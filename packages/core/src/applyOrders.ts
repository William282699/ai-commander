// ============================================================
// AI Commander — Order Execution (唯一命令入口)
// All orders flow through here → mutate GameState
// ============================================================

import type { GameState, Order, Unit, Position, TradeType, TradeBudget, ProduceBudget, UnitType, PatrolTask } from "@ai-commander/shared";
import { TRADE_COSTS, UNIT_STATS, UNIT_DISPLAY_NAME } from "@ai-commander/shared";
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
export interface EnemyOrderDispatchResult {
  requestedUnits: number;
  appliedUnits: number;
  skippedUnits: number;
  appliedPerOrder: number[]; // index-aligned with input orders
}

export function applyEnemyOrders(state: GameState, orders: Order[]): EnemyOrderDispatchResult {
  const result: EnemyOrderDispatchResult = {
    requestedUnits: 0,
    appliedUnits: 0,
    skippedUnits: 0,
    appliedPerOrder: Array.from({ length: orders.length }, () => 0),
  };

  for (let orderIdx = 0; orderIdx < orders.length; orderIdx++) {
    const order = orders[orderIdx];
    if (order.action === "produce" || order.action === "trade") {
      handleEconomyOrder(order, "enemy", state);
      continue;
    }

    result.requestedUnits += order.unitIds.length;
    for (const unitId of order.unitIds) {
      const unit = state.units.get(unitId);
      if (!unit) {
        result.skippedUnits++;
        continue;
      }
      if (unit.team !== "enemy") {
        result.skippedUnits++;
        continue;
      }
      applyOrderToUnit(unit, order, state);
      result.appliedUnits++;
      result.appliedPerOrder[orderIdx]++;
    }
  }
  return result;
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
    if (order.produceBudget?.mode === "fraction_of_money") {
      executeProduceBudget(state, team, order.produceUnitType, order.produceBudget);
    } else {
      const result = enqueueProduction(state, team, order.produceUnitType);
      if (!result.ok) {
        pushDiagnostic(state, "PRODUCE_FAIL",
          `生产 ${order.produceUnitType} 失败: ${result.reason}`);
      }
    }
  } else if (order.action === "trade" && order.tradeType) {
    executeTrade(state, team, order.tradeType, order.tradeBudget);
  }
}

/** Per-order cap for budget production (existing resolveProduce cap, unchanged
 *  semantics — the receipt states the true affordable count when it bites). */
const PRODUCE_BUDGET_ORDER_CAP = 10;

/**
 * emily-production-v1 — budget-scaled production, the executeTrade anatomy
 * ported to produce. Settles at APPLY time with live resources: the ENGINE does
 * all the arithmetic (count = floor(money×fraction ÷ cost), then the fuel
 * constraint), enqueueProduction stays the single real entry (facility check +
 * per-unit debit), and the diagnostic reports the ACTUAL enqueued count with
 * its basis — zero-mutation honest refusals otherwise.
 */
function executeProduceBudget(
  state: GameState,
  team: "player" | "enemy",
  unitType: UnitType,
  budget: ProduceBudget,
): void {
  const stats = UNIT_STATS[unitType];
  const eco = state.economy[team];

  // Defense in depth (mirrors the facts-section predicate): a cost<=0 or
  // buildTime<=0 type must never enter budget math — no division by zero.
  if (!stats || stats.cost <= 0 || stats.buildTime <= 0) {
    pushDiagnostic(state, "PRODUCE_FAIL", `生产 ${UNIT_DISPLAY_NAME[unitType]} 失败: 不可生产的单位类型`);
    return;
  }
  // Defense in depth (mirrors schema.ts): only settle when fraction is a real,
  // finite number — however the Order was built. Otherwise fall through to a
  // single enqueue (never all-in on a bad fraction).
  if (typeof budget.fraction !== "number" || !Number.isFinite(budget.fraction)) {
    const r = enqueueProduction(state, team, unitType);
    if (!r.ok) pushDiagnostic(state, "PRODUCE_FAIL", `生产 ${UNIT_DISPLAY_NAME[unitType]} 失败: ${r.reason}`);
    return;
  }

  const fraction = Math.max(0, Math.min(1, budget.fraction));
  if (fraction === 0) {
    // Codex acceptance: zero budget is its own honest reason — NOT "no money".
    if (team === "player") {
      pushDiagnostic(state, "PRODUCE_BUDGET", `预算为零：未下任何生产单，没动钱。`);
    }
    return;
  }

  // Money and fuel bounds are kept SEPARATE so a zero-unit refusal can name
  // the TRUE binding constraint (user audit: $3850/fuel=0 must say fuel, not
  // money — a merged min() erased which side actually bound).
  const budgetMoney = eco.resources.money * fraction;
  const moneyAffordable = Math.floor(budgetMoney / stats.cost);
  const fuelAffordable = stats.fuelCost > 0
    ? Math.floor(eco.resources.fuel / stats.fuelCost)
    : Number.POSITIVE_INFINITY;
  const affordable = Math.min(moneyAffordable, fuelAffordable);
  if (affordable < 1) {
    if (team === "player") {
      const msg = fuelAffordable < 1 && moneyAffordable >= 1
        ? `燃油不足：油料 ${Math.floor(eco.resources.fuel)}，一辆${UNIT_DISPLAY_NAME[unitType]}要 ${stats.fuelCost} 燃油，没动钱。`
        : `钱不够：手头 $${Math.floor(eco.resources.money)}，这点预算连一辆${UNIT_DISPLAY_NAME[unitType]}（$${stats.cost}）都造不起，没动钱。`;
      pushDiagnostic(state, "PRODUCE_BUDGET", msg);
    }
    return;
  }

  const want = Math.min(affordable, PRODUCE_BUDGET_ORDER_CAP);
  let done = 0;
  let failReason: string | null = null;
  for (let i = 0; i < want; i++) {
    // enqueueProduction re-validates facility + resources and debits per unit —
    // the ONLY real entry; if it refuses mid-run we stop and report truthfully.
    const r = enqueueProduction(state, team, unitType);
    if (!r.ok) {
      failReason = r.reason ?? "未知原因";
      break;
    }
    done++;
  }

  if (team !== "player") return;
  if (done === 0) {
    // One failure report with the real reason — never a success claim.
    pushDiagnostic(state, "PRODUCE_FAIL", `生产 ${UNIT_DISPLAY_NAME[unitType]} 失败: ${failReason ?? "未知原因"}`);
    return;
  }
  const capNote = affordable > want ? `（可产${affordable}，本单上限${PRODUCE_BUDGET_ORDER_CAP}）` : "";
  const stopNote = failReason ? `（第${done + 1}辆起中止: ${failReason}）` : "";
  pushDiagnostic(state, "PRODUCE_BUDGET",
    `${UNIT_DISPLAY_NAME[unitType]} ×${done}：花了 $${done * stats.cost}${capNote}${stopNote}，还剩 $${Math.floor(eco.resources.money)}。`);
}

