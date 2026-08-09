// ============================================================
// AI Commander — 自动执行闸（从 ChatPanel 搬家，零行为变化）
//
// 为什么单独成模块：这几个判断决定「一条命令是当场执行、还是先问长官一句」，
// 而它们原本活在 ChatPanel 的组件闭包里 —— node 台架够不到，于是这一格的
// 安全行为从来只能靠手测碰运气（LEDGER H1「接线无台架可测」正是这一族）。
// 搬家不复制：函数体逐字未改，只做两件事——加 export、把 COMMANDER_REFS
// 从模块常量改成显式参数（沿用 v4 §6c-3c 的既定裁决：avatar/role 是 UI 数据，
// 不下沉，由调用方传进来）。
//
// `decideBucket` 是本次唯一的新判断，见它自己的注释。
// ============================================================

import type { GameState, AdvisorOption, Intent } from "@ai-commander/shared";
import { collectUnitsUnder } from "@ai-commander/shared";
import { isKnownForceRef, isAllFrontHint, findFront } from "@ai-commander/core";
import type { CommanderRef } from "@ai-commander/core";

/** Check if a string matches any known location: front, tag, region, or facility. */
export function isKnownLocation(val: string, state: GameState): boolean {
  if (findFront(state, val)) return true;
  if (state.tags?.some(t => t.id === val)) return true;
  if (state.regions.has(val)) return true;
  const lower = val.toLowerCase();
  for (const [, r] of state.regions) {
    if (r.id.toLowerCase().includes(lower) || r.name.toLowerCase().includes(lower)) return true;
  }
  for (const [, f] of state.facilities) {
    if (f.id.toLowerCase() === lower || f.name.toLowerCase().includes(lower)) return true;
  }
  return false;
}

export function isValidTarget(intent: Intent, state: GameState, commanderRefs: readonly CommanderRef[]): boolean {
  if (intent.targetRegion && !isKnownLocation(intent.targetRegion, state)) return false;
  if (intent.targetFacility) {
    // Guard: empty string would match everything via includes("")
    const trimmed = intent.targetFacility.trim();
    if (trimmed.length === 0) return false;
    // Fuzzy match: accept facility ID, name, or tag (not just strict ID).
    // This lets LLM output like "El Alamein" match facility ea_alamein_town.
    const hint = trimmed.toLowerCase();
    let found = state.facilities.has(intent.targetFacility);
    if (!found) {
      for (const [, f] of state.facilities) {
        if (
          f.id.toLowerCase() === hint ||
          f.name.toLowerCase().includes(hint) ||
          f.tags.some(t => t.toLowerCase().includes(hint))
        ) {
          found = true;
          break;
        }
      }
    }
    if (!found) return false;
  }
  if (intent.toFront && !isKnownLocation(intent.toFront, state)) return false;
  if (intent.fromFront && !isKnownLocation(intent.fromFront, state)) return false;
  // v4 §6c-3c: ONE predicate owns "is this a known force reference" (core).
  // The private copy that used to live here had never heard of tickets, so a
  // correct fromSquad="G1" died as an unknown squad. Ticket VALIDITY is not
  // judged here — see isKnownForceRef's contract.
  if (intent.fromSquad && !isKnownForceRef(state, intent.fromSquad, commanderRefs)) return false;
  return true;
}

/**
 * LLM responses can reference squads that died while the request was in flight
 * (the digest sent ~5-10s ago named them alive; by the time the response comes
 * back, they're KIA). The engine-layer soft-fix in handleApprove catches this
 * when the player approves the option, but the advisor's *spoken* brief is
 * already on screen saying things like "长官，Aiden 带兵撤回总部…" — a false
 * narrative about a dead squad.
 *
 * This returns the list of fromSquad references in the response that no longer
 * resolve to a living squad (or a commander key). Caller can surface a warning
 * after the brief so the player immediately sees that the response is stale
 * without tearing down the streaming brief itself.
 */
export function detectStaleSquadRefs(
  options: AdvisorOption[] | undefined,
  state: GameState,
  commanderRefs: readonly CommanderRef[],
): string[] {
  if (!options || options.length === 0) return [];
  const opt = options[0];
  const intents = opt.intents ?? (opt.intent ? [opt.intent] : []);
  const stale = new Set<string>();
  for (const intent of intents) {
    if (!intent?.fromSquad) continue;
    const fs = intent.fromSquad.toLowerCase();

    // v4 §6c-3c: commander keys AND ticket numbers are alive-by-definition here.
    // Commander keys aggregate many squads (never flagged stale unless the
    // player named a dead one); ticket numbers are judged — unknown / expired /
    // burned — by resolveTicketReference alone. A liveness check here would be
    // a SECOND owner of ticket validity, which is the bug this fix removes.
    if (isKnownForceRef(state, intent.fromSquad, commanderRefs) &&
        !state.squads?.some(s => s.id === intent.fromSquad || s.leaderName?.toLowerCase() === fs)) {
      continue;
    }

    // Leader-name or squad-ID → find the squad entity
    const squad = state.squads?.find(s =>
      s.id === intent.fromSquad || s.leaderName?.toLowerCase() === fs,
    );
    if (!squad) {
      // Entity doesn't exist at all — clearly stale
      stale.add(intent.fromSquad);
      continue;
    }

    // Entity exists, but it may be "KIA-but-lingering": the squad shell
    // persists in state.squads while all its units are dead. resolveSourceUnits
    // rejects this downstream with "分队 X 无可用单位", but by that point the
    // player has already read the advisor brief claiming the squad will do
    // things. Treat any squad with zero living dispatchable units as stale.
    const unitIds = collectUnitsUnder(state, squad.id);
    const hasLiving = unitIds.some(id => {
      const u = state.units.get(id);
      return u && u.state !== "dead" && u.hp > 0;
    });
    if (!hasLiving) stale.add(intent.fromSquad);
  }
  return [...stale];
}

