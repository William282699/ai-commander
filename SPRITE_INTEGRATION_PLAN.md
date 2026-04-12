# Sprite Integration Plan — TDS Modern Pixel Game Kit

**Audience**: The next Claude Code window that opens this file.
**Mission**: Replace the current procedural unit visuals (circle / hexagon / star + single-letter symbol) with real pixel-art sprites from the purchased CraftPix "TDS Modern Pixel Game Kit" asset pack.
**Status at handoff**: Assets purchased, extracted, and fully surveyed. Architecture decisions locked. This document is self-contained — you should NOT need to ask the user any questions to execute it.

---

## START HERE — New Window Orientation

**If you are the Claude Code window that just had this file handed to you, read this entire section before touching anything. It is a complete workflow contract — follow it literally.**

### A. Verify you are in the right place

You are running inside an AI Commander git worktree. Claude Code creates a fresh worktree per session, so you are likely in a freshly-minted one under `.claude/worktrees/<some-name>/`. You may or may not see the asset pack directly in your cwd — that's normal, the assets live at a stable path outside any worktree.

First commands to run, before anything else:

```bash
pwd
git status && git branch --show-current
ls apps/web/src/rendererCanvas.ts 2>/dev/null
ls "/Users/yuqiaohuang/MyProjects/AI Commander/tds-modern-pixel-game-kit" 2>/dev/null | head -3
```

**Required invariants** (all must be true — if any fails, STOP and tell the user, do NOT cd elsewhere or switch branches on your own):

1. `apps/web/src/rendererCanvas.ts` exists in cwd → confirms you are in the AI Commander repo.
2. This file (`SPRITE_INTEGRATION_PLAN.md`) exists in cwd → confirms the plan is committed or otherwise available in this worktree.
3. The asset pack exists at the stable external path `/Users/yuqiaohuang/MyProjects/AI Commander/tds-modern-pixel-game-kit/` and contains at least the subdirectory `tds-pixel-art-modern-soldiers-and-vehicles-sprites/`. This path is **outside** your worktree — it lives in the main repo root directory and is reachable via absolute path from any worktree on the same machine.
4. Current branch is **NOT** `main`. Claude Code's per-session worktree should put you on something like `claude/<adjective-name>`; if you find yourself literally on `main`, STOP and ask the user.
5. Working tree is clean or only contains the standard per-session Claude Code scaffolding. If there are unrelated pending changes, STOP and ask the user.

**The assets are external, by design.** Do not expect `tds-modern-pixel-game-kit/` to be inside your cwd. The plan's asset-copying step (§15 step 2) uses the absolute source path `/Users/yuqiaohuang/MyProjects/AI Commander/tds-modern-pixel-game-kit/` as the `cp` source, and copies from there into `apps/web/public/sprites/tds/` inside your current worktree. This is the intended workflow.

**If the asset path is missing:** the user has not yet placed the asset pack at `/Users/yuqiaohuang/MyProjects/AI Commander/tds-modern-pixel-game-kit/`. STOP and ask them to copy it there before you proceed. Do not try to find assets in other worktrees or download them — they are a paid commercial product.

### B. What's already in the worktree

The plan file itself (`SPRITE_INTEGRATION_PLAN.md`) should be committed to `main` and therefore present in every new worktree automatically. If it is not in cwd but you are somehow reading it via some other mechanism, STOP and tell the user — something is wrong with the handoff.

The asset pack (`tds-modern-pixel-game-kit/`) is deliberately **not** in the worktree. It is in the main repo root directory (one level above `.claude/worktrees/`), gitignored, and referenced by absolute path. You will copy PNGs out of it into the worktree during §15 step 2.

Aside from those, the worktree should be a clean checkout of whatever branch Claude Code spun up. No pending commits, no pending changes.

### C. Architectural constraints — NON-NEGOTIABLE

The whole sprite layer is designed to be ripped out with one `rm -rf` when the game migrates to UE5. Breaking these rules pollutes unrelated parts of the codebase and defeats the purpose.

**Files you may NOT modify under any circumstance:**

- Anything under `packages/shared/` — especially `packages/shared/src/types.ts`. No new field on `Unit`, `UnitState`, `UnitType`, `AirUnitType`, `GameState`, `CombatEffects`. Rendering state goes into `WeakMap<Unit, T>` inside `apps/web/src/rendering/`.
- Anything under `packages/core/` — game logic is untouchable.
- `apps/web/src/` sim-layer files: `gameLoop.ts`, `combat.ts`, `pathfinding.ts`, `enemyAI.ts`, `defensiveAI.ts`, any planner / AI / economy / production logic.
- Save format, network sync, LLM prompt builders. If you find yourself touching any of these, STOP — something is wrong.

**Files you ARE allowed to modify, and the exact scope of each:**

| File | Allowed change |
|---|---|
| `apps/web/src/rendererCanvas.ts` | **ONE** surgical edit: replace the procedural shape-drawing block at lines 418–431 with a call to `drawUnitSprite()`. The other ~1260 lines (trench arcs, `UNIT_SYMBOLS` text, battle markers like the red × / attack zones / critical fronts, camera, grid, terrain) must stay bit-for-bit identical. See §10 for the exact diff. |
| `apps/web/src/GameCanvas.tsx` | Add **ONE** `useEffect` that calls the sprite preloader. See §11. |
| `.gitignore` | Add entries from §13. |

**Files you CREATE (purely additive):**

- `apps/web/src/rendering/` — new directory, all sprite code lives here.
- `apps/web/public/sprites/tds/` — new static asset directory, PNGs get copied here.

**Rule of thumb:** if your next action is not either (a) inside `apps/web/src/rendering/`, (b) the single lines-418–431 block in `rendererCanvas.ts`, (c) one `useEffect` in `GameCanvas.tsx`, (d) `.gitignore`, or (e) copying PNGs into `apps/web/public/sprites/tds/`, then you are about to violate the plan. STOP and ask the user.

### D. Execution order and checkpoints

Work through §15's 16 numbered steps in order. Stop at each checkpoint below and wait for explicit user approval before continuing:

