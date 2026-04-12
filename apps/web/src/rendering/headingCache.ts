// ============================================================
// AI Commander — Heading Cache
// Derives unit heading from position-over-time without adding any field
// to the Unit interface. All state lives in a WeakMap<Unit, HeadingState>.
//
// See SPRITE_INTEGRATION_PLAN.md §6.
// ============================================================

import type { Unit } from "@ai-commander/shared";

interface HeadingState {
  heading: number; // radians, 0 = east, PI/2 = south
  targetHeading: number; // the heading we're rotating toward
  lastX: number;
  lastY: number;
  lastUpdateTime: number;
}

const cache = new WeakMap<Unit, HeadingState>();

const TURN_RATE = Math.PI * 2; // radians per second (full turn in 1s)

/**
 * Return the current visual heading for a unit's body.
 *
 * Heading is updated each frame by comparing the unit's position now vs last
 * frame. Small sub-threshold movements don't trigger a re-aim so idle units
 * don't spin. When the unit is actually moving the target heading is
 * recomputed and smoothly interpolated toward at TURN_RATE.
 */
export function getBodyHeading(unit: Unit, now: number): number {
  let state = cache.get(unit);
  if (!state) {
    state = {
      heading: 0,
      targetHeading: 0,
      lastX: unit.position.x,
      lastY: unit.position.y,
      lastUpdateTime: now,
    };
    cache.set(unit, state);
  }

  const dx = unit.position.x - state.lastX;
  const dy = unit.position.y - state.lastY;
  const dist2 = dx * dx + dy * dy;

  // Only update target heading when the unit has meaningfully moved
  if (dist2 > 0.0025) {
    state.targetHeading = Math.atan2(dy, dx);
    state.lastX = unit.position.x;
    state.lastY = unit.position.y;
  }

  // Smoothly interpolate current heading toward target
  const dt = Math.max(0, now - state.lastUpdateTime);
  state.lastUpdateTime = now;
  state.heading = rotateToward(state.heading, state.targetHeading, TURN_RATE * dt);

  return state.heading;
}

/**
 * Return the current visual heading for a unit's turret / weapon.
 * Prefers the attack target; falls back to body heading when not attacking.
 */
export function getTurretHeading(
  unit: Unit,
  now: number,
  allUnitsById: Map<number, Unit>,
): number {
  if (unit.attackTarget != null) {
    const target = allUnitsById.get(unit.attackTarget);
    if (target) {
      const dx = target.position.x - unit.position.x;
      const dy = target.position.y - unit.position.y;
      return Math.atan2(dy, dx);
    }
  }
  return getBodyHeading(unit, now);
}

function rotateToward(current: number, target: number, maxStep: number): number {
  let diff = target - current;
  while (diff > Math.PI) diff -= 2 * Math.PI;
  while (diff < -Math.PI) diff += 2 * Math.PI;
  if (Math.abs(diff) <= maxStep) return target;
  return current + Math.sign(diff) * maxStep;
}