// ── Phase 1: Deterministic auto-execute gate (from CommandPanel) ──

export function canAutoExecute(
  option: AdvisorOption,
  userMessage: string,
  state: GameState,
  selectedIds?: readonly number[],
  isGroupChat?: boolean,
  commanderRefs: readonly CommanderRef[] = [],
): { auto: boolean; reason?: string; playerNamedSquad?: boolean } {
  // Group chat forces manual approval
  if (isGroupChat) return { auto: false, reason: "group_chat" };

  const intents = option.intents ?? [option.intent];
  if (intents.length === 0) return { auto: false, reason: "no_intents" };

  // Parse user text for anchors: squad IDs (T3, I1, ...) and selected-units keywords
  const squadIdsInText = new Set(
    (userMessage.match(/\b[TIANF]\d+\b/gi) ?? []).map(s => s.toUpperCase()),
  );
  const hasSelectedKeyword =
    /\bselected\b/i.test(userMessage) || /选中|圈起来|这队|这支/.test(userMessage);

  // Collect anchor names (active squad leaders + commander keys) present in the user's text.
  // ASCII names use \b word boundary; CJK names fall back to substring match.
  const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const mentionedAnchors = new Set<string>();
  const anchorCandidates: string[] = [];
  for (const sq of state.squads ?? []) {
    if (sq.leaderName) anchorCandidates.push(sq.leaderName);
  }
  for (const c of ["chen", "marcus", "emily"]) anchorCandidates.push(c);
  for (const name of anchorCandidates) {
    const lower = name.toLowerCase();
    const isAscii = /^[\x00-\x7f]+$/.test(name);
    const pattern = isAscii ? `\\b${escapeRegex(name)}\\b` : escapeRegex(name);
    if (new RegExp(pattern, "i").test(userMessage)) mentionedAnchors.add(lower);
  }

  // Validate each intent independently — multi-intent is fine as long as every
  // intent clears the same safety bar a single intent would.
  for (const intent of intents) {
    // produce/trade are economy actions with no squad anchor — a clear command
    // should execute without the squad gate it would otherwise fail (no_anchor).
    // Affordability stays the engine's call; failures surface as Emily feedback
    // after applyOrders (Step 2).
    if (intent.type === "produce" || intent.type === "trade") continue;

    if (!isValidTarget(intent, state, commanderRefs)) return { auto: false, reason: "invalid_intent_fields" };

    // high_impact only fires when the intent has NO explicit scope (no fromSquad).
    // With fromSquad set (squad ID / leader name / commander key), resolveIntent
    // restricts "all" to units under that squad/commander — not global conscription,
    // so it's safe to auto-execute. Unscoped "all" IS a global draft → force confirm.
    //
    // dispatch-scope-v1 2b: retreat/defend join the list — the 74/85 full-army
    // retreat auto-executed because the type list stopped at attack/sabotage.
    // For these two, a NAMED fromFront (not the 全军 entrance) is real scope:
    // since the scope fix, "all" resolves within that front, so the headline
    // 「让北线前哨的部队都撤退」 executes in one sentence (砍卡法) while the
    // unscoped / 全军-entrance retreat must first voice its numbers. The
    // attack/sabotage condition is byte-unchanged on purpose — loosening their
    // confirm for front-scoped orders is a separate, user-callable decision.
    const qty = intent.quantity;
    const frontScoped = typeof intent.fromFront === "string" &&
      intent.fromFront.trim().length > 0 && !isAllFrontHint(intent.fromFront);
    const isHighImpact = !intent.fromSquad &&
      (qty === "all" || qty === "most") &&
      ((intent.type === "attack" || intent.type === "sabotage") ||
        ((intent.type === "retreat" || intent.type === "defend") && !frontScoped));
    if (isHighImpact) return { auto: false, reason: "high_impact" };

    if (intent.fromSquad) {
      const fs = intent.fromSquad.toLowerCase();
      const isSquadId = /^[A-Z]\d+$/i.test(intent.fromSquad);
      const squad = state.squads?.find(s =>
        s.id === intent.fromSquad || s.leaderName?.toLowerCase() === fs,
      );

      // Accept anchor if user's text mentions this intent's source in any form:
      // the exact squad ID, the intent's leaderName/commander, or (if fromSquad is
      // a squad ID) the squad's leaderName. Covers "Aiden去..." (leader name) and
      // "T3 attack" (squad ID) and LLM-translated cross-refs between them.
      let anchored = false;
      if (isSquadId && squadIdsInText.has(intent.fromSquad.toUpperCase())) anchored = true;
      if (!anchored && mentionedAnchors.has(fs)) anchored = true;
      if (!anchored && squad) {
        if (squad.id && squadIdsInText.has(squad.id.toUpperCase())) anchored = true;
        if (squad.leaderName && mentionedAnchors.has(squad.leaderName.toLowerCase())) anchored = true;
      }
      // Step 5 (revised): the mission_conflict gate was removed. It only read
      // squad.currentMission, which player commands never set — they create a
      // TaskCard in state.tasks instead, and only capture/sabotage intents bind a
      // Mission (createMission → currentMission). So it fired inconsistently
      // (capture/sabotage only) and missed the common attack/defend TaskCards shown
      // bottom-left — false, half-wired protection. A real Mission Interrupt Flow
      // (linking TaskCard ↔ currentMission) is deferred; for now there's no gate.
      //
      // anchor_mismatch + player named a squad → possible misread (ask, bucket B);
      // anchor_mismatch + player named nothing → advisor picked for them (bucket A).
      if (!anchored) return { auto: false, reason: "anchor_mismatch", playerNamedSquad: squadIdsInText.size > 0 || mentionedAnchors.size > 0 };
    } else {
      // No fromSquad — auto only if player has selected units AND used a selected keyword
      if (!hasSelectedKeyword) return { auto: false, reason: "no_anchor" };
      if (!selectedIds || selectedIds.length === 0) return { auto: false, reason: "no_selected_units" };
    }
  }

  return { auto: true };
}

