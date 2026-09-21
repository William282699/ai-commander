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
  classifyDestination, planSelectionTurn,
} from "@ai-commander/core";
import { tick } from "../packages/core/src/sim";
import { processEnemyAI } from "../packages/core/src/enemyAI";
import { processDefensiveAI } from "../packages/core/src/scenario/elAlamein/defensiveAI";
import { processPressureDirector } from "../packages/core/src/scenario/elAlamein/pressureDirector";
import type { GameState, Unit, Squad, Intent, ScenarioId, Order, DispatchMeta, ApplyResult } from "@ai-commander/shared";
import { buildExecReceipt, type DispatchSlice } from "../apps/web/src/execReceipt";
import { stampRun, judgeRunGuard, runGuardAllows } from "@ai-commander/shared";
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

/** 源码级判据的锚：从 `needle` 起按括号配平截出那一段函数体。
 *  ★ 不许拿"下一段注释的头一句"当结束锚——注释一动判据就假红（刀己 实证）。 */
function braceBody(src: string, needle: string): string {
  const from = src.indexOf(needle);
  if (from < 0) return "";
  // ★ 从 `=> {` 起算，不从第一个 `{` 起算——参数里的内联类型
  //   （`opts?: { screen?: boolean }`）会让配平提前收口，只截到参数表。
  const open = src.indexOf("=> {", from);
  if (open < 0) return "";
  let depth = 0;
  for (let i = open + 3; i < src.length; i++) {
    const ch = src[i];
    if (ch === "{") depth++;
    else if (ch === "}") { depth--; if (depth === 0) return src.slice(from, i + 1); }
  }
  return "";
}

/** 刀己：全场单位的命令投影——"一兵未动"要逐字节可比，不靠人数。 */
function snapshotUnitOrders(state: GameState): string {
  const rows: string[] = [];
  state.units.forEach((u) => {
    if (u.team !== "player") return;
    rows.push(`${u.id}|${u.state}|${JSON.stringify(u.orders)}|${JSON.stringify(u.target)}`);
  });
  return rows.sort().join("\n");
}

