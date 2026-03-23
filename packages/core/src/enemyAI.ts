// ============================================================
// AI Commander — Enemy Rule AI (Day 8)
// Every 5s: assess fronts → attack / defend / retreat / reinforce / patrol
// Strategic orders go through applyEnemyOrders (Order[]).
// Timer uses while-loop to prevent drift on frame drops (C2).
// ============================================================

import type { GameState, Unit, Front, Position, Order } from "@ai-commander/shared";
import { getUnitCategory } from "@ai-commander/shared";
import { applyEnemyOrders } from "./applyOrders";
import { canUnitEnterTile } from "./sim";
import { enqueueProduction } from "./economy";

// ── Timer (C2: while-loop, no setInterval) ──

const ENEMY_AI_INTERVAL = 5.0; // seconds
let enemyAITimer = 0;

/** Reset module-level timer — call on new game session. */
export function resetEnemyAITimer(): void {
  enemyAITimer = 0;
}

// ── Front assessment ──

interface FrontAssessment {
  front: Front;
  enemyPower: number;   // our power (enemy team perspective)
  playerPower: number;  // threat power
  ratio: number;        // enemyPower / playerPower (>1 = we're stronger)
  enemyUnits: Unit[];
  hasFacility: boolean;
}

// ── Main entry ──

export function processEnemyAI(state: GameState, dt: number): void {
  if (state.gameOver) return;
  enemyAITimer += dt;

  // C2: while-loop prevents timer drift on frame drops
  while (enemyAITimer >= ENEMY_AI_INTERVAL) {
    enemyAITimer -= ENEMY_AI_INTERVAL;
    runEnemyAI(state);
  }
}

// MVP2: Attack wave system
let attackWaveTimer = 0;
let attackWaveCount = 0;
const ATTACK_WAVE_INTERVAL_MIN = 60;
const ATTACK_WAVE_INTERVAL_MAX = 90;
let nextWaveTime = ATTACK_WAVE_INTERVAL_MIN + Math.random() * (ATTACK_WAVE_INTERVAL_MAX - ATTACK_WAVE_INTERVAL_MIN);

/** Reset attack wave state on new game session. */
export function resetAttackWaveState(): void {
  attackWaveTimer = 0;
  attackWaveCount = 0;
  nextWaveTime = ATTACK_WAVE_INTERVAL_MIN + Math.random() * (ATTACK_WAVE_INTERVAL_MAX - ATTACK_WAVE_INTERVAL_MIN);
}

function runEnemyAI(state: GameState): void {
  const assessments = assessFronts(state);

  // MVP2: Attack wave check
  attackWaveTimer += ENEMY_AI_INTERVAL;
  if (attackWaveTimer >= nextWaveTime) {
    attackWaveTimer = 0;
    attackWaveCount++;
    nextWaveTime = ATTACK_WAVE_INTERVAL_MIN + Math.random() * (ATTACK_WAVE_INTERVAL_MAX - ATTACK_WAVE_INTERVAL_MIN);
    executeAttackWave(state, assessments);
  }

  for (const assessment of assessments) {
    executeEnemyDecision(state, assessment, assessments);
  }

  enemyProductionAI(state);
}

// ── Enemy auto-production ──

let enemyProdToggle = false; // flips each successful enqueue for true alternation

/** Reset production toggle on new game session. */
export function resetEnemyProdToggle(): void {
  enemyProdToggle = false;
}

