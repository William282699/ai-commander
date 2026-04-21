// ============================================================
// AI Commander — Auto-Behavior System (Day 8)
// Team-agnostic micro-level unit autonomy (2s interval)
// Directly mutates unit state (no Order[] generation).
//
// FIXED priority order (top-down short-circuit):
//   1. player-controlled guard — ABSOLUTE, no exceptions
//   2. lowHP emergency retreat (hp < 25%, overrides C1 active-orders)
//   3. active orders skip (unit.orders.length > 0 is PRIMARY check)
//   4. engage / patrol
//
// Constraints enforced: C1, C2, C3, C4, C5
// ============================================================

import type { GameState, Unit, Position, Team, PatrolTask } from "@ai-commander/shared";
import { getUnitCategory, isManualOnlyUnit } from "@ai-commander/shared";
import { canUnitEnterTile } from "./sim";
import { clearPathCache } from "./pathfinding";

// ── Timer (C2: while-loop, no setInterval) ──

const AUTO_BEHAVIOR_INTERVAL = 2.0; // seconds
let autoBehaviorTimer = 0;

/** Reset module-level timer — call on new game session. */
export function resetAutoBehaviorTimer(): void {
  autoBehaviorTimer = 0;
}

const LOW_HP_THRESHOLD = 0.25;   // 25% maxHP
const ENGAGE_RANGE = 8;          // tiles
// PATROL_RANGE removed (Day 9.5 Batch A: idle auto-patrol disabled)

const RECENTLY_DAMAGED_WINDOW = 3.0;  // seconds — "recently damaged" for chase response
const ALLY_ASSIST_RANGE = 15;          // tiles — scan radius for fighting allies (non-defending units)
// Defending units use a tighter assist radius — they must stay within cluster
// cohesion of their defensive posture. A 15-tile scan would pull a HQ defender
// halfway across the map to help a front-line squad, breaking the defensive line.
// 12 tiles tuned from 8 based on playtest: 8 left far-side defenders in a ~5-tile
// wide cluster out of reach when the fight was at the near edge; 12 pulls the
// whole cluster in without scatter.
const DEFENDING_ASSIST_RANGE = 12;     // tiles — assist radius when state="defending"

// ── Main entry ──

export function processAutoBehavior(state: GameState, dt: number): void {
  if (state.gameOver) return;
  autoBehaviorTimer += dt;

  // C2: while-loop prevents timer drift on frame drops
  while (autoBehaviorTimer >= AUTO_BEHAVIOR_INTERVAL) {
    autoBehaviorTimer -= AUTO_BEHAVIOR_INTERVAL;
    runAutoBehavior(state);
    processPatrolTasks(state); // Day 9.5 Batch B: task-level re-targeting
  }
}

