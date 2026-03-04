// ============================================================
// AI Commander — Simulation Tick (游戏主循环)
// Pure function: tick(state, dt) → mutates state
// ============================================================

import type { GameState, Unit, Position } from "@ai-commander/shared";
import { TERRAIN_MOVE_MULT, getUnitCategory } from "@ai-commander/shared";

/**
 * Advance game state by dt seconds.
 * Called ~60 times/sec from the game loop.
 */
export function tick(state: GameState, dt: number): void {
  if (state.gameOver) return;

  state.time += dt;
  state.tick++;

  // Move units toward their targets
  state.units.forEach(unit => {
    if (unit.hp <= 0) {
      unit.state = "dead";
      return;
    }
    if (unit.state === "moving" || unit.state === "retreating" || unit.state === "patrolling") {
      moveUnit(unit, dt, state);
    }
  });

  // Remove dead units
  const deadIds: number[] = [];
  state.units.forEach(unit => {
    if (unit.state === "dead") deadIds.push(unit.id);
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
    // Arrived
    unit.position = { ...unit.target };
    if (unit.state === "patrolling" && unit.patrolPoints.length >= 2) {
      // Swap patrol direction
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

  // Terrain speed modifier
  const tileX = Math.floor(unit.position.x);
  const tileY = Math.floor(unit.position.y);
  let speedMult = 1.0;
  if (tileY >= 0 && tileY < state.mapHeight && tileX >= 0 && tileX < state.mapWidth) {
    const terrain = state.terrain[tileY][tileX];
    const cat = getUnitCategory(unit.type);
    speedMult = TERRAIN_MOVE_MULT[terrain]?.[cat] ?? 0;
  }

  if (speedMult <= 0) {
    // Can't move on this terrain — stop
    unit.target = null;
    unit.state = "idle";
    return;
  }

  const speed = unit.moveSpeed * speedMult * dt;
  const nx = dx / dist;
  const ny = dy / dist;

  unit.position.x += nx * speed;
  unit.position.y += ny * speed;
}
