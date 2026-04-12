// ============================================================
// AI Commander — Placeholder Sprites
// Procedural circle/hexagon/star fallback for unit types without a sprite
// manifest entry. Lifted verbatim from rendererCanvas.ts:418-431 so the old
// visual still works for anything unmapped.
//
// See SPRITE_INTEGRATION_PLAN.md §15 step 6.
// ============================================================

import type { Unit } from "@ai-commander/shared";

function drawStar(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  radius: number,
  points = 5,
): void {
  ctx.beginPath();
  for (let i = 0; i < points * 2; i++) {
    const r = i % 2 === 0 ? radius : radius * 0.45;
    const angle = (Math.PI * i) / points - Math.PI / 2;
    const x = cx + Math.cos(angle) * r;
    const y = cy + Math.sin(angle) * r;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.closePath();
}

function drawHexagon(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  radius: number,
): void {
  ctx.beginPath();
  for (let i = 0; i < 6; i++) {
    const angle = (Math.PI * 2 * i) / 6 - Math.PI / 6;
    const x = cx + Math.cos(angle) * radius;
    const y = cy + Math.sin(angle) * radius;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.closePath();
}

/**
 * Draw a procedural body (circle / hexagon / star) for units not mapped in
 * the sprite manifest. Color is resolved by the caller and passed in since
 * the team palette lives in rendererCanvas.
 */
export function drawPlaceholder(
  ctx: CanvasRenderingContext2D,
  unit: Unit,
  cx: number,
  cy: number,
  unitSize: number,
  fillColor: string,
  borderColor: string,
): void {
  if (unit.type === "commander") {
    drawStar(ctx, cx, cy, unitSize / 2);
  } else if (unit.type === "elite_guard") {
    drawHexagon(ctx, cx, cy, unitSize / 2);
  } else {
    ctx.beginPath();
    ctx.arc(cx, cy, unitSize / 2, 0, Math.PI * 2);
  }
  ctx.fillStyle = fillColor;
  ctx.fill();
  ctx.strokeStyle = borderColor;
  ctx.lineWidth = 2;
  ctx.stroke();
}
