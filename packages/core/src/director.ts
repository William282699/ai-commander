// ============================================================
// AI Commander — Director (Step 7a: read-board pure function)
//
// The "director" is the war-room tension layer ported from the small MVP's
// `directorBeat()` cascade (commandersmallmvp/public/app.js). The MVP picked the
// single most urgent thing each pulse and framed it as fact + cost + choice — but
// over FAKE state that only ever escalated. Here we keep the *shape* and drop the
// *fake*: this reads the REAL battlefield and returns the one beat that matters
// right now, or null when nothing is urgent (silence is the default).
//
// ── Hard boundaries (Step 7 ironclad rule) ──
//   - Pure function. No I/O, no LLM, no React, no mutation of GameState.
//   - The ENGINE only emits STRUCTURED FACTS + a NEUTRAL classification: which
//     front, how urgent, the survival estimate, and a `stake` enum. It never
//     decides the final player wording, and it must NOT assume our side is on
//     defense — the same fresh signals fire when WE are attacking an enemy
//     strongpoint or a capture objective is changing hands. Codex review:
//     baking "战线失守/顶不住" into the engine mislabels offensive/contested cases.
//   - The LLM's only future job (7c) is to re-voice the structured beat in a
//     persona's words from `stake` + the neutral facts — it never invents
//     battlefield facts, picks the beat, or decides whether to ask.
//   - Decision math is REUSED, not re-derived: collapse/dilemma classification
//     comes from 6a's exported `assessCrisisEscalation`. No thresholds inside that
//     math are touched.
//
// ── Signal freshness (verified against the engine, June 2026) ──
//   - `front.engagementIntensity` is updated every tick (battleAwareness EMA) →
//     fresh; the primary "is this line hot" + trend signal.
//   - `estimateCollapseTime` (inside `assessCrisisEscalation`) scans live units →
//     fresh survival estimate of OUR committed force at the front (defenderHP /
//     incoming enemyDPS). Neutral reading: how long our units there last under
//     current fire — true whether we're attacking or defending.
//   - `economy.player.resources` (fuel/ammo) → fresh; the supply-strain signal.
//   - `front.supplyStatus` is DEAD: only ever initialised to "OK" in scenario
//     map data, never written at runtime. We deliberately do NOT use it.
//   - `front.playerPower/enemyPower/enemyPowerKnown` only refresh inside
//     `buildDigest` (briefs/heartbeat, not every tick) → may lag. We no longer use
//     `enemyPowerKnown` to infer a feint (Codex: absence-of-info ≠ evidence);
//     feint now requires VISIBLE massing on a quiet axis.
// ============================================================

import type { GameState, Front, Channel, CrisisEvent, MissionType, ReportEvent, ReportEventType } from "@ai-commander/shared";
import { assessCrisisEscalation } from "./crisisResponse";

// ── Tunables (one place, so later steps tune from real playtest, not guesswork) ──

const TUNING = {
  /** A front must be at least this engaged (0-1) before we run the heavy collapse
   *  assessment on it. Filters out quiet fronts (perf + correctness). */
  ENGAGED_MIN: 0.25,
  /** Collapse risk only counts when our committed force is predicted to be broken
   *  within this many seconds. Beyond it, the local exchange is holding — no beat. */
  COLLAPSE_DANGER_SEC: 90,
  /** Feint suspicion: one front at least this loud... */
  FEINT_LOUD_MIN: 0.5,
  /** ...while a DIFFERENT, relatively quiet front shows visible massing. */
  FEINT_MASSING_QUIET_MAX: 0.2,
  /** Minimum visible enemy units gathered on the quiet axis to count as massing
   *  (a real cluster, not one passing scout). Evidence, not absence-of-info. */
  FEINT_MASSING_MIN_UNITS: 4,
  /** Supply strain: the scarcer of fuel/ammo at/below this means the next big
   *  maneuver is effectively one-shot. Mirrors reportSignals' SUPPLY_LOW floor
   *  (30); raise once real playtest shows the resource scale. */
  SUPPLY_STRAIN_THRESHOLD: 30,
  /** Trend hysteresis: engagement must move more than this between snapshots to
   *  read as escalating/easing rather than steady (anti-flicker). */
  TREND_EPSILON: 0.05,
} as const;

