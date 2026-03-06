// ============================================================
// AI Commander — Auto-Behavior System (Day 8)
// Team-agnostic micro-level unit autonomy (2s interval)
// Directly mutates unit state (no Order[] generation).
//
// FIXED priority order (top-down short-circuit):
//   1. manualOverride guard — ABSOLUTE, no exceptions
//   2. lowHP emergency retreat (hp < 25%, overrides C1 active-orders)
//   3. active orders skip (unit.orders.length > 0 is PRIMARY check)
//   4. engage / patrol
//
// Constraints enforced: C1, C2, C3, C4, C5
// ============================================================

import type { GameState, Unit, Position, Team } from "@ai-commander/shared";
import { getUnitCategory } from "@ai-commander/shared";
import { canUnitEnterTile } from "./sim";

// ── Timer (C2: while-loop, no setInterval) ──

const AUTO_BEHAVIOR_INTERVAL = 2.0; // seconds
let autoBehaviorTimer = 0;

const LOW_HP_THRESHOLD = 0.25;   // 25% maxHP
const ENGAGE_RANGE = 8;          // tiles
const PATROL_RANGE = 5;          // tiles

// ── Main entry ──

export function processAutoBehavior(state: GameState, dt: number): void {
  autoBehaviorTimer += dt;

  // C2: while-loop prevents timer drift on frame drops
  while (autoBehaviorTimer >= AUTO_BEHAVIOR_INTERVAL) {
    autoBehaviorTimer -= AUTO_BEHAVIOR_INTERVAL;
    runAutoBehavior(state);
  }
}

function runAutoBehavior(state: GameState): void {
  state.units.forEach((unit) => {
    if (unit.hp <= 0 || unit.state === "dead") return;

    // ── Priority 1: manualOverride guard (ABSOLUTE, no exceptions) ──
    if (unit.team === "player" && unit.manualOverride) return;

    // ── Priority 2: lowHP emergency retreat ──
    // Overrides C1 (active orders), but NOT manualOverride (already filtered above)
    if (unit.hp / unit.maxHp < LOW_HP_THRESHOLD && unit.state !== "retreating") {
      const hqPos = findTeamHQ(state, unit.team);
      const dx = hqPos.x - unit.position.x;
      const dy = hqPos.y - unit.position.y;
      const dist = Math.sqrt(dx * dx + dy * dy);

      // Already near HQ? Don't retreat further
      if (dist < 5) return;

      const retreatDist = Math.min(15, dist * 0.5);
      let target: Position;
      if (dist < 1) {
        target = { ...hqPos };
      } else {
        target = {
          x: Math.round(unit.position.x + (dx / dist) * retreatDist),
          y: Math.round(unit.position.y + (dy / dist) * retreatDist),
        };
      }

      // C3: clamp to map bounds
      target.x = Math.max(0, Math.min(state.mapWidth - 1, target.x));
      target.y = Math.max(0, Math.min(state.mapHeight - 1, target.y));

      // Passability check
      if (!canUnitEnterTile(unit.type, target.x, target.y, state)) {
        const safe = findPassableNearby(unit, target, state);
        if (!safe) return; // Can't find safe retreat point, stay put
        target = safe;
      }

      // Direct state mutation (micro-level, no Order[])
      unit.state = "retreating";
      unit.target = target;
      unit.waypoints = [target];
      unit.attackTarget = null;
      return; // Short-circuit
    }

    // ── Priority 3: active orders skip (C1 PRIMARY check) ──
    // unit.orders.length > 0 is the primary check.
    // State checks are advisory only, never override C1/C5.
    if (unit.orders.length > 0) return;

    // ── Priority 4: engage / patrol ──

    // 4a: Auto-engage — idle/patrolling/defending unit with enemy in range
    if (unit.state === "idle" || unit.state === "patrolling" || unit.state === "defending") {
      const enemy = findNearestEnemy(unit, state, ENGAGE_RANGE);
      if (enemy) {
        unit.state = "moving";
        unit.target = { x: enemy.position.x, y: enemy.position.y };
        unit.waypoints = [{ x: enemy.position.x, y: enemy.position.y }];
        unit.attackTarget = null; // combat.ts will acquire target when in range
        return;
      }
    }

    // 4b: Idle patrol — idle unit with no enemy in vision range
    if (unit.state === "idle") {
      const hasEnemyInVision = findNearestEnemy(unit, state, unit.visionRange) !== null;
      if (!hasEnemyInVision) {
        const patrolTarget = randomPatrolPoint(unit, state, PATROL_RANGE);
        if (patrolTarget) {
          unit.state = "patrolling";
          unit.patrolPoints = [{ ...unit.position }, patrolTarget];
          unit.target = patrolTarget;
          unit.waypoints = [patrolTarget];
        }
        // C3: if no valid patrol point found, stay idle (hold) — no illegal target
      }
    }
  });
}

