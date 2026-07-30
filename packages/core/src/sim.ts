// ============================================================
// AI Commander — Simulation Tick (游戏主循环)
// Pure function: tick(state, dt) → mutates state
// ============================================================

import type { GameState, Unit, OrderAction } from "@ai-commander/shared";
import {
  TERRAIN_MOVE_MULT,
  getUnitCategory,
  isFootUnit,
} from "@ai-commander/shared";
import { canUnitEnterTile } from "./movementRules";
export { canUnitEnterTile };
import { processCombat } from "./combat";
import { processRegen } from "./regen";
import { canUnitMove, consumeMovementFuel } from "./economy";
import { getOrComputePath, advancePath, clearPathCache } from "./pathfinding";

// Actions that complete when the unit reaches its target (vs defend/hold/patrol which persist)
// NOTE: "sabotage" removed in Day 11 — sabotage orders persist so combat can damage facilities
const ONE_SHOT_ACTIONS: readonly OrderAction[] = [
  "attack_move", "retreat", "recon", "escort", "flank",
];

/** Diagnostic dedup: minimum seconds between identical code pushes. */
const DIAG_DEDUP_SEC = 5;

/** Low-value diagnostics use a longer dedup window to avoid array pollution. */
const DIAG_LOW_VALUE_DEDUP_SEC = 30;
const LOW_VALUE_DIAG_CODES = new Set(["PATH_BLOCKED", "IMPASSABLE_TERRAIN", "NO_FUEL"]);

function pushDiagnostic(state: GameState, code: string, message: string): void {
  const dedupSec = LOW_VALUE_DIAG_CODES.has(code) ? DIAG_LOW_VALUE_DEDUP_SEC : DIAG_DEDUP_SEC;
  const recent = state.diagnostics;
  for (let i = recent.length - 1; i >= 0; i--) {
    if (recent[i].code === code && state.time - recent[i].time < dedupSec) return;
    if (state.time - recent[i].time >= dedupSec) break;
  }
  state.diagnostics.push({ time: state.time, code, message });
  if (state.diagnostics.length > 50) state.diagnostics.shift();
}

/** Clear unit.orders if the current action is a one-shot (completed or failed). */
function clearOneShotOrders(unit: Unit): void {
  const action = unit.orders[0]?.action;
  if (action && (ONE_SHOT_ACTIONS as readonly string[]).includes(action)) {
    unit.orders = [];
  }
}

/** Grace period: dead units stay for 1 frame so explosion effects can reference position */
const DEAD_CLEANUP_DELAY = 0.1; // seconds
// MAX_CONSECUTIVE_DETOURS removed — A* pathfinding handles obstacle avoidance

/**
 * Advance game state by dt seconds.
 * Called ~60 times/sec from the game loop.
 */
export function tick(state: GameState, dt: number): void {
  if (state.gameOver) return;

  state.time += dt;
  state.tick++;

  // 1. Move units toward their targets (skip units that are attacking in place)
  state.units.forEach((unit) => {
    if (unit.hp <= 0) {
      unit.state = "dead";
      return;
    }
    if (
      unit.state === "moving" ||
      unit.state === "retreating" ||
      unit.state === "patrolling" ||
      (unit.state === "defending" && unit.target !== null)
    ) {
      moveUnit(unit, dt, state);
    }
  });

  // 2. Combat: auto-target, fire, apply damage, create effects
  processCombat(state, dt);

  // 2.5. Regen: commander HP regen + HQ repair (after combat)
  processRegen(state, dt);

  // 2.6. Entrench timer: foot infantry in defend state accumulate trench level
  state.units.forEach((unit) => {
    if (unit.hp <= 0 || unit.state === "dead") return;
    // Only foot-infantry (infantry / commander / elite_guard) can entrench —
    // vehicles and aircraft have no dug-in animation and gain no trench bonus.
    if (!isFootUnit(unit.type)) return;

    if (unit.state === "defending" && unit.target === null) {
      // Stationary defending — accumulate entrench time
      const prev = state.entrenchTimers.get(unit.id) ?? 0;
      const next = prev + dt;
      state.entrenchTimers.set(unit.id, next);

      if (next >= 15) {
        unit.entrenchLevel = 2;
      } else if (next >= 5) {
        unit.entrenchLevel = 1;
      }
    } else {
      // Moving or not defending — reset
      if (unit.entrenchLevel && unit.entrenchLevel > 0) {
        unit.entrenchLevel = 0;
        state.entrenchTimers.delete(unit.id);
      }
    }
  });

  // 3. Remove dead units (after a short grace period for effects)
  const deadIds: number[] = [];
  state.units.forEach((unit) => {
    if (unit.state === "dead" && unit.hp <= 0) {
      deadIds.push(unit.id);
    }
  });
  for (const id of deadIds) {
    state.units.delete(id);
    state.entrenchTimers.delete(id);
  }
}

