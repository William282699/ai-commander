// ============================================================
// AI Commander — El Alamein Pressure Director (Step 5C-lite, V3 expanded)
//
// Scripted P4 pressure module that runs PARALLEL to defensiveAI, plus a
// strategic-phase config table that defensiveAI imports to gate its own
// P1/P2/P3 stages.
//
// Coordination with defensiveAI:
//   - P4 wave logic still talks to defensiveAI ONLY via unit.state (no shared
//     module Sets, no module-state read across files).
//   - V3 adds a SECOND coupling channel: defensiveAI imports PHASE_STRATEGY
//     (const table) and getCurrentStrategicPhase (pure function). This is
//     CONST + PURE FUNCTION coupling, not state coupling — defensiveAI
//     reads the config to derive its grace/cap/cooldown, but never reads
//     pressureDirector's internal module state.
//
// Mini-helpers (isVisibleToEnemyMini / pushDiagnostic) remain copied in-file
// to keep P4 wave logic self-contained.
//
// Deletion path (V3, 4-step):
//   1) delete this file
//   2) delete export line in core/src/index.ts
//   3) delete tick + reset + import + diag-suppress lines in GameCanvas.tsx
//   4) defensiveAI.ts: revert the import + helper + per-stage `cfg.*` reads
//      back to hardcoded baseline (grace 60, P2_COMMIT_RATIO 0.75, etc.) —
//      see STEP_5C_LITE_V3_WORKPLAN.md § 10.2 for the exact mechanical
//      search-and-replace.
//
// Scenario-gated: P4 wave logic is no-op outside el_alamein.
// PHASE_STRATEGY exposes a "legacy" key so non-El-Alamein scenarios
// (dual_island etc.) get the original defensiveAI baseline unchanged.
// ============================================================
//
// NOTE: Order schema does not let "high"/"medium"/"low" express anything stronger
// than urgency relative to other queued orders. Drift between P4 intent and what
// defensiveAI/autoBehavior do with the unit is detected per-tick via u.target
// comparison (see reissueClaimedUnits) — not via order priority.

import type {
  GameState, Unit, Position, Order, UnitType,
} from "@ai-commander/shared";
import { getUnitCategory, UNIT_STATS } from "@ai-commander/shared";

import { type FormationStyle, getFormationOffset, computeHeading } from "../../formation";
import { applyEnemyOrders } from "../../applyOrders";
import { enqueueProduction } from "../../economy";

// ── Strategic Phase Director (V3) ──
//
// Centralized strategic timing logic. defensiveAI imports PHASE_STRATEGY +
// getCurrentStrategicPhase to gate P1/P2/P3 stage decisions. This keeps the
// "director" role in pressureDirector and lets defensiveAI stay an executor
// without growing its own time-phase logic.
//
// import-only coupling: defensiveAI imports the CONST table and the PURE
// FUNCTION, not module state. No shared mutable Set / Map. Coordination
// layer at runtime is still unit.state.

export type StrategicPhase =
  | "observation"       // 0-180s: 展开试探 (El Alamein only)
  | "multi_line"        // 180-720s: 多线压力 (主体, El Alamein only)
  | "counter_attack"    // 720-1320s: 反扑拉扯 (El Alamein only)
  | "endgame_offense"   // 1320s+, score > 0 (玩家领先): 总攻挽回 (El Alamein only)
  | "endgame_defense"   // 1320s+, score ≤ 0 (敌方持平/领先): 总防/拖时间 (El Alamein only)
  | "legacy";           // 非 El Alamein scenario (dual_island 等): 原 defensiveAI baseline 行为

export interface PhaseConfig {
  /** P1 opportunistic attack: 不早于这个绝对游戏时间 fire (9999 = effectively disabled) */
  p1Grace: number;
  /** P2 massed offensive: 不早于这个绝对游戏时间 fire (9999 = effectively disabled) */
  p2Grace: number;
  /** P3 probe: 不早于这个绝对游戏时间 fire (9999 = effectively disabled) */
  p3Grace: number;
  /** P2 commit ratio: pool 抽多少比例 (0..1) */
  p2CommitRatio: number;
  /** P2 cooldown between waves (seconds) */
  p2CooldownSec: number;
  /** P3 probe wave max unit count (0 = explicitly disable probe) */
  p3MaxUnits: number;
  /** P1 opportunistic attack wave max unit count (replaces hardcoded P2_MAX_ATTACK=8) */
  p1MaxAttack: number;
}

