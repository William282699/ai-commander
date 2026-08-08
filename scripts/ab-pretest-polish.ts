// ============================================================
// AI Commander — pretest-polish-v1 bench（外测前三小刀）
//
// 提案 PRETEST_POLISH_V1_PROPOSAL.md v2。三刀独立，可单砍：
//   刀1 超时计分 score = 2×captured − lost + 阈值抬两档（majorVictory 4 / victory 3）
//       —— 本文件 T1（9 格全表逐格断言）+ --negctl（旧公式期望表打新引擎，必须真 FAIL）。
//   刀2 三山脊性格权重表 —— 本文件 T2（只读探针断言候选分严格按权重排序 + 权重全 1.0 负对照）
//       + T2d 跨 kind 排序两边钉死（北 140 顶住 120 前哨 / 南 60 让位 90 前哨；用户裁定保留）。
//   刀3 插旗 —— 渲染层，bench 测不到（验收=改前/改后截图+用户过目，见提案 §1 刀3）。
//
// ★ 判据家法（六条中落在本文件的）：
//   ②有隐藏状态断言状态本身 —— T1 断 state.gameOverRating / gameOverBreakdown / winner，
//     不看 gameOverReason 台词；
//   ④N0 式台架自证 —— T0 先证明台架表达得出取值域（翻设施 team 真的改变 captured/lost 计数，
//     且 c=3 / l=3 会走即时胜负而非超时评级 —— 这正是取值域被夹死在 [0,2]² 的结构证明）；
//   ⑤负对照 —— --negctl 用旧公式期望表打新引擎，逐格数真 FAIL 数（期望 12：rating 5 格 +
//     score 6 格 + winner 1 格），0 FAIL = 断言没牙，直接退出码 1。
//
// ★ 确定性：checkGameOver / endGameWithRating 不含 Math.random（T1 纯函数式状态构造，
//   不跑任何 AI processor），无需播种；T2 只读探针同理。
//
// 用法：npx tsx scripts/ab-pretest-polish.ts [--negctl]
// ============================================================

import {
  createInitialGameState, checkGameOver, probePressureTargets, OBJECTIVE_PRESSURE_WEIGHT,
} from "@ai-commander/core";
import type { GameState } from "@ai-commander/shared";

// ── 0. Harness ──

