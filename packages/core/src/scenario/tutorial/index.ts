// ============================================================
// AI Commander — 教学关入口：造一份完整 GameState
//
// 与 El Alamein 的四处**有意不同**（改之前先读理由）：
//
//  1. **显式 `enemyAIMode: "none"`**——必须显式，不能靠"不写"。
//     ★ 这是审核窗当场推翻过的一条，值得留成教训：本文件第一版**不设**这个字段，
//     并宣称"敌人不主动动"。**错的。** 两套敌方 AI 由同一个字段**互斥**，而闸的
//     方向相反：
//       · `defensiveAI.ts:259` 正向——`!== "defensive"` 就 return
//       · `enemyAI.ts:64` 反向——`=== "defensive"` 才 return
//     所以"字段缺席"不等于"没有敌方 AI"，而等于"跑老的那套 `runEnemyAI`"。
//     审核实测（N=8×300s）：敌军每次都向西游进中央谷地，3/8 次哨站 8 格内无兵
//     ——守军离岗，第 5 步的布景不稳。
//     修法＝给这个选择器补上"关"这一档（`"none"`），两道反向闸一起认它
//     （`enemyAI.ts`、`battleAwareness.ts`）。
//     `processPressureDirector` 另有 `scenarioId !== "el_alamein"` 的真闸，
//     波次与后期剧本拳本来就不会来。
//
//  2. **过关只要 1 个目标**（打下敌军哨站）。`maxFriendlyKeypointsLost=2` 而我方
//     只有 1 个据点 ⇒ `lostCount` 最大是 1，**"失守前哨"那条败北路永不触发**。
//     ★ 但**别读成"教学关输不了"**（第一版就是这么写的，说满了）：
//     `warPhase.ts` 里还有**三条**场景无关的路通着——
//       · :179 我方总部 hp<=0 → 判负
//       · :147 到 `timeLimitSec` → `endGameWithRating` 结算（0 夺 0 失＝平局）
//       · :189 敌方总部被摧毁 → **判胜**（第二条通关路，审核挖出）
//     最后一条**用户裁定留着不管**（2026-09-03）：玩家要推到 (110,40) 打爆
//     2000 血的总部，比打 (92,40) 的哨站难得多，实际走不到；而删掉敌方总部
//     会让 `findTeamHQ` 拿不到东西（残血撤退要用）。教学只引导争夺哨站。
//
//  3. **迷雾留着，用烽火台当钥匙**（用户设计 2026-09-03）：中立的 `tut_beacon`
//     是 `radar` 型，非 el_alamein 分支给 radar **20 格**视野，而 `updateFog`
//     只算**玩家拥有**的设施 ⇒ 占下它，东边自己亮。位置 (75,40) 是算过的：
//     到敌军哨站 (92,40) 距离 17 **照得到**，到敌军指挥部 (110,40) 距离 35
//     **照不到**——正好把玩家往哨站引、不往总部引（呼应第 2 条的裁定）。
//     **零新机制**：没有为"占领后开雾"写任何特判，靠的是既有的设施视野。
//
//  4. **时限 30 分钟**是兜底不是设计——教学预期 3-5 分钟走完。
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
      victoryLabel: "训练完成——您已经会指挥了。",
      friendlyKeypoints: ["tut_player_post"],
      // ★ 2 > 我方据点数(1) ⇒ lostCount 最大 1，这条败北路永不触发。
      //   注意不等于"输不了"——总部被摧毁/到点结算两条仍在（见档头 2）。
      maxFriendlyKeypointsLost: 2,
      ratingThresholds: {
        majorVictory: 1, victory: 1, minorVictory: 1,
        draw: 0, minorDefeat: -1, defeat: -2,
      },
    },
    enemyAIMode: "none",   // 见档头 1：必须显式关，缺席＝跑老的那套
    entrenchTimers: new Map(),
  };
}
