// ============================================================
// AI Commander — Doctrine Rule Engine (core)
// Pure functions: checkDoctrines() and cancelDoctrine()
// No module-level mutable state — cooldowns live in GameState.
// ============================================================

import type { GameState, Channel } from "@ai-commander/shared";
import type { CrisisEvent, DoctrineCancelResult } from "@ai-commander/shared";

// Cooldown between alerts for the same doctrine (seconds)
const DOCTRINE_BREACH_COOLDOWN_SEC = 30;
const DOCTRINE_WARNING_COOLDOWN_SEC = 60;

/**
 * Check all active doctrines against current game state.
 * Returns CrisisEvent[] for downstream consumption (NOT pushed to state.reportEvents).
 * Uses state.doctrineCooldowns for per-doctrine alert throttling.
 *
 * For must_hold: compare front's enemyPower/playerPower ratio.
 *   > 2.5 → DOCTRINE_BREACH (critical, 30s cooldown)
 *   > 1.5 → DOCTRINE_WARNING (warning, 60s cooldown)
 */
export function checkDoctrines(state: GameState): CrisisEvent[] {
  const crises: CrisisEvent[] = [];

  for (const doc of state.doctrines) {
    if (doc.status !== "active") continue;

    if (doc.type === "must_hold") {
      // Find the front matching this doctrine's locationTag
      const front = state.fronts.find(
        (f) => f.id === doc.locationTag || f.name === doc.locationTag,
      );
      // Also check regions if no front matched
      if (!front) {
        // Attempt region-based matching (Fix P2 #4)
        const region = state.regions.get(doc.locationTag);
        if (!region) continue;
        // Find the front that contains this region
        const parentFront = state.fronts.find(
          (f) => f.regionIds.includes(doc.locationTag),
        );
        if (!parentFront) continue;
        // Use parentFront for power check (fall through to same logic)
        checkFrontForDoctrine(state, doc, parentFront, crises);
        continue;
      }

      checkFrontForDoctrine(state, doc, front, crises);
    }
  }

  return crises;
}

function checkFrontForDoctrine(
  state: GameState,
  doc: import("@ai-commander/shared").StandingOrder,
  front: import("@ai-commander/shared").Front,
  crises: CrisisEvent[],
): void {
  // Skip if enemy power unknown or player has no forces
  if (!front.enemyPowerKnown || front.playerPower <= 0) return;

  const ratio = front.enemyPower / front.playerPower;

  // Separate cooldown keys so a warning doesn't block a breach escalation
  const breachKey = `${doc.id}:breach`;
  const warnKey = `${doc.id}:warning`;

  if (ratio > 2.5) {
    const lastBreach = state.doctrineCooldowns[breachKey] ?? -Infinity;
    if (state.time - lastBreach < DOCTRINE_BREACH_COOLDOWN_SEC) return;
    state.doctrineCooldowns[breachKey] = state.time;
    crises.push({
      type: "DOCTRINE_BREACH",
      severity: "critical",
      doctrineId: doc.id,
      locationTag: doc.locationTag,
      message: `${front.name} 防线告急！敌我力量比 ${ratio.toFixed(1)}:1，${doc.locationTag} 的 must_hold 命令濒临失守！`,
      time: state.time,
    });
  } else if (ratio > 1.5) {
    const lastWarn = state.doctrineCooldowns[warnKey] ?? -Infinity;
    if (state.time - lastWarn < DOCTRINE_WARNING_COOLDOWN_SEC) return;
    state.doctrineCooldowns[warnKey] = state.time;
    crises.push({
      type: "DOCTRINE_WARNING",
      severity: "warning",
      doctrineId: doc.id,
      locationTag: doc.locationTag,
      message: `${front.name} 压力增大，敌我力量比 ${ratio.toFixed(1)}:1，注意 ${doc.locationTag} 的 must_hold 命令。`,
      time: state.time,
    });
  }
}

/**
 * Cancel a doctrine by ID. Sets status to "cancelled".
 * Returns result data for the web layer to consume (e.g. display message).
 *
 * Note: This function lives in core and does NOT touch messageStore.
 * The web layer is responsible for displaying cancellation messages.
 */
export function cancelDoctrine(
  state: GameState,
  doctrineId: string,
): DoctrineCancelResult {
  const doc = state.doctrines.find((d) => d.id === doctrineId);

  if (!doc) {
    return {
      cancelled: false,
      doctrineId,
      locationTag: "",
      type: "must_hold",
      channel: "ops",
      associatedTaskIds: [],
    };
  }

  doc.status = "cancelled";

  return {
    cancelled: true,
    doctrineId: doc.id,
    locationTag: doc.locationTag,
    type: doc.type,
    channel: doc.commander,
    associatedTaskIds: [], // Prompt 3 will populate when TaskCard doctrineId association is implemented
  };
}
