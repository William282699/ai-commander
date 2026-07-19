// ============================================================
// AI Commander — Command Preflight (V1 地基一: concern facts)
//
// Turns a pure HighImpactPreview into the STATED FACTS behind Chen's
// in-character concern: how many units actually dispatch, from which named
// places, and what every touched front is left with. All numbers are
// engine-computed from the preview's final assignedUnitIds — the LLM only
// voices them, never computes. Friendly-only reads; zero state mutation.
//
// Codex three-tier wording gate (round-2 hard constraint #1):
//   emptied        aliveBefore>0 && aliveAfter===0            → 战线将空
//   drained        aliveAfter>0 && dispatchableBefore>0
//                                && dispatchableAfter===0      → 可调兵力将被抽空
//   reduced        anything else with drafted members          → 数字如实,不用重词
//   already_empty  aliveBefore===0 — CANNOT be attributed to this order; such
//                  fronts have nothing to draft, so they never enter the list
//                  by construction (bench asserts this).
// ============================================================

import type { GameState, Unit, Front, Position } from "@ai-commander/shared";
import { isDispatchablePlayerUnit } from "@ai-commander/shared";
import type { HighImpactPreview } from "./tacticalPlanner";
import { spatialGroups, nearestPlaceWithin, compassOctant } from "./frontEscalationPayload";

export type PreflightFrontStatus = "emptied" | "drained" | "reduced";

export interface PreflightFrontDelta {
  frontId: string;
  frontName: string;
  aliveBefore: number;
  dispatchableBefore: number;
  aliveAfter: number;
  dispatchableAfter: number;
  draftedFromHere: number;
  status: PreflightFrontStatus;
}

export interface PreflightConcernFacts {
  targetName: string;
  totalDispatched: number;
  skippedCount: number;
  /** Named origins of the drafted force (spatial groups → place names). */
  sources: { place: string; count: number }[];
  /** Only fronts that LOSE members to this order (draftedFromHere > 0). */
  frontDeltas: PreflightFrontDelta[];
}

function frontBboxes(state: GameState, front: Front): [number, number, number, number][] {
  const out: [number, number, number, number][] = [];
  for (const rid of front.regionIds) {
    const r = state.regions.get(rid);
    if (r) out.push(r.bbox);
  }
  return out;
}

function insideBboxes(bboxes: [number, number, number, number][], p: Position): boolean {
  return bboxes.some(([x1, y1, x2, y2]) => p.x >= x1 && p.x <= x2 && p.y >= y1 && p.y <= y2);
}

function centroidOf(units: Unit[]): Position {
  const x = units.reduce((s, u) => s + u.position.x, 0) / units.length;
  const y = units.reduce((s, u) => s + u.position.y, 0) / units.length;
  return { x, y };
}

/** Compute the concern facts for a previewed high-impact dispatch. Pure. */
export function buildPreflightConcernFacts(
  state: GameState,
  preview: HighImpactPreview,
): PreflightConcernFacts {
  const drafted = new Set(preview.assignedUnitIds);
  const draftedUnits = preview.assignedUnitIds
    .map((id) => state.units.get(id))
    .filter((u): u is Unit => u !== undefined);

  // Sources: spatial groups of the drafted force, named exactly like
  // reinforcement candidates (place within radius, else compass direction).
  const placeCounts = new Map<string, number>();
  for (const group of spatialGroups(draftedUnits)) {
    const c = centroidOf(group);
    const place = nearestPlaceWithin(state, c) ?? `${compassOctant(state, c)}方向`;
    placeCounts.set(place, (placeCounts.get(place) ?? 0) + group.length);
  }
  const sources = Array.from(placeCounts.entries())
    .map(([place, count]) => ({ place, count }))
    .sort((a, b) => b.count - a.count || a.place.localeCompare(b.place));

  // Front deltas: only fronts that actually lose members to this order.
  // (aliveBefore===0 fronts have nothing to draft → excluded by construction,
  // which is exactly the "不得归因于本次命令" rule.)
  const frontDeltas: PreflightFrontDelta[] = [];
  for (const front of state.fronts) {
    const bboxes = frontBboxes(state, front);
    if (bboxes.length === 0) continue;
    let aliveBefore = 0;
    let dispatchableBefore = 0;
    let draftedFromHere = 0;
    state.units.forEach((u) => {
      if (u.team !== "player" || u.hp <= 0 || u.state === "dead") return;
      if (!insideBboxes(bboxes, u.position)) return;
      aliveBefore++;
      if (isDispatchablePlayerUnit(u)) dispatchableBefore++;
      if (drafted.has(u.id)) draftedFromHere++;
    });
    if (draftedFromHere === 0) continue;
    const aliveAfter = aliveBefore - draftedFromHere;
    const dispatchableAfter = dispatchableBefore - draftedFromHere; // drafted ⊆ dispatchable
    const status: PreflightFrontStatus =
      aliveAfter === 0 ? "emptied"
      : dispatchableBefore > 0 && dispatchableAfter === 0 ? "drained"
      : "reduced";
    frontDeltas.push({
      frontId: front.id,
      frontName: front.name,
      aliveBefore,
      dispatchableBefore,
      aliveAfter,
      dispatchableAfter,
      draftedFromHere,
      status,
    });
  }

  return {
    targetName: preview.targetName,
    totalDispatched: preview.assignedUnitIds.length,
    skippedCount: preview.skippedCount,
    sources,
    frontDeltas,
  };
}

const STATUS_PHRASE: Record<PreflightFrontStatus, string> = {
  emptied: "战线将空",
  drained: "可调兵力将被抽空",
  reduced: "兵力减少",
};

/** Facts block handed to the preflight voice (LLM speaks, never computes). */
export function serializePreflightFacts(f: PreflightConcernFacts): string {
  const lines = [
    `order_target: ${f.targetName}`,
    `units_dispatched: ${f.totalDispatched}`,
  ];
  if (f.skippedCount > 0) lines.push(`units_unreachable_skipped: ${f.skippedCount}`);
  if (f.sources.length > 0) {
    lines.push(`drafted_from: ${f.sources.map((s) => `${s.place}×${s.count}`).join(", ")}`);
  }
  for (const d of f.frontDeltas) {
    lines.push(
      `front_after: ${d.frontName} 存活 ${d.aliveBefore}→${d.aliveAfter}, 可调 ${d.dispatchableBefore}→${d.dispatchableAfter} (${STATUS_PHRASE[d.status]})`,
    );
  }
  return lines.join("\n");
}

/** Engine fallback when the preflight voice fails: a QUESTION with the real
 *  numbers (Codex hard constraint — never a numberless template). */
export function buildPreflightFallbackLine(f: PreflightConcernFacts): string {
  const emptied = f.frontDeltas.filter((d) => d.status === "emptied");
  const drained = f.frontDeltas.filter((d) => d.status === "drained");
  const tail =
    emptied.length > 0 ? `，${emptied.map((d) => d.frontName).join("、")}将空`
    : drained.length > 0 ? `，${drained.map((d) => d.frontName).join("、")}可调兵力将被抽空`
    : "";
  return `此令将抽调 ${f.totalDispatched} 个单位前往${f.targetName}${tail}，是否继续？`;
}
