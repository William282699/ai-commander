// ============================================================
// AI Commander — Task Tracker Engine (Prompt 3)
// Updates TaskCard statuses based on unit states each tick.
// Pure functions operating on GameState.
// ============================================================

import type { GameState, TaskCard, Squad } from "@ai-commander/shared";
import { collectUnitsUnder, resolveSquadRef } from "@ai-commander/shared";

const CLEANUP_DELAY_SEC = 30;
const HOLD_COMPLETE_SEC = 15;
// Tasks whose assigned units are all dead/missing land in "failing" state. Without
// a terminating condition they sit there forever — the failing squad can't
// recover, but "failing" is not eligible for cleanup. Grace period lets the
// state breathe (maybe reinforcements arrive) before we force-terminate.
const FAIL_GRACE_SEC = 20;

/**
 * Compute a numeric priority score for sorting.
 * Higher = more urgent.
 */
export function computeTaskPriority(task: TaskCard, state: GameState): number {
  // Base from priority level
  const BASE: Record<string, number> = { low: 1, normal: 2, high: 3, critical: 4 };
  let score = BASE[task.priority] ?? 2;

  // Urgency bonus from status
  if (task.status === "failing") {
    score += 3;
  } else if (task.status === "engaged") {
    score += 1;
    // Extra +1 if front is at disadvantage
    if (task.assignedSquads.length > 0) {
      for (const front of state.fronts) {
        if (front.enemyPowerKnown && front.playerPower > 0) {
          const ratio = front.enemyPower / front.playerPower;
          if (ratio > 1.5) {
            score += 1;
            break;
          }
        }
      }
    }
  }

  // Doctrine bonus
  if (task.constraint === "must_hold") score += 2;
  if (task.priority === "critical") score += 1;

  return score;
}

/**
 * Update all active tasks based on current unit states.
 * Called each tick from the game loop.
 */
export function updateTasks(state: GameState): void {
  // Update statuses of active tasks
  for (const task of state.tasks) {
    if (task.status === "completed" || task.status === "cancelled") continue;

    // Economy tasks (produce/trade) are fire-and-forget: mark holding immediately,
    // they stay visible until the production queue completes or cleanup runs.
    if (task.kind === "economy") {
      if (task.status === "assigned") {
        task.status = "holding";
        task.statusChangedAt = state.time;
      }
      // Economy tasks auto-complete after hold timer (no squad tracking needed)
      if (task.status === "holding" &&
          state.time - task.statusChangedAt >= HOLD_COMPLETE_SEC) {
        task.status = "completed";
        task.statusChangedAt = state.time;
      }
      continue;
    }

    // Combat tasks — track via assigned squads/units. assignedSquads entries
    // may be squad IDs, leader names, or commander keys (see resolveSquadRef
    // above). Walk each ref to its actual Squad objects before collecting
    // units, otherwise a leader-name ref returns zero units and the task
    // looks squadless even though it has a real (possibly KIA) squad behind it.
    const aliveUnitIds: number[] = [];
    const resolvedSquads: Squad[] = [];
    for (const ref of task.assignedSquads) {
      for (const sq of resolveSquadRef(state, ref)) {
        resolvedSquads.push(sq);
        const unitIds = collectUnitsUnder(state, sq.id);
        for (const id of unitIds) {
          const u = state.units.get(id);
          if (u && u.team === "player" && u.state !== "dead") {
            aliveUnitIds.push(id);
          }
        }
      }
    }

    // Determine new status from unit states
    let newStatus = task.status;

    const hasResolvedSquad = resolvedSquads.length > 0;

    if (task.assignedSquads.length === 0 || !hasResolvedSquad) {
      // Squadless combat task — units were assigned but not via squads
      if (task.status === "assigned") {
        task.status = "holding";
        task.statusChangedAt = state.time;
      }
      if (task.status === "holding" && !task.constraint &&
          state.time - task.statusChangedAt >= HOLD_COMPLETE_SEC) {
        task.status = "completed";
        task.statusChangedAt = state.time;
      }
      continue;
    } else if (aliveUnitIds.length === 0) {
      newStatus = "failing";
    } else {
      let hasAttacking = false;
      let hasMoving = false;

      for (const id of aliveUnitIds) {
        const u = state.units.get(id);
        if (!u) continue;
        if (u.state === "attacking") hasAttacking = true;
        if (u.state === "moving") hasMoving = true;
      }

      if (hasAttacking) {
        newStatus = "engaged";
      } else if (hasMoving) {
        newStatus = "moving";
      } else {
        newStatus = "holding";
      }
    }

    if (newStatus !== task.status) {
      task.status = newStatus;
      task.statusChangedAt = state.time;
    }

    // Complete task if holding idle long enough (no doctrine constraint)
    if (task.status === "holding" && !task.constraint &&
        state.time - task.statusChangedAt >= HOLD_COMPLETE_SEC) {
      task.status = "completed";
      task.statusChangedAt = state.time;
    }

    // Terminate tasks stuck in "failing" — all assigned units are dead or
    // retreated, and the doctrine/order can't be rescued from this state.
    // Transition to "cancelled" so the existing cleanup filter can drop it
    // instead of letting it hang in the UI forever.
    if (task.status === "failing" &&
        state.time - task.statusChangedAt >= FAIL_GRACE_SEC) {
      task.status = "cancelled";
      task.statusChangedAt = state.time;
    }
  }

  // Cleanup old completed/cancelled tasks
  state.tasks = state.tasks.filter((t) => {
    if (t.status !== "completed" && t.status !== "cancelled") return true;
    return state.time - t.statusChangedAt <= CLEANUP_DELAY_SEC;
  });

  // Sort by computed priority (descending)
  state.tasks.sort((a, b) => computeTaskPriority(b, state) - computeTaskPriority(a, state));
}
