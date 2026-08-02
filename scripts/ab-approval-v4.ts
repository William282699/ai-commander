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
import { buildFrontJudgmentLines } from "../packages/core/src/commanderPresence";
import {
  mintEscalationTickets, lookupEscalationTicket, burnEscalationTicket, liveMembersOf,
  isTicketRef, ticketPromptLine, resetEscalationTickets, TICKET_TTL_SEC,
} from "../packages/core/src/escalationTicket";
import type { GameState, Unit, Front, Position } from "@ai-commander/shared";

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

function main(): void {
  if (NEGCTL) {
    console.log("=== NEGCTL 模式：★ 断言持修复前预期，必须出 FAIL ===");
  }
  runKnife1();
  runKnife2a();

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
