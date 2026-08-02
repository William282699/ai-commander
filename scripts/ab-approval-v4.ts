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

import { createInitialGameState } from "@ai-commander/core";
import {
  frontCenterPos,
  battleAnchorFor,
  estimateSquadTravelTime,
} from "../packages/core/src/crisisResponse";
import { buildReinforceOptions } from "../packages/core/src/frontEscalationPayload";
import { buildFrontJudgmentLines, commanderMood } from "../packages/core/src/commanderPresence";
import { assessCrisisEscalation } from "../packages/core/src/crisisResponse";
import { collectDirectorBeats, frontEscalationFacts } from "../packages/core/src/director";
import { captureDecisionReview } from "../packages/core/src/decisionReview";
import { filterLateCandidates } from "../packages/core/src/frontEscalationPayload";
import {
  mintEscalationTickets, lookupEscalationTicket, burnEscalationTicket, liveMembersOf,
  isTicketRef, isKnownForceRef, ticketPromptLine, resetEscalationTickets, TICKET_TTL_SEC,
  buildFrontEscalationWithTickets, resolveTicketReference, ticketDispatchReceipt,
  NO_PROPOSAL_GUIDANCE,
} from "../packages/core/src/escalationTicket";
import type { GameState, Unit, Front, Position, CrisisEvent } from "@ai-commander/shared";

// ── Harness ──

let failCount = 0;
let passCount = 0;
const NEGCTL = process.argv[2] === "--negctl";

function check(name: string, ok: boolean, detail = ""): void {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok || !detail ? "" : ` — ${detail}`}`);
  if (ok) passCount++;
  else failCount++;
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
    for (let i = 0; i < 2; i++) {
      addUnit(state, 130 + i, 90, { lastAttackTime: 0, lastDamagedAt: undefined });
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
  check(
    "T1a 前置 front_center 几何中心 == (263,96)（与 5a1f195 事故档同值）",
    center.x === 263 && center.y === 96,
    `实得 (${center.x},${center.y})`,
  );
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

  // ── 三级兜底 ──
  const quiet = scenarioKnife1({ engagedTimestamps: false, defendersInFront: true });
  const quietAnchor = battleAnchorFor(quiet.state, quiet.front);
  // No one fought recently → tier 2 (all in-front defenders): 4 east + 2 west.
  const expectX = (4 * (BATTLE.x + 1.5) + 2 * 130.5) / 6;
  check(
    "T1j 兜底二级 无人近期交火 → 全体在线守军质心（非几何中心）",
    !!quietAnchor && Math.abs(quietAnchor.x - expectX) < 0.01,
    `实得 ${quietAnchor ? quietAnchor.x.toFixed(2) : "null"} 期望 ${expectX.toFixed(2)}`,
  );

  const empty = scenarioKnife1({ engagedTimestamps: false, defendersInFront: false });
  const emptyAnchor = battleAnchorFor(empty.state, empty.front);
  const emptyCenter = frontCenterPos(empty.state, empty.front);
  check(
    "T1k 兜底三级 线内无我方部队 → 退回 frontCenterPos",
    !!emptyAnchor && !!emptyCenter &&
      emptyAnchor.x === emptyCenter.x && emptyAnchor.y === emptyCenter.y,
    `anchor=${emptyAnchor ? `${emptyAnchor.x},${emptyAnchor.y}` : "null"}`,
  );

  check(
    "T1l 交战守军优先于安静守军（一级压二级）",
    Math.abs(anchor.x - (BATTLE.x + 1.5)) < 0.01 && anchor.x > expectX,
    `engaged=${anchor.x} allDefenders=${expectX.toFixed(2)}`,
  );
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

const STRADDLE_INSIDE: Position = { x: 360, y: 138 }; // inside central_desert[120,80,370,140]
const STRADDLE_OUTSIDE: Position = { x: 360, y: 143 }; // outside, 5 tiles away → same cluster

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

  check("T3p 绊索引导句为引擎原文（该分支永不进 LLM）", NO_PROPOSAL_GUIDANCE.length > 0, NO_PROPOSAL_GUIDANCE);
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

function main(): void {
  if (NEGCTL) {
    console.log("=== NEGCTL 模式：★ 断言持修复前预期，必须出 FAIL ===");
  }
  runKnife1();
  runKnife2a();
  runKnife2b();
  runKnife2c();
  runKnife3();

  console.log(`\nPASS=${passCount} FAIL=${failCount}`);
  if (NEGCTL) {
    console.log(
      failCount > 0
        ? `NEGCTL OK — ${failCount} 条 ★ 断言真 FAIL（修复确实承重）`
        : "NEGCTL BAD — 零 FAIL，说明 ★ 断言是同义反复，不是真判据",
    );
  } else {
    console.log(failCount === 0 ? "ALL PASS" : `${failCount} FAILED`);
  }
}

const mode = process.argv[2];
if (mode === "--synthetic" || mode === "--negctl") main();
else console.log("usage: tsx scripts/ab-approval-v4.ts --synthetic | --negctl");
