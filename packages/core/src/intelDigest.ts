// ============================================================
// AI Commander — Intel Digest Generator (Day 6)
// Generates DigestV1 from GameState for LLM consumption
// Computes front power from actual unit positions
// ============================================================

import type { GameState } from "@ai-commander/shared";
import { generateDigestV1 } from "@ai-commander/shared";

/**
 * Compute player/enemy power per front from actual unit positions.
 * Power = f(hp, attackDamage, attackInterval) for units in front regions.
 * Enemy units only counted if visible through fog.
 */
function updateFrontPower(state: GameState): void {
  for (const front of state.fronts) {
    const regionBboxes: [number, number, number, number][] = [];
    for (const rid of front.regionIds) {
      const region = state.regions.get(rid);
      if (region) regionBboxes.push(region.bbox);
    }

    let playerPower = 0;
    let enemyPower = 0;
    let enemyPowerKnown = false;

    state.units.forEach((unit) => {
      if (unit.state === "dead") return;

      const inFront = regionBboxes.some(
        ([x1, y1, x2, y2]) =>
          unit.position.x >= x1 &&
          unit.position.x <= x2 &&
          unit.position.y >= y1 &&
          unit.position.y <= y2,
      );
      if (!inFront) return;

      const interval = unit.attackInterval > 0 ? unit.attackInterval : 1;
      const power = (unit.hp / unit.maxHp) * unit.attackDamage / interval * 10;

      if (unit.team === "player") {
        playerPower += power;
      } else if (unit.team === "enemy") {
        const tx = Math.floor(unit.position.x);
        const ty = Math.floor(unit.position.y);
        if (state.fog[ty]?.[tx] === "visible") {
          enemyPower += power;
          enemyPowerKnown = true;
        }
      }
    });

    front.playerPower = Math.round(playerPower);
    front.enemyPower = Math.round(enemyPower);
    front.enemyPowerKnown = enemyPowerKnown;
  }
}

/**
 * Build the DigestV1 text to send to the LLM.
 * Updates front power from current unit positions before generating.
 */
export function buildDigest(
  state: GameState,
  selectedUnitIds: number[],
  markedTargets: { id: string; position: [number, number] }[],
  recentEvents: string[],
): string {
  updateFrontPower(state);
  return generateDigestV1(state, selectedUnitIds, markedTargets, recentEvents);
}
