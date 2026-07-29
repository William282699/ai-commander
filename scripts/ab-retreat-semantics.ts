// ============================================================
// AI Commander — retreat-semantics bench (retreat-semantics-v1)
//
// The rung's contract (user-ruled 2026-07-28, RETREAT_SEMANTICS_V1_PROPOSAL.md):
//   撤退读目的地（与其余动词同走 resolveTarget）；无目的地保留朝总部退一截，
//   落点逐字不漂移；目的地==出发地→走默认；到位后转 defending 守住落点，
//   不落 idle（idle 会被自动接敌拉回原战线）。
//
// ★ 判据铁律（本级新增）：会动兵的断言数 assignedUnitIds 之外必须核【实际落点
//   坐标】——这次的病正是"数量对、落点错"，只数数量抓不到。默认行为用改前快照
//   （EXPECTED_* 常量，2026-07-28 于 92ff364 未改动引擎上抓取）逐字对照。
//
// Modes:
//   --synthetic       deterministic assertions
//   --print-snapshot  print current per-verb order JSON (for snapshot refresh)
// ============================================================

import { createInitialGameState, resolveIntent, applyOrders } from "@ai-commander/core";
import { tick } from "../packages/core/src/sim";
import type { GameState, Unit, Squad, Intent } from "@ai-commander/shared";

// ── Harness ──

