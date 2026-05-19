// ============================================================
// AI Commander — Fog of War
// Three visibility layers: unknown → explored → visible
// ============================================================

import type { GameState, Visibility, Unit, Facility, UnitType } from "@ai-commander/shared";
import { getUnitCategory } from "@ai-commander/shared";

// ============================================================
// El Alamein scenario vision overrides
//
// The default UNIT_STATS visions (infantry=5, main_tank=5 ...) feel "blind"
// on the 500×300 El Alamein map. Boost vision per-scenario without mutating
// UNIT_STATS (other scenarios stay untouched). Helpers are consulted by
// updateFog only — engagement/chase still use raw unit.visionRange, so
// vision > engagement is by design.
// ============================================================

const EL_ALAMEIN_UNIT_VISION: Partial<Record<UnitType, number>> = {
  infantry: 15,
  light_tank: 18,
  main_tank: 15,
  artillery: 16,
  commander: 20,
  elite_guard: 16,
  fighter: 20,
  bomber: 14,
  recon_plane: 45,
};

function getScenarioUnitVision(state: GameState, unit: Unit): number {
  if (state.scenarioId === "el_alamein") {
    return EL_ALAMEIN_UNIT_VISION[unit.type] ?? unit.visionRange;
  }
  return unit.visionRange;
}

function getScenarioFacilityVision(state: GameState, fac: Facility): number {
  if (state.scenarioId === "el_alamein") {
    // Per-type baseline.
    let base: number;
    if (fac.type === "headquarters") base = 30;
    else if (fac.type === "radar") base = 45;
    else base = 18;

    // Captured Axis objective bonus: holding key terrain pays off with at
    // least 2x normal ground-unit vision (infantry/main_tank=15 → floor 30).
    // Radar-type objectives already exceed 30 via their type default; this
    // floor mainly lifts comm_tower-typed objectives like ea_alamein_town
    // (18 → 30). Pre-capture (team !== "player") this branch doesn't apply
    // because the outer updateFog loop already skips non-player facilities.
    const isCapturedObjective =
      fac.team === "player" &&
      (state.captureObjectives?.includes(fac.id) ?? false);
    if (isCapturedObjective) {
      return Math.max(base, 30);
    }
    return base;
  }
  if (fac.type === "headquarters") return 10;
  if (fac.type === "radar") return 20;
  return 6;
}

/**
 * Create initial fog state (all unknown).
 * Width and height are required — no default to avoid silent mismatch on new scenarios.
 */
export function createFogState(width: number, height: number): Visibility[][] {
  return Array.from({ length: height }, () =>
    Array.from({ length: width }, () => "unknown" as Visibility),
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

    // Base vision range (scenario-aware; forest penalty still applies below)
    let r = getScenarioUnitVision(state, unit);

    // Forest penalty for ground units
    if (cx >= 0 && cx < mapWidth && cy >= 0 && cy < mapHeight) {
      const terrain = state.terrain[cy][cx];
      if (terrain === "forest" && getUnitCategory(unit.type) === "ground") {
        r = Math.max(1, r - 2);
      }
    }

    revealCircle(fog, cx, cy, r, mapWidth, mapHeight);
  });

  // Pass 3: mark player facility vision (base area shouldn't be dark)
  state.facilities.forEach((fac) => {
    if (fac.team !== "player") return;
    if (fac.hp <= 0) return;

    const cx = Math.floor(fac.position.x);
    const cy = Math.floor(fac.position.y);

    // Radar gives large vision; other owned buildings provide local vision.
    // El Alamein boosts these radii via getScenarioFacilityVision.
    const r = getScenarioFacilityVision(state, fac);

    revealCircle(fog, cx, cy, r, mapWidth, mapHeight);
  });
}

function revealCircle(
  fog: Visibility[][],
  cx: number,
  cy: number,
  r: number,
  mapWidth: number,
  mapHeight: number,
): void {
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
}
