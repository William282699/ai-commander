#!/usr/bin/env npx tsx
/**
 * Day 13 P1-3: Regression guard for processFacilitySabotage.
 * Verifies that units with attackDamage=0 or attackInterval=0
 * do NOT produce sabotage damage to facilities.
 *
 * Run: npx tsx scripts/test-sabotage-guard.ts
 */

import { createInitialGameState } from "@ai-commander/core";
import { processCombat } from "@ai-commander/core";
import { UNIT_STATS } from "@ai-commander/shared";

function assert(cond: boolean, msg: string) {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    process.exit(1);
  }
  console.log(`PASS: ${msg}`);
}

// Create a real game state (has facilities, terrain, fog, etc.)
const state = createInitialGameState();

// Find an enemy facility to target
let targetFac: typeof state extends { facilities: Map<string, infer F> } ? F : never;
for (const [, fac] of state.facilities) {
  if (fac.team === "enemy" && fac.hp > 0) {
    targetFac = fac;
    break;
  }
}
assert(targetFac! !== undefined, "Found an enemy facility to target");

const initialHp = targetFac!.hp;

// --- Test 1: attackDamage=0 unit should not deal sabotage damage ---
const reconPlaneStats = UNIT_STATS["recon_plane"];
assert(reconPlaneStats.attack === 0, "recon_plane has 0 attack");

// Create a fake recon_plane unit right next to the facility with a sabotage order
const fakeUnitId = 99999;
const fakeUnit = {
  id: fakeUnitId,
  type: "recon_plane" as const,
  team: "player" as const,
  hp: 50,
  maxHp: 50,
  position: { x: targetFac!.position.x, y: targetFac!.position.y },
  state: "idle" as const,
  target: null,
  attackTarget: null,
  visionRange: 15,
  attackRange: reconPlaneStats.range,
  attackDamage: reconPlaneStats.attack, // 0
  attackInterval: reconPlaneStats.attackInterval, // 0
  moveSpeed: 10,
  lastAttackTime: -999,
  manualOverride: false,
  detourCount: 0,
  waypoints: [],
  patrolPoints: [],
  orders: [{
    unitIds: [fakeUnitId],
    action: "sabotage" as const,
    target: { x: targetFac!.position.x, y: targetFac!.position.y },
    targetFacilityId: targetFac!.id,
    priority: "high" as const,
  }],
  patrolTaskId: null,
};

state.units.set(fakeUnitId, fakeUnit as any);

// Run combat for several ticks
for (let i = 0; i < 10; i++) {
  processCombat(state, 1.0);
}

assert(
  targetFac!.hp === initialHp,
  `Facility HP unchanged after recon_plane sabotage (${targetFac!.hp} === ${initialHp})`,
);

// --- Test 2: normal infantry unit SHOULD deal sabotage damage ---
const infantryStats = UNIT_STATS["infantry"];
assert(infantryStats.attack > 0, "infantry has positive attack");

const fakeInfId = 99998;
const fakeInfantry = {
  id: fakeInfId,
  type: "infantry" as const,
  team: "player" as const,
  hp: 60,
  maxHp: 60,
  position: { x: targetFac!.position.x + 0.5, y: targetFac!.position.y },
  state: "idle" as const,
  target: null,
  attackTarget: null,
  visionRange: 5,
  attackRange: infantryStats.range,
  attackDamage: infantryStats.attack,
  attackInterval: infantryStats.attackInterval,
  moveSpeed: 2,
  lastAttackTime: -999,
  manualOverride: false,
  detourCount: 0,
  waypoints: [],
  patrolPoints: [],
  orders: [{
    unitIds: [fakeInfId],
    action: "sabotage" as const,
    target: { x: targetFac!.position.x, y: targetFac!.position.y },
    targetFacilityId: targetFac!.id,
    priority: "high" as const,
  }],
  patrolTaskId: null,
};

state.units.set(fakeInfId, fakeInfantry as any);

// Remove enemy units near the facility so main combat loop doesn't consume cooldown
for (const [uid, u] of state.units) {
  if (u.team === "enemy" && uid !== fakeInfId) {
    const edx = u.position.x - targetFac!.position.x;
    const edy = u.position.y - targetFac!.position.y;
    if (Math.sqrt(edx * edx + edy * edy) < 10) {
      state.units.delete(uid);
    }
  }
}

// Advance time enough ticks so sabotage cooldown fires
for (let i = 0; i < 10; i++) {
  state.time = 100 + i * 2;
  processCombat(state, 1.0);
}

assert(
  targetFac!.hp < initialHp,
  `Facility HP decreased after infantry sabotage (${targetFac!.hp} < ${initialHp})`,
);

// Cleanup
state.units.delete(fakeUnitId);
state.units.delete(fakeInfId);

console.log("\nAll sabotage guard tests passed!");