/** Player-facing resource name for trade feedback. */
function tradeResName(tradeType: TradeType): string {
  if (tradeType === "buy_fuel") return "燃油";
  if (tradeType === "buy_ammo") return "弹药";
  if (tradeType === "buy_intel") return "情报";
  return tradeType;
}

/** Apply a bought resource gain to the right pool. */
function addBoughtResource(eco: GameState["economy"]["player"], tradeType: TradeType, gain: number): void {
  if (tradeType === "buy_fuel") eco.resources.fuel += gain;
  else if (tradeType === "buy_ammo") eco.resources.ammo += gain;
  else if (tradeType === "buy_intel") eco.resources.intel += gain;
}

function executeTrade(
  state: GameState,
  team: "player" | "enemy",
  tradeType: TradeType,
  budget?: TradeBudget,
): void {
  const info = TRADE_COSTS[tradeType];
  if (!info) return;
  const eco = state.economy[team];

  // 7b.1 — budget-scaled BUYS. Only buys (cost>0) honor fraction_of_money; sells
  // and the default `single` path fall through to the unchanged one-shot logic
  // below, so normal "buy fuel" behaves exactly as before. The ENGINE does all the
  // arithmetic — the LLM only classified the budget intent.
  // Verified (economy.ts): resources have NO upper cap (income accumulates; only a
  // 0 floor on spend), so batched buys can't overflow/waste — no cap clamp needed.
  if (
    info.cost > 0 &&
    budget?.mode === "fraction_of_money" &&
    typeof budget.fraction === "number" &&
    Number.isFinite(budget.fraction)
  ) {
    // Defense in depth (mirrors schema.ts): only batch-buy when fraction is a real,
    // finite number. A missing / NaN / Infinity fraction — however the Order was
    // built (schema is one source; future 6b autonomous orders / tests are others) —
    // falls through to the single one-shot buy below. Never all-in on a bad fraction.
    const fraction = Math.max(0, Math.min(1, budget.fraction));
    const budgetMoney = eco.resources.money * fraction;
    const times = Math.floor(budgetMoney / info.cost);
    if (times < 1) {
      if (team === "player") {
        pushDiagnostic(state, "TRADE_BUDGET",
          `钱不够：手头 $${Math.floor(eco.resources.money)}，这点预算连一份${tradeResName(tradeType)}（$${info.cost}）都买不下来，没动钱。`);
      }
      return;
    }
    const spend = times * info.cost;
    const gain = times * info.gain;
    eco.resources.money -= spend;
    addBoughtResource(eco, tradeType, gain);
    if (team === "player") {
      pushDiagnostic(state, "TRADE_BUDGET",
        `${tradeResName(tradeType)} ×${times}：花了 $${spend}（+${gain}），还剩 $${Math.floor(eco.resources.money)}。`);
    }
    return;
  }

  if (info.cost > 0) {
    // Buying: spend money, gain resource  (single — unchanged)
    if (eco.resources.money < info.cost) {
      if (team === "player") pushDiagnostic(state, "TRADE_FAIL", "交易失败: 资金不足");
      return;
    }
    eco.resources.money -= info.cost;
    addBoughtResource(eco, tradeType, info.gain);
  } else {
    // Selling: lose resource, gain money (cost is negative)
    const loss = -info.gain; // positive amount of resource to sell
    if (tradeType === "sell_fuel" && eco.resources.fuel < loss) {
      if (team === "player") pushDiagnostic(state, "TRADE_FAIL", "交易失败: 燃油不足");
      return;
    }
    if (tradeType === "sell_ammo" && eco.resources.ammo < loss) {
      if (team === "player") pushDiagnostic(state, "TRADE_FAIL", "交易失败: 弹药不足");
      return;
    }
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
  // Phase C: idempotency check for crisis reinforcement orders.
  // If the unit is already executing a reinforcement order for the same front
  // with the same action and a nearby target, skip the re-dispatch.
  // This prevents the "click C again, same troops restart" bug.
  if (order.crisisFrontId) {
    const current = unit.orders[0];
    if (current && current.crisisFrontId === order.crisisFrontId
        && current.action === order.action && current.target && order.target) {
      const dx = current.target.x - order.target.x;
      const dy = current.target.y - order.target.y;
      if (dx * dx + dy * dy < 25) { // within 5 tiles
        return; // already executing equivalent reinforcement — skip
      }
    }
  }

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
      } else {
        // Defend-in-place must cancel any previous movement/route.
        unit.target = null;
        unit.waypoints = [];
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