// Offensive player mission types — used to recognise "we are pushing INTO this
// front" so the stake reads as attack-under-pressure, not defense. `defend_area`
// is intentionally excluded (that one is defensive).
const OFFENSIVE_MISSION_TYPES: ReadonlySet<MissionType> = new Set<MissionType>([
  "capture", "destroy", "sabotage", "cut_supply",
]);

// ── Persona routing (matches EVENT_CHANNEL_MAP in GameCanvas) ──
//   combat = Chen (frontline), ops = Marcus (operations/traps), logistics = Emily (cost)

// ── Public types ──

export type DirectorBeatKind =
  | "front_collapse"       // our committed force at a front is losing the local exchange
  | "cross_front_dilemma"  // ...and steadying it means pulling forces off another line
  | "feint_suspicion"      // loud front + visible massing elsewhere — main thrust unclear
  | "supply_strain";       // fuel/ammo low enough that the next big move is one-shot

/**
 * Neutral classification of WHAT is at stake at the focus front. The engine
 * computes this from real ownership / missions / posture; it never assumes
 * defense. 7c's LLM voices the beat differently per stake (e.g. an attack that's
 * bogging down vs a line buckling) — but that wording is the LLM's job, not here.
 */
export type DirectorStake =
  | "player_defense"               // enemy is pressing OUR ground/objective
  | "player_attack_under_pressure" // WE are pushing into enemy ground and taking fire
  | "contested_objective"          // an objective is actively changing hands
  | "unknown";                     // signals inconclusive — let the voice stay careful

export type DirectorTrend = "escalating" | "easing" | "steady";

/** Engine-computed metrics captured at selection time. No LLM, no opinion. */
export interface DirectorMetricSnapshot {
  /** Focus front engagement 0-1; null for the economy-wide supply beat. */
  engagementIntensity: number | null;
  /** Fresh fog-gated playerDPS/enemyDPS at the focus front; null when n/a. */
  powerRatio: number | null;
  fuel: number;
  ammo: number;
  /** Derived from the previous snapshot (escalating = getting worse). */
  trend: DirectorTrend;
}

export interface DirectorBeat {
  kind: DirectorBeatKind;
  /** Which advisor owns this beat's voice. */
  channel: Channel;
  /** Focus front; null for the economy-wide supply beat. */
  frontId: string | null;
  frontName: string | null;
  /** Neutral: what's at stake here (defense / our attack / contested / unknown). */
  stake: DirectorStake;
  /** 0-1 ranking score; banded by kind so ordering is stable, not flickery. */
  severity: number;
  /** Seconds until our committed force at the front is broken; null when n/a.
   *  This is a survival estimate, NOT an assertion that "the line falls". */
  estimatedCollapseSeconds: number | null;
  /** Free reinforcement the engine found for a collapse beat (6a's bestCandidate):
   *  an idle / low-priority squad that could be committed. null for a true dilemma
   *  (no free squad) and for non-collapse beats. Structured so 7c can voice it
   *  without parsing prose. */
  freeReinforcement: { squadId: string; leaderName: string; aliveCount: number } | null;
  /** DEBUG-ONLY neutral string for console/observability. This is NOT the 7c
   *  player-copy source — 7c's LLM writes player wording from the STRUCTURED fields
   *  (kind / stake / frontName / estimatedCollapseSeconds / freeReinforcement /
   *  metric), never from this text. Kept neutral (no "line falls" / no defense
   *  assumption) so it can't mislead a reviewer reading the console. */
  debugFact: string;
  /** DEBUG-ONLY neutral framing of the fork. Same rule as debugFact. */
  debugTradeoff: string | null;
  metric: DirectorMetricSnapshot;
}