export const PHASE_STRATEGY: Record<StrategicPhase, PhaseConfig> = {
  // 0-180s: P0 reactive only; P1/P2/P3 disabled. P4 wave 1 fires at 90s.
  observation:     { p1Grace: 9999, p2Grace: 9999, p3Grace: 9999, p2CommitRatio: 0,    p2CooldownSec: 9999, p3MaxUnits: 0, p1MaxAttack: 0 },
  // 180-720s: P1 opportunistic + P3 probe + P4 wave; P2 disabled (still building intel).
  multi_line:      { p1Grace: 180,  p2Grace: 9999, p3Grace: 120,  p2CommitRatio: 0,    p2CooldownSec: 9999, p3MaxUnits: 4, p1MaxAttack: 5 },
  // 720-1320s: P2 medium counter-offensive joins; ~16 unit / 2 min cadence.
  counter_attack:  { p1Grace: 0,    p2Grace: 720,  p3Grace: 0,    p2CommitRatio: 0.4,  p2CooldownSec: 120,  p3MaxUnits: 4, p1MaxAttack: 5 },
  // 1320s+ AND score > 0 (player ahead): all-in to break tie. HQ assault unlocked.
  endgame_offense: { p1Grace: 0,    p2Grace: 0,    p3Grace: 0,    p2CommitRatio: 0.7,  p2CooldownSec: 60,   p3MaxUnits: 4, p1MaxAttack: 6 },
  // 1320s+ AND score ≤ 0 (enemy tied/ahead): hold and force timeout. P2/P3 disabled.
  endgame_defense: { p1Grace: 0,    p2Grace: 9999, p3Grace: 9999, p2CommitRatio: 0.15, p2CooldownSec: 240,  p3MaxUnits: 0, p1MaxAttack: 4 },
  // Non-El-Alamein scenarios. Mirrors original hardcoded defensiveAI baseline 1:1:
  //   p1Grace=60          ← opportunisticAttack `state.time < 60`
  //   p2Grace=60          ← massedOffensive `state.time < 60`
  //   p3Grace=60          ← original PROBE_START_TIME
  //   p2CommitRatio=0.75  ← original P2_COMMIT_RATIO
  //   p2CooldownSec=50    ← original P2_COOLDOWN_SEC
  //   p3MaxUnits=6        ← original PROBE_MAX_UNITS
  //   p1MaxAttack=8       ← original P2_MAX_ATTACK (was reused as P1 cap)
  legacy:          { p1Grace: 60,   p2Grace: 60,   p3Grace: 60,   p2CommitRatio: 0.75, p2CooldownSec: 50,   p3MaxUnits: 6, p1MaxAttack: 8 },
};

/**
 * Pure function: computes current strategic phase from game state.
 * No module-level state read. Idempotent. Safe to call multiple times per tick.
 *
 * El Alamein: 4-stage time gate + score-aware endgame split.
 * Other scenarios: returns "legacy" (config mirrors original baseline 1:1).
 *
 * score = capturedAxisObjectives - lostPlayerForwardPosts (player's perspective,
 * matches warPhase.endGameWithRating). From enemy AI viewpoint:
 *   score > 0  = player winning  → enemy BEHIND  → "总攻" to break it
 *   score ≤ 0  = enemy tied/ahead → enemy holds advantage → "总防" to force timeout
 */
export function getCurrentStrategicPhase(state: GameState): StrategicPhase {
  if (state.scenarioId !== "el_alamein") return "legacy";
  if (!state.scenarioWinConfig) return "legacy";

  const t = state.time;
  if (t < 180) return "observation";
  if (t < 720) return "multi_line";
  if (t < 1320) return "counter_attack";

  const captured = (state.captureObjectives ?? [])
    .filter((id) => state.facilities.get(id)?.team === "player").length;
  const lost = state.scenarioWinConfig.friendlyKeypoints.filter((id) => {
    const f = state.facilities.get(id);
    return !f || f.hp <= 0 || f.team !== "player";
  }).length;
  const score = captured - lost;

  return score > 0 ? "endgame_offense" : "endgame_defense";
}

