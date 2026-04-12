// ============================================================
// Decoration Layer — Seeded-random scatter of rocks, bushes,
// trees, crates on terrain tiles. Deterministic per tile.
// ============================================================

import type { TerrainType } from "@ai-commander/shared";
import { TILE_SIZE } from "@ai-commander/shared";
import { TERRAIN_TILE_MANIFEST } from "./terrainManifest";
import { getTerrainBitmap } from "./terrainTileLoader";
import type { Camera } from "../../rendererCanvas";

// --- LCG deterministic random ---

function lcgRandom(seed: number): number {
  const next = (seed * 1103515245 + 12345) & 0x7fffffff;
  return next / 0x7fffffff;
}

function tileHash(col: number, row: number, decorIndex: number): number {
  return col * 73856093 + row * 19349663 + decorIndex * 83492791;
}

/**
 * Render decoration sprites (rocks, bushes, trees, crates) over terrain.
 * Called after the base terrain tile pass.
 * Skips when zoomed out too far (LOD optimization).
 */
export function renderDecorations(
  ctx: CanvasRenderingContext2D,
  terrain: TerrainType[][],
  camera: Camera,
  canvasWidth: number,
  canvasHeight: number,
): void {
  // LOD: skip decorations when tiles are too small to see them
  if (camera.zoom < 0.4) return;

  const tileScreenSize = TILE_SIZE * camera.zoom;

  const mapCols = terrain[0]?.length ?? 0;
  const mapRows = terrain.length;
  const startCol = Math.max(0, Math.floor(camera.x / TILE_SIZE));
  const startRow = Math.max(0, Math.floor(camera.y / TILE_SIZE));
  const endCol = Math.min(
    mapCols,
    Math.ceil((camera.x + canvasWidth / camera.zoom) / TILE_SIZE),
  );
  const endRow = Math.min(
    mapRows,
    Math.ceil((camera.y + canvasHeight / camera.zoom) / TILE_SIZE),
  );

  ctx.imageSmoothingEnabled = false;

  for (let row = startRow; row < endRow; row++) {
    for (let col = startCol; col < endCol; col++) {
      const t: TerrainType = terrain[row]?.[col] ?? "plains";
      const entry = TERRAIN_TILE_MANIFEST[t];
      if (!entry.decorations?.length) continue;

      for (let di = 0; di < entry.decorations.length; di++) {
        const rule = entry.decorations[di];
        const seed = tileHash(col, row, di);
        const roll = lcgRandom(seed);
        if (roll > rule.density) continue;

        const bitmap = getTerrainBitmap(rule.spriteKey);
        if (!bitmap) continue;

        // Deterministic position offset within tile (0.2-0.8 range)
        const ox = lcgRandom(seed + 1) * 0.6 + 0.2;
        const oy = lcgRandom(seed + 2) * 0.6 + 0.2;
        const scale =
          rule.scaleRange[0] +
          lcgRandom(seed + 3) * (rule.scaleRange[1] - rule.scaleRange[0]);

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
