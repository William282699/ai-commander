// ============================================================
// AI Commander — Combat System (Day 4)
// Auto-engagement, damage calc, terrain defense, death handling
// ============================================================

import type { GameState, Unit, Facility, TerrainType } from "@ai-commander/shared";
import {
  COUNTER_MATRIX,
  AMMO_PER_ATTACK,
  AMMO_EMPTY_FIRE_MULT,
  TERRAIN_DEFENSE_BONUS,
  getUnitCategory,
} from "@ai-commander/shared";

// --- Distance helper ---

function distBetween(a: Unit, b: Unit): number {
  const dx = a.position.x - b.position.x;
  const dy = a.position.y - b.position.y;
  return Math.sqrt(dx * dx + dy * dy);
}

// --- Can this attacker type hit this defender type at all? ---

function canAttackType(attackerType: string, defenderType: string): boolean {
  return (COUNTER_MATRIX[attackerType as keyof typeof COUNTER_MATRIX]?.[defenderType as keyof typeof COUNTER_MATRIX] ?? 0) > 0;
}

// --- Terrain defense multiplier (returns damage multiplier, e.g. 0.5 = 50% reduction) ---

function getTerrainDefenseMult(
  defender: Unit,
  terrain: TerrainType[][],
  mapWidth: number,
  mapHeight: number,
): number {
  const tx = Math.floor(defender.position.x);
  const ty = Math.floor(defender.position.y);
  if (tx < 0 || tx >= mapWidth || ty < 0 || ty >= mapHeight) return 1.0;

  const t = terrain[ty][tx];
  const cat = getUnitCategory(defender.type);

  // Infantry-only cover rules for urban/forest.
  if ((t === "urban" || t === "forest") && defender.type !== "infantry") {
    return 1.0;
  }

  const bonus = TERRAIN_DEFENSE_BONUS[t]?.[cat] ?? 0;
  return 1.0 - bonus; // e.g. 0.5 bonus → take 50% damage
}

function isTileVisibleToPlayer(state: GameState, tileX: number, tileY: number): boolean {
  if (tileX < 0 || tileX >= state.mapWidth || tileY < 0 || tileY >= state.mapHeight) {
    return false;
  }
  return state.fog[tileY]?.[tileX] === "visible";
}

function isUnitVisibleToPlayer(state: GameState, unit: Unit): boolean {
  const tx = Math.floor(unit.position.x);
  const ty = Math.floor(unit.position.y);
  return isTileVisibleToPlayer(state, tx, ty);
}

// --- Main tank frontal armor: +25% damage reduction when defender is main_tank ---

function getFrontalArmorMult(defender: Unit): number {
  if (defender.type === "main_tank") return 0.75;
  return 1.0;
}

/**
 * Calculate damage from attacker to defender, including:
 * - Base damage × counter multiplier
 * - Terrain defense reduction
 * - Main tank frontal armor
 * - Ammo depletion penalty
 */
export function calculateDamage(attacker: Unit, defender: Unit, state: GameState): number {
  const counter = COUNTER_MATRIX[attacker.type]?.[defender.type] ?? 0;
  if (counter === 0) return 0; // cannot attack this type

  let damage = attacker.attackDamage * counter;

  // Terrain defense
  damage *= getTerrainDefenseMult(
    defender,
    state.terrain,
    state.mapWidth,
    state.mapHeight,
  );

  // Frontal armor
  damage *= getFrontalArmorMult(defender);

  // Ammo penalty
  const ecoKey = attacker.team === "player" ? "player" : "enemy" as const;
  const ammo = state.economy[ecoKey].resources.ammo;
  if (ammo <= 0) {
    damage *= AMMO_EMPTY_FIRE_MULT;
  }

  return Math.max(1, Math.round(damage));
}

/**
 * Find the best target for a unit among all enemies in range.
 * Priority: currently targeted unit (sticky) > closest enemy that we can damage.
 */
function findTarget(unit: Unit, state: GameState): Unit | null {
  // Units that can't attack (recon_plane, carrier with 0 attack)
  if (unit.attackDamage <= 0 || unit.attackInterval <= 0) return null;
  const requiresVisibleTargets = unit.team === "player";

  // Artillery: "no_move_attack" — only attacks while idle/defending/attacking (not while moving)
  if (unit.type === "artillery" && (unit.state === "moving" || unit.state === "retreating")) {
    return null;
  }

  let bestTarget: Unit | null = null;
  let bestDist = Infinity;

  // Sticky target: if we already have an attackTarget and it's valid, prefer it
  if (unit.attackTarget !== null) {
    const current = state.units.get(unit.attackTarget);
    if (
      current &&
      current.hp > 0 &&
      current.state !== "dead" &&
      current.team !== unit.team &&
      (!requiresVisibleTargets || isUnitVisibleToPlayer(state, current)) &&
      distBetween(unit, current) <= unit.attackRange &&
      canAttackType(unit.type, current.type)
    ) {
      return current;
    }
    // Target lost/dead/out of range — clear it
    unit.attackTarget = null;
  }

  // Scan all enemy units in range
  state.units.forEach((other) => {
    if (other.team === unit.team) return;
    if (other.hp <= 0 || other.state === "dead") return;
    if (!canAttackType(unit.type, other.type)) return;
    if (requiresVisibleTargets && !isUnitVisibleToPlayer(state, other)) return;

    const d = distBetween(unit, other);
    if (d > unit.attackRange) return;

    if (d < bestDist) {
      bestDist = d;
      bestTarget = other;
    }
  });

  return bestTarget;
}

/**
 * Process combat for all units: auto-target, fire on cooldown, apply damage.
 * Also creates visual effects (attack lines and explosions).
 */
