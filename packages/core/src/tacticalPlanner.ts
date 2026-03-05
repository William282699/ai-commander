// ============================================================
// AI Commander — Tactical Planner (Day 7 MVP)
// Intent → precise Orders (rule-aware)
// Supports: attack, defend, retreat, recon, hold
// Unsupported intents degrade gracefully (no crash)
// ============================================================

import type {
  GameState,
  Order,
  StyleParams,
  Unit,
  Position,
  Front,
} from "@ai-commander/shared";
import type {
  Intent,
  IntentType,
  QuantityHint,
  UnitCategoryHint,
} from "@ai-commander/shared";
import { getUnitCategory } from "@ai-commander/shared";

// ── Result type ──

export interface ResolveResult {
  orders: Order[];
  log: string;
  degraded: boolean;
}

// ── Supported intents for Day 7 MVP ──

const SUPPORTED_INTENTS: readonly IntentType[] = [
  "attack",
  "defend",
  "retreat",
  "recon",
  "hold",
];

export function isIntentSupported(type: IntentType): boolean {
  return SUPPORTED_INTENTS.includes(type);
}

// ── Main entry point ──

/**
 * Convert an Intent from the LLM into precise game Orders.
 * Day 7 MVP: supports attack / defend / retreat / recon / hold.
 * Unsupported intents return { orders: [], degraded: true }.
 */
