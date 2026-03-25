// ============================================================
// AI Commander — El Alamein Scenario Entry Point
// Creates a full GameState for the El Alamein scenario
// ============================================================

import type { GameState, EconomyState, Squad } from "@ai-commander/shared";
import {
  UNIT_STATS,
  STARTING_RESOURCES,
  BASE_INCOME,
  DEFAULT_STYLE,
  SUPPLY_INTERVAL_SEC,
} from "@ai-commander/shared";
import {
  generateElAlameinTerrain,
  EL_ALAMEIN_REGIONS,
  EL_ALAMEIN_CHOKEPOINTS,
  EL_ALAMEIN_FACILITIES,
  EL_ALAMEIN_FRONTS,
  EL_ALAMEIN_ROUTES,
  EL_ALAMEIN_OBJECTIVES,
} from "@ai-commander/shared";
import { createFogState } from "../../fog";
import { resetMissionCounter } from "../../missions";
import { deployElAlameinUnits } from "./deployment";

const EL_ALAMEIN_WIDTH = 500;
const EL_ALAMEIN_HEIGHT = 300;

function makeEconomy(): EconomyState {
  return {
    resources: { ...STARTING_RESOURCES },
    readiness: 0,
    baseIncome: { ...BASE_INCOME },
    bonusIncome: { money: 0, fuel: 0, ammo: 0, intel: 0 },
    lastIncomeTime: 0,
  };
}

export function createElAlameinState(): GameState {
  resetMissionCounter();

  const terrain = generateElAlameinTerrain();
  const { units, nextUnitId } = deployElAlameinUnits();

  const facilitiesMap = new Map(EL_ALAMEIN_FACILITIES.map(f => [f.id, { ...f }]));
  const regionsMap = new Map(EL_ALAMEIN_REGIONS.map(r => [r.id, { ...r }]));
  const chokepointsMap = new Map(EL_ALAMEIN_CHOKEPOINTS.map(c => [c.id, { ...c }]));

  // Set HQ hp
  for (const [, fac] of facilitiesMap) {
    if (fac.type === "headquarters") {
      if (fac.team === "player") {
        fac.hp = 3000;
        fac.maxHp = 3000;
      } else {
        fac.hp = 2000;
        fac.maxHp = 2000;
      }
    }
  }

  const squads: Squad[] = [];
  const nextSquadNum: { [prefix: string]: number } = {};

  // El Alamein fog: use scenario-specific dimensions
  const fog = createFogState(EL_ALAMEIN_WIDTH, EL_ALAMEIN_HEIGHT);

  return {
    tick: 0,
    time: 0,
    phase: "WAR", // El Alamein starts in WAR phase (battle is already raging)
    mapWidth: EL_ALAMEIN_WIDTH,
    mapHeight: EL_ALAMEIN_HEIGHT,
    terrain,
    units,
    facilities: facilitiesMap,
    regions: regionsMap,
    chokepoints: chokepointsMap,
    fronts: EL_ALAMEIN_FRONTS.map(f => ({ ...f })),
    economy: {
      player: (() => {
        const eco = makeEconomy();
        eco.resources.money = 3000; // 8th Army well-supplied
        eco.resources.fuel = 150;
        eco.resources.ammo = 150;
        return eco;
      })(),
      enemy: (() => {
        const eco = makeEconomy();
        eco.resources.money = 2000; // Axis supply issues
        eco.resources.fuel = 60;    // Rommel short on fuel
        eco.resources.ammo = 80;
        eco.baseIncome = { money: 80, fuel: 10, ammo: 15, intel: 10 }; // Reduced Axis supply
        return eco;
      })(),
    },
    fog,
    missions: [],
    conditionalOrders: [],
    style: { ...DEFAULT_STYLE },
    productionQueue: { player: [], enemy: [] },
    nextUnitId,
    supplyTimer: SUPPLY_INTERVAL_SEC,
    warDeclared: true, // Already at war
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
    scenarioId: "el_alamein",
    namedRoutes: EL_ALAMEIN_ROUTES.map(r => ({ ...r, waypoints: r.waypoints.map(w => ({ ...w })) })),
    captureObjectives: [...EL_ALAMEIN_OBJECTIVES],
    enemyAIMode: "defensive",
    entrenchTimers: new Map(),
  };
}

export { processDefensiveAI, resetDefensiveAITimer } from "./defensiveAI";