// ── Cadence ──
const DIRECTOR_INTERVAL_SEC = 5.0;
const P4_GRACE_PERIOD_SEC = 90;
const P4_BASE_COOLDOWN_EASY = 140;
const P4_BASE_COOLDOWN_MID = 120;
const P4_BASE_COOLDOWN_HARD = 100;
const P4_JITTER_SEC = 20;
const P4_PHASE_BREAKPOINTS = { easyEnd: 480, midEnd: 1080 };   // 8 min / 18 min
const P4_MIN_POOL_TO_FIRE = 4;
const P4_TARGET_HISTORY_SIZE = 3;
const P4_HISTORY_PENALTY = -25;
// History entries decay after this window. Prevents permanent stall when player
// garrisons all 3 forward posts heavily: raid scores would be 20 + 0 defense - 25
// history = -5 for every target, candidates array empties, history never updates
// (only updates on successful fire) → P4 silenced forever. The window lets the
// oldest entry expire ~once per (easy phase) cooldown so the cycle resumes.
const P4_HISTORY_PENALTY_WINDOW_SEC = 360;

// ── Wave sizing per phase × kind ──
type PressurePhase = "easy" | "mid" | "hard";
type SizeBucket = "probe" | "recapture" | "raid" | "finish_post";
const P4_WAVE_SIZE: Record<PressurePhase, Record<SizeBucket, [number, number]>> = {
  easy: { probe: [4, 5], recapture: [5, 7],  raid: [4, 5],  finish_post: [4, 6] },
  mid:  { probe: [5, 6], recapture: [7, 10], raid: [6, 9],  finish_post: [6, 8] },
  hard: { probe: [6, 7], recapture: [8, 12], raid: [8, 10], finish_post: [7, 10] },
};

// ── Garrison protection / claim management ──
const MIN_GARRISON_ON_CAPTURED_POST = 2;
const CAPTURED_POST_GARRISON_RADIUS = 8;
const GARRISON_EXCLUSION_RADIUS = 15;          // Axis objectives
const HQ_EXCLUSION_RADIUS = 20;                // Axis HQ
const ARRIVAL_RADIUS = 12;                     // claim release when at target
const LOW_HP_RETREAT_RATIO = 0.30;             // release claim if damaged
const DRIFT_RELEASE_TILES_SQ = 8 * 8;          // > 8 tiles drift → release claim

// ── Production boost ──
const PRODUCTION_BOOST_COOLDOWN_SEC = 30;
const MAX_DIAGNOSTICS = 200;

// ── Module state (never exported) ──
let p4Timer = 0;
let p4CooldownUntil = 0;
let p4WaveCount = 0;

const p4ClaimedIds = new Set<number>();
const p4AttackerTargets = new Map<number, Position>();

type PressureKind = "recapture" | "finish_post" | "raid";

interface TargetHistoryEntry {
  targetId: string;
  firedAt: number;
  kind: PressureKind;
}
const p4TargetHistory: TargetHistoryEntry[] = [];

let lastBoostAt = -Infinity;

interface PressureCandidate {
  targetId: string;
  position: Position;
  kind: PressureKind;
  score: number;
}

// ── Public API ──

/**
 * Reset module-level timers + tracking sets. Must be called on new game session,
 * alongside resetDefensiveAITimer / resetEnemyAITimer / etc.
 */
export function resetPressureDirector(): void {
  p4Timer = 0;
  p4CooldownUntil = 0;
  p4WaveCount = 0;
  p4ClaimedIds.clear();
  p4AttackerTargets.clear();
  p4TargetHistory.length = 0;
  lastBoostAt = -Infinity;
}

/**
 * Process the El Alamein 5C-lite scripted pressure director.
 * Runs every DIRECTOR_INTERVAL_SEC (5s) via while-loop drift guard.
 * Fires at most one P4 pressure wave per cooldown window (100-140s, phase-jittered).
 */
