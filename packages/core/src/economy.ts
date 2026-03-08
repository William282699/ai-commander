// ============================================================
// AI Commander — Economy System (Day 9)
// Income ticking, facility bonuses, fuel/ammo constraints,
// readiness calculation, production queue, facility capture.
// ============================================================

import type {
  GameState,
  Unit,
  Facility,
  FacilityType,
  Resources,
  UnitType,
  ProductionOrder,
  Team,
} from "@ai-commander/shared";
import {
  INCOME_INTERVAL_SEC,
  FACILITY_BONUSES,
  FUEL_PER_TILE_TANK,
  FUEL_PER_TILE_SHIP,
  FUEL_PER_SORTIE_AIR,
  CAPTURE_TIME_SEC,
  UNIT_STATS,
  PRODUCTION_FACILITY,
  TERRAIN_MOVE_MULT,
  getUnitCategory,
} from "@ai-commander/shared";

// ── Non-capturable facility types (blacklist) ──
// Everything NOT on this list can be captured by infantry.
const NON_CAPTURABLE: readonly FacilityType[] = [
  "headquarters",
  "barracks",
  "shipyard",
  "airfield",
  "defense_tower",
];

// ── Helper: is a unit "mechanized" (consumes fuel to move)? ──

export function isMechanized(type: UnitType): boolean {
  // Infantry doesn't consume fuel. All others do.
  return type !== "infantry";
}

/** Fuel cost per tile for a given unit type */
export function fuelPerTile(type: UnitType): number {
  const cat = getUnitCategory(type);
  if (cat === "naval") return FUEL_PER_TILE_SHIP;
  if (cat === "air") return FUEL_PER_SORTIE_AIR; // air: per-tile simplified
  // Ground mechanized
  if (type === "infantry") return 0;
  return FUEL_PER_TILE_TANK;
}

// ── Main economy processor — called every frame from game loop ──

export function processEconomy(state: GameState, dt: number): void {
  if (state.gameOver) return;

  // 1. Income ticking (every INCOME_INTERVAL_SEC = 30s)
  tickIncome(state);

  // 2. Facility capture progress
  tickFacilityCapture(state, dt);

  // 3. Recalculate bonus income from captured facilities
  recalcBonusIncome(state);

  // 4. Production queue advancement
  tickProduction(state);

  // 5. Readiness calculation
  updateReadiness(state);
}

// ── 1. Income ticking ──

function tickIncome(state: GameState): void {
  for (const teamKey of ["player", "enemy"] as const) {
    const eco = state.economy[teamKey];
    // Use while-loop pattern (same as autoBehavior/enemyAI) to prevent drift
    while (state.time - eco.lastIncomeTime >= INCOME_INTERVAL_SEC) {
      eco.lastIncomeTime += INCOME_INTERVAL_SEC;
      // Apply base + bonus
      eco.resources.money += eco.baseIncome.money + eco.bonusIncome.money;
      eco.resources.fuel += eco.baseIncome.fuel + eco.bonusIncome.fuel;
      eco.resources.ammo += eco.baseIncome.ammo + eco.bonusIncome.ammo;
      eco.resources.intel += eco.baseIncome.intel + eco.bonusIncome.intel;
    }
  }
}

// ── 2. Facility capture (P3 fix: blacklist instead of whitelist) ──

