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

import {
  createInitialGameState, resolveIntent, applyOrders, applyPlayerCommands, updateFog, processAutoBehavior,
  liveDispatchMembers, findDispatch, activeDispatches, findDispatchAmbiguity, isDispatchIntent,
} from "@ai-commander/core";
import { tick } from "../packages/core/src/sim";
import { processEnemyAI } from "../packages/core/src/enemyAI";
import { processDefensiveAI } from "../packages/core/src/scenario/elAlamein/defensiveAI";
import { processPressureDirector } from "../packages/core/src/scenario/elAlamein/pressureDirector";
import type { GameState, Unit, Squad, Intent, ScenarioId, Order, DispatchMeta, ApplyResult } from "@ai-commander/shared";
import { buildExecReceipt, type DispatchSlice } from "../apps/web/src/execReceipt";
import { planVoiceSpeech } from "../apps/web/src/voiceSpeech";
import { readFileSync } from "fs";
import { buildDigestForChannel } from "../apps/web/src/digestHelper";

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


// ════════════════════════════════════════════════════════════
// 刀 B：屏上和耳朵，都按**实际下令结果**说
// ════════════════════════════════════════════════════════════
//
// 根因两层（计划 §B.1）：
//   ① 计划 ≠ 执行。applyOrders 对每条 order 的 unitIds 还要过四道过滤，
//      而它过去返回 void ⇒ "计划选中 8 个、实际只对 5 个下了令"外界无从得知。
//   ② 真相源有两个。耳朵拿 data.brief（执行前的方案标题），屏上拿 result.log
//      （计划日志）——两边都早于执行。
//
// 本段判据只认 ApplyResult 与 buildExecReceipt 的**结构化事实**，不做字符串
// 匹配数字（家法：判据要测效果不测措辞）。唯一的字符串判据是"不许出现的东西"
// ——落点名不许出现在"没有执行"那句里，那是效果级的。

/** 把一条 retreat 意图解析出来，连同回执要用的 slice。 */
function planRetreatSlice(state: GameState, intent: Intent): { orders: Order[]; slice: DispatchSlice } {
  const r = resolveIntent(intent, state, state.style);
  return {
    orders: r.orders,
    slice: { action: intent.type, destinationName: r.destinationName, orderIndexes: r.orders.map((_, k) => k) },
  };
}

