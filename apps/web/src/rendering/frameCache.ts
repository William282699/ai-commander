// ============================================================
// AI Commander — Frame Cache
// Tracks per-unit animation state (current frame in a walk/fire cycle).
// Stored in a WeakMap so nothing bleeds into game logic.
//
// See SPRITE_INTEGRATION_PLAN.md §7.
// ============================================================

import type { Unit } from "@ai-commander/shared";
import type { UnitFrameState } from "./spriteManifest";

interface FrameState {
  currentFrameState: UnitFrameState;
  frameStartTime: number;
}

const cache = new WeakMap<Unit, FrameState>();

/**
 * Resolve the concrete frame index within `layerFrames` for this unit at this time.
 *
 * layerFrames is the pre-resolved frame-index list for the unit's current
 * animation state (e.g., walk = [1,2,3,4,5,6,7]). This function advances that
 * cycle at `fps` rate, resetting the cycle whenever the unit's derived state
 * (idle / moving / attacking) changes.
 */
export function getFrameIndex(
  unit: Unit,
  now: number,
  layerFrames: number[],
  fps: number,
): number {
  if (layerFrames.length === 0) return 0;
  if (layerFrames.length === 1) return layerFrames[0];

  let state = cache.get(unit);
  if (!state) {
    state = {
      currentFrameState: deriveFrameState(unit),
      frameStartTime: now,
    };
    cache.set(unit, state);
  }

  // Reset animation on state change so the cycle starts at frame 0 of the new state
  const newState = deriveFrameState(unit);
  if (newState !== state.currentFrameState) {
    state.currentFrameState = newState;
    state.frameStartTime = now;
  }

  const elapsed = Math.max(0, now - state.frameStartTime);
  const frameStep = 1 / fps;
  const idx = Math.floor(elapsed / frameStep) % layerFrames.length;
  return layerFrames[idx];
}

/**
 * Collapse the full UnitState union down to the subset the renderer cares about.
 *
 * "moving" frame state is used whenever the unit is physically advancing toward
 * a target — this mirrors the condition in sim.ts::tick() that decides whether
 * to call moveUnit(). Previously only `unit.state === "moving"` mapped to the
 * walk cycle, which meant patrolling/retreating infantry and defending units
 * with an active target would render the static `idle` sprite while physically
 * moving ("zombie walk" bug). Tying the frame state to the actual movement
 * condition keeps animation, heading rotation, and position updates in sync.
 */
export function deriveFrameState(unit: Unit): UnitFrameState {
  if (unit.state === "attacking") return "attacking";
  if (
    unit.state === "moving" ||
    unit.state === "retreating" ||
    unit.state === "patrolling" ||
    (unit.state === "defending" && unit.target !== null)
  ) {
    return "moving";
  }
  return "idle";
}
