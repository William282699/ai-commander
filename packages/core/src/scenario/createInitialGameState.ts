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

  // Commander — deployed near HQ (1 total)
  const commanderUnit = createUnit(uid, "commander", "player", { x: 100, y: 12 });
  commanderUnit.isPlayerControlled = true;
  units.set(uid, commanderUnit);
  uid++;

  // Elite guard — surrounding commander (10 total)
  const elitePositions: [number, number][] = [
    [98, 11], [102, 11], [97, 13], [103, 13], [99, 10],
    [101, 10], [96, 12], [104, 12], [98, 14], [102, 14],
  ];
  for (const [x, y] of elitePositions) {
    const guard = createUnit(uid, "elite_guard", "player", { x, y });
    guard.isPlayerControlled = true;
    units.set(uid, guard);
    uid++;
  }

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

  // === Enemy units (south side) — ~40 total ===

  // Infantry (18 total)
  const enemyInfantry: [number, number][] = [
    [85, 128], [95, 130], [105, 128], [115, 130],
    [45, 112], [155, 120], [75, 126], [125, 128],
    [90, 124], [110, 124], [65, 118], [145, 126],
    [100, 132], [80, 130], [120, 130], [70, 122],
    [140, 122], [100, 126],
  ];
  for (const [x, y] of enemyInfantry) {
    units.set(uid, createUnit(uid, "infantry", "enemy", { x, y }));
    uid++;
  }

  // Light tanks (8 total)
  for (const [x, y] of [
    [40, 108], [150, 118], [130, 126], [145, 132],
    [60, 116], [135, 120], [85, 122], [115, 126],
  ] as [number, number][]) {
    units.set(uid, createUnit(uid, "light_tank", "enemy", { x, y }));
    uid++;
  }

  // Main tanks (6 total)
  for (const [x, y] of [
    [95, 122], [105, 122], [100, 118], [90, 120], [110, 120], [100, 124],
  ] as [number, number][]) {
    units.set(uid, createUnit(uid, "main_tank", "enemy", { x, y }));
    uid++;
  }

  // Artillery (3 total)
  units.set(uid, createUnit(uid, "artillery", "enemy", { x: 100, y: 136 }));
  uid++;
  units.set(uid, createUnit(uid, "artillery", "enemy", { x: 90, y: 134 }));
  uid++;
  units.set(uid, createUnit(uid, "artillery", "enemy", { x: 110, y: 136 }));
  uid++;

  // Patrol boat — strait south shore
  units.set(uid, createUnit(uid, "patrol_boat", "enemy", { x: 130, y: 85 }));
  uid++;

  // === Give a few player scouts movement targets ===

  // NW forest infantry scouts south toward bridge approach (5th infantry = uid offset by 11 commander+guard)
  const scout = units.get(16); // infantry at [35, 28]
  if (scout) {
    scout.target = { x: 40, y: 50 };
    scout.state = "moving";
  }

  // NE light tank patrols east hills (first light tank)
  const flanker = units.get(28); // first light_tank at [140, 20]
  if (flanker) {
    flanker.target = { x: 165, y: 40 };
    flanker.state = "moving";
  }

  // === Build Maps from array data ===

  const facilitiesMap = new Map(FACILITIES.map((f) => [f.id, { ...f }]));
  const regionsMap = new Map(REGIONS.map((r) => [r.id, { ...r }]));
  const chokepointsMap = new Map(CHOKEPOINTS.map((c) => [c.id, { ...c }]));

  // MVP2: Set HQ hp to 3000
  for (const [, fac] of facilitiesMap) {
    if (fac.type === "headquarters") {
      fac.hp = 3000;
      fac.maxHp = 3000;
    }
  }

  // === Phase 2: Squads start empty — commander/elite_guard are mouse-only, not in squads ===
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
    economy: {
      player: makeEconomy(),
      enemy: (() => {
        const eco = makeEconomy();
        eco.resources.money = 3000; // MVP2: enemy starts with more money
        eco.baseIncome = { money: 150, fuel: 30, ammo: 30, intel: 10 }; // 1.5x income
        return eco;
      })(),
    },
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
    doctrines: [],
    doctrineCooldowns: {},
    tasks: [],
    battleMarkers: [],
    recentDeaths: [],
    battleMarkerScanAccum: 0,
    battleMarkerDeathCursor: 0,
    advisorTriggerCooldowns: {},
  };
}
