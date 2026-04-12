// ============================================================
// Terrain Tile Loader — Preloads all terrain, decoration, and
// facility bitmaps via fetch() + createImageBitmap().
// Runtime-slices Tiles.png (64×320 strip) into 5 base tiles.
// ============================================================

// --- Bitmap cache ---

const bitmapCache = new Map<string, ImageBitmap>();

// --- Tile strip slicing layout ---
// Tiles.png is 64×320, 5 stacked 64×64 samples:
//   y:0-63   → water_tile
//   y:64-127 → grass_tile
//   y:128-191 → sand_tile
//   y:192-255 → dirt_tile
//   y:256-319 → road_tile

const TILE_STRIP_SLICES: Array<{ key: string; y: number }> = [
  { key: "water_tile", y: 0 },
  { key: "grass_tile", y: 64 },
  { key: "sand_tile", y: 128 },
  { key: "dirt_tile", y: 192 },
  { key: "road_tile", y: 256 },
];

// Bridge: BridgeTiles.png is 64×192, take center 64×64
const BRIDGE_SLICE = { key: "bridge_tile", y: 64 };

// --- Decoration file paths ---

const DECORATION_PATHS: Record<string, string> = {
  rock_01:       "/sprites/tds/decorations/rock_01.png",
  rock_02:       "/sprites/tds/decorations/rock_02.png",
  rock_03:       "/sprites/tds/decorations/rock_03.png",
  sandbags:      "/sprites/tds/decorations/sandbags.png",
  bush_01:       "/sprites/tds/decorations/bush_01.png",
  bush_02:       "/sprites/tds/decorations/bush_02.png",
  bush_03:       "/sprites/tds/decorations/bush_03.png",
  tree_small_01: "/sprites/tds/decorations/tree_small_01.png",
  tree_small_02: "/sprites/tds/decorations/tree_small_02.png",
  tree_small_03: "/sprites/tds/decorations/tree_small_03.png",
  tree_large_01: "/sprites/tds/decorations/tree_large_01.png",
  tree_large_02: "/sprites/tds/decorations/tree_large_02.png",
  tree_large_03: "/sprites/tds/decorations/tree_large_03.png",
  tree_large_04: "/sprites/tds/decorations/tree_large_04.png",
  barrel_oil:    "/sprites/tds/decorations/barrel_oil.png",
  barrel:        "/sprites/tds/decorations/barrel.png",
  crate_01:      "/sprites/tds/decorations/crate_01.png",
  crate_02:      "/sprites/tds/decorations/crate_02.png",
  crate_small_01: "/sprites/tds/decorations/crate_small_01.png",
  crate_small_02: "/sprites/tds/decorations/crate_small_02.png",
};

// --- Facility sprite paths ---

const FACILITY_SPRITE_PATHS: Record<string, string> = {
  house_small: "/sprites/tds/facilities/house_small.png",
  house_large: "/sprites/tds/facilities/house_large.png",
  watchtower:  "/sprites/tds/facilities/watchtower.png",
};

// --- Helpers ---

async function loadBitmap(url: string): Promise<ImageBitmap | null> {
  try {
    const resp = await fetch(url);
    if (!resp.ok) return null;
    const blob = await resp.blob();
    return await createImageBitmap(blob);
  } catch {
    return null;
  }
}

async function loadAndSlice(
  url: string,
  slices: Array<{ key: string; y: number }>,
  sliceWidth: number,
  sliceHeight: number,
): Promise<void> {
  const bitmap = await loadBitmap(url);
  if (!bitmap) return;
  for (const { key, y } of slices) {
    try {
      const slice = await createImageBitmap(bitmap, 0, y, sliceWidth, sliceHeight);
      bitmapCache.set(key, slice);
    } catch {
      // skip this slice
    }
  }
}

// --- Public API ---

export async function preloadTerrainTiles(): Promise<void> {
  // 1. Slice base terrain tiles from the strip
  await loadAndSlice(
    "/sprites/tds/terrain/tiles_strip.png",
    TILE_STRIP_SLICES,
    64,
    64,
  );

  // 2. Slice bridge tile from bridge sheet
  await loadAndSlice(
    "/sprites/tds/terrain/bridge_full.png",
    [BRIDGE_SLICE],
    64,
    64,
  );

  // 3. Load all decoration bitmaps in parallel
  const decoPromises = Object.entries(DECORATION_PATHS).map(
    async ([key, url]) => {
      const bm = await loadBitmap(url);
      if (bm) bitmapCache.set(key, bm);
    },
  );

  // 4. Load all facility bitmaps in parallel
  const facilPromises = Object.entries(FACILITY_SPRITE_PATHS).map(
    async ([key, url]) => {
      const bm = await loadBitmap(url);
      if (bm) bitmapCache.set(key, bm);
    },
  );

  await Promise.all([...decoPromises, ...facilPromises]);

  console.log(`[terrain] loaded ${bitmapCache.size} bitmaps`);
}

export function getTerrainBitmap(key: string): ImageBitmap | null {
  return bitmapCache.get(key) ?? null;
}

export function terrainBitmapCount(): number {
  return bitmapCache.size;
}
