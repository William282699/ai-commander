// ============================================================
// AI Commander — Tactical Planner (Day 7 MVP)
// Intent → precise Orders (rule-aware)
// Supports: attack, defend, retreat, recon, hold
// Unsupported intents degrade gracefully (no crash)
// ============================================================

import type {
  GameState,
  Order,
  OrderAction,
  StyleParams,
  Unit,
  Position,
  Front,
  UnitType,
  TradeType,
} from "@ai-commander/shared";
import type {
  Intent,
  IntentType,
  QuantityHint,
  UnitCategoryHint,
} from "@ai-commander/shared";
import { getUnitCategory, UNIT_STATS, TRADE_COSTS, collectUnitsUnder, isDispatchablePlayerUnit, isFootUnit, resolveSquadRef, isCommanderKey } from "@ai-commander/shared";
import { canUnitEnterTile } from "./sim";
import { createMission } from "./missions";
import { getFormationOffset, computeHeading, type FormationStyle } from "./formation";

// ── Result type ──

export interface ResolveResult {
  orders: Order[];
  log: string;
  degraded: boolean;
  /** Unit IDs assigned by this resolve (for reserved-set tracking in multi-intent). */
  assignedUnitIds: number[];
}

// ── Supported intents (Day 7 base + Day 9 economy) ──

const SUPPORTED_INTENTS: readonly IntentType[] = [
  "attack",
  "defend",
  "retreat",
  "recon",
  "hold",
  "produce",
  "trade",
  "patrol",
  "sabotage",
  "capture",
];

// ── Diagnostics helper ──

const DIAG_DEDUP_SEC = 5;

function pushDiagnostic(state: GameState, code: string, message: string): void {
  const recent = state.diagnostics;
  for (let i = recent.length - 1; i >= 0; i--) {
    if (recent[i].code === code && state.time - recent[i].time < DIAG_DEDUP_SEC) return;
    if (state.time - recent[i].time >= DIAG_DEDUP_SEC) break;
  }
  state.diagnostics.push({ time: state.time, code, message });
  if (state.diagnostics.length > 50) state.diagnostics.shift();
}

// ── Front alias map (Chinese + English → canonical front id) ──

const FRONT_ALIAS_TO_ID: Readonly<Record<string, string>> = {
  // 1. North Plains
  "北线": "front_north", "北路": "front_north", "一线": "front_north", "1": "front_north",
  north: "front_north", northfront: "front_north", frontnorth: "front_north", northplains: "front_north",
  // 2. Central City
  "中线": "front_center", "中路": "front_center", "二线": "front_center", "2": "front_center",
  center: "front_center", central: "front_center", mid: "front_center", middle: "front_center",
  frontcenter: "front_center",
  // 3. Strait Waters
  "海峡": "front_strait", "海线": "front_strait", "三线": "front_strait", "3": "front_strait",
  strait: "front_strait", naval: "front_strait", sea: "front_strait", frontstrait: "front_strait",
  // 4. South Hills
  "南线": "front_south", "南路": "front_south", "四线": "front_south", "4": "front_south",
  south: "front_south", southfront: "front_south", frontsouth: "front_south",
  // 5. Far South
  "远南": "front_far_south", "远南线": "front_far_south", "五线": "front_far_south", "5": "front_far_south",
  farsouth: "front_far_south", farsouthfront: "front_far_south", frontfarsouth: "front_far_south",
};

// ── Source units result (strict mode) ──

interface SourceUnitsResult {
  units: Unit[];
  error?: string;
}