// ── P0-1: 桶判定（本次唯一的新判断）──
//
// 原文是 processAdvisorData 里的两行内联布尔（ChatPanel 旧 :1576-1577）。搬出来是
// 因为**本刀最重要的那条新安全行为就写在这两行上**——留在组件闭包里，它将只有
// 手测、没有任何机器断言看着（Opus R2 的 P0）。
//
// 三个桶：
//   auto — 闸自己放行（点名相符等），照原路自动执行
//   A    — 长官没点名任何部队，参谋替他挑了 ⇒ 也自动执行（砍卡法：清楚就办）
//   B/C  — 问一句 / 高影响先说代价（本函数只负责判到 B，B 与 C 的分流照旧在调用方）
//
// ★新增的那一条（且只有这一条是新的）：
//   **语音回合，heard 缺席 ⇒ 不许进 A**。
//   理由是 A 桶的入场券本身：`no_anchor` 与 `anchor_mismatch(playerNamedSquad=false)`
//   都读同一个前提——"长官的话里没有部队名"。而语音回合若没有 heard，引擎手里
//   根本没有长官的话，"没点名"是**没看见**不是**没有**。凭没看见就自动执行，
//   等于替长官做了一个他没做的决定。
//   这一条同时封死另一个洞：通讯故障时 createFallbackResponse() 会送回一份
//   **带可执行 intent** 的兜底方案，而它是手写字面量、永远没有 heard ⇒ 语音回合
//   的兜底自动落进这里被拦住，不需要单独写一条分支。
//
// ⚠ 两个条件是**合取**，缺一不可：只写 "heard 缺席就不进 A" 会把每一个打字回合
//   都推进 B（打字回合永远没有 heard）——那是把砍卡法整个推翻。
export interface BucketInput {
  gate: { auto: boolean; reason?: string; playerNamedSquad?: boolean };
  /** 本轮有没有可执行的选项（opt0 != null）。 */
  hasOption: boolean;
  staleRefCount: number;
  /** 这一轮是不是用嘴说的（客户端发了 audio）。 */
  voiceTurn: boolean;
  /** 陈交回转写了没有。打字回合恒 false，且不参与判定。 */
  heardPresent: boolean;
}

export type Bucket = "auto" | "A" | "B";

export function decideBucket(input: BucketInput): Bucket {
  const { gate, hasOption, staleRefCount, voiceTurn, heardPresent } = input;

  // 语音回合没拿到转写 ⇒ 引擎不知道长官说了什么 ⇒ 不许当"他没点名"处理。
  //
  // ★这一句必须排在**所有**自动出口之前，包括下面的 gate.auto 捷径。
  // 起初它排在捷径之后，于是漏了一格：canAutoExecute 对 produce/trade 是
  // `continue` 直通 auto:true（经济动作没有部队锚，见上），语音听不清时会
  // **静默花钱**。给长官的承诺是"没听清就反问"，没写"经济单除外"——所以判定
  // 收敛成一句话：**语音回合 heard 缺席 ⇒ 一律 B，没有任何自动出口。**
  if (voiceTurn && !heardPresent) return "B";

  if (gate.auto && hasOption) return "auto";

  const bucketA = staleRefCount === 0 && hasOption &&
    (gate.reason === "no_anchor" || (gate.reason === "anchor_mismatch" && !gate.playerNamedSquad));
  return bucketA ? "A" : "B";
}
