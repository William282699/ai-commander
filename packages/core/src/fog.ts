// ============================================================
// AI Commander — Fog of War (stub for Day 3)
// ============================================================

import type { GameState, Visibility } from "@ai-commander/shared";
import { MAP_WIDTH, MAP_HEIGHT } from "@ai-commander/shared";

/**
 * Create initial fog state (all unknown).
 */
export function createFogState(): Visibility[][] {
  return Array.from({ length: MAP_HEIGHT }, () =>
    Array.from({ length: MAP_WIDTH }, () => "unknown" as Visibility)
  );
}

/**
 * Update fog based on player unit positions and vision ranges.
 */
export function updateFog(state: GameState): void {
  // Reset visible → explored (keeps explored tiles)
  for (let y = 0; y < state.mapHeight; y++) {
    for (let x = 0; x < state.mapWidth; x++) {
      if (state.fog[y][x] === "visible") {
        state.fog[y][x] = "explored";
      }
    }
  }

  // Mark tiles in player unit vision as visible
  state.units.forEach(unit => {
    if (unit.team !== "player") return;
    if (unit.state === "dead") return;
    const r = unit.visionRange;
    const cx = Math.floor(unit.position.x);
    const cy = Math.floor(unit.position.y);

    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (dx * dx + dy * dy > r * r) continue;
        const tx = cx + dx;
        const ty = cy + dy;
        if (tx >= 0 && tx < state.mapWidth && ty >= 0 && ty < state.mapHeight) {
          state.fog[ty][tx] = "visible";
        }
      }
    }
  });
}
