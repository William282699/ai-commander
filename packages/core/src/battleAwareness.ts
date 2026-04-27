// ============================================================
// Battle Awareness — visual markers + per-front engagement intensity
// Pure logic: reads/writes state.battleMarkers, state.recentDeaths,
// state.battleMarkerScanAccum, state.battleMarkerDeathCursor, and
// state.fronts[*].engagementIntensity (EMA-smoothed combat heat —
// powers digest, battleContext, POSITION_CRITICAL, warPhase, renderer).
// ============================================================

import type { GameState, BattleMarker, Front } from "@ai-commander/shared";

const SCAN_INTERVAL = 3; // seconds between full scans
const DEATH_MARKER_DURATION = 10; // seconds before death marker expires
const ATTACK_ZONE_DURATION = 8; // seconds before attack zone expires
const CRITICAL_FRONT_DURATION = 6; // seconds before critical front marker expires
const MAX_MARKERS = 50;
const MAX_RECENT_DEATHS = 100;
const ATTACK_ZONE_CLUSTER_RADIUS = 5; // tiles — units within this range form a cluster
const CRITICAL_FRONT_POWER_RATIO = 2.0;

// Engagement signal — hybrid of engaged-unit count + attack_zone marker presence
// per front, EMA-smoothed so digest values don't flicker. All three constants
// below are tunable post-playtest (calibrated against 1v1 / 4v4 scenarios).
const ENGAGEMENT_TAU_SEC = 4;          // tunable post-playtest — EMA time constant
const ENGAGEMENT_UNIT_SAT = 6;         // tunable post-playtest — engaged units → 1.0 saturation
const ENGAGEMENT_MARKER_WEIGHT = 0.4;  // tunable post-playtest — each attack_zone marker contribution

let nextMarkerId = 0;
function genId(): string {
  return `bm_${++nextMarkerId}`;
}

// Per-front raw engagement signal cache — recomputed on scan tick, EMA-smoothed every frame
const rawEngagementCache = new Map<string, number>();

export function resetEngagementCache(): void {
  rawEngagementCache.clear();
}

/**
 * Called every frame. Accumulates dt and every SCAN_INTERVAL seconds
 * scans for attack_zone and critical_front markers. Death markers are
 * generated immediately from recentDeaths every frame.
 */
export function updateBattleMarkers(state: GameState, dt: number): void {
  const now = state.time;

  // --- Death markers: generate from recentDeaths (instant, every frame) ---
  generateDeathMarkers(state, now);

  // --- Periodic scan for attack_zone + critical_front ---
  state.battleMarkerScanAccum += dt;
  let scannedThisFrame = false;
  if (state.battleMarkerScanAccum >= SCAN_INTERVAL) {
    state.battleMarkerScanAccum -= SCAN_INTERVAL;
    generateAttackZoneMarkers(state, now);
    generateCriticalFrontMarkers(state, now);
    scannedThisFrame = true;
  }

  // --- Update pulse phase + opacity on all markers ---
  for (const m of state.battleMarkers) {
    m.pulsePhase += dt * 2; // ~2 rad/s pulse speed
    if (m.type === "death" && m.expiresAt !== undefined) {
      const remaining = m.expiresAt - now;
      m.opacity = Math.max(0, remaining / DEATH_MARKER_DURATION);
    }
  }

  // --- Cleanup expired ---
  state.battleMarkers = state.battleMarkers.filter(
    (m) => m.expiresAt === undefined || m.expiresAt > now,
  );

  // --- Cap total markers ---
  if (state.battleMarkers.length > MAX_MARKERS) {
    state.battleMarkers = state.battleMarkers.slice(-MAX_MARKERS);
  }

  // --- Per-front engagement intensity: raw recomputed on scan, EMA every frame ---
  updateFrontEngagement(state, dt, scannedThisFrame);
}

// ── Death markers ──────────────────────────────────────────

function generateDeathMarkers(state: GameState, _now: number): void {
  // Consume only new deaths since last cursor position (no time-window, no duplicates)
  const cursor = state.battleMarkerDeathCursor;
  for (let i = cursor; i < state.recentDeaths.length; i++) {
    const d = state.recentDeaths[i];
    state.battleMarkers.push({
      id: genId(),
      type: "death",
      x: d.x,
      y: d.y,
      createdAt: d.time,
      expiresAt: d.time + DEATH_MARKER_DURATION,
      opacity: 1,
      pulsePhase: 0,
    });
  }
  state.battleMarkerDeathCursor = state.recentDeaths.length;

  // Trim old deaths, sync cursor
  let removed = 0;
  while (state.recentDeaths.length > MAX_RECENT_DEATHS) {
    state.recentDeaths.shift();
    removed++;
  }
  if (removed > 0) {
    state.battleMarkerDeathCursor = Math.max(0, state.battleMarkerDeathCursor - removed);
  }
}

// ── Attack zone markers ────────────────────────────────────

