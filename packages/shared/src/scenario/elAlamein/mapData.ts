// ============================================================
// AI Commander — El Alamein Map Data
// Regions, Facilities, Fronts, Routes, Chokepoints
// 500×300 map: British 8th Army (E) vs Afrika Korps (W)
// ============================================================

import type { Region, Chokepoint, Facility, Front, NamedRoute } from "../../types";

// ──────────────────────────────────────────────
// Regions
// ──────────────────────────────────────────────

export const EL_ALAMEIN_REGIONS: Region[] = [
  // === British 8th Army (Player, East x:370-490) ===
  {
    id: "british_hq_area",
    name: "我军总部区",
    bbox: [370, 60, 490, 160],
    terrainMix: { plains: 0.5, urban: 0.2, road: 0.2, hills: 0.1 },
    passability: { armor: true, infantry: true, naval: false },
    chokepoints: [],
    adjacent: ["central_desert", "northern_coastal", "southern_desert"],
    strategicValue: ["headquarters", "production"],
    facilities: ["ea_player_hq", "ea_player_barracks", "ea_player_airfield", "ea_repair_station"],
  },

  // === Northern Coastal Zone ===
  //
  // envelope-precision 刀3 (2026-08-07): the south edge came down 55 → 44 so the
  // northern ridge VP (220,55) belongs to ONE front. The eastern half of the old
  // strip (x316-490 × y45-55) is the HQ→north supply corridor and had nothing to
  // catch it, so `northern_coastal_e` below picks it up — same front, no gap.
  // Parent-before-child array order is load-bearing: getRegionCenter matches by
  // fuzzy `includes` and returns the FIRST hit, so "北部沿海" must keep meaning
  // this block, not the new east segment.
  {
    id: "northern_coastal",
    name: "北部沿海",
    bbox: [200, 22, 490, 44],
    terrainMix: { road: 0.3, plains: 0.3, hills: 0.2, urban: 0.2 },
    passability: { armor: true, infantry: true, naval: false },
    chokepoints: [],
    adjacent: ["british_hq_area", "tel_el_eisa", "kidney_ridge_zone", "minefield_zone_n", "northern_coastal_e"],
    strategicValue: ["highway", "coastal_approach"],
    facilities: ["ea_alamein_town", "ea_player_coastal_post"],
  },
  {
    id: "northern_coastal_e",
    name: "北部沿海东段",
    bbox: [316, 45, 490, 55],
    terrainMix: { road: 0.3, plains: 0.4, hills: 0.1, urban: 0.2 },
    passability: { armor: true, infantry: true, naval: false },
    chokepoints: [],
    adjacent: ["northern_coastal", "british_hq_area"],
    strategicValue: ["highway", "coastal_approach"],
    facilities: [],
    hideMapLabel: true, // fix A：归属判定要的子块，不是长官要看的地名
  },
  {
    id: "tel_el_eisa",
    name: "北沿海高地",
    bbox: [225, 26, 260, 44],
    terrainMix: { hills: 0.7, plains: 0.2, urban: 0.1 },
    passability: { armor: true, infantry: true, naval: false },
    chokepoints: [],
    adjacent: ["northern_coastal", "kidney_ridge_zone"],
    strategicValue: ["high_ground", "observation"],
    facilities: ["ea_comm_tower"],
  },

  // === Central Ridge Zone ===
  {
    id: "kidney_ridge_zone",
    name: "北部山脊区",
    bbox: [200, 45, 260, 75],
    terrainMix: { hills: 0.6, plains: 0.2, swamp: 0.2 },
    passability: { armor: true, infantry: true, naval: false },
    chokepoints: [],
    adjacent: ["tel_el_eisa", "miteirya_ridge_zone", "minefield_zone", "northern_coastal"],
    strategicValue: ["high_ground", "defensive_position"],
    facilities: ["ea_kidney_ridge"],
  },
  {
    id: "miteirya_ridge_zone",
    name: "中央山脊区",
    bbox: [210, 55, 260, 80],
    terrainMix: { hills: 0.5, plains: 0.2, swamp: 0.3 },
    passability: { armor: true, infantry: true, naval: false },
    chokepoints: [],
    adjacent: ["kidney_ridge_zone", "ruweisat_zone", "minefield_zone"],
    strategicValue: ["high_ground", "breakthrough_point"],
    facilities: ["ea_miteirya_ridge"],
  },

  // === Minefield Zone (Devil's Gardens) ===
  //
  // 刀3: the old single rectangle [248,38,315,125] straddled three fronts at once.
  // Split north/south; x248-260 goes back to the ridge blocks that already cover
  // it and y≤44 to the coast. NOTE (R15, registered): the PAINTED minefield is
  // terrainGen's fill(255,42,308,118) — after the split roughly 1100 painted tiles
  // sit in ridge blocks rather than in a region named 雷区. That is a map-narration
  // mismatch only: nothing reads region.passability/terrainMix (movement reads
  // state.terrain), so armour still cannot drive through the mines.
  {
    id: "minefield_zone",
    name: "魔鬼花园雷区",
    bbox: [276, 85, 315, 125],
    terrainMix: { swamp: 0.6, plains: 0.3, hills: 0.1 },
    passability: { armor: false, infantry: true, naval: false },
    chokepoints: [],
    adjacent: ["minefield_zone_n", "ruweisat_zone", "central_desert"],
    strategicValue: ["obstacle", "minefield"],
    facilities: ["ea_fuel_depot"],
  },
  {
    id: "minefield_zone_n",
    name: "魔鬼花园雷区北段",
    bbox: [261, 45, 315, 80],
    terrainMix: { swamp: 0.6, plains: 0.3, hills: 0.1 },
    passability: { armor: false, infantry: true, naval: false },
    chokepoints: [],
    adjacent: ["northern_coastal", "kidney_ridge_zone", "miteirya_ridge_zone", "minefield_zone", "central_desert"],
    strategicValue: ["obstacle", "minefield"],
    facilities: [],
    hideMapLabel: true, // fix A：归属判定要的子块，不是长官要看的地名
  },

  // === Central Desert ===
  // ruweisat's north edge 85 → 81 (R12): the 5-row seam x230-260 × y81-84 left by
  // the minefield split had an enemy main tank standing in it at turn 0 — a unit
  // that belongs to no front is invisible to every power/judgment/crisis reader.
  {
    id: "ruweisat_zone",
    // 改名刀：「中部山脊」→「乱石岭」（只改显示名，id 不动）。旧名作为可说的地名
    // 挂在 ea_observation_post.tags 里保住——region 本身没有别名字段。
    name: "乱石岭",
    bbox: [230, 81, 275, 115],
    terrainMix: { hills: 0.5, plains: 0.3, road: 0.2 },
    passability: { armor: true, infantry: true, naval: false },
    chokepoints: [],
    adjacent: ["miteirya_ridge_zone", "central_desert", "central_desert_s", "minefield_zone", "southern_desert"],
    strategicValue: ["high_ground", "central_position"],
    facilities: ["ea_observation_post"],
  },
  // 刀3: the old [120,80,370,140] swallowed the Axis rear whole (60×60) and the
  // ruweisat ridge entirely. Split into three; the EAST block keeps the id and the
  // name so `ea_player_central_post` keeps its regionId and "中央沙漠" as a spoken
  // destination keeps meaning a place on our side of the line. Array order matters:
  // getRegionCenter takes the FIRST fuzzy `includes` hit, so the parent stays first.
  {
    id: "central_desert",
    name: "中央沙漠",
    bbox: [276, 80, 370, 137],
    terrainMix: { plains: 0.6, road: 0.2, hills: 0.2 },
    passability: { armor: true, infantry: true, naval: false },
    chokepoints: [],
    adjacent: ["ruweisat_zone", "british_hq_area", "minefield_zone", "minefield_zone_n", "central_desert_s", "southern_desert"],
    strategicValue: ["open_terrain"],
    facilities: ["ea_player_central_post"],
  },
  {
    id: "central_desert_w",
    name: "中央沙漠西段",
    bbox: [181, 81, 229, 137],
    terrainMix: { plains: 0.6, road: 0.2, hills: 0.2 },
    passability: { armor: true, infantry: true, naval: false },
    chokepoints: [],
    adjacent: ["axis_rear", "miteirya_ridge_zone", "central_desert_s", "southern_desert"],
    strategicValue: ["open_terrain"],
    facilities: [],
    hideMapLabel: true, // fix A：归属判定要的子块，不是长官要看的地名
  },
  {
    id: "central_desert_s",
    name: "中央沙漠南缘",
    bbox: [230, 116, 275, 137],
    terrainMix: { plains: 0.6, road: 0.2, hills: 0.2 },
    passability: { armor: true, infantry: true, naval: false },
    chokepoints: [],
    adjacent: ["ruweisat_zone", "central_desert", "central_desert_w", "southern_desert"],
    strategicValue: ["open_terrain"],
    facilities: [],
    hideMapLabel: true, // fix A：归属判定要的子块，不是长官要看的地名
  },

  // === Southern Sector ===
  {
    id: "southern_desert",
    name: "南部沙漠",
    bbox: [200, 140, 400, 225],
    terrainMix: { plains: 0.4, hills: 0.4, road: 0.2 },
    passability: { armor: true, infantry: true, naval: false },
    chokepoints: [],
    adjacent: ["central_desert", "central_desert_w", "central_desert_s", "british_hq_area", "himeimat_zone", "alam_halfa_zone"],
    strategicValue: ["flanking_route"],
    facilities: ["ea_ammo_depot"],
  },
  {
    id: "alam_halfa_zone",
    name: "南部山脊区",
    bbox: [320, 138, 365, 165],
    terrainMix: { hills: 0.7, plains: 0.3 },
    passability: { armor: true, infantry: true, naval: false },
    chokepoints: [],
    adjacent: ["southern_desert", "british_hq_area"],
    strategicValue: ["high_ground", "defensive_anchor"],
    facilities: ["ea_player_south_post"],
  },
  {
    id: "himeimat_zone",
    name: "南部高地区",
    bbox: [230, 205, 275, 232],
    terrainMix: { hills: 0.6, plains: 0.2, swamp: 0.2 },
    passability: { armor: true, infantry: true, naval: false },
    chokepoints: [],
    adjacent: ["southern_desert", "axis_rear"],
    strategicValue: ["high_ground", "southern_anchor"],
    facilities: ["ea_himeimat"],
  },

  // === Axis Rear Area (West x:10-180) ===
  {
    id: "axis_rear",
    name: "轴心后方",
    bbox: [10, 40, 180, 200],
    terrainMix: { plains: 0.5, road: 0.2, urban: 0.2, hills: 0.1 },
    passability: { armor: true, infantry: true, naval: false },
    chokepoints: [],
    adjacent: ["central_desert_w", "himeimat_zone", "kidney_ridge_zone", "miteirya_ridge_zone"],
    strategicValue: ["headquarters", "production", "supply_base"],
    facilities: ["ea_rommel_hq", "ea_axis_barracks", "ea_axis_airfield", "ea_axis_barracks2"],
  },
];

