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
//   P  A′ DISPATCHES 行 loc= / eta≈：43 s 钉「loc=向烽火台行进中 eta≈60s」；全员停 → 「X附近」无 eta；
//      有人没目标 → 省略；eta 只随「向X行进中」出现。A″ 一批人散在几处 ⇒ 按人真在哪分组分写：
//      在途按去处、停着的按空间成簇（12 格内无地名用 preflight 同款方位短语）；62 s 钉
//      「loc=1个前线油库西北+7个向烽火台行进中 eta≈43s」、110 s 钉「7个烽火台附近+1个前线油库西北」
//      （名字与 eta 台架独立算）；停着的散两处各起名（P8）；去两处不给 eta（P9）
//   B  回执短缺句：只引长官原话里逐字出现的数量引文；派得比它少才补「（您说的「10个兵」，这一批只有 8 个）」；
//      同一句话被拆成几条 ⇒ 按整组只在合计行说一次，引文不齐不说（B7）
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
import { dispatchWhereabouts, nearestPlaceWithin, bearingNameFor, bearingPhrase } from "../packages/core/src/frontEscalationPayload";
import { estimateSquadTravelTime } from "../packages/core/src/crisisResponse";
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
/** 台架独立算的「一个停着的人 / 一簇停着的人」该叫什么：12 格内地名 ⇒ X附近，否则 preflight 同款方位短语。 */
const stillName = (s: GameState, c: Position) => { const p = nearestPlaceWithin(s, c); return p !== null ? `${p}附近` : bearingPhrase(bearingNameFor(s, c)); };
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

// ── P：A′ 现址规则（合成局面） ──

