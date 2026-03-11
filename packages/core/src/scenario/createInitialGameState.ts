// ============================================================
// AI Commander — Initial Game State (Day 3)
// Creates a GameState with terrain, facilities, units, fog.
// ============================================================

import type {
  GameState,
  Unit,
  UnitType,
  Team,
  Position,
  EconomyState,
} from "@ai-commander/shared";
import {
  UNIT_STATS,
  STARTING_RESOURCES,
  BASE_INCOME,
  DEFAULT_STYLE,
  SUPPLY_INTERVAL_SEC,
  MAP_WIDTH,
  MAP_HEIGHT,
} from "@ai-commander/shared";
import { createFogState } from "../fog";
import { resetMissionCounter } from "../missions";
import { generateTerrain, FACILITIES, REGIONS, CHOKEPOINTS, FRONTS } from "@ai-commander/shared";

// --- Unit factory ---

function createUnit(
  id: number,
  type: UnitType,
  team: Team,
  position: Position,
): Unit {
  const stats = UNIT_STATS[type];
  return {
    id,
    type,
    team,
    hp: stats.hp,
    maxHp: stats.hp,
    position: { ...position },
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
    patrolTaskId: null,
  };
}

function makeEconomy(): EconomyState {
  return {
    resources: { ...STARTING_RESOURCES },
    readiness: 0,
    baseIncome: { ...BASE_INCOME },
    bonusIncome: { money: 0, fuel: 0, ammo: 0, intel: 0 },
    lastIncomeTime: 0,
  };
}

// --- Initial deployment ---

export function createInitialGameState(): GameState {
  resetMissionCounter(); // Day 11: reset mission ID counter for new game session
  const terrain = generateTerrain();
  const units = new Map<number, Unit>();
  let uid = 1;

  // === Player units (north side) ===

  // Infantry squads — spread across north
  const playerInfantry: [number, number][] = [
    [85, 20],
    [95, 22],
    [105, 20],
    [115, 22],
    [35, 28], // NW forest scout
    [160, 18], // NE hills scout
  ];
  for (const [x, y] of playerInfantry) {
    units.set(uid, createUnit(uid, "infantry", "player", { x, y }));
    uid++;
  }

  // Main tanks — central formation
  for (const [x, y] of [[95, 28], [105, 28], [100, 32]] as [number, number][]) {
    units.set(uid, createUnit(uid, "main_tank", "player", { x, y }));
    uid++;
  }

  // Light tanks — flanking positions
  for (const [x, y] of [[140, 20], [150, 22]] as [number, number][]) {
    units.set(uid, createUnit(uid, "light_tank", "player", { x, y }));
    uid++;
  }

  // Artillery — rear
  units.set(uid, createUnit(uid, "artillery", "player", { x: 100, y: 16 }));
  uid++;

  // Patrol boat — strait north shore
  units.set(uid, createUnit(uid, "patrol_boat", "player", { x: 70, y: 65 }));
  uid++;

  // === Enemy units (south side) ===

  // Infantry
  const enemyInfantry: [number, number][] = [
    [85, 128],
    [95, 130],
    [105, 128],
    [115, 130],
    [45, 112], // SW hills
    [155, 120], // SE forest
  ];
  for (const [x, y] of enemyInfantry) {
    units.set(uid, createUnit(uid, "infantry", "enemy", { x, y }));
    uid++;
  }

  // Main tanks
  for (const [x, y] of [[95, 122], [105, 122], [100, 118]] as [number, number][]) {
    units.set(uid, createUnit(uid, "main_tank", "enemy", { x, y }));
    uid++;
  }

  // Light tanks
  for (const [x, y] of [[40, 108], [150, 118]] as [number, number][]) {
    units.set(uid, createUnit(uid, "light_tank", "enemy", { x, y }));
    uid++;
  }

  // Artillery
  units.set(uid, createUnit(uid, "artillery", "enemy", { x: 100, y: 136 }));
  uid++;

  // Patrol boat — strait south shore
  units.set(uid, createUnit(uid, "patrol_boat", "enemy", { x: 130, y: 85 }));
  uid++;

  // === Give a few player scouts movement targets ===

  // NW forest infantry scouts south toward bridge approach
  const scout = units.get(5);
  if (scout) {
    scout.target = { x: 40, y: 50 };
    scout.state = "moving";
  }

  // NE light tank patrols east hills
  const flanker = units.get(10);
  if (flanker) {
    flanker.target = { x: 165, y: 40 };
    flanker.state = "moving";
  }

  // === Build Maps from array data ===

  const facilitiesMap = new Map(FACILITIES.map((f) => [f.id, { ...f }]));
  const regionsMap = new Map(REGIONS.map((r) => [r.id, { ...r }]));
  const chokepointsMap = new Map(CHOKEPOINTS.map((c) => [c.id, { ...c }]));

  return {
    tick: 0,
    time: 0,
    phase: "PEACE",
    mapWidth: MAP_WIDTH,
    mapHeight: MAP_HEIGHT,
    terrain,
    units,
    facilities: facilitiesMap,
    regions: regionsMap,
    chokepoints: chokepointsMap,
    fronts: FRONTS.map((f) => ({ ...f })),
    economy: { player: makeEconomy(), enemy: makeEconomy() },
    fog: createFogState(),
    missions: [],
    conditionalOrders: [],
    style: { ...DEFAULT_STYLE },
    productionQueue: { player: [], enemy: [] },
    nextUnitId: uid,
    supplyTimer: SUPPLY_INTERVAL_SEC,
    warDeclared: false,
    gameOver: false,
    winner: null,
    combatEffects: { attackLines: [], explosions: [] },
    diagnostics: [],
    patrolTasks: [],
    nextPatrolTaskId: 1,
    squads: [],
    nextSquadNum: {},
  };
}
