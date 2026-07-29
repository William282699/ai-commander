// ============================================================
// AI Commander — dispatch-scope bench (dispatch-scope-v1)
//
// The rung's contract (user-ruled 2026-07-28, DISPATCH_SCOPE_V1_PROPOSAL.md):
//   作用域归 fromFront / fromSquad，数量归 quantity；
//   quantity 永远不许扩大作用域。唯一的全军入口是 fromFront 本身为"全军/all"。
//
// 家法（第四次判据教训）：every troop-moving assertion below runs the REAL
// resolveIntent and counts assignedUnitIds + checks the SOURCE SET of every
// assigned unit. Never option labels, never log strings alone — "说地名 9/9
// 全对" once passed while actual dispatch counts jumped between 8/74/0.
//
// Modes:
//   --synthetic  deterministic assertions (no LLM, no server)
//   --real       real-model probes: ask the LLM for intents, then resolve
//                LOCALLY and count (COMMAND_URL, default :3004 worktree server)
//
// Run (from the worktree root):
//   ./node_modules/.bin/tsx scripts/ab-dispatch-scope.ts --synthetic
// ============================================================

import { createInitialGameState, resolveIntent, previewHighImpactIntent, buildDigest } from "@ai-commander/core";
import type { GameState, Unit, Squad, Intent } from "@ai-commander/shared";

// ── Harness ──

