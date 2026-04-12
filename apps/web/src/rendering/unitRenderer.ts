// ============================================================
// AI Commander — Unit Renderer (sprite dispatch entry point)
// Called once per visible unit from rendererCanvas.renderUnits(). Chooses
// between the sprite manifest and the procedural placeholder, and draws all
// layers (body, turret, accessory, etc.) in order.
//
// See SPRITE_INTEGRATION_PLAN.md §9.
// ============================================================

import type { Unit } from "@ai-commander/shared";
import {
  SPRITE_MANIFEST,
  type SpriteManifestEntry,
  type SpriteLayer,
} from "./spriteManifest";
import { getSprite } from "./spriteLoader";
import { getBodyHeading, getTurretHeading } from "./headingCache";
import { getFrameIndex, deriveFrameState } from "./frameCache";
import { drawPlaceholder } from "./placeholderSprites";

/**
 * True when this unit type has a sprite manifest entry. Used by the
 * caller (rendererCanvas) to suppress the UNIT_SYMBOLS overlay for
 * sprite-backed units while keeping it for placeholder fallbacks.
 */
export function hasSpriteEntry(unit: Unit): boolean {
  return SPRITE_MANIFEST[unit.type] !== undefined;
}

/**
 * Per-bitmap character-bbox cache.
 *
 * Why: CraftPix walk cycles have an intrinsic character-bbox pulsing — e.g.
 * soldier walk frames have bbox heights ranging from 20 px (legs together,
 * walk_03) to 31 px (extended stride, walk_01) inside the same 96×96 canvas.
 * The previous min-canvas normalization could only equalize frames against
 * a constant CANVAS size, so walk_03 drew its tiny 20-px character inside a
 * 96×96 box while idle drew a 29-px character inside a 64×64 box — making
 * the character visually shrink to ~69% of idle height mid-cycle, which is
 * the "half body / 双脚怪物" visual the player reported.
 *
 * Fix: measure each bitmap's actual alpha-bbox once (via offscreen canvas +
 * getImageData) and scale per-frame so the body layer's current-frame bbox
 * max dimension maps to a constant screen target derived from the idle
 * bbox/canvas ratio. This preserves existing `drawScale` tuning AND keeps
 * the character's max visible dim rock-stable across all animation frames.
 *
 * WeakMap-keyed by ImageBitmap so measurements are garbage-collected when
 * the underlying bitmap is unloaded — no manual bookkeeping.
 */
const bitmapBboxCache = new WeakMap<ImageBitmap, number>();

function getBitmapBboxMaxDim(bitmap: ImageBitmap): number {
  const cached = bitmapBboxCache.get(bitmap);
  if (cached != null) return cached;

  const w = bitmap.width;
  const h = bitmap.height;
  // Prefer OffscreenCanvas (no DOM attachment, GC-friendly). Fall back to
  // HTMLCanvasElement for older browsers. Branches are split so TS picks
  // the correct `getContext("2d")` overload for each surface type.
  let ctx2d: OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D | null = null;
  if (typeof OffscreenCanvas !== "undefined") {
    const surface = new OffscreenCanvas(w, h);
    ctx2d = surface.getContext("2d");
  } else {
    const surface = document.createElement("canvas");
    surface.width = w;
    surface.height = h;
    ctx2d = surface.getContext("2d");
  }
  if (!ctx2d) {
    bitmapBboxCache.set(bitmap, 0);
    return 0;
  }
  ctx2d.drawImage(bitmap, 0, 0);
  let pixels: Uint8ClampedArray;
  try {
    pixels = ctx2d.getImageData(0, 0, w, h).data;
  } catch {
    // Shouldn't happen for same-origin /sprites/ but defended against taint.
    bitmapBboxCache.set(bitmap, 0);
    return 0;
  }

  // Alpha-bbox scan. Threshold > 0 treats any non-zero alpha as opaque —
  // sufficient for the CraftPix pack which uses crisp 0/255 alpha for the
  // character silhouette. O(w×h) per bitmap, run once then cached.
  let minX = w;
  let minY = h;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const a = pixels[(y * w + x) * 4 + 3];
      if (a > 0) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) {
    // Fully transparent bitmap — defensive only, shouldn't happen.
    bitmapBboxCache.set(bitmap, 0);
    return 0;
  }
  const result = Math.max(maxX - minX + 1, maxY - minY + 1);
  bitmapBboxCache.set(bitmap, result);
  return result;
}

