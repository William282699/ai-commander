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
import { canUnitEnterTile } from "./sim";

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

  const source = resolveSourceUnits(intent, state);
  if (source.error) {
    return { orders: [], log: source.error, degraded: true };
  }

  let units = source.units;
  if (intent.unitType) {
    units = units.filter((u) => matchesUnitTypeHint(u, intent.unitType!));
  }
  units = filterByTargetPassability(units, target, state);

  if (units.length === 0) {
    return { orders: [], log: "目标地形不可达，无可用单位执行进攻", degraded: true };
  }

  const count = resolveQuantity(intent.quantity, units.length, style);
  units = sortByDistance(units, target).slice(0, count);

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
  const source = resolveSourceUnits(intent, state);
  if (source.error) {
    return { orders: [], log: source.error, degraded: true };
  }

  let units = source.units;
  if (intent.unitType) {
    units = units.filter((u) => matchesUnitTypeHint(u, intent.unitType!));
  }
  if (target) {
    units = filterByTargetPassability(units, target, state);
    if (units.length === 0) {
      return { orders: [], log: "目标地形不可达，无可用单位执行防御", degraded: true };
    }
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
  const source = resolveSourceUnits(intent, state);
  if (source.error) {
    return { orders: [], log: source.error, degraded: true };
  }

  let units = source.units;
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
): ResolveResult {
  const target = resolveTarget(intent, state);
  if (!target) {
    return { orders: [], log: "无法确定侦察目标位置", degraded: true };
  }

  const source = resolveSourceUnits(intent, state);
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
  const available = filterByTargetPassability(
    scouts.length > 0 ? scouts : units,
    target,
    state,
  );

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
  const source = resolveSourceUnits(intent, state);
  if (source.error) {
    return { orders: [], log: source.error, degraded: true };
  }

  let units = source.units;
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
function resolveSourceUnits(intent: Intent, state: GameState): SourceUnitsResult {
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
    const sourceFront = findFront(state, fromHint);
    if (!sourceFront) {
      return { units: [], error: `无法匹配来源战线: ${fromHint}` };
    }
    const frontUnits = getUnitsOnFront(state, sourceFront);
    if (frontUnits.length === 0) {
      return { units: [], error: `战线 "${sourceFront.name}" 暂无可用单位` };
    }
    return { units: frontUnits };
  }

  // ── toFront only: prefer local, fallback global ──
  if (toHint) {
    const targetFront = findFront(state, toHint);
    if (targetFront) {
      const localUnits = getUnitsOnFront(state, targetFront);
      if (localUnits.length > 0) return { units: localUnits };
      // Local empty — user wants to send units TO this front, use global pool
    } else {
      return { units: [], error: `无法匹配目标战线: ${toHint}` };
    }
  }

  // ── No front hints (or toFront with no local units): global fallback ──
  const all: Unit[] = [];
  state.units.forEach((u) => {
    if (u.team === "player" && u.state !== "dead" && !u.manualOverride) {
      all.push(u);
    }
  });
  return { units: all };
}

/** Normalize a front hint for alias lookup: trim, lowercase, strip separators. */
function normalizeFrontHint(value: string): string {
  return value.trim().toLowerCase().replace(/[\s_.\-]+/g, "");
}

/**
 * Fuzzy-match a front by alias → exact id/name → substring.
 * Three layers: alias table → normalized exact → lowercase substring.
 */
function findFront(state: GameState, hint: string): Front | undefined {
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

// ── Passability helpers ──

/** Filter units that can reach the target tile. */
function filterByTargetPassability(
  units: Unit[],
  target: Position,
  state: GameState,
): Unit[] {
  const tx = Math.floor(target.x);
  const ty = Math.floor(target.y);
  return units.filter((u) => canUnitEnterTile(u.type, tx, ty, state));
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
