// ============================================================
// Facility Sprite Renderer — Draws building sprites for
// facilities that have entries in FACILITY_SPRITE_MAP.
// ============================================================

import type { Facility } from "@ai-commander/shared";
import { getTerrainBitmap } from "./terrainTileLoader";
import type { FacilitySpriteEntry } from "./terrainManifest";

/**
 * Render a building sprite for a facility, with team-color ground glow.
 * Returns true if the sprite was drawn, false if fallback needed.
 */
export function renderFacilitySprite(
  ctx: CanvasRenderingContext2D,
  fac: Facility,
  entry: FacilitySpriteEntry,
  cx: number,
  cy: number,
  tileScreenSize: number,
): boolean {
  const bitmap = getTerrainBitmap(entry.spriteKey);
  if (!bitmap) return false;

  const drawSize = tileScreenSize * entry.drawScale;
  const aspect = bitmap.width / bitmap.height;
  const dw = aspect >= 1 ? drawSize : drawSize * aspect;
  const dh = aspect >= 1 ? drawSize / aspect : drawSize;

  // Team color indicator (subtle ground glow)
  if (entry.showTeamBorder) {
    const glowColor =
      fac.team === "player"
        ? "rgba(0,100,255,0.25)"
        : fac.team === "enemy"
          ? "rgba(255,50,50,0.25)"
          : "rgba(180,180,180,0.15)";
    ctx.fillStyle = glowColor;
    ctx.beginPath();
    ctx.ellipse(cx, cy, dw / 2 + 4, dh / 2 + 4, 0, 0, Math.PI * 2);
    ctx.fill();
  }

  // Draw building sprite
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(bitmap, cx - dw / 2, cy - dh / 2, dw, dh);

  return true;
}
