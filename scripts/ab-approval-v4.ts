// ============================================================
// AI Commander — approval-contract-v4 bench (刀1 / 刀2 / 刀3)
//
// Modes:
//   --synthetic  deterministic assertions (no LLM, no server)
//   --negctl     PRE-FIX expectations — every ★ assertion below MUST report
//                FAIL here. A --negctl run that goes green means the knife
//                is not actually load-bearing and the positive run is
//                asserting a tautology (家法：摘掉修复必须真 FAIL).
//
// Every number comes from the ONE production builder — never a bench
// re-implementation. Expected values are computed with the production
// estimator (estimateSquadTravelTime) against a deliberately-chosen anchor,
// so the assertion is "which POINT did production measure to", not "did the
// bench's arithmetic match production's arithmetic".
//
// Run (worktree root):
//   npx tsx scripts/ab-approval-v4.ts --synthetic
//   npx tsx scripts/ab-approval-v4.ts --negctl
// ============================================================

import { readFileSync, readdirSync } from "node:fs";
import { createInitialGameState } from "@ai-commander/core";
import {
  frontCenterPos,
  battleAnchorFor,
  estimateSquadTravelTime,
} from "../packages/core/src/crisisResponse";
import { buildReinforceOptions, TASK_IDLE } from "../packages/core/src/frontEscalationPayload";
import { frontDestinationFor, isInsideFront } from "../packages/core/src/frontDestination";
import { describeCommittedPull } from "../packages/core/src/committedUnits";
import { buildBattleBoard, boardToDigestLines } from "../packages/core/src/battleBoard";
import { resolveIntent } from "../packages/core/src/tacticalPlanner";
import { buildFrontJudgmentLines, commanderMood } from "../packages/core/src/commanderPresence";
import { assessCrisisEscalation } from "../packages/core/src/crisisResponse";
import { collectDirectorBeats, frontEscalationFacts, facilityEscalationFacts } from "../packages/core/src/director";
import { captureDecisionReview } from "../packages/core/src/decisionReview";
import { filterLateCandidates } from "../packages/core/src/frontEscalationPayload";
import {
  mintEscalationTickets, lookupEscalationTicket, burnEscalationTicket, liveMembersOf,
  isTicketRef, isKnownForceRef, ticketPromptLine, resetEscalationTickets, TICKET_TTL_SEC,
  buildFrontEscalationWithTickets, resolveTicketReference, ticketDispatchReceipt,
  mintSpokenForce, _ticketsForTest, retargetIntentForTicket, ticketDestinationVerdict,
} from "../packages/core/src/escalationTicket";
import type { GameState, Unit, Front, Position, CrisisEvent, Intent } from "@ai-commander/shared";

// ── Harness ──

/** ★ negctl 的**逐条**期望：把修复摘掉之后，红的必须正好是这 48 条，一条不多一条不少。
 *
 *  为什么钉集合不钉条数：见 redNames 的注释。这张表是判据，不是记录——
 *  **实测与它对不上时，先查是哪一颗牙掉了，不许改这张表去迁就实测**。
 *  合法更新的唯一场合：确实增删了 ★ 断言，且在 commit message 里写明增删了哪几条。 */
const NEGCTL_EXPECTED_RED: readonly string[] = [
    "★ T1f 升级 payload etaSec 锚到战斗点",
    "★ T1i 态势板 best_help eta == 升级 payload etaSec（同源，防分叉）",
    "★ T1j ★合同变更★ 兜底二级 无人交火 → 【最大簇】质心（东头 4 人），不是全体平均",
    "★ T1k ★合同变更★ 线内无兵但有我方设施 → 落到该设施（不是空沙漠中心）",
    "★ T1l ★合同变更★ 交火簇压过人更多的安静簇（一级压二级，不是比人数）",
    "★ T1w ★ 同一条线：援兵去打仗那头，撤退去我方据点那头（两档不同点）",
    "★ T1w2 ★ 无设施可退时撤向【未交火】那簇，援兵仍去交火那簇",
    "★ T1w3 ★端到端·数兵核坐标★ 「撤到中央战线」= 4 个单位落在我方前哨附近，不在战场上",
    "★ TF1 ★回归修复★ attack 落到敌方胜负点，不落自家交火簇、不落中立雷达",
    "★ TF2 ★端到端·数兵核坐标★ 「进攻山脊战线」6 个单位落在敌方胜负点上",
    "★ TF4 ★负对照★ 线上无敌设施 → 落回 approach 档（我方立足点），中立雷达绝不当目标",
    "★ TF8 ★次序★ 线上有我方交火时，敌方【非胜负点】设施不得成为落点（交火簇压过它）",
    "★ TF9 ★次序★ 无我方人员时落敌方设施：取离 frontCenterPos 最近的那个（敌军总部，确定性）",
    "★ TF10 ★次序★ 线上无我方人员时，敌方非VP设施压过我方设施（第4档 > 第5档）",
    "★ TH1 ★披露★ 抽走带任务的部队 → 回执侧说出口，数字 == 独立重算的交集",
    "★ TH1c ★负对照★ 全闲置派兵 → 一个字都不说（披露不得退化成每次都响的噪音）",
    "★ TH1e ★端到端·数兵★ 一道「全军进攻」下去，披露数 == 派出名单里本来有任务的那些",
    "★ T2d ★牙★ 番号快照 == 升级候选的 5 人（不是板子的 10 人）",
    "★ T2e ★牙★ 快照里零个线内单位（不抽已交战的兵）",
    "★ T3i ★ 番号翻成冻结名单（5 人，全是线外那批）",
    "★ T5b ★端到端★ 活跃番号过闸（这正是活体冒烟被拦下的那一步）",
    "★ T5d ★ 烧过的号闸层照样放行（闸不查生死，否则就是第二真相源）",
    "★ T5f ★ 幻觉号 G99 闸层放行（形状合法即可）",
    "★ T4h ★行为★ 赢面零升级提案（诚实闸：守得住就不开口）",
    "★ T4k ★ 说话面 事实包 赢面 = null（不是缺数，是诚实答案）",
    "★ T4m ★ 说话面 态势板 赢面 survival=stable（不再谎报倒计时）",
    "★ T4o ★ 说话面 复盘基线 赢面 = null（§6c-4 盲区修复：压着打不再有钟）",
    "★ T4r ★ 晚到候选不进 payload（提一个来不及的案＝噪声冒充选择）",
    "★ T4s ★ 同一次过滤也挡住铸号（陈不能提的案，绝不存在号）",
    "★ TA8 ★面⑤★ 态势板有钟行不再推销晚到候选（信封自相矛盾就此闭合）",
    "★ TA8e ★⑦★ 披露只数 task=无任务 的（交战中的兵不许被报成余力）",
    "★ TA8f ★⑦·点名★ 「最近 X」只在闲着的里面挑（更近的交战群不得被点名/铸号）",
    "★ TA9 ★面⑦★ 机器 B：晚到候选不再当 bestCandidate（「艾登一人可增援」的同族出口）",
    "★ TA10 ★面⑦·连带★ 废候选不再把 dilemma 降级成 safe_reinforce（被吞掉的问句回来了）",
    "★ TA11 ★面⑦·端到端★ director beat 升为 cross_front_dilemma 且不再点名废援兵",
    "★ TA19 ★⑥★ 机器 B 装闸后同样留下它（两机同尺，不再一个说 25s 一个说 89s）",
    "★ TB4 ★ 绊索已拆：ChatPanel 不再引用 NO_PROPOSAL_GUIDANCE（咨询后的「可以」必须能进 LLM）",
    "★ TB8 ★ 被说成「赶不到」的部队照样铸号（番号是地址，不是背书）",
    "★ TB9 ★端到端★ 号解析回的正是行里点名的那批人（承诺==执行，不是就近抓一支）",
    "★ TB13 ★ 推荐出来的部队也带 handle（fromSquad 有合法把手可写）",
    "★ TB16 ★端到端·数兵★ 降级 front 提示后，冻结名单原样出发（承诺 6 == 实派 6）",
    "★ TB17 ★端到端·核坐标★ 板子号 +「去本战线」→ 兵落在打仗那处，不是几何中心",
    "★ TB18 ★ 「让 G# 就地设防」→ 原地执行、不反问，回执不再谎称出发",
    "★ TB18b ★ 板子号 + 移动动词 + 无目的地 → 零执行 + 反问（不许替长官挑地方）",
    "★ TB18d ★ 裸 retreat 保持 retreat-semantics-v1 老合同（不再被改写成撤进战场）",
    "★ TB18e ★ 查无此地的战线名原样留在 toFront（警告要报长官写的那个字段，不许改写成 targetRegion）",
    "★ TB18f ★ 假地名被清掉后 → 零执行 + 反问，绝不退化成「没写目的地」顺手执行",
    "★ TB19 ★ 板子群行也铸号（「附近有空闲部队吗」念出来的那几股必须可寻址）",
];


let failCount = 0;
let passCount = 0;
const NEGCTL = process.argv[2] === "--negctl";

/** 每条红掉的断言的名字（声明序）。negctl 比对的是这个**集合**，不是条数。
 *
 *  ★ 第 8 级 刀3 加的：原来的收口是 `failCount > 0 → NEGCTL OK`。审计实测过
 *  一次换手——地图动过之后 48 变 47，看着只少一条，逐条一比是 **6 颗 ★ 牙静默
 *  变绿、4 条前置塌成红**。只数条数的负对照分不出"修复承重"和"牙掉了又碰巧
 *  有别的东西红了"。 */
const redNames: string[] = [];

