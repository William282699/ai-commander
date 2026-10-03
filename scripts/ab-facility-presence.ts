// ============================================================
// AI Commander — facility-presence bench（place-presence V1：据点驻军数）
//
// 病例：2026-09-30 线上首局，中央前哨的 8 个全派往烽火台后，长官两次问"空了吗"，
// 陈两次答"有 4 坦 4 步，没空"。信封里没有"某据点此刻有几个我方兵"，陈拿 FRONTS
// 战线汇总 / DISPATCHES 出处去顶。真模型 19 臂对照：FACILITIES 补「在场我方=N单位」
// 0/20 → 20/20（档 _archive/central-post-empty-20261001/FINDINGS.md、REVIEW-FABLE.md）。
//
// 本台架钉的是引擎侧事实（真模型验收另跑，不进硬线）：
//   F  三把「X附近」尺（板子起名 / 外派出发据点 / 设施危机近旁）＝ shared 常量
//   C  计数口径：边界 12.0 算、12.01 不算；死亡不算；手动接管 / 亲兵 / 移动中 / 路过都算；敌军不算
//   E  同一把尺：19 设施 × 多个时刻，countPlayerUnitsNear ＝ director.facilityEscalationFacts().nearbyPlayerUnits
//   D  渲染：每个设施一行都带字段（敌方、中立也印、可为 0）；既有 token 逐字节前缀不变；节头图例
//   R  重放线上那局到 43 s：中央 0 / 北线 8 / 南线 9 / 前线油库 4（实验用的那份信封）
//   P  A′/A″ DISPATCHES 行 loc= / eta≈（逐人归组、一把 12 格尺）：离这批去处 12 格内＝「已到X」（与 FACILITIES
//      在场同圆心，已毁的去处也认）；在走的＝「向<终点所在地名>行进中」（终点取航点表最后一个）；停在别处的＝
//      「停在X附近」或「停在<地名><方位>」，只剩地图中心罗盘就整句省略。43 s 钉「loc=向烽火台行进中 eta≈60s」、
//      62 s「loc=4个已到烽火台+4个向烽火台行进中 eta≈43s」、110 s「已到烽火台」（2026-10-02 掉队兵修好后按新实况重推；
//      修前那辆停在半路的 #33 不复存在，「停在…」说法由合成段 P5b/P3b/P17 负责）（分组、eta 台架独立算；
//      P2x 自证已上线 A′ 在 62 s 说法不同）；P3–P17 合成；P16 一把尺不变式；
//      P0 台架参照实现（全开）与引擎逐例同，负对照逐项摘开关
//   B  回执短缺句：只认长官原话里逐字出现的数量引文；派得比它少才补「（不够您说的数）」；按引文算——一句引文只落在
//      一件事上才说（单条挂本句、几条挂合计行且须有新下令）；跨了几个去处或混了别的 ⇒ 不说（B7–B9）
//
// 用法（worktree 根；播种与生产序泵帧照档案复现脚本）：
//   node --import ./scripts/recorder-seed-random.mjs --import tsx scripts/ab-facility-presence.ts --synthetic
//   ... --negctl   负对照：把计数口径故意改坏（不算移动中 / 半径 15 / 漏印中立），对应断言必须真 FAIL
// ============================================================

process.env.ADVISOR_TRACE = "off";

import { readFileSync } from "node:fs";
import * as core from "@ai-commander/core";
import {
  countPlayerUnitsNear, PLACE_NEAR_RADIUS_TILES, generateDigestV1,
} from "@ai-commander/shared";
import type { GameState, Position } from "@ai-commander/shared";
import { FACILITY_GATE, facilityEscalationFacts } from "../packages/core/src/director";
import { NAME_RADIUS_TILES } from "../packages/core/src/frontEscalationPayload";
import { ORIGIN_FACILITY_RADIUS, findDispatch, liveDispatchMembers } from "../packages/core/src/dispatchLedger";
import { dispatchWhereabouts, nearestPlaceWithin, bearingNameFor, bearingPhrase, spatialGroups, locationPhraseFor } from "../packages/core/src/frontEscalationPayload";
import { estimateSquadTravelTime, estimateTravelTime, frontCenterPos } from "../packages/core/src/crisisResponse";
import { buildExecReceipt, verifiedAskedQuantity, SHORTFALL_CLAUSE } from "../apps/web/src/execReceipt";
// 静态导入（不许 await import）：动态导入会让台架与被测代码各载一份 core，编队号在一份里登记、在另一份里查不到
import { harness, serverRoutes, source, oldFunctions } from "./chainHarness";
import { buildDigestForChannel } from "../apps/web/src/digestHelper";

// ── harness ──

