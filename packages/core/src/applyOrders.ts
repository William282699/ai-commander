// ============================================================
// AI Commander — Order Execution (唯一命令入口)
// All orders flow through here → mutate GameState
// ============================================================

import type { GameState, Order, Unit, Position, TradeType } from "@ai-commander/shared";
import { TRADE_COSTS } from "@ai-commander/shared";
import { enqueueProduction } from "./economy";

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

    // produce / trade never reach here — intercepted above
  }
}
