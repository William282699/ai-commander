// ============================================================
// AI Commander — Movement Rules
// Extracted from sim.ts to break circular dependency: sim → pathfinding → sim
// ============================================================

import type { GameState, UnitType } from "@ai-commander/shared";
import {
  TERRAIN_MOVE_MULT,
  TANK_BLOCKED_TERRAIN,
  INFANTRY_BLOCKED_TERRAIN,
  getUnitCategory,
} from "@ai-commander/shared";

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