/** Minimal per-tick cache the caller threads back in to derive trend. Keeping it
 *  caller-owned (not module state) is what keeps this function pure. */
export interface DirectorSnapshot {
  time: number;
  fronts: Record<string, { engagementIntensity: number }>;
  fuel: number;
  ammo: number;
}

// ── Geometry / power helpers (pure, non-mutating) ──

function frontRegionBboxes(state: GameState, front: Front): [number, number, number, number][] {
  const out: [number, number, number, number][] = [];
  for (const rid of front.regionIds) {
    const r = state.regions.get(rid);
    if (r) out.push(r.bbox);
  }
  return out;
}

function isInsideFront(bboxes: [number, number, number, number][], x: number, y: number): boolean {
  return bboxes.some(([x1, y1, x2, y2]) => x >= x1 && x <= x2 && y >= y1 && y <= y2);
}

function isEnemyVisible(state: GameState, x: number, y: number): boolean {
  const tx = Math.floor(x);
  const ty = Math.floor(y);
  return state.fog[ty]?.[tx] === "visible";
}

/**
 * Fresh, non-mutating, fog-gated power read for the focus front, used only for the
 * metric snapshot (NOT for the collapse decision — that's `assessCrisisEscalation`).
 *
 * DPS uses the engine's one canonical definition, attackDamage / attackInterval
 * (same as combat.ts / crisisResponse.ts). Enemy units are fog-gated to "what the
 * player can actually see", matching updateFrontPower's convention.
 */
function freshFrontPowerRatio(state: GameState, front: Front): number | null {
  const bboxes = frontRegionBboxes(state, front);
  if (bboxes.length === 0) return null;

  let playerDPS = 0;
  let enemyDPS = 0;
  state.units.forEach((u) => {
    if (u.hp <= 0 || u.state === "dead") return;
    if (!isInsideFront(bboxes, u.position.x, u.position.y)) return;
    if (u.attackDamage <= 0 || u.attackInterval <= 0) return;
    const dps = u.attackDamage / u.attackInterval;
    if (u.team === "player") {
      playerDPS += dps;
    } else if (u.team === "enemy" && isEnemyVisible(state, u.position.x, u.position.y)) {
      enemyDPS += dps;
    }
  });

  if (enemyDPS <= 0) return null; // no known enemy presence → ratio undefined
  return Math.round((playerDPS / enemyDPS) * 100) / 100;
}

/**
 * Count VISIBLE enemy units inside a front's bbox. Used as massing evidence on a
 * quiet axis — real, fog-gated "we can see them gathering there", not the old
 * `enemyPowerKnown=false` absence-of-info guess.
 */
function visibleEnemyCount(state: GameState, front: Front): number {
  const bboxes = frontRegionBboxes(state, front);
  if (bboxes.length === 0) return 0;
  let n = 0;
  state.units.forEach((u) => {
    if (u.team !== "enemy" || u.hp <= 0 || u.state === "dead") return;
    if (!isInsideFront(bboxes, u.position.x, u.position.y)) return;
    if (isEnemyVisible(state, u.position.x, u.position.y)) n++;
  });
  return n;
}

/**
 * Does the front contain a real, alive player COMBAT force? This is the gate for
 * collapse/dilemma beats (Codex blocker): `estimateCollapseTime` returns
 * defenderHP / enemyDPS, so a front with zero player units yields tCollapse=0 — a
 * FAKE maximally-urgent beat claiming "我方投入部队承压" when we have nothing
 * committed there. `engagementIntensity` counts BOTH teams, so it stays elevated on
 * enemy-only or undefended-facility fights — hence this explicit presence check.
 * (An undefended player facility being overrun IS a real loss, but it belongs to
 * the FACILITY_CONTESTED/LOST report path, not a committed-force collapse beat.)
 */
