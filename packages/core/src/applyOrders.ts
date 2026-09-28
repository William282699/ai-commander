// ============================================================
// AI Commander — Order Execution (唯一命令入口)
// All orders flow through here → mutate GameState
// ============================================================

import type { GameState, Order, Unit, Position, TradeType, TradeBudget, ProduceBudget, UnitType, PatrolTask, ApplyResult, ApplyOrderOutcome, OrderRejectReason, IntentType, EconomyOutcome, EconomyOpKind } from "@ai-commander/shared";
import { TRADE_COSTS, UNIT_STATS, UNIT_DISPLAY_NAME, isProducibleUnitType } from "@ai-commander/shared";
import { enqueueProduction } from "./economy";
import { findPath, clearPathCache } from "./pathfinding";
import { recordPlayerDispatch } from "./dispatchLedger";

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
 *
 * retreat-scope 刀B: it now REPORTS what it actually did. The four filters
 * below silently dropped units, and this function returned `void` — so every
 * player-facing receipt upstream had to recite the PLAN ("8 个单位撤退至…")
 * even when only five of them ever got the order. 文字、声音、台账三者从此
 * 共用这一份结果，不再各自取数。
 */
export function applyOrders(state: GameState, orders: Order[]): ApplyResult {
  const perOrder: ApplyOrderOutcome[] = [];
  // 刀寅：接到这批令**之前**，每个人是否还在路上（离上一道令的落点还远）。
  //   台账据此判断这次是同一次外派的改令（起点延续），还是到达之后的新一次外派。
  //   必须在下令之前取——下完令 unit.orders 就换成新的了。
  const enRouteBefore = snapshotEnRoute(state, orders);

  for (let orderIndex = 0; orderIndex < orders.length; orderIndex++) {
    const order = orders[orderIndex];
    const outcome: ApplyOrderOutcome = {
      orderIndex,
      action: order.action,
      appliedUnitIds: [],
      alreadyDoingUnitIds: [],
      rejected: [],
    };
    perOrder.push(outcome);

    // Economy orders are state-level, not unit-level. They carry no unitIds,
    // so the outcome stays empty — affordability failures are already voiced
    // from state.diagnostics (PRODUCE_FAIL / TRADE_FAIL) and are not a
    // per-unit fact this result can speak to.
    if (order.action === "produce" || order.action === "trade") {
      // 刀庚：经济单的真实结算挂在这一条 order 的结果上。回执据此报真数，
      // 不再复述计划那一行（实测：$170 造 3 个只成 2 个，旧回执照说「×3」）。
      const econ = handleEconomyOrder(order, "player", state);
      if (econ) outcome.economy = econ;
      continue;
    }

    // Collect eligible units for this order
    const eligibleUnits: Unit[] = [];
    for (const unitId of order.unitIds) {
      const unit = state.units.get(unitId);
      const reason: OrderRejectReason | null =
        // 刀B 收紧一处（1 行语义，故意为之）：`state === "dead"` 也算"不在了"。
        // 尸体在 sim 的下一拍才从表里删掉，中间这一帧它会照收命令、照进计数——
        // 于是回执报"已下令 4 个"，其中一个是死人。回执诚实的前提是计数诚实。
        !unit || unit.state === "dead" ? "unit_gone"
        : unit.team !== "player" ? "not_player_unit"
        : unit.isPlayerControlled && !order.isPlayerCommand ? "player_controlled"
        : unit.manualOverride && !order.provisional && !order.isPlayerCommand ? "manual_override"
        : null;
      if (reason) {
        outcome.rejected.push({ unitId, reason });
        continue;
      }
      eligibleUnits.push(unit!);
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
      const outcomeKind = applyOrderToUnit(unit, effectiveOrder, state);
      if (outcomeKind === "already_doing") outcome.alreadyDoingUnitIds.push(unit.id);
      else outcome.appliedUnitIds.push(unit.id);
    }
  }

  // ── 刀C: 台账登记。**只认 `order.origin`**，不认调用的是哪个函数 ──
  //
  // 为什么不能按入口认：`applyPlayerCommands` 是鼠标专用（注释写着 from mouse
  // interaction，而且它给每个单位盖 `manualOverride = true`），对话派兵走的是
  // `applyOrders`。按入口记账只有两种坏结局：说话派出去的兵一条都不入账，
  // 或者把陈派的每个兵都盖上"手动接管"，砸掉现有控制规则。
  //
  // 登记用的是 **appliedUnitIds**——真接到命令的那些人。计划选中的不算数。
  // 幂等跳过（alreadyDoing）那批不摘也不记：它们本来就在执行同一件事。
  recordLedgerEntries(state, orders, perOrder, enRouteBefore);

  return summarizeApply(perOrder);
}

