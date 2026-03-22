// ============================================================
// AI Commander — LLM Output Validation
// Validates and sanitizes JSON from DeepSeek/Claude/OpenAI
// Single source of truth for action/intent whitelists
// ============================================================

import type { AdvisorResponse, AdvisorOption, LightAdvisorResponse, OrderAction, ResponseType } from "./types";
import type { IntentType, Intent, UrgencyLevel, UnitCategoryHint } from "./intents";

const VALID_RESPONSE_TYPES: readonly ResponseType[] = ["EXECUTE", "CONFIRM", "ASK", "NOOP"];

// ── Whitelists (single source of truth — import from here, don't duplicate) ──

export const VALID_ACTIONS: readonly OrderAction[] = [
  "attack_move", "defend", "retreat", "flank", "hold",
  "patrol", "escort", "sabotage", "recon", "produce", "trade",
] as const;

export const VALID_INTENT_TYPES: readonly IntentType[] = [
  "reinforce", "attack", "defend", "retreat", "flank",
  "sabotage", "recon", "patrol", "escort", "hold",
  "air_support", "produce", "trade", "capture", "cover_retreat",
] as const;

// Tactical planner supported intent types (Day 7 base + Day 9 economy + Day 11 sabotage).
export const DAY7_SUPPORTED_INTENT_TYPES: readonly IntentType[] = [
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
] as const;

const VALID_URGENCY: readonly UrgencyLevel[] = ["low", "medium", "high", "critical"];
const VALID_UNIT_CATEGORY: readonly UnitCategoryHint[] = ["armor", "infantry", "air", "naval"];

// ── Parsing ──

/**
 * Try to parse LLM output as JSON. Handles markdown code blocks.
 */