export function processPressureDirector(state: GameState, dt: number): void {
  if (state.scenarioId !== "el_alamein") return;
  if (!state.scenarioWinConfig) return;
  if (state.gameOver) return;

  p4Timer += dt;
  while (p4Timer >= DIRECTOR_INTERVAL_SEC) {
    p4Timer -= DIRECTOR_INTERVAL_SEC;
    runPressureDirector(state);
  }
}

// ── Main loop ──

function runPressureDirector(state: GameState): void {
  // Per-tick maintenance on already-dispatched P4 units (drift / arrival / death).
  reissueClaimedUnits(state);

  // Grace + cooldown gates.
  if (state.time < P4_GRACE_PERIOD_SEC) return;
  if (state.time < p4CooldownUntil) return;

  const candidates = buildPressureTargets(state);
  if (candidates.length === 0) return;

  // Deterministic tie-break: score desc, then targetId asc.
  candidates.sort((a, b) => (b.score - a.score) || a.targetId.localeCompare(b.targetId));
  const best = candidates[0];
  if (best.score <= 0) return;

  const phase = getPressurePhase(state);
  const waveSize = pickWaveSize(state, phase, best.kind);
  const pool = gatherPressurePool(state, best.position, waveSize);

  if (pool.length < P4_MIN_POOL_TO_FIRE) {
    boostEnemyProduction(state);
    // Re-check after production has time to deliver.
    p4CooldownUntil = state.time + 30;
    pushDiagnostic(state,
      `P4 hold target=${best.targetId} kind=${best.kind} pool=${pool.length}<${P4_MIN_POOL_TO_FIRE} phase=${phase}`);
    return;
  }

  const formation = pickFormation(best.kind, phase);
  const applied = dispatchWithFormation(state, pool, best.position, formation, "high");

  if (applied > 0) {
    // FIFO history, capped.
    p4TargetHistory.push({ targetId: best.targetId, firedAt: state.time, kind: best.kind });
    if (p4TargetHistory.length > P4_TARGET_HISTORY_SIZE) {
      p4TargetHistory.splice(0, p4TargetHistory.length - P4_TARGET_HISTORY_SIZE);
    }
    p4CooldownUntil = state.time + pickCooldown(phase);
    p4WaveCount += 1;
    pushDiagnostic(state,
      `P4 fire #${p4WaveCount} target=${best.targetId} kind=${best.kind} form=${formation} size=${applied}/${pool.length} score=${best.score} phase=${phase}`);
  } else {
    // Pool gathered but applyEnemyOrders rejected everyone — short retry.
    p4CooldownUntil = state.time + 15;
    pushDiagnostic(state,
      `P4 misfire target=${best.targetId} pool=${pool.length} applied=0`);
  }
}

// ── Phase / cadence / formation pickers ──

function getPressurePhase(state: GameState): PressurePhase {
  if (state.time < P4_PHASE_BREAKPOINTS.easyEnd) return "easy";
  if (state.time < P4_PHASE_BREAKPOINTS.midEnd) return "mid";
  return "hard";
}

function pickCooldown(phase: PressurePhase): number {
  const base = phase === "easy" ? P4_BASE_COOLDOWN_EASY
             : phase === "mid"  ? P4_BASE_COOLDOWN_MID
             :                    P4_BASE_COOLDOWN_HARD;
  const jitter = (Math.random() - 0.5) * 2 * P4_JITTER_SEC;
  return base + jitter;
}

function pickWaveSize(state: GameState, phase: PressurePhase, kind: PressureKind): number {
  const sizeBucket: SizeBucket =
    kind === "recapture"   ? "recapture" :
    kind === "finish_post" ? "finish_post" :
    state.time < P4_GRACE_PERIOD_SEC + 60 ? "probe" :
    "raid";
  const [min, max] = P4_WAVE_SIZE[phase][sizeBucket];
  return min + Math.floor(Math.random() * (max - min + 1));
}

function pickFormation(kind: PressureKind, phase: PressurePhase): FormationStyle {
  if (kind === "recapture") return phase === "hard" ? "encircle" : "wedge";
  if (kind === "finish_post") return "line";
  return phase === "easy" ? "column" : "wedge";
}