/** 离落点多远以内算「到了」。 */
const ARRIVED_RADIUS = 2.5;

function snapshotEnRoute(state: GameState, orders: Order[]): Map<number, boolean> {
  const out = new Map<number, boolean>();
  for (const o of orders) {
    if (o.origin !== "advisor" && o.origin !== "mouse") continue;
    for (const id of o.unitIds) {
      if (out.has(id)) continue;
      const u = state.units.get(id);
      const cur = u?.orders[0];
      const tgt = cur?.target;
      out.set(id, !!(u && tgt && Math.hypot(u.position.x - tgt.x, u.position.y - tgt.y) > ARRIVED_RADIUS));
    }
  }
  return out;
}

/** OrderAction → IntentType。两套枚举大半同名，只有 attack_move 要翻一下。 */
function intentTypeOfOrder(action: Order["action"]): IntentType {
  return action === "attack_move" ? "attack" : action;
}

/** 一句话安排两个任务 ⇒ 两个 group ⇒ **两条记录，各记各的名单**（不合成一条）。 */
function recordLedgerEntries(
  state: GameState, orders: Order[], perOrder: ApplyOrderOutcome[], enRouteBefore: ReadonlyMap<number, boolean>,
): void {
  const groups = new Map<string, { meta: NonNullable<Order["dispatchMeta"]>; ids: number[] }>();
  for (let i = 0; i < orders.length; i++) {
    const order = orders[i];
    if (order.origin !== "advisor" && order.origin !== "mouse") continue; // auto / 缺席 ⇒ 不记
    const applied = perOrder[i]?.appliedUnitIds ?? [];
    if (applied.length === 0) continue;
    const meta = order.dispatchMeta ?? {
      // 没带 meta 的玩家命令（鼠标那条路可以不带）：按单条 order 各记各的。
      // 动作从 order 自己那一栏翻过来，不硬塞一个"hold"——台账里写一个它
      // 根本没在做的动作，将来信封上就是一行假话。
      group: `o${i}`,
      sourceKind: "selection" as const,
      sourceKey: "",
      action: intentTypeOfOrder(order.action),
      targetName: "",
    };
    const key = `${order.origin}|${meta.group}`;
    const slot = groups.get(key) ?? { meta, ids: [] };
    for (const id of applied) if (!slot.ids.includes(id)) slot.ids.push(id);
    groups.set(key, slot);
  }
  for (const slot of groups.values()) {
    recordPlayerDispatch(state, slot.ids, slot.meta, enRouteBefore);
  }
}

/** Roll the per-order rows up into the three de-duplicated batch totals. */
function summarizeApply(perOrder: ApplyOrderOutcome[]): ApplyResult {
  const applied = new Set<number>();
  const already = new Set<number>();
  const rejected = new Set<number>();
  for (const o of perOrder) {
    for (const id of o.appliedUnitIds) applied.add(id);
    for (const id of o.alreadyDoingUnitIds) already.add(id);
    for (const r of o.rejected) rejected.add(r.unitId);
  }
  return {
    perOrder,
    appliedUnitIds: [...applied],
    alreadyDoingUnitIds: [...already],
    rejectedUnitIds: [...rejected],
  };
}

/**
 * Replace provisional (local-guess) orders with LLM-refined orders.
 */