function knifeB(negctl: boolean): void {
  console.log("\n== 刀 B：屏上和耳朵，都按实际下令结果说 ==");

  const retreatIntent = { type: "retreat", fromFront: "front_south", targetFacility: "ea_player_south_post", quantity: "all" } as Intent;

  // ── B1 全成：报实际数与实际落点名 ──
  {
    const { state, ids } = southArmy();
    const post = state.facilities.get("ea_player_south_post")!;
    const { orders, slice } = planRetreatSlice(state, retreatIntent);
    const res = applyOrders(state, orders);
    const receipt = buildExecReceipt(res, [slice]);
    check("B1 全成：ApplyResult 的 appliedUnitIds 就是这 4 个人（逐 id 比对）",
      res.appliedUnitIds.length === ids.length && res.appliedUnitIds.every((id) => ids.includes(id)),
      `applied=${JSON.stringify(res.appliedUnitIds)}`);
    check("B1b 回执四项：人数=实际生效数、落点=引擎真送去的地方、成败=applied",
      receipt.facts.length === 1 &&
      receipt.facts[0].appliedCount === ids.length &&
      receipt.facts[0].rejectedCount === 0 &&
      receipt.facts[0].destinationName === post.name &&
      receipt.outcome === "applied",
      JSON.stringify(receipt.facts));
    check("B1c 回执里出现落点名",
      receipt.lines.join("").includes(post.name), receipt.lines.join(" "));
  }

  // ── B2 ★部分执行：计划选中 4 个、实际只对 2 个下了令 ──
  //    真实形状：模型生成那几秒里玩家右键接管了两支（manualOverride），
  //    或者人死了。解析器选人时它们还是可调的，applyOrders 才把它们挡下。
  {
    const { state, ids } = southArmy();
    const { orders, slice } = planRetreatSlice(state, retreatIntent);
    const plannedCount = orders.reduce((n, o) => n + o.unitIds.length, 0);
    // 解析之后、执行之前：两支被手动接管
    state.units.get(ids[2])!.manualOverride = true;
    state.units.get(ids[3])!.manualOverride = true;
    const res = applyOrders(state, orders);
    const receipt = buildExecReceipt(res, [slice]);
    check("B2 台架自证：计划确实选中了 4 个（否则下面这条证明不了什么）",
      plannedCount === 4, `planned=${plannedCount}`);
    check("B2b ★报的是实际生效那个数，不是计划数★",
      receipt.facts[0].appliedCount === 2 && receipt.facts[0].appliedCount !== plannedCount,
      JSON.stringify(receipt.facts));
    check("B2c 没接到命令的 2 个如实记账，带原因",
      receipt.facts[0].rejectedCount === 2 &&
      res.perOrder.flatMap((o) => o.rejected).every((r) => r.reason === "manual_override"),
      JSON.stringify(res.perOrder.flatMap((o) => o.rejected)));
    check("B2d 结局是「部分」，不是「全成」",
      receipt.outcome === "partial", receipt.outcome);
  }

  // ── B3 ★一个都没执行：明说没有执行 + 原因，**不出现落点名** ──
  {
    const { state, ids } = southArmy();
    const post = state.facilities.get("ea_player_south_post")!;
    const { orders, slice } = planRetreatSlice(state, retreatIntent);
    for (const id of ids) state.units.get(id)!.manualOverride = true;
    const res = applyOrders(state, orders);
    const receipt = buildExecReceipt(res, [slice]);
    check("B3 全被挡下：applied=0，结局 none",
      res.appliedUnitIds.length === 0 && receipt.outcome === "none",
      JSON.stringify(res.appliedUnitIds));
    check("B3b ★回执里不出现落点名（不许说「撤回南线前哨」）★",
      !receipt.lines.join("").includes(post.name), receipt.lines.join(" "));
    check("B3c 回执明说没有执行，并带上原因",
      receipt.lines.length === 1 && receipt.lines[0].includes("没有执行") && receipt.lines[0].includes("手动接管"),
      receipt.lines.join(" "));
  }

  // ── B4 重复下令：第三类结局（既不算新派兵，也不算失败）──
  {
    const { state, ids } = southArmy();
    const target = { x: 355, y: 150 };
    const mkOrders = (): Order[] => ids.map((id) => ({
      unitIds: [id], action: "defend" as const, target, priority: "medium" as const,
      crisisFrontId: "front_south",
    }));
    applyOrders(state, mkOrders());
    const firstOrderObjects = ids.map((id) => state.units.get(id)!.orders[0]);
    const res2 = applyOrders(state, mkOrders());
    const slice2: DispatchSlice = { action: "defend", destinationName: "南线前哨", orderIndexes: [0, 1, 2, 3] };
    const receipt2 = buildExecReceipt(res2, [slice2]);
    check("B4 再说一遍同一条命令 ⇒ 全部落在 alreadyDoing",
      res2.alreadyDoingUnitIds.length === ids.length && res2.appliedUnitIds.length === 0,
      `already=${res2.alreadyDoingUnitIds.length} applied=${res2.appliedUnitIds.length}`);
    check("B4b ★三个都不许：不算新派兵、不算失败、不重建任务★",
      receipt2.outcome === "already_doing" &&
      receipt2.facts[0].appliedCount === 0 &&
      receipt2.facts[0].rejectedCount === 0 &&
      ids.every((id, i) => state.units.get(id)!.orders[0] === firstOrderObjects[i]),
      JSON.stringify(receipt2.facts));
    check("B4c 回执说「已经在」，不说「已下令」",
      receipt2.lines.every((l) => l.includes("已经在") && !l.includes("已下令")),
      receipt2.lines.join(" "));
  }

  // ── B5 多意图一成一败：两句各自对应 ──
  {
    const { state, ids } = southArmy();
    // 第二批人在北线，专门给它造"全被接管"
    const northIds: number[] = [];
    for (let i = 0; i < 3; i++) northIds.push(addUnit(state, 300 + i * 2, 30).id);
    const a = planRetreatSlice(state, retreatIntent);
    const b = planRetreatSlice(state, { type: "retreat", fromFront: "front_coastal", targetFacility: "ea_player_coastal_post", quantity: "all" } as Intent);
    const allOrders = [...a.orders, ...b.orders];
    const slices: DispatchSlice[] = [
      { ...a.slice, orderIndexes: a.orders.map((_, k) => k) },
      { ...b.slice, orderIndexes: b.orders.map((_, k) => a.orders.length + k) },
    ];
    for (const id of northIds) state.units.get(id)!.manualOverride = true;
    const res = applyOrders(state, allOrders);
    const receipt = buildExecReceipt(res, slices);
    check("B5 两条意图两句回执，各报各的",
      receipt.lines.length === 2 &&
      receipt.facts[0].appliedCount === ids.length && receipt.facts[0].outcome === "applied" &&
      receipt.facts[1].appliedCount === 0 && receipt.facts[1].outcome === "none",
      JSON.stringify(receipt.facts));
    check("B5b 失败那句不带它的落点名（另一句照常带）",
      !receipt.lines[1].includes("北线前哨") && receipt.lines[0].includes("南线前哨"),
      receipt.lines.join(" | "));
  }

  // ── B6 ★屏与耳同源：同一次调用、同一份字符串 ──
  {
    const { state } = southArmy();
    const { orders, slice } = planRetreatSlice(state, retreatIntent);
    const receipt = buildExecReceipt(applyOrders(state, orders), [slice]);
    check("B6 耳朵那段就是屏上那几行连起来（四项一致是构造保证，不是事后比对）",
      receipt.spokenText === receipt.lines.join(" ") && receipt.lines.length > 0,
      receipt.spokenText);
  }

  // ── B7 ★只宣称「下令」，绝不宣称「抵达」──
  {
    const { state } = southArmy();
    const { orders, slice } = planRetreatSlice(state, retreatIntent);
    const receipt = buildExecReceipt(applyOrders(state, orders), [slice]);
    const forbidden = ["抵达", "已到", "到达", "已经到"];
    check("B7 回执不出现「抵达/已到/到达」（ApplyResult 只证明命令下出去了）",
      forbidden.every((w) => !receipt.spokenText.includes(w)), receipt.spokenText);
  }

  // ── B8 负对照：咨询回合朗读**内容**金样不变（时机另行登记）──
  {
    const PROSE = "南线现在有 12 个人，其中 4 个在修理厂附近。";
    const consult = planVoiceSpeech({ voiceTurn: false, prose: PROSE, execTurn: false });
    check("B8 打字咨询：念的还是那一整段正文，一字不差（改的是时机，不是内容）",
      consult.finalUtterance === PROSE, consult.finalUtterance);
    const voiceConsult = planVoiceSpeech({ voiceTurn: true, spoken: "南线十二个人。", prose: PROSE, execTurn: false });
    check("B8b 语音咨询一个字不动：仍旧念 spoken、回执仍不单独出声",
      voiceConsult.route === "spoken" && voiceConsult.finalUtterance === "南线十二个人。" &&
      voiceConsult.speakExecReceipt === false, JSON.stringify(voiceConsult));
  }

  // ── B9 源码级：三条出声路径与两处渲染都挂在同一份结果上 ──
  //    （纯函数全绿而真机照旧念方案标题——这一条防的就是"忘了接"。）
  {
    const panelSrc = readFileSync("apps/web/src/ChatPanel.tsx", "utf8")
      .split("\n").filter((l) => !l.trimStart().startsWith("//")).join("\n");
    check("B9 执行回执的两个出口（上屏 / 出声）取的是同一次 buildExecReceipt 的结果",
      panelSrc.split("buildExecReceipt(").length - 1 === 2 &&
      panelSrc.includes("execReceipt.lines") &&
      panelSrc.includes("speak(`${voiceConfirm} ${execReceipt.spokenText}`"),
      `buildExecReceipt 出现 ${panelSrc.split("buildExecReceipt(").length - 1} 次`);
    check("B9b ★计划日志不许再上屏（`执行: ${result.log}` 全仓归零）★",
      !panelSrc.includes("`执行: ${result.log}`"));
    check("B9c ★执行前不许再打方案标题（cleanLabel 只进诊断）★",
      !panelSrc.includes("${voiceConfirm} ${cleanLabel}") &&
      !panelSrc.includes("Executing ${letter}"),
      "");
    check("B9d 播报源不是 data.brief：sayToEar 收到 execTurn，会动兵就不念",
      panelSrc.includes("sayToEar((data.brief as string) || \"\", willExecute)"));
  }

  // ── 绊索（计划 §B.4 第 7、8、9 条）──
  if (negctl) {
    console.log("\n-- negctl：三种坏取数打新引擎，必须真 FAIL --");
    let red = 0;
    const { state, ids } = southArmy();
    const { orders, slice } = planRetreatSlice(state, retreatIntent);
    const plannedCount = orders.reduce((n, o) => n + o.unitIds.length, 0);
    state.units.get(ids[2])!.manualOverride = true;
    state.units.get(ids[3])!.manualOverride = true;
    const res = applyOrders(state, orders);
    const real = buildExecReceipt(res, [slice]);
    {
      // 绊索 8：播报源改回 ResolveResult（"计划选中的人"）⇒ 报 4 不报 2
      const fakePerOrder = orders.map((o, i) => ({
        orderIndex: i, action: o.action, appliedUnitIds: [...o.unitIds],
        alreadyDoingUnitIds: [], rejected: [],
      }));
      const planReceipt = buildExecReceipt(
        { perOrder: fakePerOrder, appliedUnitIds: orders.flatMap((o) => o.unitIds), alreadyDoingUnitIds: [], rejectedUnitIds: [] },
        [slice]);
      const same = planReceipt.facts[0].appliedCount === real.facts[0].appliedCount;
      console.log(`  ${same ? "GREEN(坏)" : "RED(好)"} negctl-B1 用计划人数造回执（${planReceipt.facts[0].appliedCount} vs 真 ${real.facts[0].appliedCount}）`);
      if (!same) red++;
    }
    {
      // 绊索 7：播报源改回 data.brief（方案标题）⇒ 全不执行时照样说"撤回 X"
      const { state: s3, ids: ids3 } = southArmy();
      const post = s3.facilities.get("ea_player_south_post")!;
      const p3 = planRetreatSlice(s3, retreatIntent);
      for (const id of ids3) s3.units.get(id)!.manualOverride = true;
      const r3 = buildExecReceipt(applyOrders(s3, p3.orders), [p3.slice]);
      const briefStyle = `让南线的部队撤回${post.name}`; // data.brief 那一版
      const same = r3.lines.join("").includes(post.name);
      console.log(`  ${same ? "GREEN(坏)" : "RED(好)"} negctl-B2 brief 那版会说「${briefStyle}」，真回执说的是「${r3.lines[0]}」`);
      if (!same) red++;
    }
    {
      // 绊索 9：只改屏不改耳 ⇒ 耳朵那半与屏上不同源
      const same = real.spokenText !== real.lines.join(" ");
      console.log(`  ${same ? "GREEN(坏)" : "RED(好)"} negctl-B3 屏与耳不同源`);
      if (!same) red++;
    }
    check("negctl 三条坏取数全部真 FAIL（判据有牙）", red === 3, `只红了 ${red}/3`);
  }
}