/** bbox 的中点（刀戊 W0 自证用）。 */
const regionMid = (b: readonly number[]) => ({ x: (b[0] + b[2]) / 2, y: (b[1] + b[3]) / 2 });

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
    // ★刀子 改判：从前这里数的是"两处"（主链 + 线程那份复制品）。复制品已经
    //   委派给主链，所以现在钉的是**更强**的性质：全仓只剩**一处** buildExecReceipt。
    check("B9 ★执行回执全仓只有一处（第二个执行入口已消失），且上屏与出声同取它★",
      panelSrc.split("buildExecReceipt(").length - 1 === 1 &&
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

  // ── C18 字段名必须到得了模型，且只给带兵的那个人格 ──
  //    审核点名：模型读字段表当权威。但 RESPONSE FORMAT 那张表在**共享面**上
  //    （Emily 同读），而 `ab-g-knife --emily-guard` 是用户裁定的护栏：共享面
  //    新增一行就红。所以字段表写进 CHANNEL_PERSONA.combat（陈独有、不在护栏
  //    扫描的那两段里），两头都满足。这条判据把这个位置钉死。
  {
    const aiSrc = readFileSync("apps/server/src/ai.ts", "utf8");
    const combatFrom = aiSrc.indexOf("  combat: \"⚠️ ENFORCEMENT RULES");
    const combatTo = aiSrc.indexOf("  ops: \"You are CPT Marcus");
    const combatBlock = combatFrom >= 0 && combatTo > combatFrom ? aiSrc.slice(combatFrom, combatTo) : "";
    const sysFrom = aiSrc.indexOf("const SYSTEM_PROMPT = `");
    const sysTo = aiSrc.indexOf("const SYSTEM_PROMPT_MARCUS_V2");
    const sysBlock = sysFrom >= 0 && sysTo > sysFrom ? aiSrc.slice(sysFrom, sysTo) : "";
    check("C18 台架自证：两段都取到了（否则下面是恒真）",
      combatBlock.length > 500 && sysBlock.length > 2000,
      `combat=${combatBlock.length} sys=${sysBlock.length}`);
    check("C18b 字段名 fromDispatch 到得了陈（他读的那段里有来源字段表）",
      combatBlock.includes("fromDispatch") && combatBlock.includes("---DISPATCHES---"),
      "");
    // 严格数法：SYSTEM_PROMPT 里 fromDispatch 的出现次数，减去**陈块内**的次数，
    // 必须为 0。宽松写法（「要么没有、要么陈块里有」）会在两处都有时恒真。
    const chenFrom = sysBlock.indexOf("combat channel → 陈军士");
    const chenTo = sysBlock.indexOf("ops channel → CPT Marcus");
    const chenSub = chenFrom >= 0 && chenTo > chenFrom ? sysBlock.slice(chenFrom, chenTo) : "";
    const inSys = sysBlock.split("fromDispatch").length - 1;
    const inChen = chenSub.split("fromDispatch").length - 1;
    check("C18c 台架自证：陈块在 SYSTEM_PROMPT 里定位到了",
      chenSub.length > 500, `${chenSub.length}`);
    check("C18d ★共享面（陈块之外的 SYSTEM_PROMPT）一处 fromDispatch 都不许有★",
      inSys - inChen === 0, `共享面上有 ${inSys - inChen} 处`);
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
    // 引擎真办成了几件：生产看队列增量，买油看"花了几份钱"（$300/份）。
    const delta = name === "买油"
      ? Math.round((moved.before - moved.after) / 300)
      : moved.after - moved.before;
    Object.assign(moved as Record<string, unknown>, { delta });
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
    // ★刀庚 改判：旧版这里钉的是「回执那一行＝resolver 的 planLog」——那正是
    //   本刀要废掉的东西（计划不是结果）。现在钉**真实结算**：件数与引擎实际
    //   办成的件数相等，且那一行里**不许再出现计划那句话**。
    const fact0 = receipt.facts[0];
    // 判据测**效果**不测措辞：件数与引擎实际办成的相等，而且那一行里带着
    // **计划里根本没有的东西**——真实花费（planLog 从来不含金额，所以这一条
    // 只有真从结算取数才成立；成功句偶然与计划同前缀不算证据）。
    check(`J1c ${name} ★回执按真实结算说话（件数=真件数，且报出计划里没有的真实花费）★`,
      fact0.economyFact != null &&
      fact0.economyFact.succeeded === moved.delta &&
      fact0.economyFact.failed === 0 &&
      fact0.economyFact.moneySpent > 0 &&
      receipt.lines[0].includes(`$${fact0.economyFact.moneySpent}`) &&
      !r.log.includes("$"),
      `line=${receipt.lines[0]} log=${r.log} fact=${JSON.stringify(fact0.economyFact)}`);
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

  // ── J4 ★登记在案的边角：resolver 过了，结算买不起 ──
  //    这一格刀甲**有意**仍旧先报一行 planLog（＝基线「执行: 生产步兵 ×3」的
  //    诚实度），真相由引擎的 PRODUCE_FAIL 紧跟其后。判据把这个取舍钉住：
  //    引擎确实没变、失败诊断确实记了、而且**去重后只剩一句**（三条一模一样）。
  {
    const st = economyState(50, 300);
    const intent = { type: "produce", produceType: "infantry", quantity: 3 } as Intent;
    const before = new Set(st.diagnostics);
    const r = resolveIntent(intent, st, st.style);
    const res = applyOrders(st, r.orders);
    const receipt = buildExecReceipt(res, [sliceOf(intent, r.destinationName, r.log, r.orders.map((_, k) => k))]);
    const fails = st.diagnostics.filter((d) => !before.has(d) && (d.code === "PRODUCE_FAIL" || d.code === "TRADE_FAIL"));
    check("J4 台架自证：resolver 放行（3 条 order）但结算真的买不起（队列没动、钱没扣）",
      r.degraded === false && r.orders.length === 3 &&
      st.productionQueue.player.length === 0 && st.economy.player.resources.money === 50,
      `q=${st.productionQueue.player.length} $=${st.economy.player.resources.money}`);
    check("J4b 引擎照旧把失败记成诊断（调试/系统日志要它，只是不再当回执的数据总线）",
      fails.length === 3 && fails.every((d) => d.message.includes("资金不足")),
      JSON.stringify(fails.map((d) => d.message)));
    check("J4c 同一条理由去重后只剩一句（三条一模一样，说三遍是噪音）",
      new Set(fails.map((d) => d.message)).size === 1, "");
    // ★刀庚 改判：旧版这条把「回执先报 planLog」**钉成了正确行为**——而那正是
    //   §三 的病（完全失败却先说一句正面成功句）。现在钉相反的要求。
    check("J4d ★完全失败 ⇒ 回执明说「没有执行」＋原因，绝不先说计划那句正面话★",
      receipt.lines.length === 1 &&
      receipt.lines[0].includes("没有执行") &&
      receipt.lines[0].includes("资金不足") &&
      !receipt.lines[0].startsWith(r.log) &&
      receipt.outcome === "none" &&
      receipt.facts[0].economyFact?.succeeded === 0,
      receipt.lines.join(" "));
  }

  // ── J3 源码级接线：两处建 slice 的地方都得盖 economy 标记 ──
  //    （纯函数全绿而真机照旧报"没有执行"——这一条防的就是"忘了接"。）
  {
    const panelSrc = readFileSync("apps/web/src/ChatPanel.tsx", "utf8")
      .split("\n").filter((l) => !l.trimStart().startsWith("//")).join("\n");
    // ★刀子 改判：线程那条路已委派给主链，建 slice 的地方只剩一处。
    const wired = panelSrc.split("economy: true }").length - 1;
    check("J3 ChatPanel 建 slice 的那一处盖了 economy 标记（如今只此一处）",
      wired === 1 && panelSrc.split("isDispatchIntent(intent.type)").length - 1 === 1,
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


// ════════════════════════════════════════════════════════════
// 刀 乙：命令被引擎拒掉时，耳朵不许一声不出（审核 P0）
// ════════════════════════════════════════════════════════════
//
// 病：`planVoiceSpeech` 在 execTurn 时 finalUtterance=""（刀B 有意为之，是对的），
// 而执行回执只在 applyOrders 真跑完才出声。可 handleApprove 有一排在 apply
// **之前**就 return 的路——权限拒绝、任务不在麾下、消歧追问、票据不可用、
// 找不到分队、目标不存在、目的地判退、零 orders 的规划失败。于是用嘴下的命令
// 被引擎拒了 ⇒ 屏上黄字、耳朵全静音。基线上至少还念一句 spoken。
//
// 修法是**一个出口**（refuseAloud），不是复制六遍。判据因此必须能抓住
// "将来新增第 N 条早退路却没走这个出口"——否则它只是恒真的装饰。

/** 取出 handleApprove 的函数体（到下一个组件成员声明为止）。 */
function handleApproveBody(src: string): { lines: string[]; from: number } {
  const lines = src.split("\n");
  const from = lines.findIndex((l) => l.startsWith("  const handleApprove = ("));
  if (from < 0) throw new Error("handleApprove 不见了——判据失去承重对象");
  let to = lines.length;
  for (let i = from + 1; i < lines.length; i++) {
    if (/^ {2}(const|function) [A-Za-z]/.test(lines[i])) { to = i; break; }
  }
  return { lines: lines.slice(from, to), from };
}

function knifeYi(negctl: boolean): void {
  console.log("\n== 刀 乙：命令被引擎拒掉时，耳朵不许一声不出 ==");

  const src = readFileSync("apps/web/src/ChatPanel.tsx", "utf8");
  const { lines } = handleApproveBody(src);
  const body = lines.join("\n");

  // ── Y0 台架自证：函数体真取到了，而且大得像那个函数（否则下面全是恒真）──
  check("Y0 台架自证：handleApprove 函数体取到了（>200 行）",
    lines.length > 200, `${lines.length} 行`);

  // ── Y1 手钉清单：这些早退路必须**逐条**走同一个出口 ──
  //    手钉而不是正则数数：正则一旦写宽，改名/挪位都不会红（B3 那条方法资产）。
  const SITES: Array<[string, string]> = [
    ["权限拒绝（这位参谋名下没兵 / 那支不是他的）", "名下没有部队，这道命令未执行"],
    ["fromDispatch 那批不在麾下", "那批人不在${who}麾下"],
    ["消歧追问（问完这一轮什么都不执行）", "您说的是哪一批？"],
    ["票据不可用", "refuseAloud(state, ch, tk.line"],
    ["票据那批不在麾下", "不在${who}麾下，这道命令未执行——请对带这支部队的指挥官下令。`, speakReceipt)"],
    ["找不到分队", "找不到叫「${intent.fromSquad}」的分队"],
    ["目标不存在", "`目标 ${field} 不存在`"],
    ["目的地判退（票据说不出「去哪」）", "refuseAloud(state, ch, verdict.line"],
    ["零 orders 的规划失败（屏上已有话，这里只补声）", "degradedLines.join(\" \"), speakReceipt, { screen: false }"],
  ];
  const whole = src; // 问句那条在 askWhichDispatch 里，不在 handleApprove 体内
  for (const [name, needle] of SITES) {
    const inBody = body.includes(needle);
    const inFile = whole.includes(needle);
    const routed = inBody ? routedThroughRefuse(body, needle) : routedThroughRefuse(whole, needle);
    check(`Y1 ${name} ⇒ 走 refuseAloud`, inFile && routed,
      inFile ? "在，但没走那个出口" : "★连这段话都找不到了——判据失去承重对象");
  }

  // ── Y2 ★绊索：函数体里不许再有"黄字 + return"却不经出口的早退路 ──
  //    这条专抓"将来新增第 N 条路，复制粘贴了 addMessage 却忘了补声"。
  {
    const offenders: string[] = [];
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i].trim();
      if (l.startsWith("//")) continue;
      if (!/addMessage\(\s*"warning"/.test(l)) continue;
      // 把这条语句拼全（可能跨行）
      let stmt = lines[i];
      let j = i;
      while (j + 1 < lines.length && !/\);\s*$/.test(stmt)) { j++; stmt += "\n" + lines[j]; }
      // 只看"打完就 return"的那种（后面 6 行内有裸 return;）
      let earlyReturn = false;
      for (let k = j + 1; k < Math.min(j + 7, lines.length); k++) {
        const t = lines[k].trim();
        if (t === "return;") { earlyReturn = true; break; }
        if (t.length > 0 && !t.startsWith("//") && !t.startsWith("setClarification")) break;
      }
      if (!earlyReturn) continue;
      // 唯一登记在案的豁免：stale 点击那条是 "system" 类的 UI 过期提示，
      // 不是引擎拒令（它只在鼠标点了一张过期卡片时出现，没有语音回合）。
      if (/"system"/.test(stmt)) continue;
      offenders.push(stmt.trim().slice(0, 70));
    }
    check("Y2 ★绊索★ handleApprove 里再没有「黄字+return」却不经 refuseAloud 的早退路",
      offenders.length === 0, offenders.join(" | "));
  }

  // ── Y3 屏耳同源：出口内部喂给屏和喂给嘴的是**同一个变量** ──
  {
    // ★ 锚点按**括号配平**取，不挂在注释文字上（刀己 改了旁边一段注释，
    //   旧锚 `/** 问一句：候选逐项列出` 当场失配、Y3 三条一起假红——
    //   源码级判据的锚必须是结构，不能是措辞）。
    const helper = braceBody(src, "const refuseAloud = (");
    check("Y3 出口存在，且屏上与嘴里喂的是同一个 msg（不是两份文案）",
      helper.includes('addMessage("warning", msg,') && helper.includes("speak(msg, persona)"),
      helper ? "找到出口但两边不同源" : "★找不到出口");
    check("Y3b 出口用的是既有那道开关（ttsEnabled && speakReceipt），没另开一个",
      helper.includes("ttsEnabled && speakReceipt"), "");
    check("Y3c 出口自己 flush（短句没有句末标点会卡在句子缓冲里，永远不出声）",
      helper.includes("flush(persona)"), "");
  }

  // ── Y4 屏上那一行与念出去的那一段，在"只补声"那一格也同源 ──
  {
    check("Y4 零 orders 那条：念的就是屏上逐条打过的理由（degradedLines 同一份）",
      body.includes("degradedLines.push(result.log)") &&
      body.includes('degradedLines.join(" "), speakReceipt, { screen: false }'),
      "");
  }

  // ── Y5 结算失败的原因必须到得了耳朵 ──
  //
  // ★刀庚 改判（审核 §三）：刀丁当时是从 `state.diagnostics` 里捞
  //   PRODUCE_FAIL / TRADE_FAIL 补上屏＋补声。那是把诊断当回执的数据总线，
  //   而且只捞到两个码——预算结算走的是 PRODUCE_BUDGET / TRADE_BUDGET，
  //   完全失败时屏上一句失败都没有、只有那句假成功。
  //   现在原因随**真实结算**一起回来，回执自己就带着它 ⇒ 那一圈整段退场。
  //   本条因此改钉：原因确实进了回执那一份字符串（屏/耳/context 同源）。
  {
    check("Y5 诊断不再当回执的数据总线（那一圈捞 PRODUCE_FAIL 的写法已退场）",
      !body.includes('addMessage("warning", d.message') && !body.includes("economyFails"),
      "");
    // 真跑一遍：钱不够 ⇒ 回执那一行里带着引擎给的原因，且耳朵念的就是它。
    {
      const st = createInitialGameState("el_alamein");
      st.economy.player.resources.money = 50;
      const intent = { type: "produce", produceType: "infantry", quantity: 3 } as Intent;
      const r = resolveIntent(intent, st, st.style);
      const res = applyOrders(st, r.orders);
      const receipt = buildExecReceipt(res, [sliceOf(intent, r.destinationName, r.log, r.orders.map((_, k) => k))]);
      check("Y5b ★结算失败的原因进了回执（屏与耳同一份字符串），且同因只说一遍★",
        receipt.lines.length === 1 &&
        receipt.lines[0].includes("资金不足") &&
        receipt.spokenText === receipt.lines.join(" ") &&
        (receipt.lines[0].match(/资金不足/g) ?? []).length === 1,
        JSON.stringify(receipt.lines));
      check("Y5c 完全失败 ⇒ 那一行以「没有执行」起头，前面没有任何正面成功句",
        receipt.outcome === "none" && receipt.lines[0].startsWith("没有执行"),
        JSON.stringify(receipt.lines));
    }
  }

  if (negctl) {
    console.log("\n-- negctl：给函数体注入一条「忘了补声」的早退路，Y2 必须真 FAIL --");
    const fake = lines.slice();
    fake.splice(10, 0,
      '        addMessage("warning", "假的第七条早退路", state.time, ch, undefined, "command_ack");',
      "        return;");
    let caught = false;
    for (let i = 0; i < fake.length; i++) {
      const l = fake[i].trim();
      if (!/addMessage\(\s*"warning"/.test(l) || l.startsWith("//")) continue;
      let stmt = fake[i]; let j = i;
      while (j + 1 < fake.length && !/\);\s*$/.test(stmt)) { j++; stmt += "\n" + fake[j]; }
      let early = false;
      for (let k = j + 1; k < Math.min(j + 7, fake.length); k++) {
        const t = fake[k].trim();
        if (t === "return;") { early = true; break; }
        if (t.length > 0 && !t.startsWith("//") && !t.startsWith("setClarification")) break;
      }
      if (early && !/"system"/.test(stmt)) caught = true;
    }
    console.log(`  ${caught ? "RED(好)" : "GREEN(坏)"} negctl-Y 注入的第七条早退路被 Y2 抓住`);
    check("negctl 绊索确实会红（不是恒真的装饰）", caught, "注入了也没抓住");
    // Y5 的摘刀：把补声那一行拿掉，Y5 必须当场红
    const stripped = body.replace(/economyFails\.join\("[^"]*"\), speakReceipt, \{ screen: false \}/, "REMOVED");
    const y5Still = stripped.includes("economyFails.join(\" \"), speakReceipt, { screen: false }");
    console.log(`  ${y5Still ? "GREEN(坏)" : "RED(好)"} negctl-Y5 摘掉「失败也念一句」那一行，Y5 当场红`);
    check("negctl Y5 的绊索也有牙", !y5Still, "");
  }
}

/**
 * needle 那段话是不是经由 refuseAloud 出口发出去的。
 *
 * 判法：在它前后一个小窗口里找 refuseAloud，**并且**它自己那一行不许是
 * addMessage——后半句才是牙：谁把某一条改回 addMessage，这条当场红。
 * （前半句单独用会太松：窗口里随便有个别的 refuseAloud 就恒真。）
 */
function routedThroughRefuse(text: string, needle: string): boolean {
  const lines = text.split("\n");
  const i = lines.findIndex((l) => l.includes(needle));
  if (i < 0) return false;
  if (/addMessage\(/.test(lines[i])) return false;
  const win = lines.slice(Math.max(0, i - 6), i + 4).join("\n");
  return win.includes("refuseAloud(");
}


// ════════════════════════════════════════════════════════════
// 刀 丙：收窄消歧追问的范围（审核 P1）
// ════════════════════════════════════════════════════════════
//
// 病：`findDispatchAmbiguity` 不看意图类型，只看「这条线上有留守的 + 有派出去的」。
// 实测同一条线连下 4 条 fromFront 命令 ⇒ 奇数轮问、偶数轮办（追问槽一次性消费，
// 下一条又从零判）。被问的包括「南线再派两个去中央」「南线设防」这种玩家心里
// 毫无歧义的命令——撞玩家已定的「清楚就办，勿变 20 问」。
//
// 判据只看**字段形状**（意图类型 + quantity），不许有中文关键词表。

/** 留守 1 + 外派 4 的局面：返回 state、留守那个、外派那批。 */
function splitFrontFixture(): { state: GameState; stay: number; sent: number[] } {
  const { state, ids } = southArmy();
  ids.push(addUnit(state, 344, 152).id); // 南线上一共 5 个
  advisorDispatch(state, { type: "attack", fromFront: "front_south", toFront: "front_ridge", quantity: 4 } as Intent);
  fullPump(state, 400);
  const sentSet = new Set(state.dispatches[0].memberIds);
  return { state, stay: ids.find((id) => !sentSet.has(id))!, sent: [...sentSet] };
}

function knifeBing(negctl: boolean): void {
  console.log("\n== 刀 丙：收窄消歧追问的范围 ==");

  // ── B1 原病例仍然问（收窄不许把承重那格一起砍掉）──
  {
    const { state } = splitFrontFixture();
    const amb = findDispatchAmbiguity(state, { type: "retreat", fromFront: "front_south", quantity: "all" } as Intent);
    check("B1 原病例（retreat + quantity=all + 留守与外派并存）仍然问",
      amb !== null && amb.length === 2, amb ? JSON.stringify(amb.map((c) => c.label)) : "null");
    const ambMost = findDispatchAmbiguity(state, { type: "retreat", fromFront: "front_south", quantity: "most" } as Intent);
    check("B1b quantity=most 同属原病例形状，也问", ambMost !== null && ambMost.length === 2);
  }

  // ── B2 ★新增负例：其余形状一律不问，而且实际调的是**留守那批** ──
  //    判据比的是名单（逐 id），不比人数、不比全军。
  {
    const NEG: Array<[string, Intent]> = [
      ["attack", { type: "attack", fromFront: "front_south", toFront: "front_center", quantity: "all" } as Intent],
      ["defend", { type: "defend", fromFront: "front_south", quantity: "all" } as Intent],
      ["recon", { type: "recon", fromFront: "front_south", toFront: "front_center", quantity: "all" } as Intent],
      ["retreat+quantity=few", { type: "retreat", fromFront: "front_south", targetFacility: "ea_player_south_post", quantity: "few" } as Intent],
    ];
    for (const [name, intent] of NEG) {
      const { state, stay, sent } = splitFrontFixture();
      const amb = findDispatchAmbiguity(state, intent);
      check(`B2 ${name}：不问（玩家心里没有歧义，清楚就办）`, amb === null,
        amb ? JSON.stringify(amb.map((c) => c.key)) : "");
      const out = advisorDispatch(state, intent, 1);
      const moved = [...out.res.appliedUnitIds].sort((a, b) => a - b);
      check(`B2b ${name}：实际调的就是**留守那批**（逐 id 比对，不比人数、不比全军）`,
        moved.length === 1 && moved[0] === stay && !moved.some((id) => sent.includes(id)),
        `moved=${JSON.stringify(moved)} stay=${stay} sent=${JSON.stringify(sent)}`);
    }
  }

  // ── B3 ★交替追问回归：同一条线连下 4 条 attack ⇒ 追问次数为 0 ──
  //    这条钉的是审核实测那个"奇数轮问、偶数轮办"的形状。
  {
    const { state } = splitFrontFixture();
    let asks = 0;
    for (let round = 0; round < 4; round++) {
      const intent = { type: "attack", fromFront: "front_south", toFront: "front_center", quantity: 2 } as Intent;
      if (findDispatchAmbiguity(state, intent) !== null) asks++;
      advisorDispatch(state, intent, round + 1);
      fullPump(state, 30);
    }
    check("B3 同一条线连下 4 条 attack ⇒ 追问 0 次（收窄前是奇数轮问、偶数轮办）",
      asks === 0, `问了 ${asks} 次`);
  }

  // ── B4 收窄只看字段形状：源码里不许出现中文关键词表 ──
  {
    const led = readFileSync("packages/core/src/dispatchLedger.ts", "utf8");
    const codeOnly = led.split("\n").filter((l) => !l.trimStart().startsWith("//") && !l.trimStart().startsWith("*")).join("\n");
    check("B4 判据只看字段形状：`intent.type` + `intent.quantity`，没有中文词表",
      codeOnly.includes('intent.type !== "retreat"') &&
      codeOnly.includes('intent.quantity !== "all"') &&
      !/["'](刚才|之前|刚刚|派出去|留守)["']/.test(codeOnly),
      "");
  }

  if (negctl) {
    console.log("\n-- negctl：摘掉收窄（＝刀丙之前）后，B2/B3 必须真红 --");
    // 摘刀＝把"只在 retreat + all/most 上判"那两行去掉。这里用**同一份局面**
    // 直接问引擎：没有类型/数量限制时，attack 那条会不会被判成歧义。
    // 判法不复制影子实现：改用"把 intent 伪装成原病例形状"来证明局面本身够格。
    const { state } = splitFrontFixture();
    const asRetreatAll = findDispatchAmbiguity(state, { type: "retreat", fromFront: "front_south", quantity: "all" } as Intent);
    const asAttack = findDispatchAmbiguity(state, { type: "attack", fromFront: "front_south", toFront: "front_center", quantity: "all" } as Intent);
    const red = asRetreatAll !== null && asAttack === null;
    console.log(`  ${red ? "RED(好)" : "GREEN(坏)"} negctl-B 同一个局面：原病例形状问（${asRetreatAll?.length ?? 0} 个候选）、attack 不问（${asAttack === null ? "null" : "仍在问"}）`);
    check("negctl 收窄确实承重：局面不变、只换字段形状，判定就翻面", red, "");
  }
}

// ════════════════════════════════════════════════════════════
// 刀 戊：撤退目的地按**实际解析结果**判，不按"字段非空"
// ════════════════════════════════════════════════════════════
//
// 病（审核 §一，基线对照实测）：刀A 的 `destinationExplicit` 是
// `!!(_targetPos || targetFacility || targetRegion)`——**字段非空即明确地点**。
// 漏两格：
//   · `targetRegion` 可以装一个 front id（resolveTarget 第 3 步的 front 分支），
//     而同战线保护只看 `toFront` ⇒ `targetRegion=fromFront` 撤到原地；
//   · 无效设施名解析失败后回落到 `fromFront`，字段仍非空 ⇒ **core 造假目的地**。
// 两格在 9985f92 上都实测复现，且都与基线 4e41486 不符（基线两格都走默认后撤）。
//
// 判据全部**跑真代码**（resolveIntent / classifyDestination / 完整循环），
// 没有一条源码字符串扫描。

/** 南线 4 人 + 真实 tag（在本战线 bbox 内），供"本线内的点必须保留"用。 */
function wuFixture(): { state: GameState; ids: number[] } {
  const { state, ids } = southArmy();
  // alam_halfa_zone bbox = [320,138,365,165] ⊂ front_south
  state.tags = [{ id: "tag_1", name: "高地哨位", position: { x: 350, y: 150 }, createdAt: 100 }];
  state.nextTagNum = 2;
  return { state, ids };
}

function wuRetreat(build: () => { state: GameState; ids: number[] }, fields: Partial<Intent>) {
  const { state } = build();
  const r = resolveIntent(
    { type: "retreat", fromFront: "front_south", quantity: "all", ...fields } as Intent,
    state, state.style,
  );
  return { state, r, key: ordersKey(r.orders) };
}

function knifeWu(negctl: boolean): void {
  console.log("\n== 刀 戊：撤退目的地按实际解析结果判 ==");

  // ── W0 台架自证：本线内确实有那些东西，否则下面几条不承重 ──
  {
    const { state } = wuFixture();
    const post = [...state.facilities.values()].find((f) => f.id === "ea_player_south_post");
    const zone = state.regions.get("alam_halfa_zone");
    const south = state.fronts.find((f) => f.id === "front_south")!;
    const inBox = (p: { x: number; y: number }) =>
      south.regionIds.some((rid) => {
        const r = state.regions.get(rid);
        return r != null && p.x >= r.bbox[0] && p.x <= r.bbox[2] && p.y >= r.bbox[1] && p.y <= r.bbox[3];
      });
    check("W0 台架自证：南线前哨、真实 region、真实 tag 都落在出发战线的 bbox 内",
      post != null && zone != null && inBox(post.position) && inBox({ x: 350, y: 150 }) &&
      inBox(regionMid(zone.bbox)),
      `post=${post ? `${post.position.x},${post.position.y}` : "null"}`);
  }

  // ── W1 分类器：五档各自认对（这是整刀的判据基础）──
  {
    const { state } = wuFixture();
    const kindOf = (fields: Partial<Intent>) =>
      classifyDestination({ type: "retreat", fromFront: "front_south", quantity: "all", ...fields } as Intent, state);
    const rows: Array<[string, Partial<Intent>, string, string | null]> = [
      ["精确坐标", { _targetPos: { x: 300, y: 200 } } as Partial<Intent>, "exact", null],
      ["有效设施", { targetFacility: "ea_player_south_post" }, "facility", null],
      ["真实 tag", { targetRegion: "高地哨位" }, "place", null],
      ["真实 region", { targetRegion: "alam_halfa_zone" }, "place", null],
      ["targetRegion 装 front id", { targetRegion: "front_south" }, "front", "front_south"],
      ["toFront", { toFront: "front_center" }, "front", "front_center"],
      ["无效设施名 ⇒ 落到 fromFront 那一档", { targetFacility: "missing_fac" }, "front", "front_south"],
      ["什么都没有 ⇒ 也是 fromFront 那一档", {}, "front", "front_south"],
    ];
    for (const [label, fields, wantKind, wantFront] of rows) {
      const d = kindOf(fields);
      check(`W1 分类：${label} ⇒ kind=${wantKind}${wantFront ? ` front=${wantFront}` : ""}`,
        d.kind === wantKind && (wantFront === null || d.frontId === wantFront),
        `实得 kind=${d.kind} frontId=${d.frontId} field=${d.field}`);
    }
    // 无 fromFront 且无目的地字段 ⇒ 真的什么都没有
    const bare = classifyDestination({ type: "retreat", quantity: "all" } as Intent, state);
    check("W1b 连 fromFront 都没有 ⇒ kind=none、position=null（不许凭空造点）",
      bare.kind === "none" && bare.position === null, JSON.stringify(bare));
  }

  // ── W2 ★核心反例★ targetRegion=fromFront 必须与 bare retreat 逐字节相同 ──
  {
    const bare = wuRetreat(wuFixture, {});
    const asRegion = wuRetreat(wuFixture, { targetRegion: "front_south" });
    check("W2 ★targetRegion 装出发战线 ⇒ 与 bare retreat **逐字节**相同（回到基线行为）★",
      asRegion.key === bare.key,
      `bare=${bare.key.slice(0, 80)}\n       region=${asRegion.key.slice(0, 80)}`);
    check("W2b 回执也不许报出战线名（那是假目的地）",
      asRegion.r.destinationName === bare.r.destinationName && asRegion.r.destinationName === "安全区域",
      `dest="${asRegion.r.destinationName}"`);
    // 同线的**别名**也要判同（比 canonical id，不比原始字符串）
    // ★ 名单里刻意不含 "south"：解析顺序是 region 先于 front（既有行为，见
    //   classifyDestination 的第 3 步），而 "south" 会先子串命中真实 region
    //   `southern_desert`。那一格由紧跟其后的 W2e 正面钉住——它**该**保留，
    //   因为解析结果是一个真实的地方，不是一条战线。
    for (const alias of ["南线", "南路", "四线", "4", "frontsouth", "4. 南部战线"]) {
      const aliased = wuRetreat(wuFixture, { targetRegion: alias });
      check(`W2c 别名「${alias}」也按 canonical front id 判同线 ⇒ 与 bare 逐字节相同`,
        aliased.key === bare.key, `dest="${aliased.r.destinationName}"`);
    }
    // W2e ★边界正面钉死★ 先命中真实 region 的字样不是"战线别名"，该保留。
    //   这一格证明判据量的是**解析结果**而不是字符串长相：同一个 "south"，
    //   如果当成战线别名就该丢弃，当成真实 region 就该保留——引擎按解析结果走。
    {
      const { state } = wuFixture();
      const d = classifyDestination(
        { type: "retreat", fromFront: "front_south", targetRegion: "south", quantity: "all" } as Intent, state);
      const got = wuRetreat(wuFixture, { targetRegion: "south" });
      check("W2e 「south」先命中真实 region `southern_desert` ⇒ kind=place、保留（不按字符串长相判成战线）",
        d.kind === "place" && d.frontId === null && got.key !== bare.key && got.r.destinationName === "南部沙漠",
        `kind=${d.kind} field=${d.field} dest="${got.r.destinationName}"`);
    }

    // toFront 那一侧的老保护不许被碰掉
    const asToFront = wuRetreat(wuFixture, { toFront: "front_south" });
    check("W2d 旧保护仍在：toFront==fromFront 且无地点 ⇒ 与 bare 逐字节相同",
      asToFront.key === bare.key, asToFront.r.destinationName);
  }

  // ── W3 ★核心反例★ 无效设施 / 无效 region 不得变成「撤退至出发战线」──
  {
    const bare = wuRetreat(wuFixture, {});
    for (const [label, fields] of [
      ["无效设施名", { targetFacility: "missing_fac" }],
      ["无效 region 名", { targetRegion: "missing_region_xyz" }],
      ["两个都无效", { targetFacility: "missing_fac", targetRegion: "missing_region_xyz" }],
    ] as Array<[string, Partial<Intent>]>) {
      const got = wuRetreat(wuFixture, fields);
      const south = got.state.fronts.find((f) => f.id === "front_south")!;
      check(`W3 ${label} ⇒ 不冒充明确目的地（与 bare 逐字节相同、回执不报「${south.name}」）`,
        got.key === bare.key && got.r.destinationName === "安全区域" &&
        !got.r.destinationName.includes(south.name),
        `key=${got.key.slice(0, 70)} dest="${got.r.destinationName}"`);
    }
  }

  // ── W4 本战线内的**有效**地点必须保留（刀A 的成果，一个字节不许退）──
  {
    const bare = wuRetreat(wuFixture, {});
    const facCenter = probeCenter(wuFixture, { targetFacility: "ea_player_south_post" });
    const fac = wuRetreat(wuFixture, { targetFacility: "ea_player_south_post" });
    check("W4 本线内的有效设施仍然保留（落点在前哨附近、回执报站名、且与 bare 不同）",
      fac.key !== bare.key && fac.r.destinationName === "南线前哨" &&
      fac.r.orders.every((o) => o.target != null && near(o.target, facCenter, 4)),
      `dest="${fac.r.destinationName}" 落点=${JSON.stringify(fac.r.orders.map((o) => o.target))}`);

    const regCenter = probeCenter(wuFixture, { targetRegion: "alam_halfa_zone" });
    const reg = wuRetreat(wuFixture, { targetRegion: "alam_halfa_zone" });
    check("W4b 本线内的真实 region 仍然保留（落点在区中心附近、与 bare 不同）",
      reg.key !== bare.key && reg.r.destinationName === "南部山脊区" &&
      reg.r.orders.every((o) => o.target != null && near(o.target, regCenter, 4)),
      `dest="${reg.r.destinationName}"`);

    const tagCenter = probeCenter(wuFixture, { targetRegion: "高地哨位" });
    const tag = wuRetreat(wuFixture, { targetRegion: "高地哨位" });
    check("W4c 本线内的真实 tag 仍然保留（落点在 tag 附近、与 bare 不同）",
      tag.key !== bare.key && tag.r.orders.every((o) => o.target != null && near(o.target, tagCenter, 4)),
      `dest="${tag.r.destinationName}" 落点=${JSON.stringify(tag.r.orders.map((o) => o.target))}`);

    const posCenter = { x: 350, y: 148 };
    const exact = wuRetreat(wuFixture, { _targetPos: posCenter } as Partial<Intent>);
    check("W4d 本线内的精确坐标仍然保留（与 bare 不同、落在给的点附近）",
      exact.key !== bare.key && exact.r.orders.every((o) => o.target != null && near(o.target, posCenter, 4)),
      `落点=${JSON.stringify(exact.r.orders.map((o) => o.target))}`);
  }

  // ── W5 异线仍能正常撤过去（targetRegion 与 toFront 两条路都要）──
  {
    const bare = wuRetreat(wuFixture, {});
    for (const [label, fields, wantName] of [
      ["targetRegion 装异线 front id", { targetRegion: "front_center" }, "3. 中央战线"],
      ["toFront 异线", { toFront: "front_center" }, "3. 中央战线"],
      ["targetRegion 异线别名「中线」", { targetRegion: "中线" }, "3. 中央战线"],
    ] as Array<[string, Partial<Intent>, string]>) {
      const got = wuRetreat(wuFixture, fields);
      const center = probeCenter(wuFixture, fields);
      check(`W5 ${label} ⇒ 照撤过去（回执报「${wantName}」、落点在那条线的锚附近）`,
        got.key !== bare.key && got.r.destinationName === wantName &&
        got.r.orders.every((o) => o.target != null && near(o.target, center, 6)),
        `dest="${got.r.destinationName}" 落点=${JSON.stringify(got.r.orders.map((o) => o.target))}`);
    }
  }

  // ── W6 ★跑完整循环★ 本线内前哨那一格：真到位、转 defending、不掉头 ──
  {
    const { state } = wuFixture();
    const post = [...state.facilities.values()].find((f) => f.id === "ea_player_south_post")!;
    const r = resolveIntent(
      { type: "retreat", fromFront: "front_south", targetFacility: "ea_player_south_post", quantity: "all" } as Intent,
      state, state.style,
    );
    applyOrders(state, r.orders);
    fullPump(state, 300);
    const alive = r.assignedUnitIds.map((id) => state.units.get(id)).filter((u): u is Unit => u != null && u.state !== "dead");
    const arrived = alive.filter((u) => near(u.position, post.position, 6));
    const strayed = alive.filter((u) => !near(u.position, post.position, 15));
    check("W6 ★完整循环 300s：人真到了前哨（≤6 格）★",
      alive.length === r.assignedUnitIds.length && arrived.length === alive.length,
      `存活 ${alive.length}/${r.assignedUnitIds.length}、到位 ${arrived.length}`);
    check("W6b ★没有整队掉头走回原岗（>15 格 一个都不许有）★", strayed.length === 0,
      `掉头 ${strayed.length} 个：${JSON.stringify(strayed.map((u) => u.position))}`);
    check("W6c 到位后转 defending（不是还在 moving/retreating）",
      alive.every((u) => u.state === "defending"), JSON.stringify(alive.map((u) => u.state)));
  }

  // ── W7 别的动词一个字节不动（分类器是撤退专用的判据，不许溢出）──
  {
    for (const verb of ["attack", "defend", "recon"] as const) {
      const a = (() => { const { state } = wuFixture(); return ordersKey(resolveIntent({ type: verb, fromFront: "front_south", targetRegion: "front_south", quantity: "all" } as Intent, state, state.style).orders); })();
      const b = (() => { const { state } = wuFixture(); return ordersKey(resolveIntent({ type: verb, fromFront: "front_south", targetRegion: "front_south", quantity: "all" } as Intent, state, state.style).orders); })();
      check(`W7 ${verb} 的同线 targetRegion 行为未被本刀改动（自比稳定，且不是空单）`,
        a === b && a !== "[]", a.slice(0, 60));
    }
    // 攻击到本线内的前哨仍然打得到（同线保护绝不许溢出到别的动词）
    const { state } = wuFixture();
    const atk = resolveIntent({ type: "attack", fromFront: "front_south", targetFacility: "ea_player_south_post", quantity: "all" } as Intent, state, state.style);
    check("W7b attack 到本线内的设施照旧有落点（不受撤退那条同线保护影响)",
      atk.orders.length > 0 && atk.orders.every((o) => o.target != null), `orders=${atk.orders.length}`);
  }

  if (negctl) {
    console.log("\n-- negctl：把旧判据（字段非空＝明确地点）打在新引擎上，必须真红 --");
    // 旧判据的影子：只看字段在不在。拿它算出的"该保留"与新引擎实际行为对比。
    const oldExplicit = (i: Partial<Intent>) => !!(i._targetPos || i.targetFacility || i.targetRegion);
    let reds = 0;
    for (const [label, fields] of [
      ["targetRegion=出发战线", { targetRegion: "front_south" }],
      ["无效设施名", { targetFacility: "missing_fac" }],
      ["无效 region 名", { targetRegion: "missing_region_xyz" }],
    ] as Array<[string, Partial<Intent>]>) {
      const bare = wuRetreat(wuFixture, {});
      const got = wuRetreat(wuFixture, fields);
      // 旧判据说"明确" ⇒ 期望"与 bare 不同"。新引擎实际与 bare 相同 ⇒ 旧期望红。
      const oldExpectsDifferent = oldExplicit(fields);
      const actuallyDifferent = got.key !== bare.key;
      const red = oldExpectsDifferent && !actuallyDifferent;
      if (red) reds++;
      console.log(`  ${red ? "RED(好)" : "GREEN(坏)"} negctl-W ${label}：旧判据判"明确"=${oldExpectsDifferent}，新引擎实际"另有落点"=${actuallyDifferent}`);
    }
    check("negctl 旧判据（字段非空）在这三格上全部真 FAIL（收窄确实承重）", reds === 3, `${reds}/3`);
    // 反向：不许把刀A 的成果一起砍掉——有效地点那三格旧判据与新引擎**一致**
    let agree = 0;
    for (const fields of [{ targetFacility: "ea_player_south_post" }, { targetRegion: "alam_halfa_zone" }, { targetRegion: "高地哨位" }] as Array<Partial<Intent>>) {
      const bare = wuRetreat(wuFixture, {});
      const got = wuRetreat(wuFixture, fields);
      if (got.key !== bare.key) agree++;
    }
    check("negctl 反向：本线内的**有效**地点三格仍然保留（没把刀A 一起砍掉）", agree === 3, `${agree}/3`);
  }
}

// ════════════════════════════════════════════════════════════
// 刀 己：问完必须**真正绑定候选**
// ════════════════════════════════════════════════════════════
//
// 病（审核 §二）：刀C 的消歧只做了"问一句"。`pendingSelectionRef` 只存了候选、
// 从没用它来选；下一条可执行 intent 一到就把槽清空，然后**照模型这一轮填的
// 字段执行**。于是长官答「好的」、答非所问、或者模型又把 fromFront 写错，
// 仍然调错兵——实测：留守 1 ＋ 外派 4，模型仍填 fromFront ⇒ 只撤 1 个（该撤 4）。
// ★ 旧探针 C3c 不是这条的依据：它是直接把 `fromDispatch: M1` 喂给引擎的，
//   证明的是「字段填对就调对人」，不是「问完之后字段会填对」。
//
// 判据全部跑**生产代码**：`planSelectionTurn`（判定本体，已从 ChatPanel 闭包
// 搬进 core）＋ 真 `resolveIntent`/`applyOrders`/台账。

const JI_CH = "combat";
const JI_SESSION = "sess-ji";

/** 把一次「问」登记成槽——字段与 ChatPanel 的 askWhichDispatch 同源。 */
function jiSlot(state: GameState, candidates: DispatchCandidate[], snapshot: Intent, id = "sel-1", epoch = 1) {
  return {
    id, channel: JI_CH, sessionId: JI_SESSION, epoch,
    expiresAt: state.time + 120,
    candidates, intentSnapshot: snapshot,
  };
}
const jiTag = (id = "sel-1") => ({ selectionId: id, channel: JI_CH, sessionId: JI_SESSION });

/** 跑一轮选择：判定 → （若 execute）真执行 → 回执 + 台账。 */
function jiTurn(
  state: GameState,
  slot: ReturnType<typeof jiSlot> | null,
  rawDecision: unknown,
  over: { tag?: ReturnType<typeof jiTag> | null; epoch?: number; now?: number } = {},
) {
  const decision = planSelectionTurn({
    state,
    slot,
    requestTag: over.tag === undefined ? jiTag(slot?.id ?? "sel-1") : over.tag,
    epoch: over.epoch ?? 1,
    now: over.now ?? state.time,
    persona: "chen",
    rawDecision,
    personaLabel: "陈军士",
  });
  if (decision.plan.kind !== "execute") return { decision, applied: [] as number[], lines: [] as string[] };
  // 执行侧与主链同源：绑定名单当硬约束 → resolveIntent → applyOrders → 回执
  const p = decision.plan;
  const r = resolveIntent(p.intent, state, state.style, undefined, p.unitIds);
  const meta: DispatchMeta = {
    group: "i0",
    sourceKind: p.intent.fromDispatch ? "dispatch" : p.intent.fromFront ? "front" : "pool",
    sourceKey: p.intent.fromDispatch ?? p.intent.fromFront ?? "",
    action: p.intent.type, targetName: r.destinationName,
  };
  const stamped = r.orders.map((o) => ({ ...o, origin: "advisor" as const, dispatchMeta: meta }));
  const res = applyOrders(state, stamped);
  const receipt = buildExecReceipt(res, [sliceOf(p.intent, r.destinationName, r.log, stamped.map((_, k) => k))]);
  return { decision, applied: [...res.appliedUnitIds].sort((a, b) => a - b), lines: receipt.lines, res, destinationName: r.destinationName };
}

const RETREAT_SNAPSHOT: Intent = {
  type: "retreat", fromFront: "front_south", targetFacility: "ea_player_south_post", quantity: "all",
} as Intent;

function knifeJi(negctl: boolean): void {
  console.log("\n== 刀 己：问完必须真正绑定候选 ==");

  // ── I0 台架自证：局面真的是"留守 + 外派"，且候选带稳定 key ──
  {
    const { state, stay, sent } = splitFrontFixture();
    const amb = findDispatchAmbiguity(state, RETREAT_SNAPSHOT);
    check("I0 台架自证：局面判为歧义、两个候选、key 带前缀（stay:/dispatch:）",
      amb !== null && amb.length === 2 &&
      amb.some((c) => c.selectionKey === `stay:front_south`) &&
      amb.some((c) => c.selectionKey.startsWith("dispatch:M")),
      amb ? JSON.stringify(amb.map((c) => c.selectionKey)) : "null");
    check("I0b 台架自证：留守 1 个、外派 4 个（判据下面要逐 id 比这两组）",
      sent.length === 4 && typeof stay === "number", `stay=${stay} sent=${JSON.stringify(sent)}`);
    // ★ 病灶复现：模型若仍填 fromFront，实际只调得到留守那 1 个
    const naive = resolveIntent(RETREAT_SNAPSHOT, state, state.style);
    check("I0c ★病灶自证★ 模型仍填 fromFront ⇒ 只调到留守那 1 个（该调 4 个）",
      naive.assignedUnitIds.length === 1 && naive.assignedUnitIds[0] === stay,
      `assigned=${JSON.stringify(naive.assignedUnitIds)}`);
  }

  // ── I1 ★核心★ 回答「好的」⇒ 零执行，槽留着，不许清槽后盲办 ──
  {
    const { state } = splitFrontFixture();
    const amb = findDispatchAmbiguity(state, RETREAT_SNAPSHOT)!;
    const slot = jiSlot(state, amb, RETREAT_SNAPSHOT);
    const before = snapshotUnitOrders(state);
    // 「好的」＝模型判 unclear（语义归模型；引擎这儿没有任何中文确认词表）
    const t = jiTurn(state, slot, { decision: "unclear" });
    check("I1 ★「好的」⇒ verdict=unclear、零执行、再问一遍★",
      t.decision.verdict === "unclear" && t.decision.plan.kind === "reask" && t.applied.length === 0,
      `verdict=${t.decision.verdict} plan=${t.decision.plan.kind} applied=${t.applied.length}`);
    check("I1b 槽必须留着（keepSlot），不许清掉后照模型字段办",
      t.decision.keepSlot === true, `keepSlot=${t.decision.keepSlot}`);
    check("I1c 一兵未动：全场单位的命令逐字节未变",
      snapshotUnitOrders(state) === before, "");
    check("I1d 再问的那一句说清了「还没执行」",
      t.decision.plan.kind === "reask" && t.decision.plan.lead.includes("没有执行"),
      t.decision.plan.kind === "reask" ? t.decision.plan.lead : "");
  }

  // ── I2 缺字段 / 非法字段 ⇒ 协议失败，同样零执行 ──
  {
    for (const [label, raw] of [
      ["字段缺失", undefined],
      ["空对象", {}],
      ["decision 写错", { decision: "yes" }],
      ["说选了却没给 candidate", { decision: "chose" }],
      ["candidate 是空串", { decision: "chose", candidate: "  " }],
    ] as Array<[string, unknown]>) {
      const { state } = splitFrontFixture();
      const amb = findDispatchAmbiguity(state, RETREAT_SNAPSHOT)!;
      const before = snapshotUnitOrders(state);
      const t = jiTurn(state, jiSlot(state, amb, RETREAT_SNAPSHOT), raw);
      check(`I2 ${label} ⇒ protocol_failure、零执行、槽留着`,
        t.decision.verdict === "protocol_failure" && t.applied.length === 0 &&
        t.decision.keepSlot === true && snapshotUnitOrders(state) === before,
        `verdict=${t.decision.verdict}`);
    }
  }

  // ── I3 ★核心★ 选 stay ⇒ 只动"现在还守在原战线上的合法成员" ──
  {
    const { state, stay, sent } = splitFrontFixture();
    const amb = findDispatchAmbiguity(state, RETREAT_SNAPSHOT)!;
    const t = jiTurn(state, jiSlot(state, amb, RETREAT_SNAPSHOT), { decision: "chose", candidate: "stay:front_south" });
    check("I3 ★选 stay ⇒ 实际 applied **逐 id 等于**留守那一组，外派那 4 个一个都不许夹带★",
      t.decision.verdict === "chose" && t.applied.length === 1 && t.applied[0] === stay &&
      sent.every((id) => !t.applied.includes(id)),
      `applied=${JSON.stringify(t.applied)} stay=${stay} sent=${JSON.stringify(sent)}`);
    check("I3b 绑定后的 intent 来源被改写成明确的那一种（fromFront 在、fromDispatch 清掉）",
      t.decision.plan.kind === "execute" &&
      t.decision.plan.intent.fromFront === "front_south" &&
      t.decision.plan.intent.fromDispatch === undefined &&
      t.decision.plan.intent.fromSquad === undefined,
      JSON.stringify(t.decision.plan.kind === "execute" ? t.decision.plan.intent : null));
  }

  // ── I4 ★核心★ 选任务号 ⇒ 只动那次任务的**实时存活**成员 ──
  {
    const { state, stay, sent } = splitFrontFixture();
    const amb = findDispatchAmbiguity(state, RETREAT_SNAPSHOT)!;
    const dKey = amb.find((c) => c.kind === "dispatch")!.selectionKey;
    const t = jiTurn(state, jiSlot(state, amb, RETREAT_SNAPSHOT), { decision: "chose", candidate: dKey });
    check("I4 ★选任务 ⇒ applied 逐 id 等于那批外派的 4 个，留守那个不许被动★",
      t.decision.verdict === "chose" &&
      t.applied.length === sent.length && sent.every((id) => t.applied.includes(id)) &&
      !t.applied.includes(stay),
      `applied=${JSON.stringify(t.applied)} sent=${JSON.stringify([...sent].sort((a, b) => a - b))}`);
    check("I4b 绑定后 fromDispatch 在、fromFront 清掉（两个字段绝不同时填）",
      t.decision.plan.kind === "execute" &&
      t.decision.plan.intent.fromDispatch === dKey.slice("dispatch:".length) &&
      t.decision.plan.intent.fromFront === undefined,
      JSON.stringify(t.decision.plan.kind === "execute" ? t.decision.plan.intent : null));
    check("I4c 回执报的人数与真 applied 一致，落点报站名",
      t.lines.length === 1 && t.lines[0] === `已下令 ${t.applied.length} 个单位撤退至南线前哨。`,
      JSON.stringify(t.lines));
    // ★ 台账：整批从旧任务摘除、进新任务
    const active = activeDispatches(state);
    const newest = state.dispatches[state.dispatches.length - 1];
    check("I4d 台账：新任务的名单**逐 id 等于** applied，旧任务已清空转 closed",
      JSON.stringify([...newest.memberIds].sort((a, b) => a - b)) === JSON.stringify(t.applied) &&
      state.dispatches[0].status === "closed" && state.dispatches[0].memberIds.length === 0,
      `new=${JSON.stringify(newest.memberIds)} old=${state.dispatches[0].status}/${state.dispatches[0].memberIds.length} active=${active.length}`);
  }

  // ── I5 ★核心★ 模型给一个**没给过**的 key ⇒ 明确拒绝、零执行 ──
  {
    // （空串/缺 candidate 走的是 protocol_failure 那一格，见 I2——两者都零执行、
    //   都留槽，只是裁决名不同：一个是"选了个不存在的"，一个是"没说选了什么"。）
    for (const bogus of ["dispatch:M99", "stay:front_center", "M1", "STAY:FRONT_SOUTH", "stay:front", "随便"]) {
      const { state } = splitFrontFixture();
      const amb = findDispatchAmbiguity(state, RETREAT_SNAPSHOT)!;
      const before = snapshotUnitOrders(state);
      const t = jiTurn(state, jiSlot(state, amb, RETREAT_SNAPSHOT), { decision: "chose", candidate: bogus });
      check(`I5 没给过的 key「${bogus}」⇒ bad_key、零执行、一兵未动`,
        t.decision.verdict === "bad_key" && t.applied.length === 0 &&
        snapshotUnitOrders(state) === before,
        `verdict=${t.decision.verdict}`);
    }
    // ★ 唯一的规范化＝去掉首尾空白（模型常多带一个空格）。它只能把同一个 key
    //   变回自己，绝不可能把"没给过的"变成"给过的"——所以这一格是**正例**。
    //   大小写**不**折叠、不做模糊匹配（上面 STAY:FRONT_SOUTH 与 stay:front 两条
    //   负例钉的就是这个）。
    {
      const { state } = splitFrontFixture();
      const amb = findDispatchAmbiguity(state, RETREAT_SNAPSHOT)!;
      const stayId = amb.find((c) => c.kind === "stay")!.unitIds[0];
      const t = jiTurn(state, jiSlot(state, amb, RETREAT_SNAPSHOT), { decision: "chose", candidate: "  stay:front_south\n" });
      check("I5c 首尾空白被规范化掉 ⇒ 仍认得出那个 key（唯一的规范化，不折叠大小写）",
        t.decision.verdict === "chose" && t.applied.length === 1 && t.applied[0] === stayId,
        `verdict=${t.decision.verdict} applied=${JSON.stringify(t.applied)}`);
    }

    // bad_key 要说"我没听准"，不能让长官以为自己答对了
    const { state } = splitFrontFixture();
    const amb = findDispatchAmbiguity(state, RETREAT_SNAPSHOT)!;
    const t = jiTurn(state, jiSlot(state, amb, RETREAT_SNAPSHOT), { decision: "chose", candidate: "dispatch:M99" });
    check("I5b bad_key 的再问句里说清了「没听准」＋「还没有执行」",
      t.decision.plan.kind === "reask" &&
      t.decision.plan.lead.includes("没听准") && t.decision.plan.lead.includes("没有执行"),
      t.decision.plan.kind === "reask" ? t.decision.plan.lead : "");
  }

  // ── I6 等待期间**部分死亡** ⇒ 按实时状态缩减，不用旧 roster ──
  {
    const { state, sent } = splitFrontFixture();
    const amb = findDispatchAmbiguity(state, RETREAT_SNAPSHOT)!;
    const slot = jiSlot(state, amb, RETREAT_SNAPSHOT);
    const dKey = amb.find((c) => c.kind === "dispatch")!.selectionKey;
    const frozen = amb.find((c) => c.kind === "dispatch")!.unitIds.length;
    // 回复途中死一个
    const dead = sent[0];
    state.units.get(dead)!.state = "dead";
    const t = jiTurn(state, slot, { decision: "chose", candidate: dKey });
    check("I6 ★等待期间死 1 个 ⇒ 实际调动 = 冻结名单 - 1，且死者不在 applied 里★",
      t.applied.length === frozen - 1 && !t.applied.includes(dead),
      `frozen=${frozen} applied=${JSON.stringify(t.applied)} dead=${dead}`);
    check("I6b 回执报的是真数，不是槽里那份快照的原始人数",
      t.lines.length === 1 && t.lines[0].includes(`${frozen - 1} 个`) && !t.lines[0].includes(`${frozen} 个`),
      JSON.stringify(t.lines));
  }

  // ── I7 等待期间那批**全死 / 任务关闭** ⇒ 明确拒绝，不退回别的选法 ──
  {
    const { state, sent } = splitFrontFixture();
    const amb = findDispatchAmbiguity(state, RETREAT_SNAPSHOT)!;
    const slot = jiSlot(state, amb, RETREAT_SNAPSHOT);
    const dKey = amb.find((c) => c.kind === "dispatch")!.selectionKey;
    for (const id of sent) state.units.get(id)!.state = "dead";
    const before = snapshotUnitOrders(state);
    const t = jiTurn(state, slot, { decision: "chose", candidate: dKey });
    check("I7 ★那批全死 ⇒ refuse、零执行（绝不退回去调留守那个或全军）★",
      t.decision.plan.kind === "refuse" && t.applied.length === 0 &&
      snapshotUnitOrders(state) === before,
      `plan=${t.decision.plan.kind}`);
    check("I7b 拒绝话里说明了「已经不在了」＋「没有执行」",
      t.decision.plan.kind === "refuse" && t.decision.plan.line.includes("不在了") &&
      t.decision.plan.line.includes("没有执行"),
      t.decision.plan.kind === "refuse" ? t.decision.plan.line : "");
  }

  // ── I8 只剩一批时不再缠人：答不清也直接按仅剩那批办 ──
  {
    const { state, sent, stay } = splitFrontFixture();
    const amb = findDispatchAmbiguity(state, RETREAT_SNAPSHOT)!;
    const slot = jiSlot(state, amb, RETREAT_SNAPSHOT);
    state.units.get(stay)!.state = "dead";   // 留守那个没了 ⇒ 候选只剩任务那一条
    const t = jiTurn(state, slot, { decision: "unclear" });
    check("I8 答不清但候选已只剩一批 ⇒ 直接按它办（不再缠人，撞「勿变 20 问」）",
      t.decision.plan.kind === "execute" && t.applied.length === sent.length &&
      sent.every((id) => t.applied.includes(id)),
      `plan=${t.decision.plan.kind} applied=${JSON.stringify(t.applied)}`);
  }

  // ── I9 跨频道 / 过期 / 跨局：旧选择一律不可消费 ──
  {
    const mk = () => { const f = splitFrontFixture(); const amb = findDispatchAmbiguity(f.state, RETREAT_SNAPSHOT)!; return { ...f, amb }; };
    const dKeyOf = (amb: DispatchCandidate[]) => amb.find((c) => c.kind === "dispatch")!.selectionKey;

    // 跨频道：答复带的标签是别的频道
    {
      const { state, amb } = mk();
      const before = snapshotUnitOrders(state);
      const t = jiTurn(state, jiSlot(state, amb, RETREAT_SNAPSHOT), { decision: "chose", candidate: dKeyOf(amb) },
        { tag: { selectionId: "sel-1", channel: "logistics", sessionId: JI_SESSION } });
      check("I9 跨频道的答复 ⇒ stale、不消费、零执行",
        t.decision.verdict === "stale" && t.applied.length === 0 && snapshotUnitOrders(state) === before, `verdict=${t.decision.verdict}`);
    }
    // 跨会话
    {
      const { state, amb } = mk();
      const t = jiTurn(state, jiSlot(state, amb, RETREAT_SNAPSHOT), { decision: "chose", candidate: dKeyOf(amb) },
        { tag: { selectionId: "sel-1", channel: JI_CH, sessionId: "other" } });
      check("I9b 跨会话的答复 ⇒ stale、不消费", t.decision.verdict === "stale" && t.applied.length === 0);
    }
    // 跨局（epoch 变了＝重开一局）
    {
      const { state, amb } = mk();
      const before = snapshotUnitOrders(state);
      const t = jiTurn(state, jiSlot(state, amb, RETREAT_SNAPSHOT), { decision: "chose", candidate: dKeyOf(amb) }, { epoch: 2 });
      check("I9c ★重开一局（epoch 变了）⇒ 旧选择不可消费、零执行★",
        t.decision.verdict === "stale" && t.applied.length === 0 && snapshotUnitOrders(state) === before,
        `verdict=${t.decision.verdict}`);
    }
    // 过期
    {
      const { state, amb } = mk();
      const slot = jiSlot(state, amb, RETREAT_SNAPSHOT);
      const t = jiTurn(state, slot, { decision: "chose", candidate: dKeyOf(amb) }, { now: slot.expiresAt + 1 });
      check("I9d 过期的答复 ⇒ stale、零执行，且允许清掉**这一槽**",
        t.decision.verdict === "stale" && t.applied.length === 0 && t.decision.clearExpiredSlot === true,
        `verdict=${t.decision.verdict} clearExpired=${t.decision.clearExpiredSlot}`);
    }
    // 标签对不上 id（等回复期间登记了更新的一槽）⇒ 不许碰那一槽
    {
      const { state, amb } = mk();
      const t = jiTurn(state, jiSlot(state, amb, RETREAT_SNAPSHOT, "sel-NEW"), { decision: "chose", candidate: dKeyOf(amb) },
        { tag: jiTag("sel-OLD") });
      check("I9e 标签 id 与活槽不符（中途换过一槽）⇒ stale、不消费、不许清那一槽",
        t.decision.verdict === "stale" && t.applied.length === 0 && t.decision.clearExpiredSlot === false,
        `verdict=${t.decision.verdict}`);
    }
    // 没带标签
    {
      const { state, amb } = mk();
      const t = jiTurn(state, jiSlot(state, amb, RETREAT_SNAPSHOT), { decision: "chose", candidate: dKeyOf(amb) }, { tag: null });
      check("I9f 请求没带标签 ⇒ no_pending、走正常流程（不消费那一槽）",
        t.decision.verdict === "no_pending" && t.decision.plan.kind === "passthrough", `verdict=${t.decision.verdict}`);
    }
  }

  // ── I10 无关新命令 ⇒ 撤掉旧槽、正常处理这条新命令 ──
  {
    const { state, amb } = (() => { const f = splitFrontFixture(); return { ...f, amb: findDispatchAmbiguity(f.state, RETREAT_SNAPSHOT)! }; })();
    const t = jiTurn(state, jiSlot(state, amb, RETREAT_SNAPSHOT), { decision: "unrelated" });
    check("I10 无关新命令 ⇒ unrelated、passthrough、槽不留（不许拿新命令偷偷消费那一次豁免）",
      t.decision.verdict === "unrelated" && t.decision.plan.kind === "passthrough" && t.decision.keepSlot === false,
      `verdict=${t.decision.verdict} keepSlot=${t.decision.keepSlot}`);
  }

  // ── I11 权限：那批人不在这位参谋麾下 ⇒ 明确拒绝、零执行 ──
  {
    const { state } = splitFrontFixture();
    const amb = findDispatchAmbiguity(state, RETREAT_SNAPSHOT)!;
    const dKey = amb.find((c) => c.kind === "dispatch")!.selectionKey;
    const before = snapshotUnitOrders(state);
    const d = planSelectionTurn({
      state, slot: jiSlot(state, amb, RETREAT_SNAPSHOT), requestTag: jiTag(), epoch: 1, now: state.time,
      persona: "emily", rawDecision: { decision: "chose", candidate: dKey }, personaLabel: "艾米莉中尉",
    });
    check("I11 ★选定的那批不在这位参谋麾下 ⇒ refuse、零执行（走的是主链同一个权限闸）★",
      d.plan.kind === "refuse" && d.plan.line.includes("艾米莉中尉") && d.plan.line.includes("没有执行") &&
      snapshotUnitOrders(state) === before,
      `plan=${d.plan.kind} line=${d.plan.kind === "refuse" ? d.plan.line : ""}`);
  }

  // ── I12 ★跑完整循环★ 绑定后真到位、转 defending、不掉头 ──
  {
    const { state, sent } = splitFrontFixture();
    const amb = findDispatchAmbiguity(state, RETREAT_SNAPSHOT)!;
    const dKey = amb.find((c) => c.kind === "dispatch")!.selectionKey;
    const t = jiTurn(state, jiSlot(state, amb, RETREAT_SNAPSHOT), { decision: "chose", candidate: dKey });
    const post = [...state.facilities.values()].find((f) => f.id === "ea_player_south_post")!;
    fullPump(state, 300);
    const alive = t.applied.map((id) => state.units.get(id)).filter((u): u is Unit => u != null && u.state !== "dead");
    check("I12 ★绑定执行后跑完整循环 300s：人到前哨（≤6 格）、零掉头（>15 格）、转 defending★",
      alive.length === sent.length &&
      alive.every((u) => near(u.position, post.position, 6)) &&
      alive.every((u) => u.state === "defending"),
      `存活 ${alive.length}/${sent.length} 距离=${JSON.stringify(alive.map((u) => Math.round(Math.hypot(u.position.x - post.position.x, u.position.y - post.position.y))))} 状态=${JSON.stringify(alive.map((u) => u.state))}`);
  }

  // ── I13 引擎侧零中文词表：判定只看结构 ──
  {
    const src = readFileSync("packages/shared/src/dispatchSelection.ts", "utf8")
      + readFileSync("packages/core/src/dispatchSelectionTurn.ts", "utf8");
    const codeOnly = src.split("\n").filter((l) => {
      const t = l.trimStart();
      return !t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/*");
    }).join("\n");
    check("I13 合同与判定里没有中文确认词/同义词表（「好的」这类一个都不许有）",
      !/["'`](好的?|对|是的?|可以|行|嗯|没错|就这样|执行|确认)["'`]/.test(codeOnly),
      "");
    check("I13b 严格解析只认三个字面值（chose/unclear/unrelated），别的一律 undefined",
      codeOnly.includes('=== "unclear"') && codeOnly.includes('=== "unrelated"') && codeOnly.includes('=== "chose"'),
      "");
  }

  // ── I14 接线：ChatPanel 不许自己做判断，也不许再走"清槽后盲办" ──
  {
    const cp = readFileSync("apps/web/src/ChatPanel.tsx", "utf8");
    check("I14 ChatPanel 走的是 core 的 planSelectionTurn（判定不留在闭包里）",
      cp.includes("planSelectionTurn({"), "");
    check("I14b 刀C 那句「一次性消费 ⇒ 照模型字段办」的写法已经不在了",
      !cp.includes("pendingSelectionRef.current = null; // 一次性消费"), "");
    check("I14c 绑定名单作为硬约束进 resolveIntent（优先级排在框选之前）",
      cp.includes("ticketRosters.get(intent) ?? boundRosters.get(intent) ?? selectedIdsSnapshotRef.current"), "");
    check("I14d 新字段过了 shared 的白名单重建（两条 return 路径都带）",
      (readFileSync("packages/shared/src/schema.ts", "utf8").match(/dispatchSelection,/g) ?? []).length === 2, "");
  }

  if (negctl) {
    console.log("\n-- negctl：刀C 那版「问完就相信模型」打在新合同上，必须真红 --");
    // 旧行为的影子：不看 candidate、直接执行模型这一轮写的 intent（＝原快照）。
    const { state, stay } = splitFrontFixture();
    const amb = findDispatchAmbiguity(state, RETREAT_SNAPSHOT)!;
    const dKey = amb.find((c) => c.kind === "dispatch")!.selectionKey;
    const naive = resolveIntent(RETREAT_SNAPSHOT, state, state.style);   // 刀C：照字段办
    const bound = planSelectionTurn({
      state, slot: jiSlot(state, amb, RETREAT_SNAPSHOT), requestTag: jiTag(), epoch: 1, now: state.time,
      persona: "chen", rawDecision: { decision: "chose", candidate: dKey }, personaLabel: "陈军士",
    });
    const boundIds = bound.plan.kind === "execute" ? [...bound.plan.unitIds].sort((a, b) => a - b) : [];
    const red = naive.assignedUnitIds.length === 1 && naive.assignedUnitIds[0] === stay && boundIds.length === 4;
    console.log(`  ${red ? "RED(好)" : "GREEN(坏)"} negctl-I 刀C 照字段办 ⇒ ${naive.assignedUnitIds.length} 个（留守那个）；绑定后 ⇒ ${boundIds.length} 个（外派那批）`);
    check("negctl 绑定确实承重：同一句话、同一局面，照字段办与绑定办**调的不是同一批人**", red, "");

    // 第二条：把"好的"当成选定（＝没有 unclear 这一格）会怎样
    const { state: st2 } = splitFrontFixture();
    const amb2 = findDispatchAmbiguity(st2, RETREAT_SNAPSHOT)!;
    const unclear = planSelectionTurn({
      state: st2, slot: jiSlot(st2, amb2, RETREAT_SNAPSHOT), requestTag: jiTag(), epoch: 1, now: st2.time,
      persona: "chen", rawDecision: { decision: "unclear" }, personaLabel: "陈军士",
    });
    const red2 = unclear.plan.kind === "reask" && unclear.keepSlot === true;
    console.log(`  ${red2 ? "RED(好)" : "GREEN(坏)"} negctl-I2 「好的」那一格：plan=${unclear.plan.kind}、keepSlot=${unclear.keepSlot}（旧版会执行）`);
    check("negctl 「好的」绝不消费待决槽（旧版这一格会照字段执行）", red2, "");
  }
}

// ════════════════════════════════════════════════════════════
// 刀 庚/辛/壬：经济单回报真实结算 · mixed 回执补全 · 屏声 context 同源
// ════════════════════════════════════════════════════════════
//
// §三 病：`slice.economy=true` 就无条件 outcome="applied" + 复述 planLog。
//   实测三格（全部在 9985f92 上复现过）：
//   A $170 造 3 个步兵 ⇒ 队列真只进 2、钱剩 $10，回执说「生产步兵 ×3。」
//   B $50 全力造主战坦克 ⇒ 队列 0、钱没动，回执说「全力生产主战坦克。」
//   C $50 全力买油 ⇒ 钱没动，回执说「下达交易命令: buy_fuel。」
//   ★ B/C 连黄字都没有：刀丁只捞 PRODUCE_FAIL/TRADE_FAIL，而预算结算走的是
//     PRODUCE_BUDGET/TRADE_BUDGET。
// §四 病：作战条用互斥四分支判结局，非零栏会被丢掉。
// §五 病：refuseAloud 不写 context；可执行回合先把 data.brief 推了进去。

/** 跑一条经济意图，返回真实变化与回执（镜像 ChatPanel 的取数链）。 */
function econRun(money: number, intent: Intent, fuel?: number) {
  const st = createInitialGameState("el_alamein");
  st.economy.player.resources.money = money;
  if (fuel !== undefined) st.economy.player.resources.fuel = fuel;
  const q0 = st.productionQueue.player.length;
  const m0 = st.economy.player.resources.money;
  const f0 = st.economy.player.resources.fuel;
  const r = resolveIntent(intent, st, st.style);
  if (r.degraded) return { st, r, receipt: null, dq: 0, dm: 0, df: 0 };
  const res = applyOrders(st, r.orders);
  const receipt = buildExecReceipt(res, [sliceOf(intent, r.destinationName, r.log, r.orders.map((_, k) => k))]);
  return {
    st, r, receipt,
    dq: st.productionQueue.player.length - q0,
    dm: m0 - st.economy.player.resources.money,
    df: st.economy.player.resources.fuel - f0,
  };
}

function knifeGeng(negctl: boolean): void {
  console.log("\n== 刀 庚/辛/壬：真实结算 · mixed 回执 · 屏声 context 同源 ==");

  // ── G1 ★反例 A★ 普通生产**部分成功**：报真数，不报计划那个数 ──
  {
    const g = econRun(170, { type: "produce", produceType: "infantry", quantity: 3 } as Intent);
    const f = g.receipt!.facts[0].economyFact!;
    check("G1 台架自证：$170 造 3 个步兵 ⇒ 引擎真只进 2 个、真花 $160",
      g.dq === 2 && g.dm === 160, `dq=${g.dq} dm=${g.dm}`);
    check("G1b ★回执报真实成功数 2（不是计划那个 3），并说清没办成的那 1 件★",
      f.requested === 3 && f.succeeded === 2 && f.failed === 1 && f.moneySpent === 160 &&
      g.receipt!.lines[0].includes("×2") && !g.receipt!.lines[0].includes("×3") &&
      g.receipt!.lines[0].includes("还差 1 件"),
      `line=${g.receipt!.lines[0]} fact=${JSON.stringify(f)}`);
    check("G1c ★部分成功 ⇒ 整批结局是 partial，不许伪装成纯成功★",
      g.receipt!.outcome === "partial" && g.receipt!.facts[0].outcome === "partial",
      `outcome=${g.receipt!.outcome}`);
    check("G1d 真实花费与引擎实际扣款逐元相等（计划那一行里根本没有金额）",
      f.moneySpent === g.dm && !g.r.log.includes("$"), `spent=${f.moneySpent} dm=${g.dm}`);
  }

  // ── G2 钱够：一份成功回执，不多一声失败 ──
  {
    const g = econRun(3500, { type: "produce", produceType: "infantry", quantity: 3 } as Intent);
    const f = g.receipt!.facts[0].economyFact!;
    check("G2 钱够造 3 个 ⇒ 真成 3、回执 3、结局 applied、一条原因都没有",
      g.dq === 3 && f.succeeded === 3 && f.failed === 0 && f.reasons.length === 0 &&
      g.receipt!.outcome === "applied" && g.receipt!.lines.length === 1 &&
      !g.receipt!.lines[0].includes("没有执行") && !g.receipt!.lines[0].includes("还差"),
      `line=${g.receipt!.lines[0]}`);
  }

  // ── G3 完全没钱：零变化，且**不许先说一句正面成功句** ──
  {
    const g = econRun(0, { type: "produce", produceType: "infantry", quantity: 3 } as Intent);
    const f = g.receipt!.facts[0].economyFact!;
    check("G3 ★$0 造 3 个 ⇒ 真零变化、结局 none、回执以「没有执行」起头、带原因★",
      g.dq === 0 && g.dm === 0 && f.succeeded === 0 && f.failed === 3 &&
      g.receipt!.outcome === "none" &&
      g.receipt!.lines[0].startsWith("没有执行") && g.receipt!.lines[0].includes("资金不足") &&
      !g.receipt!.lines[0].includes("×3"),
      `line=${g.receipt!.lines[0]}`);
  }

  // ── G4 ★反例 B★ 预算生产完全失败 ──
  {
    const g = econRun(50, {
      type: "produce", produceType: "main_tank",
      produceBudget: { mode: "fraction_of_money", fraction: 1 },
    } as Intent);
    const f = g.receipt!.facts[0].economyFact!;
    check("G4 台架自证：$50 全力造主战坦克 ⇒ 队列没动、钱没动",
      g.dq === 0 && g.dm === 0, `dq=${g.dq} dm=${g.dm}`);
    check("G4b ★回执不再说「全力生产主战坦克。」，而是「没有执行」＋真实约束★",
      g.receipt!.outcome === "none" && f.succeeded === 0 &&
      g.receipt!.lines[0].startsWith("没有执行") &&
      g.receipt!.lines[0].includes("钱不够") &&
      !g.receipt!.lines[0].includes("全力生产"),
      `line=${g.receipt!.lines[0]}`);
  }

  // ── G5 预算生产成功：回执带真实数量与花费 ──
  {
    const g = econRun(3500, {
      type: "produce", produceType: "infantry",
      produceBudget: { mode: "fraction_of_money", fraction: 0.5 },
    } as Intent);
    const f = g.receipt!.facts[0].economyFact!;
    check("G5 预算生产成功 ⇒ 回执的件数/花费＝引擎真结算（不是模型也不是计划）",
      f.succeeded === g.dq && f.moneySpent === g.dm && f.succeeded > 0 &&
      g.receipt!.lines[0].includes(`×${f.succeeded}`) &&
      g.receipt!.lines[0].includes(`$${f.moneySpent}`),
      `line=${g.receipt!.lines[0]} dq=${g.dq} dm=${g.dm}`);
  }

  // ── G6 ★燃油界★：零件回执要报真实约束（钱油不合并，用户审计那一笔）──
  {
    const g = econRun(100000, {
      type: "produce", produceType: "main_tank",
      produceBudget: { mode: "fraction_of_money", fraction: 1 },
    } as Intent, 0);
    check("G6 钱多油零 ⇒ 回执说的是**燃油不足**，不是钱不够（钱界油界不合并）",
      g.receipt!.outcome === "none" &&
      g.receipt!.lines[0].includes("燃油不足") && !g.receipt!.lines[0].includes("钱不够"),
      `line=${g.receipt!.lines[0]}`);
  }

  // ── G7 ★反例 C★ 预算交易失败 / 成功 两格 ──
  {
    const bad = econRun(50, {
      type: "trade", tradeAction: "buy_fuel",
      tradeBudget: { mode: "fraction_of_money", fraction: 1 },
    } as Intent);
    check("G7 ★$50 全力买油 ⇒ 钱没动，回执不再复述「buy_fuel」而是「没有执行」＋原因★",
      bad.dm === 0 && bad.df === 0 && bad.receipt!.outcome === "none" &&
      bad.receipt!.lines[0].startsWith("没有执行") &&
      !bad.receipt!.lines[0].includes("buy_fuel"),
      `line=${bad.receipt!.lines[0]}`);
    const ok = econRun(3500, {
      type: "trade", tradeAction: "buy_fuel",
      tradeBudget: { mode: "fraction_of_money", fraction: 1 },
    } as Intent);
    const f = ok.receipt!.facts[0].economyFact!;
    check("G7b 预算交易成功 ⇒ 报真实结算（到手的油量、花掉的钱），不复述计划字段",
      f.resourceGained === ok.df && f.moneySpent === ok.dm && f.succeeded > 0 &&
      ok.receipt!.lines[0].includes(`${ok.df}`) && ok.receipt!.lines[0].includes(`$${ok.dm}`) &&
      !ok.receipt!.lines[0].includes("buy_fuel"),
      `line=${ok.receipt!.lines[0]} df=${ok.df} dm=${ok.dm}`);
    const single = econRun(50, { type: "trade", tradeAction: "buy_fuel" } as Intent);
    check("G7c 单次买油钱不够 ⇒ 同样「没有执行」＋原因（不是正面交易计划）",
      single.dm === 0 && single.receipt!.outcome === "none" &&
      single.receipt!.lines[0].includes("资金不足"),
      `line=${single.receipt!.lines[0]}`);
  }

  // ── G8 去重只合并措辞，不丢件数 ──
  {
    const g = econRun(170, { type: "produce", produceType: "infantry", quantity: 3 } as Intent);
    const f = g.receipt!.facts[0].economyFact!;
    check("G8 ★同因去重后只剩一句，但成功件数/失败件数一件不丢★",
      f.reasons.length === 1 &&
      (g.receipt!.lines[0].match(/资金不足/g) ?? []).length === 1 &&
      f.succeeded === 2 && f.failed === 1 && f.succeeded + f.failed === f.requested,
      `reasons=${JSON.stringify(f.reasons)} fact=${JSON.stringify(f)}`);
  }

  // ── S1..S7 ★审核 §四★ mixed 组合：三栏分别追加，不许丢掉非零栏 ──
  //    ★ 用**真** applyOrders 造组合，不手搓假对象。
  {
    const mix = (opts: { applied: number; already: number; rejected: number }) => {
      nextId = 9000;
      const st = emptyBattlefield("el_alamein");
      st.time = 120;
      const ids: number[] = [];
      const target = { x: 350, y: 150 };
      // applied：干净的可调单位
      for (let i = 0; i < opts.applied; i++) ids.push(addUnit(st, 340 + i, 150).id);
      // rejected：被玩家手动接管 ⇒ applyOrders 的四道过滤会拒（manual_override）
      const rej: number[] = [];
      for (let i = 0; i < opts.rejected; i++) {
        const u = addUnit(st, 345 + i, 150, { manualOverride: true });
        rej.push(u.id); ids.push(u.id);
      }
      // already：已经在执行等价的危机增援单 ⇒ 幂等跳过
      const alr: number[] = [];
      for (let i = 0; i < opts.already; i++) {
        const u = addUnit(st, 348 + i, 150);
        u.orders = [{ unitIds: [u.id], action: "retreat", target, priority: 1, crisisFrontId: "cf1" }];
        alr.push(u.id); ids.push(u.id);
      }
      const order: Order = {
        unitIds: ids, action: "retreat", target, priority: 1, crisisFrontId: "cf1",
      };
      const res = applyOrders(st, [order]);
      const receipt = buildExecReceipt(res, [{ action: "retreat", destinationName: "南线前哨", orderIndexes: [0] }]);
      return { res, receipt };
    };
    const COMB: Array<[string, { applied: number; already: number; rejected: number }]> = [
      ["只有 applied", { applied: 2, already: 0, rejected: 0 }],
      ["只有 already", { applied: 0, already: 2, rejected: 0 }],
      ["只有 rejected", { applied: 0, already: 0, rejected: 2 }],
      ["applied+rejected", { applied: 2, already: 0, rejected: 1 }],
      ["applied+already", { applied: 2, already: 1, rejected: 0 }],
      ["already+rejected", { applied: 0, already: 1, rejected: 1 }],
      ["applied+already+rejected", { applied: 1, already: 1, rejected: 1 }],
    ];
    for (const [label, want] of COMB) {
      const { res, receipt } = mix(want);
      const line = receipt.lines[0] ?? "";
      const f = receipt.facts[0];
      // ① 台架自证：applyOrders 真造出了这个组合（否则这一条不承重）
      const got = {
        applied: res.appliedUnitIds.length,
        already: res.alreadyDoingUnitIds.length,
        rejected: res.rejectedUnitIds.length,
      };
      const shaped = got.applied === want.applied && got.already === want.already && got.rejected === want.rejected;
      // ② 每个非零栏都必须在那一行里露面（数字对得上）
      const mentions =
        (want.applied === 0 || (line.includes(`${want.applied} 个单位`) && line.includes("已下令"))) &&
        (want.already === 0 || (line.includes(`${want.already} 个已经在`) && line.includes("没有重新下令"))) &&
        (want.rejected === 0 || line.includes("没接到命令"));
      // ③ 有被拒就不许读成纯成功
      const severity = want.rejected === 0 || (f.outcome !== "applied" && f.outcome !== "already_doing");
      check(`S ${label} ⇒ 真造出该组合、三栏各自露面、有被拒就不算纯成功`,
        shaped && mentions && severity,
        `got=${JSON.stringify(got)} want=${JSON.stringify(want)} outcome=${f.outcome} line=${line}`);
    }
    // ★ already 绝不进新任务的 applied 名单
    {
      nextId = 9000;
      const st = emptyBattlefield("el_alamein");
      st.time = 120;
      const target = { x: 350, y: 150 };
      const fresh = addUnit(st, 340, 150).id;
      const busy = addUnit(st, 348, 150);
      busy.orders = [{ unitIds: [busy.id], action: "retreat", target, priority: 1, crisisFrontId: "cf1" }];
      const meta: DispatchMeta = { group: "i0", sourceKind: "front", sourceKey: "front_south", action: "retreat", targetName: "南线前哨" };
      const res = applyOrders(st, [{
        unitIds: [fresh, busy.id], action: "retreat", target, priority: 1,
        crisisFrontId: "cf1", origin: "advisor", dispatchMeta: meta,
      } as Order]);
      const d = st.dispatches[st.dispatches.length - 1];
      check("S8 ★alreadyDoing 不算新派兵：台账新记录里只有真下令那个，幂等那个不在★",
        res.appliedUnitIds.length === 1 && res.appliedUnitIds[0] === fresh &&
        res.alreadyDoingUnitIds.length === 1 && res.alreadyDoingUnitIds[0] === busy.id &&
        d != null && d.memberIds.length === 1 && d.memberIds[0] === fresh,
        `applied=${JSON.stringify(res.appliedUnitIds)} ledger=${JSON.stringify(d?.memberIds)}`);
    }
  }

  // ── C1..C4 ★审核 §五★ 屏 / 声 / context 同源 ──
  {
    const cp = readFileSync("apps/web/src/ChatPanel.tsx", "utf8");
    const helper = braceBody(cp, "const refuseAloud = (");
    check("C1 ★拒绝出口也写 context（屏/声/context 同一个 msg）★",
      helper.includes("pushContext(channelContextRef.current, ch, { role: \"assistant\", text: msg"),
      helper ? "找到出口但没写 context" : "★找不到出口");
    check("C1b `screen:false` 只表示不重复上屏，**不**禁止进 context（两个开关分开）",
      helper.includes("opts?.screen !== false") && helper.includes("opts?.context !== false"),
      "");
    check("C2 ★会动兵的回合不把 data.brief 当已执行事实写进 context★",
      cp.includes("if (data.brief && !willExecute) {"), "");
    check("C3 执行回执的每一行都进 context（真实结果覆盖得到）",
      cp.includes("pushContext(channelContextRef.current, ch, { role: \"assistant\", text: line, time: state.time });"),
      "");
    // ★刀子 改判：执行出口只剩一处（线程那份已委派），所以这里也只该有一处。
    check("C4 部分成功也不许显示成普通 info（有没办成的部分就降级；出口只此一处）",
      (cp.match(/execReceipt\.outcome === "none" \|\| execReceipt\.outcome === "partial" \? "warning" : "info"/g) ?? []).length === 1,
      "");
  }

  if (negctl) {
    console.log("\n-- negctl：刀甲那版「经济单一律 applied + 复述计划」打在新引擎上，必须真红 --");
    let reds = 0;
    const CASES: Array<[string, () => ReturnType<typeof econRun>]> = [
      ["A 部分成功", () => econRun(170, { type: "produce", produceType: "infantry", quantity: 3 } as Intent)],
      ["B 预算生产全败", () => econRun(50, { type: "produce", produceType: "main_tank", produceBudget: { mode: "fraction_of_money", fraction: 1 } } as Intent)],
      ["C 预算交易全败", () => econRun(50, { type: "trade", tradeAction: "buy_fuel", tradeBudget: { mode: "fraction_of_money", fraction: 1 } } as Intent)],
    ];
    for (const [label, run] of CASES) {
      const g = run();
      const oldLine = `${g.r.log}。`;                 // 刀甲：复述计划那一行
      const oldOutcome = "applied";                   // 刀甲：无条件 applied
      const trulyOk = g.dq > 0 || g.dm > 0;           // 引擎到底办成没有
      const red = g.receipt!.lines[0] !== oldLine &&
        (g.receipt!.outcome !== oldOutcome || !trulyOk === false);
      const honest = (g.receipt!.outcome === "none") === (!trulyOk && g.dq === 0 && g.dm === 0);
      if (red && honest) reds++;
      console.log(`  ${red && honest ? "RED(好)" : "GREEN(坏)"} negctl-G ${label}：旧回执「${oldLine}」/${oldOutcome} vs 新回执「${g.receipt!.lines[0]}」/${g.receipt!.outcome}（引擎真变了=${trulyOk}）`);
    }
    check("negctl 刀甲那版回执在三格上全部与真相不符（真实结算确实承重）", reds === 3, `${reds}/3`);
  }
}

// ════════════════════════════════════════════════════════════
// 刀 癸：跨局 / 延迟回调保护（审核 §六）
// ════════════════════════════════════════════════════════════
//
// 病：`processAdvisorData` 头上那道按对象身份的重开守卫是对的，但它**过了之后**
// 还要 `setTimeout(..., 0)` 才真去 `handleApprove`，而 `ExecContext` 里没有来源局
// 的任何印记 —— 中间那一跳撞上重开一局，上一局的单子就落进新局。
// 群聊那条路更长（每条押 2.2–4 秒），旧写法还带着**旧局的** `state.time`。
//
// 判据分两层：
//   ① 纯判官 `judgeRunGuard` 跑真代码，含**可控 fake timer** 的四步序列；
//   ② 接线用源码级检查钉住（那几处在 React 闭包里，node 够不着）。

/** 可控假定时器：push 进来的回调只有 flush() 时才跑（顺序 FIFO）。 */
function fakeTimer() {
  const q: Array<() => void> = [];
  return {
    schedule(fn: () => void) { q.push(fn); },
    pending() { return q.length; },
    flush() { const all = q.splice(0, q.length); for (const fn of all) fn(); },
  };
}

function knifeGui(negctl: boolean): void {
  console.log("\n== 刀 癸：跨局 / 延迟回调保护 ==");

  // ── R1 纯判官四格 ──
  {
    const sA = createInitialGameState("el_alamein");
    const sB = createInitialGameState("el_alamein");   // 重开一局＝换一个对象
    const st = stampRun(1, sA);
    check("R1 同一局（局次与对象身份都没变）⇒ same_run",
      judgeRunGuard(st, 1, sA) === "same_run" && runGuardAllows(st, 1, sA), "");
    check("R1b 局次变了 ⇒ restarted、不许跑",
      judgeRunGuard(st, 2, sA) === "restarted" && !runGuardAllows(st, 2, sA), "");
    check("R1c GameState 被换掉（轮询还没追上 epoch 的那个 race）⇒ state_replaced、不许跑",
      judgeRunGuard(st, 1, sB) === "state_replaced" && !runGuardAllows(st, 1, sB), "");
    check("R1d 没盖印 ⇒ no_stamp、不许跑（fail-closed：宁可漏做，不许做错局）",
      judgeRunGuard(null, 1, sA) === "no_stamp" && !runGuardAllows(undefined, 1, sA), "");
  }

  // ── R2 ★守局次与对象身份，不守游戏时间★ ──
  {
    const sA = createInitialGameState("el_alamein");
    const st = stampRun(1, sA);
    sA.time = 9999;                   // 同一局把钟推很远 ⇒ 仍然算同一局
    check("R2 同一局里时间推进多久都仍是 same_run（判据不看时间）",
      runGuardAllows(st, 1, sA), "");
    const sNew = createInitialGameState("el_alamein");
    sNew.time = 0;                    // 新局钟从 0 起 ⇒ 任何"按时间"的闸都会漏
    check("R2b ★新局钟从 0 起，按时间写的闸会漏，而本判据照样拦住★",
      !runGuardAllows(st, 2, sNew) && sNew.time < sA.time, "");
  }

  // ── R3 ★可控 fake timer 的四步序列★（审核点名的那一条）──
  //    ① 响应通过 guard；② timer 还没跑时重开一局；③ flush；④ 新局零污染。
  {
    const timer = fakeTimer();
    let epoch = 1;
    let live = createInitialGameState("el_alamein");
    // ① 响应通过重开守卫：此刻 getState() === 出发时那个 state
    const ctxRun = stampRun(epoch, live);
    const passedGuard = runGuardAllows(ctxRun, epoch, live);
    // 回调体：与生产里 handleApprove 的头一段同形——先复核，不过就一件事不做。
    const newRunOrders: Order[] = [];
    const newRunMessages: string[] = [];
    let dropped = 0;
    timer.schedule(() => {
      if (!runGuardAllows(ctxRun, epoch, live)) { dropped++; return; }
      // 真派兵 + 真上屏（跑到这儿就说明守卫漏了）
      const r = resolveIntent({ type: "retreat", fromFront: "front_south", quantity: "all" } as Intent, live, live.style);
      const res = applyOrders(live, r.orders);
      newRunOrders.push(...r.orders);
      newRunMessages.push(`已下令 ${res.appliedUnitIds.length} 个单位撤退`);
    });
    check("R3 ① 响应当时确实通过了守卫（否则这一条不承重）", passedGuard, "");
    check("R3b ② timer 还没跑（回调押在队列里）", timer.pending() === 1, `pending=${timer.pending()}`);
    // ② 重开一局：换对象 + 推进局次（生产里 syncGameEpoch 就是这么干的）
    live = createInitialGameState("el_alamein");
    epoch = 2;
    const unitsBefore = live.units.size;
    // ③ flush
    timer.flush();
    // ④ 新局零污染
    check("R3c ★③flush 之后 ④新局零污染：没下单、没上屏、回调被静默作废★",
      dropped === 1 && newRunOrders.length === 0 && newRunMessages.length === 0,
      `dropped=${dropped} orders=${newRunOrders.length} msgs=${newRunMessages.length}`);
    let anyOrdered = 0;
    live.units.forEach((u) => { if (u.team === "player" && u.orders.length > 0) anyOrdered++; });
    check("R3d 新局的部队一个都没接到旧局那道命令",
      anyOrdered === 0 && live.units.size === unitsBefore, `ordered=${anyOrdered}`);
  }

  // ── R3e 负对照：把守卫摘掉，同一序列必须**真的**污染新局 ──
  {
    const timer = fakeTimer();
    let live = createInitialGameState("el_alamein");
    let epoch = 1;
    const ctxRun = stampRun(epoch, live);
    let ordered = 0;
    timer.schedule(() => {
      // ★摘刀：不复核，照生产里旧写法直接 getState() 当场用
      void ctxRun;
      const r = resolveIntent({ type: "retreat", fromFront: "front_south", quantity: "all" } as Intent, live, live.style);
      const res = applyOrders(live, r.orders);
      ordered = res.appliedUnitIds.length;
    });
    live = createInitialGameState("el_alamein");
    epoch = 2;
    void epoch;
    timer.flush();
    check("R3e ★摘刀负对照：不复核 ⇒ 旧局那道命令真的落进了新局（判据确实承重）★",
      ordered > 0, `新局被下令 ${ordered} 个`);
  }

  // ── R4 接线：四条批准路与群聊延迟回调都盖印/复核 ──
  {
    const cp = readFileSync("apps/web/src/ChatPanel.tsx", "utf8");
    check("R4 ExecContext 带局印字段（run: RunStamp）",
      /type ExecContext = \{[\s\S]{0,400}?run\?: RunStamp;/.test(cp), "");
    check("R4b 造 ctx 那一处盖印（四条批准路共用它）",
      cp.includes("run: stampRun(gameEpochRef.current, state)"), "");
    const ha = braceBody(cp, "const handleApprove = (");
    const guardAt = ha.indexOf("runGuardAllows(execCtx?.run");
    const firstWrite = Math.min(
      ...["applyOrders(", "addMessage(", "pushContext(", "resolveIntent("]
        .map((k) => { const i = ha.indexOf(k); return i < 0 ? Number.POSITIVE_INFINITY : i; }),
    );
    check("R4c ★handleApprove 的复核排在任何 写状态/发消息/下单 之前★",
      guardAt > 0 && guardAt < firstWrite, `guardAt=${guardAt} firstWrite=${firstWrite}`);
    check("R4d 复核不过就 return（静默作废，只留一条诊断）",
      /runGuardAllows\(execCtx\?\.run[\s\S]{0,400}?STALE_RUN_DROPPED[\s\S]{0,200}?return;/.test(ha), "");
    check("R4e 群聊那条延迟回调也盖印＋落地复核，且时间取落地这一刻的钟",
      cp.includes("const groupRun = stampRun(gameEpochRef.current, state)") &&
      cp.includes("if (!now || !runGuardAllows(groupRun, gameEpochRef.current, now)) return;") &&
      cp.includes("addMessage(\"info\", r.brief, now.time, ch, commander"), "");
    check("R4f 判据不看游戏时间：守卫那两处一个 state.time 比较都没有",
      !/runGuardAllows\([^)]*time/.test(cp), "");
  }

  if (negctl) {
    console.log("\n-- negctl：只守局次不守对象身份 / 只守对象身份不守局次，各漏一格 --");
    const sA = createInitialGameState("el_alamein");
    const sB = createInitialGameState("el_alamein");
    const st = stampRun(1, sA);
    // 只比 epoch：换了 GameState 但轮询还没推进 epoch ⇒ 漏
    const epochOnly = (stamp: typeof st, e: number) => stamp.epoch === e;
    const leak1 = epochOnly(st, 1) === true && !runGuardAllows(st, 1, sB);
    console.log(`  ${leak1 ? "RED(好)" : "GREEN(坏)"} negctl-R1 只比局次 ⇒ 换了 GameState 那一格漏（真规则拦住）`);
    // 只比对象身份：对象没换但 epoch 推进过（同一对象被复用）⇒ 漏
    const idOnly = (stamp: typeof st, cur: unknown) => stamp.state === cur;
    const leak2 = idOnly(st, sA) === true && !runGuardAllows(st, 2, sA);
    console.log(`  ${leak2 ? "RED(好)" : "GREEN(坏)"} negctl-R2 只比对象身份 ⇒ 局次推进那一格漏（真规则拦住）`);
    check("negctl 两道缺一不可（各自单用都漏一格）", leak1 && leak2, "");
  }
}

// ════════════════════════════════════════════════════════════
// 刀 子：不留第二个绕过主安全链的执行入口（审核 §七）
// ════════════════════════════════════════════════════════════
//
// `handleThreadApprove` 原本是 handleApprove 的一份**退化**复制品：没有权限闸；
// 无效 fromSquad 被删掉后让引擎自动选兵（"静默扩大范围"那一族）；不解析也不
// 复查 fromDispatch；下的是裸 order（无 origin/dispatchMeta ⇒ 台账一条不记）；
// 不写 context；没有局印复核。
// ★它**不是死代码**：`ENABLE_STAFF_ASK` / `ENABLE_STAFF_THREADS` 都是 true，
//   UNDER_ATTACK 这类事件在真实战斗里会触发 `/api/staff-ask`，按钮就会出现。
// 修法：委派给主链（主链本来就认 execCtx.threadId 并会 resolveThread）。

function knifeZi(negctl: boolean): void {
  console.log("\n== 刀 子：不留第二个执行入口 ==");

  const cp = readFileSync("apps/web/src/ChatPanel.tsx", "utf8");
  const gc = readFileSync("apps/web/src/GameCanvas.tsx", "utf8");
  const body = braceBody(cp, "const handleThreadApprove = (");

  // ── Z0 台架自证：这条路是**活的**（否则"必须收口"这个前提不成立）──
  {
    check("Z0 ★台架自证：staff-thread 链是活的（两个 flag 都是 true，按钮真会出现）★",
      /const ENABLE_STAFF_ASK = true/.test(gc) &&
      /const ENABLE_STAFF_THREADS = true/.test(gc) &&
      gc.includes("createThread(") &&
      cp.includes("onClick={() => handleThreadApprove(thread, opt, i)}"),
      "");
  }

  // ── Z1 ★副入口的执行能力必须为零★ ──
  {
    const banned = ["applyOrders(", "resolveIntent(", "buildExecReceipt(", "softFixTargetFields(", "isValidTarget("];
    const still = banned.filter((k) => body.includes(k));
    check("Z1 ★handleThreadApprove 里不再有任何执行动作（apply/resolve/回执/预检全没了）★",
      body.length > 0 && still.length === 0, `仍残留: ${still.join(", ")}`);
    check("Z1b 也不再自己删无效 fromSquad（「删掉后自动选兵」正是静默扩大范围）",
      !body.includes("intent.fromSquad = undefined"), "");
    check("Z1c 也不再自己 resolveThread（主链跑完按 execCtx.threadId 收尾）",
      !body.includes("resolveThread("), "");
  }

  // ── Z2 ★它确实委派给了主链，并且带齐了主链需要的东西★ ──
  {
    check("Z2 委派给 handleApprove，且 ctx 带 threadId（主链据此 resolveThread）",
      body.includes("handleApprove(opt, idx,") && body.includes("threadId: thread.id"), "");
    check("Z2b ctx 带局印（跨局的旧点击也拦得住）",
      body.includes("run: stampRun(gameEpochRef.current, state)"), "");
    check("Z2c ★mode 传 \"auto\"：主链的 `mode===\"manual\"` 只用于聊天卡片过期那道闸，"
      + "线程选项不来自 response，传 manual 会把所有线程批准误伤掉★",
      /handleApprove\(opt, idx, "auto"/.test(body) && !/handleApprove\(opt, idx, "manual"/.test(body),
      "");
    check("Z2d 执行锁与 open 判定留着（线程自己的新鲜度检查）",
      body.includes('thread.status !== "open"') && body.includes("tryLockThread(thread.id)") &&
      body.includes("unlockThread(thread.id)"), "");
  }

  // ── Z3 ★全仓只剩一个执行入口★ ──
  {
    const panelSrc = cp.split("\n").filter((l) => !l.trimStart().startsWith("//")).join("\n");
    check("Z3 ★ChatPanel 里 applyOrders 只有一处（主链）★",
      panelSrc.split("applyOrders(").length - 1 === 1,
      `applyOrders 出现 ${panelSrc.split("applyOrders(").length - 1} 次`);
    check("Z3b ★buildExecReceipt 只有一处★",
      panelSrc.split("buildExecReceipt(").length - 1 === 1, "");
    // 主链那一处必须盖 origin/dispatchMeta（台账的入口）
    check("Z3c 唯一那处 apply 仍盖 origin:\"advisor\" + dispatchMeta（台账记得上）",
      panelSrc.includes('origin: "advisor" as const, dispatchMeta: meta'), "");
  }

  // ── Z4 走主链就自动拿到整条安全链（逐项点名）──
  {
    const ha = braceBody(cp, "const handleApprove = (");
    const need: Array<[string, string]> = [
      ["局印复核", "runGuardAllows(execCtx?.run"],
      ["权限闸", "checkDispatchAuthority(state, speakingPersona, intent)"],
      ["fromDispatch 权限复查", "任务 ${d.id} 那批人不在"],
      ["指代歧义判定", "findDispatchAmbiguity(state, intent"],
      ["无效分队**明确拒绝**（不是删字段）", "找不到叫「${intent.fromSquad}」的分队"],
      ["目标校验", "isValidTarget(intent, state, COMMANDER_REFS)"],
      ["台账登记", 'origin: "advisor" as const, dispatchMeta: meta'],
      ["真实结果回执", "buildExecReceipt(applyRes, slices)"],
      ["结果进 context", 'text: line, time: state.time'],
    ];
    const missing = need.filter(([, k]) => !ha.includes(k)).map(([n]) => n);
    check("Z4 ★委派之后线程路自动获得整条安全链（九项逐项点名，缺一即红）★",
      missing.length === 0, `缺: ${missing.join(" / ")}`);
  }

  if (negctl) {
    console.log("\n-- negctl：把旧副入口那几样放回去，判据必须真红 --");
    const fakeBody = `
      const state = getState();
      if (!state) return;
      if (intent.fromSquad) { intent.fromSquad = undefined; }
      const result = resolveIntent(intent, state, state.style, reserved);
      applyOrders(state, allOrders);
      resolveThread(thread.id);
    `;
    const banned = ["applyOrders(", "resolveIntent(", "intent.fromSquad = undefined", "resolveThread("];
    const caught = banned.filter((k) => fakeBody.includes(k));
    console.log(`  ${caught.length === 4 ? "RED(好)" : "GREEN(坏)"} negctl-Z 旧副入口的四样特征全被 Z1 抓住（${caught.length}/4）`);
    check("negctl Z1 的黑名单确实抓得住旧写法（不是恒真）", caught.length === 4, "");
  }
}

// ── main ──

const knifeArg = (process.argv.find((a) => a.startsWith("--knife=")) ?? "--knife=all").split("=")[1];
const negctl = process.argv.includes("--negctl");

if (knifeArg === "a" || knifeArg === "all") knifeA(negctl);
if (knifeArg === "b" || knifeArg === "all") knifeB(negctl);
if (knifeArg === "c" || knifeArg === "all") knifeC(negctl);
if (knifeArg === "jia" || knifeArg === "all") knifeJia(negctl);
if (knifeArg === "yi" || knifeArg === "all") knifeYi(negctl);
if (knifeArg === "bing" || knifeArg === "all") knifeBing(negctl);
if (knifeArg === "wu" || knifeArg === "all") knifeWu(negctl);
if (knifeArg === "ji" || knifeArg === "all") knifeJi(negctl);
if (knifeArg === "geng" || knifeArg === "all") knifeGeng(negctl);
if (knifeArg === "gui" || knifeArg === "all") knifeGui(negctl);
if (knifeArg === "zi" || knifeArg === "all") knifeZi(negctl);

console.log(failCount === 0 ? `\nALL PASS (${checkCount} 条)` : `\n${failCount}/${checkCount} FAILURES`);
process.exit(failCount === 0 ? 0 : 1);
