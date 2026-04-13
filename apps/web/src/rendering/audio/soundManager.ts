// ============================================================
// AI Commander — Sound Manager (Singleton)
// Creates/caches Howl instances, handles volume control and mute.
// ============================================================

import { Howl, Howler } from "howler";
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
        html5: true, // Use HTML5 Audio — Web Audio API fails to decode some MP3 files
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

    // Ensure AudioContext is running (may still be suspended after page load)
    this.unlock();

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

  /** Stop a specific sound (by sound ID string) */
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

  /**
   * Unlock the AudioContext. MUST be called from a direct user-gesture handler
   * (click / keydown) so the browser allows resuming.
   */
  unlock(): void {
    const ctx = Howler.ctx;
    if (ctx && ctx.state === "suspended") {
      ctx.resume().then(() => {
        console.log("[audio] AudioContext unlocked");
      });
    }
  }

  /** Start ambient loops (call once after user gesture) */
  startAmbient(): void {
    this.unlock();
    // Play any ambient sounds that exist in the manifest
    for (const [id, entry] of this.entries) {
      if (entry.category === "ambient" && entry.loop) {
        this.play(id);
      }
    }
  }

  /** Stop ambient loops */
  stopAmbient(): void {
    this.stopCategory("ambient");
  }

  /** Master mute toggle */
  toggleMute(): void {
    this.muted = !this.muted;
    Howler.mute(this.muted);
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
