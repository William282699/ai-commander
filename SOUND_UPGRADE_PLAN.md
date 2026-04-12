# Sound System Upgrade Plan — Combat SFX + Ambient Audio

**Audience**: The next Claude Code window that opens this file.
**Mission**: Add a sound system to the game from scratch. Currently the game is completely silent — zero audio code, zero audio files. By the end of this plan, the player will hear gunfire, explosions, tank engines, desert wind, and UI feedback sounds.
**Status at handoff**: No audio system exists. Trigger points in the renderer have been identified. Architecture decisions locked. This document is self-contained.

---

## START HERE — New Window Orientation

### A. Verify you are in the right place

```bash
pwd
git status && git branch --show-current
ls apps/web/src/rendererCanvas.ts 2>/dev/null
ls apps/web/src/rendering/juice/muzzleFlashLayer.ts 2>/dev/null
```

**Required invariants:**

1. `apps/web/src/rendererCanvas.ts` exists → you are in the AI Commander repo.
2. `apps/web/src/rendering/juice/muzzleFlashLayer.ts` exists → sprite integration is merged.
3. Current branch is NOT `main`.

### B. Architectural constraints — NON-NEGOTIABLE

Same isolation rules as sprite and terrain upgrades. The entire sound system must be deletable with `rm -rf`.

**Files you may NOT modify under any circumstance:**

- Anything under `packages/shared/` — no changes to types, game state, combat logic
- Anything under `packages/core/` — game logic is untouchable
- `apps/web/src/rendering/unitRenderer.ts`, `spriteManifest.ts`, `spriteLoader.ts` — sprite system frozen
- `apps/web/src/rendering/terrain/` — terrain system frozen

**Files you ARE allowed to modify:**

| File | Allowed change |
|---|---|
| `apps/web/src/rendering/juice/muzzleFlashLayer.ts` | Add a sound trigger callback alongside the existing flash spawn (1-2 lines). The visual flash logic must stay unchanged. |
| `apps/web/src/rendering/juice/deathSmokeLayer.ts` | Add a sound trigger callback alongside the existing smoke spawn (1-2 lines). The visual smoke logic must stay unchanged. |
| `apps/web/src/GameCanvas.tsx` | Add sound system initialization + UI sound triggers at existing input handling points. |
| `apps/web/package.json` | Add `howler` dependency. |

**Files you CREATE (purely additive):**

- `apps/web/src/rendering/audio/` — all sound code lives here
- `apps/web/public/sfx/` — audio files served at runtime

### C. Execution order and checkpoints

1. **After step 3** (sound manager + manifest created, howler installed) — run type check, confirm no errors.
2. **After step 6** (combat sounds wired + audio files placed) — run `pnpm dev`, trigger combat, confirm sounds play. This is the big checkpoint.
3. **After step 8** (ambient + UI sounds) — describe final audio state.
4. **Before any git operations** — stop completely. User commits manually.

### D. Git and commit policy

Same as previous plans: **never commit, never push, never `git add -A`**. User does all git operations.

### E. Audio files — User must provide

**CRITICAL: This plan requires audio files to exist at `apps/web/public/sfx/` before sounds will play.** The code gracefully handles missing files (silent fallback), so you can implement the full system first and add audio files later.

See §5 for the complete list of required audio files, filenames, and recommended free sources. The user may need to download these manually from Kenney.nl, Freesound.org, or other CC0 sources.

If audio files are not yet present when you reach the combat sound checkpoint (step 6), tell the user what files are missing and where to get them. Do NOT try to download files yourself.

---

## 0. Context

### 0.1 Current state

**Zero audio code.** No `Howler`, no `AudioContext`, no `<audio>` elements, no `.mp3`/`.ogg`/`.wav` files anywhere in the project. `apps/web/package.json` has React + Vite only.

### 0.2 Existing trigger points we'll hook into

The juice layer system already detects combat events for visual effects. We piggyback on the same detection:

