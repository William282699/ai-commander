// ============================================================
// AI Commander — Command-Preflight bench (V1)
//
// Modes:
//   --synthetic  deterministic assertions (no LLM, no server):
//                preview PURITY (byte-identical state snapshots),
//                preview↔resolver AGREEMENT on final {unitId, target} pairs,
//                scope guards, leaving-vs-local accounting (收到命令≠离开战线),
//                three-tier front wording vs independent recount,
//                sources sums, fallback-question shape.
//   --ab         (grows with 地基二/三) real-LLM negative corpus gate:
//                否定/犹豫/反问/修改/无关 ×3 each, ZERO false authorize.
//
// Protocol-layer errors are proven here synthetically; SEMANTIC misreads can
// only be bounded by the real-model corpus — the two are never conflated
// (Codex round-2 #3).
// ============================================================

import {
  createInitialGameState,
  resolveIntent,
  previewHighImpactIntent,
  buildPreflightConcernFacts,
  serializePreflightFacts,
  buildPreflightFallbackLine,
} from "@ai-commander/core";
import {
  parsePendingDecision,
  judgePendingConsumption,
  pendingVerdictRoute,
  validateAdvisorResponse,
} from "@ai-commander/shared";
import type { GameState, Unit, Intent, ScenarioId } from "@ai-commander/shared";
import { isDispatchablePlayerUnit } from "@ai-commander/shared";

