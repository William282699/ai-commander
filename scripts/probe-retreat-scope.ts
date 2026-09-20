// ============================================================
// AI Commander — 改令这条链 · A/B/C 三刀共用探针
//   （probe- 前缀 ⇒ 不进 run-benches 的硬编码清单，各刀自己跑）
//
// 计划：RETREAT_SCOPE_V2_WORKPLAN_20260920.md
//
// 跑法：
//   npx tsx scripts/probe-retreat-scope.ts --knife=a
//   npx tsx scripts/probe-retreat-scope.ts --knife=a --negctl
//   （--knife=b / --knife=c 见各自小节；--knife=all 全跑）
//
// ★ 台架硬要求（计划 §4.3，旧账写过）：`tick()` **不含** processAutoBehavior /
//   敌方 AI / 导演。所有"撤到之后"的判据必须跑 fullPump（完整循环序）。
//   只跑 tick 的台架曾让三方全绿、实机照样掉头。
//
// ★ 判据家法：会动兵的断言数 assignedUnitIds **并核实际落点坐标**；
//   "期望中心"一律从**生产代码**探出来（单位 defend 探针），不在台架里重算几何。
// ============================================================

import { createInitialGameState, resolveIntent, applyOrders, updateFog, processAutoBehavior } from "@ai-commander/core";
import { tick } from "../packages/core/src/sim";
import { processEnemyAI } from "../packages/core/src/enemyAI";
import { processDefensiveAI } from "../packages/core/src/scenario/elAlamein/defensiveAI";
import { processPressureDirector } from "../packages/core/src/scenario/elAlamein/pressureDirector";
import type { GameState, Unit, Squad, Intent, ScenarioId } from "@ai-commander/shared";

// ── 0. Harness ──