| Event | Existing detector | Location | Detection method |
|---|---|---|---|
| **Unit fires** | `muzzleFlashLayer.ts` `updateMuzzleFlashes()` | Line ~134 | `unit.lastAttackTime > prevCachedTime` via WeakMap |
| **Unit dies** | `deathSmokeLayer.ts` `updateDeathSmoke()` | Line ~92 | `unit.state === "dead"` + WeakMap `alreadySmoked` |
| **Attack line appears** | `rendererCanvas.ts` `renderCombatEffects()` | Line ~1122 | `age < threshold` on AttackLine array |
| **Explosion appears** | `rendererCanvas.ts` `renderCombatEffects()` | Line ~1155 | `age < threshold` on Explosion array |
| **Unit selected** | `GameCanvas.tsx` game loop | Line ~841 | `input.selectionComplete` flag |
| **Order issued** | `GameCanvas.tsx` game loop | Line ~953 | `applyPlayerCommands()` call |
| **Deselect** | `GameCanvas.tsx` game loop | Line ~876 | `input.escPressed` flag |

### 0.3 User's explicit instructions

- Add sound effects to the game
- Don't break current architecture (terrain, sprites, game logic)
- El Alamein theme (desert ambiance)

---

## 1. Technology Choice: Howler.js

**Why Howler.js** (not raw Web Audio API):
- ~10KB gzipped, zero dependencies
- Auto-handles browser autoplay restrictions (user gesture unlock)
- Sprite sheet support (multiple sounds in one file — optional, not using for MVP)
- Volume control, fade, spatial positioning (optional for later)
- Cross-browser compatibility (Safari quirks handled internally)
- Simple API: `new Howl({ src: [...] }); howl.play();`

**Install:**
```bash
pnpm -C apps/web add howler
pnpm -C apps/web add -D @types/howler
```

---

## 2. File Structure

```
apps/web/src/rendering/audio/
├── soundManager.ts         ← Singleton: creates/caches Howl instances, volume control, mute toggle
├── soundManifest.ts        ← Sound ID → file path + volume + category mapping
├── combatSounds.ts         ← Hooks into muzzle flash / death smoke detectors
├── ambientSounds.ts        ← Desert wind loop, distant battle ambiance
└── uiSounds.ts             ← Click, select, order, deselect

apps/web/public/sfx/
├── combat/
│   ├── rifle_01.ogg        ← Infantry attack
│   ├── rifle_02.ogg        ← Infantry attack variant
│   ├── rifle_03.ogg        ← Infantry attack variant
│   ├── cannon_01.ogg       ← Tank cannon fire
│   ├── cannon_02.ogg       ← Tank cannon variant
│   ├── machinegun_01.ogg   ← Light tank / BTR
│   ├── explosion_01.ogg    ← Unit death (small)
│   ├── explosion_02.ogg    ← Unit death variant
│   ├── explosion_03.ogg    ← Unit death (large, for tanks)
│   └── artillery_01.ogg    ← Artillery fire (deep boom)
├── ambient/
│   ├── desert_wind.ogg     ← Looping desert wind
│   └── distant_battle.ogg  ← Optional: faint distant gunfire loop
└── ui/
    ├── click.ogg           ← Button/menu click
    ├── select.ogg          ← Unit selection
    ├── order.ogg           ← Move/attack order issued
    └── deselect.ogg        ← ESC / deselect
```

**File format**: `.ogg` (Vorbis) preferred — small size, good quality, supported everywhere except Safari. For Safari fallback, Howler can auto-switch to `.mp3` if we provide both. For MVP, `.ogg` only is fine (Safari 17+ supports it). If the user provides `.mp3` or `.wav` files instead, adjust the manifest paths accordingly.

---

## 3. Sound Manifest