// ──────────────────────────────────────────────
// Chokepoints — minefield gaps
// ──────────────────────────────────────────────

export const EL_ALAMEIN_CHOKEPOINTS: Chokepoint[] = [
  {
    id: "minefield_gap_north",
    name: "北部雷区缺口",
    position: { x: 271, y: 55 },
    type: "pass",
    connects: ["kidney_ridge_zone", "minefield_zone"],
    passableFor: ["infantry"],
    destructible: false,
    hp: 100,
    maxHp: 100,
  },
  {
    id: "minefield_gap_center",
    name: "中央雷区缺口",
    position: { x: 291, y: 80 },
    type: "pass",
    connects: ["ruweisat_zone", "minefield_zone"],
    passableFor: ["infantry"],
    destructible: false,
    hp: 100,
    maxHp: 100,
  },
];

// ──────────────────────────────────────────────
// Facilities
// ──────────────────────────────────────────────

export const EL_ALAMEIN_FACILITIES: Facility[] = [
  // === British (Player) Base Facilities ===
  {
    id: "ea_player_hq",
    name: "我军总部",
    type: "headquarters",
    tags: ["HQ", "headquarters", "Montgomery", "command", "我军总部", "蒙哥马利总部", "Montgomery HQ"],
    position: { x: 430, y: 90 },
    team: "player",
    hp: 3000,
    maxHp: 3000,
    regionId: "british_hq_area",
    strategicEffect: "Game over if destroyed",
    captureProgress: 0,
    capturingTeam: null,
  },
  {
    id: "ea_player_barracks",
    name: "我军兵营",
    type: "barracks",
    tags: ["barracks", "infantry", "ground production", "我军兵营", "步兵营房", "8th Army Barracks"],
    position: { x: 410, y: 75 },
    team: "player",
    hp: 500,
    maxHp: 500,
    regionId: "british_hq_area",
    strategicEffect: "Produces ground units",
    captureProgress: 0,
    capturingTeam: null,
  },
  {
    id: "ea_player_airfield",
    name: "我军机场",
    type: "airfield",
    tags: ["airfield", "RAF", "air production", "我军机场", "沙漠空军基地", "Desert Air Force Base"],
    position: { x: 450, y: 130 },
    team: "player",
    hp: 500,
    maxHp: 500,
    regionId: "british_hq_area",
    strategicEffect: "Produces air units",
    captureProgress: 0,
    capturingTeam: null,
  },
  {
    id: "ea_repair_station",
    name: "野战修理厂",
    type: "repair_station",
    tags: ["repair", "maintenance", "野战修理厂", "修理厂", "Field Repair Depot"],
    position: { x: 400, y: 90 },
    team: "player",
    hp: 300,
    maxHp: 300,
    regionId: "british_hq_area",
    strategicEffect: "Nearby units +2% HP/s",
    captureProgress: 0,
    capturingTeam: null,
  },

  // === Objectives (Enemy-held, must capture) ===
  {
    id: "ea_alamein_town",
    name: "阿拉曼镇",
    type: "comm_tower",
    tags: ["alamein", "town", "railway", "据点", "敌一号", "阿拉曼", "阿拉曼镇", "El Alamein"],
    position: { x: 280, y: 30 },
    team: "enemy",
    hp: 400,
    maxHp: 400,
    regionId: "northern_coastal",
    strategicEffect: "Coastal strongpoint + rail junction",
    captureProgress: 0,
    capturingTeam: null,
  },
  {
    id: "ea_kidney_ridge",
    name: "北部山脊",
    type: "radar",
    tags: ["kidney", "ridge", "strongpoint", "据点", "敌二号", "北部山脊", "北线山脊", "Kidney Ridge"],
    position: { x: 220, y: 55 },
    team: "enemy",
    hp: 400,
    maxHp: 400,
    regionId: "kidney_ridge_zone",
    strategicEffect: "Northern high ground + observation",
    captureProgress: 0,
    capturingTeam: null,
  },
  {
    id: "ea_miteirya_ridge",
    // 改名刀（第 8 级，用户二轮拍板 2026-08-07）：「中央山脊」→「驼峰山脊」。
    // 「中央」这个命名空间里挤了五个东西——中央战线 / 中央沙漠 / 中央前哨（我方）
    // / 中央山脊（敌 VP）/ 中央雷达（中立）——长官说「中央」时，模型抓错邻居是
    // 结构性的，不是措辞不小心。拆的是敌方侧那两个，玩家侧三个一个字不动。
    // 定名取语音识别友好的常用词（音译名「米泰里亚」在二轮被否）。
    // 只改显示名，id 不动；旧名留在下面 tags[] 里当别名——加不减（I2 家法），
    // 长官的旧习惯与 STT 照旧解析。tags 从不进信封，纯解析用，零字节代价。
    name: "驼峰山脊",
    type: "radar",
    tags: ["miteirya", "ridge", "strongpoint", "据点", "敌三号", "中央山脊", "驼峰山脊", "Miteirya Ridge"],
    position: { x: 230, y: 70 },
    team: "enemy",
    hp: 400,
    maxHp: 400,
    regionId: "miteirya_ridge_zone",
    strategicEffect: "Key breakthrough point",
    captureProgress: 0,
    capturingTeam: null,
  },
  {
    id: "ea_himeimat",
    name: "南部高地",
    type: "radar",
    tags: ["himeimat", "heights", "southern", "据点", "敌四号", "南部高地", "南线高地", "Himeimat Heights"],
    position: { x: 250, y: 220 },
    team: "enemy",
    hp: 400,
    maxHp: 400,
    regionId: "himeimat_zone",
    strategicEffect: "Southern high ground",
    captureProgress: 0,
    capturingTeam: null,
  },
  {
    id: "ea_rommel_hq",
    name: "敌军总部",
    type: "headquarters",
    tags: ["Rommel", "HQ", "headquarters", "据点", "command", "敌军总部", "隆美尔总部", "Rommel HQ"],
    position: { x: 80, y: 100 },
    team: "enemy",
    hp: 2000,
    maxHp: 2000,
    regionId: "axis_rear",
    strategicEffect: "Axis command center — final objective",
    captureProgress: 0,
    capturingTeam: null,
  },

  // === Capturable neutral facilities ===
  {
    id: "ea_fuel_depot",
    name: "前线油库",
    type: "fuel_depot",
    tags: ["fuel", "oil", "supply", "前线油库", "油库", "Forward Fuel Dump"],
    position: { x: 310, y: 100 },
    team: "neutral",
    hp: 400,
    maxHp: 400,
    regionId: "minefield_zone",
    strategicEffect: "+30 Fuel/30s",
    captureProgress: 0,
    capturingTeam: null,
  },
  {
    id: "ea_ammo_depot",
    name: "沙漠弹药库",
    type: "ammo_depot",
    tags: ["ammo", "ammunition", "supply", "沙漠弹药库", "弹药库", "Desert Ammo Cache"],
    position: { x: 260, y: 150 },
    team: "neutral",
    hp: 400,
    maxHp: 400,
    // 刀3 (R4): was "central_desert", which no rectangle ever contained this point
    // — geometry put it in southern_desert while director.frontIdForRegion read the
    // declared id, so one facility answered to two fronts depending on who asked.
    // The fact follows the geometry; its FACILITY_* events now belong to the south.
    regionId: "southern_desert",
    strategicEffect: "+25 Ammo/30s",
    captureProgress: 0,
    capturingTeam: null,
  },
  {
    id: "ea_comm_tower",
    name: "沿海雷达",
    type: "comm_tower",
    tags: ["comm", "signal", "intel", "Tel el Eisa", "沿海雷达", "海岸雷达", "Tel el Eisa Signal Station"],
    position: { x: 240, y: 35 },
    team: "neutral",
    hp: 300,
    maxHp: 300,
    regionId: "tel_el_eisa",
    strategicEffect: "+20 Intel/30s + reveals Rommel HQ",
    captureProgress: 0,
    capturingTeam: null,
  },
  {
    id: "ea_observation_post",
    // 改名刀：「中央雷达」→「烽火台」。它是中立的，却坐在「中央」命名空间正中间——
    // 刀F 那场事故（「拿下山脊战线」把 14 个人送到 (250,100)）就在这儿。
    // 「中部山脊」也挂进来当别名：ruweisat_zone 的旧显示名改叫「乱石岭」之后，
    // region 没有 tags[] 这种别名字段，而这个设施就站在那块地里——长官说旧名，
    // 落点差 2.5 格，比"找不到那个地方"强得多（加不减）。
    name: "烽火台",
    type: "radar",
    tags: ["observation", "Ruweisat", "vision", "中央雷达", "沙漠雷达", "烽火台", "中部山脊", "Ruweisat Observation Post"],
    position: { x: 250, y: 100 },
    team: "neutral",
    hp: 300,
    maxHp: 300,
    regionId: "ruweisat_zone",
    strategicEffect: "Central high ground + area vision",
    captureProgress: 0,
    capturingTeam: null,
  },

  // === Axis Base Facilities ===
  {
    id: "ea_axis_barracks",
    name: "敌军德军营房",
    type: "barracks",
    tags: ["axis barracks", "German", "敌军德军营房", "德军营房", "Afrika Korps Barracks"],
    position: { x: 100, y: 80 },
    team: "enemy",
    hp: 500,
    maxHp: 500,
    regionId: "axis_rear",
    strategicEffect: "Produces German ground units",
    captureProgress: 0,
    capturingTeam: null,
  },
  {
    id: "ea_axis_airfield",
    name: "敌军机场",
    type: "airfield",
    tags: ["axis airfield", "Luftwaffe", "敌军机场", "轴心机场", "Axis Airfield"],
    position: { x: 60, y: 130 },
    team: "enemy",
    hp: 500,
    maxHp: 500,
    regionId: "axis_rear",
    strategicEffect: "Produces air units",
    captureProgress: 0,
    capturingTeam: null,
  },
  {
    id: "ea_axis_barracks2",
    name: "敌军意军营房",
    type: "barracks",
    tags: ["Italian", "barracks", "敌军意军营房", "意军营房", "Italian Infantry Depot"],
    position: { x: 120, y: 140 },
    team: "enemy",
    hp: 500,
    maxHp: 500,
    regionId: "axis_rear",
    strategicEffect: "Produces Italian ground units",
    captureProgress: 0,
    capturingTeam: null,
  },

  // === Player Forward Keypoints (Step 5B) — defendable strongpoints ahead of British HQ.
  // Loss of 2 of these = defeat. Capturable + destructible like normal facilities.
  // Tagged "前哨" (forward post) to disambiguate from Axis "据点" objectives. ===
  {
    id: "ea_player_coastal_post",
    name: "北线前哨",
    type: "comm_tower",
    tags: ["forward", "keypoint", "前哨", "player", "一号前哨", "北线前哨", "Coastal Forward Post"],
    position: { x: 360, y: 35 },
    team: "player",
    hp: 350,
    maxHp: 350,
    regionId: "northern_coastal",
    strategicEffect: "Forward coastal observation post",
    captureProgress: 0,
    capturingTeam: null,
  },
  {
    id: "ea_player_central_post",
    name: "中央前哨",
    type: "ammo_depot",
    tags: ["forward", "keypoint", "前哨", "player", "二号前哨", "中央前哨", "Central Desert Forward Post"],
    position: { x: 360, y: 105 },
    team: "player",
    hp: 350,
    maxHp: 350,
    regionId: "central_desert",  // ID matches region — (360,105) sits in central_desert bbox, not ruweisat_zone
    strategicEffect: "Forward ammunition cache",
    captureProgress: 0,
    capturingTeam: null,
  },
  {
    id: "ea_player_south_post",
    name: "南线前哨",
    type: "radar",
    tags: ["forward", "keypoint", "前哨", "player", "三号前哨", "南线前哨", "Alam Halfa Forward Post"],
    position: { x: 365, y: 155 },
    team: "player",
    hp: 350,
    maxHp: 350,
    regionId: "alam_halfa_zone",
    strategicEffect: "Southern flank surveillance",
    captureProgress: 0,
    capturingTeam: null,
  },
];

