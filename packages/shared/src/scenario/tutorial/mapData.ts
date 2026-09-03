// ============================================================
// AI Commander — 教学关地图数据
//
// 设计约束（写在这里，免得将来被"顺手扩充"）：
//  1. **两个据点**——我方一个、敌方一个。敌方那个就是过关目标。
//     多一个据点就多一份要教的东西，教学关不背这个。
//  2. **地名必须好念**。参谋说话全靠地名；玩家要能把听到的名字原样说回去
//     （撞过账：语音识别听不懂音译名）。所以三个地名都是常用字。
//  3. **一条战线**。马克斯要有东西可报；零战线时判读行会空掉。
//  4. 设施类型不是随便挑的：敌方哨站必须是**可占**类型（`radar`），
//     而 `barracks`/`headquarters` 在引擎黑名单里（economy.ts NON_CAPTURABLE），
//     选错了就永远打不下来、教学关直接死在最后一步。
// ============================================================

import type { Region, Chokepoint, Facility, Front } from "../../types";

// --- 分区（＝地名的来源）---

export const TUTORIAL_REGIONS: Region[] = [
  {
    id: "tut_base",
    name: "我军营地",
    bbox: [4, 20, 40, 60],
    terrainMix: { urban: 0.3, plains: 0.5, road: 0.2 },
    passability: { armor: true, infantry: true, naval: false },
    chokepoints: [],
    adjacent: ["tut_valley"],
    strategicValue: ["base", "production"],
    facilities: ["tut_player_hq", "tut_player_barracks", "tut_player_post"],
  },
  {
    id: "tut_valley",
    name: "中央谷地",
    bbox: [40, 15, 80, 65],
    terrainMix: { plains: 0.8, road: 0.2 },
    passability: { armor: true, infantry: true, naval: false },
    chokepoints: [],
    adjacent: ["tut_base", "tut_ridge"],
    strategicValue: ["open_ground", "approach"],
    facilities: [],
  },
  {
    id: "tut_ridge",
    name: "东岭",
    bbox: [80, 20, 116, 60],
    terrainMix: { hills: 0.7, plains: 0.2, road: 0.1 },
    passability: { armor: true, infantry: true, naval: false },
    chokepoints: [],
    adjacent: ["tut_valley"],
    strategicValue: ["high_ground", "objective"],
    facilities: ["tut_enemy_post", "tut_enemy_hq"],
  },
];

// 教学关不设隘口：卡住新手的东西越少越好。
export const TUTORIAL_CHOKEPOINTS: Chokepoint[] = [];

// --- 设施 ---

export const TUTORIAL_FACILITIES: Facility[] = [
  {
    id: "tut_player_hq",
    name: "我军指挥部",
    type: "headquarters",
    tags: ["hq", "player", "我军指挥部", "指挥部"],
    position: { x: 14, y: 40 },
    team: "player",
    hp: 3000,
    maxHp: 3000,
    regionId: "tut_base",
    strategicEffect: "Command center",
    captureProgress: 0,
    capturingTeam: null,
  },
  {
    id: "tut_player_barracks",
    name: "我军兵营",
    type: "barracks",
    tags: ["barracks", "ground production", "player", "我军兵营", "兵营"],
    position: { x: 22, y: 48 },
    team: "player",
    hp: 500,
    maxHp: 500,
    regionId: "tut_base",
    strategicEffect: "Produces ground units",
    captureProgress: 0,
    capturingTeam: null,
  },
  {
    id: "tut_player_post",
    name: "我方哨站",
    type: "comm_tower",
    tags: ["forward", "keypoint", "player", "我方哨站", "哨站"],
    position: { x: 36, y: 30 },
    team: "player",
    hp: 350,
    maxHp: 350,
    regionId: "tut_base",
    strategicEffect: "Forward observation post",
    captureProgress: 0,
    capturingTeam: null,
  },
  {
    // ★ 教学关的过关目标。类型必须可占（见档头约束 4）。
    id: "tut_enemy_post",
    name: "敌军哨站",
    type: "radar",
    tags: ["forward", "keypoint", "enemy", "敌军哨站", "敌人哨站"],
    position: { x: 92, y: 40 },
    team: "enemy",
    hp: 350,
    maxHp: 350,
    regionId: "tut_ridge",
    strategicEffect: "Enemy forward radar post",
    captureProgress: 0,
    capturingTeam: null,
  },
  {
    id: "tut_enemy_hq",
    name: "敌军指挥部",
    type: "headquarters",
    tags: ["hq", "enemy", "敌军指挥部"],
    position: { x: 110, y: 40 },
    team: "enemy",
    hp: 2000,
    maxHp: 2000,
    regionId: "tut_ridge",
    strategicEffect: "Enemy command center",
    captureProgress: 0,
    capturingTeam: null,
  },
];

// --- 战线（马克斯/陈的判读行按它组织）---

export const TUTORIAL_FRONTS: Front[] = [
  {
    id: "tut_front_center",
    name: "中央战线",
    regionIds: ["tut_valley", "tut_ridge"],
    playerPower: 0,
    enemyPower: 0,
    enemyPowerKnown: false,
    engagementIntensity: 0,
    supplyStatus: "OK",
    keyEvents: [],
  },
];

export const TUTORIAL_CAMERA_TARGETS: Record<string, { x: number; y: number }> = {
  tut_front_center: { x: 70, y: 40 },
};

/** 过关＝打下敌军哨站这一个目标（`requiredCapturedObjectives: 1`）。 */
export const TUTORIAL_OBJECTIVES: string[] = ["tut_enemy_post"];