// ── Target scoring ──

function buildPressureTargets(state: GameState): PressureCandidate[] {
  const winCfg = state.scenarioWinConfig!;
  const out: PressureCandidate[] = [];

  // (A) Recapture: Axis objectives held by / being captured by player.
  for (const objId of state.captureObjectives ?? []) {
    const f = state.facilities.get(objId);
    if (!f || f.hp <= 0) continue;
    let s = 0;
    if (f.team === "player") s += 100;
    else if (f.team === "enemy" && f.capturingTeam === "player") s += 70;
    else continue;
    s += historyPenalty(state, objId, "recapture");  // exempt → 0
    out.push({ targetId: objId, position: { ...f.position }, kind: "recapture", score: s });
  }

  // (B) Finish weak player forward post (hp < 50% OR currently being captured by enemy).
  for (const kpId of winCfg.friendlyKeypoints) {
    const f = state.facilities.get(kpId);
    if (!f || f.team !== "player" || f.hp <= 0) continue;
    const hpRatio = f.hp / f.maxHp;
    let s = 0;
    if (hpRatio < 0.5) s += 60;
    if (f.capturingTeam === "enemy") s += 60;
    if (hasActiveEnemyAttackersNear(state, f.position, 18)) s += 25;
    s += scoreLocalPlayerDefense(state, f.position, 18);
    s += historyPenalty(state, kpId, "finish_post", hpRatio);
    if (s > 0) out.push({ targetId: kpId, position: { ...f.position }, kind: "finish_post", score: s });
  }

  // (C) Raid healthy post — only if no recapture pending.
  const recaptureExists = out.some(c => c.kind === "recapture");
  if (!recaptureExists) {
    for (const kpId of winCfg.friendlyKeypoints) {
      const f = state.facilities.get(kpId);
      if (!f || f.team !== "player" || f.hp <= 0) continue;
      const hpRatio = f.hp / f.maxHp;
      if (hpRatio < 0.5) continue;   // covered by finish_post above
      let s = 20;
      if (kpId === "ea_player_central_post") s += 5;   // mild central bias
      s += scoreLocalPlayerDefense(state, f.position, 18);
      s += historyPenalty(state, kpId, "raid", hpRatio);
      if (s > 0) out.push({ targetId: kpId, position: { ...f.position }, kind: "raid", score: s });
    }
  }

  return out;
}

function historyPenalty(state: GameState, targetId: string, kind: PressureKind, hpRatio?: number): number {
  if (kind === "recapture") return 0;
  // If post is now weak (<50% HP), repeat-attack penalty is waived — we want to finish it.
  if (hpRatio !== undefined && hpRatio < 0.5) return 0;
  const now = state.time;
  return p4TargetHistory.some(
    h => h.targetId === targetId && (now - h.firedAt) < P4_HISTORY_PENALTY_WINDOW_SEC,
  ) ? P4_HISTORY_PENALTY : 0;
}

function scoreLocalPlayerDefense(state: GameState, pos: Position, radius: number): number {
  let localHp = 0;
  const r2 = radius * radius;
  state.units.forEach(u => {
    if (u.team !== "player" || u.state === "dead") return;
    if (getUnitCategory(u.type) !== "ground") return;
    if (!isVisibleToEnemyMini(state, u.position)) return;
    const dx = u.position.x - pos.x, dy = u.position.y - pos.y;
    if (dx * dx + dy * dy <= r2) localHp += u.hp;
  });
  if (localHp >= 250) return 0;
  if (localHp >= 100) return 20;
  if (localHp >= 30)  return 30;
  return 40;
}

function hasActiveEnemyAttackersNear(state: GameState, pos: Position, radius: number): boolean {
  const r2 = radius * radius;
  // Our own P4 attackers count.
  for (const id of p4ClaimedIds) {
    const u = state.units.get(id);
    if (!u || u.state === "dead") continue;
    const dx = u.position.x - pos.x, dy = u.position.y - pos.y;
    if (dx * dx + dy * dy <= r2) return true;
  }
  // Other enemy units currently engaging nearby (defensiveAI P0-P3 attackers).
  let found = false;
  state.units.forEach(u => {
    if (found) return;
    if (u.team !== "enemy" || u.state === "dead") return;
    if (u.state !== "attacking" && u.state !== "moving") return;
    const dx = u.position.x - pos.x, dy = u.position.y - pos.y;
    if (dx * dx + dy * dy <= r2) found = true;
  });
  return found;
}