```typescript
// apps/web/src/rendering/audio/soundManifest.ts

export type SoundCategory = "combat" | "ambient" | "ui";

export interface SoundEntry {
  /** Unique sound ID */
  id: string;
  /** URL path (relative to public root) */
  src: string;
  /** Base volume (0-1) */
  volume: number;
  /** Category for volume group control */
  category: SoundCategory;
  /** Whether this sound loops */
  loop: boolean;
  /** Max simultaneous instances (prevents stacking 200 rifle sounds) */
  maxInstances: number;
}

export const SOUND_MANIFEST: SoundEntry[] = [
  // --- Combat ---
  { id: "rifle_01",       src: "/sfx/combat/rifle_01.ogg",       volume: 0.25, category: "combat", loop: false, maxInstances: 5 },
  { id: "rifle_02",       src: "/sfx/combat/rifle_02.ogg",       volume: 0.25, category: "combat", loop: false, maxInstances: 5 },
  { id: "rifle_03",       src: "/sfx/combat/rifle_03.ogg",       volume: 0.25, category: "combat", loop: false, maxInstances: 5 },
  { id: "cannon_01",      src: "/sfx/combat/cannon_01.ogg",      volume: 0.35, category: "combat", loop: false, maxInstances: 3 },
  { id: "cannon_02",      src: "/sfx/combat/cannon_02.ogg",      volume: 0.35, category: "combat", loop: false, maxInstances: 3 },
  { id: "machinegun_01",  src: "/sfx/combat/machinegun_01.ogg",  volume: 0.20, category: "combat", loop: false, maxInstances: 4 },
  { id: "explosion_01",   src: "/sfx/combat/explosion_01.ogg",   volume: 0.40, category: "combat", loop: false, maxInstances: 4 },
  { id: "explosion_02",   src: "/sfx/combat/explosion_02.ogg",   volume: 0.40, category: "combat", loop: false, maxInstances: 4 },
  { id: "explosion_03",   src: "/sfx/combat/explosion_03.ogg",   volume: 0.45, category: "combat", loop: false, maxInstances: 3 },
  { id: "artillery_01",   src: "/sfx/combat/artillery_01.ogg",   volume: 0.35, category: "combat", loop: false, maxInstances: 3 },

  // --- Ambient ---
  { id: "desert_wind",    src: "/sfx/ambient/desert_wind.ogg",   volume: 0.15, category: "ambient", loop: true, maxInstances: 1 },
  { id: "distant_battle", src: "/sfx/ambient/distant_battle.ogg",volume: 0.08, category: "ambient", loop: true, maxInstances: 1 },

  // --- UI ---
  { id: "click",          src: "/sfx/ui/click.ogg",              volume: 0.30, category: "ui", loop: false, maxInstances: 2 },
  { id: "select",         src: "/sfx/ui/select.ogg",             volume: 0.25, category: "ui", loop: false, maxInstances: 2 },
  { id: "order",          src: "/sfx/ui/order.ogg",              volume: 0.30, category: "ui", loop: false, maxInstances: 2 },
  { id: "deselect",       src: "/sfx/ui/deselect.ogg",           volume: 0.20, category: "ui", loop: false, maxInstances: 2 },
];

// Unit type → attack sound ID mapping
export const ATTACK_SOUND_BY_UNIT_TYPE: Record<string, string[]> = {
  infantry:     ["rifle_01", "rifle_02", "rifle_03"],
  elite_guard:  ["rifle_01", "rifle_02", "rifle_03"],
  commander:    ["rifle_01", "rifle_02"],
  main_tank:    ["cannon_01", "cannon_02"],
  light_tank:   ["machinegun_01"],
  artillery:    ["artillery_01", "cannon_01"],
  // Air units (helicopter) — reuse machinegun
  fighter:      ["machinegun_01"],
  bomber:       ["cannon_01"],
  recon_plane:  ["machinegun_01"],
  transport:    ["machinegun_01"],
};

// Unit category → death sound ID mapping
export const DEATH_SOUND_BY_CATEGORY: Record<string, string[]> = {
  ground_vehicle: ["explosion_03"],           // big explosion for tanks
  ground_infantry: ["explosion_01", "explosion_02"],  // smaller explosion for infantry
  air: ["explosion_03"],                      // big explosion for aircraft
};
```

---

## 4. Sound Manager

