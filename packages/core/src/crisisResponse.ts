// ============================================================
// AI Commander — Crisis Response (Prompt 2)
// Pure rule engine: zero-delay tactical card generation for
// DOCTRINE_BREACH events. No LLM call, synchronous return.
// ============================================================

import type { GameState, Front, Position, AdvisorOption } from "@ai-commander/shared";
import type { Intent } from "@ai-commander/shared";
import type { CrisisEvent, StandingOrder } from "@ai-commander/shared";
import { collectUnitsUnder } from "@ai-commander/shared";
import { findFront } from "./tacticalPlanner";

// --- Types ---

export interface ReinforceCandidate {
  squadId: string;
  leaderName: string;
  distance: number;
  aliveCount: number;
  missionPriority: number; // 0 idle, 1 low, 2 high
  score: number;
}

// --- Helpers ---

/** Get the center position of a front by averaging its region bboxes. */
function frontCenterPos(state: GameState, front: Front): Position | null {
  let totalX = 0;
  let totalY = 0;
  let count = 0;
  for (const rid of front.regionIds) {
    const region = state.regions.get(rid);
    if (region) {
      totalX += (region.bbox[0] + region.bbox[2]) / 2;
      totalY += (region.bbox[1] + region.bbox[3]) / 2;
      count++;
    }
  }
  if (count === 0) return null;
  return { x: Math.round(totalX / count), y: Math.round(totalY / count) };
}

/** Average position of alive units in a list of unit IDs. */
function avgUnitPos(state: GameState, unitIds: number[]): Position | null {
  let sx = 0;
  let sy = 0;
  let n = 0;
  for (const id of unitIds) {
    const u = state.units.get(id);
    if (!u || u.team !== "player" || u.state === "dead") continue;
    sx += u.position.x;
    sy += u.position.y;
    n++;
  }
  if (n === 0) return null;
  return { x: Math.round(sx / n), y: Math.round(sy / n) };
}

function dist(a: Position, b: Position): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return Math.sqrt(dx * dx + dy * dy);
}

/** Deterministic mission priority: 0=idle, 1=low-priority, 2=high-priority. */
function missionPri(currentMission: string | null): number {
  if (currentMission == null) return 0;
  if (currentMission === "hold" || currentMission === "patrol") return 1;
  return 2;
}

// --- Resolve crisis target front ---

function resolveCrisisFront(state: GameState, locationTag: string): Front | undefined {
  // Try direct front match
  const front = findFront(state, locationTag);
  if (front) return front;

  // Try region → parent front
  const region = state.regions.get(locationTag);
  if (region) {
    return state.fronts.find((f) => f.regionIds.includes(locationTag));
  }

  return undefined;
}

// --- Public API ---

/**
 * Find best reinforcement candidates for a crisis.
 * Returns up to 3 candidates sorted by score (descending).
 */
export function findBestReinforcements(
  state: GameState,
  crisis: CrisisEvent,
  doctrine: StandingOrder,
): ReinforceCandidate[] {
  const front = resolveCrisisFront(state, crisis.locationTag);
  if (!front) return [];

  const targetPos = frontCenterPos(state, front);
  if (!targetPos) return [];

  // Collect candidate squads: player squads not already assigned to this doctrine
  const candidates: ReinforceCandidate[] = [];

  for (const sq of state.squads) {
    // Skip squads already assigned to this doctrine
    if (doctrine.assignedSquads.includes(sq.id)) continue;

    // Only consider leader-role squads (they have actual units)
    if (sq.role !== "leader") continue;

    // Only player-owned squads
    if (sq.ownerCommander !== "chen" && sq.ownerCommander !== "marcus" && sq.ownerCommander !== "emily") continue;

    const unitIds = collectUnitsUnder(state, sq.id);
    const aliveIds = unitIds.filter((id) => {
      const u = state.units.get(id);
      return u && u.team === "player" && u.state !== "dead";
    });

    if (aliveIds.length === 0) continue;

    const squadPos = avgUnitPos(state, aliveIds);
    if (!squadPos) continue;

    const distance = dist(squadPos, targetPos);
    const mp = missionPri(sq.currentMission);

    // Hard filter: never pull squads on high-priority missions
    if (mp >= 2) continue;

    const score = (1 / (distance + 1)) * 100 - mp * 50 + aliveIds.length * 10;

    candidates.push({
      squadId: sq.id,
      leaderName: sq.leaderName,
      distance: Math.round(distance),
      aliveCount: aliveIds.length,
      missionPriority: mp,
      score,
    });
  }

  // If no squad candidates, create a virtual "reserve" candidate from unassigned units
  if (candidates.length === 0) {
    const assignedUnitIds = new Set<number>();
    for (const sq of state.squads) {
      for (const id of collectUnitsUnder(state, sq.id)) assignedUnitIds.add(id);
    }
    const reserveIds: number[] = [];
    state.units.forEach((u) => {
      if (u.team === "player" && u.hp > 0 && u.state !== "dead" && !assignedUnitIds.has(u.id)
          && !u.isPlayerControlled && u.type !== "commander") {
        reserveIds.push(u.id);
      }
    });
    if (reserveIds.length > 0) {
      const reservePos = avgUnitPos(state, reserveIds);
      if (reservePos) {
        const distance = dist(reservePos, targetPos);
        candidates.push({
          squadId: "__reserve__",
          leaderName: "预备队",
          distance: Math.round(distance),
          aliveCount: reserveIds.length,
          missionPriority: 0,
          score: (1 / (distance + 1)) * 100 + reserveIds.length * 5,
        });
      }
    }
  }

  // Sort by score descending, take top 3
  candidates.sort((a, b) => b.score - a.score);
  return candidates.slice(0, 3);
}