// ════════════════════════════════════════════════════════════
// 刀 C：把「哪条战线」和「哪次任务」分开表达
// ════════════════════════════════════════════════════════════
//
// 根因（计划 §C.1）：`getUnitsOnFront` 是纯几何——「某条战线的部队」＝此刻站在
// 该线包围盒里的可调单位。部队一开拔就不再"属于"原战线，而玩家心里的
// 「南线的部队」可能是**位置**，也可能是**来源**。两种指代，一种表达方式。
//
// ★ 台架照生产链走：intent → resolveIntent → **盖 origin/dispatchMeta** →
//   applyOrders → ApplyResult → 回执。少盖一步，台账就不该记——判据要测的
//   正是"生产里那条链会不会记"。

/** 镜像 ChatPanel 的对话派兵：解析 → 盖来源标记 → 执行 → 回执。 */
function advisorDispatch(
  state: GameState,
  intent: Intent,
  groupIdx = 0,
  selectedUnitIds?: readonly number[],
): { res: ApplyResult; assigned: number[]; destinationName: string; orders: Order[] } {
  const r = resolveIntent(intent, state, state.style, undefined, selectedUnitIds);
  const meta: DispatchMeta = {
    group: `i${groupIdx}`,
    sourceKind: intent.fromDispatch ? "dispatch" : intent.fromSquad ? "squad" : intent.fromFront ? "front" : "pool",
    sourceKey: intent.fromDispatch ?? intent.fromSquad ?? intent.fromFront ?? "",
    action: intent.type,
    targetName: r.destinationName,
  };
  const stamped = r.orders.map((o) => ({ ...o, origin: "advisor" as const, dispatchMeta: meta }));
  const res = applyOrders(state, stamped);
  return { res, assigned: r.assignedUnitIds, destinationName: r.destinationName, orders: stamped, log: r.log };
}

/** 镜像 ChatPanel 造 slice 的那一段（刀甲：经济单带 economy/planLog）。
 *  `withEconomy=false` 就是刀甲**之前**的写法——负对照用它。 */
function sliceOf(
  intent: Intent,
  destinationName: string,
  log: string,
  orderIndexes: number[],
  withEconomy = true,
): DispatchSlice {
  const economy = withEconomy && !isDispatchIntent(intent.type);
  return {
    action: intent.type,
    destinationName,
    orderIndexes,
    ...(economy ? { economy: true, planLog: log } : {}),
  };
}