function runAutoBehavior(state: GameState): void {
  state.units.forEach((unit) => {
    if (unit.hp <= 0 || unit.state === "dead") return;

    // ── Priority 1: player-controlled guard (ABSOLUTE, no exceptions) ──
    if (unit.team === "player" && (unit.manualOverride || isManualOnlyUnit(unit))) return;

    // ── Priority 2: lowHP emergency retreat ──
    // Overrides C1 (active orders), but NOT player-controlled units (already filtered above)
    if (unit.hp / unit.maxHp < LOW_HP_THRESHOLD && unit.state !== "retreating") {
      const hqPos = findTeamHQ(state, unit.team);
      const dx = hqPos.x - unit.position.x;
      const dy = hqPos.y - unit.position.y;
      const dist = Math.sqrt(dx * dx + dy * dy);

      // Already near HQ? Don't retreat further
      if (dist < 5) return;

      const retreatDist = Math.min(15, dist * 0.5);
      let target: Position;
      if (dist < 1) {
        target = { ...hqPos };
      } else {
        target = {
          x: Math.round(unit.position.x + (dx / dist) * retreatDist),
          y: Math.round(unit.position.y + (dy / dist) * retreatDist),
        };
      }

      // C3: clamp to map bounds
      target.x = Math.max(0, Math.min(state.mapWidth - 1, target.x));
      target.y = Math.max(0, Math.min(state.mapHeight - 1, target.y));

      // Passability check
      if (!canUnitEnterTile(unit.type, target.x, target.y, state)) {
        const safe = findPassableNearby(unit, target, state);
        if (!safe) return; // Can't find safe retreat point, stay put
        target = safe;
      }

      // Direct state mutation (micro-level, no Order[])
      unit.state = "retreating";
      clearPathCache(unit.id);
      unit.target = target;
      unit.waypoints = [target];
      unit.attackTarget = null;
      return; // Short-circuit
    }

    // ── Priority 3: active orders skip (C1 PRIMARY check) ──
    // unit.orders.length > 0 is the primary check.
    // State checks are advisory only, never override C1/C5.
    //
    // EXCEPTION: a persistent `defend` order means "hold this zone," not
    // "ignore the zone being attacked." Defending units fall through to
    // 4a/4b/4c so they can engage incoming threats and assist neighbors.
    // combat.ts sends them back to their defend post when the engagement
    // ends — see the `defend` branch in the no-target block of processCombat.
    const currentAction = unit.orders[0]?.action;
    const inDefendPosture = unit.orders.length > 0 && currentAction === "defend";
    if (unit.orders.length > 0 && !inDefendPosture) return;

    // ── Priority 4: engage / patrol ──

    // 4a: Auto-engage — idle/patrolling/defending unit with enemy in range
    if (unit.state === "idle" || unit.state === "patrolling" || unit.state === "defending") {
      const enemy = findNearestEnemy(unit, state, ENGAGE_RANGE);
      if (enemy) {
        unit.state = "moving";
        clearPathCache(unit.id);
        unit.target = { x: enemy.position.x, y: enemy.position.y };
        unit.waypoints = [{ x: enemy.position.x, y: enemy.position.y }];
        unit.attackTarget = null; // combat.ts will acquire target when in range
        return;
      }
    }

    // 4b: Chase outranging attacker — recently damaged idle unit closes distance
    if (unit.state === "idle" || unit.state === "defending") {
      const chaseTarget = findOutrangingAttacker(unit, state);
      if (chaseTarget) {
        unit.state = "moving";
        clearPathCache(unit.id);
        unit.target = { x: chaseTarget.position.x, y: chaseTarget.position.y };
        unit.waypoints = [{ x: chaseTarget.position.x, y: chaseTarget.position.y }];
        unit.attackTarget = null;
        return;
      }
    }

    // 4c: Assist nearby fighting ally — idle unit joins nearby combat
    if (unit.state === "idle" || unit.state === "defending") {
      // Narrow the assist radius when defending so the cluster doesn't
      // dissolve across the map chasing distant allies.
      const assistRange = unit.state === "defending" ? DEFENDING_ASSIST_RANGE : ALLY_ASSIST_RANGE;
      const allyTarget = findAllyBattleTarget(unit, state, assistRange);
      if (allyTarget) {
        unit.state = "moving";
        clearPathCache(unit.id);
        unit.target = { x: allyTarget.position.x, y: allyTarget.position.y };
        unit.waypoints = [{ x: allyTarget.position.x, y: allyTarget.position.y }];
        unit.attackTarget = null;
        return;
      }
    }

    // 4d: Idle patrol — DISABLED (Day 9.5 Batch A)
    // Idle units stay idle until player issues a patrol command.
    // PatrolTask system (Batch B) will replace this.
  });
}

// ── Helpers ──

/**
 * Find nearest enemy unit within maxRange tiles.
 * For player units, only finds enemies visible in fog.
 * For enemy units, finds all player units (enemy has "omniscient" local awareness).
 */
function findNearestEnemy(unit: Unit, state: GameState, maxRange: number): Unit | null {
  let best: Unit | null = null;
  let bestDist = maxRange * maxRange; // Compare squared distances

  state.units.forEach((other) => {
    if (other.team === unit.team) return;
    if (other.hp <= 0 || other.state === "dead") return;

    // Player units can only engage visible enemies
    if (unit.team === "player") {
      const tx = Math.floor(other.position.x);
      const ty = Math.floor(other.position.y);
      if (state.fog[ty]?.[tx] !== "visible") return;
    }

    const dx = other.position.x - unit.position.x;
    const dy = other.position.y - unit.position.y;
    const d2 = dx * dx + dy * dy;

    if (d2 < bestDist) {
      bestDist = d2;
      best = other;
    }
  });

  return best;
}

/**
 * 4b helper: Chase outranging attacker.
 * If unit was recently damaged and is idle, find a visible enemy within
 * visionRange to close distance on. Prioritizes the unit that last attacked us.
 */