```typescript
// apps/web/src/rendering/audio/soundManager.ts

import { Howl } from "howler";
import { SOUND_MANIFEST, type SoundEntry, type SoundCategory } from "./soundManifest";

class SoundManager {
  private howls: Map<string, Howl> = new Map();
  private entries: Map<string, SoundEntry> = new Map();
  private activeCounts: Map<string, number> = new Map();
  private categoryVolumes: Record<SoundCategory, number> = {
    combat: 1.0,
    ambient: 1.0,
    ui: 1.0,
  };
  private masterVolume: number = 1.0;
  private muted: boolean = false;
  private initialized: boolean = false;

  /**
   * Create Howl instances for all sounds in the manifest.
   * Does NOT start loading — Howler lazy-loads on first play by default.
   * Call this once at app startup.
   */
  init(): void {
    if (this.initialized) return;
    this.initialized = true;

    for (const entry of SOUND_MANIFEST) {
      this.entries.set(entry.id, entry);
      this.activeCounts.set(entry.id, 0);

      const howl = new Howl({
        src: [entry.src],
        volume: this.computeVolume(entry),
        loop: entry.loop,
        preload: entry.loop, // Only preload loops (ambient); combat sounds lazy-load on first play
        onend: () => {
          if (!entry.loop) {
            const count = this.activeCounts.get(entry.id) ?? 0;
            this.activeCounts.set(entry.id, Math.max(0, count - 1));
          }
        },
        onloaderror: (_id: number, err: unknown) => {
          // Silent fallback — missing audio files should not crash the game
          console.warn(`[audio] failed to load ${entry.src}:`, err);
        },
      });

      this.howls.set(entry.id, howl);
    }

    console.log(`[audio] initialized ${this.howls.size} sounds`);
  }

  /**
   * Play a sound by ID. Respects maxInstances to prevent audio stacking.
   * Returns the Howler sound ID (for stopping/fading) or -1 if skipped.
   */
  play(id: string): number {
    if (this.muted) return -1;
    const entry = this.entries.get(id);
    const howl = this.howls.get(id);
    if (!entry || !howl) return -1;

    // Enforce max instances
    const active = this.activeCounts.get(id) ?? 0;
    if (active >= entry.maxInstances) return -1;

    this.activeCounts.set(id, active + 1);
    howl.volume(this.computeVolume(entry));
    return howl.play();
  }

  /**
   * Play a random sound from a list of IDs.
   * Used for attack/death sound variation.
   */
  playRandom(ids: string[]): number {
    if (ids.length === 0) return -1;
    const idx = Math.floor(Math.random() * ids.length);
    return this.play(ids[idx]);
  }

  /** Stop a specific sound (by Howl ID) */
  stop(id: string): void {
    this.howls.get(id)?.stop();
    this.activeCounts.set(id, 0);
  }

  /** Stop all sounds in a category */
  stopCategory(category: SoundCategory): void {
    for (const [id, entry] of this.entries) {
      if (entry.category === category) {
        this.howls.get(id)?.stop();
        this.activeCounts.set(id, 0);
      }
    }
  }

  /** Start ambient loops (call once after user gesture) */
  startAmbient(): void {
    this.play("desert_wind");
    // distant_battle is optional — uncomment if the file exists:
    // this.play("distant_battle");
  }

  /** Stop ambient loops */
  stopAmbient(): void {
    this.stopCategory("ambient");
  }

  /** Master mute toggle */
  toggleMute(): void {
    this.muted = !this.muted;
    if (this.muted) {
      Howler.mute(true);
    } else {
      Howler.mute(false);
    }
  }

  get isMuted(): boolean {
    return this.muted;
  }

  /** Set category volume (0-1) */
  setCategoryVolume(category: SoundCategory, volume: number): void {
    this.categoryVolumes[category] = Math.max(0, Math.min(1, volume));
    // Update all Howls in this category
    for (const [id, entry] of this.entries) {
      if (entry.category === category) {
        this.howls.get(id)?.volume(this.computeVolume(entry));
      }
    }
  }

  /** Set master volume (0-1) */
  setMasterVolume(volume: number): void {
    this.masterVolume = Math.max(0, Math.min(1, volume));
    Howler.volume(this.masterVolume);
  }

  private computeVolume(entry: SoundEntry): number {
    return entry.volume * this.categoryVolumes[entry.category] * this.masterVolume;
  }
}

// Singleton export
export const soundManager = new SoundManager();
```

---

## 5. Audio File Sourcing Guide

The user needs to download audio files and place them in `apps/web/public/sfx/`. Here are recommended free sources:

### 5.1 Kenney.nl (CC0 — best for explosions + UI)

