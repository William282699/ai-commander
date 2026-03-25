// ============================================================
// Battle Awareness — visual markers for attack zones, deaths, critical fronts
// Pure logic: reads/writes only state.battleMarkers, state.recentDeaths,
// state.battleMarkerScanAccum. Does NOT touch any other system.
// ============================================================

import type { GameState, BattleMarker } from "@ai-commander/shared";

const SCAN_INTERVAL = 3; // seconds between full scans
const DEATH_MARKER_DURATION = 10; // seconds before death marker expires
const ATTACK_ZONE_DURATION = 8; // seconds before attack zone expires
const CRITICAL_FRONT_DURATION = 6; // seconds before critical front marker expires
const MAX_MARKERS = 50;
const MAX_RECENT_DEATHS = 100;
const ATTACK_ZONE_CLUSTER_RADIUS = 5; // tiles — units within this range form a cluster
const CRITICAL_FRONT_POWER_RATIO = 2.0;

let nextMarkerId = 0;
function genId(): string {
  return `bm_${++nextMarkerId}`;
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
  if (state.battleMarkerScanAccum >= SCAN_INTERVAL) {
    state.battleMarkerScanAccum -= SCAN_INTERVAL;
    generateAttackZoneMarkers(state, now);
    generateCriticalFrontMarkers(state, now);
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
