// ============================================================
// Minimap Colors — El Alamein desert palette
// Re-exports from manifest for convenient import.
// ============================================================

import type { TerrainType } from "@ai-commander/shared";
import { TERRAIN_TILE_MANIFEST } from "./terrainManifest";

/** Minimap colors derived from the terrain manifest. */
export const TERRAIN_MINIMAP_COLORS: Record<TerrainType, string> = Object.fromEntries(
  Object.entries(TERRAIN_TILE_MANIFEST).map(([k, v]) => [k, v.minimapColor]),
) as Record<TerrainType, string>;
