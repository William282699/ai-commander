# Map & Terrain Upgrade Plan — TDS Modern Tilesets

**Audience**: The next Claude Code window that opens this file.
**Mission**: Replace the current flat-color `fillRect()` terrain with pixel-art tiles from the purchased CraftPix "TDS Modern Tilesets Environment" pack, add decoration overlays (rocks, sandbags, buildings), and upgrade facility rendering with building sprites. The El Alamein desert scenario must feel like a North African battlefield, not colored Excel cells.
**Status at handoff**: Assets verified, tile sheet structure analyzed, rendering code studied line-by-line. Architecture decisions locked. This document is self-contained.

---

## START HERE — New Window Orientation

**If you are the Claude Code window that just had this file handed to you, read this entire section before touching anything. It is a complete workflow contract — follow it literally.**

### A. Verify you are in the right place

You are running inside an AI Commander git worktree. Claude Code creates a fresh worktree per session.

First commands to run:

```bash
pwd
git status && git branch --show-current
ls apps/web/src/rendererCanvas.ts 2>/dev/null
ls "/Users/yuqiaohuang/MyProjects/AI Commander/tds-modern-pixel-game-kit/tds-modern-tilesets-environment/PNG/Tiles/" 2>/dev/null | head -5
```

**Required invariants** (all must be true — if any fails, STOP and tell the user):

1. `apps/web/src/rendererCanvas.ts` exists in cwd → you are in the AI Commander repo.
2. `apps/web/src/rendering/unitRenderer.ts` exists → the sprite integration is already merged to main.
3. The tileset assets exist at the stable external path `/Users/yuqiaohuang/MyProjects/AI Commander/tds-modern-pixel-game-kit/tds-modern-tilesets-environment/` and contain `PNG/Tiles/`, `PNG/Rocks/`, etc.
4. Current branch is NOT `main`. Claude Code's per-session worktree should put you on `claude/<adjective-name>`.

**The tileset assets are external.** They live in the main repo root directory, outside any worktree, at the absolute path above. Your copy scripts will reference this absolute path.

### B. Architectural constraints — NON-NEGOTIABLE

Same isolation rules as the sprite integration. The terrain upgrade must be deletable with `rm -rf` of the new files + reverting the surgical edits.

**Files you may NOT modify under any circumstance:**

- Anything under `packages/shared/` — no changes to `TerrainType`, `FacilityType`, `Facility`, `GameState`, terrain generation, or map data. The terrain generator and game logic are untouchable.
- Anything under `packages/core/` — game logic is untouchable.
- `apps/web/src/rendering/unitRenderer.ts`, `spriteManifest.ts`, `spriteLoader.ts`, `headingCache.ts`, `frameCache.ts`, `placeholderSprites.ts` — the existing sprite system is complete and frozen. Do not modify it.
- `apps/web/src/rendering/juice/` — muzzle flash and death smoke layers are frozen.

**Files you ARE allowed to modify, and the exact scope:**

| File | Allowed change |
|---|---|
| `apps/web/src/rendererCanvas.ts` lines 30-41 | Replace `TERRAIN_COLORS` usage in `renderTerrain()` with tile sprite drawing. The color table itself can remain as fallback. |
| `apps/web/src/rendererCanvas.ts` `renderTerrain()` (lines 183-236) | Replace `fillRect()` calls with `drawImage()` calls using preloaded terrain tile bitmaps. Grid lines can stay or be removed per visual judgment. |
| `apps/web/src/rendererCanvas.ts` `renderFacilities()` (lines 242-340) | Replace the colored-circle + symbol rendering with building sprite drawing for facility types that have sprites. Keep the HQ health bar, labels, and team color indicator. |
| `apps/web/src/rendererCanvas.ts` `buildMinimapCache()` (lines 131-177) | Update minimap to use El Alamein terrain colors (sandy tones instead of green). |
| `apps/web/src/GameCanvas.tsx` | Add terrain tile preload call alongside existing sprite preload. |
| `.gitignore` | Already has `tds-modern-pixel-game-kit/` entry from sprite integration. |

**Files you CREATE (purely additive):**

- `apps/web/src/rendering/terrain/` — new subdirectory for all terrain rendering code.
- `apps/web/public/sprites/tds/terrain/` — terrain tile PNGs served at runtime.
- `apps/web/public/sprites/tds/decorations/` — rock, sandbag, tree, building PNGs.
- `apps/web/public/sprites/tds/facilities/` — facility building sprites.

### C. Execution order and checkpoints

Work through §12's execution steps in order. Stop at each checkpoint:

1. **After step 3** (copy script run + tile manifests created) — report file tree + PNG count.
2. **After step 6** (terrain renderer + decoration layer complete) — run `pnpm dev`, describe visual result to user. This is the big visual checkpoint.
3. **After step 8** (facility sprites integrated) — describe visual result.
4. **After step 10** (minimap updated + final polish) — describe final state.
5. **Before any git operations** — stop completely. User commits manually.

### D. Git and commit policy

Same as sprite integration: **never commit, never push, never `git add -A`**. User does all git operations.

### E. Tooling gotchas