| Pack | URL | Use |
|---|---|---|
| **Impact Sounds** (130 files) | https://kenney.nl/assets/impact-sounds | Explosions, impacts |
| **Interface Sounds** (100 files) | https://kenney.nl/assets/interface-sounds | UI click, select, order |

Download the zips, pick 2-3 explosion sounds and 3-4 UI sounds, rename to match the filenames in §2.

### 5.2 Freesound.org (CC0 — best for military-specific)

| Sound | URL | Use |
|---|---|---|
| **Rifle shots** | https://freesound.org/people/qubodup/sounds/238916/ | `rifle_01.ogg` etc |
| **Tank engine loop** | https://freesound.org/people/qubodup/sounds/200303/ | (future use) |
| **Desert wind loop** | https://freesound.org/people/Imjeax/sounds/427401/ | `desert_wind.ogg` |
| **War ambience** | https://freesound.org/people/qubodup/sounds/239139/ | `distant_battle.ogg` |

Freesound requires a free account to download. Filter by CC0 license.

### 5.3 OpenGameArt.org (CC0)

| Pack | URL | Use |
|---|---|---|
| **100 CC0 SFX** | https://opengameart.org/content/100-cc0-sfx | General combat sounds |
| **25 CC0 Bang SFX** | https://opengameart.org/content/25-cc0-bang-firework-sfx | Cannon fire |
| **Gun Sound Effects** | https://opengameart.org/content/gun-sound-effects | Rifle variants |

### 5.4 Mixkit.co (Free license, commercial OK)

| Category | URL | Use |
|---|---|---|
| **Gun sounds** (23) | https://mixkit.co/free-sound-effects/gun/ | Rifle, cannon variants |
| **Explosion sounds** (36) | https://mixkit.co/free-sound-effects/explosion/ | Death explosions |

### 5.5 Minimum viable audio set

If the user wants to start with the absolute minimum, these 6 files cover the essentials:

| File | What it is | Where to get |
|---|---|---|
| `sfx/combat/rifle_01.ogg` | Any short gunshot sound | Kenney Impact or Mixkit |
| `sfx/combat/cannon_01.ogg` | Heavy weapon / cannon | Kenney Impact or Mixkit |
| `sfx/combat/explosion_01.ogg` | Explosion | Kenney Impact |
| `sfx/ambient/desert_wind.ogg` | Looping wind sound | Freesound Imjeax |
| `sfx/ui/click.ogg` | UI click | Kenney Interface |
| `sfx/ui/select.ogg` | Unit select chime | Kenney Interface |

