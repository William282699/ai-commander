// ============================================================
// AI Commander — Escalation tickets (approval-contract-v4 刀2)
//
// THE machine handle for "那批兵". When Chen proposes a reinforcement, the
// engine mints a short ticket number (G1, G2, …) per candidate and FREEZES
// that candidate's member ids. The number rides the ---ACTIVE_ESCALATION---
// block into the prompt; the model may echo it back as `fromSquad`, and the
// translation layer resolves it to the frozen roster — never to a live
// re-scan, never through the global pool.
//
// ⚠ 下面这段"NOT on the board row"**已经不是现状**（B3 步2 更正，2026-08-12）：
//   B 刀之后 `mintSpokenForce` 就是在给板子行与判读行铸票（`intelDigest:89/96`），
//   理由写在那个函数上——不给号，模型只能把 label 写进 fromSquad，而 label
//   从来不是合法引用，闸必拦（live hand-test 02:42）。
//   **原文的两条理由本身仍然成立，且比结论更值钱，所以整段留着**：
//     · 理由一（名同人不同）正是票据要冻结 memberIds 的原因——今天仍然是；
//     · 理由二（板子行每帧重算 ⇒ 稳定的板子号需要跨帧的"群身份"）正是
//       **B3 这一刀要解的题**。B3 的答法是把"群身份"取到最窄：
//       **名单逐字节相同才算同一支**，不做任何跨帧追踪、不做模糊匹配。
//
// Why the ticket was ORIGINALLY minted on the ESCALATION candidate and NOT on
// the board row (user ruling 2026-08-02, B 案):
//   battleBoard calls buildReinforceOptions(state, null) while the escalation
//   calls it with the front. The two produce IDENTICALLY LABELLED groups with
//   DIFFERENT membership (measured: board 10 units vs escalation 5 units for
//   the same "东方向未编组群" when a cluster straddles the front boundary).
//   Numbering the board row would let Chen promise 5 and the engine dispatch
//   10 — silently, and invisibly to any label-only assertion. Minting on the
//   candidate makes 承诺 == 执行 true by construction.
//   Second reason: board rows are recomputed every frame, so a stable board
//   number would need cluster-identity tracking across frames. Not a problem
//   the candidate snapshot has.
//
// Lifecycle is deliberately NOT the shelved contract's five triggers: a ticket
// is NAMED by the model, so there is no "which proposal did 可以 mean" to
// disambiguate. One-shot + lazy expiry, checked only at consumption. No timer,
// no background task, no single slot — tickets are naturally multi-instance.
// ============================================================

import type { GameState, Front, Position, CrisisEvent, Intent, IntentType } from "@ai-commander/shared";
import { isDispatchablePlayerUnit } from "@ai-commander/shared";
import { isDispatchIntent } from "./commandAuthority";
import { buildReinforceOptions, buildFrontEscalationPayload, filterLateCandidates } from "./frontEscalationPayload";
import type { ReinforceOptionsResult } from "./frontEscalationPayload";
import { battleAnchorFor } from "./crisisResponse";
import { findFront } from "./tacticalPlanner";
import { frontEscalationFacts, facilityEscalationFacts, buildFacilityEscalationPayload, FACILITY_GATE } from "./director";

/**
 * Ticket validity, in seconds of GAME time (state.time) — the same clock and
 * the same 120s as messageStore's ESCALATION_WINDOW_SEC, which gates
 * ---ACTIVE_ESCALATION--- via getActiveEscalation(ch, state.time).
 *
 * ⇄ The two MUST stay equal: a ticket outliving its question would let "可以"
 * land on a proposal that is no longer on screen (the P0-1 shape); a ticket
 * dying first would make a visible proposal silently unexecutable. If you
 * change one, change the other (messageStore.ts ESCALATION_WINDOW_SEC).
 */
export const TICKET_TTL_SEC = 120;

/** What Chen says when a bare "可以" arrives with no proposal on the table.
 *  Engine-authored: this branch must never reach the LLM (绊索), so there is
 *  no model turn in which to phrase it. */
export const NO_PROPOSAL_GUIDANCE = "我这儿没有待批的方案——您说「派谁去哪」我就动。";