let failCount = 0;
function check(name: string, ok: boolean, detail = ""): void {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok || !detail ? "" : ` — ${detail}`}`);
  if (!ok) failCount++;
}
function info(line: string): void {
  console.log(`     · ${line}`);
}

// ── 1. 刀1 状态构造 ──
//
// 超时评级只看三样：captureObjectives 里 team==="player" 的个数（captured）、
// friendlyKeypoints 里 !f || hp<=0 || team!=="player" 的个数（lost）、
// state.time >= timeLimitSec。构造 = 翻 team + 推时钟，零帧模拟。

type Rating = NonNullable<GameState["gameOverRating"]>;

function makeTimeoutState(captured: number, lost: number): GameState {
  const s = createInitialGameState("el_alamein");
  const winCfg = s.scenarioWinConfig!;
  const objectives = s.captureObjectives ?? [];
  for (let i = 0; i < captured; i++) {
    s.facilities.get(objectives[i])!.team = "player";
  }
  for (let i = 0; i < lost; i++) {
    s.facilities.get(winCfg.friendlyKeypoints[i])!.team = "enemy";
  }
  s.time = winCfg.timeLimitSec; // >= 即触发（warPhase.ts:147）
  return s;
}

// ── 2. T0 台架自证（家法④）──

function T0_harness_proves_domain(): void {
  console.log("\n== T0 台架自证：构造函数真的控制 captured/lost，且 [0,2]² 是被即时胜负夹出来的 ==");

  const fresh = createInitialGameState("el_alamein");
  const winCfg = fresh.scenarioWinConfig!;
  check("T0a 剧本真值 requiredCapturedObjectives=3 / maxFriendlyKeypointsLost=3（9 格表的前提）",
    winCfg.requiredCapturedObjectives === 3 && winCfg.maxFriendlyKeypointsLost === 3,
    `实际 ${winCfg.requiredCapturedObjectives}/${winCfg.maxFriendlyKeypointsLost}`);
  check("T0b 新局零占零丢（构造起点干净）",
    (fresh.captureObjectives ?? []).every(id => fresh.facilities.get(id)?.team !== "player")
    && winCfg.friendlyKeypoints.every(id => {
      const f = fresh.facilities.get(id);
      return !!f && f.hp > 0 && f.team === "player";
    }));

  // c=3 → 即时胜（不走评级）；l=3 → 即时败（不走评级）。这两格证明超时路径的取值域上界。
  const win = makeTimeoutState(3, 0);
  checkGameOver(win, 0.1);
  check("T0c c=3 走即时胜利而非超时评级（gameOverRating 缺席）",
    win.gameOver && win.winner === "player" && win.gameOverRating === undefined,
    `rating=${win.gameOverRating}`);
  const loss = makeTimeoutState(0, 3);
  checkGameOver(loss, 0.1);
  check("T0d l=3 走即时失败而非超时评级（gameOverRating 缺席）",
    loss.gameOver && loss.winner === "enemy" && loss.gameOverRating === undefined,
    `rating=${loss.gameOverRating}`);
}

// ── 3. T1 九格全表 ──
//
// 提案 v2 §1 刀1 的 9 格表（score = 2c − l，阈值 4/3/1/0/−1）：
//   c\l   0        1        2
//   0     0 平局   −1 小败  −2 失败   ← 下行三格与旧公式完全一致
//   1     2 小胜    1 小胜   0 平局
//   2     4 大胜    3 胜利   2 小胜   ← 大胜只留给满分卷
// winner：draw 及以上 = "player"，minor_defeat 及以下 = "enemy"（warPhase.ts:269-274）。

interface Cell { c: number; l: number; score: number; rating: Rating; winner: "player" | "enemy" }

const NEW_TABLE: Cell[] = [
  { c: 0, l: 0, score: 0,  rating: "draw",          winner: "player" },
  { c: 0, l: 1, score: -1, rating: "minor_defeat",  winner: "enemy" },
  { c: 0, l: 2, score: -2, rating: "defeat",        winner: "enemy" },
  { c: 1, l: 0, score: 2,  rating: "minor_victory", winner: "player" },
  { c: 1, l: 1, score: 1,  rating: "minor_victory", winner: "player" },
  { c: 1, l: 2, score: 0,  rating: "draw",          winner: "player" },
  { c: 2, l: 0, score: 4,  rating: "major_victory", winner: "player" },
  { c: 2, l: 1, score: 3,  rating: "victory",       winner: "player" },
  { c: 2, l: 2, score: 2,  rating: "minor_victory", winner: "player" },
];

// 旧公式期望表（score = c − l，阈值 3/2/1/0/−1）—— 只给 --negctl 用。
const OLD_TABLE: Cell[] = [
  { c: 0, l: 0, score: 0,  rating: "draw",          winner: "player" },
  { c: 0, l: 1, score: -1, rating: "minor_defeat",  winner: "enemy" },
  { c: 0, l: 2, score: -2, rating: "defeat",        winner: "enemy" },
  { c: 1, l: 0, score: 1,  rating: "minor_victory", winner: "player" },
  { c: 1, l: 1, score: 0,  rating: "draw",          winner: "player" },
  { c: 1, l: 2, score: -1, rating: "minor_defeat",  winner: "enemy" },
  { c: 2, l: 0, score: 2,  rating: "victory",       winner: "player" },
  { c: 2, l: 1, score: 1,  rating: "minor_victory", winner: "player" },
  { c: 2, l: 2, score: 0,  rating: "draw",          winner: "player" },
];

function runTable(table: Cell[], tag: string): void {
  for (const cell of table) {
    const s = makeTimeoutState(cell.c, cell.l);
    checkGameOver(s, 0.1);
    const b = s.gameOverBreakdown;
    check(`${tag} c=${cell.c} l=${cell.l} → gameOver 且 breakdown 计数正确`,
      s.gameOver && b?.capturedObjectives === cell.c && b?.lostKeypoints === cell.l,
      `breakdown=${JSON.stringify(b)}`);
    check(`${tag} c=${cell.c} l=${cell.l} → score=${cell.score}`,
      b?.score === cell.score, `实际 ${b?.score}`);
    check(`${tag} c=${cell.c} l=${cell.l} → rating=${cell.rating}`,
      s.gameOverRating === cell.rating, `实际 ${s.gameOverRating}`);
    check(`${tag} c=${cell.c} l=${cell.l} → winner=${cell.winner}`,
      s.winner === cell.winner, `实际 ${s.winner}`);
  }
}

function T1_nine_grid(): void {
  console.log("\n== T1 刀1 九格全表（score = 2×captured − lost，阈值 4/3/1/0/−1）==");
  runTable(NEW_TABLE, "T1");
  info("阶梯语义：大胜只在 (2,0) 满分卷；(1,1) 强推微损=小胜不再平局；下行三格 (0,*) 与旧公式逐格一致");
}

function T1_negctl(): void {
  console.log("\n== NEGCTL 刀1 负对照：旧公式期望表（c−l，阈值 3/2）打新引擎，必须真 FAIL ==");
  const before = failCount;
  runTable(OLD_TABLE, "NEGCTL");
  const fails = failCount - before;
  // 期望 12 条真 FAIL：rating 差 5 格 (1,1)(1,2)(2,0)(2,1)(2,2) + score 差 6 格 (1,*)(2,*)
  // + winner 差 1 格 (1,2)（旧小败=enemy，新平局=player）。breakdown 计数两表同值不该 FAIL。
  console.log(`\nNEGCTL 结果：${fails} 条 FAIL（期望恰 12 —— 少了=断言没牙，多了=改动越界）`);
  if (fails === 12) {
    failCount = before; // 负对照的 FAIL 是预期行为，不算总账
    console.log("NEGCTL PASS —— 新断言在旧行为下真的会挂，且只挂在公式改变的格子上");
  } else {
    console.log("NEGCTL FAIL —— 负对照失真，检查公式或断言");
  }
}

// ── 4. T2 刀2 三山脊性格（pressureDirector (A) recapture 权重表）──
//
// 探针 probePressureTargets 只读返回拷贝（照 chaseAnchorHomeOf 形状）。
// 权重真值直接读 OBJECTIVE_PRESSURE_WEIGHT（不在 bench 里抄第二份数字表，
// 抄了就是第二真相源）；本段只把"排序严格按权重"和"数值=基础分×权重"钉死。
// 确定性：probe 纯读 state，无 Math.random（historyPenalty 对 recapture 恒 0，
// 模块级 p4TargetHistory 在本进程从未被写入）。

const RIDGE_ORDER = ["ea_kidney_ridge", "ea_alamein_town", "ea_miteirya_ridge", "ea_himeimat"];
/** 断言名里的人话地名，**从生产 state 取**，不在台架里写死一份。
 *  第 8 级改名刀在这儿逮到一张硬编码显示名表（`ea_miteirya_ridge: "中央山脊"`）：
 *  设施改了名，这张表会安静地继续印旧名——断言照绿，报告骗人。同一把尺，读生产的 name。 */
const ridgeName = (s: GameState, id: string): string => s.facilities.get(id)?.name ?? id;

/** 四目标同时进入 (A) 分支的两种姿势：held=玩家已占（基础分 100）；
 *  capturing=敌持有但玩家占领中（基础分 70）。 */
function makeRecaptureState(mode: "held" | "capturing"): GameState {
  const s = createInitialGameState("el_alamein");
  for (const objId of s.captureObjectives ?? []) {
    const f = s.facilities.get(objId)!;
    if (mode === "held") f.team = "player";
    else f.capturingTeam = "player"; // team 保持 enemy
  }
  return s;
}

function runT2Grid(mode: "held" | "capturing", base: number, tag: string): void {
  const s = makeRecaptureState(mode);
  const recap = probePressureTargets(s, true, false).filter(c => c.kind === "recapture");
  check(`${tag} 四个 objective 全部产出 recapture 候选`,
    recap.length === 4, `实际 ${recap.length}`);
  for (const c of recap) {
    const expected = base * (OBJECTIVE_PRESSURE_WEIGHT[c.targetId] ?? 1.0);
    check(`${tag} ${ridgeName(s, c.targetId)} score=${base}×${OBJECTIVE_PRESSURE_WEIGHT[c.targetId]}`,
      Math.abs(c.score - expected) < 1e-9, `实际 ${c.score}，期望 ${expected}`);
  }
  const sorted = [...recap].sort((a, b) => b.score - a.score);
  const strictlyDesc = sorted.every((c, i) => i === 0 || sorted[i - 1].score > c.score);
  check(`${tag} 候选分严格按权重表排序：北>镇>中央>南（无并列）`,
    strictlyDesc && sorted.map(c => c.targetId).join(",") === RIDGE_ORDER.join(","),
    `实际 ${sorted.map(c => `${ridgeName(s, c.targetId)}:${c.score}`).join(" ")}`);
}

function T2_ridge_weights(): void {
  console.log("\n== T2 刀2 三山脊性格：候选分严格按权重表排序（探针只读）==");
  runT2Grid("held", 100, "T2a[已占100]");
  runT2Grid("capturing", 70, "T2b[占领中70]");
  info("消费方耦合：P4 在 pressureDirector.ts:399 按 score 降序取 candidates[0]，operation 层 :576 同样");
  info("best-first —— 上面钉住的排序就是派兵决策线本身。真剧本反扑派兵差异属记录性观测（提案 (c)");
  info("不设硬门槛），等用户手测时看敌军是否死保北线、软放南线。");

  // T2c B/C 分支不吃权重：同一状态下，真权重 vs 全 1.0，非 recapture 候选逐字节相同。
  const s = createInitialGameState("el_alamein");
  const objectives = s.captureObjectives ?? [];
  s.facilities.get(objectives[0])!.team = "player"; // 造一个 recapture，B 照常、C 被压制
  const weighted = probePressureTargets(s, true, false).filter(c => c.kind !== "recapture");
  const saved = { ...OBJECTIVE_PRESSURE_WEIGHT };
  try {
    for (const k of Object.keys(OBJECTIVE_PRESSURE_WEIGHT)) OBJECTIVE_PRESSURE_WEIGHT[k] = 1.0;
    const flat = probePressureTargets(s, true, false).filter(c => c.kind !== "recapture");
    check("T2c B/C 分支不吃权重（真权重 vs 全1.0，非 recapture 候选逐字节相同）",
      JSON.stringify(weighted) === JSON.stringify(flat),
      `weighted=${JSON.stringify(weighted)} flat=${JSON.stringify(flat)}`);
  } finally {
    Object.assign(OBJECTIVE_PRESSURE_WEIGHT, saved);
  }
}

// ── 4b. T2d 跨 kind 排序钉死（用户裁定 2026-07-31：权重的跨类效应=有意保留）──
//
// 权重不止排"三山脊之间"，还翻转 recapture vs finish_post 的跨类排序（三类候选
// 同一张表，P4 :399 与 op 层 :578 都取全局最大）。两边都钉（Opus 审核指出只钉南边
// 的话，1.4 调回 1.0 断言不会响）：
//   北：占住北岭 140 > 残血前哨 120 —— 改前 100~140 的 finish_post 能把敌人拉走，
//       改后拉不走（1.4 的真实代价="只会一件事"，手测判据在此）；
//   南：占住南高地 60 < 残血前哨 90 —— 敌人宁可补刀也不抢软肋。
// 构造全确定性（家法④ 自证=两个构造分数逐分断言）：
//   残血 +60 / 被占领中 +60 / 攻击者 +0（观察哨 state 恒 idle，:628 只认
//   attacking|moving）/ 防守分靠"对敌可见的圈内我方地面 hp"分桶精确控制
//   （观察哨给视野；N 塞 ≥250hp 满编→+0；S 清场后放一个 40hp→+30）。
//   applyHistory=false（op 层语义；P4 的轮换惩罚是另一维度，与跨类排序无关）。

function farCornerFrom(s: GameState, pos: { x: number; y: number }): { x: number; y: number } {
  const corners = [
    { x: 2, y: 2 }, { x: s.mapWidth - 3, y: 2 },
    { x: 2, y: s.mapHeight - 3 }, { x: s.mapWidth - 3, y: s.mapHeight - 3 },
  ];
  return corners.reduce((best, c) => {
    const d = (a: { x: number; y: number }) => (a.x - pos.x) ** 2 + (a.y - pos.y) ** 2;
    return d(c) > d(best) ? c : best;
  });
}

/** 拿一个敌军单位当观察哨钉在 pos：给敌方视野（防守分才数得到人），idle 不触发 +25。 */
function plantObserver(s: GameState, pos: { x: number; y: number }): void {
  for (const u of s.units.values()) {
    if (u.team === "enemy" && u.state !== "dead") {
      u.position = { ...pos };
      u.state = "idle";
      return;
    }
  }
  throw new Error("no enemy unit to plant as observer");
}

function playerGroundUnits(s: GameState): Array<{ position: { x: number; y: number }; hp: number; maxHp: number }> {
  const out: Array<{ position: { x: number; y: number }; hp: number; maxHp: number }> = [];
  for (const u of s.units.values()) {
    if (u.team === "player" && u.state !== "dead" && (u.type === "infantry" || u.type === "tank")) out.push(u);
  }
  return out;
}

function T2d_cross_kind(): void {
  console.log("\n== T2d 跨 kind 排序（用户裁定：保留；北南两边+负对照都要真牙）==");

  // 北：kidney 140 顶住 120 分残血前哨（旧世界 100 会被拉走）
  const n = createInitialGameState("el_alamein");
  n.facilities.get("ea_kidney_ridge")!.team = "player";
  const postN = n.facilities.get("ea_player_coastal_post")!;
  postN.hp = Math.floor(postN.maxHp * 0.4);   // +60
  postN.capturingTeam = "enemy";              // +60
  plantObserver(n, postN.position);
  const defenders = playerGroundUnits(n).slice(0, 8);
  defenders.forEach((u, i) => {
    u.position = { x: postN.position.x + (i % 3) - 1, y: postN.position.y + Math.floor(i / 3) - 1 };
    u.hp = u.maxHp;
  });
  const sumHp = defenders.reduce((a, u) => a + u.hp, 0);
  check("T2d-N 前置：圈内可见我方地面 hp ≥250（防守分归零的自证）", sumHp >= 250, `实际 ${sumHp}`);
  const candN = probePressureTargets(n, false, false);
  const fpN = candN.find(c => c.targetId === "ea_player_coastal_post");
  check("T2d-N 残血前哨构造分=120（60 残血+60 被占中+0 攻击者+0 防守）",
    fpN?.kind === "finish_post" && fpN.score === 120, `实际 ${fpN?.kind}:${fpN?.score}`);
  check("T2d-N 120 落在翻转窗（>旧北分 100，<新北分 140）", 120 > 100 && 120 < 140);
  const kidN = candN.find(c => c.targetId === "ea_kidney_ridge");
  check("T2d-N 北岭分=100×权重表值（两个世界都该过——读表不抄数）",
    Math.abs((kidN?.score ?? NaN) - 100 * OBJECTIVE_PRESSURE_WEIGHT.ea_kidney_ridge) < 1e-9,
    `实际 ${kidN?.score}`);
  const topN = [...candN].sort((a, b) => (b.score - a.score) || a.targetId.localeCompare(b.targetId))[0];
  check("T2d-N ★全表第一名仍是北岭（残血前哨拉不走敌人——1.4 的代价与承诺同源）",
    topN.targetId === "ea_kidney_ridge",
    `实际 top=${topN.targetId}:${topN.score}`);

  // 南：himeimat 60 输给 90 分残血前哨（旧世界 100 必赢）
  const s = createInitialGameState("el_alamein");
  s.facilities.get("ea_himeimat")!.team = "player";
  const postS = s.facilities.get("ea_player_south_post")!;
  postS.hp = Math.floor(postS.maxHp * 0.4);   // +60，不设占领中
  const far = farCornerFrom(s, postS.position);
  for (const u of s.units.values()) {
    if (u.team !== "player" || u.state === "dead") continue;     // 清场搬全兵种：
    const dx = u.position.x - postS.position.x, dy = u.position.y - postS.position.y;  // 只搬步坦会把
    if (dx * dx + dy * dy <= 18 * 18) u.position = { ...far };   // 炮兵等地面单位留在圈里爆 250 档
  }
  plantObserver(s, postS.position);
  const lone = playerGroundUnits(s)[0];
  lone.position = { x: postS.position.x + 1, y: postS.position.y };
  lone.hp = 40;                               // 可见 hp 40 → 防守分档 +30
  const candS = probePressureTargets(s, false, false);
  const fpS = candS.find(c => c.targetId === "ea_player_south_post");
  check("T2d-S 残血前哨构造分=90（60 残血+30 防守薄）",
    fpS?.kind === "finish_post" && fpS.score === 90, `实际 ${fpS?.kind}:${fpS?.score}`);
  check("T2d-S 90 落在翻转窗（>新南分 60，<旧南分 100）", 90 > 60 && 90 < 100);
  const himS = candS.find(c => c.targetId === "ea_himeimat");
  check("T2d-S 南高地分=100×权重表值（两个世界都该过）",
    Math.abs((himS?.score ?? NaN) - 100 * OBJECTIVE_PRESSURE_WEIGHT.ea_himeimat) < 1e-9,
    `实际 ${himS?.score}`);
  const sortedS = [...candS].sort((a, b) => (b.score - a.score) || a.targetId.localeCompare(b.targetId));
  check("T2d-S ★残血前哨排在南高地之前（敌人宁可补刀也不抢软肋）",
    sortedS.findIndex(c => c.targetId === "ea_player_south_post")
      < sortedS.findIndex(c => c.targetId === "ea_himeimat"),
    `实际序 ${sortedS.map(c => `${c.targetId}:${c.score}`).join(" ")}`);
}

function T2d_negctl(): void {
  console.log("\n== NEGCTL 刀2-T2d 负对照：权重全 1.0 → 两条跨 kind 断言必须真 FAIL ==");
  const saved = { ...OBJECTIVE_PRESSURE_WEIGHT };
  const before = failCount;
  try {
    for (const k of Object.keys(OBJECTIVE_PRESSURE_WEIGHT)) OBJECTIVE_PRESSURE_WEIGHT[k] = 1.0;
    T2d_cross_kind();
  } finally {
    Object.assign(OBJECTIVE_PRESSURE_WEIGHT, saved);
  }
  const fails = failCount - before;
  // 期望恰 2：北=第一名被 120 分前哨抢走、南=100 分南高地重新压过 90 分前哨。
  // 构造分/翻转窗/读表断言两个世界通过（负对照零误伤的自证）。
  console.log(`\nNEGCTL-T2d 结果：${fails} 条 FAIL（期望恰 2）`);
  if (fails === 2) {
    failCount = before;
    console.log("NEGCTL-T2d PASS —— 跨 kind 两边的牙都是真的，平权世界里两条都翻");
  } else {
    console.log("NEGCTL-T2d FAIL —— 负对照失真，检查构造或断言");
  }
}

function T2_negctl(): void {
  console.log("\n== NEGCTL 刀2 负对照：权重全 1.0 → 四分并列，排序/数值断言必须真 FAIL ==");
  const saved = { ...OBJECTIVE_PRESSURE_WEIGHT };
  const before = failCount;
  try {
    for (const k of Object.keys(OBJECTIVE_PRESSURE_WEIGHT)) OBJECTIVE_PRESSURE_WEIGHT[k] = 1.0;
    // 数值断言读的是表本身（全 1.0 时期望=实际），所以换用【原始权重表】的期望值打平权引擎，
    // 与 T1 负对照同构：新期望打旧行为。
    for (const [mode, base, tag] of [["held", 100, "NEGCTL-T2a"], ["capturing", 70, "NEGCTL-T2b"]] as const) {
      const s = makeRecaptureState(mode);
      const recap = probePressureTargets(s, true, false).filter(c => c.kind === "recapture");
      check(`${tag} 四候选仍在（平权不该丢候选）`, recap.length === 4);
      for (const c of recap) {
        const expected = base * (saved[c.targetId] ?? 1.0);
        check(`${tag} ${ridgeName(s, c.targetId)} 原权重期望 ${expected}`,
          Math.abs(c.score - expected) < 1e-9, `实际 ${c.score}`);
      }
      const sorted = [...recap].sort((a, b) => b.score - a.score);
      check(`${tag} 严格排序（平权下必并列）`,
        sorted.every((c, i) => i === 0 || sorted[i - 1].score > c.score));
    }
  } finally {
    Object.assign(OBJECTIVE_PRESSURE_WEIGHT, saved);
  }
  const fails = failCount - before;
  // 期望恰 8：每臂 3 条数值 FAIL（驼峰山脊 ×1.0 平权同值不挂——精准不误伤）+ 1 条严格排序 FAIL。
  console.log(`\nNEGCTL-刀2 结果：${fails} 条 FAIL（期望恰 8）`);
  if (fails === 8) {
    failCount = before;
    console.log("NEGCTL-刀2 PASS —— 排序与数值断言在平权世界里真的会挂，驼峰山脊(×1.0)零误伤");
  } else {
    console.log("NEGCTL-刀2 FAIL —— 负对照失真，检查权重表或断言");
  }
}

// ── main ──

const args = process.argv.slice(2);
T0_harness_proves_domain();
T1_nine_grid();
T2_ridge_weights();
T2d_cross_kind();
if (args.includes("--negctl")) { T1_negctl(); T2_negctl(); T2d_negctl(); }

console.log(`\n${failCount === 0 ? "ALL PASS" : `${failCount} FAILED`}`);
process.exit(failCount === 0 ? 0 : 1);