export function replaceProvisionalOrders(state: GameState, newOrders: Order[]): ApplyResult {
  // Clear provisional orders from all player units
  state.units.forEach(unit => {
    if (unit.team === "player" && !unit.manualOverride) {
      unit.orders = unit.orders.filter(o => !o.provisional);
    }
  });
  // Apply new orders
  return applyOrders(state, newOrders);
}

/**
 * Apply player-issued commands (from mouse interaction).
 * Sets manualOverride=true on affected units and bypasses the
 * override check so the order always applies.
 */
export function applyPlayerCommands(state: GameState, orders: Order[]): ApplyResult {
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
  // 刀C: 鼠标这条路自己盖 origin —— 调用方（GameCanvas）不必逐处记得。
  // 手动接管语义一个字不改：上面照旧设 manualOverride。
  const taggedOrders = orders.map((order) => ({
    ...order,
    isPlayerCommand: true,
    origin: order.origin ?? ("mouse" as const),
  }));
  return applyOrders(state, taggedOrders);
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

/** 刀庚：经济单的空白结果骨架（每条路都从它起手，字段一个不漏）。 */
function emptyEconomyOutcome(kind: EconomyOpKind, subject: string, subjectLabel: string): EconomyOutcome {
  return {
    kind, subject, subjectLabel,
    requested: 0, succeeded: 0, failed: 0,
    moneySpent: 0, moneyGained: 0, resourceGained: 0,
    failReasons: [],
  };
}

/**
 * 刀庚：经济单从此**回报真实结算**，不再让 `state.diagnostics` 当回执的数据总线。
 *
 * 诊断照旧推（调试/系统日志要它），但那句人话现在**先进结果、再进诊断**——
 * 一份文案两处用，不会漂。
 */
function handleEconomyOrder(
  order: Order,
  team: "player" | "enemy",
  state: GameState,
): EconomyOutcome | null {
  if (order.action === "produce" && order.produceUnitType) {
    if (order.produceBudget?.mode === "fraction_of_money") {
      return executeProduceBudget(state, team, order.produceUnitType, order.produceBudget);
    }
    const unitType = order.produceUnitType;
    const out = emptyEconomyOutcome("produce", unitType, UNIT_DISPLAY_NAME[unitType] ?? String(unitType));
    out.requested = 1;
    const moneyBefore = state.economy[team].resources.money;
    const result = enqueueProduction(state, team, unitType);
    if (result.ok) {
      out.succeeded = 1;
      out.moneySpent = Math.max(0, moneyBefore - state.economy[team].resources.money);
    } else {
      out.failed = 1;
      const msg = `生产${out.subjectLabel}失败: ${result.reason}`;
      out.failReasons.push(msg);
      // 诊断留着（调试/系统日志），但玩家面前的回执从 out 取数。
      pushDiagnostic(state, "PRODUCE_FAIL", msg);
    }
    return out;
  }
  if (order.action === "trade" && order.tradeType) {
    return executeTrade(state, team, order.tradeType, order.tradeBudget);
  }
  return null;
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
): EconomyOutcome {
  const stats = UNIT_STATS[unitType];
  const eco = state.economy[team];
  // 刀庚：每条出口都要填满这份结果。诊断照旧推，但**同一句人话**先进 out。
  const out = emptyEconomyOutcome("produce", unitType, UNIT_DISPLAY_NAME[unitType] ?? String(unitType));

  // Defense in depth（同一个谓词 isProducibleUnitType，唯一真相源）：cost<=0 或
  // buildTime<=0 的类型绝不能进预算算术——会除以零。★这道闸不许因为"引擎入口
  // 已经加了闸"而删：它挡在 enqueueProduction 被调用**之前**（下面的预算除法就
  // 在本函数里），删了就是把除零放回来。
  if (!stats || !isProducibleUnitType(unitType)) {
    const msg = `生产${out.subjectLabel}失败: 不可生产的单位类型`;
    out.requested = 1; out.failed = 1; out.failReasons.push(msg);
    pushDiagnostic(state, "PRODUCE_FAIL", msg);
    return out;
  }
  // Defense in depth (mirrors schema.ts): only settle when fraction is a real,
  // finite number — however the Order was built. Otherwise fall through to a
  // single enqueue (never all-in on a bad fraction).
  if (typeof budget.fraction !== "number" || !Number.isFinite(budget.fraction)) {
    out.requested = 1;
    const moneyBefore = eco.resources.money;
    const r = enqueueProduction(state, team, unitType);
    if (r.ok) {
      out.succeeded = 1;
      out.moneySpent = Math.max(0, moneyBefore - eco.resources.money);
    } else {
      const msg = `生产${out.subjectLabel}失败: ${r.reason}`;
      out.failed = 1; out.failReasons.push(msg);
      pushDiagnostic(state, "PRODUCE_FAIL", msg);
    }
    return out;
  }

  const fraction = Math.max(0, Math.min(1, budget.fraction));
  if (fraction === 0) {
    // Codex acceptance: zero budget is its own honest reason — NOT "no money".
    const msg = `预算为零：未下任何生产单，没动钱。`;
    out.failReasons.push(msg);   // requested=0 ⇒ 既不是成功也不是"造不起"
    if (team === "player") pushDiagnostic(state, "PRODUCE_BUDGET", msg);
    return out;
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
    // ★钱界与油界不合并：零件回执要报**真实约束**（用户审计那一笔）。
    const msg = fuelAffordable < 1 && moneyAffordable >= 1
      ? `燃油不足：油料 ${Math.floor(eco.resources.fuel)}，一辆${UNIT_DISPLAY_NAME[unitType]}要 ${stats.fuelCost} 燃油，没动钱。`
      : `钱不够：手头 $${Math.floor(eco.resources.money)}，这点预算连一辆${UNIT_DISPLAY_NAME[unitType]}（$${stats.cost}）都造不起，没动钱。`;
    out.requested = 1; out.failed = 1; out.failReasons.push(msg);
    if (team === "player") pushDiagnostic(state, "PRODUCE_BUDGET", msg);
    return out;
  }

  const want = Math.min(affordable, PRODUCE_BUDGET_ORDER_CAP);
  out.requested = want;   // ★引擎自己算出来的那个数（不是模型说的）
  const moneyAtStart = eco.resources.money;
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

  // ★真实结算先进结果（屏幕/TTS/context 从这儿取数），诊断照旧推给日志。
  out.succeeded = done;
  out.failed = want - done;
  out.moneySpent = Math.max(0, moneyAtStart - eco.resources.money);
  if (done === 0) {
    const msg = `生产${out.subjectLabel}失败: ${failReason ?? "未知原因"}`;
    out.failReasons.push(msg);
    if (team === "player") pushDiagnostic(state, "PRODUCE_FAIL", msg);
    return out;
  }
  if (failReason) out.failReasons.push(`第${done + 1}辆起中止: ${failReason}`);
  if (team !== "player") return out;
  const capNote = affordable > want ? `（可产${affordable}，本单上限${PRODUCE_BUDGET_ORDER_CAP}）` : "";
  const stopNote = failReason ? `（第${done + 1}辆起中止: ${failReason}）` : "";
  pushDiagnostic(state, "PRODUCE_BUDGET",
    `${UNIT_DISPLAY_NAME[unitType]} ×${done}：花了 $${done * stats.cost}${capNote}${stopNote}，还剩 $${Math.floor(eco.resources.money)}。`);
  return out;
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
): EconomyOutcome {
  const info = TRADE_COSTS[tradeType];
  // 刀庚：交易也回报**真实结算**——绝不把 `buy_fuel` 这种计划字段当成功事实复述。
  const out = emptyEconomyOutcome("trade", tradeType, tradeResName(tradeType));
  if (!info) {
    out.requested = 1; out.failed = 1;
    out.failReasons.push(`未知交易类型: ${tradeType}`);
    return out;
  }
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
      const msg = `钱不够：手头 $${Math.floor(eco.resources.money)}，这点预算连一份${tradeResName(tradeType)}（$${info.cost}）都买不下来，没动钱。`;
      out.requested = 1; out.failed = 1; out.failReasons.push(msg);
      if (team === "player") pushDiagnostic(state, "TRADE_BUDGET", msg);
      return out;
    }
    const spend = times * info.cost;
    const gain = times * info.gain;
    eco.resources.money -= spend;
    addBoughtResource(eco, tradeType, gain);
    out.requested = times; out.succeeded = times;
    out.moneySpent = spend; out.resourceGained = gain;
    if (team === "player") {
      pushDiagnostic(state, "TRADE_BUDGET",
        `${tradeResName(tradeType)} ×${times}：花了 $${spend}（+${gain}），还剩 $${Math.floor(eco.resources.money)}。`);
    }
    return out;
  }

  out.requested = 1;
  if (info.cost > 0) {
    // Buying: spend money, gain resource  (single — unchanged)
    if (eco.resources.money < info.cost) {
      const msg = "交易失败: 资金不足";
      out.failed = 1; out.failReasons.push(msg);
      if (team === "player") pushDiagnostic(state, "TRADE_FAIL", msg);
      return out;
    }
    eco.resources.money -= info.cost;
    addBoughtResource(eco, tradeType, info.gain);
    out.succeeded = 1; out.moneySpent = info.cost; out.resourceGained = info.gain;
  } else {
    // Selling: lose resource, gain money (cost is negative)
    const loss = -info.gain; // positive amount of resource to sell
    if (tradeType === "sell_fuel" && eco.resources.fuel < loss) {
      const msg = "交易失败: 燃油不足";
      out.failed = 1; out.failReasons.push(msg);
      if (team === "player") pushDiagnostic(state, "TRADE_FAIL", msg);
      return out;
    }
    if (tradeType === "sell_ammo" && eco.resources.ammo < loss) {
      const msg = "交易失败: 弹药不足";
      out.failed = 1; out.failReasons.push(msg);
      if (team === "player") pushDiagnostic(state, "TRADE_FAIL", msg);
      return out;
    }
    if (tradeType === "sell_fuel") eco.resources.fuel -= loss;
    else if (tradeType === "sell_ammo") eco.resources.ammo -= loss;
    eco.resources.money += -info.cost; // cost is negative, so -cost is positive
    out.succeeded = 1; out.moneyGained = -info.cost; out.resourceGained = -loss;
  }
  return out;
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

