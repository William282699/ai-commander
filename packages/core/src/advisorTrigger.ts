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
 * Compute pressure ratio for a front (enemyPower / playerPower).
 *
 * IMPORTANT: Computes power live from state.units instead of reading the cached
 * front.playerPower / front.enemyPower fields. Those cached fields are ONLY
 * refreshed inside buildDigest() → updateFrontPower(), which runs on LLM calls
 * (heartbeat, staff-ask) — NOT in the main game tick. So at game start the
 * cached values are 0 and UNDER_ATTACK → crisis_card never fires until the
 * first LLM call incidentally refreshes them.
 *
 * This mirrors the precedent in reportSignals.ts::detectPositionCritical which
 * also computes local realtime stats to avoid the same staleness bug. We use
 * the same power formula as intelDigest.ts::updateFrontPower so that pressure
 * is consistent with what the LLM digest later reports.
 *
 * Returns 0 if front not found or no live player power. Returns Infinity when
 * player power is 0 but enemy power exists (total collapse — always fires).
 */
function getFrontPressure(state: GameState, frontId: string): number {
  const front = state.fronts.find(f => f.id === frontId);
  if (!front) return 0;

  const regionBboxes: [number, number, number, number][] = [];
  for (const rid of front.regionIds) {
    const region = state.regions.get(rid);
    if (region) regionBboxes.push(region.bbox);
  }
  if (regionBboxes.length === 0) return 0;

  let playerPower = 0;
  let enemyPower = 0;

  state.units.forEach((unit) => {
    if (unit.state === "dead" || unit.hp <= 0) return;
    const inFront = regionBboxes.some(
      ([x1, y1, x2, y2]) =>
        unit.position.x >= x1 &&
        unit.position.x <= x2 &&
        unit.position.y >= y1 &&
        unit.position.y <= y2,
    );
    if (!inFront) return;

    const interval = unit.attackInterval > 0 ? unit.attackInterval : 1;
    const power = (unit.hp / unit.maxHp) * unit.attackDamage / interval * 10;

    if (unit.team === "player") {
      playerPower += power;
    } else if (unit.team === "enemy") {
      // Note: do NOT gate by fog here. An UNDER_ATTACK event implies the
      // player unit is actively taking damage, so adjacent enemies are by
      // definition visible — fog gating would only hide pressure from
      // legitimate crisis scenarios.
      enemyPower += power;
    }
  });

  if (playerPower <= 0) return enemyPower > 0 ? Infinity : 0;
  return enemyPower / playerPower;
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
    // Rule 1: UNDER_ATTACK + high pressure → crisis_card
    if (evt.type === "UNDER_ATTACK" && evt.entityId) {
      const pressure = getFrontPressure(state, evt.entityId);
      if (pressure > 2.0) {
        const ruleKey = `advisor:under_attack:${evt.entityId}`;
        if (canFireTrigger(cd, ruleKey, now)) {
          results.push({ type: "crisis_card", event: evt, channel: "combat" });
        }
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
