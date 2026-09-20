// ============================================================
// AI Commander — 教学关地图数据
//
// 设计约束（写在这里，免得将来被"顺手扩充"）：
//  1. **三个可占点，但只有一个是过关目标**：
//       · `tut_player_post` 我方哨站——开局就是你的，用来教"这是我的点"
//       · `tut_beacon` 烽火台（中立，无人守）——教学的**第一次占领**，
//         占下来东边的迷雾自己散（见该设施的注释）
//       · `tut_enemy_post` 敌军哨站——**过关目标**，有人守，最后一步
//     顺序是有意的：先在没有战斗的情况下学会占领机制、拿到一个看得见的奖励，
//     再去打真的。别再加第四个——多一个点就多一份要教的东西。
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
    facilities: ["tut_beacon"],
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
    // ★ 迷雾的钥匙（用户设计 2026-09-03）：教学关第一次占领就是它。
    //
    //  · **中立**不是敌方——第一次占领要**没有战斗**，先把机制教干净，
    //    打仗留给后面的敌军哨站。
    //  · **`radar` 型**：非 el_alamein 分支给 radar 20 格视野（`fog.ts:63`），
    //    而 `updateFog` 只算玩家拥有的设施 ⇒ 占下就自己亮，**零新机制**。
    //  · **(75,40) 是算过的**：到敌军哨站 (92,40) 距离 17（<20，照得到）、
    //    到敌军指挥部 (110,40) 距离 35（>20，照不到）。挪它之前先重算这两个数，
    //    挪错了要么白占（照不到目标）、要么把玩家引向总部那条不该走的通关路。
    id: "tut_beacon",
    name: "烽火台",
    tags: ["beacon", "neutral", "烽火台", "了望塔"],
    type: "radar",
    position: { x: 75, y: 40 },
    team: "neutral",
    hp: 200,
    maxHp: 200,
    regionId: "tut_valley",
    strategicEffect: "Observation tower — reveals the eastern approach once held",
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
    // ★ tut_base 必须在里面：玩家 12 个单位全站在营地区，漏掉它 ⇒
    //   信封写 `OurPwr=0`、马克斯的 ops 面写 `EMPTY?/QUIET` + `KEY_RISKS: None`，
    //   教学第 4 步「问马克斯当前什么情况」他手上一个字都没有。（审核挖出）
    regionIds: ["tut_base", "tut_valley", "tut_ridge"],
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