function generateAttackZoneMarkers(state: GameState, now: number): void {
  // Remove old attack_zone markers — they'll be regenerated if still valid
  state.battleMarkers = state.battleMarkers.filter((m) => m.type !== "attack_zone");

  // Collect units actually engaged in combat (have a live target within weapon range)
  const engagedUnits: { x: number; y: number; team: string }[] = [];
  for (const unit of state.units.values()) {
    if (unit.state === "dead") continue;
    if (unit.attackTarget == null) continue;
    const target = state.units.get(unit.attackTarget);
    if (!target || target.state === "dead") continue;
    // Both units must be alive and close enough to actually fight
    const dx = unit.position.x - target.position.x;
    const dy = unit.position.y - target.position.y;
    const dist = Math.sqrt(dx * dx + dy * dy);
    if (dist <= (unit.attackRange ?? 5) * 1.5) {
      engagedUnits.push({ x: unit.position.x, y: unit.position.y, team: unit.team });
    }
  }

  if (engagedUnits.length < 4) return; // need meaningful engagement

  // Grid-based clustering: bucket units into cells
  const cellSize = ATTACK_ZONE_CLUSTER_RADIUS;
  const clusters = new Map<string, { xs: number[]; ys: number[]; count: number; teams: Set<string> }>();

  for (const u of engagedUnits) {
    const cx = Math.floor(u.x / cellSize);
    const cy = Math.floor(u.y / cellSize);
    const key = `${cx},${cy}`;
    let cluster = clusters.get(key);
    if (!cluster) {
      cluster = { xs: [], ys: [], count: 0, teams: new Set() };
      clusters.set(key, cluster);
    }
    cluster.xs.push(u.x);
    cluster.ys.push(u.y);
    cluster.count++;
    cluster.teams.add(u.team);
  }

  for (const cluster of clusters.values()) {
    // Must have both sides fighting in same cell — this IS a battle, not a march
    if (cluster.count < 4 || cluster.teams.size < 2) continue;

    const avgX = cluster.xs.reduce((a, b) => a + b, 0) / cluster.count;
    const avgY = cluster.ys.reduce((a, b) => a + b, 0) / cluster.count;

    state.battleMarkers.push({
      id: genId(),
      type: "attack_zone",
      x: avgX,
      y: avgY,
      radius: ATTACK_ZONE_CLUSTER_RADIUS,
      createdAt: now,
      expiresAt: now + ATTACK_ZONE_DURATION,
      opacity: 0.6,
      pulsePhase: 0,
    });
  }
}

// ── Critical front markers ────────────────────────────────

function generateCriticalFrontMarkers(state: GameState, now: number): void {
  // Remove old critical_front markers
  state.battleMarkers = state.battleMarkers.filter((m) => m.type !== "critical_front");

  // Offensive scenarios (player is attacking, enemy is defending) — skip entirely.
  // critical_front is a DEFENSIVE alarm ("your front is being overwhelmed"), meaningless
  // when all fronts are enemy-held by design.
  if (state.enemyAIMode === "defensive") return;

  for (const front of state.fronts) {
    // Only flag as critical when player HAS forces on this front but is being overwhelmed.
    if (front.playerPower <= 0) continue;
    const ratio = front.enemyPower / front.playerPower;
    if (ratio < CRITICAL_FRONT_POWER_RATIO) continue;

    // Place marker at average position of the front's regions
    let totalX = 0;
    let totalY = 0;
    let count = 0;
    for (const rid of front.regionIds) {
      const region = state.regions.get(rid);
      if (region) {
        const [x1, y1, x2, y2] = region.bbox;
        totalX += (x1 + x2) / 2;
        totalY += (y1 + y2) / 2;
        count++;
      }
    }
    if (count === 0) continue;

    state.battleMarkers.push({
      id: genId(),
      type: "critical_front",
      x: totalX / count,
      y: totalY / count,
      radius: 6,
      createdAt: now,
      expiresAt: now + CRITICAL_FRONT_DURATION,
      opacity: 0.5,
      pulsePhase: 0,
    });
  }
}

// ── Front engagement intensity (hybrid: engaged units + attack_zone markers) ──

function computeRawEngagementForFront(state: GameState, front: Front): number {
  const bboxes: [number, number, number, number][] = [];
  for (const rid of front.regionIds) {
    const region = state.regions.get(rid);
    if (region) bboxes.push(region.bbox);
  }
  if (bboxes.length === 0) return 0;

  // Engaged units: live target within attack range, inside front bbox.
  // Counts BOTH teams (attacker + defender both add to "front is hot").
  let engagedInFront = 0;
  for (const u of state.units.values()) {
    if (u.state === "dead" || u.attackTarget == null) continue;
    const target = state.units.get(u.attackTarget);
    if (!target || target.state === "dead") continue;
    const dx = u.position.x - target.position.x;
    const dy = u.position.y - target.position.y;
    const dist = Math.sqrt(dx * dx + dy * dy);
    if (dist > (u.attackRange ?? 5) * 1.5) continue;

    const inFront = bboxes.some(([x1, y1, x2, y2]) =>
      u.position.x >= x1 && u.position.x <= x2 &&
      u.position.y >= y1 && u.position.y <= y2,
    );
    if (inFront) engagedInFront++;
  }

  // attack_zone markers within front bbox — boost from clustered combat
  let markersInFront = 0;
  for (const m of state.battleMarkers) {
    if (m.type !== "attack_zone") continue;
    const inFront = bboxes.some(([x1, y1, x2, y2]) =>
      m.x >= x1 && m.x <= x2 && m.y >= y1 && m.y <= y2,
    );
    if (inFront) markersInFront++;
  }

  const unitSignal = engagedInFront / ENGAGEMENT_UNIT_SAT;
  const markerSignal = markersInFront * ENGAGEMENT_MARKER_WEIGHT;
  return Math.min(1, unitSignal + markerSignal);
}

function updateFrontEngagement(state: GameState, dt: number, recomputeRaw: boolean): void {
  // EMA blend factor — dt-independent so frame rate doesn't change responsiveness
  const blend = 1 - Math.exp(-dt / ENGAGEMENT_TAU_SEC);

  for (const front of state.fronts) {
    if (recomputeRaw) {
      rawEngagementCache.set(front.id, computeRawEngagementForFront(state, front));
    }
    const raw = rawEngagementCache.get(front.id) ?? 0;
    front.engagementIntensity = front.engagementIntensity + (raw - front.engagementIntensity) * blend;
  }
}