function tickFacilityCapture(state: GameState, dt: number): void {
  state.facilities.forEach((fac) => {
    // Skip non-capturable types (HQ, barracks, shipyard, airfield, defense_tower)
    if ((NON_CAPTURABLE as readonly string[]).includes(fac.type)) return;
    // Skip destroyed facilities
    if (fac.hp <= 0) return;

    // Find infantry near this facility (within 1.5 tiles)
    let playerInf = 0;
    let enemyInf = 0;

    state.units.forEach((unit) => {
      if (unit.type !== "infantry" || unit.hp <= 0 || unit.state === "dead") return;
      const dx = unit.position.x - fac.position.x;
      const dy = unit.position.y - fac.position.y;
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dist > 1.5) return;
      if (unit.team === "player") playerInf++;
      else if (unit.team === "enemy") enemyInf++;
    });

    // Determine capturing team (must be unopposed infantry)
    let capTeam: Team | null = null;
    if (playerInf > 0 && enemyInf === 0 && fac.team !== "player") {
      capTeam = "player";
    } else if (enemyInf > 0 && playerInf === 0 && fac.team !== "enemy") {
      capTeam = "enemy";
    }

    if (capTeam) {
      // If switching capturing team, reset progress
      if (fac.capturingTeam !== capTeam) {
        fac.capturingTeam = capTeam;
        fac.captureProgress = 0;
      }
      fac.captureProgress += dt / CAPTURE_TIME_SEC;
      if (fac.captureProgress >= 1) {
        fac.captureProgress = 0;
        fac.capturingTeam = null;
        fac.team = capTeam;
      }
    } else {
      // No valid capturer — decay progress slowly
      if (fac.captureProgress > 0) {
        fac.captureProgress = Math.max(0, fac.captureProgress - dt / (CAPTURE_TIME_SEC * 2));
        if (fac.captureProgress === 0) {
          fac.capturingTeam = null;
        }
      }
    }
  });
}

// ── 3. Recalculate bonus income from owned facilities ──

function recalcBonusIncome(state: GameState): void {
  const playerBonus: Resources = { money: 0, fuel: 0, ammo: 0, intel: 0 };
  const enemyBonus: Resources = { money: 0, fuel: 0, ammo: 0, intel: 0 };

  state.facilities.forEach((fac) => {
    const bonus = FACILITY_BONUSES[fac.type];
    if (!bonus) return;

    const target = fac.team === "player" ? playerBonus : fac.team === "enemy" ? enemyBonus : null;
    if (!target) return;

    if (bonus.money) target.money += bonus.money;
    if (bonus.fuel) target.fuel += bonus.fuel;
    if (bonus.ammo) target.ammo += bonus.ammo;
    if (bonus.intel) target.intel += bonus.intel;
  });

  state.economy.player.bonusIncome = playerBonus;
  state.economy.enemy.bonusIncome = enemyBonus;
}

// ── 4. Production queue (P1 fix: find passable spawn tile) ──

/**
 * BFS-spiral search for the nearest tile passable by the given unit category.
 * Searches outward from (cx, cy) up to maxRadius tiles.
 * Returns null if nothing found.
 */
function findPassableSpawn(
  state: GameState,
  cx: number,
  cy: number,
  unitType: UnitType,
  maxRadius: number,
): { x: number; y: number } | null {
  const cat = getUnitCategory(unitType);
  // Check origin first
  const ox = Math.floor(cx);
  const oy = Math.floor(cy);
  if (isPassableTile(state, ox, oy, cat)) return { x: cx, y: cy };

  // Expanding square rings
  for (let r = 1; r <= maxRadius; r++) {
    for (let dx = -r; dx <= r; dx++) {
      for (let dy = -r; dy <= r; dy++) {
        // Only ring perimeter (skip interior, already checked)
        if (Math.abs(dx) !== r && Math.abs(dy) !== r) continue;
        const tx = ox + dx;
        const ty = oy + dy;
        if (isPassableTile(state, tx, ty, cat)) {
          return { x: tx + 0.5, y: ty + 0.5 };
        }
      }
    }
  }
  return null;
}

function isPassableTile(
  state: GameState,
  tx: number,
  ty: number,
  cat: "ground" | "naval" | "air",
): boolean {
  if (tx < 0 || tx >= state.mapWidth || ty < 0 || ty >= state.mapHeight) return false;
  const terrain = state.terrain[ty][tx];
  const mult = TERRAIN_MOVE_MULT[terrain]?.[cat] ?? 0;
  return mult > 0;
}

