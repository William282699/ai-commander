// ============================================================
// AI Commander — Canvas Renderer (会丢的，别纠结)
// Renders terrain tiles, facilities, fog, minimap on 2D canvas.
// ============================================================

import type { TerrainType, Facility, Front } from "@ai-commander/shared";
import { TILE_SIZE, MAP_WIDTH, MAP_HEIGHT } from "@ai-commander/shared";

// --- Terrain colors ---

const TERRAIN_COLORS: Record<TerrainType, string> = {
  plains:        "#6b8e23",
  hills:         "#556b2f",
  forest:        "#2d5016",
  swamp:         "#5c6b3a",
  road:          "#8b8682",
  shallow_water: "#4a90c4",
  deep_water:    "#1e5fa8",
  bridge:        "#9e9e9e",
  urban:         "#7a7a7a",
  mountain:      "#8b7355",
};

// --- Facility icon colors (by type) ---

const FACILITY_COLORS: Record<string, string> = {
  headquarters:   "#ff4444",
  barracks:       "#ffaa00",
  shipyard:       "#00aaff",
  airfield:       "#aa66ff",
  radar:          "#00ffaa",
  fuel_depot:     "#ff8800",
  ammo_depot:     "#ff4488",
  comm_tower:     "#44ffff",
  rail_hub:       "#ccaa00",
  repair_station: "#44ff44",
  defense_tower:  "#ff6644",
};

const FACILITY_SYMBOLS: Record<string, string> = {
  headquarters:   "HQ",
  barracks:       "B",
  shipyard:       "S",
  airfield:       "A",
  radar:          "R",
  fuel_depot:     "\u2388",  // ⎈ (fuel icon)
  ammo_depot:     "\u25C6",  // ◆
  comm_tower:     "\u2606",  // ☆
  rail_hub:       "\u2550",  // ═
  repair_station: "+",
  defense_tower:  "\u25B2",  // ▲
};

// --- Camera ---

export interface Camera {
  x: number; // top-left world x in pixels (tile coords * TILE_SIZE)
  y: number;
  zoom: number; // 0.5 to 2.0
}

// --- Minimap cache ---

let minimapCache: ImageData | null = null;
let minimapCacheTerrain: TerrainType[][] | null = null;

function buildMinimapCache(
  terrain: TerrainType[][],
  mmWidth: number,
  mmHeight: number,
): ImageData {
  const offscreen = new OffscreenCanvas(mmWidth, mmHeight);
  const octx = offscreen.getContext("2d")!;

  const pixelW = mmWidth / MAP_WIDTH;
  const pixelH = mmHeight / MAP_HEIGHT;

  for (let row = 0; row < MAP_HEIGHT; row++) {
    for (let col = 0; col < MAP_WIDTH; col++) {
      const t = terrain[row]?.[col] ?? "plains";
      octx.fillStyle = TERRAIN_COLORS[t];
      octx.fillRect(
        col * pixelW,
        row * pixelH,
        pixelW + 0.5,
        pixelH + 0.5,
      );
    }
  }

  return octx.getImageData(0, 0, mmWidth, mmHeight);
}

// ──────────────────────────────────────────────
// Render: Terrain
// ──────────────────────────────────────────────

