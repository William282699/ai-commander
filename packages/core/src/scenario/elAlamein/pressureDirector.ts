// ============================================================
// AI Commander — El Alamein Pressure Director (Step 5C-lite, V3 expanded)
//
// Scripted P4 pressure module that runs PARALLEL to defensiveAI, plus a
// strategic-phase config table that defensiveAI imports to gate its own
// P1/P2/P3 stages.
//
// Coordination with defensiveAI:
//   - P4 wave logic observes normal unit.state plus one scenario-local,
//     read-only ownership predicate (operationRegistry) so it cannot poach a
//     staged armored operation. defensiveAI is the registry's only writer.
//   - V3 adds the config coupling channel: defensiveAI imports PHASE_STRATEGY
//     (const table) and getCurrentStrategicPhase (pure function). This is
//     CONST + PURE FUNCTION coupling, not state coupling — defensiveAI
//     reads the config to derive its grace/cap/cooldown, but never reads
//     pressureDirector's internal module state.
//
// Mini-helpers (isVisibleToEnemyMini / pushDiagnostic) remain copied in-file
// to keep P4 wave logic self-contained.
//
// Deletion path (V3, 4-step):
//   1) delete this file + operationRegistry.ts
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
import { isOperationReserved } from "./operationRegistry";

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
  | "observation"       // 0-90s: 展开试探 (El Alamein only; EP-V1a: was 0-180s)
  | "multi_line"        // 90-720s: 多线压力 (主体, El Alamein only)
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
  // 0-90s (EP-V1a: was 0-180): P0 reactive + P3 probe from 45s; P1 disabled.
  // P4 wave 1 departs ~15s (see P4_GRACE_PERIOD_SEC). The armored-fist operation
  // may CREATE/ASSEMBLE from ~15s (marching is not attacking) but its LAUNCH is
  // gated by the multi_line p2Grace below.
  // EP-V1a.2: p3MaxUnits 4→3 — early probes were poaching the fist's units.
  // EP-V1 opening tempo: p2Grace 9999→55 — the fist may LAUNCH during
  // observation once gathered (≥4 mt at staging slots). With the forward-staged
  // assembly group this puts the first big contact at ~85-95s; later fists are
  // paced by the 180s launch cooldown, not by grace.
  observation:     { p1Grace: 9999, p2Grace: 55,   p3Grace: 45,   p2CommitRatio: 0,    p2CooldownSec: 180,  p3MaxUnits: 3, p1MaxAttack: 0 },
  // 90-720s: P1 opportunistic + P3 probe + P4 wave + the P2 armored-fist
  // OPERATION (owner: defensiveAI operation layer; old massedOffensive body is
  // legacy-gated). p2Grace = earliest fist LAUNCH; p2CooldownSec = launch-to-launch
  // pacing → 玩家可见 contact-to-contact ≈ 180s + ~30s staging→target march.
  // EP-V1a: p3Grace 120→45 (grace is ABSOLUTE game time — leaving 120 would re-forbid
  //   probes in the 90-120s window right after observation ends).
  // EP-V1c 降噪: p3MaxUnits 4→3, p1MaxAttack 5→4 — shave the scattered small
  // waves so the P2 fist is the recognizable event, not one more ripple.
  // p2Grace 180→55 (EP-V1 opening tempo): must MATCH observation's value — an
  // absolute-time grace above 90 would re-block a fist that slipped past the
  // 90s phase boundary (same absolute-grace trap as p3Grace, noted above).
  multi_line:      { p1Grace: 180,  p2Grace: 55,   p3Grace: 45,   p2CommitRatio: 0,    p2CooldownSec: 180,  p3MaxUnits: 3, p1MaxAttack: 4 },
  // 720-1320s: operation keeps cycling on a faster 120s cadence.
  counter_attack:  { p1Grace: 0,    p2Grace: 720,  p3Grace: 0,    p2CommitRatio: 0.4,  p2CooldownSec: 120,  p3MaxUnits: 4, p1MaxAttack: 5 },
  // 1320s+ AND score > 0 (player ahead): all-in to break tie. HQ assault unlocked.
  endgame_offense: { p1Grace: 0,    p2Grace: 0,    p3Grace: 0,    p2CommitRatio: 0.7,  p2CooldownSec: 60,   p3MaxUnits: 4, p1MaxAttack: 6 },
  // 1320s+ AND score ≤ 0 (enemy tied/ahead): hold and force timeout. P2/P3 disabled
  // (p2Grace 9999 also stops new operation launches; an assembling op is cancelled).
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