- `pnpm` monorepo. Dev: `pnpm dev` or `pnpm -C apps/web dev`.
- Path has a space (`AI Commander`). Quote in shell commands.
- Vite serves `apps/web/public/` at URL root. File at `apps/web/public/sprites/tds/terrain/sand_center.png` is fetched as `/sprites/tds/terrain/sand_center.png`.
- `imageSmoothingEnabled = false` must be applied for pixel art tiles (already set by sprite system — verify it's applied before terrain drawing too).

---

## 0. Context

### 0.1 What we're replacing

**Current terrain rendering** (`rendererCanvas.ts:183-236`):
- Each tile: `ctx.fillStyle = TERRAIN_COLORS[terrainType]; ctx.fillRect(...)` — a solid color rectangle.
- 10 terrain types, 10 hex colors. No texture, no variation, no decoration.
- Grid lines drawn when zoom >= 1.0.

**Current facility rendering** (`rendererCanvas.ts:242-340`):
- Each facility: colored circle with team-color border + single-character symbol (HQ, B, A, etc.) + text label.
- HQ gets a health bar. No building visuals.

### 0.2 What we have to work with

The CraftPix `tds-modern-tilesets-environment` pack contains:

**Terrain tile sheets** (all 320×320px, transparent background):
Each sheet is a single large terrain patch with organic/rough edges. These are NOT traditional grid-sliced tile sheets — they are whole-terrain textures meant to be used as large patches or sliced into a center region for seamless tiling.

| File | Content | El Alamein mapping |
|---|---|---|
| `_0002_SandTiles.png` (320×320) | Sandy desert terrain, tan/khaki | **PRIMARY** — plains, hills base |
| `_0001_DirtTiles.png` (320×320) | Dark brown earth | hills overlay, mountain transition |
| `_0003_GrassTiles.png` (320×320) | Dark green vegetation | forest, oasis areas |
| `_0004_RoadTiles.png` (320×320) | Dark asphalt with gold trim border | roads |
| `_0000_WTiles.png` (320×320) | Blue water with wave texture | shallow_water, deep_water |
| `BridgeTiles.png` (64×192) | Dark bridge surface | bridge terrain |
| `_0007_SandToRoad.png` (320×320) | Sand with road inset (transition) | road edges |
| `_0005_RoadDecals.png` (320×320) | Crack/damage overlays for roads | road variation |
| `Tiles.png` (64×320) | Reference strip: water, grass, sand, dirt, asphalt (5 samples stacked vertically, 64×64 each) | **KEY REFERENCE** for extracting clean center tiles |
| `TDS04_0001_RoadSand.png` (171×173) | Sand-bordered road frame | road variant |

**Decoration sprites** (individual PNGs, transparent background):

| Category | Files | El Alamein use |
|---|---|---|
| Rocks | `Rock01.png` (31×38), `Rock02.png` (48×62), `Rock03.png` (56×64) | Scatter on desert terrain (hills, plains) |
| Sandbags | `Sandbags.png` (85×23) | Near facilities, frontline positions |
| Houses | `House01.png` (132×132), `House02.png` (263×139) | Urban terrain, HQ compounds |
| WatchTower | `WatchTower.png` (72×72) | Observation posts, comm towers |
| Trees/Bushes | 6 small (25-66px), 4 large (104-161px) | Forest terrain, oasis |
| Crates/Barrels | 6 items (19-30px) | Near facilities (fuel depot, ammo depot) |

**Props from hero pack** (potential facility markers):

| File | Content | Facility mapping |
|---|---|---|
| `Props/Ammo/Army Box.png` | Military ammo crate | ammo_depot marker |
| `Props/Ammo/Ammo Box.png` | Ammo box | ammo_depot alt |
| `Crates Barrels/Barrel-oil.png` | Red oil drum | fuel_depot marker |

### 0.3 El Alamein color palette decisions

The real El Alamein is overwhelmingly sandy desert with scattered rocky ridges. The current TERRAIN_COLORS uses olive green (#6b8e23) for plains — completely wrong for North Africa.

**El Alamein-appropriate color mapping:**

| Terrain type | Current color | El Alamein reality | Tile approach |
|---|---|---|---|
| `plains` | #6b8e23 (olive) | **Sandy desert** | Use `SandTiles.png` center crop → repeating sand texture |
| `hills` | #556b2f (dark olive) | **Rocky ridges** | Sand texture + brown tint overlay + scattered rock decorations |
| `forest` | #2d5016 (dark green) | **Oasis / palm groves** (rare) | Grass texture + tree/bush decorations |
| `swamp` | #5c6b3a (murky green) | **Minefields** (Devil's Gardens) | Sand texture + darker danger tint + barbed wire pattern |
| `road` | #8b8682 (gray) | **Desert tracks & Via Balbia** | Road texture from `RoadTiles.png` or `Tiles.png` asphalt strip |
| `shallow_water` | #4a90c4 (light blue) | **Mediterranean coast** | Water texture, lighter |
| `deep_water` | #1e5fa8 (dark blue) | **Mediterranean Sea** | Water texture, darker |
| `bridge` | #9e9e9e (gray) | **Desert bridges** | Bridge texture from `BridgeTiles.png` |
| `urban` | #7a7a7a (gray) | **El Alamein town, HQ compounds** | Sand base + building decorations |
| `mountain` | #8b7355 (brown) | **Qattara Depression cliffs** | Dirt texture + heavy rock scattering |

### 0.4 User's explicit instructions

- Map terrain to El Alamein desert palette (sandy, not green)
- Use the purchased CraftPix tileset assets (same style as unit sprites)
- Check for building/facility sprite replacements (HQ, comm center, etc.)
- Don't break current architecture
- Only update map rendering, nothing else

---

## 1. Tile Extraction Strategy

The CraftPix tile sheets are **NOT** traditional auto-tile grids. They are 320×320 terrain patches with organic edges on transparent backgrounds. We need to extract usable repeating tiles from them.

### 1.1 The `Tiles.png` reference strip

`Tiles.png` is 64×320 — a vertical strip of 5 terrain samples, each 64×64:

| Y offset | Content | Maps to |
|---|---|---|
| 0-63 | Water (blue, wavy) | `deep_water`, `shallow_water` |
| 64-127 | Grass (dark green) | `forest` |
| 128-191 | Sand (tan/khaki) | `plains`, `hills` base |
| 192-255 | Dirt (dark brown) | `mountain`, `hills` overlay |
| 256-319 | Asphalt (dark gray) | `road` |

These 64×64 samples tile seamlessly and are the **primary source** for base terrain textures. We will slice them into individual 64×64 PNGs and use `drawImage()` with the canvas pattern API or simple repeated drawing.

### 1.2 Extraction approach

For each terrain type, we extract a **64×64 center crop** from the reference strip `Tiles.png`. These become our base repeating tiles:

```
Tiles.png (64×320) → slice into:
  water_tile.png    (64×64, y:0-63)
  grass_tile.png    (64×64, y:64-127)
  sand_tile.png     (64×64, y:128-191)
  dirt_tile.png     (64×64, y:192-255)
  road_tile.png     (64×64, y:256-319)
```

For terrain types without a direct tile (bridge, swamp, shallow_water), we apply tinting or overlays to the base tiles at render time.

### 1.3 Alternative: CanvasPattern for seamless tiling

Instead of calling `drawImage()` per tile, we can create `CanvasPattern` objects from the 64×64 tiles:

```typescript
const sandPattern = ctx.createPattern(sandBitmap, "repeat");
ctx.fillStyle = sandPattern;
ctx.fillRect(screenX, screenY, tileScreenSize, tileScreenSize);
```

This is efficient but doesn't respect camera zoom correctly (patterns don't scale with transforms). So we'll use the simpler approach: `drawImage()` per tile with the 64×64 source scaled to `tileScreenSize × tileScreenSize`.

---

## 2. File Structure to Create

```
apps/web/public/sprites/tds/terrain/
├── sand_tile.png           ← 64×64, sliced from Tiles.png y:128-191
├── dirt_tile.png            ← 64×64, sliced from Tiles.png y:192-255
├── grass_tile.png           ← 64×64, sliced from Tiles.png y:64-127
├── water_tile.png           ← 64×64, sliced from Tiles.png y:0-63
├── road_tile.png            ← 64×64, sliced from Tiles.png y:256-319
├── bridge_tile.png          ← 64×64, cropped from BridgeTiles.png center

apps/web/public/sprites/tds/decorations/
├── rock_01.png              ← Rock01 (31×38)
├── rock_02.png              ← Rock02 (48×62)
├── rock_03.png              ← Rock03 (56×64)
├── sandbags.png             ← Sandbags (85×23)
├── bush_01.png              ← Bush-01 (31×30)
├── bush_02.png              ← Bush-02 (66×28)
├── bush_03.png              ← Bush-03 (44×34)
├── tree_small_01.png        ← Tree05 (45×45)
├── tree_small_02.png        ← Tree06 (25×26)
├── tree_small_03.png        ← Tree07 (29×28)
├── tree_large_01.png        ← Tree1 (152×136)
├── tree_large_02.png        ← Tree2 (104×106)
├── tree_large_03.png        ← Tree3 (161×145)
├── tree_large_04.png        ← Tree4 (140×131)
├── barrel_oil.png           ← Barrel-oil (20×20)
├── barrel.png               ← Barrel (20×20)
├── crate_01.png             ← Box1 (30×31)
├── crate_02.png             ← Box-02 (30×31)
├── crate_small_01.png       ← Box1-mini (19×19)
├── crate_small_02.png       ← Box-02-mini (19×19)

apps/web/public/sprites/tds/facilities/
├── house_small.png          ← House01 (132×132) — for barracks, comm_tower, radar, repair_station
├── house_large.png          ← House02 (263×139) — for headquarters
├── watchtower.png           ← WatchTower (72×72) — for defense_tower, observation posts

apps/web/src/rendering/terrain/
├── terrainTileLoader.ts     ← Preloads all terrain tile ImageBitmaps
├── terrainManifest.ts       ← TerrainType → tile bitmap + tint mapping
├── terrainRenderer.ts       ← Replaces fillRect with drawImage, handles tinting
├── decorationLayer.ts       ← Seeded-random decoration placement (rocks, bushes, crates)
├── facilityRenderer.ts      ← Building sprite rendering (replaces colored circles)
└── minimapColors.ts         ← El Alamein-appropriate minimap color palette
```

---

## 3. TypeScript Types

```typescript
// apps/web/src/rendering/terrain/terrainManifest.ts

import type { TerrainType } from "@ai-commander/shared";

export interface TerrainTileEntry {
  /** Base tile bitmap key (matches filename without extension) */
  baseTile: string;
  /** Optional RGBA tint applied over the base tile (for terrain variants) */
  tint?: string;
  /** Optional opacity for the tint overlay (0-1) */
  tintOpacity?: number;
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
```

---

## 4. Terrain Manifest — El Alamein Edition

```typescript
// apps/web/src/rendering/terrain/terrainManifest.ts

export const TERRAIN_TILE_MANIFEST: Record<TerrainType, TerrainTileEntry> = {
  plains: {
    baseTile: "sand_tile",
    minimapColor: "#c2b280",  // desert sand
    decorations: [
      { spriteKey: "rock_01", density: 0.008, scaleRange: [0.3, 0.5], randomRotate: true },
    ],
  },
  hills: {
    baseTile: "sand_tile",
    tint: "rgba(139,115,85,0.3)",  // brownish overlay for rocky ridges
    tintOpacity: 0.3,
    minimapColor: "#a89070",  // darker sandy brown
    decorations: [
      { spriteKey: "rock_02", density: 0.04, scaleRange: [0.4, 0.7], randomRotate: true },
      { spriteKey: "rock_03", density: 0.03, scaleRange: [0.5, 0.8], randomRotate: true },
      { spriteKey: "rock_01", density: 0.02, scaleRange: [0.3, 0.5], randomRotate: true },
    ],
  },
  forest: {
    baseTile: "grass_tile",
    minimapColor: "#4a6b35",  // muted olive (oasis)
    decorations: [
      { spriteKey: "tree_large_01", density: 0.06, scaleRange: [0.8, 1.2], randomRotate: false },
      { spriteKey: "tree_large_02", density: 0.04, scaleRange: [0.7, 1.0], randomRotate: false },
      { spriteKey: "bush_01", density: 0.05, scaleRange: [0.4, 0.7], randomRotate: true },
      { spriteKey: "bush_03", density: 0.04, scaleRange: [0.5, 0.8], randomRotate: true },
    ],
  },
  swamp: {
    baseTile: "sand_tile",
    tint: "rgba(80,60,40,0.35)",  // darker danger tint (minefields)
    tintOpacity: 0.35,
    minimapColor: "#8a7a5a",  // muddy sand (minefield)
    decorations: [
      // Sparse — minefields are barren, maybe a few small rocks
      { spriteKey: "rock_01", density: 0.015, scaleRange: [0.2, 0.4], randomRotate: true },
    ],
  },
  road: {
    baseTile: "road_tile",
    minimapColor: "#6b6560",  // dark grayish
    decorations: [],  // roads are clean
  },
  shallow_water: {
    baseTile: "water_tile",
    tint: "rgba(100,180,220,0.15)",  // lighter blue tint
    tintOpacity: 0.15,
    minimapColor: "#5a9ec4",  // light blue
    decorations: [],
  },
  deep_water: {
    baseTile: "water_tile",
    minimapColor: "#2a6aa0",  // deep blue
    decorations: [],
  },
  bridge: {
    baseTile: "bridge_tile",
    minimapColor: "#7a7a7a",  // gray
    decorations: [],
  },
  urban: {
    baseTile: "sand_tile",
    tint: "rgba(120,120,120,0.2)",  // slight gray overlay for built-up areas
    tintOpacity: 0.2,
    minimapColor: "#9a9080",  // grayish sand
    decorations: [
      { spriteKey: "crate_01", density: 0.03, scaleRange: [0.3, 0.5], randomRotate: true },
      { spriteKey: "barrel", density: 0.02, scaleRange: [0.25, 0.4], randomRotate: true },
      { spriteKey: "sandbags", density: 0.02, scaleRange: [0.5, 0.8], randomRotate: false },
    ],
  },
  mountain: {
    baseTile: "dirt_tile",
    tint: "rgba(60,50,40,0.2)",  // darker cliff tint
    tintOpacity: 0.2,
    minimapColor: "#7a6545",  // dark brown (Qattara cliffs)
    decorations: [
      { spriteKey: "rock_03", density: 0.08, scaleRange: [0.6, 1.0], randomRotate: true },
      { spriteKey: "rock_02", density: 0.06, scaleRange: [0.5, 0.9], randomRotate: true },
      { spriteKey: "rock_01", density: 0.04, scaleRange: [0.3, 0.6], randomRotate: true },
    ],
  },
};
```

---

## 5. Facility → Building Sprite Mapping

Not all facility types have direct sprite matches. The strategy: use building sprites for facilities that represent physical structures, keep the icon system for abstract/small facilities.

```typescript
// apps/web/src/rendering/terrain/facilityRenderer.ts

export const FACILITY_SPRITE_MAP: Partial<Record<FacilityType, FacilitySpriteEntry>> = {
  headquarters: {
    spriteKey: "house_large",   // House02 (263×139) — largest building
    drawScale: 3.5,              // dominant visual on map
    showTeamBorder: true,
  },
  barracks: {
    spriteKey: "house_small",   // House01 (132×132)
    drawScale: 2.5,
    showTeamBorder: true,
  },
  airfield: {
    spriteKey: "house_large",   // reuse large building for airfields
    drawScale: 3.0,
    showTeamBorder: true,
  },
  comm_tower: {
    spriteKey: "watchtower",    // WatchTower (72×72) — perfect for comms
    drawScale: 2.0,
    showTeamBorder: true,
  },
  radar: {
    spriteKey: "watchtower",    // reuse watchtower for radar
    drawScale: 2.0,
    showTeamBorder: true,
  },
  defense_tower: {
    spriteKey: "watchtower",    // watchtower for defense
    drawScale: 2.0,
    showTeamBorder: true,
  },
  repair_station: {
    spriteKey: "house_small",   // small building for repair
    drawScale: 2.0,
    showTeamBorder: true,
  },
};

// Facilities NOT in this map keep their current icon rendering:
// fuel_depot   → keep colored circle + ⎈ symbol (no matching building, use crate/barrel decoration nearby)
// ammo_depot   → keep colored circle + ◆ symbol (same reasoning)
// shipyard     → keep icon (not relevant for El Alamein)
// rail_hub     → keep icon
```

---

## 6. Terrain Tile Loader

```typescript
// apps/web/src/rendering/terrain/terrainTileLoader.ts

const TERRAIN_TILE_PATHS: Record<string, string> = {
  sand_tile:    "/sprites/tds/terrain/sand_tile.png",
  dirt_tile:    "/sprites/tds/terrain/dirt_tile.png",
  grass_tile:   "/sprites/tds/terrain/grass_tile.png",
  water_tile:   "/sprites/tds/terrain/water_tile.png",
  road_tile:    "/sprites/tds/terrain/road_tile.png",
  bridge_tile:  "/sprites/tds/terrain/bridge_tile.png",
};

const DECORATION_PATHS: Record<string, string> = {
  rock_01:          "/sprites/tds/decorations/rock_01.png",
  rock_02:          "/sprites/tds/decorations/rock_02.png",
  rock_03:          "/sprites/tds/decorations/rock_03.png",
  sandbags:         "/sprites/tds/decorations/sandbags.png",
  bush_01:          "/sprites/tds/decorations/bush_01.png",
  bush_02:          "/sprites/tds/decorations/bush_02.png",
  bush_03:          "/sprites/tds/decorations/bush_03.png",
  tree_small_01:    "/sprites/tds/decorations/tree_small_01.png",
  tree_small_02:    "/sprites/tds/decorations/tree_small_02.png",
  tree_small_03:    "/sprites/tds/decorations/tree_small_03.png",
  tree_large_01:    "/sprites/tds/decorations/tree_large_01.png",
  tree_large_02:    "/sprites/tds/decorations/tree_large_02.png",
  tree_large_03:    "/sprites/tds/decorations/tree_large_03.png",
  tree_large_04:    "/sprites/tds/decorations/tree_large_04.png",
  barrel_oil:       "/sprites/tds/decorations/barrel_oil.png",
  barrel:           "/sprites/tds/decorations/barrel.png",
  crate_01:         "/sprites/tds/decorations/crate_01.png",
  crate_02:         "/sprites/tds/decorations/crate_02.png",
  crate_small_01:   "/sprites/tds/decorations/crate_small_01.png",
  crate_small_02:   "/sprites/tds/decorations/crate_small_02.png",
};

const FACILITY_SPRITE_PATHS: Record<string, string> = {
  house_small:  "/sprites/tds/facilities/house_small.png",
  house_large:  "/sprites/tds/facilities/house_large.png",
  watchtower:   "/sprites/tds/facilities/watchtower.png",
};

// Load all bitmaps via createImageBitmap (same pattern as sprite loader)
// Store in a Map<string, ImageBitmap>
// Export: preloadTerrainTiles(): Promise<void>
// Export: getTerrainBitmap(key: string): ImageBitmap | null
```

Implementation pattern: same as `spriteLoader.ts` in the existing sprite system. Use `fetch()` + `createImageBitmap()` for GPU-resident bitmaps. Log count on completion: `[terrain] loaded N bitmaps`.

---

## 7. Terrain Renderer — The Core Change

### 7.1 What changes in `renderTerrain()`

**Current** (lines 206-214):
```typescript
for (let row = startRow; row < endRow; row++) {
  for (let col = startCol; col < endCol; col++) {
    const t = terrain[row]?.[col] ?? "plains";
    ctx.fillStyle = TERRAIN_COLORS[t];
    ctx.fillRect(screenX, screenY, tileScreenSize + 0.5, tileScreenSize + 0.5);
  }
}
```

**New**:
```typescript
for (let row = startRow; row < endRow; row++) {
  for (let col = startCol; col < endCol; col++) {
    const t = terrain[row]?.[col] ?? "plains";
    const entry = TERRAIN_TILE_MANIFEST[t];
    const bitmap = getTerrainBitmap(entry.baseTile);

    const screenX = (col * TILE_SIZE - camera.x) * camera.zoom;
    const screenY = (row * TILE_SIZE - camera.y) * camera.zoom;
    const size = tileScreenSize + 0.5;

    if (bitmap) {
      ctx.drawImage(bitmap, screenX, screenY, size, size);

      // Apply tint overlay if specified
      if (entry.tint && entry.tintOpacity) {
        ctx.fillStyle = entry.tint;
        ctx.fillRect(screenX, screenY, size, size);
      }
    } else {
      // Fallback to flat color (use minimap color as fallback)
      ctx.fillStyle = entry.minimapColor;
      ctx.fillRect(screenX, screenY, size, size);
    }
  }
}
```

### 7.2 `imageSmoothingEnabled` check

Before the tile loop, verify pixel art rendering is crisp:
```typescript
ctx.imageSmoothingEnabled = false;
```

This should already be set by the sprite system, but verify it's applied before terrain drawing in the render pipeline.

### 7.3 Grid lines

**Keep grid lines but make them more subtle** — change to `rgba(0,0,0,0.05)` (from current 0.1) so they don't overpower the tile textures. Or remove them entirely — use visual judgment at the checkpoint.

### 7.4 Performance note

**500×300 = 150,000 tiles total, but only visible tiles are drawn** (camera culling at lines 195-204). At typical zoom levels, ~1000-3000 tiles are visible. Each tile = 1 `drawImage()` call + maybe 1 `fillRect()` for tint = 2000-6000 draw calls. This is well within Canvas 2D budget for 60fps on M-series Macs. The existing sprite system already does 1500+ `drawImage()` calls per frame for units.

---

## 8. Decoration Layer

Decorations (rocks, bushes, trees, crates) are scattered on terrain tiles based on the `DecorationRule` in the manifest. They must be **deterministic** — same seed, same positions every frame — so they don't jitter.

### 8.1 Seeded random placement

Use the same LCG (Linear Congruential Generator) pattern as `terrainGen.ts`:

```typescript
function lcgRandom(seed: number): number {
  const next = (seed * 1103515245 + 12345) & 0x7fffffff;
  return next / 0x7fffffff;
}

function tileHash(col: number, row: number, decorIndex: number): number {
  // Deterministic seed per tile+decoration combination
  return col * 73856093 + row * 19349663 + decorIndex * 83492791;
}
```

### 8.2 Decoration rendering pass

After the base terrain loop, run a second pass for decorations:

```typescript
function renderDecorations(
  ctx: CanvasRenderingContext2D,
  terrain: TerrainType[][],
  camera: Camera,
  canvasWidth: number,
  canvasHeight: number,
): void {
  // Same visible tile range as terrain
  for (let row = startRow; row < endRow; row++) {
    for (let col = startCol; col < endCol; col++) {
      const t = terrain[row]?.[col] ?? "plains";
      const entry = TERRAIN_TILE_MANIFEST[t];
      if (!entry.decorations?.length) continue;

      for (let di = 0; di < entry.decorations.length; di++) {
        const rule = entry.decorations[di];
        const seed = tileHash(col, row, di);
        const roll = lcgRandom(seed);
        if (roll > rule.density) continue;  // no decoration at this tile

        const bitmap = getTerrainBitmap(rule.spriteKey);
        if (!bitmap) continue;

        // Position offset within tile (deterministic)
        const ox = lcgRandom(seed + 1) * 0.6 + 0.2;  // 0.2-0.8 range
        const oy = lcgRandom(seed + 2) * 0.6 + 0.2;
        const scale = rule.scaleRange[0] + lcgRandom(seed + 3) * (rule.scaleRange[1] - rule.scaleRange[0]);

        const screenX = (col * TILE_SIZE - camera.x) * camera.zoom;
        const screenY = (row * TILE_SIZE - camera.y) * camera.zoom;
        const dx = screenX + ox * tileScreenSize;
        const dy = screenY + oy * tileScreenSize;
        const dw = bitmap.width * scale * (tileScreenSize / TILE_SIZE);
        const dh = bitmap.height * scale * (tileScreenSize / TILE_SIZE);

        if (rule.randomRotate) {
          const angle = lcgRandom(seed + 4) * Math.PI * 2;
          ctx.save();
          ctx.translate(dx, dy);
          ctx.rotate(angle);
          ctx.drawImage(bitmap, -dw / 2, -dh / 2, dw, dh);
          ctx.restore();
        } else {
          ctx.drawImage(bitmap, dx - dw / 2, dy - dh / 2, dw, dh);
        }
      }
    }
  }
}
```

### 8.3 Decoration density tuning

The `density` values in §4 are starting points. After the first visual checkpoint, the user may want to adjust:
- More rocks on hills/mountains
- Fewer decorations at low zoom (performance)
- Tree scale adjustments for forest tiles

**LOD optimization**: Skip decoration rendering when `camera.zoom < 0.4` (tiles are too small to see decorations). This eliminates thousands of `drawImage` calls when zoomed out to full map.

---

## 9. Facility Renderer Upgrade

### 9.1 Building sprite rendering

For facilities with entries in `FACILITY_SPRITE_MAP`:

```typescript
function renderFacilitySprite(
  ctx: CanvasRenderingContext2D,
  fac: Facility,
  entry: FacilitySpriteEntry,
  cx: number, cy: number,
  tileScreenSize: number,
): void {
  const bitmap = getTerrainBitmap(entry.spriteKey);
  if (!bitmap) return;  // fallback to icon

  const drawSize = tileScreenSize * entry.drawScale;
  const aspect = bitmap.width / bitmap.height;
  const dw = aspect >= 1 ? drawSize : drawSize * aspect;
  const dh = aspect >= 1 ? drawSize / aspect : drawSize;

  // Team color indicator (subtle ground glow)
  if (entry.showTeamBorder) {
    const glowColor = fac.team === "player" ? "rgba(0,100,255,0.25)"
                    : fac.team === "enemy" ? "rgba(255,50,50,0.25)"
                    : "rgba(180,180,180,0.15)";
    ctx.fillStyle = glowColor;
    ctx.beginPath();
    ctx.ellipse(cx, cy, dw / 2 + 4, dh / 2 + 4, 0, 0, Math.PI * 2);
    ctx.fill();
  }

  // Draw building sprite
  ctx.drawImage(bitmap, cx - dw / 2, cy - dh / 2, dw, dh);
}
```

### 9.2 Hybrid rendering in `renderFacilities()`

Modify the existing function to check `FACILITY_SPRITE_MAP` first:

```typescript
for (const fac of facilities) {
  // ... existing screen position + culling code stays ...

  const spriteEntry = FACILITY_SPRITE_MAP[fac.type];
  if (spriteEntry && getTerrainBitmap(spriteEntry.spriteKey)) {
    // New: render building sprite
    renderFacilitySprite(ctx, fac, spriteEntry, cx, cy, tileScreenSize);
  } else {
    // Existing: render colored circle + symbol (unchanged)
    // ... keep existing code for facilities without sprites ...
  }

  // Label rendering stays the same for both paths
  // HQ health bar stays the same
}
```

### 9.3 Keep existing systems

- **HQ health bar** (lines 302-334): Keep as-is, render ABOVE the building sprite.
- **Facility labels** (lines 292-300): Keep as-is, render below the building sprite.
- **Capture progress**: If the facility has capture UI, keep it above the sprite.
- **Icon-only facilities** (fuel_depot, ammo_depot, shipyard, rail_hub): No change. They keep their colored circle + symbol.

---

## 10. Minimap Color Update

### 10.1 Replace minimap terrain colors

The `buildMinimapCache()` function (lines 131-177) uses `TERRAIN_COLORS` to paint the minimap. Replace with El Alamein-appropriate colors from the manifest:

```typescript
// In buildMinimapCache():
// Change line 166 from:
//   octx.fillStyle = TERRAIN_COLORS[t];
// To:
//   octx.fillStyle = TERRAIN_TILE_MANIFEST[t]?.minimapColor ?? TERRAIN_COLORS[t];
```

This gives the minimap sandy/brown tones matching the actual map appearance instead of the olive/green TERRAIN_COLORS.

### 10.2 Minimap colors (from §4 manifest)

| Terrain | Old minimap color | New minimap color | Visual |
|---|---|---|---|
| plains | #6b8e23 (olive) | #c2b280 (desert sand) | Sandy |
| hills | #556b2f (dark olive) | #a89070 (darker sandy) | Rocky |
| forest | #2d5016 (dark green) | #4a6b35 (muted olive) | Oasis |
| swamp | #5c6b3a (murky) | #8a7a5a (muddy sand) | Minefield |
| road | #8b8682 (gray) | #6b6560 (dark gray) | Track |
| shallow_water | #4a90c4 (same) | #5a9ec4 (same) | Coast |
| deep_water | #1e5fa8 (same) | #2a6aa0 (same) | Sea |
| bridge | #9e9e9e (same) | #7a7a7a (same) | Bridge |
| urban | #7a7a7a (gray) | #9a9080 (grayish sand) | Town |
| mountain | #8b7355 (same) | #7a6545 (dark brown) | Cliffs |

---

## 11. Tile Extraction Script

```bash
#!/bin/bash
# scripts/copy-terrain-tiles.sh
# Extracts and copies terrain tiles from purchased CraftPix asset pack
# into the Vite public directory for runtime serving.

set -euo pipefail

SRC="/Users/yuqiaohuang/MyProjects/AI Commander/tds-modern-pixel-game-kit/tds-modern-tilesets-environment/PNG"
DEST_TERRAIN="apps/web/public/sprites/tds/terrain"
DEST_DECOR="apps/web/public/sprites/tds/decorations"
DEST_FACIL="apps/web/public/sprites/tds/facilities"

mkdir -p "$DEST_TERRAIN" "$DEST_DECOR" "$DEST_FACIL"

# --- Terrain base tiles ---
# The reference strip Tiles.png (64×320) contains 5 stacked 64×64 tiles.
# We need to slice it. Use ImageMagick (convert/magick) or Python PIL.
# If neither is available, we can slice at runtime in the loader.
# For now, try ImageMagick:

if command -v magick &>/dev/null || command -v convert &>/dev/null; then
  CONVERT_CMD=$(command -v magick || command -v convert)
  echo "Using ImageMagick to slice Tiles.png..."
  "$CONVERT_CMD" "$SRC/Tiles/Tiles.png" -crop 64x64+0+0   "$DEST_TERRAIN/water_tile.png"
  "$CONVERT_CMD" "$SRC/Tiles/Tiles.png" -crop 64x64+0+64  "$DEST_TERRAIN/grass_tile.png"
  "$CONVERT_CMD" "$SRC/Tiles/Tiles.png" -crop 64x64+0+128 "$DEST_TERRAIN/sand_tile.png"
  "$CONVERT_CMD" "$SRC/Tiles/Tiles.png" -crop 64x64+0+192 "$DEST_TERRAIN/dirt_tile.png"
  "$CONVERT_CMD" "$SRC/Tiles/Tiles.png" -crop 64x64+0+256 "$DEST_TERRAIN/road_tile.png"
  # Bridge: crop center 64×64 from BridgeTiles (64×192)
  "$CONVERT_CMD" "$SRC/Tiles/BridgeTiles.png" -crop 64x64+0+64 "$DEST_TERRAIN/bridge_tile.png"
else
  echo "WARNING: ImageMagick not found. Copying full tile sheets instead."
  echo "The terrainTileLoader will need to handle slicing at runtime."
  cp "$SRC/Tiles/Tiles.png" "$DEST_TERRAIN/tiles_strip.png"
  cp "$SRC/Tiles/BridgeTiles.png" "$DEST_TERRAIN/bridge_full.png"
fi

# --- Decorations ---
cp "$SRC/Rocks/TDS04_0005_Rock01.png"       "$DEST_DECOR/rock_01.png"
cp "$SRC/Rocks/TDS04_0004_Rock02.png"       "$DEST_DECOR/rock_02.png"
cp "$SRC/Rocks/TDS04_0003_Rock03.png"       "$DEST_DECOR/rock_03.png"
cp "$SRC/SandBag/TDS04_0002_Sandbags.png"   "$DEST_DECOR/sandbags.png"
cp "$SRC/Trees Bushes/TDS04_0012_Bush-01.png"  "$DEST_DECOR/bush_01.png"
cp "$SRC/Trees Bushes/TDS04_0011_Bush-02.png"  "$DEST_DECOR/bush_02.png"
cp "$SRC/Trees Bushes/TDS04_0010_Bush-03.png"  "$DEST_DECOR/bush_03.png"
cp "$SRC/Trees Bushes/TDS04_0008_Tree05.png"   "$DEST_DECOR/tree_small_01.png"
cp "$SRC/Trees Bushes/TDS04_0007_Tree06.png"   "$DEST_DECOR/tree_small_02.png"
cp "$SRC/Trees Bushes/TDS04_0006_Tree07.png"   "$DEST_DECOR/tree_small_03.png"
cp "$SRC/Trees Bushes/TDS04_0022_Tree1.png"    "$DEST_DECOR/tree_large_01.png"
cp "$SRC/Trees Bushes/TDS04_0021_Tree2.png"    "$DEST_DECOR/tree_large_02.png"
cp "$SRC/Trees Bushes/TDS04_0020_Tree3.png"    "$DEST_DECOR/tree_large_03.png"
cp "$SRC/Trees Bushes/TDS04_0019_Tree4.png"    "$DEST_DECOR/tree_large_04.png"
cp "$SRC/Crates Barrels/TDS04_0015_Barrel-oil.png"  "$DEST_DECOR/barrel_oil.png"
cp "$SRC/Crates Barrels/TDS04_0016_Barrel.png"      "$DEST_DECOR/barrel.png"
cp "$SRC/Crates Barrels/TDS04_0018_Box1.png"         "$DEST_DECOR/crate_01.png"
cp "$SRC/Crates Barrels/TDS04_0013_Box-02.png"       "$DEST_DECOR/crate_02.png"
cp "$SRC/Crates Barrels/TDS04_0017_Box1-mini.png"    "$DEST_DECOR/crate_small_01.png"
cp "$SRC/Crates Barrels/TDS04_0014_Box-02-mini.png"  "$DEST_DECOR/crate_small_02.png"

# --- Facility buildings ---
cp "$SRC/House/TDS04_0000_House01.png"       "$DEST_FACIL/house_small.png"
cp "$SRC/House/TDS04_House02.png"            "$DEST_FACIL/house_large.png"
cp "$SRC/WatchTower/TDS04_0009_WatchTower.png"  "$DEST_FACIL/watchtower.png"

echo ""
echo "Terrain tiles: $(ls -1 "$DEST_TERRAIN" | wc -l | tr -d ' ') files"
echo "Decorations:   $(ls -1 "$DEST_DECOR" | wc -l | tr -d ' ') files"
echo "Facilities:    $(ls -1 "$DEST_FACIL" | wc -l | tr -d ' ') files"
echo "Done."
```

### 11.1 Runtime slicing fallback

If ImageMagick is not available, the tile loader can slice `Tiles.png` at runtime using `createImageBitmap()` with crop parameters:

```typescript
// Slice a 64×64 region from a larger image
const sandBitmap = await createImageBitmap(tilesStripImage, 0, 128, 64, 64);
```

This is the preferred approach if we want to avoid the ImageMagick dependency. The loader can:
1. Fetch `Tiles.png` as a single image
2. Call `createImageBitmap(img, sx, sy, sw, sh)` for each tile slice
3. Store each slice as a named bitmap in the cache

This completely eliminates the need for pre-slicing and works everywhere.

---

## 12. Execution Order

1. ☐ Write `scripts/copy-terrain-tiles.sh` and run it (or implement runtime slicing in step 3)
2. ☐ Create `apps/web/src/rendering/terrain/terrainManifest.ts` — types + manifest from §3, §4
3. ☐ Create `terrainTileLoader.ts` — preload all terrain/decoration/facility bitmaps (§6). Include runtime tile slicing from `Tiles.png` if pre-sliced files don't exist.
4. ☐ Create `terrainRenderer.ts` — the new `renderTerrainTiles()` function (§7)
5. ☐ Create `decorationLayer.ts` — seeded decoration rendering (§8)
6. ☐ **SURGICAL EDIT** `rendererCanvas.ts` `renderTerrain()`: Replace the `fillRect` loop (lines 206-214) with calls to `renderTerrainTiles()` + `renderDecorations()`. Keep camera culling logic. Keep grid lines (with reduced opacity).
7. ☐ Create `facilityRenderer.ts` — building sprite rendering (§9)
8. ☐ **SURGICAL EDIT** `rendererCanvas.ts` `renderFacilities()`: Add sprite path before the existing icon path (§9.2). Keep HQ health bar, labels, capture progress unchanged.
9. ☐ Create `minimapColors.ts` — export `TERRAIN_MINIMAP_COLORS` from manifest
10. ☐ **SURGICAL EDIT** `rendererCanvas.ts` `buildMinimapCache()`: Replace `TERRAIN_COLORS[t]` with El Alamein minimap colors (§10.1)
11. ☐ **EDIT** `GameCanvas.tsx`: Add `preloadTerrainTiles()` call alongside existing `preloadSprites()`.
12. ☐ Run `pnpm dev` — visual verification:
    - Plains should be sandy desert, not olive green
    - Rocks scattered on hills/mountains
    - Trees on forest tiles
    - Buildings visible at HQ / barracks locations
    - Minimap shows sandy tones
    - Performance check: 55+ fps at full scenario
13. ☐ Tune decoration densities, tint opacities, and facility sprite scales based on visual result
14. ☐ Final polish: decide on grid line visibility, adjust decoration LOD threshold

---

## 13. Testing Plan

### 13.1 Smoke test
1. Run `pnpm dev` after steps 1-6.
2. Open El Alamein scenario.
3. Network tab: confirm terrain tile PNGs load (200 OK, no 404s).
4. Console: confirm `[terrain] loaded N bitmaps` log.

### 13.2 Visual verification
1. **Desert feel**: Plains should be sandy tan, not green. The overall map should read as "North African desert."
2. **Hills/ridges**: Should look rockier than flat plains (darker tint + rock decorations).
3. **Forest/oasis**: Green with trees. Should be rare and stand out from the sand.
4. **Roads**: Dark tracks cutting through sand. Via Balbia should be clearly visible.
5. **Water**: Mediterranean Sea in the north should be blue with wave texture.
6. **Minefields (swamp)**: Darker sand, ominous. The Devil's Gardens should look distinct from regular sand.
7. **Urban**: Sand base with crates/barrels/sandbags scattered.
8. **Mountains (Qattara)**: Dark brown/dirt with heavy rocks. Should look impassable.
9. **Facilities with buildings**: HQ should show House02, barracks show House01, comm tower shows WatchTower.
10. **Facilities with icons**: Fuel depot, ammo depot should still show colored circles.
11. **Minimap**: Sandy tones, not olive green.
12. **Zoom out (0.3x)**: Tiles still visible, decorations hidden (LOD), no performance drop.
13. **Zoom in (2.0x)**: Tiles crisp (no blur), decorations visible, pixel art clean.

### 13.3 Performance
1. Full El Alamein with ~200 units active: ≥55 fps.
2. If decorations cause frame drops at high zoom, reduce density or add zoom-based LOD.

### 13.4 Fallback
1. If any tile bitmap fails to load, terrain should fall back to flat color (minimap color from manifest, not olive green).
2. If facility bitmap fails to load, facility should render with existing icon system.

---

## 14. Known Unknowns

- **Tile seam artifacts**: Adjacent tiles may show hairline gaps at certain zoom levels. The existing `+ 0.5` on tileScreenSize helps but may need adjustment. If seams appear, try `Math.ceil(tileScreenSize) + 1` for slight overlap.
- **Decoration performance at high density**: If forest tiles with 4 decoration rules cause frame drops, add zoom-based LOD (skip decorations below zoom threshold).
- **Tile visual monotony**: A single 64×64 sand tile repeated across 80% of the map may look too uniform. If so, consider: (a) using 2-3 sand tile variants with random selection per tile, or (b) adding subtle random tint variation per tile using the LCG.
- **Bridge tile orientation**: `BridgeTiles.png` is 64×192 (portrait). Bridges may need rotation for horizontal crossing. Check at visual verification.
- **House02 aspect ratio**: 263×139 is wide. When drawn at the HQ position, it may overlap adjacent tiles. Adjust `drawScale` if needed.
- **ImageMagick availability**: If the user's machine doesn't have ImageMagick, the copy script can't pre-slice tiles. The runtime slicing fallback in §11.1 is the safe option — implement it as the primary path.

---

## 15. Things Explicitly NOT in Scope

- ❌ Don't implement auto-tiling / Wang tiles (terrain transitions). Simple per-tile textures with tint overlays are sufficient for MVP.
- ❌ Don't add terrain animation (water waves, sand blowing). Static tiles only.
- ❌ Don't change `TerrainType` enum or terrain generation logic in `packages/shared/`.
- ❌ Don't add new facility types or change `FacilityType`.
- ❌ Don't touch unit rendering, combat, AI, pathfinding, or game logic.
- ❌ Don't build a tile editor or map editor.
- ❌ Don't ship PSD files.
- ❌ Don't implement fog of war visual changes (that's a separate task).
- ❌ Don't change the render pipeline order (terrain → fog → facilities → units → juice → minimap → combat effects → battle markers). Only change what happens INSIDE `renderTerrain()` and `renderFacilities()`.

