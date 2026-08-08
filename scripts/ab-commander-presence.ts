// ============================================================
// AI Commander — Commander Presence bench (presence-v1)
//
// Step A: FRONT_JUDGMENT engine section + judgment-license real-model probes.
// Step B: commanderMood three-band thresholds (per-gate negatives) + the
//         calm-vs-critical register probe (human-read, logged).
//
// Modes:
//   --synthetic  deterministic assertions (no LLM, no server)
//   --real       real-model fixtures via the worktree server
//                (COMMAND_URL=http://localhost:3002/api/command)
//
// Both modes read the ONE production builder (buildFrontJudgmentLines) —
// never a re-implementation (V1b precedent).
//
// 家法（第四次判据教训，2026-07-28 审核判）：只读回话字面会漏"字面对、执行错"
// —— option.label 恒对时实派单位数仍在 8/74/0 之间跳（撤兵作用域账）。凡会动兵
// 的验收必须跑 resolveIntent 数 assignedUnitIds.length，不许看台词。本 bench 的
// S 系列只测台词层（PLAYER_VIEW 是纯信封步、零执行牵连）；执行链级落地时判据照此。
// 前三次同形教训：Step B 正则两向饱和 / 验收单一问法 / R12 关键词表 —— 共同
// 形状＝判据测"说了什么"，病在"做了什么"。
//
// Run (from the worktree root):
//   ./node_modules/.bin/tsx scripts/ab-commander-presence.ts --synthetic
// ============================================================

import {
  createInitialGameState,
  buildDigest,
  buildBattleContextV2,
  buildBattleBoard,
} from "@ai-commander/core";
import { generateDigestV1 } from "@ai-commander/shared";
import { boardToDigestLines } from "../packages/core/src/battleBoard";
import {
  buildFrontJudgmentLines,
  commanderMood,
  buildCommanderMoodLine,
  viewportToTileBox,
  unitsInBox,
  placeNameAt,
  buildPlayerViewLines,
  type ViewportGeometry,
} from "../packages/core/src/commanderPresence";
import { buildReinforceOptions, filterLateCandidates, nearestPlaceWithin } from "../packages/core/src/frontEscalationPayload";
import { resolveIntent } from "../packages/core/src/tacticalPlanner";
import { canUnitEnterTile } from "../packages/core/src/movementRules";
import type { GameState, Unit, Squad, Intent } from "@ai-commander/shared";

// ── Harness ──