function hasPlayerCombatPresence(state: GameState, front: Front): boolean {
  const bboxes = frontRegionBboxes(state, front);
  if (bboxes.length === 0) return false;
  for (const u of state.units.values()) {
    if (u.team !== "player" || u.hp <= 0 || u.state === "dead") continue;
    if (u.type === "commander" || u.attackDamage <= 0) continue; // committed combat unit only
    if (isInsideFront(bboxes, u.position.x, u.position.y)) return true;
  }
  return false;
}

/**
 * Classify the neutral stake at a front from real ownership / missions / posture.
 * Deterministic and confident-first; falls back to `unknown` rather than guessing
 * defense. This is what keeps the engine from mislabelling an offensive push as a
 * collapsing defensive line.
 */
function classifyStake(state: GameState, front: Front): DirectorStake {
  const bboxes = frontRegionBboxes(state, front);
  const regionSet = new Set(front.regionIds);

  // 1) Active capture anywhere in the front → an objective is changing hands.
  let playerFacility = false;
  let enemyFacility = false;
  let captureActive = false;
  state.facilities.forEach((f) => {
    if (!regionSet.has(f.regionId)) return;
    if (f.capturingTeam !== null && f.captureProgress > 0) captureActive = true;
    if (f.team === "player") playerFacility = true;
    else if (f.team === "enemy") enemyFacility = true;
  });
  if (captureActive) return "contested_objective";

  // 2) A player offensive mission aimed into this front → we're attacking.
  const hasOffensiveMission = state.missions.some((m) => {
    if (m.status !== "active" || !OFFENSIVE_MISSION_TYPES.has(m.type)) return false;
    if (m.targetRegionId && regionSet.has(m.targetRegionId)) return true;
    if (m.targetFacilityId) {
      const tf = state.facilities.get(m.targetFacilityId);
      if (tf && regionSet.has(tf.regionId)) return true;
    }
    return false;
  });
  if (hasOffensiveMission) return "player_attack_under_pressure";

  // 3) Ownership + presence.
  let playerUnits = 0;
  let enemyVisible = 0;
  let defending = 0;
  let attacking = 0;
  state.units.forEach((u) => {
    if (u.hp <= 0 || u.state === "dead") return;
    if (!isInsideFront(bboxes, u.position.x, u.position.y)) return;
    if (u.team === "player") {
      playerUnits++;
      if (u.state === "defending") defending++;
      else if (u.state === "attacking") attacking++;
    } else if (u.team === "enemy" && isEnemyVisible(state, u.position.x, u.position.y)) {
      enemyVisible++;
    }
  });

  if (enemyFacility && playerUnits > 0) return "player_attack_under_pressure"; // pushing into their ground
  if (playerFacility && enemyVisible > 0) return "player_defense";             // enemy pressing our ground

  // 4) Posture fallback (only when ownership is silent).
  if (defending > attacking && defending > 0) return "player_defense";
  if (attacking > defending && attacking > 0) return "player_attack_under_pressure";

  return "unknown";
}

// ── Trend (derived, never stored on GameState) ──

function trendFromEngagement(
  frontId: string,
  current: number,
  prev: DirectorSnapshot | null | undefined,
): DirectorTrend {
  if (!prev) return "steady";
  const before = prev.fronts[frontId]?.engagementIntensity;
  if (before === undefined) return "steady";
  const delta = current - before;
  if (delta > TUNING.TREND_EPSILON) return "escalating";
  if (delta < -TUNING.TREND_EPSILON) return "easing";
  return "steady";
}

function trendFromSupply(
  fuel: number,
  ammo: number,
  prev: DirectorSnapshot | null | undefined,
): DirectorTrend {
  if (!prev) return "steady";
  const now = Math.min(fuel, ammo);
  const before = Math.min(prev.fuel, prev.ammo);
  // Draining (now < before) means the strain is getting worse → escalating.
  if (now < before - 1) return "escalating";
  if (now > before + 1) return "easing";
  return "steady";
}

