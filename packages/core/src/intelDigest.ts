// ============================================================
// AI Commander — Intel Digest Generator (stub for Day 6)
// Generates DigestV1 from GameState for LLM consumption
// ============================================================

import type { GameState } from "@ai-commander/shared";
import { generateDigestV1 } from "@ai-commander/shared";

/**
 * Build the DigestV1 text to send to the LLM.
 */
export function buildDigest(
  state: GameState,
  selectedUnitIds: number[],
  markedTargets: { id: string; position: [number, number] }[],
  recentEvents: string[],
): string {
  return generateDigestV1(state, selectedUnitIds, markedTargets, recentEvents);
}