function splitFrontHints(value: string): string[] {
  return value
    .split(/[，,;；|/]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function isAllFrontHint(value: string): boolean {
  const n = normalizeFrontHint(value);
  return (
    n === "all" ||
    n === "allunits" ||
    n === "allfronts" ||
    n === "全部" ||
    n === "全军" ||
    n === "所有"
  );
}

export function isIntentSupported(type: IntentType): boolean {
  return SUPPORTED_INTENTS.includes(type);
}

// ── Main entry point ──

/**
 * Convert an Intent from the LLM into precise game Orders.
 * Day 7 MVP: supports attack / defend / retreat / recon / hold.
 * Unsupported intents return { orders: [], degraded: true }.
 */
/**
 * Normalize intent location fields: LLM often puts tag/region IDs into
 * toFront/fromFront fields. This single-pass normalization moves them to
 * targetRegion so all downstream resolvers get clean front-only fields.
 */
function normalizeIntentLocations(intent: Intent, state: GameState): Intent {
  const normalized = { ...intent };
  for (const field of ["toFront", "fromFront"] as const) {
    const val = normalized[field];
    if (!val) continue;
    if (findFront(state, val)) continue; // genuine front — keep it
    // Not a front: check if tag or region
    const isTag = state.tags?.some(t => t.id === val);
    const isRegion = state.regions.has(val);
    if (isTag || isRegion) {
      // Move to targetRegion (resolveTarget handles tags/regions there)
      if (!normalized.targetRegion) normalized.targetRegion = val;
      normalized[field] = undefined;
      continue;
    }
    // Not a front/tag/region: check if it's a facility name/id
    // LLM often puts facility names like "Himeimat Heights" in toFront — move to targetFacility
    const matchedFac = findFacilityPosition(state, val);
    if (matchedFac && !normalized.targetFacility) {
      normalized.targetFacility = val;
      normalized[field] = undefined;
      continue;
    }
    // If it's none of the above, leave it — isValidTarget will catch it
  }
  return normalized;
}

export function resolveIntent(
  intent: Intent,
  state: GameState,
  style: StyleParams,
  excludeUnitIds?: ReadonlySet<number>,
  selectedUnitIds?: readonly number[],  // Day 10.5: hard constraint from player box-select
): ResolveResult {
  const normalized = normalizeIntentLocations(intent, state);
  const inner = resolveIntentInner(normalized, state, style, excludeUnitIds, selectedUnitIds);

  // Compute assignedUnitIds from orders (for multi-intent reserved-set tracking)
  const ids = new Set<number>();
  for (const o of inner.orders) {
    for (const id of o.unitIds) ids.add(id);
  }
  return { ...inner, assignedUnitIds: Array.from(ids) };
}

/** Inner dispatch — returns result without assignedUnitIds (computed by wrapper). */
function resolveIntentInner(
  intent: Intent,
  state: GameState,
  style: StyleParams,
  exclude?: ReadonlySet<number>,
  selectedUnitIds?: readonly number[],
): Omit<ResolveResult, "assignedUnitIds"> {
  if (!isIntentSupported(intent.type)) {
    const msg = `意图类型 "${intent.type}" 尚未实现，已跳过`;
    pushDiagnostic(state, "UNSUPPORTED_INTENT", msg);
    return { orders: [], log: msg, degraded: true };
  }

  switch (intent.type) {
    case "attack":
      return resolveAttack(intent, state, style, exclude, selectedUnitIds);
    case "defend":
      return resolveDefend(intent, state, style, exclude, selectedUnitIds);
    case "retreat":
      return resolveRetreat(intent, state, style, exclude, selectedUnitIds);
    case "recon":
      return resolveRecon(intent, state, style, exclude, selectedUnitIds);
    case "hold":
      return resolveHold(intent, state, style, exclude, selectedUnitIds);
    case "produce":
      return resolveProduce(intent, state);
    case "trade":
      return resolveTrade(intent, state);
    case "patrol":
      return resolvePatrol(intent, state, style, exclude, selectedUnitIds);
    case "sabotage":
      return resolveSabotage(intent, state, style, exclude, selectedUnitIds);
    case "capture":
      return resolveCapture(intent, state, style, exclude, selectedUnitIds);
    default:
      return {
        orders: [],
        log: `未知意图: ${intent.type}`,
        degraded: true,
      };
  }
}

// ============================================================
// Intent resolvers
// ============================================================

function resolveAttack(
  intent: Intent,
  state: GameState,
  style: StyleParams,
  exclude?: ReadonlySet<number>,
  selectedUnitIds?: readonly number[],
): Omit<ResolveResult, "assignedUnitIds"> {
  const target = resolveTarget(intent, state);
  if (!target) {
    const msg = "无法确定攻击目标位置";
    pushDiagnostic(state, "NO_VISIBLE_TARGET", msg);
    return { orders: [], log: msg, degraded: true };
  }

  const source = resolveSourceUnits(intent, state, exclude, selectedUnitIds);
  if (source.error) {
    pushDiagnostic(state, "NO_AVAILABLE_UNITS", source.error);
    return { orders: [], log: source.error, degraded: true };
  }

  let units = source.units;
  if (intent.unitType) {
    const filtered = units.filter((u) => matchesUnitTypeHint(u, intent.unitType!));
    if (filtered.length === 0 && intent.fromSquad && units.length > 0) {
      // fromSquad set but unitType filter wiped all units → bypass filter
      pushDiagnostic(state, "UNITTYPE_FILTER_BYPASSED",
        `分队 ${intent.fromSquad} 无 ${intent.unitType} 类型单位，已忽略类型筛选`);
    } else {
      units = filtered;
    }
  }

  // Scope-aware quantity default: without fromSquad or a player selection the
  // source pool is the full global list. An LLM-omitted quantity in that case
  // would otherwise send every dispatchable unit into one attack. With a scope,
  // "undefined" honestly means "all of that squad" and stays as-is.
  const isScoped = !!intent.fromSquad || (selectedUnitIds !== undefined && selectedUnitIds.length > 0);
  const count = resolveQuantity(
    isScoped ? intent.quantity : (intent.quantity ?? "some"),
    units.length, style,
  );
  units = sortByDistance(units, target).slice(0, count);

  if (units.length === 0) {
    return { orders: [], log: "无可用单位执行进攻", degraded: true };
  }

  // ── If targeting a facility, emit sabotage orders so damage is actually applied ──
  // BUT: skip sabotage for capture objectives — combat.ts would instantly clear them.
  // Capture objectives should be attacked with attack_move (kill defenders, then capture).
  if (intent.targetFacility) {
    const fac = findFacilityById(state, intent.targetFacility);
    const isCaptureObj = fac && state.captureObjectives?.includes(fac.id);
    if (fac && fac.team !== "player" && !isCaptureObj) {
      const spread = createOrdersWithSpread(
        units, target, state, "sabotage", mapUrgency(intent.urgency), 1.5,
        undefined, intent.routeId, intent.routeIds,
      );
      if (spread.orders.length === 0) {
        const msg = "目标地形不可达，无可用单位执行进攻";
        pushDiagnostic(state, "IMPASSABLE_TARGET", msg);
        return { orders: [], log: msg, degraded: true };
      }
      // Mark orders with targetFacilityId for combat layer facility damage
      for (const order of spread.orders) {
        order.targetFacilityId = fac.id;
        // Phase C: crisis reinforcement dedup tag
        if (intent.excludeFront) order.crisisFrontId = intent.excludeFront;
      }
      // Create sabotage mission for tracking
      const actualUnitIds = spread.orders.flatMap((o) => o.unitIds);
      const squadId = intent.fromSquad || undefined;
      createMission(state, "sabotage", {
        name: `摧毁${fac.name}`,
        description: `派遣 ${actualUnitIds.length} 个单位摧毁目标设施`,
        targetFacilityId: fac.id,
        assignedUnitIds: actualUnitIds,
        etaSec: 120,
        squadId,
      });
      let log = `调度 ${spread.orders.length} 个单位摧毁 ${fac.name}`;
      if (spread.degradedCount > 0) {
        log += ` (${spread.degradedCount} 个已调整目标)`;
      }
      return { orders: spread.orders, log, degraded: false };
    }
  }

  // ④ + ③: spread targets + passability degradation (replaces filterByTargetPassability)
  // Look up squad formation style if dispatching from a squad. resolveSquadRef
  // accepts squad ID / leader name / commander key — commander refs return
  // multiple squads but we only need a representative for formation style.
  const squad = intent.fromSquad ? resolveSquadRef(state, intent.fromSquad)[0] : undefined;
  const formation = squad?.formationStyle as FormationStyle | undefined;
  const spread = createOrdersWithSpread(
    units, target, state, "attack_move", mapUrgency(intent.urgency), 1.5, formation,
    intent.routeId, intent.routeIds,
  );

  if (spread.orders.length === 0) {
    const msg = "目标地形不可达，无可用单位执行进攻";
    pushDiagnostic(state, "IMPASSABLE_TARGET", msg);
    return { orders: [], log: msg, degraded: true };
  }

  // Phase C: tag orders with crisisFrontId for reinforcement dedup.
  // When excludeFront is set, this is a crisis reinforcement — mark orders
  // so scanBattlefield can skip units already en-route to this front.
  if (intent.excludeFront) {
    for (const order of spread.orders) {
      order.crisisFrontId = intent.excludeFront;
    }
  }

  let log = `调度 ${spread.orders.length} 个单位向 (${Math.round(target.x)},${Math.round(target.y)}) 发起进攻`;
  if (spread.degradedCount > 0) {
    log += ` (${spread.degradedCount} 个已调整目标)`;
    pushDiagnostic(state, "DEGRADED_TARGET",
      `${spread.degradedCount} 个单位目标已调整为最近可达点`);
  }
  if (spread.skippedCount > 0) {
    log += ` (${spread.skippedCount} 个无法到达已跳过)`;
  }

  return { orders: spread.orders, log, degraded: false };
}

function resolveDefend(
  intent: Intent,
  state: GameState,
  style: StyleParams,
  exclude?: ReadonlySet<number>,
  selectedUnitIds?: readonly number[],
): Omit<ResolveResult, "assignedUnitIds"> {
  const target = resolveTarget(intent, state);
  const source = resolveSourceUnits(intent, state, exclude, selectedUnitIds);
  if (source.error) {
    return { orders: [], log: source.error, degraded: true };
  }

  let units = source.units;
  if (intent.unitType) {
    const filtered = units.filter((u) => matchesUnitTypeHint(u, intent.unitType!));
    if (filtered.length === 0 && intent.fromSquad && units.length > 0) {
      pushDiagnostic(state, "UNITTYPE_FILTER_BYPASSED",
        `分队 ${intent.fromSquad} 无 ${intent.unitType} 类型单位，已忽略类型筛选`);
    } else {
      units = filtered;
    }
  }

  // Scope-aware quantity default — same shape as resolveAttack, but "few" by
  // default. The prompt already asks the LLM for 3-6 units on a defensive
  // position; this is the code-level safety net when the LLM omits quantity
  // on an unscoped defend, which would otherwise freeze every dispatchable
  // unit and starve subsequent intents in the same option.
  const isScoped = !!intent.fromSquad || (selectedUnitIds !== undefined && selectedUnitIds.length > 0);
  const count = resolveQuantity(
    isScoped ? intent.quantity : (intent.quantity ?? "few"),
    units.length, style,
  );

  if (target) {
    units = sortByDistance(units, target).slice(0, count);
  } else {
    units = units.slice(0, count);
  }

  if (units.length === 0) {
    return { orders: [], log: "无可用单位执行防御", degraded: true };
  }

  // ④ passability degradation for defend target
  if (target) {
    const spread = createOrdersWithSpread(
      units, target, state, "defend", mapUrgency(intent.urgency), 1.0,
    );
    if (spread.orders.length === 0) {
      return { orders: [], log: "目标地形不可达，无可用单位执行防御", degraded: true };
    }
    let log = `${spread.orders.length} 个单位转入防御态势`;
    if (spread.degradedCount > 0) {
      log += ` (${spread.degradedCount} 个已调整位置)`;
    }
    return { orders: spread.orders, log, degraded: false };
  }

  // No target: defend in place
  const orders: Order[] = [{
    unitIds: units.map((u) => u.id),
    action: "defend",
    target: null,
    priority: mapUrgency(intent.urgency),
  }];
  return { orders, log: `${units.length} 个单位转入防御态势`, degraded: false };
}

function resolveRetreat(
  intent: Intent,
  state: GameState,
  style: StyleParams,
  exclude?: ReadonlySet<number>,
  selectedUnitIds?: readonly number[],
): Omit<ResolveResult, "assignedUnitIds"> {
  const source = resolveSourceUnits(intent, state, exclude, selectedUnitIds);
  if (source.error) {
    return { orders: [], log: source.error, degraded: true };
  }

  let units = source.units;
  if (intent.unitType) {
    const filtered = units.filter((u) => matchesUnitTypeHint(u, intent.unitType!));
    if (filtered.length === 0 && intent.fromSquad && units.length > 0) {
      pushDiagnostic(state, "UNITTYPE_FILTER_BYPASSED",
        `分队 ${intent.fromSquad} 无 ${intent.unitType} 类型单位，已忽略类型筛选`);
    } else {
      units = filtered;
    }
  }

  const count = resolveQuantity(intent.quantity, units.length, style);
  units = units.slice(0, count);

  if (units.length === 0) {
    return { orders: [], log: "无可用单位执行撤退", degraded: true };
  }

  // Retreat target: move towards player HQ (dynamic lookup)
  const playerBase: Position = findPlayerHQPosition(state) ?? { x: 100, y: 10 };

  const orders: Order[] = [];
  for (const u of units) {
    const dx = playerBase.x - u.position.x;
    const dy = playerBase.y - u.position.y;
    const dist = Math.sqrt(dx * dx + dy * dy);
    const retreatDist = Math.min(25, dist * 0.6);
    const roughTarget: Position =
      dist < 1
        ? playerBase
        : {
            x: Math.round(u.position.x + (dx / dist) * retreatDist),
            y: Math.round(u.position.y + (dy / dist) * retreatDist),
          };

    const safeTarget = ensurePassableTarget(u, roughTarget, state);
    if (!safeTarget) continue; // skip unit if no passable retreat point

    orders.push({
      unitIds: [u.id],
      action: "retreat" as const,
      target: safeTarget,
      priority: mapUrgency(intent.urgency),
    });
  }

  if (orders.length === 0) {
    return { orders: [], log: "撤退目标地形不可达，无可执行命令", degraded: true };
  }

  const skipped = units.length - orders.length;
  const skipNote = skipped > 0 ? `（${skipped} 个单位因地形限制未下达）` : "";

  return {
    orders,
    log: `命令 ${orders.length} 个单位撤退至安全区域${skipNote}`,
    degraded: false,
  };
}

function resolveRecon(
  intent: Intent,
  state: GameState,
  style: StyleParams,
  exclude?: ReadonlySet<number>,
  selectedUnitIds?: readonly number[],
): Omit<ResolveResult, "assignedUnitIds"> {
  const target = resolveTarget(intent, state);
  if (!target) {
    return { orders: [], log: "无法确定侦察目标位置", degraded: true };
  }

  const source = resolveSourceUnits(intent, state, exclude, selectedUnitIds);
  if (source.error) {
    return { orders: [], log: source.error, degraded: true };
  }

  let units = source.units;

  // Prefer fast / scout units
  const scouts = units.filter(
    (u) =>
      u.type === "recon_plane" ||
      u.type === "light_tank" ||
      u.type === "infantry",
  );
  units = scouts.length > 0 ? scouts : units;

  const count = resolveQuantity(intent.quantity ?? "few", units.length, style);
  const selected = sortByDistance(units, target).slice(0, count);

  if (selected.length === 0) {
    return { orders: [], log: "无可用单位执行侦察", degraded: true };
  }

  // ④ passability degradation (no spread for recon — units scout independently)
  const spread = createOrdersWithSpread(
    selected, target, state, "recon", mapUrgency(intent.urgency), 0,
  );

  if (spread.orders.length === 0) {
    return { orders: [], log: "侦察目标不可达", degraded: true };
  }

  let log = `派出 ${spread.orders.length} 个单位侦察 (${Math.round(target.x)},${Math.round(target.y)})`;
  if (spread.degradedCount > 0) {
    log += ` (${spread.degradedCount} 个已调整目标)`;
  }
  return { orders: spread.orders, log, degraded: false };
}

function resolveHold(
  intent: Intent,
  state: GameState,
  style: StyleParams,
  exclude?: ReadonlySet<number>,
  selectedUnitIds?: readonly number[],
): Omit<ResolveResult, "assignedUnitIds"> {
  const source = resolveSourceUnits(intent, state, exclude, selectedUnitIds);
  if (source.error) {
    return { orders: [], log: source.error, degraded: true };
  }

  let units = source.units;
  if (intent.unitType) {
    const filtered = units.filter((u) => matchesUnitTypeHint(u, intent.unitType!));
    if (filtered.length === 0 && intent.fromSquad && units.length > 0) {
      pushDiagnostic(state, "UNITTYPE_FILTER_BYPASSED",
        `分队 ${intent.fromSquad} 无 ${intent.unitType} 类型单位，已忽略类型筛选`);
    } else {
      units = filtered;
    }
  }

  const count = resolveQuantity(intent.quantity, units.length, style);
  units = units.slice(0, count);

  if (units.length === 0) {
    return { orders: [], log: "无可用单位执行原地待命", degraded: true };
  }

  const orders: Order[] = [
    {
      unitIds: units.map((u) => u.id),
      action: "hold",
      target: null,
      priority: mapUrgency(intent.urgency),
    },
  ];

  return {
    orders,
    log: `命令 ${units.length} 个单位原地待命`,
    degraded: false,
  };
}

// ── Day 9: produce / trade / patrol resolvers ──

function resolveProduce(
  intent: Intent,
  state: GameState,
): Omit<ResolveResult, "assignedUnitIds"> {
  const unitType = intent.produceType as UnitType | undefined;
  if (!unitType || !UNIT_STATS[unitType]) {
    const msg = unitType
      ? `未知单位类型: ${unitType}`
      : "生产命令未指定单位类型";
    pushDiagnostic(state, "PRODUCE_FAIL", msg);
    return { orders: [], log: msg, degraded: true };
  }

  // Support quantity: number → loop, default 1
  const count = typeof intent.quantity === "number"
    ? Math.max(1, Math.min(intent.quantity, 10)) // cap 10
    : 1;

  const orders: Order[] = [];
  for (let i = 0; i < count; i++) {
    orders.push({
      unitIds: [],
      action: "produce",
      target: null,
      produceUnitType: unitType,
      priority: mapUrgency(intent.urgency),
    });
  }

  return {
    orders,
    log: `下达生产命令: ${unitType} ×${count}`,
    degraded: false,
  };
}

function resolveTrade(
  intent: Intent,
  state: GameState,
): Omit<ResolveResult, "assignedUnitIds"> {
  const tradeAction = intent.tradeAction as string | undefined;
  if (!tradeAction || !TRADE_COSTS[tradeAction as keyof typeof TRADE_COSTS]) {
    const msg = tradeAction
      ? `未知交易类型: ${tradeAction}`
      : "交易命令未指定交易类型";
    pushDiagnostic(state, "TRADE_FAIL", msg);
    return { orders: [], log: msg, degraded: true };
  }

  const orders: Order[] = [{
    unitIds: [],
    action: "trade",
    target: null,
    tradeType: tradeAction as import("@ai-commander/shared").TradeType,
    priority: mapUrgency(intent.urgency),
  }];

  return {
    orders,
    log: `下达交易命令: ${tradeAction}`,
    degraded: false,
  };
}

// Day 9.5: patrol radius constant mapping
const PATROL_RADIUS_MAP: Record<string, number> = {
  small: 5,  "小": 5,
  medium: 10, "中": 10,
  large: 15,  "大": 15,
};

function resolvePatrol(
  intent: Intent,
  state: GameState,
  style: StyleParams,
  exclude?: ReadonlySet<number>,
  selectedUnitIds?: readonly number[],
): Omit<ResolveResult, "assignedUnitIds"> {
  const target = resolveTarget(intent, state);
  const source = resolveSourceUnits(intent, state, exclude, selectedUnitIds);
  if (source.error) {
    pushDiagnostic(state, "NO_AVAILABLE_UNITS", source.error);
    return { orders: [], log: source.error, degraded: true };
  }

  let units = source.units;
  if (intent.unitType) {
    const filtered = units.filter((u) => matchesUnitTypeHint(u, intent.unitType!));
    if (filtered.length === 0 && intent.fromSquad && units.length > 0) {
      pushDiagnostic(state, "UNITTYPE_FILTER_BYPASSED",
        `分队 ${intent.fromSquad} 无 ${intent.unitType} 类型单位，已忽略类型筛选`);
    } else {
      units = filtered;
    }
  }

  const count = resolveQuantity(intent.quantity ?? "few", units.length, style);
  const selected = target
    ? sortByDistance(units, target).slice(0, count)
    : units.slice(0, count);

  if (selected.length === 0) {
    const msg = "无可用单位执行巡逻";
    pushDiagnostic(state, "NO_AVAILABLE_UNITS", msg);
    return { orders: [], log: msg, degraded: true };
  }

  // Day 9.5: resolve patrol radius
  let radius = 10; // default medium
  if (intent.patrolRadius !== undefined) {
    // Check if it maps to a named size, otherwise clamp numeric
    const mapped = PATROL_RADIUS_MAP[String(intent.patrolRadius)];
    radius = mapped ?? Math.round(Math.max(3, Math.min(30, intent.patrolRadius)));
  }

  // Compute center (from target or average of selected units)
  let center: Position;
  if (target) {
    center = target;
  } else {
    let sumX = 0, sumY = 0;
    for (const u of selected) {
      sumX += u.position.x;
      sumY += u.position.y;
    }
    center = { x: sumX / selected.length, y: sumY / selected.length };
  }

  // Quantize center to integer tile
  const centerTileX = Math.round(center.x);
  const centerTileY = Math.round(center.y);

  // Create per-unit orders with patrolTaskParams
  const orders: Order[] = selected.map((u) => ({
    unitIds: [u.id],
    action: "patrol" as OrderAction,
    target: center,
    priority: mapUrgency(intent.urgency),
    patrolTaskParams: { centerTileX, centerTileY, radius },
  }));

  return {
    orders,
    log: `巡逻任务已下达: ${selected.length} 个单位在 (${centerTileX},${centerTileY}) 半径${radius} 范围巡逻`,
    degraded: false,
  };
}

// ── Day 11: sabotage resolver ──

function resolveSabotage(
  intent: Intent,
  state: GameState,
  style: StyleParams,
  exclude?: ReadonlySet<number>,
  selectedUnitIds?: readonly number[],
): Omit<ResolveResult, "assignedUnitIds"> {
  // Target must be a facility
  const facilityHint = intent.targetFacility;
  if (!facilityHint) {
    const msg = "破坏命令未指定目标设施";
    pushDiagnostic(state, "SABOTAGE_NO_TARGET", msg);
    return { orders: [], log: msg, degraded: true };
  }

  const target = findFacilityPosition(state, facilityHint);
  if (!target) {
    const msg = `无法定位目标设施: ${facilityHint}`;
    pushDiagnostic(state, "SABOTAGE_NO_TARGET", msg);
    return { orders: [], log: msg, degraded: true };
  }

  // Resolve facility for mission creation
  const fac = findFacilityById(state, facilityHint);

  const source = resolveSourceUnits(intent, state, exclude, selectedUnitIds);
  if (source.error) {
    pushDiagnostic(state, "NO_AVAILABLE_UNITS", source.error);
    return { orders: [], log: source.error, degraded: true };
  }

  let units = source.units;

  // Prefer infantry + light_tank (sabotage operatives)
  const saboteurs = units.filter(
    (u) => u.type === "infantry" || u.type === "light_tank",
  );
  units = saboteurs.length > 0 ? saboteurs : units;

  const count = resolveQuantity(intent.quantity ?? "some", units.length, style);
  units = sortByDistance(units, target).slice(0, count);

  if (units.length === 0) {
    return { orders: [], log: "无可用单位执行破坏任务", degraded: true };
  }

  // Squad ID for mission linkage (if fromSquad was provided)
  const squadId = intent.fromSquad || undefined;

  // Issue sabotage orders to the facility (action: "sabotage" — NOT attack_move)
  const spread = createOrdersWithSpread(
    units, target, state, "sabotage", mapUrgency(intent.urgency), 1.5,
  );

  if (spread.orders.length === 0) {
    return { orders: [], log: "目标地形不可达，无法执行破坏", degraded: true };
  }

  // Mark orders with targetFacilityId for combat layer facility damage
  for (const order of spread.orders) {
    order.targetFacilityId = fac?.id ?? facilityHint;
  }

  // P1-2 fix: create mission AFTER confirming orders can be dispatched
  const actualUnitIds = spread.orders.flatMap((o) => o.unitIds);
  createMission(state, "sabotage", {
    name: `破坏${fac ? fac.name : facilityHint}`,
    description: `派遣 ${actualUnitIds.length} 个单位破坏目标设施`,
    targetFacilityId: fac?.id ?? facilityHint,
    assignedUnitIds: actualUnitIds,
    etaSec: 120,
    squadId,
  });

  let log = `派出 ${spread.orders.length} 个单位执行破坏任务: ${fac?.name ?? facilityHint}`;
  if (spread.degradedCount > 0) {
    log += ` (${spread.degradedCount} 个已调整目标)`;
  }
  return { orders: spread.orders, log, degraded: false };
}

function resolveCapture(
  intent: Intent,
  state: GameState,
  style: StyleParams,
  exclude?: ReadonlySet<number>,
  selectedUnitIds?: readonly number[],
): Omit<ResolveResult, "assignedUnitIds"> {
  // Resolve target: prefer facility, fall back to front/region
  let target: Position | null = null;
  let facilityName = intent.targetFacility ?? "";

  if (intent.targetFacility) {
    target = findFacilityPosition(state, intent.targetFacility);
    const fac = findFacilityById(state, intent.targetFacility);
    if (fac) facilityName = fac.name;
  }
  if (!target) {
    target = resolveTarget(intent, state);
  }
  if (!target) {
    const msg = `占领命令无法定位目标: ${intent.targetFacility ?? intent.toFront ?? "未指定"}`;
    pushDiagnostic(state, "CAPTURE_NO_TARGET", msg);
    return { orders: [], log: msg, degraded: true };
  }

  const source = resolveSourceUnits(intent, state, exclude, selectedUnitIds);
  if (source.error) {
    pushDiagnostic(state, "NO_AVAILABLE_UNITS", source.error);
    return { orders: [], log: source.error, degraded: true };
  }

  let units = source.units;
  // Scenario-aware capture doctrine. Must match economy.ts::tickFacilityCapture
  // line 118-126 — the *actual* game-engine rule that decides who can capture:
  //   - El Alamein: any GROUND unit (infantry + armor + commanders)
  //   - Default:   infantry only
  // Previously this resolver hard-preferred infantry in ALL scenarios, which on
  // El Alamein shrank a tank-heavy squad (e.g. Blake) to 0-2 lone infantry and
  // effectively made "Blake capture X" dispatch a single token soldier while
  // the real combat force sat idle.
  const isElAlamein = state.scenarioId === "el_alamein";
  if (isElAlamein) {
    // Air/naval can't stand on a facility — filter to ground only.
    units = units.filter((u) => getUnitCategory(u.type) === "ground");
  } else {
    const infantry = units.filter((u) => u.type === "infantry");
    units = infantry.length > 0 ? infantry : units;
  }

  const count = resolveQuantity(intent.quantity ?? "some", units.length, style);
  units = sortByDistance(units, target).slice(0, count);

  if (units.length === 0) {
    return { orders: [], log: "无可用单位执行占领任务", degraded: true };
  }

  // Move units to facility and set up capture (uses attack_move to handle hostiles en route)
  const spread = createOrdersWithSpread(
    units, target, state, "attack_move", mapUrgency(intent.urgency), 1.0,
  );

  if (spread.orders.length === 0) {
    return { orders: [], log: "目标地形不可达，无法执行占领", degraded: true };
  }

  // Mark orders with targetFacilityId so the economy layer picks up capture proximity
  if (intent.targetFacility) {
    const fac = findFacilityById(state, intent.targetFacility);
    for (const order of spread.orders) {
      order.targetFacilityId = fac?.id ?? intent.targetFacility;
    }
  }

  // Create tracking mission
  const actualUnitIds = spread.orders.flatMap((o) => o.unitIds);
  const squadId = intent.fromSquad || undefined;
  createMission(state, "capture", {
    name: `占领${facilityName || "目标"}`,
    description: `派遣 ${actualUnitIds.length} 个单位占领目标`,
    assignedUnitIds: actualUnitIds,
    etaSec: 90,
    squadId,
    targetFacilityId: intent.targetFacility ?? undefined,
  });

  let log = `派出 ${spread.orders.length} 个单位执行占领: ${facilityName || "目标区域"}`;
  if (spread.degradedCount > 0) {
    log += ` (${spread.degradedCount} 个已调整目标)`;
  }
  return { orders: spread.orders, log, degraded: false };
}

/** Find a facility by id, type, name, or tag (returns full Facility or undefined). */
export function findFacilityById(
  state: GameState,
  facilityHint: string,
): import("@ai-commander/shared").Facility | undefined {
  const fac = state.facilities.get(facilityHint);
  if (fac) return fac;

  const lower = facilityHint.toLowerCase();
  for (const [, f] of state.facilities) {
    if (
      f.type.toLowerCase().includes(lower) ||
      f.name.toLowerCase().includes(lower) ||
      f.tags.some((t) => t.toLowerCase().includes(lower))
    ) {
      return f;
    }
  }
  return undefined;
}

// ============================================================
// Helpers
// ============================================================

/** Resolve attack/defend/recon target position from intent fields. */
function resolveTarget(intent: Intent, state: GameState): Position | null {
  // Internal override: crisis card system provides exact coordinates
  // (enemy centroid) to avoid region/front center inaccuracy.
  if (intent._targetPos) {
    return { x: intent._targetPos.x, y: intent._targetPos.y };
  }
  if (intent.targetFacility) {
    const pos = findFacilityPosition(state, intent.targetFacility);
    if (pos) return pos;
  }
  if (intent.targetRegion) {
    // Day 15: check tags first, then regions, then fronts
    const tag = state.tags?.find(t => t.id === intent.targetRegion);
    if (tag) return { x: Math.round(tag.position.x), y: Math.round(tag.position.y) };
    const pos = getRegionCenter(state, intent.targetRegion);
    if (pos) return pos;
    // Also try front match (LLM might put front id in targetRegion)
    const front = findFront(state, intent.targetRegion);
    if (front) return getFrontCenterPos(state, front);
  }
  if (intent.toFront) {
    const front = findFront(state, intent.toFront);
    if (front) return getFrontCenterPos(state, front);
  }
  // For some intents, fromFront can serve as target area
  if (intent.fromFront) {
    const front = findFront(state, intent.fromFront);
    if (front) return getFrontCenterPos(state, front);
  }
  // Last resort: try all location fields as facility name (fuzzy match).
  // Catches cases where LLM puts a facility name in toFront/targetRegion
  // and normalizeIntentLocations didn't move it (shouldn't happen, but defensive).
  for (const val of [intent.toFront, intent.targetRegion, intent.fromFront]) {
    if (val) {
      const pos = findFacilityPosition(state, val);
      if (pos) return pos;
    }
  }
  return null;
}

/**
 * Find player units to assign (strict mode).
 *
 * Rules:
 * - fromFront given but not found → error (degraded)
 * - fromFront found but 0 units   → error (degraded)
 * - only toFront: prefer local units; local empty → global fallback
 * - no front hints at all → global fallback
 * - NO "smart from↔to swap" — never silently reinterpret fromFront
 */
function resolveSourceUnits(
  intent: Intent,
  state: GameState,
  exclude?: ReadonlySet<number>,
  selectedUnitIds?: readonly number[],  // Day 10.5: hard constraint from player box-select
): SourceUnitsResult {
  // When excludeFront matches toFront, the intent is "send units TO this
  // front but NOT FROM this front" (crisis reinforcement). Skip the toFront
  // local-preference path in source resolution so we get the global pool
  // instead of units already at the front (which excludeFront would filter
  // out anyway, leaving an empty set).
  let sourceIntent = intent;
  if (intent.excludeFront && intent.toFront) {
    const exFront = findFront(state, intent.excludeFront);
    const toFrontObj = findFront(state, intent.toFront);
    if (exFront && toFrontObj && exFront.id === toFrontObj.id) {
      sourceIntent = { ...intent, toFront: undefined };
    }
  }

  const raw = resolveSourceUnitsRaw(sourceIntent, state);

  let units = raw.units;
  if (raw.error) return raw;

  // selectedUnitIds is a HARD constraint for manual unit control (right-click move).
  // Chat commands never pass selectedUnitIds — they let the LLM decide.
  if (selectedUnitIds && selectedUnitIds.length > 0) {
    const selectedSet = new Set(selectedUnitIds);
    units = units.filter((u) => selectedSet.has(u.id));
    if (units.length === 0) {
      return { units: [], error: "框选的单位不在可调度范围内" };
    }
  }

  // Apply multi-intent exclusion filter
  if (exclude && exclude.size > 0 && units.length > 0) {
    const filtered = units.filter((u) => !exclude.has(u.id));
    if (filtered.length === 0 && units.length > 0) {
      return { units: [], error: "所有可用单位已被前序意图占用" };
    }
    units = filtered;
  }

  // excludeFront: filter out units physically inside a specific front.
  // Used by crisis card reinforcement intents to ensure only units
  // OUTSIDE the crisis front are dispatched — regardless of source path
  // (fromSquad, toFront, global pool).
  if (intent.excludeFront) {
    const exFront = findFront(state, intent.excludeFront);
    if (exFront) {
      const bboxes = exFront.regionIds
        .map((rid) => state.regions.get(rid))
        .filter((r): r is NonNullable<typeof r> => r !== undefined)
        .map((r) => r.bbox);
      const outside = units.filter((u) =>
        !bboxes.some(([x1, y1, x2, y2]) =>
          u.position.x >= x1 && u.position.x <= x2 &&
          u.position.y >= y1 && u.position.y <= y2,
        ),
      );
      if (outside.length === 0) {
        return { units: [], error: "危机前线外无可用增援单位" };
      }
      units = outside;
    }
  }

  // Prefer idle units: avoid pulling units already on a mission (defending/attacking/etc.)
  // Skip busy-filter when:
  //   - quantity is "all"/"most" (explicit full mobilization), OR
  //   - fromSquad is set AND quantity is missing/undefined (user named a squad without
  //     specifying a partial amount — intent is "everyone under this person, go").
  // When fromSquad + quantity is "few"/"some"/number, keep busy-filter (partial dispatch).
  const busyStates = new Set(["defending", "attacking", "moving", "retreating"]);
  const isFullMobilization = intent.quantity === "all" || intent.quantity === "most";
  const isSquadDefaultAll = !!intent.fromSquad && (intent.quantity == null || intent.quantity === undefined);
  if (!isFullMobilization && !isSquadDefaultAll) {
    const idleUnits = units.filter((u) => !busyStates.has(u.state));
    // Crisis reinforcement (excludeFront set): strict idle-only, never fall back
    // to the full pool. Falling back would re-dispatch units already moving to
    // reinforce, causing the "click C again, same troops re-ordered" bug.
    if (intent.excludeFront) {
      units = idleUnits;
      if (units.length === 0) {
        return { units: [], error: "无空闲增援单位可调度（其余部队正在移动中）" };
      }
    } else {
      // Normal dispatch: use idle pool if there are enough; otherwise fall back to full pool
      if (idleUnits.length >= 2) {
        units = idleUnits;
      }
    }
  }

  return { units };
}

function resolveSourceUnitsRaw(
  intent: Intent,
  state: GameState,
): SourceUnitsResult {
  // ── Phase 2: fromSquad — delegate ref resolution to shared helper,
  // which already handles squad ID / leader name / commander key in one pass.
  // We preserve the commander-vs-leaf distinction only in the error message.
  if (intent.fromSquad && typeof intent.fromSquad === "string") {
    const matched = resolveSquadRef(state, intent.fromSquad);
    if (matched.length === 0) {
      return { units: [], error: `无法找到分队: ${intent.fromSquad}` };
    }

    // Aggregate units across all matched squads (commander ref → many; leaf → one).
    // Dedup via Set since collectUnitsUnder may overlap if squads share descendants.
    const allIds = new Set<number>();
    for (const sq of matched) {
      for (const id of collectUnitsUnder(state, sq.id)) allIds.add(id);
    }
    const units = Array.from(allIds)
      .map((id) => state.units.get(id))
      .filter((u): u is Unit => u !== undefined && isDispatchablePlayerUnit(u));
    if (units.length > 0) return { units };

    // Matched squads but none dispatchable — error wording differentiates
    // "commander's forces all spent" from "that specific squad wiped."
    return {
      units: [],
      error: isCommanderKey(intent.fromSquad)
        ? `指挥官 ${intent.fromSquad} 下属无可用单位`
        : `分队 ${intent.fromSquad} 无可用单位（已阵亡或被手动接管）`,
    };
  }

  const fromHint =
    typeof intent.fromFront === "string" && intent.fromFront.trim().length > 0
      ? intent.fromFront
      : null;
  const toHint =
    typeof intent.toFront === "string" && intent.toFront.trim().length > 0
      ? intent.toFront
      : null;

  // ── fromFront: strict ──
  if (fromHint) {
    // Common LLM output: "all", "全军", etc. Treat as global pool.
    if (isAllFrontHint(fromHint)) {
      return { units: getAllAvailablePlayerUnits(state) };
    }

    // Day 10.5 Fix 3: quantity=all/most with fromFront → global pool
    // fromFront is a hint only; user intent is "all units", not "only those in this bbox"
    if (intent.quantity === "all" || intent.quantity === "most") {
      return { units: getAllAvailablePlayerUnits(state) };
    }

    // Common LLM output: comma-separated multiple fronts.
    const parts = splitFrontHints(fromHint);
    if (parts.length > 1) {
      const byId = new Map<number, Unit>();
      let matchedFrontCount = 0;
      for (const part of parts) {
        if (isAllFrontHint(part)) {
          return { units: getAllAvailablePlayerUnits(state) };
        }
        const front = findFront(state, part);
        if (!front) continue;
        matchedFrontCount += 1;
        const frontUnits = getUnitsOnFront(state, front);
        for (const u of frontUnits) byId.set(u.id, u);
      }
      if (byId.size > 0) {
        return { units: Array.from(byId.values()) };
      }
      if (matchedFrontCount > 0) {
        // For retreat/defend: do NOT fallback to global pool
        if (intent.type === "retreat" || intent.type === "defend") {
          return { units: [], error: "指定来源战线暂无可用单位" };
        }
        const all = getAllAvailablePlayerUnits(state);
        if (all.length > 0) return { units: all };
        return { units: [], error: "指定来源战线暂无可用单位" };
      }
      return { units: [], error: `无法匹配来源战线: ${fromHint}` };
    }

    const sourceFront = findFront(state, fromHint);
    if (!sourceFront) {
      return { units: [], error: `无法匹配来源战线: ${fromHint}` };
    }
    const frontUnits = getUnitsOnFront(state, sourceFront);
    if (frontUnits.length === 0) {
      // For retreat/defend: do NOT fallback to global pool — only retreat units
      // actually on this front. Global fallback caused full-army mis-retreats.
      if (intent.type === "retreat" || intent.type === "defend") {
        return { units: [], error: `战线 "${sourceFront.name}" 暂无可用单位` };
      }
      // For other intent types (attack, etc.): soft fallback to global pool
      const all = getAllAvailablePlayerUnits(state);
      if (all.length > 0) return { units: all };
      return { units: [], error: `战线 "${sourceFront.name}" 暂无可用单位` };
    }
    return { units: frontUnits };
  }

  // ── toFront only: prefer local, fallback global ──
  if (toHint) {
    const targetFront = findFront(state, toHint);
    if (targetFront) {
      const localUnits = getUnitsOnFront(state, targetFront);

      // Day 10.5 Fix 2: broaden source pool for large-scale redeploy.
      // attack: quantity=all/most OR tiny local force (<=1)
      // retreat/defend: only quantity=all/most (P3-7: conservative, no localUnits<=1)
      const wantsBroadDispatch =
        (intent.type === "attack" &&
          (intent.quantity === "all" || intent.quantity === "most" || localUnits.length <= 1)) ||
        ((intent.type === "retreat" || intent.type === "defend") &&
          (intent.quantity === "all" || intent.quantity === "most"));
      if (wantsBroadDispatch) {
        const all = getAllAvailablePlayerUnits(state);
        if (all.length > 0) return { units: all };
      }

      if (localUnits.length > 0) return { units: localUnits };
      // Local empty — user wants to send units TO this front, use global pool
    } else {
      return { units: [], error: `无法匹配目标战线: ${toHint}` };
    }
  }

  // ── No front hints (or toFront with no local units): global fallback ──
  return { units: getAllAvailablePlayerUnits(state) };
}

function getAllAvailablePlayerUnits(state: GameState): Unit[] {
  const all: Unit[] = [];
  state.units.forEach((u) => {
    if (isDispatchablePlayerUnit(u)) {
      all.push(u);
    }
  });
  return all;
}

/** Normalize a front hint for alias lookup: trim, lowercase, strip separators. */
function normalizeFrontHint(value: string): string {
  return value.trim().toLowerCase().replace(/[\s_.\-]+/g, "");
}

/**
 * Fuzzy-match a front by alias → exact id/name → substring.
 * Three layers: alias table → normalized exact → lowercase substring.
 */
export function findFront(state: GameState, hint: string): Front | undefined {
  // Layer 1: alias table
  const normalized = normalizeFrontHint(hint);
  const aliasedId = FRONT_ALIAS_TO_ID[normalized];
  if (aliasedId) {
    const aliased = state.fronts.find((f) => f.id === aliasedId);
    if (aliased) return aliased;
  }

  // Layer 2: exact match on normalized id/name
  const exact = state.fronts.find(
    (f) =>
      normalizeFrontHint(f.id) === normalized ||
      normalizeFrontHint(f.name) === normalized,
  );
  if (exact) return exact;

  // Layer 3: substring match (original behavior)
  const lower = hint.toLowerCase();
  return state.fronts.find(
    (f) =>
      f.id === hint ||
      f.id.toLowerCase().includes(lower) ||
      f.name.toLowerCase().includes(lower),
  );
}

/** Get all dispatchable player units within a front's regions. */
function getUnitsOnFront(state: GameState, front: Front): Unit[] {
  const bboxes = front.regionIds
    .map((rid) => state.regions.get(rid))
    .filter((r): r is NonNullable<typeof r> => r !== undefined)
    .map((r) => r.bbox);

  const units: Unit[] = [];
  state.units.forEach((u) => {
    if (!isDispatchablePlayerUnit(u)) return;
    const inFront = bboxes.some(
      ([x1, y1, x2, y2]) =>
        u.position.x >= x1 &&
        u.position.x <= x2 &&
        u.position.y >= y1 &&
        u.position.y <= y2,
    );
    if (inFront) units.push(u);
  });
  return units;
}

/** Compute center position of a front's regions. */
function getFrontCenterPos(state: GameState, front: Front): Position | null {
  let totalX = 0;
  let totalY = 0;
  let count = 0;
  for (const rid of front.regionIds) {
    const region = state.regions.get(rid);
    if (region) {
      totalX += (region.bbox[0] + region.bbox[2]) / 2;
      totalY += (region.bbox[1] + region.bbox[3]) / 2;
      count++;
    }
  }
  if (count === 0) return null;
  return { x: Math.round(totalX / count), y: Math.round(totalY / count) };
}

/** Find a region's center by exact id or fuzzy name match. */
function getRegionCenter(state: GameState, regionHint: string): Position | null {
  const lower = regionHint.toLowerCase();
  let found = state.regions.get(regionHint);
  if (!found) {
    for (const [, r] of state.regions) {
      if (
        r.id.toLowerCase().includes(lower) ||
        r.name.toLowerCase().includes(lower)
      ) {
        found = r;
        break;
      }
    }
  }
  if (!found) return null;
  return {
    x: (found.bbox[0] + found.bbox[2]) / 2,
    y: (found.bbox[1] + found.bbox[3]) / 2,
  };
}

/** Find a facility position by id, type, name, or tag match. */
function findFacilityPosition(
  state: GameState,
  facilityHint: string,
): Position | null {
  const fac = state.facilities.get(facilityHint);
  if (fac) return { ...fac.position };

  const lower = facilityHint.toLowerCase();
  for (const [, f] of state.facilities) {
    if (
      f.type.toLowerCase().includes(lower) ||
      f.name.toLowerCase().includes(lower) ||
      f.tags.some((t) => t.toLowerCase().includes(lower))
    ) {
      return { ...f.position };
    }
  }
  return null;
}

/** Check if a unit matches the LLM's unit-type hint. */
function matchesUnitTypeHint(unit: Unit, hint: UnitCategoryHint): boolean {
  switch (hint) {
    case "armor":
      return (
        unit.type === "light_tank" ||
        unit.type === "main_tank" ||
        unit.type === "artillery"
      );
    case "infantry":
      // "infantry" hint covers all biological foot units, including commander
      // and elite_guard — they share infantry movement/cover/capture rules.
      return isFootUnit(unit.type);
    case "air":
      return getUnitCategory(unit.type) === "air";
    case "naval":
      return getUnitCategory(unit.type) === "naval";
    default:
      return true;
  }
}

/** Convert a quantity hint to a concrete number. */
function resolveQuantity(
  q: QuantityHint | undefined,
  total: number,
  style: StyleParams,
): number {
  if (total === 0) return 0;
  if (q === undefined) return total;
  if (typeof q === "number") return Math.min(q, total);
  switch (q) {
    case "all":
      return total;
    case "most":
      return Math.max(1, Math.ceil(total * 0.75));
    case "some":
      return Math.max(
        1,
        Math.ceil(total * (style.riskTolerance > 0.5 ? 0.6 : 0.4)),
      );
    case "few":
      return Math.min(3, total);
    default:
      return total;
  }
}

/** Sort units by distance to a target (closest first). */
function sortByDistance(units: Unit[], target: Position): Unit[] {
  return [...units].sort((a, b) => {
    const da =
      (a.position.x - target.x) ** 2 + (a.position.y - target.y) ** 2;
    const db =
      (b.position.x - target.x) ** 2 + (b.position.y - target.y) ** 2;
    return da - db;
  });
}

/** Map intent urgency to Order priority. */
function mapUrgency(
  urgency?: string,
): "low" | "medium" | "high" {
  switch (urgency) {
    case "critical":
    case "high":
      return "high";
    case "medium":
      return "medium";
    case "low":
    default:
      return "low";
  }
}

/** Find player HQ position from facilities. Returns null if not found. */
function findPlayerHQPosition(state: GameState): Position | null {
  for (const [, f] of state.facilities) {
    if (f.team === "player" && f.type === "headquarters") {
      return { ...f.position };
    }
  }
  return null;
}

// ── ③ Target spread ──

/** Offset a position around a center in a circle formation. */
function spreadTarget(
  center: Position,
  index: number,
  total: number,
  radius: number,
): Position {
  if (total <= 1 || radius <= 0) return center;
  const angle = (2 * Math.PI * index) / total;
  return {
    x: center.x + Math.cos(angle) * radius,
    y: center.y + Math.sin(angle) * radius,
  };
}

// ── ④ Level 2 passability degradation + ③ spread ──

/**
 * Create per-unit orders with:
 * - ③ Spread: offset units around center in a circle (avoids blob-forming)
 * - ④ Passability degradation: if spread/center tile is impassable, find nearest passable
 * Returns combined orders and degradation stats.
 */
function createOrdersWithSpread(
  units: Unit[],
  center: Position,
  state: GameState,
  action: OrderAction,
  priority: Order["priority"],
  spreadRadius: number = 1.5,
  formationStyle?: FormationStyle,
  routeId?: string,
  routeIds?: string[],
): { orders: Order[]; degradedCount: number; skippedCount: number } {
  const orders: Order[] = [];
  let degradedCount = 0;
  let skippedCount = 0;

  // Compute heading for formation offset (from centroid to target)
  let heading = 0;
  if (formationStyle && units.length > 1) {
    let cx = 0, cy = 0;
    for (const u of units) { cx += u.position.x; cy += u.position.y; }
    cx /= units.length; cy /= units.length;
    heading = computeHeading({ x: cx, y: cy }, center);
  }

  // Determine if we should use named route resolution
  const useRoutes = state.namedRoutes.length > 0 && (routeId || (routeIds && routeIds.length > 0));

  for (let i = 0; i < units.length; i++) {
    const unit = units[i];
    // Step 1: spread position (formation-aware or default circular)
    const spread =
      formationStyle && units.length > 1
        ? getFormationOffset(center, i, units.length, formationStyle, heading)
        : units.length > 1
          ? spreadTarget(center, i, units.length, spreadRadius)
          : center;

    // Step 2: passability check
    const sx = Math.floor(spread.x);
    const sy = Math.floor(spread.y);
    let finalTarget: Position;

    if (canUnitEnterTile(unit.type, sx, sy, state)) {
      finalTarget = spread;
    } else {
      // ④ degradation: find nearest passable (try spread point, then center)
      const adj =
        ensurePassableTarget(unit, spread, state) ??
        ensurePassableTarget(unit, center, state);
      if (adj) {
        finalTarget = adj;
        degradedCount++;
      } else {
        skippedCount++;
        continue;
      }
    }

    // Step 3: resolve route waypoints if available
    let waypoints: Position[] | undefined;
    if (useRoutes) {
      const rIds = routeIds && routeIds.length > 0 ? routeIds : routeId ? [routeId] : [];
      const resolved = rIds.length > 1
        ? resolveRouteChain(state, unit.position, finalTarget, rIds)
        : rIds.length === 1
          ? resolveRoute(state, unit.position, finalTarget, rIds[0])
          : null;
      if (resolved && resolved.waypoints.length > 0) {
        waypoints = resolved.waypoints;
      }
    }
    // Auto-route: if no explicit route but scenario has routes and unit needs to cross
    // far distance (>30 tiles), try to find a suitable route automatically.
    // Score by total path cost (entry + route + exit), only accept if better than direct.
    if (!waypoints && state.namedRoutes.length > 0) {
      const directDist = Math.abs(unit.position.x - finalTarget.x) + Math.abs(unit.position.y - finalTarget.y);
      if (directDist > 30) {
        const cat = getUnitCategory(unit.type);
        const passableRoutes = state.namedRoutes.filter(nr => nr.passableFor.includes(cat));

        let bestRoute: ResolvedRoute | null = null;
        let bestCost = Infinity;

        // Try single routes — score by totalCost (entry + route + exit)
        for (const nr of passableRoutes) {
          const resolved = resolveRoute(state, unit.position, finalTarget, nr.id);
          if (resolved && resolved.waypoints.length > 1 && resolved.totalCost < bestCost) {
            bestCost = resolved.totalCost;
            bestRoute = resolved;
          }
        }

        // If best single route exit still >20 tiles from target, try 2-route chains
        if ((!bestRoute || bestRoute.exitDist > 20) && passableRoutes.length >= 2) {
          for (let a = 0; a < passableRoutes.length; a++) {
            for (let b = 0; b < passableRoutes.length; b++) {
              if (a === b) continue;
              const chain = resolveRouteChain(
                state, unit.position, finalTarget, [passableRoutes[a].id, passableRoutes[b].id],
              );
              if (chain && chain.waypoints.length > 0 && chain.totalCost < bestCost) {
                bestCost = chain.totalCost;
                bestRoute = chain;
              }
            }
          }
        }

        // Only use route if it's meaningfully better than direct distance.
        // Route must save at least 20% vs going straight, otherwise just walk direct.
        if (bestRoute && bestCost < directDist * 0.8) {
          waypoints = bestRoute.waypoints;
        }
      }
    }

    orders.push({ unitIds: [unit.id], action, target: finalTarget, priority, waypoints });
  }

  return { orders, degradedCount, skippedCount };
}

/** If target tile is impassable for unit, find nearest passable tile (spiral search, max 12 tiles). */
function ensurePassableTarget(
  unit: Unit,
  target: Position,
  state: GameState,
): Position | null {
  const tx = Math.floor(target.x);
  const ty = Math.floor(target.y);
  if (canUnitEnterTile(unit.type, tx, ty, state)) return target;

  // Spiral outward looking for passable tile
  const maxRadius = 12;
  for (let r = 1; r <= maxRadius; r++) {
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        const x = tx + dx;
        const y = ty + dy;
        if (canUnitEnterTile(unit.type, x, y, state)) {
          return { x, y };
        }
      }
    }
  }
  return null;
}

