// ============================================================
// AI Commander — Order Execution (唯一命令入口)
// All orders flow through here → mutate GameState
// ============================================================

import type { GameState, Order, Unit, Position, TradeType, PatrolTask } from "@ai-commander/shared";
import { TRADE_COSTS } from "@ai-commander/shared";
import { enqueueProduction } from "./economy";
import { findPath, clearPathCache } from "./pathfinding";

/**
 * Compute a shared A* path for a group of units heading to the same target.
 * Uses the unit closest to the group centroid as the "leader" — all units
 * follow the same path so they don't split around obstacles.
 */
function computeGroupPath(units: Unit[], target: Position, state: GameState): Position[] | null {
  if (units.length === 0) return null;

  // Find centroid of the group
  let cx = 0, cy = 0;
  for (const u of units) { cx += u.position.x; cy += u.position.y; }
  cx /= units.length;
  cy /= units.length;

  // Pick leader: unit closest to centroid
  let leader = units[0];
  let bestDist = Infinity;
  for (const u of units) {
    const d = (u.position.x - cx) ** 2 + (u.position.y - cy) ** 2;
    if (d < bestDist) { bestDist = d; leader = u; }
  }

  // A* from leader to target
  const path = findPath(leader.position.x, leader.position.y, target.x, target.y, leader.type, state);
  return path;
}

/**
 * Apply a batch of orders to the game state.
 * This is the ONLY entry point for modifying unit behavior.
 */
export function applyOrders(state: GameState, orders: Order[]): void {
  for (const order of orders) {
    // Economy orders are state-level, not unit-level
    if (order.action === "produce" || order.action === "trade") {
      handleEconomyOrder(order, "player", state);
      continue;
    }

    // Collect eligible units for this order
    const eligibleUnits: Unit[] = [];
    for (const unitId of order.unitIds) {
      const unit = state.units.get(unitId);
      if (!unit) continue;
      if (unit.team !== "player") continue;
      if (unit.isPlayerControlled && !order.isPlayerCommand) continue;
      if (unit.manualOverride && !order.provisional && !order.isPlayerCommand) continue;
      eligibleUnits.push(unit);
    }

    // Compute shared A* path for the group (leader = unit closest to centroid)
    let effectiveOrder = order;
    if (eligibleUnits.length > 1 && order.target && !order.waypoints?.length) {
      const sharedPath = computeGroupPath(eligibleUnits, order.target, state);
      if (sharedPath) {
        effectiveOrder = { ...order, waypoints: sharedPath };
      }
    }

    for (const unit of eligibleUnits) {
      applyOrderToUnit(unit, effectiveOrder, state);
    }
  }
}

/**
 * Replace provisional (local-guess) orders with LLM-refined orders.
 */
export function replaceProvisionalOrders(state: GameState, newOrders: Order[]): void {
  // Clear provisional orders from all player units
  state.units.forEach(unit => {
    if (unit.team === "player" && !unit.manualOverride) {
      unit.orders = unit.orders.filter(o => !o.provisional);
    }
  });
  // Apply new orders
  applyOrders(state, newOrders);
}

/**
 * Apply player-issued commands (from mouse interaction).
 * Sets manualOverride=true on affected units and bypasses the
 * override check so the order always applies.
 */
export function applyPlayerCommands(state: GameState, orders: Order[]): void {
  // Mark selected units as manual override first
  for (const order of orders) {
    for (const unitId of order.unitIds) {
      const unit = state.units.get(unitId);
      if (!unit) continue;
      if (unit.team !== "player") continue;

      unit.manualOverride = true;
    }
  }

  // Route through the normal entrypoint using a player-command flag.
  const taggedOrders = orders.map((order) => ({ ...order, isPlayerCommand: true }));
  applyOrders(state, taggedOrders);
}

/**
 * Release manual override on specified units, returning them to AI control.
 */
export function releaseManualOverride(state: GameState, unitIds: number[]): void {
  for (const id of unitIds) {
    const unit = state.units.get(id);
    if (unit && unit.team === "player") {
      unit.manualOverride = false;
    }
  }
}

/**
 * Apply a batch of orders to enemy units.
 * Used by processEnemyAI for strategic decisions.
 * Mirrors applyOrders but filters for enemy team.
 */
export function applyEnemyOrders(state: GameState, orders: Order[]): void {
  for (const order of orders) {
    if (order.action === "produce" || order.action === "trade") {
      handleEconomyOrder(order, "enemy", state);
      continue;
    }

    for (const unitId of order.unitIds) {
      const unit = state.units.get(unitId);
      if (!unit) continue;
      if (unit.team !== "enemy") continue;
      applyOrderToUnit(unit, order, state);
    }
  }
}

// ── Economy order dispatch (produce / trade) ──

function pushDiagnostic(state: GameState, code: string, message: string): void {
  state.diagnostics.push({ time: state.time, code, message });
  if (state.diagnostics.length > 50) state.diagnostics.shift();
}

function handleEconomyOrder(
  order: Order,
  team: "player" | "enemy",
  state: GameState,
): void {
  if (order.action === "produce" && order.produceUnitType) {
    const result = enqueueProduction(state, team, order.produceUnitType);
    if (!result.ok) {
      pushDiagnostic(state, "PRODUCE_FAIL",
        `生产 ${order.produceUnitType} 失败: ${result.reason}`);
    }
  } else if (order.action === "trade" && order.tradeType) {
    executeTrade(state, team, order.tradeType);
  }
}