// ──────────────────────────────────────────────
// Fronts
// ──────────────────────────────────────────────

export const EL_ALAMEIN_FRONTS: Front[] = [
  // 刀3 invariant (ab-mapdata-audit): every point belongs to AT MOST ONE front.
  // Region rectangles may still nest INSIDE a front (tel_el_eisa ⊂ northern_coastal
  // is geography, not ambiguity) — the invariant is deliberately stated at front
  // level, because that is the level every power/judgment/crisis reader asks at.
  {
    id: "front_coastal",
    name: "1. 北部战线",
    regionIds: ["northern_coastal", "northern_coastal_e", "tel_el_eisa"],
    playerPower: 0,
    enemyPower: 0,
    enemyPowerKnown: false,
    engagementIntensity: 0,
    supplyStatus: "OK",
    keyEvents: [],
  },
  {
    id: "front_ridge",
    name: "2. 山脊战线",
    regionIds: ["kidney_ridge_zone", "miteirya_ridge_zone", "ruweisat_zone"],
    playerPower: 0,
    enemyPower: 0,
    enemyPowerKnown: false,
    engagementIntensity: 0,
    supplyStatus: "OK",
    keyEvents: [],
  },
  {
    id: "front_center",
    name: "3. 中央战线",
    regionIds: ["central_desert", "central_desert_w", "central_desert_s", "minefield_zone", "minefield_zone_n"],
    playerPower: 0,
    enemyPower: 0,
    enemyPowerKnown: false,
    engagementIntensity: 0,
    supplyStatus: "OK",
    keyEvents: [],
  },
  {
    id: "front_south",
    name: "4. 南部战线",
    regionIds: ["southern_desert", "alam_halfa_zone", "himeimat_zone"],
    playerPower: 0,
    enemyPower: 0,
    enemyPowerKnown: false,
    engagementIntensity: 0,
    supplyStatus: "OK",
    keyEvents: [],
  },
  {
    id: "front_axis_rear",
    name: "5. 敌军后方",
    regionIds: ["axis_rear"],
    playerPower: 0,
    enemyPower: 0,
    enemyPowerKnown: false,
    engagementIntensity: 0,
    supplyStatus: "OK",
    keyEvents: [],
  },
];

