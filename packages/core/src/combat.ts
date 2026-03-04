// ============================================================
// AI Commander — Combat System (stub for Day 4)
// ============================================================

import type { GameState, Unit } from "@ai-commander/shared";
import { COUNTER_MATRIX, AMMO_PER_ATTACK, AMMO_EMPTY_FIRE_MULT } from "@ai-commander/shared";

/**
 * Calculate damage from attacker to defender.
 */
export function calculateDamage(attacker: Unit, defender: Unit, state: GameState): number {
  const counter = COUNTER_MATRIX[attacker.type]?.[defender.type] ?? 0;
  if (counter === 0) return 0; // cannot attack this type

  let damage = attacker.attackDamage * counter;

  // Ammo penalty
  const ammo = state.economy[attacker.team === "player" ? "player" : "enemy"].resources.ammo;
  if (ammo <= 0) {
    damage *= AMMO_EMPTY_FIRE_MULT;
  }

  return Math.round(damage);
}

/**
 * Process combat for all units in range. (stub — Day 4 fills this in)
 */
export function processCombat(_state: GameState, _dt: number): void {
  // TODO: Day 4 — auto-target, fire, apply damage
}