function check(name: string, ok: boolean, detail = ""): void {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok || !detail ? "" : ` — ${detail}`}`);
  if (ok) passCount++;
  else {
    failCount++;
    redNames.push(name);
  }
}

/** ★ = load-bearing on the knife. Inverted under --negctl (pre-fix expectation). */
function checkKnife(name: string, okAfterFix: boolean, okBeforeFix: boolean, detail = ""): void {
  check(`★ ${name}`, NEGCTL ? okBeforeFix : okAfterFix, detail);
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

function frontById(state: GameState, id: string): Front {
  const f = state.fronts.find((x) => x.id === id);
  if (!f) throw new Error(`front ${id} missing`);
  return f;
}

function dist(a: Position, b: Position): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function makeCrisis(front: Front): CrisisEvent {
  return {
    type: "DOCTRINE_BREACH",
    severity: "critical",
    doctrineId: "bench-v4",
    locationTag: front.id,
    message: `${front.name} 态势需要决断`,
    time: 0,
  };
}

/** Production ETA convention (frontEscalationPayload.etaOf): ceil, never a fake 0. */
function etaTo(state: GameState, ids: number[], anchor: Position): number | null {
  const t = estimateSquadTravelTime(state, ids, anchor);
  return Number.isFinite(t) && t > 0 ? Math.ceil(t) : null;
}

// ============================================================
// 刀1 — ETA anchor: the promise is measured to the FIGHT, not to the
//        front's geometric center.
//
// Scenario replicates the 2026-07-22 acceptance incident verbatim:
// front_center's geometric center is (263,96) — an average of
// central_desert[120,80,370,140] and minefield_zone[248,38,315,125] — while
// the shooting is at the eastern end, (360,105). 97 tiles apart.
// ============================================================

const BATTLE: Position = { x: 360, y: 105 };
const RELIEF: Position = { x: 380, y: 150 }; // outside both bboxes, near the fight
/** The quiet west-end garrison of scenarioKnife1 — 刀3 重钉，见其用处的注释。 */
const QUIET_GARRISON: Position = { x: 185, y: 90 };

/** Fight at the east end of front_center; a 10-unit relief group just outside. */
function scenarioKnife1(opts: { engagedTimestamps: boolean; defendersInFront: boolean }): {
  state: GameState;
  front: Front;
  reliefIds: number[];
} {
  const state = emptyBattlefield();
  const front = frontById(state, "front_center");
  state.time = 1000;

  if (opts.defendersInFront) {
    // Four defenders taking fire at the east end — this is where help is needed.
    for (let i = 0; i < 4; i++) {
      addUnit(state, BATTLE.x + i, BATTLE.y, {
        lastAttackTime: opts.engagedTimestamps ? state.time - 2 : 0,
        lastDamagedAt: opts.engagedTimestamps ? state.time - 1 : undefined,
      });
    }
    // A quiet garrison at the WEST end, inside the same front, never engaged.
    // Tier 2 of the fallback must not let these drag the anchor west.
    //
    // ★ 第 8 级 刀3 重钉（与 WEST_CLUSTER 是两个坐标，都要动）：原写死 (130,90)，
    // 切图后掉出 front_center → T1j 的两簇局塌成一簇局。这一处比 WEST_CLUSTER 更险：
    // 它塌了**没有任何断言会红**，T1j/T1j-neg 照样绿，只是不再测任何东西。
    for (let i = 0; i < 2; i++) {
      addUnit(state, QUIET_GARRISON.x + i, QUIET_GARRISON.y, { lastAttackTime: 0, lastDamagedAt: undefined });
    }
  }

  // Visible enemy at the fight → freshFrontPowerRatio is non-null, so the
  // board takes its numeric branch (survival≈ + best_help).
  addUnit(state, BATTLE.x + 2, BATTLE.y + 1, { team: "enemy", lastAttackTime: state.time - 1 });

  // 10-unit unassigned relief group outside the front, clustered tight.
  const reliefIds: number[] = [];
  for (let i = 0; i < 10; i++) {
    reliefIds.push(addUnit(state, RELIEF.x + (i % 5), RELIEF.y + Math.floor(i / 5)).id);
  }
  return { state, front, reliefIds };
}

// 两簇同线（v4 §8）：东头 / 西头各一堆，只有一堆带交火时间戳。分档合同的两个
// 承重点都要靠它——「取最大簇不取平均」与「交火压人多」在单簇局里都测不出来。
//
// ★ 第 8 级 刀3 重钉：西头原在 (130,90)，那是 central_desert 西缘还在 x=120 的年代
// （那个矩形把敌军后方整块吞进了中央战线）。切完之后 front_center 从 x=181 起，
// (130,90) 归敌军后方——两簇局会塌成一簇局，而"取最大簇"与"取全体平均"在一簇局里
// 答案相同：**断言不会红，只会变成同义反复**。新坐标必须仍在 front_center 内
// （central_desert_w [181,81,229,137]）。
const EAST_CLUSTER: Position = { x: 360, y: 105 }; // central_desert 东端
const WEST_CLUSTER: Position = { x: 185, y: 90 };  // 同一条线的西端，相距 175 格

function twoClusterFront(opts: {
  eastN: number;
  westN: number;
  engaged: "east" | "west" | "none";
}): { state: GameState; front: Front; eastIds: number[]; westIds: number[] } {
  const state = emptyBattlefield();
  const front = frontById(state, "front_center");
  state.time = 1000;
  const stamp = (side: "east" | "west"): Partial<Unit> =>
    opts.engaged === side
      ? { lastAttackTime: state.time - 2, lastDamagedAt: state.time - 1 }
      : { lastAttackTime: 0, lastDamagedAt: undefined };
  const eastIds: number[] = [];
  const westIds: number[] = [];
  for (let i = 0; i < opts.eastN; i++) {
    eastIds.push(addUnit(state, EAST_CLUSTER.x + i, EAST_CLUSTER.y, stamp("east")).id);
  }
  for (let i = 0; i < opts.westN; i++) {
    westIds.push(addUnit(state, WEST_CLUSTER.x + i, WEST_CLUSTER.y, stamp("west")).id);
  }
  return { state, front, eastIds, westIds };
}

function runKnife1(): void {
  console.log("\n== 刀1 ETA 锚点：承诺量到战斗点，不是几何中心 ==");

  const { state, front, reliefIds } = scenarioKnife1({
    engagedTimestamps: true,
    defendersInFront: true,
  });

  const center = frontCenterPos(state, front);
  const anchor = battleAnchorFor(state, front);
  if (!center || !anchor) throw new Error("anchor/center null in a constructed front");

  // ── Construction validity (前置：局造得对，断言才有意义) ──
  //
  // 刀3 前的值是 (263,96)（5a1f195 事故档同值）。中央战线拆成五块之后中心移到
  // (273,103)——**这条断言变红正是它该干的活**：地图在脚下动了，本刀的所有 fixture
  // 都要重看一遍。所以这里仍然钉字面值（动了就红），另加一条独立重算校验它确实是
  // "各 region 矩形中心的平均"这个定义本身，而不是钉了个不知从哪来的数。
  check(
    "T1a 前置 front_center 几何中心 == (273,102)（刀3 前为 (263,96)）",
    center.x === 273 && center.y === 102,
    `实得 (${center.x},${center.y})`,
  );
  {
    let sx = 0, sy = 0, n = 0;
    for (const rid of front.regionIds) {
      const r = state.regions.get(rid);
      if (!r) continue;
      sx += (r.bbox[0] + r.bbox[2]) / 2;
      sy += (r.bbox[1] + r.bbox[3]) / 2;
      n += 1;
    }
    const defX = Math.round(sx / n), defY = Math.round(sy / n);
    check(
      "T1a2 前置 几何中心 == 五块 region 矩形中心的平均（定义级复算，不抄生产结果）",
      n === 5 && center.x === defX && center.y === defY,
      `生产 (${center.x},${center.y}) 定义 (${defX},${defY}) n=${n}`,
    );
  }
  check(
    "T1b 前置 战斗锚点落在交战守军身上（东端 x≈360）",
    Math.abs(anchor.x - (BATTLE.x + 1.5)) < 0.01 && Math.abs(anchor.y - BATTLE.y) < 0.01,
    `实得 (${anchor.x},${anchor.y})`,
  );
  check(
    "T1c 前置 两点相距 > 50 格（构造出真实分歧，非噪声）",
    dist(center, anchor) > 50,
    `实得 ${dist(center, anchor).toFixed(1)} 格`,
  );

  // ── The knife itself: which point did production measure to? ──
  const top = buildReinforceOptions(state, front).shown[0];
  check("T1d 前置 relief 群进了候选表", !!top && top.unitCount === 10, top ? `unitCount=${top.unitCount}` : "无候选");
  if (!top) return;

  const etaToBattle = etaTo(state, reliefIds, anchor);
  const etaToCenter = etaTo(state, reliefIds, center);
  check(
    "T1e 前置 两个锚点算出的 ETA 确实不同（否则本刀不可测）",
    etaToBattle !== etaToCenter,
    `battle=${etaToBattle}s center=${etaToCenter}s`,
  );

  checkKnife(
    "T1f 升级 payload etaSec 锚到战斗点",
    top.etaSec === etaToBattle,
    top.etaSec === etaToCenter,
    `payload=${top.etaSec}s battle=${etaToBattle}s center=${etaToCenter}s`,
  );

  // ── 双面同源：the board row must carry the same number (防将来分叉) ──
  const lines = buildFrontJudgmentLines(state);
  const row = lines.find((l) => l.includes("3. 中央战线"));
  check("T1g 前置 态势板产出中央战线行", !!row, row ?? "(无该行)");
  if (row) {
    const m = row.match(/eta≈(\d+)s/);
    check("T1h 前置 该行带 best_help eta", !!m, row);
    if (m) {
      const boardEta = Number(m[1]);
      checkKnife(
        "T1i 态势板 best_help eta == 升级 payload etaSec（同源，防分叉）",
        boardEta === etaToBattle && boardEta === top.etaSec,
        boardEta === etaToCenter,
        `board=${boardEta}s payload=${top.etaSec}s battle=${etaToBattle}s center=${etaToCenter}s`,
      );
    }
  }

  // ── 兜底各级（v4 §8：分档合同，2026-08-04 用户裁定 / Fable 5 裁决）──
  //
  // ★ 合同变更 1（T1j）：二级从「全体在线守军的【平均】」改为「最大簇质心」。
  //   变更原因：平均是个统计量，不是一个地方——西头一堆、东头一堆，平均值落在
  //   两堆中间的空地上，离谁都一百格（§8.2 第三档的实测病因）。
  //   出处：DIALOGUE_AB_KNIFE_REVIEW_BRIEF_20260803.md §8.2 / §8.4-3。
  const quiet = scenarioKnife1({ engagedTimestamps: false, defendersInFront: true });
  const quietAnchor = battleAnchorFor(quiet.state, quiet.front);
  // 局里两堆：东头 4 人、西头 2 人。新合同取东头那簇。
  //
  // ★ 第 8 级 刀3：修复前期望 `meanOfAllX` 原本写死 `(4*361.5 + 2*130.5)/6 = 284.5`。
  // 常数化的期望值是个陷阱——西头驻军一旦掉出这条线，局里只剩一簇，"最大簇"与
  // "全体平均"答案相同，而这条断言仍然绿：它不再能区分修复前后的两种行为，
  // 变成了同义反复。现在改为**从 state 用生产的战线成员判定重算**：谁在线内由
  // isInsideFront 说了算，fixture 一塌，下面的前置断言当场红。
  const inFrontXs: number[] = [];
  quiet.state.units.forEach((u) => {
    if (u.team !== "player" || u.hp <= 0) return;
    if (isInsideFront(quiet.state, quiet.front, u.position)) inFrontXs.push(u.position.x);
  });
  const meanOfAllX = inFrontXs.reduce((s, x) => s + x, 0) / (inFrontXs.length || 1);
  const biggestX = BATTLE.x + 1.5;
  check(
    "T1j0 前置 两簇都在线内（6 人：东头 4 + 西头 2），且两个答案确实不同",
    inFrontXs.length === 6 && Math.abs(biggestX - meanOfAllX) > 50,
    `线内 ${inFrontXs.length} 人 最大簇 ${biggestX.toFixed(2)} 全体平均 ${meanOfAllX.toFixed(2)}`,
  );
  checkKnife(
    "T1j ★合同变更★ 兜底二级 无人交火 → 【最大簇】质心（东头 4 人），不是全体平均",
    !!quietAnchor && Math.abs(quietAnchor.x - biggestX) < 0.01,
    !!quietAnchor && Math.abs(quietAnchor.x - meanOfAllX) < 0.01,
    `实得 ${quietAnchor ? quietAnchor.x.toFixed(2) : "null"} 最大簇 ${biggestX.toFixed(2)} 全体平均 ${meanOfAllX.toFixed(2)}`,
  );
  check(
    "T1j-neg ★负对照★ 落点绝不是两堆的中点（那是没人站的空地）",
    !!quietAnchor && Math.abs(quietAnchor.x - meanOfAllX) > 50,
    `实得 ${quietAnchor ? quietAnchor.x.toFixed(2) : "null"} 中点 ${meanOfAllX.toFixed(2)}`,
  );

  // ★ 合同变更 2（T1k）：线内无兵不再直接退回几何中心，先看这条线上【我方拥有
  //   什么】。实测：front_center 几何中心 (263,96) 是空沙漠，而我方在这条线上
  //   真正拥有的是中央前哨 (360,105)（§8.2 第五档，"第五档实测同样必要"）。
  //   battleAnchorFor 与派兵落点同走一把尺 ⇒ 这一档必然一起进来。
  const empty = scenarioKnife1({ engagedTimestamps: false, defendersInFront: false });
  const emptyAnchor = battleAnchorFor(empty.state, empty.front);
  const emptyCenter = frontCenterPos(empty.state, empty.front);
  const ownPost = empty.state.facilities.get("ea_player_central_post");
  check(
    "T1k0 前置 该线我方设施与几何中心确实是两个地方（否则本条不可测）",
    !!ownPost && !!emptyCenter && dist(ownPost.position, emptyCenter) > 50,
    ownPost && emptyCenter
      ? `post=(${ownPost.position.x},${ownPost.position.y}) center=(${emptyCenter.x},${emptyCenter.y}) d=${dist(ownPost.position, emptyCenter).toFixed(1)}`
      : "缺设施/中心",
  );
  checkKnife(
    "T1k ★合同变更★ 线内无兵但有我方设施 → 落到该设施（不是空沙漠中心）",
    !!emptyAnchor && !!ownPost &&
      emptyAnchor.x === ownPost.position.x && emptyAnchor.y === ownPost.position.y,
    !!emptyAnchor && !!emptyCenter &&
      emptyAnchor.x === emptyCenter.x && emptyAnchor.y === emptyCenter.y,
    `anchor=${emptyAnchor ? `${emptyAnchor.x},${emptyAnchor.y}` : "null"}`,
  );

  // 真荒线（无兵、无我方设施）才退回几何中心 —— 兜底的最后一级仍在。
  {
    const bare = emptyBattlefield();
    const bareFront = frontById(bare, "front_ridge"); // 线上三座设施全是敌/中立
    bare.time = 1000;
    const bareCenter = frontCenterPos(bare, bareFront);
    const bareDest = battleAnchorFor(bare, bareFront);
    check(
      "T1k2 荒线兜底 无兵且线上没有我方任何设施 → 退回 frontCenterPos",
      !!bareDest && !!bareCenter && bareDest.x === bareCenter.x && bareDest.y === bareCenter.y,
      `dest=${bareDest ? `${bareDest.x},${bareDest.y}` : "null"} center=${bareCenter ? `${bareCenter.x},${bareCenter.y}` : "null"}`,
    );
  }

  // ★ 合同变更 3（T1l）：旧局里交战堆恰好也是最大堆，一级二级同点 ⇒ 测不出谁压谁
  //   （旧断言是同义反复）。换成「东头 2 人在打、西头 4 人安静」——交火必须压过人多。
  {
    const tl = twoClusterFront({ eastN: 2, westN: 4, engaged: "east" });
    const d = battleAnchorFor(tl.state, tl.front);
    checkKnife(
      "T1l ★合同变更★ 交火簇压过人更多的安静簇（一级压二级，不是比人数）",
      !!d && Math.abs(d.x - (EAST_CLUSTER.x + 0.5)) < 0.01,
      !!d && Math.abs(d.x - ((2 * (EAST_CLUSTER.x + 0.5) + 4 * (WEST_CLUSTER.x + 1.5)) / 6)) < 0.01,
      `实得 ${d ? d.x.toFixed(2) : "null"} 交火簇 ${(EAST_CLUSTER.x + 0.5).toFixed(2)} 安静大簇 ${(WEST_CLUSTER.x + 1.5).toFixed(2)}`,
    );
    check(
      "T1l-neg ★负对照★ 人多的那簇没有赢（判据真的在量交火，不是量人数）",
      !!d && Math.abs(d.x - (WEST_CLUSTER.x + 1.5)) > 50,
      `实得 ${d ? d.x.toFixed(2) : "null"} 安静大簇 ${(WEST_CLUSTER.x + 1.5).toFixed(2)}`,
    );
  }
}

// ============================================================
// 刀A 续 — 撤退档（withdraw）：同一条线，撤和援不是同一个点。
//
// §7④ 实证：裸 retreat 被改写成"撤向原战斗锚"，6 个单位收到 retreat → (251,38)，
// 也就是敌人所在。撤退档的第一级是我方设施（退守要塞），第二级是【未交火】簇的
// 质心——交火簇在撤退档里永远不是答案。
// ============================================================

function runKnife1Withdraw(): void {
  console.log("\n== 刀A 撤退档：撤退落点永不落进交火堆 ==");

  // 西头一场恶仗，东头是我方的中央前哨（同一条线）。
  const tw = twoClusterFront({ eastN: 0, westN: 4, engaged: "west" });
  const post = tw.state.facilities.get("ea_player_central_post");
  const approach = frontDestinationFor(tw.state, tw.front, "approach");
  const withdraw = frontDestinationFor(tw.state, tw.front, "withdraw");
  check(
    "T1w0 前置 该线打在西头、我方设施在东头（两点相距 > 100 格）",
    !!post && !!approach && dist(approach, post.position) > 100,
    post && approach
      ? `fight=(${approach.x.toFixed(1)},${approach.y.toFixed(1)}) post=(${post.position.x},${post.position.y}) d=${dist(approach, post.position).toFixed(1)}`
      : "缺件",
  );
  checkKnife(
    "T1w ★ 同一条线：援兵去打仗那头，撤退去我方据点那头（两档不同点）",
    !!withdraw && !!post && withdraw.x === post.position.x && withdraw.y === post.position.y,
    !!withdraw && !!approach && Math.abs(withdraw.x - approach.x) < 0.01,
    `withdraw=${withdraw ? `${withdraw.x},${withdraw.y}` : "null"} approach=${approach ? `${approach.x.toFixed(1)},${approach.y.toFixed(1)}` : "null"}`,
  );
  check(
    "T1w-neg ★负对照★ 撤退落点离交火簇 > 100 格（绝不撤进正在打的那堆）",
    !!withdraw && !!approach && dist(withdraw, approach) > 100,
    withdraw && approach ? `d=${dist(withdraw, approach).toFixed(1)}` : "缺件",
  );

  // 无我方设施的线：撤退落到【未交火】簇，不是交火簇。
  {
    const st = emptyBattlefield();
    const fr = frontById(st, "front_ridge"); // 线上无我方设施
    st.time = 1000;
    const hot = { x: 215, y: 60 };   // kidney_ridge_zone[200,45,260,75]
    const cold = { x: 250, y: 100 }; // ruweisat_zone[230,85,275,115]
    for (let i = 0; i < 3; i++) addUnit(st, hot.x + i, hot.y, { lastAttackTime: st.time - 2, lastDamagedAt: st.time - 1 });
    for (let i = 0; i < 2; i++) addUnit(st, cold.x + i, cold.y, { lastAttackTime: 0, lastDamagedAt: undefined });
    const w = frontDestinationFor(st, fr, "withdraw");
    const a = frontDestinationFor(st, fr, "approach");
    checkKnife(
      "T1w2 ★ 无设施可退时撤向【未交火】那簇，援兵仍去交火那簇",
      !!w && Math.abs(w.x - (cold.x + 0.5)) < 0.01 && !!a && Math.abs(a.x - (hot.x + 1)) < 0.01,
      !!w && !!a && Math.abs(w.x - a.x) < 0.01,
      `withdraw=${w ? `${w.x.toFixed(1)},${w.y.toFixed(1)}` : "null"} approach=${a ? `${a.x.toFixed(1)},${a.y.toFixed(1)}` : "null"}`,
    );
  }

  // ★端到端·数兵+核坐标★ 具名撤退真的落在设施上，且带的是那批兵。
  {
    const { state, front } = twoClusterFront({ eastN: 0, westN: 4, engaged: "west" });
    const post = state.facilities.get("ea_player_central_post")!;
    const fleeIds: number[] = [];
    for (let i = 0; i < 4; i++) fleeIds.push(addUnit(state, 250 + i * 2, 38).id); // front_coastal
    const r = resolveIntent(
      { type: "retreat", fromFront: "front_coastal", toFront: front.id, quantity: "all" } as Intent,
      state, state.style,
    );
    const landings = r.orders.map((o) => o.target).filter((t): t is Position => !!t);
    const fightPos = frontDestinationFor(state, front, "approach")!;
    checkKnife(
      "T1w3 ★端到端·数兵核坐标★ 「撤到中央战线」= 4 个单位落在我方前哨附近，不在战场上",
      r.assignedUnitIds.length === fleeIds.length &&
        r.assignedUnitIds.every((id) => fleeIds.includes(id)) &&
        landings.length === fleeIds.length &&
        landings.every((t) => dist(t, post.position) <= 5) &&
        landings.every((t) => dist(t, fightPos) > 100),
      landings.length > 0 && landings.every((t) => dist(t, fightPos) <= 5),
      `assigned=${r.assignedUnitIds.length} landings=${JSON.stringify(landings)} post=(${post.position.x},${post.position.y}) fight=(${fightPos.x.toFixed(1)},${fightPos.y.toFixed(1)})`,
    );
  }
}

// ============================================================
// 刀F — attack 自己的档（回归修复；提案 §1-F / §3，2026-08-05）
//
// §8 把 attack 挂在 approach 档上，而 approach 的一级是"这条线上打得最凶的那处"。
// 手测当场坐实：「拿下山脊战线」把 14 个人送到 (250,100) 中央雷达——那是我方 I1
// 在打的地方，离敌方胜负点中央山脊 36.1 格、北部山脊 54.1 格；而 §8 之前的几何
// 中心 (239,76) 离中央山脊只有 10.8 格。旧中心表现好是本线几何巧合（两个胜负点
// 恰好夹住质心），所以修法不是回退，是给 attack 一档自己的：先打敌人的东西。
//
// 中立设施不进一档：中立 ≠ 敌方目标，而本局那个"打错的地方"恰恰是中立雷达。
// ============================================================

/** 山脊战线真形状：两个敌方胜负点 + 一个中立雷达 + 我方小簇正蹲在那个中立雷达上。 */
const RIDGE_VP_NEAR: Position = { x: 230, y: 70 };  // 中央山脊 ea_miteirya_ridge ★VP
const RIDGE_VP_FAR: Position = { x: 220, y: 55 };   // 北部山脊 ea_kidney_ridge ★VP
const RIDGE_NEUTRAL: Position = { x: 250, y: 100 }; // 中央雷达 ea_observation_post（中立）

function assaultFixture(): { state: GameState; front: Front; ourIds: number[]; squadIds: number[] } {
  const state = emptyBattlefield();
  const front = frontById(state, "front_ridge");
  state.time = 1000;
  // 我方小簇在中立雷达上交火 —— 手测那局的形状（I1 去占中央雷达，正在挨打）
  const ourIds: number[] = [];
  for (let i = 0; i < 3; i++) {
    ourIds.push(addUnit(state, RIDGE_NEUTRAL.x + i, RIDGE_NEUTRAL.y, {
      lastAttackTime: state.time - 2, lastDamagedAt: state.time - 1,
    }).id);
  }
  // 突击队在线外（东南），带编队以便 fromSquad 精确取源
  const squadIds: number[] = [];
  for (let i = 0; i < 6; i++) squadIds.push(addUnit(state, 300 + i, 130).id);
  state.squads.push({
    id: "F1", name: "突击分队", unitIds: squadIds,
    leader: { name: "Reyes", rank: "squad_leader", personality: "balanced" },
    currentMission: null, missionTarget: null, morale: 1,
    formationStyle: "line", ownerCommander: "chen", leaderName: "Reyes", role: "leader",
  });
  return { state, front, ourIds, squadIds };
}

function runKnifeF(): void {
  console.log("\n== 刀F attack 档：突击队打敌人的山头，不打自家遭遇战 ==");

  const { state, front, ourIds, squadIds } = assaultFixture();
  const ourCluster = { x: RIDGE_NEUTRAL.x + 1, y: RIDGE_NEUTRAL.y };
  const approachPt = frontDestinationFor(state, front, "approach")!;
  const assaultPt = frontDestinationFor(state, front, "assault")!;

  check(
    "TF0 前置 局造得对：我方小簇正蹲在中立雷达上交火，两个敌方胜负点在别处",
    Math.abs(approachPt.x - ourCluster.x) < 0.01 && Math.abs(approachPt.y - ourCluster.y) < 0.01 &&
      dist(ourCluster, RIDGE_VP_NEAR) > 30,
    `approach=(${approachPt.x},${approachPt.y}) 我方簇=(${ourCluster.x},${ourCluster.y}) 离最近VP=${dist(ourCluster, RIDGE_VP_NEAR).toFixed(1)}`,
  );

  checkKnife(
    "TF1 ★回归修复★ attack 落到敌方胜负点，不落自家交火簇、不落中立雷达",
    dist(assaultPt, RIDGE_VP_NEAR) <= 5 &&
      dist(assaultPt, ourCluster) > 30 && dist(assaultPt, RIDGE_NEUTRAL) > 30,
    dist(assaultPt, ourCluster) <= 5,
    `assault=(${assaultPt.x},${assaultPt.y}) 离VP=${dist(assaultPt, RIDGE_VP_NEAR).toFixed(1)} 离我方簇=${dist(assaultPt, ourCluster).toFixed(1)} 离中立雷达=${dist(assaultPt, RIDGE_NEUTRAL).toFixed(1)}`,
  );
  check(
    "TF1b 同级多个胜负点时取离我方立足点最近的那个（打够得着的山头）",
    dist(assaultPt, RIDGE_VP_NEAR) <= 5 && dist(assaultPt, RIDGE_VP_FAR) > 15,
    `离近VP=${dist(assaultPt, RIDGE_VP_NEAR).toFixed(1)} 离远VP=${dist(assaultPt, RIDGE_VP_FAR).toFixed(1)}`,
  );

  // ★端到端·数兵+核坐标★
  const r = resolveIntent(
    { type: "attack", fromSquad: "F1", toFront: front.id, quantity: "all" } as Intent,
    state, state.style,
  );
  const landings = r.orders.map((o) => o.target).filter((t): t is Position => !!t);
  // 判据分两层：编队【质心】钉在 VP 上（≤2 格），单兵允许编队展开半径（≤10 格）。
  // 6 人的进攻展开最外圈实测 7.8 格——那是队形不是落点错；把它当失败会把判据变成
  // 在量队形。真正承重的是与我方簇的 36 格分离，两个阈值差 3 倍，量得动。
  const centroid = landings.length
    ? { x: landings.reduce((a, t) => a + t.x, 0) / landings.length,
        y: landings.reduce((a, t) => a + t.y, 0) / landings.length }
    : null;
  checkKnife(
    "TF2 ★端到端·数兵核坐标★ 「进攻山脊战线」6 个单位落在敌方胜负点上",
    r.assignedUnitIds.length === squadIds.length &&
      r.assignedUnitIds.every((id) => squadIds.includes(id)) &&
      landings.length === squadIds.length &&
      !!centroid && dist(centroid, RIDGE_VP_NEAR) <= 2 &&
      landings.every((t) => dist(t, RIDGE_VP_NEAR) <= 10) &&
      landings.every((t) => dist(t, ourCluster) > 30),
    landings.length > 0 && landings.every((t) => dist(t, ourCluster) <= 10),
    `assigned=${r.assignedUnitIds.length}/${squadIds.length} 质心=${centroid ? `(${centroid.x.toFixed(1)},${centroid.y.toFixed(1)})` : "-"} 离VP最远=${landings.length ? Math.max(...landings.map((t) => dist(t, RIDGE_VP_NEAR))).toFixed(1) : "-"} 离我方簇最近=${landings.length ? Math.min(...landings.map((t) => dist(t, ourCluster))).toFixed(1) : "-"}`,
  );

  // ── 负对照 1：修 attack 不许动 approach ──
  const def = resolveIntent(
    { type: "defend", fromSquad: "F1", toFront: front.id, quantity: "all" } as Intent,
    state, state.style,
  );
  const defLandings = def.orders.map((o) => o.target).filter((t): t is Position => !!t);
  check(
    "TF3 ★负对照★ defend 到同一条线仍落我方簇（assault 档不得溢出到别的动词）",
    defLandings.length === squadIds.length &&
      defLandings.every((t) => dist(t, ourCluster) <= 5) &&
      defLandings.every((t) => dist(t, RIDGE_VP_NEAR) > 30),
    `landings=${JSON.stringify(defLandings.slice(0, 2))} 离我方簇=${defLandings[0] ? dist(defLandings[0], ourCluster).toFixed(1) : "-"}`,
  );

  // ── 负对照 2+3：线上没有敌设施 → 落回 approach 档；中立设施绝不当一档 ──
  {
    const st = assaultFixture().state;
    const fr = frontById(st, "front_ridge");
    // 把两个敌方胜负点打掉（hp=0），只剩中立雷达
    for (const id of ["ea_kidney_ridge", "ea_miteirya_ridge"]) {
      const f = st.facilities.get(id); if (f) f.hp = 0;
    }
    // 我方簇挪到别处，与中立雷达拉开距离，好判断落点到底跟谁走
    st.units.forEach((u) => { if (u.team === "player") { u.position = { x: 215 + (u.id % 3), y: 60 }; } });
    const elsewhere = { x: 216, y: 60 };
    const d = frontDestinationFor(st, fr, "assault")!;
    checkKnife(
      "TF4 ★负对照★ 线上无敌设施 → 落回 approach 档（我方立足点），中立雷达绝不当目标",
      dist(d, elsewhere) <= 3 && dist(d, RIDGE_NEUTRAL) > 30,
      dist(d, RIDGE_NEUTRAL) <= 3,
      `落点=(${d.x.toFixed(1)},${d.y.toFixed(1)}) 离我方簇=${dist(d, elsewhere).toFixed(1)} 离中立雷达=${dist(d, RIDGE_NEUTRAL).toFixed(1)}`,
    );
  }

  // ── 负对照 4：retreat 一动不动 ──
  // ★ 判据不能写成"撤退落点离敌 VP 够远"：本线几何中心 (239,76) 离中央山脊只有
  //   10.8 格，这正是提案 §1-F 说的那个巧合。量"离得远"会把巧合当合同。
  //   要量的是【撤退档走的还是它自己那条梯子】：三级兜底 = frontCenterPos。
  const wd = frontDestinationFor(state, front, "withdraw")!;
  const ridgeCenter = frontCenterPos(state, front)!;
  check(
    "TF5 ★负对照★ retreat 档一字未动（我方全在交火 → 仍走三级兜底 frontCenterPos，不是 assault 选的 VP）",
    wd.x === ridgeCenter.x && wd.y === ridgeCenter.y &&
      !(wd.x === assaultPt.x && wd.y === assaultPt.y),
    `withdraw=(${wd.x},${wd.y}) frontCenterPos=(${ridgeCenter.x},${ridgeCenter.y}) assault=(${assaultPt.x},${assaultPt.y})`,
  );

  // ── T1 系列合同不动：assault 不许进 ETA 承诺那条路 ──
  const anchor = battleAnchorFor(state, front)!;
  check(
    "TF6 ★边界★ battleAnchorFor 仍是 approach（ETA 承诺是增援语义，不是进攻语义）",
    Math.abs(anchor.x - approachPt.x) < 0.01 && Math.abs(anchor.y - approachPt.y) < 0.01 &&
      dist(anchor, RIDGE_VP_NEAR) > 30,
    `anchor=(${anchor.x},${anchor.y}) approach=(${approachPt.x},${approachPt.y})`,
  );
  check("TF7 前置 我方小簇确实在册（局没造空）", ourIds.length === 3, `${ourIds.length}`);

  // ── 档位次序三条（用户裁定 2026-08-05：效果最大处排序）──
  //
  // 1) 中央战线：全线唯一敌设施是西南角营房 (120,140)，非胜负点；我方在东头交火。
  //    「我方交火簇」必须压过「敌方非VP设施」——否则「全军进攻中央战线」= 74 人
  //    向 240 格外行军（实测；preflight 那 4 条红就是这么来的）。
  {
    const st = emptyBattlefield();
    const fr = frontById(st, "front_center");
    st.time = 1000;
    const east = { x: 356, y: 108 }; // 东头，手测那局战况所在
    for (let i = 0; i < 4; i++) {
      addUnit(st, east.x + i, east.y, { lastAttackTime: st.time - 2, lastDamagedAt: st.time - 1 });
    }
    const barracks = st.facilities.get("ea_axis_barracks2")!;
    const d = frontDestinationFor(st, fr, "assault")!;
    check(
      "TF8a 前置 该线无敌方胜负点，唯一敌设施是角落营房，且离我方交火处 > 200 格",
      barracks.team === "enemy" && !(st.captureObjectives ?? []).includes(barracks.id) &&
        dist(barracks.position, east) > 200,
      `营房=(${barracks.position.x},${barracks.position.y}) 离东头=${dist(barracks.position, east).toFixed(1)}`,
    );
    checkKnife(
      "TF8 ★次序★ 线上有我方交火时，敌方【非胜负点】设施不得成为落点（交火簇压过它）",
      dist(d, east) <= 5 && dist(d, barracks.position) > 200,
      dist(d, barracks.position) <= 5,
      `落点=(${d.x.toFixed(1)},${d.y.toFixed(1)}) 离交火处=${dist(d, east).toFixed(1)} 离营房=${dist(d, barracks.position).toFixed(1)}`,
    );
  }

  // 2) 敌军后方：四个敌设施、零胜负点、我方一人没有 ⇒ 必须落到敌方设施，
  //    且取离 frontCenterPos 最近的那个（确定性），即敌军总部。
  {
    const st = emptyBattlefield();
    const fr = frontById(st, "front_axis_rear");
    st.time = 1000;
    const hq = st.facilities.get("ea_rommel_hq")!;
    const center = frontCenterPos(st, fr)!;
    const d = frontDestinationFor(st, fr, "assault")!;
    const enemyHere = [...st.facilities.values()].filter(
      (f) => f.team === "enemy" && f.hp > 0 && dist(f.position, center) < 1e9 &&
        fr.regionIds.some((rid) => { const r = st.regions.get(rid); return !!r &&
          f.position.x >= r.bbox[0] && f.position.x <= r.bbox[2] &&
          f.position.y >= r.bbox[1] && f.position.y <= r.bbox[3]; }),
    );
    check(
      "TF9a 前置 敌军后方：多个敌设施、零胜负点、我方零人员",
      enemyHere.length >= 3 && enemyHere.every((f) => !(st.captureObjectives ?? []).includes(f.id)),
      enemyHere.map((f) => `${f.name}@${f.position.x},${f.position.y}`).join(" | "),
    );
    checkKnife(
      "TF9 ★次序★ 无我方人员时落敌方设施：取离 frontCenterPos 最近的那个（敌军总部，确定性）",
      d.x === hq.position.x && d.y === hq.position.y &&
        enemyHere.every((f) => dist(hq.position, center) <= dist(f.position, center)),
      d.x === center.x && d.y === center.y,
      `落点=(${d.x},${d.y}) 敌总部=(${hq.position.x},${hq.position.y}) 中心=(${center.x},${center.y}) 各设施离中心=${enemyHere.map((f) => `${f.name}:${dist(f.position, center).toFixed(1)}`).join(" ")}`,
    );
  }

  // 3) 敌非VP设施 压过 我方设施（第 4 档 > 第 5 档）：线上无我方人员，
  //    同时存在敌方营房与我方据点 ⇒ 打敌人的，不是回自己家。
  {
    const st = emptyBattlefield();
    const fr = frontById(st, "front_center");
    st.time = 1000; // 线内零我方人员

    // ★ 第 8 级 刀3：这条合同原来的 fixture 是 `ea_axis_barracks2`(120,140)。它当时
    // 在中央战线**只因为 central_desert 的西缘伸到 x=120 把敌军后方整块吞了进来**——
    // 那正是本刀切掉的病。切完之后中央战线一个敌方设施都没有了，第 4 档在这条线上
    // 失去了 fixture。
    // 按 R14 裁定：不删牙、不换弱断言，改为**在测试态内造一个中央线内的敌方非 VP
    // 设施**（字段与生产设施同形，只活在这一个局部 state 里，不碰地图数据）。
    // 它必须不在 captureObjectives 里，否则测的就变成第 1 档了。
    const plantedId = "bench_axis_supply_dump";
    st.facilities.set(plantedId, {
      id: plantedId,
      name: "轴心野战补给点（台架）",
      type: "ammo_depot",
      tags: ["bench-fixture"],
      position: { x: 300, y: 110 },   // inside central_desert[276,80,370,137]
      team: "enemy",
      hp: 300,
      maxHp: 300,
      regionId: "central_desert",
      strategicEffect: "",
      captureProgress: 0,
      capturingTeam: null,
    });
    const dump = st.facilities.get(plantedId)!;
    const ourPost = st.facilities.get("ea_player_central_post")!;
    const d = frontDestinationFor(st, fr, "assault")!;
    check(
      "TF10a 前置 该线同时有敌方非VP设施与我方前哨、线内零我方人员，且该敌设施不是胜负点",
      dump.team === "enemy" && ourPost.team === "player" &&
        isInsideFront(st, fr, dump.position) && isInsideFront(st, fr, ourPost.position) &&
        !(st.captureObjectives ?? []).includes(plantedId) &&
        ![...st.units.values()].some((u) => u.team === "player"),
      `敌设施=(${dump.position.x},${dump.position.y}) 我方前哨=(${ourPost.position.x},${ourPost.position.y})`,
    );
    checkKnife(
      "TF10 ★次序★ 线上无我方人员时，敌方非VP设施压过我方设施（第4档 > 第5档）",
      d.x === dump.position.x && d.y === dump.position.y,
      d.x === ourPost.position.x && d.y === ourPost.position.y,
      `落点=(${d.x},${d.y}) 敌设施=(${dump.position.x},${dump.position.y}) 我方前哨=(${ourPost.position.x},${ourPost.position.y})`,
    );
  }
}

// ============================================================
// H1 — 抽走带任务的部队必须说出口（披露，不是闸；用户裁定 2026-08-05）
//
// 手测 03:15：一句「拿下山脊战线」派出 14 人，其中 10 个是长官 76 秒前亲自
// 押到中央战线的增援。全军池 + busy 旁路是有意留宽的（"全军"就该是全军），
// 裁定不动它——但抽走就得报账。
//
// ★ 判据：披露句里的数字必须 == 台架【独立重算】的 assignedUnitIds ∩ 忙碌集。
//   谁报的数字对方重算才作数；读句子里的数字算自证。
// ============================================================

function runH1(): void {
  console.log("\n== H1 抽走带任务的部队必须说出口 ==");

  const state = emptyBattlefield();
  state.time = 1000;
  const front = frontById(state, "front_ridge");

  // 忙碌组：中央战线东头，带 defend 单在身（长官刚押过去的那种）
  const busyIds: number[] = [];
  for (let i = 0; i < 4; i++) {
    const u = addUnit(state, 356 + i, 108, { state: "defending" });
    u.orders = [{ unitIds: [u.id], action: "defend", target: { x: 356, y: 108 }, priority: 1 }];
    busyIds.push(u.id);
  }
  // 闲置组：线外待命，零单零状态
  const idleIds: number[] = [];
  for (let i = 0; i < 5; i++) idleIds.push(addUnit(state, 300 + i, 130).id);

  const all = [...busyIds, ...idleIds];
  const pull = describeCommittedPull(state, all);
  // 台架独立重算，绝不读句子里的数
  const recount = all.filter((id) => {
    const u = state.units.get(id)!;
    return !(u.state === "idle" && u.orders.length === 0);
  });
  check(
    "TH1a 前置 局造得对：4 个带 defend 任务 + 5 个真闲置",
    recount.length === 4 && recount.every((id) => busyIds.includes(id)),
    `重算忙碌=${recount.length} 忙碌组=${busyIds.length} 闲置组=${idleIds.length}`,
  );
  checkKnife(
    "TH1 ★披露★ 抽走带任务的部队 → 回执侧说出口，数字 == 独立重算的交集",
    !!pull && pull.count === recount.length &&
      pull.unitIds.slice().sort((a, b) => a - b).join(",") === recount.slice().sort((a, b) => a - b).join(",") &&
      pull.line.includes(String(recount.length)),
    pull === null,
    pull ? `count=${pull.count} 重算=${recount.length} 句子=「${pull.line}」` : "无披露句",
  );
  check(
    "TH1b 披露句点名了任务去处（不是一句「有部队被抽走」了事）",
    !!pull && pull.line.includes("设防") && pull.line.includes("中央战线"),
    pull ? pull.line : "(无)",
  );

  // ── 负对照：全闲置派兵零披露行 ──
  checkKnife(
    "TH1c ★负对照★ 全闲置派兵 → 一个字都不说（披露不得退化成每次都响的噪音）",
    describeCommittedPull(state, idleIds) === null,
    describeCommittedPull(state, idleIds) !== null,
    JSON.stringify(describeCommittedPull(state, idleIds)),
  );
  check(
    "TH1d 边界 空名单/阵亡单位不产出披露行",
    describeCommittedPull(state, []) === null &&
      (() => { const u = state.units.get(busyIds[0])!; const hp = u.hp; u.hp = 0; u.state = "dead";
        const r = describeCommittedPull(state, [busyIds[0]]); u.hp = hp; u.state = "defending"; return r === null; })(),
  );

  // ── 端到端：真派兵一次，数 assignedUnitIds ∩ 忙碌集 ──
  {
    const before = new Set(
      [...state.units.values()].filter((u) => u.team === "player" && !(u.state === "idle" && u.orders.length === 0)).map((u) => u.id),
    );
    const r = resolveIntent(
      { type: "attack", toFront: front.id, quantity: "all" } as Intent, state, state.style,
    );
    const pulled = r.assignedUnitIds.filter((id) => before.has(id));
    const d = describeCommittedPull(state, r.assignedUnitIds);
    checkKnife(
      "TH1e ★端到端·数兵★ 一道「全军进攻」下去，披露数 == 派出名单里本来有任务的那些",
      pulled.length > 0 && !!d && d.count === pulled.length,
      pulled.length > 0 && d === null,
      `assigned=${r.assignedUnitIds.length} 其中带任务=${pulled.length} 披露=${d ? d.count : "无"}`,
    );
  }
}

// ============================================================
// 刀2a — escalation tickets: the machine handle for "那批兵".
//
// The hardest tooth (user-promoted 2026-08-02): a cluster STRADDLING the front
// boundary makes battleBoard and the escalation produce identically-labelled
// groups with different membership. The ticket must carry the ESCALATION
// candidate's roster; taking the board's would dispatch twice what Chen
// promised, silently.
// ============================================================

// 刀3 重钉：南缘 140→137，原来的 (360,138) 出线了，"同名不同成员"的坑就不成立了
// （板子 10 人 == 升级 5 人，T2b 前置当场红）。两点必须一个在 front_center 内、
// 一个在外，且相距 5 格以内——否则它们不再是同一个空间簇，坑也就不是那个坑。
const STRADDLE_INSIDE: Position = { x: 360, y: 135 }; // inside central_desert[276,80,370,137]
const STRADDLE_OUTSIDE: Position = { x: 360, y: 140 }; // outside, 5 tiles away → same cluster

function scenarioStraddle(): { state: GameState; front: Front; insideIds: number[]; outsideIds: number[] } {
  const state = emptyBattlefield();
  const front = frontById(state, "front_center");
  state.time = 1000;
  const insideIds: number[] = [];
  const outsideIds: number[] = [];
  for (let i = 0; i < 5; i++) insideIds.push(addUnit(state, STRADDLE_INSIDE.x + i, STRADDLE_INSIDE.y).id);
  for (let i = 0; i < 5; i++) outsideIds.push(addUnit(state, STRADDLE_OUTSIDE.x + i, STRADDLE_OUTSIDE.y).id);
  return { state, front, insideIds, outsideIds };
}

function runKnife2a(): void {
  console.log("\n== 刀2a 番号登记簿：承诺==执行 ==");
  resetEscalationTickets();

  const { state, front, insideIds, outsideIds } = scenarioStraddle();

  // ── The tooth: board grouping vs escalation grouping ──
  const boardGroups = buildReinforceOptions(state, null).options.filter((o) => o.label.includes("未编组"));
  const escGroups = buildReinforceOptions(state, front).options.filter((o) => o.label.includes("未编组"));
  check(
    "T2a 前置 板子与升级候选标签相同（同名陷阱成立）",
    boardGroups.length > 0 && escGroups.length > 0 && boardGroups[0].label === escGroups[0].label,
    `board="${boardGroups[0]?.label}" esc="${escGroups[0]?.label}"`,
  );
  check(
    "T2b 前置 同名但成员不同：板子 10 / 升级 5（坑是真的）",
    boardGroups[0]?.unitCount === 10 && escGroups[0]?.unitCount === 5,
    `board=${boardGroups[0]?.unitCount} esc=${escGroups[0]?.unitCount}`,
  );

  const minted = mintEscalationTickets(state, front);
  const groupTicket = minted.find((t) => t.label.includes("未编组"));
  check("T2c 前置 铸出了群候选的号", !!groupTicket, minted.map((t) => `${t.gNumber}=${t.label}`).join(" | "));
  if (!groupTicket) return;

  const outsideSet = new Set(outsideIds);
  const insideSet = new Set(insideIds);
  checkKnife(
    "T2d ★牙★ 番号快照 == 升级候选的 5 人（不是板子的 10 人）",
    groupTicket.unitCount === 5 && groupTicket.unitIds.every((id) => outsideSet.has(id)),
    groupTicket.unitCount === 10,
    `快照 ${groupTicket.unitCount} 人 ids=[${groupTicket.unitIds.join(",")}]`,
  );
  checkKnife(
    "T2e ★牙★ 快照里零个线内单位（不抽已交战的兵）",
    groupTicket.unitIds.every((id) => !insideSet.has(id)),
    groupTicket.unitIds.some((id) => insideSet.has(id)),
    `线内 ids=[${insideIds.join(",")}]`,
  );
  check(
    "T2f 陈口播的数字 == 快照人数（承诺==执行的算术面）",
    groupTicket.unitCount === groupTicket.unitIds.length,
    `unitCount=${groupTicket.unitCount} ids=${groupTicket.unitIds.length}`,
  );

  // ── 生命周期：一次性 + 惰性过期 + 核名单 ──
  const g = groupTicket.gNumber;
  check("T2g 号格式 G+数字，且 isTicketRef 认得", /^G\d+$/.test(g) && isTicketRef(g), g);
  check("T2h 大小写无关解析", lookupEscalationTicket(g.toLowerCase(), state.time).ok, g.toLowerCase());

  const okNow = lookupEscalationTicket(g, state.time);
  check("T2i 在窗内可用", okNow.ok);

  const expired = lookupEscalationTicket(g, state.time + TICKET_TTL_SEC + 1);
  check(
    "T2j 惰性过期：超窗一秒即拒（reason=expired，非静默兜底）",
    !expired.ok && expired.reason === "expired",
    expired.ok ? "仍可用" : expired.reason,
  );

  check(
    "T2k 未知号响亮拒绝（不猜、不兜底）",
    (() => { const r = lookupEscalationTicket("G9999", state.time); return !r.ok && r.reason === "unknown"; })(),
  );

  // 核名单：kill two of the five → only survivors go, receipt reports the real number
  const dead = groupTicket.unitIds.slice(0, 2);
  for (const id of dead) { const u = state.units.get(id); if (u) { u.hp = 0; u.state = "dead"; } }
  const live = liveMembersOf(state, groupTicket);
  check(
    "T2l 核名单：阵亡剔除，余部出发（5→3，回执报真实数）",
    live.length === 3 && live.every((id) => !dead.includes(id)),
    `live=${live.length} [${live.join(",")}]`,
  );

  burnEscalationTicket(g);
  const burned = lookupEscalationTicket(g, state.time);
  check(
    "T2m 一次性：烧号后同一单不可再执行",
    !burned.ok && burned.reason === "burned",
    burned.ok ? "仍可用" : burned.reason,
  );

  // ── 番号不复用（P0-1 换皮的微缩版）──
  const before = minted.map((t) => t.gNumber);
  const again = mintEscalationTickets(state, front);
  const overlap = again.filter((t) => before.includes(t.gNumber));
  check("T2n 番号同局单调递增、永不复用", overlap.length === 0, `重号 ${overlap.map((t) => t.gNumber).join(",")}`);

  // ── prompt 许可行 ──
  const line = ticketPromptLine(minted);
  check("T2o 许可行含号与人数", !!line && line.includes(g) && line.includes(`${groupTicket.unitCount}units`), line ?? "null");
  check(
    "T2p 许可行明说群名仍非把手（不推翻两堵墙的禁令）",
    !!line && line.includes("群名仍然不是"),
    line ?? "null",
  );
}

// ============================================================
// 刀2b — the pure half of the wiring: one construction feeds both the spoken
// payload and the tickets, and the translation verdict is decided in core
// (GameCanvas/ChatPanel have no node harness — that blind spot shipped a
// reversed frame label once already).
// ============================================================

function runKnife2b(): void {
  console.log("\n== 刀2b 接线的纯函数面 ==");
  resetEscalationTickets();

  const { state, front } = scenarioStraddle();
  const crisis = makeCrisis(front);
  const built = buildFrontEscalationWithTickets(state, crisis);

  // ── 单次构建：payload 与番号必须描述同一批候选 ──
  const groupTicket = built.tickets.find((t) => t.label.includes("未编组"));
  check("T3a 合成入口同时产出 payload 与番号", built.payload.length > 0 && built.tickets.length > 0,
    `tickets=${built.tickets.length}`);
  check(
    "T3b payload 里 serialize 的候选人数 == 番号快照人数（同一次构建）",
    !!groupTicket && built.payload.includes(`${groupTicket.unitCount}`),
    groupTicket ? `ticket=${groupTicket.unitCount} payload含该数=${built.payload.includes(String(groupTicket.unitCount))}` : "无群号",
  );
  check(
    "T3c payload 文本不含 G 番号（号只走 ACTIVE_ESCALATION，不污染 SITUATION）",
    !/G\d+/.test(built.payload),
    built.payload.split("\n").find((l) => /G\d+/.test(l)) ?? "",
  );

  // ── anchor 回填断言（用户 item 2）：(0,0) 占位不许活过接线 ──
  const expectAnchor = battleAnchorFor(state, front);
  check(
    "T3d anchor 非 (0,0) 占位",
    !!groupTicket && groupTicket.anchor !== null &&
      !(groupTicket.anchor.x === 0 && groupTicket.anchor.y === 0),
    groupTicket?.anchor ? `${groupTicket.anchor.x},${groupTicket.anchor.y}` : "null",
  );
  check(
    "T3e anchor == 刀1 的 battleAnchorFor（两刀同一个点）",
    !!groupTicket && !!expectAnchor && groupTicket.anchor !== null &&
      groupTicket.anchor.x === expectAnchor.x && groupTicket.anchor.y === expectAnchor.y,
    `ticket=${groupTicket?.anchor ? `${groupTicket.anchor.x},${groupTicket.anchor.y}` : "null"} battleAnchor=${expectAnchor ? `${expectAnchor.x},${expectAnchor.y}` : "null"}`,
  );

  // ── TTL 对齐（用户 item 3）──
  check("T3f 番号 TTL == messageStore 升级窗口 120s（同一游戏时钟）", TICKET_TTL_SEC === 120, `${TICKET_TTL_SEC}`);

  // ── 翻译判决（ChatPanel 只做路由，判断全在这里）──
  if (!groupTicket) return;
  const g = groupTicket.gNumber;

  const notTicket = resolveTicketReference(state, "Aiden", state.time);
  check("T3g 非番号引用原路放行（不劫持正常命令）", notTicket.kind === "not_a_ticket", notTicket.kind);

  const nullRef = resolveTicketReference(state, undefined, state.time);
  check("T3h 无 fromSquad 原路放行", nullRef.kind === "not_a_ticket", nullRef.kind);

  const good = resolveTicketReference(state, g, state.time);
  checkKnife(
    "T3i ★ 番号翻成冻结名单（5 人，全是线外那批）",
    good.kind === "dispatch" && good.unitIds.length === 5,
    good.kind === "dispatch" && good.unitIds.length === 10,
    good.kind === "dispatch" ? `${good.unitIds.length} 人 [${good.unitIds.join(",")}]` : good.kind,
  );

  const stale = resolveTicketReference(state, g, state.time + TICKET_TTL_SEC + 1);
  check(
    "T3j 过期＝响亮拒绝＋人话，零执行",
    stale.kind === "refuse" && stale.reason === "expired" && stale.line.length > 0,
    stale.kind === "refuse" ? `${stale.reason}: ${stale.line}` : stale.kind,
  );

  const unknown = resolveTicketReference(state, "G9999", state.time);
  check(
    "T3k 未知号＝响亮拒绝，绝不静默兜底",
    unknown.kind === "refuse" && unknown.reason === "unknown",
    unknown.kind,
  );

  burnEscalationTicket(g);
  const twice = resolveTicketReference(state, g, state.time);
  check(
    "T3l 烧号后再引用＝拒绝（同一提案不执行两遍）",
    twice.kind === "refuse" && twice.reason === "burned",
    twice.kind === "refuse" ? twice.reason : twice.kind,
  );

  // ── 核空：全员阵亡 → 拒绝而不是派零人 ──
  resetEscalationTickets();
  const fresh = buildFrontEscalationWithTickets(state, makeCrisis(front));
  const t2 = fresh.tickets.find((t) => t.label.includes("未编组"));
  if (t2) {
    for (const id of t2.unitIds) { const u = state.units.get(id); if (u) { u.hp = 0; u.state = "dead"; } }
    const gone = resolveTicketReference(state, t2.gNumber, state.time);
    check(
      "T3m 名单核空＝拒绝＋人话（不派零人、不换人顶替）",
      gone.kind === "refuse" && gone.reason === "all_gone",
      gone.kind === "refuse" ? `${gone.reason}: ${gone.line}` : gone.kind,
    );
  }

  // ── 回执报真实数（承诺与实发对账）──
  check(
    "T3n 回执足额时报promised数",
    ticketDispatchReceipt(groupTicket, groupTicket.unitCount).includes(`${groupTicket.unitCount}个单位`),
    ticketDispatchReceipt(groupTicket, groupTicket.unitCount),
  );
  check(
    "T3o 回执缺额时同时报实发与原报（不假装足额）",
    (() => { const r = ticketDispatchReceipt(groupTicket, 3);
      return r.includes("3") && r.includes(`${groupTicket.unitCount}`); })(),
    ticketDispatchReceipt(groupTicket, 3),
  );

  // T3p（绊索引导句断言）已随绊索删除 — 见 runKnifeB1 的护栏登记表。
}

// ============================================================
// B 刀①「听得见」— 确认词表只准当捷径，绝不准当闸
//
// 事故：Codex 在 preflight round-2 立过一条护栏，写在词表正上方——
//   "NEVER EXPAND — semantic fallback owns natural language.
//    ANY word-list miss goes to the LLM pendingDecision pass."
// 即：命中 = 抄近路，未命中 = 照常进 LLM，词表没有语义裁决权。
// v4 刀2b 把同一个词表反过来用：命中就拦下、不进 LLM、回一句罐头。安全性质翻转
// （miss→LLM 变成 hit→罐头），词表从加速器变成了法官。护栏就在同一个文件里，
// 往上九百行，没人看见。
//
// ★ 教训：护栏写成注释拦不住后来的人。所以这里把它变成会 FAIL 的断言——
//   确认词的每一个调用点都必须登记并声明政策；多出一个未登记的，台架当场炸。
// ============================================================

type ConfirmSitePolicy =
  | "fast-path"    // 命中抄近路（仅限已有待批合同）；未命中必须落回 LLM
  | "telemetry"    // 只读打点，不改变路由
  | "context-only"; // 调整上下文/状态，但不拦截 LLM 调用

interface ConfirmSite {
  token: "isConfirmReply" | "isCancelReply";
  nth: number;
  policy: ConfirmSitePolicy;
  note: string;
}

/** ChatPanel 里确认词判定的全部活调用点。**新增一个就必须先登记并声明政策。** */
const CONFIRM_WORD_SITES: ConfirmSite[] = [
  { token: "isConfirmReply", nth: 1, policy: "fast-path",
    note: "待批合同存在时直接执行该合同（避开确认死循环）" },
  { token: "isCancelReply", nth: 1, policy: "fast-path",
    note: "待批合同存在时直接放弃该合同" },
  { token: "isConfirmReply", nth: 2, policy: "telemetry",
    note: "V4_BARE_CONFIRM_EXEC 打点：裸确认答复在案升级时记一行，不改路由" },
  { token: "isCancelReply", nth: 2, policy: "context-only",
    note: "取消/推辞时清掉在案升级，避免串到下一条命令；消息照常进 LLM" },
];

const CHATPANEL = "apps/web/src/ChatPanel.tsx";

function runKnifeB1(): void {
  console.log("\n== B 刀① 听得见：确认词表只准当捷径，不准当闸 ==");

  const src = readFileSync(CHATPANEL, "utf8").split("\n");
  const seen = new Map<string, number>();
  const found: { token: string; nth: number; line: number }[] = [];
  src.forEach((raw, i) => {
    const line = raw.trim();
    if (line.startsWith("//") || line.startsWith("*") || line.startsWith("/*")) return;
    if (/^(export )?function is(Confirm|Cancel)Reply\(/.test(line)) return; // 定义本身不算
    for (const token of ["isConfirmReply", "isCancelReply"]) {
      if (!new RegExp(`\\b${token}\\(`).test(line)) continue;
      const nth = (seen.get(token) ?? 0) + 1;
      seen.set(token, nth);
      found.push({ token, nth, line: i + 1 });
    }
  });

  const declared = new Set(CONFIRM_WORD_SITES.map((s) => `${s.token}#${s.nth}`));
  const undeclared = found.filter((f) => !declared.has(`${f.token}#${f.nth}`));
  const missing = CONFIRM_WORD_SITES.filter(
    (s) => !found.some((f) => f.token === s.token && f.nth === s.nth),
  );

  check(
    "TB1 ★护栏★ 确认词没有未登记的调用点（新增一处必须先声明政策）",
    undeclared.length === 0,
    undeclared.map((f) => `${f.token}#${f.nth}@:${f.line}`).join(" , "),
  );
  check(
    "TB2 ★护栏★ 登记表里没有已消失的调用点",
    missing.length === 0,
    missing.map((s) => `${s.token}#${s.nth}`).join(" , "),
  );
  check(
    "TB3 ★护栏★ 没有任何调用点被声明为闸（policy 不含 blocker 类）",
    CONFIRM_WORD_SITES.every((s) =>
      s.policy === "fast-path" || s.policy === "telemetry" || s.policy === "context-only"),
    CONFIRM_WORD_SITES.map((s) => `${s.token}#${s.nth}=${s.policy}`).join(" "),
  );

  // 具体回归钉：那句罐头必须从 ChatPanel 彻底消失（绊索的唯一出口）
  const body = src.join("\n");
  checkKnife(
    "TB4 ★ 绊索已拆：ChatPanel 不再引用 NO_PROPOSAL_GUIDANCE（咨询后的「可以」必须能进 LLM）",
    !body.includes("NO_PROPOSAL_GUIDANCE"),
    body.includes("NO_PROPOSAL_GUIDANCE"),
    body.includes("NO_PROPOSAL_GUIDANCE") ? "仍被引用" : "已移除",
  );
  check(
    "TB5 捷径本身保留：待批合同下的确认/取消仍走本地快路（不得回到确认死循环）",
    found.some((f) => f.token === "isConfirmReply" && f.nth === 1) &&
      found.some((f) => f.token === "isCancelReply" && f.nth === 1),
    found.map((f) => `${f.token}#${f.nth}`).join(" "),
  );
}