// ── Pool gathering with garrison protection ──

function gatherPressurePool(state: GameState, attackTarget: Position, want: number): Unit[] {
  const winCfg = state.scenarioWinConfig!;

  // (1) Captured-player-post protection: maintain min garrison at each.
  const occupiedPosts: { pos: Position; capacity: number; current: number }[] = [];
  for (const kpId of winCfg.friendlyKeypoints) {
    const f = state.facilities.get(kpId);
    if (f && f.team === "enemy") {
      occupiedPosts.push({
        pos: { ...f.position },
        capacity: MIN_GARRISON_ON_CAPTURED_POST,
        current: 0,
      });
    }
  }

  // (2) Axis objective + HQ exclusion zones — never poach from defensiveAI's garrison.
  const axisProtectionZones: { pos: Position; radius: number }[] = [];
  for (const objId of state.captureObjectives ?? []) {
    const f = state.facilities.get(objId);
    if (f && f.team === "enemy") {
      axisProtectionZones.push({ pos: { ...f.position }, radius: GARRISON_EXCLUSION_RADIUS });
    }
  }
  state.facilities.forEach(f => {
    if (f.type === "headquarters" && f.team === "enemy") {
      axisProtectionZones.push({ pos: { ...f.position }, radius: HQ_EXCLUSION_RADIUS });
    }
  });

  // (3) Build candidates.
  const candidates: { u: Unit; postIdx: number | null }[] = [];
  state.units.forEach(u => {
    if (u.team !== "enemy" || u.state === "dead" || u.hp <= 0) return;
    if (getUnitCategory(u.type) !== "ground") return;
    if (u.type === "commander") return;
    if (p4ClaimedIds.has(u.id)) return;
    if (u.state !== "idle" && u.state !== "defending" && u.state !== "patrolling") return;

    // (a) Skip if inside an Axis garrison/HQ ring.
    let excluded = false;
    for (const z of axisProtectionZones) {
      const dx = u.position.x - z.pos.x, dy = u.position.y - z.pos.y;
      if (dx * dx + dy * dy <= z.radius * z.radius) { excluded = true; break; }
    }
    if (excluded) return;

    // (b) Tag if inside a captured player post — capped withdrawal later.
    let postIdx: number | null = null;
    for (let i = 0; i < occupiedPosts.length; i++) {
      const p = occupiedPosts[i];
      const dx = u.position.x - p.pos.x, dy = u.position.y - p.pos.y;
      if (dx * dx + dy * dy <= CAPTURED_POST_GARRISON_RADIUS * CAPTURED_POST_GARRISON_RADIUS) {
        postIdx = i;
        occupiedPosts[i].current++;
        break;
      }
    }
    candidates.push({ u, postIdx });
  });

  // (4) Sort: closer-to-target first; HP desc as tiebreaker.
  candidates.sort((a, b) => {
    const da = (a.u.position.x - attackTarget.x) ** 2 + (a.u.position.y - attackTarget.y) ** 2;
    const db = (b.u.position.x - attackTarget.x) ** 2 + (b.u.position.y - attackTarget.y) ** 2;
    if (Math.abs(da - db) > 100) return da - db;
    return b.u.hp - a.u.hp;
  });

  // (5) Take up to `want`, never dropping a captured post below its capacity.
  const taken: Unit[] = [];
  for (const { u, postIdx } of candidates) {
    if (taken.length >= want) break;
    if (postIdx !== null) {
      const post = occupiedPosts[postIdx];
      if (post.current <= post.capacity) continue;   // would drop below minimum
      post.current--;
    }
    taken.push(u);
  }

  return taken;
}

// ── Dispatch with formation ──