let failCount = 0;
const failed: string[] = [];
function check(name: string, ok: boolean, detail = ""): void {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok || !detail ? "" : ` — ${detail}`}`);
  if (!ok) { failCount++; failed.push(name); }
}
const info = (s: string) => console.log(`     · ${s}`);

type CountFn = (state: GameState, pos: Position, radius: number) => number;

/** 生产序泵帧（GameCanvas 的逐帧调用序；与档案复现脚本一致）。 */
function frame(s: GameState, dt: number): void {
  core.tick(s, dt); core.processEconomy(s, dt); core.processReportSignals(s, dt); core.updateBattleMarkers(s, dt);
  core.processAdvisorTriggers(s); core.checkDoctrines(s); core.updateGamePhase(s, dt); core.checkGameOver(s, dt);
  core.processMissions(s, dt); core.updateTasks(s); core.processEnemyAI(s, dt); core.processDefensiveAI(s, dt);
  core.processPressureDirector(s, dt); core.processAutoBehavior(s, dt); core.applyEndgamePressure(s, dt);
  core.updateFog(s);
}
function pumpTo(s: GameState, t: number): void { while (s.time + 1e-9 < t) frame(s, Math.min(0.05, t - s.time)); }

function freshState(scenario = "el_alamein"): GameState {
  const state = core.createInitialGameState(scenario) as GameState;
  core.resetEnemyAITimer(); core.resetEnemyProdToggle(); core.resetAttackWaveState(); core.resetAutoBehaviorTimer();
  core.resetWarPhaseTimers(); core.resetReportSignals(); core.resetEngagementCache(); core.resetDefensiveAITimer();
  core.resetPressureDirector(); core.resetEscalationTickets();
  core.updateFog(state);
  return state;
}

const FACILITY_SUFFIX = / 在场我方=(\d+)单位$/;
/** 引擎自己的移动门（sim.ts tick 第 1 步；与 frontEscalationPayload.isActuallyMoving 同义，台架照抄一份做独立期望值）。 */
const movingGate = (u: any) => u.state === "moving" || u.state === "retreating" || u.state === "patrolling" || (u.state === "defending" && u.target !== null);
const centroid = (ps: Position[]) => ({ x: ps.reduce((a, p) => a + p.x, 0) / ps.length, y: ps.reduce((a, p) => a + p.y, 0) / ps.length });
/** 台架独立算的「停在别处的一个人 / 一簇人」该叫什么：12 格内有地名 ⇒ 停在X附近，否则「停在」＋preflight 同款方位短语。 */
const stillName = (s: GameState, c: Position) => { const p = nearestPlaceWithin(s, c); return p !== null ? `停在${p}附近` : `停在${bearingPhrase(bearingNameFor(s, c))}`; };
const LEGEND = "---FACILITIES---"; // 节头不带图例（验收：图例让第三回合掉分，已去掉）

// ── F：同一把尺 ──

function F_oneRuler(): void {
  console.log("\n── F 三把「X附近」尺 ＝ shared 常量 ──");
  check("F1 PLACE_NEAR_RADIUS_TILES = 12", PLACE_NEAR_RADIUS_TILES === 12, `${PLACE_NEAR_RADIUS_TILES}`);
  check("F2 板子起名 NAME_RADIUS_TILES ＝ shared 常量", NAME_RADIUS_TILES === PLACE_NEAR_RADIUS_TILES, `${NAME_RADIUS_TILES}`);
  check("F3 外派出发据点 ORIGIN_FACILITY_RADIUS ＝ shared 常量", ORIGIN_FACILITY_RADIUS === PLACE_NEAR_RADIUS_TILES, `${ORIGIN_FACILITY_RADIUS}`);
  check("F4 设施危机近旁 FACILITY_GATE.NEAR_RADIUS ＝ shared 常量", FACILITY_GATE.NEAR_RADIUS === PLACE_NEAR_RADIUS_TILES, `${FACILITY_GATE.NEAR_RADIUS}`);
}

// ── C：计数口径（合成局面） ──

function C_countingRules(count: CountFn): void {
  console.log("\n── C 计数口径 ──");
  const s = freshState();
  const fac = s.facilities.get("ea_player_central_post")!;
  const P = fac.position;
  // 清场：把所有单位挪到远处，只留下我们手放的几个
  s.units.forEach((u) => { u.position = { x: 5, y: 5 }; });
  const pick = (type?: string, team = "player") => [...s.units.values()].find((u) => u.team === team && (!type || u.type === type) && u.position.x === 5 && u.position.y === 5)!;
  const r = PLACE_NEAR_RADIUS_TILES;
  const base = count(s, P, r);
  check("C0 清场后中央前哨附近 0", base === 0, `${base}`);

  const a = pick("infantry"); a.position = { x: P.x + r, y: P.y };
  check("C1 恰好 12.0 格算", count(s, P, r) === 1, `${count(s, P, r)}`);
  const b = pick("infantry"); b.position = { x: P.x + r + 0.01, y: P.y };
  check("C2 12.01 格不算", count(s, P, r) === 1, `${count(s, P, r)}`);
  b.position = { x: 5, y: 5 };

  const dead = pick("infantry"); dead.position = { x: P.x, y: P.y }; dead.hp = 0;
  check("C3 hp=0 不算", count(s, P, r) === 1, `${count(s, P, r)}`);
  dead.hp = dead.maxHp; dead.state = "dead";
  check("C4 state=dead 不算", count(s, P, r) === 1, `${count(s, P, r)}`);
  dead.state = "idle"; dead.position = { x: 5, y: 5 };

  const manual = pick("main_tank"); manual.position = { x: P.x - 3, y: P.y }; manual.manualOverride = true;
  check("C5 手动接管的算", count(s, P, r) === 2, `${count(s, P, r)}`);
  const guard = pick("elite_guard"); guard.position = { x: P.x, y: P.y + 2 };
  check("C6 亲兵算", count(s, P, r) === 3, `${count(s, P, r)}`);
  const mover = pick("infantry"); mover.position = { x: P.x + 4, y: P.y - 4 }; mover.state = "moving";
  mover.target = { x: P.x - 100, y: P.y };
  check("C7 移动中（路过）的算", count(s, P, r) === 4, `${count(s, P, r)}`);
  const enemy = pick(undefined, "enemy"); enemy.position = { x: P.x + 1, y: P.y + 1 };
  check("C8 敌军不算", count(s, P, r) === 4, `${count(s, P, r)}`);
}

// ── E：与 director 的近旁计数逐个相等 ──

const eAcc = { compared: 0, mismatches: [] as string[] };
function E_collect(count: CountFn, label: string, s: GameState): void {
  s.facilities.forEach((f) => {
    const ours = count(s, f.position, PLACE_NEAR_RADIUS_TILES);
    const dir = facilityEscalationFacts(s, f.id)?.nearbyPlayerUnits;
    eAcc.compared++;
    if (ours !== dir) eAcc.mismatches.push(`${label} ${f.id}: ours=${ours} director=${dir}`);
  });
}
function E_finalize(): void {
  console.log("\n── E 与 director.facilityEscalationFacts().nearbyPlayerUnits 同一把尺 ──");
  check(`E1 ${eAcc.compared} 个（设施×时刻）全等`, eAcc.compared >= 19 * 3 && eAcc.mismatches.length === 0, eAcc.mismatches.slice(0, 5).join("; "));
  eAcc.compared = 0; eAcc.mismatches = [];
}

// ── D：渲染 ──

function D_rendering(states: { label: string; s: GameState }[], mutate?: (digest: string) => string): void {
  for (const { label, s } of states) {
    let digest = generateDigestV1(s, [], [], []);
    if (mutate) digest = mutate(digest);
    const lines = digest.split("\n");
    const hi = lines.findIndex((l) => l.startsWith("---FACILITIES---"));
    check(`D1[${label}] 节头原样（无图例）`, hi >= 0 && lines[hi] === LEGEND, hi >= 0 ? lines[hi] : "no header");
    const body: string[] = [];
    for (let i = hi + 1; i < lines.length && lines[i] && !lines[i].startsWith("---"); i++) body.push(lines[i]);
    const facs = [...s.facilities.values()];
    check(`D2[${label}] 每个设施一行（${facs.length}）`, body.length === facs.length, `${body.length} lines`);
    let prefixBad: string[] = [], countBad: string[] = [], teams = new Set<string>(), zeroSeen = false;
    for (const f of facs) {
      const legacy = `${f.id}:${f.type} "${f.name}" team=${f.team} hp=${f.hp}/${f.maxHp} @(${f.position.x},${f.position.y})`;
      const line = body.find((l) => l.startsWith(`${f.id}:`));
      if (!line || !line.startsWith(legacy) || !FACILITY_SUFFIX.test(line.slice(legacy.length))) { prefixBad.push(f.id); continue; }
      const n = Number(line.match(FACILITY_SUFFIX)![1]);
      if (n !== countPlayerUnitsNear(s, f.position, PLACE_NEAR_RADIUS_TILES)) countBad.push(`${f.id}=${n}`);
      teams.add(f.team); if (n === 0) zeroSeen = true;
    }
    check(`D3[${label}] 既有 token 逐字节前缀不变＋行尾字段`, prefixBad.length === 0, prefixBad.join(","));
    check(`D4[${label}] 字段数字 ＝ 计数函数`, countBad.length === 0, countBad.join(","));
    check(`D5[${label}] 敌方/中立/我方三种设施都印`, teams.has("enemy") && teams.has("neutral") && teams.has("player"), [...teams].join(","));
    check(`D6[${label}] 0 也照印`, zeroSeen);
    // 归一化：去掉字段与图例后，节内容 ＝ 旧格式（逐字节）
    const normalized = body.map((l) => l.replace(FACILITY_SUFFIX, "")).join("\n");
    const legacyBody = facs.map((f) => `${f.id}:${f.type} "${f.name}" team=${f.team} hp=${f.hp}/${f.maxHp} @(${f.position.x},${f.position.y})`).join("\n");
    check(`D7[${label}] 归一化后与旧格式零差异`, normalized === legacyBody);
  }
}

// ── P：A′/A″ 现址规则（合成局面） ──
//
// 期望值由台架按定义独立算：「X附近」＝离这人被送去的地方 12 格内（to= 是设施时圆心就是那个设施，
// 与 FACILITIES 在场同一个圆心）；「向X行进中」＝在走、X 取被送去的地方（当下终点在那儿时）；
// 「停在…」＝没在走、也没到。每例另核一条不变式（rulerAgrees）：到了那组的人数 ＝ 成员里离那个圆心
// 12 格内的人数，各组人数相加 ＝ 成员数。

type DispatchLike = { targetName: string; destPosById?: Record<number, Position> };
type WhereFn = (state: GameState, members: any[], d?: DispatchLike) => { loc: string | null; etaSec: number | null };
/** 把 loc 拆回 [人数, 说法]；只有一组时不带人数 ⇒ 人数＝成员数。 */
function parseLoc(loc: string, n: number): [number, string][] {
  const parts = loc.split("+");
  if (parts.length === 1) return [[n, loc]];
  return parts.map((p) => { const m = p.match(/^(\d+)个(.+)$/); return m ? [Number(m[1]), m[2]] as [number, string] : [NaN, p]; });
}
const ruler: { label: string; ok: boolean; detail: string }[] = [];
/** 到了那组（「已到<arrName>」）人数 ＝ 离 center 12 格内的成员数；各组相加 ＝ 成员数。 */
function rulerAgrees(label: string, members: any[], arrName: string, center: Position, w: { loc: string | null }): void {
  if (w.loc === null) return;
  const parts = parseLoc(w.loc, members.length);
  const near = members.filter((u) => Math.hypot(u.position.x - center.x, u.position.y - center.y) <= PLACE_NEAR_RADIUS_TILES).length;
  const said = parts.filter(([, p]) => p === `已到${arrName}`).reduce((a, [k]) => a + k, 0);
  const sum = parts.reduce((a, [k]) => a + k, 0);
  ruler.push({ label, ok: said === near && sum === members.length, detail: `${w.loc} ｜ ${arrName} 12 格内 ${near}、说成「已到${arrName}」${said}、合计 ${sum}/${members.length}` });
}

function P_whereaboutsRules(where: WhereFn): void {
  console.log("\n── P A′/A″ loc= / eta≈ 规则 ──");
  ruler.length = 0;
  const s = freshState();
  const inf = [...s.units.values()].filter((u) => u.team === "player" && u.type === "infantry").slice(0, 4);
  const three = inf.slice(0, 3);
  const OBS = s.facilities.get("ea_observation_post")!.position;     // 烽火台 (250,100)
  const REP = s.facilities.get("ea_repair_station")!.position;       // 野战修理厂 (400,90)
  const RIDGE = s.facilities.get("ea_miteirya_ridge")!.position;     // 驼峰山脊 (230,70)，2. 山脊战线中心离它 10 格
  const CPOST = s.facilities.get("ea_player_central_post")!.position; // 中央前哨 (360,105)
  const set = (u: any, pos: Position, state: string, target: Position | null, waypoints: Position[] = []) => {
    u.position = { ...pos }; u.state = state; u.target = target ? { ...target } : null; u.waypoints = waypoints.map((p) => ({ ...p }));
  };
  /** 一份台账样的记录：to= 名字＋每人被送去的点（默认全员同一点）。 */
  const disp = (name: string, ms: any[], at: Position | ((u: any) => Position)): DispatchLike =>
    ({ targetName: name, destPosById: Object.fromEntries(ms.map((u) => [u.id, typeof at === "function" ? at(u) : { ...at }])) });
  const W = (label: string, ms: any[], d: DispatchLike, arrName: string, center: Position) => { const w = where(s, ms, d); rulerAgrees(label, ms, arrName, center, w); return w; };
  const etaOfGoals = (ms: any[], goals: Position[]) => Math.ceil(estimateSquadTravelTime(s, ms.map((u) => u.id), centroid(goals)));
  // 两个"12 格内没地名"的点：一个有方位原点（36 格内有地名），一个只剩地图中心罗盘
  let withOrigin: Position | null = null, compassOnly: Position | null = null;
  for (let y = 0; y < s.mapHeight && !(withOrigin && compassOnly); y += 3) for (let x = 0; x < s.mapWidth && !(withOrigin && compassOnly); x += 3) {
    if (nearestPlaceWithin(s, { x, y }) !== null) continue;
    const b = bearingNameFor(s, { x, y });
    if (b.origin !== null && !withOrigin) withOrigin = { x, y };
    if (b.origin === null && !compassOnly) compassOnly = { x, y };
  }
  const toObs = disp("烽火台", inf, OBS);
  let w;

  // P3 全员停在修理厂旁、被派去的是烽火台 ⇒「停在野战修理厂附近」；P3′ 被派去的就是修理厂 ⇒「已到野战修理厂」（到了）
  three.forEach((u, i) => set(u, { x: REP.x + i, y: REP.y }, "idle", null));
  w = W("P3", three, toObs, "烽火台", OBS);
  check("P3 全员停在别处的据点旁 → loc=停在野战修理厂附近、无 eta", w.loc === "停在野战修理厂附近" && w.etaSec === null, JSON.stringify(w));
  w = W("P3′", three, disp("野战修理厂", three, REP), "野战修理厂", REP);
  check("P3′ 全员停在被派去的地方 12 格内 → loc=已到野战修理厂（到了）、无 eta", w.loc === "已到野战修理厂" && w.etaSec === null, JSON.stringify(w));
  // P4 全员在途 → 「向烽火台行进中」＋ eta
  three.forEach((u, i) => set(u, { x: 330 + i, y: 100 }, "moving", { x: OBS.x + i, y: OBS.y }));
  w = W("P4", three, toObs, "烽火台", OBS);
  check("P4 全员在途 → loc=向烽火台行进中、eta 为正整数", w.loc === "向烽火台行进中" && Number.isInteger(w.etaSec) && (w.etaSec ?? 0) > 0, JSON.stringify(w));
  // P5 一个停在修理厂、两个在途（离烽火台 15 格）；eta 只算在途两个
  set(three[0], REP, "idle", null);
  three.slice(1).forEach((u, i) => set(u, { x: OBS.x + 15 + i, y: OBS.y }, "moving", { x: OBS.x + i, y: OBS.y }));
  const etaMoving = etaOfGoals(three.slice(1), three.slice(1).map((u) => u.target!));
  const etaAll = etaOfGoals(three, three.slice(1).map((u) => u.target!));
  w = W("P5", three, toObs, "烽火台", OBS);
  check("P5 动静混合 → loc=1个停在野战修理厂附近+2个向烽火台行进中、eta＝只算在途两个",
    etaAll > etaMoving && w.loc === "1个停在野战修理厂附近+2个向烽火台行进中" && w.etaSec === etaMoving, JSON.stringify({ ...w, etaMoving, etaAll }));
  // P5b 停着的那个 12 格内没地名、36 格内有 ⇒「停在<地名><方位>」
  set(three[0], withOrigin!, "idle", null);
  const bearingThere = `停在${bearingPhrase(bearingNameFor(s, withOrigin!))}`;
  w = W("P5b", three, toObs, "烽火台", OBS);
  check(`P5b 停着的那个 12 格内没地名 → 「停在」＋preflight 同款方位短语「${bearingThere}」`,
    withOrigin !== null && bearingNameFor(s, withOrigin!).origin !== null && w.loc === `1个${bearingThere}+2个向烽火台行进中` && w.etaSec === etaMoving, JSON.stringify({ ...w, withOrigin }));
  // P13 停着的那个连方位原点都没有（只剩地图中心罗盘）⇒ 整句省略（「中央方向」会和中央前哨/中央战线撞名）
  set(three[0], compassOnly!, "idle", null);
  w = W("P13", three, toObs, "烽火台", OBS);
  check("P13 停着的只能说地图中心罗盘方位 → 整句省略", compassOnly !== null && w.loc === null && w.etaSec === null, JSON.stringify({ ...w, compassOnly }));
  // P5c 在途那部分有人没目标 → 整句省略
  set(three[0], REP, "idle", null); three[2].target = null; three[2].waypoints = [];
  w = W("P5c", three, disp("", three, OBS), "烽火台", OBS);
  check("P5c 在途的有人没目标、台账也没记点 → 省略", w.loc === null && w.etaSec === null, JSON.stringify(w));
  // P6 全员在动但有人没目标（台账也没记点）→ 省略
  three.forEach((u, i) => set(u, { x: OBS.x + 15 + i, y: OBS.y }, "moving", { x: OBS.x + i, y: OBS.y }));
  three[0].target = null;
  w = W("P6", three, { targetName: "" }, "烽火台", OBS);
  check("P6 有人没目标 → 省略", w.loc === null && w.etaSec === null, JSON.stringify(w));
  // P7 eta 只随「向」短语
  three.forEach((u, i) => set(u, { x: REP.x + i, y: REP.y }, "idle", null));
  check("P7 eta 只随「向X行进中」出现", where(s, three, toObs).etaSec === null);
  // P8 停着的人散在两处：两个在烽火台、一个在修理厂
  set(three[0], REP, "idle", null); set(three[1], OBS, "idle", null); set(three[2], { x: OBS.x + 1, y: OBS.y }, "idle", null);
  w = W("P8", three, toObs, "烽火台", OBS);
  check("P8 停着的散在两处 → loc=2个已到烽火台+1个停在野战修理厂附近、无 eta", w.loc === "2个已到烽火台+1个停在野战修理厂附近" && w.etaSec === null, JSON.stringify(w));
  // P9 在途的去两个地方（一个半路去追别处）→ 各写各的，eta 不给
  set(three[1], { x: OBS.x + 15, y: OBS.y }, "moving", OBS); set(three[2], { x: REP.x + 15, y: REP.y }, "moving", REP);
  w = W("P9", three, toObs, "烽火台", OBS);
  check("P9 在途的去两处 → 各写一组、eta 省略",
    w.loc === `1个停在野战修理厂附近+${["向烽火台行进中", "向野战修理厂行进中"].sort().map((x) => `1个${x}`).join("+")}` && w.etaSec === null, JSON.stringify(w));
  // P3b 全员停在 12 格内无地名处（有方位原点）→ 单组「停在<方位>」
  three.forEach((u, i) => set(u, { x: withOrigin!.x + i, y: withOrigin!.y }, "idle", null));
  const bearingAll = `停在${bearingPhrase(bearingNameFor(s, centroid(three.map((u) => u.position))))}`;
  w = W("P3b", three, toObs, "烽火台", OBS);
  check(`P3b 全员停在没地名的地方 → loc=${bearingAll}、无 eta`, w.loc === bearingAll && w.etaSec === null, JSON.stringify(w));
  // P10 一把尺：被派去的地方旁边另有更近的地名（驼峰山脊 6 格处离 2. 山脊战线中心更近）——在途已进 12 格的照样算到了
  const nearRidge = { x: RIDGE.x + 6, y: RIDGE.y };
  set(three[0], RIDGE, "idle", null);
  set(three[1], nearRidge, "moving", RIDGE);
  set(three[2], { x: RIDGE.x + 25, y: RIDGE.y }, "moving", { x: RIDGE.x + 1, y: RIDGE.y });
  const etaFar = etaOfGoals([three[2]], [three[2].target!]);
  w = W("P10", three, disp("驼峰山脊", three, RIDGE), "驼峰山脊", RIDGE);
  check("P10 在途已进去处 12 格内（哪怕旁边另有更近的地名）→ 记「已到驼峰山脊」；eta 只算 12 格外那个",
    nearestPlaceWithin(s, nearRidge) !== "驼峰山脊" && w.loc === "2个已到驼峰山脊+1个向驼峰山脊行进中" && w.etaSec === etaFar, JSON.stringify({ ...w, etaFar, nearestAtNearRidge: nearestPlaceWithin(s, nearRidge) }));
  // P11 路过别的地名不算到：在修理厂旁边走、去烽火台
  three.forEach((u, i) => set(u, { x: REP.x + i, y: REP.y + 1 }, "moving", { x: OBS.x + i, y: OBS.y }));
  w = W("P11", three, toObs, "烽火台", OBS);
  check("P11 路过别的地名（修理厂旁、去烽火台）→ 向烽火台行进中", w.loc === "向烽火台行进中" && (w.etaSec ?? 0) > 0, JSON.stringify(w));
  // P12 去处已被打掉（hp=0；FACILITIES 照印它、在场照算）——停在废墟上的照样是「沙漠弹药库附近」
  const DEPOT_F = s.facilities.get("ea_ammo_depot")!; const DEPOT = DEPOT_F.position; const hp0 = DEPOT_F.hp; DEPOT_F.hp = 0;
  three.forEach((u, i) => set(u, { x: DEPOT.x + i, y: DEPOT.y + 1 }, "idle", null));
  const toDepot = disp("沙漠弹药库", three, DEPOT);
  w = W("P12", three, toDepot, "沙漠弹药库", DEPOT);
  check("P12 去处已毁、人停在上面 → loc=已到沙漠弹药库（与 FACILITIES 在场同圆心）", w.loc === "已到沙漠弹药库" && w.etaSec === null, JSON.stringify(w));
  // P21 去处已毁、还有人在往那走 ⇒ 在途的也用它的名字，不因为废墟不算地名就整句省略
  set(three[2], { x: DEPOT.x + 30, y: DEPOT.y }, "moving", DEPOT);
  w = W("P21", three, toDepot, "沙漠弹药库", DEPOT);
  check("P21 去处已毁、有人还在路上 → 2个已到沙漠弹药库+1个向沙漠弹药库行进中＋eta", w.loc === "2个已到沙漠弹药库+1个向沙漠弹药库行进中" && (w.etaSec ?? 0) > 0, JSON.stringify(w));
  DEPOT_F.hp = hp0;
  // P14 带路线的单：下一个航点在前线油库旁，终点是烽火台 ⇒ 说终点；eta 按航点逐段累加（比直线长）
  const FUEL = s.facilities.get("ea_fuel_depot")!.position;
  three.forEach((u, i) => { const wps = [{ x: FUEL.x, y: FUEL.y - 25 }, { x: OBS.x + i, y: OBS.y }]; set(u, { x: FUEL.x + 30 + i, y: FUEL.y }, "moving", wps[0], wps); });
  const legs = Math.ceil(Math.max(...three.map((u) => { let t = 0, f = u.position; for (const wp of u.waypoints) { t += estimateTravelTime(u, f, wp, s); f = wp; } return t; })));
  const straight = etaOfGoals(three, three.map((u) => u.waypoints[u.waypoints.length - 1]));
  w = W("P14", three, toObs, "烽火台", OBS);
  check("P14 走路线的：下一个航点在前线油库、终点烽火台 → 向烽火台行进中、eta 按航点逐段累加（与直线估计不同）",
    legs !== straight && w.loc === "向烽火台行进中" && w.etaSec === legs, JSON.stringify({ ...w, legs, straight }));
  // P15 一条拉长的停住纵队（交火停下）：烽火台以东 2/8/14/20 格——只有 12 格内的两个算到了
  inf.forEach((u, i) => set(u, { x: OBS.x + [2, 8, 14, 20][i], y: OBS.y }, "attacking", null));
  w = W("P15", inf, toObs, "烽火台", OBS);
  check("P15 拉长的停住纵队 → 只有 12 格内的 2 个算「已到烽火台」", w.loc !== null && w.loc.startsWith("2个已到烽火台+") && w.etaSec === null, JSON.stringify(w));
  // P17 停在别处的两个人相隔 10 格（成一簇）：一个在修理厂 12 格内、一个在外——逐人认地名，不拿那一簇的质心起一个名
  const a = three[0], b = three[1];
  set(a, { x: REP.x - 6, y: REP.y }, "idle", null); set(b, { x: REP.x - 16, y: REP.y }, "idle", null);
  const na = stillName(s, a.position), nb = stillName(s, b.position), nc = stillName(s, centroid([a.position, b.position]));
  w = W("P17", [a, b], toObs, "烽火台", OBS);
  check(`P17 停在别处的一簇里一人在修理厂 12 格内、一人在外 → 各说各的（「${na}」／「${nb}」），不说成一簇「${nc}」`,
    na !== nb && nc === na && w.loc === [`1个${na}`, `1个${nb}`].sort().join("+"), JSON.stringify(w));
  // P18 派去一条战线（to=3. 中央战线），引擎真送去的是中央前哨（几何中心 (273,102) 离它 87 格）：
  //   到了中央前哨的算「中央前哨附近」（与 FACILITIES 中央前哨在场同圆心），路过战线中心的不算到
  const FC = frontCenterPos(s, s.fronts.find((f) => f.id === "front_center")!)!;
  set(three[0], { x: CPOST.x + 2, y: CPOST.y }, "defending", null);
  set(three[1], { x: CPOST.x - 5, y: CPOST.y + 3 }, "defending", { x: CPOST.x - 1, y: CPOST.y });
  set(three[2], { x: FC.x, y: FC.y }, "defending", { x: CPOST.x + 1, y: CPOST.y });
  w = W("P18", three, disp("3. 中央战线", three, CPOST), "中央前哨", CPOST);
  check("P18 派去战线、真落点是中央前哨 → 2个已到中央前哨+1个向中央前哨行进中（路过战线中心的不算到）",
    w.loc === "2个已到中央前哨+1个向中央前哨行进中" && (w.etaSec ?? 0) > 0, JSON.stringify(w));
  // P19 叫回出发地（to=「出发地（南线前哨附近）」，每人被送去的是自己的出发位置）：到了的算「南线前哨附近」
  const SPOST = s.facilities.get("ea_player_south_post")!.position;
  const origins = new Map(three.map((u, i) => [u.id, { x: SPOST.x - 3 + 3 * i, y: SPOST.y + 2 }]));
  set(three[0], origins.get(three[0].id)!, "defending", null);
  set(three[1], origins.get(three[1].id)!, "defending", null);
  set(three[2], { x: SPOST.x - 40, y: SPOST.y }, "retreating", origins.get(three[2].id)!);
  w = W("P19", three, disp("出发地（南线前哨附近）", three, (u) => origins.get(u.id)!), "南线前哨", SPOST);
  check("P19 叫回出发地 → 2个已到南线前哨+1个向南线前哨行进中", w.loc === "2个已到南线前哨+1个向南线前哨行进中" && (w.etaSec ?? 0) > 0, JSON.stringify(w));
  // P20 烽火台 8 格处有一面玩家标记「集结点」（取地名时标记优先）——派去烽火台的到了照样算「烽火台附近」，不被标记顶掉
  const tags0 = s.tags; (s as any).tags = [...(s.tags ?? []), { id: "tag_bench", name: "集结点", position: { x: OBS.x - 8, y: OBS.y } }];
  three.forEach((u, i) => set(u, { x: OBS.x + i, y: OBS.y }, "idle", null));
  w = W("P20", three, toObs, "烽火台", OBS);
  check("P20 去处旁边插了标记 → 到了的仍是「已到烽火台」", nearestPlaceWithin(s, OBS) === "集结点" && w.loc === "已到烽火台", JSON.stringify(w));
  (s as any).tags = tags0;
  // P22 去处是一面名叫「向阳坡」的标记：到了那组不许被当成在途（eta 不挂在它上面），在途那组的 eta 不丢
  const HILL = { x: OBS.x, y: OBS.y + 40 };
  (s as any).tags = [...(tags0 ?? []), { id: "tag_bench2", name: "向阳坡", position: HILL }];
  set(three[0], HILL, "idle", null); set(three[1], { x: HILL.x + 1, y: HILL.y }, "idle", null);
  set(three[2], { x: HILL.x + 30, y: HILL.y }, "moving", HILL);
  const etaHill = etaOfGoals([three[2]], [HILL]);
  w = W("P22", three, disp("向阳坡", three, HILL), "向阳坡", HILL);
  check("P22 去处名字以「向」开头 → 2个已到向阳坡+1个向向阳坡行进中、eta 只算在途那个", w.loc === "2个已到向阳坡+1个向向阳坡行进中" && w.etaSec === etaHill, JSON.stringify({ ...w, etaHill }));
  (s as any).tags = tags0;
  // P23 被派去的点附近没有任何地名（区域中心 / 撤退点 / 坐标）：到了的用 to= 当名字，在途的也照叫——不说成「停在<别处><方位>」
  const AREA = withOrigin!;
  set(three[0], AREA, "defending", null); set(three[1], { x: AREA.x + 2, y: AREA.y }, "defending", null);
  set(three[2], { x: AREA.x + 30, y: AREA.y }, "defending", AREA);
  const etaArea = etaOfGoals([three[2]], [AREA]);
  w = W("P23", three, disp("魔鬼花园雷区", three, AREA), "魔鬼花园雷区", AREA);
  check("P23 去处附近没地名 → 2个已到魔鬼花园雷区+1个向魔鬼花园雷区行进中、eta 只算在途那个",
    nearestPlaceWithin(s, AREA) === null && w.loc === "2个已到魔鬼花园雷区+1个向魔鬼花园雷区行进中" && w.etaSec === etaArea, JSON.stringify({ ...w, etaArea }));
  // 一把尺不变式：上面每一例（有 loc 的）到了那组人数 ＝ 离被派去的地方 12 格内的人数
  const bad = ruler.filter((r) => !r.ok);
  check(`P16 一把尺：${ruler.length} 例里「已到<被派去的地方>」人数＝它 12 格内人数、各组相加＝成员数`, ruler.length >= 18 && bad.length === 0, bad.map((r) => `${r.label}: ${r.detail}`).join(" ‖ "));
}

/** 台架侧参照实现（只给负对照用）：与引擎同一套定义，开关逐项摘掉一条，看对应断言会不会真红。 */
type RefOpts = { recordedDest: boolean; facilityFirst: boolean; arriveByDistance: boolean; finalGoal: boolean; routeLegs: boolean;
  stopMarker: boolean; perUnitStopped: boolean; omitCompass: boolean; kindByStructure: boolean; toNameFallback: boolean };
const REF_ALL: RefOpts = { recordedDest: true, facilityFirst: true, arriveByDistance: true, finalGoal: true, routeLegs: true,
  stopMarker: true, perUnitStopped: true, omitCompass: true, kindByStructure: true, toNameFallback: true };
function refWhere(off: Partial<RefOpts>): WhereFn {
  const o = { ...REF_ALL, ...off };
  return (st, ms, d) => {
    const none = { loc: null, etaSec: null };
    const R = PLACE_NEAR_RADIUS_TILES;
    const dist2 = (p: Position, q: Position) => Math.hypot(p.x - q.x, p.y - q.y);
    let fac: { name: string; position: Position } | null = null;
    if (d?.targetName) st.facilities.forEach((f) => { if (!fac && f.name === d.targetName) fac = { name: f.name, position: { ...f.position } }; });
    const facN = fac as { name: string; position: Position } | null;
    const goal = (u: any): Position | null => (o.finalGoal && u.waypoints.length > 0 ? u.waypoints[u.waypoints.length - 1] : u.target);
    const placeAt = (p: Position): { name: string; position: Position } | null => {
      const name = nearestPlaceWithin(st, p); if (name === null) return null;
      for (const t of (st as any).tags ?? []) if (t.name === name) return { name, position: t.position };
      let hit: any = null; st.facilities.forEach((f) => { if (!hit && f.name === name) hit = { name, position: f.position }; });
      if (hit) return hit;
      const fr = st.fronts.find((f) => f.name === name); const c = fr ? frontCenterPos(st, fr) : null;
      return c ? { name, position: c } : null;
    };
    const sentPlace = (u: any): { name: string; position: Position } | null => {
      if (!o.recordedDest) {   // 上一版：按 to= 的名字找（标记 / 设施 / 战线中心）
        if (!d?.targetName) return null;
        for (const t of (st as any).tags ?? []) if (t.name === d.targetName) return { name: t.name, position: t.position };
        if (facN) return facN;
        const fr = st.fronts.find((f) => f.name === d.targetName); const c = fr ? frontCenterPos(st, fr) : null;
        return c ? { name: d.targetName, position: c } : null;
      }
      const dest = d?.destPosById?.[u.id] ?? (movingGate(u) ? goal(u) : null);
      if (!dest) return null;
      if (o.facilityFirst && facN && dist2(dest, facN.position) <= R) return facN;
      const at = placeAt(dest);
      if (at) return at;
      const rec = d?.destPosById?.[u.id];
      return o.toNameFallback && rec && d?.targetName && d.targetName !== "未指明" ? { name: d.targetName, position: rec } : null;
    };
    type K = "arrived" | "stopped" | "enRoute";
    const parts = new Map<string, { k: K; us: any[] }>();
    const add = (p: string, k: K, us: any[]) => { const x = parts.get(p); if (x) x.us.push(...us); else parts.set(p, { k, us: [...us] }); };
    const strays: any[] = [];
    for (const u of ms) {
      const sp = sentPlace(u);
      if (o.arriveByDistance && sp && dist2(u.position, sp.position) <= R) { add(`已到${sp.name}`, "arrived", [u]); continue; }
      if (movingGate(u)) {
        const g = goal(u); if (!g) return none;
        if (!o.arriveByDistance) { const here = nearestPlaceWithin(st, u.position), there = nearestPlaceWithin(st, g); if (there && here === there) { add(`已到${there}`, "arrived", [u]); continue; } }
        const name = sp && dist2(g, sp.position) <= R ? sp.name : nearestPlaceWithin(st, g);
        if (name === null) return none;
        add(`向${name}行进中`, "enRoute", [u]); continue;
      }
      if (!o.perUnitStopped) { strays.push(u); continue; }
      const here = nearestPlaceWithin(st, u.position);
      if (here !== null) add(`停在${here}附近`, "stopped", [u]); else strays.push(u);
    }
    for (const g of spatialGroups(strays)) {
      const c = centroid(g.map((u) => u.position)); const p = nearestPlaceWithin(st, c);
      if (p !== null) { add(`${o.stopMarker ? "停在" : ""}${p}附近`, "stopped", g); continue; }
      const b = bearingNameFor(st, c);
      if (o.omitCompass && b.origin === null) return none;
      add(`${o.stopMarker ? "停在" : ""}${bearingPhrase(b)}`, "stopped", g);
    }
    const kindOf = (p: string, x: { k: K }): K => (o.kindByStructure ? x.k : p.startsWith("向") ? "enRoute" : x.k === "enRoute" ? "stopped" : x.k);
    const rk: Record<K, number> = { arrived: 0, stopped: 1, enRoute: 2 };
    const ord = Array.from(parts.entries()).sort(([a, xa], [b, xb]) => rk[kindOf(a, xa)] - rk[kindOf(b, xb)] || xb.us.length - xa.us.length || (a < b ? -1 : a > b ? 1 : 0));
    const loc = ord.length === 1 ? ord[0][0] : ord.map(([p, x]) => `${x.us.length}个${p}`).join("+");
    const en = ord.filter(([p, x]) => kindOf(p, x) === "enRoute");
    let eta: number | null = null;
    if (en.length === 1) {
      const us = en[0][1].us; const gs = us.map(goal);
      if (gs.every(Boolean)) {
        const anchor = centroid(gs as Position[]);
        let worst = 0;
        for (const u of us) {
          let t: number;
          if (o.routeLegs && u.waypoints.length > 1) { t = 0; let f = u.position; for (const wp of u.waypoints) { t += estimateTravelTime(u, f, wp, st); f = wp; } }
          else t = estimateTravelTime(u, u.position, anchor, st);
          if (t > worst) worst = t;
        }
        eta = Number.isFinite(worst) && worst > 0 ? Math.ceil(worst) : null;
      }
    }
    return { loc, etaSec: eta };
  };
}

// ── Q：端到端——真的下令（applyOrders → 台账记下被送去的点）→ 泵帧 → 真信封那一行 ──
//   派去一条战线（引擎真落点＝线上据点）与「叫回出发地」两条常见路，逐秒核：到了那组人数 ＝ 离落点据点 12 格内的人数，
//   在途的叫同一个名字，从不出现「停在<落点据点>附近」（到了的不许被说成停在别处）。

function Q_endToEnd(): void {
  console.log("\n── Q 端到端：派去战线 / 叫回出发地 ──");
  const s = freshState();
  const SPOST = s.facilities.get("ea_player_south_post")!.position;
  const CPOST = s.facilities.get("ea_player_central_post")!.position;
  const near = (p: Position, q: Position) => Math.hypot(p.x - q.x, p.y - q.y) <= PLACE_NEAR_RADIUS_TILES;
  // 南线前哨旁 4 个步兵（不在中央前哨 12 格内），派去「3. 中央战线」，落点＝中央前哨
  const ids = [...s.units.values()].filter((u) => u.team === "player" && u.type === "infantry" && near(u.position, SPOST) && !near(u.position, CPOST)).slice(0, 4).map((u) => u.id);
  const orders: any[] = ids.map((id, i) => ({ unitIds: [id], action: "defend", target: { x: CPOST.x - 1 + (i % 2), y: CPOST.y - 1 + Math.floor(i / 2) }, priority: "medium", origin: "advisor",
    dispatchMeta: { group: "q1", sourceKind: "front", sourceKey: "front_south", action: "defend", targetName: "3. 中央战线" } }));
  const res = core.applyOrders(s, orders);
  const d = s.dispatches[s.dispatches.length - 1];
  const rowOf = () => core.buildDigest(s, [], [], []).split("\n").find((l) => l.startsWith(`${d.id} `)) ?? "";
  let frames = 0, bad: string[] = [], sawArrive = false, sawEnRoute = false, oldDiffers = 0, allInFor = 0;
  const oldRule = refWhere({ recordedDest: false });
  const end1 = s.time + 200;
  for (let t = s.time + 2; t < end1; t += 2) {
    pumpTo(s, t);
    const ms = liveDispatchMembers(s, d);
    const line = rowOf(); const m = line.match(/ loc=(\S+)/); if (!m) continue;
    frames++;
    const parts = parseLoc(m[1], ms.length);
    const said = parts.filter(([, p]) => p === "已到中央前哨").reduce((a, [k]) => a + k, 0);
    const inRing = ms.filter((u) => near(u.position, CPOST)).length;
    if (said > 0) sawArrive = true; if (parts.some(([, p]) => p === "向中央前哨行进中")) sawEnRoute = true;
    if (said !== inRing || parts.some(([, p]) => p === "停在中央前哨附近" || p === "已到3. 中央战线")) bad.push(`t${Math.round(s.time)} ${m[1]} 环内${inRing}`);
    if (oldRule(s, ms, d).loc !== m[1]) oldDiffers++;
    allInFor = ms.length > 0 && inRing === ms.length ? allInFor + 1 : 0;
    if (allInFor >= 3) break; // 全到了、站稳 6 秒就叫回（再待下去会被敌军下一波打光，Q2 就没人可叫）
  }
  check(`Q1 派去「3. 中央战线」（落点中央前哨）：${frames} 帧里「已到中央前哨」人数＝中央前哨 12 格内人数，从不说「停在中央前哨附近」`,
    res.appliedUnitIds.length === 4 && !!d.destPosById && frames >= 8 && allInFor >= 3 && sawArrive && sawEnRoute && bad.length === 0, bad.slice(0, 4).join(" ‖ ") || `frames=${frames} arrive=${sawArrive} enRoute=${sawEnRoute}`);
  check(`Q1x 绊索自证：上一版（按 to= 名字找圆心）在同样这些帧里说法不同（${oldDiffers}/${frames} 帧）——Q1 分得出新旧`, oldDiffers > 0);
  // 叫回：每人回自己的出发位置（南线前哨旁），to=「出发地（南线前哨附近）」
  const back: any[] = ids.map((id) => ({ unitIds: [id], action: "retreat", target: { ...d.originPosById![id] }, priority: "medium", origin: "advisor",
    dispatchMeta: { group: "q2", sourceKind: "dispatch", sourceKey: d.id, action: "retreat", targetName: "出发地（南线前哨附近）", returnTo: "origin" } }));
  const resBack = core.applyOrders(s, back);
  const d2 = s.dispatches[s.dispatches.length - 1];
  info(`Q2 叫回：接令 ${resBack.appliedUnitIds.length}/${ids.length}（已在办 ${resBack.alreadyDoingUnitIds.length}、被拒 ${resBack.perOrder.reduce((a: number, p: any) => a + p.rejected.length, 0)}）；台账末条 ${d2.id} ${d2.status} to=${d2.targetName}；活成员 ${ids.filter((id) => (s.units.get(id)?.hp ?? 0) > 0).length}`);
  const rowOf2 = () => core.buildDigest(s, [], [], []).split("\n").find((l) => l.startsWith(`${d2.id} `)) ?? "";
  frames = 0; bad = []; sawArrive = false; sawEnRoute = false;
  const end2 = s.time + 200;
  for (let t = s.time + 2; t < end2; t += 2) {
    pumpTo(s, t);
    const ms = liveDispatchMembers(s, d2);
    const line = rowOf2(); const m = line.match(/ loc=(\S+)/); if (!m) continue;
    frames++;
    const parts = parseLoc(m[1], ms.length);
    const said = parts.filter(([, p]) => p === "已到南线前哨").reduce((a, [k]) => a + k, 0);
    const inRing = ms.filter((u) => near(u.position, SPOST)).length;
    if (said > 0) sawArrive = true; if (parts.some(([, p]) => p === "向南线前哨行进中")) sawEnRoute = true;
    if (said !== inRing || parts.some(([, p]) => p === "停在南线前哨附近")) bad.push(`t${Math.round(s.time)} ${m[1]} 环内${inRing}`);
  }
  check(`Q2 叫回出发地（to=出发地（南线前哨附近））：${frames} 帧里「已到南线前哨」人数＝南线前哨 12 格内人数，从不说「停在南线前哨附近」`,
    d2.id !== d.id && resBack.appliedUnitIds.length >= 3 && frames >= 15 && sawArrive && sawEnRoute && bad.length === 0, bad.slice(0, 4).join(" ‖ ") || `frames=${frames} arrive=${sawArrive} enRoute=${sawEnRoute}`);
  // Q3 派去一个附近没有地名的点（像区域中心）：到了以后是「魔鬼花园雷区附近」，不是「停在<别处><方位>」
  const s3 = freshState();
  let spot: Position | null = null;
  // 复核实测用的那个点：魔鬼花园雷区中心 (295.5,105)——最近的地名前线油库在 15.3 格外；中央前哨的步兵 49 s 走得到
  spot = { x: 295.5, y: 105 };
  const CP3 = s3.facilities.get("ea_player_central_post")!.position;
  const ids3 = [...s3.units.values()].filter((u) => u.team === "player" && u.type === "infantry" && Math.hypot(u.position.x - CP3.x, u.position.y - CP3.y) <= PLACE_NEAR_RADIUS_TILES).slice(0, 4).map((u) => u.id);
  core.applyOrders(s3, ids3.map((id, i) => ({ unitIds: [id], action: "defend", target: { x: spot!.x + i, y: spot!.y }, priority: "medium", origin: "advisor",
    dispatchMeta: { group: "q3", sourceKind: "selection", sourceKey: "", action: "defend", targetName: "魔鬼花园雷区" } })) as any);
  const d3 = s3.dispatches[s3.dispatches.length - 1];
  let last3 = "", strayStop = 0, frames3 = 0, allIn3 = 0;
  const end3 = s3.time + 300;
  for (let t = s3.time + 2; t < end3; t += 2) {
    pumpTo(s3, t);
    const line = core.buildDigest(s3, [], [], []).split("\n").find((l) => l.startsWith(`${d3.id} `)) ?? "";
    const m = line.match(/ loc=(\S+)/); if (!m) continue;
    frames3++; last3 = m[1];
    const ms = liveDispatchMembers(s3, d3);
    // 附近没地名时圆心就是每人自己被送去的那一点（台账逐人记的 destPosById）
    const onSpot = ms.filter((u) => { const q = d3.destPosById![u.id]; return Math.hypot(u.position.x - q.x, u.position.y - q.y) <= PLACE_NEAR_RADIUS_TILES; }).length;
    const said = parseLoc(m[1], ms.length).filter(([, p]) => p === "已到魔鬼花园雷区").reduce((a, [k]) => a + k, 0);
    if (said !== onSpot) { strayStop++; info(`Q3 不一致 t${Math.round(s3.time)} ${m[1]} 落点内${onSpot}`); }
    allIn3 = ms.length > 0 && onSpot === ms.length ? allIn3 + 1 : 0;
    if (allIn3 >= 3) break;
  }
  check(`Q3 派去附近没地名的点（to=魔鬼花园雷区）：${frames3} 帧里「已到魔鬼花园雷区」人数＝离各自落点 12 格内的人数，最后一帧「${last3}」`,
    ids3.length === 4 && nearestPlaceWithin(s3, spot!) === null && frames3 >= 3 && strayStop === 0 && last3 === "已到魔鬼花园雷区", `spot=${JSON.stringify(spot)} mismatch=${strayStop}`);
}

// ── B：回执短缺句（纯函数） ──

type AskFn = (quote: string | null | undefined, said: string | null | undefined) => { quote: string; count: number } | null;
type BuildFn = typeof buildExecReceipt;
function B_shortfallReceipt(ask: AskFn, build: BuildFn = buildExecReceipt): void {
  console.log("\n── B 回执短缺句 ──");
  const ids8 = [30, 31, 32, 33, 34, 35, 36, 37];
  const res = (applied: number[]) => ({ appliedUnitIds: applied, alreadyDoingUnitIds: [], rejectedUnitIds: [], perOrder: [{ appliedUnitIds: applied, alreadyDoingUnitIds: [], rejected: [] }] }) as any;
  // planned：null＝意图上没写数字（缺席）；不传＝与引文同数
  const line = (applied: number[], asked: ReturnType<AskFn>, planned: number | null = asked?.count ?? null) =>
    build(res(applied), [{ action: "defend", destinationName: "烽火台", orderIndexes: [0], ...(asked ? { askedQuantity: asked } : {}), ...(planned !== null ? { plannedQuantity: planned } : {}) }]).lines.join(" ");
  const b1 = line(ids8, ask("10个兵", "从中央前哨派10个兵去烽火台"));
  check("B1 有引文、计划 10、只派出 8 → 补句「（不够您说的数）」", b1 === "已下令 8 个单位前往烽火台设防（不够您说的数）。" && SHORTFALL_CLAUSE === "（不够您说的数）", b1);
  const b2 = line(ids8, ask("10个兵", "从中央前哨派兵去烽火台"), 10);
  check("B2 引文不在长官原话里（模型写的）→ 不补", !b2.includes("您说的"), b2);
  const b3 = line(ids8, ask(undefined, "从中央前哨派10个兵去烽火台"), 10);
  check("B3 没有引文 → 不补", !b3.includes("您说的"), b3);
  const b4 = line([34, 35], ask("两个", "从中路派两个步兵去北线前哨"));
  check("B4 引文「两个」派 2 → 不补", !b4.includes("您说的"), b4);
  const b5 = line(ids8, ask("都", "中央前哨的都派去烽火台"));
  check("B5 引文不是数（「都」）→ 不补", !b5.includes("您说的"), b5);
  const b13 = line(ids8, ask("10个兵", "从中央前哨派10个兵去烽火台"), null);
  check("B13 意图上没写数字（计划人数缺席）→ 不判、不补", !b13.includes("您说的"), b13);
  const b15 = line(ids8.slice(0, 6), ask("百分之五十", "中央战线百分之五十的部队去守烽火台"), 6);
  check("B15「百分之五十」被读成 50，计划 6 ≠ 50 → 不补", !b15.includes("您说的"), b15);

  // B7–B12：同一句引文被拆成几条——按兵种拆（同一个去处）或分两路（不同去处）。
  type Batch = number[] | { applied: number[]; already: number[] };
  const multi = (batches: Batch[], sl: { dest: string; asked: ReturnType<AskFn>; planned?: number }[]) => {
    const perOrder = batches.map((b) => Array.isArray(b) ? { appliedUnitIds: b, alreadyDoingUnitIds: [], rejected: [] } : { appliedUnitIds: b.applied, alreadyDoingUnitIds: b.already, rejected: [] });
    const r = { appliedUnitIds: perOrder.flatMap((p) => p.appliedUnitIds), alreadyDoingUnitIds: perOrder.flatMap((p) => p.alreadyDoingUnitIds), rejectedUnitIds: [], perOrder } as any;
    return build(r, sl.map((x, i) => ({ action: "defend", destinationName: x.dest, orderIndexes: [i], ...(x.asked ? { askedQuantity: x.asked } : {}), ...(x.planned !== undefined ? { plannedQuantity: x.planned } : {}) }))).lines;
  };
  const said = "从中央前哨派10个兵去烽火台";
  const q10 = ask("10个兵", said);
  const clauses = (ls: string[]) => ls.filter((l) => l.includes("您说的"));
  const b7a = multi([[30, 31, 32, 33], [34, 35, 36, 37, 38, 39]], [{ dest: "烽火台", asked: q10, planned: 4 }, { dest: "烽火台", asked: q10, planned: 6 }]);
  check("B7a 按兵种拆成 4＋6＝10 → 一句短缺都不说", clauses(b7a).length === 0, b7a.join(" | "));
  const b7b = multi([[30, 31, 32], [34, 35, 36, 37]], [{ dest: "烽火台", asked: q10, planned: 4 }, { dest: "烽火台", asked: q10, planned: 6 }]);
  check("B7b 按兵种拆、计划 4＋6、只派出 3＋4 → 恰好一句、挂在合计行",
    clauses(b7b).length === 1 && clauses(b7b)[0] === "合计：新下令 7 个单位前往烽火台设防（不够您说的数）。", b7b.join(" | "));
  const b7c = multi([[30, 31, 32, 33], [34, 35, 36]], [{ dest: "烽火台", asked: q10, planned: 7 }, { dest: "烽火台", asked: null, planned: 3 }]);
  check("B7c 同一件事只有一条挂了引文 → 不说", clauses(b7c).length === 0, b7c.join(" | "));
  const b7d = multi([[30, 31], [34, 35, 36]], [{ dest: "烽火台", asked: q10, planned: 5 }, { dest: "烽火台", asked: ask("5个", "派10个兵去烽火台，再派5个"), planned: 5 }]);
  check("B7d 同一件事两条引文不一样 → 不说", clauses(b7d).length === 0, b7d.join(" | "));
  const b7e = multi([[30, 31], [34, 35, 36, 37, 38]], [
    { dest: "烽火台", asked: ask("3个兵", "派3个兵去烽火台，5个兵去北线前哨"), planned: 3 },
    { dest: "北线前哨", asked: ask("5个兵", "派3个兵去烽火台，5个兵去北线前哨"), planned: 5 },
  ]);
  check("B7e 两件事各一条：只有短的那件（烽火台 2<3）说，挂在它自己那句",
    clauses(b7e).length === 1 && clauses(b7e)[0] === "已下令 2 个单位前往烽火台设防（不够您说的数）。", b7e.join(" | "));
  const twoWay = ask("一共10个", "一共10个，分两路去守北线前哨和南线前哨");
  const b8a = multi([[30, 31, 32, 33, 34], [35, 36, 37, 38, 39]], [{ dest: "北线前哨", asked: twoWay, planned: 5 }, { dest: "南线前哨", asked: twoWay, planned: 5 }]);
  check("B8a 一句「一共10个」分两路 5＋5＝10 → 一句短缺都不说", clauses(b8a).length === 0, b8a.join(" | "));
  const b8b = multi([[30, 31, 32, 33, 34], [35, 36, 37]], [{ dest: "北线前哨", asked: twoWay, planned: 5 }, { dest: "南线前哨", asked: twoWay, planned: 5 }]);
  check("B8b 一句引文分两路且真少了（5＋3）→ 引文不是哪一路一家的数，不说（宁缺不错）", clauses(b8b).length === 0, b8b.join(" | "));
  const b9 = multi([{ applied: [], already: [30, 31, 32] }, { applied: [], already: [33, 34, 35] }], [{ dest: "北线前哨", asked: q10, planned: 5 }, { dest: "北线前哨", asked: q10, planned: 5 }]);
  check("B9 拆成两条、全是已在办（一个没新下令）→ 合计行也不补（与单条同规矩）", clauses(b9).length === 0 && b9.some((l) => l.startsWith("合计：")), b9.join(" | "));
  const tenTwo = "派10个兵去守北线前哨和南线前哨";
  const b10 = multi([[30, 31, 32, 33, 34], [35, 36, 37, 38, 39]], [{ dest: "北线前哨", asked: ask("10个兵", tenTwo), planned: 5 }, { dest: "南线前哨", asked: null, planned: 5 }]);
  check("B10 分两路、只有一路抄了引文（计划 5 ≠ 10）→ 不说", clauses(b10).length === 0, b10.join(" | "));
  const b11 = multi([[30, 31, 32, 33, 34], [35, 36, 37, 38, 39]], [{ dest: "北线前哨", asked: ask("10个兵", tenTwo), planned: 5 }, { dest: "南线前哨", asked: ask("10个", tenTwo), planned: 5 }]);
  check("B11 分两路、两路抄的字不一样（「10个兵」/「10个」）→ 不说", clauses(b11).length === 0, b11.join(" | "));
  const fiveFive = "北线前哨派5个，南线前哨也派5个";
  const b12 = multi([[30, 31, 32, 33, 34], [35, 36, 37]], [{ dest: "北线前哨", asked: ask("5个", fiveFive), planned: 5 }, { dest: "南线前哨", asked: ask("5个", fiveFive), planned: 5 }]);
  check("B12 两路各自说了「5个」、南线只派出 3 → 只在南线那句说一次",
    clauses(b12).length === 1 && clauses(b12)[0] === "已下令 3 个单位前往南线前哨设防（不够您说的数）。", b12.join(" | "));
  const b14 = multi([{ applied: [30, 31, 32, 33, 34, 35, 36, 37], already: [38, 39] }], [{ dest: "烽火台", asked: q10, planned: 10 }]);
  check("B14 新下令 8＋已在办 2＝10（已在办的也是长官要的人）→ 不补", clauses(b14).length === 0, b14.join(" | "));
}

// ── R：重放线上那局 ──

async function R_replay(count: CountFn, onState?: (label: string, s: GameState) => void): Promise<void> {
  console.log("\n── R 重放线上首局（真实客户端链路＋录下的模型原文）──");
  const fx = JSON.parse(readFileSync(new URL("./fixtures/central-post-empty-20260930.json", import.meta.url), "utf8"));
  const S: any = await serverRoutes();
  const state = freshState();
  const ctxFns: any = oldFunctions(source, ["MAX_CONTEXT_ENTRIES", "MAX_CONTEXT_CHARS", "createEmptyChannelContext", "pushContext", "formatContext"],
    ["createEmptyChannelContext", "pushContext", "formatContext"]);
  const pv: any = oldFunctions(source, ["buildPlayerViewContext"], ["buildPlayerViewContext"], { buildPlayerViewLines: (core as any).buildPlayerViewLines });
  let view: any = fx.turns[0].view;
  const h: any = harness(state as any, source, "combat", undefined, {
    buildDigestForChannel,
    channelContextRef: { current: ctxFns.createEmptyChannelContext() },
    pushContext: ctxFns.pushContext, formatContext: ctxFns.formatContext,
    commanderMemoryRef: { current: { combat: { playerIntent: "", openCommitments: [] }, ops: { playerIntent: "", openCommitments: [] }, logistics: { playerIntent: "", openCommitments: [] } } },
    buildPlayerViewContext: pv.buildPlayerViewContext, getViewport: () => view,
  });
  const digests: string[] = [];
  const receipts: string[][] = [];
  let got = { central: -1, coastal: -1, south: -1, fuel: -1 };
  let m1At62: { still: number; near: number; far: number; eta: number; stillName: string; movingNamed: boolean; obsPresent: number; legacyA1: string | null } =
    { still: -1, near: -1, far: -1, eta: -1, stillName: "", movingNamed: false, obsPresent: -1, legacyA1: "?" };
  for (const turn of fx.turns) {
    pumpTo(state, turn.t); view = turn.view;
    onState?.(`t${Math.round(turn.t)}`, state);
    if (Math.round(turn.t) === 62) {
      // A″ 的独立期望值（按定义算）：离烽火台 12 格内的 ⇒ 到了；其余在走的 ⇒ 在途（eta 只算他们、按终点）；其余停着的 ⇒ 停在别处
      const ms = liveDispatchMembers(state, findDispatch(state, "M1")!);
      const OBSP = state.facilities.get("ea_observation_post")!.position;
      const near = ms.filter((u) => Math.hypot(u.position.x - OBSP.x, u.position.y - OBSP.y) <= PLACE_NEAR_RADIUS_TILES);
      const far = ms.filter((u) => !near.includes(u) && movingGate(u)); const st = ms.filter((u) => !near.includes(u) && !movingGate(u));
      m1At62 = { still: st.length, near: near.length, far: far.length,
        eta: Math.ceil(estimateSquadTravelTime(state, far.map((u) => u.id), centroid(far.map((u) => u.waypoints.length ? u.waypoints[u.waypoints.length - 1] : u.target!)))),
        stillName: st.length === 1 ? stillName(state, st[0].position) : "?", movingNamed: far.every((u) => nearestPlaceWithin(state, u.target!) === "烽火台"),
        obsPresent: countPlayerUnitsNear(state, OBSP, PLACE_NEAR_RADIUS_TILES), legacyA1: locationPhraseFor(state, ms) };
    }
    if (Math.round(turn.t) === 43) {
      const n = (id: string) => count(state, state.facilities.get(id)!.position, PLACE_NEAR_RADIUS_TILES);
      got = { central: n("ea_player_central_post"), coastal: n("ea_player_coastal_post"), south: n("ea_player_south_post"), fuel: n("ea_fuel_depot") };
    }
    S.llm.queue = [{ kind: "text", text: turn.raw }];
    const r0 = h.requests.length;
    const s0 = h.screen.length;
    await h.send(turn.text, S.clientFetch);
    receipts.push(h.screen.slice(s0).filter((m: any) => m.source === "command_ack").map((m: any) => m.text));
    const req = h.requests.slice(r0).find((q: any) => q.path === "/api/command-stream" || q.path === "/api/command");
    digests.push(String(req?.body?.digest ?? ""));
  }
  info(`43 s：中央 ${got.central} / 北线 ${got.coastal} / 南线 ${got.south} / 前线油库 ${got.fuel}`);
  check("R1 43 s 中央前哨 0", got.central === 0, `${got.central}`);
  check("R2 43 s 北线前哨 8", got.coastal === 8, `${got.coastal}`);
  check("R3 43 s 南线前哨 9", got.south === 9, `${got.south}`);
  check("R4 43 s 前线油库 4（在途纵队正路过）", got.fuel === 4, `${got.fuel}`);
  // 真渲染的信封里也是这几个数（实验夹具＝这份信封）
  const d43 = digests[1];
  const lineOf = (id: string) => d43.split("\n").find((l) => l.startsWith(`${id}:`)) ?? "";
  check("R5 43 s 真信封：中央前哨行印 0", / 在场我方=0单位$/.test(lineOf("ea_player_central_post")), lineOf("ea_player_central_post"));
  check("R6 43 s 真信封：北线 8、南线 9、油库 4", / 在场我方=8单位$/.test(lineOf("ea_player_coastal_post")) && / 在场我方=9单位$/.test(lineOf("ea_player_south_post")) && / 在场我方=4单位$/.test(lineOf("ea_fuel_depot")),
    [lineOf("ea_player_coastal_post"), lineOf("ea_player_south_post"), lineOf("ea_fuel_depot")].join(" | "));
  check("R7 43 s 真信封：FRONTS 中央战线行与 DISPATCHES 行原样（本刀不碰）",
    d43.includes("front_center:3. 中央战线 OurPwr=440 EnemyPwr=? OurComp=[4×main_tank,4×infantry]") &&
    d43.includes("M1 from=3. 中央战线 to=烽火台 act=defend left=8 via=G2「中央前哨附近未编组群」里派出的 home=中央前哨附近"));
  const m1 = (d: string) => d.split("\n").find((l) => l.startsWith("M1 ")) ?? "";
  const M1_LEGACY = "M1 from=3. 中央战线 to=烽火台 act=defend left=8 via=G2「中央前哨附近未编组群」里派出的 home=中央前哨附近";
  check("P1 43 s 真信封 M1 行 ＝ 旧行 ＋「 loc=向烽火台行进中 eta≈60s」", m1(d43) === `${M1_LEGACY} loc=向烽火台行进中 eta≈60s`, m1(d43));
  // 62 s 实况（重放逐人核过；2026-10-02 掉队兵修好后按新实况重推）：4 辆主战坦克已进烽火台 9 格内（引擎移动门仍算
  // 在走最后一段；FACILITIES 烽火台在场 4）、4 个步兵在路上离烽火台约 38 格，没有停在别处的人。
  // 修前这一刻是「3 个到了＋1 辆（#33）停在前线油库西北」：#33 去岗路上被 autoBehavior 拉去帮友军、拴回半路后
  // 再不走（ab-straggler 钉那条病）。「停在…」那种说法的覆盖由合成段 P5b / P3b / P17 继续负责。
  const p2Loc = `${m1At62.near}个已到烽火台+${m1At62.far}个向烽火台行进中`;
  const p2Want = `${M1_LEGACY} loc=${p2Loc} eta≈${m1At62.eta}s`;
  check(`P2 62 s 真信封 M1 行 ＝ 旧行 ＋「 loc=${p2Loc} eta≈${m1At62.eta}s」（分组、eta 台架独立算；到了的人数 ＝ FACILITIES 烽火台在场数；没有停在别处的）`,
    m1At62.still === 0 && m1At62.near === 4 && m1At62.far === 4 && m1At62.obsPresent === m1At62.near && m1At62.movingNamed &&
    m1At62.eta > 0 && m1At62.eta < 60 && m1(digests[2]) === p2Want, `${m1(digests[2])} ｜ 期望 ${p2Want}`);
  // 110 s：8 个全到了烽火台（修前那辆 #33 还停在原地）。全员一组 ⇒ 只写地名、不带人数（与 P3′「到了」同一条规矩）。
  pumpTo(state, 110);
  let legacyA1At110: string | null = "?";
  let p2bWant = "?";
  {
    const ms = liveDispatchMembers(state, findDispatch(state, "M1")!);
    const OBSP = state.facilities.get("ea_observation_post")!.position;
    const near = ms.filter((u) => Math.hypot(u.position.x - OBSP.x, u.position.y - OBSP.y) <= PLACE_NEAR_RADIUS_TILES);
    const rest = ms.filter((u) => !near.includes(u));
    p2bWant = rest.length === 0 ? "已到烽火台" : `${near.length}个已到烽火台+${rest.length}个?`;
    legacyA1At110 = locationPhraseFor(state, ms);
    const line = m1(core.buildDigest(state, [], [], []));
    check(`P2b 110 s 真信封 M1 行 ＝ 旧行 ＋「 loc=${p2bWant}」（8 个全到、没人掉在半路，无 eta）`,
      ms.length === 8 && rest.length === 0 && line === `${M1_LEGACY} loc=${p2bWant}`, `${line} ｜ 期望 loc=${p2bWant}`);
  }
  // 绊索自证：已上线的 A′ 在这两刻说的与期望不同——62 s 拿全批一句「向烽火台行进中」（把已到的 4 辆也说成在路上）、
  // 110 s 说「烽火台附近」（真模型问「都到了吗？」6/20 答对、14/20 编「8分钟」；本版「已到烽火台」20/20）——P2/P2b 分得出新旧。
  check(`P2x 已上线 A′ 在 62 s 给「${m1At62.legacyA1}」≠「${p2Loc}」、110 s 给「${legacyA1At110}」≠「${p2bWant}」（P2/P2b 分得出新旧）`,
    m1At62.legacyA1 === "向烽火台行进中" && m1At62.legacyA1 !== p2Loc && legacyA1At110 === "烽火台附近" && p2bWant === "已到烽火台");
  const r1 = receipts[0].join(" | ");
  check("B6 重放：第一回合回执「…8个单位出发了，前往烽火台（不够您说的数）。」", r1.includes("8个单位出发了，前往烽火台（不够您说的数）。"), r1);
  (globalThis as any).__FP_DIGESTS__ = digests;
}

// ── main ──

const args = process.argv.slice(2);
const NEGCTL = args.includes("--negctl");

async function main(): Promise<void> {
  console.log(`=== ab-facility-presence (place-presence V1) ${NEGCTL ? "· NEGCTL" : "· synthetic"} ===`);
  if (!(globalThis as any).__REC_SEEDED__) console.log("     · 注意：未经 recorder-seed-random 播种（R 段数值可能与档案不符）");

  if (!NEGCTL) {
    // R 必须最先跑：它要从干净的随机序列开始，才与档案复现逐位一致
    console.log("\n── D 渲染（逐时刻当场检查）──");
    await R_replay(countPlayerUnitsNear, (label, s) => { E_collect(countPlayerUnitsNear, label, s); D_rendering([{ label, s }]); });
    F_oneRuler();
    C_countingRules(countPlayerUnitsNear);
    // 跑引擎本身；同时逐例比对台架参照实现（全开），证明负对照摘掉的那一条是唯一差别
    { const ref = refWhere({}); let same = 0, all = 0; const diffs: string[] = [];
      const probe: WhereFn = (st, ms, dn) => { const a = dispatchWhereabouts(st, ms, dn), b = ref(st, ms, dn); all++; if (a.loc === b.loc && a.etaSec === b.etaSec) same++; else diffs.push(`${JSON.stringify(a)} vs ${JSON.stringify(b)}`); return a; };
      P_whereaboutsRules(probe);
      check(`P0 台架参照实现（全开）与引擎在全部 P 例上逐字同（${same}/${all}）`, same === all && all > 0, diffs.join(" ‖ ")); }
    B_shortfallReceipt(verifiedAskedQuantity);
    Q_endToEnd();
    const t0 = freshState(); E_collect(countPlayerUnitsNear, "t0", t0); D_rendering([{ label: "t0", s: t0 }]);
    const extra = freshState(); pumpTo(extra, 90); E_collect(countPlayerUnitsNear, "t90", extra); D_rendering([{ label: "t90", s: extra }]);
    E_finalize();
    console.log(`\n=== ${failCount === 0 ? "ALL SYNTHETIC PASS" : `${failCount} FAIL`} ===`);
    if (failCount > 0) process.exit(1);
    return;
  }

  // 负对照：每种改坏的口径，对应断言必须真 FAIL
  const expectFail = async (label: string, run: () => Promise<void> | void, mustFail: RegExp[]): Promise<boolean> => {
    failCount = 0; failed.length = 0;
    console.log(`\n▶ 负对照 ${label}`);
    await run();
    const ok = mustFail.every((re) => failed.some((n) => re.test(n)));
    console.log(`   ${ok ? "★ 真 FAIL（台架咬得住）" : "✗ 没咬住"}：${failed.join(" / ") || "（零 FAIL）"}`);
    return ok;
  };
  // "排除在途"：命令目标离当前位置还有 >2 格的不算。注意在途单位的 state 往往是 defending/retreating
  // 而不是 moving（接的是防守/撤退单），只按 state 名过滤滤不掉他们——所以按"还没到目标点"判。
  const skipMoving: CountFn = (s, p, r) => {
    let n = 0; const r2 = r * r;
    s.units.forEach((u: any) => {
      if (u.team !== "player" || u.hp <= 0 || u.state === "dead") return;
      const tgt = u.orders?.[0]?.target ?? u.target;
      if (u.state === "moving" || (tgt && Math.hypot(tgt.x - u.position.x, tgt.y - u.position.y) > 2)) return;
      if ((u.position.x - p.x) ** 2 + (u.position.y - p.y) ** 2 <= r2) n++;
    });
    return n;
  };
  const radius15: CountFn = (s, p) => countPlayerUnitsNear(s, p, 15);
  const results = [
    await expectFail("N1 不算在途/移动中的", async () => { await R_replay(skipMoving); C_countingRules(skipMoving); }, [/^C7/, /^R4/]),
    await expectFail("N2 半径 15", () => C_countingRules(radius15), [/^C2/]),
    await expectFail("N3 中立设施漏印字段", () => D_rendering([{ label: "t0", s: freshState() }], (d) => d.split("\n").map((l) => / team=neutral /.test(l) ? l.replace(FACILITY_SUFFIX, "") : l).join("\n")), [/^D3/, /^D5/]),
    await expectFail("N4 计数与 director 口径分家（不算亲兵）", () => {
      const noGuard: CountFn = (s, p, r) => { let n = 0; const r2 = r * r; s.units.forEach((u) => { if (u.team === "player" && u.hp > 0 && u.state !== "dead" && u.type !== "elite_guard" && (u.position.x - p.x) ** 2 + (u.position.y - p.y) ** 2 <= r2) n++; }); return n; };
      const s0 = freshState(); E_collect(noGuard, "t0", s0); E_collect(noGuard, "t0b", s0); E_collect(noGuard, "t0c", s0); E_finalize();
    }, [/^E1/]),
  ];
  results.push(await expectFail("N5 A′ 不管动静齐不齐都写现址（拿在途那个人的说法代表全批）", () => {
    const sloppy: WhereFn = (st, ms, d) => {
      const mover = ms.find((u: any) => u.target !== null) ?? ms[0];
      return dispatchWhereabouts(st, [mover], d);
    };
    P_whereaboutsRules(sloppy);
  }, [/^P5 /]));
  results.push(await expectFail("N8 A″ eta 把停着的人也算进最慢成员", () => {
    const allIn: WhereFn = (st, ms, d) => {
      const r = dispatchWhereabouts(st, ms, d);
      if (!r.loc?.includes("+") || r.etaSec === null) return r;
      const mv = ms.filter((u: any) => u.target !== null);
      return { loc: r.loc, etaSec: Math.ceil(estimateSquadTravelTime(st, ms.map((u: any) => u.id), centroid(mv.map((u: any) => u.target)))) };
    };
    P_whereaboutsRules(allIn);
  }, [/^P5 /]));
  results.push(await expectFail("N9 A″ 退回 A′：动静混合整行省略", () => {
    const omitMixed: WhereFn = (st, ms, d) => { const r = dispatchWhereabouts(st, ms, d); return r.loc?.includes("+") ? { loc: null, etaSec: null } : r; };
    P_whereaboutsRules(omitMixed);
  }, [/^P5 /]));
  results.push(await expectFail("N10 A″ 停着的人不逐人认地名、拿一簇的质心起名", () => P_whereaboutsRules(refWhere({ perUnitStopped: false })), [/^P17 /]));
  results.push(await expectFail("N11 A″「到了」按最近地名同名判（不按离被派去的地方的距离）", () => P_whereaboutsRules(refWhere({ arriveByDistance: false })), [/^P10 /, /^P16 /]));
  results.push(await expectFail("N12 A″ 停在没地名处只写方位、不加「停在」", () => P_whereaboutsRules(refWhere({ stopMarker: false })), [/^P5b /, /^P3b /]));
  results.push(await expectFail("N13 A″ 在途的去处取下一个航点（不取终点）", () => P_whereaboutsRules(refWhere({ finalGoal: false })), [/^P14 /]));
  results.push(await expectFail("N14 A″ 连方位原点都没有也照说罗盘方位", () => P_whereaboutsRules(refWhere({ omitCompass: false })), [/^P13 /]));
  results.push(await expectFail("N15 A″ 按 to= 的名字找「到了」的圆心（上一版：战线取几何中心、区域与出发地找不到）", () => P_whereaboutsRules(refWhere({ recordedDest: false })), [/^P18 /, /^P19 /]));
  results.push(await expectFail("N17 A″ 去处旁边的标记顶替设施（不先认 to= 那个设施）", () => P_whereaboutsRules(refWhere({ facilityFirst: false })), [/^P20 /]));
  results.push(await expectFail("N18 A″ 带路线的 eta 按直线算", () => P_whereaboutsRules(refWhere({ routeLegs: false })), [/^P14 /]));
  // N19（按「向」字头判在途）已撤：「到了」改写成「已到X」后三类说法各有固定开头（已到… / 停在… / 向…行进中），
  // 字头与结构类别在构造上恒同，这条负对照再无可咬之处；P22（去处叫「向阳坡」）作正向回归照留。
  results.push(await expectFail("N21 A″ 去处附近没地名就没有「到了」（站在自己终点上被说成停在别处）", () => P_whereaboutsRules(refWhere({ toNameFallback: false })), [/^P23 /]));
  results.push(await expectFail("N6 B 不核原话、直接信模型写的引文", () => {
    const trusting: AskFn = (q) => { const t = (q ?? "").trim(); const m = t.match(/\d+/); return m ? { quote: t, count: Number(m[0]) } : null; };
    B_shortfallReceipt(trusting);
  }, [/^B2/]));
  results.push(await expectFail("N7 B 按切片各算短缺（按兵种拆开的同一句话各算各的）", () => {
    const perSlice: BuildFn = (r, sl) => ({ ...buildExecReceipt(r, sl), lines: sl.flatMap((x) => buildExecReceipt(r, [x]).lines) });
    B_shortfallReceipt(verifiedAskedQuantity, perSlice);
  }, [/^B7b/]));
  results.push(await expectFail("N20 B 不看这条单子自己计划几个（引文的数直接当这件事的数）", () => {
    const noPlanCheck: BuildFn = (r, sl) => buildExecReceipt(r, sl.map((x) => (x.askedQuantity ? { ...x, plannedQuantity: x.askedQuantity.count } : x)));
    B_shortfallReceipt(verifiedAskedQuantity, noPlanCheck);
  }, [/^B8a/, /^B10/, /^B11/, /^B13/, /^B15/]));
  const n = results.filter(Boolean).length;
  console.log(`\n=== ${n === results.length ? `NEGCTL OK — ${n}/${results.length} 条 ★ 真 FAIL` : `NEGCTL BROKEN — 只有 ${n}/${results.length} 条咬住`} ===`);
  if (n !== results.length) process.exit(1);
}

main().then(() => process.exit(0), (e) => { console.error(e); process.exit(1); });