// ── Strategic map data (single source of truth; defensiveAI imports these) ──
//
// Moved here from defensiveAI (EP-V1 final): the operation layer's target
// candidates must carry frontId + corridor, and this module builds them.

/** Objective → front (H6/H11). */
export const OBJECTIVE_FRONT_MAP: Record<string, string> = {
  ea_kidney_ridge: "front_ridge",
  ea_miteirya_ridge: "front_ridge",
  ea_alamein_town: "front_coastal",
  ea_himeimat: "front_south",
};

/** Player forward post → front (explicit; central maps to front_ridge to match
 *  the historical P2 approach axis). */
export const POST_FRONT_MAP: Record<string, string> = {
  ea_player_coastal_post: "front_coastal",
  ea_player_central_post: "front_ridge",
  ea_player_south_post: "front_south",
};

/** 5C-lite: front → the Allied forward post it pressures (P1/P3 fallback chain). */
export const FRONT_PLAYER_POST_MAP: Record<string, string> = {
  front_coastal: "ea_player_coastal_post",
  front_ridge:   "ea_player_central_post",
  front_center:  "ea_player_central_post",
  front_south:   "ea_player_south_post",
};

/** Multi-waypoint attack corridors (west→east, bypassing Devil's Gardens minefield). */
export const ATTACK_CORRIDORS: Record<string, Position[]> = {
  front_coastal: [
    { x: 200, y: 30 },   // coastal highway start
    { x: 300, y: 25 },   // north of minefield
    { x: 380, y: 35 },   // approach player area
  ],
  front_ridge: [
    { x: 200, y: 80 },   // ridge direction
    { x: 320, y: 60 },   // through ridge gap
    { x: 380, y: 50 },   // approach objective
  ],
  front_center: [
    { x: 200, y: 140 },  // central start
    { x: 320, y: 150 },  // south of minefield
    { x: 370, y: 140 },  // approach player
  ],
  front_south: [
    { x: 200, y: 200 },  // southern desert
    { x: 320, y: 210 },  // open desert march
    { x: 380, y: 200 },  // approach Himeimat
  ],
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
  if (t < 90) return "observation"; // EP-V1a: was 180 — multi_line pressure starts sooner
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
// EP-V1a: 90→15 — first P4 wave DEPARTS ~15s in, so the opening isn't dead air.
// March time from the western pool is still real (~2-3 min until V1b moves a
// vanguard forward); early departure ≠ early contact, and that's intended here.
const P4_GRACE_PERIOD_SEC = 15;
// EP-V1a: 140→90 — a second direction gets pressed within the first ~2 minutes
// (history penalty auto-rotates the target away from wave 1's post).
const P4_BASE_COOLDOWN_EASY = 90;
const P4_BASE_COOLDOWN_MID = 120;
const P4_BASE_COOLDOWN_HARD = 100;
const P4_JITTER_SEC = 20;
const P4_PHASE_BREAKPOINTS = { easyEnd: 480, midEnd: 1080 };   // 8 min / 18 min
const P4_MIN_POOL_TO_FIRE = 4;
const P4_HARASS_STANDOFF_TILES = 7; // fight around a post; the operation owns capture
const P4_TARGET_HISTORY_SIZE = 3;
const P4_HISTORY_PENALTY = -25;
// EP-V1a.2 opening fist — playtest ("前10分钟不好玩，压力没形成拳头") root causes:
// (1) history penalty rotated the target EVERY wave, so each post faced a lone
//     4-5 unit light wave vs a full 8-9 garrison = serial 添油;
// (2) waves carried no main_tank (distance-sort picks the cluster's front-row
//     inf/lt; the damage matrix makes armorless waves harassment, not pressure:
//     mt deals 2.0×/1.5× vs inf/lt and takes 0.25×/0.5× back).
// (EP-V1c: the V1a.2 easy-phase momentum bonus was retired — see
// historyPenalty. P4 is the rotating harass tool; P2 owns the fist.)
/** Wave armor floor per kind (recapture/finish_post hit harder). */
const P4_WAVE_MIN_HEAVY: Record<PressureKind, number> = {
  raid: 1, recapture: 2, finish_post: 2,
};
/** Only pull a main_tank into a wave if it's within this range of the target —
 *  swapping a nearby rifleman for a tank 300 tiles away would UN-fist the wave.
 *  170 covers the forward-staged 15.Pz pair + 21.Pz for every post. */
const P4_HEAVY_PULL_RADIUS = 170;
/** After a forward post FALLS, P4 enters a RESTRICTED window (not a freeze —
 *  EP-V1 final: the old 150s full pause was the main cause of the perceived
 *  "第8分钟后全场停机"): finish_post targeting is banned (no snowballing a
 *  second post while the player digests the first), raids shrink to probe
 *  size with no armor, recapture stays at full strength (it answers a player
 *  counterattack). The fist cadence itself is paced by the operation layer. */
const OFFENSIVE_CONSOLIDATE_SEC = 150;
/** Blip debounce: a post must stay enemy-held this long before the restricted
 *  window arms (an 11-second flip the garrison retakes at once must not
 *  restrict P4). Also imported by defensiveAI's operation layer as the
 *  capture-confirm delay before posting an occupation garrison. */
export const CONSOLIDATE_CONFIRM_SEC = 20;
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
let p4LastEnemyHeldPosts = new Set<string>(); // EP-V1a.2: consolidation-pause tracking (EP-V1c: id-set)
const p4PendingFlips = new Map<string, number>(); // EP-V1c: flip → confirm-clock (blip debounce)
let p4RestrictedUntil = 0; // EP-V1 final: post-capture RESTRICTED window (see OFFENSIVE_CONSOLIDATE_SEC)

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

export interface PressureCandidate {
  targetId: string;
  frontId: string;
  position: Position;
  kind: PressureKind;
  score: number;
}

/** Operation target candidate: PressureCandidate + the corridor to march it.
 *  Consumed by defensiveAI's operation layer (owner of the armored fist). */
export interface OperationTargetCandidate extends PressureCandidate {
  corridor: Position[];
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
  p4LastEnemyHeldPosts = new Set();
  p4PendingFlips.clear();
  p4RestrictedUntil = 0;
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

  // Post-capture RESTRICTED window: when a forward post flips to enemy hands
  // (confirmed past the blip debounce), P4 does NOT freeze — it keeps texture
  // pressure but is barred from snowballing: finish_post banned, raids shrink
  // to armorless probe size, recapture unaffected. Player retaking a post
  // re-arms the trigger for the next flip.
  const heldNow = new Set<string>();
  for (const id of state.scenarioWinConfig?.friendlyKeypoints ?? []) {
    const f = state.facilities.get(id);
    if (f && f.hp > 0 && f.team === "enemy") heldNow.add(id);
  }
  for (const id of heldNow) {
    if (!p4LastEnemyHeldPosts.has(id) && !p4PendingFlips.has(id)) {
      p4PendingFlips.set(id, state.time);
    }
  }
  for (const [id, at] of p4PendingFlips) {
    if (!heldNow.has(id)) { p4PendingFlips.delete(id); continue; } // blip — retaken
    if (state.time - at >= CONSOLIDATE_CONFIRM_SEC) {
      p4PendingFlips.delete(id);
      p4RestrictedUntil = Math.max(p4RestrictedUntil, state.time + OFFENSIVE_CONSOLIDATE_SEC);
      pushDiagnostic(state,
        `P4 restricted +${OFFENSIVE_CONSOLIDATE_SEC}s post=${id} (no finish_post, probe-size raids)`);
    }
  }
  p4LastEnemyHeldPosts = heldNow;

  // Grace + cooldown gates.
  if (state.time < P4_GRACE_PERIOD_SEC) return;
  if (state.time < p4CooldownUntil) return;

  const restricted = state.time < p4RestrictedUntil;
  const candidates = buildPressureTargets(state, true, restricted);
  if (candidates.length === 0) return;

  // Deterministic tie-break: score desc, then targetId asc.
  candidates.sort((a, b) => (b.score - a.score) || a.targetId.localeCompare(b.targetId));
  const best = candidates[0];
  if (best.score <= 0) return;

  const phase = getPressurePhase(state);
  // Restricted window: raids drop to armorless probe strength; recapture full.
  const waveSize = restricted && best.kind === "raid"
    ? P4_WAVE_SIZE.easy.probe[0] + Math.floor(Math.random() * (P4_WAVE_SIZE.easy.probe[1] - P4_WAVE_SIZE.easy.probe[0] + 1))
    : pickWaveSize(state, phase, best.kind);
  const armorlessRaid = restricted && best.kind === "raid";
  const wantHeavy = armorlessRaid ? 0 : P4_WAVE_MIN_HEAVY[best.kind];
  const pool = gatherPressurePool(state, best.position, waveSize, wantHeavy, armorlessRaid);

  if (pool.length < P4_MIN_POOL_TO_FIRE) {
    boostEnemyProduction(state);
    // Re-check after production has time to deliver.
    p4CooldownUntil = state.time + 30;
    pushDiagnostic(state,
      `P4 hold target=${best.targetId} kind=${best.kind} pool=${pool.length}<${P4_MIN_POOL_TO_FIRE} phase=${phase}`);
    return;
  }

  const formation = pickFormation(best.kind, phase);
  const harassTarget = getHarassmentApproach(pool, best.position);
  const applied = dispatchWithFormation(state, pool, harassTarget, formation, "high");

  if (applied > 0) {
    // FIFO history, capped.
    p4TargetHistory.push({ targetId: best.targetId, firedAt: state.time, kind: best.kind });
    if (p4TargetHistory.length > P4_TARGET_HISTORY_SIZE) {
      p4TargetHistory.splice(0, p4TargetHistory.length - P4_TARGET_HISTORY_SIZE);
    }
    p4CooldownUntil = state.time + pickCooldown(phase);
    p4WaveCount += 1;
    const mtCount = pool.filter((u) => u.type === "main_tank").length;
    pushDiagnostic(state,
      `P4 fire #${p4WaveCount} target=${best.targetId} kind=${best.kind} form=${formation} size=${applied}/${pool.length} mt=${mtCount} score=${best.score} phase=${phase}`);
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
  if (kind === "recapture") return "wedge";
  if (kind === "finish_post") return "line";
  return phase === "easy" ? "column" : "wedge";
}

// ── Target scoring ──
//
// Shared candidate builder. Two consumers:
//   - P4 harass waves: applyHistory=true (rotation), banFinishPost while in the
//     post-capture restricted window (no snowballing a second post);
//   - the P2 armored-fist operation (via buildOperationTargets below):
//     applyHistory=false — the op locks its target for a whole assembly, so
//     P4's rotation memory must not skew its strategic pick.

function buildPressureTargets(
  state: GameState,
  applyHistory: boolean,
  banFinishPost: boolean,
): PressureCandidate[] {
  const winCfg = state.scenarioWinConfig!;
  const out: PressureCandidate[] = [];
  const frontOf = (targetId: string): string =>
    OBJECTIVE_FRONT_MAP[targetId] ?? POST_FRONT_MAP[targetId] ?? "front_ridge";

  // (A) Recapture: Axis objectives held by / being captured by player.
  for (const objId of state.captureObjectives ?? []) {
    const f = state.facilities.get(objId);
    if (!f || f.hp <= 0) continue;
    let s = 0;
    if (f.team === "player") s += 100;
    else if (f.team === "enemy" && f.capturingTeam === "player") s += 70;
    else continue;
    if (applyHistory) s += historyPenalty(state, objId, "recapture");  // exempt → 0
    out.push({ targetId: objId, frontId: frontOf(objId), position: { ...f.position }, kind: "recapture", score: s });
  }

  // (B) Finish weak player forward post (hp < 50% OR currently being captured by enemy).
  if (!banFinishPost) {
    for (const kpId of winCfg.friendlyKeypoints) {
      const f = state.facilities.get(kpId);
      if (!f || f.team !== "player" || f.hp <= 0) continue;
      const hpRatio = f.hp / f.maxHp;
      let s = 0;
      if (hpRatio < 0.5) s += 60;
      if (f.capturingTeam === "enemy") s += 60;
      if (hasActiveEnemyAttackersNear(state, f.position, 18)) s += 25;
      s += scoreLocalPlayerDefense(state, f.position, 18);
      if (applyHistory) s += historyPenalty(state, kpId, "finish_post", hpRatio);
      if (s > 0) out.push({ targetId: kpId, frontId: frontOf(kpId), position: { ...f.position }, kind: "finish_post", score: s });
    }
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
      if (applyHistory) s += historyPenalty(state, kpId, "raid", hpRatio);
      if (s > 0) out.push({ targetId: kpId, frontId: frontOf(kpId), position: { ...f.position }, kind: "raid", score: s });
    }
  }

  return out;
}

/**
 * Operation-layer targets (owner: defensiveAI). Same live scoring as P4 —
 * recapture(100) > finish_post(60+) > raid(20+defense mods) — minus P4's
 * rotation history, plus the corridor each front marches. Sorted best-first.
 */
export function buildOperationTargets(state: GameState): OperationTargetCandidate[] {
  if (!state.scenarioWinConfig) return [];
  return buildPressureTargets(state, false, false)
    .map((c) => ({ ...c, corridor: (ATTACK_CORRIDORS[c.frontId] ?? []).map(p => ({ ...p })) }))
    .sort((a, b) => (b.score - a.score) || a.targetId.localeCompare(b.targetId));
}

function historyPenalty(state: GameState, targetId: string, kind: PressureKind, hpRatio?: number): number {
  if (kind === "recapture") return 0;
  // EP-V1c: the V1a.2 easy-phase momentum (+P4_EASY_FOCUS_BONUS on the last
  // target) is RETIRED. It existed when P4 was the only fist; with P2 now the
  // doctrine main assault, momentum made P4 steal the fist's job — its stacked
  // waves captured the first post ~150s, which triggered the consolidation
  // brake and pushed the REAL fist's launch from 180s to ~310s (sim). P4 goes
  // back to rotating harassment: 告急 across posts, the FALL belongs to P2.
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

function gatherPressurePool(
  state: GameState,
  attackTarget: Position,
  want: number,
  wantHeavy: number,
  excludeMainTanks: boolean,
): Unit[] {
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
    if (excludeMainTanks && u.type === "main_tank") return;
    if (p4ClaimedIds.has(u.id)) return;
    if (isOperationReserved(u.id)) return; // EP-V1 final: never poach the armored fist
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
  const taken: { u: Unit; postIdx: number | null }[] = [];
  for (const c of candidates) {
    if (taken.length >= want) break;
    if (c.postIdx !== null) {
      const post = occupiedPosts[c.postIdx];
      if (post.current <= post.capacity) continue;   // would drop below minimum
      post.current--;
    }
    taken.push(c);
  }

  // (6) EP-V1a.2 armor floor: a wave without main_tank cannot break a garrison
  // (damage matrix), so ensure at least `wantHeavy` of them when spare tanks
  // exist IN RANGE — swap the farthest-from-target foot/light pick for the
  // nearest un-taken tank. postIdx===null only (captured-post garrison math
  // stays untouched); capacity restored for whoever is swapped out.
  // wantHeavy is 0 during the post-capture restricted window (raids go armorless).
  const heavyCount = () => taken.filter((t) => t.u.type === "main_tank").length;
  if (heavyCount() < wantHeavy) {
    const takenIds = new Set(taken.map((t) => t.u.id));
    const pullR2 = P4_HEAVY_PULL_RADIUS * P4_HEAVY_PULL_RADIUS;
    const spareTanks = candidates.filter((c) => {
      if (c.u.type !== "main_tank" || c.postIdx !== null || takenIds.has(c.u.id)) return false;
      const dx = c.u.position.x - attackTarget.x, dy = c.u.position.y - attackTarget.y;
      return dx * dx + dy * dy <= pullR2;
    }); // candidates are already closest-first, so these are too
    for (const tank of spareTanks) {
      if (heavyCount() >= wantHeavy) break;
      let idx = -1;
      for (let i = taken.length - 1; i >= 0 && idx === -1; i--) {
        if (taken[i].u.type === "infantry") idx = i;
      }
      for (let i = taken.length - 1; i >= 0 && idx === -1; i--) {
        if (taken[i].u.type === "light_tank") idx = i;
      }
      if (idx === -1) break; // nothing swappable — wave is already armor/other
      const out = taken[idx];
      if (out.postIdx !== null) occupiedPosts[out.postIdx].current++; // restore capacity
      taken.splice(idx, 1);
      taken.push(tank);
    }
  }

  return taken.map((t) => t.u);
}

// ── Dispatch with formation ──

/** P4 is the harassment layer. Approach from the attackers' side and stop
 * outside the 1.5-tile capture circle; combat still happens around the post,
 * but only the armored operation/P0 is allowed to deliberately seize ground. */
function getHarassmentApproach(attackers: Unit[], objective: Position): Position {
  const centroid = {
    x: attackers.reduce((sum, unit) => sum + unit.position.x, 0) / attackers.length,
    y: attackers.reduce((sum, unit) => sum + unit.position.y, 0) / attackers.length,
  };
  const dx = centroid.x - objective.x;
  const dy = centroid.y - objective.y;
  const length = Math.hypot(dx, dy) || 1;
  return {
    x: objective.x + (dx / length) * P4_HARASS_STANDOFF_TILES,
    y: objective.y + (dy / length) * P4_HARASS_STANDOFF_TILES,
  };
}

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
