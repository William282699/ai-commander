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
import type { Squad } from "@ai-commander/shared";
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

  // Infantry squads — spread across north (11 total)
  const playerInfantry: [number, number][] = [
    [85, 20],
    [95, 22],
    [105, 20],
    [115, 22],
    [35, 28], // NW forest scout
    [160, 18], // NE hills scout
    [75, 24],  // extra infantry west
    [125, 20], // extra infantry mid-east
    [90, 26],  // extra infantry center-left
    [110, 26], // extra infantry center-right
    [100, 24], // extra infantry center
  ];
  for (const [x, y] of playerInfantry) {
    units.set(uid, createUnit(uid, "infantry", "player", { x, y }));
    uid++;
  }

  // Main tanks — central formation (5 total)
  for (const [x, y] of [[95, 28], [105, 28], [100, 32], [90, 30], [110, 30]] as [number, number][]) {
    units.set(uid, createUnit(uid, "main_tank", "player", { x, y }));
    uid++;
  }

  // Light tanks — flanking positions (4 total)
  for (const [x, y] of [[140, 20], [150, 22], [130, 24], [145, 18]] as [number, number][]) {
    units.set(uid, createUnit(uid, "light_tank", "player", { x, y }));
    uid++;
  }

  // Artillery — rear (2 total)
  units.set(uid, createUnit(uid, "artillery", "player", { x: 100, y: 16 }));
  uid++;
  units.set(uid, createUnit(uid, "artillery", "player", { x: 110, y: 14 }));
  uid++;

  // Patrol boat — strait north shore
  units.set(uid, createUnit(uid, "patrol_boat", "player", { x: 70, y: 65 }));
  uid++;

  // === Enemy units (south side) ===

  // Infantry (13 total: mirror 11 + 2 extra)
  const enemyInfantry: [number, number][] = [
    [85, 128],
    [95, 130],
    [105, 128],
    [115, 130],
    [45, 112], // SW hills
    [155, 120], // SE forest
    [75, 126],  // mirror extra
    [125, 128], // mirror extra
    [90, 124],  // mirror extra
    [110, 124], // mirror extra
    [65, 118],  // bonus infantry west
    [145, 126], // bonus infantry east
    [100, 132], // bonus infantry center
  ];
  for (const [x, y] of enemyInfantry) {
    units.set(uid, createUnit(uid, "infantry", "enemy", { x, y }));
    uid++;
  }

  // Main tanks (5 total, mirror player)
  for (const [x, y] of [[95, 122], [105, 122], [100, 118], [90, 120], [110, 120]] as [number, number][]) {
    units.set(uid, createUnit(uid, "main_tank", "enemy", { x, y }));
    uid++;
  }

  // Light tanks (4 total, mirror player)
  for (const [x, y] of [[40, 108], [150, 118], [130, 126], [145, 132]] as [number, number][]) {
    units.set(uid, createUnit(uid, "light_tank", "enemy", { x, y }));
    uid++;
  }

  // Artillery (2 total, mirror player)
  units.set(uid, createUnit(uid, "artillery", "enemy", { x: 100, y: 136 }));
  uid++;
  units.set(uid, createUnit(uid, "artillery", "enemy", { x: 90, y: 134 }));
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

  // NE light tank patrols east hills (first light tank)
  const flanker = units.get(17);
  if (flanker) {
    flanker.target = { x: 165, y: 40 };
    flanker.state = "moving";
  }

  // === Build Maps from array data ===

  const facilitiesMap = new Map(FACILITIES.map((f) => [f.id, { ...f }]));
  const regionsMap = new Map(REGIONS.map((r) => [r.id, { ...r }]));
  const chokepointsMap = new Map(CHOKEPOINTS.map((c) => [c.id, { ...c }]));

  // === Phase 2: Squads start empty — player creates them manually ===
  const nextSquadNum: { [prefix: string]: number } = {};
  const squads: Squad[] = [];

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
    phaseStartTime: 0,
    endgameStartTime: null,
    logisticsZeroSec: { player: 0, enemy: 0 },
    warEngageSec: 0,
    gameOverReason: undefined,
    combatEffects: { attackLines: [], explosions: [] },
    diagnostics: [],
    reportEvents: [],
    patrolTasks: [],
    nextPatrolTaskId: 1,
    squads,
    nextSquadNum,
    tags: [],
    nextTagNum: 1,
  };
}
