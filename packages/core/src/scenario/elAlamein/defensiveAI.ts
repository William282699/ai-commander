// ============================================================
// AI Commander — Defensive AI for El Alamein
// Enemy holds positions, counterattacks when strongpoints fall
// ============================================================

import type { GameState, Unit, Position, Order, Facility, UnitType } from "@ai-commander/shared";
import { getUnitCategory } from "@ai-commander/shared";
import { applyEnemyOrders } from "../../applyOrders";
import { canUnitEnterTile } from "../../sim";
import { enqueueProduction } from "../../economy";

const DEFENSIVE_AI_INTERVAL = 5.0;
let defensiveAITimer = 0;

// ── Offensive probe state ──
const OFFENSIVE_FIRST_DELAY_SEC = 90;
const OFFENSIVE_SOURCE_BBOX: [number, number, number, number] = [10, 40, 180, 200];
const MIN_HQ_GUARD = 4;

let offensiveTimer = OFFENSIVE_FIRST_DELAY_SEC;
let offensiveWaveCount = 0;

export function resetDefensiveAITimer(): void {
  defensiveAITimer = 0;
  offensiveTimer = OFFENSIVE_FIRST_DELAY_SEC;
  offensiveWaveCount = 0;
  activeAttackerIds.clear();
}

// Track dispatched attacker IDs — holdPositions must not override these
let debugAttackerIds: number[] = [];
const activeAttackerIds = new Set<number>();

export function processDefensiveAI(state: GameState, dt: number): void {
  if (state.gameOver) return;
  if (state.enemyAIMode !== "defensive") return;
  defensiveAITimer += dt;
  while (defensiveAITimer >= DEFENSIVE_AI_INTERVAL) {
    defensiveAITimer -= DEFENSIVE_AI_INTERVAL;
    const eFuel = state.economy.enemy.resources.fuel;
    state.diagnostics.push({ time: state.time, code: "DEFAI_DBG", message: `offTimer=${offensiveTimer.toFixed(0)} wave=${offensiveWaveCount} eFuel=${eFuel}` });
    // Track dispatched units
    if (debugAttackerIds.length > 0) {
      const info = debugAttackerIds.slice(0, 3).map(id => {
        const u = state.units.get(id);
        if (!u) return `${id}:GONE`;
        return `${id}:${u.state}@(${u.position.x.toFixed(0)},${u.position.y.toFixed(0)})tgt=${u.target ? `(${u.target.x},${u.target.y})` : 'null'}`;
      }).join(' ');
      state.diagnostics.push({ time: state.time, code: "DEFAI_DBG", message: `TRACK ${info}` });
    }
    runDefensiveAI(state);
  }
}

