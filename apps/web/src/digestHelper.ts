// ============================================================
// Digest Helper — single decision point for channel → digest builder
// Used by ChatPanel and GameCanvas (phase 2)
// ============================================================

import { ENABLE_BATTLE_CONTEXT_V2 } from "@ai-commander/shared";
import type { GameState, Channel, CommanderMemory } from "@ai-commander/shared";
import { buildDigest, buildBattleContextV2 } from "@ai-commander/core";

const DEFAULT_MEMORY: CommanderMemory = { playerIntent: "", openCommitments: [] };

/**
 * Build the appropriate digest for a given channel.
 * ops channel uses compressed BattleContextV2 when enabled; others use full DigestV1.
 * This is the ONLY place in the web layer that decides which digest format to use.
 */
export function buildDigestForChannel(
  state: GameState,
  ch: Channel,
  memory?: CommanderMemory,
  selectedUnitIds?: number[],
  markedTargets?: { id: string; position: [number, number] }[],
  recentEvents?: string[],
): string {
  if (ENABLE_BATTLE_CONTEXT_V2 && ch === "ops") {
    return buildBattleContextV2(state, ch, memory ?? DEFAULT_MEMORY);
  }
  return buildDigest(state, selectedUnitIds ?? [], markedTargets ?? [], recentEvents ?? []);
}
