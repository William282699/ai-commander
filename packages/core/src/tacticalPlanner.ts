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
import { getUnitCategory, UNIT_STATS, UNIT_DISPLAY_NAME, TRADE_COSTS, collectUnitsUnder, isDispatchablePlayerUnit, isFootUnit, isProducibleUnitType } from "@ai-commander/shared";
import { canUnitEnterTile } from "./sim";
import { usesGroundCaptureRules } from "./economy";
import { frontDestinationFor, type FrontDestinationMode } from "./frontDestination";
import { createMission } from "./missions";
import { getFormationOffset, computeHeading, type FormationStyle } from "./formation";
import { installFrontResolver, findDispatch, liveDispatchMembers, originOfUnit } from "./dispatchLedger";

// ── Result type ──

export interface ResolveResult {
  orders: Order[];
  log: string;
  degraded: boolean;
  /** Unit IDs assigned by this resolve (for reserved-set tracking in multi-intent). */
  assignedUnitIds: number[];
  /** retreat-scope 刀B: 这批人**实际被送去的地方**的真名（空串＝没有可宣称的地名）。
   *  必填、不给默认值——播报层要报落点名，而落点名只有解析器知道：撤退那条路
   *  一旦丢弃了目的地，真正的落点是「安全区域」而不是 intent 上写的那个地名，
   *  从 intent 反推就会报错地方。给默认值等于允许"忘了填"静默变成空名。 */
  destinationName: string;
  /**
   * 刀寅：这条意图里**没被下令**的那部分人为什么没动（有结构化原因才写）。
   * 例：「回原处」时有人没记下出发地、有人的出发地到不了。执行层把它并进回执，
   * 屏/耳/context 同一句——不许悄悄少派。
   */
  note?: string;
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

// Exported (dispatch-scope-v1 2b): the ChatPanel high-impact gate must judge
// "is this fromFront actually the full-army entrance" with the SAME predicate
// the resolver uses — a second copy would drift.
export function isAllFrontHint(value: string): boolean {
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
/**
 * THE one answer to "does this string name a player map marker".
 *
 * 第 8 级 刀4（闭环，与刀2 的番号前缀同一条原则）：
 * **引擎自己印出去的名字，引擎必须认得回来。**
 * 刀4 之后信封会开始印标记的**名字**（「制高点附近未编组群」、SQUADS 的 loc=、
 * preflight 的来源地），而这两处判定原本只认 `tag_1` 这种 id ——
 * 模型把它刚听见的名字写回 targetRegion，引擎就一脸茫然。
 *
 * 匹配只有两档，都是精确的：id，或者**引擎打印出去的那个 name 本身**。
 * 没有同义词表、没有模糊包含（红线二）——"制高点"能解析是因为引擎印过
 * 这四个字，不是因为谁枚举了地名的说法。trim + 大小写归一是同一个字符串的
 * 不同写法，不是另一个词。
 *
 * 并列（同名两个标记）先入者赢，与 nearestPlaceWithin 的 tie-break 同规则。
 */
export function findTagRef(state: GameState, raw: string | undefined | null) {
  if (!raw) return undefined;
  const key = raw.trim();
  if (key.length === 0) return undefined;
  const lower = key.toLowerCase();
  const tags = state.tags ?? [];
  return tags.find((t) => t.id.toLowerCase() === lower)
    ?? tags.find((t) => t.name.trim().toLowerCase() === lower);
}

function normalizeIntentLocations(intent: Intent, state: GameState): Intent {
  const normalized = { ...intent };
  for (const field of ["toFront", "fromFront"] as const) {
    const val = normalized[field];
    if (!val) continue;
    if (findFront(state, val)) continue; // genuine front — keep it
    // Not a front: check if tag or region
    const isTag = !!findTagRef(state, val);
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
    return { orders: [], log: msg, degraded: true, destinationName: "" };
  }

  // P1.F: apply formation override sticky to squad BEFORE per-type handlers run.
  // After this, downstream handlers reading squad.formationStyle see the new style.
  // Resolves fromSquad as squad ID or leaderName (matches Chen prompt semantics).
  // TODO: when canonical squad-ref resolver lands, swap this lookup for it.
  if (intent.formationStyle && intent.fromSquad) {
    const ref = intent.fromSquad;
    const squad = state.squads.find((s) => s.id === ref || s.leaderName === ref);
    if (squad) squad.formationStyle = intent.formationStyle;
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
        destinationName: "",
      };
  }
}

// ============================================================
// Intent resolvers
// ============================================================


// ── Voice-polish v1: execution-receipt target naming (display only) ──
// Chat receipts must never leak raw coordinates. Fixed resolution order
// (Codex): facility name → player map-tag name → region name → front name →
// "目标区域". Pure read for the log string — Order generation untouched.
export function describeTargetForLog(intent: Intent, state: GameState): string {
  // STRICT mirror of resolveTarget() — the receipt must name the SAME thing
  // the units actually march to (Codex polish round-2 #1). Order:
  // _targetPos → targetFacility → targetRegion(tag→region→front) → toFront
  // → fromFront → fuzzy-facility last resort → "目标区域". Lookup semantics
  // mirror the resolver's helpers (fuzzy includes), not exact-id only.
  if (intent._targetPos) return "目标区域"; // internal coordinate override — no name to claim
  if (intent.targetFacility) {
    const fac = findFacilityById(state, intent.targetFacility);
    if (fac) return fac.name;
  }
  if (intent.targetRegion) {
    const tag = findTagRef(state, intent.targetRegion);
    if (tag) return tag.name;
    // Mirrors getRegionCenter's lookup: exact id, then id/name includes.
    let region = state.regions.get(intent.targetRegion);
    if (!region) {
      const lower = intent.targetRegion.toLowerCase();
      for (const [, r] of state.regions) {
        if (r.id.toLowerCase().includes(lower) || r.name.toLowerCase().includes(lower)) {
          region = r;
          break;
        }
      }
    }
    if (region) return region.name;
    const front = findFront(state, intent.targetRegion);
    if (front) return front.name;
  }
  if (intent.toFront) {
    const front = findFront(state, intent.toFront);
    if (front) return front.name;
  }
  if (intent.fromFront) {
    const front = findFront(state, intent.fromFront);
    if (front) return front.name;
  }
  for (const val of [intent.toFront, intent.targetRegion, intent.fromFront]) {
    if (val) {
      const fac = findFacilityById(state, val);
      if (fac) return fac.name;
    }
  }
  return "目标区域";
}

// ── Shared pure planning (preflight blocker-2: ONE pipeline, two callers) ──
//
// planAttack / planSabotage own the ENTIRE selection + realization control
// flow (target → source → filters → quantity → sortByDistance → spread).
// resolveAttack / resolveSabotage AND previewHighImpactIntent all call them —
// there is no second copy of the pipeline to drift. Pure: no diagnostics, no
// missions, no order mutation (tagging stays in the resolvers).

type PlannedSpread = { orders: Order[]; degradedCount: number; skippedCount: number };

type AttackPlan =
  | { ok: false; fail: "no_target" }
  | { ok: false; fail: "no_source"; error: string }
  | { ok: false; fail: "no_units"; unitTypeBypassed: boolean }
  | { ok: false; fail: "impassable"; unitTypeBypassed: boolean }
  | {
      ok: true;
      target: Position;
      spread: PlannedSpread;
      requestedCount: number;
      /** Enemy non-capture-objective facility target → sabotage-action branch. */
      sabotageFacility: import("@ai-commander/shared").Facility | null;
      unitTypeBypassed: boolean;
    };

function planAttack(
  intent: Intent,
  state: GameState,
  style: StyleParams,
  exclude?: ReadonlySet<number>,
  selectedUnitIds?: readonly number[],
): AttackPlan {
  const target = resolveTarget(intent, state);
  if (!target) return { ok: false, fail: "no_target" };

  const source = resolveSourceUnits(intent, state, exclude, selectedUnitIds);
  if (source.error) return { ok: false, fail: "no_source", error: source.error };

  let units = source.units;
  let unitTypeBypassed = false;
  if (intent.unitType) {
    const filtered = units.filter((u) => matchesUnitTypeHint(u, intent.unitType!));
    if (filtered.length === 0 && intent.fromSquad && units.length > 0) {
      // fromSquad set but unitType filter wiped all units → bypass filter
      unitTypeBypassed = true;
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

  if (units.length === 0) return { ok: false, fail: "no_units", unitTypeBypassed };

  // ── If targeting a facility, use sabotage orders so damage is applied ──
  // BUT: skip sabotage for capture objectives — combat.ts would instantly clear
  // them. Capture objectives are attacked with attack_move.
  const fac = intent.targetFacility ? findFacilityById(state, intent.targetFacility) : undefined;
  const isCaptureObj = fac && state.captureObjectives?.includes(fac.id);
  if (fac && fac.team !== "player" && !isCaptureObj) {
    const spread = createOrdersWithSpread(
      units, target, state, "sabotage", mapUrgency(intent.urgency), 1.5,
      undefined, intent.routeId, intent.routeIds,
    );
    if (spread.orders.length === 0) return { ok: false, fail: "impassable", unitTypeBypassed };
    return { ok: true, target, spread, requestedCount: units.length, sabotageFacility: fac, unitTypeBypassed };
  }

  // ④ + ③: spread targets + passability degradation. Squad formation style is
  // resolved by squad ID OR leaderName — matches resolveIntent injection.
  const squad = intent.fromSquad
    ? state.squads.find(s => s.id === intent.fromSquad || s.leaderName === intent.fromSquad)
    : undefined;
  const formation = squad?.formationStyle as FormationStyle | undefined;
  const spread = createOrdersWithSpread(
    units, target, state, "attack_move", mapUrgency(intent.urgency), 1.5, formation,
    intent.routeId, intent.routeIds,
  );
  if (spread.orders.length === 0) return { ok: false, fail: "impassable", unitTypeBypassed };
  return { ok: true, target, spread, requestedCount: units.length, sabotageFacility: null, unitTypeBypassed };
}

function resolveAttack(
  intent: Intent,
  state: GameState,
  style: StyleParams,
  exclude?: ReadonlySet<number>,
  selectedUnitIds?: readonly number[],
): Omit<ResolveResult, "assignedUnitIds"> {
  const plan = planAttack(intent, state, style, exclude, selectedUnitIds);

  // Bypass note surfaces exactly where the old inline filter emitted it.
  // (Only the post-source variants carry the flag, so the `in` check suffices.)
  if ("unitTypeBypassed" in plan && plan.unitTypeBypassed) {
    pushDiagnostic(state, "UNITTYPE_FILTER_BYPASSED",
      `分队 ${intent.fromSquad} 无 ${intent.unitType} 类型单位，已忽略类型筛选`);
  }

  if (!plan.ok) {
    switch (plan.fail) {
      case "no_target": {
        const msg = "无法确定攻击目标位置";
        pushDiagnostic(state, "NO_VISIBLE_TARGET", msg);
        return { orders: [], log: msg, degraded: true, destinationName: "" };
      }
      case "no_source": {
        pushDiagnostic(state, "NO_AVAILABLE_UNITS", plan.error);
        return { orders: [], log: plan.error, degraded: true, destinationName: "" };
      }
      case "no_units":
        return { orders: [], log: "无可用单位执行进攻", degraded: true, destinationName: "" };
      case "impassable": {
        const msg = "目标地形不可达，无可用单位执行进攻";
        pushDiagnostic(state, "IMPASSABLE_TARGET", msg);
        return { orders: [], log: msg, degraded: true, destinationName: "" };
      }
    }
  }

  const { spread } = plan;

  if (plan.sabotageFacility) {
    const fac = plan.sabotageFacility;
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
    return { orders: spread.orders, log, degraded: false, destinationName: fac.name };
  }

  // Phase C: tag orders with crisisFrontId for reinforcement dedup.
  if (intent.excludeFront) {
    for (const order of spread.orders) {
      order.crisisFrontId = intent.excludeFront;
    }
  }

  let log = `调度 ${spread.orders.length} 个单位进攻${describeTargetForLog(intent, state)}`;
  if (spread.degradedCount > 0) {
    log += ` (${spread.degradedCount} 个已调整目标)`;
    pushDiagnostic(state, "DEGRADED_TARGET",
      `${spread.degradedCount} 个单位目标已调整为最近可达点`);
  }
  if (spread.skippedCount > 0) {
    log += ` (${spread.skippedCount} 个无法到达已跳过)`;
  }

  return { orders: spread.orders, log, degraded: false, destinationName: describeTargetForLog(intent, state) };
}

// ── Command-Preflight V1: pure preview of a high-impact dispatch ──
//
// Runs the SAME planAttack/planSabotage pipeline the real resolvers run —
// single source, no drift — and skips everything impure (no diagnostics, no
// missions, no order tagging). ZERO state mutation (bench asserts identical
// snapshots). Out of the gate scope (single unscoped attack/sabotage with
// quantity all|most) or unplannable → null: the caller falls back to the
// static concern and costs are NEVER guessed off-mirror.

export interface HighImpactPreview {
  /** Target display name (same naming as execution receipts). */
  targetName: string;
  /** Final per-unit order targets — the ground truth for "who actually goes
   *  where". A unit ordered to a point inside its own front is NOT leaving. */
  assignments: { unitId: number; target: Position }[];
  assignedUnitIds: number[];
  /** Selected count after quantity resolution, before passability. */
  requestedCount: number;
  skippedCount: number;
}

export function previewHighImpactIntent(
  rawIntent: Intent,
  state: GameState,
  style: StyleParams,
): HighImpactPreview | null {
  const qty = rawIntent.quantity;
  if (rawIntent.fromSquad) return null;
  if (qty !== "all" && qty !== "most") return null;
  // dispatch-scope-v1 2b: retreat joins the coverage list — the 74/85
  // full-army retreat sailed through precisely because this line stopped at
  // attack/sabotage, so the confirm flow had no numbers to voice.
  if (rawIntent.type !== "attack" && rawIntent.type !== "sabotage" && rawIntent.type !== "retreat") return null;

  // Mirror resolveIntent's entry: locations normalized before dispatch.
  const intent = normalizeIntentLocations(rawIntent, state);

  if (intent.type === "retreat") {
    const plan = planRetreat(intent, state, style, undefined, undefined);
    if (!plan.ok) return null;
    const assignments = plan.orders.flatMap((o) =>
      o.target !== null ? o.unitIds.map((id) => ({ unitId: id, target: o.target! })) : [],
    );
    if (assignments.length === 0) return null;
    return {
      targetName: describeTargetForLog(intent, state),
      assignments,
      assignedUnitIds: assignments.map((a) => a.unitId),
      requestedCount: plan.requestedCount,
      skippedCount: plan.skippedCount,
    };
  }

  const plan =
    intent.type === "sabotage"
      ? planSabotage(intent, state, style, undefined, undefined)
      : planAttack(intent, state, style, undefined, undefined);
  if (!plan.ok) return null;

  const assignments = plan.spread.orders.flatMap((o) =>
    o.target !== null ? o.unitIds.map((id) => ({ unitId: id, target: o.target! })) : [],
  );
  if (assignments.length === 0) return null;
  return {
    targetName: describeTargetForLog(intent, state),
    assignments,
    assignedUnitIds: assignments.map((a) => a.unitId),
    requestedCount: plan.requestedCount,
    skippedCount: plan.spread.skippedCount,
  };
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
    return { orders: [], log: source.error, degraded: true, destinationName: "" };
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
    return { orders: [], log: "无可用单位执行防御", degraded: true, destinationName: "" };
  }

  // ④ passability degradation for defend target
  if (target) {
    const spread = createOrdersWithSpread(
      units, target, state, "defend", mapUrgency(intent.urgency), 1.0,
      undefined, intent.routeId, intent.routeIds,
    );
    if (spread.orders.length === 0) {
      return { orders: [], log: "目标地形不可达，无可用单位执行防御", degraded: true, destinationName: "" };
    }
    let log = `${spread.orders.length} 个单位前往${describeTargetForLog(intent, state)}设防`;
    if (spread.degradedCount > 0) {
      log += ` (${spread.degradedCount} 个已调整位置)`;
    }
    return { orders: spread.orders, log, degraded: false, destinationName: describeTargetForLog(intent, state) };
  }

  // No target: defend in place
  const orders: Order[] = [{
    unitIds: units.map((u) => u.id),
    action: "defend",
    target: null,
    priority: mapUrgency(intent.urgency),
  }];
  // 就地设防：没有"去处"可以宣称——空串，播报层据此不说"前往某地"。
  return { orders, log: `${units.length} 个单位就地设防`, degraded: false, destinationName: "" };
}

// ── Retreat planning (dispatch-scope-v1 2b): same ONE-pipeline pattern as
// planAttack/planSabotage — resolveRetreat AND previewHighImpactIntent both
// call planRetreat, so the preview can never drift from what executes. Pure:
// the unitType-bypass diagnostic is returned as a flag and pushed only by the
// resolver (preview's gate excludes fromSquad, so it never trips it anyway).
type RetreatPlan =
  | { ok: false; fail: "no_source"; error: string; unitTypeBypassed: boolean }
  | { ok: false; fail: "no_units"; unitTypeBypassed: boolean }
  | { ok: false; fail: "impassable"; unitTypeBypassed: boolean }
  | { ok: false; fail: "no_origin"; unitTypeBypassed: boolean }
  | { ok: true; orders: Order[]; requestedCount: number; skippedCount: number; unitTypeBypassed: boolean; destinationNamed: boolean;
      /** 刀寅：「回原处」这一档的结算（缺席＝不是这一档）。 */
      origin?: { noOrigin: number; unreachable: number; facilityId?: string; mixedPlaces: boolean } };

function planRetreat(
  intent: Intent,
  state: GameState,
  style: StyleParams,
  exclude?: ReadonlySet<number>,
  selectedUnitIds?: readonly number[],
): RetreatPlan {
  const source = resolveSourceUnits(intent, state, exclude, selectedUnitIds);
  if (source.error) {
    return { ok: false, fail: "no_source", error: source.error, unitTypeBypassed: false };
  }

  let units = source.units;
  let unitTypeBypassed = false;
  if (intent.unitType) {
    const filtered = units.filter((u) => matchesUnitTypeHint(u, intent.unitType!));
    if (filtered.length === 0 && intent.fromSquad && units.length > 0) {
      unitTypeBypassed = true;
    } else {
      units = filtered;
    }
  }

  const count = resolveQuantity(intent.quantity, units.length, style);
  units = units.slice(0, count);

  if (units.length === 0) {
    return { ok: false, fail: "no_units", unitTypeBypassed };
  }

  // ── retreat-semantics-v1 修法1: a NAMED destination routes through the ONE
  // resolver every other verb uses (resolveTarget). Gated on destination
  // fields actually being present — resolveTarget's fromFront fallback would
  // otherwise send the force back INTO the front it is leaving, and a bare
  // 「快撤」 must keep the legacy toward-HQ step byte-for-byte
  // (snapshot-pinned in ab-retreat-semantics).
  // retreat-scope 刀A: the destination's SOURCE decides whether it may be
  // dropped — a place the player actually named is their intent, a bare front
  // hint is a guess the staff filled in.
  //
  // ★刀戊 (审核 §一) 把判据从「字段非空」换成「**实际解析结果**」。
  //   「字段非空」漏两格，两格都实测复现过、都与基线不符：
  //     · `targetRegion` 可以装 front id（classifyDestination 的第 3 步），
  //       而同战线保护只看 `toFront` ⇒ `targetRegion=fromFront` 撤到原地；
  //     · 无效设施名解析失败后回落到 `fromFront`，字段却仍非空
  //       ⇒ core 自己造出一个假目的地，回执还报得出战线名。
  //   现在只有真解析成设施 / tag / region / 精确坐标才算"点名了地方"；
  //   解析结果是一条战线，就与旧 `toFront` 保护同待遇；什么都没解析出来
  //   就是"没说去哪"。规则不看地名、不看距离、不看坐标，对任何图成立。
  const dest = classifyDestination(intent, state);
  // 明确的"点"：设施 / tag / 真实 region / 精确坐标。即使它坐落在出发战线的
  // bbox 里也**必须保留**——前哨天然长在自家战线里，那正是刀A 治的病。
  const destinationNamedPlace = dest.kind === "exact" || dest.kind === "facility" || dest.kind === "place";
  let destination: Position | null = destinationNamedPlace ? dest.position : null;

  // 修法3：解析结果只是一条战线时，才谈得上"参谋把出发战线重复填进目的地"
  // 这唯一的误填形状。比较的是**解析后的 canonical front id**，不是原始字符串
  // ——同一条线的别名（id / 名字 / 序号前缀）因此一律判同。
  if (dest.kind === "front") {
    const departFront = intent.fromFront ? findFront(state, intent.fromFront) : undefined;
    const sameFront = departFront != null && dest.frontId === departFront.id;
    // 同线 ⇒ 丢弃，走下面的默认安全后撤（bare retreat 与基线逐字一致：它的
    // 解析结果正是 fromFront 自己那条线）。异线 ⇒ 正常撤过去。
    destination = sameFront ? null : dest.position;
  }

  // ── 刀寅：回到这次外派的出发地（returnTo:"origin"）──
  //
  // 只在长官**没另点地方**时生效（上面解析出了设施/地点/异线战线 ⇒ 以他点的为准）。
  // 出发位置逐人从台账取（接到命令那一刻的真实坐标），每人走同一条 spread/通行管线
  // ——不是裸坐标。仍是 retreat：途中不追敌、到达后转设防（retreat-semantics-v1 那条链）。
  // 没记下出发地 / 出发地到不了的人**不动**，并如实报出来；绝不拿「安全区」顶上。
  if (destination === null && intent.returnTo === "origin") {
    const orders: Order[] = [];
    let noOrigin = 0;
    let unreachable = 0;
    const facs = new Set<string>();
    let anyWithoutFacility = false;
    for (const u of units) {
      const o = originOfUnit(state, u.id);
      if (!o) { noOrigin++; continue; }
      const spread = createOrdersWithSpread(
        [u], o.pos, state, "retreat", mapUrgency(intent.urgency), 1.0,
        undefined, intent.routeId, intent.routeIds,
      );
      if (spread.orders.length === 0) { unreachable++; continue; }
      orders.push(...spread.orders);
      if (o.facilityId) facs.add(o.facilityId); else anyWithoutFacility = true;
    }
    if (orders.length === 0) {
      return { ok: false, fail: noOrigin === units.length ? "no_origin" : "impassable", unitTypeBypassed };
    }
    return {
      ok: true, orders, requestedCount: units.length, skippedCount: noOrigin + unreachable,
      unitTypeBypassed, destinationNamed: true,
      origin: {
        noOrigin, unreachable,
        facilityId: facs.size === 1 && !anyWithoutFacility ? [...facs][0] : undefined,
        mixedPlaces: facs.size > 1 || (facs.size > 0 && anyWithoutFacility),
      },
    };
  }

  if (destination !== null) {
    // Same spread/passability pipeline as defend (radius 1.0 — a retreat
    // regroups tight); action stays "retreat" so the no-chase transit
    // semantics (sim.ts / combat.ts retreating exemptions) hold en route.
    const spread = createOrdersWithSpread(
      units, destination, state, "retreat", mapUrgency(intent.urgency), 1.0,
      undefined, intent.routeId, intent.routeIds,
    );
    if (spread.orders.length === 0) {
      return { ok: false, fail: "impassable", unitTypeBypassed };
    }
    return {
      ok: true,
      orders: spread.orders,
      requestedCount: units.length,
      skippedCount: spread.skippedCount,
      unitTypeBypassed,
      destinationNamed: true,
    };
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
    return { ok: false, fail: "impassable", unitTypeBypassed };
  }

  return {
    ok: true,
    orders,
    requestedCount: units.length,
    skippedCount: units.length - orders.length,
    unitTypeBypassed,
    destinationNamed: false,
  };
}

function hasNamedDestination(intent: Intent): boolean {
  return !!(intent._targetPos || intent.targetFacility || intent.targetRegion || intent.toFront);
}

function resolveRetreat(
  intent: Intent,
  state: GameState,
  style: StyleParams,
  exclude?: ReadonlySet<number>,
  selectedUnitIds?: readonly number[],
): Omit<ResolveResult, "assignedUnitIds"> {
  const plan = planRetreat(intent, state, style, exclude, selectedUnitIds);

  if (plan.unitTypeBypassed) {
    pushDiagnostic(state, "UNITTYPE_FILTER_BYPASSED",
      `分队 ${intent.fromSquad} 无 ${intent.unitType} 类型单位，已忽略类型筛选`);
  }

  if (!plan.ok) {
    switch (plan.fail) {
      case "no_source":
        return { orders: [], log: plan.error, degraded: true, destinationName: "" };
      case "no_units":
        return { orders: [], log: "无可用单位执行撤退", degraded: true, destinationName: "" };
      case "impassable":
        return { orders: [], log: intent.returnTo === "origin" && !hasNamedDestination(intent)
          ? "这批人的出发地现在到不了，没有执行" : "撤退目标地形不可达，无可执行命令", degraded: true, destinationName: "" };
      case "no_origin":
        return { orders: [], log: "这批人没有记下这次外派的出发地，没有执行", degraded: true, destinationName: "" };
    }
  }

  // 刀寅：「回原处」——落点名只说引擎真解析到的：同一个我方据点附近才叫得出据点名。
  if (plan.origin) {
    const o = plan.origin;
    const fac = o.facilityId ? state.facilities.get(o.facilityId) : undefined;
    const dest = fac ? `出发地（${fac.name}附近）` : o.mixedPlaces ? "各自的出发地" : "出发地";
    const parts: string[] = [];
    if (o.noOrigin > 0) parts.push(`${o.noOrigin} 个没有记下出发地`);
    if (o.unreachable > 0) parts.push(`${o.unreachable} 个的出发地现在到不了`);
    return {
      orders: plan.orders,
      log: `命令 ${plan.orders.length} 个单位撤回${dest}`,
      degraded: false,
      destinationName: dest,
      ...(parts.length > 0 ? { note: `另有${parts.join("、")}，没有动。` } : {}),
    };
  }

  const skipNote = plan.skippedCount > 0 ? `（${plan.skippedCount} 个单位因地形限制未下达）` : "";
  // Named destination → the receipt names what actually executes (the 74/85
  // family's other face was a receipt reciting the order sheet); default stays
  // byte-identical 安全区域.
  const dest = plan.destinationNamed ? describeTargetForLog(intent, state) : "安全区域";
  return {
    orders: plan.orders,
    log: `命令 ${plan.orders.length} 个单位撤退至${dest}${skipNote}`,
    degraded: false,
    // 刀B：落点名取的是 `dest` 这一个变量——**引擎真送他们去的地方**。
    // 目的地被丢弃时它就是「安全区域」，绝不回头去念 intent 上那个地名。
    destinationName: dest,
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
    return { orders: [], log: "无法确定侦察目标位置", degraded: true, destinationName: "" };
  }

  const source = resolveSourceUnits(intent, state, exclude, selectedUnitIds);
  if (source.error) {
    return { orders: [], log: source.error, degraded: true, destinationName: "" };
  }

  let units = source.units;

  // LLM-explicit unitType filter (mirrors resolveAttack / resolveHold / resolvePatrol).
  // When the player said "派 3 个步兵侦察 X", LLM fills intent.unitType:"infantry"
  // — the engine must honor it. Without this filter, the type-priority sort
  // below would pick recon_plane instead and brief-vs-engine would mismatch
  // in the opposite direction (player asked infantry, engine sends planes).
  if (intent.unitType) {
    const filtered = units.filter((u) => matchesUnitTypeHint(u, intent.unitType!));
    if (filtered.length === 0 && intent.fromSquad && units.length > 0) {
      pushDiagnostic(state, "UNITTYPE_FILTER_BYPASSED",
        `分队 ${intent.fromSquad} 无 ${intent.unitType} 类型单位，已忽略类型筛选`);
    } else {
      units = filtered;
    }
  }

  // Prefer scout types as a sensible default (recon is conventionally light).
  // Skip when player asked for "全军 / all" (P2 #4) OR already filtered above
  // by explicit unitType — both cases mean the player has already chosen.
  if (intent.quantity !== "all" && !intent.unitType) {
    const scouts = units.filter(
      (u) =>
        u.type === "recon_plane" ||
        u.type === "light_tank" ||
        u.type === "infantry",
    );
    units = scouts.length > 0 ? scouts : units;
  }

  const count = resolveQuantity(intent.quantity ?? "few", units.length, style);
  // Selection ordering:
  //   "all"             → source order (every unit goes anyway)
  //   explicit unitType → distance only (single-type pool, no need to rank)
  //   implicit          → type priority (recon_plane > light_tank > infantry) + distance
  let selected: Unit[];
  if (intent.quantity === "all") {
    selected = units.slice(0, count);
  } else if (intent.unitType) {
    selected = sortByDistance(units, target).slice(0, count);
  } else {
    selected = sortReconCandidates(units, target).slice(0, count);
  }

  if (selected.length === 0) {
    return { orders: [], log: "无可用单位执行侦察", degraded: true, destinationName: "" };
  }

  // ④ passability degradation (no spread for recon — units scout independently)
  const spread = createOrdersWithSpread(
    selected, target, state, "recon", mapUrgency(intent.urgency), 0,
    undefined, intent.routeId, intent.routeIds,
  );

  if (spread.orders.length === 0) {
    return { orders: [], log: "侦察目标不可达", degraded: true, destinationName: "" };
  }

  let log = `派出 ${spread.orders.length} 个单位侦察${describeTargetForLog(intent, state)}`;
  if (spread.degradedCount > 0) {
    log += ` (${spread.degradedCount} 个已调整目标)`;
  }
  return { orders: spread.orders, log, degraded: false, destinationName: describeTargetForLog(intent, state) };
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
    return { orders: [], log: source.error, degraded: true, destinationName: "" };
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
    return { orders: [], log: "无可用单位执行原地待命", degraded: true, destinationName: "" };
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
    destinationName: "", // 原地待命：没有去处
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
    return { orders: [], log: msg, degraded: true, destinationName: "" };
  }
  // 嘴也要诚实（LEDGER §P5）：引擎入口会拒绝 cost=0/buildTime=0 的英雄单位，
  // 台词就不能先宣布「生产指挥官 ×3」——resolver 的 log 在执行前就上屏，
  // 说了没发生的事＝假执行回报（v1 提案当初被拦下正是这条）。
  if (!isProducibleUnitType(unitType)) {
    const msg = `${UNIT_DISPLAY_NAME[unitType]}不是能生产的单位`;
    pushDiagnostic(state, "PRODUCE_FAIL", msg);
    return { orders: [], log: msg, degraded: true, destinationName: "" };
  }

  // emily-production-v1: budget mode → ONE Order carrying the budget; the
  // unit count is settled in applyOrders with LIVE resources. The resolver
  // must never pre-announce a count here — its log shows in the UI before
  // execution, and a count the settlement can't honor would be a fake
  // execution report (Codex block #1). The receipt with real numbers comes
  // from the PRODUCE_BUDGET diagnostic after settlement.
  if (intent.produceBudget?.mode === "fraction_of_money") {
    return {
      orders: [{
        unitIds: [],
        action: "produce",
        target: null,
        produceUnitType: unitType,
        produceBudget: intent.produceBudget,
        priority: mapUrgency(intent.urgency),
      }],
      // Human register, zero count claim (the count only exists after the
      // applyOrders settlement — silence about it IS the no-claim contract;
      // an explanatory parenthetical was the der-culprit, twice).
      log: (intent.produceBudget.fraction ?? 0) >= 1
        ? `全力生产${UNIT_DISPLAY_NAME[unitType]}`
        : `按预算生产${UNIT_DISPLAY_NAME[unitType]}`,
      degraded: false,
      destinationName: "", // 经济单：没有战场落点可宣称
    };
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
    log: `生产${UNIT_DISPLAY_NAME[unitType]} ×${count}`,
    degraded: false,
    destinationName: "", // 经济单：没有战场落点可宣称
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
    return { orders: [], log: msg, degraded: true, destinationName: "" };
  }

  const orders: Order[] = [{
    unitIds: [],
    action: "trade",
    target: null,
    tradeType: tradeAction as import("@ai-commander/shared").TradeType,
    tradeBudget: intent.tradeBudget, // 7b.1: carry budget intent through to executeTrade
    priority: mapUrgency(intent.urgency),
  }];

  return {
    orders,
    log: `下达交易命令: ${tradeAction}`,
    degraded: false,
    destinationName: "", // 经济单：没有战场落点可宣称
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
    return { orders: [], log: source.error, degraded: true, destinationName: "" };
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
    return { orders: [], log: msg, degraded: true, destinationName: "" };
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
    destinationName: describeTargetForLog(intent, state),
  };
}

// ── Day 11: sabotage resolver (planning shared with preflight preview) ──

type SabotagePlan =
  | { ok: false; fail: "no_facility_hint" }
  | { ok: false; fail: "no_facility_pos" }
  | { ok: false; fail: "no_source"; error: string }
  | { ok: false; fail: "no_units" }
  | { ok: false; fail: "impassable" }
  | {
      ok: true;
      target: Position;
      fac: import("@ai-commander/shared").Facility | undefined;
      spread: PlannedSpread;
      requestedCount: number;
    };

function planSabotage(
  intent: Intent,
  state: GameState,
  style: StyleParams,
  exclude?: ReadonlySet<number>,
  selectedUnitIds?: readonly number[],
): SabotagePlan {
  // Target must be a facility
  if (!intent.targetFacility) return { ok: false, fail: "no_facility_hint" };
  const target = findFacilityPosition(state, intent.targetFacility);
  if (!target) return { ok: false, fail: "no_facility_pos" };

  // Resolve facility for mission creation
  const fac = findFacilityById(state, intent.targetFacility);

  const source = resolveSourceUnits(intent, state, exclude, selectedUnitIds);
  if (source.error) return { ok: false, fail: "no_source", error: source.error };

  let units = source.units;

  // Prefer infantry + light_tank (sabotage operatives)
  const saboteurs = units.filter(
    (u) => u.type === "infantry" || u.type === "light_tank",
  );
  units = saboteurs.length > 0 ? saboteurs : units;

  const count = resolveQuantity(intent.quantity ?? "some", units.length, style);
  units = sortByDistance(units, target).slice(0, count);

  if (units.length === 0) return { ok: false, fail: "no_units" };

  // Issue sabotage orders to the facility (action: "sabotage" — NOT attack_move)
  const spread = createOrdersWithSpread(
    units, target, state, "sabotage", mapUrgency(intent.urgency), 1.5,
    undefined, intent.routeId, intent.routeIds,
  );
  if (spread.orders.length === 0) return { ok: false, fail: "impassable" };
  return { ok: true, target, fac, spread, requestedCount: units.length };
}

function resolveSabotage(
  intent: Intent,
  state: GameState,
  style: StyleParams,
  exclude?: ReadonlySet<number>,
  selectedUnitIds?: readonly number[],
): Omit<ResolveResult, "assignedUnitIds"> {
  const plan = planSabotage(intent, state, style, exclude, selectedUnitIds);

  if (!plan.ok) {
    switch (plan.fail) {
      case "no_facility_hint": {
        const msg = "破坏命令未指定目标设施";
        pushDiagnostic(state, "SABOTAGE_NO_TARGET", msg);
        return { orders: [], log: msg, degraded: true, destinationName: "" };
      }
      case "no_facility_pos": {
        const msg = `无法定位目标设施: ${intent.targetFacility}`;
        pushDiagnostic(state, "SABOTAGE_NO_TARGET", msg);
        return { orders: [], log: msg, degraded: true, destinationName: "" };
      }
      case "no_source": {
        pushDiagnostic(state, "NO_AVAILABLE_UNITS", plan.error);
        return { orders: [], log: plan.error, degraded: true, destinationName: "" };
      }
      case "no_units":
        return { orders: [], log: "无可用单位执行破坏任务", degraded: true, destinationName: "" };
      case "impassable":
        return { orders: [], log: "目标地形不可达，无法执行破坏", degraded: true, destinationName: "" };
    }
  }

  const { spread, fac } = plan;
  const facilityHint = intent.targetFacility!;

  // Squad ID for mission linkage (if fromSquad was provided)
  const squadId = intent.fromSquad || undefined;

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
  return { orders: spread.orders, log, degraded: false, destinationName: fac?.name ?? facilityHint };
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
    return { orders: [], log: msg, degraded: true, destinationName: "" };
  }

