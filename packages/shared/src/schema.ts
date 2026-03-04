// ============================================================
// AI Commander — LLM Output Validation
// Validates and sanitizes JSON from DeepSeek/Claude/OpenAI
// ============================================================

import type { AdvisorResponse, LightAdvisorResponse, OrderAction } from "./types";
import type { IntentType } from "./intents";

const VALID_ACTIONS: OrderAction[] = [
  "attack_move", "defend", "retreat", "flank", "hold",
  "patrol", "escort", "sabotage", "recon", "produce", "trade",
];

const VALID_INTENT_TYPES: IntentType[] = [
  "reinforce", "attack", "defend", "retreat", "flank",
  "sabotage", "recon", "escort", "air_support", "produce", "trade",
];

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

/**
 * Validate an AdvisorResponse from LLM.
 * Returns sanitized response or null if invalid.
 */
export function validateAdvisorResponse(data: unknown): AdvisorResponse | null {
  if (!data || typeof data !== "object") return null;
  const obj = data as Record<string, unknown>;

  if (typeof obj.brief !== "string") return null;
  if (!Array.isArray(obj.options) || obj.options.length === 0) return null;

  const validOptions = (obj.options as unknown[])
    .filter((o): o is Record<string, unknown> => !!o && typeof o === "object")
    .filter((o) => {
      if (typeof o.label !== "string") return false;
      if (typeof o.description !== "string") return false;
      if (typeof o.risk !== "number" || o.risk < 0 || o.risk > 1) return false;
      if (typeof o.reward !== "number" || o.reward < 0 || o.reward > 1) return false;
      if (!o.intent || typeof o.intent !== "object") return false;
      const intent = o.intent as Record<string, unknown>;
      if (!VALID_INTENT_TYPES.includes(intent.type as IntentType)) return false;
      return true;
    })
    .slice(0, 3); // max 3 options

  if (validOptions.length === 0) return null;

  const recommended = typeof obj.recommended === "string" ? obj.recommended : "A";
  const urgency = typeof obj.urgency === "number"
    ? Math.max(0, Math.min(1, obj.urgency))
    : 0.5;

  return {
    brief: obj.brief as string,
    options: validOptions as unknown as AdvisorResponse["options"],
    recommended: recommended as "A" | "B" | "C",
    urgency,
    suggestProduction: obj.suggest_production
      ? (obj.suggest_production as AdvisorResponse["suggestProduction"])
      : undefined,
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
