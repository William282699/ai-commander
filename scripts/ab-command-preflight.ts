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

  console.log(failCount === 0 ? "\nALL SYNTHETIC PASS" : `\n${failCount} FAILURES`);
  process.exit(failCount === 0 ? 0 : 1);
}

const mode = process.argv[2];
if (mode === "--synthetic") runSynthetic();
else {
  console.log("usage: tsx scripts/ab-command-preflight.ts --synthetic   (--ab arrives with 地基二/三)");
  process.exit(2);
}
