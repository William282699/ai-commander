// ============================================================
// AI Commander — Muzzle Flash Juice Layer
// Spawns a short-lived muzzle flash sprite at a unit's turret tip whenever
// the unit fires (detected by a change in Unit.lastAttackTime).
//
// Particles live in a module-local array, animate at 24 fps through 3 frames,
// and are garbage-collected once finished. Nothing about this module touches
// game state or Unit fields — it reads Unit.lastAttackTime as an observer and
// keeps its own per-unit memory in a WeakMap.
//
// Deletable in one `rm -rf` when migrating to UE5. See SPRITE_INTEGRATION_PLAN.md §12.1.
// ============================================================

import type { Unit } from "@ai-commander/shared";
import { getSprite } from "../spriteLoader";
import { getTurretHeading } from "../headingCache";
import { SPRITE_MANIFEST } from "../spriteManifest";

// ---------------------------------------------------------------------------
// Sprite URL constants — also exported so spriteLoader can preload them.
// ---------------------------------------------------------------------------

export const MUZZLE_BIG_FRAMES: readonly string[] = [
  "/sprites/tds/effects/muzzle_big_01.png",
  "/sprites/tds/effects/muzzle_big_02.png",
  "/sprites/tds/effects/muzzle_big_03.png",
];

export const MUZZLE_SMALL_FRAMES: readonly string[] = [
  "/sprites/tds/effects/muzzle_small_01.png",
  "/sprites/tds/effects/muzzle_small_02.png",
  "/sprites/tds/effects/muzzle_small_03.png",
];

/** All muzzle-flash URLs (big + small). Consumed by spriteLoader.ts. */
export const MUZZLE_FLASH_URLS: readonly string[] = [
  ...MUZZLE_BIG_FRAMES,
  ...MUZZLE_SMALL_FRAMES,
];

// ---------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------

const FPS = 24;
const FRAME_COUNT = 3; // big and small both have 3 frames
const FLASH_LIFETIME = FRAME_COUNT / FPS; // ≈ 125ms

/**
 * Forward offset (in world tiles, converted to screen px via baseUnitSize)
 * from the unit center to the muzzle tip. We express it as a multiple of
 * drawSize so it scales with the rendered sprite. Values are tuned so the
 * flash sits roughly where the barrel exits the turret.
 */
const MUZZLE_OFFSET_BY_TYPE: Partial<Record<string, number>> = {
  main_tank: 0.55,
  light_tank: 0.45,
  artillery: 0.60,
  elite_guard: 0.35, // bazooka — nose of the tube
};

/**
 * Which sprite set a unit type uses. Default: none (no flash rendered).
 * Tanks / artillery use the big cannon flash; infantry-tier shooters use small.
 */
const FLASH_SET_BY_TYPE: Partial<Record<string, "big" | "small">> = {
  main_tank: "big",
  artillery: "big",
  light_tank: "small",
  elite_guard: "small",
};

/**
 * Fallback draw size multiplier vs baseUnitSize. Matches the tank drawScale
 * so the flash looks proportional; muzzle_*.png are 64x64 source but we
 * want them to visually match the sprite they anchor to.
 */
const FLASH_DRAW_SCALE = 1.8;

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

interface Flash {
  // World-space position of the muzzle tip
  worldX: number;
  worldY: number;
  /** Heading in radians (east = 0) */
  rot: number;
  /** Game time when the flash spawned */
  startTime: number;
  /** Which frame set to use */
  set: "big" | "small";
  /** Cached base unit size from the spawn frame, used for draw sizing */
  baseUnitSize: number;
}

/** Remember the last attack time we've already reacted to for each unit. */
const lastSeenAttackTime = new WeakMap<Unit, number>();

/** All active flashes. Finished ones are filtered out on each draw pass. */
const flashes: Flash[] = [];

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Walk visible units and spawn a new Flash whenever `unit.lastAttackTime`
 * has changed since last frame. Must be called BEFORE drawMuzzleFlashes in
 * the render loop. `baseUnitSize` comes from the renderer's current zoom-
 * scaled unit size (same value passed to renderUnit).
 */