  const source = resolveSourceUnits(intent, state, exclude, selectedUnitIds);
  if (source.error) {
    pushDiagnostic(state, "NO_AVAILABLE_UNITS", source.error);
    return { orders: [], log: source.error, degraded: true, destinationName: "" };
  }

  let units = source.units;
  // Scenario-aware capture doctrine. Must match economy.ts::tickFacilityCapture
  // line 118-126 — the *actual* game-engine rule that decides who can capture:
  //   - 正式规则（el_alamein / tutorial / 将来的图）: any GROUND unit
  //   - dual_island 遗留原型:                        infantry only
  //   ★ 读的必须是 economy.ts 那个**同一个谓词**——两边分家过一次：
  //     教学关上 planner 派得出坦克、引擎却判它占不了点，回执还说"已派出"。
  // Previously this resolver hard-preferred infantry in ALL scenarios, which on
  // El Alamein shrank a tank-heavy squad (e.g. Blake) to 0-2 lone infantry and
  // effectively made "Blake capture X" dispatch a single token soldier while
  // the real combat force sat idle.
  if (usesGroundCaptureRules(state)) {
    // Air/naval can't stand on a facility — filter to ground only.
    units = units.filter((u) => getUnitCategory(u.type) === "ground");
  } else {
    const infantry = units.filter((u) => u.type === "infantry");
    units = infantry.length > 0 ? infantry : units;
  }