/**
 * Per-entry "character size ratio" cache.
 *
 * charRatio = bodyIdleBbox / bodyIdleCanvas, where "bodyIdle" is the body
 * layer's idle-state frame. Represents "what fraction of its canvas does
 * the at-rest character occupy" and is used as the visible-size target for
 * EVERY frame of EVERY layer — anchoring the character's max dimension at
 * `charRatio × drawSize` regardless of which walk/attack frame is playing.
 *
 * Why anchor to idle: the manifest's `drawScale` values were already tuned
 * under the old min-canvas renderer, where the idle (tight-crop) frame
 * rendered at drawSize × drawSize and the character occupied
 * `charRatio × drawSize` visible pixels. Anchoring to the idle ratio keeps
 * the new renderer producing the same idle visual, then extends that
 * stability to walk and attack frames.
 */
const entryCharRatioCache = new WeakMap<SpriteManifestEntry, number>();

function getEntryCharRatio(entry: SpriteManifestEntry): number {
  const cached = entryCharRatioCache.get(entry);
  if (cached != null) return cached;
  const bodyLayer = entry.layers.find((l) => l.name === "body") ?? entry.layers[0];
  if (!bodyLayer) return 0;
  const idleIdx = bodyLayer.stateFrames?.idle?.[0] ?? 0;
  const idleFrame = bodyLayer.frames[idleIdx];
  if (!idleFrame) return 0;
  const idleBitmap = getSprite(idleFrame.url);
  if (!idleBitmap) return 0; // body idle not preloaded yet — retry next frame
  const canvasMax = Math.max(idleBitmap.width, idleBitmap.height);
  if (canvasMax === 0) return 0;
  const bboxMax = getBitmapBboxMaxDim(idleBitmap);
  if (bboxMax === 0) return 0;
  const ratio = bboxMax / canvasMax;
  entryCharRatioCache.set(entry, ratio);
  return ratio;
}

/**
 * Resolve a layer's current frame index from the unit's state + game time.
 *
 * Shared between the body-layer pre-pass (where we need the body's current
 * frame to compute sharedScale) and the main layer loop (where each layer
 * draws its current frame). Same inputs → same output, so the body's
 * sharedScale is guaranteed to be computed against exactly the frame the
 * main loop will draw.
 */
function getLayerFrameIdx(layer: SpriteLayer, unit: Unit, gameTime: number): number {
  const frames = layer.frames;
  if (layer.stateFrames && frames.length > 1) {
    const state = deriveFrameState(unit);
    const range = layer.stateFrames[state];
    if (range && range.length > 0) {
      return getFrameIndex(unit, gameTime, range, layer.fps ?? 10);
    }
    // Explicitly empty array (e.g. `idle: []`) = layer hidden for this state.
    // Distinct from undefined (= state not listed → fall through to frame 0).
    if (range) return -1;
    return 0;
  }
  if (frames.length > 1 && layer.rotatesWith === "alwaysSpin") {
    // Constant-rate cycle independent of unit state (helicopter rotor).
    return Math.floor(gameTime * (layer.fps ?? 10)) % frames.length;
  }
  return 0;
}

/**
 * Draw a single unit at screen coords (cx, cy). Replaces the procedural
 * shape-drawing block in rendererCanvas.ts:418-431.
 *
 * @param baseUnitSize the zoom-scaled base size (current formula:
 *                    Math.max(8, TILE_SIZE * camera.zoom * 0.7)). The
 *                    manifest's drawScale is applied on top of this.
 * @param gameTime seconds since game start
 * @param allUnitsById lookup map for attack-target resolution
 * @param fillColor / borderColor used only if we fall back to the placeholder
 */
