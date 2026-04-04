// ============================================================
// AI Commander — Crisis Response (Phase B rewrite)
// Pure rule engine: zero-delay tactical card generation for
// DOCTRINE_BREACH events. No LLM call, synchronous return.
//
// Root design: scan the battlefield directly.
//   - "Defenders" = player units physically inside the crisis front
//   - "Reinforcements" = player units outside the crisis front that
//     are idle or on low-priority missions
// No dependency on doctrine.assignedSquads — works with dynamic
// squad creation (El Alamein) and pre-assigned doctrines alike.
//
// Phase B: time-based feasibility + power assessment.
//   - T_arrive: estimated travel time per candidate
//   - T_collapse: estimated time before front falls
//   - Power ratio: DPS impact of reinforcement arrival
//   - Each viable candidate becomes its own option (player chooses)
// ============================================================

import type { GameState, Front, Position, AdvisorOption, Unit } from "@ai-commander/shared";
import type { Intent } from "@ai-commander/shared";
import type { CrisisEvent, StandingOrder } from "@ai-commander/shared";
import { collectUnitsUnder, getUnitCategory, TERRAIN_MOVE_MULT } from "@ai-commander/shared";
import { findFront } from "./tacticalPlanner";

// --- Types ---

/** Assessment of what the reinforcement can achieve on arrival. */
export type ReinforcementAssessment = "decisive" | "delaying" | "insufficient";

export interface ReinforceCandidate {
  squadId: string;
  leaderName: string;
  distance: number;        // geometric distance (tiles)
  aliveCount: number;
  missionPriority: number; // 0 idle, 1 low, 2 high
  score: number;
  // Phase B: time & power fields
  tArrive: number;         // estimated travel time (seconds)
  tCollapse: number;       // estimated time before front collapses (seconds)
  reinforceDPS: number;    // total DPS this candidate brings
  currentPowerRatio: number; // defender DPS / enemy DPS before reinforcement
  newPowerRatio: number;   // (defender DPS + reinforcement DPS) / enemy DPS
  assessment: ReinforcementAssessment;
}

// --- Helpers ---