1. **After step 3** (`.gitignore` updated + PNGs copied into `public/sprites/tds/` + TypeScript types file created) — report the new file tree and the total PNG count copied.
2. **After step 9** (manifest + sprite loader + `unitRenderer.ts` fully written) — run `pnpm -C apps/web tsc --noEmit` (or the repo's type-check command) and confirm zero errors.
3. **After step 10** (the surgical edit in `rendererCanvas.ts`) — run `pnpm dev`, describe the visual result to the user (or ask them to screenshot). Do not proceed to juice/particles until user confirms the base sprites render correctly.
4. **After step 14** (muzzle flash + death smoke particle layer) — describe final visual state.
5. **Before step 16** (git operations) — stop completely. The user commits manually.

### E. Git and commit policy

- **Never run `git commit` on your own.** Never run `git push`. Never run `git add -A` or `git add .`.
- When staging files is appropriate, stage specific named files only, and only after the user explicitly asks for a commit.
- Never commit `*.psd`, `tds-modern-pixel-game-kit/`, `tds-modern-pixel-game-kit.zip`, or anything matching `apps/web/public/sprites/tds/**/*.psd`. The `.gitignore` update in §13 is step 1 for a reason — do it first, before copying any assets.

### F. Resolving unknowns

§16 lists things the plan deliberately left unresolved because they depend on information only visible by reading source. For each of them, use `Read` / `Glob` / `Grep` to confirm the real answer before writing code. Specifically:

- **Sprite orientation offset** — sprites face south in the source files; game angles use east=0. Start with `+π/2` offset, verify visually, adjust if wrong.
- **`UnitState` enum member names** — Read `packages/shared/src/types.ts` to get the exact strings for "moving" / "attacking" / "idle" before writing state-machine branches in `unitRenderer.ts`. Do not guess.
- **`AirUnitType` enum members** — same thing, read before mapping.
- **`commander` walk cycle frames** — enumerate `tds-modern-hero-weapons-and-props/Hero_Rifle/Hero_Walk/` with `Glob` before hardcoding frame counts.
- **Non-ASCII / garbled filenames** — if a file name looks corrupted in `ls` output, quote the path carefully and confirm with `Glob` before operating on it.

If you hit something not in §16 and not in the plan, STOP and describe the problem to the user. Do NOT invent a workaround that adds fields to `Unit`, touches sim code, or refactors `rendererCanvas.ts` beyond the §10 block.

### G. Tooling gotchas specific to this repo

- Package manager is **pnpm** (monorepo workspace). Dev server: `pnpm -C apps/web dev` or `pnpm dev` at root. Never use `npm` or `yarn`.
- The project path contains a literal space (`AI Commander`). Always quote paths in shell commands.
- Vite serves `apps/web/public/` at URL root. A file at `apps/web/public/sprites/tds/tanks/panzer_body.png` is fetched by the browser as `/sprites/tds/tanks/panzer_body.png` (no `public/` in the URL).
- When copying PNGs from `tds-modern-pixel-game-kit/` into `apps/web/public/sprites/tds/`, use explicit `cp` commands per file or per directory. Do not use recursive globs that might accidentally pick up `*.psd`, `*.txt` (license/readme), or other non-image files.
- `imageSmoothingEnabled = false` must be set on the canvas 2D context before any sprite `drawImage` call, otherwise the browser will bilinear-blur the pixel art.

### H. One-line summary of the whole job

Add a pixel-art sprite rendering layer at the leaves of the existing canvas renderer. Do not touch game logic. Do not touch shared types. Do not commit assets. Stop at every checkpoint. When done, the game looks different; everything else is byte-for-byte identical.

Now go read §0 through §20 below and execute.

---

## 0. Context You Must Understand Before Writing Code

### 0.1 Where things live

Your cwd is a Claude Code per-session worktree under `.claude/worktrees/<name>/`. Code paths below are relative to this cwd. The raw asset pack is **external** to the worktree and is referenced by absolute path.

```
Cwd (this worktree):   .                                                          (Claude Code's per-session worktree)
Main repo root:        /Users/yuqiaohuang/MyProjects/AI Commander/                 (the "real" git repo, one level above .claude/worktrees/)
Assets (raw, external):/Users/yuqiaohuang/MyProjects/AI Commander/tds-modern-pixel-game-kit/   (outside any worktree, gitignored in main — see §13)
Game code:             ./apps/web/src/                                             (in cwd, via git)
Current render:        ./apps/web/src/rendererCanvas.ts                            (1274 lines, DO NOT rewrite — minimal surgical edits only)
Game host:             ./apps/web/src/GameCanvas.tsx                               (needs 1 preload hook)
Shared types:          ./packages/shared/src/types.ts                              (DO NOT add rendering fields to Unit)
```

**Why assets are external**: Claude Code creates a fresh per-session worktree for each task. If the asset pack lived inside a worktree, it would only be available in that one worktree. By placing it at the main repo root (outside any worktree), every current and future worktree can reach it via the same absolute path with zero duplication.

### 0.2 The Iron Rules (non-negotiable)

These rules exist so that this whole sprite layer is **deletable in one `rm -rf`** when the renderer moves to UE5. Breaking them pollutes the rest of the codebase.

1. **All new sprite code lives under `apps/web/src/rendering/`**. Not `packages/core`, not `packages/shared`, not anywhere else.
2. **Do NOT add any new field to `Unit` or `GameState`**. No `heading`, no `spriteKey`, no `currentFrame`, no `animationState`. Derive all of it at runtime via `WeakMap<Unit, T>` caches.
3. **Renderer is a read-only consumer of game state**. Never mutate `state.units[i].xxx` from rendering code.
4. **Sim tick never waits on render tick**. Animations are visual-only; game logic runs independent of whether a muzzle flash has finished.
5. **Preserve the existing death marker system** (`BattleMarker.type === "death"` at `rendererCanvas.ts:1153`). When a unit dies it simply stops being rendered — the red × remains as-is.
6. **Canvas 2D, `imageSmoothingEnabled = false`** for crisp pixel art scaling.

### 0.3 What the user explicitly told me

- The render layer will eventually be rewritten for UE5. Do NOT over-engineer for long-term portability. Build the minimum that looks good now.
- Units should render **about 2x larger than current** for tanks, **1.5x larger** for infantry (see §5 for exact formula).
- Destroyed/broken sprite variants are **NOT needed**. Dead unit = disappears + existing red × stays.
- Naval units don't exist in this MVP (El Alamein is a land scenario).
- Air units use `Helicopter` as a universal placeholder.
- FlaK 88 / specialized artillery sprites: **NOT commissioned**. Use `ACS` (from expansion pack) as the artillery visual — it's the third distinct vehicle body and reads as "heavy armor / self-propelled gun" well enough at this render size.

---

## 1. Asset Inventory (verified file-by-file)

### 1.1 Tanks (all have separated body + turret — critical)

| Game unit type | Source folder | Body file | Turret file | Move animation | Fire animation |
|---|---|---|---|---|---|
| `main_tank` | `Panzer/` | `PanzerBase.png` (128×128) | `PanzerTower.png` (128×128) | `Panzer_Move/PanzerMove (1-4).png` (4 frames) | `Panzer_Fire/Panzer Shot 01-03.png` (3 frames, body-level muzzle flash) |
| `light_tank` | `BTR/` | `BTR_Base.png` (128×128) | `BTR_Tower.png` (128×128) | `BTR_Move/BTR_Move01-02.png` (2 frames) | `BTR_Shot/BTR_Shot01-02.png` (2 frames) |
| `artillery` | `ACS/` (in `tds-modern-soldiers-and-vehicles-sprites-2/`) | `ACS/Source/ACS_Base.png` | `ACS/Source/ACS_Tower.png` | `ACS/Move/ACS_move._01-03.png` (3 frames) | none — reuse Panzer muzzle flash particle |

All files are under `tds-modern-pixel-game-kit/tds-pixel-art-modern-soldiers-and-vehicles-sprites/` unless otherwise noted.

### 1.2 Infantry (single-direction, runtime rotate)

| Game unit type | Source folder | Idle | Walk | Fire |
|---|---|---|---|---|
| `infantry` | `Soldier/` | `Soldier.png` (64×64) | `Soldier/Walk/SW_01-07.png` (7 frames, 96×96 each) | `Soldier/Shot/Soldier Shot.png` (single frame) |
| `elite_guard` | `Soldier 02/` | `Soldier 02/Soldier02.png` + `Soldier 02/BAZOOKA.png` (bazooka is a separate accessory layer) | — (no walk cycle, use idle) | `Soldier 02/Fire/SF_01-05.png` (5 frames) |
| `commander` | `tds-modern-hero-weapons-and-props/Hero_Rifle/` | (first walk frame, see directory) | full walk cycle (enumerate at implementation time) | — (treat attack as idle flash for MVP) |

### 1.3 Air placeholder

| Game unit type | Source |
|---|---|
| any `AirUnitType` | `tds-modern-soldiers-and-vehicles-sprites-2/Helicopter/Source/Helicopter_Source.png` + rotor from `Helicopter/Parts/Helicopter_Screw_4x.png` (separate layer, rotates fast regardless of movement) |

### 1.4 Juice / particle assets

| Effect | Files | Use |
|---|---|---|
| Muzzle flash (big, tank cannon) | `Effects/Panzer Fire/Panzer_fire1-3.png` (3 frames) | Spawn at tank turret tip on attack fire |
| Muzzle flash (small) | `Effects/BTR Fire/BTR_Fire_01-03.png` (3 frames) | Spawn at BTR turret tip |
| Smoke cloud | `Effects/LightSmoke/Light-Smoke_0000s_0000_*.png` (7 frames) | Spawn at unit death position (briefly, then red × battle marker takes over) |

### 1.5 What we are NOT using (and why)

- `*/Broken/*` folders — user decision: dead units disappear, no destroyed sprites.
- `Humvee/` — redundant given Panzer/BTR/ACS cover the tank roles.
- `Bomber/` — single air placeholder (Helicopter) is enough for MVP.
- `Gunner/` and `Sniper/` — expansion tier beyond MVP unit types.
- `tds-modern-tilesets-environment/` — the game already has terrain rendering.
- `tds-modern-gui-pixel-art/` — UI is already done.
- `icons/` — not relevant to in-game rendering.
- All `*.psd` files — source files. PNGs only ship (license requirement §1.1.3 of CraftPix EULA).

---

## 2. File Structure You Will Create

```
apps/web/public/sprites/tds/                 ← runtime-served static assets
├── tanks/
│   ├── panzer_body.png
│   ├── panzer_turret.png
│   ├── panzer_move_01.png ... panzer_move_04.png
│   ├── btr_body.png
│   ├── btr_turret.png
│   ├── btr_move_01.png ... btr_move_02.png
│   ├── acs_body.png
│   ├── acs_turret.png
│   └── acs_move_01.png ... acs_move_03.png
├── infantry/
│   ├── soldier_idle.png
│   ├── soldier_walk_01.png ... soldier_walk_07.png
│   ├── soldier_shot.png
│   ├── elite_idle.png         ← renamed Soldier02.png
│   ├── elite_bazooka.png      ← BAZOOKA.png
│   ├── elite_fire_01.png ... elite_fire_05.png
│   ├── commander_walk_01.png  ... commander_walk_NN.png (copy Hero_Rifle walk frames)
│   └── commander_idle.png
├── air/
│   ├── heli_body.png
│   └── heli_rotor.png
└── effects/
    ├── muzzle_big_01.png ... muzzle_big_03.png
    ├── muzzle_small_01.png ... muzzle_small_03.png
    └── smoke_01.png ... smoke_07.png

apps/web/src/rendering/                      ← all new TS code
├── spriteManifest.ts        ← declarative sprite definitions (see §4)
├── spriteLoader.ts          ← PNG → ImageBitmap preloader
├── headingCache.ts          ← WeakMap<Unit, HeadingState>
├── frameCache.ts            ← WeakMap<Unit, FrameState>
├── placeholderSprites.ts    ← procedural fallback (circle/hexagon/star) for unmapped units
├── unitRenderer.ts          ← exports renderUnit(ctx, unit, ...) — called from rendererCanvas.ts
└── juice/
    ├── muzzleFlashLayer.ts  ← spawns flash particles on unit.lastAttackTime change
    ├── deathSmokeLayer.ts   ← spawns smoke puff when unit disappears
    └── particlePool.ts      ← simple object pool for particles
```

### 2.1 Asset copy script (required)

Write a one-shot copy script `scripts/copy-sprites.sh` that copies from the **absolute external path**

```
/Users/yuqiaohuang/MyProjects/AI Commander/tds-modern-pixel-game-kit/
```

(which lives in the main repo root directory, outside any worktree — see §A) into `apps/web/public/sprites/tds/` **inside the current worktree**, applying the rename mapping above. This makes the process idempotent and documents the file lineage.

The script should hardcode the absolute source path at the top as a variable (`SRC="/Users/yuqiaohuang/MyProjects/AI Commander/tds-modern-pixel-game-kit"`) and use `cp` with explicit named files — NOT recursive globs that might pick up `*.psd`, `license.txt`, or other non-PNG assets. If any source file is missing, the script should print a clear error and exit non-zero.

---

## 3. TypeScript Types (put these in `spriteManifest.ts`)

```typescript
// apps/web/src/rendering/spriteManifest.ts

import type { GroundUnitType, AirUnitType } from "@ai-commander/shared";

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
//   static — no rotation (e.g., helicopter rotor spins independently, or decorative)

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
  stateFrames?: Partial<Record<UnitFrameState, [number, number] | number[]>>;
}

export type UnitFrameState = "idle" | "moving" | "attacking";

export interface SpriteManifestEntry {
  layers: SpriteLayer[];
  /** Draw size multiplier vs baseUnitSize. See §5. */
  drawScale: number;
  /** Whether to darken/tint this sprite for enemy faction (simple hue shift). */
  enemyTint?: boolean;
}

/** Map unit type string → manifest. Missing entries fall back to procedural placeholder. */
export type SpriteManifest = Partial<Record<GroundUnitType | AirUnitType, SpriteManifestEntry>>;
```

---

## 4. The Manifest Itself (put in `spriteManifest.ts`)

```typescript
export const SPRITE_MANIFEST: SpriteManifest = {
  infantry: {
    drawScale: 1.5,
    layers: [
      {
        name: "body",
        orientationMode: "rotate",
        rotatesWith: "movement",
        frames: [
          { url: "/sprites/tds/infantry/soldier_idle.png" },
          { url: "/sprites/tds/infantry/soldier_walk_01.png" },
          { url: "/sprites/tds/infantry/soldier_walk_02.png" },
          { url: "/sprites/tds/infantry/soldier_walk_03.png" },
          { url: "/sprites/tds/infantry/soldier_walk_04.png" },
          { url: "/sprites/tds/infantry/soldier_walk_05.png" },
          { url: "/sprites/tds/infantry/soldier_walk_06.png" },
          { url: "/sprites/tds/infantry/soldier_walk_07.png" },
          { url: "/sprites/tds/infantry/soldier_shot.png" },
        ],
        fps: 10,
        stateFrames: {
          idle: [0],
          moving: [1, 2, 3, 4, 5, 6, 7],  // 7-frame walk cycle
          attacking: [8],                  // shot frame
        },
      },
    ],
  },

  main_tank: {
    drawScale: 2.0,
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
        rotatesWith: "attackTarget",  // independent from body!
        frames: [{ url: "/sprites/tds/tanks/panzer_turret.png" }],
      },
    ],
  },

  light_tank: {
    drawScale: 2.0,
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
      },
    ],
  },

  artillery: {
    drawScale: 2.0,
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
        ],
        fps: 6,
        stateFrames: {
          idle: [0],
          moving: [1, 2, 3],
          attacking: [0],
        },
      },
      {
        name: "turret",
        orientationMode: "rotate",
        rotatesWith: "attackTarget",
        frames: [{ url: "/sprites/tds/tanks/acs_turret.png" }],
      },
    ],
  },

  commander: {
    drawScale: 1.8,
    layers: [
      {
        name: "body",
        orientationMode: "rotate",
        rotatesWith: "movement",
        // Populate from Hero_Rifle/ Walk folder at copy time. Placeholder structure:
        frames: [
          { url: "/sprites/tds/infantry/commander_idle.png" },
          { url: "/sprites/tds/infantry/commander_walk_01.png" },
          // ... add remaining walk frames after running copy script
        ],
        fps: 10,
        stateFrames: {
          idle: [0],
          moving: [1],  // expand once all walk frames are copied
          attacking: [0],
        },
      },
    ],
  },

  elite_guard: {
    drawScale: 1.6,
    layers: [
      {
        name: "body",
        orientationMode: "rotate",
        rotatesWith: "movement",
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
          moving: [0],     // no walk cycle available; use idle
          attacking: [1, 2, 3, 4, 5],
        },
      },
      {
        name: "accessory",
        orientationMode: "rotate",
        rotatesWith: "movement",
        frames: [{ url: "/sprites/tds/infantry/elite_bazooka.png" }],
      },
    ],
  },

  // Air placeholder (covers all AirUnitType values)
  // Note: AirUnitType may have multiple values — duplicate this entry under each
  // or extend the fallback logic to map any AirUnitType → "air_placeholder".
  // For MVP, literal keys below (adjust to actual AirUnitType members):
  // fighter: { ... same layers as below ... },
  // bomber: { ... },
};

// Helicopter layer definition, reused via spreading into each air type entry:
export const HELICOPTER_LAYERS: SpriteLayer[] = [
  {
    name: "body",
    orientationMode: "rotate",
    rotatesWith: "movement",
    frames: [{ url: "/sprites/tds/air/heli_body.png" }],
  },
  {
    name: "rotor",
    orientationMode: "rotate",
    rotatesWith: "alwaysSpin",  // spins at constant rate regardless of movement
    frames: [{ url: "/sprites/tds/air/heli_rotor.png" }],
    fps: 30,  // very fast spin illusion via rotation, not frame swap
  },
];
```

When you populate the actual air entries, look at `packages/shared/src/types.ts` for the current `AirUnitType` union and add a manifest entry for each.

---

## 5. Sizing Math (this is the formula to use)

Current formula (in `rendererCanvas.ts:368`):
```typescript
const baseUnitSize = Math.max(8, tileScreenSize * 0.7);
// tileScreenSize = TILE_SIZE * camera.zoom = 32 * zoom
```

At zoom 1.0, `baseUnitSize ≈ 22.4` pixels diameter.

**New formula for sprite units:**
```typescript
const drawSize = baseUnitSize * manifestEntry.drawScale;
```

With `drawScale` values from §4:
- Infantry: 22.4 × 1.5 = **33.6 px** (about 1 full tile)
- Tanks: 22.4 × 2.0 = **44.8 px** (about 1.4 tiles — clearly bigger than infantry)
- Commander: 22.4 × 1.8 = **40.3 px**
- Elite guard: 22.4 × 1.6 = **35.8 px**

All scale with zoom naturally (because `tileScreenSize` already includes zoom). At max zoom (2.0), tanks render at ~90 px — still a downscale from the 128 px source, so no upscaling blur. At min zoom (0.3), tanks render at ~13 px — small but recognizable.

**Critical: set `ctx.imageSmoothingEnabled = false`** in the unit render pass or the downscale will blur the pixel art.

---

## 6. Runtime Heading Cache (the trick that keeps Unit clean)

Since `Unit` has no `heading` field, derive it from position-over-time:

```typescript
// apps/web/src/rendering/headingCache.ts

import type { Unit } from "@ai-commander/shared";

interface HeadingState {
  heading: number;          // radians, 0 = east, PI/2 = south
  targetHeading: number;    // what we're turning toward
  lastX: number;
  lastY: number;
  lastUpdateTime: number;
}

const cache = new WeakMap<Unit, HeadingState>();

const TURN_RATE = Math.PI * 2; // radians per second (full turn in 1s)

export function getBodyHeading(unit: Unit, now: number): number {
  let state = cache.get(unit);
  if (!state) {
    state = {
      heading: 0,
      targetHeading: 0,
      lastX: unit.position.x,
      lastY: unit.position.y,
      lastUpdateTime: now,
    };
    cache.set(unit, state);
  }

  const dx = unit.position.x - state.lastX;
  const dy = unit.position.y - state.lastY;
  const dist2 = dx * dx + dy * dy;

  // Only update target heading when the unit has meaningfully moved
  if (dist2 > 0.0025) {  // ~0.05 tile threshold
    state.targetHeading = Math.atan2(dy, dx);
    state.lastX = unit.position.x;
    state.lastY = unit.position.y;
  }

  // Smoothly interpolate current heading toward target
  const dt = Math.max(0, now - state.lastUpdateTime);
  state.lastUpdateTime = now;
  state.heading = rotateToward(state.heading, state.targetHeading, TURN_RATE * dt);

  return state.heading;
}

export function getTurretHeading(unit: Unit, now: number, allUnitsById: Map<number, Unit>): number {
  // If unit has an attack target, face it. Otherwise match body heading.
  if (unit.attackTarget !== null) {
    const target = allUnitsById.get(unit.attackTarget);
    if (target) {
      const dx = target.position.x - unit.position.x;
      const dy = target.position.y - unit.position.y;
      return Math.atan2(dy, dx);
    }
  }
  return getBodyHeading(unit, now);
}

function rotateToward(current: number, target: number, maxStep: number): number {
  let diff = target - current;
  while (diff > Math.PI) diff -= 2 * Math.PI;
  while (diff < -Math.PI) diff += 2 * Math.PI;
  if (Math.abs(diff) <= maxStep) return target;
  return current + Math.sign(diff) * maxStep;
}
```

**Key detail**: The sprites in the kit are drawn facing **south** (downward, positive-Y). When you `ctx.rotate()`, account for this: `ctx.rotate(heading + Math.PI / 2)` — because heading=0 means "east", but sprite's natural orientation is "south", so add 90°.

Verify this at implementation time by loading the sprite, setting heading=0, and checking the tank points east. If it's wrong, adjust the offset.

---

## 7. Frame State Cache

```typescript
// apps/web/src/rendering/frameCache.ts

import type { Unit } from "@ai-commander/shared";
import type { UnitFrameState } from "./spriteManifest";

interface FrameState {
  currentFrameState: UnitFrameState;
  frameStartTime: number;
  lastFrameIndex: number;
}

const cache = new WeakMap<Unit, FrameState>();

export function getFrameIndex(
  unit: Unit,
  now: number,
  layerFrames: number[],  // resolved from stateFrames[currentState]
  fps: number,
): number {
  if (layerFrames.length === 0) return 0;
  if (layerFrames.length === 1) return layerFrames[0];

  let state = cache.get(unit);
  if (!state) {
    state = {
      currentFrameState: deriveFrameState(unit),
      frameStartTime: now,
      lastFrameIndex: 0,
    };
    cache.set(unit, state);
  }

  // Reset animation on state change
  const newState = deriveFrameState(unit);
  if (newState !== state.currentFrameState) {
    state.currentFrameState = newState;
    state.frameStartTime = now;
  }

  const elapsed = now - state.frameStartTime;
  const frameStep = 1 / fps;
  const idx = Math.floor(elapsed / frameStep) % layerFrames.length;
  state.lastFrameIndex = layerFrames[idx];
  return layerFrames[idx];
}

function deriveFrameState(unit: Unit): UnitFrameState {
  if (unit.state === "attacking") return "attacking";
  if (unit.state === "moving") return "moving";
  return "idle";
}
```

---

## 8. Sprite Loader

```typescript
// apps/web/src/rendering/spriteLoader.ts

import { SPRITE_MANIFEST } from "./spriteManifest";

const imageCache = new Map<string, ImageBitmap>();
let preloadPromise: Promise<void> | null = null;

export function getSprite(url: string): ImageBitmap | undefined {
  return imageCache.get(url);
}

export function preloadSprites(): Promise<void> {
  if (preloadPromise) return preloadPromise;

  // Collect every unique URL from the manifest
  const urls = new Set<string>();
  for (const entry of Object.values(SPRITE_MANIFEST)) {
    if (!entry) continue;
    for (const layer of entry.layers) {
      for (const frame of layer.frames) {
        urls.add(frame.url);
      }
    }
  }

  preloadPromise = Promise.all(
    Array.from(urls).map(async (url) => {
      try {
        const res = await fetch(url);
        if (!res.ok) {
          console.warn(`[spriteLoader] failed to fetch ${url}: ${res.status}`);
          return;
        }
        const blob = await res.blob();
        const bitmap = await createImageBitmap(blob);
        imageCache.set(url, bitmap);
      } catch (e) {
        console.warn(`[spriteLoader] error loading ${url}`, e);
      }
    }),
  ).then(() => undefined);

  return preloadPromise;
}

export function spriteCount(): number {
  return imageCache.size;
}
```

---

## 9. The Renderer Entry Point

```typescript
// apps/web/src/rendering/unitRenderer.ts

import type { Unit, GameState } from "@ai-commander/shared";
import { SPRITE_MANIFEST, type SpriteManifestEntry, type UnitFrameState } from "./spriteManifest";
import { getSprite } from "./spriteLoader";
import { getBodyHeading, getTurretHeading } from "./headingCache";
import { getFrameIndex } from "./frameCache";
import { drawPlaceholder } from "./placeholderSprites";

/**
 * Draw a single unit at screen coords. Replaces the procedural body block
 * in rendererCanvas.ts:418-431.
 *
 * @param baseUnitSize current zoom-scaled base size (formerly used as diameter)
 */
export function renderUnit(
  ctx: CanvasRenderingContext2D,
  unit: Unit,
  cx: number,
  cy: number,
  baseUnitSize: number,
  gameTime: number,
  allUnitsById: Map<number, Unit>,
): void {
  const entry = SPRITE_MANIFEST[unit.type];
  if (!entry) {
    drawPlaceholder(ctx, unit, cx, cy, baseUnitSize);
    return;
  }

  const drawSize = baseUnitSize * entry.drawScale;
  const halfDraw = drawSize / 2;

  // Derive frame state once per unit per frame
  const bodyHeading = getBodyHeading(unit, gameTime);
  const turretHeading = getTurretHeading(unit, gameTime, allUnitsById);

  ctx.save();
  ctx.imageSmoothingEnabled = false;

  for (const layer of entry.layers) {
    const frames = layer.frames;
    let frameIdx = 0;

    if (layer.stateFrames) {
      const state: UnitFrameState =
        unit.state === "attacking" ? "attacking" :
        unit.state === "moving" ? "moving" : "idle";
      const range = layer.stateFrames[state];
      if (range && Array.isArray(range)) {
        frameIdx = getFrameIndex(unit, gameTime, range as number[], layer.fps ?? 10);
      }
    } else if (frames.length > 1 && layer.rotatesWith === "alwaysSpin") {
      // e.g., helicopter rotor — spin frame purely from time
      frameIdx = Math.floor(gameTime * (layer.fps ?? 10)) % frames.length;
    }

    const frame = frames[frameIdx];
    const bitmap = getSprite(frame.url);
    if (!bitmap) continue;  // image not yet loaded; skip this frame silently

    let rot = 0;
    switch (layer.rotatesWith) {
      case "movement": rot = bodyHeading; break;
      case "attackTarget": rot = turretHeading; break;
      case "alwaysSpin": rot = (gameTime * Math.PI * 4) % (Math.PI * 2); break;
      case "none": rot = 0; break;
    }

    ctx.save();
    ctx.translate(cx, cy);
    // IMPORTANT: source sprites face south; offset by +PI/2 so heading=0 points east
    ctx.rotate(rot + Math.PI / 2);
    ctx.drawImage(bitmap, -halfDraw, -halfDraw, drawSize, drawSize);
    ctx.restore();
  }

  ctx.restore();
}
```

---

## 10. Surgical Edits to `rendererCanvas.ts`

Find the block at lines **418-431** in `apps/web/src/rendererCanvas.ts`:

```typescript
// --- Draw unit body ---
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
```

**Replace with:**

```typescript
// --- Draw unit body (sprite or placeholder) ---
import { renderUnit } from "./rendering/unitRenderer";
// NOTE: add the import near the top of the file; shown inline here for clarity.

renderUnit(ctx, unit, cx, cy, baseUnitSize, gameTime, allUnitsById);
```

You will need to build `allUnitsById` once per frame at the top of `renderUnits()`:
```typescript
const allUnitsById = new Map<number, Unit>();
for (const u of visibleUnits) allUnitsById.set(u.id, u);
```

**Also: remove the attack flash color-override block at lines 404-416** — it will no longer visually do anything because sprite drawing doesn't use `fillColor`/`borderColor`. The attack feedback will instead come from the muzzle flash juice layer (§11).

**Keep all the other overlays as-is:**
- Entrench visual (lines 433-466) — still drawn *over* the sprite
- UNIT_SYMBOLS fallback text (lines 468-475) — **remove for sprite-backed units, keep for placeholder units**. Easiest: check if `SPRITE_MANIFEST[unit.type]` exists before drawing the symbol.
- Manual override indicator (478+) — keep
- HP bar (however it's drawn, find it and keep it) — keep

**Do NOT touch:**
- Selection ring / waypoints
- Attack lines / tracers
- Battle markers (death ×, attack zones) — these remain the primary combat feedback
- Fog of war
- Terrain rendering

---

## 11. Preload Hook in `GameCanvas.tsx`

Find the game initialization effect (look for where the game state is first set up). Add:

```typescript
import { preloadSprites } from "./rendering/spriteLoader";

// In an effect or before starting the game loop:
useEffect(() => {
  preloadSprites().then(() => {
    console.log(`[sprites] loaded ${spriteCount()} bitmaps`);
  });
}, []);
```

The renderer silently falls back to not drawing the layer if a bitmap isn't ready yet, so the game can start immediately and sprites pop in as they finish loading (for 384 small PNGs total, this should be <2 seconds on localhost).

---

## 12. Juice Layer (lightweight, 1-2 hours of work)

### 12.1 Muzzle flash

```typescript
// apps/web/src/rendering/juice/muzzleFlashLayer.ts

import type { Unit } from "@ai-commander/shared";
import { getSprite } from "../spriteLoader";
import { getTurretHeading } from "../headingCache";

interface FlashInstance {
  x: number;
  y: number;
  rotation: number;
  startTime: number;
  urls: string[];
  fps: number;
}

const active: FlashInstance[] = [];
const lastAttackSeen = new WeakMap<Unit, number>();

const TANK_FLASH_URLS = [
  "/sprites/tds/effects/muzzle_big_01.png",
  "/sprites/tds/effects/muzzle_big_02.png",
  "/sprites/tds/effects/muzzle_big_03.png",
];
const SMALL_FLASH_URLS = [
  "/sprites/tds/effects/muzzle_small_01.png",
  "/sprites/tds/effects/muzzle_small_02.png",
  "/sprites/tds/effects/muzzle_small_03.png",
];

export function updateMuzzleFlashes(
  units: Unit[],
  allUnitsById: Map<number, Unit>,
  gameTime: number,
): void {
  for (const unit of units) {
    const lastSeen = lastAttackSeen.get(unit) ?? 0;
    if (unit.lastAttackTime > lastSeen && unit.state === "attacking") {
      lastAttackSeen.set(unit, unit.lastAttackTime);
      spawnFlash(unit, allUnitsById, gameTime);
    }
  }
  // Reap expired
  for (let i = active.length - 1; i >= 0; i--) {
    if (gameTime - active[i].startTime > 0.25) active.splice(i, 1);
  }
}

function spawnFlash(unit: Unit, allUnitsById: Map<number, Unit>, gameTime: number): void {
  const isTank = unit.type === "main_tank" || unit.type === "light_tank" || unit.type === "artillery";
  const urls = isTank ? TANK_FLASH_URLS : SMALL_FLASH_URLS;
  active.push({
    x: unit.position.x,
    y: unit.position.y,
    rotation: getTurretHeading(unit, gameTime, allUnitsById),
    startTime: gameTime,
    urls,
    fps: 24,
  });
}

export function drawMuzzleFlashes(
  ctx: CanvasRenderingContext2D,
  gameTime: number,
  worldToScreen: (x: number, y: number) => { x: number; y: number },
  tileSize: number,
): void {
  ctx.save();
  ctx.imageSmoothingEnabled = false;
  for (const f of active) {
    const age = gameTime - f.startTime;
    const idx = Math.min(f.urls.length - 1, Math.floor(age * f.fps));
    const bitmap = getSprite(f.urls[idx]);
    if (!bitmap) continue;
    const screen = worldToScreen(f.x, f.y);
    const size = tileSize * 1.5;
    ctx.save();
    ctx.translate(screen.x, screen.y);
    ctx.rotate(f.rotation + Math.PI / 2);
    // offset forward so flash emerges from gun tip, not unit center
    ctx.translate(0, -size * 0.6);
    ctx.drawImage(bitmap, -size / 2, -size / 2, size, size);
    ctx.restore();
  }
  ctx.restore();
}
```

Wire `updateMuzzleFlashes(visibleUnits, allUnitsById, gameTime)` once per frame in `renderUnits()` (before the per-unit loop), and call `drawMuzzleFlashes(...)` *after* all unit bodies are drawn (so flash appears on top).

### 12.2 Death smoke puff

Cheaper version: when a unit you've been tracking disappears from `state.units`, spawn a smoke puff at its last known position. Use a `WeakRef` or a Set of seen unit IDs to detect disappearance. Same rendering approach as muzzle flash, with `smoke_01 ... smoke_07` frames at 15 fps.

Keep the red × battle marker as the persistent "battle happened here" indicator. The smoke is just a 0.5-second flourish.

---

## 13. `.gitignore` Entry

The user has (or should have) already added the following to the **main repo root** `.gitignore` before starting:

```
# Raw sprite assets (licensed, not for redistribution via git history)
/tds-modern-pixel-game-kit/
/tds-modern-pixel-game-kit.zip
```

This is because the raw asset pack lives at `/Users/yuqiaohuang/MyProjects/AI Commander/tds-modern-pixel-game-kit/` (main repo root, outside any worktree — see §A). If those two lines are not yet in `.gitignore`, STOP and ask the user to add them before you proceed. Do not proceed until `git status` in the main repo shows the asset folder as ignored.

The *runtime-used* PNGs live under `apps/web/public/sprites/tds/` **inside the worktree** and **should be checked in** — those are the ones the game actually serves. They are small, renamed, and license-compliant. The raw unorganized `tds-modern-pixel-game-kit/` extraction stays outside the worktree and is never committed.

**Before checking anything in**, verify the CraftPix license file is copied alongside the sprites as `apps/web/public/sprites/tds/LICENSE.txt` (just a URL pointing to https://craftpix.net/file-licenses/ is enough — it was a single-line file in the source). Keep the purchase receipt separately in a personal drive.

---

## 14. Testing Plan

### 14.1 Smoke test (do this first)

1. Run `npm run dev` after implementing §8 and §11.
2. Open the El Alamein scenario with `?nofog=1`.
3. Open browser devtools → Network → filter "sprite". Confirm the 20-30 PNGs load with 200 OK and no 404s.
4. Confirm `[sprites] loaded N bitmaps` console log fires.

### 14.2 Visual verification

1. Zoom in to 100% on a group of infantry + tanks. Infantry should be visibly smaller than tanks. Both should be visibly bigger than the old circles.
2. Pan to a moving unit. The body should rotate to face its movement direction. For tanks, the turret should stay locked on the enemy even while the body turns.
3. Trigger combat. Confirm:
   - Muzzle flash appears at tank turret tips when firing
   - Walk animation plays when infantry is moving
   - Dead units disappear (no broken/destroyed sprite visible)
   - Red × marker stays where the death happened
4. Zoom out to min (0.3x). Sprites should still be visible and not collapse to invisible.
5. Zoom in to max (2.0x). Sprites should not appear blurry — if they do, check that `imageSmoothingEnabled = false` is being applied in `renderUnit()`.

### 14.3 Performance check

1. In El Alamein full scenario with ~200 units active, confirm frame rate stays ≥55 fps on an M-series Mac.
2. Use `preview_eval` with `performance.now()` sampling around the render loop if there's any perceived stutter.

### 14.4 Fallback test

1. Temporarily remove one entry from `SPRITE_MANIFEST` (e.g., `commander`).
2. Commanders should render as the old procedural star — no crash, no visual break.
3. Restore the entry.

---

## 15. Execution Order (do these in order)

1. ☐ Create `scripts/copy-sprites.sh`; run it to populate `apps/web/public/sprites/tds/`
2. ☐ Create `apps/web/src/rendering/spriteManifest.ts` (types + constant from §3, §4)
3. ☐ Create `spriteLoader.ts` (§8)
4. ☐ Create `headingCache.ts` (§6)
5. ☐ Create `frameCache.ts` (§7)
6. ☐ Create `placeholderSprites.ts` — copy the existing circle/hexagon/star logic from `rendererCanvas.ts:418-431` into a function `drawPlaceholder(ctx, unit, cx, cy, size)`
7. ☐ Create `unitRenderer.ts` (§9)
8. ☐ Edit `rendererCanvas.ts`: replace the body-drawing block with `renderUnit(...)` call per §10. Keep all other overlays. Remove the UNIT_SYMBOLS text for sprite-backed units.
9. ☐ Edit `GameCanvas.tsx`: add `preloadSprites()` call per §11
10. ☐ Run smoke test (§14.1)
11. ☐ Create `juice/muzzleFlashLayer.ts` (§12.1)
12. ☐ Wire muzzle flashes into `rendererCanvas.ts` render order
13. ☐ Create `juice/deathSmokeLayer.ts` (§12.2 — optional MVP polish)
14. ☐ Add `.gitignore` entries (§13)
15. ☐ Run full visual verification (§14.2)
16. ☐ Commit in logical chunks:
    - Commit 1: "feat(sprites): add sprite manifest + loader + heading cache"
    - Commit 2: "feat(sprites): integrate sprite renderer in rendererCanvas"
    - Commit 3: "feat(juice): muzzle flash + death smoke"
    - Commit 4: "chore: gitignore raw asset pack, copy license"

---

## 16. Known Unknowns (OK to discover at implementation time)

- **Sprite source-orientation offset**: The +π/2 offset in §6 is my best guess. If tanks point north instead of east, flip sign. Test at first run.
- **Commander walk frame count**: I didn't enumerate Hero_Rifle/Walk/ exhaustively. When you run the copy script, count the actual frames and update the manifest.
- **`UnitState` enum exact values**: I wrote `"idle" | "moving" | "attacking"` but the actual enum may differ. Check `packages/shared/src/types.ts` for the real values and adjust `deriveFrameState()`.
- **`AirUnitType` members**: Enumerate from types.ts and add one manifest entry per air type, all reusing `HELICOPTER_LAYERS`.
- **File name sanity**: Some source files had Japanese/garbled characters from the zip encoding (`足ｮｩ`). Make sure the copy script renames to the clean ASCII names shown in §2.

---

## 17. Things Explicitly NOT in Scope (do NOT do these)

- ❌ Don't build an atlas slicer — all frames are individual PNGs
- ❌ Don't build 4/8-direction pre-rendered support — runtime rotate is sufficient
- ❌ Don't build a broken/destroyed sprite system — dead units disappear
- ❌ Don't add sprite fields to `Unit` / `GameState` / `packages/shared`
- ❌ Don't touch combat math, AI, or pathfinding
- ❌ Don't replace the battle marker system (red ×, attack zones, critical fronts)
- ❌ Don't replace terrain rendering, fog of war, or UI
- ❌ Don't commission FlaK 88 or WW2-specific sprites — artillery uses ACS, this is intentional
- ❌ Don't recolor the sprites for WW2 desert theme — the green is fine for MVP; desert recolor is a separate post-MVP task
- ❌ Don't ship `.psd` files (license forbids source file redistribution)

---

## 18. Future Extension Hooks (for the next plan, not this one)

These are the hooks where the architecture is designed to plug in further work without refactoring:

1. **Atlas support** — `SpriteFrame.sx/sy/sw/sh` fields are already in the schema. When we migrate to atlases, add an atlas resolution pass in `spriteLoader.ts` that slices the atlas into individual `ImageBitmap`s on load. No changes to `unitRenderer.ts` needed.

2. **Pre-rendered direction frames** — `SpriteLayer.orientationMode` enum can be extended to `"directional4"` / `"directional8"`. `unitRenderer.ts` would branch on mode.

3. **WW2 recolor** — Add a `colorMatrix` or `hueShift` field to `SpriteManifestEntry`. Apply via offscreen canvas at preload time. Completely transparent to the game code.

4. **Custom FlaK 88** — When the commissioned artwork arrives, drop the PNG under `apps/web/public/sprites/tds/tanks/flak88_*.png` and add a new manifest entry under a new `GroundUnitType` value (if we add one) or under `artillery` as a scenario-specific variant. The mechanism for "scenario-specific sprite" is: pass a `scenarioId` to `renderUnit()` and have the manifest lookup prefer `artillery:88` over plain `artillery`.

5. **Infantry 4-direction sheets** — If later we want soldiers to face 4 cardinal directions with pre-rendered art instead of rotating, the mode enum extension handles it.

---

## 19. Estimated Effort

| Task | Hours |
|---|---|
| Copy script + file organization | 0.5 |
| Manifest + types | 1.0 |
| Loader + caches (heading, frame) | 1.5 |
| unitRenderer.ts + integration into rendererCanvas | 2.0 |
| Preload hook in GameCanvas | 0.25 |
| Smoke test + visual fixes (orientation offset, scale) | 1.5 |
| Muzzle flash juice | 1.0 |
| Death smoke juice (optional) | 0.5 |
| Final polish + commits | 1.0 |
| **Total (MVP)** | **~9 hours** |

Expect to spend 70% of the actual time in the smoke-test / visual-fix step because source sprite orientation, pivot, and scale always need tweaking against real rendering. Budget accordingly.

---

## 20. End State

When you finish all of §15, running the El Alamein scenario should show:

- Infantry units rendered as small green soldier sprites, walking with a visible gait animation, facing their movement direction.
- Tanks (main/light/artillery) rendered as three visually distinct armored vehicles, each ~2x larger than current units, with turrets independently tracking their attack targets while the body rotates toward movement direction.
- Commanders rendered as a distinct Hero character with rifle (different from generic infantry).
- Elite guards rendered as a soldier with a bazooka accessory.
- Air units (if any) rendered as a helicopter with a spinning rotor, regardless of which `AirUnitType` variant.
- Attack fire triggers a muzzle flash at the turret tip / soldier's weapon.
- Dead units disappear, leaving the existing red × battle marker.
- Trench arcs, HP bars, selection rings, waypoints, fog of war, UI, diagnostics — all **unchanged**.

No changes visible in `packages/core`, `packages/shared`, or any file outside `apps/web/src/rendering/` and the two surgical edits to `rendererCanvas.ts` + `GameCanvas.tsx`.

The sprite layer is deletable via:
```bash
rm -rf apps/web/src/rendering apps/web/public/sprites
# then revert the two surgical edits
```

This is the "escape hatch" for UE5 migration — a clean cut line.

---

**END OF PLAN**

If anything in this document contradicts reality when you open the code (e.g., the line numbers shifted, enum values differ, file paths moved), trust the code and update your mental model. Then execute the spirit of the plan, not the letter of the plan.
