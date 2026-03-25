// ============================================================
// AI Commander — Simulation Tick (游戏主循环)
// Pure function: tick(state, dt) → mutates state
// ============================================================

import type { GameState, Unit, OrderAction } from "@ai-commander/shared";
import {
  TERRAIN_MOVE_MULT,
  getUnitCategory,
} from "@ai-commander/shared";
export { canUnitEnterTile } from "./movementRules";
import { processCombat } from "./combat";
import { processRegen } from "./regen";
import { canUnitMove, consumeMovementFuel } from "./economy";
import { getOrComputePath, advancePath, clearPathCache } from "./pathfinding";

// Actions that complete when the unit reaches its target (vs defend/hold/patrol which persist)
// NOTE: "sabotage" removed in Day 11 — sabotage orders persist so combat can damage facilities
const ONE_SHOT_ACTIONS: readonly OrderAction[] = [
  "attack_move", "retreat", "recon", "escort", "flank",
];

/** Diagnostic dedup: minimum seconds between identical code pushes. */
const DIAG_DEDUP_SEC = 5;

/** Low-value diagnostics use a longer dedup window to avoid array pollution. */
const DIAG_LOW_VALUE_DEDUP_SEC = 30;
const LOW_VALUE_DIAG_CODES = new Set(["PATH_BLOCKED", "IMPASSABLE_TERRAIN", "NO_FUEL"]);

function pushDiagnostic(state: GameState, code: string, message: string): void {
  const dedupSec = LOW_VALUE_DIAG_CODES.has(code) ? DIAG_LOW_VALUE_DEDUP_SEC : DIAG_DEDUP_SEC;
  const recent = state.diagnostics;
  for (let i = recent.length - 1; i >= 0; i--) {
    if (recent[i].code === code && state.time - recent[i].time < dedupSec) return;
    if (state.time - recent[i].time >= dedupSec) break;
  }
  state.diagnostics.push({ time: state.time, code, message });
  if (state.diagnostics.length > 50) state.diagnostics.shift();
}

/** Clear unit.orders if the current action is a one-shot (completed or failed). */
function clearOneShotOrders(unit: Unit): void {
  const action = unit.orders[0]?.action;
  if (action && (ONE_SHOT_ACTIONS as readonly string[]).includes(action)) {
    unit.orders = [];
  }
}

/** Grace period: dead units stay for 1 frame so explosion effects can reference position */
const DEAD_CLEANUP_DELAY = 0.1; // seconds
// MAX_CONSECUTIVE_DETOURS removed — A* pathfinding handles obstacle avoidance

/**
 * Advance game state by dt seconds.
 * Called ~60 times/sec from the game loop.
 */
export function tick(state: GameState, dt: number): void {
  if (state.gameOver) return;

  state.time += dt;
  state.tick++;

  // 1. Move units toward their targets (skip units that are attacking in place)
  state.units.forEach((unit) => {
    if (unit.hp <= 0) {
      unit.state = "dead";
      return;
    }
    if (
      unit.state === "moving" ||
      unit.state === "retreating" ||
      unit.state === "patrolling" ||
      (unit.state === "defending" && unit.target !== null)
    ) {
      moveUnit(unit, dt, state);
    }
  });

  // 2. Combat: auto-target, fire, apply damage, create effects
  processCombat(state, dt);

  // 2.5. Regen: commander HP regen + HQ repair (after combat)
  processRegen(state, dt);

  // 2.6. Entrench timer: infantry in defend state accumulate trench level
  state.units.forEach((unit) => {
    if (unit.hp <= 0 || unit.state === "dead") return;
    // Only infantry / elite_guard can entrench
    if (unit.type !== "infantry" && unit.type !== "elite_guard") return;

    if (unit.state === "defending" && unit.target === null) {
      // Stationary defending — accumulate entrench time
      const prev = state.entrenchTimers.get(unit.id) ?? 0;
      const next = prev + dt;
      state.entrenchTimers.set(unit.id, next);

      if (next >= 15) {
        unit.entrenchLevel = 2;
      } else if (next >= 5) {
        unit.entrenchLevel = 1;
      }
    } else {
      // Moving or not defending — reset
      if (unit.entrenchLevel && unit.entrenchLevel > 0) {
        unit.entrenchLevel = 0;
        state.entrenchTimers.delete(unit.id);
      }
    }
  });

  // 3. Remove dead units (after a short grace period for effects)
  const deadIds: number[] = [];
  state.units.forEach((unit) => {
    if (unit.state === "dead" && unit.hp <= 0) {
      deadIds.push(unit.id);
    }
  });
  for (const id of deadIds) {
    state.units.delete(id);
    state.entrenchTimers.delete(id);
  }
}