/** Get the center position of a front by averaging its region bboxes. */
export function frontCenterPos(state: GameState, front: Front): Position | null {
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

function euclidDist(a: Position, b: Position): number {
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

// ============================================================
// Phase B: Time & Power estimation
// ============================================================

/**
 * Estimate travel time (seconds) for a unit moving from `from` to `to`.
 *
 * Uses Bresenham line sampling to estimate terrain along the straight-line
 * path, then accumulates time = 1 / (moveSpeed × terrainMult) per tile.
 * Impassable tiles are penalised with a conservative 0.3 multiplier
 * (approximates the detour cost of going around).
 *
 * This is intentionally cheaper than A* — good enough for ranking candidates,
 * not used for actual pathfinding.
 */
export function estimateTravelTime(
  unit: Unit,
  from: Position,
  to: Position,
  state: GameState,
): number {
  const cat = getUnitCategory(unit.type);
  const speed = unit.moveSpeed;
  if (speed <= 0) return Infinity;

  // Bresenham line rasterisation
  let x0 = Math.floor(from.x);
  let y0 = Math.floor(from.y);
  const x1 = Math.floor(to.x);
  const y1 = Math.floor(to.y);
  const dx = Math.abs(x1 - x0);
  const dy = Math.abs(y1 - y0);
  const sx = x0 < x1 ? 1 : -1;
  const sy = y0 < y1 ? 1 : -1;
  let err = dx - dy;

  let totalTime = 0;
  const maxTiles = 500; // safety cap
  let tileCount = 0;

  while (tileCount < maxTiles) {
    // Accumulate time for this tile
    let mult = 1.0;
    if (y0 >= 0 && y0 < state.mapHeight && x0 >= 0 && x0 < state.mapWidth) {
      const terrain = state.terrain[y0]?.[x0];
      if (terrain) {
        mult = TERRAIN_MOVE_MULT[terrain]?.[cat] ?? 0;
      }
    }
    if (mult <= 0) {
      // Impassable — penalise as if detour at slowest passable terrain
      totalTime += 1 / (speed * 0.3);
    } else {
      totalTime += 1 / (speed * mult);
    }

    if (x0 === x1 && y0 === y1) break;
    const e2 = 2 * err;
    if (e2 > -dy) { err -= dy; x0 += sx; }
    if (e2 < dx) { err += dx; y0 += sy; }
    tileCount++;
  }

  return totalTime;
}

/**
 * Estimate average travel time for a squad (group of unit IDs) to a target.
 * Uses the slowest unit's estimate (bottleneck determines squad arrival).
 */
function estimateSquadTravelTime(
  state: GameState,
  unitIds: number[],
  target: Position,
): number {
  let worstTime = 0;
  for (const id of unitIds) {
    const u = state.units.get(id);
    if (!u || u.hp <= 0 || u.state === "dead") continue;
    const t = estimateTravelTime(u, u.position, target, state);
    if (t > worstTime) worstTime = t;
  }
  return worstTime;
}

/**
 * Estimate how long the front can hold (seconds) based on current force balance.
 *
 * T_collapse ≈ totalDefenderHP / totalEnemyDPS
 *
 * Conservative: ignores terrain defence bonuses and counter multipliers,
 * so the estimate errs on the pessimistic side (shorter collapse time).
 * This is intentional — better to slightly over-estimate urgency than
 * to recommend reinforcement that arrives after the line breaks.
 */
function estimateCollapseTime(state: GameState, front: Front): {
  tCollapse: number;
  defenderDPS: number;
  enemyDPS: number;
} {
  let defenderHP = 0;
  let defenderDPS = 0;
  let enemyDPS = 0;

  state.units.forEach(u => {
    if (u.hp <= 0 || u.state === "dead") return;
    if (!isInsideFront(state, front, u.position)) return;

    if (u.team === "player") {
      defenderHP += u.hp;
      if (u.attackDamage > 0 && u.attackInterval > 0) {
        defenderDPS += u.attackDamage / u.attackInterval;
      }
    } else {
      // FOG-TODO: when fog-of-war has an info layer, only count enemies
      // visible to the player (state.visibleTiles check). Unseen enemies
      // should be excluded, making T_collapse optimistic — which is the
      // correct "incomplete intel" behavior for fog.
      if (u.attackDamage > 0 && u.attackInterval > 0) {
        enemyDPS += u.attackDamage / u.attackInterval;
      }
    }
  });

  const tCollapse = enemyDPS > 0 ? defenderHP / enemyDPS : Infinity;
  return { tCollapse, defenderDPS, enemyDPS };
}

/**
 * Compute the total DPS a group of units contributes.
 */
function computeGroupDPS(state: GameState, unitIds: number[]): number {
  let dps = 0;
  for (const id of unitIds) {
    const u = state.units.get(id);
    if (!u || u.hp <= 0 || u.state === "dead") continue;
    if (u.attackDamage > 0 && u.attackInterval > 0) {
      dps += u.attackDamage / u.attackInterval;
    }
  }
  return dps;
}

/**
 * Classify what a reinforcement can achieve based on power ratio AND timing.
 * Both axes must pass for a positive assessment:
 * - Arrives after collapse → "insufficient" regardless of firepower
 * - Arrives in time but weak → "insufficient"
 */
function assessReinforcement(
  currentRatio: number,
  newRatio: number,
  tArrive: number,
  tCollapse: number,
): ReinforcementAssessment {
  // Hard gate: if they arrive after the front collapses, it's insufficient
  // (they can only counter-attack ruins, not reinforce a living position)
  if (tCollapse !== Infinity && tArrive > tCollapse) return "insufficient";

  // Power assessment (only meaningful if they arrive in time)
  if (newRatio >= 1.2) return "decisive";
  if (newRatio >= 0.7) return "delaying";
  return "insufficient";
}

/**
 * Compute the average position of friendly defenders inside a front.
 * Reinforcements should link up with defenders, not charge at enemies.
 *
 * This is tactically correct: reinforcements join the defensive line
 * where friendlies already have positions, rather than running past
 * them into the enemy formation.
 */
function findDefenderCentroid(state: GameState, front: Front): Position | null {
  let count = 0;
  let sx = 0;
  let sy = 0;

  state.units.forEach(u => {
    if (u.hp <= 0 || u.state === "dead" || u.team !== "player") return;
    if (u.isPlayerControlled || u.type === "commander") return;
    if (!isInsideFront(state, front, u.position)) return;
    sx += u.position.x;
    sy += u.position.y;
    count++;
  });

  if (count <= 0) return null;
  return { x: Math.round(sx / count), y: Math.round(sy / count) };
}

// --- Battlefield scan ---

/**
 * Scan the battlefield and partition player units into defenders (inside
 * crisis front) and available reinforcements (outside, idle/low-priority).
 *
 * Outside units are filtered to "dispatchable" state (idle, patrolling, holding)
 * to match the execution-side strict idle-only filter in resolveSourceUnits.
 * This prevents "card shows reinforcement available, click does nothing".
 *
 * Units already en-route to reinforce THIS front (order.crisisFrontId matches)
 * are excluded from both pools to prevent re-dispatch.
 */
function scanBattlefield(state: GameState, front: Front, targetPos: Position) {
  // States that the execution layer (resolveSourceUnits strict idle-only) will accept
  const dispatchableStates = new Set(["idle", "patrolling", "holding"]);

  const defenderIds: number[] = [];
  const outsideIds: number[] = [];

  state.units.forEach((u) => {
    if (!isAlivePlayerUnit(u)) return;
    // Phase C: skip units already en-route to reinforce this front
    const isEnRoute = u.orders.some(o => o.crisisFrontId === front.id);
    if (isEnRoute) return;
    if (isInsideFront(state, front, u.position)) {
      defenderIds.push(u.id);
    } else {
      // Only include dispatchable units as reinforcement candidates.
      // Busy units (moving, attacking, defending, retreating) won't pass
      // the execution-side idle filter, so including them would create
      // phantom candidates ("card says 8 available, 0 actually dispatched").
      if (dispatchableStates.has(u.state)) {
        outsideIds.push(u.id);
      }
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
      if (!u || !isAlivePlayerUnit(u)) return false;
      // Skip en-route units
      if (u.orders.some(o => o.crisisFrontId === front.id)) return false;
      if (!dispatchableStates.has(u.state)) return false;
      return !isInsideFront(state, front, u.position);
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
 *
 * Phase B: each candidate now carries T_arrive, T_collapse, power assessment.
 * Scoring: time feasibility (weight 60) + power impact (30) - opportunity cost (10).
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

  // Front situation assessment
  const { tCollapse, defenderDPS, enemyDPS } = estimateCollapseTime(state, front);
  const currentPowerRatio = enemyDPS > 0 ? defenderDPS / enemyDPS : Infinity;

  const candidates: ReinforceCandidate[] = [];

  // 1. Squad-based candidates (squads with units OUTSIDE the crisis front)
  for (const [sqId, unitIds] of squadOutside) {
    const sq = state.squads.find(s => s.id === sqId);
    if (!sq) continue;

    const squadPos = avgUnitPos(state, unitIds);
    if (!squadPos) continue;

    const mp = missionPri(sq.currentMission);
    if (mp >= 2) continue; // never pull squads on high-priority missions

    const distance = euclidDist(squadPos, targetPos);
    const tArrive = estimateSquadTravelTime(state, unitIds, targetPos);
    const reinforceDPS = computeGroupDPS(state, unitIds);
    const newPowerRatio = enemyDPS > 0 ? (defenderDPS + reinforceDPS) / enemyDPS : Infinity;
    const assessment = assessReinforcement(currentPowerRatio, newPowerRatio, tArrive, tCollapse);

    // Three-axis scoring:
    // Time axis (0-60): how much margin before collapse.
    // Late arrival gets -100 to guarantee it sorts below all on-time candidates.
    const timeScore = tCollapse === Infinity ? 60 :
      tArrive <= tCollapse ? (1 - tArrive / tCollapse) * 60 : -100;
    // Power axis (0-30): how much the power ratio improves.
    const powerDelta = enemyDPS > 0 ? reinforceDPS / enemyDPS : 0;
    const powerScore = Math.min(powerDelta * 30, 30);
    // Cost axis (0-10): opportunity cost of pulling this squad.
    const costPenalty = mp * 5; // 0 for idle, 5 for low-priority

    const score = timeScore + powerScore - costPenalty;

    candidates.push({
      squadId: sq.id,
      leaderName: sq.leaderName,
      distance: Math.round(distance),
      aliveCount: unitIds.length,
      missionPriority: mp,
      score,
      tArrive: Math.round(tArrive),
      tCollapse: Math.round(tCollapse),
      reinforceDPS: Math.round(reinforceDPS * 10) / 10,
      currentPowerRatio: Math.round(currentPowerRatio * 100) / 100,
      newPowerRatio: Math.round(newPowerRatio * 100) / 100,
      assessment,
    });
  }

  // 2. Unassigned reserve pool (units not in any squad, outside the crisis front)
  // Dispatch count is demand-driven: add closest units until we have enough DPS
  // to reach a 1.2 power ratio (decisive threshold). No arbitrary cap — a small
  // skirmish might need 3 units, a major breakthrough might need 20.
  if (unassignedOutside.length > 0) {
    // Sort by individual travel time to target (closest first)
    const withTime = unassignedOutside
      .map(id => {
        const u = state.units.get(id)!;
        return { id, time: estimateTravelTime(u, u.position, targetPos, state) };
      })
      .sort((a, b) => a.time - b.time);

    // How much DPS do we need to reach 1.2 power ratio?
    const TARGET_RATIO = 1.2;
    const dpsDeficit = enemyDPS > 0 ? enemyDPS * TARGET_RATIO - defenderDPS : 0;

    // Greedily add closest units until deficit is covered
    const dispatched: number[] = [];
    let accumulatedDPS = 0;
    for (const w of withTime) {
      dispatched.push(w.id);
      const u = state.units.get(w.id);
      if (u && u.attackDamage > 0 && u.attackInterval > 0) {
        accumulatedDPS += u.attackDamage / u.attackInterval;
      }
      // Stop once we have enough DPS to flip the fight,
      // but always take at least 2 units (avoid sending 1 lone soldier)
      if (accumulatedDPS >= dpsDeficit && dispatched.length >= 2) break;
    }

    if (dispatched.length > 0) {
      const reservePos = avgUnitPos(state, dispatched);
      if (reservePos) {
        const distance = euclidDist(reservePos, targetPos);
        const tArrive = estimateSquadTravelTime(state, dispatched, targetPos);
        const reinforceDPS = computeGroupDPS(state, dispatched);
        const newPowerRatio = enemyDPS > 0 ? (defenderDPS + reinforceDPS) / enemyDPS : Infinity;
        const assessment = assessReinforcement(currentPowerRatio, newPowerRatio, tArrive, tCollapse);

        const timeScore = tCollapse === Infinity ? 60 :
          tArrive <= tCollapse ? (1 - tArrive / tCollapse) * 60 : -100;
        const powerDelta = enemyDPS > 0 ? reinforceDPS / enemyDPS : 0;
        const powerScore = Math.min(powerDelta * 30, 30);

        candidates.push({
          squadId: "__reserve__",
          leaderName: "预备队",
          distance: Math.round(distance),
          aliveCount: dispatched.length,
          missionPriority: 0,
          score: timeScore + powerScore,
          tArrive: Math.round(tArrive),
          tCollapse: Math.round(tCollapse),
          reinforceDPS: Math.round(reinforceDPS * 10) / 10,
          currentPowerRatio: Math.round(currentPowerRatio * 100) / 100,
          newPowerRatio: Math.round(newPowerRatio * 100) / 100,
          assessment,
        });
      }
    }
  }

  candidates.sort((a, b) => b.score - a.score);
  return candidates.slice(0, 3);
}

/**
 * Generate AdvisorOptions for a crisis card.
 * A: Defend — only units already inside the crisis front
 * B: Fighting retreat — only units already inside the crisis front
 * C/D/E: Reinforce — each viable candidate as a separate option with
 *         time estimate, power assessment, and player-facing info.
 *
 * If no candidate can arrive before collapse, Option C is omitted and
 * a warning is appended to Option A.
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

  // Find defender centroid: average position of friendly units in the front.
  // Reinforcements link up with defenders, not charge at enemies.
  const defenderCentroid = front ? findDefenderCentroid(state, front) : null;

  // Scan battlefield for defenders
  const scan = front && targetPos ? scanBattlefield(state, front, targetPos) : null;
  const defenderSquads = scan?.defenderSquads ?? [];

  const options: AdvisorOption[] = [];

  // --- Option A: Hold the line ---
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

  // --- Option C/D/E: Per-candidate reinforcement options ---
  // Filter: only show candidates with positive score as primary options.
  // Negative-score candidates (arrive after collapse) are shown with warning.
  if (candidates.length === 0) {
    options[0].description += "\n⚠ 当前无可调度增援部队——所有分队均在执行高优先级任务或已在增援途中。";
  }

  const letters = ["C", "D", "E"];
  const assessmentLabel: Record<ReinforcementAssessment, string> = {
    decisive: "★可翻转局面",
    delaying: "⚠可延缓崩溃",
    insufficient: "✗兵力不足",
  };

  for (let i = 0; i < candidates.length && i < 3; i++) {
    const c = candidates[i];
    const letter = letters[i];

    // Build the reinforcement intent.
    // If a pressure hotspot region was found, use targetRegion to direct
    // reinforcements to the actual fight instead of the geometric front center.
    // Keep toFront as fallback (resolveTarget tries targetRegion first).
    const reinforceIntent: Intent = c.squadId === "__reserve__"
      ? {
          type: "attack" as const,
          _targetPos: defenderCentroid ?? undefined,
          toFront: frontId,
          quantity: c.aliveCount as unknown as Intent["quantity"],
          excludeFront: frontId,
          urgency: "critical" as const,
        }
      : {
          type: "attack" as const,
          fromSquad: c.squadId,
          _targetPos: defenderCentroid ?? undefined,
          toFront: frontId,
          excludeFront: frontId,
          urgency: "critical" as const,
        };

    // Player-facing info: time, count, power assessment
    const timeStr = c.tCollapse === Infinity
      ? `${c.tArrive}秒到达`
      : `${c.tArrive}秒到达 (阵地预计${c.tCollapse}秒后失守)`;
    const powerStr = c.currentPowerRatio < Infinity && c.newPowerRatio < Infinity
      ? `战力比 ${c.currentPowerRatio.toFixed(1)} → ${c.newPowerRatio.toFixed(1)}`
      : "";
    const label = assessmentLabel[c.assessment];

    // Risk/reward based on assessment
    const risk = c.assessment === "insufficient" ? 0.85 :
                 c.assessment === "delaying" ? 0.6 : 0.4;
    const reward = c.assessment === "decisive" ? 0.95 :
                   c.assessment === "delaying" ? 0.65 : 0.3;

    // Description lines
    let desc = `调${c.leaderName}支援${front?.name ?? crisis.locationTag}`;
    desc += `\n${c.aliveCount}人, ${timeStr}`;
    if (powerStr) desc += `\n→ ${powerStr} ${label}`;
    else desc += `\n→ ${label}`;

    // Late-arrival warning
    if (c.tCollapse !== Infinity && c.tArrive > c.tCollapse) {
      desc += `\n⚠ 预计到达时阵地已失守，仅能牵制或反攻`;
    }

    options.push({
      label: `${letter}: 调${c.leaderName}增援`,
      description: desc,
      risk,
      reward,
      intent: reinforceIntent,
      intents: [reinforceIntent],
    });
  }

  return options;
}
