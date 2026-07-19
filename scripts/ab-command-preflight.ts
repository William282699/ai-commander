// ============================================================
// AI Commander — Command-Preflight bench (V1)
//
// Modes:
//   --synthetic  deterministic assertions (no LLM, no server):
//                preview PURITY (byte-identical state snapshots),
//                preview↔resolver AGREEMENT (same drafted set),
//                scope guards, three-tier front wording, sources sums,
//                fallback-question shape.
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
import type { GameState, Unit, Intent } from "@ai-commander/shared";
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

function bboxCenter(state: GameState, frontId: string): { x: number; y: number } {
  const front = state.fronts.find((f) => f.id === frontId)!;
  const bbox = state.regions.get(front.regionIds[0])!.bbox;
  return { x: Math.round((bbox[0] + bbox[2]) / 2), y: Math.round((bbox[1] + bbox[3]) / 2) };
}

/** Recompute a front's alive/dispatchable/drafted counts independently of
 *  commandPreflight's implementation — the classification contract check. */
function recountFront(state: GameState, frontId: string, drafted: ReadonlySet<number>) {
  const front = state.fronts.find((f) => f.id === frontId)!;
  const bboxes = front.regionIds
    .map((r) => state.regions.get(r))
    .filter((r): r is NonNullable<typeof r> => !!r)
    .map((r) => r.bbox);
  let alive = 0, disp = 0, draftedIn = 0;
  state.units.forEach((u) => {
    if (u.team !== "player" || u.hp <= 0 || u.state === "dead") return;
    const inside = bboxes.some(([x1, y1, x2, y2]) =>
      u.position.x >= x1 && u.position.x <= x2 && u.position.y >= y1 && u.position.y <= y2);
    if (!inside) return;
    alive++;
    if (isDispatchablePlayerUnit(u)) disp++;
    if (drafted.has(u.id)) draftedIn++;
  });
  return { alive, disp, draftedIn };
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
    check("purity: preview exists on opening state", pv !== null && pv.assignedUnitIds.length > 0,
      String(pv?.assignedUnitIds.length));
  }

  // 2) AGREEMENT: preview's drafted set === real resolver's assignedUnitIds
  //    (resolver runs on a clone — it mutates missions/diagnostics).
  {
    const s = createInitialGameState("el_alamein");
    const pv = previewHighImpactIntent(attackAll, s, s.style)!;
    const clone = structuredClone(s);
    const real = resolveIntent(attackAll, clone, clone.style);
    const a = [...pv.assignedUnitIds].sort((x, y) => x - y).join(",");
    const b = [...real.assignedUnitIds].sort((x, y) => x - y).join(",");
    check("agreement: preview set === resolver set (attack all)", a === b,
      `preview=${pv.assignedUnitIds.length} real=${real.assignedUnitIds.length}`);
  }
  {
    // most-quantity agreement too (partial draft ordering must match)
    const s = createInitialGameState("el_alamein");
    const attackMost: Intent = { type: "attack", toFront: "front_center", quantity: "most" } as Intent;
    const pv = previewHighImpactIntent(attackMost, s, s.style)!;
    const real = resolveIntent(attackMost, structuredClone(s), s.style);
    const a = [...pv.assignedUnitIds].sort((x, y) => x - y).join(",");
    const b = [...real.assignedUnitIds].sort((x, y) => x - y).join(",");
    check("agreement: preview set === resolver set (attack most)", a === b);
  }
  {
    // sabotage agreement (enemy facility)
    const s = createInitialGameState("el_alamein");
    const sab: Intent = { type: "sabotage", targetFacility: "ea_rommel_hq", quantity: "all" } as Intent;
    const pv = previewHighImpactIntent(sab, s, s.style);
    if (pv === null) {
      check("agreement: sabotage preview exists", false, "null");
    } else {
      const real = resolveIntent(sab, structuredClone(s), s.style);
      const a = [...pv.assignedUnitIds].sort((x, y) => x - y).join(",");
      const b = [...real.assignedUnitIds].sort((x, y) => x - y).join(",");
      check("agreement: preview set === resolver set (sabotage all)", a === b);
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

  // 4) THREE-TIER classification contract: statuses recomputed independently
  //    must match, and already-empty fronts must never appear.
  {
    const s = emptyBattlefield();
    const south = bboxCenter(s, "front_south");
    const ridge = bboxCenter(s, "front_ridge");
    // front_south: 2 dispatchable (→ likely emptied when both drafted)
    addUnit(s, south.x, south.y);
    addUnit(s, south.x + 1, south.y);
    // front_ridge: 1 dispatchable + 1 manual-only (drafting the one → drained)
    addUnit(s, ridge.x, ridge.y);
    addUnit(s, ridge.x + 1, ridge.y, { isPlayerControlled: true });
    // front_coastal: left empty (already_empty — must NOT appear in deltas)
    const sab: Intent = { type: "sabotage", targetFacility: "ea_rommel_hq", quantity: "all" } as Intent;
    const pv = previewHighImpactIntent(sab, s, s.style);
    check("three-tier: preview exists", pv !== null, "null");
    if (pv) {
      const facts = buildPreflightConcernFacts(s, pv);
      const drafted = new Set(pv.assignedUnitIds);
      let consistent = true;
      for (const d of facts.frontDeltas) {
        const rc = recountFront(s, d.frontId, drafted);
        const expected =
          rc.alive - rc.draftedIn === 0 ? "emptied"
          : rc.disp > 0 && rc.disp - rc.draftedIn === 0 ? "drained"
          : "reduced";
        if (d.status !== expected || d.aliveBefore !== rc.alive ||
            d.dispatchableBefore !== rc.disp || d.draftedFromHere !== rc.draftedIn) {
          consistent = false;
        }
      }
      check("three-tier: status matches independent recount", consistent,
        JSON.stringify(facts.frontDeltas.map((d) => [d.frontName, d.status])));
      check("three-tier: no zero-draft fronts listed",
        facts.frontDeltas.every((d) => d.draftedFromHere > 0));
      check("three-tier: already-empty front absent",
        facts.frontDeltas.every((d) => d.frontId !== "front_coastal"));
      const southDelta = facts.frontDeltas.find((d) => d.frontId === "front_south");
      const ridgeDelta = facts.frontDeltas.find((d) => d.frontId === "front_ridge");
      check("three-tier: full-draft front → emptied wording",
        southDelta?.status === "emptied" &&
        serializePreflightFacts(facts).includes("(战线将空)"),
        southDelta?.status ?? "missing");
      check("three-tier: manual-only survivor → drained wording",
        ridgeDelta?.status === "drained" &&
        serializePreflightFacts(facts).includes("(可调兵力将被抽空)"),
        ridgeDelta?.status ?? "missing");
    }
  }

  // 5) SOURCES: counts sum to total; places named, never coordinates.
  {
    const s = createInitialGameState("el_alamein");
    const pv = previewHighImpactIntent(attackAll, s, s.style)!;
    const facts = buildPreflightConcernFacts(s, pv);
    const sum = facts.sources.reduce((n, x) => n + x.count, 0);
    check("sources: counts sum === totalDispatched", sum === facts.totalDispatched,
      `${sum} vs ${facts.totalDispatched}`);
    check("sources: named places, no coordinates",
      facts.sources.every((x) => x.place.length > 0 && !/\d+,\d+/.test(x.place)));
  }

  // 6) FALLBACK: a real-number QUESTION, never a numberless template.
  {
    const s = createInitialGameState("el_alamein");
    const pv = previewHighImpactIntent(attackAll, s, s.style)!;
    const facts = buildPreflightConcernFacts(s, pv);
    const line = buildPreflightFallbackLine(facts);
    check("fallback: contains real dispatch number", line.includes(`${facts.totalDispatched} 个单位`), line);
    check("fallback: is a question", line.endsWith("是否继续？"), line);
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