function findOutrangingAttacker(unit: Unit, state: GameState): Unit | null {
  const now = state.time;
  const lastDamaged = unit.lastDamagedAt ?? 0;
  if (now - lastDamaged > RECENTLY_DAMAGED_WINDOW) return null;

  // Helper: check if target is visible to this unit's team
  const isVisible = (target: Unit): boolean => {
    if (unit.team === "player") {
      const tx = Math.floor(target.position.x);
      const ty = Math.floor(target.position.y);
      return state.fog[ty]?.[tx] === "visible";
    }
    return true; // enemy has local omniscience (consistent with findNearestEnemy)
  };

  // First: try the specific attacker that hit us
  if (unit.lastDamagedById !== undefined) {
    const attacker = state.units.get(unit.lastDamagedById);
    if (attacker && attacker.hp > 0 && attacker.state !== "dead"
        && attacker.team !== unit.team && isVisible(attacker)) {
      const dx = attacker.position.x - unit.position.x;
      const dy = attacker.position.y - unit.position.y;
      const dist2 = dx * dx + dy * dy;
      if (dist2 <= unit.visionRange * unit.visionRange) {
        return attacker;
      }
    }
  }

  // Fallback: nearest visible enemy within visionRange but beyond attackRange
  let best: Unit | null = null;
  let bestDist = unit.visionRange * unit.visionRange;

  state.units.forEach((other) => {
    if (other.team === unit.team) return;
    if (other.hp <= 0 || other.state === "dead") return;
    if (!isVisible(other)) return;

    const dx = other.position.x - unit.position.x;
    const dy = other.position.y - unit.position.y;
    const d2 = dx * dx + dy * dy;

    // Only targets beyond attackRange (within-range handled by 4a/findTarget)
    if (d2 <= unit.attackRange * unit.attackRange) return;
    if (d2 < bestDist) {
      bestDist = d2;
      best = other;
    }
  });

  return best;
}

/**
 * 4c helper: Find enemy to engage near a fighting ally.
 * Scans for friendly units within ALLY_ASSIST_RANGE in "attacking" state,
 * then returns their attack target if visible to this unit.
 */
function findAllyBattleTarget(
  unit: Unit,
  state: GameState,
  maxRange: number = ALLY_ASSIST_RANGE,
): Unit | null {
  let bestAllyDist = maxRange * maxRange;
  let bestEnemy: Unit | null = null;

  state.units.forEach((ally) => {
    if (ally.id === unit.id) return;
    if (ally.team !== unit.team) return;
    if (ally.hp <= 0 || ally.state === "dead") return;
    if (ally.state !== "attacking") return;

    // Is ally within assist range?
    const adx = ally.position.x - unit.position.x;
    const ady = ally.position.y - unit.position.y;
    const allyDist2 = adx * adx + ady * ady;
    if (allyDist2 > maxRange * maxRange) return;

    // Find ally's combat target
    if (ally.attackTarget === null) return;
    const allyEnemy = state.units.get(ally.attackTarget);
    if (!allyEnemy || allyEnemy.hp <= 0 || allyEnemy.state === "dead") return;
    if (allyEnemy.team === unit.team) return;

    // Visibility check — consistent with findNearestEnemy
    if (unit.team === "player") {
      const tx = Math.floor(allyEnemy.position.x);
      const ty = Math.floor(allyEnemy.position.y);
      if (state.fog[ty]?.[tx] !== "visible") return;
    }

    // Prefer closest fighting ally's target
    if (allyDist2 < bestAllyDist) {
      bestAllyDist = allyDist2;
      bestEnemy = allyEnemy;
    }
  });

  return bestEnemy;
}

/**
 * Find team HQ position.
 * C4: safe fallback if HQ facility not found.
 * Player fallback: (5, 5). Enemy fallback: (mapWidth-5, mapHeight-5).
 */
function findTeamHQ(state: GameState, team: Team): Position {
  for (const [, fac] of state.facilities) {
    if (fac.type === "headquarters" && fac.team === team) {
      return { x: fac.position.x, y: fac.position.y };
    }
  }

  // C4 fallback
  if (team === "player") {
    return { x: 5, y: 5 };
  }
  return { x: state.mapWidth - 5, y: state.mapHeight - 5 };
}

/**
 * Find passable tile near target via spiral search. Max 8 tiles radius.
 * C3: clamp + canUnitEnterTile. Returns null if nothing found.
 */
