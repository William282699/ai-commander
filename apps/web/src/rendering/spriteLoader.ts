// ============================================================
// AI Commander — Sprite Loader
// Preloads every PNG referenced by SPRITE_MANIFEST into an ImageBitmap cache.
// Silently skips failed loads so the game can start even if some assets are missing.
//
// See SPRITE_INTEGRATION_PLAN.md §8.
// ============================================================

import { SPRITE_MANIFEST } from "./spriteManifest";
import { MUZZLE_FLASH_URLS } from "./juice/muzzleFlashLayer";
import { DEATH_SMOKE_URLS } from "./juice/deathSmokeLayer";

const imageCache = new Map<string, ImageBitmap>();
let preloadPromise: Promise<void> | null = null;

export function getSprite(url: string): ImageBitmap | undefined {
  return imageCache.get(url);
}

export function spriteCount(): number {
  return imageCache.size;
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
  // Juice layers declare their sprite URLs alongside the manifest — preload
  // them so a tank's first shot shows a flash instead of an invisible frame.
  for (const url of MUZZLE_FLASH_URLS) urls.add(url);
  for (const url of DEATH_SMOKE_URLS) urls.add(url);

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
