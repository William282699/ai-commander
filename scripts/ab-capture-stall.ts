// ============================================================
// AI Commander — capture-stall bench (capture-stall-feedback-v1)
//
// 本级契约（提案 v2 §0，用户裁定 2026-07-29）：
//   ①占领圈开始往回掉的那一刻，作战处（ops/马克斯）报一句为什么——不等 180 秒；
//   ②受命占领的部队（说话下令的和鼠标右键点的都算）到圈即驻防：打完仗走回圈里，占完就地驻守；
//   ③占领判定语义（半径 1.5 / 无对抗 / 5 秒 / 半速衰减）一个字节不动。
//
// ★ 判据铁律（家法六条，逐条落在本文件）：
//   ①会动兵的断言数 assignedUnitIds + 核【实际落点坐标】，不看回执台词；
//   ②有隐藏状态的病断言状态本身（unit.state / orders[0].action / capturingTeam），位置只作旁证；
//   ③第一机制陷阱：复现出同方向症状 ≠ 破案——幅度与终点都要对齐（本文件把环值轨迹打出来）；
//   ④N0 式台架自证：先证明台架结构上表达得出"占领"，再证明它表达得出"这个病"；
//   ⑤回归测试必做负对照（T3/T6，摘掉修复必须真 FAIL）；
//   ⑥谁报的数字对方重算才作数——所以：圈内计数用本文件自己的几何算，不信引擎；
//     且 Math.random 播种使复跑逐位一致（见下）。
//
// ★ 泵帧必须镜像生产序（retreat-semantics fix1 的血教训）：
//   tick() 只做 移动/combat/regen/堑壕/清尸体。processEconomy / processReportSignals /
//   processMissions / processEnemyAI / processDefensiveAI / processPressureDirector /
//   processAutoBehavior 全都【不在】tick() 里，只有 GameCanvas.tsx:1507-1586 依次调用。
//   建立在裸 tick() 上的泵帧跑在"占领从不推进、微行为从不运行、剧本反击从不发生"的世界里。
//
// ★ 确定性：Math.random 是全引擎唯一的不确定源（core/shared 无 Date.now / performance.now /
//   crypto；17 处 Math.random 全在 autoBehavior / enemyAI / defensiveAI / pressureDirector）。
//   本文件用 mulberry32 顶掉 Math.random 并逐个 reset 模块级状态（含 resetAttackWaveState——
//   enemyAI.ts:53 在模块加载时抽过一次 nextWaveTime，静态 import 抢在播种之前，reset 重抽即密封）。
//   → 同 --seed 复跑逐位一致；断言仍只写稳健性质，换种子也该过。
//
// ★ 两臂制（用户+Fable 设计级点头 2026-07-29，理由必须留档）：
//   实施前用真剧本试了 7 次，【真剧本打不出"进度涨到峰值再停住"】——因为地图上到处是自己人：
//   全局池派兵会抓 27-30 个（圈里永远有人，5 秒必占下）；换小队后又发现前哨自带守军
//   （就算把设施设成敌方所有、只派 3 人，圈里仍站着 7-8 个原有我方单位）；把守军也清掉之后
//   小队直接被守军打残（2 死 1 个低血量撤退 69 格回家），变成"任务永远 0%"另一种形态。
//   "涨到峰值再停"需要一个很窄的窗口（圈里刚好只有派去的那几个人、刚好推到大半、刚好被拉走或被堵），
//   真实一局会自然撞到（用户 2026-07-18 就撞到了），但要【确定性】造出来绕不开脚本化。
//   所以分两臂，各自诚实标注：
//     主臂 MAIN（真剧本 + 真 AI，零脚本化）＝占完全员漂走：占下来 → 全队离圈 7-9 格站住 →
//       200 秒不回 → 空城被敌军晃回来夺走。刀B 的直接靶子，可比对坐标。
//     副臂 SCRIPT（脚本化，标注为脚本化及理由）＝进度掉光冻结：推到 ≥0.7 → 圈被占/被空 →
//       8 秒掉光 → 任务条冻在末值 → 180 秒静默。刀A 的直接靶子，也最贴用户记忆的终态。
//   记账（不在本刀治，勿扩范围）：小队被打光/低血量跑光 → 进度从未涨过 → 刀A 的"从峰值回落"
//   天生不触发 → 仍是 180 秒后一句"卡在 0%"。要治得靠"指派单位全没了"另一条判据。
//
// ★ 一手现场（提案 v2 §1，记忆档 project_capture_stall_provenance）：
//   ROADMAP 里那个"占领圈 80% 静默卡死"的 80% 是转述产物。用户 2026-07-18 22:44 原话是
//   「让 carter 夺回中央前哨…把敌军打跑了…蓝色圈圈到最后剩大概 20% 的时候突然不转了」，
//   设施＝ea_player_central_post（他自己的前哨，当时已被敌占，故"夺回"），且他看的是
//   【蓝色圆环】(rendererCanvas.ts:406) 不是任务条。环从不"冻结"（要么锯齿悬停要么 8 秒掉光后
//   整个不画）；"冻结"只存在于任务条（missions.ts:194 带守卫的单向镜像）。两个口径分开断言。
//
// Modes:
//   --synthetic       确定性断言（默认）
//   --seed=N          换种子复跑（默认 1；主臂稳定性用 --sweep）
//   --sweep           主臂跨 3 个种子跑一遍，报稳定性
//   --print-snapshot  打印改前到达行为快照 + 环值轨迹（刀B/刀A 落地前的基线）
// ============================================================

import {
  createInitialGameState, tick, processEconomy, processReportSignals, processMissions,
  processEnemyAI, processDefensiveAI, processPressureDirector, processAutoBehavior,
  resetReportSignals, resetAutoBehaviorTimer, resetEnemyAITimer, resetEnemyProdToggle,
  resetAttackWaveState, resetDefensiveAITimer, resetPressureDirector, resetMissionCounter,
  resetEngagementCache, resetWarPhaseTimers, updateFog, resolveIntent, applyOrders,
  applyPlayerCommands, selectEscalationEvent,
} from "@ai-commander/core";
import type { GameState, Unit, Facility, Intent, Order, ReportEvent } from "@ai-commander/shared";

// ── 0. Harness ──

