// ============================================================
// AI Commander — MVP Terrain Generator
// Generates the "Dual-Island Strait" map (200x150 tiles)
// 5 fronts: North Plains / Central City / Strait / South Hills / Far South
// ============================================================

import type { TerrainType } from "@ai-commander/shared";
import { MAP_WIDTH, MAP_HEIGHT } from "@ai-commander/shared";

export function generateTerrain(): TerrainType[][] {
  const map: TerrainType[][] = Array.from({ length: MAP_HEIGHT }, () =>
    Array.from({ length: MAP_WIDTH }, () => "plains" as TerrainType)
  );

  const fill = (x1: number, y1: number, x2: number, y2: number, t: TerrainType) => {
    for (let y = Math.max(0, y1); y < Math.min(MAP_HEIGHT, y2); y++) {
      for (let x = Math.max(0, x1); x < Math.min(MAP_WIDTH, x2); x++) {
        map[y][x] = t;
      }
    }
  };

  const fillCircle = (cx: number, cy: number, r: number, t: TerrainType) => {
    for (let y = cy - r; y <= cy + r; y++) {
      for (let x = cx - r; x <= cx + r; x++) {
        if ((x - cx) ** 2 + (y - cy) ** 2 <= r * r) {
          if (y >= 0 && y < MAP_HEIGHT && x >= 0 && x < MAP_WIDTH) {
            map[y][x] = t;
          }
        }
      }
    }
  };

  // Scatter random patches to break up monotony
  const scatterPatches = (
    x1: number, y1: number, x2: number, y2: number,
    t: TerrainType, count: number, minR: number, maxR: number,
    seed: number,
  ) => {
    let s = seed;
    const rng = () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; };
    for (let i = 0; i < count; i++) {
      const cx = Math.floor(x1 + rng() * (x2 - x1));
      const cy = Math.floor(y1 + rng() * (y2 - y1));
      const r = Math.floor(minR + rng() * (maxR - minR));
      fillCircle(cx, cy, r, t);
    }
  };

  // ═══════════════════════════════════════════
  // LAYER 1: Mountain borders (impassable edges)
  // ═══════════════════════════════════════════
  fill(0, 0, 8, MAP_HEIGHT, "mountain");
  fill(192, 0, MAP_WIDTH, MAP_HEIGHT, "mountain");

  // ═══════════════════════════════════════════
  // LAYER 2: Water — Horizontal strait (rows 64-86)
  // ═══════════════════════════════════════════
  fill(8, 66, 192, 84, "deep_water");
  // Shallow water shores
  fill(8, 63, 192, 66, "shallow_water");
  fill(8, 84, 192, 87, "shallow_water");
  // Irregular coastline — some shallow inlets
  scatterPatches(8, 60, 192, 64, "shallow_water", 12, 1, 3, 42);
  scatterPatches(8, 86, 192, 90, "shallow_water", 12, 1, 3, 99);

  // ═══════════════════════════════════════════
  // LAYER 3: NORTH SIDE (Player Territory)
  // ═══════════════════════════════════════════

  // -- Player Base (urban compound, top center) --
  fill(82, 2, 118, 14, "urban");
  // Base internal roads
  fill(98, 2, 102, 14, "road");
  fill(82, 7, 118, 9, "road");

  // -- North Forest (northwest, infantry ambush terrain) --
  fill(15, 18, 55, 48, "forest");
  scatterPatches(12, 15, 58, 50, "forest", 8, 2, 5, 101);
  // Clearings in the forest
  fillCircle(35, 30, 3, "plains");
  fillCircle(28, 42, 2, "plains");

  // -- Northeast Hills (tank territory, high ground) --
  fill(130, 10, 185, 42, "hills");
  scatterPatches(125, 8, 190, 45, "hills", 6, 2, 4, 202);
  // Rocky outcrops on hills
  fillCircle(155, 20, 3, "mountain");
  fillCircle(170, 35, 2, "mountain");

  // -- North Central City (urban combat zone) --
  fill(82, 30, 118, 52, "urban");
  // City roads grid
  fill(98, 30, 102, 52, "road");
  fill(82, 38, 118, 40, "road");
  fill(82, 48, 118, 50, "road");

  // -- Scattered plains features (north) --
  scatterPatches(55, 20, 80, 50, "hills", 4, 1, 3, 303);
  scatterPatches(60, 15, 130, 30, "forest", 5, 1, 3, 404);

  // -- Major roads (north) --
  // Horizontal highway connecting east-west
  fill(8, 25, 192, 27, "road");
  // Vertical road from base south to shore
  fill(99, 14, 101, 63, "road");
  // West vertical road
  fill(40, 5, 42, 63, "road");
  // East vertical road
  fill(160, 5, 162, 63, "road");
  // Diagonal road from NW forest to center
  for (let i = 0; i < 30; i++) {
    const x = 55 + i;
    const y = 48 - Math.floor(i * 0.5);
    if (x < MAP_WIDTH && y >= 0) { map[y][x] = "road"; map[y + 1][x] = "road"; }
  }

  // ═══════════════════════════════════════════
  // LAYER 4: BRIDGES (3 crossings)
  // ═══════════════════════════════════════════
  // West bridge (wider, main armor crossing)
  fill(38, 63, 45, 87, "bridge");
  // Center bridge (medium)
  fill(98, 63, 104, 87, "bridge");
  // East bridge (narrow)
  fill(159, 63, 164, 87, "bridge");

  // ═══════════════════════════════════════════
  // LAYER 5: SOUTH SIDE (Enemy Territory)
  // ═══════════════════════════════════════════

  // -- South Hills (west, oil depot area) --
  fill(15, 93, 75, 118, "hills");
  scatterPatches(10, 90, 78, 120, "hills", 6, 2, 4, 505);
  // Pockets of forest on hills
  scatterPatches(20, 95, 70, 115, "forest", 4, 1, 3, 606);

  // -- South Central City --
  fill(82, 98, 118, 122, "urban");
  fill(98, 98, 102, 122, "road");
  fill(82, 108, 118, 110, "road");

  // -- South Forest (east, ammo depot hidden here) --
  fill(120, 96, 170, 132, "forest");
  scatterPatches(115, 93, 175, 135, "forest", 6, 2, 4, 707);
  // Clearings
  fillCircle(140, 115, 3, "plains");
  fillCircle(150, 105, 2, "plains");

  // -- Far South Swamp (western flanking route) --
  fill(10, 120, 60, 145, "swamp");
  scatterPatches(8, 118, 65, 148, "swamp", 8, 2, 4, 808);
  // Some swamp creeps into plains
  scatterPatches(55, 125, 80, 140, "swamp", 3, 1, 2, 809);

  // -- Far South Plains (approach to enemy base) --
  // Already plains by default, add some features
  scatterPatches(65, 125, 140, 138, "hills", 3, 1, 2, 909);

  // -- Enemy Base (urban compound, bottom center) --
  fill(82, 137, 118, 148, "urban");
  fill(98, 137, 102, 148, "road");
  fill(82, 141, 118, 143, "road");

  // -- Major roads (south) --
  // Horizontal highway
  fill(8, 125, 192, 127, "road");
  // Vertical road from shore to enemy base
  fill(99, 87, 101, 137, "road");
  // West vertical
  fill(40, 87, 42, 148, "road");
  // East vertical
  fill(160, 87, 162, 148, "road");

  // ═══════════════════════════════════════════
  // LAYER 6: Facility markers (small urban patches at facility locations)
  // ═══════════════════════════════════════════
  // Comm tower (center bridge approach) — small urban dot
  fillCircle(100, 55, 2, "urban");
  // Repair station (north city area) — already in urban
  // Fuel depot (south hills)
  fillCircle(45, 105, 2, "urban");
  // Ammo depot (south forest clearing)
  fillCircle(140, 115, 2, "urban");
  // Rail hub (far south)
  fillCircle(100, 130, 2, "urban");
  // Road to rail hub
  fill(99, 127, 101, 133, "road");

  return map;
}