let failCount = 0;
function check(name: string, ok: boolean, detail = ""): void {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok || !detail ? "" : ` — ${detail}`}`);
  if (!ok) failCount++;
}

/** Fresh el_alamein state with all units/squads removed (fronts/regions/facilities kept). */
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

function addSquad(state: GameState, ids: number[], over: Partial<Squad> = {}): Squad {
  const sq: Squad = {
    id: over.id ?? `B${nextId++}`,
    name: "bench squad",
    unitIds: ids,
    leader: { name: "Bench", rank: "sergeant" as Squad["leader"]["rank"], personality: "balanced" },
    currentMission: null,
    missionTarget: null,
    morale: 1,
    formationStyle: "line",
    ownerCommander: "chen",
    leaderName: "Bench",
    role: "leader",
    ...over,
  };
  state.squads.push(sq);
  return sq;
}

/** Mark a tile (and unit tiles) visible so the fog gate reads the enemy as seen. */
function reveal(state: GameState, x: number, y: number): void {
  const ty = Math.floor(y);
  const tx = Math.floor(x);
  if (state.fog[ty]) state.fog[ty][tx] = "visible";
}

// Fixture geometry (el_alamein): points chosen inside exactly ONE front's bbox.
// front_coastal ("1. 北部战线") — northern_coastal bbox [200,22,490,55] (y<45 avoids
// the kidney_ridge overlap band); front_ridge ("2. 山脊战线") — kidney_ridge_zone
// bbox [200,45,260,75] (y>55 avoids the coastal band).
const COASTAL = { x: 300, y: 30 };
const RIDGE = { x: 220, y: 65 };

/** Two-front crisis: committed forces + visible enemies on both, one idle squad far south. */
function twoFrontCrisis(): GameState {
  const s = emptyBattlefield();
  s.time = 120;

  // Committed defenders (in squads, engaged-ish positions)
  const c1 = addUnit(s, COASTAL.x, COASTAL.y, { hp: 40 });
  const c2 = addUnit(s, COASTAL.x + 2, COASTAL.y, { hp: 40 });
  addSquad(s, [c1.id, c2.id], { id: "I1", leaderName: "Aiden" });
  const r1 = addUnit(s, RIDGE.x, RIDGE.y, { hp: 60 });
  const r2 = addUnit(s, RIDGE.x + 2, RIDGE.y, { hp: 60 });
  addSquad(s, [r1.id, r2.id], { id: "I2", leaderName: "Carter" });

  // Visible enemies — coastal outnumbered hard, ridge roughly even
  for (let i = 0; i < 6; i++) {
    const e = addUnit(s, COASTAL.x + 4 + i, COASTAL.y + 2, { team: "enemy" } as Partial<Unit>);
    reveal(s, e.position.x, e.position.y);
  }
  for (let i = 0; i < 2; i++) {
    const e = addUnit(s, RIDGE.x + 4 + i, RIDGE.y + 2, { team: "enemy" } as Partial<Unit>);
    reveal(s, e.position.x, e.position.y);
  }

  // One free reinforcement squad outside both crisis fronts. y=150 keeps Blake
  // strictly in southern_desert — y=140 sits ON the central_desert bbox edge
  // ([120,80,370,140] is inclusive) and would give the central front a combat
  // presence, hiding its no-force note.
  const f1 = addUnit(s, 300, 150);
  const f2 = addUnit(s, 302, 150);
  addSquad(s, [f1.id, f2.id], { id: "T5", leaderName: "Blake" });

  return s;
}

/** Asymmetric crisis: coastal manned + visible enemies; central EMPTY (fallen);
 *  ridge unmanned too; Blake free in the south. The handtest shape: the player
 *  weighs a front the old frame silently omitted. */
function northCrisisCenterEmpty(): GameState {
  const s = emptyBattlefield();
  s.time = 150;
  const c1 = addUnit(s, COASTAL.x, COASTAL.y, { hp: 40 });
  const c2 = addUnit(s, COASTAL.x + 2, COASTAL.y, { hp: 40 });
  addSquad(s, [c1.id, c2.id], { id: "I1", leaderName: "Aiden" });
  for (let i = 0; i < 5; i++) {
    const e = addUnit(s, COASTAL.x + 4 + i, COASTAL.y + 2, { team: "enemy" } as Partial<Unit>);
    reveal(s, e.position.x, e.position.y);
  }
  const f1 = addUnit(s, 300, 150);
  const f2 = addUnit(s, 302, 150);
  addSquad(s, [f1.id, f2.id], { id: "T5", leaderName: "Blake" });
  return s;
}

/** Fogged brawl: coastal units carry OWN recent combat evidence (fired /
 *  took damage inside the 10s isEngaged window); enemies exist but are NEVER
 *  revealed — gate ② fails while the fight is on the player's screen. */
function foggedBrawl(opts: { staleEvidence?: boolean } = {}): GameState {
  const s = emptyBattlefield();
  s.time = 200;
  const t = opts.staleEvidence ? 100 : 197; // stale = far outside the window
  const c1 = addUnit(s, COASTAL.x, COASTAL.y, { hp: 30, lastDamagedAt: t } as Partial<Unit>);
  const c2 = addUnit(s, COASTAL.x + 2, COASTAL.y, { hp: 50, lastAttackTime: t + 1 });
  addSquad(s, [c1.id, c2.id], { id: "I1", leaderName: "Aiden" });
  for (let i = 0; i < 5; i++) {
    addUnit(s, COASTAL.x + 5 + i, COASTAL.y + 2, { team: "enemy" } as Partial<Unit>); // fog NOT revealed
  }
  const f1 = addUnit(s, 300, 150);
  const f2 = addUnit(s, 302, 150);
  addSquad(s, [f1.id, f2.id], { id: "T5", leaderName: "Blake" });
  return s;
}

/** twoFrontCrisis with OWN combat evidence stamped on both crisis fronts'
 *  defenders (Blake's southern reserve untouched) — the mood gates (①presence
 *  ②own-evidence engagement ③visible ratio) all pass. Coastal collapse ≈
 *  80HP / 24DPS ≈ 3s, ridge ≈ 120HP / 8DPS = 15s → both critical band,
 *  coastal tightest. */
function crisisEngaged(): GameState {
  const s = twoFrontCrisis();
  s.units.forEach((u) => {
    if (u.team === "player" && u.position.y < 100) {
      u.lastDamagedAt = s.time - 2; // inside the 10s isEngaged window
    }
  });
  return s;
}

/** Single-front boundary state: pooled defender HP vs ONE visible enemy
 *  infantry (DPS = 6/1.5 = 4) places collapse exactly at / just past the
 *  critical threshold: [40,40,40] → 120/4 = 30s; [40,40,48] → 128/4 = 32s. */
/** v4 刀3: enemyCount is now a parameter because the spoken clock reads BOTH
 *  sides. One enemy against three defenders is a fight we win, so it can no
 *  longer be used to exercise the "critical + seconds" band (see M9/M10). */
function boundaryMood(defenderHp: number[], enemyCount = 1): GameState {
  const s = emptyBattlefield();
  s.time = 300;
  const ids: number[] = [];
  defenderHp.forEach((hp, i) => {
    const u = addUnit(s, COASTAL.x + i, COASTAL.y, { hp, lastDamagedAt: s.time - 2 } as Partial<Unit>);
    ids.push(u.id);
  });
  addSquad(s, ids, { id: "I1", leaderName: "Aiden" });
  for (let k = 0; k < enemyCount; k++) {
    const e = addUnit(s, COASTAL.x + 8 + k, COASTAL.y, { team: "enemy" } as Partial<Unit>);
    reveal(s, e.position.x, e.position.y);
  }
  return s;
}

/** Enemy units brawling on a front with NO player force, the front's
 *  both-teams engagementIntensity forced high — a canary: if commanderMood
 *  ever consulted that metric, this state would read tense. */
function enemyOnlyFight(): GameState {
  const s = emptyBattlefield();
  s.time = 300;
  for (let i = 0; i < 6; i++) {
    const e = addUnit(s, COASTAL.x + i, COASTAL.y, { team: "enemy", lastDamagedAt: s.time - 1 } as Partial<Unit>);
    reveal(s, e.position.x, e.position.y);
  }
  const front = s.fronts.find((f) => f.id === "front_coastal")!;
  front.engagementIntensity = 9.9;
  const p = addUnit(s, 300, 150); // far-south player unit keeps the state non-degenerate
  addSquad(s, [p.id], { id: "T5", leaderName: "Blake" });
  return s;
}

// ── --synthetic ──

function runSynthetic(): void {
  console.log("== commander-presence Step A synthetic assertions ==");

  // A) Two-front crisis → one judgment line per pressured front, with survival,
  //    ratio, and a best_help drawn from the ONE V1b candidate builder.
  {
    const s = twoFrontCrisis();
    const lines = buildFrontJudgmentLines(s);
    check("A1 header present once", lines.filter((l) => l.startsWith("---FRONT_JUDGMENT---")).length === 1, lines.join(" | "));
    const coastal = lines.find((l) => l.startsWith("1. 北部战线:"));
    const ridge = lines.find((l) => l.startsWith("2. 山脊战线:"));
    check("A2 coastal line rendered", coastal !== undefined, lines.join(" | "));
    check("A3 ridge line rendered", ridge !== undefined, lines.join(" | "));
    // header + 2 real lines + 2 no-force notes (central fallen, axis rear);
    // southern front (Blake, no visible enemy) stays fog-silent entirely.
    check("A4 exactly 2 real + 2 no-force lines", lines.length === 5, `got ${lines.length}: ${lines.join(" | ")}`);
    check(
      "A5 survival+ratio tokens on both",
      [coastal, ridge].every((l) => !!l && /survival[≈=]/.test(l) && /ratio=\d/.test(l)),
      `${coastal} || ${ridge}`,
    );
    check("A6 no null/NaN leakage", lines.every((l) => !l.includes("null") && !l.includes("NaN") && !l.includes("Infinity")));

    // best_help must be the top shown V1b candidate for that front — same
    // builder, same sort; never a re-ranked or invented name.
    //
    // A 刀 (2026-08-02) 合同变更：候选集先过晚到闸，钟就是这一行自己印出来的
    // survival≈Ns。旧断言测的是"未过滤的 top"——那正是本刀砍掉的行为：这局
    // 只剩 3 秒，谁也赶不到，把 best_help=Carter(eta≈40s) 印上去是拿噪声冒充
    // 选择。新断言仍然守住原来那条性质（同一 builder、同一排序、绝不改名或
    // 重排），只是量在过闸后的集合上；集合空 ⇒ 该行必须一个字都不提增援。
    const coastalFront = s.fronts.find((f) => f.id === "front_coastal")!;
    const unfilteredTop = buildReinforceOptions(s, coastalFront).shown[0];
    const survivalMatch = coastal?.match(/survival≈(\d+)s/);
    const rowClock = survivalMatch ? Number(survivalMatch[1]) : null;
    const gatedTop = filterLateCandidates(buildReinforceOptions(s, coastalFront), rowClock).shown[0];
    // 防空转：这一局必须真的有候选被闸拦下，否则 A7 会以"闸没干活"的方式空绿。
    check(
      "A6b 前置 本局确有候选被晚到闸拦下（否则 A7 空转）",
      !!unfilteredTop && !gatedTop && rowClock !== null,
      `clock=${rowClock}s unfilteredTop=${unfilteredTop?.label}(eta≈${unfilteredTop?.etaSec}s) gatedTop=${gatedTop?.label ?? "none"}`,
    );
    check(
      "A7 best_help = 过闸后的 V1b top（空集 ⇒ 转为 none(...) 披露，不是沉默）",
      gatedTop
        ? !!coastal && coastal.includes(`best_help=${gatedTop.label}(`)
        : !!coastal && coastal.includes("best_help=none("),
      `gatedTop=${gatedTop?.label ?? "none"} line=${coastal}`,
    );
    check(
      "A8 eta token engine-sourced（推荐给 eta；空集给最近一股的 eta 作为「赶不到」的依据）",
      !!coastal && (/eta≈\d+s/.test(coastal) || coastal.includes("eta=unknown")),
      coastal,
    );
    // fix1：F1 教训上板——"无候选"绝不能读成"无友军"。手测现场：长官问
    // "有没有可支援部队"，参谋答"只有 Blake"，六辆闲着的坦克被藏掉。
    check(
      "A8b fix1 空集必须披露存在（有闲兵就报支数/人数，没有就明说无友军）",
      gatedTop
        ? true
        : !!coastal && (/线外\d+支\/\d+units/.test(coastal) ||
            /front 外有\d+个友军单位/.test(coastal) || coastal.includes("战场上无其他友军")),
      coastal,
    );

    // No-force notes (handtest fix): fallen/undeployed fronts appear as pure
    // existence facts — completing the compare frame with ZERO enemy-derived
    // data — and only ride along when at least one real judgment line exists.
    const center = lines.find((l) => l.startsWith("3. 中央战线:"));
    const rear = lines.find((l) => l.startsWith("5. 敌军后方:"));
    const south = lines.find((l) => l.startsWith("4. 南部战线:"));
    check("A9 central no-force note", center === "3. 中央战线: 无我方作战部队（增援须从后方调兵；早先提问里引用的该线存活/战力数字已作废）", center);
    check("A10 axis-rear no-force note", rear !== undefined, lines.join(" | "));
    check(
      "A11 no-force notes carry no engine combat data",
      [center, rear].every((l) => !!l && !/survival|ratio=|eta|best_help/.test(l)),
      `${center} || ${rear}`,
    );
    check("A12 fog-gated south stays silent", south === undefined, south);
  }

  // B) Presence gate: enemies visible on a front with NO committed player force
  //    → no line for it (the tCollapse=0 fake must never render).
  {
    const s = emptyBattlefield();
    s.time = 120;
    for (let i = 0; i < 4; i++) {
      const e = addUnit(s, COASTAL.x + i, COASTAL.y, { team: "enemy" } as Partial<Unit>);
      reveal(s, e.position.x, e.position.y);
    }
    // player presence only on ridge
    const r = addUnit(s, RIDGE.x, RIDGE.y);
    addSquad(s, [r.id], { id: "I2", leaderName: "Carter" });
    const e2 = addUnit(s, RIDGE.x + 3, RIDGE.y, { team: "enemy" } as Partial<Unit>);
    reveal(s, e2.position.x, e2.position.y);

    const lines = buildFrontJudgmentLines(s);
    const coastalLine = lines.find((l) => l.startsWith("1. 北部战线:"));
    check(
      "B1 empty-front fake killed (no-force note, zero combat data)",
      coastalLine !== undefined && coastalLine.includes("无我方作战部队") && !/survival|ratio=|eta/.test(coastalLine),
      coastalLine ?? lines.join(" | "),
    );
    check("B2 manned front still renders", lines.some((l) => l.startsWith("2. 山脊战线:") && /survival[≈=]/.test(l)), lines.join(" | "));
  }

  // C) Fog gate: enemy present but NOT visible → nothing to judge → no line.
  {
    const s = emptyBattlefield();
    s.time = 120;
    const p = addUnit(s, COASTAL.x, COASTAL.y);
    addSquad(s, [p.id], { id: "I1", leaderName: "Aiden" });
    addUnit(s, COASTAL.x + 5, COASTAL.y, { team: "enemy" } as Partial<Unit>); // fog NOT revealed
    const lines = buildFrontJudgmentLines(s);
    check("C1 invisible enemy → no section", lines.length === 0, lines.join(" | "));
  }

  // D) Healthy battlefield (players only, no visible enemy) → section omitted.
  {
    const s = emptyBattlefield();
    s.time = 120;
    const p = addUnit(s, COASTAL.x, COASTAL.y);
    addSquad(s, [p.id], { id: "I1", leaderName: "Aiden" });
    check("D1 healthy → no section", buildFrontJudgmentLines(s).length === 0);
  }

  // I) Engaged-unknown line (handtest round-2 fix): a front where OUR units
  //    are trading fire under fog must never vanish from the frame. Evidence
  //    source is the units' OWN timestamps (V1b isEngaged), never
  //    engagementIntensity (counts both teams → would leak unseen fights).
  {
    const s = foggedBrawl();
    const lines = buildFrontJudgmentLines(s);
    const coastal = lines.find((l) => l.startsWith("1. 北部战线:"));
    check(
      "I1 fogged brawl renders engaged-unknown line",
      !!coastal && coastal.includes("交战中") && coastal.includes("敌军实力未明"),
      lines.join(" | "),
    );
    check(
      "I2 own-strength tokens only (count + hp%)",
      !!coastal && /我方2units hp=\d+%/.test(coastal) && !/survival[≈=]|ratio=/.test(coastal),
      coastal,
    );
    check("I3 best_help rides (own geometry, zero enemy data)", !!coastal && /best_help=.*eta≈\d+s/.test(coastal), coastal);
    check(
      "I4 counts as body: no-force notes ride along",
      lines.some((l) => l.includes("无我方作战部队")),
      lines.join(" | "),
    );
    check(
      "I5 hidden enemy count (5) leaks nowhere",
      lines.every((l) => !l.includes("5units") && !l.includes("5×")),
      lines.join(" | "),
    );
  }

  // I6) Same front, evidence outside the 10s window → no line, and with no
  //     real/engaged line anywhere the section stays omitted entirely.
  {
    const s = foggedBrawl({ staleEvidence: true });
    check("I6 stale evidence → section omitted", buildFrontJudgmentLines(s).length === 0);
  }

  // M) Step B — commanderMood: three-band thresholds + one negative per gate.
  //    Same three gates as the judgment line kinds; the voice may never move
  //    on evidence the player can't see.
  {
    // No engagement anywhere (healthy field, collapse=Infinity on every front)
    // → calm, and calm renders NO envelope line (Act-0 guard).
    const s = emptyBattlefield();
    s.time = 120;
    const p = addUnit(s, COASTAL.x, COASTAL.y);
    addSquad(s, [p.id], { id: "I1", leaderName: "Aiden" });
    const m = commanderMood(s);
    check("M1 no combat → calm", m.level === "calm", `${m.level}（${m.reason}）`);
    check("M2 calm renders no envelope line", buildCommanderMoodLine(s) === null);
  }
  {
    // Gate ① negative + engagementIntensity ban canary: an enemy-only brawl
    // with the both-teams metric forced high must not raise the voice.
    const m = commanderMood(enemyOnlyFight());
    check("M3 enemy-only fight (engagementIntensity=9.9) → calm", m.level === "calm", `${m.level}（${m.reason}）`);
  }
  {
    // Gate ② negatives: visible enemies massing against committed defenders
    // but no own fired-at/took-damage evidence — content may alarm (the
    // judgment section still renders), tone must not move until contact.
    const m = commanderMood(twoFrontCrisis());
    check("M4 massing without contact → calm", m.level === "calm", `${m.level}（${m.reason}）`);
    const m2 = commanderMood(foggedBrawl({ staleEvidence: true }));
    check("M5 stale own evidence → calm", m2.level === "calm", `${m2.level}（${m2.reason}）`);
  }
  {
    // Gate ③ fog branch: engaged under fog is tense on own facts alone; the
    // reason carries no collapse seconds (estimateCollapseTime counts unseen
    // enemies) and no ratio; the hidden enemy count leaks nowhere.
    const m = commanderMood(foggedBrawl());
    check("M6 fogged brawl → tense", m.level === "tense", `${m.level}（${m.reason}）`);
    check(
      "M7 fog reason: own facts, no seconds/ratio",
      m.reason.includes("交战中") && m.reason.includes("未明") && !m.reason.includes("秒") && !m.reason.includes("战力比"),
      m.reason,
    );
    check("M8 hidden enemy count leaks nowhere", !m.reason.includes("5"), m.reason);
  }
  {
    // Visible-branch banding at the named threshold (CRITICAL_COLLAPSE_SEC=30,
    // inclusive). v4 刀3 (§6c-3 行为变化预期 + §6c-3b 用户裁定 A): the spoken
    // clock is now the EXCHANGE clock, so the boundary must be exercised by a
    // fight we are LOSING. The old fixture (3 defenders vs 1 enemy) said "还能
    // 撑30秒" while the enemy died in 5 — it asserted the very lie 刀3 removes.
    //
    // Losing boundary, 1v3, arithmetic checkable by hand:
    //   defender 1×360HP, DPS 4   → tWeDie     = 360 / 12 = 30s  (on the band edge)
    //   enemy    3×60HP,  DPS 12  → tEnemyDies = 180 /  4 = 45s
    //   45 > 30 ⇒ holds=false ⇒ spokenSeconds = 30
    const mCrit = commanderMood(boundaryMood([360], 3));
    check("M9 t=30s boundary (输面 1v3) → critical", mCrit.level === "critical", `${mCrit.level}（${mCrit.reason}）`);
    check("M10 critical reason: front + ~seconds", mCrit.reason.includes("北部战线") && /约30秒内/.test(mCrit.reason), mCrit.reason);
    // 负对照 (§6c-3b 条件 b): the SAME 30s pessimistic clock, but we win the
    // exchange (3 defenders vs 1 enemy: they die in 5s). A countdown here is
    // the pre-刀3 lie — it must not come back.
    const mWin = commanderMood(boundaryMood([40, 40, 40]));
    check(
      "M9b ★负对照★ 赢面 3打1：同样 30s 悲观钟，绝不出倒计时",
      mWin.level !== "critical" && !/秒内/.test(mWin.reason),
      `${mWin.level}（${mWin.reason}）`,
    );
    const mTense = commanderMood(boundaryMood([40, 40, 48]));
    check(
      "M11 t=32s → tense w/ ratio, no seconds",
      mTense.level === "tense" && mTense.reason.includes("战力比3.00") && !mTense.reason.includes("秒"),
      `${mTense.level}（${mTense.reason}）`,
    );
  }
  {
    // Worst front wins (coastal 3s beats ridge 15s inside the critical band);
    // envelope tail rides BOTH routes; healthy renders stay mood-free.
    const s = crisisEngaged();
    const m = commanderMood(s);
    check("M12 two engaged fronts → critical band", m.level === "critical", `${m.level}（${m.reason}）`);
    check("M13 reason names the tightest front", m.reason.includes("北部战线") && /约\d+秒内/.test(m.reason), m.reason);
    const moodLine = buildCommanderMoodLine(s);
    check("M14 mood line format", moodLine !== null && /^mood: critical（.+）$/.test(moodLine), moodLine ?? "null");
    const d = buildDigest(s, [], [], []);
    check("M15 DigestV1 ends with mood line", moodLine !== null && d.endsWith(`${moodLine}\n`));
    const ctx = buildBattleContextV2(s, "ops", { playerIntent: "", openCommitments: [] });
    check("M16 V2 ends with mood line after judgment", moodLine !== null && ctx.endsWith(moodLine) && ctx.includes("---FRONT_JUDGMENT---"));
    const h = emptyBattlefield();
    h.time = 120;
    const hp = addUnit(h, COASTAL.x, COASTAL.y);
    addSquad(h, [hp.id], { id: "I1", leaderName: "Aiden" });
    check(
      "M17 healthy digests carry no mood line",
      !buildDigest(h, [], [], []).includes("mood:") &&
        !buildBattleContextV2(h, "ops", { playerIntent: "", openCommitments: [] }).includes("mood:"),
    );
  }

  // E) DigestV1 append-only contract: the digest WITHOUT judgment lines is a
  //    byte-exact prefix; the tail is exactly the builder's lines.
  {
    const s = twoFrontCrisis();
    const newDigest = buildDigest(s, [], [], []); // mutates front power, then renders
    const board = boardToDigestLines(buildBattleBoard(s));
    const oldDigest = generateDigestV1(s, [], [], [], board); // same state, no judgment
    const judgment = buildFrontJudgmentLines(s);
    const expectedTail = judgment.map((l) => `${l}\n`).join("");
    check("E1 DigestV1 byte-prefix", newDigest.startsWith(oldDigest), "legacy digest is not a prefix");
    check("E2 DigestV1 tail = judgment lines exactly", newDigest === oldDigest + expectedTail);
  }

  // E3) Same append-only contract on the engaged-unknown path. Step B: this
  //     fixture is engaged → the tense mood line rides the tail after the
  //     judgment section (twoFrontCrisis in E2 stays calm — no line, no drift).
  {
    const s = foggedBrawl();
    const newDigest = buildDigest(s, [], [], []);
    const board = boardToDigestLines(buildBattleBoard(s));
    const oldDigest = generateDigestV1(s, [], [], [], board);
    const judgment = buildFrontJudgmentLines(s);
    const mood = buildCommanderMoodLine(s);
    const expectedTail = [...judgment, ...(mood ? [mood] : [])].map((l) => `${l}\n`).join("");
    check("E3 engaged-unknown digest byte-prefix + exact tail (judgment + mood)", newDigest === oldDigest + expectedTail);
    check("E4 fog mood line is tense", mood !== null && mood.startsWith("mood: tense（"), mood ?? "null");
  }

  // F) BattleContextV2 append-only contract: judgment block sits at the very
  //    end, after FORCES, and is exactly the same ONE builder's output.
  {
    const s = twoFrontCrisis();
    const ctx = buildBattleContextV2(s, "ops", { playerIntent: "", openCommitments: [] });
    const judgment = buildFrontJudgmentLines(s);
    check("F1 V2 ends with judgment block", judgment.length > 0 && ctx.endsWith(judgment.join("\n")));
    const before = ctx.slice(0, ctx.length - judgment.join("\n").length);
    check("F2 V2 judgment after FORCES", before.includes("---FORCES---") && !before.includes("---FRONT_JUDGMENT---"));
  }

  // G) Healthy V2/V1 renders carry no judgment section at all (no empty header).
  {
    const s = emptyBattlefield();
    s.time = 120;
    const p = addUnit(s, COASTAL.x, COASTAL.y);
    addSquad(s, [p.id], { id: "I1", leaderName: "Aiden" });
    const d = buildDigest(s, [], [], []);
    const ctx = buildBattleContextV2(s, "ops", { playerIntent: "", openCommitments: [] });
    check("G1 healthy DigestV1 clean", !d.includes("FRONT_JUDGMENT"));
    check("G2 healthy V2 clean", !ctx.includes("FRONT_JUDGMENT"));
  }

  // H) el_alamein opening state (production start): whatever renders must obey
  //    the gates — every body line names a real front with committed presence.
  {
    const s = createInitialGameState("el_alamein");
    const lines = buildFrontJudgmentLines(s);
    const frontNames = new Set(s.fronts.map((f) => f.name));
    const bodyOk = lines
      .filter((l) => !l.startsWith("---"))
      .every((l) => frontNames.has(l.slice(0, l.indexOf(":"))));
    check("H1 opening lines name real fronts only", bodyOk, lines.join(" | "));
    console.log(`   (opening state renders ${Math.max(0, lines.length - 1)} judgment line(s))`);
  }

  // ── Step C: PLAYER_VIEW synthetic assertions ──
  console.log("\n== commander-presence Step C synthetic assertions ==");

  // Helper: viewport whose tile box is centered on pt with half-extents (tiles).
  const TILE = 32; // shared TILE_SIZE (constants.ts) — px per tile at zoom 1
  const viewAround = (pt: { x: number; y: number }, halfW: number, halfH: number): ViewportGeometry => ({
    x: (pt.x - halfW) * TILE,
    y: (pt.y - halfH) * TILE,
    zoom: 1,
    canvasWidth: 2 * halfW * TILE,
    canvasHeight: 2 * halfH * TILE,
  });
  let unnamedPoint: { x: number; y: number } | null = null;

  // P1) Pixel↔tile conversion — the renderer's own formula, both zoom ends.
  //     A wrong formula fails silent (empty view / whole-map view), so exact
  //     numbers are pinned here.
  {
    const b1 = viewportToTileBox({ x: 320, y: 160, zoom: 2, canvasWidth: 640, canvasHeight: 320 });
    check("P1 zoom=2 box exact", b1.left === 10 && b1.top === 5 && b1.right === 20 && b1.bottom === 10, JSON.stringify(b1));
    const b2 = viewportToTileBox({ x: 0, y: 0, zoom: 0.5, canvasWidth: 640, canvasHeight: 320 });
    check("P2 zoom=0.5 box exact", b2.left === 0 && b2.top === 0 && b2.right === 40 && b2.bottom === 20, JSON.stringify(b2));
  }

  // P3) unitsInBox boundaries: empty view → nothing; whole-map view → every
  //     alive unit; edges inclusive; dead excluded.
  {
    const s = emptyBattlefield();
    const a = addUnit(s, 50, 50);
    addUnit(s, 52, 50); // sits exactly on the right edge of the P5 box
    const dead = addUnit(s, 51, 50, { hp: 0, state: "dead" } as Partial<Unit>);
    check("P3 empty view → no units", unitsInBox(s, { left: 100, top: 100, right: 110, bottom: 110 }).length === 0);
    const all = unitsInBox(s, { left: 0, top: 0, right: s.mapWidth, bottom: s.mapHeight });
    check("P4 whole-map view → all alive units", all.length === 2 && !all.some((u) => u.id === dead.id), `got ${all.length}`);
    const edge = unitsInBox(s, { left: 48, top: 48, right: 52, bottom: 52 });
    check("P5 inclusive edge", edge.length === 2 && edge.some((u) => u.id === a.id), `got ${edge.length}`);
  }

  // P6) placeNameAt: facility name resolves; a player tag WITHIN radius beats
  //     it (planted precision outranks standing names); a far tag does not;
  //     an unresolvable point is null, never an approximation.
  {
    const s = emptyBattlefield();
    let fac: { name: string; position: { x: number; y: number } } | null = null;
    s.facilities.forEach((f) => { if (!fac) fac = { name: f.name, position: f.position }; });
    if (!fac) throw new Error("no facilities in el_alamein");
    const fpos = (fac as { name: string; position: { x: number; y: number } }).position;
    const fname = (fac as { name: string; position: { x: number; y: number } }).name;
    check("P6 facility name resolves", placeNameAt(s, fpos) === fname, `${placeNameAt(s, fpos)} vs ${fname}`);
    s.tags.push({ id: "tag_1", name: "司令旗", position: { x: fpos.x + 2, y: fpos.y }, createdAt: 0 });
    check("P7 tag beats facility inside radius", placeNameAt(s, fpos) === "司令旗");
    s.tags[0].position = { x: fpos.x + 40, y: fpos.y };
    check("P8 far tag falls back to facility", placeNameAt(s, fpos) === fname);
    s.tags.pop();
    // Deterministic hunt for a genuinely unnamed point: scan a coarse grid;
    // with no tags placeNameAt IS the shared facility/front resolver, so null
    // here means "no standing name within radius" — assert one exists.
    for (let y = 2; y < s.mapHeight && !unnamedPoint; y += 7) {
      for (let x = 2; x < s.mapWidth && !unnamedPoint; x += 7) {
        if (placeNameAt(s, { x, y }) === null) unnamedPoint = { x, y };
      }
    }
    check("P9 unnamed point exists and resolves null", unnamedPoint !== null, "map fully covered by names");
  }

  // P10) buildPlayerViewLines composition: named view with friendlies; fog
  //      keeps hidden enemies out; reveal brings them in; ≤5 lines; label is
  //      镜头对准 (the camera stays a clue, never "你正看着" a topic).
  {
    const s = emptyBattlefield();
    let fpos: { x: number; y: number } | null = null;
    s.facilities.forEach((f) => { if (!fpos) fpos = f.position; });
    const pt = fpos as unknown as { x: number; y: number };
    addUnit(s, pt.x + 1, pt.y);
    addUnit(s, pt.x - 1, pt.y, { type: "tank" } as Partial<Unit>);
    const hidden = addUnit(s, pt.x + 3, pt.y, { team: "enemy" } as Partial<Unit>);
    const view = viewAround(pt, 6, 6);

    const lines1 = buildPlayerViewLines(s, view, []);
    check("P10 header + 镜头对准 present", lines1[0]?.startsWith("---PLAYER_VIEW---") === true && lines1.some((l) => l.startsWith("镜头对准: ")), lines1.join(" | "));
    check("P11 friendly summary rendered", lines1.some((l) => /^视口内我方: 2units\(/.test(l)), lines1.join(" | "));
    check("P12 hidden enemy leaks nowhere", !lines1.some((l) => l.includes("敌军")), lines1.join(" | "));
    check("P13 section ≤5 lines", lines1.length <= 5, `${lines1.length}`);
    check("P14 no 你正看着 phrasing", lines1.every((l) => !l.includes("你正看着")));

    reveal(s, hidden.position.x, hidden.position.y);
    const lines2 = buildPlayerViewLines(s, view, []);
    check("P15 revealed enemy rendered", lines2.some((l) => /^视口内可见敌军: 1units\(/.test(l)), lines2.join(" | "));

    // Selected units: line renders from passed ids; dead ids drop; empty omits.
    const sel = addUnit(s, pt.x, pt.y + 1);
    const deadSel = addUnit(s, pt.x, pt.y + 2, { hp: 0, state: "dead" } as Partial<Unit>);
    const lines3 = buildPlayerViewLines(s, view, [sel.id, deadSel.id]);
    check("P16 selected line from live ids only", lines3.some((l) => l.startsWith("选中单位: ") && l.includes(`#${sel.id}(`) && !l.includes(`#${deadSel.id}(`)), lines3.join(" | "));
    check("P17 no selected line when empty", !lines2.some((l) => l.startsWith("选中单位")));
  }

  // P18) Omission over fabrication: an unnamed empty view renders NOTHING —
  //      no lone header (Act-0 guard).
  {
    const s = emptyBattlefield();
    if (unnamedPoint) {
      const lines = buildPlayerViewLines(s, viewAround(unnamedPoint, 4, 4), []);
      check("P18 unnamed empty view → section omitted", lines.length === 0, lines.join(" | "));
    } else {
      check("P18 unnamed empty view → section omitted", false, "no unnamed point found by P9");
    }
  }

  // P19) Route contract: PLAYER_VIEW is ChatPanel-injected — neither digest
  //      builder may ever emit it. Watering the existing PLAYER_SELECTED pipe
  //      changes the envelope by EXACTLY that section and nothing else.
  {
    const s = twoFrontCrisis();
    const d = buildDigest(s, [], [], []);
    const ctx = buildBattleContextV2(s, "ops", { playerIntent: "", openCommitments: [] });
    check("P19 builders never emit PLAYER_VIEW", !d.includes("PLAYER_VIEW") && !ctx.includes("PLAYER_VIEW"));

    const u = addUnit(s, 305, 150);
    const dWithout = buildDigest(s, [], [], []);
    const dWith = buildDigest(s, [u.id], [], []);
    const block = `---PLAYER_SELECTED---\n#${u.id} ${u.type} hp=${u.hp}/${u.maxHp} @(${u.position.x},${u.position.y}) sq=none\n`;
    check("P20 selected pipe waters exactly one section", dWith.includes(block) && dWith.replace(block, "") === dWithout, `has=${dWith.includes(block)}`);
  }

  // ============================================================
  // 第 8 级 刀4 — 玩家标记进"就近地名"
  //
  // 判据一律走生产路径：label 从 buildReinforceOptions 取，不自拼；
  // 闭环那条数 assignedUnitIds，不看 label 文本（第 6b 级"字面对、执行错"教训）。
  // ============================================================
  console.log("\n== 刀4 tag → nearestPlaceWithin（标记也是地名）==");

  /** 一支停在旷野里的未编组闲兵群：远离一切设施与战线中心，名字只能靠标记。 */
  function idleGroupAtUnnamedSpot(): { s: GameState; spot: { x: number; y: number }; ids: number[] } {
    const s = emptyBattlefield();
    s.time = 240;
    // 选点必须同时满足两条，缺一台架就测不到东西：①生产解析器叫不出名字（否则
    // K4-1 的"修前无名"不成立）②兵站得上去、标记那格也走得到——否则 resolveIntent
    // 一律 degraded「目标地形不可达」，闭环那条会以 0 单位"通过"：空转断言白过，
    // 第 7 级刚吃过这个亏。用生产 canUnitEnterTile 判，不自造地形判定。
    let spot: { x: number; y: number } | null = null;
    const walkable = (x: number, y: number): boolean =>
      canUnitEnterTile("infantry", Math.round(x), Math.round(y), s);
    for (let y = 2; y < s.mapHeight && !spot; y += 3) {
      for (let x = 2; x < s.mapWidth && !spot; x += 3) {
        if (placeNameAt(s, { x, y }) !== null) continue;
        if (walkable(x, y) && walkable(x + 1, y) && walkable(x + 3, y)) spot = { x, y };
      }
    }
    if (!spot) throw new Error("地图上找不到「无名 + 可通行」的点，本刀不可测");
    const ids = [addUnit(s, spot.x, spot.y).id, addUnit(s, spot.x + 1, spot.y).id];
    return { s, spot, ids };
  }

  const groupLabel = (s: GameState): string =>
    buildReinforceOptions(s, null).options.map((o) => o.label).join("|");

  // K4-1 正例：标记半径内的群，label 带标记名（生产 label，不自拼）
  {
    const { s, spot } = idleGroupAtUnnamedSpot();
    const before = groupLabel(s);
    s.tags.push({ id: "tag_1", name: "制高点", position: { x: spot.x + 3, y: spot.y }, createdAt: 0 });
    const after = groupLabel(s);
    check(
      "K4-1 标记半径内的未编组群 label 带标记名（修前叫不出名字）",
      !before.includes("制高点") && after.includes("制高点") && after.includes("未编组群"),
      `修前=${before} 修后=${after}`,
    );
  }

  // K4-2 标记赢过更近的设施（语义从 placeNameAt 原样移植，不是"更准"，是长官花的精度）
  {
    const s = emptyBattlefield();
    let fpos: { x: number; y: number } | null = null;
    let fname = "";
    s.facilities.forEach((f) => { if (!fpos) { fpos = { ...f.position }; fname = f.name; } });
    const p = fpos as unknown as { x: number; y: number };
    check("K4-2a 前置 该点本来解析成设施名", nearestPlaceWithin(s, p) === fname, `${nearestPlaceWithin(s, p)}`);
    s.tags.push({ id: "tag_1", name: "司令旗", position: { x: p.x + 5, y: p.y }, createdAt: 0 });
    check(
      "K4-2 标记赢过更近的设施（设施 0 格、标记 5 格，仍报标记）",
      nearestPlaceWithin(s, p) === "司令旗",
      `${nearestPlaceWithin(s, p)}`,
    );
  }

  // K4-3 别名等价：placeNameAt 塌缩之后与 nearestPlaceWithin 逐点同答
  {
    const { s, spot } = idleGroupAtUnnamedSpot();
    s.tags.push({ id: "tag_1", name: "制高点", position: { x: spot.x + 3, y: spot.y }, createdAt: 0 });
    let same = true;
    let firstDiff = "";
    for (let y = 1; y < s.mapHeight; y += 11) {
      for (let x = 1; x < s.mapWidth; x += 11) {
        const a = placeNameAt(s, { x, y });
        const b = nearestPlaceWithin(s, { x, y });
        if (a !== b) { same = false; if (!firstDiff) firstDiff = `(${x},${y}) ${a} vs ${b}`; }
      }
    }
    check("K4-3 placeNameAt 是 nearestPlaceWithin 的别名（全图抽样逐点同答）", same, firstDiff);
  }

  // K4-4 ★闭环·数 assignedUnitIds★：信封印出去的标记名，写回单子必须解析得到
  //      —— 与刀2 的番号前缀同一条原则：引擎自己印出去的名字，引擎必须认得回来。
  {
    const { s, spot, ids } = idleGroupAtUnnamedSpot();
    s.tags.push({ id: "tag_1", name: "制高点", position: { x: spot.x + 3, y: spot.y }, createdAt: 0 });
    const label = groupLabel(s);
    check("K4-4a 前置 label 确实印出了标记名", label.includes("制高点"), label);

    // 模型把它刚听见的**名字**写回 targetRegion（不是 tag_1）
    const byName = resolveIntent(
      { type: "defend", targetRegion: "制高点", quantity: "all" } as Intent, s, s.style,
    );
    const byId = resolveIntent(
      { type: "defend", targetRegion: "tag_1", quantity: "all" } as Intent, s, s.style,
    );
    const assignedName = [...new Set(byName.orders.flatMap((o) => o.unitIds))].sort((a, b) => a - b);
    const assignedId = [...new Set(byId.orders.flatMap((o) => o.unitIds))].sort((a, b) => a - b);
    // 落点不能钉单张 order 的 target：defend 会按队形把人摊开，orders[0] 只是摊开后的
    // 一格。钉两样——①名字路径与 id 路径**逐字节同一张单**（这就是闭环本身）
    // ②落点质心 == 标记那一格（证明去的是标记，不是别处）。
    const ordersKey = (r: { orders: { unitIds: number[]; action: string; target?: { x: number; y: number } | null }[] }): string =>
      JSON.stringify(r.orders.map((o) => ({ u: [...o.unitIds].sort((a, b) => a - b), a: o.action, t: o.target })));
    const lands = byName.orders.map((o) => o.target).filter((t): t is { x: number; y: number } => !!t);
    const cx = lands.reduce((s2, t) => s2 + t.x, 0) / (lands.length || 1);
    const cy = lands.reduce((s2, t) => s2 + t.y, 0) / (lands.length || 1);
    check(
      "K4-4 ★闭环★ 写回标记【名字】== 写回 tag id：逐字节同一张单，落点质心落在标记上",
      assignedName.length > 0 &&
        assignedName.join(",") === assignedId.join(",") &&
        ordersKey(byName) === ordersKey(byId) &&
        lands.length > 0 && Math.abs(cx - (spot.x + 3)) < 0.51 && Math.abs(cy - spot.y) < 0.51,
      `assigned=[${assignedName}] 质心=(${cx.toFixed(2)},${cy.toFixed(2)}) 标记=(${spot.x + 3},${spot.y}) 同单=${ordersKey(byName) === ordersKey(byId)}`,
    );
    check(
      "K4-4b 闭环兜底：这批兵确实是标记旁那两个（不是全图乱抓）",
      assignedName.join(",") === [...ids].sort((a, b) => a - b).join(","),
      `assigned=[${assignedName}] 期望=[${ids}]`,
    );
    // 负对照：没印出去的东西不许认（不是同义词表）
    const bogus = resolveIntent(
      { type: "defend", targetRegion: "那个高地", quantity: "all" } as Intent, s, s.style,
    );
    const bogusLand = bogus.orders[0]?.target;
    check(
      "K4-4c ★负对照★ 引擎没印过的说法不解析成标记（禁同义词表）",
      !bogusLand || !(bogusLand.x === spot.x + 3 && bogusLand.y === spot.y),
      `落点=${JSON.stringify(bogusLand)} 标记=(${spot.x + 3},${spot.y})`,
    );
  }

  // K4-5 ★负对照★ 无标记的对局：全信封逐字节不变
  {
    const base = twoFrontCrisis();
    check("K4-5a 前置 该对局本来没有标记", base.tags.length === 0, `tags=${base.tags.length}`);
    const d1 = buildDigest(base, [], [], []);
    const c1 = buildBattleContextV2(base, "combat", { playerIntent: "", openCommitments: [] });
    const j1 = buildFrontJudgmentLines(base).join("\n");
    // 与一个从头到尾没碰过 tags 的同构局逐字节比：本刀在无标记对局上必须是空操作
    const twin = twoFrontCrisis();
    check(
      "K4-5 ★负对照★ 无标记对局：DigestV1 / BattleContextV2 / 判读行三面逐字节不变",
      d1 === buildDigest(twin, [], [], []) &&
        c1 === buildBattleContextV2(twin, "combat", { playerIntent: "", openCommitments: [] }) &&
        j1 === buildFrontJudgmentLines(twin).join("\n"),
    );
  }

  // K4-6 ★负对照★ 半径边界：量的必须是命名真正用的那个点（群/分队的**质心**），
  //      不是随便一个成员——从成员量 13 格，质心可能才 11 格，那测的是别的东西。
  //      12 格内改名、13 格外不改名，两头都钉，边界才算被钉住。
  {
    const mk = (offset: number | null): string => {
      const { s, spot } = idleGroupAtUnnamedSpot();
      // 群质心 = 两个兵的中点
      const cx = spot.x + 0.5, cy = spot.y;
      if (offset !== null) {
        s.tags.push({ id: "tag_1", name: "远标记", position: { x: cx + offset, y: cy }, createdAt: 0 });
      }
      return groupLabel(s);
    };
    const none = mk(null);
    const inside = mk(12);
    const outside = mk(13);
    check(
      "K4-6 ★负对照★ 标记在质心 13 格外：群 label 与无标记时逐字节相同",
      outside === none,
      `无标记=${none} 13格=${outside}`,
    );
    check(
      "K4-6b 边界对照：12 格内确实改名（证明 13 格是「刚好够不着」，不是「哪儿都不生效」）",
      inside !== none && inside.includes("远标记"),
      `无标记=${none} 12格=${inside}`,
    );
  }

  // K4-7 ★负对照★ 半径外的标记对整封信的唯一影响 = ---TAGS--- 清单本身
  //      （那是 Day 15 就有的玩家标记清单，不是命名面；把它与命名分开钉住，
  //      将来谁在命名面上漏了半径判断，这条会红）
  {
    const base = twoFrontCrisis();
    const far = twoFrontCrisis();
    const anyUnit = [...far.units.values()].find((u) => u.team === "player")!;
    far.tags.push({
      id: "tag_1", name: "远标记",
      position: { x: anyUnit.position.x + 200, y: anyUnit.position.y }, createdAt: 0,
    });
    const a = buildDigest(base, [], [], []).split("\n");
    const b = buildDigest(far, [], [], []).split("\n");
    const added = b.filter((l) => !a.includes(l));
    const removed = a.filter((l) => !b.includes(l));
    check(
      // fix B：---TAGS--- 行改名字前置 `"名字"(tag_id) @(x,y)`。断言随格式更新，
      // 不放宽——仍然逐字钉住行首是名字、id 在括号里、坐标在后。
      "K4-7 ★负对照★ 远标记对 DigestV1 的唯一影响是 ---TAGS--- 两行，命名面零变化",
      removed.length === 0 && added.length === 2 &&
        added[0] === "---TAGS---" &&
        /^"远标记"\(tag_1\) @\(\d+,\d+\)$/.test(added[1]),
      `+${JSON.stringify(added)} -${JSON.stringify(removed)}`,
    );
    check(
      "K4-7b 远标记不改判读行与 BattleContextV2",
      buildFrontJudgmentLines(far).join("\n") === buildFrontJudgmentLines(base).join("\n") &&
        buildBattleContextV2(far, "combat", { playerIntent: "", openCommitments: [] }) ===
          buildBattleContextV2(base, "combat", { playerIntent: "", openCommitments: [] }),
    );
  }

  console.log(failCount === 0 ? "\nALL SYNTHETIC PASS" : `\n${failCount} FAILURES`);
  process.exit(failCount === 0 ? 0 : 1);
}