export function renderUnit(
  ctx: CanvasRenderingContext2D,
  unit: Unit,
  cx: number,
  cy: number,
  baseUnitSize: number,
  gameTime: number,
  allUnitsById: Map<number, Unit>,
  fillColor: string,
  borderColor: string,
): void {
  const entry = SPRITE_MANIFEST[unit.type];
  if (!entry) {
    drawPlaceholder(ctx, unit, cx, cy, baseUnitSize, fillColor, borderColor);
    return;
  }

  const drawSize = baseUnitSize * entry.drawScale;

  // ── sharedScale: bbox-aware per-frame scaling driven by the BODY layer ──
  //
  // Goal: keep the character's max visible dimension constant across idle,
  // walk, and attack frames even though each frame has a different
  // character bbox size inside its canvas. Approach: compute a target
  // character size in screen px (`charRatio × drawSize`), measure the body
  // layer's current-frame alpha-bbox in source px, and derive a single
  // sharedScale that every layer then applies to its raw bitmap dims.
  //
  // Using ONE sharedScale for all layers is critical for multi-layer units
  // (tank body+turret, helicopter body+rotor, elite body+bazooka). Scaling
  // each layer independently by its own bbox would cause body and turret
  // to drift in relative size as animation frames cycled. Keying to the
  // body keeps the whole unit visually coherent.
  //
  // Fallback: if the body bitmap isn't loaded yet OR its bbox measurement
  // fails, sharedScale stays 0 and per-layer draws fall back to
  // drawSize × drawSize (the old pre-fix behavior). This only affects a
  // handful of frames during asset preload.
  const charRatio = getEntryCharRatio(entry);
  const bodyLayer = entry.layers.find((l) => l.name === "body") ?? entry.layers[0];
  let sharedScale = 0;
  if (charRatio > 0 && bodyLayer) {
    const bodyIdx = getLayerFrameIdx(bodyLayer, unit, gameTime);
    const bodyBitmap = getSprite(bodyLayer.frames[bodyIdx].url);
    if (bodyBitmap) {
      const bodyBboxMax = getBitmapBboxMaxDim(bodyBitmap);
      if (bodyBboxMax > 0) {
        sharedScale = (charRatio * drawSize) / bodyBboxMax;
      }
    }
  }

  const bodyHeading = getBodyHeading(unit, gameTime);
  // Only materialize the turret heading when an attackTarget layer needs it.
  // Lazy-computed to avoid doing a Map lookup for infantry-only units.
  let turretHeading: number | null = null;
  const getTurret = () => {
    if (turretHeading == null) {
      turretHeading = getTurretHeading(unit, gameTime, allUnitsById);
    }
    return turretHeading;
  };

  ctx.save();
  ctx.imageSmoothingEnabled = false;

  for (const layer of entry.layers) {
    // Frame index resolution is shared with the body-layer pre-pass above
    // via getLayerFrameIdx — same inputs → same output — so when this loop
    // reaches the body layer it reuses exactly the frame that sharedScale
    // was computed against.
    const frameIdx = getLayerFrameIdx(layer, unit, gameTime);
    if (frameIdx < 0) continue; // layer explicitly hidden for this state
    const frame = layer.frames[frameIdx];
    const bitmap = getSprite(frame.url);
    if (!bitmap) continue; // not yet loaded; skip this layer silently

    let rot = 0;
    switch (layer.rotatesWith) {
      case "movement":
        rot = bodyHeading;
        break;
      case "attackTarget":
        rot = getTurret();
        break;
      case "alwaysSpin":
        // Constant-rate spin driven by time — visible for helicopter rotors.
        rot = (gameTime * Math.PI * 6) % (Math.PI * 2);
        break;
      case "none":
        rot = 0;
        break;
    }

    ctx.save();
    ctx.translate(cx, cy);
    // Orient the sprite so its "forward" aligns with the game heading.
    //
    // Each layer stores `spriteFrontAngle` — the direction the sprite's forward
    // points in image-local coordinates (0 = +X right, π/2 = +Y down,
    // -π/2 = -Y up). Default is -π/2 because the CraftPix TDS pack draws most
    // sprites (tank bodies, infantry, helicopter hull) facing the TOP of the
    // PNG. Tank TURRETS in this pack are exceptions — they're drawn with the
    // barrel extending DOWNWARD, so those layers set spriteFrontAngle = π/2.
    //
    // Formula: ctx.rotate(heading − spriteFrontAngle) ensures that after
    // rotation the sprite's forward vector aligns with the world heading.
    // See SPRITE_INTEGRATION_PLAN.md §F / §6.
    const spriteFrontAngle = layer.spriteFrontAngle ?? -Math.PI / 2;
    ctx.rotate(rot - spriteFrontAngle);

    // Per-frame draw size:
    //   destW = bitmap.width × sharedScale
    //   destH = bitmap.height × sharedScale
    // Using sharedScale (computed once from the body layer's current frame)
    // means the character's max visible dim stays pinned at
    // `charRatio × drawSize` for every layer, every frame.
    //
    // Width/height are NOT collapsed to a single square size — preserving
    // the bitmap's native aspect ratio means frames with asymmetric
    // canvases (rare in this pack but cheap to handle correctly) draw
    // without horizontal/vertical distortion.
    //
    // Fallback path (`sharedScale === 0`) matches the original square-draw
    // behavior and is only reached while the body bitmap is still loading.
    let destW: number;
    let destH: number;
    if (sharedScale > 0) {
      destW = bitmap.width * sharedScale;
      destH = bitmap.height * sharedScale;
    } else {
      destW = drawSize;
      destH = drawSize;
    }
    ctx.drawImage(bitmap, -destW / 2, -destH / 2, destW, destH);
    ctx.restore();
  }

  ctx.restore();
}
