// ============================================================
// AI Commander — facility-presence bench（place-presence V1：据点驻军数）
//
// 病例：2026-09-30 线上首局，中央前哨的 8 个全派往烽火台后，长官两次问"空了吗"，
// 陈两次答"有 4 坦 4 步，没空"。信封里没有"某据点此刻有几个我方兵"，陈拿 FRONTS
// 战线汇总 / DISPATCHES 出处去顶。真模型 19 臂对照：FACILITIES 补「附近我方=N单位」
// 0/20 → 20/20（档 _archive/central-post-empty-20261001/FINDINGS.md、REVIEW-FABLE.md）。
//
// 本台架钉的是引擎侧事实（真模型验收另跑，不进硬线）：
//   F  三把「X附近」尺（板子起名 / 外派出发据点 / 设施危机近旁）＝ shared 常量
//   C  计数口径：边界 12.0 算、12.01 不算；死亡不算；手动接管 / 亲兵 / 移动中 / 路过都算；敌军不算
//   E  同一把尺：19 设施 × 多个时刻，countPlayerUnitsNear ＝ director.facilityEscalationFacts().nearbyPlayerUnits
//   D  渲染：每个设施一行都带字段（敌方、中立也印、可为 0）；既有 token 逐字节前缀不变；节头图例
//   R  重放线上那局到 43 s：中央 0 / 北线 8 / 南线 9 / 前线油库 4（实验用的那份信封）
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
import { ORIGIN_FACILITY_RADIUS } from "../packages/core/src/dispatchLedger";
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

const FACILITY_SUFFIX = / 附近我方=(\d+)单位$/;
const LEGEND = `---FACILITIES--- (附近我方=该据点 ${PLACE_NEAR_RADIUS_TILES} 格内此刻的我方单位数；各行各自计数，不可相加)`;

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
    check(`D1[${label}] 节头带图例`, hi >= 0 && lines[hi] === LEGEND, hi >= 0 ? lines[hi] : "no header");
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
  let got = { central: -1, coastal: -1, south: -1, fuel: -1 };
  for (const turn of fx.turns) {
    pumpTo(state, turn.t); view = turn.view;
    onState?.(`t${Math.round(turn.t)}`, state);
    if (Math.round(turn.t) === 43) {
      const n = (id: string) => count(state, state.facilities.get(id)!.position, PLACE_NEAR_RADIUS_TILES);
      got = { central: n("ea_player_central_post"), coastal: n("ea_player_coastal_post"), south: n("ea_player_south_post"), fuel: n("ea_fuel_depot") };
    }
    S.llm.queue = [{ kind: "text", text: turn.raw }];
    const r0 = h.requests.length;
    await h.send(turn.text, S.clientFetch);
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
  check("R5 43 s 真信封：中央前哨行印 0", / 附近我方=0单位$/.test(lineOf("ea_player_central_post")), lineOf("ea_player_central_post"));
  check("R6 43 s 真信封：北线 8、南线 9、油库 4", / 附近我方=8单位$/.test(lineOf("ea_player_coastal_post")) && / 附近我方=9单位$/.test(lineOf("ea_player_south_post")) && / 附近我方=4单位$/.test(lineOf("ea_fuel_depot")),
    [lineOf("ea_player_coastal_post"), lineOf("ea_player_south_post"), lineOf("ea_fuel_depot")].join(" | "));
  check("R7 43 s 真信封：FRONTS 中央战线行与 DISPATCHES 行原样（本刀不碰）",
    d43.includes("front_center:3. 中央战线 OurPwr=440 EnemyPwr=? OurComp=[4×main_tank,4×infantry]") &&
    d43.includes("M1 from=3. 中央战线 to=烽火台 act=defend left=8 via=G2「中央前哨附近未编组群」里派出的 home=中央前哨附近"));
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
  const n = results.filter(Boolean).length;
  console.log(`\n=== ${n === results.length ? `NEGCTL OK — ${n}/${results.length} 条 ★ 真 FAIL` : `NEGCTL BROKEN — 只有 ${n}/${results.length} 条咬住`} ===`);
  if (n !== results.length) process.exit(1);
}

main().then(() => process.exit(0), (e) => { console.error(e); process.exit(1); });