export function renderTerrain(
  ctx: CanvasRenderingContext2D,
  terrain: TerrainType[][],
  camera: Camera,
  canvasWidth: number,
  canvasHeight: number,
): void {
  const tileScreenSize = TILE_SIZE * camera.zoom;

  // Visible tile range
  const startCol = Math.max(0, Math.floor(camera.x / TILE_SIZE));
  const startRow = Math.max(0, Math.floor(camera.y / TILE_SIZE));
  const endCol = Math.min(MAP_WIDTH, Math.ceil((camera.x + canvasWidth / camera.zoom) / TILE_SIZE));
  const endRow = Math.min(MAP_HEIGHT, Math.ceil((camera.y + canvasHeight / camera.zoom) / TILE_SIZE));

  for (let row = startRow; row < endRow; row++) {
    for (let col = startCol; col < endCol; col++) {
      const t = terrain[row]?.[col] ?? "plains";
      const screenX = (col * TILE_SIZE - camera.x) * camera.zoom;
      const screenY = (row * TILE_SIZE - camera.y) * camera.zoom;

      ctx.fillStyle = TERRAIN_COLORS[t];
      ctx.fillRect(screenX, screenY, tileScreenSize + 0.5, tileScreenSize + 0.5);
    }
  }

  // Grid lines (when zoomed in)
  if (camera.zoom >= 1.0) {
    ctx.strokeStyle = "rgba(0,0,0,0.1)";
    ctx.lineWidth = 0.5;
    for (let row = startRow; row <= endRow; row++) {
      const y = (row * TILE_SIZE - camera.y) * camera.zoom;
      ctx.beginPath();
      ctx.moveTo((startCol * TILE_SIZE - camera.x) * camera.zoom, y);
      ctx.lineTo((endCol * TILE_SIZE - camera.x) * camera.zoom, y);
      ctx.stroke();
    }
    for (let col = startCol; col <= endCol; col++) {
      const x = (col * TILE_SIZE - camera.x) * camera.zoom;
      ctx.beginPath();
      ctx.moveTo(x, (startRow * TILE_SIZE - camera.y) * camera.zoom);
      ctx.lineTo(x, (endRow * TILE_SIZE - camera.y) * camera.zoom);
      ctx.stroke();
    }
  }
}

// ──────────────────────────────────────────────
// Render: Facilities (icons on the map)
// ──────────────────────────────────────────────