export interface EscalationTicket {
  /** "G7" — monotonic within a battle, never reused (a recycled number is the
   *  P0-1 "old G7 / new G7" impersonation in miniature). */
  gNumber: string;
  /** Frozen at mint. The ONLY roster this ticket will ever dispatch. */
  unitIds: number[];
  /** Human label as Chen speaks it, for receipts. Never a bare internal id. */
  label: string;
  /** unitIds.length at mint — the number Chen promised out loud. */
  unitCount: number;
  targetFrontId: string;
  /** 第 8 级 刀1：设施危机铸的票带着**那个设施**。前线族恒不带（字段缺席），
   *  所以前线族票据逐字节不变。消费时 ticketDestinationVerdict 的设施档凭它
   *  把精确目的地注入单子——「派他们去」不再退化成「去那条线上某处」。 */
  targetFacilityId?: string;
  /** Rally point the ETA promise was measured to (刀1 battleAnchorFor).
   *  null only when the front has no resolvable geometry at all — never a
   *  (0,0) placeholder waiting for someone to remember to backfill it.
   *
   *  ★ v4 §8 (2026-08-04): READ-ONLY provenance for the ETA. It is no longer
   *  injected into the dispatch path. It used to be, and a frozen point that
   *  outlives the situation it was frozen in is how a bare 「快撤」 became
   *  "retreat onto the enemy's position" (§7④) and how an unknown place name
   *  became a silent rewrite to an old anchor (§7③). Execution now re-resolves
   *  the destination at dispatch time through frontDestinationFor — the same
   *  ladder the anchor itself came from, so the two still agree by
   *  construction, they just no longer agree by freezing. */
  anchor: Position | null;
  /** Arrival estimate at mint time; null = unknown. Carried so the receipt can
   *  state the cost of sending a force the engine already called too slow —
   *  B 刀: a handle is an ADDRESS, not an endorsement, so late forces DO get
   *  numbered, and the receipt is where their lateness is reconciled out loud. */
  etaSec: number | null;
  mintedAt: number;
  burned: boolean;
  /** 哪一族铸的（B3 ②修正案，2026-08-12）。**复用只在 `"spoken"` 内部查。**
   *
   *  为什么必须有这一维：判读行那条路铸票时 `targetFrontId = front.id`，
   *  与**同一条战线的 escalation 票面完全同形**，而危机线上那支队两边都会点到。
   *  只按 `memberIds + targetFrontId + targetFacilityId` 做谓词，板子会
   *  **复用掉一张升级票** ⇒ `ticketDestinationVerdict` 拿到别人的
   *  anchor/targetFacilityId provenance，正是 v4 刀1 消灭过的"一句承诺两个来源"。
   *  加这一维不是放宽谓词，是让「escalation 票永不参与复用」从约定变成结构保证。 */
  origin: TicketOrigin;
  /** 这张票**印出去过**的所有名字（append-only，去重，含铸造名）。
   *
   *  为什么不是覆写 `label`：号被复用之后会印在**新名字**旁边，而 `glued()`
   *  判的是"剥掉尾号后的前缀 == 票面 label"——覆写会让**自家刚印出去的组合**
   *  被自己拒掉（H1 复活）。改成"前缀 ∈ 印过的组合"，是自家打印记账，
   *  不是模糊匹配（红线二不违）：没印过的名字 + 真号，照旧拒。 */
  printedLabels: string[];
  /** 最近一次把这个号印给长官看的时刻。
   *
   *  TTL 从这里起算（**只对 spoken 族**，B3 ④修正案）：TTL 的本义是
   *  "刚印给你看的号 120s 内有效"；复用重印一个 119 秒龄的号、1 秒后就死，
   *  正是 `TICKET_TTL_SEC` 注释里点名的"屏上可见却不可执行"。
   *  **escalation 族仍从 `mintedAt` 起算**——提案问句不会重印，
   *  它的 120s 本就该从提问算起，⇄ `ESCALATION_WINDOW_SEC` 那条对仗一字不动。 */
  lastPrintedAt: number;
}

/** 票据家族。`spoken`＝板子行/判读行随信封重印的地址；
 *  `escalation`＝一案一号的提案把手。 */
export type TicketOrigin = "spoken" | "escalation";

/**
 * 把这张票说出口时该用的名字 ＝ **长官最后看到的那个**（`printedLabels` 末位）。
 *
 * 为什么要有唯一访问器而不是各处 `t.label`：号被复用之后，票面 `label` 是
 * **首铸时**的名字，而长官刚在屏上看到的是最新那个。任何一处漏改，
 * 陈就会用一个长官两分钟前才见过的旧名去称呼眼前这支部队。
 * 全仓把票名说出口的有 8 处（含 ChatPanel 的权限拒绝），一律走这里。
 *
 * ★对 escalation 族恒等于 `label`（它们从不重印，`printedLabels` 只有一条）
 * ——所以 `ticketPromptLine` 的输出逐字节不变（rider R1 第一件）。
 */
export function spokenNameOf(t: EscalationTicket): string {
  return t.printedLabels[t.printedLabels.length - 1] ?? t.label;
}

export type TicketLookup =
  | { ok: true; ticket: EscalationTicket }
  | { ok: false; reason: "unknown" | "expired" | "burned"; ticket?: EscalationTicket };

let seq = 0;
const tickets = new Map<string, EscalationTicket>();

/** New battle → the numbering restarts and every old ticket is unreachable. */
export function resetEscalationTickets(): void {
  seq = 0;
  tickets.clear();
}

/**
 * Mint one ticket per SHOWN candidate for this front's escalation.
 *
 * Shown (not just top) on purpose: the payload hands Chen up to DISPLAY_BUDGET
 * candidates and he may name any of them. Numbering only the top would leave
 * the model one number for a proposal about a different group — the exact
 * promise/execution split this knife exists to close.
 *
 * Same-state determinism with the payload: both read the one builder
 * synchronously off the same GameState.
 */
export function mintEscalationTickets(
  state: GameState,
  /** null = 设施危机：这批票不属于任何一条战线的"线外候选"，池子是全图。 */
  front: Front | null,
  /** The candidate set already built for this tick. Production ALWAYS passes it
   *  (via buildFrontEscalationWithTickets) so the payload Chen speaks from and
   *  the tickets are literally the same objects — not two constructions that
   *  happen to agree today. */
  precomputed?: ReinforceOptionsResult,
  /** 第 8 级 刀1（R13）：锚点覆盖必须**穿过 mint**，不能只喂给候选构造。
   *
   *  票面的 `anchor`/`etaSec` 是那句 ETA 承诺的 provenance；`battleAnchorFor`
   *  给的是"这条线上打得最凶的那处"，正是手测那笔账里援兵被送去的地方。
   *  只修候选侧、不修 mint 侧，payload 的 ETA 会好、冻在票上的还是旧点——
   *  一句承诺两个来源，正是 v4 刀1 当初消灭过的形状。 */
  override?: { anchor?: Position | null; targetFacilityId?: string },
): EscalationTicket[] {
  const result = precomputed ?? buildReinforceOptions(state, front);
  // The rally point the ETA promise was made against (刀1). Computed HERE, not
  // backfilled by the caller: a placeholder that depends on a later call is a
  // placeholder that eventually ships.
  const anchor = override?.anchor !== undefined
    ? override.anchor
    : (front ? battleAnchorFor(state, front) : null);
  const out: EscalationTicket[] = [];
  for (const opt of result.shown) {
    const t = mintOne(state, front, opt, anchor, "escalation", override?.targetFacilityId);
    if (t) out.push(t);
  }
  return out;
}