export function updateMuzzleFlashes(
  visibleUnits: Unit[],
  allUnitsById: Map<number, Unit>,
  gameTime: number,
  baseUnitSize: number,
): void {
  for (const unit of visibleUnits) {
    const set = FLASH_SET_BY_TYPE[unit.type];
    if (!set) continue;

    const prev = lastSeenAttackTime.get(unit);
    const curr = unit.lastAttackTime;

    // First time we've seen this unit — seed the cache but don't retroactively
    // spawn a flash (it would look weird on initial load).
    if (prev === undefined) {
      lastSeenAttackTime.set(unit, curr);
      continue;
    }

    if (curr > prev) {
      // Unit just fired. Spawn a flash at the muzzle tip.
      lastSeenAttackTime.set(unit, curr);

      // Only render if the unit actually has a meaningful attackTarget — the
      // turret rotation depends on it. If there's no target we skip (no visible
      // aim direction).
      const rot = getTurretHeading(unit, gameTime, allUnitsById);
      const offsetScale = MUZZLE_OFFSET_BY_TYPE[unit.type] ?? 0.5;
      // Convert the forward offset from "fraction of rendered sprite size" to
      // world-tile units. The rendered sprite is baseUnitSize * drawScale px
      // across, and baseUnitSize ≈ TILE_SIZE * zoom * 0.7, so converting to
      // world tiles cancels the zoom:
      //   screen offset = offsetScale * baseUnitSize * drawScale
      //   world offset  = screen offset / (TILE_SIZE * zoom)
      //                 = offsetScale * drawScale * 0.7
      // This keeps the flash anchored at the barrel tip regardless of camera zoom.
      const drawScale = SPRITE_MANIFEST[unit.type]?.drawScale ?? 1;
      const worldOffset = offsetScale * drawScale * 0.7;
      flashes.push({
        worldX: unit.position.x + Math.cos(rot) * worldOffset,
        worldY: unit.position.y + Math.sin(rot) * worldOffset,
        rot,
        startTime: gameTime,
        set,
        baseUnitSize,
      });
    }
  }
}

/**
 * Draw every active flash. `worldToScreen` converts world-space (x, y) to
 * screen-space pixel coords — this is the exact same transform the renderer
 * uses for unit positions.
 */
export function drawMuzzleFlashes(
  ctx: CanvasRenderingContext2D,
  gameTime: number,
  worldToScreen: (wx: number, wy: number) => { sx: number; sy: number },
): void {
  if (flashes.length === 0) return;

  ctx.save();
  ctx.imageSmoothingEnabled = false;

  // Filter-in-place: keep only still-alive flashes while drawing the rest.
  let write = 0;
  for (let read = 0; read < flashes.length; read++) {
    const f = flashes[read];
    const age = gameTime - f.startTime;
    if (age < 0 || age >= FLASH_LIFETIME) continue; // drop

    const frameIdx = Math.min(FRAME_COUNT - 1, Math.floor(age * FPS));
    const url = f.set === "big" ? MUZZLE_BIG_FRAMES[frameIdx] : MUZZLE_SMALL_FRAMES[frameIdx];
    const bmp = getSprite(url);

    // Convert world → screen and draw (keep the flash even if its bitmap isn't
    // loaded yet — next frame might have it).
    const { sx, sy } = worldToScreen(f.worldX, f.worldY);
    if (bmp) {
      const drawSize = f.baseUnitSize * FLASH_DRAW_SCALE;
      const half = drawSize / 2;
      ctx.save();
      ctx.translate(sx, sy);
      // Muzzle flash sprites face UP in source (-Y), same convention as tank
      // bodies. spriteFrontAngle = -π/2 → rotation offset = +π/2.
      ctx.rotate(f.rot + Math.PI / 2);
      ctx.drawImage(bmp, -half, -half, drawSize, drawSize);
      ctx.restore();
    }

    flashes[write++] = f;
  }
  flashes.length = write;

  ctx.restore();
}

/** Test/debug helper — forces clear of all in-flight flashes. */
export function clearMuzzleFlashes(): void {
  flashes.length = 0;
}
