// ============================================================
// Terrain Tile Renderer — Replaces fillRect with drawImage
// for pixel-art terrain tiles. Handles tint overlays.
// ============================================================

import type { TerrainType } from "@ai-commander/shared";
import { TILE_SIZE } from "@ai-commander/shared";
import { TERRAIN_TILE_MANIFEST } from "./terrainManifest";
import { getTerrainBitmap } from "./terrainTileLoader";
import type { Camera } from "../../rendererCanvas";

/**
 * Draw terrain tiles for all visible cells. Replaces the old
 * `fillRect(TERRAIN_COLORS[t])` loop with bitmap drawImage calls.
 */
export function renderTerrainTiles(
  ctx: CanvasRenderingContext2D,
  terrain: TerrainType[][],
  camera: Camera,
  canvasWidth: number,
  canvasHeight: number,
): void {
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

  // Ensure pixel-art crispness
  ctx.imageSmoothingEnabled = false;

  const size = tileScreenSize + 0.5;

  for (let row = startRow; row < endRow; row++) {
    for (let col = startCol; col < endCol; col++) {
      const t: TerrainType = terrain[row]?.[col] ?? "plains";
      const entry = TERRAIN_TILE_MANIFEST[t];
      const bitmap = getTerrainBitmap(entry.baseTile);

      const screenX = (col * TILE_SIZE - camera.x) * camera.zoom;
      const screenY = (row * TILE_SIZE - camera.y) * camera.zoom;

      if (bitmap) {
        ctx.drawImage(bitmap, screenX, screenY, size, size);

        // Apply tint overlay if specified
        if (entry.tint) {
          ctx.fillStyle = entry.tint;
          ctx.fillRect(screenX, screenY, size, size);
        }
      } else {
        // Fallback to flat color
        ctx.fillStyle = entry.minimapColor;
        ctx.fillRect(screenX, screenY, size, size);
      }
    }
  }
}
