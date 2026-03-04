// ============================================================
// AI Commander — Style Training Engine (stub for Day 13)
// ============================================================

import type { StyleParams } from "@ai-commander/shared";
import { STYLE_LEARNING_RATE, DEFAULT_STYLE } from "@ai-commander/shared";

export function createDefaultStyle(): StyleParams {
  return { ...DEFAULT_STYLE };
}

export function updateStyleParam(
  params: StyleParams,
  field: keyof StyleParams,
  direction: 1 | -1,
): void {
  const lr = STYLE_LEARNING_RATE;
  params[field] = clamp(params[field] + lr * direction, 0, 1);
}

function clamp(val: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, val));
}