  const count = resolveQuantity(intent.quantity ?? "some", units.length, style);
  units = sortByDistance(units, target).slice(0, count);

  if (units.length === 0) {
    return { orders: [], log: "无可用单位执行占领任务", degraded: true, destinationName: "" };
  }

  // Move units to facility and set up capture (uses attack_move to handle hostiles en route)
  const spread = createOrdersWithSpread(
    units, target, state, "attack_move", mapUrgency(intent.urgency), 1.0,
    undefined, intent.routeId, intent.routeIds,
  );

  if (spread.orders.length === 0) {
    return { orders: [], log: "目标地形不可达，无法执行占领", degraded: true, destinationName: "" };
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
  return { orders: spread.orders, log, degraded: false, destinationName: facilityName || "" };
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

/**
 * A front hint is the LEAST specific thing a commander can name, and until v4
 * §8 it was also the least accurate: all three branches below went through the
 * front's geometric center — an average of region bboxes, 97 tiles from the
 * outpost the order was about on front_center. `frontDestinationFor` walks the
 * ladder instead (biggest fighting cluster → any friendlies → our facility →
 * the center only when the line is bare). Tags, facilities and explicit
 * coordinates are untouched: those already name a POINT the commander chose.
 *
 * Mode is read off the verb: the same front resolves to three different points
 * depending on what you are doing to it. Falling back onto the firefight is not
 * a retreat, and charging at our own firefight is not an attack.
 *
 * 刀F (2026-08-05): attack moved off "approach". §8's opening ruling hung it
 * there, and the live hand-test showed why that is wrong — approach's first
 * rung is "the biggest fight on this line", so an assault ordered at a front
 * where our own squad was skirmishing marched onto the skirmish instead of the
 * enemy's victory point. See DIALOGUE_HANDTEST_LEDGER_AND_KNIFE_F_PROPOSAL_20260805.md §1-F.
 */
function frontDestinationMode(intent: Intent): FrontDestinationMode {
  if (intent.type === "retreat") return "withdraw";
  if (intent.type === "attack") return "assault";
  return "approach";
}

// ── 刀戊: 目的地**按实际解析结果**分类，不按"字段非空" ──
//
// 病（审核 §一，基线对照实测）：刀A 把丢弃条件收窄成「字段来源」，判据写的是
// `!!(_targetPos || targetFacility || targetRegion)`——**字段非空即视为明确地点**。
// 可 `resolveTarget` 允许 `targetRegion` 里装一个 front id（下面第 3 步的 front
// 分支），而同战线保护只看 `toFront`。于是两笔回归：
//   · `targetRegion="front_south"` + `fromFront="front_south"` ⇒ 被当成明确地点，
//     撤到本战线的 withdraw 锚（基线与 bare retreat 一样走默认安全后撤）；
//   · `targetFacility="missing_fac"` 解析失败后回落到 `fromFront`，却仍因字段
//     非空被视为明确地点 ⇒ **core 自己造了一个假目的地**。
//
// 修法：把"解析到哪儿"和"那是什么"一次算完。`resolveTarget` 降为本函数的薄
// 包装，所以坐标只有一份实现、**不可能漂**；planRetreat 改读 `kind`/`frontId`。
export type DestinationKind =
  /** 引擎内部给的精确坐标（危机卡）。 */
  | "exact"
  /** 解析到了一个真实设施。 */
  | "facility"
  /** 解析到了一个真实 tag 或真实 region——玩家点的是一个**点**。 */
  | "place"
  /** 只解析到一条战线（最不具体的那一档，也是参谋误填唯一的形状）。 */
  | "front"
  /** 什么都没解析出来。**不许拿它冒充明确目的地。** */
  | "none";

export interface DestinationClass {
  kind: DestinationKind;
  position: Position | null;
  /** kind==="front" 时那条战线的 canonical id（比较身份用，不比原始字符串）。 */
  frontId: string | null;
  /** 哪个字段最终产生了它（判据与诊断用，不参与判定）。 */
  field: "_targetPos" | "targetFacility" | "targetRegion" | "toFront" | "fromFront" | "fuzzy" | null;
}

const NO_DESTINATION: DestinationClass = { kind: "none", position: null, frontId: null, field: null };

/**
 * 解析目的地**并说明它是什么**。顺序与历史 `resolveTarget` 逐字一致：
 *   _targetPos → targetFacility → targetRegion(tag→region→front) → toFront
 *   → fromFront → 三个字段当设施名的模糊兜底 → 无
 */
export function classifyDestination(intent: Intent, state: GameState): DestinationClass {
  // Internal override: crisis card system provides exact coordinates
  // (enemy centroid) to avoid region/front center inaccuracy.
  if (intent._targetPos) {
    return {
      kind: "exact",
      position: { x: intent._targetPos.x, y: intent._targetPos.y },
      frontId: null,
      field: "_targetPos",
    };
  }
  if (intent.targetFacility) {
    const fac = findFacilityById(state, intent.targetFacility);
    if (fac) {
      return { kind: "facility", position: { ...fac.position }, frontId: null, field: "targetFacility" };
    }
  }
  const mode = frontDestinationMode(intent);
  if (intent.targetRegion) {
    // Day 15: check tags first, then regions, then fronts
    // 刀4: findTagRef 认 id 也认引擎印出去的那个名字（闭环，见其注释）
    const tag = findTagRef(state, intent.targetRegion);
    if (tag) {
      return {
        kind: "place",
        position: { x: Math.round(tag.position.x), y: Math.round(tag.position.y) },
        frontId: null,
        field: "targetRegion",
      };
    }
    const region = findRegionByHint(state, intent.targetRegion);
    if (region) {
      return { kind: "place", position: regionCenterOf(region), frontId: null, field: "targetRegion" };
    }
    // Also try front match (LLM might put front id in targetRegion).
    // ★ 这一档是 **front**，不是 place —— 同战线保护因此也管得到它。
    const front = findFront(state, intent.targetRegion);
    if (front) {
      return {
        kind: "front",
        position: frontDestinationFor(state, front, mode),
        frontId: front.id,
        field: "targetRegion",
      };
    }
  }
  if (intent.toFront) {
    const front = findFront(state, intent.toFront);
    if (front) {
      return { kind: "front", position: frontDestinationFor(state, front, mode), frontId: front.id, field: "toFront" };
    }
  }
  // For some intents, fromFront can serve as target area.
  // ★ 对撤退而言这一档几乎总是"没说去哪"：它解析出来的就是出发战线本身，
  //   同战线保护会把它丢掉 ⇒ bare retreat 仍走默认安全后撤（逐字不变）。
  if (intent.fromFront) {
    const front = findFront(state, intent.fromFront);
    if (front) {
      return { kind: "front", position: frontDestinationFor(state, front, mode), frontId: front.id, field: "fromFront" };
    }
  }
  // Last resort: try all location fields as facility name (fuzzy match).
  // Catches cases where LLM puts a facility name in toFront/targetRegion
  // and normalizeIntentLocations didn't move it (shouldn't happen, but defensive).
  for (const val of [intent.toFront, intent.targetRegion, intent.fromFront]) {
    if (val) {
      const fac = findFacilityById(state, val);
      if (fac) return { kind: "facility", position: { ...fac.position }, frontId: null, field: "fuzzy" };
    }
  }
  return NO_DESTINATION;
}

/** Resolve attack/defend/recon target position from intent fields.
 *  刀戊：降为 `classifyDestination` 的薄包装——坐标只有一份实现，不可能漂。 */
function resolveTarget(intent: Intent, state: GameState): Position | null {
  return classifyDestination(intent, state).position;
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
  // 刀C: 任务号与编制号同待遇。「刚派去山脊那批撤回来」没说数量 ⇒ 是整批，
  // 不是"整批里闲着的那几个"——同一任务里本来就既有忙兵也有闲兵。
  const isDispatchDefaultAll = !!intent.fromDispatch && (intent.quantity == null || intent.quantity === undefined);
  if (!isFullMobilization && !isSquadDefaultAll && !isDispatchDefaultAll) {
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
  // ── 刀C: fromDispatch —— 按**任务**指代（「刚从南线派去山脊那批」）──
  //
  // 排在 fromSquad 之前：任务号是一份冻结的具体名单，比编制更具体。
  // 两个字段**不互相兜底**——查不到就明确失败，绝不退化成"按编制找"或
  // "按位置找"，更不退化成全军（那正是 74/85 那笔账的形状）。
  //
  // ★ 这里同时就是「执行前复查」：本函数在 applyOrders 之前的那一刻跑，
  //   活成员从**当前战场**现查（liveDispatchMembers）。服务端校验不算数——
  //   等模型回复那几秒里人会死、会被改派。
  if (intent.fromDispatch && typeof intent.fromDispatch === "string") {
    const d = findDispatch(state, intent.fromDispatch);
    if (!d) {
      return { units: [], error: `任务 ${intent.fromDispatch} 已经不在了` };
    }
    const live = liveDispatchMembers(state, d);
    if (live.length === 0) {
      return { units: [], error: `任务 ${d.id} 已经没有可调的人了` };
    }
    return { units: live };
  }

  // ── Phase 2: fromSquad — match by squad.id, leaderName, or ownerCommander ──
  if (intent.fromSquad && typeof intent.fromSquad === "string") {
    // 1. Exact squad id
    let squad = state.squads.find((s) => s.id === intent.fromSquad);
    // 2. Squad leader name — case-insensitive, matching the ChatPanel gate's
    //    predicate exactly (dispatch-scope-v1 2a: a reference the gate accepts
    //    must also resolve here, or the two layers loud-fail inconsistently).
    if (!squad) {
      const refLower = intent.fromSquad.toLowerCase();
      squad = state.squads.find((s) => s.leaderName?.toLowerCase() === refLower);
    }
    if (squad) {
      // Use collectUnitsUnder for hierarchy-aware unit collection
      const allIds = collectUnitsUnder(state, squad.id);
      const units = allIds
        .map((id) => state.units.get(id))
        .filter(
          (u): u is Unit => u !== undefined && isDispatchablePlayerUnit(u),
        );
      if (units.length > 0) return { units };
      return { units: [], error: `分队 ${intent.fromSquad} 无可用单位（已阵亡或被手动接管）` };
    }
    // 3. Commander name (chen/marcus/emily) → all squads under that commander
    const cmdKey = intent.fromSquad.toLowerCase() as import("@ai-commander/shared").CommanderKey;
    const cmdSquads = state.squads.filter((s) => s.ownerCommander === cmdKey);
    if (cmdSquads.length > 0) {
      const allIds = new Set<number>();
      for (const sq of cmdSquads) {
        for (const id of collectUnitsUnder(state, sq.id)) allIds.add(id);
      }
      const units = Array.from(allIds)
        .map((id) => state.units.get(id))
        .filter(
          (u): u is Unit => u !== undefined && isDispatchablePlayerUnit(u),
        );
      if (units.length > 0) return { units };
      return { units: [], error: `指挥官 ${intent.fromSquad} 下属无可用单位` };
    }
    return { units: [], error: `无法找到分队: ${intent.fromSquad}` };
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
    // Common LLM output: "all", "全军", etc. Treat as global pool. This is
    // the ONE full-army entrance (dispatch-scope-v1 ruling 2026-07-28):
    // scope belongs to fromFront/fromSquad, quantity only says how many OF
    // that pool — 「北线的部队都撤退」的"都"管北线那些部队，不管全军。The old
    // quantity=all/most → global shortcut that lived here overrode the named
    // front and full-army-retreated 74/85 on a one-outpost order; it also made
    // the two mis-retreat guards below dead code under "all".
    if (isAllFrontHint(fromHint)) {
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

// ── 刀C: 把"战线 hint → 战线 / 线上有谁"这一份实现注入台账模块 ──
//    台账需要同样的判断，而反向 import 会成环。复制一份几何判断就会漂，
//    所以这里注入：一份实现，两处用。
installFrontResolver({
  frontIdOf: (state, hint) => findFront(state, hint)?.id ?? null,
  frontNameOf: (state, hint) => findFront(state, hint)?.name ?? hint,
  unitsOnFront: (state, hint) => {
    const f = findFront(state, hint);
    return f ? getUnitsOnFront(state, f) : [];
  },
  // 刀寅：台账记「出发战线」用。与 getUnitsOnFront 同一份几何（isInFront），
  // 只是不带可调过滤——来源是位置事实，不是"能不能调"。
  frontIdOfUnit: (state, unit) => state.fronts.find((f) => isInFront(state, f, unit.position))?.id ?? null,
});

/**
 * 刀寅：**这条命令自己的「去处原话」**与它的目的地字段是否一致。
 *
 * 模型在每条会动兵的单子上抄下长官原话里说这条命令去处的那几个字（destinationQuote）。
 * 本函数只做程序能证明的几件事，**语义仍归模型**：
 *   ① 引用确实出自长官这一句（这份方案绑定的原话）——不在原话里 ⇒ 不采信它是长官的话，
 *      只核这张单子自己的两个字段前后是否一致（verified=false）；
 *   ② 这几个字里有没有地图上地点的**本名**（设施名／战线名，不认错别字、代词）——
 *      没有 ⇒ 不介入（「北部展现」「北线前稍」「那里」照模型的理解走）；
 *   ③ 有 ⇒ 与字段解析出的去处比对：一致就放行；
 *      字段只写到**包含该设施的那条战线** ⇒ narrowed（提出按设施办，问一句）；
 *      两者说的是不同的地方 ⇒ conflict（问一句）。**不静默替长官改目标。**
 *   ④ 字段**没写去处**时一律不介入、**绝不拿片段补去处**：没写去处本身就是完整的意思
 *      （裸撤退、回原处、就地设防），而片段可能标的是"派去北线前哨的那两个"里的
 *      「北线前哨」（审核实测：叫回来被补成开往北线前哨，一半以上中招）。
 *   ⑤ 撤退单不提"按设施办"——对不上就只问，不替他出方案（撤退往哪儿偏一步都是反方向）。
 * 引用只能证明"确实是长官说过的话"，证明不了它是正向的去处（否定、来源、问句都可能被
 * 错标）——所以对不上时一律问，不替他挑。
 */
export type DestinationQuoteVerdict =
  | { kind: "no_check"; reason: "no_quote" | "not_in_player_words" | "names_no_place" | "not_dispatch" | "no_destination_written" }
  | { kind: "consistent" }
  /** verified＝片段确实出自长官这一句；false＝出自别处（例如「是的」那一轮模型凭记忆重写），
   *  只能说明**单子自己前后不一**，不能说「您说的是…」。 */
  | { kind: "narrowed"; facilityId: string; facilityName: string; frontName: string; verified: boolean }
  | { kind: "conflict"; quote: string; wrote: string; verified: boolean };

export function checkDestinationQuote(
  state: GameState,
  intent: Intent,
  playerText: string | null | undefined,
): DestinationQuoteVerdict {
  if (!isDispatchIntentType(intent.type)) return { kind: "no_check", reason: "not_dispatch" };
  const quote = (intent.destinationQuote ?? "").trim();
  if (!quote) return { kind: "no_check", reason: "no_quote" };
  const said = (playerText ?? "").trim();
  // 片段不在这份方案绑定的原话里：不采信它来**补**目的地；但单子自己「去处片段」与
  //   「目的地字段」前后不一时，照样不许静默执行（实测：陈反问后长官答「是的」，模型凭记忆
  //   重写单子，片段抄的是「北线前哨」、字段只写到北部战线——7/10 去了战线中心）。
  //   这不是翻历史找补丁：比的是**这一张单子自己的两个字段**。
  const verified = !!said && said.includes(quote);

  // 引用里点到的地点（只认本名：设施名、去掉序号的战线名）。
  const facs = [...state.facilities.values()].filter((f) => f.hp > 0 && f.name && quote.includes(f.name));
  const fronts = state.fronts.filter((f) => {
    const bare = f.name.replace(/^\s*\d+\.\s*/, "");
    return bare.length > 0 && quote.includes(bare);
  });
  if (facs.length === 0 && fronts.length === 0) return { kind: "no_check", reason: "names_no_place" };

  // 字段自己写了什么（classifyDestination 回落到 fromFront 那一档算"没写去处"）。
  const dest = classifyDestination(intent, state);
  const wroteNothing = dest.kind === "none" || (dest.kind === "front" && dest.field === "fromFront");
  const frontById = (id: string | null) => (id ? state.fronts.find((f) => f.id === id) : undefined);
  // 引用里若既有战线又有其中的设施（「北部战线的北线前哨」），按更具体的设施算。
  const namedFacs = facs;
  const namedFronts = fronts.filter((fr) => !namedFacs.some((f) => isInFront(state, fr, f.position)));

  if (wroteNothing) return { kind: "no_check", reason: "no_destination_written" };

  const wroteName = describeTargetForLog(intent, state);
  if (dest.kind === "facility" && dest.position) {
    const hit = namedFacs.find((f) => f.position.x === dest.position!.x && f.position.y === dest.position!.y);
    if (hit) return { kind: "consistent" };
    return { kind: "conflict", quote, wrote: wroteName, verified };
  }
  if (dest.kind === "front") {
    const fr = frontById(dest.frontId);
    if (!fr) return { kind: "conflict", quote, wrote: wroteName, verified };
    const inside = namedFacs.filter((f) => isInFront(state, fr, f.position));
    if (intent.type !== "retreat" && namedFacs.length === 1 && inside.length === 1 && namedFronts.every((x) => x.id === fr.id)) {
      return { kind: "narrowed", facilityId: inside[0].id, facilityName: inside[0].name, frontName: fr.name, verified };
    }
    if (namedFacs.length === 0 && namedFronts.length === 1 && namedFronts[0].id === fr.id) return { kind: "consistent" };
    return { kind: "conflict", quote, wrote: wroteName, verified };
  }
  // 地点／精确坐标：引用点到的设施在落点 6 格内、或点到的战线包含落点 ⇒ 一致。
  if (dest.position) {
    const p = dest.position;
    if (namedFacs.some((f) => Math.hypot(f.position.x - p.x, f.position.y - p.y) <= 6)) return { kind: "consistent" };
    if (namedFacs.length === 0 && namedFronts.some((fr) => isInFront(state, fr, p))) return { kind: "consistent" };
  }
  return { kind: "conflict", quote, wrote: wroteName, verified };
}

/**
 * 第六轮：把一小段数量原话里的**数**读出来（「两个」→2、「3辆」→3、「十二个」→12）。
 * 只认数字与汉字数词本身（封闭的数词集合，不是同义词表）；读不出数就返回 null。
 */
const CN_DIGIT: Record<string, number> = {
  "零": 0, "一": 1, "二": 2, "两": 2, "俩": 2, "三": 3, "仨": 3, "四": 4, "五": 5,
  "六": 6, "七": 7, "八": 8, "九": 9,
};
export function parseQuantityWord(text: string | null | undefined): number | null {
  const t = (text ?? "").replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0));
  const arabic = t.match(/\d+/);
  if (arabic) return parseInt(arabic[0], 10);
  const m = t.match(/[零一二两俩三仨四五六七八九十]+/);
  if (!m) return null;
  const w = m[0];
  if (!w.includes("十")) return w.length === 1 ? CN_DIGIT[w] ?? null : null;
  const [tens, ones] = w.split("十");
  const tv = tens === "" ? 1 : CN_DIGIT[tens];
  const ov = ones === "" ? 0 : CN_DIGIT[ones];
  return tv === undefined || ov === undefined ? null : tv * 10 + ov;
}

/** 兵种的中文说法（把枚举翻成人话；不是穷举玩家的说法）。 */
export const UNIT_TYPE_WORD: Record<string, string> = { armor: "坦克", infantry: "步兵", air: "飞机", naval: "舰艇" };

/** 按兵种拆开、却说不清是「一共」还是「各自」的那一组（第六轮）。 */
export interface QuantityAmbiguity {
  /** 这一组的身份（动作§来源§去处）：答完后用它标"这一组已经答过"，不靠下标。 */
  signature: string;
  /** 这一组在整份 intents 里的下标。 */
  indexes: number[];
  /** 「一共」读法的总数；null ＝ 引擎读不出一个总数（只能问"就这样派吗"）。 */
  total: number | null;
  /** 照单子写的派（按兵种各算）的总人数。 */
  asWritten: number;
  /** 问长官的那一句（候选说成人话，不念 key）。 */
  question: string;
  /** 可选的读法（key 只进信封给模型抄；label 是人话）。 */
  candidates: { selectionKey: string; label: string }[];
}
export const QUANTITY_TOTAL_KEY = "quantity:total";
export const QUANTITY_BY_TYPE_KEY = "quantity:by_type";

/**
 * 在原话里给每段引用找一个**互不重叠**的出处（长的先找）。找不齐 ⇒ false。
 * 同一段话说了两次（「两个坦克去…，两个步兵也去…」都抄「两个」）能各占一处；
 * 「两个」与「两个步兵」只说了一次时，不能把同一个「两」算两遍。
 */
function quotesOccupyDistinctSpans(said: string, quotes: string[]): boolean {
  const taken: [number, number][] = [];
  const order = quotes.map((q, i) => ({ q, i })).sort((a, b) => b.q.length - a.q.length);
  for (const { q } of order) {
    let from = 0; let placed = false;
    while (from <= said.length) {
      const at = said.indexOf(q, from);
      if (at < 0) break;
      const end = at + q.length;
      if (!taken.some(([a, b]) => at < b && a < end)) { taken.push([at, end]); placed = true; break; }
      from = at + 1;
    }
    if (!placed) return false;
  }
  return true;
}

/**
 * 第六轮：一句话里的数量有没有被**按兵种拆开**、而长官的原话证明不了是各自的数。
 *
 * 结构：同一个动作、同一个来源、同一个去处，却按兵种写成了几条带数字的单子。
 * 只有两种情形算**有证据**、照单执行：
 *   ① 各自：每一条都抄了一段数量原话、都出自长官这一句、段与段在原话里**不重叠**，
 *      而且每段原话里**读得出的数正是这一条的数**（「两辆坦克」「两个步兵」）。
 *      ——「派两个坦克和步兵」抄成「两个坦克」「步兵」：「步兵」里没有数，证明不了
 *      步兵也是两个（Codex 复现：旧规则只看"引用不同"，放行派出 4 个）。
 *   ② 总量分配：几条抄的是**同一段**原话、它出自长官这一句，且这段话里的数**等于几条之和**
 *      （「派其中三个」→ 坦克 2＋步兵 1）。数量不同本身**不**是证据（2＋1 也可能是替他编的）。
 * 其余一律返回这一组：引擎先问，零执行。
 */
export function findQuantityAmbiguity(intents: readonly Intent[], playerText: string | null | undefined): QuantityAmbiguity[] {
  const said = (playerText ?? "").trim();
  const groups = new Map<string, number[]>();
  intents.forEach((it, i) => {
    if (!isDispatchIntentType(it.type) || typeof it.quantity !== "number") return;
    const src = it.fromSquad ?? it.fromDispatch ?? it.fromFront ?? "";
    const dst = [it.targetFacility, it.targetRegion, it.toFront, it.returnTo].map((x) => x ?? "").join("|");
    const key = [it.type, src, dst].join("§");
    groups.set(key, [...(groups.get(key) ?? []), i]);
  });
  const out: QuantityAmbiguity[] = [];
  for (const [signature, idx] of groups) {
    if (idx.length < 2) continue;
    const types = idx.map((i) => intents[i].unitType ?? "");
    if (new Set(types).size < idx.length) continue; // 不是"只差兵种"那种拆法
    const qty = idx.map((i) => intents[i].quantity as number);
    const asWritten = qty.reduce((a, b) => a + b, 0);
    const quotes = idx.map((i) => (intents[i].quantityQuote ?? "").trim());
    const allSaid = !!said && quotes.every((q) => q.length > 0 && said.includes(q));
    // ① 各自说了各自的数
    if (allSaid && quotes.every((q, k) => parseQuantityWord(q) === qty[k]) && quotesOccupyDistinctSpans(said, quotes)) continue;
    // ② 同一段原话里的总数，被分到了几个兵种上
    const shared = new Set(quotes).size === 1 ? quotes[0] : null;
    if (allSaid && shared && parseQuantityWord(shared) === asWritten) continue;

    // ── 说不清：列出两种读法 ──
    // 「一共」的总数：同一段原话 ⇒ 它的数；否则长官原话里唯一读得出的那个数；
    // 再不然几条写的一样多 ⇒ 那个数（「每种各 n」的对面就是「一共 n」）。
    const saidNums = [...new Set(quotes.filter((q) => q && said.includes(q)).map(parseQuantityWord).filter((n): n is number => n !== null))];
    const total = shared && parseQuantityWord(shared) !== null && said.includes(shared) ? parseQuantityWord(shared)
      : saidNums.length === 1 ? saidNums[0]
      : new Set(qty).size === 1 ? qty[0] : null;
    const equal = new Set(qty).size === 1;
    const n = qty[0];
    // 没写兵种（或写了引擎不认的兵种、被白名单剥掉）的那一条＝不限兵种，照实说。
    const parts = idx.map((i, k) => `${UNIT_TYPE_WORD[intents[i].unitType ?? ""] ?? "不限兵种"} ${qty[k]} 个`).join("、");
    const byTypeLabel = equal ? `每种各 ${n} 个（共 ${asWritten} 个）` : `${parts}（共 ${asWritten} 个）`;
    const candidates: QuantityAmbiguity["candidates"] = [];
    if (total !== null && total !== asWritten) candidates.push({ selectionKey: QUANTITY_TOTAL_KEY, label: `一共 ${total} 个` });
    candidates.push({ selectionKey: QUANTITY_BY_TYPE_KEY, label: byTypeLabel });
    let question: string;
    if (candidates.length === 1) {
      question = `这道令写的是${parts}（共 ${asWritten} 个），就这样派吗？这道命令先没有执行。`;
    } else if (equal && total === n) {
      const q0 = quotes[0];
      const lead = shared && q0 && said.includes(q0) ? `您说的「${q0}」` : `这道令给${idx.length}种兵各写了 ${n} 个`;
      question = `${lead}——是一共 ${n} 个，还是每种各 ${n} 个（共 ${asWritten} 个）？这道命令先没有执行。`;
    } else {
      question = `这道令写的是${parts}——是一共 ${total} 个，还是就按${parts}（共 ${asWritten} 个）？这道命令先没有执行。`;
    }
    out.push({ signature, indexes: idx, total, asWritten, question, candidates });
  }
  return out;
}

/** 兼容旧调用：只要下标。 */
export function findSplitQuantity(intents: readonly Intent[], playerText: string | null | undefined): number[][] {
  return findQuantityAmbiguity(intents, playerText).map((a) => a.indexes);
}

/**
 * 长官选了一种读法之后的整份 intents（纯函数，不改输入）。
 *   · by_type ⇒ 原样（照单子各算）；
 *   · total ⇒ 这一组合成**一条**：不分兵种、数量＝总数，放在这一组第一条的位置上，其余几条去掉。
 * 同时给出旧下标 → 新下标的映射（已选来源的 key 按下标记账，合并后要跟着挪）。
 * 读法不认识 / total 读不出总数 ⇒ null（调用方零执行）。
 */
export function applyQuantityReading(
  intents: readonly Intent[],
  amb: Pick<QuantityAmbiguity, "indexes" | "total">,
  key: string,
): { intents: Intent[]; indexMap: Map<number, number> } | null {
  const identity = new Map(intents.map((_, i) => [i, i] as [number, number]));
  if (key === QUANTITY_BY_TYPE_KEY) return { intents: intents.map((it) => ({ ...it })), indexMap: identity };
  if (key !== QUANTITY_TOTAL_KEY || amb.total === null || amb.indexes.length === 0) return null;
  if (amb.indexes.some((i) => !Number.isInteger(i) || i < 0 || i >= intents.length)) return null;
  const first = Math.min(...amb.indexes);
  const drop = new Set(amb.indexes.filter((i) => i !== first));
  const merged: Intent = { ...intents[first], quantity: amb.total };
  delete merged.unitType;
  delete merged.quantityQuote;
  const out: Intent[] = []; const indexMap = new Map<number, number>();
  intents.forEach((it, i) => {
    if (drop.has(i)) { indexMap.set(i, -1); return; }
    indexMap.set(i, out.length);
    out.push(i === first ? merged : { ...it });
  });
  for (const i of drop) indexMap.set(i, indexMap.get(first)!);
  return { intents: out, indexMap };
}

/**
 * 第七轮：长官对「待确认方案」答了一句、模型给出判词（authorize / amend）——这一份回复**在结构上**
 * 能不能照判词办。唯一生效位置：ChatPanel 的批准判官（contract 消费之前）。
 *
 * 规则（与 PENDING CONTRACT DECISION 的定义同义，不看措辞）：
 *   · authorize ＝「按存下的方案**原样**办」。执行的永远是存下的那一份；回复里的单子只能是它的复述。
 *     回复里**每一张**带意图的单子都必须与存下的方案一致——只要有一张说了不同的人数/兵种/来源/
 *     去处/动作/条数，这份回复就同时在说「照旧」和「改了」，自相矛盾。
 *     ★第六轮的写法是「**任意一张**一致就算批准」：[A:派 1 个, B:原来的 2 个] 因为 B 与旧方案一致，
 *       就执行了旧的 2 个——玩家明说的「一个就够了」被另一张备选掩盖（Codex 复现）。换序、换推荐项、
 *       放一张字段更少的复述都能掩盖。现在不看第几张、不看 recommended，**全部**一致才算。
 *     复述时省略字段、把设施写成它所在的战线，不算不同（C1：「是的」＋凭记忆写粗了仍按存下的办）。
 *   · amend ＝「改成回复里的那一版」。回复里必须恰好只有**一种**改法（重复的复述算一种）；
 *     给了几种不同的改法 ⇒ 引擎不替长官挑第一张。
 * 冲突 ⇒ 调用方零执行、方案作废、用引擎的话说清哪里对不上（不执行旧的，也不执行新的）。
 */
export type ContractReplyConflict =
  | { kind: "authorize_changed"; differences: string[] }
  | { kind: "amend_ambiguous"; plans: number };

export function contractReplyConflict(
  state: GameState,
  captured: { intents?: Intent[]; intent?: Intent } | null | undefined,
  decision: string | null | undefined,
  responseOptions: unknown,
): ContractReplyConflict | null {
  if (!captured || !Array.isArray(responseOptions)) return null;
  const listOf = (o: { intents?: Intent[]; intent?: Intent }) => (o.intents?.length ? o.intents : o.intent ? [o.intent] : []);
  const offered = (responseOptions as { intents?: Intent[]; intent?: Intent }[])
    .filter((o) => o && typeof o === "object").map(listOf).filter((xs) => xs.length > 0);
  if (decision === "authorize") {
    const want = listOf(captured);
    const differences = new Set<string>();
    for (const got of offered) for (const d of planDifferences(state, want, got)) differences.add(d);
    return differences.size > 0 ? { kind: "authorize_changed", differences: [...differences] } : null;
  }
  if (decision === "amend") {
    const distinct: Intent[][] = [];
    for (const got of offered) {
      if (!distinct.some((d) => planDifferences(state, d, got).length === 0 && planDifferences(state, got, d).length === 0)) distinct.push(got);
    }
    return distinct.length > 1 ? { kind: "amend_ambiguous", plans: distinct.length } : null;
  }
  return null;
}

function planDifferences(state: GameState, want: Intent[], got: Intent[]): string[] {
  const diffs = new Set<string>();
  const sum = (xs: Intent[]) => xs.every((i) => typeof i.quantity === "number") ? xs.reduce((a, i) => a + (i.quantity as number), 0) : null;
  const wantSum = sum(want); const gotSum = sum(got);
  const qtyWord = () => (wantSum !== null && gotSum !== null && wantSum !== gotSum
    ? `人数：方案是 ${wantSum} 个，这句是 ${gotSum} 个` : "人数");
  if (want.length !== got.length) {
    diffs.add(wantSum !== null && gotSum !== null && wantSum !== gotSum ? qtyWord() : `方案有 ${want.length} 条命令，这句是 ${got.length} 条`);
  }
  const used = new Set<number>();
  for (const g of got) {
    let bestIdx = -1; let bestDiff: string[] | null = null;
    want.forEach((w, i) => {
      if (used.has(i)) return;
      const d = intentDifferences(state, w, g);
      if (!bestDiff || d.length < bestDiff.length) { bestDiff = d; bestIdx = i; }
    });
    if (bestIdx < 0) continue;
    used.add(bestIdx);
    for (const d of bestDiff ?? []) diffs.add(d === "人数" ? qtyWord() : d);
  }
  return [...diffs];
}

function intentDifferences(state: GameState, w: Intent, g: Intent): string[] {
  const out: string[] = [];
  if (w.type !== g.type) out.push("动作");
  if (g.quantity !== undefined && g.quantity !== w.quantity) out.push("人数");
  if (g.unitType !== undefined && g.unitType !== w.unitType) out.push("兵种");
  const norm = (v: string | undefined) => (v ?? "").trim().toLowerCase();
  for (const k of ["fromSquad", "fromDispatch", "fromFront"] as const) {
    if (g[k] !== undefined && norm(g[k]) !== norm(w[k])) { out.push("来源"); break; }
  }
  if (!destinationCompatible(state, w, g)) out.push("去处");
  return out;
}

/**
 * 第六轮：这条单子的去处是不是**这个点**——同一个地方（6 格内），或者单子只写到了包含这个点的
 * 那条战线（更粗的说法）。没写去处 / 解析不出 ⇒ false（没有东西可比，不算同一处）。
 */
export function destinationCovers(state: GameState, intent: Intent, point: Position): boolean {
  const d = classifyDestination(intent, state);
  if (d.kind === "none") return false;
  if (d.kind === "front") {
    const fr = state.fronts.find((f) => f.id === d.frontId);
    return !!fr && isInFront(state, fr, point);
  }
  return !!d.position && Math.hypot(d.position.x - point.x, d.position.y - point.y) <= 6;
}

/** 回复里的去处是不是存下那个去处（或它更粗的说法）。没写 ⇒ 兼容。 */
function destinationCompatible(state: GameState, w: Intent, g: Intent): boolean {
  const gWrote = !!(g._targetPos || g.targetFacility || g.targetRegion || g.toFront || g.returnTo);
  if (!gWrote) return true;
  if ((g.returnTo ?? "") !== (w.returnTo ?? "")) return false;
  if (g.returnTo) return !(g.targetFacility || g.targetRegion || g.toFront);
  const wd = classifyDestination(w, state);
  const gd = classifyDestination(g, state);
  if (gd.kind === "none") return false; // 写了却解析不出 ⇒ 说的是别处
  if (gd.kind === "front") {
    if (wd.kind === "front") return wd.frontId === gd.frontId;
    const fr = state.fronts.find((f) => f.id === gd.frontId);
    return !!(fr && wd.position && isInFront(state, fr, wd.position)); // 更粗的说法
  }
  if (!wd.position || !gd.position) return false;
  return wd.kind !== "front" && Math.hypot(wd.position.x - gd.position.x, wd.position.y - gd.position.y) <= 1;
}

/**
 * 刀寅：陈要长官点头的方案是否**已经完整**（谁、做什么、去哪都齐，只差一句话）。
 * 不完整的「方案」只是开放问题里夹带的草稿（「您指哪两个人？」＋一张暂定单子），
 * 不能进批准流程——否则长官一句「对」就会把草稿执行掉。纯结构判定。
 */
export function isCompleteConfirmPlan(opt: { intents?: Intent[]; intent?: Intent } | null | undefined): boolean {
  const intents = opt?.intents?.length ? opt.intents : opt?.intent ? [opt.intent] : [];
  if (intents.length === 0) return false;
  return intents.every((i) => {
    if (!isDispatchIntentType(i.type)) return true; // 经济单等：没有「去哪」这一维
    const hasDest = !!(i._targetPos || i.targetFacility || i.targetRegion || i.toFront || i.returnTo);
    if (hasDest) return true;
    if (i.type === "retreat") return true; // 裸撤退本身就是完整命令
    if (i.type === "defend") return !!(i.fromSquad || i.fromDispatch || i.fromFront); // 就地设防：得说清是谁
    return false;
  });
}

const MOVE_INTENTS = new Set(["attack", "defend", "retreat", "recon", "patrol", "reinforce", "capture", "sabotage"]);
function isDispatchIntentType(t: string): boolean {
  return MOVE_INTENTS.has(t);
}

/** 这个位置是否落在该战线的某个区域矩形里（每个点至多属于一条战线，见 mapData 的不变量）。 */
function isInFront(state: GameState, front: Front, p: Position): boolean {
  return front.regionIds.some((rid) => {
    const r = state.regions.get(rid);
    if (!r) return false;
    const [x1, y1, x2, y2] = r.bbox;
    return p.x >= x1 && p.x <= x2 && p.y >= y1 && p.y <= y2;
  });
}

/** Get all dispatchable player units within a front's regions. */
function getUnitsOnFront(state: GameState, front: Front): Unit[] {
  const units: Unit[] = [];
  state.units.forEach((u) => {
    if (!isDispatchablePlayerUnit(u)) return;
    if (isInFront(state, front, u.position)) units.push(u);
  });
  return units;
}

// getFrontCenterPos deleted (v4 §8): it was a byte-for-byte second copy of
// crisisResponse's frontCenterPos, and every one of its call sites now goes
// through frontDestinationFor — which still ends on that same center as its
// last rung. One front-center implementation, in frontDestination.ts.

/** Find a region's center by exact id or fuzzy name match. */
// 刀戊：region 的查找与取中心拆成两件事，**一份实现两处用**
// （`getRegionCenter` 与 `classifyDestination` 都走它；复制一份就会漂）。
function findRegionByHint(state: GameState, regionHint: string) {
  const found = state.regions.get(regionHint);
  if (found) return found;
  const lower = regionHint.toLowerCase();
  for (const [, r] of state.regions) {
    if (r.id.toLowerCase().includes(lower) || r.name.toLowerCase().includes(lower)) return r;
  }
  return undefined;
}

function regionCenterOf(region: { bbox: readonly [number, number, number, number] | number[] }): Position {
  const b = region.bbox as number[];
  return { x: (b[0] + b[2]) / 2, y: (b[1] + b[3]) / 2 };
}

function getRegionCenter(state: GameState, regionHint: string): Position | null {
  const found = findRegionByHint(state, regionHint);
  return found ? regionCenterOf(found) : null;
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

/**
 * Rank recon candidates: type-priority then distance.
 * Order is recon_plane > light_tank > infantry > everything-else;
 * within a tier, closest unit to the target wins.
 *
 * Why: when Chen's brief says "派 N 架侦察机", the engine should actually pick
 * recon_plane first if any are available, instead of silently falling back to
 * infantry just because some footman happens to be closer. Aligns engine
 * selection with the LLM's natural brief wording.
 *
 * Only used by resolveRecon for finite quantity (not "all", which dispatches
 * every unit anyway).
 */
function sortReconCandidates(units: Unit[], target: Position): Unit[] {
  const TYPE_PRIORITY: Record<string, number> = {
    recon_plane: 0,
    light_tank: 1,
    infantry: 2,
  };
  return [...units].sort((a, b) => {
    const pa = TYPE_PRIORITY[a.type] ?? 99;
    const pb = TYPE_PRIORITY[b.type] ?? 99;
    if (pa !== pb) return pa - pb;
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
