// ============================================================
// AI Commander — Simulation Tick (游戏主循环)
// Pure function: tick(state, dt) → mutates state
// ============================================================

import type { GameState, Unit, UnitType, OrderAction } from "@ai-commander/shared";
import {
  TERRAIN_MOVE_MULT,
  TANK_BLOCKED_TERRAIN,
  INFANTRY_BLOCKED_TERRAIN,
  getUnitCategory,
} from "@ai-commander/shared";
import { processCombat } from "./combat";
import { canUnitMove, consumeMovementFuel } from "./economy";

// Actions that complete when the unit reaches its target (vs defend/hold/patrol which persist)
// NOTE: "sabotage" removed in Day 11 — sabotage orders persist so combat can damage facilities
const ONE_SHOT_ACTIONS: readonly OrderAction[] = [
  "attack_move", "retreat", "recon", "escort", "flank",
];

/** Diagnostic dedup: minimum seconds between identical code pushes. */
const DIAG_DEDUP_SEC = 5;

/** Low-value diagnostics use a longer dedup window to avoid array pollution. */
const DIAG_LOW_VALUE_DEDUP_SEC = 30;
const LOW_VALUE_DIAG_CODES = new Set(["PATH_BLOCKED", "IMPASSABLE_TERRAIN"]);

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

/**
 * Check if a unit type can enter a specific tile.
 * Considers both category-level passability and type-specific restrictions
 * (e.g. tanks blocked by forest/swamp).
 */
export function canUnitEnterTile(
  unitType: UnitType,
  tileX: number,
  tileY: number,
  state: GameState,
): boolean {
  if (tileX < 0 || tileX >= state.mapWidth || tileY < 0 || tileY >= state.mapHeight) {
    return false;
  }

  const terrain = state.terrain[tileY][tileX];
  const cat = getUnitCategory(unitType);

  // Category-level: check terrain movement multiplier
  const mult = TERRAIN_MOVE_MULT[terrain]?.[cat] ?? 0;
  if (mult <= 0) return false;

  // Type-specific: tanks (including artillery) can't enter forest/swamp etc.
  if (
    unitType === "light_tank" ||
    unitType === "main_tank" ||
    unitType === "artillery"
  ) {
    if ((TANK_BLOCKED_TERRAIN as readonly string[]).includes(terrain)) return false;
  }

  // Infantry restrictions (mostly redundant with mult=0, but explicit)
  if (unitType === "infantry") {
    if ((INFANTRY_BLOCKED_TERRAIN as readonly string[]).includes(terrain)) return false;
  }

  return true;
}

/** Grace period: dead units stay for 1 frame so explosion effects can reference position */
const DEAD_CLEANUP_DELAY = 0.1; // seconds
const MAX_CONSECUTIVE_DETOURS = 8;

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
      unit.state === "patrolling"
    ) {
      moveUnit(unit, dt, state);
    }
  });

  // 2. Combat: auto-target, fire, apply damage, create effects
  processCombat(state, dt);

  // 3. Remove dead units (after a short grace period for effects)
  const deadIds: number[] = [];
  state.units.forEach((unit) => {
    if (unit.state === "dead" && unit.hp <= 0) {
      deadIds.push(unit.id);
    }
  });
  for (const id of deadIds) {
    state.units.delete(id);
  }
}

/**
 * Local detour: when next step is blocked, probe candidate headings
 * at 8 angle offsets × 3 step distances = 24 probes.
 * Returns a short detour waypoint or null if no passable candidate found.
 * Deterministic: fixed candidate order (smallest offset first), no randomness.
 */
function tryLocalDetour(
  unit: Unit,
  blockedTileX: number,
  blockedTileY: number,
  headingX: number,
  headingY: number,
  state: GameState,
): { x: number; y: number } | null {
  // 8 angle offsets: ±22.5°, ±45°, ±90°, ±135° (ordered by preference)
  const angleOffsets = [
    Math.PI / 8,     // +22.5°
    -Math.PI / 8,    // -22.5°
    Math.PI / 4,     // +45°
    -Math.PI / 4,    // -45°
    Math.PI / 2,     // +90°
    -Math.PI / 2,    // -90°
    (3 * Math.PI) / 4,   // +135°
    -(3 * Math.PI) / 4,  // -135°
  ];
  const stepDistances = [1.0, 2.0, 3.0];

  const baseAngle = Math.atan2(headingY, headingX);

  for (const offset of angleOffsets) {
    const angle = baseAngle + offset;
    const dirX = Math.cos(angle);
    const dirY = Math.sin(angle);

    for (const stepDist of stepDistances) {
      const candidateX = unit.position.x + dirX * stepDist;
      const candidateY = unit.position.y + dirY * stepDist;
      const candTileX = Math.floor(candidateX);
      const candTileY = Math.floor(candidateY);

      // Skip if same as blocked tile
      if (candTileX === blockedTileX && candTileY === blockedTileY) continue;

      if (canUnitEnterTile(unit.type, candTileX, candTileY, state)) {
        return { x: candidateX, y: candidateY };
      }
    }
  }

  return null; // no passable candidate found
}