function dispatchWithFormation(
  state: GameState,
  attackers: Unit[],
  target: Position,
  style: FormationStyle,
  priority: "high" | "medium" | "low",
): number {
  const centroid = {
    x: attackers.reduce((s, u) => s + u.position.x, 0) / attackers.length,
    y: attackers.reduce((s, u) => s + u.position.y, 0) / attackers.length,
  };
  const heading = computeHeading(centroid, target);

  const orders: Order[] = attackers.map((u, i) => {
    const off = getFormationOffset(target, i, attackers.length, style, heading);
    return {
      unitIds: [u.id],
      action: "attack_move" as const,
      target: {
        x: Math.max(0, Math.min(state.mapWidth - 1, off.x)),
        y: Math.max(0, Math.min(state.mapHeight - 1, off.y)),
      },
      priority,
    };
  });

  const result = applyEnemyOrders(state, orders);

  // Per-index claim: each Order has unitIds: [attackers[i].id], so appliedPerOrder[i]
  // is 1 iff that specific attacker's order was applied. Claiming the whole batch on
  // any-success would tag units whose orders were rejected (e.g. dead between gather
  // and dispatch), letting reissueClaimedUnits chase ghosts for a tick. Per-index is
  // tighter and easier to reason about.
  let totalApplied = 0;
  for (let i = 0; i < attackers.length; i++) {
    if (result.appliedPerOrder[i] > 0) {
      p4ClaimedIds.add(attackers[i].id);
      p4AttackerTargets.set(attackers[i].id, { ...target });
      totalApplied++;
    }
  }
  return totalApplied;
}

// ── Per-tick maintenance for claimed units ──
//
// Tick order is processDefensiveAI → processPressureDirector. Within one tick, a
// P4-claimed unit that goes idle (waypoint completed, target killed) is first
// seen by defensiveAI's assignRoles, which may put it in reserveIds and re-task
// it via P0/P1/P2/P3. By the time we reach reissue, the unit may already have
// new orders. Our drift detection releases the claim instead of fighting over
// the unit — next P4 fire (~100-140s later) picks from a fresh pool.
function reissueClaimedUnits(state: GameState): void {
  for (const id of Array.from(p4ClaimedIds)) {
    const u = state.units.get(id);

    // (1) Dead or vanished → cleanup.
    if (!u || u.state === "dead" || u.hp <= 0) {
      p4ClaimedIds.delete(id);
      p4AttackerTargets.delete(id);
      continue;
    }

    // (2) Badly damaged → release (autoBehavior retreat takes over).
    if (u.hp / u.maxHp < LOW_HP_RETREAT_RATIO) {
      p4ClaimedIds.delete(id);
      p4AttackerTargets.delete(id);
      continue;
    }

    const tgt = p4AttackerTargets.get(id);
    if (!tgt) {
      p4ClaimedIds.delete(id);
      continue;
    }

    // (3) defensiveAI re-classified this unit → release. We never steal back.
    if (u.state === "patrolling" || u.state === "defending" || u.state === "retreating") {
      p4ClaimedIds.delete(id);
      p4AttackerTargets.delete(id);
      continue;
    }

    // (4) Arrived at P4 final target → drop claim (success).
    const dx = u.position.x - tgt.x, dy = u.position.y - tgt.y;
    if (dx * dx + dy * dy <= ARRIVAL_RADIUS * ARRIVAL_RADIUS) {
      p4ClaimedIds.delete(id);
      p4AttackerTargets.delete(id);
      continue;
    }

    // (5) moving/attacking — compare u.target to our intended p4Target.
    //     Formation offsets are normally < 5 tiles; > 8 tiles means another
    //     system redirected the unit.
    if ((u.state === "moving" || u.state === "attacking") && u.target) {
      const tdx = u.target.x - tgt.x, tdy = u.target.y - tgt.y;
      const driftSq = tdx * tdx + tdy * tdy;
      if (driftSq > DRIFT_RELEASE_TILES_SQ) {
        p4ClaimedIds.delete(id);
        p4AttackerTargets.delete(id);
        continue;
      }
      continue;   // on-track, don't churn orders
    }

    // (6) Idle but not arrived — re-issue P4 attack_move.
    //     Race window: defensiveAI may have given a new idle-state order this
    //     same tick (before us). We overwrite; next tick's drift check catches
    //     any contention.
    if (u.state === "idle") {
      applyEnemyOrders(state, [{
        unitIds: [id],
        action: "attack_move",
        target: { ...tgt },
        priority: "high",
      }]);
    }
  }
}