function clamp01(n: number): number {
  return Math.max(0, Math.min(1, n));
}

// ── Beat builders (each is a deterministic detector; returns 0+ candidates) ──

/**
 * Collapse / dilemma beats. For every actively-engaged front, reuse 6a's
 * `assessCrisisEscalation` to learn the survival estimate of our committed force
 * and whether a free squad can steady it. A `dilemma` (no free squad → must pull
 * committed forces) is the real fork and outranks a `safe_reinforce` dip.
 *
 * Phrasing stays NEUTRAL: "pressure rising / our committed units are losing the
 * local exchange / decide whether to keep investing" — never "the line falls".
 * The `stake` field carries attack vs defense; the LLM voices it.
 */
function collectCollapseBeats(
  state: GameState,
  prev: DirectorSnapshot | null | undefined,
): DirectorBeat[] {
  const beats: DirectorBeat[] = [];
  const res = state.economy.player.resources;

  for (const front of state.fronts) {
    if (front.engagementIntensity < TUNING.ENGAGED_MIN) continue; // quiet → skip heavy scan
    // Gate (Codex blocker): a committed-force collapse beat requires that WE
    // actually have combat units in the front. Otherwise tCollapse=0 → fake beat.
    if (!hasPlayerCombatPresence(state, front)) continue;

    const crisis: CrisisEvent = {
      type: "DOCTRINE_BREACH",
      severity: "critical",
      doctrineId: "__director__",
      locationTag: front.id,
      message: `${front.name} 态势评估`,
      time: state.time,
    };
    const a = assessCrisisEscalation(state, crisis);
    if (!a) continue;
    // Only a finite, near-term break is a beat. A holding exchange stays silent.
    if (a.tCollapse === Infinity || a.tCollapse > TUNING.COLLAPSE_DANGER_SEC) continue;

    const urgency = clamp01(1 - a.tCollapse / TUNING.COLLAPSE_DANGER_SEC);
    const tSec = Math.round(a.tCollapse);
    const stake = classifyStake(state, front);
    const metric: DirectorMetricSnapshot = {
      engagementIntensity: front.engagementIntensity,
      powerRatio: freshFrontPowerRatio(state, front),
      fuel: res.fuel,
      ammo: res.ammo,
      trend: trendFromEngagement(front.id, front.engagementIntensity, prev),
    };

    // Neutral, stake-agnostic debug fact: force balance is shifting against our
    // committed units; the engine does not claim whose "line" or that we lose the
    // map. The reinforcement candidate is surfaced STRUCTURED (freeReinforcement),
    // not parsed out of this string.
    const debugFact = `${front.name} 方向压力升高，我方投入部队承压（约 ${tSec}s 后力量对比逆转）。`;
    const c = a.bestCandidate;
    const freeReinforcement = c
      ? { squadId: c.squadId, leaderName: c.leaderName, aliveCount: c.aliveCount }
      : null;

    if (a.kind === "dilemma") {
      beats.push({
        kind: "cross_front_dilemma",
        channel: "combat",
        frontId: front.id,
        frontName: front.name,
        stake,
        severity: 0.8 + urgency * 0.2,
        estimatedCollapseSeconds: tSec,
        freeReinforcement, // null for a true dilemma (no free squad)
        debugFact,
        debugTradeoff: "需要判断是否继续投入：能动的部队都在别处吃紧，加码就得从另一条线抽人——加码、收手、还是换防？",
        metric,
      });
    } else {
      // safe_reinforce (a free idle/low-priority squad can steady it) or report_only.
      const debugTradeoff = c
        ? `需要判断是否继续投入：${c.leaderName}（${c.aliveCount}人）还闲着，加码顶上还是收手？`
        : "需要判断是否继续投入：加码顶上，还是收手？";
      beats.push({
        kind: "front_collapse",
        channel: "combat",
        frontId: front.id,
        frontName: front.name,
        stake,
        severity: 0.6 + urgency * 0.2,
        estimatedCollapseSeconds: tSec,
        freeReinforcement,
        debugFact,
        debugTradeoff,
        metric,
      });
    }
  }

  return beats;
}