export function processCombat(state: GameState, dt: number): void {
  const now = state.time;

  state.units.forEach((unit) => {
    if (unit.hp <= 0 || unit.state === "dead") return;

    // Find target
    const target = findTarget(unit, state);

    if (!target) {
      // No target — if we were attacking, go idle (unless we have a move order)
      if (unit.state === "attacking") {
        unit.attackTarget = null;
        // Resume movement if we have a target position
        if (unit.target) {
          unit.state = "moving";
        } else {
          unit.state = "idle";
        }
      }
      return;
    }

    // We have a target — set attacking state
    unit.attackTarget = target.id;

    // If unit is idle or just found a target, switch to attacking
    // For attack_move: units stop to fire, then continue — we keep state as "attacking"
    // but preserve the movement target so they resume after target dies
    if (unit.state === "idle" || unit.state === "moving" || unit.state === "patrolling" || unit.state === "defending") {
      unit.state = "attacking";
    }

    // Check cooldown
    const timeSinceLastAttack = now - unit.lastAttackTime;
    if (timeSinceLastAttack < unit.attackInterval) return;

    // Fire!
    unit.lastAttackTime = now;

    const damage = calculateDamage(unit, target, state);
    if (damage <= 0) return;

    target.hp -= damage;

    // Consume ammo
    const ecoKey = unit.team === "player" ? "player" : "enemy" as const;
    state.economy[ecoKey].resources.ammo = Math.max(
      0,
      state.economy[ecoKey].resources.ammo - AMMO_PER_ATTACK,
    );

    // Attack line visual effect
    const lineColor = unit.team === "player" ? "#4488ff" : "#ff4444";
    state.combatEffects.attackLines.push({
      fromX: unit.position.x,
      fromY: unit.position.y,
      toX: target.position.x,
      toY: target.position.y,
      startTime: now,
      duration: 0.15,
      color: lineColor,
    });

    // Unit flash (handled by renderer checking lastAttackTime)

    // Death check → explosion
    if (target.hp <= 0) {
      target.hp = 0;
      target.state = "dead";
      target.attackTarget = null;

      state.combatEffects.explosions.push({
        x: target.position.x,
        y: target.position.y,
        startTime: now,
        duration: 0.6,
        radius: getUnitCategory(target.type) === "ground" ? 0.8 : 1.2,
      });
    }
  });

  // --- Day 11: Facility sabotage damage ---
  processFacilitySabotage(state, now);

  // Cleanup expired effects
  state.combatEffects.attackLines = state.combatEffects.attackLines.filter(
    (l) => now - l.startTime < l.duration,
  );
  state.combatEffects.explosions = state.combatEffects.explosions.filter(
    (e) => now - e.startTime < e.duration,
  );
}

// ── Day 11: Facility Sabotage Damage ──

/**
 * Units with active sabotage orders + targetFacilityId deal damage to facilities
 * when in attack range. Uses same cooldown as normal attacks.
 * When facility HP reaches 0, clear sabotage orders and go idle.
 */
function processFacilitySabotage(state: GameState, now: number): void {
  state.units.forEach((unit) => {
    if (unit.hp <= 0 || unit.state === "dead") return;

    // Check for sabotage order with facility target
    const order = unit.orders[0];
    if (!order || order.action !== "sabotage" || !order.targetFacilityId) return;

    // P1 fix: skip non-combat units (recon_plane, carrier, etc.)
    if (unit.attackDamage <= 0 || unit.attackInterval <= 0) return;

    const facility = state.facilities.get(order.targetFacilityId);
    if (!facility || facility.hp <= 0) {
      // P2 fix: fully clean unit state when facility gone/destroyed
      unit.orders = [];
      unit.target = null;
      unit.waypoints = [];
      unit.state = "idle"; // safe: dead units already filtered at function entry
      return;
    }

    // Distance check: unit must be within attack range of facility
    const dx = unit.position.x - facility.position.x;
    const dy = unit.position.y - facility.position.y;
    const dist = Math.sqrt(dx * dx + dy * dy);
    if (dist > unit.attackRange) return;

    // Cooldown check
    const timeSinceLastAttack = now - unit.lastAttackTime;
    if (timeSinceLastAttack < unit.attackInterval) return;

    // Deal damage to facility (no Math.max(1) — 0-attack units already filtered above)
    unit.lastAttackTime = now;
    const damage = Math.round(unit.attackDamage * 0.8);
    facility.hp = Math.max(0, facility.hp - damage);

    // Consume ammo
    const ecoKey = unit.team === "player" ? "player" : ("enemy" as const);
    state.economy[ecoKey].resources.ammo = Math.max(
      0,
      state.economy[ecoKey].resources.ammo - AMMO_PER_ATTACK,
    );

    // Visual: attack line to facility
    const lineColor = unit.team === "player" ? "#ff8800" : "#ff4444"; // orange for sabotage
    state.combatEffects.attackLines.push({
      fromX: unit.position.x,
      fromY: unit.position.y,
      toX: facility.position.x,
      toY: facility.position.y,
      startTime: now,
      duration: 0.2,
      color: lineColor,
    });

    // Facility destroyed
    if (facility.hp <= 0) {
      state.combatEffects.explosions.push({
        x: facility.position.x,
        y: facility.position.y,
        startTime: now,
        duration: 1.0,
        radius: 1.5,
      });

      // Clear sabotage orders on all units targeting this facility
      state.units.forEach((u) => {
        if (
          u.orders[0]?.action === "sabotage" &&
          u.orders[0]?.targetFacilityId === order.targetFacilityId
        ) {
          u.orders = [];
          u.target = null;
          u.waypoints = [];
          if (u.state !== "dead") u.state = "idle";
        }
      });
    }
  });
}