/** The one place a ticket is actually created. Roster frozen at this instant.
 *
 *  `origin` 是**必填**（不给默认值）：新的调用点必须当场想清楚自己属于哪一族，
 *  漏了编译就红。默认值会让第三条铸票路悄悄混进 spoken 族、被复用谓词吃掉。 */
function mintOne(
  state: GameState,
  front: Front | null,
  opt: { label: string; memberIds: number[]; etaSec: number | null },
  anchor: Position | null,
  origin: TicketOrigin,
  targetFacilityId?: string,
): EscalationTicket | null {
  if (opt.memberIds.length === 0) return null;
  seq += 1;
  const t: EscalationTicket = {
    gNumber: `G${seq}`,
    unitIds: [...opt.memberIds],
    label: opt.label,
    unitCount: opt.memberIds.length,
    targetFrontId: front?.id ?? "",
    // 缺席而不是 undefined 赋值：前线族票据的对象形状逐字节不变。
    ...(targetFacilityId ? { targetFacilityId } : {}),
    anchor: anchor ? { x: anchor.x, y: anchor.y } : null,
    etaSec: opt.etaSec,
    mintedAt: state.time,
    burned: false,
    origin,
    // 铸造名就是第一条印出去的组合。append-only，去重（名字只在位移到
    // 悬崖/等距点时才变，实测 8%，去重后每票撑死两三条）。
    printedLabels: [opt.label],
    // 起点＝铸造时刻；步 3 起每次复用重印时前移（**只对 spoken 族**）。
    lastPrintedAt: state.time,
  };
  tickets.set(t.gNumber, t);
  return t;
}

/**
 * B 刀 (2026-08-02): mint a handle for a force the staff is about to NAME OUT
 * LOUD outside the escalation machine — the board's best_help row, and the
 * disclosure row that names a force it just said cannot arrive in time.
 *
 * Why this exists: a spatial group's spoken name ("东北方向第一未编组群") is not
 * a legal fromSquad and never can be — the label is recomputed every frame and
 * the same words can mean a different roster seconds later. Before this, naming
 * such a force in conversation was a dead end: the commander says 「让她们去
 * 支援」, the model has nothing to bind to, falls back to a destination-only
 * intent, and the engine dispatches whoever already stands at the destination
 * (live hand-test: 6 idle tanks promised, 1 surviving defender actually moved).
 *
 * ★ A handle is an ADDRESS, not an endorsement. The engine mints one even for a
 * force it has just declared too slow — refusing to RECOMMEND it (诚实闸) and
 * refusing to let the commander REACH it are different things, and only the
 * first is the engine's call. Overriding "赶不到" is a legitimate command
 * decision (counter-attack, screen, retake).
 *
 * Roster + anchor are frozen here exactly as the escalation path freezes them,
 * so 承诺 == 执行 holds for this face too.
 */
export function mintSpokenForce(
  state: GameState,
  front: Front | null,
  opt: { label: string; memberIds: number[]; etaSec: number | null },
): string | null {
  // front === null: the board's force rows are front-agnostic (they are built
  // with buildReinforceOptions(state, null)), so there is no rally point and no
  // ETA to freeze — only the ROSTER, which is the part that matters. The order
  // itself supplies the destination. Handing these rows a handle is what makes
  // 「东方向第四未编组群」 addressable at all: the staff reads that name off the
  // board when the commander asks 「附近有空闲部队吗」, and without a number the
  // model can only write the LABEL into fromSquad — which the gate then refuses
  // as a squad that was never in the order of battle (live hand-test 02:42).
  // ── B3：同一批人再被点名，复用原来那个号 ──
  //
  // 病：本函数每条命令被调用一次（digest 重建），旧实现无条件 mintOne ⇒
  // 同一支部队每回合换一个号（实测连印两次 G1-G6 → G7-G12，五回合 seq 到 G30）。
  // 号一直换 ⇒ 对话史堆死号 ⇒ 模型抄到旧号 ⇒ 绊索拦下白费一轮（LEDGER B3）。
  const reused = findReusableSpokenTicket(state, front, opt);
  if (reused) {
    // ★命中时**只做三件事**（裁定 2026-08-12）：
    //   ① printedLabels 追加去重  ② lastPrintedAt 前移  ③ 返回旧号
    // label / etaSec / anchor / mintedAt **一个字节不许动**——它们是这张票的
    // provenance（首铸时那句承诺是对着它们说的）。回执改念"最新印出的名"
    // 归步 4，与 glued 一起落。
    if (!reused.printedLabels.includes(opt.label)) reused.printedLabels.push(opt.label);
    reused.lastPrintedAt = state.time;
    return reused.gNumber;
  }
  const t = front
    ? mintOne(state, front, opt, battleAnchorFor(state, front), "spoken")
    : mintOne(state, null, opt, null, "spoken");
  return t ? t.gNumber : null;
}

/** 名单逐字节同。两个调用点喂进来的 memberIds 都直接来自
 *  `buildReinforceOptions`（`:497`/`:549` 都 `.sort((a,b)=>a-b)`），**已排序**，
 *  所以逐元素比就是真正的"同一批人"，不需要防御性重排——重排会把
 *  "顺序不同"悄悄也算成同一支，那是放宽谓词。 */