export function renderFacilities(
  ctx: CanvasRenderingContext2D,
  facilities: Facility[],
  camera: Camera,
): void {
  const tileScreenSize = TILE_SIZE * camera.zoom;

  for (const fac of facilities) {
    const screenX = (fac.position.x * TILE_SIZE - camera.x) * camera.zoom;
    const screenY = (fac.position.y * TILE_SIZE - camera.y) * camera.zoom;

    // Skip if off-screen (with margin)
    if (screenX < -50 || screenY < -50) continue;

    const iconSize = Math.max(12, tileScreenSize * 1.2);
    const cx = screenX + tileScreenSize / 2;
    const cy = screenY + tileScreenSize / 2;

    // Background circle
    const color = FACILITY_COLORS[fac.type] || "#ffffff";
    ctx.beginPath();
    ctx.arc(cx, cy, iconSize / 2, 0, Math.PI * 2);

    // Team border color
    if (fac.team === "player") {
      ctx.fillStyle = "rgba(0,100,255,0.6)";
    } else if (fac.team === "enemy") {
      ctx.fillStyle = "rgba(255,50,50,0.6)";
    } else {
      ctx.fillStyle = "rgba(180,180,180,0.5)";
    }
    ctx.fill();

    // Inner icon
    ctx.beginPath();
    ctx.arc(cx, cy, iconSize / 2 - 2, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.globalAlpha = 0.85;
    ctx.fill();
    ctx.globalAlpha = 1.0;

    // Symbol text
    const symbol = FACILITY_SYMBOLS[fac.type] || "?";
    const fontSize = Math.max(8, iconSize * 0.5);
    ctx.font = `bold ${fontSize}px monospace`;
    ctx.fillStyle = "#000";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(symbol, cx, cy);

    // Label (when zoomed in enough)
    if (camera.zoom >= 0.8) {
      ctx.font = `${Math.max(9, 10 * camera.zoom)}px sans-serif`;
      ctx.fillStyle = "#fff";
      ctx.strokeStyle = "#000";
      ctx.lineWidth = 2;
      ctx.strokeText(fac.name, cx, cy + iconSize / 2 + 8);
      ctx.fillText(fac.name, cx, cy + iconSize / 2 + 8);
    }
  }

  // Reset text alignment
  ctx.textAlign = "start";
  ctx.textBaseline = "alphabetic";
}

// ──────────────────────────────────────────────
// Render: Minimap (bottom-right corner)
// ──────────────────────────────────────────────

export const MINIMAP_WIDTH = 200;
export const MINIMAP_HEIGHT = 150;
export const MINIMAP_PADDING = 10;

export function getMinimapRect(canvasWidth: number, canvasHeight: number) {
  return {
    x: canvasWidth - MINIMAP_WIDTH - MINIMAP_PADDING,
    y: canvasHeight - MINIMAP_HEIGHT - MINIMAP_PADDING,
    w: MINIMAP_WIDTH,
    h: MINIMAP_HEIGHT,
  };
}

export function renderMinimap(
  ctx: CanvasRenderingContext2D,
  terrain: TerrainType[][],
  camera: Camera,
  canvasWidth: number,
  canvasHeight: number,
  facilities?: Facility[],
): void {
  const mm = getMinimapRect(canvasWidth, canvasHeight);

  // Background border
  ctx.fillStyle = "rgba(0,0,0,0.8)";
  ctx.fillRect(mm.x - 2, mm.y - 2, mm.w + 4, mm.h + 4);
  ctx.strokeStyle = "#3a5a7a";
  ctx.lineWidth = 1;
  ctx.strokeRect(mm.x - 2, mm.y - 2, mm.w + 4, mm.h + 4);

  // Cache minimap terrain image
  if (!minimapCache || minimapCacheTerrain !== terrain) {
    minimapCache = buildMinimapCache(terrain, mm.w, mm.h);
    minimapCacheTerrain = terrain;
  }
  ctx.putImageData(minimapCache, mm.x, mm.y);

  // Facility dots on minimap
  if (facilities) {
    const pixelW = mm.w / MAP_WIDTH;
    const pixelH = mm.h / MAP_HEIGHT;

    for (const fac of facilities) {
      const fx = mm.x + fac.position.x * pixelW;
      const fy = mm.y + fac.position.y * pixelH;
      const dotSize = fac.type === "headquarters" ? 3 : 2;

      ctx.beginPath();
      ctx.arc(fx, fy, dotSize, 0, Math.PI * 2);
      if (fac.team === "player") {
        ctx.fillStyle = "#4488ff";
      } else if (fac.team === "enemy") {
        ctx.fillStyle = "#ff4444";
      } else {
        ctx.fillStyle = "#ffffff";
      }
      ctx.fill();
    }
  }

  // Viewport rectangle
  const pixelW = mm.w / MAP_WIDTH;
  const pixelH = mm.h / MAP_HEIGHT;
  const vpX = mm.x + (camera.x / TILE_SIZE) * pixelW;
  const vpY = mm.y + (camera.y / TILE_SIZE) * pixelH;
  const vpW = (canvasWidth / camera.zoom / TILE_SIZE) * pixelW;
  const vpH = (canvasHeight / camera.zoom / TILE_SIZE) * pixelH;

  ctx.strokeStyle = "#ffffff";
  ctx.lineWidth = 1.5;
  ctx.strokeRect(vpX, vpY, vpW, vpH);
}

// ──────────────────────────────────────────────
// Render: Front labels (when zoomed out)
// ──────────────────────────────────────────────

export function renderFrontLabels(
  ctx: CanvasRenderingContext2D,
  fronts: Front[],
  frontPositions: Record<string, { x: number; y: number }>,
  camera: Camera,
): void {
  if (camera.zoom > 0.9) return; // Only show when zoomed out

  ctx.font = "bold 14px sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";

  for (const front of fronts) {
    const pos = frontPositions[front.id];
    if (!pos) continue;

    const screenX = (pos.x * TILE_SIZE - camera.x) * camera.zoom;
    const screenY = (pos.y * TILE_SIZE - camera.y) * camera.zoom;

    // Status color
    let statusColor = "#888888"; // unknown
    if (front.engagementIntensity > 0.6) statusColor = "#ff4444"; // hot
    else if (front.engagementIntensity > 0.2) statusColor = "#ffaa00"; // warm
    else if (front.playerPower > 0) statusColor = "#44cc44"; // held

    // Background
    const labelW = ctx.measureText(front.name).width + 16;
    ctx.fillStyle = "rgba(0,0,0,0.7)";
    ctx.fillRect(screenX - labelW / 2, screenY - 10, labelW, 20);

    // Border
    ctx.strokeStyle = statusColor;
    ctx.lineWidth = 1;
    ctx.strokeRect(screenX - labelW / 2, screenY - 10, labelW, 20);

    // Text
    ctx.fillStyle = statusColor;
    ctx.fillText(front.name, screenX, screenY);
  }

  ctx.textAlign = "start";
  ctx.textBaseline = "alphabetic";
}
