// ============================================================
// AI Commander — Ambient Sound System
// Starts/stops ambient loops (desert wind, distant battle).
// Must be called AFTER a user gesture to satisfy autoplay policy.
// ============================================================

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
