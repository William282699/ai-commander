/**
 * Prompt 6 — Advisor Trigger System
 *
 * Pure function that scans reportEvents and returns trigger results
 * for the web layer to consume (crisis cards or LLM advice).
 * No side effects — only reads state, returns results.
 */

import type { GameState, ReportEvent, Channel } from "@ai-commander/shared";

const TRIGGER_COOLDOWN_SEC = 30;

export type AdvisorTriggerType = "crisis_card" | "llm_advice";

export interface AdvisorTriggerResult {
  type: AdvisorTriggerType;
  event: ReportEvent;
  channel: Channel;
}

/**
 * Check if a trigger rule is off cooldown.
 * Updates cooldowns in-place if firing (the only mutation — on GameState.advisorTriggerCooldowns).
 */
function canFireTrigger(
  cooldowns: Record<string, number>,
  ruleKey: string,
  nowSec: number,
): boolean {
  const last = cooldowns[ruleKey] ?? -Infinity;
  if (nowSec - last < TRIGGER_COOLDOWN_SEC) return false;
  cooldowns[ruleKey] = nowSec;
  return true;
}

/**
 * Scan state.reportEvents for advisor trigger conditions.
 * Must be called BEFORE drainReportEvents so events are still present.
 *
 * Mutates: state.advisorTriggerCooldowns (cooldown timestamps only).
 * Returns: array of trigger results for the web layer.
 */
export function processAdvisorTriggers(state: GameState): AdvisorTriggerResult[] {
  const results: AdvisorTriggerResult[] = [];
  const cd = state.advisorTriggerCooldowns;
  const now = state.time;

  for (const evt of state.reportEvents) {
    // Rule 1: UNDER_ATTACK → Chen alert (event-driven chat, not A/B/C card).
    // Fires on ANY pressure — Chen's prompt judges urgency from digest (light probe vs
    // full assault). Cooldown (30s/front here + 15s/front in reportSignals) prevents spam.
    // Player responds naturally in chat; LLM translates reply → intent → execute.
    // Crisis cards are reserved for DOCTRINE_BREACH (player-declared must-hold) and HQ loss.
    if (evt.type === "UNDER_ATTACK" && evt.entityId) {
      const ruleKey = `advisor:under_attack:${evt.entityId}`;
      if (canFireTrigger(cd, ruleKey, now)) {
        results.push({ type: "llm_advice", event: evt, channel: "combat" });
      }
    }

    // Rule 2: FACILITY_LOST + HQ → crisis_card
    if (evt.type === "FACILITY_LOST" && evt.entityId) {
      // Check if the lost facility WAS the player HQ (it may have changed team by now)
      const fac = state.facilities.get(evt.entityId);
      const isHQ = fac?.type === "headquarters";
      if (isHQ) {
        const ruleKey = `advisor:facility_lost_hq:${evt.entityId}`;
        if (canFireTrigger(cd, ruleKey, now)) {
          results.push({ type: "crisis_card", event: evt, channel: "ops" });
        }
      }
    }

    // Rule 3: SQUAD_HEAVY_LOSS → llm_advice
    if (evt.type === "SQUAD_HEAVY_LOSS") {
      const ruleKey = `advisor:squad_heavy_loss:${evt.entityId ?? "global"}`;
      if (canFireTrigger(cd, ruleKey, now)) {
        results.push({ type: "llm_advice", event: evt, channel: "combat" });
      }
    }
  }

  return results;
}