// ============================================================
// B 刀②「知道指谁」— 被说出口的部队都有临时番号
//
// 手测坐实的死链：群标签不是合法 fromSquad → 模型退回"只给目的地"的兜底 →
// 引擎的就近优先把源池取成【目的地已有的部队】→ 承诺 6 辆坦克，实派 1 个原地
// 幸存者，回执还念着"6辆主战坦克增援中央战线"。
//
// ★ 本刀的核心裁定：**番号是地址，不是背书。** 引擎拒绝「推荐」赶不到的部队
// （诚实闸）与拒绝「让长官够得着」它们，是两件事，只有前者归引擎管。
// ============================================================

function runKnifeB2(): void {
  console.log("\n== B 刀② 知道指谁：说出口的部队都有把手 ==");

  // ── 纯度：不给铸号器 ⇒ 行字节不变、一个号都不铸 ──
  resetEscalationTickets();
  const pure = lateCandidateFixture();
  const pureRow1 = buildFrontJudgmentLines(pure.state).find((l) => l.includes("1. 北部战线"));
  const pureRow2 = buildFrontJudgmentLines(pure.state).find((l) => l.includes("1. 北部战线"));
  check(
    "TB6 纯度 无铸号器时行内无 handle=，且零铸号（台架/心跳/复算不得产生副作用）",
    !!pureRow1 && !pureRow1.includes("handle=") && pureRow1 === pureRow2 &&
      _ticketsForTest().length === 0,
    `tickets=${_ticketsForTest().length} row=${pureRow1 ?? "(无)"}`,
  );

  // ── ★ 赶不到的那批也必须有号（地址≠背书）──
  resetEscalationTickets();
  const late = lateCandidateFixture();
  const lateRow = buildFrontJudgmentLines(late.state, (f, o) => mintSpokenForce(late.state, f, o))
    .find((l) => l.includes("1. 北部战线"));
  const lateG = lateRow?.match(/handle=(G\d+)/)?.[1] ?? null;
  check(
    "TB7 前置 该行确实是「披露赶不到」形态（best_help=none + 点名 + 赶不到）",
    !!lateRow && lateRow.includes("best_help=none(") && lateRow.includes(late.squadLabel) &&
      lateRow.includes("赶不到"),
    lateRow ?? "(无)",
  );
  checkKnife(
    "TB8 ★ 被说成「赶不到」的部队照样铸号（番号是地址，不是背书）",
    lateG !== null,
    lateG === null,
    `handle=${lateG ?? "(无)"} row=${lateRow ?? ""}`,
  );
  if (lateG) {
    const look = lookupEscalationTicket(lateG, late.state.time);
    const expected = late.state.squads.find((s) => s.id === "T9")?.unitIds ?? [];
    checkKnife(
      "TB9 ★端到端★ 号解析回的正是行里点名的那批人（承诺==执行，不是就近抓一支）",
      look.ok && look.ticket.label === late.squadLabel &&
        look.ticket.unitIds.length === expected.length &&
        look.ticket.unitIds.every((id) => expected.includes(id)),
      false,
      look.ok ? `${look.ticket.label} ${look.ticket.unitIds.length}units` : `lookup=${look.reason}`,
    );
    const res = resolveTicketReference(late.state, lateG, late.state.time);
    check(
      "TB10 翻译层按冻结名单派兵（6 辆坦克全在，绝不退化成目的地就近）",
      res.kind === "dispatch" && res.unitIds.length === expected.length,
      res.kind === "dispatch" ? `${res.unitIds.length}units` : res.kind,
    );
    if (look.ok) {
      const receipt = ticketDispatchReceipt(look.ticket, expected.length);
      check(
        "TB11 回执带到达估算（派赶不到的兵，代价要说出口）",
        /约 \d+ 秒到位/.test(receipt),
        receipt,
      );
    }
  }

  // ── 推荐面同样有号（两种行都要能被指着说话）──
  resetEscalationTickets();
  const near = lateCandidateFixture(false);
  const nearRow = buildFrontJudgmentLines(near.state, (f, o) => mintSpokenForce(near.state, f, o))
    .find((l) => l.includes("1. 北部战线"));
  check(
    "TB12 前置 近处编队过闸，该行是推荐形态（best_help=<番号>）",
    !!nearRow && nearRow.includes(`best_help=${near.squadLabel}(`),
    nearRow ?? "(无)",
  );
  checkKnife(
    "TB13 ★ 推荐出来的部队也带 handle（fromSquad 有合法把手可写）",
    !!nearRow && /handle=G\d+/.test(nearRow),
    !!nearRow && !/handle=G\d+/.test(nearRow),
    nearRow ?? "(无)",
  );
  check(
    "TB14 表头在铸号时才挂番号说明（没铸号的信封不多话）",
    buildFrontJudgmentLines(near.state, (f, o) => mintSpokenForce(near.state, f, o))[0]
      .includes("handle=G#") &&
      !buildFrontJudgmentLines(near.state)[0].includes("handle=G#"),
  );

  // ── ★ 手测 02:50 的真凶：名单被当过滤器，交集为空 ──
  // 家法：会动兵的断言必须数 assignedUnitIds，不许读 log 字面。
  //
  // ★★ fixture 铁律（§7 的头号教训，2026-08-04 起执行）：本组票据一律走【生产
  // 铸号路径】。上一版这里用的是手捏的对象字面量，它自带 anchor + targetFrontId，
  // 而真实板子票据两样都没有——于是台架对它自己要防的那个 bug 发了假绿灯。
  // 手捏的 fixture 只能证明手捏的世界。
  resetEscalationTickets();
  const disp = lateCandidateFixture();
  const roster = disp.state.squads.find((s) => s.id === "T9")!.unitIds;
  const boardG = mintSpokenForce(disp.state, null, {
    label: disp.squadLabel, memberIds: roster, etaSec: null,
  });
  const boardLook = boardG ? lookupEscalationTicket(boardG, disp.state.time) : null;
  check(
    "TB15a 前置 板子票据由生产铸号器产出，且形状就是真实的那种（anchor=null / 无所属战线）",
    !!boardLook && boardLook.ok && boardLook.ticket.anchor === null &&
      boardLook.ticket.targetFrontId === "" && boardLook.ticket.unitCount === roster.length,
    boardLook && boardLook.ok
      ? `${boardLook.ticket.gNumber} anchor=${boardLook.ticket.anchor === null ? "null" : "有"} front="${boardLook.ticket.targetFrontId}" ${boardLook.ticket.unitCount}units`
      : "铸号失败",
  );
  if (!boardLook || !boardLook.ok) return;
  const boardTicket = boardLook.ticket;

  const countFrom = (intent: Intent): { n: number; fromRoster: number; log: string; landings: Position[] } => {
    const r = resolveIntent(intent, disp.state, disp.state.style, undefined, roster);
    return {
      n: r.assignedUnitIds.length,
      fromRoster: r.assignedUnitIds.filter((i) => roster.includes(i)).length,
      log: r.log,
      landings: r.orders.map((o) => o.target).filter((t): t is Position => !!t),
    };
  };
  const raw = countFrom({ type: "defend", toFront: disp.front.id } as Intent);
  check(
    "TB15 前置 病灶复现：名单 + toFront 时源池取的是目的地已有部队，交集为空",
    raw.n === 0 && raw.log.includes("框选的单位不在可调度范围内"),
    `assigned=${raw.n} log=${raw.log}`,
  );
  const fixed = countFrom(retargetIntentForTicket(disp.state, { type: "defend", toFront: disp.front.id } as Intent, boardTicket));
  checkKnife(
    "TB16 ★端到端·数兵★ 降级 front 提示后，冻结名单原样出发（承诺 6 == 实派 6）",
    fixed.n === roster.length && fixed.fromRoster === roster.length,
    fixed.n === 0,
    `assigned=${fixed.n}/${roster.length} 名单内=${fixed.fromRoster} log=${fixed.log}`,
  );

  // ★ §7① 那条 bug 的真形态：板子号（自带 anchor 的路已删）+「去中央战线」。
  // 判据量【落点坐标】，不是"调用了谁"——刀A 修的是路，这里验的是走完路到哪。
  const anchorPt = battleAnchorFor(disp.state, disp.front)!;
  const centerPt = frontCenterPos(disp.state, disp.front)!;
  check(
    // 门槛按本局实测定（44 格），不是拍脑袋的 50——判据要能量到真实分歧，
    // 又不能松到"两点几乎重合也算过"。
    "TB17a 前置 该局战斗锚点与几何中心相距 > 30 格（否则本条不可测）",
    dist(anchorPt, centerPt) > 30,
    `anchor=(${anchorPt.x},${anchorPt.y}) center=(${centerPt.x},${centerPt.y}) d=${dist(anchorPt, centerPt).toFixed(1)}`,
  );
  checkKnife(
    "TB17 ★端到端·核坐标★ 板子号 +「去本战线」→ 兵落在打仗那处，不是几何中心",
    fixed.n === roster.length && fixed.landings.length === roster.length &&
      fixed.landings.every((t) => dist(t, anchorPt) <= 5) &&
      fixed.landings.every((t) => dist(t, centerPt) > 30),
    fixed.landings.length > 0 && fixed.landings.every((t) => dist(t, centerPt) <= 5),
    `landings=${JSON.stringify(fixed.landings)} anchor=(${anchorPt.x},${anchorPt.y}) center=(${centerPt.x},${centerPt.y})`,
  );
  const otherFrontId = disp.state.fronts.find((f) => f.id !== disp.front.id)!.id;
  const otherFront = retargetIntentForTicket(disp.state, { type: "defend", toFront: otherFrontId } as Intent, boardTicket);
  check(
    "TB17b ★边界★ 目的地是【别的】战线时不得被劫持（长官说去哪就去哪）",
    otherFront.targetRegion === otherFrontId && !otherFront._targetPos && otherFront.toFront === undefined,
    `targetRegion=${otherFront.targetRegion ?? "无"} _targetPos=${otherFront._targetPos ? "有" : "无"}`,
  );
  check(
    "TB17c 精确目的地（设施/标记点）优先——长官点了名的点不许被改",
    (() => { const o = retargetIntentForTicket(disp.state, { type: "defend", targetFacility: "ea_alamein_town", toFront: disp.front.id } as Intent, boardTicket);
      return o.targetFacility === "ea_alamein_town" && !o._targetPos && o.toFront === undefined; })(),
  );

  // ── ★ 目的地裁决三分支（§8 条件二）──
  //
  // 票据是"指谁"的把手，从来不是"去哪"的把手。没写目的地时，引擎只有三条路是
  // 诚实的：动词本身就地自足 → 就地办；撤退 → 走老合同；升级票据知道自己那条线
  // → 用那条线。板子票据什么都不知道 —— 那就问，不猜。
  const escFix = lateCandidateFixture(false); // 近处编队，过得了诚实闸 ⇒ 会铸升级号
  const escBuilt = buildFrontEscalationWithTickets(escFix.state, makeCrisis(escFix.front));
  const escTicket = escBuilt.tickets[0] ?? null;
  check(
    "TB18a 前置 升级票据也由生产入口产出，且带着自己那条战线",
    !!escTicket && escTicket.targetFrontId === escFix.front.id,
    escTicket ? `${escTicket.gNumber} front=${escTicket.targetFrontId}` : "(无票据)",
  );

  // 分支 3a：就地自足动词 —— 执行，不反问，且回执说的是「就地设防」
  // 「原地」的判据是【一个单位都没拿到目的地】（就地设防那条 order 的 target 是
  // null），不是"落点离出发点近"——后者在原地和短距离移动之间分不清。
  {
    const v = ticketDestinationVerdict({ type: "defend" } as Intent, boardTicket, false);
    const inPlace = countFrom(retargetIntentForTicket(disp.state, { type: "defend" } as Intent, boardTicket));
    const receipt = ticketDispatchReceipt(boardTicket, inPlace.n, v.kind === "execute" ? v.receipt : "moved");
    checkKnife(
      "TB18 ★ 「让 G# 就地设防」→ 原地执行、不反问，回执不再谎称出发",
      v.kind === "execute" && v.receipt === "in_place" &&
        inPlace.n === roster.length && inPlace.landings.length === 0 &&
        receipt.includes("就地设防") && !receipt.includes("出发"),
      v.kind === "execute" && v.receipt === "moved",
      `verdict=${v.kind}/${v.kind === "execute" ? v.receipt : v.reason} assigned=${inPlace.n} 有目的地的单位=${inPlace.landings.length} 回执=「${receipt}」`,
    );
  }

  // 分支 3b：板子号 + 移动动词 + 没目的地 —— 零执行 + 反问「去哪」
  checkKnife(
    "TB18b ★ 板子号 + 移动动词 + 无目的地 → 零执行 + 反问（不许替长官挑地方）",
    (() => { const v = ticketDestinationVerdict({ type: "attack" } as Intent, boardTicket, false);
      return v.kind === "refuse" && v.reason === "no_destination" &&
        v.line.includes(boardTicket.gNumber) && v.line.includes("去哪"); })(),
    (() => { const v = ticketDestinationVerdict({ type: "attack" } as Intent, boardTicket, false);
      return v.kind === "execute"; })(),
    JSON.stringify(ticketDestinationVerdict({ type: "attack" } as Intent, boardTicket, false)),
  );

  // 分支 3c：升级号 + 移动动词 + 没目的地 —— 注入本票据那条战线，走 §8 梯子
  if (escTicket) {
    const v = ticketDestinationVerdict({ type: "attack" } as Intent, escTicket, false);
    check(
      "TB18c 升级号没写目的地 → 注入它自己那条战线（不是问，也不是猜）",
      v.kind === "execute" && v.injectTargetRegion === escFix.front.id,
      JSON.stringify(v),
    );
  }

  // 分支 3d：裸 retreat —— 老合同（朝大本营），绝不改写成"撤向战斗锚点"
  checkKnife(
    "TB18d ★ 裸 retreat 保持 retreat-semantics-v1 老合同（不再被改写成撤进战场）",
    (() => { const o = retargetIntentForTicket(disp.state, { type: "retreat" } as Intent, boardTicket);
      const v = ticketDestinationVerdict(o, boardTicket, false);
      return !o._targetPos && !o.targetRegion && !o.toFront &&
        v.kind === "execute" && !v.injectTargetRegion; })(),
    (() => { const o = retargetIntentForTicket(disp.state, { type: "retreat" } as Intent, boardTicket);
      return !!o._targetPos; })(),
    JSON.stringify(retargetIntentForTicket(disp.state, { type: "retreat" } as Intent, boardTicket)),
  );

  // 分支 2：假地名 —— 原字段名必须活到警告里（静默改写正是 §7③）
  {
    const bogus = retargetIntentForTicket(
      disp.state, { type: "defend", toFront: "__不存在战线__" } as Intent, boardTicket,
    );
    checkKnife(
      "TB18e ★ 查无此地的战线名原样留在 toFront（警告要报长官写的那个字段，不许改写成 targetRegion）",
      bogus.toFront === "__不存在战线__" && bogus.targetRegion === undefined && !bogus._targetPos,
      bogus.toFront === undefined && (bogus.targetRegion === "__不存在战线__" || !!bogus._targetPos),
      `toFront=${bogus.toFront ?? "无"} targetRegion=${bogus.targetRegion ?? "无"} _targetPos=${bogus._targetPos ? "有" : "无"}`,
    );
    // softFix 清场之后（前端会清掉那个字段并报警），裁决必须是"问"，不是"办"。
    const afterSoftFix = { ...bogus, toFront: undefined } as Intent;
    checkKnife(
      "TB18f ★ 假地名被清掉后 → 零执行 + 反问，绝不退化成「没写目的地」顺手执行",
      (() => { const v = ticketDestinationVerdict(afterSoftFix, boardTicket, true);
        return v.kind === "refuse" && v.reason === "unknown_place"; })(),
      (() => { const v = ticketDestinationVerdict(afterSoftFix, boardTicket, true);
        return v.kind === "execute"; })(),
      JSON.stringify(ticketDestinationVerdict(afterSoftFix, boardTicket, true)),
    );
  }

  // ── 板子群行也要有号（手测 02:07 陈是从板子上念的那两股） ──
  resetEscalationTickets();
  const boardState = lateCandidateFixture().state;
  const boardLines = boardToDigestLines(
    buildBattleBoard(boardState),
    (row) => mintSpokenForce(boardState, null, { label: row.label, memberIds: row.memberIds, etaSec: null }),
  ).unassignedGroupLines;
  const boardRowG = boardLines.join("\n").match(/handle=(G\d+)/)?.[1] ?? null;
  checkKnife(
    "TB19 ★ 板子群行也铸号（「附近有空闲部队吗」念出来的那几股必须可寻址）",
    boardLines.length > 0 && boardRowG !== null,
    boardLines.length > 0 && boardRowG === null,
    boardLines.join(" | ") || "(无群行)",
  );
  check(
    "TB20 板子号解析回该群的冻结名单（不是标签，标签每帧会变）",
    (() => { if (!boardRowG) return false;
      const look = lookupEscalationTicket(boardRowG, boardState.time);
      return look.ok && look.ticket.unitIds.length > 0; })(),
    boardRowG ?? "(无号)",
  );
  check(
    "TB21 纯度 板子不给铸号器时字节不变、零 handle",
    !boardToDigestLines(buildBattleBoard(boardState)).unassignedGroupLines.join("").includes("handle="),
  );
}