// ── --real (real model via worktree server; COMMAND_URL points at :3002) ──

interface AdvisorRespLite {
  brief?: string;
  responseType?: string;
  options?: unknown[];
}
interface GroupRespLite {
  responses?: Array<{ from: string; brief: string }>;
  data?: AdvisorRespLite;
}

const PUNT_MARKERS = ["看您", "由您定", "您来定", "请您决断", "您定夺", "听您的", "请指示"];

// Concrete unit handles in the crisis fixtures (either script — the model
// voices "Carter" and "卡特" interchangeably).
const UNIT_NAMES = ["Blake", "Carter", "Aiden", "T5", "I2", "I1", "布雷克", "卡特", "艾登"];

function isPunt(text: string): boolean {
  return PUNT_MARKERS.some((m) => text.includes(m));
}
/** First two sentences — the delivery window for the asked-for unknown.
 *  ("长官，北线撑不过三秒。卡特最近，65秒能到。" delivers the who in sentence
 *  two behind a natural situational lead-in; buried-at-the-end doesn't count.) */
function deliveryWindow(text: string): string {
  return text.split(/[。！？!?\n]/).slice(0, 2).join("。");
}
function namesAUnit(text: string): boolean {
  return UNIT_NAMES.some((n) => text.includes(n));
}
function hasDigit(text: string): boolean {
  // Engine numbers may be voiced in Chinese numerals ("约三秒"/"六十五秒") —
  // both count as citing a number.
  return /[0-9〇零一二三四五六七八九十百千]/.test(text);
}
function namesAFront(text: string): boolean {
  return text.includes("北") || text.includes("山脊") || text.includes("沿海") || text.includes("中央");
}