function findPassableNearby(unit: Unit, target: Position, state: GameState): Position | null {
  for (let r = 1; r <= 8; r++) {
    for (let dx = -r; dx <= r; dx++) {
      for (let dy = -r; dy <= r; dy++) {
        if (Math.abs(dx) !== r && Math.abs(dy) !== r) continue;
        const x = Math.max(0, Math.min(state.mapWidth - 1, target.x + dx));
        const y = Math.max(0, Math.min(state.mapHeight - 1, target.y + dy));
        if (canUnitEnterTile(unit.type, x, y, state)) {
          return { x, y };
        }
      }
    }
  }
  return null;
}

// ============================================================
// Day 9.5 Batch B — PatrolTask System
// Single patrol controller: fog-frontier targeting, silent retry
// ============================================================

const PATROL_TASK_DEFAULT_COOLDOWN = 6; // seconds between re-targeting

/** Process all PatrolTasks: prune, cooldown, re-target idle units. */
function processPatrolTasks(state: GameState): void {
  // Build a map of unit → highest task id for dedup guard
  const unitHighestTask = new Map<number, number>();
  for (const task of state.patrolTasks) {
    for (const uid of task.unitIds) {
      const prev = unitHighestTask.get(uid);
      if (prev === undefined || task.id > prev) {
        unitHighestTask.set(uid, task.id);
      }
    }
  }

  for (let i = state.patrolTasks.length - 1; i >= 0; i--) {
    const task = state.patrolTasks[i];

    // 1. Prune dead/invalid/reassigned units
    task.unitIds = task.unitIds.filter((uid) => {
      const u = state.units.get(uid);
      if (!u || u.state === "dead") return false;
      if (u.team !== "player") return false;
      if (u.manualOverride || isManualOnlyUnit(u)) return false;
      if (u.patrolTaskId !== task.id) return false;
      // Dedup: if this unit is in a newer task, remove from this one
      if (unitHighestTask.get(uid) !== task.id) {
        return false;
      }
      // If unit has active non-patrol orders, detach it
      if (u.orders.length > 0 && u.orders[0].action !== "patrol") {
        u.patrolTaskId = null;
        return false;
      }
      return true;
    });

    // Remove empty tasks
    if (task.unitIds.length === 0) {
      state.patrolTasks.splice(i, 1);
      continue;
    }

    // 2. Cooldown check
    if (task.paused && state.time < task.pauseUntil) continue;
    if (task.paused) {
      task.paused = false;
      task.consecutiveFails = 0;
    }
    if (state.time - task.lastTargetTime < task.cooldownSec) continue;

    // 3. Re-target idle units in this task
    let anySuccess = false;
    for (const uid of task.unitIds) {
      const unit = state.units.get(uid);
      if (!unit) continue;
      if (unit.state !== "idle") continue; // still moving to previous target

      const target = selectPatrolTarget(unit, task, state);
      if (target) {
        unit.state = "patrolling";
        unit.patrolPoints = [{ ...unit.position }, target];
        clearPathCache(unit.id);
        unit.target = target;
        unit.waypoints = [target];
        anySuccess = true;
      }
      // Silent retry: no diagnostic push on failure
    }

    task.lastTargetTime = state.time;

    if (!anySuccess) {
      task.consecutiveFails++;
      // Cooldown escalation: 3+ consecutive fails → pause
      if (task.consecutiveFails >= 3) {
        task.paused = true;
        task.pauseUntil = state.time + Math.min(30, 10 * task.consecutiveFails);
      }
    } else {
      task.consecutiveFails = 0;
    }
  }

  // Emit patrol summary every 30s
  emitPatrolSummary(state);
}

// ── Patrol summary (every 30s) ──

const PATROL_SUMMARY_INTERVAL = 30; // seconds
let lastPatrolSummaryTime = 0;

function emitPatrolSummary(state: GameState): void {
  if (state.time - lastPatrolSummaryTime < PATROL_SUMMARY_INTERVAL) return;
  lastPatrolSummaryTime = state.time;

  if (state.patrolTasks.length === 0) return;

  let activeUnits = 0;
  let pausedTasks = 0;
  for (const task of state.patrolTasks) {
    activeUnits += task.unitIds.length;
    if (task.paused) pausedTasks++;
  }

  if (activeUnits === 0) return;

  let msg = `巡逻: ${activeUnits}个单位执行中`;
  if (pausedTasks > 0) {
    msg += `, ${pausedTasks}个任务暂停`;
  }

  // Use dedicated dedup — PATROL_SUMMARY only emits every 30s so no extra dedup needed
  state.diagnostics.push({ time: state.time, code: "PATROL_SUMMARY", message: msg });
  if (state.diagnostics.length > 50) state.diagnostics.shift();
}

