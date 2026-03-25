// ============================================================
// AI Commander — Defensive AI for El Alamein
// Enemy holds positions, counterattacks when strongpoints fall
// ============================================================

import type { GameState, Unit, Position, Order, Facility } from "@ai-commander/shared";
import { getUnitCategory } from "@ai-commander/shared";
import { applyEnemyOrders } from "../../applyOrders";
import { canUnitEnterTile } from "../../sim";
import { enqueueProduction } from "../../economy";

const DEFENSIVE_AI_INTERVAL = 5.0;
let defensiveAITimer = 0;

export function resetDefensiveAITimer(): void {
  defensiveAITimer = 0;
}

export function processDefensiveAI(state: GameState, dt: number): void {
  if (state.gameOver) return;
  if (state.enemyAIMode !== "defensive") return;
  defensiveAITimer += dt;
  while (defensiveAITimer >= DEFENSIVE_AI_INTERVAL) {
    defensiveAITimer -= DEFENSIVE_AI_INTERVAL;
    runDefensiveAI(state);
  }
}

function runDefensiveAI(state: GameState): void {
  // 1. Check for lost strongpoints → counterattack
  counterattackLostStrongpoints(state);

  // 2. Reinforce weak strongpoints
  reinforceWeakStrongpoints(state);

  // 3. Defenders that are idle → defend at current position
  holdPositions(state);

  // 4. Production (biased toward infantry)
  defensiveProduction(state);
}

// ── Counterattack lost strongpoints ──

function counterattackLostStrongpoints(state: GameState): void {
  const objectives = state.captureObjectives ?? [];
  for (const objId of objectives) {
    const fac = state.facilities.get(objId);
    if (!fac) continue;
    // If objective was captured by player, send nearby reserves
    if (fac.team === "player") {
      const reserves = findNearbyEnemyUnits(state, fac.position, 80);
      if (reserves.length === 0) continue;

      // Send up to 6 units to counterattack
      const attackers = reserves.slice(0, Math.min(6, reserves.length));
      const orders: Order[] = [{
        unitIds: attackers.map(u => u.id),
        action: "attack_move",
        target: { x: fac.position.x, y: fac.position.y },
        priority: "high",
      }];
      applyEnemyOrders(state, orders);
    }
  }
}

// ── Reinforce weak strongpoints ──

function reinforceWeakStrongpoints(state: GameState): void {
  const objectives = state.captureObjectives ?? [];

  // Assess each enemy-held strongpoint
  const strongpoints: { fac: Facility; defenders: number }[] = [];
  for (const objId of objectives) {
    const fac = state.facilities.get(objId);
    if (!fac || fac.team !== "enemy") continue;
    const defenders = countNearbyEnemyUnits(state, fac.position, 15);
    strongpoints.push({ fac, defenders });
  }

  if (strongpoints.length < 2) return;

  // Sort: weakest first
  strongpoints.sort((a, b) => a.defenders - b.defenders);
  const weakest = strongpoints[0];
  const strongest = strongpoints[strongpoints.length - 1];

  // If imbalanced, transfer 1-2 units from strongest to weakest
  if (strongest.defenders - weakest.defenders >= 3) {
    const transferUnits = findNearbyEnemyUnits(state, strongest.fac.position, 15)
      .filter(u => u.state === "idle" || u.state === "defending" || u.state === "patrolling")
      .slice(0, 2);

    if (transferUnits.length > 0) {
      const orders: Order[] = [{
        unitIds: transferUnits.map(u => u.id),
        action: "attack_move",
        target: { x: weakest.fac.position.x, y: weakest.fac.position.y },
        priority: "medium",
      }];
      applyEnemyOrders(state, orders);
    }
  }
}

// ── Hold positions ──

function holdPositions(state: GameState): void {
  const orders: Order[] = [];
  state.units.forEach(u => {
    if (u.team !== "enemy" || u.state === "dead" || u.hp <= 0) return;
    if (getUnitCategory(u.type) !== "ground") return;
    if (u.state === "idle") {
      orders.push({
        unitIds: [u.id],
        action: "defend",
        target: null,
        priority: "low",
      });
    }
  });
  if (orders.length > 0) {
    applyEnemyOrders(state, orders);
  }
}

// ── Defensive production (70% infantry) ──

function defensiveProduction(state: GameState): void {
  if (state.productionQueue.enemy.length >= 4) return;
  const money = state.economy.enemy.resources.money;

  const roll = Math.random();
  if (roll < 0.7 && money >= 100) {
    enqueueProduction(state, "enemy", "infantry");
  } else if (roll < 0.9 && money >= 250) {
    enqueueProduction(state, "enemy", "light_tank");
  } else if (money >= 500) {
    enqueueProduction(state, "enemy", "main_tank");
  } else if (money >= 100) {
    enqueueProduction(state, "enemy", "infantry");
  }
}

// ── Helpers ──

function findNearbyEnemyUnits(state: GameState, pos: Position, radius: number): Unit[] {
  const units: Unit[] = [];
  state.units.forEach(u => {
    if (u.team !== "enemy" || u.state === "dead" || u.hp <= 0) return;
    if (getUnitCategory(u.type) !== "ground") return;
    const dx = u.position.x - pos.x;
    const dy = u.position.y - pos.y;
    if (dx * dx + dy * dy <= radius * radius) {
      units.push(u);
    }
  });
  // Sort by HP (strongest first)
  units.sort((a, b) => b.hp - a.hp);
  return units;
}

function countNearbyEnemyUnits(state: GameState, pos: Position, radius: number): number {
  let count = 0;
  state.units.forEach(u => {
    if (u.team !== "enemy" || u.state === "dead" || u.hp <= 0) return;
    if (getUnitCategory(u.type) !== "ground") return;
    const dx = u.position.x - pos.x;
    const dy = u.position.y - pos.y;
    if (dx * dx + dy * dy <= radius * radius) count++;
  });
  return count;
}