export function resolveIntent(
  intent: Intent,
  state: GameState,
  style: StyleParams,
): ResolveResult {
  if (!isIntentSupported(intent.type)) {
    return {
      orders: [],
      log: `意图类型 "${intent.type}" 尚未实现，已跳过`,
      degraded: true,
    };
  }

  switch (intent.type) {
    case "attack":
      return resolveAttack(intent, state, style);
    case "defend":
      return resolveDefend(intent, state, style);
    case "retreat":
      return resolveRetreat(intent, state, style);
    case "recon":
      return resolveRecon(intent, state, style);
    case "hold":
      return resolveHold(intent, state, style);
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
): ResolveResult {
  const target = resolveTarget(intent, state);
  if (!target) {
    return { orders: [], log: "无法确定攻击目标位置", degraded: true };
  }

  let units = resolveSourceUnits(intent, state);
  if (intent.unitType) {
    units = units.filter((u) => matchesUnitTypeHint(u, intent.unitType!));
  }

  const count = resolveQuantity(intent.quantity, units.length, style);
  units = sortByDistance(units, target).slice(0, count);

  if (units.length === 0) {
    return { orders: [], log: "无可用单位执行进攻", degraded: true };
  }

  const orders: Order[] = [
    {
      unitIds: units.map((u) => u.id),
      action: "attack_move",
      target,
      priority: mapUrgency(intent.urgency),
    },
  ];

  return {
    orders,
    log: `调度 ${units.length} 个单位向 (${Math.round(target.x)},${Math.round(target.y)}) 发起进攻`,
    degraded: false,
  };
}

function resolveDefend(
  intent: Intent,
  state: GameState,
  style: StyleParams,
): ResolveResult {
  const target = resolveTarget(intent, state);
  let units = resolveSourceUnits(intent, state);

  if (intent.unitType) {
    units = units.filter((u) => matchesUnitTypeHint(u, intent.unitType!));
  }

  const count = resolveQuantity(intent.quantity, units.length, style);

  if (target) {
    units = sortByDistance(units, target).slice(0, count);
  } else {
    units = units.slice(0, count);
  }

  if (units.length === 0) {
    return { orders: [], log: "无可用单位执行防御", degraded: true };
  }

  const orders: Order[] = [
    {
      unitIds: units.map((u) => u.id),
      action: "defend",
      target: target ?? null,
      priority: mapUrgency(intent.urgency),
    },
  ];

  return {
    orders,
    log: `${units.length} 个单位转入防御态势`,
    degraded: false,
  };
}

function resolveRetreat(
  intent: Intent,
  state: GameState,
  style: StyleParams,
): ResolveResult {
  let units = resolveSourceUnits(intent, state);

  if (intent.unitType) {
    units = units.filter((u) => matchesUnitTypeHint(u, intent.unitType!));
  }

  const count = resolveQuantity(intent.quantity, units.length, style);
  units = units.slice(0, count);

  if (units.length === 0) {
    return { orders: [], log: "无可用单位执行撤退", degraded: true };
  }

  // Retreat target: move towards player base (north)
  const playerBase: Position = { x: 100, y: 10 };

  const orders: Order[] = units.map((u) => {
    const dx = playerBase.x - u.position.x;
    const dy = playerBase.y - u.position.y;
    const dist = Math.sqrt(dx * dx + dy * dy);
    const retreatDist = Math.min(25, dist * 0.6);
    const retreatTarget: Position =
      dist < 1
        ? playerBase
        : {
            x: Math.round(u.position.x + (dx / dist) * retreatDist),
            y: Math.round(u.position.y + (dy / dist) * retreatDist),
          };

    return {
      unitIds: [u.id],
      action: "retreat" as const,
      target: retreatTarget,
      priority: mapUrgency(intent.urgency),
    };
  });

  return {
    orders,
    log: `命令 ${units.length} 个单位撤退至安全区域`,
    degraded: false,
  };
}

function resolveRecon(
  intent: Intent,
  state: GameState,
  style: StyleParams,
): ResolveResult {
  const target = resolveTarget(intent, state);
  if (!target) {
    return { orders: [], log: "无法确定侦察目标位置", degraded: true };
  }

  let units = resolveSourceUnits(intent, state);

  // Prefer fast / scout units
  const scouts = units.filter(
    (u) =>
      u.type === "recon_plane" ||
      u.type === "light_tank" ||
      u.type === "infantry",
  );
  const available = scouts.length > 0 ? scouts : units;

  const count = resolveQuantity(intent.quantity ?? "few", available.length, style);
  const selected = sortByDistance(available, target).slice(0, count);

  if (selected.length === 0) {
    return { orders: [], log: "无可用单位执行侦察", degraded: true };
  }

  const orders: Order[] = [
    {
      unitIds: selected.map((u) => u.id),
      action: "recon",
      target,
      priority: mapUrgency(intent.urgency),
    },
  ];

  return {
    orders,
    log: `派出 ${selected.length} 个单位侦察 (${Math.round(target.x)},${Math.round(target.y)})`,
    degraded: false,
  };
}

function resolveHold(
  intent: Intent,
  state: GameState,
  style: StyleParams,
): ResolveResult {
  let units = resolveSourceUnits(intent, state);

  if (intent.unitType) {
    units = units.filter((u) => matchesUnitTypeHint(u, intent.unitType!));
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

// ============================================================
// Helpers
// ============================================================

/** Resolve attack/defend/recon target position from intent fields. */
function resolveTarget(intent: Intent, state: GameState): Position | null {
  if (intent.targetFacility) {
    const pos = findFacilityPosition(state, intent.targetFacility);
    if (pos) return pos;
  }
  if (intent.targetRegion) {
    const pos = getRegionCenter(state, intent.targetRegion);
    if (pos) return pos;
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
  return null;
}

/** Find player units to assign, prioritizing the specified front. */
function resolveSourceUnits(intent: Intent, state: GameState): Unit[] {
  // Try fromFront first
  if (intent.fromFront) {
    const front = findFront(state, intent.fromFront);
    if (front) {
      const units = getUnitsOnFront(state, front);
      if (units.length > 0) return units;
    }
  }
  // Try toFront (for defend / hold the "source" is the front itself)
  if (intent.toFront) {
    const front = findFront(state, intent.toFront);
    if (front) {
      const units = getUnitsOnFront(state, front);
      if (units.length > 0) return units;
    }
  }
  // Fallback: all non-overridden player units
  const all: Unit[] = [];
  state.units.forEach((u) => {
    if (u.team === "player" && u.state !== "dead" && !u.manualOverride) {
      all.push(u);
    }
  });
  return all;
}

/** Fuzzy-match a front by id or name substring. */
function findFront(state: GameState, hint: string): Front | undefined {
  const lower = hint.toLowerCase();
  return state.fronts.find(
    (f) =>
      f.id === hint ||
      f.id.toLowerCase().includes(lower) ||
      f.name.toLowerCase().includes(lower),
  );
}

/** Get all alive, non-overridden player units within a front's regions. */
function getUnitsOnFront(state: GameState, front: Front): Unit[] {
  const bboxes = front.regionIds
    .map((rid) => state.regions.get(rid))
    .filter((r): r is NonNullable<typeof r> => r !== undefined)
    .map((r) => r.bbox);

  const units: Unit[] = [];
  state.units.forEach((u) => {
    if (u.team !== "player" || u.state === "dead" || u.manualOverride) return;
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
      return unit.type === "infantry";
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