function enemyProductionAI(state: GameState): void {
  // MVP2: Allow up to 4 queued items (was 2)
  if (state.productionQueue.enemy.length >= 4) return;

  const money = state.economy.enemy.resources.money;

  // MVP2: Aggressive production — 50% infantry, 30% light_tank, 20% main_tank
  const roll = Math.random();
  let result: { ok: boolean };

  if (roll < 0.5 && money >= 100) {
    result = enqueueProduction(state, "enemy", "infantry");
    if (result.ok) enemyProdToggle = !enemyProdToggle;
  } else if (roll < 0.8 && money >= 250) {
    result = enqueueProduction(state, "enemy", "light_tank");
    if (result.ok) enemyProdToggle = !enemyProdToggle;
  } else if (money >= 500) {
    result = enqueueProduction(state, "enemy", "main_tank");
    if (result.ok) enemyProdToggle = !enemyProdToggle;
  } else if (money >= 100) {
    // Fallback: infantry if can't afford desired type
    result = enqueueProduction(state, "enemy", "infantry");
    if (result.ok) enemyProdToggle = !enemyProdToggle;
  }
}

// ── Front assessment ──

function assessFronts(state: GameState): FrontAssessment[] {
  return state.fronts.map((front) => {
    const enemyUnits = getEnemyUnitsOnFront(state, front);
    const playerUnits = getPlayerUnitsOnFront(state, front);

    const enemyPower = computePower(enemyUnits);
    const playerPower = computePower(playerUnits);

    // Avoid division by zero: if no player presence, ratio = large number (we dominate)
    const ratio = playerPower > 0 ? enemyPower / playerPower : enemyPower > 0 ? 10.0 : 1.0;

    const hasFacility = frontHasFacility(state, front);

    return { front, enemyPower, playerPower, ratio, enemyUnits, hasFacility };
  });
}

function computePower(units: Unit[]): number {
  let power = 0;
  for (const u of units) {
    const interval = u.attackInterval > 0 ? u.attackInterval : 1;
    power += (u.hp / u.maxHp) * u.attackDamage / interval * 10;
  }
  return power;
}

function getEnemyUnitsOnFront(state: GameState, front: Front): Unit[] {
  const bboxes = front.regionIds
    .map((rid) => state.regions.get(rid))
    .filter((r): r is NonNullable<typeof r> => r !== undefined)
    .map((r) => r.bbox);

  const units: Unit[] = [];
  state.units.forEach((u) => {
    if (u.team !== "enemy" || u.state === "dead") return;
    const inFront = bboxes.some(
      ([x1, y1, x2, y2]) =>
        u.position.x >= x1 && u.position.x <= x2 &&
        u.position.y >= y1 && u.position.y <= y2,
    );
    if (inFront) units.push(u);
  });
  return units;
}

function getPlayerUnitsOnFront(state: GameState, front: Front): Unit[] {
  const bboxes = front.regionIds
    .map((rid) => state.regions.get(rid))
    .filter((r): r is NonNullable<typeof r> => r !== undefined)
    .map((r) => r.bbox);

  const units: Unit[] = [];
  state.units.forEach((u) => {
    if (u.team !== "player" || u.state === "dead") return;
    const inFront = bboxes.some(
      ([x1, y1, x2, y2]) =>
        u.position.x >= x1 && u.position.x <= x2 &&
        u.position.y >= y1 && u.position.y <= y2,
    );
    if (inFront) units.push(u);
  });
  return units;
}

function frontHasFacility(state: GameState, front: Front): boolean {
  for (const rid of front.regionIds) {
    const region = state.regions.get(rid);
    if (!region) continue;
    for (const facId of region.facilities) {
      const fac = state.facilities.get(facId);
      if (fac && fac.team === "enemy") return true;
    }
  }
  return false;
}

// ── Decision execution ──

function executeEnemyDecision(
  state: GameState,
  assessment: FrontAssessment,
  allAssessments: FrontAssessment[],
): void {
  const { ratio, enemyUnits } = assessment;

  if (enemyUnits.length === 0) return;

  if (ratio < 0.4) {
    // Overwhelmed → retreat weakest 30%
    executeRetreat(state, assessment);
  } else if (ratio < 0.8) {
    // Outnumbered → defend
    executeDefend(state, assessment);
  } else if (ratio > 2.5 && enemyUnits.length >= 4) {
    // Massive surplus → reinforce weakest allied front
    executeReinforce(state, assessment, allAssessments);
  } else if (ratio > 1.5) {
    // Superior → attack
    executeAttack(state, assessment);
  } else {
    // Roughly even → patrol / hold
    executePatrol(state, assessment);
  }
}