// ============================================================
// 刀3 — 互射钟。口径原则：对内触发用悲观钟，对人说话用互射钟。
// 覆盖矩阵照 §6c-5：六说话面各一断言 + 两内部面不变负对照 + 行为正负对照
// + filterLateCandidates 同喂两处。
// ============================================================

/** front_coastal fixture with dialled HP/DPS so both clocks are hand-checkable.
 *  infantry = 60maxHP, 6dmg/1.5s = 4 DPS. */
function exchangeFixture(opts: {
  defenders: number[];     // player HP each (DPS 4 apiece)
  enemies: number[];       // enemy HP each (DPS 4 apiece)
}): { state: GameState; front: Front } {
  const state = emptyBattlefield();
  state.time = 300;
  const front = frontById(state, "front_coastal");
  const [x, y] = [250, 38]; // inside northern_coastal[200,22,490,55]
  opts.defenders.forEach((hp, i) =>
    addUnit(state, x + i, y, { hp, lastAttackTime: state.time - 1, lastDamagedAt: state.time - 1 }));
  opts.enemies.forEach((hp, i) =>
    addUnit(state, x + 8 + i, y, { hp, team: "enemy", lastAttackTime: state.time - 1 }));
  for (const row of state.fog) for (let i = 0; i < row.length; i++) row[i] = "visible";
  // director's collapse scan skips quiet fronts (TUNING.ENGAGED_MIN = 0.25);
  // this fixture exists to exercise the scan, so mark it hot.
  front.engagementIntensity = 5;
  return { state, front };
}