function knifeC(negctl: boolean): void {
  console.log("\n== 刀 C：把「哪条战线」和「哪次任务」分开表达 ==");

  // ── C0 台架自证：不盖 origin 就不该记账（否则下面每一条都证明不了什么）──
  {
    const { state } = southArmy();
    const r = resolveIntent({ type: "attack", fromFront: "front_south", toFront: "front_ridge", quantity: "all" } as Intent, state, state.style);
    applyOrders(state, r.orders); // 裸 order，没有 origin
    check("C0 台架自证：不带 origin 的 order 一条台账都不产生",
      state.dispatches.length === 0, `dispatches=${state.dispatches.length}`);
  }

  // ── C13 对话派兵必须入账，且**不盖 manualOverride** ──
  {
    const { state, ids } = southArmy();
    advisorDispatch(state, { type: "attack", fromFront: "front_south", toFront: "front_ridge", quantity: "all" } as Intent);
    check("C13 通过参谋派一批 ⇒ 台账多一条",
      state.dispatches.length === 1 && state.dispatches[0].memberIds.length === ids.length,
      JSON.stringify(state.dispatches.map((d) => [d.id, d.memberIds.length])));
    check("C13b ★这批兵的 manualOverride 不变（鼠标派兵才置位）★",
      ids.every((id) => state.units.get(id)!.manualOverride === false));
    check("C13c 号走 M# 命名空间，不与 G#／分队号冒认",
      /^M\d+$/.test(state.dispatches[0].id), state.dispatches[0].id);
  }
  {
    // 鼠标那条路：照旧置位，且照旧记账
    const { state, ids } = southArmy();
    applyPlayerCommands(state, [{ unitIds: [...ids], action: "attack_move", target: { x: 250, y: 90 }, priority: "medium" }]);
    check("C13d 鼠标派兵：manualOverride 照旧置位（一个字不改），台账照样记",
      ids.every((id) => state.units.get(id)!.manualOverride === true) && state.dispatches.length === 1,
      `dispatches=${state.dispatches.length}`);
  }

  // ── C1 ★核心：人已离开本线，用任务号指代 ⇒ 调的就是那批人 ──
  {
    const { state, ids } = southArmy();
    // 先派去山脊（跑完整循环让他们真的离开南线框）
    advisorDispatch(state, { type: "attack", fromFront: "front_south", toFront: "front_ridge", quantity: "all" } as Intent);
    fullPump(state, 400);
    const d = state.dispatches[0];
    const stillOnSouth = resolveIntent({ type: "retreat", fromFront: "front_south", quantity: "all" } as Intent, state, state.style);
    check("C1 台架自证：他们确实已经离开南线框（否则按位置也找得到，本条不承重）",
      stillOnSouth.orders.length === 0 && stillOnSouth.degraded,
      `按位置还能找到 ${stillOnSouth.assignedUnitIds.length} 个`);
    const live = liveDispatchMembers(state, d).map((u) => u.id).sort((a, b) => a - b);
    const out = advisorDispatch(state, { type: "retreat", fromDispatch: d.id, targetFacility: "ea_player_south_post", quantity: "all" } as Intent, 1);
    const applied = [...out.res.appliedUnitIds].sort((a, b) => a - b);
    check("C1b ★用任务号指代 ⇒ appliedUnitIds 集合等于该任务的活成员（逐 id 比对）★",
      applied.length === live.length && applied.every((id, i) => id === live[i]),
      `applied=${JSON.stringify(applied)} live=${JSON.stringify(live)}`);
    check("C1c 名单没有漏人：当初派出去几个，现在就调回几个",
      applied.length === ids.length, `${applied.length}/${ids.length}`);
  }

  // ── C2 换一张图复跑（规则与地名无关）──
  {
    const { state, ids } = tutorialArmy();
    advisorDispatch(state, { type: "attack", fromFront: "tut_front_center", targetFacility: "tut_enemy_post", quantity: "all" } as Intent);
    fullPump(state, 200);
    const d = state.dispatches[0];
    const live = liveDispatchMembers(state, d).map((u) => u.id).sort((a, b) => a - b);
    const out = advisorDispatch(state, { type: "retreat", fromDispatch: d.id, targetFacility: "tut_player_post", quantity: "all" } as Intent, 1);
    const applied = [...out.res.appliedUnitIds].sort((a, b) => a - b);
    check("C2 教学关同样成立",
      applied.length === live.length && applied.length === ids.length && applied.every((id, i) => id === live[i]),
      `applied=${applied.length} live=${live.length}`);
  }

  // ── C3 留守 + 外派并存 ⇒ 问一句（判的是"候选是否唯一"，不是"说没说编号"）──
  {
    const { state, ids } = southArmy();
    ids.push(addUnit(state, 344, 152).id); // 南线上一共 5 个人
    advisorDispatch(state, {
      type: "attack", fromFront: "front_south", toFront: "front_ridge", quantity: 4,
    } as Intent);
    fullPump(state, 400);
    // ★ 留守的是谁由**引擎**决定（quantity 取的是前 4 个，顺序是引擎的），
    //   台架不许自己假设是最后加的那个——上一版就是这么假设的，判据当场红。
    const sent = new Set(state.dispatches[0].memberIds);
    const stay = ids.find((id) => !sent.has(id))!;
    const amb = findDispatchAmbiguity(state, { type: "retreat", fromFront: "front_south", quantity: "all" } as Intent);
    check("C3 留守 1 + 外派 4 ⇒ 判为指代不清，要问一句",
      amb !== null && amb.length === 2, amb ? JSON.stringify(amb.map((c) => c.label)) : "null");
    check("C3b 候选逐项列得出来：一条是留守的，一条是那次任务（带号）",
      !!amb && amb.some((c) => c.kind === "stay" && c.unitIds.length === 1 && c.unitIds[0] === stay) &&
      amb.some((c) => c.kind === "dispatch" && c.key === state.dispatches[0].id && c.unitIds.length === 4),
      amb ? JSON.stringify(amb.map((c) => [c.kind, c.key, c.unitIds.length])) : "null");
    // 回答"派出去那批" ⇒ 撤的是那 4 个，不是留守那 1 个
    const d = state.dispatches[0];
    const out = advisorDispatch(state, { type: "retreat", fromDispatch: d.id, targetFacility: "ea_player_south_post", quantity: "all" } as Intent, 1);
    check("C3c 回答「派出去那批」⇒ 撤的是那 4 个，留守那 1 个没被动",
      out.res.appliedUnitIds.length === 4 && !out.res.appliedUnitIds.includes(stay) &&
      [...sent].every((id) => out.res.appliedUnitIds.includes(id)),
      `applied=${JSON.stringify(out.res.appliedUnitIds)} stay=${stay}`);
    check("C3d 指代唯一时不问：点名了任务号 ⇒ 不再判为歧义",
      findDispatchAmbiguity(state, { type: "retreat", fromDispatch: d.id } as Intent) === null);
  }

  // ── C4 / C16 执行前复查：下令到执行之间死了人，名单重新取过 ──
  {
    const { state, ids } = southArmy();
    advisorDispatch(state, { type: "attack", fromFront: "front_south", toFront: "front_ridge", quantity: "all" } as Intent);
    fullPump(state, 400);
    const d = state.dispatches[0];
    const before = liveDispatchMembers(state, d).length;
    state.units.delete(ids[0]); // 问完到执行之间，死了一个
    const out = advisorDispatch(state, { type: "retreat", fromDispatch: d.id, targetFacility: "ea_player_south_post", quantity: "all" } as Intent, 1);
    const receipt = buildExecReceipt(out.res, [{ action: "retreat", destinationName: out.destinationName, orderIndexes: out.orders.map((_, k) => k) }]);
    check("C4 名单**现查**：死掉 1 个 ⇒ 实际只调动 before-1 个",
      out.res.appliedUnitIds.length === before - 1 && !out.res.appliedUnitIds.includes(ids[0]),
      `applied=${out.res.appliedUnitIds.length} before=${before}`);
    check("C4b 回执如实报那个真数（不是台账快照里的原始人数）",
      receipt.facts[0].appliedCount === before - 1, JSON.stringify(receipt.facts));
  }

  // ── C5 负对照：「Aiden 那队撤回来」逐字节不变（钉 C.2 那条订正）──
  {
    const build = () => {
      nextId = 9000;
      const s2 = emptyBattlefield("el_alamein");
      s2.time = 120;
      const squadIds: number[] = [];
      for (let i = 0; i < 4; i++) squadIds.push(addUnit(s2, 340 + i * 2, 150).id);
      addSquad(s2, squadIds, { id: "I1", leaderName: "Aiden" });
      return { state: s2, ids: squadIds };
    };
    const intent = { type: "retreat", fromSquad: "Aiden", targetFacility: "ea_player_south_post", quantity: "all" } as Intent;
    // 无台账时的落点
    const a = build();
    const goldA = ordersKey(resolveIntent(intent, a.state, a.state.style).orders);
    // 有台账时（同一批人刚被登记过一条任务）
    const b = build();
    advisorDispatch(b.state, { type: "attack", fromSquad: "Aiden", toFront: "front_ridge", quantity: "all" } as Intent);
    // 把他们搬回原位，排除"位置变了"这个干扰项——本条要测的是台账在不在场
    b.ids.forEach((id, i) => { b.state.units.get(id)!.position = { x: 340 + i * 2, y: 150 }; b.state.units.get(id)!.orders = []; b.state.units.get(id)!.state = "idle"; });
    const goldB = ordersKey(resolveIntent(intent, b.state, b.state.style).orders);
    check("C5 ★「Aiden 那队撤回来」走编制路，台账在不在场逐字节相同★",
      goldA === goldB && b.state.dispatches.length === 1,
      `A=${goldA.slice(0, 80)} B=${goldB.slice(0, 80)}`);
  }

  // ── C6 单位被玩家另派 ⇒ 从旧任务摘除 ──
  {
    const { state, ids } = southArmy();
    advisorDispatch(state, { type: "attack", fromFront: "front_south", toFront: "front_ridge", quantity: "all" } as Intent);
    const d0 = state.dispatches[0];
    applyPlayerCommands(state, [{ unitIds: [ids[0]], action: "defend", target: { x: 360, y: 150 }, priority: "medium" }]);
    check("C6 被玩家另派的那个 ⇒ 不在旧任务活成员里了",
      !liveDispatchMembers(state, d0).some((u) => u.id === ids[0]) &&
      liveDispatchMembers(state, d0).length === ids.length - 1,
      `left=${liveDispatchMembers(state, d0).length}`);
    check("C6b 另派的那个进了新任务（两条记录，不是一条）",
      state.dispatches.length === 2 && state.dispatches[1].memberIds.includes(ids[0]));
  }

  // ── C7 ★抵达后转防守 ⇒ 仍在旧任务活成员里（钉 C.4 那条订正）──
  //    必须跑**完整循环**：sim 在抵达后把命令改写成持久 defend 单、
  //    autoBehavior 会直接改 state——"看到命令变化就摘"会把他们踢出台账。
  {
    const { state, ids } = southArmy();
    advisorDispatch(state, { type: "retreat", fromFront: "front_south", targetFacility: "ea_player_south_post", quantity: "all" } as Intent);
    const d0 = state.dispatches[0];
    fullPump(state, 300);
    const states = ids.map((id) => state.units.get(id)?.state);
    check("C7 台架自证：他们确实已经抵达并转成 defending（否则本条不承重）",
      states.every((st) => st === "defending"), states.join(","));
    check("C7b ★抵达后转防守、命令被改写 ⇒ 仍在旧任务活成员里★",
      liveDispatchMembers(state, d0).length === ids.length,
      `left=${liveDispatchMembers(state, d0).length}/${ids.length}`);
  }

  // ── C8 敌方 / 自动行为调兵 ⇒ 台账长度不增 ──
  {
    const state = createInitialGameState("el_alamein");
    const before = state.dispatches.length;
    fullPump(state, 300); // 敌方 AI、防守 AI、导演、autoBehavior 全跑
    check("C8 跑 300 秒完整循环（敌方/防守/导演/自动行为都动了兵）⇒ 台账一条不增",
      state.dispatches.length === before, `${before} → ${state.dispatches.length}`);
  }

  // ── C9 重开一局 ⇒ 台账空（三条场景路都要）──
  {
    for (const sc of ["el_alamein", "tutorial", "dual_island"] as const) {
      const s2 = createInitialGameState(sc);
      check(`C9 ${sc} 开局台账为空且号从 1 起`,
        Array.isArray(s2.dispatches) && s2.dispatches.length === 0 && s2.nextDispatchNum === 1,
        `${JSON.stringify(s2.dispatches)} next=${s2.nextDispatchNum}`);
    }
  }

  // ── C10 框选下令 ⇒ 走框选，不查台账 ──
  {
    const { state, ids } = southArmy();
    advisorDispatch(state, { type: "attack", fromFront: "front_south", toFront: "front_ridge", quantity: "all" } as Intent);
    fullPump(state, 400);
    const d = state.dispatches[0];
    const picked = [ids[0], ids[1]];
    const out = advisorDispatch(state, { type: "retreat", fromDispatch: d.id, targetFacility: "ea_player_south_post", quantity: "all" } as Intent, 1, picked);
    check("C10 框选优先：同时给了任务号与框选 ⇒ 只动框选的那两个",
      out.res.appliedUnitIds.length === 2 && out.res.appliedUnitIds.every((id) => picked.includes(id)),
      JSON.stringify(out.res.appliedUnitIds));
  }

  // ── C11 不误调：比的是【实际调动名单】与【这次应该调动的名单】──
  //    （v2 比人数错，v3 比"全军名单"还是错）
  {
    const { state, ids } = southArmy();
    for (let i = 0; i < 6; i++) addUnit(state, 300 + i * 2, 30); // 北线旁观者
    advisorDispatch(state, { type: "attack", fromFront: "front_south", toFront: "front_ridge", quantity: "all" } as Intent);
    fullPump(state, 400);
    const d = state.dispatches[0];
    const expected = liveDispatchMembers(state, d).map((u) => u.id).sort((a, b) => a - b);
    const out = advisorDispatch(state, { type: "retreat", fromDispatch: d.id, targetFacility: "ea_player_south_post", quantity: "all" } as Intent, 1);
    const actual = [...out.res.appliedUnitIds, ...out.res.alreadyDoingUnitIds].sort((a, b) => a - b);
    check("C11 ★实际调动名单 == 该指代解析出的应调集合（逐 id，不比人数、不比全军）★",
      actual.length === expected.length && actual.every((id, i) => id === expected[i]) &&
      actual.every((id) => ids.includes(id)),
      `actual=${JSON.stringify(actual)} expected=${JSON.stringify(expected)}`);
  }

  // ── C12 正向案例：全军恰好只剩那一队时，调到全军就是正确结果 ──
  //    （防止"不得等于全军"这类判据逼着代码犯错）
  {
    nextId = 9000;
    const state = emptyBattlefield("el_alamein");
    state.time = 120;
    const only: number[] = [];
    for (let i = 0; i < 3; i++) only.push(addUnit(state, 340 + i * 2, 150).id);
    addSquad(state, only, { id: "I1", leaderName: "Aiden" });
    const out = advisorDispatch(state, { type: "retreat", fromSquad: "Aiden", targetFacility: "ea_player_south_post", quantity: "all" } as Intent);
    check("C12 全军只剩 Aiden 那一队 ⇒「让 Aiden 撤回来」调到全军**就是对的**",
      out.res.appliedUnitIds.length === only.length, JSON.stringify(out.res.appliedUnitIds));
  }

  // ── C14 一句话两个任务 ⇒ 两条记录，名单不混 ──
  {
    const { state, ids } = southArmy();
    const north: number[] = [];
    for (let i = 0; i < 3; i++) north.push(addUnit(state, 300 + i * 2, 30).id);
    const r1 = resolveIntent({ type: "attack", fromFront: "front_south", toFront: "front_ridge", quantity: "all" } as Intent, state, state.style);
    const r2 = resolveIntent({ type: "defend", fromFront: "front_coastal", toFront: "front_center", quantity: "all" } as Intent, state, state.style, new Set(r1.assignedUnitIds));
    const stamp = (orders: Order[], k: number, dest: string, key: string): Order[] =>
      orders.map((o) => ({ ...o, origin: "advisor" as const, dispatchMeta: { group: `i${k}`, sourceKind: "front" as const, sourceKey: key, action: k === 0 ? "attack" as const : "defend" as const, targetName: dest } }));
    applyOrders(state, [...stamp(r1.orders, 0, r1.destinationName, "front_south"), ...stamp(r2.orders, 1, r2.destinationName, "front_coastal")]);
    check("C14 两个 group ⇒ 两条记录，各记各的名单（不合成一条）",
      state.dispatches.length === 2 &&
      state.dispatches[0].memberIds.every((id) => ids.includes(id)) &&
      state.dispatches[1].memberIds.every((id) => north.includes(id)),
      JSON.stringify(state.dispatches.map((d) => [d.id, d.action, d.memberIds.length])));
  }

  // ── C15 重复下令 ⇒ 不新建任务、不清旧任务 ──
  {
    const { state, ids } = southArmy();
    const target = { x: 355, y: 150 };
    const meta: DispatchMeta = { group: "i0", sourceKind: "front", sourceKey: "front_south", action: "defend", targetName: "南线前哨" };
    const mk = (): Order[] => ids.map((id) => ({
      unitIds: [id], action: "defend" as const, target, priority: "medium" as const,
      crisisFrontId: "front_south", origin: "advisor" as const, dispatchMeta: meta,
    }));
    applyOrders(state, mk());
    const firstId = state.dispatches[0].id;
    const firstMembers = [...state.dispatches[0].memberIds];
    applyOrders(state, mk());
    check("C15 同一条命令再说一遍 ⇒ 台账不新增、旧任务原封不动",
      state.dispatches.length === 1 && state.dispatches[0].id === firstId &&
      state.dispatches[0].memberIds.length === firstMembers.length,
      JSON.stringify(state.dispatches.map((d) => [d.id, d.memberIds.length])));
  }

  // ── C17 信封：号必须印出来，否则模型永远填不出 fromDispatch ──
  {
    const { state } = southArmy();
    advisorDispatch(state, { type: "attack", fromFront: "front_south", toFront: "front_ridge", quantity: "all" } as Intent);
    const envelope = buildDigestForChannel(state, "combat");
    const d = state.dispatches[0];
    check("C17 ★在役任务进信封（号、去向、还剩几个人）★",
      envelope.includes("---DISPATCHES---") && envelope.includes(d.id) && envelope.includes("left="),
      envelope.split("\n").filter((l) => l.includes("DISPATCH") || /^M\d+ /.test(l)).join(" | "));
    const clean = buildDigestForChannel(createInitialGameState("el_alamein"), "combat");
    check("C17b 没有在役任务时整节缺席（不印空节）",
      !clean.includes("---DISPATCHES---"));
  }

  // ── 绊索（计划 §C.5 的 12、13、14）──
  if (negctl) {
    console.log("\n-- negctl：三种坏改法打新引擎，必须真 FAIL --");
    let red = 0;
    {
      // 12：摘掉 fromDispatch 解析（＝把它当成没填）⇒ C1 当场红
      // ★ 旁观者必须在场：空战场上"全局兜底"恰好等于那批人，比较会恒真
      //   （上一版就是这么假绿的）。
      const { state } = southArmy();
      for (let i = 0; i < 6; i++) addUnit(state, 300 + i * 2, 30);
      advisorDispatch(state, { type: "attack", fromFront: "front_south", toFront: "front_ridge", quantity: "all" } as Intent);
      fullPump(state, 400);
      const d = state.dispatches[0];
      const withField = resolveIntent({ type: "retreat", fromDispatch: d.id, quantity: "all" } as Intent, state, state.style);
      const without = resolveIntent({ type: "retreat", quantity: "all" } as Intent, state, state.style);
      const same = JSON.stringify(withField.assignedUnitIds.sort()) === JSON.stringify(without.assignedUnitIds.sort());
      console.log(`  ${same ? "GREEN(坏)" : "RED(好)"} negctl-C1 摘掉 fromDispatch（${withField.assignedUnitIds.length} vs 无字段 ${without.assignedUnitIds.length}）`);
      if (!same) red++;
    }
    {
      // 13：把摘除规则改成"命令一变就摘" ⇒ C7 当场红
      //     抵达后 sim 会把命令改写成持久 defend 单——按"命令变了"摘人，
      //     这一刻活成员会掉到 0。
      const { state, ids } = southArmy();
      advisorDispatch(state, { type: "retreat", fromFront: "front_south", targetFacility: "ea_player_south_post", quantity: "all" } as Intent);
      const d0 = state.dispatches[0];
      fullPump(state, 300);
      const ordersChanged = ids.filter((id) => state.units.get(id)!.orders[0]?.action === "defend").length;
      const stillMembers = liveDispatchMembers(state, d0).length;
      const badRuleWouldKeep = stillMembers - ordersChanged; // "命令一变就摘"剩下的人数
      const same = badRuleWouldKeep === stillMembers;
      console.log(`  ${same ? "GREEN(坏)" : "RED(好)"} negctl-C2 「命令一变就摘」会把 ${ordersChanged} 个抵达后转防守的人踢出台账（真规则留了 ${stillMembers} 个）`);
      if (!same) red++;
    }
    {
      // 14：把两个字段合并成一个（fromDispatch 当 fromFront 用）⇒ C3/C5 当场红
      const { state } = southArmy();
      advisorDispatch(state, { type: "attack", fromFront: "front_south", toFront: "front_ridge", quantity: "all" } as Intent);
      fullPump(state, 400);
      const d = state.dispatches[0];
      const asDispatch = resolveIntent({ type: "retreat", fromDispatch: d.id, quantity: "all" } as Intent, state, state.style);
      const asFront = resolveIntent({ type: "retreat", fromFront: d.id, quantity: "all" } as Intent, state, state.style);
      const same = asDispatch.assignedUnitIds.length === asFront.assignedUnitIds.length;
      console.log(`  ${same ? "GREEN(坏)" : "RED(好)"} negctl-C3 两个字段合并（按任务 ${asDispatch.assignedUnitIds.length} vs 把号塞进 fromFront ${asFront.assignedUnitIds.length}）`);
      if (!same) red++;
    }
    check("negctl 三条坏改法全部真 FAIL（判据有牙）", red === 3, `只红了 ${red}/3`);
  }
}