export function safeParse(raw: string): unknown | null {
  let text = raw.trim();
  // Strip markdown code fences
  if (text.startsWith("```")) {
    text = text.replace(/^```(?:json)?\n?/, "").replace(/\n?```$/, "");
  }
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

// ── Intent Sanitization ──

/**
 * Sanitize an intent object from LLM output.
 * Strips invalid fields, ensures type is in whitelist.
 * Returns null if intent type is invalid.
 */
export function sanitizeIntent(raw: unknown): Intent | null {
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;

  if (!VALID_INTENT_TYPES.includes(obj.type as IntentType)) return null;

  const intent: Intent = { type: obj.type as IntentType };

  // Squad-level dispatch (Day 10.5) — sanitize with trim + sentinel filter
  if (typeof obj.fromSquad === "string" && obj.fromSquad.trim().length > 0) {
    const sq = obj.fromSquad.trim();
    // Day 11: filter sentinel values LLM sometimes emits
    const SQUAD_SENTINELS = ["none", "unassigned", "null", "n/a", "undefined", ""];
    if (!SQUAD_SENTINELS.includes(sq.toLowerCase())) {
      intent.fromSquad = sq;
    }
  }

  // Optional string fields
  if (typeof obj.fromFront === "string") intent.fromFront = obj.fromFront;
  if (typeof obj.toFront === "string") intent.toFront = obj.toFront;
  if (typeof obj.targetFacility === "string") intent.targetFacility = obj.targetFacility;
  if (typeof obj.targetRegion === "string") intent.targetRegion = obj.targetRegion;

  // unitType
  if (VALID_UNIT_CATEGORY.includes(obj.unitType as UnitCategoryHint)) {
    intent.unitType = obj.unitType as UnitCategoryHint;
  }

  // quantity
  if (typeof obj.quantity === "number" && obj.quantity > 0) {
    intent.quantity = obj.quantity;
  } else if (typeof obj.quantity === "string" && ["all", "most", "some", "few"].includes(obj.quantity)) {
    intent.quantity = obj.quantity as "all" | "most" | "some" | "few";
  }

  // urgency
  if (VALID_URGENCY.includes(obj.urgency as UrgencyLevel)) {
    intent.urgency = obj.urgency as UrgencyLevel;
  }

  // Booleans
  if (typeof obj.minimizeLosses === "boolean") intent.minimizeLosses = obj.minimizeLosses;
  if (typeof obj.airCover === "boolean") intent.airCover = obj.airCover;
  if (typeof obj.holdAfter === "boolean") intent.holdAfter = obj.holdAfter;
  if (typeof obj.stealth === "boolean") intent.stealth = obj.stealth;

  // Production / trade
  if (typeof obj.produceType === "string") intent.produceType = obj.produceType;
  if (typeof obj.tradeAction === "string") intent.tradeAction = obj.tradeAction;

  // Patrol radius (Day 9.5): clamp [3, 30], integer
  if (typeof obj.patrolRadius === "number") {
    intent.patrolRadius = Math.round(Math.max(3, Math.min(30, obj.patrolRadius)));
  }

  return intent;
}

// ── Response Validation ──

/**
 * Validate an AdvisorResponse from LLM.
 * Returns sanitized response or null if invalid.
 */
export function validateAdvisorResponse(data: unknown): AdvisorResponse | null {
  if (!data || typeof data !== "object") return null;
  const obj = data as Record<string, unknown>;

  if (typeof obj.brief !== "string") return null;
  if (!Array.isArray(obj.options)) return null;

  // Parse responseType if present (case-insensitive — LLM may return "noop"/"Noop")
  const rawRT = typeof obj.responseType === "string" ? obj.responseType.toUpperCase() : undefined;
  const responseType = (rawRT && VALID_RESPONSE_TYPES.includes(rawRT as ResponseType))
    ? rawRT as ResponseType
    : undefined;

  // Doctrine fields — extract early so NOOP/empty-options paths also get them
  let standingOrder: AdvisorResponse["standingOrder"] | undefined;
  if (obj.standingOrder && typeof obj.standingOrder === "object") {
    const so = obj.standingOrder as Record<string, unknown>;
    if (typeof so.type === "string" && typeof so.locationTag === "string") {
      standingOrder = {
        type: so.type,
        locationTag: so.locationTag,
        priority: typeof so.priority === "string" ? so.priority : "normal",
        allowAutoReinforce: typeof so.allowAutoReinforce === "boolean" ? so.allowAutoReinforce : false,
      };
    }
  }
  const cancelDoctrineId = typeof obj.cancelDoctrine === "string" && obj.cancelDoctrine.length > 0
    ? obj.cancelDoctrine
    : undefined;

  // Day 13 Layer B: LLM may return empty options[] to reject invalid commands.
  // Phase 2: NOOP responseType with options:[] is a valid conversational response.
  if (obj.options.length === 0) {
    const urgency = typeof obj.urgency === "number"
      ? Math.max(0, Math.min(1, obj.urgency))
      : 0;
    return {
      brief: obj.brief as string,
      options: [],
      recommended: "A" as const,
      urgency,
      responseType,
      standingOrder,
      cancelDoctrine: cancelDoctrineId,
    };
  }

  const validOptions = (obj.options as unknown[])
    .filter((o): o is Record<string, unknown> => !!o && typeof o === "object")
    .map((o) => {
      if (typeof o.label !== "string") return null;
      if (typeof o.description !== "string") return null;
      const risk = typeof o.risk === "number" ? Math.max(0, Math.min(1, o.risk)) : 0.5;
      const reward = typeof o.reward === "number" ? Math.max(0, Math.min(1, o.reward)) : 0.5;

      // Multi-intent: accept "intents" (array) or "intent" (single, wrap to array)
      let intents: Intent[] = [];
      if (Array.isArray(o.intents)) {
        for (const raw of o.intents) {
          const i = sanitizeIntent(raw);
          if (i) intents.push(i);
        }
      }
      if (intents.length === 0 && o.intent) {
        const single = sanitizeIntent(o.intent);
        if (single) intents = [single];
      }
      if (intents.length === 0) return null;

      // Prompt6: cap intents per option at 5 to match schema safety limit
      if (intents.length > 5) {
        console.warn(`[schema] Option "${o.label}" had ${intents.length} intents — truncated to 5`);
        intents = intents.slice(0, 5);
      }

      return {
        label: o.label,
        description: o.description,
        risk,
        reward,
        intent: intents[0],     // backward compat: first intent
        intents,                 // full array
      } as AdvisorOption;
    })
    .filter((o): o is AdvisorOption => o !== null)
    .slice(0, 3);

  if (validOptions.length === 0) return null;

  const recommended = typeof obj.recommended === "string" ? obj.recommended : "A";
  const urgency = typeof obj.urgency === "number"
    ? Math.max(0, Math.min(1, obj.urgency))
    : 0.5;

  // Enforce: NOOP must have empty options. If LLM returned NOOP with options, drop responseType.
  const effectiveRT = (responseType === "NOOP" && validOptions.length > 0)
    ? undefined
    : responseType;

  return {
    brief: obj.brief as string,
    options: validOptions,
    recommended: recommended as "A" | "B" | "C",
    urgency,
    responseType: effectiveRT,
    suggestProduction: obj.suggest_production
      ? (obj.suggest_production as AdvisorResponse["suggestProduction"])
      : undefined,
    standingOrder,
    cancelDoctrine: cancelDoctrineId,
  };
}

/**
 * Validate a LightAdvisorResponse (brief only, no orders).
 */
export function validateLightResponse(data: unknown): LightAdvisorResponse | null {
  if (!data || typeof data !== "object") return null;
  const obj = data as Record<string, unknown>;
  if (typeof obj.brief !== "string") return null;
  const urgency = typeof obj.urgency === "number"
    ? Math.max(0, Math.min(1, obj.urgency))
    : 0.5;
  return { brief: obj.brief as string, urgency };
}

/**
 * Check if an action string is in the allowed set.
 */
export function isValidAction(action: string): action is OrderAction {
  return VALID_ACTIONS.includes(action as OrderAction);
}

/**
 * Check if an intent type is in the allowed set.
 */
export function isValidIntentType(type: string): type is IntentType {
  return VALID_INTENT_TYPES.includes(type as IntentType);
}

export function isDay7SupportedIntentType(type: IntentType): boolean {
  return DAY7_SUPPORTED_INTENT_TYPES.includes(type);
}

// ── Fallback Response ──

/**
 * Create a default fallback response when LLM returns non-JSON or invalid data.
 */
export function createFallbackResponse(): AdvisorResponse {
  return {
    brief: "通讯干扰，无法解析参谋建议。以下为默认方案。",
    options: [
      {
        label: "A: 稳守阵地",
        description: "全线防御，等待进一步情报",
        risk: 0.2,
        reward: 0.3,
        intent: { type: "defend", urgency: "medium" },
        intents: [{ type: "defend", urgency: "medium" }],
      },
      {
        label: "B: 有限进攻",
        description: "在最有利战线发动试探性进攻",
        risk: 0.5,
        reward: 0.6,
        intent: { type: "attack", quantity: "some", urgency: "medium" },
        intents: [{ type: "attack", quantity: "some", urgency: "medium" }],
      },
      {
        label: "C: 全线侦察",
        description: "派出侦察力量摸清敌方部署",
        risk: 0.1,
        reward: 0.4,
        intent: { type: "recon", quantity: "few", urgency: "low" },
        intents: [{ type: "recon", quantity: "few", urgency: "low" }],
      },
    ],
    recommended: "A",
    urgency: 0.3,
  };
}