// ============================================================
// Named Route Resolution (El Alamein)
// ============================================================

/**
 * Build waypoints along a named route from a unit's position to a target.
 * Returns the route waypoints to inject into unit orders, or null if no route found.
 */
export interface ResolvedRoute {
  waypoints: Position[];
  /** Manhattan distance from unit to route entry point.
   *  For chains: sum of all segments' entry gaps (includes inter-segment gaps). */
  entryDist: number;
  /** Manhattan distance along route waypoints (entry → exit).
   *  For chains: sum of all segments' on-route distances. */
  routeLen: number;
  /** Manhattan distance from route exit to final target.
   *  For chains: sum of all segments' exit gaps (includes intermediate exits). */
  exitDist: number;
  /** Total estimated path cost. Invariant: totalCost === entryDist + routeLen + exitDist.
   *  Must equal waypointPathCost(startPos, waypoints) for correctness. */
  totalCost: number;
}

export function resolveRoute(
  state: GameState,
  unitPos: Position,
  target: Position,
  routeId: string,
): ResolvedRoute | null {
  const route = state.namedRoutes.find(r => r.id === routeId);
  if (!route || route.waypoints.length === 0) return null;

  // Find closest route entry point (to unit)
  let entryIdx = 0;
  let entryDistSq = Infinity;
  for (let i = 0; i < route.waypoints.length; i++) {
    const wp = route.waypoints[i];
    const d = (wp.x - unitPos.x) ** 2 + (wp.y - unitPos.y) ** 2;
    if (d < entryDistSq) { entryDistSq = d; entryIdx = i; }
  }

  // Find closest route exit point (to target)
  let exitIdx = 0;
  let exitDistSq = Infinity;
  for (let i = 0; i < route.waypoints.length; i++) {
    const wp = route.waypoints[i];
    const d = (wp.x - target.x) ** 2 + (wp.y - target.y) ** 2;
    if (d < exitDistSq) { exitDistSq = d; exitIdx = i; }
  }

  // Extract waypoints between entry and exit (in correct order)
  const waypoints: Position[] = [];
  if (entryIdx <= exitIdx) {
    for (let i = entryIdx; i <= exitIdx; i++) {
      waypoints.push({ ...route.waypoints[i] });
    }
  } else {
    for (let i = entryIdx; i >= exitIdx; i--) {
      waypoints.push({ ...route.waypoints[i] });
    }
  }

  // Trim overshoot: walk from the end and drop any waypoints that are farther
  // from target than their successor. This prevents the path from going past
  // the target along the route and then doubling back.
  while (waypoints.length > 1) {
    const last = waypoints[waypoints.length - 1];
    const prev = waypoints[waypoints.length - 2];
    const lastD = (last.x - target.x) ** 2 + (last.y - target.y) ** 2;
    const prevD = (prev.x - target.x) ** 2 + (prev.y - target.y) ** 2;
    if (prevD <= lastD) {
      waypoints.pop();
    } else {
      break;
    }
  }

  // Compute Manhattan distances for scoring
  const entryWp = route.waypoints[entryIdx];
  const entryDist = Math.abs(entryWp.x - unitPos.x) + Math.abs(entryWp.y - unitPos.y);

  const exitWp = waypoints[waypoints.length - 1]; // last route wp before appending target
  const exitDist = Math.abs(exitWp.x - target.x) + Math.abs(exitWp.y - target.y);

  let routeLen = 0;
  for (let i = 1; i < waypoints.length; i++) {
    routeLen += Math.abs(waypoints[i].x - waypoints[i - 1].x) + Math.abs(waypoints[i].y - waypoints[i - 1].y);
  }

  // Append final target
  waypoints.push({ ...target });
  return { waypoints, entryDist, routeLen, exitDist, totalCost: entryDist + routeLen + exitDist };
}