// ════════════════════════════════════════════════════════════
// 刀 甲：经济单不许被误报成「没有执行」（审核 P0）
// ════════════════════════════════════════════════════════════
//
// 病（审核已复现）：produce / trade 实际成功——队列 0→3、钱真扣了——屏上和耳朵
// 却都说「没有执行——没有部队接到这道命令。」，红字 warning，还被 pushContext
// 喂给模型，下一轮参谋记得的是"生产失败了"。Emily 的生产每条都中。
// 根因：经济 order 的 unitIds 天生为空 ⇒ ApplyOrderOutcome 三栏全空 ⇒
// buildExecReceipt 按人头判成 none。
//
// ★ 判据把「报成功」与「真成功」**绑在同一条断言里**：只断言字符串就会在
//   引擎其实失败时照样绿。

function economyState(money = 3850, fuel = 300): GameState {
  const s = createInitialGameState("el_alamein");
  s.economy.player.resources.money = money;
  s.economy.player.resources.fuel = fuel;
  return s;
}

function knifeJia(negctl: boolean): void {
  console.log("\n== 刀 甲：经济单不许被误报成「没有执行」 ==");

  const CASES: Array<[string, Intent, (s: GameState) => { before: number; after: number }]> = [
    ["数量生产", { type: "produce", produceType: "infantry", quantity: 3 } as Intent,
      (s) => ({ before: 0, after: s.productionQueue.player.length })],
    ["预算生产", { type: "produce", produceType: "main_tank", produceBudget: { mode: "fraction_of_money", fraction: 1 } } as Intent,
      (s) => ({ before: 0, after: s.productionQueue.player.length })],
    ["买油", { type: "trade", tradeAction: "buy_fuel" } as Intent,
      (s) => ({ before: 3850, after: s.economy.player.resources.money })],
  ];

  for (const [name, intent, probe] of CASES) {
    const st = economyState();
    const r = resolveIntent(intent, st, st.style);
    const res = applyOrders(st, r.orders);
    const receipt = buildExecReceipt(res, [sliceOf(intent, r.destinationName, r.log, r.orders.map((_, k) => k))]);
    const moved = probe(st);
    const enginedidIt = name === "买油" ? moved.after < moved.before : moved.after > moved.before;
    check(`J1 ${name}：引擎**真办成了**（队列增加 / 钱减少）——本条不成立下面就不承重`,
      enginedidIt, `before=${moved.before} after=${moved.after}`);
    check(`J1b ${name} ★回执不说「没有执行」，结局不是 none，而且与引擎真的变了绑在一条断言里★`,
      enginedidIt &&
      receipt.outcome !== "none" &&
      receipt.facts[0].outcome === "applied" &&
      receipt.facts[0].economy === true &&
      receipt.lines.length === 1 &&
      !receipt.lines[0].includes("没有执行"),
      `outcome=${receipt.outcome} lines=${JSON.stringify(receipt.lines)}`);
    check(`J1c ${name}：回执那一行就是该 resolver 的 log（基线「执行: …」那句的内容）`,
      receipt.lines[0].startsWith(r.log), `line=${receipt.lines[0]} log=${r.log}`);
    check(`J1d ${name}：经济单不进人头统计（三栏全 0，不许拿它冒充派了兵）`,
      receipt.facts[0].appliedCount === 0 && receipt.facts[0].alreadyDoingCount === 0 && receipt.facts[0].rejectedCount === 0,
      JSON.stringify(receipt.facts[0]));
  }

  // ── J2 混合一句：一条 produce + 一条 retreat ⇒ 两行各自对应 ──
  {
    nextId = 9000;
    const st = economyState();
    // 南线上放一支可调小队（正式局自带的兵太多，混进来会把判据搅浑）
    const ids: number[] = [];
    for (let i = 0; i < 4; i++) ids.push(addUnit(st, 340 + i * 2, 150).id);
    addSquad(st, ids, { id: "PJ", leaderName: "Probe" });
    const prod = { type: "produce", produceType: "infantry", quantity: 3 } as Intent;
    const retr = { type: "retreat", fromSquad: "PJ", targetFacility: "ea_player_south_post", quantity: "all" } as Intent;
    const r1 = resolveIntent(prod, st, st.style);
    const r2 = resolveIntent(retr, st, st.style, new Set(r1.assignedUnitIds));
    const orders = [...r1.orders, ...r2.orders];
    const slices = [
      sliceOf(prod, r1.destinationName, r1.log, r1.orders.map((_, k) => k)),
      sliceOf(retr, r2.destinationName, r2.log, r2.orders.map((_, k) => r1.orders.length + k)),
    ];
    const res = applyOrders(st, orders);
    const receipt = buildExecReceipt(res, slices);
    check("J2 混合一句：两行回执各自对应（生产那行走 planLog，撤退那行走人头）",
      receipt.lines.length === 2 &&
      receipt.facts[0].economy === true && receipt.facts[0].outcome === "applied" &&
      receipt.facts[1].economy === false && receipt.facts[1].appliedCount === ids.length &&
      receipt.facts[1].outcome === "applied",
      JSON.stringify(receipt.facts));
    check("J2b 撤退那行的人数仍取 appliedUnitIds（不被经济条污染）",
      receipt.facts[1].appliedCount === res.appliedUnitIds.length &&
      res.appliedUnitIds.length === ids.length,
      `fact=${receipt.facts[1].appliedCount} apply=${res.appliedUnitIds.length}`);
    check("J2c 总结局是 applied，不是 none / partial",
      receipt.outcome === "applied", receipt.outcome);
  }

  // ── J3 源码级接线：两处建 slice 的地方都得盖 economy 标记 ──
  //    （纯函数全绿而真机照旧报"没有执行"——这一条防的就是"忘了接"。）
  {
    const panelSrc = readFileSync("apps/web/src/ChatPanel.tsx", "utf8")
      .split("\n").filter((l) => !l.trimStart().startsWith("//")).join("\n");
    const wired = panelSrc.split("economy: true, planLog:").length - 1;
    check("J3 ChatPanel 两处 slice 都带 economy/planLog（漏一处那条路照旧误报）",
      wired === 2 && panelSrc.split("isDispatchIntent(intent.type)").length - 1 === 2,
      `盖上的有 ${wired} 处`);
    check("J3b 「是不是经济单」只有一份真相源（core 的 isDispatchIntent），UI 没另抄一张表",
      !/const\s+economyTypes\s*=\s*new Set\(\["produce"/.test(panelSrc) ||
      panelSrc.includes("isDispatchIntent(intent.type)"),
      "");
  }

  // ── 绊索：把 economy 标记摘掉（＝刀甲之前的写法）跑同一份判据，必须真 RED ──
  if (negctl) {
    console.log("\n-- negctl：摘掉 economy 标记，必须真 FAIL --");
    let red = 0;
    for (const [name, intent, probe] of CASES) {
      const st = economyState();
      const r = resolveIntent(intent, st, st.style);
      const res = applyOrders(st, r.orders);
      const receipt = buildExecReceipt(res, [sliceOf(intent, r.destinationName, r.log, r.orders.map((_, k) => k), false)]);
      const moved = probe(st);
      const enginedidIt = name === "买油" ? moved.after < moved.before : moved.after > moved.before;
      const stillGood = receipt.outcome !== "none" && !receipt.lines.join("").includes("没有执行");
      console.log(`  ${stillGood ? "GREEN(坏)" : "RED(好)"} negctl-J ${name}：引擎真办成=${enginedidIt}，回执说「${receipt.lines[0]}」`);
      if (!stillGood) red++;
    }
    check("negctl 三种经济单摘掉标记后全部真 FAIL（判据有牙）", red === 3, `只红了 ${red}/3`);
  }
}

// ── main ──

const knifeArg = (process.argv.find((a) => a.startsWith("--knife=")) ?? "--knife=all").split("=")[1];
const negctl = process.argv.includes("--negctl");

if (knifeArg === "a" || knifeArg === "all") knifeA(negctl);
if (knifeArg === "b" || knifeArg === "all") knifeB(negctl);
if (knifeArg === "c" || knifeArg === "all") knifeC(negctl);
if (knifeArg === "jia" || knifeArg === "all") knifeJia(negctl);

console.log(failCount === 0 ? `\nALL PASS (${checkCount} 条)` : `\n${failCount}/${checkCount} FAILURES`);
process.exit(failCount === 0 ? 0 : 1);