// ── Order generators ──

function executeAttack(state: GameState, assessment: FrontAssessment): void {
  const { enemyUnits, front } = assessment;

  // Send 60% of units to attack (strongest first)
  const attackCount = Math.max(1, Math.ceil(enemyUnits.length * 0.6));
  const sorted = [...enemyUnits].sort((a, b) => b.hp - a.hp);
  const attackers = sorted.slice(0, attackCount);

  // Target: nearest player unit on this front, or front center
  const playerUnits = getPlayerUnitsOnFront(state, front);
  let target: Position;

  if (playerUnits.length > 0) {
    // Attack toward closest player unit (from centroid of our units)
    const centroid = getCentroid(attackers);
    const closest = findClosestUnit(centroid, playerUnits);
    target = { x: closest.position.x, y: closest.position.y };
  } else {
    // No player presence — push toward front center
    target = getFrontCenter(state, front) ?? { x: 100, y: 75 };
  }

  const orders: Order[] = [{
    unitIds: attackers.map((u) => u.id),
    action: "attack_move",
    target,
    priority: "high",
  }];

  applyEnemyOrders(state, orders);
}

function executeDefend(state: GameState, assessment: FrontAssessment): void {
  const { enemyUnits } = assessment;

  // All units defend at current positions
  const orders: Order[] = [{
    unitIds: enemyUnits.map((u) => u.id),
    action: "defend",
    target: null,
    priority: "medium",
  }];

  applyEnemyOrders(state, orders);
}

function executeRetreat(state: GameState, assessment: FrontAssessment): void {
  const { enemyUnits } = assessment;

  // Retreat weakest 30% of units
  const retreatCount = Math.max(1, Math.ceil(enemyUnits.length * 0.3));
  const sorted = [...enemyUnits].sort((a, b) => (a.hp / a.maxHp) - (b.hp / b.maxHp));
  const retreaters = sorted.slice(0, retreatCount);

  // C4: HQ fallback
  const hqPos = findEnemyHQ(state);

  const orders: Order[] = [];
  for (const u of retreaters) {
    const dx = hqPos.x - u.position.x;
    const dy = hqPos.y - u.position.y;
    const dist = Math.sqrt(dx * dx + dy * dy);
    const retreatDist = Math.min(20, dist * 0.5);

    let target: Position;
    if (dist < 1) {
      target = hqPos;
    } else {
      target = {
        x: Math.round(u.position.x + (dx / dist) * retreatDist),
        y: Math.round(u.position.y + (dy / dist) * retreatDist),
      };
    }

    // C3: clamp to map bounds
    target.x = Math.max(0, Math.min(state.mapWidth - 1, target.x));
    target.y = Math.max(0, Math.min(state.mapHeight - 1, target.y));

    // Passability check — try spiral if needed
    const safeTarget = findPassableNearby(u, target, state);
    if (!safeTarget) continue;

    orders.push({
      unitIds: [u.id],
      action: "retreat",
      target: safeTarget,
      priority: "high",
    });
  }

  if (orders.length > 0) {
    applyEnemyOrders(state, orders);
  }
}

function executeReinforce(
  state: GameState,
  assessment: FrontAssessment,
  allAssessments: FrontAssessment[],
): void {
  const { enemyUnits } = assessment;

  // Find weakest allied front (excluding this one)
  const weakest = findWeakestAllyFront(allAssessments, assessment.front.id);
  if (!weakest) {
    // No other front to reinforce → just patrol
    executePatrol(state, assessment);
    return;
  }

  // Send 30% of surplus units
  const reinforceCount = Math.max(1, Math.ceil(enemyUnits.length * 0.3));
  const sorted = [...enemyUnits].sort((a, b) => b.hp - a.hp);
  const reinforcers = sorted.slice(0, reinforceCount);

  const target = getFrontCenter(state, weakest.front) ?? findEnemyHQ(state);

  const orders: Order[] = [{
    unitIds: reinforcers.map((u) => u.id),
    action: "attack_move",
    target,
    priority: "medium",
  }];

  applyEnemyOrders(state, orders);
}