function runKnife3(): void {
  console.log("\n== 刀3 互射钟：对内悲观、对人互射 ==");

  // 输面：我方 1×360HP/DPS4；敌方 3×60HP/DPS12
  //   tWeDie = 360/12 = 30s   tEnemyDies = 180/4 = 45s → holds=false, spoken=30
  const lose = exchangeFixture({ defenders: [360], enemies: [60, 60, 60] });
  const aLose = assessCrisisEscalation(lose.state, makeCrisis(lose.front));
  check("T4a 前置 输面构造：悲观钟 30s", !!aLose && Math.round(aLose.tCollapse) === 30,
    aLose ? `${aLose.tCollapse.toFixed(1)}` : "null");
  check("T4b 前置 输面互射钟：tEnemyDies 45s > tWeDie 30s ⇒ 守不住",
    !!aLose && Math.round(aLose.exchange.tEnemyDies) === 45 && aLose.exchange.holds === false,
    aLose ? `tEnemyDies=${aLose.exchange.tEnemyDies.toFixed(1)} holds=${aLose.exchange.holds}` : "null");
  check("T4c 输面说话数 == 30（输时互射钟与悲观钟同值，见 §6c-2 披露）",
    !!aLose && aLose.exchange.spokenSeconds !== null && Math.round(aLose.exchange.spokenSeconds) === 30,
    aLose ? `${aLose.exchange.spokenSeconds}` : "null");

  // 赢面：我方 3×40HP/DPS12；敌方 1×60HP/DPS4
  //   tWeDie = 120/4 = 30s    tEnemyDies = 60/12 = 5s → holds=true, spoken=null
  const win = exchangeFixture({ defenders: [40, 40, 40], enemies: [60] });
  const aWin = assessCrisisEscalation(win.state, makeCrisis(win.front));
  check("T4d 前置 赢面构造：悲观钟同样是 30s（两局悲观钟不可区分）",
    !!aWin && Math.round(aWin.tCollapse) === 30, aWin ? `${aWin.tCollapse.toFixed(1)}` : "null");
  checkKnife(
    "T4e ★ 赢面：互射钟判守得住，说话数为 null（旧公式结构上说不出这句）",
    !!aWin && aWin.exchange.holds === true && aWin.exchange.spokenSeconds === null,
    !!aWin && Math.round(aWin.tCollapse) === 30,
    aWin ? `holds=${aWin.exchange.holds} spoken=${aWin.exchange.spokenSeconds}` : "null",
  );

  // ── 两内部面必须仍读悲观钟（负对照：改错面要被抓）──
  check(
    "T4f ★内部面★ 报警闸读悲观钟：赢面悲观钟 30s < DANGER 阈值，仍进扫描",
    !!aWin && aWin.tCollapse <= 30 && aWin.tCollapse !== Infinity,
    aWin ? `${aWin.tCollapse}` : "null",
  );
  check(
    "T4g ★内部面★ tCollapse 字节未变：两局同值 30s，只有说话面分叉",
    !!aWin && !!aLose && Math.round(aWin.tCollapse) === Math.round(aLose.tCollapse),
    `win=${aWin?.tCollapse.toFixed(1)} lose=${aLose?.tCollapse.toFixed(1)}`,
  );

  // ── 说话面 1-2: director beat（tSec）与事实包（estimatedCollapseSeconds）──
  const beatsWin = collectDirectorBeats(win.state, null).filter((b) => b.frontId === "front_coastal");
  const beatsLose = collectDirectorBeats(lose.state, null).filter((b) => b.frontId === "front_coastal");
  checkKnife(
    "T4h ★行为★ 赢面零升级提案（诚实闸：守得住就不开口）",
    beatsWin.length === 0,
    beatsWin.length > 0,
    `beats=${beatsWin.length}`,
  );
  check(
    "T4i ★行为正对照★ 输面照常升级，且 beat 念的是新数 30s",
    beatsLose.length > 0 && beatsLose.every((b) => b.estimatedCollapseSeconds === 30),
    `beats=${beatsLose.length} secs=${beatsLose.map((b) => b.estimatedCollapseSeconds).join(",")}`,
  );
  const factsLose = frontEscalationFacts(lose.state, makeCrisis(lose.front));
  const factsWin = frontEscalationFacts(win.state, makeCrisis(win.front));
  check("T4j 说话面 事实包 输面 = 30", factsLose?.estimatedCollapseSeconds === 30,
    `${factsLose?.estimatedCollapseSeconds}`);
  checkKnife(
    "T4k ★ 说话面 事实包 赢面 = null（不是缺数，是诚实答案）",
    factsWin?.estimatedCollapseSeconds === null,
    factsWin?.estimatedCollapseSeconds === 30,
    `${factsWin?.estimatedCollapseSeconds}`,
  );

  // ── 说话面 3-4: presence wrapper（survival≈ 与 mood 行）──
  const rowsLose = buildFrontJudgmentLines(lose.state).find((l) => l.includes("1. 北部战线"));
  const rowsWin = buildFrontJudgmentLines(win.state).find((l) => l.includes("1. 北部战线"));
  check("T4l 说话面 态势板 输面带 survival≈30s", !!rowsLose && /survival≈30s/.test(rowsLose), rowsLose ?? "");
  checkKnife(
    "T4m ★ 说话面 态势板 赢面 survival=stable（不再谎报倒计时）",
    !!rowsWin && rowsWin.includes("survival=stable"),
    !!rowsWin && /survival≈30s/.test(rowsWin),
    rowsWin ?? "",
  );
  const moodWin = commanderMood(win.state);
  check("T4n 说话面 mood 赢面不出秒数", !/秒内/.test(moodWin.reason), `${moodWin.level}（${moodWin.reason}）`);

  // ── 说话面 5-6: decisionReview wrapper（复盘基线/跨线行）──
  // §6c-4: "压着打"现在 = null，翻盘才非 null —— 旧谓词把这类战线永远滤掉。
  const revSnap = (st: GameState, fr: Front): number | null => {
    const ids = Array.from(st.units.values()).filter((u) => u.team === "player").map((u) => u.id);
    // escalateId lowers MIN_UNITS from 3 to 1 — the losing fixture is 1v3 on
    // purpose, and the wrapper under test is per-front, not per-squad-size.
    const rec = captureDecisionReview(st, {
      kind: "defend", assignedUnitIds: ids, frontId: fr.id, escalateId: "bench",
    } as never);
    return rec?.baseline.fronts.find((f) => f.frontId === fr.id)?.collapseSeconds ?? null;
  };
  const revWin = revSnap(win.state, win.front);
  const revLose = revSnap(lose.state, lose.front);
  checkKnife(
    "T4o ★ 说话面 复盘基线 赢面 = null（§6c-4 盲区修复：压着打不再有钟）",
    revWin === null, revWin === 30, `${revWin}`,
  );
  check("T4p 说话面 复盘基线 输面 = 30", revLose === 30, `${revLose}`);

  // ── 诚实闸第二半：晚到候选从 payload 与铸号同时消失 ──
  resetEscalationTickets();
  // Relief group 300 tiles away → eta far beyond the 30s exchange clock.
  const far = exchangeFixture({ defenders: [360], enemies: [60, 60, 60] });
  for (let i = 0; i < 6; i++) addUnit(far.state, 60 + i, 260, {}); // deep south-west
  const unfiltered = buildReinforceOptions(far.state, far.front);
  const built = buildFrontEscalationWithTickets(far.state, makeCrisis(far.front));
  const farOpt = unfiltered.options.find((o) => o.etaSec !== null && o.etaSec > 30);
  check("T4q 前置 存在一个 eta > 互射钟(30s) 的候选", !!farOpt,
    unfiltered.options.map((o) => `${o.label}:${o.etaSec}s`).join(" | "));
  if (farOpt) {
    checkKnife(
      "T4r ★ 晚到候选不进 payload（提一个来不及的案＝噪声冒充选择）",
      !built.payload.includes(farOpt.label),
      built.payload.includes(farOpt.label),
      built.payload.split("\n").filter((l) => l.includes("units")).join(" / "),
    );
    checkKnife(
      "T4s ★ 同一次过滤也挡住铸号（陈不能提的案，绝不存在号）",
      !built.tickets.some((t) => t.label === farOpt.label),
      built.tickets.some((t) => t.label === farOpt.label),
      built.tickets.map((t) => `${t.gNumber}=${t.label}`).join(" | "),
    );
  }
  check(
    "T4t 未知 eta 永不被过滤（缺数不得当作判决）",
    filterLateCandidates({ ...unfiltered, options: [{ ...unfiltered.options[0], etaSec: null }],
      shown: [{ ...unfiltered.options[0], etaSec: null }], omitted: 0 }, 1).options.length === 1,
  );
  check(
    "T4u 互射钟为 null（稳/赢）时零过滤（无依据不删候选）",
    filterLateCandidates(unfiltered, null).options.length === unfiltered.options.length,
  );
}