The system handles missing files gracefully (Howler logs a warning, sound simply doesn't play). So start with whatever you have and add more later.

---

## 6. Combat Sound Triggers

### 6.1 Attack sounds — Hook into muzzleFlashLayer

The muzzle flash layer already detects new attacks via the `lastAttackTime` WeakMap pattern. We add a sound trigger at the same detection point.

**In `muzzleFlashLayer.ts`, at the point where `curr > prev` is detected (new attack):**

```typescript
// Existing code (around line 134):
if (curr > prev) {
  // ... existing muzzle flash spawn logic ...

  // NEW: Trigger attack sound
  onAttackDetected?.(unit);
}
```

**Pattern: Callback injection**

Instead of importing `soundManager` directly into `muzzleFlashLayer.ts` (which would create a coupling), we use a callback:

```typescript
// In muzzleFlashLayer.ts:
let attackSoundCallback: ((unit: Unit) => void) | null = null;

export function setAttackSoundCallback(cb: (unit: Unit) => void): void {
  attackSoundCallback = cb;
}

// Then in updateMuzzleFlashes, at the detection point:
if (curr > prev) {
  // existing flash spawn...
  attackSoundCallback?.(unit);
}
```

**In `combatSounds.ts`:**

```typescript
import { setAttackSoundCallback } from "../juice/muzzleFlashLayer";
import { setDeathSoundCallback } from "../juice/deathSmokeLayer";
import { soundManager } from "./soundManager";
import { ATTACK_SOUND_BY_UNIT_TYPE, DEATH_SOUND_BY_CATEGORY } from "./soundManifest";
import type { Unit } from "@ai-commander/shared";

function getUnitCategory(unitType: string): string {
  // Map unit type to sound category
  const vehicles = ["main_tank", "light_tank", "artillery"];
  const air = ["fighter", "bomber", "recon_plane", "transport"];
  if (vehicles.includes(unitType)) return "ground_vehicle";
  if (air.includes(unitType)) return "air";
  return "ground_infantry";
}

export function initCombatSounds(): void {
  // Wire attack sound
  setAttackSoundCallback((unit: Unit) => {
    const soundIds = ATTACK_SOUND_BY_UNIT_TYPE[unit.type];
    if (soundIds) {
      soundManager.playRandom(soundIds);
    }
  });

  // Wire death sound
  setDeathSoundCallback((unit: Unit) => {
    const category = getUnitCategory(unit.type);
    const soundIds = DEATH_SOUND_BY_CATEGORY[category];
    if (soundIds) {
      soundManager.playRandom(soundIds);
    }
  });
}
```

### 6.2 Death sounds — Hook into deathSmokeLayer

Same callback pattern:

**In `deathSmokeLayer.ts`, at the point where `unit.state === "dead"` is first detected:**

```typescript
let deathSoundCallback: ((unit: Unit) => void) | null = null;

export function setDeathSoundCallback(cb: (unit: Unit) => void): void {
  deathSoundCallback = cb;
}

// In updateDeathSmoke, at the detection point (around line 93):
if (unit.state === "dead" && !alreadySmoked.has(unit)) {
  alreadySmoked.set(unit, true);
  // existing smoke spawn...
  deathSoundCallback?.(unit);
}
```

### 6.3 Sound throttling for large battles

With 200+ units fighting, dozens of attacks happen per second. Without throttling, the audio layer would try to play 50+ simultaneous gunshots and sound like garbage.

**Two-level throttling:**

1. **`maxInstances` in manifest** (per sound ID): e.g., max 5 simultaneous `rifle_01` — the 6th attempt is silently dropped by `soundManager.play()`.

2. **Global combat sound cooldown** (in `combatSounds.ts`):
```typescript
let lastCombatSoundTime = 0;
const COMBAT_SOUND_MIN_INTERVAL = 0.05; // 50ms between any combat sound

function shouldPlayCombatSound(gameTime: number): boolean {
  if (gameTime - lastCombatSoundTime < COMBAT_SOUND_MIN_INTERVAL) return false;
  lastCombatSoundTime = gameTime;
  return true;
}
```

This limits combat sounds to ~20 per second max, which sounds like a realistic battle without audio clipping.

---

## 7. Ambient Sound System

```typescript
// apps/web/src/rendering/audio/ambientSounds.ts

import { soundManager } from "./soundManager";

let ambientStarted = false;

/**
 * Start ambient sounds. Must be called AFTER a user gesture
 * (click/keypress) to satisfy browser autoplay policy.
 */
export function startAmbientSounds(): void {
  if (ambientStarted) return;
  ambientStarted = true;
  soundManager.startAmbient();
}

/**
 * Stop ambient sounds (e.g., when leaving the game screen).
 */
export function stopAmbientSounds(): void {
  if (!ambientStarted) return;
  ambientStarted = false;
  soundManager.stopAmbient();
}
```

**Browser autoplay policy**: Browsers block audio playback until a user gesture (click, keypress). The ambient sound start should be triggered by the **first user interaction** with the game canvas (click to select, keypress to move camera, etc.).

**In `GameCanvas.tsx`:**
```typescript
// Add a one-time user gesture listener
const handleFirstInteraction = useCallback(() => {
  startAmbientSounds();
  // Remove listeners after first trigger
  document.removeEventListener("click", handleFirstInteraction);
  document.removeEventListener("keydown", handleFirstInteraction);
}, []);

useEffect(() => {
  document.addEventListener("click", handleFirstInteraction);
  document.addEventListener("keydown", handleFirstInteraction);
  return () => {
    document.removeEventListener("click", handleFirstInteraction);
    document.removeEventListener("keydown", handleFirstInteraction);
  };
}, [handleFirstInteraction]);
```

---

## 8. UI Sound Triggers

Hook into existing input handling in `GameCanvas.tsx`:

```typescript
// After unit selection logic (around line 841):
if (input.selectionComplete) {
  // ... existing selection logic ...
  if (input.selectedUnitIds.length > 0) {
    soundManager.play("select");
  }
}

// After order issued (around line 953):
if (input.rightClickCommand) {
  // ... existing order logic ...
  soundManager.play("order");
}

// After ESC deselect (around line 876):
if (input.escPressed) {
  // ... existing deselect logic ...
  soundManager.play("deselect");
}
```

These are tiny 1-line additions at existing code points. No structural changes to the input handling flow.

---

## 9. Integration in GameCanvas.tsx

### 9.1 Initialization

```typescript
// At top of file, add imports:
import { soundManager } from "./rendering/audio/soundManager";
import { initCombatSounds } from "./rendering/audio/combatSounds";
import { startAmbientSounds, stopAmbientSounds } from "./rendering/audio/ambientSounds";

// In the component, add initialization useEffect:
useEffect(() => {
  soundManager.init();
  initCombatSounds();
  return () => {
    stopAmbientSounds();
  };
}, []);
```

### 9.2 Mute toggle

Add a keyboard shortcut for mute (e.g., `M` key):

```typescript
// In the keyboard handler:
if (e.key === "m" || e.key === "M") {
  soundManager.toggleMute();
}
```

This is a nice-to-have. The user can also control volume via `soundManager.setMasterVolume()` or `soundManager.setCategoryVolume()` if a UI panel is added later.

---

## 10. Surgical Edits Summary

**Total modifications to existing files: 4 files, ~15 lines each**

### 10.1 `muzzleFlashLayer.ts`
- Add `deathSoundCallback` variable + `setAttackSoundCallback()` export (3 lines)
- Add callback invocation at detection point (1 line)
- **Does NOT change any existing flash logic**

### 10.2 `deathSmokeLayer.ts`
- Add `deathSoundCallback` variable + `setDeathSoundCallback()` export (3 lines)
- Add callback invocation at detection point (1 line)
- **Does NOT change any existing smoke logic**

### 10.3 `GameCanvas.tsx`
- Add imports (3 lines)
- Add `soundManager.init()` + `initCombatSounds()` in useEffect (3 lines)
- Add ambient sound start on first user gesture (~8 lines)
- Add UI sound triggers at 3 existing input points (3 lines)
- Add mute toggle on `M` key (3 lines)
- **Does NOT change any existing game logic or rendering**

### 10.4 `apps/web/package.json`
- Add `howler` + `@types/howler` dependencies (via `pnpm add`)

---

## 11. Execution Order

1. ☐ Install howler: `pnpm -C apps/web add howler && pnpm -C apps/web add -D @types/howler`
2. ☐ Create `apps/web/src/rendering/audio/soundManifest.ts` (§3)
3. ☐ Create `soundManager.ts` (§4)
4. ☐ Create `combatSounds.ts` (§6)
5. ☐ Add callback hooks to `muzzleFlashLayer.ts` and `deathSmokeLayer.ts` (§6.1, §6.2)
6. ☐ Create `ambientSounds.ts` (§7)
7. ☐ Create `uiSounds.ts` or inline UI triggers (§8)
8. ☐ Edit `GameCanvas.tsx` — add initialization + ambient start + UI triggers + mute toggle (§9)
9. ☐ Create `apps/web/public/sfx/` directory structure and check if user has placed audio files
10. ☐ Run `pnpm dev` — smoke test:
    - Console: `[audio] initialized 16 sounds`
    - Click on canvas → ambient wind starts (if `desert_wind.ogg` exists)
    - Trigger combat → attack sounds play (if combat audio files exist)
    - Press `M` → mute toggle
    - If audio files are missing, Howler logs warnings but game runs fine
11. ☐ Type-check: `pnpm -C apps/web tsc --noEmit` — zero errors
12. ☐ Report to user: what works, what files are still missing

---

## 12. Testing Plan

### 12.1 Smoke test
1. Open game, open devtools console.
2. Confirm `[audio] initialized 16 sounds` log.
3. Click anywhere on canvas.
4. If `desert_wind.ogg` exists: hear wind. If not: Howler warning in console, no crash.

### 12.2 Combat sounds
1. Open El Alamein with `?nofog=1`.
2. Wait for or trigger combat between units.
3. Infantry attacks → rifle sounds.
4. Tank attacks → cannon sounds.
5. Unit dies → explosion sound + visual smoke + red ×.
6. Large battle (20+ units fighting) → sounds don't clip or stutter (throttling works).

### 12.3 UI sounds
1. Click to select a unit → "select" sound.
2. Right-click to issue move order → "order" sound.
3. Press ESC → "deselect" sound.

### 12.4 Mute
1. Press M → all sounds stop.
2. Press M again → sounds resume.

### 12.5 Performance
1. Full scenario with 200+ units: no frame drops from audio (Howler runs on Web Audio API thread, separate from main thread).

---

## 13. Known Unknowns

- **Exact line numbers in muzzleFlashLayer.ts and deathSmokeLayer.ts**: These were analyzed from a previous version. Read the actual files to find the exact callback insertion points. Look for the `if (curr > prev)` pattern in muzzleFlashLayer and the `unit.state === "dead"` + WeakMap check in deathSmokeLayer.
- **UnitType → sound mapping completeness**: The `ATTACK_SOUND_BY_UNIT_TYPE` map in §3 may not cover all unit types. Read `packages/shared/src/types.ts` to enumerate all unit types and ensure complete coverage.
- **Audio file format**: If user provides `.mp3` or `.wav` instead of `.ogg`, adjust manifest paths. Howler handles all three formats.
- **Browser autoplay nuances**: If ambient sound doesn't start on first click, check if Howler's `ctx.resume()` is being called (usually automatic).
- **GameCanvas.tsx line numbers**: The exact insertion points for UI sound triggers depend on the current state of the file after terrain and sprite upgrades. Read the file to find the actual `input.selectionComplete`, `input.rightClickCommand`, and `input.escPressed` handler locations.

---

## 14. Things Explicitly NOT in Scope

- ❌ Don't implement 3D spatial audio / positional sound (distance-based volume)
- ❌ Don't implement background music / soundtrack
- ❌ Don't add a volume slider UI (just the `M` mute toggle for MVP)
- ❌ Don't download audio files — the user provides them
- ❌ Don't add voice acting or radio chatter
- ❌ Don't touch game logic, combat math, or shared types
- ❌ Don't modify terrain rendering or sprite rendering
- ❌ Don't implement sound occlusion (behind mountains, etc.)
- ❌ Don't add sound to the minimap interactions

---

## 15. Future Extensions (post-MVP)

- **Spatial audio**: Volume based on distance from camera center. Battles at the edge of the viewport are quieter.
- **Unit type-specific engine sounds**: Tanks have engine loops while moving.
- **Dynamic ambient**: More gunfire in ambient loop when multiple battles are active.
- **Music system**: Background orchestral/percussion track that intensifies during combat.
- **Volume control UI**: Sliders for master, combat, ambient, UI in the settings panel.
- **Radio chatter**: Stylized military radio voice clips on major events (HQ under attack, objective captured).

---

## 16. Estimated Effort

| Step | Task | Hours |
|---|---|---|
| 1-3 | Install howler + manifest + sound manager | ~1.5h |
| 4-5 | Combat sounds + callback hooks | ~2h |
| 6-7 | Ambient + UI sounds | ~1h |
| 8 | GameCanvas integration | ~1h |
| 9-12 | Testing + tuning | ~1h |
| **Total** | | **~6.5h** |

(Does not include time for the user to source/download audio files.)

---

## 17. End State

When complete:
- The game boots silently, then starts desert wind ambiance on first user interaction.
- Infantry firefights produce rifle shots with 2-3 random variants.
- Tank engagements produce heavy cannon blasts.
- Unit deaths trigger explosions scaled to unit type (small for infantry, large for tanks).
- Selecting units, issuing orders, and deselecting all have UI feedback sounds.
- Large battles (200+ units) sound like a chaotic battlefield without audio clipping.
- Pressing `M` toggles mute for all sounds.
- Missing audio files cause zero crashes — the game just stays silent for those sounds.
- All audio code lives in `apps/web/src/rendering/audio/`, deletable with one `rm -rf`.