function sameRoster(a: readonly number[], b: readonly number[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/**
 * 可复用的那张票——**fail-closed，宁窄勿宽**（用户明确怕"错绑"）。
 *
 * 五项全同才算同一支，差任何一样都新铸：
 *   ① `origin === "spoken"` —— escalation 票**永不参与复用**。判读行铸票时
 *      `targetFrontId = front.id`，与同线 escalation 票面完全同形，只按名单+战线
 *      比会让板子**吃掉一张升级票**，`ticketDestinationVerdict` 就会拿到别人的
 *      anchor/provenance（v4 刀1 消灭过的"一句承诺两个来源"）。
 *   ②③ 名单逐字节同、`targetFrontId` 同 —— 板子行(`""`)与判读行(`front.id`)
 *      是**两个子形，故意不跨**：跨了就是错绑。代价是"同信封双号"仍在（B3b），
 *      那是另一笔账，不许为它放宽这里。
 *   ④ `targetFacilityId` 同（spoken 路恒不带，两边都 undefined 才算同）。
 *   ⑤ 未 burn、未过期 —— burn 过的票roster 已经花掉，复用它等于把同一批人
 *      派两次；过期的票长官已经看不见了。
 */
function findReusableSpokenTicket(
  state: GameState,
  front: Front | null,
  opt: { label: string; memberIds: number[] },
): EscalationTicket | null {
  const wantFrontId = front?.id ?? "";
  for (const t of tickets.values()) {
    if (t.origin !== "spoken") continue;
    if (t.burned) continue;
    if (state.time - ttlBasisOf(t) > TICKET_TTL_SEC) continue;
    if (t.targetFrontId !== wantFrontId) continue;
    if (t.targetFacilityId !== undefined) continue; // spoken 路恒不带设施
    if (!sameRoster(t.unitIds, opt.memberIds)) continue;
    return t;
  }
  return null;
}

export interface EscalationWithTickets {
  /** The SITUATION payload the voice is written from (byte-identical to V1b). */
  payload: string;
  tickets: EscalationTicket[];
  /** Permission line for ---ACTIVE_ESCALATION---; null when nothing was minted. */
  promptLine: string | null;
}

/**
 * THE production entry for a front escalation: one candidate construction
 * feeding both the spoken payload and the tickets.
 *
 * Why this exists instead of two calls in GameCanvas (user ruling 2026-08-02
 * item 1): "same tick, same state, pure function" is true today, but it is an
 * argument, not a structure. Building once and handing the SAME result to both
 * consumers makes promise/ticket drift impossible rather than merely unlikely.
 * It also keeps buildReinforceOptions out of core/index.ts, which stays
 * builder-only for production (Codex round-4 P1-4).
 */
export function buildFrontEscalationWithTickets(
  state: GameState,
  crisis: CrisisEvent,
): EscalationWithTickets {
  const facts = frontEscalationFacts(state, crisis);
  const front = facts ? state.fronts.find((f) => f.id === facts.frontId) ?? null : null;
  // 诚实闸 (刀3) is applied ONCE, here, and the SAME filtered set feeds both the
  // payload and the mint — a ticket must never exist for a candidate Chen was
  // not allowed to mention.
  const result = filterLateCandidates(
    buildReinforceOptions(state, front),
    facts?.estimatedCollapseSeconds ?? null,
  );
  const payload = buildFrontEscalationPayload(state, crisis, result);
  const minted = front ? mintEscalationTickets(state, front, result) : [];
  return { payload, tickets: minted, promptLine: ticketPromptLine(state, minted) };
}

/**
 * 第 8 级 刀1：设施家族危机的**票据机器**（镜像 buildFrontEscalationWithTickets）。
 *
 * 病：设施名在引擎里只活在设施家族事件上（FACILITY_CONTESTED / CAPTURE_STALLED），
 * 而这一族升级时走 facFacts 分支，**一张票都不铸**（GameCanvas :475 原
 * `withTickets = facFacts ? null : …`）。玩家在前哨危机语境下说「派他们去」，
 * 模型手上没有任何号可绑，单子退化成普通命令，精确目的地在传递中丢掉——
 * 援兵去了战线别处，前哨没人管。
 *
 * 三条口径：
 *  - **候选池 = 全图 − 设施身边那圈**（R9 乙案）。战线口径「线外才算候选」对设施
 *    危机不成立：最该派的往往正是同线但在别处闲着的那坨人。身边那圈要排除——
 *    他们正在那儿挨打，不是援兵。
 *  - **ETA 一律量到设施坐标**，候选侧与 mint 侧同一个点（R13）。
 *  - **诚实闸口径**：设施危机没有互射钟 ⇒ clock=null ⇒ 不滤。
 *    缺席的数不许当判决（engaged-unknown 行的同一条原则）。
 *
 * payload **字节不变**（buildFacilityEscalationPayload 原样调用）——号只走
 * ticketPromptLine 进 ---ACTIVE_ESCALATION---，既有管道，零新接线。
 */
export function buildFacilityEscalationWithTickets(
  state: GameState,
  facilityId: string,
  situationType: string,
  rawSignal: string,
): EscalationWithTickets | null {
  const facts = facilityEscalationFacts(state, facilityId);
  const facility = state.facilities.get(facilityId);
  if (!facts || !facility) return null;

  const result = buildReinforceOptions(state, null, {
    anchorOverride: facility.position,
    excludeNear: { center: facility.position, radius: FACILITY_GATE.NEAR_RADIUS }, // 与 payload 的 nearby_forces_ours 同一把尺
  });
  // 设施危机无互射钟 → 不滤。仍然走这道闸，是为了将来这里长出钟时不会被绕过。
  const shown = filterLateCandidates(result, null);

  // `front` 只用来给票**记账**（targetFrontId）：池子已经由上面的 precomputed
  // 全图构造定死，anchor 也由 override 定死。设施若丢了，verdict 的设施档会跳过，
  // 票凭这个 front 落回战线档 —— 这正是 §O-3 要的降级路径。
  const front = state.fronts.find((f) => f.regionIds.includes(facility.regionId)) ?? null;
  const minted = mintEscalationTickets(state, front, shown, {
    anchor: facility.position,
    targetFacilityId: facilityId,
  });
  return {
    payload: buildFacilityEscalationPayload(facts, situationType as never, rawSignal),
    tickets: minted,
    promptLine: ticketPromptLine(state, minted),
  };
}

/**
 * Resolve a model-written reference. Fail-closed and LOUD: an unknown,
 * expired or already-burned number returns a reason, never a silent fallback
 * to "pick something reasonable" (that soft-fix is the 74/85 family).
 */
export function lookupEscalationTicket(raw: string, now: number): TicketLookup {
  const key = normalizeForceRef(raw);
  const t = key === null ? undefined : tickets.get(key);
  if (!t) return { ok: false, reason: "unknown" };
  if (t.burned) return { ok: false, reason: "burned", ticket: t };
  if (now - ttlBasisOf(t) > TICKET_TTL_SEC) return { ok: false, reason: "expired", ticket: t };
  return { ok: true, ticket: t };
}

/**
 * TTL 从哪一刻起算——**这是两族唯一分岔的地方**（B3 ④修正案）。
 *
 * `spoken`（板子行/判读行）：从**最近一次印给长官看**起算。TTL 的本义是
 *   "刚印给你看的号 120s 内有效"；板子每条命令重印一次，复用重印一个 119 秒龄
 *   的号、1 秒后就死，正是 `TICKET_TTL_SEC` 注释点名的"屏上可见却不可执行"。
 * `escalation`（提案把手）：仍从 `mintedAt` 起算，**一字不动**。提案问句不会
 *   重印，它的 120s 本就该从提问算起——⇄ `messageStore.ESCALATION_WINDOW_SEC`
 *   那条对仗靠这一行守住。approval-v4 那 23 格是它的看门狗。
 */
function ttlBasisOf(t: EscalationTicket): number {
  return t.origin === "spoken" ? t.lastPrintedAt : t.mintedAt;
}

// ── 号怎么印、怎么认（第 8 级 刀2）──
//
// 病：`handle=G7` 是行尾一个独立 token，而那一行的主语是**战线**。
// 「1. 北部战线: … best_help=Aiden(I1)(3units …) handle=G2」——模型把号绑给了
// 行首那个名字，9/131。根因是**语法位置**，不是措辞：G 刀在合同里补了
// 「号只指部队」之后从 17 腰斩到 9，没归零——措辞治不了语法。
//
// 刀：号永远紧跟部队名，`名[临时编队G7]`；行尾独立 token 废除。
// 「临时编队」是自描述——冻结的那批本来就不是编制分队，说出口反而更准（R6）。
//
// 印与认写在一起，是为了它们能被证明互逆：**印出去的形，必须认得回来**
// （与刀4 的 tag 名字归一同一条原则）。

const HANDLE_PREFIX = "临时编队";

/** 号贴在部队名紧邻处的印法。**唯一**一处定义这个形状。 */
export function forceHandleTag(gNumber: string): string {
  return `[${HANDLE_PREFIX}${gNumber}]`;
}

/**
 * 冻结名单恰好是**某支活着的编制队的全员**时，返回那支队；否则 null。
 *
 * 「全员」= 双向相等：名单里每个都是该队成员，且该队每个活着的成员都在名单里。
 * 单向包含不够——子集也满足"每个都是成员"，而子集正是 R6 要叫「临时编队」的那类。
 */
function wholeSquadOf(state: GameState, memberIds: readonly number[]): { id: string; leaderName: string } | null {
  if (memberIds.length === 0) return null;
  const ids = new Set(memberIds);
  for (const sq of state.squads ?? []) {
    if (sq.role !== "leader") continue;
    const alive = sq.unitIds.filter((id) => {
      const u = state.units.get(id);
      return u !== undefined && u.hp > 0 && u.state !== "dead";
    });
    if (alive.length !== ids.size) continue;
    if (alive.every((id) => ids.has(id))) return { id: sq.id, leaderName: sq.leaderName };
  }
  return null;
}

/**
 * 这支部队在行里该带什么号——**R6 修订 v2（Fable 裁定 2026-08-08，手测 H4）**。
 *
 * 病：R6 原裁定「统一用[临时编队G#]」的理由是"冻结的那批本来就不是编制分队"，
 * 那对**子集**成立；但候选是**整支编制队**时，这句话是纯粹说错——
 * 实测信封把 `Aiden(I1)` 印成 `Aiden(I1)[临时编队G1]`，再配上同行的
 * 「1股…闲着」，陈照账本念就成了「空闲部队」，**玩家编队时挣来的那个名字没了**。
 * 长官花力气编的队，参谋当面把它降级成一股临时的闲兵。
 *
 * 修订：**名单==某支活着编制队的全员 ⇒ 不加任何标签**。它的名与号已经在 label
 * 里（`Aiden(I1)`），而 `I1` 本来就是合法 fromSquad——它不需要借一个临时号。
 * 子集 / 空间群 / 跨队拼盘 ⇒ 照 R6 原样 `[临时编队G#]`。
 *
 * 票照铸不误（冻结/burn/verdict 机器一个字节没动）：号仍在登记簿里，模型写
 * `fromSquad="G7"` 照样解析得到那批冻结名单。本次改的**只是印不印**。
 */
export function forceHandleTagFor(
  state: GameState,
  gNumber: string,
  memberIds: readonly number[],
): string {
  return wholeSquadOf(state, memberIds) ? "" : forceHandleTag(gNumber);
}

/**
 * 把写来的部队引用归一成登记簿的 key。
 *
 * 只剥**我们自己印的那一个前缀**（外加整段抄行时带出来的方括号），再照旧判
 * `G\d+`——这是对自家打印格式的解析闭环，不是同义词表（红线二不违）。
 * `isTicketRef` / `lookupEscalationTicket` / `isKnownForceRef` 三处共用这一个。
 * fail-closed 不变：`临时编队2` / `G2X` / `编队G2` 一律拒绝。
 */
function normalizeForceRef(raw: string): string | null {
  let s = raw.trim();
  if (s.startsWith("[") && s.endsWith("]")) s = s.slice(1, -1).trim();
  if (s.startsWith(HANDLE_PREFIX)) s = s.slice(HANDLE_PREFIX.length).trim();
  if (/^G\d+$/i.test(s)) return s.toUpperCase();
  return glued(raw.trim());
}

/**
 * 名字和号**粘成一串**时的归一（手测 H1，2026-08-08）。
 *
 * 病：刀2 之后信封印的是 `战狼点附近未编组群[临时编队G45]`——名字与号紧挨着。
 * 模型抄"这支部队的引用"时整段抄进 fromSquad，实测抄成 `战狼点附近未编组群G45`
 * （连方括号都省了）。旧归一只认真空里的号，于是这条引用**连票据登记簿都没查**
 * 就被判成"这实体不存在"，命令零执行、白费一轮。号很可能还是活的。
 *
 * fail-closed 的切法：剥掉尾号之后，**剩下的前缀必须逐字等于那张票自己的 label**。
 * 只认「我们自己印出去的那个组合」——不是模糊匹配，不是同义词表（红线二不违）。
 * 一个恰好以 G 数字结尾的真分队名不会被误吞：它的前缀对不上任何一张票的 label。
 */
function glued(s: string): string | null {
  const m = s.match(/^(.*?)\s*(?:\[\s*)?(?:临时编队)?\s*(G\d+)\s*\]?$/i);
  if (!m) return null;
  const prefix = m[1].trim();
  if (prefix.length === 0) return null;          // 裸号已在上面处理过
  const key = m[2].toUpperCase();
  const t = tickets.get(key);
  if (!t) return null;                            // 号都不认识，谈不上前缀匹配
  // B3 步4：改判「前缀 ∈ **这张票自己**印出去过的组合」。
  // ★是 `t.printedLabels`，**不是全局印过的名字池**——一张票没印过的名字
  //   配上它的真号，照旧拒（⑤② 负对照真咬这一格）。
  //   为什么非改不可：号被复用后印在**新名字**旁，旧判法拿首铸 label 比，
  //   会把**自家刚印出去的那个组合**判成不存在（H1 复活）。
  //   这是对自家打印格式的解析闭环，不是模糊匹配（红线二不违）。
  return t.printedLabels.some((l) => l.trim() === prefix) ? key : null;
}

/** True iff the string looks like a force reference at all (G + digits,
 *  optionally wearing the 「临时编队」 prefix we print). */
export function isTicketRef(raw: string): boolean {
  return normalizeForceRef(raw) !== null;
}

/** A commander as the reference predicate needs to see one: the key the model
 *  may write ("chen") and the display label a player may say ("陈军士").
 *  Passed IN so core never carries UI data (avatar/role stay in the web layer). */
export interface CommanderRef {
  key: string;
  label: string;
}

/**
 * THE one answer to "is this string a force reference the system knows about".
 *
 * v4 §6c-3c (P0 fix): `detectStaleSquadRefs` and `isValidTarget` each carried a
 * private copy of this judgement, and neither had heard of tickets — so a
 * correctly-written `fromSquad="G1"` was rejected as a dead squad before the
 * translation layer ever ran. Two private definitions of "legal reference" IS
 * the bug class; this collapses them to one.
 *
 * ★ Ticket refs pass on SHAPE ALONE. Whether G1 is unknown / expired / burned
 * is decided by resolveTicketReference and NOWHERE ELSE — a gate that also
 * consulted the registry would recreate the second source of truth this fix
 * exists to remove. A hallucinated G99 therefore passes the gate and is refused
 * loudly one layer down: same zero-execution outcome, one owner.
 */
export function isKnownForceRef(
  state: GameState,
  raw: string | undefined | null,
  commanders: readonly CommanderRef[],
): boolean {
  if (!raw) return false;
  const s = raw.trim();
  if (s.length === 0) return false;
  if (isTicketRef(s)) return true;

  const lower = s.toLowerCase();
  if (state.squads?.some((sq) => sq.id === s || sq.leaderName?.toLowerCase() === lower)) return true;
  // Semantics preserved verbatim from the two former copies: key matches
  // case-insensitively and exactly; label matches by CONTAINING the reference.
  return commanders.some((c) => c.key.toLowerCase() === lower || c.label.includes(s));
}

/** One-shot: a consumed ticket can never dispatch twice. */
export function burnEscalationTicket(gNumber: string): void {
  const key = normalizeForceRef(gNumber);
  const t = key === null ? undefined : tickets.get(key);
  if (t) t.burned = true;
}

/**
 * The frozen roster filtered to who can still go: alive and dispatchable.
 * Casualties and units the player has since re-tasked simply drop out — the
 * receipt then reports the REAL number that left, never the promised one.
 */
export function liveMembersOf(state: GameState, ticket: EscalationTicket): number[] {
  const out: number[] = [];
  for (const id of ticket.unitIds) {
    const u = state.units.get(id);
    if (!u || u.hp <= 0 || u.state === "dead") continue;
    if (!isDispatchablePlayerUnit(u)) continue;
    out.push(id);
  }
  return out;
}

/**
 * The permission line injected next to the escalation question. States the
 * mapping explicitly because the digest's standing rule says the opposite
 * ("group labels are NOT valid fromSquad") — that rule stays TRUE for labels;
 * this grants the NUMBER, which is a different handle.
 */
export function ticketPromptLine(state: GameState, minted: EscalationTicket[]): string | null {
  if (minted.length === 0) return null;
  // 刀2：候选行也印自描述的号，与判读行/板子行同一个形。
  // R6 修订 v2：整支编制队报它自己的名与号，不冠「临时编队」。
  const list = minted
    .map((t) => (wholeSquadOf(state, t.unitIds)
      ? `${spokenNameOf(t)}(${t.unitCount}units)`
      : `${HANDLE_PREFIX}${t.gNumber}=${spokenNameOf(t)}(${t.unitCount}units)`))
    .join("｜");
  return `本案候选编号：${list}\nfromSquad="${HANDLE_PREFIX}G编号" 即调陈所述那批（编号是合法把手，群名仍然不是）。`;
}

// ── The translation decision (pure; ChatPanel keeps only thin glue) ──
//
// GameCanvas/ChatPanel have no node harness — a reversed frame label once
// shipped through exactly that blind spot (GameCanvas.tsx:463). So every
// judgment lives here where the bench can reach it, and the UI layer only
// routes the verdict: dispatch these ids, or say this line.

export type TicketResolution =
  /** fromSquad is not a G-number at all → normal command path, untouched. */
  | { kind: "not_a_ticket" }
  /** Execute EXACTLY these ids (they are the frozen roster, filtered to alive). */
  | { kind: "dispatch"; ticket: EscalationTicket; unitIds: number[] }
  /** Zero execution + this in-character line. Never a silent fallback. */
  | { kind: "refuse"; reason: "unknown" | "expired" | "burned" | "all_gone"; line: string };

/**
 * Resolve a model-written `fromSquad` against the ticket registry.
 *
 * Fail-closed by construction: every non-dispatch outcome is a REFUSAL with a
 * spoken reason, never "pick something reasonable". The silently-widening
 * soft-fix is the 74/85 family and is what dispatch-scope-v1 removed.
 */
export function resolveTicketReference(
  state: GameState,
  rawFromSquad: string | undefined | null,
  now: number,
): TicketResolution {
  if (!rawFromSquad || !isTicketRef(rawFromSquad)) return { kind: "not_a_ticket" };

  const look = lookupEscalationTicket(rawFromSquad, now);
  if (!look.ok) {
    const g = rawFromSquad.trim().toUpperCase(); // 仅用于兜底话术里回显长官原话
    const line =
      look.reason === "expired"
        ? `那个增援案已经过时了——现在还要动兵的话，您说一声，我按当下的情况重新点人。`
        : look.reason === "burned"
          ? `${look.ticket ? spokenNameOf(look.ticket) : g} 已经派出去了，不重复下令。`
          : `我这儿没有编号 ${g} 的方案——您说「派谁去哪」我就动。`;
    return { kind: "refuse", reason: look.reason, line };
  }

  const live = liveMembersOf(state, look.ticket);
  if (live.length === 0) {
    return {
      kind: "refuse",
      reason: "all_gone",
      line: `${spokenNameOf(look.ticket)} 已经没人能动了——要增援得另外点人。`,
    };
  }
  return { kind: "dispatch", ticket: look.ticket, unitIds: live };
}

/**
 * Demote a ticket-bound intent's front hints from SOURCE to DESTINATION.
 *
 * The frozen roster reaches the planner through resolveIntent's selectedUnitIds,
 * which is a hard FILTER over whatever pool resolveSourceUnits built. With
 * toFront set, that pool is "units already standing at the destination", so
 * roster ∩ pool = ∅ and the order dies as 「框选的单位不在可调度范围内」 — after
 * the receipt already promised the batch (live hand-test 2026-08-02; measured
 * 0 dispatched with toFront, 6 with the hints cleared).
 *
 * A ticket HAS no source front: its source is the roster. So fromFront is
 * dropped and toFront is moved to targetRegion, where resolveTarget resolves a
 * front id through the §8 destination ladder.
 *
 * ★ v4 §8 (2026-08-04): the anchor-injection branch that used to sit here is
 * GONE. It existed only to route around getFrontCenterPos, and now that the
 * front branches of resolveTarget resolve properly there is nothing to route
 * around. Its three measured defects go with it: a bare retreat rewritten to
 * "retreat onto the fight" (§7④), an unknown place name silently rewritten to
 * an old anchor with the offending field deleted before isValidTarget could
 * see it (§7③), and a board-minted ticket (anchor === null) falling through to
 * the geometric center anyway (§7①).
 *
 * ★ An UNRESOLVABLE toFront is left in place on purpose. Demoting it to
 * targetRegion would make the downstream warning name a field the model never
 * wrote — a silent rewrite of the commander's own words. Left where it is,
 * softFixTargetFields reports 「toFront=<原话>」 and ticketDestinationVerdict
 * turns it into a question instead of a guess.
 *
 * Pure, and in core on purpose: ChatPanel has no bench harness, and this is
 * exactly the kind of judgment that shipped reversed once already.
 */
export function retargetIntentForTicket(
  state: GameState,
  intent: Intent,
  /** Kept in the signature, no longer read: the one thing this took from the
   *  ticket was its frozen anchor, and §8 deleted that path. */
  _ticket: EscalationTicket,
): Intent {
  const out: Intent = { ...intent };
  // A ticket has no SOURCE front — its source is the frozen roster.
  out.fromFront = undefined;

  // Precise, player-meant destinations win outright (a facility, a map tag, an
  // explicit coordinate): those name a POINT, and the commander chose it.
  const hasPreciseTarget = !!(out.targetFacility || out.targetRegion || out._targetPos);

  if (hasPreciseTarget) {
    out.toFront = undefined;
  } else if (out.toFront && findFront(state, out.toFront)) {
    // Front hint demoted from SOURCE to DESTINATION (targetRegion resolves a
    // front id) — it must never reach resolveSourceUnits, where it would make
    // the pool "units already at the destination" and leave the roster with an
    // empty intersection (measured: 0 dispatched with toFront, 6 without).
    out.targetRegion = out.toFront;
    out.toFront = undefined;
  }
  return out;
}

// ── Where does a ticket-bound order actually go? (v4 §8 条件二, 2026-08-04) ──

export type TicketDestinationVerdict =
  /** Dispatch it. `injectTargetRegion` (when set) is the destination the engine
   *  supplies because the order named none; `receipt` picks the wording. */
  | { kind: "execute"; injectTargetRegion?: string; injectTargetFacility?: string; receipt: "moved" | "in_place" }
  /** Zero execution + this question. A ticket is a handle on PEOPLE, never on a
   *  place, so "where" is the one thing it can never fill in for the commander. */
  | { kind: "refuse"; reason: "unknown_place" | "no_destination"; line: string };

/** Verbs that are already complete without a destination: they act where the
 *  force stands. Everything else needs somewhere to go. */
const IN_PLACE_TYPES: ReadonlySet<IntentType> = new Set<IntentType>(["defend", "hold"]);

/**
 * THE destination decision for a ticket-bound order, in three cases:
 *
 *   1. a destination was written and survived validation → execute it;
 *   2. one was written and did NOT survive (no such place) → refuse and ask,
 *      never substitute (§7③: the substitute was an anchor frozen minutes ago);
 *   3. none was written at all:
 *      · defend/hold act in place — legal, and the receipt must say so
 *        rather than claim a march that never happened (§7②);
 *      · retreat keeps the retreat-semantics-v1 default (toward HQ, pinned
 *        byte-for-byte in ab-retreat-semantics);
 *      · an ESCALATION ticket knows which front it was raised for, so that
 *        front becomes the destination and rides the §8 ladder;
 *      · a BOARD ticket (targetFrontId === "") knows no front — and inventing
 *        one is the whole family of soft-fixes this rung removes. Ask.
 *
 * Called only for intents the ticket layer actually bound. Non-ticket commands
 * are untouched on purpose: the engine cannot tell "a new order that named no
 * squad" from "a follow-up that got mis-bound", and gating both would put a
 * confirmation card back in front of clear orders — the thing the 砍卡法 ruling
 * removed (Bucket A, 审核档 §3-6).
 */
export function ticketDestinationVerdict(
  /** 刀1：设施档要判"那个据点还在不在、还是不是我们的"——那是 state 才知道的事。 */
  state: GameState,
  intent: Intent,
  ticket: EscalationTicket,
  /** Did the model write ANY destination field before softFixTargetFields ran?
   *  This is what separates case 2 from case 3 — after the soft-fix they look
   *  identical, and treating "you named a place I can't find" as "you named no
   *  place" is how a typo turns into a dispatch to somewhere else. */
  wroteDestination: boolean,
): TicketDestinationVerdict {
  const hasDestination = !!(
    intent._targetPos || intent.targetFacility || intent.targetRegion || intent.toFront
  );
  if (hasDestination) return { kind: "execute", receipt: "moved" };

  if (wroteDestination) {
    return {
      kind: "refuse",
      reason: "unknown_place",
      line: `${spokenNameOf(ticket)} 还在原地——您说的那个地方我在图上找不着。换个地名，或者说「原地守住」，我立刻办。`,
    };
  }

  // Economy intents carry no destination by nature and can never be a dispatch.
  if (!isDispatchIntent(intent.type)) return { kind: "execute", receipt: "moved" };
  if (IN_PLACE_TYPES.has(intent.type)) return { kind: "execute", receipt: "in_place" };
  if (intent.type === "retreat") return { kind: "execute", receipt: "moved" };
  // 第 8 级 刀1：设施票带着它是为哪个据点铸的——那是比"某条战线"精确得多的
  // 目的地，长官说「派他们去」时要的正是它。
  //
  // 位置是合同：**在 retreat 档之后**（撤退的默认落点由 retreat-semantics-v1
  // 逐字节钉死，设施档不许插到它前面），**在 targetFrontId 档之前**（有精确
  // 目的地就不该退回战线级）。
  //
  // 设施已丢（转敌/打没）⇒ 跳过，落回下面的战线档：夺回是 attack 语义，
  // 与"增援我们还守着的据点"不是一回事，那一档另说。
  if (ticket.targetFacilityId) {
    const fac = state.facilities.get(ticket.targetFacilityId);
    if (fac && fac.hp > 0 && fac.team === "player") {
      return { kind: "execute", injectTargetFacility: ticket.targetFacilityId, receipt: "moved" };
    }
  }
  if (ticket.targetFrontId) {
    return { kind: "execute", injectTargetRegion: ticket.targetFrontId, receipt: "moved" };
  }
  return {
    kind: "refuse",
    reason: "no_destination",
    line: `${spokenNameOf(ticket)}（${ticket.gNumber}）去哪？您给个地名或据点，我这就派。`,
  };
}

/** Receipt after a dispatch: the REAL number that left, never the promised one.
 *  B 刀: when the handle carries an arrival estimate, the receipt states it —
 *  a force the engine called too slow may still be sent, but the commander is
 *  told what he just bought rather than only that it left.
 *
 *  刀C (v4 §8 ⑤, 2026-08-04): `dispatched` must be counted from the resolver's
 *  assignedUnitIds AFTER the dispatch, not from the roster before it. Measured
 *  §7⑤: roster 6 + quantity=2 → 2 units moved, receipt said 6. And `mode`
 *  exists because 「出发了」 is a lie about a defend-in-place order — the units
 *  did what was asked without going anywhere (§7②). The ETA belongs only to
 *  the marching case; there is no arrival to estimate when nobody departs. */
export function ticketDispatchReceipt(
  ticket: EscalationTicket,
  dispatched: number,
  mode: "moved" | "in_place" = "moved",
): string {
  if (mode === "in_place") {
    return dispatched === ticket.unitCount
      ? `${spokenNameOf(ticket)} ${dispatched}个单位就地设防。`
      : `${spokenNameOf(ticket)} 实际能动的 ${dispatched} 个已就地设防（原报 ${ticket.unitCount} 个，其余已不在编）。`;
  }
  const eta = ticket.etaSec !== null ? `，按估算约 ${ticket.etaSec} 秒到位` : "";
  return dispatched === ticket.unitCount
    ? `${spokenNameOf(ticket)} ${dispatched}个单位出发了${eta}。`
    : `${spokenNameOf(ticket)} 实际能走的 ${dispatched} 个已经出发${eta}（原报 ${ticket.unitCount} 个，其余已不在编）。`;
}

/** Bench-only view of the registry. */
export function _ticketsForTest(): EscalationTicket[] {
  return Array.from(tickets.values());
}
