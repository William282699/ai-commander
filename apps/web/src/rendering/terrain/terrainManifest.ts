// ============================================================
// Terrain Tile Manifest — El Alamein Desert Edition
// Maps TerrainType → tile bitmap + tint + decoration rules
// ============================================================

import type { TerrainType, FacilityType } from "@ai-commander/shared";

// --- Types ---

export interface TerrainTileEntry {
  /** Base tile bitmap key (matches filename without extension) */
  baseTile: string;
  /** Optional RGBA tint applied over the base tile (for terrain variants) */
  tint?: string;
  /** Decoration pool: which decoration sprites can appear on this terrain */
  decorations?: DecorationRule[];
  /** Minimap color for this terrain type */
  minimapColor: string;
}

export interface DecorationRule {
  /** Sprite key (matches filename in decorations/) */
  spriteKey: string;
  /** Probability of a decoration appearing per tile (0-1) */
  density: number;
  /** Scale range [min, max] relative to tile size */
  scaleRange: [number, number];
  /** Whether to randomly rotate the decoration */
  randomRotate: boolean;
}

export interface FacilitySpriteEntry {
  /** Sprite key (matches filename in facilities/) */
  spriteKey: string;
  /** Draw scale relative to tileScreenSize */
  drawScale: number;
  /** Whether to draw the team-color border underneath */
  showTeamBorder: boolean;
}

// --- Terrain → tile mapping (El Alamein) ---

export const TERRAIN_TILE_MANIFEST: Record<TerrainType, TerrainTileEntry> = {
  plains: {
    baseTile: "sand_tile",
    minimapColor: "#c2b280",
    decorations: [
      { spriteKey: "rock_01", density: 0.008, scaleRange: [0.3, 0.5], randomRotate: true },
    ],
  },
  hills: {
    baseTile: "sand_tile",
    tint: "rgba(139,115,85,0.3)",
    minimapColor: "#a89070",
    decorations: [
      { spriteKey: "rock_02", density: 0.04, scaleRange: [0.4, 0.7], randomRotate: true },
      { spriteKey: "rock_03", density: 0.03, scaleRange: [0.5, 0.8], randomRotate: true },
      { spriteKey: "rock_01", density: 0.02, scaleRange: [0.3, 0.5], randomRotate: true },
    ],
  },
  forest: {
    baseTile: "grass_tile",
    minimapColor: "#4a6b35",
    decorations: [
      { spriteKey: "tree_large_01", density: 0.06, scaleRange: [0.8, 1.2], randomRotate: false },
      { spriteKey: "tree_large_02", density: 0.04, scaleRange: [0.7, 1.0], randomRotate: false },
      { spriteKey: "bush_01", density: 0.05, scaleRange: [0.4, 0.7], randomRotate: true },
      { spriteKey: "bush_03", density: 0.04, scaleRange: [0.5, 0.8], randomRotate: true },
    ],
  },
  swamp: {
    baseTile: "sand_tile",
    tint: "rgba(80,60,40,0.35)",
    minimapColor: "#8a7a5a",
    decorations: [
      { spriteKey: "rock_01", density: 0.015, scaleRange: [0.2, 0.4], randomRotate: true },
    ],
  },
  road: {
    baseTile: "road_tile",
    minimapColor: "#6b6560",
    decorations: [],
  },
  shallow_water: {
    baseTile: "water_tile",
    tint: "rgba(100,180,220,0.15)",
    minimapColor: "#5a9ec4",
    decorations: [],
  },
  deep_water: {
    baseTile: "water_tile",
    minimapColor: "#2a6aa0",
    decorations: [],
  },
  bridge: {
    baseTile: "bridge_tile",
    minimapColor: "#7a7a7a",
    decorations: [],
  },
  urban: {
    baseTile: "sand_tile",
    tint: "rgba(120,120,120,0.2)",
    minimapColor: "#9a9080",
    decorations: [
      { spriteKey: "crate_01", density: 0.03, scaleRange: [0.3, 0.5], randomRotate: true },
      { spriteKey: "barrel", density: 0.02, scaleRange: [0.25, 0.4], randomRotate: true },
      { spriteKey: "sandbags", density: 0.02, scaleRange: [0.5, 0.8], randomRotate: false },
    ],
  },
  mountain: {
    baseTile: "dirt_tile",
    tint: "rgba(60,50,40,0.2)",
    minimapColor: "#7a6545",
    decorations: [
      { spriteKey: "rock_03", density: 0.08, scaleRange: [0.6, 1.0], randomRotate: true },
      { spriteKey: "rock_02", density: 0.06, scaleRange: [0.5, 0.9], randomRotate: true },
      { spriteKey: "rock_01", density: 0.04, scaleRange: [0.3, 0.6], randomRotate: true },
    ],
  },
};

// --- Facility → building sprite mapping ---

export const FACILITY_SPRITE_MAP: Partial<Record<FacilityType, FacilitySpriteEntry>> = {
  headquarters: {
    spriteKey: "house_large",
    drawScale: 3.5,
    showTeamBorder: true,
  },
  barracks: {
    spriteKey: "house_small",
    drawScale: 2.5,
    showTeamBorder: true,
  },
  airfield: {
    spriteKey: "house_large",
    drawScale: 3.0,
    showTeamBorder: true,
  },
  comm_tower: {
    spriteKey: "watchtower",
    drawScale: 2.0,
    showTeamBorder: true,
  },
  radar: {
    spriteKey: "watchtower",
    drawScale: 2.0,
    showTeamBorder: true,
  },
  defense_tower: {
    spriteKey: "watchtower",
    drawScale: 2.0,
    showTeamBorder: true,
  },
  repair_station: {
    spriteKey: "house_small",
    drawScale: 2.0,
    showTeamBorder: true,
  },
};
