// ============================================================
// AI Commander — El Alamein Terrain Generator
// 500×300 map: Mediterranean(N) → Desert → Qattara Depression(S)
// ============================================================

import type { TerrainType } from "../../types";

const EL_ALAMEIN_WIDTH = 500;
const EL_ALAMEIN_HEIGHT = 300;

export function generateElAlameinTerrain(): TerrainType[][] {
  const map: TerrainType[][] = Array.from({ length: EL_ALAMEIN_HEIGHT }, () =>
    Array.from({ length: EL_ALAMEIN_WIDTH }, () => "plains" as TerrainType),
  );

  const fill = (x1: number, y1: number, x2: number, y2: number, t: TerrainType) => {
    for (let y = Math.max(0, y1); y < Math.min(EL_ALAMEIN_HEIGHT, y2); y++) {
      for (let x = Math.max(0, x1); x < Math.min(EL_ALAMEIN_WIDTH, x2); x++) {
        map[y][x] = t;
      }
    }
  };

  const fillCircle = (cx: number, cy: number, r: number, t: TerrainType) => {
    for (let y = cy - r; y <= cy + r; y++) {
      for (let x = cx - r; x <= cx + r; x++) {
        if ((x - cx) ** 2 + (y - cy) ** 2 <= r * r) {
          if (y >= 0 && y < EL_ALAMEIN_HEIGHT && x >= 0 && x < EL_ALAMEIN_WIDTH) {
            map[y][x] = t;
          }
        }
      }
    }
  };

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
  // LAYER 1: Mediterranean Sea (y:0-20)
  // ═══════════════════════════════════════════
  fill(0, 0, EL_ALAMEIN_WIDTH, 18, "deep_water");
  fill(0, 18, EL_ALAMEIN_WIDTH, 22, "shallow_water");
  // Irregular coastline
  scatterPatches(0, 16, EL_ALAMEIN_WIDTH, 24, "shallow_water", 20, 1, 3, 1001);

  // ═══════════════════════════════════════════
  // LAYER 2: Via Balbia — coastal highway (y:22-26)
  // ═══════════════════════════════════════════
  fill(0, 22, EL_ALAMEIN_WIDTH, 26, "road");

  // ═══════════════════════════════════════════
  // LAYER 3: Qattara Depression (y:230-300)
  // ═══════════════════════════════════════════
  fill(0, 235, EL_ALAMEIN_WIDTH, EL_ALAMEIN_HEIGHT, "mountain");
  // Transition zone: swamp/rough terrain (y:228-235)
  fill(0, 228, EL_ALAMEIN_WIDTH, 235, "swamp");
  scatterPatches(0, 225, EL_ALAMEIN_WIDTH, 240, "mountain", 15, 2, 5, 2001);
  scatterPatches(0, 220, EL_ALAMEIN_WIDTH, 232, "swamp", 10, 2, 4, 2002);

  // ═══════════════════════════════════════════
  // LAYER 4: Key ridges and hills
  // ═══════════════════════════════════════════

  // Tel el Eisa high ground (x:235-250, y:30-42)
  fill(232, 28, 252, 44, "hills");
  scatterPatches(228, 26, 256, 46, "hills", 6, 2, 4, 3001);

  // Kidney Ridge (x:212-232, y:48-62)
  fill(212, 48, 235, 64, "hills");
  scatterPatches(208, 45, 238, 66, "hills", 5, 2, 4, 3002);

  // Miteirya Ridge (x:220-245, y:60-75)
  fill(220, 58, 248, 76, "hills");
  scatterPatches(216, 56, 252, 78, "hills", 5, 2, 4, 3003);

  // Ruweisat Ridge — central commanding position (x:240-265, y:92-108)
  fill(238, 92, 268, 110, "hills");
  scatterPatches(234, 88, 272, 112, "hills", 6, 2, 5, 3004);

  // Alam el Halfa Ridge (x:330-355, y:142-160)
  fill(328, 142, 358, 162, "hills");
  scatterPatches(324, 138, 362, 164, "hills", 5, 2, 4, 3005);

  // Alam Nayil Ridge (x:260-285, y:133-148)
  fill(258, 133, 288, 150, "hills");
  scatterPatches(254, 130, 292, 152, "hills", 4, 2, 3, 3006);

  // Himeimat high ground (x:240-265, y:212-228)
  fill(238, 212, 268, 230, "hills");
  scatterPatches(234, 208, 272, 232, "hills", 5, 2, 4, 3007);

  // Deir el Munassib depression (scattered rocky terrain)
  scatterPatches(250, 192, 275, 210, "hills", 4, 2, 3, 3008);

  // ═══════════════════════════════════════════
  // LAYER 5: Devil's Gardens — minefields (swamp = minefield)
  // x:250-310, y:40-120 — broad band across the front
  // ═══════════════════════════════════════════
  fill(255, 42, 308, 118, "swamp");
  // Gaps/lanes through the minefield — MUST extend east to Front Line Road (x:314)
  // so tanks can pass from east side through to west side
  fill(268, 50, 314, 56, "plains");   // north gap corridor → connects to road
  fill(268, 50, 275, 110, "plains");  // north gap (N-S strip)
  fill(288, 60, 314, 66, "plains");   // center gap corridor → connects to road
  fill(288, 60, 295, 100, "plains");  // center gap (N-S strip)
  // More scattered mines outside the main band
  scatterPatches(248, 38, 315, 125, "swamp", 12, 2, 4, 4001);
  // Re-ensure gaps after scatter
  fill(268, 50, 314, 56, "plains");
  fill(268, 50, 275, 110, "plains");
  fill(288, 60, 314, 66, "plains");
  fill(288, 60, 295, 100, "plains");

  // ═══════════════════════════════════════════
  // LAYER 6: Roads
  // ═══════════════════════════════════════════

  // Central Desert Track (y:90-94, east-west)
  fill(0, 90, EL_ALAMEIN_WIDTH, 94, "road");

  // Southern Track (y:193-197)
  fill(0, 193, EL_ALAMEIN_WIDTH, 197, "road");

  // Front line road (north-south, x:308-312)
  fill(308, 22, 314, 198, "road");

  // Axis supply road (north-south, x:148-152)
  fill(148, 22, 154, 198, "road");

  // ═══════════════════════════════════════════
  // LAYER 7: Urban areas (Alamein town, HQ compounds)
  // ═══════════════════════════════════════════

  // El Alamein town
  fill(274, 26, 290, 38, "urban");
  fillCircle(282, 32, 4, "urban");

  // Player HQ compound
  fill(424, 84, 440, 98, "urban");
  fill(428, 88, 436, 94, "road");

  // Player barracks
  fillCircle(410, 75, 4, "urban");

  // Player airfield
  fillCircle(450, 130, 5, "road");

  // Enemy HQ compound
  fill(74, 94, 90, 108, "urban");
  fill(78, 98, 86, 104, "road");

  // Enemy barracks
  fillCircle(100, 80, 4, "urban");
  fillCircle(120, 140, 4, "urban");

  // Enemy airfield
  fillCircle(60, 130, 5, "road");

  // ═══════════════════════════════════════════
  // LAYER 8: Facility markers (small urban dots)
  // ═══════════════════════════════════════════
  fillCircle(310, 100, 2, "urban"); // fuel depot
  fillCircle(260, 150, 2, "urban"); // ammo depot
  fillCircle(240, 35, 2, "urban");  // comm tower at Tel el Eisa
  fillCircle(250, 100, 2, "urban"); // Ruweisat observation post
  fillCircle(400, 90, 2, "urban");  // repair station

  // ═══════════════════════════════════════════
  // LAYER 9: Scattered desert features
  // ═══════════════════════════════════════════
  // Random rocky outcrops in open desert
  scatterPatches(10, 80, 240, 200, "hills", 15, 1, 3, 5001);
  scatterPatches(320, 30, 490, 200, "hills", 10, 1, 2, 5002);
  // Small sand dune patches (as hills)
  scatterPatches(100, 50, 200, 180, "hills", 8, 1, 2, 5003);

  return map;
}
