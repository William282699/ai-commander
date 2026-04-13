// ============================================================
// AI Commander — Death Smoke Juice Layer
// Spawns a short-lived smoke puff at a unit's last known position the first
// frame we observe its state transition to "dead". The red × battle marker
// remains as the persistent "battle happened here" indicator — this layer is
// purely a ~0.5s visual flourish at the moment of death.
//
// Same architecture as muzzleFlashLayer.ts: module-local Puff[] array, per-
// unit WeakMap to avoid re-spawning, no touching of game state or Unit fields.
//
// Deletable in one `rm -rf` when migrating to UE5. See SPRITE_INTEGRATION_PLAN.md §12.2.
// ============================================================

import type { Unit } from "@ai-commander/shared";
import { getSprite } from "../spriteLoader";

// ---------------------------------------------------------------------------
// Sprite URL constants — also exported so spriteLoader can preload them.
// ---------------------------------------------------------------------------

export const SMOKE_FRAMES: readonly string[] = [
  "/sprites/tds/effects/smoke_01.png",
  "/sprites/tds/effects/smoke_02.png",
  "/sprites/tds/effects/smoke_03.png",
  "/sprites/tds/effects/smoke_04.png",
  "/sprites/tds/effects/smoke_05.png",
  "/sprites/tds/effects/smoke_06.png",
  "/sprites/tds/effects/smoke_07.png",
];

/** All smoke-puff URLs. Consumed by spriteLoader.ts. */
export const DEATH_SMOKE_URLS: readonly string[] = SMOKE_FRAMES;

// ---------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------

const FPS = 15;
const FRAME_COUNT = SMOKE_FRAMES.length; // 7
const PUFF_LIFETIME = FRAME_COUNT / FPS; // ≈ 0.467s

/**
 * Draw-size multiplier vs baseUnitSize. Smoke reads larger than the unit
 * itself because it dissipates outward — 2.4× gives a visible cloud without
 * dwarfing neighbors.
 */
const PUFF_DRAW_SCALE = 2.4;

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

interface Puff {
  /** World-space position (copied from unit at spawn time — unit may be GC'd). */
  worldX: number;
  worldY: number;
  /** Game time when the puff spawned */
  startTime: number;
  /** Cached base unit size from the spawn frame, used for draw sizing */
  baseUnitSize: number;
}

/**
 * Track units we've already spawned a puff for, so a unit that stays in
 * state="dead" for many frames only produces one puff. WeakMap keys by Unit
 * object identity; entries disappear automatically if the sim ever removes
 * the unit from its store.
 */
const alreadySmoked = new WeakMap<Unit, true>();

/** All active puffs. Finished ones are filtered out on each draw pass. */
const puffs: Puff[] = [];

// --- Sound callback (injected by combatSounds.ts) ---
let deathSoundCallback: ((unit: Unit, gameTime: number) => void) | null = null;

export function setDeathSoundCallback(cb: (unit: Unit, gameTime: number) => void): void {
  deathSoundCallback = cb;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Walk the full unit list and spawn a smoke puff the first time we see a
 * unit in state="dead". Must be called BEFORE drawDeathSmoke in the render
 * loop. Unlike muzzle flash, we pass ALL units (not just visibleUnits) —
 * deaths should render regardless of fog-of-war because the battle marker
 * system already exposes them, and a smoke puff in the fog is just noise
 * that never gets drawn (off-screen units produce off-screen puffs).
 */
export function updateDeathSmoke(
  units: Unit[],
  gameTime: number,
  baseUnitSize: number,
): void {
  for (const unit of units) {
    if (unit.state !== "dead") continue;
    if (alreadySmoked.has(unit)) continue;
    alreadySmoked.set(unit, true);
    deathSoundCallback?.(unit, gameTime);
    puffs.push({
      worldX: unit.position.x,
      worldY: unit.position.y,
      startTime: gameTime,
      baseUnitSize,
    });
  }
}

/**
 * Draw every active puff. `worldToScreen` converts world-space (x, y) to
 * screen-space pixel coords — same transform used for unit positions.
 *
 * Puffs fade out over their lifetime and advance through the 7-frame cycle
 * at 15 fps so they read as a dissipating cloud.
 */
export function drawDeathSmoke(
  ctx: CanvasRenderingContext2D,
  gameTime: number,
  worldToScreen: (wx: number, wy: number) => { sx: number; sy: number },
): void {
  if (puffs.length === 0) return;

  ctx.save();
  ctx.imageSmoothingEnabled = false;

  // Filter-in-place: keep only still-alive puffs while drawing the rest.
  let write = 0;
  for (let read = 0; read < puffs.length; read++) {
    const p = puffs[read];
    const age = gameTime - p.startTime;
    if (age < 0 || age >= PUFF_LIFETIME) continue; // drop

    const frameIdx = Math.min(FRAME_COUNT - 1, Math.floor(age * FPS));
    const url = SMOKE_FRAMES[frameIdx];
    const bmp = getSprite(url);

    const { sx, sy } = worldToScreen(p.worldX, p.worldY);
    if (bmp) {
      const drawSize = p.baseUnitSize * PUFF_DRAW_SCALE;
      const half = drawSize / 2;
      // Linear fade-out over the second half of the puff's life.
      const lifeFrac = age / PUFF_LIFETIME; // 0..1
      const alpha = lifeFrac < 0.5 ? 1 : 1 - (lifeFrac - 0.5) * 2;
      ctx.save();
      ctx.globalAlpha = Math.max(0, Math.min(1, alpha));
      ctx.drawImage(bmp, sx - half, sy - half, drawSize, drawSize);
      ctx.restore();
    }

    puffs[write++] = p;
  }
  puffs.length = write;

  ctx.restore();
}

/** Test/debug helper — forces clear of all in-flight puffs. */
export function clearDeathSmoke(): void {
  puffs.length = 0;
}
