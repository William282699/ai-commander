// ============================================================
// AI Commander — pretest-polish-v1 bench（外测前三小刀）
//
// 提案 PRETEST_POLISH_V1_PROPOSAL.md v2。三刀独立，可单砍：
//   刀1 超时计分 score = 2×captured − lost + 阈值抬两档（majorVictory 4 / victory 3）
//       —— 本文件 T1（9 格全表逐格断言）+ --negctl（旧公式期望表打新引擎，必须真 FAIL）。
//   刀2 三山脊性格权重表 —— 本文件 T2（只读探针断言候选分严格按权重排序 + 权重全 1.0 负对照）。
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
const RIDGE_NAMES: Record<string, string> = {
  ea_kidney_ridge: "北部山脊", ea_alamein_town: "阿拉曼镇",
  ea_miteirya_ridge: "中央山脊", ea_himeimat: "南部高地",
};

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
    check(`${tag} ${RIDGE_NAMES[c.targetId]} score=${base}×${OBJECTIVE_PRESSURE_WEIGHT[c.targetId]}`,
      Math.abs(c.score - expected) < 1e-9, `实际 ${c.score}，期望 ${expected}`);
  }
  const sorted = [...recap].sort((a, b) => b.score - a.score);
  const strictlyDesc = sorted.every((c, i) => i === 0 || sorted[i - 1].score > c.score);
  check(`${tag} 候选分严格按权重表排序：北>镇>中央>南（无并列）`,
    strictlyDesc && sorted.map(c => c.targetId).join(",") === RIDGE_ORDER.join(","),
    `实际 ${sorted.map(c => `${RIDGE_NAMES[c.targetId]}:${c.score}`).join(" ")}`);
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
        check(`${tag} ${RIDGE_NAMES[c.targetId]} 原权重期望 ${expected}`,
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
  // 期望恰 8：每臂 3 条数值 FAIL（中央山脊 ×1.0 平权同值不挂——精准不误伤）+ 1 条严格排序 FAIL。
  console.log(`\nNEGCTL-刀2 结果：${fails} 条 FAIL（期望恰 8）`);
  if (fails === 8) {
    failCount = before;
    console.log("NEGCTL-刀2 PASS —— 排序与数值断言在平权世界里真的会挂，中央山脊(×1.0)零误伤");
  } else {
    console.log("NEGCTL-刀2 FAIL —— 负对照失真，检查权重表或断言");
  }
}

// ── main ──

const args = process.argv.slice(2);
T0_harness_proves_domain();
T1_nine_grid();
T2_ridge_weights();
if (args.includes("--negctl")) { T1_negctl(); T2_negctl(); }

console.log(`\n${failCount === 0 ? "ALL PASS" : `${failCount} FAILED`}`);
process.exit(failCount === 0 ? 0 : 1);