let failCount = 0;
function check(name: string, ok: boolean, detail = ""): void {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok || !detail ? "" : ` — ${detail}`}`);
  if (!ok) failCount++;
}

/** Fresh el_alamein state with all units/squads removed (fronts/regions/facilities kept). */
function emptyBattlefield(): GameState {
  const state = createInitialGameState("el_alamein");
  state.units.clear();
  state.squads = [];
  state.missions = [];
  return state;
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

function addSquad(state: GameState, ids: number[], over: Partial<Squad> = {}): Squad {
  const sq: Squad = {
    id: over.id ?? `B${nextId++}`,
    name: "bench squad",
    unitIds: ids,
    leader: { name: "Bench", rank: "sergeant" as Squad["leader"]["rank"], personality: "balanced" },
    currentMission: null,
    missionTarget: null,
    morale: 1,
    formationStyle: "line",
    ownerCommander: "chen",
    leaderName: "Bench",
    role: "leader",
    ...over,
  };
  state.squads.push(sq);
  return sq;
}

// Fixture geometry (el_alamein, same exclusive points as the presence bench):
// COASTAL inside front_coastal only; RIDGE inside front_ridge only; SOUTH deep
// in southern_desert (y=150 — y=140 sits ON central_desert's inclusive edge).
const COASTAL = { x: 300, y: 30 };
const RIDGE = { x: 220, y: 65 };
const SOUTH = { x: 300, y: 150 };

interface Army {
  state: GameState;
  coastalIds: number[];
  ridgeIds: number[];
  southIds: number[];
  allIds: number[];
}

/** Three groups: 4 on coastal (squad I1 "Aiden"), 3 on ridge, 5 far south. */
function threeGroupArmy(): Army {
  const s = emptyBattlefield();
  s.time = 120;
  const coastalIds: number[] = [];
  for (let i = 0; i < 4; i++) coastalIds.push(addUnit(s, COASTAL.x + i * 2, COASTAL.y).id);
  addSquad(s, coastalIds, { id: "I1", leaderName: "Aiden" });
  const ridgeIds: number[] = [];
  for (let i = 0; i < 3; i++) ridgeIds.push(addUnit(s, RIDGE.x + i * 2, RIDGE.y).id);
  const southIds: number[] = [];
  for (let i = 0; i < 5; i++) southIds.push(addUnit(s, SOUTH.x + i * 2, SOUTH.y).id);
  return { state: s, coastalIds, ridgeIds, southIds, allIds: [...coastalIds, ...ridgeIds, ...southIds] };
}

/** assignedUnitIds ⊆ expected set, with human-readable spill detail. */
function sourceSetOk(assigned: number[], allowed: number[]): { ok: boolean; detail: string } {
  const allowedSet = new Set(allowed);
  const spill = assigned.filter((id) => !allowedSet.has(id));
  return { ok: spill.length === 0, detail: spill.length > 0 ? `spilled ids: ${spill.join(",")}` : "" };
}

function run(army: Army, intent: Intent) {
  return resolveIntent(intent, army.state, army.state.style);
}

// ── --synthetic ──

function runSynthetic(): void {
  console.log("== dispatch-scope regression net (behaviors the knife must NOT change) ==");

  // N1) The ONE legitimate full-army entrance: fromFront itself says 全军
  //     (isAllFrontHint branch). Must keep returning the global pool.
  {
    const a = threeGroupArmy();
    const r = run(a, { type: "retreat", fromFront: "全军", quantity: "all" } as Intent);
    check("N1 fromFront=全军 retreat → whole army moves", r.assignedUnitIds.length === a.allIds.length,
      `assigned ${r.assignedUnitIds.length}/${a.allIds.length}`);
  }

  // N2) Numeric quantity inside a front: strict source, count honored.
  {
    const a = threeGroupArmy();
    const r = run(a, { type: "attack", fromFront: "front_coastal", toFront: "front_ridge", quantity: 2 } as Intent);
    const src = sourceSetOk(r.assignedUnitIds, a.coastalIds);
    check("N2 fromFront + quantity=2 attack → 2 units, coastal only",
      r.assignedUnitIds.length === 2 && src.ok, `assigned ${r.assignedUnitIds.length}; ${src.detail}`);
  }

  // N3/N4) fromSquad by squad id AND by leader name → exactly that squad.
  {
    const a = threeGroupArmy();
    const rId = run(a, { type: "retreat", fromSquad: "I1" } as Intent);
    const s1 = sourceSetOk(rId.assignedUnitIds, a.coastalIds);
    check("N3 fromSquad=I1 retreat → exactly the squad", rId.assignedUnitIds.length === a.coastalIds.length && s1.ok,
      `assigned ${rId.assignedUnitIds.length}/${a.coastalIds.length}; ${s1.detail}`);
    const b = threeGroupArmy();
    const rName = resolveIntent({ type: "retreat", fromSquad: "Aiden" } as Intent, b.state, b.state.style);
    const s2 = sourceSetOk(rName.assignedUnitIds, b.coastalIds);
    check("N4 fromSquad=Aiden (leader name) retreat → exactly the squad",
      rName.assignedUnitIds.length === b.coastalIds.length && s2.ok,
      `assigned ${rName.assignedUnitIds.length}/${b.coastalIds.length}; ${s2.detail}`);
    // N4b) Case drift ("aiden") resolves too — the engine's leaderName match
    //      must equal the ChatPanel gate's case-insensitive predicate, or a
    //      reference the gate accepts dies downstream as a confusing error.
    const c = threeGroupArmy();
    const rLower = resolveIntent({ type: "retreat", fromSquad: "aiden" } as Intent, c.state, c.state.style);
    const s3 = sourceSetOk(rLower.assignedUnitIds, c.coastalIds);
    check("N4b fromSquad=aiden (case drift) retreat → exactly the squad",
      rLower.assignedUnitIds.length === c.coastalIds.length && s3.ok,
      `assigned ${rLower.assignedUnitIds.length}/${c.coastalIds.length}; ${s3.detail}`);
  }

  // N5) Engine-level loud failure on unresolvable fromSquad: degraded + error
  //     log + ZERO units. (2a's UI soft-fix bypasses this — locked here so the
  //     engine guarantee can never quietly rot.)
  {
    const a = threeGroupArmy();
    const r = run(a, { type: "retreat", fromSquad: "艾登大队" } as Intent);
    check("N5 unresolvable fromSquad → degraded + 0 units + named error",
      r.degraded === true && r.assignedUnitIds.length === 0 && r.log.includes("无法找到分队"),
      `degraded=${r.degraded} assigned=${r.assignedUnitIds.length} log=${r.log}`);
  }

  // N6) Empty named front + retreat, NON-all quantity: the existing
  //     mis-retreat guard (:1447) answers with an error, never the global
  //     pool. (Under quantity=all the :1405 shortcut returns global BEFORE
  //     this guard can run — the guard is dead code there today; the contract
  //     section will assert the all-path once the knife makes it reachable.)
  {
    const a = threeGroupArmy();
    for (const id of a.coastalIds) a.state.units.delete(id);
    a.state.squads = [];
    const r = run(a, { type: "retreat", fromFront: "front_coastal", quantity: 2 } as Intent);
    check("N6 empty front retreat (qty=2) → error, not global",
      r.assignedUnitIds.length === 0 && r.degraded === true, `assigned=${r.assignedUnitIds.length} log=${r.log}`);
  }

  // ── Contract: quantity never widens scope (the knife itself) ──
  console.log("\n== dispatch-scope contract (作用域归 fromFront，数量归 quantity) ==");

  // C1-C4) The headline: fromFront + quantity=all for every unit-moving type
  //        → ALL of that front, ONLY that front. (attack/recon need a target.)
  {
    const cases: Array<[string, Intent]> = [
      ["C1 retreat", { type: "retreat", fromFront: "front_coastal", toFront: "ea_player_hq", quantity: "all" } as Intent],
      ["C2 attack", { type: "attack", fromFront: "front_coastal", toFront: "front_ridge", quantity: "all" } as Intent],
      ["C3 defend", { type: "defend", fromFront: "front_coastal", toFront: "front_ridge", quantity: "all" } as Intent],
      ["C4 recon", { type: "recon", fromFront: "front_coastal", toFront: "front_ridge", quantity: "all" } as Intent],
    ];
    for (const [name, intent] of cases) {
      const a = threeGroupArmy();
      const r = run(a, intent);
      const src = sourceSetOk(r.assignedUnitIds, a.coastalIds);
      check(`${name} fromFront+all → all of the front, only the front`,
        r.assignedUnitIds.length === a.coastalIds.length && src.ok,
        `assigned ${r.assignedUnitIds.length}/${a.coastalIds.length}; ${src.detail}`);
    }
  }

  // C5) quantity=most narrows WITHIN the front (ceil(4*0.75)=3), never beyond.
  {
    const a = threeGroupArmy();
    const r = run(a, { type: "retreat", fromFront: "front_coastal", quantity: "most" } as Intent);
    const src = sourceSetOk(r.assignedUnitIds, a.coastalIds);
    check("C5 fromFront+most → 3/4 of the front, only the front",
      r.assignedUnitIds.length === 3 && src.ok, `assigned ${r.assignedUnitIds.length}; ${src.detail}`);
  }

  // C6) Multi-front hint + all → the union of the NAMED fronts, nothing else.
  {
    const a = threeGroupArmy();
    const r = run(a, { type: "retreat", fromFront: "front_coastal,front_ridge", quantity: "all" } as Intent);
    const allowed = [...a.coastalIds, ...a.ridgeIds];
    const src = sourceSetOk(r.assignedUnitIds, allowed);
    check("C6 two named fronts + all → their union only",
      r.assignedUnitIds.length === allowed.length && src.ok,
      `assigned ${r.assignedUnitIds.length}/${allowed.length}; ${src.detail}`);
  }

  // C7) Empty named front + all → the :1447 guard is now REACHABLE: error,
  //     zero units, never the global pool (N6's dead-code end, revived).
  {
    const a = threeGroupArmy();
    for (const id of a.coastalIds) a.state.units.delete(id);
    a.state.squads = [];
    const r = run(a, { type: "retreat", fromFront: "front_coastal", quantity: "all" } as Intent);
    check("C7 empty front retreat+all → error, not global",
      r.assignedUnitIds.length === 0 && r.degraded === true, `assigned=${r.assignedUnitIds.length} log=${r.log}`);
  }

  // C8) Boundary documented, deliberately UNCHANGED this rung (proposal names
  //     :1405 only): toFront-only + quantity=all still broadens to the global
  //     pool (:1467 wantsBroadDispatch). Locked so any future change to it is
  //     a conscious one.
  {
    const a = threeGroupArmy();
    const r = run(a, { type: "retreat", toFront: "ea_player_hq", quantity: "all" } as Intent);
    check("C8 toFront-only retreat+all keeps its current broad dispatch (out of scope)",
      r.assignedUnitIds.length === a.allIds.length, `assigned ${r.assignedUnitIds.length}/${a.allIds.length}`);
  }

  console.log(failCount === 0 ? "\nALL SYNTHETIC PASS" : `\n${failCount} FAILURES`);
  process.exit(failCount === 0 ? 0 : 1);
}

// ── Entry ──

const mode = process.argv[2];
if (mode === "--synthetic") runSynthetic();
else {
  console.log("usage: tsx scripts/ab-dispatch-scope.ts --synthetic | --real");
  process.exit(2);
}