/**
 * Generate 2-3 AdvisorOptions for a crisis card.
 * A: Defend (hold position)
 * B: Fighting retreat
 * C: Reinforce with top 2 candidates (only if >= 2 candidates)
 */
export function generateCrisisCard(
  state: GameState,
  crisis: CrisisEvent,
  candidates: ReinforceCandidate[],
  doctrine: StandingOrder,
): AdvisorOption[] {
  const front = resolveCrisisFront(state, crisis.locationTag);
  const frontId = front?.id ?? crisis.locationTag;

  const options: AdvisorOption[] = [];

  // Option A: Hold the line (defend) — scoped to squads assigned to this doctrine
  const defendSquads = doctrine.assignedSquads;
  const defendIntents: Intent[] = defendSquads.length > 0
    ? defendSquads.map((sqId) => ({
        type: "defend" as const,
        fromSquad: sqId,
        fromFront: frontId,
        urgency: "critical" as const,
        minimizeLosses: false,
      }))
    : [{
        type: "defend" as const,
        fromFront: frontId,
        urgency: "critical" as const,
        minimizeLosses: false,
      }];
  options.push({
    label: "A: 死守阵地",
    description: `全力防守${front?.name ?? crisis.locationTag}，不惜代价守住阵地`,
    risk: 0.7,
    reward: 0.8,
    intent: defendIntents[0],
    intents: defendIntents,
  });

  // Option B: Fighting retreat — scoped to squads assigned to this doctrine
  // so only the units on this front retreat, not the entire army.
  // When no squads are assigned, use quantity:"few" to avoid pulling the whole front.
  const retreatSquads = doctrine.assignedSquads;
  const retreatIntents: Intent[] = retreatSquads.length > 0
    ? retreatSquads.map((sqId) => ({
        type: "retreat" as const,
        fromSquad: sqId,
        fromFront: frontId,
        urgency: "high" as const,
        minimizeLosses: true,
      }))
    : [{
        type: "retreat" as const,
        fromFront: frontId,
        quantity: "few" as const,
        urgency: "high" as const,
        minimizeLosses: true,
      }];
  options.push({
    label: "B: 边打边撤",
    description: `有序后撤，保存${front?.name ?? crisis.locationTag}方向有生力量`,
    risk: 0.3,
    reward: 0.4,
    intent: retreatIntents[0],
    intents: retreatIntents,
  });

  // Option C: Reinforce (only if >= 1 candidate), otherwise explain why
  if (candidates.length === 0) {
    // Append notice to option A's description so player understands why no reinforce option
    options[0].description += "\n⚠ 当前无可调度增援部队——所有分队均在执行高优先级任务。";
  }
  if (candidates.length >= 1) {
    const reinforceIntents: Intent[] = candidates.slice(0, 2).map((c) => ({
      type: "attack" as const,
      fromSquad: c.squadId,
      toFront: frontId,
      urgency: "critical" as const,
    }));

    const names = candidates.slice(0, 2).map((c) => c.leaderName).join("、");
    options.push({
      label: "C: 紧急增援",
      description: `调${names}支援${front?.name ?? crisis.locationTag}`,
      risk: 0.5,
      reward: 0.9,
      intent: reinforceIntents[0],
      intents: reinforceIntents,
    });
  }

  return options;
}