// ============================================================
// 刀2c — the gate layer (v4 §6c-3c P0). The live smoke test found a correct
// fromSquad="G1" killed by detectStaleSquadRefs BEFORE the translation layer
// ever ran: two gates each carried a private definition of "legal reference"
// and neither knew about tickets. These assertions are the blind spot turned
// into territory — the predicate now lives in core, so the bench can reach it.
//
// Gate contract under test: ticket-shaped refs pass on SHAPE ALONE. Validity
// (unknown/expired/burned) is resolveTicketReference's alone.
// ============================================================

const BENCH_COMMANDERS = [
  { key: "chen", label: "陈军士" },
  { key: "marcus", label: "马克斯上尉" },
  { key: "emily", label: "艾米莉中尉" },
];

function runKnife2c(): void {
  console.log("\n== 刀2c 闸层：番号是合法引用（形状归闸，生死归翻译）==");
  resetEscalationTickets();

  const { state, front } = scenarioStraddle();
  const built = buildFrontEscalationWithTickets(state, makeCrisis(front));
  const g = built.tickets.find((t) => t.label.includes("未编组"))?.gNumber;
  check("T5a 前置 铸出番号", !!g, built.tickets.map((t) => t.gNumber).join(","));
  if (!g) return;

  // ── ① 活跃番号：闸放行 + 翻译派出快照 ──
  checkKnife(
    "T5b ★端到端★ 活跃番号过闸（这正是活体冒烟被拦下的那一步）",
    isKnownForceRef(state, g, BENCH_COMMANDERS),
    false,
    `isKnownForceRef(${g})=${isKnownForceRef(state, g, BENCH_COMMANDERS)}`,
  );
  const okRes = resolveTicketReference(state, g, state.time);
  check(
    "T5c 过闸后翻译派出快照（assignedUnitIds ⊆ 冻结名单）",
    okRes.kind === "dispatch" && okRes.unitIds.every((id) => okRes.ticket.unitIds.includes(id)),
    okRes.kind === "dispatch" ? `${okRes.unitIds.length}/${okRes.ticket.unitIds.length}` : okRes.kind,
  );

  // ── ② 已烧号：闸仍放行，翻译响亮拒绝，零派兵 ──
  burnEscalationTicket(g);
  checkKnife(
    "T5d ★ 烧过的号闸层照样放行（闸不查生死，否则就是第二真相源）",
    isKnownForceRef(state, g, BENCH_COMMANDERS),
    false,
    `${g} burned`,
  );
  const burnedRes = resolveTicketReference(state, g, state.time);
  check(
    "T5e 烧号的裁决权独占于翻译层：refuse+人话+零派兵",
    burnedRes.kind === "refuse" && burnedRes.reason === "burned" && burnedRes.line.length > 0,
    burnedRes.kind === "refuse" ? `${burnedRes.reason}: ${burnedRes.line}` : burnedRes.kind,
  );

  // ── ③ 幻觉号 G99：从未铸过，闸放行 → 翻译拒绝 ──
  checkKnife(
    "T5f ★ 幻觉号 G99 闸层放行（形状合法即可）",
    isKnownForceRef(state, "G99", BENCH_COMMANDERS),
    false,
  );
  const ghost = resolveTicketReference(state, "G99", state.time);
  check(
    "T5g 幻觉号被翻译层响亮拒绝，安全性质不变（零执行）",
    ghost.kind === "refuse" && ghost.reason === "unknown",
    ghost.kind === "refuse" ? ghost.reason : ghost.kind,
  );

  // ── 谓词其余三类不得回归 ──
  check("T5h 谓词仍认 commander key", isKnownForceRef(state, "chen", BENCH_COMMANDERS));
  check("T5i 谓词仍认 commander 显示名（label 包含引用）", isKnownForceRef(state, "陈军士", BENCH_COMMANDERS));
  check("T5j 谓词拒绝真正的胡话", !isKnownForceRef(state, "第七装甲军", BENCH_COMMANDERS));
  check("T5k 谓词拒绝空引用", !isKnownForceRef(state, "  ", BENCH_COMMANDERS));
}