function executePatrol(state: GameState, assessment: FrontAssessment): void {
  const { enemyUnits, front } = assessment;

  const orders: Order[] = [];
  for (const u of enemyUnits) {
    // Skip units already patrolling or attacking
    if (u.state === "patrolling" || u.state === "attacking") continue;

    const patrolTarget = randomPointInFront(state, front, u);
    if (!patrolTarget) {
      // C3: no valid patrol point → explicit hold
      orders.push({
        unitIds: [u.id],
        action: "hold",
        target: null,
        priority: "low",
      });
      continue;
    }

    orders.push({
      unitIds: [u.id],
      action: "patrol",
      target: patrolTarget,
      priority: "low",
    });
  }

  if (orders.length > 0) {
    applyEnemyOrders(state, orders);
  }
}

// ── MVP2: Attack Wave Execution ──

function executeAttackWave(state: GameState, assessments: FrontAssessment[]): void {
  // Wave size: 5 + 3 * (waveCount - 1), capped at available units
  const waveSize = Math.min(5 + 3 * (attackWaveCount - 1), 20);

  // Find weakest player front (lowest player power)
  let weakestFront: FrontAssessment | null = null;
  let weakestPower = Infinity;
  for (const a of assessments) {
    if (a.playerPower < weakestPower && a.playerPower >= 0) {
      weakestPower = a.playerPower;
      weakestFront = a;
    }
  }

  // Gather all available enemy units (not currently attacking)
  const availableUnits: Unit[] = [];
  state.units.forEach((u) => {
    if (u.team !== "enemy" || u.state === "dead" || u.hp <= 0) return;
    if (getUnitCategory(u.type) !== "ground") return;
    availableUnits.push(u);
  });

  if (availableUnits.length === 0) return;

  // Sort by HP (strongest first)
  availableUnits.sort((a, b) => b.hp - a.hp);
  const attackers = availableUnits.slice(0, Math.min(waveSize, availableUnits.length));

  // MVP2: Target priority — look for player commander first
  let target: Position | null = null;

  // Priority 1: Commander
  state.units.forEach((u) => {
    if (u.type === "commander" && u.team === "player" && u.state !== "dead" && u.hp > 0) {
      target = { x: u.position.x, y: u.position.y };
    }
  });

  // Priority 2: Weakest front or player HQ
  if (!target) {
    if (weakestFront && weakestFront.playerPower === 0) {
      // Empty front → push toward player HQ
      target = findPlayerHQ(state);
    } else if (weakestFront) {
      target = getFrontCenter(state, weakestFront.front) ?? findPlayerHQ(state);
    } else {
      target = findPlayerHQ(state);
    }
  }

  const orders: Order[] = [{
    unitIds: attackers.map((u) => u.id),
    action: "attack_move",
    target,
    priority: "high",
  }];

  // MVP2: 20% chance to split attack on two fronts
  if (Math.random() < 0.2 && assessments.length >= 2 && attackers.length >= 6) {
    const halfCount = Math.floor(attackers.length / 2);
    const group1 = attackers.slice(0, halfCount);
    const group2 = attackers.slice(halfCount);

    // Find second weakest front
    const sortedFronts = [...assessments].sort((a, b) => a.playerPower - b.playerPower);
    const secondTarget = sortedFronts.length >= 2
      ? (getFrontCenter(state, sortedFronts[1].front) ?? target)
      : target;

    orders.length = 0;
    orders.push({
      unitIds: group1.map((u) => u.id),
      action: "attack_move",
      target,
      priority: "high",
    });
    orders.push({
      unitIds: group2.map((u) => u.id),
      action: "attack_move",
      target: secondTarget,
      priority: "high",
    });
  }

  applyEnemyOrders(state, orders);
}

