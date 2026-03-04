// ============================================================
// AI Commander — Tactical Planner (stub, Phase 2 Day 10)
// Intent → precise Orders (100% rule-aware)
// ============================================================

import type { GameState, Order, StyleParams } from "@ai-commander/shared";
import type { Intent } from "@ai-commander/shared";

/**
 * Convert an Intent from the LLM into precise game Orders.
 * This function 100% understands game rules — it will never
 * pick wrong units, invalid paths, or impossible actions.
 */
export function resolveIntent(
  _intent: Intent,
  _state: GameState,
  _style: StyleParams,
): Order[] {
  // TODO: Phase 2 (Day 10) — implement resolver for each intent type
  return [];
}