async function runReal(): Promise<void> {
  const cmdUrl = process.env.COMMAND_URL ?? "http://localhost:3002/api/command";
  const groupUrl = cmdUrl.replace("/api/command", "/api/command-group");
  console.log(`== commander-presence Step A real-model fixtures (${cmdUrl}) ==`);

  const crisis = twoFrontCrisis();
  const crisisDigestV1 = buildDigest(crisis, [], [], []);
  const crisisCtxV2 = buildBattleContextV2(crisis, "ops", { playerIntent: "", openCommitments: [] });

  const healthy = emptyBattlefield();
  healthy.time = 120;
  const hp1 = addUnit(healthy, COASTAL.x, COASTAL.y);
  addSquad(healthy, [hp1.id], { id: "I1", leaderName: "Aiden" });
  const healthyDigestV1 = buildDigest(healthy, [], [], []);

  const QUESTION = "北线和山脊线都吃紧，先救哪条？";
  const style = "risk=0.50 focus=0.50 obj=0.50 cas=0.50";

  const ask = async (digest: string, message: string, channel: string): Promise<AdvisorRespLite> => {
    const res = await fetch(cmdUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ digest, message, styleNote: style, channel, sessionId: "ab-presence" }),
    });
    return (await res.json()) as AdvisorRespLite;
  };
  const askGroup = async (digest: string, message: string): Promise<GroupRespLite> => {
    const res = await fetch(groupUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ digest, message, styleNote: style, sessionId: "ab-presence" }),
    });
    return (await res.json()) as GroupRespLite;
  };

  // 1) Chen (combat, DigestV1): must take a side with numbers, no punting, no intents.
  for (let i = 1; i <= 3; i++) {
    const r = await ask(crisisDigestV1, QUESTION, "combat");
    const brief = r.brief ?? "";
    const noExec = (r.options ?? []).length === 0;
    check(
      `R1.${i} chen picks a side w/ numbers`,
      noExec && hasDigit(brief) && namesAFront(brief) && !isPunt(brief),
      brief.slice(0, 160),
    );
    console.log(`   [chen #${i}] ${brief}`);
  }

  // 2) Marcus (ops, BattleContextV2): same contract.
  for (let i = 1; i <= 3; i++) {
    const r = await ask(crisisCtxV2, QUESTION, "ops");
    const brief = r.brief ?? "";
    const noExec = (r.options ?? []).length === 0;
    check(
      `R2.${i} marcus picks a side w/ numbers`,
      noExec && hasDigit(brief) && namesAFront(brief) && !isPunt(brief),
      brief.slice(0, 160),
    );
    console.log(`   [marcus #${i}] ${brief}`);
  }

  // 3) Healthy battlefield, same question: honest non-alarm (no exec, logged for
  //    the human read; hard assert = no intents, no punting).
  for (let i = 1; i <= 2; i++) {
    const r = await ask(healthyDigestV1, QUESTION, "combat");
    const brief = r.brief ?? "";
    check(`R3.${i} healthy → no exec, no punt`, (r.options ?? []).length === 0 && !isPunt(brief), brief.slice(0, 160));
    console.log(`   [healthy #${i}] ${brief}`);
  }

  // 4) Group war room: domain officer answers with numbers; banding logged
  //    (one may run long; interjections stay short).
  for (let i = 1; i <= 3; i++) {
    const g = await askGroup(crisisDigestV1, QUESTION);
    const responses = g.responses ?? [];
    const combined = responses.map((r) => r.brief).join(" ");
    check(
      `R4.${i} group answers w/ numbers, no punt`,
      responses.length > 0 && hasDigit(combined) && namesAFront(combined) && !isPunt(combined),
      combined.slice(0, 160),
    );
    for (const r of responses) {
      console.log(`   [group #${i} ${r.from} len=${r.brief.length}] ${r.brief}`);
    }
  }

  // 5) Deliver-the-unknown (handtest fix): "who do I send" must be answered
  //    with a concrete unit handle IN THE FIRST SENTENCE — numbers follow as
  //    evidence, never substitute for the asked-for unknown.
  for (let i = 1; i <= 3; i++) {
    const r = await ask(crisisDigestV1, "派谁去增援北部前线？", "combat");
    const brief = r.brief ?? "";
    const window = deliveryWindow(brief);
    check(
      `R5.${i} who-question → unit name delivered up front`,
      namesAUnit(window) && !isPunt(brief),
      `window="${window}" full=${brief.slice(0, 140)}`,
    );
    console.log(`   [who #${i}] ${brief}`);
  }

  // 6) Asymmetric frame (handtest shape): one front pressured, one FALLEN
  //    (no-force note on the wire). The answer must still take a stance and
  //    may cite the rebuild-from-rear fact; hard assert = stance + number.
  {
    const asym = northCrisisCenterEmpty();
    const asymDigest = buildDigest(asym, [], [], []);
    for (let i = 1; i <= 2; i++) {
      const r = await ask(asymDigest, "北线吃紧，中央又丢了，先顾哪头？", "combat");
      const brief = r.brief ?? "";
      check(
        `R6.${i} asymmetric → stance w/ numbers, no punt`,
        (r.options ?? []).length === 0 && hasDigit(brief) && namesAFront(brief) && !isPunt(brief),
        brief.slice(0, 160),
      );
      console.log(`   [asym #${i}] ${brief}`);
    }
  }

  // 7) Fogged brawl (handtest round-2 shape): north fighting under fog,
  //    central in a visible crisis. The previously-vanishing front must now
  //    be part of the comparison — the answer has to name it.
  {
    const s = foggedBrawl();
    // central front, exclusive point (outside minefield/ruweisat/axis_rear):
    // committed defenders + visible enemies → a REAL numeric line coexists
    // with the north's engaged-unknown line.
    const d1 = addUnit(s, 200, 130, { hp: 60 });
    const d2 = addUnit(s, 202, 130, { hp: 60 });
    addSquad(s, [d1.id, d2.id], { id: "I2", leaderName: "Carter" });
    for (let i = 0; i < 4; i++) {
      const e = addUnit(s, 204 + i, 132, { team: "enemy" } as Partial<Unit>);
      reveal(s, e.position.x, e.position.y);
    }
    const digest = buildDigest(s, [], [], []);
    for (let i = 1; i <= 2; i++) {
      const r = await ask(digest, "先救哪条线？", "combat");
      const brief = r.brief ?? "";
      check(
        `R7.${i} fogged front stays in the comparison`,
        (r.options ?? []).length === 0 && hasDigit(brief) && brief.includes("北") && !isPunt(brief),
        brief.slice(0, 160),
      );
      console.log(`   [fog #${i}] ${brief}`);
    }
  }

  // 8) Casual status question (handtest round-3 ★): "情况怎么样" was eaten by
  //    the greeting register 3/3. The exact failing utterance, crisis state:
  //    must get a real sitrep answer, never a 1-3字 greeting reply.
  for (let i = 1; i <= 3; i++) {
    const r = await ask(crisisDigestV1, "现在情况怎么样？", "combat");
    const brief = r.brief ?? "";
    check(
      `R8.${i} casual status question gets a real answer`,
      (r.options ?? []).length === 0 && brief.length >= 15 && hasDigit(brief) && namesAFront(brief),
      brief.slice(0, 160),
    );
    console.log(`   [casual #${i}] ${brief}`);
  }

  // 9) Counter-guard: a TRUE greeting must stay a short greeting — the
  //    boundary line must not kill the register the other way.
  {
    const rc = await ask(crisisDigestV1, "你好", "combat");
    const bc = rc.brief ?? "";
    check("R9.1 chen greeting stays short", bc.length <= 12 && !/\d/.test(bc), bc);
    console.log(`   [greet chen] ${bc}`);
    const rm = await ask(crisisCtxV2, "你好", "ops");
    const bm = rm.brief ?? "";
    check("R9.2 marcus greeting stays short", bm.length <= 12 && !/\d/.test(bm), bm);
    console.log(`   [greet marcus] ${bm}`);
  }

  // 10) Stale-snapshot precedence (handtest round-3 followup): the envelope
  //     carries BOTH an old escalation question (ask-time numbers) and the
  //     current FRONT_JUDGMENT frame. Recital must use the frame's current
  //     values, never the snapshot's. Frame truth here: coastal survival≈3s
  //     ratio=0.33; the fake snapshot deliberately contradicts (10秒/0.88).
  {
    const staleBlock =
      `\n---ACTIVE_ESCALATION---\n参谋刚问:「北部战线我方单位仅能支撑10秒，当前战力比0.88。Blake部队可在999秒内抵达，是否调动？」\n指挥官下面这句是对它的回应。`;
    for (let i = 1; i <= 2; i++) {
      const r = await ask(crisisDigestV1 + staleBlock, "现在情况怎么样？", "combat");
      const brief = r.brief ?? "";
      const usesCurrent = brief.includes("3秒") || brief.includes("三秒");
      const usesStale = brief.includes("10秒") || brief.includes("十秒") || brief.includes("0.88") || brief.includes("999");
      check(
        `R10.${i} current frame beats ask-time snapshot`,
        usesCurrent && !usesStale,
        brief.slice(0, 160),
      );
      console.log(`   [stale #${i}] ${brief}`);
    }
  }

  // 11) Numberless-row precedence, no-force branch (round-4 live failure: a
  //     fallen front's stale snapshot numbers were recited as current —
  //     "全灭" reported as "还能撑1秒"). Frame truth: 中央 has NO force; the
  //     fake snapshot claims impossible numbers for it.
  {
    const asym = northCrisisCenterEmpty();
    const asymDigest = buildDigest(asym, [], [], []);
    const staleCentral =
      `\n---ACTIVE_ESCALATION---\n参谋刚问:「中央战线我方单位仅能支撑7秒，敌我战力比1:9。Blake部队可在999秒内抵达，是否调动？」\n指挥官下面这句是对它的回应。`;
    for (let i = 1; i <= 2; i++) {
      const r = await ask(asymDigest + staleCentral, "中央那边现在到底什么情况？", "combat");
      const brief = r.brief ?? "";
      const saysNoForce = /无|没/.test(brief) && /部队|兵力|人/.test(brief);
      const usesStale = brief.includes("7秒") || brief.includes("七秒") || brief.includes("1:9") || brief.includes("999");
      check(`R11.${i} fallen front: no-force beats stale snapshot`, saysNoForce && !usesStale, brief.slice(0, 160));
      console.log(`   [void #${i}] ${brief}`);
    }
  }

  // 12) Numberless-row precedence, engaged-unknown branch: fogged brawl has no
  //     survival/ratio; a stale snapshot offering them must not be recited —
  //     the honest answer conveys "can't estimate" plus own-strength facts.
  {
    const fog = foggedBrawl();
    const fogDigest = buildDigest(fog, [], [], []);
    const staleNorth =
      `\n---ACTIVE_ESCALATION---\n参谋刚问:「北部战线我方单位仅能支撑8秒，敌我战力比1:6，是否后撤？」\n指挥官下面这句是对它的回应。`;
    for (let i = 1; i <= 2; i++) {
      const r = await ask(fogDigest + staleNorth, "北线现在到底什么情况？", "combat");
      const brief = r.brief ?? "";
      const conveysUnknown = /不明|未明|无法/.test(brief);
      const usesStale = brief.includes("8秒") || brief.includes("八秒") || brief.includes("1:6");
      check(`R12.${i} fogged front: unknown beats stale snapshot`, conveysUnknown && !usesStale, brief.slice(0, 160));
      console.log(`   [fogvoid #${i}] ${brief}`);
    }
  }

  // ⑦ 口径（audit 2026-07-27）：语域的唯一有效量法＝同信封 ± mood 行对照
  //    （R15），不比 calm——R13/R14 两边信封内容不同，长度差被内容差污染，
  //    只作 smoke 探针。达标＝同内容更短；基线 A=73.0/76.3 vs B=97.5/93.0。
  // ⑤ 收口判据（结构尺，audit 2026-07-27）：平稳断言必须在同一口气里带
  //    限定（让步/条件附着在断言上，或点名受威胁战线危险）——用手读判，
  //    永不写成正则硬断言：calm/hedge 词表在两个方向都骗过我们（漏判
  //    隐患/隐忧/亟需、误判"无关键风险点"），关键词穷举不收敛（家法）。
  //    结构尺三组：修前 15/20 裸、无守则对照 6/20、修后 9/30＝对照持平。
  //    原始采样档：~/MyProjects/_archive/presence-step-b-audit-20260727/
  // 13) Step B register probe: the SAME question against a calm envelope (no
  //     mood line) vs a critical one (mood: critical + seconds). Hard asserts
  //     stay mechanical (no exec / no punt / critical cites digits); the
  //     register contrast itself is a HUMAN read — lengths logged so the
  //     judgment is recordable in the run output.
  {
    const critDigest = buildDigest(crisisEngaged(), [], [], []);
    const REGISTER_Q = "现在情况怎么样？";
    for (let i = 1; i <= 3; i++) {
      const r = await ask(healthyDigestV1, REGISTER_Q, "combat");
      const brief = r.brief ?? "";
      check(`R13.${i} calm register: no exec, no punt`, (r.options ?? []).length === 0 && !isPunt(brief), brief.slice(0, 160));
      console.log(`   [mood-calm #${i} len=${brief.length}] ${brief}`);
    }
    for (let i = 1; i <= 3; i++) {
      const r = await ask(critDigest, REGISTER_Q, "combat");
      const brief = r.brief ?? "";
      check(
        `R14.${i} critical register: no exec, cites digits, no punt`,
        (r.options ?? []).length === 0 && hasDigit(brief) && !isPunt(brief),
        brief.slice(0, 160),
      );
      console.log(`   [mood-critical #${i} len=${brief.length}] ${brief}`);
    }
  }

  // 15) ⑦ same-envelope ablation — the valid register measure: ONE critical
  //     envelope, arm A as production builds it, arm B byte-identical except
  //     the mood line is deleted. Only hard assert: mean(A) < mean(B) (同内容
  //     更短). Lengths + full text logged for the human read.
  {
    const s = crisisEngaged();
    const ctx = buildBattleContextV2(s, "ops", { playerIntent: "", openCommitments: [] });
    const moodLine = buildCommanderMoodLine(s);
    const without = ctx.split("\n").filter((l) => !l.startsWith("mood: ")).join("\n");
    const lens: { A: number[]; B: number[] } = { A: [], B: [] };
    for (const [armName, digest] of [["A", ctx], ["B", without]] as ["A" | "B", string][]) {
      for (let i = 1; i <= 4; i++) {
        const r = await ask(digest, "现在情况怎么样？", "ops");
        const brief = r.brief ?? "";
        lens[armName].push(brief.length);
        console.log(`   [ablate-${armName} #${i} len=${brief.length}] ${brief}`);
      }
    }
    const mean = (a: number[]): number => a.reduce((x, y) => x + y, 0) / a.length;
    check(
      "R15 same-envelope ablation: mood line compresses (mean A < mean B)",
      moodLine !== null && mean(lens.A) < mean(lens.B),
      `A=${mean(lens.A).toFixed(1)} B=${mean(lens.B).toFixed(1)} line=${moodLine ?? "null"}`,
    );
  }

  // ── Step C: PLAYER_VIEW spatial-deixis probes ──
  // 判据是【手读】(家法: Step B's keyword regex judged prose wrongly in BOTH
  // directions — word lists are banned as acceptance criteria). Hard asserts
  // below are mechanical only (a reply exists; the stage resolves a name);
  // full transcripts print for the human read + the audit archive.
  {
    console.log("\n== Step C PLAYER_VIEW probes (transcripts = HUMAN READ) ==");

    // Deixis stage: ONE fight, placed at a point the shared resolver can NAME,
    // camera aimed straight at it. Hunt inside the coastal bbox — honest
    // failure if the map offers no named point there.
    const stage = emptyBattlefield();
    stage.time = 240;
    let aim: { x: number; y: number } | null = null;
    for (let y = 24; y <= 53 && !aim; y += 3) {
      for (let x = 205; x <= 485 && !aim; x += 5) {
        if (placeNameAt(stage, { x, y }) !== null) aim = { x, y };
      }
    }
    if (!aim) throw new Error("no named point inside coastal bbox — fixture impossible");
    const aimName = placeNameAt(stage, aim)!;
    const d1 = addUnit(stage, aim.x - 2, aim.y, { hp: 70, lastDamagedAt: stage.time - 2 } as Partial<Unit>);
    const d2 = addUnit(stage, aim.x - 1, aim.y, { hp: 80 });
    addSquad(stage, [d1.id, d2.id], { id: "I1", leaderName: "Aiden" });
    for (let i = 0; i < 4; i++) {
      const e = addUnit(stage, aim.x + 2 + i, aim.y + 1, { team: "enemy" } as Partial<Unit>);
      reveal(stage, e.position.x, e.position.y);
    }
    const f1 = addUnit(stage, 300, 150);
    const f2 = addUnit(stage, 302, 150);
    addSquad(stage, [f1.id, f2.id], { id: "T5", leaderName: "Blake" });

    const stageDigest = buildDigest(stage, [], [], []);
    // Same assembly shape as ChatPanel: envelope + "\n" + section lines.
    const stageView: ViewportGeometry = { x: (aim.x - 10) * 32, y: (aim.y - 7) * 32, zoom: 1, canvasWidth: 20 * 32, canvasHeight: 14 * 32 };
    const pvLines = buildPlayerViewLines(stage, stageView, []);
    check("S0 stage: 镜头对准 resolves", pvLines.some((l) => l === `镜头对准: ${aimName}`), pvLines.join(" | "));
    const pv = `\n${pvLines.join("\n")}`;
    console.log(`   [stage] aim=${aimName}@(${aim.x},${aim.y})`);
    for (const l of pvLines) console.log(`   [pv] ${l}`);

    // Five phrasings (Step B lesson: acceptance on ONE phrasing hid a 5/5
    // hole) — status, ownership, holdability, an order with a bare pronoun,
    // and a consultative ask.
    const DEIXIS_QS: Array<[string, string, number]> = [
      ["S1", "这边怎么样？", 3],
      ["S2", "那儿是谁的？", 2],
      ["S3", "这块守得住吗？", 2],
      ["S4", "把他们撤回来", 2],
      ["S5", "你觉得这边需要加把手吗？", 2],
    ];
    for (const [tag, q, n] of DEIXIS_QS) {
      for (let i = 1; i <= n; i++) {
        const r = await ask(stageDigest + pv, q, "combat");
        const brief = r.brief ?? "";
        check(`${tag}.${i} deixis reply exists`, brief.length > 0, JSON.stringify(r).slice(0, 120));
        console.log(`   [${tag}.${i} "${q}" opts=${(r.options ?? []).length}] ${brief}`);
      }
    }

    // Hijack guard: camera parked on the COASTAL fight while the DIALOGUE is
    // about the ridge — "他们" must bind to the conversation (Carter/ridge),
    // not the lens. Context block precedes PLAYER_VIEW, same order ChatPanel
    // assembles them. ×3, human-read.
    const hj = twoFrontCrisis();
    const hjDigest = buildDigest(hj, [], [], []);
    const hjView: ViewportGeometry = { x: (COASTAL.x - 10) * 32, y: (COASTAL.y - 7) * 32, zoom: 1, canvasWidth: 20 * 32, canvasHeight: 14 * 32 };
    const hjPvLines = buildPlayerViewLines(hj, hjView, []);
    const hjPv = hjPvLines.length > 0 ? `\n${hjPvLines.join("\n")}` : "";
    console.log(`   [hijack stage] camera=北线coastal, dialogue=山脊线`);
    for (const l of hjPvLines) console.log(`   [hj pv] ${l}`);
    const ridgeCtx = `\n---CONTEXT---\n[指挥官] 山脊线现在什么情况？\n[参谋] 山脊线交战中，Carter的I2分队两个单位在顶，对面兵力相近。\n`;
    for (let i = 1; i <= 3; i++) {
      const r = await ask(hjDigest + ridgeCtx + hjPv, "他们还顶得住吗？", "combat");
      const brief = r.brief ?? "";
      check(`S6.${i} hijack-guard reply exists`, brief.length > 0, JSON.stringify(r).slice(0, 120));
      console.log(`   [S6.${i}] ${brief}`);
    }
  }

  console.log(failCount === 0 ? "\nREAL-MODEL GATE PASS" : `\nREAL-MODEL FAILURES: ${failCount}`);
  process.exit(failCount === 0 ? 0 : 1);
}

// ── Entry ──

const mode = process.argv[2];
if (mode === "--synthetic") runSynthetic();
else if (mode === "--real") void runReal();
else {
  console.log("usage: tsx scripts/ab-commander-presence.ts --synthetic | --real");
  process.exit(2);
}