let failCount = 0;
function check(name: string, ok: boolean, detail = ""): void {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok || !detail ? "" : ` — ${detail}`}`);
  if (!ok) failCount++;
}
function info(line: string): void {
  console.log(`     · ${line}`);
}

/** mulberry32 — 顶掉 Math.random 让整条 AI 链可复现。 */
function seedRandom(seed: number): void {
  let a = seed >>> 0;
  Math.random = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 每个场景前把全部模块级状态清干净（顺序无关，但必须一个不漏）。 */
function resetAll(seed: number): void {
  seedRandom(seed);
  resetReportSignals();
  resetAutoBehaviorTimer();
  resetEnemyAITimer();
  resetEnemyProdToggle();
  resetAttackWaveState();   // 重抽 enemyAI.ts:53 那次模块加载期的 Math.random
  resetDefensiveAITimer();
  resetPressureDirector();
  resetMissionCounter();
  resetEngagementCache();
  resetWarPhaseTimers();
}

/** 一帧＝生产循环序（GameCanvas.tsx:1507→1586）。
 *
 *  ★ 省了什么、为什么（Fable commit① 审核账①——撤退语义的教训正是"省略不可见"）：
 *    不含 updateBattleMarkers / updateGamePhase / checkGameOver / updateTasks /
 *    processAdvisorTriggers+checkDoctrines / applyEndgamePressure。
 *    理由：它们都不喂本 bench 的任何断言——relatedEvents 只认 facId/missionId；
 *    gameOver 恒 false（不调 checkGameOver）反而让各 processor 的 `if (gameOver) return`
 *    早退闸永不触发，即"跑得比生产更满"而非更少；advisor/doctrine 层只产对话消息不动兵。
 *    一旦某条断言开始依赖战况阶段、任务栏或 ENDGAME 消耗，必须先把对应处理器加回来。
 */
function step(s: GameState, dt: number): void {
  tick(s, dt);
  processEconomy(s, dt);
  processReportSignals(s, dt);
  processMissions(s, dt);
  processEnemyAI(s, dt);
  processDefensiveAI(s, dt);
  processPressureDirector(s, dt);
  processAutoBehavior(s, dt);
}

/** 泵 seconds 秒，每 sim-秒刷一次雾（生产每帧刷；不刷雾则玩家单位全盲，接战判定失真）。 */
function pump(s: GameState, seconds: number, onFrame?: (s: GameState) => void): void {
  const dt = 0.1;
  let sinceFog = 1;
  for (let t = 0; t < seconds - 1e-9; t += dt) {
    if (sinceFog >= 1) { updateFog(s); sinceFog = 0; }
    step(s, dt);
    sinceFog += dt;
    onFrame?.(s);
  }
}

// ── 几何：本文件自己算，不用引擎的任何计数（家法⑥） ──

const CAPTURE_RADIUS = 1.5;   // economy.ts:131 的常数，故意在此重打一遍
const dist = (a: { x: number; y: number }, b: { x: number; y: number }): number =>
  Math.hypot(a.x - b.x, a.y - b.y);

function countInCircle(s: GameState, fac: Facility, team: "player" | "enemy"): number {
  let n = 0;
  s.units.forEach((u) => {
    if (u.hp <= 0 || u.state === "dead") return;
    if (u.team !== team) return;
    if (dist(u.position, fac.position) <= CAPTURE_RADIUS) n++;
  });
  return n;
}
const liveUnits = (s: GameState, ids: readonly number[]): Unit[] =>
  ids.map((id) => s.units.get(id)).filter((u): u is Unit => !!u && u.state !== "dead" && u.hp > 0);

/** 与某设施/某任务相关的事件（经济类噪声排除——它们自带 120 秒定时器，任何 ≥60 秒窗口必有）。
 *
 *  ★ 本 bench 从不排水 reportEvents，生产每帧 drainReportEvents(state, 5)（GameCanvas:1696）。
 *    （Fable commit① 审核账②）无行为分叉——泵内没有任何处理器读这个数组，它只是只写缓冲；
 *    不排水反而让整窗事件都留在原地可供断言。但【别拿它当生产等价】：真实频道分发、
 *    升级问句单槽竞争、staff-ask 冷却全在排水之后，本 bench 一概不覆盖。
 */
function relatedEvents(s: GameState, facId: string, missionId?: string): ReportEvent[] {
  return s.reportEvents.filter(
    (e) => !e.type.startsWith("ECONOMY") && (e.entityId === facId || (missionId != null && e.entityId === missionId)),
  );
}

// ── 单位模板（克隆开局真单位，避免手捏出不可能的属性） ──

let tplCache: Record<string, Unit> = {};
function template(type: string, team: "player" | "enemy"): Unit {
  const key = `${type}:${team}`;
  if (!tplCache[key]) {
    const s = createInitialGameState("el_alamein");
    let found: Unit | null = null;
    s.units.forEach((u) => { if (!found && u.team === team && u.type === type) found = u; });
    if (!found) throw new Error(`el_alamein 开局没有 ${team} 的 ${type}`);
    tplCache[key] = found;
  }
  return tplCache[key];
}
let nextId = 90000;
function addUnit(s: GameState, type: string, team: "player" | "enemy", x: number, y: number): Unit {
  const u: Unit = {
    ...structuredClone(template(type, team)),
    id: nextId++, team, position: { x, y }, state: "idle",
    orders: [], waypoints: [], target: null, attackTarget: null,
    manualOverride: false, isPlayerControlled: false,
  } as Unit;
  u.hp = u.maxHp;
  s.units.set(u.id, u);
  return u;
}

// ── 场景构造 ──

/** 真剧本：整局开局状态一字不改（85 我方 / 78 敌方 / 真 defensiveAI）。 */
function realScenario(seed: number): GameState {
  resetAll(seed);
  return createInitialGameState("el_alamein");
}

/** 脚本化：清空战场，只留真设施 + 手摆的少量单位。标注为脚本化，理由见文件头。 */
function clearedScenario(seed: number): GameState {
  resetAll(seed);
  const s = createInitialGameState("el_alamein");
  s.units.clear();
  s.squads = [];
  s.missions = [];
  return s;
}

const facOf = (s: GameState, id: string): Facility => {
  const f = s.facilities.get(id);
  if (!f) throw new Error(`没有设施 ${id}`);
  return f;
};

// ════════════════════════════════════════════════════════════
// N0 · 台架自证（先于一切：它结构上表达得出"占领"和"这个病"吗）
// ════════════════════════════════════════════════════════════

function N0a_healthyCaptureIsExpressible(): void {
  console.log("\n── N0a 台架表达得出「占领」：无对抗满圈 5 秒、设施易主 ──");
  const s = clearedScenario(1);
  const fac = facOf(s, "ea_alamein_town");
  const ids = [0, 1, 2].map((i) => addUnit(s, "infantry", "player", fac.position.x + 0.3 * i, fac.position.y).id);

  const before = fac.team;
  let flippedAt = -1;
  const t0 = s.time;
  pump(s, 12, (st) => { if (flippedAt < 0 && fac.team === "player") flippedAt = st.time - t0; });

  check("N0a 圈内 3 人无对抗 → 设施翻给我方", fac.team === "player",
    `before=${before} after=${fac.team}`);
  check("N0a 满圈耗时 ≈ CAPTURE_TIME_SEC(5)", flippedAt >= 4.8 && flippedAt <= 5.4,
    `实测 ${flippedAt.toFixed(2)}s`);
  check("N0a 我方 3 人全在圈内（本文件自算几何）", countInCircle(s, fac, "player") === ids.length,
    `圈内 ${countInCircle(s, fac, "player")}/${ids.length}`);
}

function N0b_stallIsExpressible(): void {
  console.log("\n── N0b 台架表达得出「这个病」：敌兵入圈 → 进度回落 ──");
  const s = clearedScenario(1);
  const fac = facOf(s, "ea_alamein_town");
  for (let i = 0; i < 3; i++) addUnit(s, "infantry", "player", fac.position.x + 0.3 * i, fac.position.y);
  // 推到 0.8 就停手（不让它占下来）
  let peak = 0;
  pump(s, 4.0, () => { if (fac.captureProgress > peak) peak = fac.captureProgress; });
  const atInject = fac.captureProgress;
  check("N0b 注入前进度已过半（台架推得动进度）", atInject >= 0.7, `prog=${atInject.toFixed(2)}`);

  // 一辆满血主战坦克进圈：无对抗条件破了 → 必须回落
  addUnit(s, "main_tank", "enemy", fac.position.x, fac.position.y);
  pump(s, 2.0);
  check("N0b 敌兵入圈后进度回落（台架表达得出这个病）", fac.captureProgress < atInject,
    `${atInject.toFixed(2)} → ${fac.captureProgress.toFixed(2)}`);
  check("N0b 回落期间 capturingTeam 仍是 player（静默成因的前提）", fac.capturingTeam === "player",
    `capTeam=${fac.capturingTeam}`);
}

// ════════════════════════════════════════════════════════════
// T1-MAIN · 真剧本 RED 基线：占完没人回岗，空城无人告知
//
// ★ 这是【病的断言】，不是【药的断言】：commit ① 的 T1 必须在 main 上 PASS。
//   刀B 落地后（commit ②）它理应翻转——届时这些断言改写成 T2 的反面（空城 ≈ 0 秒、
//   部队回圈驻防），本节的数字冻成基线常量（同 EXPECTED_ARRIVAL 的做法），
//   并由 T3 负对照（注释掉刀B）证明它能重新 FAIL。不留永久失败的测试。
// ════════════════════════════════════════════════════════════

interface MainArmResult {
  seed: number;
  capturedAt: number;
  minDistEnd: number;
  maxDistEnd: number;
  inCircleEnd: number;
  survivors: number;
  assigned: number;
  everReenteredAfter60s: boolean;
  lostBack: boolean;
  silentWindowSec: number;
  /** 占领成功后，"圈内我方 = 0"连续持续的最长秒数——刀B 要消掉的就是这个空窗。
   *  比"终态离圈几格"稳健得多：终态是单帧快照，会被最后一次抖动整个改写。 */
  longestEmptySec: number;
  emptyFractionPct: number;
  /** 存活的指派单位里，处于「defending + 持久 defend 单 + 锚点在圈内」的比例——刀B 的机制本身
   *  （家法②：有隐藏状态的病断言状态本身；空城时长只是它的下游代理，还混着合法的出击往返）。 */
  defendingAtPostPct: number;
  /** 占领成功之后该设施还被 CONTESTED / LOST 过几次（改前 seed1 是 +118s 被抢、198s 丢掉）。 */
  contestedOrLostAfterCapture: number;
}

function runMainArm(seed: number, verbose: boolean): MainArmResult {
  const s = realScenario(seed);
  const facId = "ea_alamein_town";
  const fac = facOf(s, facId);

  // 真实节奏：先让雾/AI 跑 2 秒，玩家看到情况才下令
  pump(s, 2);
  const r = resolveIntent({ type: "capture", targetFacility: facId, quantity: "some" } as Intent, s, s.style);
  const assigned = (r as { assignedUnitIds?: number[] }).assignedUnitIds ?? [];
  applyOrders(s, r.orders);
  const missionId = s.missions[0]?.id;

  const t0 = s.time;
  let capturedAt = -1;
  pump(s, 120, (st) => { if (capturedAt < 0 && fac.team === "player") capturedAt = st.time - t0; });

  // 占下来之后再跑 120 秒，看部队回不回岗；同时量"空城"时长（每 sim-秒采样一次）
  let reentered = false;
  const tAfter = s.time;
  let emptyRun = 0, longestEmpty = 0, emptySamples = 0, samples = 0, lastSample = -1;
  pump(s, 120, (st) => {
    if (st.time - tAfter > 60 && countInCircle(st, fac, "player") > 0) reentered = true;
    const sec = Math.floor(st.time - tAfter);
    if (sec !== lastSample) {
      lastSample = sec;
      samples++;
      if (countInCircle(st, fac, "player") === 0) {
        emptySamples++; emptyRun++;
        if (emptyRun > longestEmpty) longestEmpty = emptyRun;
      } else emptyRun = 0;
    }
  });

  const alive = liveUnits(s, assigned);
  const dists = alive.map((u) => dist(u.position, fac.position));
  const rel = relatedEvents(s, facId, missionId);
  const afterCapture = rel.filter((e) => e.time > t0 + Math.max(capturedAt, 0) + 1);
  const firstAfter = afterCapture[0];

  const res: MainArmResult = {
    seed,
    capturedAt,
    minDistEnd: dists.length ? Math.min(...dists) : -1,
    maxDistEnd: dists.length ? Math.max(...dists) : -1,
    inCircleEnd: countInCircle(s, fac, "player"),
    survivors: alive.length,
    assigned: assigned.length,
    everReenteredAfter60s: reentered,
    lostBack: fac.team !== "player",
    silentWindowSec: firstAfter ? firstAfter.time - (t0 + Math.max(capturedAt, 0)) : s.time - (t0 + Math.max(capturedAt, 0)),
    longestEmptySec: longestEmpty,
    emptyFractionPct: samples ? Math.round((emptySamples / samples) * 100) : -1,
    // ★ 只看【持久 defend 单 + 锚点在圈内】，不看 unit.state：
    //   开火时 state 是 "attacking"，脱战后 combat.ts:209-217 才翻回 "defending"。
    //   首版把 state==="defending" 也写进判据 → seed=1 量出"驻岗 0%"，而同一帧圈内站着 10 个人、
    //   离圈 1.0~1.5 格。瞬时 state 是抖动量，那张单子才是决定它会不会回来的耐久状态。
    defendingAtPostPct: alive.length
      ? Math.round((alive.filter((u) =>
          u.orders[0]?.action === "defend" &&
          !!u.orders[0]?.target && dist(u.orders[0].target!, fac.position) <= CAPTURE_RADIUS,
        ).length / alive.length) * 100)
      : -1,
    contestedOrLostAfterCapture: rel.filter(
      (e) => e.time > t0 + Math.max(capturedAt, 0) + 1 &&
        (e.type === "FACILITY_CONTESTED" || e.type === "FACILITY_LOST"),
    ).length,
  };

  if (verbose) {
    info(`seed=${seed} 派出 ${assigned.length} 个单位，占下来用 ${capturedAt.toFixed(1)}s`);
    info(`240s 后：存活 ${alive.length}/${assigned.length}，离圈 ${res.minDistEnd.toFixed(1)}~${res.maxDistEnd.toFixed(1)} 格，圈内我方 ${res.inCircleEnd}`);
    info(`★空城：占领后 120 秒里圈内无我方占 ${res.emptyFractionPct}%，最长连续 ${res.longestEmptySec}s`);
    info(`占领后是否有单位再进过圈（>60s 窗口）：${reentered ? "有" : "没有"}；设施终态 ${fac.team}`);
    info(`占领成功后与该设施相关的下一条事件：${firstAfter ? `${firstAfter.type}@+${res.silentWindowSec.toFixed(0)}s "${firstAfter.message}"` : "(无)"}`);
    info(`全部相关事件：${rel.map((e) => `${e.type}@${e.time.toFixed(0)}s`).join(" | ") || "(零条)"}`);
  }
  return res;
}

/** commit ① 在【未修引擎】(b73d973 + bench) 上测得并经 Fable 逐位复算的病态基线。
 *  刀B 落地后这些数必须垮掉——T2 断言的就是"垮掉"，T3 负对照断言"把刀B 注释掉就回到这里"。 */
const PRE_FIX_MAIN = {
  capturedAtSec: 72.0,                       // 三种子完全一致（行军时间主导）
  longestEmptySec: { s1: 35, s7: 36, s1337: 27 },
  emptyFractionPct: { s1: 29, s7: 57, s1337: 66 },
  silentWindowSec: { s1: 118, s7: 71, s1337: 76 },
} as const;

function T2_main(seed: number): void {
  console.log("\n── T2-MAIN 刀B 效果（真剧本，零脚本化）：占完有人守 ──");
  const r = runMainArm(seed, true);
  info(`改前基线（commit ① 实测，Fable 已复算）：空城最长 ${PRE_FIX_MAIN.longestEmptySec.s1}/` +
    `${PRE_FIX_MAIN.longestEmptySec.s7}/${PRE_FIX_MAIN.longestEmptySec.s1337}s、` +
    `占比 ${PRE_FIX_MAIN.emptyFractionPct.s1}/${PRE_FIX_MAIN.emptyFractionPct.s7}/${PRE_FIX_MAIN.emptyFractionPct.s1337}%`);

  const preLongest = PRE_FIX_MAIN.longestEmptySec[`s${seed}` as keyof typeof PRE_FIX_MAIN.longestEmptySec];

  check("T2-MAIN 占领仍然成功（刀B 不该拖慢占领本身）", r.capturedAt > 0,
    `capturedAt=${r.capturedAt.toFixed(1)}s（改前 ${PRE_FIX_MAIN.capturedAtSec}s）`);
  check("T2-MAIN 存活单位仍有", r.survivors > 0, `存活 ${r.survivors}/${r.assigned}`);
  // ★ 机制断言排第一（家法②）：耐久状态＝那张锚在圈内的 defend 单。
  check("T2-MAIN ★存活的指派单位全都持有锚在圈内的持久 defend 单（岗位本身）",
    r.defendingAtPostPct === 100, `${r.defendingAtPostPct}%`);
  check("T2-MAIN ★占领之后该设施再没被 CONTESTED / LOST 过（改前 seed=1 是 +118s 被抢、198s 丢掉）",
    r.contestedOrLostAfterCapture === 0, `${r.contestedOrLostAfterCapture} 次`);
  // 空城时长：门槛先量后定（改前 35/36/27s → 改后 11/13/18s，三种子逐个严格下降）。
  check("T2-MAIN 长段弃守消失：最长连续空城 ≤20 秒（改前 27-36s，改后实测 11-18s）",
    r.longestEmptySec <= 20, `最长 ${r.longestEmptySec}s`);
  check(`T2-MAIN 最长空城严格小于改前同种子（${preLongest}s）`,
    preLongest === undefined || r.longestEmptySec < preLongest,
    `改后 ${r.longestEmptySec}s vs 改前 ${preLongest}s`);
  info(`空城【占比】29/57/66% → 26/37/33%：只小幅下降，且【不作断言】——剩下的空窗是驻防单位` +
    `合法出击往返（defend 允许迎击射程内威胁，脱战再回岗），不是弃守。本刀治的是"回不回来"，` +
    `不是"一步不离"（接战方式属手感，用户 07-29 裁定押后）。`);
  info(`（终态离圈 ${r.minDistEnd.toFixed(1)}~${r.maxDistEnd.toFixed(1)} 格、圈内 ${r.inCircleEnd} 人；` +
    `静默 ${r.silentWindowSec.toFixed(0)}s——静默归刀A 治，本 commit 不动）`);
}

function T2_main_sweep(): void {
  console.log("\n── T2-MAIN 稳定性：跨种子复跑（换种子应仍成立） ──");
  const seeds = [1, 7, 1337];
  const rows = seeds.map((sd) => runMainArm(sd, false));
  for (const r of rows) {
    info(`seed=${r.seed} 占领@${r.capturedAt.toFixed(1)}s 存活${r.survivors}/${r.assigned} 驻岗${r.defendingAtPostPct}% 抢/丢${r.contestedOrLostAfterCapture}次 ` +
      `空城最长${r.longestEmptySec}s(${r.emptyFractionPct}%) 终态离圈${r.minDistEnd.toFixed(1)}~${r.maxDistEnd.toFixed(1)} ` +
      `圈内${r.inCircleEnd} 终态${r.lostBack ? "被夺回" : "仍我方"} 静默${r.silentWindowSec.toFixed(0)}s`);
  }
  check("T2-MAIN 三个种子都：占领成功 + 全员持有圈内 defend 单 + 设施再没被抢/丢 + 最长空城 ≤20s",
    rows.every((r) => r.capturedAt > 0 && r.defendingAtPostPct === 100 &&
      r.contestedOrLostAfterCapture === 0 && r.longestEmptySec <= 20),
    rows.map((r) => `s${r.seed}:驻岗${r.defendingAtPostPct}%/抢丢${r.contestedOrLostAfterCapture}/空${r.longestEmptySec}s`).join(" "));
}

// ════════════════════════════════════════════════════════════
// T1-SCRIPT · 脚本化 RED 基线：掉光、冻结、180 秒静默
//   S1 = 敌人赖在圈里（原始诊断的第 2 种可能："打跑≠打死"）
//   S2 = 圈子空了（原始诊断的第 1 种可能：人打完架没回旗下）
// ════════════════════════════════════════════════════════════

interface ScriptArmResult {
  peak: number;
  zeroAfterSec: number;
  missionFrozenAt: number;
  missionStatus: string;
  survivorsOutside: number;
  survivors: number;
  firstRelatedAfterStallSec: number;
  firstRelatedType: string;
  /** 刀A 的产物：停滞后发出的 CAPTURE_STALLED（时间相对停滞起点） */
  stalls: Array<{ atSec: number; entityId?: string; message: string }>;
  /** 发第一条时环还剩多少（>0 就是"没等掉光就说话了"） */
  progressAtFirstStall: number;
  trajectory: Array<[number, number]>;
}

function runScriptArm(mode: "S1" | "S2", seed: number): ScriptArmResult {
  const s = clearedScenario(seed);
  const facId = "ea_alamein_town";
  const fac = facOf(s, facId);
  for (let i = 0; i < 3; i++) addUnit(s, "infantry", "player", fac.position.x + 0.35 * i, fac.position.y);

  // 走真解析器下令：order 必须带 targetFacilityId（刀B 的闸门要它），并建真 mission
  const r = resolveIntent({ type: "capture", targetFacility: facId, quantity: "all" } as Intent, s, s.style);
  const assigned = (r as { assignedUnitIds?: number[] }).assignedUnitIds ?? [];
  applyOrders(s, r.orders);
  const missionId = s.missions[0]?.id;

  // 推到 ≥0.7
  let peak = 0;
  const traj: Array<[number, number]> = [];
  const t0 = s.time;
  pump(s, 4.0, (st) => {
    if (fac.captureProgress > peak) peak = fac.captureProgress;
    traj.push([st.time - t0, fac.captureProgress]);
  });

  const tStall = s.time;
  if (mode === "S1") {
    // 敌残兵晃回圈里：满血主战坦克（不会一挨打就低血量自撤），我方仍站在圈里
    addUnit(s, "main_tank", "enemy", fac.position.x, fac.position.y);
  } else {
    // 圈子空了：我方被拉到 4 格外（真机制是 autoBehavior 4a/4b/4c 拖走，见文件头；
    // 这里直接把终态摆出来，因为本臂测的是"圈空之后引擎说不说话"，不是"怎么被拖走的"）
    for (const u of liveUnits(s, assigned)) {
      u.position = { x: fac.position.x + 4, y: fac.position.y + 1 };
      u.orders = []; u.target = null; u.waypoints = []; u.state = "idle";
    }
  }

  let zeroAt = -1;
  let progressAtFirstStall = -1;
  const noteFirstStall = (st: GameState): void => {
    if (progressAtFirstStall >= 0) return;
    if (st.reportEvents.some((e) => e.type === "CAPTURE_STALLED" && e.entityId === facId)) {
      progressAtFirstStall = fac.captureProgress;
    }
  };
  pump(s, 20, (st) => {
    if (fac.captureProgress > peak) peak = fac.captureProgress;
    traj.push([st.time - t0, fac.captureProgress]);
    if (zeroAt < 0 && fac.captureProgress === 0) zeroAt = st.time - tStall;
    noteFirstStall(st);
  });
  const frozen = s.missions[0]?.progress ?? -1;

  pump(s, 200, noteFirstStall);

  const rel = relatedEvents(s, facId, missionId).filter((e) => e.time >= tStall);
  const alive = liveUnits(s, assigned);
  return {
    stalls: s.reportEvents
      .filter((e) => e.type === "CAPTURE_STALLED" && e.entityId === facId)
      .map((e) => ({ atSec: e.time - tStall, entityId: e.entityId, message: e.message })),
    progressAtFirstStall,
    peak,
    zeroAfterSec: zeroAt,
    missionFrozenAt: frozen,
    missionStatus: s.missions[0]?.status ?? "-",
    survivors: alive.length,
    survivorsOutside: alive.filter((u) => dist(u.position, fac.position) > CAPTURE_RADIUS).length,
    firstRelatedAfterStallSec: rel.length ? rel[0].time - tStall : -1,
    firstRelatedType: rel.length ? rel[0].type : "(无)",
    trajectory: traj,
  };
}

/** commit ① 在【未修引擎】上测得、Fable 已复算的 S2 病态基线。刀A 落地后这些数必须垮掉。 */
const PRE_FIX_SCRIPT = {
  silentSec: 170,          // 停滞后 170 秒内与该设施/任务相关的事件：零条
  firstWordAtSec: 188,     // 唯一那句话 MISSION_STALLED，字面"卡在 0%"
  missionFrozenAt: 0.010,  // 任务条冻在末值、status 仍 active
} as const;

// S1（敌人赖在圈里）为什么不在 commit ① 里：
//   要让"敌兵占着圈"这个状态【持续】200 秒以观察静默，就得让双方都活着僵持——而引擎两边都不肯僵持：
//   敌方 autoBehavior 4a 会冲出来打我方（isThreatInAction 命中"orders[0].targetFacilityId != null"，
//   我方占领单正好带这个字段），主战坦克 25 秒打光 3 个步兵 → 触发 MISSION_FAILED（这一句反而不静默了，
//   本身是个真事实：队伍打光了引擎【会】告诉你）。硬造僵持只能靠捏不会开火的单位＝伪造不可能的值。
//   → "敌在圈内"这个 reason 分支改在 commit ③ 用【短窗口检测器测试】覆盖（摆好状态跑几帧、断言 emit
//     出的原因），不需要 200 秒存活场景。commit ① 的 RED 基线用 S2（完全可控：无敌军、无战斗、无死亡）。
function T5_script(seed: number): void {
  for (const mode of ["S2"] as const) {
    const label = "圈子空了";
    console.log(`\n── T5-SCRIPT ${mode}（脚本化，理由见文件头）：${label} ──`);
    const r = runScriptArm(mode, seed);

    info(`峰值 ${r.peak.toFixed(2)} → 掉光耗时 ${r.zeroAfterSec.toFixed(2)}s；` +
      `任务条冻在 ${r.missionFrozenAt.toFixed(3)}（status=${r.missionStatus}）`);
    info(`停滞后第一条相关事件：${r.firstRelatedType}@+${r.firstRelatedAfterStallSec.toFixed(0)}s`);

    check(`${mode} 进度先推到 ≥0.7（有峰值才谈得上回落）`, r.peak >= 0.7, `peak=${r.peak.toFixed(2)}`);
    check(`${mode} 半速衰减：峰值→0 的耗时 ≈ peak×10 秒`,
      Math.abs(r.zeroAfterSec - r.peak * 10) <= 0.6,
      `实测 ${r.zeroAfterSec.toFixed(2)}s，按公式应 ${(r.peak * 10).toFixed(2)}s`);
    check(`${mode} 环最终归零（环不"冻结"——冻结只在任务条）`, r.zeroAfterSec > 0);
    check(`${mode} 任务条冻在末值且任务仍 active（单向镜像 missions.ts:194）`,
      r.missionFrozenAt > 0 && r.missionFrozenAt < 0.1 && r.missionStatus === "active",
      `frozen=${r.missionFrozenAt.toFixed(3)} status=${r.missionStatus}`);
    check(`${mode} 指派单位存活（不是死光了）`, r.survivors > 0, `存活 ${r.survivors}`);
    if (mode === "S2") {
      check("S2 存活单位全在圈外（核坐标）", r.survivorsOutside === r.survivors,
        `圈外 ${r.survivorsOutside}/${r.survivors}`);
    }
    // ── T5 刀A 效果：改前这里是 170 秒静默、188 秒才一句过期的"卡在 0%"。 ──
    info(`CAPTURE_STALLED ×${r.stalls.length}：` +
      (r.stalls.map((x) => `+${x.atSec.toFixed(1)}s`).join(" ") || "(无)") +
      `；首条发出时环还剩 ${(r.progressAtFirstStall * 100).toFixed(0)}%`);
    if (r.stalls[0]) info(`首条原文：${r.stalls[0].message}`);

    info(`改前基线（commit ① 实测，Fable 已复算）：静默 ≥${PRE_FIX_SCRIPT.silentSec}s、` +
      `第一句 MISSION_STALLED@+${PRE_FIX_SCRIPT.firstWordAtSec}s「卡在 0%」、任务条冻 ${PRE_FIX_SCRIPT.missionFrozenAt}`);
    check(`T5 ★停滞当场就说话（≤3 秒，改前是 ${PRE_FIX_SCRIPT.firstWordAtSec} 秒）`,
      r.stalls.length > 0 && r.stalls[0].atSec <= 3,
      r.stalls[0] ? `+${r.stalls[0].atSec.toFixed(2)}s` : "一条都没发");
    check("T5 ★没等掉光就说话（首条发出时环仍 >0，改前只能等归零后再等 180 秒）",
      r.progressAtFirstStall > 0, `首条时环 ${(r.progressAtFirstStall * 100).toFixed(0)}%`);
    check("T5 entityId 是设施 id（不是任务 id——按设施键控）",
      r.stalls.length > 0 && r.stalls[0].entityId === "ea_alamein_town",
      `entityId=${r.stalls[0]?.entityId}`);
    check("T5 ★复读机护栏：整个 episode 最多 2 条（220 秒窗口）",
      r.stalls.length > 0 && r.stalls.length <= 2, `实际 ${r.stalls.length} 条`);
    // 事实字段由测试【独立重算】：不信 emit 方给的数（家法⑥）。
    // S2 的构造是"我方全被挪到 4 格外、圈内无人"，所以那句话必须说"圈内已经没有我方单位"。
    check("T5 事实与测试自算的几何一致（圈内我方 0 → 文案必须说圈里没我方单位）",
      r.stalls.length > 0 && r.stalls[0].message.includes("没有我方单位"),
      r.stalls[0]?.message ?? "-");
    check("T5 旧的 MISSION_STALLED 仍在（重叠可接受，本刀不动 detectMissionStalled）",
      r.firstRelatedType === "CAPTURE_STALLED",
      `第一条现在是 ${r.firstRelatedType}@+${r.firstRelatedAfterStallSec.toFixed(0)}s`);
  }
}

// ════════════════════════════════════════════════════════════
// T2-SCRIPT · 刀B 机制（可控场景）：到达即驻防 → 被拖出去打 → 打完回岗
//   断言【状态本身】（unit.state / orders[0].action / 锚点坐标），位置只作旁证（家法②）。
// ════════════════════════════════════════════════════════════

function T2_script_defendConversion(): void {
  console.log("\n── T2-SCRIPT 刀B：到达即驻防，打完回岗 ──");
  const s = clearedScenario(1);
  const fac = facOf(s, "ea_alamein_town");
  // 摆在 8 格外 —— 必须真的走过去、真的触发到达分支（摆在圈里就测不到"到达"）
  const start = { x: fac.position.x + 8, y: fac.position.y };
  for (let i = 0; i < 3; i++) addUnit(s, "infantry", "player", start.x + 0.4 * i, start.y);

  const r = resolveIntent({ type: "capture", targetFacility: fac.id, quantity: "all" } as Intent, s, s.style);
  const assigned = (r as { assignedUnitIds?: number[] }).assignedUnitIds ?? [];
  check("T2-SCRIPT 前置：占领令带 targetFacilityId 且派出 3 个单位（数 assignedUnitIds）",
    assigned.length === 3 && r.orders[0]?.targetFacilityId === fac.id,
    `assigned=${assigned.length} tfid=${r.orders[0]?.targetFacilityId}`);
  applyOrders(s, r.orders);

  pump(s, 40);
  const arrived = liveUnits(s, assigned);
  const converted = arrived.filter((u) => u.state === "defending" && u.orders[0]?.action === "defend");
  const anchoredIn = converted.filter((u) => u.orders[0]?.target && dist(u.orders[0].target!, fac.position) <= CAPTURE_RADIUS);
  const carriesFid = converted.filter((u) => u.orders[0]?.targetFacilityId != null);

  info(`到达后：${arrived.map((u) => `${u.state}/${u.orders[0]?.action ?? "-"}`).join(" ")}`);
  check("T2-SCRIPT 到达即转 defending + 持久 defend 单（状态本身）",
    arrived.length > 0 && converted.length === arrived.length,
    `${converted.length}/${arrived.length}`);
  // ↓ 这两条必须显式要求 converted.length > 0：T3 负对照跑出来时 converted 是空集，
  //   "0 === 0" 和 "带字段的有 0 个" 都会【空转通过】——关掉修复却还 PASS 的断言等于没有断言。
  check("T2-SCRIPT defend 单锚点落在圈内（≤1.5 格）",
    converted.length > 0 && anchoredIn.length === converted.length,
    `${anchoredIn.length}/${converted.length}`);
  check("T2-SCRIPT ★新 defend 单不带 targetFacilityId（否则敌方 4a isThreatInAction 会读到，行为分叉）",
    converted.length > 0 && carriesFid.length === 0,
    `转换 ${converted.length} 个，其中带字段的 ${carriesFid.length} 个`);
  check("T2-SCRIPT 站住了就把点占下来", fac.team === "player", `facTeam=${fac.team}`);

  // 打一架：4 格外来一个"正在行动"的敌人 → autoBehavior 4a 会把驻防单位拉出去
  const bait = addUnit(s, "infantry", "enemy", fac.position.x + 4, fac.position.y + 2);
  bait.attackTarget = assigned[0];
  let everLeft = false;
  pump(s, 45, (st) => {
    if (!everLeft && liveUnits(st, assigned).some((u) => dist(u.position, fac.position) > CAPTURE_RADIUS)) everLeft = true;
  });

  const back = liveUnits(s, assigned);
  const inCircle = back.filter((u) => dist(u.position, fac.position) <= CAPTURE_RADIUS);
  const stillDefending = back.filter((u) => u.state === "defending" && u.orders[0]?.action === "defend");
  info(`交战后：曾离岗=${everLeft ? "是" : "否"}，回圈 ${inCircle.length}/${back.length}，` +
    `离圈距离 ${back.map((u) => dist(u.position, fac.position).toFixed(1)).join("/")}`);
  check("T2-SCRIPT ★打完回岗：存活单位全部回到圈内（核实际落点坐标）",
    back.length > 0 && inCircle.length === back.length, `回圈 ${inCircle.length}/${back.length}`);
  check("T2-SCRIPT 回岗后仍持有 defend 单（岗位没丢）", stillDefending.length === back.length,
    `${stillDefending.length}/${back.length}`);
}

function T5b_mousePathConversion(): void {
  console.log("\n── T5b(B半) 鼠标右键占领：不经 resolveIntent、无 mission，刀B 照样认 ──");
  const s = clearedScenario(1);
  const fac = facOf(s, "ea_alamein_town");
  const u = addUnit(s, "infantry", "player", fac.position.x + 8, fac.position.y);
  // 逐字镜像 GameCanvas.handleFacilityCapture 修后的 order
  applyPlayerCommands(s, [{
    unitIds: [u.id], action: "attack_move",
    target: { x: fac.position.x, y: fac.position.y },
    targetFacilityId: fac.id, priority: "high",
  } as Order]);
  check("T5b 该路径确实不建 mission（所以刀A 必须按设施键控，不能按任务）", s.missions.length === 0,
    `missions=${s.missions.length}`);

  pump(s, 40);
  const cur = s.units.get(u.id)!;
  check("T5b 鼠标下的占领令到达后同样转 defending + defend 单",
    cur.state === "defending" && cur.orders[0]?.action === "defend",
    `state=${cur.state} action=${cur.orders[0]?.action}`);
  check("T5b 锚点在圈内", !!cur.orders[0]?.target && dist(cur.orders[0].target!, fac.position) <= CAPTURE_RADIUS,
    `锚点 ${cur.orders[0]?.target ? `(${cur.orders[0].target!.x.toFixed(1)},${cur.orders[0].target!.y.toFixed(1)})` : "无"}`);

  // ── T5b(A半)：同一条无 mission 的路径上，刀A 也必须发得出声 ──
  //   这是"按设施键控而不按任务"的唯一硬证据：这里 state.missions 恒为空。
  //   另起一局：上面那局单位站够 5 秒已经把点占下来了（fac.team=player），没有停滞可报——
  //   所以本段把窗口卡在【占领完成之前】把人拽走。
  const s2 = clearedScenario(1);
  const fac2 = facOf(s2, "ea_kidney_ridge");
  const u2 = addUnit(s2, "infantry", "player", fac2.position.x, fac2.position.y);
  applyPlayerCommands(s2, [{
    unitIds: [u2.id], action: "attack_move",
    target: { x: fac2.position.x, y: fac2.position.y },
    targetFacilityId: fac2.id, priority: "high",
  } as Order]);
  pump(s2, 2.5);                                  // 峰值 ~0.5，还没满
  const peak = fac2.captureProgress;
  const cur2 = s2.units.get(u2.id)!;
  cur2.position = { x: fac2.position.x + 5, y: fac2.position.y };  // 被拖走：圈子空了
  cur2.orders = []; cur2.target = null; cur2.waypoints = []; cur2.state = "idle";
  pump(s2, 3);
  const st = stallsOf(s2, fac2.id);
  info(`无 mission 路径：峰值 ${peak.toFixed(2)}，missions=${s2.missions.length}，` +
    `CAPTURE_STALLED ×${st.length}` + (st[0] ? `　首条：${st[0].message}` : ""));
  check("T5b(A半) ★无 mission 的鼠标路径照样报得出停滞（设施键控的硬证据）",
    s2.missions.length === 0 && st.length > 0 && peak >= CAPTURE_PEAK_FLOOR_MIRROR,
    `missions=${s2.missions.length} 停滞事件 ${st.length} 条 峰值 ${peak.toFixed(2)}`);
}

// ════════════════════════════════════════════════════════════
// T8 · 三条原因分支 + director 两张表接线
//   原因分支用【短窗口检测器测试】覆盖（摆好状态跑几帧、断言 emit 出的原因），
//   不造 200 秒僵持——引擎两边都不肯僵持，硬造只能捏不会开火的单位（commit ① 已论证）。
// ════════════════════════════════════════════════════════════

/** 把一个设施推到指定进度，返回 state/fac/我方单位（供三条原因分支复用）。 */
function primedCapture(seed = 1): { s: GameState; fac: Facility; us: Unit[] } {
  const s = clearedScenario(seed);
  const fac = facOf(s, "ea_alamein_town");
  const us = [0, 1, 2].map((i) => addUnit(s, "infantry", "player", fac.position.x + 0.3 * i, fac.position.y));
  pump(s, 3.0);   // ~0.6，安全越过 0.25 峰值门槛且未满
  return { s, fac, us };
}

function T8_reasonBranches(): void {
  console.log("\n── T8 三条原因分支（短窗口，不造 200 秒僵持） ──");

  // ① 圈里没人了
  {
    const { s, fac, us } = primedCapture();
    us.forEach((u) => { u.position = { x: fac.position.x + 6, y: fac.position.y }; u.orders = []; u.state = "idle"; });
    pump(s, 1.0);
    const st = stallsOf(s, fac.id);
    info(`①圈内无人：${st[0]?.message ?? "(无)"}`);
    check("T8① 圈内无我方 → 原因说「圈内已经没有我方单位」",
      st.length === 1 && st[0].message.includes("没有我方单位") && !st[0].message.includes("敌军还有"),
      st[0]?.message ?? "-");
  }

  // ② 敌人还在圈里（我方也在，双方僵持 → capTeam 变 null → 回落）
  {
    const { s, fac } = primedCapture();
    addUnit(s, "main_tank", "enemy", fac.position.x, fac.position.y);
    pump(s, 1.0);
    const st = stallsOf(s, fac.id);
    const mine = countInCircle(s, fac, "player");
    const theirs = countInCircle(s, fac, "enemy");
    info(`②敌在圈内（我方${mine}/敌${theirs}）：${st[0]?.message ?? "(无)"}`);
    // 事实字段由测试独立重算（家法⑥）：文案里的两个数必须等于本文件自己数出来的
    check("T8② 敌军入圈 → 原因报圈内双方人头，且与测试自算的几何逐个相等",
      st.length === 1 && st[0].message.includes(`我方 ${mine} 个、敌军 ${theirs} 个`),
      `自算 我方${mine}/敌${theirs}；文案「${st[0]?.message ?? "-"}」`);
  }

  // ③ 对方反占（中立设施才可能：capTeam 要求 fac.team !== "enemy"）
  {
    const s = clearedScenario(1);
    const fac = facOf(s, "ea_fuel_depot");     // 开局 neutral
    const us = [0, 1, 2].map((i) => addUnit(s, "infantry", "player", fac.position.x + 0.3 * i, fac.position.y));
    pump(s, 3.0);
    const peak = fac.captureProgress;
    us.forEach((u) => { u.position = { x: fac.position.x + 8, y: fac.position.y }; u.orders = []; u.state = "idle"; });
    addUnit(s, "main_tank", "enemy", fac.position.x, fac.position.y);
    pump(s, 1.0);
    const st = stallsOf(s, fac.id);
    info(`③对方反占（峰值 ${peak.toFixed(2)}，capTeam=${fac.capturingTeam}）：${st[0]?.message ?? "(无)"}`);
    check("T8③ 敌方接管圈子 → 原因说「对方已开始反向占领」（★这条分支若挂在 capturingTeam==='player' 下就是死代码）",
      fac.capturingTeam === "enemy" && st.length === 1 && st[0].message.includes("反向占领"),
      `capTeam=${fac.capturingTeam}；${st[0]?.message ?? "-"}`);
  }

  // ③b episode 重置（用户/Fable 裁定的预算规则）：玩家二次派兵把进度推过历史峰值 →
  //     预算重置，下一次弃守【必须】再说得出话。实施时我一度改成"不重置"，实测证伪后改回。
  {
    const { s, fac, us } = primedCapture();           // 第一次推到 ~0.6
    const home = us.map((u) => ({ ...u.position }));
    const away = { x: fac.position.x + 8, y: fac.position.y };
    us.forEach((u) => { u.position = { ...away }; u.orders = []; u.state = "idle"; });
    pump(s, 150);                                     // 掉光 + 长静默（跨过 60 秒冷却）
    const firstRound = stallsOf(s, fac.id).length;
    us.forEach((u, i) => { u.position = { ...home[i] }; });
    pump(s, 4.0);                                     // 二次推进，越过历史峰值
    const peak2 = fac.captureProgress;
    us.forEach((u) => { u.position = { ...away }; });
    pump(s, 3);                                       // 又弃守
    const total = stallsOf(s, fac.id).length;
    info(`③b 二次占领：第一轮 ${firstRound} 条 → 二次推到 ${peak2.toFixed(2)} 再弃守 → 累计 ${total} 条`);
    check("T8③b 越过历史峰值 → episode 重置 → 二次弃守仍报得出（预算不是一局一次）",
      peak2 > 0.6 && total > firstRound, `${firstRound} → ${total}`);
  }

  // ④ director 两张表：Partial Record 不强制，漏了不会 typecheck 报错，只会永远输
  {
    const s = clearedScenario(1);
    const fac = facOf(s, "ea_alamein_town");
    const capture: ReportEvent = {
      type: "CAPTURE_STALLED", time: 10, message: "x", severity: "warning",
      entityId: fac.id, actionRequired: true,
    };
    const mission: ReportEvent = {
      type: "MISSION_STALLED", time: 10, message: "y", severity: "warning",
      entityId: "m1", actionRequired: true,
    };
    const picked = selectEscalationEvent(s, [mission, capture]);
    check("T8④ ESCALATION_TYPE_PRIORITY 条目生效：同 severity 下 CAPTURE_STALLED(2) 压过 MISSION_STALLED(1)",
      picked?.type === "CAPTURE_STALLED", `选中 ${picked?.type}`);
    // eventFrontId 的设施 case：设施 → regionId → front。这里独立重算一遍映射存在性，
    // 否则该 case 返回 null，事件永远拿不到"导演本拍前线"的 +1000。
    const front = s.fronts.find((f) => f.regionIds.includes(fac.regionId));
    check("T8④ eventFrontId 的设施 case 有得可解（设施 regionId 能映射到前线）",
      !!front, `regionId=${fac.regionId} → ${front?.id ?? "null"}`);
  }
}

// ════════════════════════════════════════════════════════════
// T7 · 刀A 不误报（四种"看起来像回落、其实不是"的情形）
// ════════════════════════════════════════════════════════════

const stallsOf = (s: GameState, facId: string): ReportEvent[] =>
  s.reportEvents.filter((e) => e.type === "CAPTURE_STALLED" && e.entityId === facId);

function T7_noFalsePositives(): void {
  console.log("\n── T7 刀A 不误报 ──");

  // ① 健康占领：成功那一帧环值也是 0.98 → 0（满格清零）。纯"从峰值回落"判据必踩。
  {
    const s = clearedScenario(1);
    const fac = facOf(s, "ea_alamein_town");
    for (let i = 0; i < 3; i++) addUnit(s, "infantry", "player", fac.position.x + 0.3 * i, fac.position.y);
    pump(s, 20);
    check("T7① 健康占领全程零 CAPTURE_STALLED（★完成态护栏：成功当帧也是 0.98→0）",
      fac.team === "player" && stallsOf(s, fac.id).length === 0,
      `facTeam=${fac.team} 报了 ${stallsOf(s, fac.id).length} 条`);
  }

  // ② 行军途中：进度从未启动
  {
    const s = clearedScenario(1);
    const fac = facOf(s, "ea_alamein_town");
    const u = addUnit(s, "infantry", "player", fac.position.x + 40, fac.position.y);
    applyPlayerCommands(s, [{
      unitIds: [u.id], action: "attack_move", targetFacilityId: fac.id,
      target: { x: fac.position.x, y: fac.position.y }, priority: "high",
    } as Order]);
    pump(s, 20);
    const cur = s.units.get(u.id)!;
    const stillMarching = dist(cur.position, fac.position) > CAPTURE_RADIUS;
    // 前提也要断言：首版摆 20 格、泵 15 秒，人早就走到并开始占了（进度 0.60），
    // 这条测的就不再是"途中"。零误报是真的，前提是假的——前提假的绿灯不算数。
    check("T7② 行军途中（尚未进圈、进度未启动）零 CAPTURE_STALLED",
      stillMarching && fac.captureProgress === 0 && stallsOf(s, fac.id).length === 0,
      `离圈 ${dist(cur.position, fac.position).toFixed(1)} prog=${fac.captureProgress.toFixed(2)} 报了 ${stallsOf(s, fac.id).length} 条`);
  }

  // ③ 路过：蹭出一点进度就走（峰值 < 0.25 门槛）
  {
    const s = clearedScenario(1);
    const fac = facOf(s, "ea_alamein_town");
    const u = addUnit(s, "infantry", "player", fac.position.x, fac.position.y);
    pump(s, 0.8);                       // ~0.16
    const peak = fac.captureProgress;
    u.position = { x: fac.position.x + 10, y: fac.position.y };
    pump(s, 30);
    check("T7③ 路过设施（峰值 <0.25）零 CAPTURE_STALLED",
      peak > 0 && peak < CAPTURE_PEAK_FLOOR_MIRROR && stallsOf(s, fac.id).length === 0,
      `峰值 ${peak.toFixed(2)} 报了 ${stallsOf(s, fac.id).length} 条`);
  }

  // ④ 抖动：推到 0.5 后有人挪出圈 3 帧再回来（落差 0.03 < 0.05 门槛）
  {
    const s = clearedScenario(1);
    const fac = facOf(s, "ea_alamein_town");
    const us = [0, 1, 2].map((i) => addUnit(s, "infantry", "player", fac.position.x + 0.3 * i, fac.position.y));
    pump(s, 2.5);                       // ~0.5
    const peak = fac.captureProgress;
    const home = us.map((u) => ({ ...u.position }));
    us.forEach((u) => { u.position = { x: fac.position.x + 5, y: fac.position.y }; });
    pump(s, 0.3);                       // 3 帧 → 掉 0.03
    const dip = peak - fac.captureProgress;
    us.forEach((u, i) => { u.position = home[i]; });
    pump(s, 3);
    check("T7④ 单位挪出圈 3 帧的抖动（落差 <0.05）零 CAPTURE_STALLED",
      dip > 0 && dip < CAPTURE_DROP_FLOOR_MIRROR && stallsOf(s, fac.id).length === 0,
      `落差 ${dip.toFixed(3)} 报了 ${stallsOf(s, fac.id).length} 条`);
  }
}

/** 门槛在引擎里（reportSignals.ts），此处故意重打一遍供断言用——数值漂了就该有人发现。 */
const CAPTURE_PEAK_FLOOR_MIRROR = 0.25;
const CAPTURE_DROP_FLOOR_MIRROR = 0.05;

// ════════════════════════════════════════════════════════════
// 刀A 的误报陷阱：占领【成功】那一帧 progress 是 0.98 → 0（economy.ts:152 满格清零）
// 纯"从峰值回落"判据会在玩家占下来的瞬间喊"停滞"。此处把这一帧钉成基线事实。
// ════════════════════════════════════════════════════════════

function T0_successLooksLikeADrop(): void {
  console.log("\n── 陷阱基线：占领成功的那一帧，环值也是「从峰值掉到 0」 ──");
  const s = clearedScenario(1);
  const fac = facOf(s, "ea_alamein_town");
  for (let i = 0; i < 3; i++) addUnit(s, "infantry", "player", fac.position.x + 0.3 * i, fac.position.y);

  let prev = 0, peakBeforeFlip = 0, dropAtFlip = -1;
  pump(s, 8, () => {
    if (fac.team !== "player") { prev = fac.captureProgress; if (prev > peakBeforeFlip) peakBeforeFlip = prev; }
    else if (dropAtFlip < 0) dropAtFlip = peakBeforeFlip - fac.captureProgress;
  });
  info(`翻转前峰值 ${peakBeforeFlip.toFixed(2)} → 翻转帧 ${fac.captureProgress.toFixed(2)}，一帧内落差 ${dropAtFlip.toFixed(2)}`);
  check("陷阱确实存在：成功翻转时环值一帧内从峰值掉到 0",
    fac.team === "player" && dropAtFlip > 0.9,
    `落差 ${dropAtFlip.toFixed(2)}`);
  info("→ 刀A 必须显式排除完成态（设施易主给我方 / 满格清零），T7 专门断言这条");
}

// ════════════════════════════════════════════════════════════
// T4 改前快照 · 三条到达路径的当前行为（刀B 落地后逐字比对，证明零误伤）
// ════════════════════════════════════════════════════════════

interface ArrivalSnapshot {
  bareAttackMove: { state: string; orders: number; action: string };
  sabotage: { state: string; orders: number; action: string };
  enemyAttackMove: { state: string; orders: number; action: string };
}

function arrivalSnapshot(): ArrivalSnapshot {
  // 快照必须取【到达那一帧】，不是"跑 30 秒之后"：
  //   ①刀B 改的就是到达分支，到达帧才是同一个受测对象；
  //   ②"清空的战场"并不真空——defensiveAI 会下生产单、processEconomy 把敌军新兵造出来
  //     （实测 30 秒内总单位 1→3），跑得越久越是在测别的东西，还会把单位打死（首版就崩在这）。
  const snap = (build: (s: GameState) => Unit): { state: string; orders: number; action: string } => {
    const s = clearedScenario(1);
    const u = build(s);
    const goal = { ...u.target! };
    let hit: { state: string; orders: number; action: string } | null = null;
    for (let f = 0; f < 1200 && !hit; f++) {
      if (f % 10 === 0) updateFog(s);
      step(s, 0.1);
      const cur = s.units.get(u.id);
      if (!cur) break;                       // 被打死了 → 场景不干净，让断言去报
      if (cur.target === null && dist(cur.position, goal) < 0.5) {
        hit = { state: cur.state, orders: cur.orders.length, action: cur.orders[0]?.action ?? "(none)" };
      }
    }
    return hit ?? { state: "(never-arrived)", orders: -1, action: "(never-arrived)" };
  };

  return {
    // ① 光杆 attack_move（无 targetFacilityId）——刀B 必须放过
    bareAttackMove: snap((s) => {
      const fac = facOf(s, "ea_alamein_town");
      const u = addUnit(s, "infantry", "player", fac.position.x + 6, fac.position.y);
      applyPlayerCommands(s, [{
        unitIds: [u.id], action: "attack_move",
        target: { x: fac.position.x + 3, y: fac.position.y }, priority: "high",
      } as Order]);
      return u;
    }),
    // ② sabotage（带 targetFacilityId 但动作不是 attack_move）——刀B 必须放过
    sabotage: snap((s) => {
      const fac = facOf(s, "ea_axis_barracks");
      const u = addUnit(s, "infantry", "player", fac.position.x + 5, fac.position.y);
      applyPlayerCommands(s, [{
        unitIds: [u.id], action: "sabotage", targetFacilityId: fac.id,
        target: { x: fac.position.x, y: fac.position.y }, priority: "high",
      } as Order]);
      return u;
    }),
    // ③ 敌军 attack_move 到达——刀B 的 team 闸必须放过
    enemyAttackMove: snap((s) => {
      const fac = facOf(s, "ea_alamein_town");
      const u = addUnit(s, "infantry", "enemy", fac.position.x + 6, fac.position.y);
      u.state = "moving";
      u.target = { x: fac.position.x + 3, y: fac.position.y };
      u.waypoints = [{ x: fac.position.x + 3, y: fac.position.y }];
      u.orders = [{
        unitIds: [u.id], action: "attack_move", targetFacilityId: fac.id,
        target: { x: fac.position.x + 3, y: fac.position.y }, priority: "high",
      } as Order];
      return u;
    }),
  };
}

// 改前快照（2026-07-29 于未改动的 b73d973 上抓取，刀B 落地后必须逐字不变）
const EXPECTED_ARRIVAL: ArrivalSnapshot = {
  bareAttackMove: { state: "idle", orders: 0, action: "(none)" },
  sabotage: { state: "idle", orders: 1, action: "sabotage" },
  enemyAttackMove: { state: "idle", orders: 0, action: "(none)" },
};

function T4_beforeSnapshot(printOnly: boolean): void {
  console.log("\n── T4 改前到达行为快照（刀B 之后必须逐字不变） ──");
  const got = arrivalSnapshot();
  const fmt = (x: { state: string; orders: number; action: string }) => `state=${x.state} orders=${x.orders} action=${x.action}`;
  info(`① 光杆 attack_move：${fmt(got.bareAttackMove)}`);
  info(`② sabotage：${fmt(got.sabotage)}`);
  info(`③ 敌军 attack_move：${fmt(got.enemyAttackMove)}`);
  if (printOnly) {
    console.log(JSON.stringify(got, null, 2));
    return;
  }
  for (const k of ["bareAttackMove", "sabotage", "enemyAttackMove"] as const) {
    check(`T4 ${k} 与改前快照逐字一致`,
      JSON.stringify(got[k]) === JSON.stringify(EXPECTED_ARRIVAL[k]),
      `got ${fmt(got[k])} / expected ${fmt(EXPECTED_ARRIVAL[k])}`);
  }
}

// ── 环值轨迹（挑刀A 的回落幅度门槛用；不是断言，是证据） ──

function printTrajectory(): void {
  console.log("\n── 环值轨迹（S1 峰值前后，供刀A 选回落幅度门槛） ──");
  const r = runScriptArm("S1", 1);
  const iPeak = r.trajectory.findIndex(([, p]) => p >= r.peak - 1e-9);
  const w = r.trajectory.slice(Math.max(0, iPeak - 4), iPeak + 30);
  console.log("   " + w.map(([t, p]) => `${t.toFixed(1)}:${p.toFixed(3)}`).join(" "));
  const drops: number[] = [];
  for (let i = 1; i < r.trajectory.length; i++) {
    const d = r.trajectory[i - 1][1] - r.trajectory[i][1];
    if (d > 0) drops.push(d);
  }
  info(`单帧回落幅度：最小 ${Math.min(...drops).toFixed(4)} 最大 ${Math.max(...drops).toFixed(4)}（dt=0.1 时半速衰减理论值 0.01）`);
}

// ── main ──

const args = process.argv.slice(2);
const seedArg = args.find((a) => a.startsWith("--seed="));
const SEED = seedArg ? Number(seedArg.split("=")[1]) : 1;

console.log("=== ab-capture-stall (capture-stall-feedback-v1) ===");
console.log(`基线 b73d973 · seed=${SEED} · 泵帧镜像生产序 · Math.random 已播种`);

if (args.includes("--print-snapshot")) {
  T4_beforeSnapshot(true);
  printTrajectory();
} else {
  N0a_healthyCaptureIsExpressible();
  N0b_stallIsExpressible();
  T0_successLooksLikeADrop();
  T2_script_defendConversion();
  T5b_mousePathConversion();
  T2_main(SEED);
  if (args.includes("--sweep")) T2_main_sweep();
  T5_script(SEED);
  T8_reasonBranches();
  T7_noFalsePositives();
  T4_beforeSnapshot(false);
  printTrajectory();

  console.log(`\n=== ${failCount === 0 ? "ALL PASS" : `${failCount} FAIL`} ===`);
  if (failCount > 0) process.exit(1);
}