// ── Helpers ──

/**
 * Find nearest enemy unit within maxRange tiles.
 * For player units, only finds enemies visible in fog.
 * For enemy units, finds all player units (enemy has "omniscient" local awareness).
 */
function findNearestEnemy(unit: Unit, state: GameState, maxRange: number): Unit | null {
  let best: Unit | null = null;
  let bestDist = maxRange * maxRange; // Compare squared distances

  state.units.forEach((other) => {
    if (other.team === unit.team) return;
    if (other.hp <= 0 || other.state === "dead") return;

    // Player units can only engage visible enemies
    if (unit.team === "player") {
      const tx = Math.floor(other.position.x);
      const ty = Math.floor(other.position.y);
      if (state.fog[ty]?.[tx] !== "visible") return;
    }

    const dx = other.position.x - unit.position.x;
    const dy = other.position.y - unit.position.y;
    const d2 = dx * dx + dy * dy;

    if (d2 < bestDist) {
      bestDist = d2;
      best = other;
    }
  });

  return best;
}

/**
 * Find team HQ position.
 * C4: safe fallback if HQ facility not found.
 * Player fallback: (5, 5). Enemy fallback: (mapWidth-5, mapHeight-5).
 */
function findTeamHQ(state: GameState, team: Team): Position {
  for (const [, fac] of state.facilities) {
    if (fac.type === "headquarters" && fac.team === team) {
      return { x: fac.position.x, y: fac.position.y };
    }
  }

  // C4 fallback
  if (team === "player") {
    return { x: 5, y: 5 };
  }
  return { x: state.mapWidth - 5, y: state.mapHeight - 5 };
}

/**
 * Generate random patrol point within range tiles.
 * C3: clamp to map bounds + canUnitEnterTile validation.
 * Returns null if no valid point found after 6 attempts → caller keeps unit idle.
 */
function randomPatrolPoint(unit: Unit, state: GameState, range: number): Position | null {
  for (let attempt = 0; attempt < 6; attempt++) {
    const dx = Math.round((Math.random() * 2 - 1) * range);
    const dy = Math.round((Math.random() * 2 - 1) * range);

    // C3: clamp to map bounds
    const x = Math.max(0, Math.min(state.mapWidth - 1, Math.round(unit.position.x + dx)));
    const y = Math.max(0, Math.min(state.mapHeight - 1, Math.round(unit.position.y + dy)));

    // Skip trivial moves
    if (x === Math.round(unit.position.x) && y === Math.round(unit.position.y)) continue;

    if (canUnitEnterTile(unit.type, x, y, state)) {
      return { x, y };
    }
  }

  return null; // No valid point → stay idle (hold)
}

/**
 * Find passable tile near target via spiral search. Max 8 tiles radius.
 * C3: clamp + canUnitEnterTile. Returns null if nothing found.
 */
function findPassableNearby(unit: Unit, target: Position, state: GameState): Position | null {
  for (let r = 1; r <= 8; r++) {
    for (let dx = -r; dx <= r; dx++) {
      for (let dy = -r; dy <= r; dy++) {
        if (Math.abs(dx) !== r && Math.abs(dy) !== r) continue;
        const x = Math.max(0, Math.min(state.mapWidth - 1, target.x + dx));
        const y = Math.max(0, Math.min(state.mapHeight - 1, target.y + dy));
        if (canUnitEnterTile(unit.type, x, y, state)) {
          return { x, y };
        }
      }
    }
  }
  return null;
}