function moveUnit(unit: Unit, dt: number, state: GameState): void {
  // Fuel gate
  if (!canUnitMove(unit, state)) {
    clearOneShotOrders(unit);
    if (unit.team === "player") {
      // Include fuel reading + order context so the player can instantly
      // diagnose "是油不够还是卡住了" without inspecting state.
      const fuel = state.economy.player.resources.fuel;
      const hadOrder = unit.orders[0]?.action ?? "none";
      const tx = unit.target?.x?.toFixed(0) ?? "-";
      const ty = unit.target?.y?.toFixed(0) ?? "-";
      pushDiagnostic(
        state,
        "NO_FUEL",
        `⛽ ${unit.type}#${unit.id} 燃油耗尽 (库存${fuel.toFixed(0)}) — ${hadOrder}→(${tx},${ty}) 中止`,
      );
    }
    return;
  }

  // Track locked attack target — sync movement to enemy position
  if (unit.attackTarget !== null) {
    if (unit.state === "retreating") {
      // Retreat semantics: never chase lock-targets.
      unit.attackTarget = null;
    } else {
      const tracked = state.units.get(unit.attackTarget);
      if (tracked && tracked.hp > 0 && tracked.state !== "dead" && tracked.team !== unit.team) {
        const newTarget = { ...tracked.position };
        if (unit.target && (Math.abs(unit.target.x - newTarget.x) > 2 || Math.abs(unit.target.y - newTarget.y) > 2)) {
          clearPathCache(unit.id);
        }
        unit.target = newTarget;
        if (unit.waypoints.length > 0) {
          unit.waypoints[0] = unit.target;
        } else {
          unit.waypoints = [unit.target];
        }
      } else {
        unit.attackTarget = null;
      }
    }
  }

  if (!unit.target) return;

  // ── Resolve next move point via A* ──
  let moveTarget: { x: number; y: number };

  // Try cached A* path first
  const nextAstarWp = advancePath(unit.id, unit.position.x, unit.position.y);
  if (nextAstarWp) {
    moveTarget = nextAstarWp;
  } else {
    // Compute new A* path
    const path = getOrComputePath(
      unit.id, unit.position.x, unit.position.y,
      unit.target.x, unit.target.y, unit.type, state,
    );
    if (path && path.length > 0) {
      moveTarget = path[0];
    } else {
      // Fallback: direct move for very short distances
      const directDist = Math.abs(unit.target.x - unit.position.x) + Math.abs(unit.target.y - unit.position.y);
      const tx = Math.floor(unit.target.x);
      const ty = Math.floor(unit.target.y);
      if (directDist < 3 && canUnitEnterTile(unit.type, tx, ty, state)) {
        moveTarget = unit.target;
      } else {
        const posInfo = `pos(${unit.position.x.toFixed(1)},${unit.position.y.toFixed(1)})`;
        const tgtInfo = `tgt(${unit.target.x.toFixed(1)},${unit.target.y.toFixed(1)})`;
        const tgtTerrain = (ty >= 0 && ty < state.mapHeight && tx >= 0 && tx < state.mapWidth)
          ? state.terrain[ty][tx] : "OOB";
        const canEnter = canUnitEnterTile(unit.type, tx, ty, state);
        const wpInfo = `wps=${unit.waypoints.length}`;
        pushDiagnostic(state, "PATH_BLOCKED",
          `${unit.type}#${unit.id} A*失败 ${posInfo} → ${tgtInfo} terrain=${tgtTerrain} canEnter=${canEnter} dist=${directDist.toFixed(1)} ${wpInfo}`);
        unit.target = null;
        unit.waypoints = [];
        unit.state = "idle";
        clearOneShotOrders(unit);
        clearPathCache(unit.id);
        return;
      }
    }
  }

  // ── Check arrival ──
  const dx = moveTarget.x - unit.position.x;
  const dy = moveTarget.y - unit.position.y;
  const dist = Math.sqrt(dx * dx + dy * dy);

  if (dist < 0.1) {
    // Arrived at A* waypoint — check if also at unit.target
    unit.position = { ...moveTarget };
    const tdx = unit.target.x - unit.position.x;
    const tdy = unit.target.y - unit.position.y;
    if (tdx * tdx + tdy * tdy >= 0.36) {
      return; // reached A* waypoint but not unit.target yet — next frame continues
    }

    // ── Arrived at unit.target ──
    unit.position = { ...unit.target };
    clearPathCache(unit.id);

    if (unit.state === "patrolling" && unit.patrolPoints.length >= 2) {
      if (unit.patrolTaskId !== null) {
        unit.target = null;
        unit.patrolPoints = [];
        unit.state = "idle";
      } else {
        unit.patrolPoints.reverse();
        unit.target = unit.patrolPoints[1];
      }
    } else if (unit.waypoints.length > 1) {
      unit.waypoints.shift();
      unit.target = unit.waypoints[0];
      clearPathCache(unit.id);
    } else {
      unit.target = null;
      unit.waypoints = [];
      if (unit.state === "defending") {
        // Stay defending
      } else if (
        unit.state === "retreating" &&
        unit.team === "player" &&
        unit.orders[0]?.action === "retreat"
      ) {
        // retreat-semantics-v1 修法2: an arrived retreat HOLDS its landing
        // point instead of falling to idle — idle gets flipped to attacking
        // by auto-engage (combat.ts) and the unit walks straight back into
        // the fight it just left. The one-shot retreat order becomes a
        // persistent defend order anchored here, so the existing defend
        // machinery applies unchanged: fight back in range, return to post
        // when the engagement ends, never chase. Gated to PLAYER units
        // carrying a real retreat ORDER — enemy retreats (enemyAI re-tasks
        // from idle) and autoBehavior's stateful order-less retreats keep
        // their legacy idle landing.
        unit.state = "defending";
        unit.orders = [{
          unitIds: [unit.id],
          action: "defend",
          target: { ...unit.position },
          priority: unit.orders[0].priority,
        }];
      } else if (
        unit.team === "player" &&
        unit.orders[0]?.action === "attack_move" &&
        unit.orders[0]?.targetFacilityId != null
      ) {
        // capture-stall-feedback-v1 刀B: a unit sent to TAKE a facility treats
        // that circle as its post. Without this it lands `idle` with its orders
        // cleared (attack_move ∈ ONE_SHOT_ACTIONS) — and an order-less idle unit
        // is exactly what autoBehavior 4a/4b/4c is allowed to drag away (P3 only
        // shields units still carrying an order). It then stops wherever the
        // firefight ended: the capture radius is 1.5 tiles and the chase leash
        // only pulls back beyond 12, so the gap is never closed. Measured on the
        // unfixed engine: after a successful capture the post sits empty for
        // 27-36s at a stretch (29-66% of the window) and nothing ever says so.
        //
        // Same已证 machinery as retreat-semantics-v1 修法2 above: the one-shot
        // capture order becomes a PERSISTENT defend order anchored at the landing
        // point, so combat.ts:209-217 walks the unit back to the circle every
        // time an engagement ends. Whole-array replacement, never an in-place
        // field edit: applyOrders.ts:439 stores ONE shared Order object across the
        // group, so mutating orders[0] would splash onto every unit in it.
        //
        // The new defend order deliberately does NOT carry targetFacilityId:
        // autoBehavior.ts:377 (isThreatInAction) reads that field on the OTHER
        // side's units, and today the post-arrival unit has no orders at all —
        // keeping the field absent leaves the enemy reaction path reading a
        // falsy value in both worlds, i.e. zero behavioural fork.
        //
        // Gate is action+field, not unit.state: `attack_move + targetFacilityId`
        // is written only by the capture flow (planCapture tacticalPlanner:1262
        // and the facility context menu); the two sabotage writers use
        // action "sabotage", and enemyAI writes the field nowhere. The team
        // check backstops both.
        unit.state = "defending";
        unit.orders = [{
          unitIds: [unit.id],
          action: "defend",
          target: { ...unit.position },
          priority: unit.orders[0].priority,
        }];
      } else if (unit.state !== "patrolling") {
        unit.state = "idle";
        clearOneShotOrders(unit);
      }
    }
    return;
  }

  // ── Move toward A* waypoint ──
  const tileX = Math.floor(unit.position.x);
  const tileY = Math.floor(unit.position.y);
  let speedMult = 1.0;
  if (tileY >= 0 && tileY < state.mapHeight && tileX >= 0 && tileX < state.mapWidth) {
    const terrain = state.terrain[tileY][tileX];
    const cat = getUnitCategory(unit.type);
    speedMult = TERRAIN_MOVE_MULT[terrain]?.[cat] ?? 0;
  }

  if (speedMult <= 0) {
    clearPathCache(unit.id);
    unit.target = null;
    unit.waypoints = [];
    unit.state = "idle";
    clearOneShotOrders(unit);
    pushDiagnostic(state, "IMPASSABLE_TERRAIN", `${unit.type}#${unit.id} 当前地块不可通行，已停止`);
    return;
  }

  const speed = unit.moveSpeed * speedMult * dt;
  const step = Math.min(speed, dist);
  const nx = dx / dist;
  const ny = dy / dist;
  const newX = unit.position.x + nx * step;
  const newY = unit.position.y + ny * step;

  consumeMovementFuel(unit, Math.sqrt((newX - unit.position.x) ** 2 + (newY - unit.position.y) ** 2), state);
  unit.position.x = newX;
  unit.position.y = newY;
}