function moveUnit(unit: Unit, dt: number, state: GameState): void {
  // Fuel gate
  if (!canUnitMove(unit, state)) {
    clearOneShotOrders(unit);
    if (unit.team === "player") {
      pushDiagnostic(state, "NO_FUEL", `${unit.type}#${unit.id} 燃油耗尽，无法移动`);
    }
    return;
  }

  // Track locked attack target — sync movement to enemy position
  if (unit.attackTarget !== null) {
    const tracked = state.units.get(unit.attackTarget);
    if (tracked && tracked.hp > 0 && tracked.state !== "dead" && tracked.team !== unit.team) {
      const newTarget = { ...tracked.position };
      if (unit.target && (Math.abs(unit.target.x - newTarget.x) > 2 || Math.abs(unit.target.y - newTarget.y) > 2)) {
        clearPathCache(unit.id);
      }
      unit.target = newTarget;
      if (unit.waypoints.length > 0) {
        unit.waypoints[0] = unit.target;
      } else {
        unit.waypoints = [unit.target];
      }
    } else {
      unit.attackTarget = null;
    }
  }

  if (!unit.target) return;

  // ── Resolve next move point via A* ──
  let moveTarget: { x: number; y: number };

  // Try cached A* path first
  const nextAstarWp = advancePath(unit.id, unit.position.x, unit.position.y);
  if (nextAstarWp) {
    moveTarget = nextAstarWp;
  } else {
    // Compute new A* path
    const path = getOrComputePath(
      unit.id, unit.position.x, unit.position.y,
      unit.target.x, unit.target.y, unit.type, state,
    );
    if (path && path.length > 0) {
      moveTarget = path[0];
    } else {
      // Fallback: direct move for very short distances
      const directDist = Math.abs(unit.target.x - unit.position.x) + Math.abs(unit.target.y - unit.position.y);
      if (directDist < 3) {
        moveTarget = unit.target;
      } else {
        unit.target = null;
        unit.waypoints = [];
        unit.state = "idle";
        clearOneShotOrders(unit);
        clearPathCache(unit.id);
        pushDiagnostic(state, "PATH_BLOCKED", `${unit.type}#${unit.id} A*寻路失败，目标不可达`);
        return;
      }
    }
  }

  // ── Check arrival ──
  const dx = moveTarget.x - unit.position.x;
  const dy = moveTarget.y - unit.position.y;
  const dist = Math.sqrt(dx * dx + dy * dy);

  if (dist < 0.1) {
    // Arrived at A* waypoint — check if also at unit.target
    unit.position = { ...moveTarget };
    const tdx = unit.target.x - unit.position.x;
    const tdy = unit.target.y - unit.position.y;
    if (tdx * tdx + tdy * tdy >= 0.36) {
      return; // reached A* waypoint but not unit.target yet — next frame continues
    }

    // ── Arrived at unit.target ──
    unit.position = { ...unit.target };
    clearPathCache(unit.id);

    if (unit.state === "patrolling" && unit.patrolPoints.length >= 2) {
      if (unit.patrolTaskId !== null) {
        unit.target = null;
        unit.patrolPoints = [];
        unit.state = "idle";
      } else {
        unit.patrolPoints.reverse();
        unit.target = unit.patrolPoints[1];
      }
    } else if (unit.waypoints.length > 1) {
      unit.waypoints.shift();
      unit.target = unit.waypoints[0];
      clearPathCache(unit.id);
    } else {
      unit.target = null;
      unit.waypoints = [];
      if (unit.state === "defending") {
        // Stay defending
      } else if (unit.state !== "patrolling") {
        unit.state = "idle";
        clearOneShotOrders(unit);
      }
    }
    return;
  }

  // ── Move toward A* waypoint ──
  const tileX = Math.floor(unit.position.x);
  const tileY = Math.floor(unit.position.y);
  let speedMult = 1.0;
  if (tileY >= 0 && tileY < state.mapHeight && tileX >= 0 && tileX < state.mapWidth) {
    const terrain = state.terrain[tileY][tileX];
    const cat = getUnitCategory(unit.type);
    speedMult = TERRAIN_MOVE_MULT[terrain]?.[cat] ?? 0;
  }

  if (speedMult <= 0) {
    clearPathCache(unit.id);
    unit.target = null;
    unit.waypoints = [];
    unit.state = "idle";
    clearOneShotOrders(unit);
    pushDiagnostic(state, "IMPASSABLE_TERRAIN", `${unit.type}#${unit.id} 当前地块不可通行，已停止`);
    return;
  }

  const speed = unit.moveSpeed * speedMult * dt;
  const step = Math.min(speed, dist);
  const nx = dx / dist;
  const ny = dy / dist;
  const newX = unit.position.x + nx * step;
  const newY = unit.position.y + ny * step;

  consumeMovementFuel(unit, Math.sqrt((newX - unit.position.x) ** 2 + (newY - unit.position.y) ** 2), state);
  unit.position.x = newX;
  unit.position.y = newY;
}