// ── Fog frontier helpers ──

/** Find fog frontier tiles within radius of center. Returns unknown tiles adjacent to known tiles. */
function findFogFrontier(
  state: GameState,
  center: Position,
  radius: number,
  maxResults: number,
): Position[] {
  const { fog, mapWidth, mapHeight } = state;
  const results: Position[] = [];

  const cx = Math.floor(center.x);
  const cy = Math.floor(center.y);
  const xMin = Math.max(0, cx - radius);
  const xMax = Math.min(mapWidth - 1, cx + radius);
  const yMin = Math.max(0, cy - radius);
  const yMax = Math.min(mapHeight - 1, cy + radius);
  const rSq = radius * radius;

  for (let y = yMin; y <= yMax; y++) {
    for (let x = xMin; x <= xMax; x++) {
      if ((x - cx) * (x - cx) + (y - cy) * (y - cy) > rSq) continue;
      if (fog[y][x] !== "unknown") continue;

      // Must be adjacent to explored/visible
      const hasKnown =
        (y > 0 && fog[y - 1][x] !== "unknown") ||
        (y < mapHeight - 1 && fog[y + 1][x] !== "unknown") ||
        (x > 0 && fog[y][x - 1] !== "unknown") ||
        (x < mapWidth - 1 && fog[y][x + 1] !== "unknown");

      if (!hasKnown) continue;
      results.push({ x, y });
      if (results.length >= maxResults) return results;
    }
  }
  return results;
}

/** Find a passable explored tile adjacent to a frontier tile, suitable for the unit. */
function findPassableNeighborOfFrontier(
  frontier: Position,
  unit: Unit,
  state: GameState,
): Position | null {
  const neighbors = [
    { x: frontier.x, y: frontier.y - 1 },
    { x: frontier.x, y: frontier.y + 1 },
    { x: frontier.x - 1, y: frontier.y },
    { x: frontier.x + 1, y: frontier.y },
  ];

  for (const n of neighbors) {
    if (n.x < 0 || n.x >= state.mapWidth || n.y < 0 || n.y >= state.mapHeight) continue;
    if (state.fog[n.y][n.x] === "unknown") continue;
    if (canUnitEnterTile(unit.type, n.x, n.y, state)) return n;
  }
  return null;
}

/** Select a patrol target for a unit within a task's area. Prefers fog frontier. */
function selectPatrolTarget(
  unit: Unit,
  task: PatrolTask,
  state: GameState,
): Position | null {
  const frontier = findFogFrontier(state, task.center, task.radius, 40);

  if (frontier.length > 0) {
    // Find passable known-side neighbors for frontier tiles
    const candidates: Position[] = [];
    for (const ft of frontier) {
      const neighbor = findPassableNeighborOfFrontier(ft, unit, state);
      if (neighbor) candidates.push(neighbor);
    }

    if (candidates.length > 0) {
      // Sort by distance to unit, pick randomly from closest 5
      candidates.sort((a, b) => {
        const da = (a.x - unit.position.x) ** 2 + (a.y - unit.position.y) ** 2;
        const db = (b.x - unit.position.x) ** 2 + (b.y - unit.position.y) ** 2;
        return da - db;
      });
      const topN = Math.min(5, candidates.length);
      return candidates[Math.floor(Math.random() * topN)];
    }
  }

  // Fallback: random passable point within radius (frontier exhausted)
  return randomPassableInRadius(unit, task.center, task.radius, state);
}

/** Fallback: random passable tile within radius (when frontier is exhausted). */
function randomPassableInRadius(
  unit: Unit,
  center: Position,
  radius: number,
  state: GameState,
): Position | null {
  for (let attempt = 0; attempt < 10; attempt++) {
    const angle = Math.random() * 2 * Math.PI;
    const dist = Math.random() * radius;
    const x = Math.round(center.x + Math.cos(angle) * dist);
    const y = Math.round(center.y + Math.sin(angle) * dist);

    if (x < 0 || x >= state.mapWidth || y < 0 || y >= state.mapHeight) continue;
    if (x === Math.round(unit.position.x) && y === Math.round(unit.position.y)) continue;
    if (canUnitEnterTile(unit.type, x, y, state)) return { x, y };
  }
  return null;
}