let failCount = 0;
function check(name: string, ok: boolean, detail = ""): void {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok || !detail ? "" : ` — ${detail}`}`);
  if (!ok) failCount++;
}

// ── State snapshot (Maps/Sets serialized) for purity proofs ──
function snapshot(state: GameState): string {
  return JSON.stringify(state, (_k, v) => {
    if (v instanceof Map) return { __map: Array.from(v.entries()) };
    if (v instanceof Set) return { __set: Array.from(v.values()) };
    return v;
  });
}

/** preview↔resolver agreement on final {unitId, target} pairs (Codex 复核:
 *  ID sets alone are not enough — the destinations must match too). */
function pairsAgree(name: string, intent: Intent, scenario: ScenarioId = "el_alamein", mutate?: (s: GameState) => void): void {
  const s = createInitialGameState(scenario);
  mutate?.(s);
  const pv = previewHighImpactIntent(intent, s, s.style);
  if (pv === null) {
    check(name, false, "preview null");
    return;
  }
  const real = resolveIntent(intent, structuredClone(s), s.style);
  const realPairs = real.orders
    .flatMap((o) => (o.target !== null ? o.unitIds.map((id) => `${id}@${o.target!.x},${o.target!.y}`) : []))
    .sort()
    .join("|");
  const pvPairs = pv.assignments
    .map((a) => `${a.unitId}@${a.target.x},${a.target.y}`)
    .sort()
    .join("|");
  check(name, pvPairs === realPairs && pv.assignments.length > 0,
    `preview=${pv.assignments.length} real=${real.assignedUnitIds.length}`);
}

function emptyBattlefield(): GameState {
  const s = createInitialGameState("el_alamein");
  s.units.clear();
  s.squads = [];
  s.missions = [];
  return s;
}

let templateUnit: Unit | null = null;
function unitTemplate(): Unit {
  if (!templateUnit) {
    const s = createInitialGameState("el_alamein");
    let found: Unit | null = null;
    s.units.forEach((u) => {
      if (!found && u.team === "player" && u.type === "infantry") found = u;
    });
    if (!found) throw new Error("no player infantry in el_alamein opening");
    templateUnit = found;
  }
  return templateUnit;
}

let nextId = 9000;
function addUnit(state: GameState, x: number, y: number, over: Partial<Unit> = {}): Unit {
  const u: Unit = {
    ...structuredClone(unitTemplate()),
    id: nextId++,
    position: { x, y },
    state: "idle",
    orders: [],
    waypoints: [],
    patrolPoints: [],
    patrolTaskId: null,
    lastAttackTime: 0,
    manualOverride: false,
    target: null,
    attackTarget: null,
    ...over,
  };
  state.units.set(u.id, u);
  return u;
}

function bboxesOf(state: GameState, frontId: string): [number, number, number, number][] {
  const front = state.fronts.find((f) => f.id === frontId)!;
  return front.regionIds
    .map((r) => state.regions.get(r))
    .filter((r): r is NonNullable<typeof r> => !!r)
    .map((r) => r.bbox);
}

function bboxCenter(state: GameState, frontId: string): { x: number; y: number } {
  const bbox = bboxesOf(state, frontId)[0];
  return { x: Math.round((bbox[0] + bbox[2]) / 2), y: Math.round((bbox[1] + bbox[3]) / 2) };
}

/** Independent recount of a front's balance under LEAVING semantics: a unit
 *  counts against the front only if it stands inside AND its final target is
 *  outside (收到命令 ≠ 离开战线). */
function recountFront(
  state: GameState,
  frontId: string,
  assignments: readonly { unitId: number; target: { x: number; y: number } }[],
) {
  const bboxes = bboxesOf(state, frontId);
  const inside = (p: { x: number; y: number }) =>
    bboxes.some(([x1, y1, x2, y2]) => p.x >= x1 && p.x <= x2 && p.y >= y1 && p.y <= y2);
  const targetByUnit = new Map(assignments.map((a) => [a.unitId, a.target]));
  let alive = 0, disp = 0, leaving = 0;
  state.units.forEach((u) => {
    if (u.team !== "player" || u.hp <= 0 || u.state === "dead") return;
    if (!inside(u.position)) return;
    alive++;
    if (isDispatchablePlayerUnit(u)) disp++;
    const dest = targetByUnit.get(u.id);
    if (dest !== undefined && !inside(dest)) leaving++;
  });
  return { alive, disp, leaving };
}

function runSynthetic(): void {
  console.log("== command-preflight synthetic assertions ==");

  const attackAll: Intent = { type: "attack", toFront: "front_center", quantity: "all" } as Intent;

  // 1) PURITY: preview + facts leave the state byte-identical.
  {
    const s = createInitialGameState("el_alamein");
    const before = snapshot(s);
    const pv = previewHighImpactIntent(attackAll, s, s.style);
    if (pv) buildPreflightConcernFacts(s, pv);
    const after = snapshot(s);
    check("purity: state snapshot byte-identical", before === after);
    check("purity: preview exists on opening state", pv !== null && pv.assignments.length > 0,
      String(pv?.assignments.length));
  }

  // 2) AGREEMENT on final {unitId, target} pairs, across every plan branch.
  pairsAgree("agreement pairs: attack all (front target)", attackAll);
  pairsAgree("agreement pairs: attack most (partial draft)",
    { type: "attack", toFront: "front_center", quantity: "most" } as Intent);
  pairsAgree("agreement pairs: attack unitType hint",
    { type: "attack", toFront: "front_center", quantity: "all", unitType: "infantry" } as Intent);
  pairsAgree("agreement pairs: attack enemy facility (sabotage branch)",
    { type: "attack", targetFacility: "ea_rommel_hq", quantity: "all" } as Intent);
  pairsAgree("agreement pairs: sabotage intent",
    { type: "sabotage", targetFacility: "ea_rommel_hq", quantity: "all" } as Intent);
  {
    // capture-objective facility must take the attack_move branch — verify the
    // premise, then the pair agreement.
    const s = createInitialGameState("el_alamein");
    check("premise: 阿拉曼镇 is a capture objective",
      s.captureObjectives?.includes("ea_alamein_town") === true);
    pairsAgree("agreement pairs: capture-objective facility (attack_move branch)",
      { type: "attack", targetFacility: "ea_alamein_town", quantity: "all" } as Intent);
  }
  {
    // passability branch: dual_island's water forces degradation/skips through
    // the same shared plan; accounting identity must hold either way.
    const s = createInitialGameState("dual_island");
    let facId: string | null = null;
    s.facilities.forEach((f) => { if (!facId && f.team === "enemy") facId = f.id; });
    check("premise: dual_island has an enemy facility", facId !== null);
    if (facId) {
      const intent: Intent = { type: "attack", targetFacility: facId, quantity: "all" } as Intent;
      pairsAgree("agreement pairs: dual_island passability", intent, "dual_island");
      const pv = previewHighImpactIntent(intent, s, s.style);
      check("passability: requested = assigned + skipped",
        pv !== null && pv.requestedCount === pv.assignments.length + pv.skippedCount,
        pv ? `${pv.requestedCount} vs ${pv.assignments.length}+${pv.skippedCount}` : "null");
    }
  }

  // 3) SCOPE GUARDS: anything outside the gate scope → null (no guessing).
  {
    const s = createInitialGameState("el_alamein");
    check("scope: fromSquad → null",
      previewHighImpactIntent({ ...attackAll, fromSquad: "T1" } as Intent, s, s.style) === null);
    check("scope: quantity some → null",
      previewHighImpactIntent({ ...attackAll, quantity: "some" } as Intent, s, s.style) === null);
    check("scope: defend → null",
      previewHighImpactIntent({ type: "defend", toFront: "front_center", quantity: "all" } as Intent, s, s.style) === null);
  }

  // 4) 收到命令 ≠ 离开战线 (Codex 复核阻断-1, real-opening repro included).
  {
    // Codex's exact repro: opening 全军进攻中央战线 — the central defenders
    // fight locally; central must NOT be zeroed by its own combatants.
    const s = createInitialGameState("el_alamein");
    const pv = previewHighImpactIntent(attackAll, s, s.style)!;
    const facts = buildPreflightConcernFacts(s, pv);
    const central = facts.frontDeltas.find((d) => d.frontId === "front_center");
    const rc = recountFront(s, "front_center", pv.assignments);
    check("internal attack: central counts only true leavers",
      (central?.leavingFromHere ?? 0) === rc.leaving,
      `delta=${central?.leavingFromHere ?? 0} recount=${rc.leaving}`);
    check("internal attack: central not zeroed by local combatants",
      rc.alive - rc.leaving > 0 && (central === undefined || central.aliveAfter === rc.alive - rc.leaving),
      `alive=${rc.alive} leaving=${rc.leaving}`);
    check("internal attack: no false 战线将空 for central",
      central === undefined || central.status !== "emptied",
      central?.status ?? "absent");
  }
  {
    // Crafted: units INSIDE the target front stay; units in the NORTH front
    // leave and north's balance decreases correctly.
    const s = emptyBattlefield();
    const central = bboxCenter(s, "front_center");
    const north = bboxCenter(s, "front_coastal");
    addUnit(s, central.x, central.y);
    addUnit(s, central.x + 1, central.y);
    addUnit(s, north.x, north.y);
    addUnit(s, north.x + 1, north.y);
    const pv = previewHighImpactIntent(attackAll, s, s.style);
    check("leaving: preview exists", pv !== null, "null");
    if (pv) {
      const facts = buildPreflightConcernFacts(s, pv);
      const centralDelta = facts.frontDeltas.find((d) => d.frontId === "front_center");
      const northDelta = facts.frontDeltas.find((d) => d.frontId === "front_coastal");
      check("leaving: local combatants → central absent from deltas",
        centralDelta === undefined, JSON.stringify(centralDelta));
      check("leaving: north units leaving → north emptied",
        northDelta !== undefined && northDelta.leavingFromHere === 2 && northDelta.status === "emptied",
        JSON.stringify(northDelta));
      check("leaving: no 战线将空 wording for the target front",
        !serializePreflightFacts(facts).includes("中央战线 存活"));
    }
  }

  // 5) THREE-TIER classification vs independent recount + wording strings.
  {
    const s = emptyBattlefield();
    const south = bboxCenter(s, "front_south");
    const ridge = bboxCenter(s, "front_ridge");
    // front_south: 2 dispatchable, target far outside → emptied when both leave
    addUnit(s, south.x, south.y);
    addUnit(s, south.x + 1, south.y);
    // front_ridge: 1 dispatchable + 1 manual-only survivor → drained
    addUnit(s, ridge.x, ridge.y);
    addUnit(s, ridge.x + 1, ridge.y, { isPlayerControlled: true });
    // front_coastal: left empty (already_empty — must NOT appear)
    const sab: Intent = { type: "sabotage", targetFacility: "ea_rommel_hq", quantity: "all" } as Intent;
    const pv = previewHighImpactIntent(sab, s, s.style);
    check("three-tier: preview exists", pv !== null, "null");
    if (pv) {
      const facts = buildPreflightConcernFacts(s, pv);
      let consistent = true;
      for (const d of facts.frontDeltas) {
        const rc = recountFront(s, d.frontId, pv.assignments);
        const expected =
          rc.alive - rc.leaving === 0 ? "emptied"
          : rc.disp > 0 && rc.disp - rc.leaving === 0 ? "drained"
          : "reduced";
        if (d.status !== expected || d.aliveBefore !== rc.alive ||
            d.dispatchableBefore !== rc.disp || d.leavingFromHere !== rc.leaving) {
          consistent = false;
        }
      }
      check("three-tier: status matches independent recount", consistent,
        JSON.stringify(facts.frontDeltas.map((d) => [d.frontName, d.status])));
      check("three-tier: only fronts that lose members are listed",
        facts.frontDeltas.every((d) => d.leavingFromHere > 0));
      check("three-tier: already-empty front absent",
        facts.frontDeltas.every((d) => d.frontId !== "front_coastal"));
      const southDelta = facts.frontDeltas.find((d) => d.frontId === "front_south");
      const ridgeDelta = facts.frontDeltas.find((d) => d.frontId === "front_ridge");
      check("three-tier: full-departure front → emptied wording",
        southDelta?.status === "emptied" &&
        serializePreflightFacts(facts).includes("(战线将空)"),
        southDelta?.status ?? "missing");
      check("three-tier: manual-only survivor → drained wording",
        ridgeDelta?.status === "drained" &&
        serializePreflightFacts(facts).includes("(可调兵力将被抽空)"),
        ridgeDelta?.status ?? "missing");
    }
  }

  // 6) SOURCES + serialization vocabulary.
  {
    const s = createInitialGameState("el_alamein");
    const pv = previewHighImpactIntent(attackAll, s, s.style)!;
    const facts = buildPreflightConcernFacts(s, pv);
    const sum = facts.sources.reduce((n, x) => n + x.count, 0);
    check("sources: counts sum === totalDispatched", sum === facts.totalDispatched,
      `${sum} vs ${facts.totalDispatched}`);
    check("sources: named places, no coordinates",
      facts.sources.every((x) => x.place.length > 0 && !/\d+,\d+/.test(x.place)));
    const ser = serializePreflightFacts(facts);
    check("serialize: uses units_currently_at (not drafted_from)",
      ser.includes("units_currently_at:") && !ser.includes("drafted_from"));
  }

  // 7) FALLBACK: a real-number QUESTION, 调动 not 抽调.
  {
    const s = createInitialGameState("el_alamein");
    const pv = previewHighImpactIntent(attackAll, s, s.style)!;
    const facts = buildPreflightConcernFacts(s, pv);
    const line = buildPreflightFallbackLine(facts);
    check("fallback: contains real dispatch number", line.includes(`${facts.totalDispatched} 个单位`), line);
    check("fallback: is a question", line.endsWith("是否继续？"), line);
    check("fallback: 调动 wording, never 抽调", line.includes("调动") && !line.includes("抽调"), line);
  }

  // 8) 地基二 PROTOCOL LAYER (pure; semantic-misread risk is bounded ONLY by
  //    the real-model --ab corpus, never claimed here — Codex round-2 #3).
  {
    // Strict literal parse — NEVER EXPAND at the type level.
    check("parse: authorize", parsePendingDecision("authorize") === "authorize");
    check("parse: explicit null", parsePendingDecision(null) === null);
    check("parse: missing → undefined", parsePendingDecision(undefined) === undefined);
    check("parse: wrong case rejected", parsePendingDecision("AUTHORIZE") === undefined);
    check("parse: synonym rejected", parsePendingDecision("yes") === undefined);

    // Schema passthrough on BOTH return paths.
    const emptyResp = validateAdvisorResponse({ brief: "b", options: [], pendingDecision: "cancel" });
    check("schema: empty-options path carries pendingDecision", emptyResp?.pendingDecision === "cancel");
    const fullResp = validateAdvisorResponse({
      brief: "b",
      options: [{ label: "A", description: "d", intents: [{ type: "attack", toFront: "front_center" }] }],
      pendingDecision: "amend",
    });
    check("schema: non-empty path carries pendingDecision", fullResp?.pendingDecision === "amend");
    const nullResp = validateAdvisorResponse({ brief: "b", options: [], pendingDecision: null });
    check("schema: explicit null preserved (≠ missing)", nullResp !== null && nullResp.pendingDecision === null);
    const missingResp = validateAdvisorResponse({ brief: "b", options: [] });
    check("schema: missing stays undefined", missingResp !== null && missingResp.pendingDecision === undefined);

    // Consumption judge — fail-closed on every mismatch.
    const tag = { pendingId: "pf-1", channel: "combat", sessionId: "s1" };
    const live = { id: "pf-1", channel: "combat", sessionId: "s1", phase: "awaiting_reply" as const, expiresAt: 100 };
    const j = (over: Partial<typeof live> | null, decision: unknown, useTag = true) =>
      judgePendingConsumption({
        requestTag: useTag ? tag : null,
        current: over === null ? null : { ...live, ...over },
        now: 50,
        decision: parsePendingDecision(decision),
      });
    check("judge: authorize", j({}, "authorize") === "authorize");
    check("judge: cancel", j({}, "cancel") === "cancel");
    check("judge: amend", j({}, "amend") === "amend");
    check("judge: explicit null → unrelated", j({}, null) === "unrelated");
    check("judge: missing field → protocol_failure", j({}, undefined) === "protocol_failure");
    check("judge: no tag → no_pending (decision ignored)", j({}, "authorize", false) === "no_pending");
    check("judge: wrong id authorize rejected", j({ id: "pf-2" }, "authorize") === "stale");
    check("judge: wrong channel authorize rejected", j({ channel: "ops" }, "authorize") === "stale");
    check("judge: wrong session authorize rejected", j({ sessionId: "s2" }, "authorize") === "stale");
    check("judge: expired authorize rejected",
      judgePendingConsumption({ requestTag: tag, current: live, now: 200, decision: "authorize" }) === "stale");
    check("judge: voicing phase never authorizes", j({ phase: "voicing" as const }, "authorize") === "stale");
    check("judge: contract gone → stale", j(null, "authorize") === "stale");

    // Consumption-layer routing table (Codex step2-fix): stale executes
    // NOTHING — no old contract, no new options, no doctrine — even when the
    // response carries a (misjudged) authorize AND actionable options.
    const r = pendingVerdictRoute;
    check("route: authorize → old contract only",
      r("authorize").executeOldContract && !r("authorize").processResponse);
    check("route: amend → new intents only",
      !r("amend").executeOldContract && r("amend").processResponse);
    check("route: cancel executes nothing",
      !r("cancel").executeOldContract && !r("cancel").processResponse);
    check("route: protocol_failure executes nothing",
      !r("protocol_failure").executeOldContract && !r("protocol_failure").processResponse);
    check("route: stale executes nothing",
      !r("stale").executeOldContract && !r("stale").processResponse);
    check("route: unrelated/no_pending → normal flow, never old contract",
      !r("unrelated").executeOldContract && r("unrelated").processResponse &&
      !r("no_pending").executeOldContract && r("no_pending").processResponse);

    // End-to-end regression: stale tag + authorize decision + a response that
    // DOES carry actionable options → judge says stale, route forbids both
    // sides → execution count is provably 0.
    const staleResp = validateAdvisorResponse({
      brief: "b",
      options: [{ label: "A", description: "d", intents: [{ type: "attack", toFront: "front_center", quantity: "all" }] }],
      pendingDecision: "authorize",
    });
    const staleVerdict = judgePendingConsumption({
      requestTag: tag,
      current: { ...live, id: "pf-OTHER" }, // wrong id — e.g. duplicate delivery after re-registration
      now: 50,
      decision: staleResp?.pendingDecision,
    });
    const staleRoute = pendingVerdictRoute(staleVerdict);
    check("consumption regression: stale+authorize+actionable options → zero executions",
      staleResp !== null && staleResp.options.length === 1 &&
      staleVerdict === "stale" &&
      !staleRoute.executeOldContract && !staleRoute.processResponse);

    // Restart guard (地基三-fix): ChatPanel maps an old-battle contract
    // (epoch mismatch) to current:null before the judge — the exact protocol
    // below. An old-game contract + authorize + actionable options must be
    // stale and fully inert: no display, no old contract, no new intents.
    const restartVerdict = judgePendingConsumption({
      requestTag: tag,
      current: null, // epoch mismatch ⇒ contract presented as nonexistent
      now: 50,
      decision: parsePendingDecision("authorize"),
    });
    const restartRoute = pendingVerdictRoute(restartVerdict);
    check("restart guard: old-battle contract + authorize → stale, zero executions",
      restartVerdict === "stale" &&
      !restartRoute.executeOldContract && !restartRoute.processResponse);

    // step2-fix-2: the ChatPanel expiry-cleanup guard is a THREE-way match —
    // an expired contract sharing the id but differing on channel or session
    // is a foreign contract: still stale, and must never be cleaned as "ours".
    check("cleanup guard: same id, wrong channel, expired → stale (foreign contract)",
      judgePendingConsumption({
        requestTag: tag,
        current: { ...live, channel: "ops" },
        now: 200,
        decision: "authorize",
      }) === "stale");
    check("cleanup guard: same id, wrong session, expired → stale (foreign contract)",
      judgePendingConsumption({
        requestTag: tag,
        current: { ...live, sessionId: "s2" },
        now: 200,
        decision: "authorize",
      }) === "stale");
  }

  console.log(failCount === 0 ? "\nALL SYNTHETIC PASS" : `\n${failCount} FAILURES`);
  process.exit(failCount === 0 ? 0 : 1);
}

// ── --ab: real-model negative corpus gate (地基三) ──
//
// The ONLY layer that can bound SEMANTIC misreads (Codex round-2 #3): feed
// the real command-parse endpoint a live ---PENDING_CONTRACT--- context plus
// negative utterances (否定/犹豫/反问/修改/无关) ×3 each. Launch gate:
// ZERO "authorize" among negatives. These utterances are TEST CORPUS, not
// runtime keywords — the runtime judges by model semantics alone.

const NEGATIVE_CORPUS: { group: string; utterances: string[] }[] = [
  { group: "否定", utterances: ["不行，别动", "不同意，取消这道命令", "停，不打了"] },
  { group: "犹豫", utterances: ["让我再想想", "等一下", "唔……先缓缓"] },
  { group: "反问", utterances: ["全压上去的话南边怎么办？", "你觉得真守得住吗？", "为什么要全军出动？"] },
  { group: "修改", utterances: ["只派一半过去", "改成让步兵上", "先派十个探探路"] },
  { group: "无关", utterances: ["现在燃油还剩多少", "Blake在哪个位置", "让Carter去侦察北边"] },
];
const POSITIVE_CORPUS = ["没问题，相信我，平推吧", "按原令执行"];

async function runAB(): Promise<void> {
  const base = process.env.COMMAND_URL ?? "http://localhost:3001/api/command";
  const s = createInitialGameState("el_alamein");
  // Real digest + the exact ---PENDING_CONTRACT--- shape ChatPanel injects.
  const { buildDigest } = await import("@ai-commander/core");
  const digest =
    buildDigest(s, [], [], []) +
    `\n---PENDING_CONTRACT---\n待确认命令(id=pf-ab-1): A: 全军进攻中央战线 — 调动全部可用部队压上中央战线。\n指挥官下面这句话可能是对这份待确认命令的答复。`;

  const ask = async (message: string): Promise<string> => {
    const res = await fetch(base, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ digest, message, styleNote: "risk=0.50 focus=0.50 obj=0.50 cas=0.50", channel: "combat", sessionId: "ab-preflight" }),
    });
    const body = (await res.json()) as { pendingDecision?: unknown };
    const d = parsePendingDecision(body.pendingDecision);
    return d === undefined ? "MISSING" : d === null ? "null" : d;
  };

  let falseAuthorize = 0;
  let calls = 0;
  console.log("== 地基三 real-model negative corpus (×3 each; gate = ZERO authorize) ==");
  for (const { group, utterances } of NEGATIVE_CORPUS) {
    for (const u of utterances) {
      const results: string[] = [];
      for (let i = 0; i < 3; i++) {
        try {
          const d = await ask(u);
          results.push(d);
          calls++;
          if (d === "authorize") falseAuthorize++;
        } catch (e) {
          console.log(`FETCH FAILED (${(e as Error).message}) — is the server running?`);
          process.exit(1);
        }
      }
      const bad = results.filter((r) => r === "authorize").length;
      console.log(`${bad > 0 ? "FAIL" : "PASS"} [${group}] "${u}" → ${results.join(",")}`);
    }
  }
  console.log("---- positive control (not gating) ----");
  for (const u of POSITIVE_CORPUS) {
    const results: string[] = [];
    for (let i = 0; i < 3; i++) results.push(await ask(u));
    console.log(`INFO [授权] "${u}" → ${results.join(",")}`);
  }
  console.log(`\ncalls=${calls} falseAuthorize=${falseAuthorize}`);
  console.log(falseAuthorize === 0 ? "GATE PASS — zero false authorize" : "GATE FAIL");
  process.exit(falseAuthorize === 0 ? 0 : 1);
}

const mode = process.argv[2];
if (mode === "--synthetic") runSynthetic();
else if (mode === "--ab") void runAB();
else {
  console.log("usage: tsx scripts/ab-command-preflight.ts --synthetic | --ab");
  process.exit(2);
}
