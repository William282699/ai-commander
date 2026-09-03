// 教学关：地图数据 + 地形生成器的对外出口。
// 命名一律带 TUTORIAL_ 前缀——`shared/scenario/index.ts` 把 dual_island 那份
// 用**裸名**导出（REGIONS/FACILITIES/…），不加前缀会当场撞名。
export * from "./mapData";
export * from "./terrainGen";
