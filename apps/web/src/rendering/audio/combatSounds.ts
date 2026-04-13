// ============================================================
// AI Commander — Combat Sound Triggers
// Hooks into muzzle flash / death smoke detectors via callbacks.
// ============================================================

import { setAttackSoundCallback } from "../juice/muzzleFlashLayer";
import { setDeathSoundCallback } from "../juice/deathSmokeLayer";
import { soundManager } from "./soundManager";
import { ATTACK_SOUND_BY_UNIT_TYPE, DEATH_SOUND_BY_CATEGORY } from "./soundManifest";
import type { Unit } from "@ai-commander/shared";

function getUnitCategory(unitType: string): string {
  const vehicles = ["main_tank", "light_tank", "artillery"];
  const air = ["fighter", "bomber", "recon_plane"];
  if (vehicles.includes(unitType)) return "ground_vehicle";
  if (air.includes(unitType)) return "air";
  return "ground_infantry";
}

// Global combat sound cooldown — limits to ~20 sounds/sec max
let lastCombatSoundTime = 0;
const COMBAT_SOUND_MIN_INTERVAL = 0.05; // 50ms between any combat sound

function shouldPlayCombatSound(gameTime: number): boolean {
  if (gameTime - lastCombatSoundTime < COMBAT_SOUND_MIN_INTERVAL) return false;
  lastCombatSoundTime = gameTime;
  return true;
}

export function initCombatSounds(): void {
  // Wire attack sound
  setAttackSoundCallback((unit: Unit, gameTime: number) => {
    if (!shouldPlayCombatSound(gameTime)) return;
    const soundIds = ATTACK_SOUND_BY_UNIT_TYPE[unit.type];
    if (soundIds) {
      soundManager.playRandom(soundIds);
    }
  });

  // Wire death sound
  setDeathSoundCallback((unit: Unit, gameTime: number) => {
    if (!shouldPlayCombatSound(gameTime)) return;
    const category = getUnitCategory(unit.type);
    const soundIds = DEATH_SOUND_BY_CATEGORY[category];
    if (soundIds) {
      soundManager.playRandom(soundIds);
    }
  });
}