// ── Production boost (called when target candidates exist but pool is dry) ──

function boostEnemyProduction(state: GameState): void {
  if (state.time - lastBoostAt < PRODUCTION_BOOST_COOLDOWN_SEC) return;

  const queue = state.productionQueue.enemy;
  if (queue.length >= 4) return;   // respect defensiveAI.manageEconomy's cap

  const eco = state.economy.enemy.resources;
  const phase = getPressurePhase(state);

  // Costs come live from UNIT_STATS (single source of truth) so they track price changes.
  const wishlist: { type: UnitType; cost: number }[] = [];
  if (phase === "easy") {
    wishlist.push({ type: "infantry",   cost: UNIT_STATS.infantry.cost });
    wishlist.push({ type: "infantry",   cost: UNIT_STATS.infantry.cost });
  } else if (phase === "mid") {
    wishlist.push({ type: "infantry",   cost: UNIT_STATS.infantry.cost });
    wishlist.push({ type: "light_tank", cost: UNIT_STATS.light_tank.cost });
  } else {
    wishlist.push({ type: "infantry",   cost: UNIT_STATS.infantry.cost });
    if (eco.money >= UNIT_STATS.main_tank.cost) {
      wishlist.push({ type: "main_tank",  cost: UNIT_STATS.main_tank.cost });
    } else {
      wishlist.push({ type: "light_tank", cost: UNIT_STATS.light_tank.cost });
    }
  }

  let added = 0;
  for (const item of wishlist) {
    if (queue.length >= 4) break;
    if (eco.money < item.cost) continue;   // try next, don't bail
    const result = enqueueProduction(state, "enemy", item.type);
    if (result.ok) added++;
  }

  if (added > 0) {
    lastBoostAt = state.time;   // only update cooldown on success
    pushDiagnostic(state, `P4 prod-boost phase=${phase} added=${added} queue=${queue.length}`);
  }
  // On total failure (money too low for everything), don't set cooldown — next
  // 5s tick retries. Underlying problem is defensiveAI's economy, not ours.
}

// ── Mini helpers (copied in-file so deleting this module touches nothing else) ──

function pushDiagnostic(state: GameState, message: string): void {
  // code "P4_DBG" is suppressed by GameCanvas SUPPRESSED_DIAG_CODES.
  if (state.diagnostics.length >= MAX_DIAGNOSTICS) {
    state.diagnostics.splice(0, state.diagnostics.length - MAX_DIAGNOSTICS + 1);
  }
  state.diagnostics.push({
    time: state.time,
    code: "P4_DBG",
    message,
  });
}

// Mirrors defensiveAI.isVisibleToEnemy. Intentionally duplicated.
function isVisibleToEnemyMini(state: GameState, target: Position): boolean {
  const tx = Math.floor(target.x);
  const ty = Math.floor(target.y);

  let visible = false;
  state.units.forEach(u => {
    if (visible) return;
    if (u.team !== "enemy" || u.state === "dead" || u.hp <= 0) return;
    let vision = u.visionRange;
    if (getUnitCategory(u.type) === "ground") {
      const ux = Math.floor(u.position.x);
      const uy = Math.floor(u.position.y);
      if (ux >= 0 && ux < state.mapWidth && uy >= 0 && uy < state.mapHeight) {
        const terrain = state.terrain[uy][ux];
        if (terrain === "forest") vision = Math.max(1, vision - 2);
      }
    }
    const dx = tx - u.position.x, dy = ty - u.position.y;
    if (dx * dx + dy * dy <= vision * vision) visible = true;
  });
  if (visible) return true;

  state.facilities.forEach(f => {
    if (visible) return;
    if (f.team !== "enemy" || f.hp <= 0) return;
    let v = 6;
    if (f.type === "headquarters") v = 10;
    if (f.type === "radar") v = 20;
    const dx = tx - f.position.x, dy = ty - f.position.y;
    if (dx * dx + dy * dy <= v * v) visible = true;
  });
  return visible;
}