let failCount = 0;
function check(name: string, ok: boolean, detail = ""): void {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok || !detail ? "" : ` — ${detail}`}`);
  if (!ok) failCount++;
}

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

const COASTAL = { x: 300, y: 30 };

/** Fixed 4-unit coastal squad — nextId reset so every build is id-identical. */
function coastalArmy(): { state: GameState; ids: number[] } {
  nextId = 9000;
  const s = emptyBattlefield();
  s.time = 120;
  const ids: number[] = [];
  for (let i = 0; i < 4; i++) ids.push(addUnit(s, COASTAL.x + i * 2, COASTAL.y).id);
  addSquad(s, ids, { id: "I1", leaderName: "Aiden" });
  return { state: s, ids };
}

/** Stable projection of orders for byte-compare snapshots. */
function ordersKey(orders: ReturnType<typeof resolveIntent>["orders"]): string {
  return JSON.stringify(
    orders.map((o) => ({ u: [...o.unitIds].sort((a, b) => a - b), a: o.action, t: o.target })),
  );
}

const VERBS: Array<[string, Intent]> = [
  ["retreat-default", { type: "retreat", fromFront: "front_coastal", quantity: "all" } as Intent],
  ["attack", { type: "attack", fromFront: "front_coastal", toFront: "front_ridge", quantity: "all" } as Intent],
  ["defend", { type: "defend", fromFront: "front_coastal", toFront: "front_ridge", quantity: "all" } as Intent],
  ["recon", { type: "recon", fromFront: "front_coastal", toFront: "front_ridge", quantity: "all" } as Intent],
  ["patrol", { type: "patrol", fromFront: "front_coastal", toFront: "front_ridge", quantity: "all" } as Intent],
];

function currentKey(intent: Intent): string {
  const { state } = coastalArmy();
  return ordersKey(resolveIntent(intent, state, state.style).orders);
}

// ── Pre-change snapshots (captured on 92ff364, engine untouched) ──
const EXPECTED: Record<string, string> = {
  "retreat-default": "[{\"u\":[9000],\"a\":\"retreat\",\"t\":{\"x\":323,\"y\":40}},{\"u\":[9001],\"a\":\"retreat\",\"t\":{\"x\":325,\"y\":41}},{\"u\":[9002],\"a\":\"retreat\",\"t\":{\"x\":327,\"y\":41}},{\"u\":[9003],\"a\":\"retreat\",\"t\":{\"x\":329,\"y\":41}}]",
  "attack": "[{\"u\":[9000],\"a\":\"attack_move\",\"t\":{\"x\":240.5,\"y\":76}},{\"u\":[9001],\"a\":\"attack_move\",\"t\":{\"x\":239,\"y\":77.5}},{\"u\":[9002],\"a\":\"attack_move\",\"t\":{\"x\":237.5,\"y\":76}},{\"u\":[9003],\"a\":\"attack_move\",\"t\":{\"x\":239,\"y\":74.5}}]",
  "defend": "[{\"u\":[9000],\"a\":\"defend\",\"t\":{\"x\":240,\"y\":76}},{\"u\":[9001],\"a\":\"defend\",\"t\":{\"x\":239,\"y\":77}},{\"u\":[9002],\"a\":\"defend\",\"t\":{\"x\":238,\"y\":76}},{\"u\":[9003],\"a\":\"defend\",\"t\":{\"x\":239,\"y\":75}}]",
  "recon": "[{\"u\":[9000],\"a\":\"recon\",\"t\":{\"x\":239,\"y\":76}},{\"u\":[9001],\"a\":\"recon\",\"t\":{\"x\":239,\"y\":76}},{\"u\":[9002],\"a\":\"recon\",\"t\":{\"x\":239,\"y\":76}},{\"u\":[9003],\"a\":\"recon\",\"t\":{\"x\":239,\"y\":76}}]",
  "patrol": "[{\"u\":[9000],\"a\":\"patrol\",\"t\":{\"x\":239,\"y\":76}},{\"u\":[9001],\"a\":\"patrol\",\"t\":{\"x\":239,\"y\":76}},{\"u\":[9002],\"a\":\"patrol\",\"t\":{\"x\":239,\"y\":76}},{\"u\":[9003],\"a\":\"patrol\",\"t\":{\"x\":239,\"y\":76}}]",
};

// ── --print-snapshot ──

function printSnapshot(): void {
  for (const [name, intent] of VERBS) {
    console.log(`  "${name}": ${JSON.stringify(currentKey(intent))},`);
  }
}

// ── --synthetic ──

function runSynthetic(): void {
  console.log("== retreat-semantics: default-behavior snapshots (不许漂移) ==");
  for (const [name, intent] of VERBS) {
    const expected = EXPECTED[name];
    if (!expected) {
      check(`S0 snapshot present for ${name}`, false, "run --print-snapshot and paste");
      continue;
    }
    const actual = currentKey(intent);
    check(`S1 ${name} landing coordinates byte-identical to pre-change snapshot`,
      actual === expected,
      `actual=${actual.slice(0, 120)}…`);
  }

  // ── 修法1+3 contract: destination read, coordinates verified ──
  console.log("\n== retreat destination contract (读目的地；目的地==出发地→默认) ==");

  // Expected destination center derived from PRODUCTION code, not re-math:
  // a single-unit defend at the same toFront lands on resolveTarget's center
  // (spread of 1 unit = the center itself, modulo passability).
  const expectedCenter = (toFront: string): { x: number; y: number } => {
    nextId = 9000;
    const s = emptyBattlefield();
    const u = addUnit(s, COASTAL.x, COASTAL.y);
    addSquad(s, [u.id], { id: "I1", leaderName: "Aiden" });
    const r = resolveIntent({ type: "defend", fromFront: "front_coastal", toFront, quantity: "all" } as Intent, s, s.style);
    if (r.orders.length !== 1 || !r.orders[0].target) throw new Error(`no center probe for ${toFront}`);
    return r.orders[0].target;
  };
  const near = (p: { x: number; y: number }, c: { x: number; y: number }, tol: number): boolean =>
    Math.hypot(p.x - c.x, p.y - c.y) <= tol;

  // D1) retreat + toFront=front_south → every landing within spread+degrade
  //     tolerance of the ONE resolver's center, counts+source intact.
  {
    const { state, ids } = coastalArmy();
    const center = expectedCenter("front_south");
    const r = resolveIntent({ type: "retreat", fromFront: "front_coastal", toFront: "front_south", quantity: "all" } as Intent, state, state.style);
    const landings = r.orders.map((o) => o.target).filter((t): t is { x: number; y: number } => t !== null);
    check("D1 retreat reads toFront: 4 units land at the named front",
      r.assignedUnitIds.length === ids.length &&
      landings.length === ids.length &&
      landings.every((t) => near(t, center, 4)),
      `center=(${center.x},${center.y}) landings=${JSON.stringify(landings)}`);
    check("D1b transit action stays retreat (no-chase semantics)",
      r.orders.every((o) => o.action === "retreat"));
    check("D1c receipt names the destination, not 安全区域",
      r.log.includes("撤退至") && !r.log.includes("安全区域"), r.log);
  }

  // D2) targetFacility destination (normalizeIntentLocations moves a facility
  //     put in toFront) — landings at the facility.
  {
    const { state, ids } = coastalArmy();
    const r = resolveIntent({ type: "retreat", fromFront: "front_coastal", toFront: "ea_player_hq", quantity: "all" } as Intent, state, state.style);
    const hq = state.facilities.get("ea_player_hq");
    if (!hq) throw new Error("no ea_player_hq facility");
    const landings = r.orders.map((o) => o.target).filter((t): t is { x: number; y: number } => t !== null);
    check("D2 facility destination: landings at the HQ",
      r.assignedUnitIds.length === ids.length && landings.every((t) => near(t, hq.position, 4)),
      `hq=(${hq.position.x},${hq.position.y}) landings=${JSON.stringify(landings)}`);
  }

  // D3) 修法3: destination == departure front → ignored, byte-identical to the
  //     default snapshot (the toFront field changes NOTHING).
  {
    nextId = 9000;
    const s = emptyBattlefield();
    s.time = 120;
    const ids: number[] = [];
    for (let i = 0; i < 4; i++) ids.push(addUnit(s, COASTAL.x + i * 2, COASTAL.y).id);
    addSquad(s, ids, { id: "I1", leaderName: "Aiden" });
    const r = resolveIntent({ type: "retreat", fromFront: "front_coastal", toFront: "front_coastal", quantity: "all" } as Intent, s, s.style);
    check("D3 destination==departure → default landings, byte-identical",
      ordersKey(r.orders) === EXPECTED["retreat-default"], ordersKey(r.orders).slice(0, 120));
  }

  // D4) Scope contract survives the new branch: only the named front's units
  //     move, even with a destination named (dispatch-scope holds through).
  {
    const { state, ids } = coastalArmy();
    for (let i = 0; i < 5; i++) addUnit(state, 300 + i * 2, 150); // southern bystanders
    const r = resolveIntent({ type: "retreat", fromFront: "front_coastal", toFront: "front_south", quantity: "all" } as Intent, state, state.style);
    const allowed = new Set(ids);
    check("D4 destination retreat still front-scoped",
      r.assignedUnitIds.length === ids.length && r.assignedUnitIds.every((id) => allowed.has(id)),
      `assigned=${r.assignedUnitIds.length}`);
  }

  console.log(failCount === 0 ? "\nALL SYNTHETIC PASS" : `\n${failCount} FAILURES`);
  process.exit(failCount === 0 ? 0 : 1);
}

// keep unused imports referenced until later commits wire them in
void applyOrders;
void tick;

// ── Entry ──

const mode = process.argv[2];
if (mode === "--synthetic") runSynthetic();
else if (mode === "--print-snapshot") printSnapshot();
else {
  console.log("usage: tsx scripts/ab-retreat-semantics.ts --synthetic | --print-snapshot");
  process.exit(2);
}