function tickProduction(state: GameState): void {
  for (const teamKey of ["player", "enemy"] as const) {
    const queue = state.productionQueue[teamKey];
    if (queue.length === 0) continue;

    // Process first item in queue
    const order = queue[0];
    if (state.time >= order.startTime + order.duration) {
      // Complete: spawn unit near facility on a passable tile
      const fac = state.facilities.get(order.facilityId);
      if (fac) {
        // P1 fix: search large radius for passable spawn point
        const spawn = findPassableSpawn(state, fac.position.x, fac.position.y, order.unitType, 80);
        if (spawn) {
          const stats = UNIT_STATS[order.unitType];
          const unit: Unit = {
            id: state.nextUnitId++,
            type: order.unitType,
            team: teamKey,
            hp: stats.hp,
            maxHp: stats.hp,
            position: spawn,
            state: "idle",
            target: null,
            attackTarget: null,
            visionRange: stats.vision,
            attackRange: stats.range,
            attackDamage: stats.attack,
            attackInterval: stats.attackInterval,
            moveSpeed: stats.speed,
            lastAttackTime: 0,
            manualOverride: false,
            detourCount: 0,
            waypoints: [],
            patrolPoints: [],
            orders: [],
          };
          state.units.set(unit.id, unit);
        } else {
          // No passable tile found — refund resources
          const eco = state.economy[teamKey];
          eco.resources.money += order.cost;
          eco.resources.fuel += order.fuelCost;
        }
      }
      queue.shift();
    }
  }
}

// ── 5. Readiness (simplified: average of resource fullness) ──

function updateReadiness(state: GameState): void {
  for (const teamKey of ["player", "enemy"] as const) {
    const eco = state.economy[teamKey];
    const r = eco.resources;
    // Normalize each resource against a "full" threshold
    const moneyFull = Math.min(r.money / 2000, 1);
    const fuelFull = Math.min(r.fuel / 100, 1);
    const ammoFull = Math.min(r.ammo / 100, 1);
    const intelFull = Math.min(r.intel / 50, 1);
    eco.readiness = (moneyFull + fuelFull + ammoFull + intelFull) / 4;
  }
}

// ── Public: enqueue production (validates cost) ──

export function enqueueProduction(
  state: GameState,
  teamKey: "player" | "enemy",
  unitType: UnitType,
): { ok: boolean; reason?: string } {
  const stats = UNIT_STATS[unitType];
  const eco = state.economy[teamKey];

  // Check money
  if (eco.resources.money < stats.cost) {
    return { ok: false, reason: "资金不足" };
  }
  // Check fuel
  if (eco.resources.fuel < stats.fuelCost) {
    return { ok: false, reason: "燃油不足" };
  }

  // Find production facility
  const cat = getUnitCategory(unitType);
  const facType = PRODUCTION_FACILITY[cat];
  let prodFac: Facility | null = null;
  state.facilities.forEach((f) => {
    if (f.type === facType && f.team === teamKey && f.hp > 0 && !prodFac) {
      prodFac = f;
    }
  });
  if (!prodFac) {
    return { ok: false, reason: "无可用生产设施" };
  }

  // Deduct cost
  eco.resources.money -= stats.cost;
  eco.resources.fuel -= stats.fuelCost;

  // P2-1 fix: serialize startTime — queue sequentially after last item
  const queue = state.productionQueue[teamKey];
  let startTime = state.time;
  if (queue.length > 0) {
    const last = queue[queue.length - 1];
    const lastEnd = last.startTime + last.duration;
    if (lastEnd > startTime) startTime = lastEnd;
  }

  const order: ProductionOrder = {
    unitType,
    facilityId: (prodFac as Facility).id,
    startTime,
    duration: stats.buildTime,
    cost: stats.cost,
    fuelCost: stats.fuelCost,
  };
  queue.push(order);
  return { ok: true };
}

// ── Public: consume fuel for unit movement (called from sim.ts) ──

export function consumeMovementFuel(unit: Unit, tilesMoved: number, state: GameState): void {
  if (!isMechanized(unit.type)) return;
  const cost = fuelPerTile(unit.type) * tilesMoved;
  if (cost <= 0) return;
  const ecoKey = unit.team === "player" ? "player" : ("enemy" as const);
  state.economy[ecoKey].resources.fuel = Math.max(
    0,
    state.economy[ecoKey].resources.fuel - cost,
  );
}

// ── Public: check if a mechanized unit can move (fuel > 0) ──

export function canUnitMove(unit: Unit, state: GameState): boolean {
  if (!isMechanized(unit.type)) return true; // infantry always moves
  const ecoKey = unit.team === "player" ? "player" : ("enemy" as const);
  return state.economy[ecoKey].resources.fuel > 0;
}