function runDefensiveAI(state: GameState): void {
  // 1. Check for lost strongpoints → counterattack
  counterattackLostStrongpoints(state);

  // 2. Reinforce weak strongpoints
  reinforceWeakStrongpoints(state);

  // 3. Launch offensive probe from rear reserves
  launchOffensiveProbe(state);

  // 4. Defenders that are idle → defend at current position
  holdPositions(state);

  // 5. Production (biased toward infantry)
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

// ── Offensive probe from rear reserves ──

function launchOffensiveProbe(state: GameState): void {
  offensiveTimer -= DEFENSIVE_AI_INTERVAL;
  if (offensiveTimer > 0) return;

  // --- Pick target front (local realtime player power, exclude axis_rear) ---
  // Use Set per front to avoid double-counting units in overlapping regions
  const frontPower: { front: typeof state.fronts[0]; power: number }[] = [];
  for (const front of state.fronts) {
    if (front.id === "front_axis_rear") continue;
    let playerHp = 0;
    const counted = new Set<number>();
    for (const regionId of front.regionIds) {
      const region = state.regions.get(regionId);
      if (!region) continue;
      const [x1, y1, x2, y2] = region.bbox;
      state.units.forEach(u => {
        if (u.team !== "player" || u.state === "dead" || u.hp <= 0) return;
        if (counted.has(u.id)) return;
        if (u.position.x >= x1 && u.position.x <= x2 &&
            u.position.y >= y1 && u.position.y <= y2) {
          counted.add(u.id);
          playerHp += u.hp;
        }
      });
    }
    frontPower.push({ front, power: playerHp });
  }
  if (frontPower.length === 0) return;

  // Sort ascending by player power → weakest first
  frontPower.sort((a, b) => a.power - b.power);
  const primaryTarget = frontPower[0].front;

  // --- Collect rear pool units ---
  const [sx1, sy1, sx2, sy2] = OFFENSIVE_SOURCE_BBOX;
  const pool: Unit[] = [];
  state.units.forEach(u => {
    if (u.team !== "enemy" || u.state === "dead" || u.hp <= 0) return;
    if (getUnitCategory(u.type) !== "ground") return;
    if (u.type === "commander") return;
    if (u.state !== "idle" && u.state !== "defending" && u.state !== "patrolling") return;
    if (u.position.x >= sx1 && u.position.x <= sx2 &&
        u.position.y >= sy1 && u.position.y <= sy2) {
      pool.push(u);
    }
  });

  // HQ guard protection: keep MIN_HQ_GUARD near enemy HQ
  let hqPos: Position | null = null;
  state.facilities.forEach(f => {
    if (f.type === "headquarters" && f.team === "enemy") hqPos = f.position;
  });
  if (hqPos) {
    const hqX = (hqPos as Position).x;
    const hqY = (hqPos as Position).y;
    const nearHQ = pool.filter(u => {
      const dx = u.position.x - hqX;
      const dy = u.position.y - hqY;
      return dx * dx + dy * dy <= 20 * 20;
    });
    if (nearHQ.length <= MIN_HQ_GUARD) {
      const guardIds = new Set(nearHQ.map(u => u.id));
      for (let i = pool.length - 1; i >= 0; i--) {
        if (guardIds.has(pool[i].id)) pool.splice(i, 1);
      }
    } else {
      nearHQ.sort((a, b) => b.hp - a.hp);
      const guardIds = new Set(nearHQ.slice(0, MIN_HQ_GUARD).map(u => u.id));
      for (let i = pool.length - 1; i >= 0; i--) {
        if (guardIds.has(pool[i].id)) pool.splice(i, 1);
      }
    }
  }

  // --- Fuel-aware pool filtering: when fuel is low, prefer infantry ---
  const enemyFuel = state.economy.enemy.resources.fuel;
  const fuelPerTankTile = 0.5; // approximate fuel cost per tile for mechanized
  const marchDistance = 60; // approximate tiles to target
  const fuelNeededPerTank = fuelPerTankTile * marchDistance;
  if (enemyFuel < fuelNeededPerTank * 3) {
    // Not enough fuel for tanks — sort infantry first, only include tanks if we have fuel
    const infantryPool = pool.filter(u => u.type === "infantry");
    const mechPool = pool.filter(u => u.type !== "infantry");
    const affordableMech = Math.floor(enemyFuel / fuelNeededPerTank);
    pool.length = 0;
    pool.push(...infantryPool, ...mechPool.slice(0, Math.max(0, affordableMech)));
  }

  // --- Wave size (use nextWave for calculation, commit only on success) ---
  const nextWave = offensiveWaveCount + 1;
  const cap = nextWave >= 5 ? 16 : 12;
  const waveSize = Math.min(3 + 2 * nextWave, cap);

  // Insufficient forces? Don't count as a wave, short retry
  if (pool.length < Math.ceil(waveSize * 0.6)) {
    offensiveTimer = 15;
    return;
  }

  // Sort by type priority: light_tank > main_tank > infantry, then HP desc
  const typePriority: Record<string, number> = { light_tank: 0, main_tank: 1, infantry: 2 };
  pool.sort((a, b) => {
    const pa = typePriority[a.type] ?? 3;
    const pb = typePriority[b.type] ?? 3;
    if (pa !== pb) return pa - pb;
    return b.hp - a.hp;
  });

  const attackers = pool.slice(0, waveSize);

  // --- Target point: use lead type of main attack group ---
  const mainLeadType = getLeadType(attackers);
  const targetPos = getTargetPosition(state, primaryTarget, mainLeadType);

  // --- Generate orders ---
  const orders: Order[] = [{
    unitIds: attackers.map(u => u.id),
    action: "attack_move",
    target: targetPos,
    priority: "high",
  }];

  // 30% chance: secondary feint at second-weakest front
  if (frontPower.length >= 2 && Math.random() < 0.3) {
    const secondaryTarget = frontPower[1].front;
    const feintPool = pool.slice(waveSize, waveSize + 3);
    if (feintPool.length >= 2) {
      const feintLeadType = getLeadType(feintPool);
      const feintTarget = getTargetPosition(state, secondaryTarget, feintLeadType);
      orders.push({
        unitIds: feintPool.map(u => u.id),
        action: "attack_move",
        target: feintTarget,
        priority: "medium",
      });
    }
  }

  state.diagnostics.push({ time: state.time, code: "DEFAI_DBG", message: `LAUNCH pool=${pool.length} ws=${waveSize} atk=${attackers.length} tgt=(${targetPos.x},${targetPos.y}) front=${primaryTarget.id} lead=${mainLeadType}` });

  const dispatch = applyEnemyOrders(state, orders);

  // Commit wave only when main strike order is actually dispatched to all intended units.
  const mainApplied = dispatch.appliedPerOrder[0] ?? 0;
  debugAttackerIds = attackers.map(u => u.id);
  for (const id of debugAttackerIds) activeAttackerIds.add(id);
  state.diagnostics.push({ time: state.time, code: "DEFAI_DBG", message: `DISPATCH applied=${mainApplied}/${attackers.length} ids=[${debugAttackerIds.join(',')}]` });
  if (mainApplied < attackers.length) {
    offensiveTimer = 15;
    return;
  }

  offensiveWaveCount = nextWave;
  if (nextWave < 3) {
    offensiveTimer = 60 + Math.random() * 60; // 60-120s
  } else if (nextWave < 5) {
    offensiveTimer = 45 + Math.random() * 30; // 45-75s
  } else {
    offensiveTimer = 45 + Math.random() * 15; // 45-60s
  }
}

/** Determine the most common unit type in a group (lead type for passability) */
function getLeadType(units: Unit[]): UnitType {
  const counts = new Map<UnitType, number>();
  for (const u of units) {
    counts.set(u.type, (counts.get(u.type) ?? 0) + 1);
  }
  let best: UnitType = "infantry";
  let bestCount = 0;
  for (const [type, count] of counts) {
    if (count > bestCount) { best = type; bestCount = count; }
  }
  return best;
}

/** Get a target position for an offensive wave targeting a front */
function getTargetPosition(
  state: GameState,
  front: typeof state.fronts[0],
  leadType: UnitType,
): { x: number; y: number } {
  for (const regionId of front.regionIds) {
    const region = state.regions.get(regionId);
    if (!region) continue;
    const [x1, y1, x2, y2] = region.bbox;
    const cx = Math.floor((x1 + x2) / 2);
    const cy = Math.floor((y1 + y2) / 2);
    if (canUnitEnterTile(leadType, cx, cy, state)) {
      return { x: cx, y: cy };
    }
    // Nearby search
    for (let dx = -3; dx <= 3; dx++) {
      for (let dy = -3; dy <= 3; dy++) {
        if (canUnitEnterTile(leadType, cx + dx, cy + dy, state)) {
          return { x: cx + dx, y: cy + dy };
        }
      }
    }
  }
  // Fallback: nearest player facility
  let bestDist = Infinity;
  let bestPos = { x: 200, y: 100 };
  state.facilities.forEach(f => {
    if (f.team !== "player") return;
    const d = Math.hypot(f.position.x - 80, f.position.y - 100);
    if (d < bestDist) {
      bestDist = d;
      bestPos = { x: f.position.x, y: f.position.y };
    }
  });
  return bestPos;
}

// ── Hold positions ──

function holdPositions(state: GameState): void {
  // Clean up active attackers: remove dead or idle (arrived/stuck) units
  for (const id of activeAttackerIds) {
    const u = state.units.get(id);
    if (!u || u.state === "dead" || u.hp <= 0) {
      activeAttackerIds.delete(id);
    }
  }

  const orders: Order[] = [];
  state.units.forEach(u => {
    if (u.team !== "enemy" || u.state === "dead" || u.hp <= 0) return;
    if (getUnitCategory(u.type) !== "ground") return;
    // Skip units on active offensive — don't override their attack_move
    if (activeAttackerIds.has(u.id)) return;
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

// ── Defensive production (70% infantry) + fuel/ammo management ──

function defensiveProduction(state: GameState): void {
  const eco = state.economy.enemy;
  const money = eco.resources.money;
  const fuel = eco.resources.fuel;
  const ammo = eco.resources.ammo;

  // Priority: buy fuel aggressively when low (mechanized units need fuel to move)
  if (fuel < 80 && money >= 300) {
    applyEnemyOrders(state, [{ unitIds: [], action: "trade", target: null, priority: "high", tradeType: "buy_fuel" }]);
  }
  // Buy again if still critically low (double buy if money allows)
  if (fuel < 20 && money >= 600) {
    applyEnemyOrders(state, [{ unitIds: [], action: "trade", target: null, priority: "high", tradeType: "buy_fuel" }]);
  }
  // Buy ammo when low
  if (ammo < 50 && money >= 300) {
    applyEnemyOrders(state, [{ unitIds: [], action: "trade", target: null, priority: "medium", tradeType: "buy_ammo" }]);
  }

  if (state.productionQueue.enemy.length >= 4) return;

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