type UnitApplyOutcome = "applied" | "already_doing";

/** 两道令的落点算不算同一个：都没有落点（就地），或者相距 5 格以内。 */
function sameOrderTarget(a: Order["target"], b: Order["target"]): boolean {
  if (!a || !b) return !a && !b;
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return dx * dx + dy * dy < 25;
}

function applyOrderToUnit(unit: Unit, order: Order, state: GameState): UnitApplyOutcome {
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
        // 刀B 第三类结局：已经在执行等价命令。既不是新派兵，也不是失败——
        // 报「这批兵已经在执行」，且不重建任务、不清旧任务。
        return "already_doing";
      }
    }
  }

  // 刀寅：对**某一批**原样再下一次同一道令（同动作、落点 5 格内）⇒ 已在执行。
  // 典型：长官再说一遍「派 G2 去修理厂」，号已换成那批真走了的人（fromDispatch），
  // 他们正在做这件事——不重下、不另开一条任务、更不会把票上没派的人补派出去。
  // 只认「按批次指代」这一种形状（dispatchMeta.sourceKind === "dispatch"）：
  // 按战线/分队再说一遍"派三个去"，可能就是要再派三个，那一格不在这里判。
  if (order.origin === "advisor" && order.dispatchMeta?.sourceKind === "dispatch") {
    const current = unit.orders[0];
    if (current && current.action === order.action && sameOrderTarget(current.target, order.target)) {
      return "already_doing";
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

  return "applied";
}
