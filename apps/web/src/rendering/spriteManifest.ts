// ============================================================
// AI Commander — Sprite Manifest
// Declarative mapping from UnitType → sprite layers + frames.
// Runtime-only, game logic never reads this. Deletable in one `rm -rf`
// when the renderer migrates to UE5.
//
// See SPRITE_INTEGRATION_PLAN.md §3 §4.
// ============================================================

import type { UnitType } from "@ai-commander/shared";

/**
 * A single image file with optional atlas slicing.
 * For TDS Pixel Game Kit, all frames are individual PNGs so sx/sy/sw/sh are unused.
 * Left in the schema for future atlas support without migration.
 */
export interface SpriteFrame {
  url: string;
  sx?: number;
  sy?: number;
  sw?: number;
  sh?: number;
  /** Pivot point in source pixels; defaults to image center */
  pivotX?: number;
  pivotY?: number;
}

export type OrientationMode = "rotate" | "static";
//   rotate — single source image, runtime ctx.rotate to face heading
//   static — no rotation (decorative)

export type UnitFrameState = "idle" | "moving" | "attacking";

export interface SpriteLayer {
  name: "body" | "turret" | "shadow" | "rotor" | "accessory";
  orientationMode: OrientationMode;
  /** What this layer's rotation tracks. "none" = static direction. */
  rotatesWith: "movement" | "attackTarget" | "none" | "alwaysSpin";
  /**
   * Frames for this layer.
   * - Length 1 = static single frame
   * - Length > 1 = animation (use fps to advance)
   * State-specific frame ranges are specified via `stateFrames`.
   */
  frames: SpriteFrame[];
  fps?: number;
  /**
   * Optional per-state frame index ranges within `frames`.
   * E.g., { idle: [0], moving: [1,2,3,4], attacking: [5,6] }
   */
  stateFrames?: Partial<Record<UnitFrameState, number[]>>;
  /**
   * Direction the sprite's "forward" points in source-image local coordinates,
   * expressed as an angle in radians (0 = +X/right, π/2 = +Y/down, -π/2 = -Y/up).
   *
   * The renderer applies `ctx.rotate(heading - spriteFrontAngle)` so that the
   * sprite's forward aligns with the game heading. Default is -π/2 (up), which
   * matches the CraftPix TDS convention where most sprites (bodies, infantry,
   * helicopter hull) face the TOP of their PNG.
   *
   * Tank TURRETS in this pack are drawn with the barrel extending DOWNWARD
   * (+Y in image local), so they must set spriteFrontAngle = π/2.
   */
  spriteFrontAngle?: number;
}

export interface SpriteManifestEntry {
  layers: SpriteLayer[];
  /** Draw size multiplier vs baseUnitSize. See §5. */
  drawScale: number;
  /** Whether to darken/tint this sprite for enemy faction (simple hue shift). */
  enemyTint?: boolean;
}

/** Map unit type string → manifest. Missing entries (including NavalUnitType
 *  like patrol_boat which currently has no sprite) fall back to the procedural
 *  placeholder via the `hasSpriteEntry` check in unitRenderer.ts. */
export type SpriteManifest = Partial<Record<UnitType, SpriteManifestEntry>>;

// ------------------------------------------------------------
// Reusable layer definitions
// ------------------------------------------------------------

/** Air placeholder: every AirUnitType shares this layer set. */
const HELICOPTER_LAYERS: SpriteLayer[] = [
  {
    name: "body",
    orientationMode: "rotate",
    rotatesWith: "movement",
    frames: [{ url: "/sprites/tds/air/heli_body.png" }],
  },
  {
    name: "rotor",
    orientationMode: "rotate",
    rotatesWith: "alwaysSpin", // rotation driven by time, ignores unit heading
    frames: [{ url: "/sprites/tds/air/heli_rotor.png" }],
  },
];

// ------------------------------------------------------------
// The manifest
// ------------------------------------------------------------

