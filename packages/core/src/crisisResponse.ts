// ============================================================
// AI Commander — Crisis Response (Prompt 2)
// Pure rule engine: zero-delay tactical card generation for
// DOCTRINE_BREACH events. No LLM call, synchronous return.
//
// Root design: scan the battlefield directly.
//   - "Defenders" = player units physically inside the crisis front
//   - "Reinforcements" = player units outside the crisis front that
//     are idle or on low-priority missions
// No dependency on doctrine.assignedSquads — works with dynamic
// squad creation (El Alamein) and pre-assigned doctrines alike.
// ============================================================

import type { GameState, Front, Position, AdvisorOption, Unit } from "@ai-commander/shared";
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

/** Check if a position is inside a front's region bounding boxes. */
function isInsideFront(state: GameState, front: Front, pos: Position): boolean {
  for (const rid of front.regionIds) {
    const r = state.regions.get(rid);
    if (r && pos.x >= r.bbox[0] && pos.x <= r.bbox[2] && pos.y >= r.bbox[1] && pos.y <= r.bbox[3]) {
      return true;
    }
  }
  return false;
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

function isAlivePlayerUnit(u: Unit): boolean {
  return u.team === "player" && u.hp > 0 && u.state !== "dead"
    && !u.isPlayerControlled && u.type !== "commander";
}

/** Deterministic mission priority: 0=idle, 1=low-priority, 2=high-priority. */
function missionPri(currentMission: string | null): number {
  if (currentMission == null) return 0;
  if (currentMission === "hold" || currentMission === "patrol") return 1;
  return 2;
}

// --- Resolve crisis target front ---

function resolveCrisisFront(state: GameState, locationTag: string): Front | undefined {
  const front = findFront(state, locationTag);
  if (front) return front;
  const region = state.regions.get(locationTag);
  if (region) {
    return state.fronts.find((f) => f.regionIds.includes(locationTag));
  }
  return undefined;
}

// --- Battlefield scan ---

/**
 * Scan the battlefield and partition player units into defenders (inside
 * crisis front) and available reinforcements (outside, idle/low-priority).
 */
function scanBattlefield(state: GameState, front: Front, targetPos: Position) {
  const defenderIds: number[] = [];
  const outsideIds: number[] = [];

  state.units.forEach((u) => {
    if (!isAlivePlayerUnit(u)) return;
    if (isInsideFront(state, front, u.position)) {
      defenderIds.push(u.id);
    } else {
      outsideIds.push(u.id);
    }
  });

  // Group outside units by squad membership
  const assignedToSquad = new Set<number>();
  const squadOutside = new Map<string, number[]>(); // squadId → unitIds outside
  for (const sq of state.squads) {
    if (sq.role !== "leader") continue;
    const uids = collectUnitsUnder(state, sq.id);
    const outsideAlive = uids.filter(id => {
      const u = state.units.get(id);
      return u && isAlivePlayerUnit(u) && !isInsideFront(state, front, u.position);
    });
    if (outsideAlive.length > 0) {
      squadOutside.set(sq.id, outsideAlive);
      for (const id of outsideAlive) assignedToSquad.add(id);
    }
  }

  // Unassigned outside units
  const unassignedOutside = outsideIds.filter(id => !assignedToSquad.has(id));

  // Defenders by squad
  const defenderSquads: string[] = [];
  for (const sq of state.squads) {
    if (sq.role !== "leader") continue;
    const uids = collectUnitsUnder(state, sq.id);
    const insideAlive = uids.filter(id => {
      const u = state.units.get(id);
      return u && isAlivePlayerUnit(u) && isInsideFront(state, front, u.position);
    });
    if (insideAlive.length > 0) defenderSquads.push(sq.id);
  }

  return { defenderIds, defenderSquads, squadOutside, unassignedOutside };
}

// --- Public API ---

/**
 * Find best reinforcement candidates for a crisis.
 * Scans the battlefield directly — no doctrine dependency.
 * Returns up to 3 candidates sorted by score (descending).
 */
export function findBestReinforcements(
  state: GameState,
  crisis: CrisisEvent,
  _doctrine: StandingOrder,
): ReinforceCandidate[] {
  const front = resolveCrisisFront(state, crisis.locationTag);
  if (!front) return [];

  const targetPos = frontCenterPos(state, front);
  if (!targetPos) return [];

  const { squadOutside, unassignedOutside } = scanBattlefield(state, front, targetPos);

  const candidates: ReinforceCandidate[] = [];

  // 1. Squad-based candidates (squads with units OUTSIDE the crisis front)
  for (const [sqId, unitIds] of squadOutside) {
    const sq = state.squads.find(s => s.id === sqId);
    if (!sq) continue;

    const squadPos = avgUnitPos(state, unitIds);
    if (!squadPos) continue;

    const distance = dist(squadPos, targetPos);
    const mp = missionPri(sq.currentMission);
    if (mp >= 2) continue; // never pull squads on high-priority missions

    const score = (1 / (distance + 1)) * 100 - mp * 50 + unitIds.length * 10;
    candidates.push({
      squadId: sq.id,
      leaderName: sq.leaderName,
      distance: Math.round(distance),
      aliveCount: unitIds.length,
      missionPriority: mp,
      score,
    });
  }

  // 2. Unassigned reserve pool (units not in any squad, outside the crisis front)
  if (unassignedOutside.length > 0) {
    const reservePos = avgUnitPos(state, unassignedOutside);
    if (reservePos) {
      const distance = dist(reservePos, targetPos);
      candidates.push({
        squadId: "__reserve__",
        leaderName: "预备队",
        distance: Math.round(distance),
        aliveCount: unassignedOutside.length,
        missionPriority: 0,
        score: (1 / (distance + 1)) * 100 + unassignedOutside.length * 5,
      });
    }
  }

  candidates.sort((a, b) => b.score - a.score);
  return candidates.slice(0, 3);
}

/**
 * Generate 2-3 AdvisorOptions for a crisis card.
 * A: Defend — only units already inside the crisis front
 * B: Fighting retreat — only units already inside the crisis front
 * C: Reinforce — pull outside units/squads toward the front
 */
export function generateCrisisCard(
  state: GameState,
  crisis: CrisisEvent,
  candidates: ReinforceCandidate[],
  _doctrine: StandingOrder,
): AdvisorOption[] {
  const front = resolveCrisisFront(state, crisis.locationTag);
  const frontId = front?.id ?? crisis.locationTag;
  const targetPos = front ? frontCenterPos(state, front) : null;

  // Scan battlefield for defenders
  const scan = front && targetPos ? scanBattlefield(state, front, targetPos) : null;
  const defenderSquads = scan?.defenderSquads ?? [];

  const options: AdvisorOption[] = [];

  // --- Option A: Hold the line ---
  // Scoped to squads physically inside the crisis front.
  // Fallback: defend by fromFront (targets units in-region, which IS correct for defend).
  const defendIntents: Intent[] = defenderSquads.length > 0
    ? defenderSquads.map((sqId) => ({
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

  // --- Option B: Fighting retreat ---
  // ONLY retreat units physically inside the crisis front.
  // Never retreat units outside (they're not part of this fight).
  const retreatIntents: Intent[] = defenderSquads.length > 0
    ? defenderSquads.map((sqId) => ({
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

  // --- Option C: Reinforce ---
  if (candidates.length === 0) {
    options[0].description += "\n⚠ 当前无可调度增援部队——所有分队均在执行高优先级任务。";
  }
  if (candidates.length >= 1) {
    // For reinforcement intents, we must ensure resolveSourceUnits picks
    // units OUTSIDE the crisis front (not the defenders already inside).
    // - Named squads: use fromSquad (resolveSourceUnitsRaw collects that
    //   squad's units — they're already outside per scanBattlefield).
    // - Reserve pool (__reserve__): avoid toFront here.
    //   resolveSourceUnits detects excludeFront===toFront and skips the
    //   toFront local-preference path, using global pool instead.
    //   excludeFront then filters out units already inside the crisis front.
    const reinforceIntents: Intent[] = candidates.slice(0, 2).map((c) => {
      if (c.squadId === "__reserve__") {
        // Reserve pool: no fromSquad. toFront provides correct target
        // position (front center, not single region center).
        // resolveSourceUnits sees excludeFront===toFront → skips local
        // preference → global pool → excludeFront filters interior units.
        return {
          type: "attack" as const,
          toFront: frontId,
          quantity: Math.min(c.aliveCount, 6) as unknown as Intent["quantity"],
          excludeFront: frontId,
          urgency: "critical" as const,
        };
      }
      // Named squad: fromSquad + excludeFront guarantees only the
      // squad's units that are physically outside the crisis front.
      return {
        type: "attack" as const,
        fromSquad: c.squadId,
        toFront: frontId,
        excludeFront: frontId,
        urgency: "critical" as const,
      };
    });

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