type WhereFn = (state: GameState, members: any[]) => { loc: string | null; etaSec: number | null };
function P_whereaboutsRules(where: WhereFn): void {
  console.log("\n── P A′ loc= / eta≈ 规则 ──");
  const s = freshState();
  const inf = [...s.units.values()].filter((u) => u.team === "player" && u.type === "infantry").slice(0, 3);
  const OBS = s.facilities.get("ea_observation_post")!.position;
  const REP = s.facilities.get("ea_repair_station")!.position;
  // 全员停在修理厂旁：「野战修理厂附近」，不给 eta
  inf.forEach((u, i) => { u.position = { x: REP.x + i, y: REP.y }; u.state = "idle"; u.target = null; });
  let w = where(s, inf);
  check("P3 全员停在据点旁 → loc=X附近、无 eta", w.loc === "野战修理厂附近" && w.etaSec === null, JSON.stringify(w));
  // 全员在途、都有目标 → 「向烽火台行进中」＋ eta
  inf.forEach((u, i) => { u.position = { x: 330 + i, y: 100 }; u.state = "moving"; u.target = { x: OBS.x + i, y: OBS.y }; });
  w = where(s, inf);
  check("P4 全员在途 → loc=向烽火台行进中、eta 为正整数", w.loc === "向烽火台行进中" && Number.isInteger(w.etaSec) && (w.etaSec ?? 0) > 0, JSON.stringify(w));
  // A″ 动静混合 → 按子集分写；eta 只算在途那两个（停着的那个离烽火台远得多，算进去就会拖长）
  inf[0].position = { x: REP.x, y: REP.y }; inf[0].state = "idle"; inf[0].target = null;
  inf.slice(1).forEach((u, i) => { u.position = { x: OBS.x + 15 + i, y: OBS.y }; u.state = "moving"; u.target = { x: OBS.x + i, y: OBS.y }; });
  const movingIds = inf.slice(1).map((u) => u.id);
  const tgtC = { x: (inf[1].target!.x + inf[2].target!.x) / 2, y: (inf[1].target!.y + inf[2].target!.y) / 2 };
  const etaMoving = Math.ceil(estimateSquadTravelTime(s, movingIds, tgtC));
  const etaAll = Math.ceil(estimateSquadTravelTime(s, inf.map((u) => u.id), tgtC));
  w = where(s, inf);
  check("P5 动静混合 → loc=1个野战修理厂附近+2个向烽火台行进中、eta＝只算在途两个",
    etaAll > etaMoving && w.loc === "1个野战修理厂附近+2个向烽火台行进中" && w.etaSec === etaMoving, JSON.stringify({ ...w, etaMoving, etaAll }));
  // A″ 停着的那部分说不出地名 → 整句省略（不编）
  let nameless: Position | null = null;
  for (let y = 0; y < 300 && !nameless; y += 4) for (let x = 0; x < 400 && !nameless; x += 4) if (nearestPlaceWithin(s, { x, y }) === null) nameless = { x, y };
  inf[0].position = { ...nameless! };
  w = where(s, inf);
  const bearingThere = bearingPhrase(bearingNameFor(s, nameless!));
  check(`P5b 动静混合、停着的那个 12 格内没地名 → 用 preflight 同款方位短语「${bearingThere}」`,
    nameless !== null && w.loc === `1个${bearingThere}+2个向烽火台行进中` && w.etaSec === etaMoving, JSON.stringify({ ...w, nameless }));
  // A″ 在途那部分有人没目标 → 整句省略
  inf[0].position = { x: REP.x, y: REP.y }; inf[2].target = null;
  w = where(s, inf);
  check("P5c 动静混合、在途那部分有人没目标 → 省略", w.loc === null && w.etaSec === null, JSON.stringify(w));
  // 全员在动但有人没目标 → 省略
  inf.slice(1).forEach((u, i) => { u.position = { x: OBS.x + 15 + i, y: OBS.y }; u.state = "moving"; u.target = { x: OBS.x + i, y: OBS.y }; });
  inf[0].state = "moving"; inf[0].target = null;
  w = where(s, inf);
  check("P6 有人没目标 → 省略", w.loc === null && w.etaSec === null, JSON.stringify(w));
  // eta 只随「向」短语：停着的那一路永远不出 eta
  inf.forEach((u, i) => { u.position = { x: REP.x + i, y: REP.y }; u.state = "idle"; u.target = null; });
  check("P7 eta 只随「向X行进中」出现", where(s, inf).etaSec === null);
  // A″ 停着的人散在两处 → 各簇各起名，不拿全体质心起一个名（质心会落在两处之间：假地名或没名）
  inf[0].position = { x: REP.x, y: REP.y };
  inf[1].position = { x: OBS.x, y: OBS.y }; inf[2].position = { x: OBS.x + 1, y: OBS.y };
  w = where(s, inf);
  check("P8 停着的人散在两处 → loc=2个烽火台附近+1个野战修理厂附近、无 eta", w.loc === "2个烽火台附近+1个野战修理厂附近" && w.etaSec === null, JSON.stringify(w));
  // A″ 在途的去两个地方 → 各写各的，eta 不给（说不清是哪一路的）
  inf[1].position = { x: OBS.x + 15, y: OBS.y }; inf[1].state = "moving"; inf[1].target = { x: OBS.x, y: OBS.y };
  inf[2].position = { x: REP.x + 15, y: REP.y }; inf[2].state = "moving"; inf[2].target = { x: REP.x, y: REP.y };
  w = where(s, inf);
  check("P9 在途的去两处 → 各写一组、eta 省略", w.loc === `1个野战修理厂附近+${["向烽火台行进中", "向野战修理厂行进中"].sort().map((x) => `1个${x}`).join("+")}` && w.etaSec === null, JSON.stringify(w));
  // A″ 全员停在一处、12 格内没地名 → 方位短语（A′ 时整句省略；同一套起名规则，不因只有一簇就改口）
  inf.forEach((u, i) => { u.position = { x: nameless!.x + i, y: nameless!.y }; u.state = "idle"; u.target = null; });
  w = where(s, inf);
  const bearingAll = stillName(s, centroid(inf.map((u) => u.position)));
  check(`P3b 全员停在没地名的地方 → loc=${bearingAll}、无 eta`, w.loc === bearingAll && w.etaSec === null, JSON.stringify(w));
}

