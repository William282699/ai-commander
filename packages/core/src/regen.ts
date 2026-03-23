// ============================================================
// AI Commander — Regeneration System (MVP2)
// Commander unit HP regen + HQ repair
// ============================================================

import type { GameState } from "@ai-commander/shared";
import { UNIT_STATS } from "@ai-commander/shared";

// --- Commander Regen Constants ---
const COMMANDER_REGEN_DELAY = 15; // seconds out of combat before regen starts
const COMMANDER_REGEN_RATE = 30;  // hp per second

// --- HQ Regen Constants ---
const HQ_REGEN_DELAY = 10;       // seconds out of combat before regen starts
const HQ_REGEN_RATE = 50;        // hp per second
const HQ_REGEN_COST_PER_SEC = 3; // money per second of regen

/**
 * Process regeneration for commander units and HQ facilities.
 * Called once per tick after processCombat.
 */
export function processRegen(state: GameState, dt: number): void {
  const now = state.time;

  // --- Commander unit regen ---
  state.units.forEach((unit) => {
    if (unit.type !== "commander") return;
    if (unit.hp <= 0 || unit.state === "dead") return;

    const maxHp = UNIT_STATS.commander.hp;
    if (unit.hp >= maxHp) return;

    const lastDamaged = unit.lastDamagedAt ?? 0;
    if (now - lastDamaged < COMMANDER_REGEN_DELAY) return;

    unit.hp = Math.min(maxHp, unit.hp + COMMANDER_REGEN_RATE * dt);
  });

  // --- HQ regen (costs money) ---
  for (const [, facility] of state.facilities) {
    if (facility.type !== "headquarters") continue;
    if (facility.hp <= 0 || facility.hp >= facility.maxHp) continue;

    const lastDamaged = facility.lastDamagedAt ?? 0;
    if (now - lastDamaged < HQ_REGEN_DELAY) continue;

    const teamKey = facility.team === "player" ? "player" : "enemy" as const;
    const eco = state.economy[teamKey];

    // Check if team can afford regen
    const costThisTick = HQ_REGEN_COST_PER_SEC * dt;
    if (eco.resources.money < costThisTick) continue;

    // Deduct cost and heal
    eco.resources.money -= costThisTick;
    facility.hp = Math.min(facility.maxHp, facility.hp + HQ_REGEN_RATE * dt);
  }
}