---

## 16. Future Extensions (post-MVP)

- **Terrain transitions**: Auto-tiling with the transition sheets (`SandToRoad.png`, `GrassToRoad.png`, `DirtToRoad.png`) for smooth edges between terrain types.
- **Animated water**: Simple 2-frame animation for water tiles using the wave texture.
- **Seasonal/time-of-day tinting**: Global color overlay for dawn/dusk atmosphere.
- **Destructible environment**: Buildings show damage when facilities take HP loss.
- **Minefield visual markers**: Barbed wire or skull icons on swamp tiles to make minefields more obvious.
- **Sound integration**: Environmental audio based on terrain (wind for desert, waves for coast). This is the next upgrade after map.

---

## 17. Estimated Effort

| Step | Task | Hours |
|---|---|---|
| 1-3 | Asset copy + manifest + loader | ~2h |
| 4-5 | Terrain renderer + decoration layer | ~3h |
| 6 | Surgical edit to rendererCanvas.ts (terrain) | ~1h |
| 7-8 | Facility renderer + surgical edit | ~2h |
| 9-10 | Minimap + GameCanvas preload | ~0.5h |
| 11-13 | Visual tuning + performance check | ~1.5h |
| **Total** | | **~10h** |

---

## 18. End State

When complete, the El Alamein map should look like a North African desert battlefield:
- Vast sandy plains with scattered rocks
- Rocky ridges at Tel el Eisa, Kidney Ridge, Ruweisat
- Dark ominous minefield zones (Devil's Gardens)
- Green oasis patches for forest
- Dark road tracks crossing the desert
- Blue Mediterranean Sea to the north
- Brown Qattara Depression cliffs to the south
- Military buildings at HQ, barracks, and key facilities
- Watchtowers at communication and radar positions
- Crates and barrels near supply depots
- Minimap reflecting the desert palette

All unit sprites (already integrated) will be running on textured terrain instead of flat color blocks. The visual upgrade will be immediately obvious and dramatically improve immersion.