// ── B：回执短缺句（纯函数） ──

type AskFn = (quote: string | null | undefined, said: string | null | undefined) => { quote: string; count: number } | null;
type BuildFn = typeof buildExecReceipt;
function B_shortfallReceipt(ask: AskFn, build: BuildFn = buildExecReceipt): void {
  console.log("\n── B 回执短缺句 ──");
  const ids8 = [30, 31, 32, 33, 34, 35, 36, 37];
  const res = (applied: number[]) => ({ appliedUnitIds: applied, alreadyDoingUnitIds: [], rejectedUnitIds: [], perOrder: [{ appliedUnitIds: applied, alreadyDoingUnitIds: [], rejected: [] }] }) as any;
  const line = (applied: number[], asked: ReturnType<AskFn>) =>
    buildExecReceipt(res(applied), [{ action: "defend", destinationName: "烽火台", orderIndexes: [0], ...(asked ? { askedQuantity: asked } : {}) }]).lines.join(" ");
  const b1 = line(ids8, ask("10个兵", "从中央前哨派10个兵去烽火台"));
  check("B1 有引文且短缺 → 补句「（不够您说的数）」", b1 === "已下令 8 个单位前往烽火台设防（不够您说的数）。" && SHORTFALL_CLAUSE === "（不够您说的数）", b1);
  const b2 = line(ids8, ask("10个兵", "从中央前哨派兵去烽火台"));
  check("B2 引文不在长官原话里（模型写的）→ 不补", !b2.includes("您说的"), b2);
  const b3 = line(ids8, ask(undefined, "从中央前哨派10个兵去烽火台"));
  check("B3 没有引文 → 不补", !b3.includes("您说的"), b3);
  const b4 = line([34, 35], ask("两个", "从中路派两个步兵去北线前哨"));
  check("B4 引文「两个」派 2 → 不补", !b4.includes("您说的"), b4);
  const b5 = line(ids8, ask("都", "中央前哨的都派去烽火台"));
  check("B5 引文不是数（「都」）→ 不补", !b5.includes("您说的"), b5);

  // B7（复核 P0-1）：同一句「10个兵」被模型按兵种拆成几条（规划器判"各条之和＝引文数"不歧义、直接执行）。
  //   短缺按整件事算、只说一次（挂合计行）；引文不齐 ⇒ 不说。
  const multi = (batches: number[][], sl: { dest: string; asked: ReturnType<AskFn> }[]) => {
    const perOrder = batches.map((b) => ({ appliedUnitIds: b, alreadyDoingUnitIds: [], rejected: [] }));
    const r = { appliedUnitIds: batches.flat(), alreadyDoingUnitIds: [], rejectedUnitIds: [], perOrder } as any;
    return build(r, sl.map((x, i) => ({ action: "defend", destinationName: x.dest, orderIndexes: [i], ...(x.asked ? { askedQuantity: x.asked } : {}) }))).lines;
  };
  const said = "从中央前哨派10个兵去烽火台";
  const q10 = ask("10个兵", said);
  const clauses = (ls: string[]) => ls.filter((l) => l.includes("您说的"));
  const b7a = multi([[30, 31, 32, 33], [34, 35, 36, 37, 38, 39]], [{ dest: "烽火台", asked: q10 }, { dest: "烽火台", asked: q10 }]);
  check("B7a 拆成 4＋6＝10 → 一句短缺都不说", clauses(b7a).length === 0, b7a.join(" | "));
  const b7b = multi([[30, 31, 32], [34, 35, 36, 37]], [{ dest: "烽火台", asked: q10 }, { dest: "烽火台", asked: q10 }]);
  check("B7b 拆成 3＋4＝7 → 恰好一句、挂在合计行（合计 7 个）",
    clauses(b7b).length === 1 && clauses(b7b)[0] === "合计：新下令 7 个单位前往烽火台设防（不够您说的数）。", b7b.join(" | "));
  const b7c = multi([[30, 31, 32, 33], [34, 35, 36]], [{ dest: "烽火台", asked: q10 }, { dest: "烽火台", asked: null }]);
  check("B7c 同一件事只有一条挂了引文（分不清是不是同一句话）→ 不说", clauses(b7c).length === 0, b7c.join(" | "));
  const b7d = multi([[30, 31], [34, 35, 36]], [{ dest: "烽火台", asked: q10 }, { dest: "烽火台", asked: ask("5个", "派10个兵去烽火台，再派5个") }]);
  check("B7d 同一件事两条引文不一样 → 不说", clauses(b7d).length === 0, b7d.join(" | "));
  const b7e = multi([[30, 31], [34, 35, 36, 37, 38]], [
    { dest: "烽火台", asked: ask("3个兵", "派3个兵去烽火台，5个兵去北线前哨") },
    { dest: "北线前哨", asked: ask("5个兵", "派3个兵去烽火台，5个兵去北线前哨") },
  ]);
  check("B7e 两件事各一条：只有短的那件（烽火台 2<3）说，挂在它自己那句",
    clauses(b7e).length === 1 && clauses(b7e)[0] === "已下令 2 个单位前往烽火台设防（不够您说的数）。", b7e.join(" | "));
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
  let m1At62 = { still: -1, moving: -1, eta: -1, stillName: "", movingNamed: false };
  for (const turn of fx.turns) {
    pumpTo(state, turn.t); view = turn.view;
    onState?.(`t${Math.round(turn.t)}`, state);
    if (Math.round(turn.t) === 62) {
      // A″ 的独立期望值：M1 谁停着、谁在途（引擎自己的移动门）、在途那几个最慢的多久到
      const ms = liveDispatchMembers(state, findDispatch(state, "M1")!);
      const mv = ms.filter(movingGate); const st = ms.filter((u) => !movingGate(u));
      m1At62 = { still: st.length, moving: mv.length, eta: Math.ceil(estimateSquadTravelTime(state, mv.map((u) => u.id), centroid(mv.map((u) => u.target!)))),
        stillName: st.length === 1 ? stillName(state, st[0].position) : "?", movingNamed: mv.every((u) => nearestPlaceWithin(state, u.target!) === "烽火台") };
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
  // 62 s 实况（重放逐人核过）：3 辆坦克在烽火台 5 格内但还在走最后一段、4 个步兵在路上（引擎移动门都算在途），
  // 1 辆坦克（#33）43–62 s 间接敌后停下、丢了目标，停在前线油库西北、离烽火台 47 格。
  const p2Want = `${M1_LEGACY} loc=1个${m1At62.stillName}+7个向烽火台行进中 eta≈${m1At62.eta}s`;
  check(`P2 62 s 真信封 M1 行 ＝ 旧行 ＋「 loc=1个${m1At62.stillName}+7个向烽火台行进中 eta≈${m1At62.eta}s」（名字与 eta 台架独立算）`,
    m1At62.still === 1 && m1At62.moving === 7 && m1At62.movingNamed && m1At62.eta > 0 && m1At62.eta < 60 && m1(digests[2]) === p2Want, `${m1(digests[2])} ｜ 期望 ${p2Want}`);
  // 110 s：7 个到了烽火台，那 1 辆还停在原地。A′（已上线）此刻拿 8 人质心说「烽火台附近」——把没到的那辆也说成到了。
  pumpTo(state, 110);
  {
    const ms = liveDispatchMembers(state, findDispatch(state, "M1")!);
    const st = ms.filter((u) => !movingGate(u));
    const groups = new Map<string, number>(); for (const u of st) { const n = stillName(state, u.position); groups.set(n, (groups.get(n) ?? 0) + 1); }
    const want = Array.from(groups.entries()).sort((a, b) => b[1] - a[1]).map(([n, k]) => `${k}个${n}`).join("+");
    const line = m1(core.buildDigest(state, [], [], []));
    check(`P2b 110 s 真信封 M1 行 ＝ 旧行 ＋「 loc=${want}」（没到的那辆单独说，无 eta）`,
      ms.length === 8 && ms.every((u) => !movingGate(u)) && want === `7个烽火台附近+1个${m1At62.stillName}` && line === `${M1_LEGACY} loc=${want}`, `${line} ｜ 期望 loc=${want}`);
  }
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
    P_whereaboutsRules(dispatchWhereabouts);
    B_shortfallReceipt(verifiedAskedQuantity);
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
    const sloppy: WhereFn = (st, ms) => {
      const mover = ms.find((u: any) => u.target !== null) ?? ms[0];
      return dispatchWhereabouts(st, [mover]);
    };
    P_whereaboutsRules(sloppy);
  }, [/^P5/]));
  results.push(await expectFail("N8 A″ eta 把已经到了的人也算进最慢成员", () => {
    const allIn: WhereFn = (st, ms) => {
      const r = dispatchWhereabouts(st, ms);
      if (!r.loc?.includes("+")) return r;
      const mv = ms.filter((u: any) => u.target !== null);
      const c = { x: mv.reduce((a: number, u: any) => a + u.target.x, 0) / mv.length, y: mv.reduce((a: number, u: any) => a + u.target.y, 0) / mv.length };
      return { loc: r.loc, etaSec: Math.ceil(estimateSquadTravelTime(st, ms.map((u: any) => u.id), c)) };
    };
    P_whereaboutsRules(allIn);
  }, [/^P5 /]));
  results.push(await expectFail("N10 A″ 停着的人不分簇、拿全体质心起一个名", () => {
    const oneCentroid: WhereFn = (st, ms) => {
      const still = ms.filter((u: any) => !movingGate(u)); const mv = ms.filter(movingGate);
      if (still.length === 0) return dispatchWhereabouts(st, ms);
      const sp = stillName(st, centroid(still.map((u: any) => u.position)));
      if (mv.length === 0) return { loc: sp, etaSec: null };
      const m = dispatchWhereabouts(st, mv);
      return m.loc ? { loc: `${still.length}个${sp}+${mv.length}个${m.loc}`, etaSec: m.etaSec } : { loc: null, etaSec: null };
    };
    P_whereaboutsRules(oneCentroid);
  }, [/^P8 /]));
  results.push(await expectFail("N9 A″ 退回 A′：动静混合整行省略", () => {
    const omitMixed: WhereFn = (st, ms) => { const r = dispatchWhereabouts(st, ms); return r.loc?.includes("+") ? { loc: null, etaSec: null } : r; };
    P_whereaboutsRules(omitMixed);
  }, [/^P5 /]));
  results.push(await expectFail("N6 B 不核原话、直接信模型写的引文", () => {
    const trusting: AskFn = (q) => { const t = (q ?? "").trim(); const m = t.match(/\d+/); return m ? { quote: t, count: Number(m[0]) } : null; };
    B_shortfallReceipt(trusting);
  }, [/^B2/]));
  results.push(await expectFail("N7 B 按切片各算短缺（拆开的同一句话各说一遍）", () => {
    // 复核前的样子：每条切片单独成一张回执，各拿自己的人数去比引文
    const perSlice: BuildFn = (r, sl) => ({ ...buildExecReceipt(r, sl), lines: sl.flatMap((x) => buildExecReceipt(r, [x]).lines) });
    B_shortfallReceipt(verifiedAskedQuantity, perSlice);
  }, [/^B7a/, /^B7b/]));
  const n = results.filter(Boolean).length;
  console.log(`\n=== ${n === results.length ? `NEGCTL OK — ${n}/${results.length} 条 ★ 真 FAIL` : `NEGCTL BROKEN — 只有 ${n}/${results.length} 条咬住`} ===`);
  if (n !== results.length) process.exit(1);
}

main().then(() => process.exit(0), (e) => { console.error(e); process.exit(1); });
