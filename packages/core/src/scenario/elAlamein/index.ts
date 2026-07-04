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
        eco.resources.money = 3500; // 5C-lite: bigger pool for 30-min sustained ops
        eco.resources.fuel = 300;
        eco.resources.ammo = 225;
        eco.baseIncome = { money: 120, fuel: 30, ammo: 30, intel: 10 };
        return eco;
      })(),
      enemy: (() => {
        const eco = makeEconomy();
        // 5C-lite v3: fuel restored to 1500 (was 400 in v2.1)
        //   Root cause of v2.1 playtest "armor flood at 60s + stalled tanks"
        //   was P2 massedOffensive firing too early, not fuel being too high.
        //   V3 solves it via PHASE_STRATEGY (P2 gated to 12 min+ in El Alamein).
        //   Fuel is NOT a rhythm lever — it should just cover armor movement.
        //
        // money: 12,500 total (3500 + 150×60) — income +25% 玩家反映 AI 90% sustain vs 玩家 70%
        // fuel:  3,300 total (1500 + 30×60) — ~2.9× of 30-min demand (~1,150)
        // ammo:  2,025 total (225 + 30×60) — 持平玩家, 双方 ~2× demand
        eco.resources.money = 3500;
        eco.resources.fuel = 1500;
        eco.resources.ammo = 225;
        eco.baseIncome = { money: 150, fuel: 30, ammo: 30, intel: 10 };
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
    decisionReviews: [],
    recentDeaths: [],
    battleMarkerScanAccum: 0,
    battleMarkerDeathCursor: 0,
    advisorTriggerCooldowns: {},
    scenarioId: "el_alamein",
    namedRoutes: EL_ALAMEIN_ROUTES.map(r => ({ ...r, waypoints: r.waypoints.map(w => ({ ...w })) })),
    captureObjectives: [...EL_ALAMEIN_OBJECTIVES],
    // Step 5B win/loss tuning: capture ANY 2 of 4 Axis objectives to win,
    // lose 2 of 3 forward keypoints OR run out of time to lose. HQ destroyed
    // and all-commanders-dead are handled by scenario-agnostic checks in warPhase.
    scenarioWinConfig: {
      timeLimitSec: 1800,                  // 30 minutes
      requiredCapturedObjectives: 3,       // 5C-lite: K=3 of 4 Axis objectives
      friendlyKeypoints: [
        "ea_player_coastal_post",
        "ea_player_central_post",
        "ea_player_south_post",
      ],
      maxFriendlyKeypointsLost: 3,         // 5C-lite: all 3 lost → defeat (rating handles partial)
      ratingThresholds: {
        majorVictory: 3, victory: 2, minorVictory: 1,
        draw: 0, minorDefeat: -1, defeat: -2,
      },
    },
    enemyAIMode: "defensive",
    entrenchTimers: new Map(),
  };
}

export { processDefensiveAI, resetDefensiveAITimer } from "./defensiveAI";