export const SPRITE_MANIFEST: SpriteManifest = {
  infantry: {
    drawScale: 2.5,
    layers: [
      // Single body layer — idle for all states except attacking (shot).
      // CraftPix TDS walk sprites are legs-only overlays with a diagonal
      // stride axis that doesn't align with cardinal headings, creating a
      // "backwards walk" illusion. Using idle for movement (same approach
      // as elite_guard) keeps the character visually consistent: the body
      // rotates to face the heading and looks correct at all angles.
      {
        name: "body",
        orientationMode: "rotate",
        rotatesWith: "movement",
        spriteFrontAngle: Math.PI / 2, // soldier sprites face DOWN in source PNG
        frames: [
          { url: "/sprites/tds/infantry/soldier_idle.png" },
          { url: "/sprites/tds/infantry/soldier_shot.png" },
        ],
        fps: 10,
        stateFrames: {
          idle: [0],
          moving: [0],
          attacking: [1],
        },
      },
    ],
  },

  main_tank: {
    drawScale: 2.7,
    layers: [
      {
        name: "body",
        orientationMode: "rotate",
        rotatesWith: "movement",
        frames: [
          { url: "/sprites/tds/tanks/panzer_body.png" },
          { url: "/sprites/tds/tanks/panzer_move_01.png" },
          { url: "/sprites/tds/tanks/panzer_move_02.png" },
          { url: "/sprites/tds/tanks/panzer_move_03.png" },
          { url: "/sprites/tds/tanks/panzer_move_04.png" },
        ],
        fps: 8,
        stateFrames: {
          idle: [0],
          moving: [1, 2, 3, 4],
          attacking: [0],
        },
      },
      {
        name: "turret",
        orientationMode: "rotate",
        rotatesWith: "attackTarget",
        frames: [{ url: "/sprites/tds/tanks/panzer_turret.png" }],
        // Barrel extends DOWNWARD in source PNG — forward = +Y in image local.
        spriteFrontAngle: Math.PI / 2,
      },
    ],
  },

  light_tank: {
    drawScale: 2.7,
    layers: [
      {
        name: "body",
        orientationMode: "rotate",
        rotatesWith: "movement",
        frames: [
          { url: "/sprites/tds/tanks/btr_body.png" },
          { url: "/sprites/tds/tanks/btr_move_01.png" },
          { url: "/sprites/tds/tanks/btr_move_02.png" },
        ],
        fps: 6,
        stateFrames: {
          idle: [0],
          moving: [1, 2],
          attacking: [0],
        },
      },
      {
        name: "turret",
        orientationMode: "rotate",
        rotatesWith: "attackTarget",
        frames: [{ url: "/sprites/tds/tanks/btr_turret.png" }],
        // Barrel extends DOWNWARD in source PNG — forward = +Y in image local.
        spriteFrontAngle: Math.PI / 2,
      },
    ],
  },

  artillery: {
    drawScale: 2.7,
    layers: [
      {
        name: "body",
        orientationMode: "rotate",
        rotatesWith: "movement",
        frames: [
          { url: "/sprites/tds/tanks/acs_body.png" },
          { url: "/sprites/tds/tanks/acs_move_01.png" },
          { url: "/sprites/tds/tanks/acs_move_02.png" },
          { url: "/sprites/tds/tanks/acs_move_03.png" },
          { url: "/sprites/tds/tanks/acs_move_04.png" },
          { url: "/sprites/tds/tanks/acs_move_05.png" },
        ],
        fps: 7,
        stateFrames: {
          idle: [0],
          moving: [1, 2, 3, 4, 5],
          attacking: [0],
        },
      },
      {
        name: "turret",
        orientationMode: "rotate",
        rotatesWith: "attackTarget",
        frames: [{ url: "/sprites/tds/tanks/acs_turret.png" }],
        // Barrel extends DOWNWARD in source PNG — forward = +Y in image local.
        spriteFrontAngle: Math.PI / 2,
      },
    ],
  },

  commander: {
    // Commander visual used to be 1.5x in the procedural renderer (rendererCanvas.ts:369).
    // Here drawScale is applied on top of baseUnitSize, so 2.8 gives a visibly-larger
    // hero without dwarfing infantry (which is now 2.5×).
    drawScale: 2.8,
    layers: [
      // Base body — always draws idle (same body+legs split as infantry)
      {
        name: "body",
        orientationMode: "rotate",
        rotatesWith: "movement",
        spriteFrontAngle: Math.PI / 2, // commander sprites face DOWN in source PNG
        frames: [{ url: "/sprites/tds/infantry/commander_idle.png" }],
      },
      // Walk-cycle legs overlay (same convention as infantry: faces DOWN)
      {
        name: "accessory",
        orientationMode: "rotate",
        rotatesWith: "movement",
        spriteFrontAngle: Math.PI / 2,
        frames: [
          { url: "/sprites/tds/infantry/commander_walk_01.png" },
          { url: "/sprites/tds/infantry/commander_walk_02.png" },
          { url: "/sprites/tds/infantry/commander_walk_03.png" },
          { url: "/sprites/tds/infantry/commander_walk_04.png" },
          { url: "/sprites/tds/infantry/commander_walk_05.png" },
          { url: "/sprites/tds/infantry/commander_walk_06.png" },
          { url: "/sprites/tds/infantry/commander_walk_07.png" },
        ],
        fps: 10,
        stateFrames: {
          idle: [],       // hidden
          moving: [0, 1, 2, 3, 4, 5, 6],
          attacking: [],  // hidden
        },
      },
    ],
  },

  elite_guard: {
    drawScale: 2.6,
    layers: [
      {
        name: "body",
        orientationMode: "rotate",
        rotatesWith: "movement",
        spriteFrontAngle: Math.PI / 2, // elite sprites face DOWN in source PNG
        frames: [
          { url: "/sprites/tds/infantry/elite_idle.png" },
          { url: "/sprites/tds/infantry/elite_fire_01.png" },
          { url: "/sprites/tds/infantry/elite_fire_02.png" },
          { url: "/sprites/tds/infantry/elite_fire_03.png" },
          { url: "/sprites/tds/infantry/elite_fire_04.png" },
          { url: "/sprites/tds/infantry/elite_fire_05.png" },
        ],
        fps: 8,
        stateFrames: {
          idle: [0],
          moving: [0], // no walk cycle available — use idle
          attacking: [1, 2, 3, 4, 5],
        },
      },
      {
        name: "accessory",
        orientationMode: "rotate",
        rotatesWith: "movement",
        spriteFrontAngle: Math.PI / 2, // bazooka sprite faces DOWN in source PNG
        frames: [{ url: "/sprites/tds/infantry/elite_bazooka.png" }],
      },
    ],
  },

  // --- Air units ---
  // AirUnitType = "fighter" | "bomber" | "recon_plane"
  // All three share the helicopter placeholder per §0.3.
  fighter: {
    drawScale: 2.2,
    layers: HELICOPTER_LAYERS,
  },
  bomber: {
    drawScale: 2.4,
    layers: HELICOPTER_LAYERS,
  },
  recon_plane: {
    drawScale: 2.0,
    layers: HELICOPTER_LAYERS,
  },
};