/**
 * Feint suspicion (Codex-hardened). Requires real EVIDENCE, not absence-of-info:
 * one front is loud (high engagement) while a DIFFERENT, relatively quiet front
 * shows a visible enemy build-up (massing). That's the classic "is the loud line a
 * fixing attack while they mass elsewhere?" — Marcus's question. Kept at the LOWEST
 * priority band so it never preempts a real crisis; it's a heads-up, not an alarm.
 */
function collectFeintBeats(
  state: GameState,
  prev: DirectorSnapshot | null | undefined,
): DirectorBeat[] {
  const loud = state.fronts.filter((f) => f.engagementIntensity >= TUNING.FEINT_LOUD_MIN);
  if (loud.length === 0) return []; // no loud line → nothing to be a feint FOR

  // Quiet fronts (not the loud fight) with a visible enemy cluster = massing.
  let bestMassingFront: Front | null = null;
  let bestMassingCount = 0;
  for (const f of state.fronts) {
    if (f.engagementIntensity > TUNING.FEINT_MASSING_QUIET_MAX) continue; // it's already a fight, not massing
    const count = visibleEnemyCount(state, f);
    if (count >= TUNING.FEINT_MASSING_MIN_UNITS && count > bestMassingCount) {
      bestMassingCount = count;
      bestMassingFront = f;
    }
  }
  if (!bestMassingFront) return []; // no visible massing → no evidence → stay silent

  const loudest = loud.reduce((a, b) => (b.engagementIntensity > a.engagementIntensity ? b : a));
  if (loudest.id === bestMassingFront.id) return []; // same front can't be both
  const res = state.economy.player.resources;
  const loudFactor = clamp01(
    (loudest.engagementIntensity - TUNING.FEINT_LOUD_MIN) / (1 - TUNING.FEINT_LOUD_MIN),
  );

  return [{
    kind: "feint_suspicion",
    channel: "ops",
    frontId: loudest.id,
    frontName: loudest.name,
    stake: "unknown", // the whole point is that the main thrust is unclear
    severity: 0.2 + loudFactor * 0.15, // strictly below supply (0.4+)
    estimatedCollapseSeconds: null,
    freeReinforcement: null,
    debugFact: `${loudest.name} 打得最凶，但 ${bestMassingFront.name} 方向有约 ${bestMassingCount} 股敌军在集结，主攻口还不明朗。`,
    debugTradeoff: `押 ${loudest.name}，还是留预备队等 ${bestMassingFront.name} 那边露头？`,
    metric: {
      engagementIntensity: loudest.engagementIntensity,
      powerRatio: freshFrontPowerRatio(state, loudest),
      fuel: res.fuel,
      ammo: res.ammo,
      trend: trendFromEngagement(loudest.id, loudest.engagementIntensity, prev),
    },
  }];
}

/**
 * Supply strain. From LIVE economy resources (not the dead supplyStatus field):
 * when the scarcer of fuel/ammo is near empty, the next big maneuver is one-shot —
 * Emily's cost warning. Only meaningful when something is actually being fought
 * over, i.e. at least one front is engaged.
 */
