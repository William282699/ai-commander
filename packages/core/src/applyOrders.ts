// ============================================================
// AI Commander — Order Execution (唯一命令入口)
// All orders flow through here → mutate GameState
// ============================================================

import type { GameState, Order, Unit, Position } from "@ai-commander/shared";

/**
 * Apply a batch of orders to the game state.
 * This is the ONLY entry point for modifying unit behavior.
 */
export function applyOrders(state: GameState, orders: Order[]): void {
  for (const order of orders) {
    for (const unitId of order.unitIds) {
      const unit = state.units.get(unitId);
      if (!unit) continue;
      if (unit.team !== "player") continue;
      if (unit.manualOverride && !order.provisional && !order.isPlayerCommand) continue;

      applyOrderToUnit(unit, order, state);
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

function applyOrderToUnit(unit: Unit, order: Order, state: GameState): void {
  // Store order on unit
  unit.orders = [order];

  switch (order.action) {
    case "attack_move":
      unit.state = "moving";
      unit.attackTarget = order.targetUnitId ?? null;
      if (order.target) {
        unit.target = order.target;
        unit.waypoints = [order.target];
      }
      break;

    case "defend":
      unit.state = "defending";
      if (order.target) {
        unit.target = order.target;
      }
      break;

    case "retreat":
      unit.state = "retreating";
      if (order.target) {
        unit.target = order.target;
        unit.waypoints = [order.target];
      }
      break;

    case "flank":
      unit.state = "moving";
      if (order.target) {
        unit.target = order.target;
        unit.waypoints = [order.target];
      }
      break;

    case "hold":
      unit.state = "idle";
      unit.target = null;
      unit.waypoints = [];
      break;

    case "patrol":
      unit.state = "patrolling";
      if (order.target) {
        unit.patrolPoints = [{ ...unit.position }, order.target];
        unit.target = order.target;
      }
      break;

    case "escort":
      unit.state = "moving";
      if (order.target) {
        unit.target = order.target;
      }
      break;

    case "sabotage":
      unit.state = "moving";
      if (order.target) {
        unit.target = order.target;
        unit.waypoints = [order.target];
      }
      break;

    case "recon":
      unit.state = "moving";
      if (order.target) {
        unit.target = order.target;
        unit.waypoints = [order.target];
      }
      break;

    case "produce":
    case "trade":
      // These are handled at economy level, not unit level
      break;
  }
}