let failCount = 0;
let checkCount = 0;
function check(name: string, ok: boolean, detail = ""): void {
  checkCount++;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok || !detail ? "" : ` — ${detail}`}`);
  if (!ok) failCount++;
}
function info(line: string): void {
  console.log(`     · ${line}`);
}

function emptyBattlefield(scenario: ScenarioId = "el_alamein"): GameState {
  const state = createInitialGameState(scenario);
  state.units.clear();
  state.squads = [];
  state.missions = [];
  return state;
}

const templateCache = new Map<string, Unit>();
function unitTemplate(scenario: ScenarioId): Unit {
  const hit = templateCache.get(scenario);
  if (hit) return hit;
  const s = createInitialGameState(scenario);
  let found: Unit | null = null;
  s.units.forEach((u) => {
    if (!found && u.team === "player" && u.type === "infantry") found = u;
  });
  if (!found) throw new Error(`no player infantry in ${scenario} opening`);
  templateCache.set(scenario, found);
  return found;
}

let nextId = 9000;
function addUnit(state: GameState, x: number, y: number, over: Partial<Unit> = {}, scenario: ScenarioId = "el_alamein"): Unit {
  const u: Unit = {
    ...structuredClone(unitTemplate(scenario)),
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
    id: over.id ?? `P${nextId++}`,
    name: "probe squad",
    unitIds: ids,
    leader: { name: "Probe", rank: "sergeant" as Squad["leader"]["rank"], personality: "balanced" },
    currentMission: null,
    missionTarget: null,
    morale: 1,
    formationStyle: "line",
    ownerCommander: "chen",
    leaderName: "Probe",
    role: "leader",
    ...over,
  };
  state.squads.push(sq);
  return sq;
}

/** ★ 完整循环序（镜像 GameCanvas）——"撤到之后"的判据只许用这个。 */
function fullPump(s: GameState, seconds: number, dt = 0.5): void {
  let sinceFog = 1;
  for (let t = 0; t < seconds; t += dt) {
    if (sinceFog >= 1) { updateFog(s); sinceFog = 0; }
    tick(s, dt);
    processEnemyAI(s, dt);
    processDefensiveAI(s, dt);
    processPressureDirector(s, dt);
    processAutoBehavior(s, dt);
    sinceFog += dt;
  }
}

/** 稳定投影，供逐字节金样比对。 */
function ordersKey(orders: ReturnType<typeof resolveIntent>["orders"]): string {
  return JSON.stringify(
    orders.map((o) => ({ u: [...o.unitIds].sort((a, b) => a - b), a: o.action, t: o.target })),
  );
}

const near = (p: { x: number; y: number }, c: { x: number; y: number }, tol: number): boolean =>
  Math.hypot(p.x - c.x, p.y - c.y) <= tol;

// ════════════════════════════════════════════════════════════
// 刀 A：说了地点就去那个地点
// ════════════════════════════════════════════════════════════
//
// 根因（计划 §A.1）：「修法3」把"同一条战线"当成"同一个位置"——而前哨天然
// 坐落在自己那条战线里，于是「让某条线的部队撤回自家前哨」目的地必然被抹掉。
//   南线前哨 (365,155) ∈ alam_halfa_zone [320,138,365,165]（front_south）
//   中央前哨 (360,105) ∈ central_desert  [276,80,370,137]（front_center）
//   教学关 我方哨站 (36,30) ∈ tut_base   [4,20,40,60]（tut_front_center）
// 三张都不是特例，是地图设计的普遍形态。

/** 南线上的一支 4 人小队（id 固定，金样可比）。 */
function southArmy(): { state: GameState; ids: number[] } {
  nextId = 9000;
  const s = emptyBattlefield("el_alamein");
  s.time = 120;
  const ids: number[] = [];
  for (let i = 0; i < 4; i++) ids.push(addUnit(s, 340 + i * 2, 150).id);
  addSquad(s, ids, { id: "PA", leaderName: "Probe" });
  return { state: s, ids };
}

/** 教学关中央战线上的一支 4 人小队。 */
function tutorialArmy(): { state: GameState; ids: number[] } {
  nextId = 9000;
  const s = emptyBattlefield("tutorial");
  s.time = 120;
  const ids: number[] = [];
  for (let i = 0; i < 4; i++) ids.push(addUnit(s, 56 + i * 2, 40, {}, "tutorial").id);
  addSquad(s, ids, { id: "PT", leaderName: "Probe" });
  return { state: s, ids };
}

/** 期望落点中心：**从生产代码探出来**（同 fixture 的单位 defend 探针），
 *  不在台架里重算几何——重算会把台架和引擎的分歧算成"通过"。 */
function probeCenter(
  build: () => { state: GameState; ids: number[] },
  destFields: Partial<Intent>,
): { x: number; y: number } {
  const { state } = build();
  // 只留一个单位 ⇒ spread 半径退化为中心本身（modulo 可通行性）
  const keep = [...state.units.keys()][0];
  state.units.forEach((u, id) => { if (id !== keep) state.units.delete(id); });
  const r = resolveIntent({ type: "defend", fromSquad: state.squads[0].id, quantity: "all", ...destFields } as Intent, state, state.style);
  const t = r.orders[0]?.target;
  if (!t) throw new Error(`no center probe for ${JSON.stringify(destFields)}`);
  return t;
}

// ── 金样（在 4e41486 未改引擎上抓取 = 计划所说的 pre-retreat-fix 那版行为）──
//    A3/A4/A5 三条负对照钉的就是这三串：本刀一个字节都不许碰它们。
const GOLD_A = {
  // 「快撤」——无任何目的地字段
  bare: "[{\"u\":[9000],\"a\":\"retreat\",\"t\":{\"x\":361,\"y\":136}},{\"u\":[9001],\"a\":\"retreat\",\"t\":{\"x\":363,\"y\":136}},{\"u\":[9002],\"a\":\"retreat\",\"t\":{\"x\":365,\"y\":136}},{\"u\":[9003],\"a\":\"retreat\",\"t\":{\"x\":366,\"y\":135}}]",
  // toFront == fromFront、无设施 ⇒ 仍然丢弃（与 bare 逐字节相同）
  sameFront: "[{\"u\":[9000],\"a\":\"retreat\",\"t\":{\"x\":361,\"y\":136}},{\"u\":[9001],\"a\":\"retreat\",\"t\":{\"x\":363,\"y\":136}},{\"u\":[9002],\"a\":\"retreat\",\"t\":{\"x\":365,\"y\":136}},{\"u\":[9003],\"a\":\"retreat\",\"t\":{\"x\":366,\"y\":135}}]",
  // toFront != fromFront ⇒ 本来就走 resolveTarget，不受本刀影响
  otherFront: "[{\"u\":[9000],\"a\":\"retreat\",\"t\":{\"x\":361,\"y\":35}},{\"u\":[9001],\"a\":\"retreat\",\"t\":{\"x\":360,\"y\":36}},{\"u\":[9002],\"a\":\"retreat\",\"t\":{\"x\":359,\"y\":35}},{\"u\":[9003],\"a\":\"retreat\",\"t\":{\"x\":360,\"y\":34}}]",
};

function knifeA(negctl: boolean): void {
  console.log("== 刀 A：说了地点就去那个地点 ==");

  const bareIntent = { type: "retreat", fromFront: "front_south", quantity: "all" } as Intent;
  const sameFrontIntent = { type: "retreat", fromFront: "front_south", toFront: "front_south", quantity: "all" } as Intent;
  const otherFrontIntent = { type: "retreat", fromFront: "front_south", toFront: "front_coastal", quantity: "all" } as Intent;
  const namedIntent = { type: "retreat", fromFront: "front_south", targetFacility: "ea_player_south_post", quantity: "all" } as Intent;
  const tutNamedIntent = { type: "retreat", fromFront: "tut_front_center", targetFacility: "tut_player_post", quantity: "all" } as Intent;

  if (process.argv.includes("--print-gold")) {
    const k = (i: Intent, b = southArmy) => ordersKey(resolveIntent(i, b().state, b().state.style).orders);
    console.log(`  bare:        ${JSON.stringify(k(bareIntent))},`);
    console.log(`  sameFront:   ${JSON.stringify(k(sameFrontIntent))},`);
    console.log(`  otherFront:  ${JSON.stringify(k(otherFrontIntent))},`);
    return;
  }

  // ── A1 正向：单位仍在本线，说「撤回<本线的前哨>」⇒ 落点在该前哨，log 报前哨名 ──
  {
    const { state, ids } = southArmy();
    const center = probeCenter(southArmy, { targetFacility: "ea_player_south_post" });
    const post = state.facilities.get("ea_player_south_post")!;
    const r = resolveIntent(namedIntent, state, state.style);
    const landings = r.orders.map((o) => o.target).filter((t): t is { x: number; y: number } => t !== null);
    check("A1 本线部队撤回本线前哨：4 个单位全部落在该前哨 spread 内",
      r.assignedUnitIds.length === ids.length &&
      landings.length === ids.length &&
      landings.every((t) => near(t, center, 4)),
      `center=(${center.x},${center.y}) landings=${JSON.stringify(landings)}`);
    check("A1b 回执报前哨名，不报「安全区域」",
      r.log.includes(post.name) && !r.log.includes("安全区域"), r.log);
    check("A1c 落点确实是前哨、不是默认后撤那一截（离前哨 ≤4 格、离出发点 >10 格）",
      landings.every((t) => near(t, post.position, 4)) &&
      landings.every((t) => Math.hypot(t.x - 340, t.y - 150) > 10),
      `post=(${post.position.x},${post.position.y}) landings=${JSON.stringify(landings)}`);
  }

  // ── A2 换一张图复跑同一条（规则与地名无关）──
  {
    const { state, ids } = tutorialArmy();
    const center = probeCenter(tutorialArmy, { targetFacility: "tut_player_post" });
    const post = state.facilities.get("tut_player_post")!;
    const r = resolveIntent(tutNamedIntent, state, state.style);
    const landings = r.orders.map((o) => o.target).filter((t): t is { x: number; y: number } => t !== null);
    check("A2 教学关同一条：落在我方哨站，回执报站名",
      r.assignedUnitIds.length === ids.length &&
      landings.length === ids.length &&
      landings.every((t) => near(t, center, 4)) &&
      r.log.includes(post.name) && !r.log.includes("安全区域"),
      `center=(${center.x},${center.y}) landings=${JSON.stringify(landings)} log=${r.log}`);
  }

  // ── A3/A4/A5 负对照：三条旧行为逐字节不许动 ──
  {
    const { state } = southArmy();
    const actual = ordersKey(resolveIntent(bareIntent, state, state.style).orders);
    check("A3 「快撤」（无目的地字段）逐字节与改前金样相同",
      actual === GOLD_A.bare, `actual=${actual.slice(0, 140)}…`);
  }
  {
    const { state } = southArmy();
    const actual = ordersKey(resolveIntent(sameFrontIntent, state, state.style).orders);
    check("A4 ★ toFront==fromFront 且无设施 ⇒ 仍然丢弃（那条保护还活着）",
      actual === GOLD_A.sameFront, `actual=${actual.slice(0, 140)}…`);
    check("A4b 丢弃后落点与「快撤」逐字节相同（走的就是默认后撤）",
      actual === GOLD_A.bare);
    const r = resolveIntent(sameFrontIntent, state, state.style);
    check("A4c 丢弃后回执说「安全区域」，不冒认战线名",
      r.log.includes("安全区域"), r.log);
  }
  {
    const { state } = southArmy();
    const actual = ordersKey(resolveIntent(otherFrontIntent, state, state.style).orders);
    check("A5 toFront != fromFront 不受本刀影响（逐字节与改前金样相同）",
      actual === GOLD_A.otherFront, `actual=${actual.slice(0, 140)}…`);
  }

  // ── A6 ★「撤到之后」必须跑完整循环（家法：tick() 不含 processAutoBehavior）──
  //    旧账：只跑 tick 的台架让三方全绿、实机照样整队掉头走回原岗。
  {
    const { state, ids } = southArmy();
    const post = state.facilities.get("ea_player_south_post")!;
    const home = { ...state.units.get(ids[0])!.position };
    const r = resolveIntent(namedIntent, state, state.style);
    applyOrders(state, r.orders);
    fullPump(state, 300);
    const units = ids.map((id) => state.units.get(id)!).filter((u) => u && u.state !== "dead");
    const atPost = units.filter((u) => near(u.position, post.position, 8));
    const marchedBack = units.filter((u) =>
      Math.hypot(u.position.x - home.x, u.position.y - home.y) <
      Math.hypot(u.position.x - post.position.x, u.position.y - post.position.y));
    check("A6 跑完整循环 300 秒：人到前哨、没有整队走回原岗",
      units.length === ids.length && atPost.length === units.length && marchedBack.length === 0,
      `atPost=${atPost.length}/${units.length} back=${marchedBack.length} pos=${JSON.stringify(units.map((u) => u.position))}`);
    check("A6b 到位后转 defending 守住落点（撤退语义 fix1 不许被本刀碰坏）",
      units.every((u) => u.state === "defending"),
      `states=${units.map((u) => u.state).join(",")}`);
  }

  // ── 绊索（计划 §A.3 第 6、7 条）──
  //
  // 6) 把收窄条件改回原样（"落在出发框内就丢"）⇒ A1、A2 当场红
  // 7) 把收窄写成"永远不丢弃"        ⇒ A4 当场红
  //
  // 这两条不靠影子实现来"模拟"——A1/A2/A4 的 fixture 本身就是那两种改法的
  // 反例（A1/A2 的目的地**就在**出发框内；A4 的目的地**就是**出发战线）。
  // --negctl 把**旧规则下的期望**打在新引擎上，要求它们真的 FAIL：
  // 0 个 FAIL ＝ 判据没牙。
  if (negctl) {
    console.log("\n-- negctl：旧规则期望打新引擎，必须真 FAIL --");
    let redA = 0;
    {
      // 旧规则（"落在出发框内就丢"）下：A1 的落点应当 == bare 金样
      const { state } = southArmy();
      const actual = ordersKey(resolveIntent(namedIntent, state, state.style).orders);
      const oldWouldSay = actual === GOLD_A.bare;
      console.log(`  ${oldWouldSay ? "GREEN(坏)" : "RED(好)"} negctl-1 旧规则期望：撤回本线前哨 == 默认后撤`);
      if (!oldWouldSay) redA++;
    }
    {
      // 教学关同理
      const { state } = tutorialArmy();
      const r = resolveIntent(tutNamedIntent, state, state.style);
      const oldWouldSay = r.log.includes("安全区域");
      console.log(`  ${oldWouldSay ? "GREEN(坏)" : "RED(好)"} negctl-2 旧规则期望：教学关撤回哨站 ⇒ 回执说「安全区域」`);
      if (!oldWouldSay) redA++;
    }
    {
      // "永远不丢弃"下：A4 的落点应当落在 front_south 的战线目的地上，而非默认后撤
      const { state } = southArmy();
      const actual = ordersKey(resolveIntent(sameFrontIntent, state, state.style).orders);
      const neverDiscardWouldSay = actual !== GOLD_A.bare;
      console.log(`  ${neverDiscardWouldSay ? "GREEN(坏)" : "RED(好)"} negctl-3 「永远不丢弃」期望：toFront==fromFront 也去战线中心`);
      if (!neverDiscardWouldSay) redA++;
    }
    check("negctl 三条旧/坏规则期望全部真 FAIL（判据有牙）", redA === 3, `只红了 ${redA}/3`);
  }
}

// ── main ──

const knifeArg = (process.argv.find((a) => a.startsWith("--knife=")) ?? "--knife=all").split("=")[1];
const negctl = process.argv.includes("--negctl");

if (knifeArg === "a" || knifeArg === "all") knifeA(negctl);

console.log(failCount === 0 ? `\nALL PASS (${checkCount} 条)` : `\n${failCount}/${checkCount} FAILURES`);
process.exit(failCount === 0 ? 0 : 1);
