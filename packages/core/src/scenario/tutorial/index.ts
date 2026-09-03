// ============================================================
// AI Commander — 教学关入口：造一份完整 GameState
//
// 与 El Alamein 的三处**有意不同**（改之前先读理由）：
//
//  1. **不设 `enemyAIMode`**。`processDefensiveAI` 的闸是
//     `state.enemyAIMode !== "defensive"` ——**它不看 scenarioId**
//     （GameCanvas 那行 "no-op for other scenarios" 的注释是错的）。
//     不设 ⇒ 那 2298 行防御 AI 整个不跑，敌人只会被打了还手。
//     教学关要的就是这个：新手不该被主动扑上来的 AI 打断。
//     `processPressureDirector` 另有 `scenarioId !== "el_alamein"` 的真闸，
//     所以波次与后期剧本拳也一并不会来。
//
//  2. **过关只要 1 个目标**（打下敌军哨站）。`maxFriendlyKeypointsLost=2` 而我方
//     只有 1 个据点 ⇒ `lostCount` 最大是 1，**"失守前哨"那条败北路永不触发**。
//     ★ 但**别读成"教学关输不了"**（我第一版就是这么写的，说满了）：
//     `warPhase.ts` 里还有两条**场景无关**的路仍然通着——
//       · :179 我方总部 hp<=0 → 判负
//       · :147 到 `timeLimitSec` → `endGameWithRating` 结算（0 夺 0 失＝score 0＝平局）
//     实际打不到，是因为敌人根本不会推进（见 1）——那是**行为上打不到**，
//     不是**结构上不可能**。将来谁给教学关加了会动的敌人，这两条立刻活过来。
//
//  3. **时限 30 分钟**是兜底不是设计——教学预期 3-5 分钟走完。
//     `timeLimitSec` 是必填字段，给个宽松值，不是让玩家去卡时间。
// ============================================================

import type { GameState, EconomyState, Squad } from "@ai-commander/shared";
import {
  STARTING_RESOURCES,
  BASE_INCOME,
  DEFAULT_STYLE,
  SUPPLY_INTERVAL_SEC,
} from "@ai-commander/shared";
import {
  generateTutorialTerrain,
  TUTORIAL_WIDTH,
  TUTORIAL_HEIGHT,
  TUTORIAL_REGIONS,
  TUTORIAL_CHOKEPOINTS,
  TUTORIAL_FACILITIES,
  TUTORIAL_FRONTS,
  TUTORIAL_OBJECTIVES,
} from "@ai-commander/shared";
import { createFogState } from "../../fog";
import { resetMissionCounter } from "../../missions";
import { deployTutorialUnits } from "./deployment";

function makeEconomy(): EconomyState {
  return {
    resources: { ...STARTING_RESOURCES },
    readiness: 0,
    baseIncome: { ...BASE_INCOME },
    bonusIncome: { money: 0, fuel: 0, ammo: 0, intel: 0 },
    lastIncomeTime: 0,
  };
}

export function createTutorialState(): GameState {
  resetMissionCounter();

  const terrain = generateTutorialTerrain();
  const { units, nextUnitId } = deployTutorialUnits();

  const facilitiesMap = new Map(TUTORIAL_FACILITIES.map(f => [f.id, { ...f }]));
  const regionsMap = new Map(TUTORIAL_REGIONS.map(r => [r.id, { ...r }]));
  const chokepointsMap = new Map(TUTORIAL_CHOKEPOINTS.map(c => [c.id, { ...c }]));

  const squads: Squad[] = [];
  const nextSquadNum: { [prefix: string]: number } = {};

  const fog = createFogState(TUTORIAL_WIDTH, TUTORIAL_HEIGHT);

  return {
    tick: 0,
    time: 0,
    phase: "WAR",
    mapWidth: TUTORIAL_WIDTH,
    mapHeight: TUTORIAL_HEIGHT,
    terrain,
    units,
    facilities: facilitiesMap,
    regions: regionsMap,
    chokepoints: chokepointsMap,
    fronts: TUTORIAL_FRONTS.map(f => ({ ...f })),
    economy: {
      player: (() => {
        const eco = makeEconomy();
        // 够艾米莉当场造几个兵（教学第 3 步），不多给——教学不教理财。
        eco.resources.money = 2000;
        eco.resources.fuel = 200;
        eco.resources.ammo = 150;
        eco.baseIncome = { money: 120, fuel: 30, ammo: 30, intel: 10 };
        return eco;
      })(),
      enemy: (() => {
        const eco = makeEconomy();
        eco.resources.money = 500;
        eco.resources.fuel = 200;
        eco.resources.ammo = 150;
        eco.baseIncome = { money: 0, fuel: 0, ammo: 0, intel: 0 };
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
    warDeclared: true,
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
    scenarioId: "tutorial",
    namedRoutes: [],
    captureObjectives: [...TUTORIAL_OBJECTIVES],
    scenarioWinConfig: {
      timeLimitSec: 1800,
      requiredCapturedObjectives: 1,     // 打下敌军哨站即过关
      friendlyKeypoints: ["tut_player_post"],
      // ★ 2 > 我方据点数(1) ⇒ lostCount 最大 1，这条败北路永不触发。
      //   注意不等于"输不了"——总部被摧毁/到点结算两条仍在（见档头 2）。
      maxFriendlyKeypointsLost: 2,
      ratingThresholds: {
        majorVictory: 1, victory: 1, minorVictory: 1,
        draw: 0, minorDefeat: -1, defeat: -2,
      },
    },
    // enemyAIMode 有意缺席——见档头 1
    entrenchTimers: new Map(),
  };
}