function moveUnit(unit: Unit, dt: number, state: GameState): void {
  // Fuel gate: mechanized units cannot move if team fuel is 0
  if (!canUnitMove(unit, state)) {
    clearOneShotOrders(unit); // ⑦ release autoBehavior on fuel exhaustion
    pushDiagnostic(state, "NO_FUEL",
      `${unit.type}#${unit.id} 燃油耗尽，无法移动`);
    return;
  }

  // If we have a locked attack target, keep movement target synced to enemy's live position.
  if (unit.attackTarget !== null) {
    const tracked = state.units.get(unit.attackTarget);
    if (tracked && tracked.hp > 0 && tracked.state !== "dead" && tracked.team !== unit.team) {
      unit.target = { ...tracked.position };
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

  const dx = unit.target.x - unit.position.x;
  const dy = unit.target.y - unit.position.y;
  const dist = Math.sqrt(dx * dx + dy * dy);

  if (dist < 0.1) {
    // Arrived at current target
    unit.position = { ...unit.target };
    unit.detourCount = 0;

    if (unit.state === "patrolling" && unit.patrolPoints.length >= 2) {
      if (unit.patrolTaskId !== null) {
        // Task-managed patrol: go idle, clear stale data, let processPatrolTasks re-target
        unit.target = null;
        unit.patrolPoints = [];
        unit.state = "idle";
      } else {
        // Legacy 2-point patrol (enemy AI, etc.)
        unit.patrolPoints.reverse();
        unit.target = unit.patrolPoints[1];
      }
    } else if (unit.waypoints.length > 1) {
      unit.waypoints.shift();
      unit.target = unit.waypoints[0];
    } else {
      unit.target = null;
      unit.waypoints = [];
      if (unit.state !== "patrolling") {
        unit.state = "idle";
        clearOneShotOrders(unit); // ⑦ release autoBehavior
      }
    }
    return;
  }

  // Current tile terrain speed modifier
  const tileX = Math.floor(unit.position.x);
  const tileY = Math.floor(unit.position.y);
  let speedMult = 1.0;
  if (
    tileY >= 0 &&
    tileY < state.mapHeight &&
    tileX >= 0 &&
    tileX < state.mapWidth
  ) {
    const terrain = state.terrain[tileY][tileX];
    const cat = getUnitCategory(unit.type);
    speedMult = TERRAIN_MOVE_MULT[terrain]?.[cat] ?? 0;
  }

  if (speedMult <= 0) {
    // Stuck on impassable terrain — abort
    unit.target = null;
    unit.waypoints = [];
    unit.state = "idle";
    clearOneShotOrders(unit); // ⑦
    pushDiagnostic(state, "IMPASSABLE_TERRAIN",
      `${unit.type}#${unit.id} 当前地块不可通行，已停止`);
    return;
  }

  const speed = unit.moveSpeed * speedMult * dt;
  const step = Math.min(speed, dist);
  const nx = dx / dist;
  const ny = dy / dist;

  const newX = unit.position.x + nx * step;
  const newY = unit.position.y + ny * step;

  // Check if entering a new tile
  const newTileX = Math.floor(newX);
  const newTileY = Math.floor(newY);

  if (newTileX !== tileX || newTileY !== tileY) {
    // About to enter a new tile — check passability
    if (!canUnitEnterTile(unit.type, newTileX, newTileY, state)) {
      // Blocked — try local detour before stopping
      const detour = tryLocalDetour(unit, newTileX, newTileY, nx, ny, state);
      if (detour) {
        unit.detourCount += 1;
        if (unit.detourCount > MAX_CONSECUTIVE_DETOURS) {
          unit.target = null;
          unit.waypoints = [];
          unit.state = "idle";
          unit.detourCount = 0;
          clearOneShotOrders(unit); // ⑦
          pushDiagnostic(state, "PATH_BLOCKED",
            `${unit.type}#${unit.id} 连续绕路失败，已停止`);
          return;
        }

        // Insert one short detour first, then the original destination.
        const originalTarget =
          unit.waypoints.length > 1 ? unit.waypoints[unit.waypoints.length - 1] : unit.target;
        unit.target = detour;
        unit.waypoints = [detour, originalTarget];
      } else {
        // No detour found — stop
        unit.target = null;
        unit.waypoints = [];
        unit.state = "idle";
        unit.detourCount = 0;
        clearOneShotOrders(unit); // ⑦
        pushDiagnostic(state, "PATH_BLOCKED",
          `${unit.type}#${unit.id} 寻路失败，无可绕行路径`);
      }
      return;
    }
  }

  // Consume fuel proportional to tiles moved
  const moved = Math.sqrt(
    (newX - unit.position.x) ** 2 + (newY - unit.position.y) ** 2,
  );
  consumeMovementFuel(unit, moved, state);

  unit.position.x = newX;
  unit.position.y = newY;
  unit.detourCount = 0;
}