/**
 * Resolve multi-segment route chain.
 */
export function resolveRouteChain(
  state: GameState,
  unitPos: Position,
  target: Position,
  routeIds: string[],
): ResolvedRoute | null {
  if (routeIds.length === 0) return null;
  if (routeIds.length === 1) return resolveRoute(state, unitPos, target, routeIds[0]);

  // Chain: resolve first route from unit to midpoint, then second from midpoint to target
  const allWaypoints: Position[] = [];
  let currentPos = unitPos;
  let totalEntry = 0;
  let totalRoute = 0;
  let totalExit = 0;

  let totalCost = 0;

  for (let i = 0; i < routeIds.length; i++) {
    const isLast = i === routeIds.length - 1;
    const routeTarget = isLast ? target : findRouteIntersection(state, routeIds[i], routeIds[i + 1]) ?? target;
    const segment = resolveRoute(state, currentPos, routeTarget, routeIds[i]);
    if (segment) {
      allWaypoints.push(...segment.waypoints);
      currentPos = segment.waypoints[segment.waypoints.length - 1];
      // Accumulate ALL cost components from every segment.
      // This ensures totalCost matches the actual waypoint path cost.
      totalEntry += segment.entryDist;
      totalRoute += segment.routeLen;
      totalExit += segment.exitDist;
      totalCost += segment.totalCost;
    }
  }

  if (allWaypoints.length === 0) return null;
  return {
    waypoints: allWaypoints,
    entryDist: totalEntry,
    routeLen: totalRoute,
    exitDist: totalExit,
    totalCost,
  };
}

function findRouteIntersection(state: GameState, routeId1: string, routeId2: string): Position | null {
  const r1 = state.namedRoutes.find(r => r.id === routeId1);
  const r2 = state.namedRoutes.find(r => r.id === routeId2);
  if (!r1 || !r2) return null;

  // Find closest pair of waypoints between the two routes
  let bestDist = Infinity;
  let bestPos: Position | null = null;
  for (const wp1 of r1.waypoints) {
    for (const wp2 of r2.waypoints) {
      const d = (wp1.x - wp2.x) ** 2 + (wp1.y - wp2.y) ** 2;
      if (d < bestDist) {
        bestDist = d;
        bestPos = { x: Math.round((wp1.x + wp2.x) / 2), y: Math.round((wp1.y + wp2.y) / 2) };
      }
    }
  }
  return bestPos;
}