function collectSupplyBeats(
  state: GameState,
  prev: DirectorSnapshot | null | undefined,
): DirectorBeat[] {
  const res = state.economy.player.resources;
  const scarcer = Math.min(res.fuel, res.ammo);
  if (scarcer > TUNING.SUPPLY_STRAIN_THRESHOLD) return [];

  // No tension if nothing's happening — don't nag about fuel in a dead-quiet game.
  const anyEngaged = state.fronts.some((f) => f.engagementIntensity >= TUNING.ENGAGED_MIN);
  if (!anyEngaged) return [];

  const which = res.fuel <= res.ammo ? "燃油" : "弹药";
  const lowFactor = clamp01(1 - scarcer / TUNING.SUPPLY_STRAIN_THRESHOLD);

  return [{
    kind: "supply_strain",
    channel: "logistics",
    frontId: null,
    frontName: null,
    stake: "unknown",
    severity: 0.4 + lowFactor * 0.2,
    estimatedCollapseSeconds: null,
    freeReinforcement: null,
    debugFact: `${which}见底（${Math.floor(scarcer)}），只够再支撑一次大机动。`,
    debugTradeoff: "这一下要花在哪条线上？花了下一波就接不上了。",
    metric: {
      engagementIntensity: null,
      powerRatio: null,
      fuel: res.fuel,
      ammo: res.ammo,
      trend: trendFromSupply(res.fuel, res.ammo, prev),
    },
  }];
}

// ── Public API ──

/**
 * Collect ALL candidate beats, ranked most-urgent-first. Exposed for debug /
 * observability (so a playtest can see *why* the top beat won), and as the basis
 * for `selectDirectorBeat`. Pure.
 *
 * Ranking: severity desc, then sooner break first, then frontId for a stable
 * deterministic order (the hand-test cares that the pick doesn't flicker).
 */
export function collectDirectorBeats(
  state: GameState,
  prev?: DirectorSnapshot | null,
): DirectorBeat[] {
  const beats = [
    ...collectCollapseBeats(state, prev),
    ...collectFeintBeats(state, prev),
    ...collectSupplyBeats(state, prev),
  ];

  beats.sort((a, b) => {
    if (b.severity !== a.severity) return b.severity - a.severity;
    const at = a.estimatedCollapseSeconds ?? Infinity;
    const bt = b.estimatedCollapseSeconds ?? Infinity;
    if (at !== bt) return at - bt;
    return (a.frontId ?? "").localeCompare(b.frontId ?? "");
  });

  return beats;
}

/**
 * The Step 7a deliverable: select the SINGLE most important beat from the real
 * battlefield right now, or null when nothing is urgent (silence is correct).
 *
 * Pure read-board function — no I/O, no LLM, no mutation. Pass the previous
 * snapshot to derive the pressure trend; omit it on the first call.
 */
export function selectDirectorBeat(
  state: GameState,
  prev?: DirectorSnapshot | null,
): DirectorBeat | null {
  return collectDirectorBeats(state, prev)[0] ?? null;
}

// ============================================================
// Step 7b — Report-event denoise gate (director-prioritised)
//
// 6a escalates EVERY actionRequired report event to a Chen-voiced question, so a
// multi-crisis tick fires several questions at once ("多问句齐冒"). 7b caps a drain
// window to a SINGLE escalation and lets the director pick which one; the caller
// demotes the rest to the quiet report lane. Pure: decides WHICH event, never
// posts / escalates / voices / moves anything.
// ============================================================

const ESCALATION_TYPE_PRIORITY: Partial<Record<ReportEventType, number>> = {
  POSITION_CRITICAL: 5,   // front losing the local exchange — aligns with collapse beats
  FACILITY_CONTESTED: 3,  // an objective actively being taken
  MISSION_STALLED: 1,     // progress stalled — least time-critical
};

function frontIdForRegion(state: GameState, regionId: string): string | null {
  const f = state.fronts.find((fr) => fr.regionIds.includes(regionId));
  return f?.id ?? null;
}

/** Which front (if any) a report event belongs to — used to align an event with
 *  the director's top-beat front. Pure. */
