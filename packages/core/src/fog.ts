// ============================================================
// AI Commander — Fog of War
// Three visibility layers: unknown → explored → visible
// ============================================================

import type { GameState, Visibility } from "@ai-commander/shared";
import { MAP_WIDTH, MAP_HEIGHT, getUnitCategory } from "@ai-commander/shared";

/**
 * Create initial fog state (all unknown).
 */
export function createFogState(): Visibility[][] {
  return Array.from({ length: MAP_HEIGHT }, () =>
    Array.from({ length: MAP_WIDTH }, () => "unknown" as Visibility),
  );
}

/**
 * Update fog based on player unit positions and vision ranges.
 * Called every frame:
 *   1. Reset all "visible" → "explored" (units moved, old vision fades)
 *   2. Mark tiles within each player unit's vision radius as "visible"
 *
 * Special rules:
 *   - Ground units in forest: vision range −2 (min 1)
 */
export function updateFog(state: GameState): void {
  const { fog, mapWidth, mapHeight } = state;

  // Pass 1: visible → explored
  for (let y = 0; y < mapHeight; y++) {
    for (let x = 0; x < mapWidth; x++) {
      if (fog[y][x] === "visible") {
        fog[y][x] = "explored";
      }
    }
  }

  // Pass 2: mark player unit vision
  state.units.forEach((unit) => {
    if (unit.team !== "player") return;
    if (unit.state === "dead") return;

    const cx = Math.floor(unit.position.x);
    const cy = Math.floor(unit.position.y);

    // Base vision range
    let r = unit.visionRange;

    // Forest penalty for ground units
    if (cx >= 0 && cx < mapWidth && cy >= 0 && cy < mapHeight) {
      const terrain = state.terrain[cy][cx];
      if (terrain === "forest" && getUnitCategory(unit.type) === "ground") {
        r = Math.max(1, r - 2);
      }
    }

    // Reveal tiles in circular radius
    const rSq = r * r;
    const yMin = Math.max(0, cy - r);
    const yMax = Math.min(mapHeight - 1, cy + r);
    const xMin = Math.max(0, cx - r);
    const xMax = Math.min(mapWidth - 1, cx + r);

    for (let ty = yMin; ty <= yMax; ty++) {
      for (let tx = xMin; tx <= xMax; tx++) {
        const ddx = tx - cx;
        const ddy = ty - cy;
        if (ddx * ddx + ddy * ddy <= rSq) {
          fog[ty][tx] = "visible";
        }
      }
    }
  });
}