function findPlayerHQ(state: GameState): Position {
  for (const [, fac] of state.facilities) {
    if (fac.type === "headquarters" && fac.team === "player") {
      return { x: fac.position.x, y: fac.position.y };
    }
  }
  return { x: 5, y: 5 }; // fallback: top-left
}

// ── Helpers ──

/** C4: Find enemy HQ position with safe fallback */
function findEnemyHQ(state: GameState): Position {
  for (const [, fac] of state.facilities) {
    if (fac.type === "headquarters" && fac.team === "enemy") {
      return { x: fac.position.x, y: fac.position.y };
    }
  }
  // C4 fallback: bottom-center of map
  return { x: state.mapWidth - 5, y: state.mapHeight - 5 };
}

function findWeakestAllyFront(
  assessments: FrontAssessment[],
  excludeFrontId: string,
): FrontAssessment | null {
  let weakest: FrontAssessment | null = null;
  let weakestRatio = Infinity;

  for (const a of assessments) {
    if (a.front.id === excludeFrontId) continue;
    if (a.enemyUnits.length === 0 && a.playerPower === 0) continue; // empty front
    if (a.ratio < weakestRatio) {
      weakestRatio = a.ratio;
      weakest = a;
    }
  }

  return weakest;
}

function getFrontCenter(state: GameState, front: Front): Position | null {
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

function getCentroid(units: Unit[]): Position {
  let x = 0, y = 0;
  for (const u of units) {
    x += u.position.x;
    y += u.position.y;
  }
  return { x: x / units.length, y: y / units.length };
}

function findClosestUnit(pos: Position, units: Unit[]): Unit {
  let best = units[0];
  let bestDist = Infinity;
  for (const u of units) {
    const dx = u.position.x - pos.x;
    const dy = u.position.y - pos.y;
    const d = dx * dx + dy * dy;
    if (d < bestDist) {
      bestDist = d;
      best = u;
    }
  }
  return best;
}

/**
 * Generate a random passable point within a front's region bboxes.
 * C3: clamp to map bounds + canUnitEnterTile check.
 * Returns null if no valid point found after 8 attempts → caller should fall back to hold.
 */
function randomPointInFront(state: GameState, front: Front, unit: Unit): Position | null {
  const bboxes = front.regionIds
    .map((rid) => state.regions.get(rid))
    .filter((r): r is NonNullable<typeof r> => r !== undefined)
    .map((r) => r.bbox);

  if (bboxes.length === 0) return null;

  for (let attempt = 0; attempt < 8; attempt++) {
    // Pick a random bbox
    const bbox = bboxes[Math.floor(Math.random() * bboxes.length)];
    const x = Math.round(bbox[0] + Math.random() * (bbox[2] - bbox[0]));
    const y = Math.round(bbox[1] + Math.random() * (bbox[3] - bbox[1]));

    // C3: clamp to map bounds
    const cx = Math.max(0, Math.min(state.mapWidth - 1, x));
    const cy = Math.max(0, Math.min(state.mapHeight - 1, y));

    if (canUnitEnterTile(unit.type, cx, cy, state)) {
      return { x: cx, y: cy };
    }
  }

  return null; // Fall back to hold
}

/**
 * Find a passable tile near the target position via spiral search.
 * C3: clamp + canUnitEnterTile. Max 12 tiles radius.
 * Returns null if nothing found.
 */
function findPassableNearby(unit: Unit, target: Position, state: GameState): Position | null {
  // Check target itself first
  if (canUnitEnterTile(unit.type, target.x, target.y, state)) {
    return target;
  }

  // Spiral search
  for (let r = 1; r <= 12; r++) {
    for (let dx = -r; dx <= r; dx++) {
      for (let dy = -r; dy <= r; dy++) {
        if (Math.abs(dx) !== r && Math.abs(dy) !== r) continue; // only check perimeter
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