function eventFrontId(state: GameState, evt: ReportEvent): string | null {
  switch (evt.type) {
    case "POSITION_CRITICAL":
      return evt.entityId ?? null; // entityId is already a front id
    case "FACILITY_CONTESTED":
    case "FACILITY_LOST": {
      const f = evt.entityId ? state.facilities.get(evt.entityId) : undefined;
      return f ? frontIdForRegion(state, f.regionId) : null;
    }
    case "MISSION_STALLED": {
      const m = evt.entityId ? state.missions.find((mm) => mm.id === evt.entityId) : undefined;
      if (!m) return null;
      if (m.targetRegionId) return frontIdForRegion(state, m.targetRegionId);
      if (m.targetFacilityId) {
        const tf = state.facilities.get(m.targetFacilityId);
        return tf ? frontIdForRegion(state, tf.regionId) : null;
      }
      return null;
    }
    default:
      return null;
  }
}

/**
 * Step 7b gate: from the actionRequired events eligible to escalate THIS window,
 * pick the single one that should become a question. Ranking: an event on the
 * director's top-beat front wins (that is "let the director's top beat sound"),
 * then severity, then a stable type priority, then drain order. Returns null only
 * for an empty list; returns the sole element for a one-event window (so 6a's
 * single-crisis behaviour is unchanged — no regression).
 *
 * Pure read-board decision — the caller escalates the returned event and demotes
 * the rest to the report lane. Never triggers the LLM, posts messages, or moves
 * units. Only invoke it when there is more than one candidate (its one call into
 * the full director is otherwise wasted work).
 */
export function selectEscalationEvent(
  state: GameState,
  candidates: ReportEvent[],
): ReportEvent | null {
  if (candidates.length === 0) return null;
  if (candidates.length === 1) return candidates[0];

  const beatFrontId = selectDirectorBeat(state)?.frontId ?? null;

  let best = candidates[0];
  let bestScore = -Infinity;
  for (let i = 0; i < candidates.length; i++) {
    const e = candidates[i];
    let score = 0;
    if (beatFrontId && eventFrontId(state, e) === beatFrontId) score += 1000; // director's pick
    score += e.severity === "critical" ? 100 : e.severity === "warning" ? 50 : 10;
    score += ESCALATION_TYPE_PRIORITY[e.type] ?? 0;
    score -= i * 0.001; // stable tie-break: earlier-drained wins
    if (score > bestScore) {
      bestScore = score;
      best = e;
    }
  }
  return best;
}

/**
 * Build the per-tick snapshot the caller threads back in next time to derive trend.
 * Kept separate (and caller-owned) so `selectDirectorBeat` stays a pure function
 * with no hidden module state. Pure.
 */
export function snapshotForDirector(state: GameState): DirectorSnapshot {
  const fronts: Record<string, { engagementIntensity: number }> = {};
  for (const f of state.fronts) {
    fronts[f.id] = { engagementIntensity: f.engagementIntensity };
  }
  const res = state.economy.player.resources;
  return { time: state.time, fronts, fuel: res.fuel, ammo: res.ammo };
}

/** One-line console string for debug / observability. Pure; no UI, no LLM.
 *  Text is the engine's neutral debug fact, NOT a final player line. */
export function describeDirectorBeat(beat: DirectorBeat | null): string {
  if (!beat) return "[director] (quiet — no beat)";
  const m = beat.metric;
  const bits = [
    `sev=${beat.severity.toFixed(2)}`,
    `ch=${beat.channel}`,
    `stake=${beat.stake}`,
    beat.frontName ? `front=${beat.frontName}` : "front=—",
    beat.estimatedCollapseSeconds !== null ? `estBreak=${beat.estimatedCollapseSeconds}s` : null,
    m.engagementIntensity !== null ? `eng=${m.engagementIntensity.toFixed(2)}` : null,
    m.powerRatio !== null ? `pwr=${m.powerRatio.toFixed(2)}` : null,
    `trend=${m.trend}`,
    beat.freeReinforcement
      ? `free=${beat.freeReinforcement.leaderName}(${beat.freeReinforcement.aliveCount})`
      : null,
  ].filter(Boolean);
  let out = `[director] ${beat.kind} (${bits.join(" ")})\n  fact: ${beat.debugFact}`;
  if (beat.debugTradeoff) out += `\n  fork: ${beat.debugTradeoff}`;
  return out;
}