// ============================================================
// A 刀 — 候选诚实闸「同一把尺」（对话层全量审计 2026-08-02）
//
// 病史：诚实闸只装在升级合成入口一处，于是同一个信封里，升级块说
// "reinforcement_options: none"，态势板行还在推销 best_help=某群(eta≈153s)。
// 更深一层：候选不是一台机器而是三台，各有各的成员判据——
//   机器 A buildReinforceOptions   (isDispatchable + 空间群 + 按 front 内外分)
//   机器 B findBestReinforcements  (idle/patrolling/holding + 仅编队 + missionPri<2)
//   机器 C facilityEscalationFacts (全图任一 idle 带枪单位 → 一个布尔)
// 只 grep 机器 A 的调用点会数出"两处要修"——那正是本次事故的盲区形状。
//
// 所以断言写在【出口枚举表】上，不逐面散写（逐面写下次还漏第三个面）：
//   ① 源码扫描不变量：任何未登记的新出口 → 直接 FAIL；
//   ② 每个已登记出口按其【声明的政策】断言行为。
// ============================================================

/** 一个说话面被允许的政策。写死在表里，改行为必须先改政策声明。 */
type FacePolicy =
  | "gate"             // 必须过晚到闸
  | "gate-null-clock"  // 走闸，但钟按构造恒为 null（雾：无可见敌 ⇒ 无可辩护的秒数）
  | "gated-upstream"   // 生产恒接收已过滤集合
  | "no-eta"           // 结构上给不出到达承诺（front=null ⇒ 无锚点 ⇒ 无 eta）
  | "known-gap";       // 已入档的缺口（P1 改话术），断言现状以防悄悄漂移

/** 候选出口的三个源码标记：两台 builder 的调用 + 那个被两台机器共用的字段名。 */
type FaceToken =
  | "buildReinforceOptions"
  | "findBestReinforcements"
  | "idle_reinforcement_available"          // 机器 C（设施布尔）仍用原名
  | "reinforcement_able_to_arrive_in_time"; // fix1: 机器 B 的播报字段改名，none 才不说谎

interface CandidateFace {
  file: string;
  token: FaceToken;
  /** 该文件内该标记的第 N 次出现（1 起）。**故意不用行号当键**——行号会因为
   *  上方任何一次加注释而漂，那是噪声不是信号；序数只在真的增删调用点时才变。 */
  nth: number;
  machine: "A" | "B" | "C";
  policy: FacePolicy;
  note: string;
}

/** ★ 全部能把"候选"变成长官读得到的东西的活调用点。 */
const CANDIDATE_FACES: CandidateFace[] = [
  { file: "packages/core/src/escalationTicket.ts", token: "buildReinforceOptions", nth: 1,
    machine: "A", policy: "gated-upstream", note: "mint：生产恒传 precomputed（已被下一处滤过）" },
  { file: "packages/core/src/escalationTicket.ts", token: "buildReinforceOptions", nth: 2,
    machine: "A", policy: "gate", note: "升级 payload + 铸号（一次过滤同喂两处）" },
  { file: "packages/core/src/frontEscalationPayload.ts", token: "buildReinforceOptions", nth: 1,
    machine: "A", policy: "gate", note: "payload builder 自带 filterLateCandidates" },
  { file: "packages/core/src/commanderPresence.ts", token: "buildReinforceOptions", nth: 1,
    machine: "A", policy: "gate-null-clock", note: "态势板『交战中·敌情未明』行 best_help" },
  { file: "packages/core/src/commanderPresence.ts", token: "buildReinforceOptions", nth: 2,
    machine: "A", policy: "gate", note: "态势板有钟行 best_help（症状 1a 病灶）" },
  { file: "packages/core/src/battleBoard.ts", token: "buildReinforceOptions", nth: 1,
    machine: "A", policy: "no-eta", note: "板子群行 front=null → 无锚点 → 无 eta，推销不了晚到" },
  { file: "packages/core/src/crisisResponse.ts", token: "findBestReinforcements", nth: 1,
    machine: "B", policy: "gate", note: "assessCrisisEscalation：bestCandidate / kind / freeReinforcement 三消费者同源" },
  { file: "packages/core/src/director.ts", token: "idle_reinforcement_available", nth: 1,
    machine: "C", policy: "known-gap", note: "设施升级布尔：全图任一 idle 即 true（P1 改话术，已入档）" },
  { file: "apps/web/src/GameCanvas.tsx", token: "reinforcement_able_to_arrive_in_time", nth: 1,
    machine: "B", policy: "gated-upstream", note: "proactive 播报行：渲染机器 B 的 freeReinforcement（源头已过滤；fix1 字段改名，none 才不说谎）" },
];

interface ScannedSite { file: string; token: FaceToken; nth: number; line: number }

/** 扫描源码，列出所有"候选出口"的活调用点（跳过注释 / 定义 / import）。 */
function scanCandidateSites(): ScannedSite[] {
  const TOKENS: { token: FaceToken; re: RegExp }[] = [
    { token: "buildReinforceOptions", re: /\bbuildReinforceOptions\(/ },
    { token: "findBestReinforcements", re: /\bfindBestReinforcements\(/ },
    { token: "idle_reinforcement_available", re: /idle_reinforcement_available/ },
    { token: "reinforcement_able_to_arrive_in_time", re: /reinforcement_able_to_arrive_in_time/ },
  ];
  const roots = ["packages/core/src", "apps/web/src"];
  const out: ScannedSite[] = [];
  const seen = new Map<string, number>(); // file|token → 已见次数
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const p = `${dir}/${entry.name}`;
      if (entry.isDirectory()) { walk(p); continue; }
      if (!/\.(ts|tsx)$/.test(entry.name)) continue;
      readFileSync(p, "utf8").split("\n").forEach((raw, i) => {
        const line = raw.trim();
        if (line.startsWith("//") || line.startsWith("*") || line.startsWith("/*")) return; // 注释不算出口
        if (/^export function /.test(line)) return;                                        // 定义本身不算
        for (const { token, re } of TOKENS) {
          if (!re.test(line)) continue;
          const key = `${p}|${token}`;
          const nth = (seen.get(key) ?? 0) + 1;
          seen.set(key, nth);
          out.push({ file: p, token, nth, line: i + 1 });
        }
      });
    }
  };
  for (const r of roots) walk(r);
  return out;
}

const faceKey = (f: { file: string; token: FaceToken; nth: number }): string =>
  `${f.file}|${f.token}#${f.nth}`;

/** front_coastal 输面（互射钟 30s）+ 一支编队。far=true 时远在西南、绝对来不及。 */
function lateCandidateFixture(far = true): { state: GameState; front: Front; squadLabel: string } {
  const { state, front } = exchangeFixture({ defenders: [360], enemies: [60, 60, 60] });
  const ids: number[] = [];
  const [ox, oy] = far ? [60, 260] : [252, 60]; // 远：eta ≫ 30s；近：赶得上
  for (let i = 0; i < 6; i++) ids.push(addUnit(state, ox + i, oy).id);
  state.squads.push({
    id: "T9", name: "远征分队", unitIds: ids,
    leader: { name: "Farrell", rank: "squad_leader", personality: "balanced" },
    currentMission: null, missionTarget: null, morale: 1,
    formationStyle: "line", ownerCommander: "chen", leaderName: "Farrell", role: "leader",
  });
  return { state, front, squadLabel: "Farrell(T9)" };
}

/**
 * §7⑥ 的原局：front_center 东端一场必输的仗（互射钟 30s），一支编队在线外
 * 东南角——到战斗点 25s（赶得上），到几何中心 89s（赶不上）。两台候选机器
 * 量不同的点就会给出相反的裁决。
 */
function twoRulerFixture(): { state: GameState; front: Front; squadIds: number[]; squadLabel: string } {
  const state = emptyBattlefield();
  const front = frontById(state, "front_center");
  state.time = 1000;
  // 输面：我方 1×360HP/DPS4 vs 敌方 3×60HP/DPS4 ⇒ tWeDie = 360/12 = 30s
  addUnit(state, BATTLE.x, BATTLE.y, { hp: 360, lastAttackTime: state.time - 1, lastDamagedAt: state.time - 1 });
  for (let i = 0; i < 3; i++) {
    addUnit(state, BATTLE.x + 6 + i, BATTLE.y, { hp: 60, team: "enemy", lastAttackTime: state.time - 1 });
  }
  for (const row of state.fog) for (let i = 0; i < row.length; i++) row[i] = "visible";
  front.engagementIntensity = 5;
  // 线外编队（必须是编队：机器 B 把散兵归到 __reserve__，那一档本就不参与裁决）
  const squadIds: number[] = [];
  for (let i = 0; i < 6; i++) squadIds.push(addUnit(state, RELIEF.x + i, RELIEF.y).id);
  state.squads.push({
    id: "T7", name: "近援分队", unitIds: squadIds,
    leader: { name: "Nadia", rank: "squad_leader", personality: "balanced" },
    currentMission: null, missionTarget: null, morale: 1,
    formationStyle: "line", ownerCommander: "chen", leaderName: "Nadia", role: "leader",
  });
  return { state, front, squadIds, squadLabel: "Nadia(T7)" };
}