function executeTrade(
  state: GameState,
  team: "player" | "enemy",
  tradeType: TradeType,
): void {
  const info = TRADE_COSTS[tradeType];
  if (!info) return;
  const eco = state.economy[team];

  if (info.cost > 0) {
    // Buying: spend money, gain resource
    if (eco.resources.money < info.cost) return;
    eco.resources.money -= info.cost;
    if (tradeType === "buy_fuel") eco.resources.fuel += info.gain;
    else if (tradeType === "buy_ammo") eco.resources.ammo += info.gain;
    else if (tradeType === "buy_intel") eco.resources.intel += info.gain;
  } else {
    // Selling: lose resource, gain money (cost is negative)
    const loss = -info.gain; // positive amount of resource to sell
    if (tradeType === "sell_fuel" && eco.resources.fuel < loss) return;
    if (tradeType === "sell_ammo" && eco.resources.ammo < loss) return;
    if (tradeType === "sell_fuel") eco.resources.fuel -= loss;
    else if (tradeType === "sell_ammo") eco.resources.ammo -= loss;
    eco.resources.money += -info.cost; // cost is negative, so -cost is positive
  }
}

/** Unbind a unit from its patrol task (if any). */
function unbindPatrolTask(unit: Unit, state: GameState): void {
  if (unit.patrolTaskId !== null) {
    const task = state.patrolTasks.find((t) => t.id === unit.patrolTaskId);
    if (task) {
      task.unitIds = task.unitIds.filter((id) => id !== unit.id);
    }
    unit.patrolTaskId = null;
  }
}

/**
 * Find or create a PatrolTask matching the given params (exact integer key).
 * Returns the task id.
 */
function findOrCreatePatrolTask(
  state: GameState,
  params: { centerTileX: number; centerTileY: number; radius: number },
): number {
  // Match existing task by exact integer key
  for (const task of state.patrolTasks) {
    if (
      Math.round(task.center.x) === params.centerTileX &&
      Math.round(task.center.y) === params.centerTileY &&
      task.radius === params.radius
    ) {
      return task.id;
    }
  }

  // Create new task
  const id = state.nextPatrolTaskId++;
  const newTask: PatrolTask = {
    id,
    center: { x: params.centerTileX, y: params.centerTileY },
    radius: params.radius,
    unitIds: [],
    cooldownSec: 6,
    lastTargetTime: 0,
    consecutiveFails: 0,
    paused: false,
    pauseUntil: 0,
  };
  state.patrolTasks.push(newTask);
  return id;
}

function applyOrderToUnit(unit: Unit, order: Order, state: GameState): void {
  // Store order on unit
  unit.orders = [order];
  // CONTRACT: clear cached A* path before any target change
  clearPathCache(unit.id);

  // Day 9.5: all non-patrol orders unbind from patrol task
  if (order.action !== "patrol") {
    unbindPatrolTask(unit, state);
  }

  // Use route waypoints if available, otherwise just [target]
  const orderWaypoints = (t: Position) =>
    order.waypoints && order.waypoints.length > 0
      ? [...order.waypoints]
      : [t];

  switch (order.action) {
    case "attack_move":
      unit.state = "moving";
      unit.attackTarget = order.targetUnitId ?? null;
      if (order.target) {
        const wps = orderWaypoints(order.target);
        unit.target = wps[0];
        unit.waypoints = wps;
      }
      break;

    case "defend":
      unit.state = "defending";
      unit.attackTarget = null;
      if (order.target) {
        const wps = orderWaypoints(order.target);
        unit.target = wps[0];
        unit.waypoints = wps;
      }
      break;

    case "retreat":
      unit.state = "retreating";
      unit.attackTarget = null;
      if (order.target) {
        const wps = orderWaypoints(order.target);
        unit.target = wps[0];
        unit.waypoints = wps;
      }
      break;

    case "flank":
      unit.state = "moving";
      unit.attackTarget = null;
      if (order.target) {
        const wps = orderWaypoints(order.target);
        unit.target = wps[0];
        unit.waypoints = wps;
      }
      break;

    case "hold":
      unit.state = "idle";
      unit.attackTarget = null;
      unit.target = null;
      unit.waypoints = [];
      break;

    case "patrol":
      // Day 9.5: if order has patrolTaskParams, create/join PatrolTask
      if (order.patrolTaskParams) {
        // Unbind from any previous task first
        unbindPatrolTask(unit, state);

        const taskId = findOrCreatePatrolTask(state, order.patrolTaskParams);
        const task = state.patrolTasks.find((t) => t.id === taskId)!;
        if (!task.unitIds.includes(unit.id)) {
          task.unitIds.push(unit.id);
        }
        unit.patrolTaskId = taskId;
        // Set idle — processPatrolTasks will pick the first fog-frontier target
        unit.state = "idle";
        unit.attackTarget = null;
        unit.target = null;
        unit.patrolPoints = [];
      } else {
        // Legacy patrol (no task params — enemy AI, etc.)
        unit.state = "patrolling";
        unit.attackTarget = null;
        if (order.target) {
          unit.patrolPoints = [{ ...unit.position }, order.target];
          unit.target = order.target;
        }
      }
      break;

    case "escort":
      unit.state = "moving";
      unit.attackTarget = null;
      if (order.target) {
        unit.target = order.target;
      }
      break;

    case "sabotage":
      unit.state = "moving";
      unit.attackTarget = null;
      if (order.target) {
        const wps = orderWaypoints(order.target);
        unit.target = wps[0];
        unit.waypoints = wps;
      }
      break;

    case "recon":
      unit.state = "moving";
      unit.attackTarget = null;
      if (order.target) {
        const wps = orderWaypoints(order.target);
        unit.target = wps[0];
        unit.waypoints = wps;
      }
      break;

    // produce / trade never reach here — intercepted above
  }
}
