// ============================================================
// AI Commander — 教学关地形
// 120×80：西边我军营地 → 中央谷地（一条公路贯穿）→ 东边敌军哨所高地
//
// 刻意做得平：教学关要教的是「跟参谋说话」，不是地形阅读。除了中间那条
// 公路和东边一小片高地，整张图都能走——新手不该在寻路上卡住。
// ============================================================

import type { TerrainType } from "../../types";

export const TUTORIAL_WIDTH = 120;
export const TUTORIAL_HEIGHT = 80;

export function generateTutorialTerrain(): TerrainType[][] {
  const map: TerrainType[][] = Array.from({ length: TUTORIAL_HEIGHT }, () =>
    Array.from({ length: TUTORIAL_WIDTH }, () => "plains" as TerrainType),
  );

  const fill = (x1: number, y1: number, x2: number, y2: number, t: TerrainType) => {
    for (let y = Math.max(0, y1); y < Math.min(TUTORIAL_HEIGHT, y2); y++) {
      for (let x = Math.max(0, x1); x < Math.min(TUTORIAL_WIDTH, x2); x++) {
        map[y][x] = t;
      }
    }
  };

  // 东侧高地——敌军哨站坐在上面，远看就知道那边是"高处"
  fill(84, 26, 112, 54, "hills");

  // 贯穿东西的公路：玩家一眼看得出"往那边走"
  fill(8, 38, 112, 42, "road");

  // 我军营地一小片城镇底色（让基地区域在地图上认得出来）
  fill(10, 34, 26, 48, "urban");
  // ★ 补回被 urban 盖掉的那段公路（审核抓出：(12,40) 曾经是 urban）。
  //   顺序敏感——这一笔必须在 urban 之后，否则又被盖回去。
  fill(10, 38, 26, 42, "road");

  return map;
}