/** 无钟面：我方按自身时间戳在交战，敌军全在雾里 ⇒ ratio=null ⇒ 走无钟分支。 */
function noClockFixture(hiddenEnemies: number): { state: GameState; front: Front } {
  const state = emptyBattlefield();
  state.time = 300;
  const front = frontById(state, "front_coastal");
  const [x, y] = [250, 38];
  for (let i = 0; i < 3; i++) {
    addUnit(state, x + i, y, { lastAttackTime: state.time - 1, lastDamagedAt: state.time - 1 });
  }
  // 雾中敌军：不设 fog=visible，所以 freshFrontPowerRatio 看不见它们，
  // 而 estimateCollapseTime 会把它们算进去（FOG-TODO）——这正是钉子①防的那条泄漏。
  for (let i = 0; i < hiddenEnemies; i++) {
    addUnit(state, x + 8 + i, y, { team: "enemy", lastAttackTime: state.time - 1 });
  }
  for (let i = 0; i < 6; i++) addUnit(state, 60 + i, 260);
  front.engagementIntensity = 5;
  return { state, front };
}

function runKnifeA(): void {
  console.log("\n== A 刀 候选诚实闸：同一把尺覆盖全部说话面 ==");

  // ── ① 枚举表 vs 源码：任何未登记的新出口都必须炸 ──
  let scanned: ScannedSite[] = [];
  let scanOk = true;
  try {
    scanned = scanCandidateSites();
  } catch (e) {
    scanOk = false;
    check("TA0 前置 源码扫描可运行（须在 worktree 根目录跑）", false, String(e));
  }
  if (scanOk) {
    const declared = new Set(CANDIDATE_FACES.map(faceKey));
    const undeclared = scanned.filter((s) => !declared.has(faceKey(s)));
    const scannedKeys = new Set(scanned.map(faceKey));
    const missing = CANDIDATE_FACES.filter((f) => !scannedKeys.has(faceKey(f)));
    check(
      "TA1 ★不变量★ 源码里没有未登记的候选出口（新增一个面必须先进枚举表）",
      undeclared.length === 0,
      undeclared.map((s) => `${s.file}:${s.line}(${s.token}#${s.nth})`).join(" , "),
    );
    check(
      "TA2 ★不变量★ 枚举表里没有已消失的出口（删掉一个面也必须改表）",
      missing.length === 0,
      missing.map(faceKey).join(" , "),
    );
    check(
      "TA3 三台候选机器全部在册（A/B/C 各至少一个面）",
      (["A", "B", "C"] as const).every((m) => CANDIDATE_FACES.some((f) => f.machine === m)),
      CANDIDATE_FACES.map((f) => `${f.machine}:${f.policy}`).join(" "),
    );
  }

  // ── ② 行为：有钟面（机器 A + 机器 B 同局对照）──
  resetEscalationTickets();
  const { state, front, squadLabel } = lateCandidateFixture();
  const a = assessCrisisEscalation(state, makeCrisis(front));
  check(
    "TA4 前置 局造得对：互射钟 30s，且唯一候选是那支来不及的编队",
    !!a && a.exchange.spokenSeconds !== null && Math.round(a.exchange.spokenSeconds) === 30 &&
      buildReinforceOptions(state, front).options.every((o) => o.label === squadLabel),
    a ? `spoken=${a.exchange.spokenSeconds} 候选=${buildReinforceOptions(state, front).options.map((o) => `${o.label}:${o.etaSec}s`).join("|")}` : "null",
  );

  // 面 ①②（机器 A，早已装闸——回归守卫，不是本刀承重）
  const built = buildFrontEscalationWithTickets(state, makeCrisis(front));
  check("TA5 面① 升级 payload 不含晚到候选", !built.payload.includes(squadLabel));
  check("TA6 面② 同一次过滤也挡住铸号", !built.tickets.some((t) => t.label === squadLabel));

  // 面⑤（机器 A，:120）——本刀承重
  const row = buildFrontJudgmentLines(state).find((l) => l.includes("1. 北部战线"));
  check("TA7 前置 态势板产出该战线有钟行", !!row && /survival≈30s/.test(row ?? ""), row ?? "(无)");
  checkKnife(
    "TA8 ★面⑤★ 态势板有钟行不再推销晚到候选（信封自相矛盾就此闭合）",
    !!row && !row.includes(`best_help=${squadLabel}(`),
    !!row && row.includes(`best_help=${squadLabel}(`),
    row ?? "(无)",
  );
  // fix1（手测 2026-08-02）：闸清空 ≠ 沉默。沉默把"有没有可支援部队"答成"只有
  // Blake"，六辆闲着的坦克被藏掉——F1 教训（无候选≠无友军）此前只写在升级面。
  check(
    "TA8b ★fix1★ 空集必须开口：披露存在（股数/人数）+ 最近 eta + 赶不到",
    !!row && row.includes("best_help=none(") && row.includes(squadLabel) &&
      /线外\d+股\/\d+units/.test(row) && /eta≈\d+s/.test(row) && row.includes("赶不到"),
    row ?? "(无)",
  );
  check(
    "TA8c ★fix1·边界★ 披露不得变相推荐（番号只出现在 none(...) 从句里）",
    !!row && !new RegExp(`best_help=${squadLabel.replace(/[()]/g, "\\$&")}\\(`).test(row),
    row ?? "(无)",
  );
  // ── ⑦「闲着」只准数真闲的（v4 §8, 2026-08-04）──
  // fix1 的披露句把线外全部候选都算成"闲着"，其中包括正在交火的。可调度 ≠ 空闲：
  // 把已经在打的兵报成余力，是把长官往二次投入上引。
  {
    resetEscalationTickets();
    const mixed = lateCandidateFixture();
    for (let i = 0; i < 4; i++) {
      addUnit(mixed.state, 100 + i, 200, {
        lastAttackTime: mixed.state.time - 1, lastDamagedAt: mixed.state.time - 1,
      });
    }
    const opts = buildReinforceOptions(mixed.state, mixed.front).options;
    const busy = opts.filter((o) => o.task === "交战中");
    const free = opts.filter((o) => o.task === TASK_IDLE);
    check(
      "TA8d 前置 局造得对：线外一股 6 人闲着 + 一股 4 人交战中（都可调度）",
      busy.length === 1 && busy[0].unitCount === 4 && free.length === 1 && free[0].unitCount === 6,
      opts.map((o) => `${o.label}:${o.task}:${o.unitCount}`).join(" | "),
    );
    const mixedRow = buildFrontJudgmentLines(mixed.state).find((l) => l.includes("1. 北部战线"));
    const m = mixedRow?.match(/线外(\d+)股\/(\d+)units 闲着/);
    checkKnife(
      "TA8e ★⑦★ 披露只数 task=无任务 的（交战中的兵不许被报成余力）",
      !!m && m[1] === "1" && m[2] === "6",
      !!m && m[1] === "2" && m[2] === "10",
      mixedRow ?? "(无该行)",
    );
    // ⑦ 的另一半（Fable 裁定 2026-08-04）：被【点名】的那股也必须是闲着的。
    // 数对了但点名点了交战群，是同一个病换了个位置——而且那股还会被铸号，
    // 长官照着"闲着"那句话说「让他们去」就会把正在交火的兵抽出来。
    const busyLabel = busy[0]?.label ?? "__none__";
    const freeLabel = free[0]?.label ?? "__none__";
    check(
      "TA8f0 前置 交战那股确实更近（否则「限定 idle」这条不可测）",
      (busy[0]?.etaSec ?? Infinity) < (free[0]?.etaSec ?? Infinity),
      `交战中 ${busyLabel}:${busy[0]?.etaSec}s 闲着 ${freeLabel}:${free[0]?.etaSec}s`,
    );
    const named = mixedRow?.match(/最近 (\S+) eta≈/)?.[1] ?? null;
    checkKnife(
      "TA8f ★⑦·点名★ 「最近 X」只在闲着的里面挑（更近的交战群不得被点名/铸号）",
      named === freeLabel && named !== busyLabel,
      named === busyLabel,
      `点名=${named ?? "(无)"} 闲着=${freeLabel} 交战中=${busyLabel}`,
    );
  }

  // 面⑦（机器 B）——本刀承重，三个消费者一次全喂
  checkKnife(
    "TA9 ★面⑦★ 机器 B：晚到候选不再当 bestCandidate（「艾登一人可增援」的同族出口）",
    !!a && a.bestCandidate === null,
    !!a && a.bestCandidate !== null,
    a ? `best=${a.bestCandidate?.leaderName ?? "null"} tArrive=${a.bestCandidate?.tArrive ?? "-"}s` : "null",
  );
  checkKnife(
    "TA10 ★面⑦·连带★ 废候选不再把 dilemma 降级成 safe_reinforce（被吞掉的问句回来了）",
    !!a && a.kind === "dilemma",
    !!a && a.kind === "safe_reinforce",
    a ? a.kind : "null",
  );
  const beats = collectDirectorBeats(state, null).filter((b) => b.frontId === front.id);
  checkKnife(
    "TA11 ★面⑦·端到端★ director beat 升为 cross_front_dilemma 且不再点名废援兵",
    beats.length > 0 && beats.every((b) => b.kind === "cross_front_dilemma" && b.freeReinforcement === null),
    beats.length > 0 && beats.every((b) => b.kind === "front_collapse" && b.freeReinforcement !== null),
    beats.map((b) => `${b.kind}/free=${b.freeReinforcement?.leaderName ?? "null"}`).join(" | ") || "(无 beat)",
  );

  // ── ③ 行为：无钟面（政策 gate-null-clock）+ 雾泄漏守卫 ──
  const clean = noClockFixture(0);
  const fogged = noClockFixture(6);
  const rowClean = buildFrontJudgmentLines(clean.state).find((l) => l.includes("敌军实力未明"));
  const rowFogged = buildFrontJudgmentLines(fogged.state).find((l) => l.includes("敌军实力未明"));
  check("TA12 前置 无钟面确实无钟（该行不带 survival≈）",
    !!rowClean && !/survival≈/.test(rowClean), rowClean ?? "(无)");
  check(
    "TA13 面④ 政策 gate-null-clock：无钟 ⇒ 零过滤，候选照列（缺数不得当判决）",
    !!rowClean && rowClean.includes("best_help"),
    rowClean ?? "(无)",
  );
  check(
    "TA14 ★钉子①守卫★ 雾中敌军不得经候选名单形状泄露（有/无隐身敌，该行必须逐字相同）",
    rowClean === rowFogged,
    `clean=${rowClean ?? "(无)"}\n      fogged=${rowFogged ?? "(无)"}`,
  );

  // ── ④ 行为：结构性不可推销面 + 已入档缺口 ──
  check(
    "TA15 面⑥ 政策 no-eta：front=null 的板子群行结构上给不出 eta",
    buildReinforceOptions(state, null).options.every((o) => o.etaSec === null),
    buildReinforceOptions(state, null).options.map((o) => `${o.label}:${o.etaSec}`).join("|"),
  );
  const facId = [...state.facilities.keys()][0];
  const facFacts = facId ? facilityEscalationFacts(state, facId) : null;
  check(
    "TA16 面⑧ 政策 known-gap 记账：设施布尔仍被地图另一端的 idle 单位点亮（P1 待改话术）",
    !!facFacts && facFacts.idleReinforcementAvailable === true,
    facFacts ? `idle=${facFacts.idleReinforcementAvailable} 附近我方=${facFacts.nearbyPlayerUnits}` : "null",
  );

  // ── ⑤ 两机同尺（v4 §8 ⑥；审核档 §7⑥ 的原局）──
  //
  // 同一支候选：到【战斗点】25s、到【几何中心】89s、这条线撑 30s。装闸之后，
  // 量哪个点决定它是"来得及的援兵"还是"废候选"——机器 A 量战斗点留下它，
  // 机器 B 量几何中心淘汰它。诚实闸把这个旧偏差从排序扣分放大成了淘汰依据，
  // 所以两台机器必须用同一把尺。
  {
    const two = twoRulerFixture();
    const anchorPt = battleAnchorFor(two.state, two.front)!;
    const centerPt = frontCenterPos(two.state, two.front)!;
    const etaAnchor = etaTo(two.state, two.squadIds, anchorPt);
    const etaCenter = etaTo(two.state, two.squadIds, centerPt);
    const esc = assessCrisisEscalation(two.state, makeCrisis(two.front));
    const clock = esc && esc.exchange.spokenSeconds !== null ? Math.round(esc.exchange.spokenSeconds) : null;
    check(
      "TA17 前置 局造得对：到战斗点赶得上、到几何中心赶不上、钟在两者之间",
      etaAnchor !== null && etaCenter !== null && clock !== null &&
        etaAnchor <= clock && etaCenter > clock,
      `战斗点=${etaAnchor}s 几何中心=${etaCenter}s 钟=${clock}s`,
    );
    const optA = filterLateCandidates(buildReinforceOptions(two.state, two.front), clock)
      .options.find((o) => o.label === two.squadLabel);
    check(
      "TA18 前置 机器 A 留下了它（量的是战斗点）",
      !!optA && optA.etaSec === etaAnchor,
      optA ? `${optA.label} eta=${optA.etaSec}s` : "(被滤掉)",
    );
    checkKnife(
      "TA19 ★⑥★ 机器 B 装闸后同样留下它（两机同尺，不再一个说 25s 一个说 89s）",
      !!esc && esc.bestCandidate !== null && esc.bestCandidate.squadId === "T7" &&
        esc.bestCandidate.tArrive === etaAnchor,
      !!esc && esc.bestCandidate === null,
      esc ? `best=${esc.bestCandidate?.leaderName ?? "null"} tArrive=${esc.bestCandidate?.tArrive ?? "-"}s 战斗点=${etaAnchor}s 中心=${etaCenter}s 钟=${clock}s` : "null",
    );
  }
}

// ============================================================

function main(): void {
  if (NEGCTL) {
    console.log("=== NEGCTL 模式：★ 断言持修复前预期，必须出 FAIL ===");
  }
  runKnife1();
  runKnife1Withdraw();
  runKnifeF();
  runH1();
  runKnife2a();
  runKnife2b();
  runKnife2c();
  runKnife3();
  runKnifeA();
  runKnifeB1();
  runKnifeB2();

  console.log(`\nPASS=${passCount} FAIL=${failCount}`);
  if (NEGCTL) {
    const got = [...redNames].sort();
    const want = [...NEGCTL_EXPECTED_RED].sort();
    const missing = want.filter((n) => !got.includes(n));   // 牙掉了：本该红的变绿了
    const extra = got.filter((n) => !want.includes(n));     // 新红：多半是前置/fixture 塌了
    const ok = missing.length === 0 && extra.length === 0;
    if (!ok) {
      if (missing.length) console.log(`  ★ 掉牙（本该红却绿了）${missing.length} 条：\n    - ${missing.join("\n    - ")}`);
      if (extra.length) console.log(`  ！ 意外变红 ${extra.length} 条（多半是前置或 fixture 塌了）：\n    - ${extra.join("\n    - ")}`);
    }
    console.log(
      ok
        ? `NEGCTL OK — 红的正是登记在案的那 ${failCount} 条，修复确实承重`
        : `NEGCTL BAD — 红集合与登记表对不上（掉牙 ${missing.length} / 意外 ${extra.length}）：` +
          "先查是哪一边变了，不许改期望表迁就实测",
    );
    process.exit(ok ? 0 : 1);
  } else {
    console.log(failCount === 0 ? "ALL PASS" : `${failCount} FAILED`);
    process.exit(failCount === 0 ? 0 : 1);
  }
}

const mode = process.argv[2];
if (mode === "--synthetic" || mode === "--negctl") main();
else console.log("usage: tsx scripts/ab-approval-v4.ts --synthetic | --negctl");
