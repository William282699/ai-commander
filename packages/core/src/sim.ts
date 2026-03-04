// ============================================================
// AI Commander — Simulation Tick (游戏主循环)
// Pure function: tick(state, dt) → mutates state
// ============================================================

import type { GameState, Unit, UnitType } from "@ai-commander/shared";
import {
  TERRAIN_MOVE_MULT,
  TANK_BLOCKED_TERRAIN,
  INFANTRY_BLOCKED_TERRAIN,
  getUnitCategory,
} from "@ai-commander/shared";
import { processCombat } from "./combat";

/**
 * Check if a unit type can enter a specific tile.
 * Considers both category-level passability and type-specific restrictions
 * (e.g. tanks blocked by forest/swamp).
 */
export function canUnitEnterTile(
  unitType: UnitType,
  tileX: number,
  tileY: number,
  state: GameState,
): boolean {
  if (tileX < 0 || tileX >= state.mapWidth || tileY < 0 || tileY >= state.mapHeight) {
    return false;
  }

  const terrain = state.terrain[tileY][tileX];
  const cat = getUnitCategory(unitType);

  // Category-level: check terrain movement multiplier
  const mult = TERRAIN_MOVE_MULT[terrain]?.[cat] ?? 0;
  if (mult <= 0) return false;

  // Type-specific: tanks (including artillery) can't enter forest/swamp etc.
  if (
    unitType === "light_tank" ||
    unitType === "main_tank" ||
    unitType === "artillery"
  ) {
    if ((TANK_BLOCKED_TERRAIN as readonly string[]).includes(terrain)) return false;
  }

  // Infantry restrictions (mostly redundant with mult=0, but explicit)
  if (unitType === "infantry") {
    if ((INFANTRY_BLOCKED_TERRAIN as readonly string[]).includes(terrain)) return false;
  }

  return true;
}

/** Grace period: dead units stay for 1 frame so explosion effects can reference position */
const DEAD_CLEANUP_DELAY = 0.1; // seconds

/**
 * Advance game state by dt seconds.
 * Called ~60 times/sec from the game loop.
 */
export function tick(state: GameState, dt: number): void {
  if (state.gameOver) return;

  state.time += dt;
  state.tick++;

  // 1. Move units toward their targets (skip units that are attacking in place)
  state.units.forEach((unit) => {
    if (unit.hp <= 0) {
      unit.state = "dead";
      return;
    }
    if (
      unit.state === "moving" ||
      unit.state === "retreating" ||
      unit.state === "patrolling"
    ) {
      moveUnit(unit, dt, state);
    }
  });

  // 2. Combat: auto-target, fire, apply damage, create effects
  processCombat(state, dt);

  // 3. Remove dead units (after a short grace period for effects)
  const deadIds: number[] = [];
  state.units.forEach((unit) => {
    if (unit.state === "dead" && unit.hp <= 0) {
      deadIds.push(unit.id);
    }
  });
  for (const id of deadIds) {
    state.units.delete(id);
  }
}

function moveUnit(unit: Unit, dt: number, state: GameState): void {
  if (!unit.target) return;

  const dx = unit.target.x - unit.position.x;
  const dy = unit.target.y - unit.position.y;
  const dist = Math.sqrt(dx * dx + dy * dy);

  if (dist < 0.1) {
    // Arrived at current target
    unit.position = { ...unit.target };

    if (unit.state === "patrolling" && unit.patrolPoints.length >= 2) {
      unit.patrolPoints.reverse();
      unit.target = unit.patrolPoints[1];
    } else if (unit.waypoints.length > 1) {
      unit.waypoints.shift();
      unit.target = unit.waypoints[0];
    } else {
      unit.target = null;
      unit.waypoints = [];
      if (unit.state !== "patrolling") {
        unit.state = "idle";
      }
    }
    return;
  }

  // Current tile terrain speed modifier
  const tileX = Math.floor(unit.position.x);
  const tileY = Math.floor(unit.position.y);
  let speedMult = 1.0;
  if (
    tileY >= 0 &&
    tileY < state.mapHeight &&
    tileX >= 0 &&
    tileX < state.mapWidth
  ) {
    const terrain = state.terrain[tileY][tileX];
    const cat = getUnitCategory(unit.type);
    speedMult = TERRAIN_MOVE_MULT[terrain]?.[cat] ?? 0;
  }

  if (speedMult <= 0) {
    // Stuck on impassable terrain — abort
    unit.target = null;
    unit.waypoints = [];
    unit.state = "idle";
    return;
  }

  const speed = unit.moveSpeed * speedMult * dt;
  const step = Math.min(speed, dist);
  const nx = dx / dist;
  const ny = dy / dist;

  const newX = unit.position.x + nx * step;
  const newY = unit.position.y + ny * step;

  // Check if entering a new tile
  const newTileX = Math.floor(newX);
  const newTileY = Math.floor(newY);

  if (newTileX !== tileX || newTileY !== tileY) {
    // About to enter a new tile — check passability
    if (!canUnitEnterTile(unit.type, newTileX, newTileY, state)) {
      // Blocked — stop movement
      unit.target = null;
      unit.waypoints = [];
      unit.state = "idle";
      return;
    }
  }

  unit.position.x = newX;
  unit.position.y = newY;
}