// ──────────────────────────────────────────────
// Named Routes
// ──────────────────────────────────────────────

export const EL_ALAMEIN_ROUTES: NamedRoute[] = [
  {
    id: "via_balbia",
    name: "沿海公路",
    waypoints: [
      { x: 470, y: 24 }, { x: 420, y: 24 }, { x: 370, y: 24 },
      { x: 320, y: 24 }, { x: 280, y: 24 }, { x: 240, y: 24 },
      { x: 180, y: 24 }, { x: 120, y: 24 }, { x: 60, y: 24 },
    ],
    passableFor: ["ground"],
    connectedRoutes: ["front_line_road", "axis_supply_road"],
  },
  {
    id: "desert_track",
    name: "中央沙漠小路",
    waypoints: [
      { x: 450, y: 92 }, { x: 400, y: 92 }, { x: 350, y: 92 },
      { x: 300, y: 92 }, { x: 250, y: 92 }, { x: 200, y: 92 },
      { x: 140, y: 92 }, { x: 80, y: 92 },
    ],
    passableFor: ["ground"],
    connectedRoutes: ["front_line_road", "axis_supply_road"],
  },
  {
    id: "southern_pass",
    name: "南部山路",
    waypoints: [
      { x: 450, y: 195 }, { x: 400, y: 195 }, { x: 340, y: 195 },
      { x: 280, y: 195 }, { x: 250, y: 195 }, { x: 200, y: 195 },
      { x: 140, y: 195 }, { x: 80, y: 195 },
    ],
    passableFor: ["ground"],
    connectedRoutes: ["front_line_road", "axis_supply_road"],
  },
  {
    id: "front_line_road",
    name: "前线公路",
    waypoints: [
      { x: 310, y: 24 }, { x: 310, y: 65 }, { x: 310, y: 95 },
      { x: 310, y: 150 }, { x: 310, y: 195 },
    ],
    passableFor: ["ground"],
    connectedRoutes: ["via_balbia", "desert_track", "southern_pass"],
  },
  {
    id: "axis_supply_road",
    name: "敌军补给路",
    waypoints: [
      { x: 150, y: 24 }, { x: 150, y: 65 }, { x: 150, y: 95 },
      { x: 150, y: 150 }, { x: 150, y: 195 },
    ],
    passableFor: ["ground"],
    connectedRoutes: ["via_balbia", "desert_track", "southern_pass"],
  },
];

// ──────────────────────────────────────────────
// Front camera positions (tile coords for keys 1-5)
// ──────────────────────────────────────────────

export const EL_ALAMEIN_CAMERA_TARGETS: Record<string, { x: number; y: number }> = {
  front_coastal:   { x: 280, y: 35 },
  front_ridge:     { x: 230, y: 65 },
  front_center:    { x: 280, y: 95 },
  front_south:     { x: 280, y: 195 },
  front_axis_rear: { x: 80,  y: 100 },
};

// ──────────────────────────────────────────────
// Capture objectives — pool of Axis strongpoints that count toward victory.
// Step 5B: victory requires capturing ANY K of these (K = scenarioWinConfig.
// requiredCapturedObjectives, currently 3). Rommel's HQ remains a separate
// "destroy HQ" win path handled by warPhase, not listed here.
// ──────────────────────────────────────────────

export const EL_ALAMEIN_OBJECTIVES: string[] = [
  "ea_alamein_town",
  "ea_kidney_ridge",
  "ea_miteirya_ridge",
  "ea_himeimat",
];
