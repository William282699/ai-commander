// ============================================================
// AI Commander — Canvas Renderer (会丢的，别纠结)
// Renders terrain tiles, units, facilities, fog, minimap.
// ============================================================

import type {
  TerrainType,
  Facility,
  Front,
  Unit,
  Visibility,
  CombatEffects,
  Tag,
  BattleMarker,
} from "@ai-commander/shared";
import { TILE_SIZE, MAP_WIDTH, MAP_HEIGHT } from "@ai-commander/shared";

// --- Terrain colors ---

const TERRAIN_COLORS: Record<TerrainType, string> = {
  plains: "#6b8e23",
  hills: "#556b2f",
  forest: "#2d5016",
  swamp: "#5c6b3a",
  road: "#8b8682",
  shallow_water: "#4a90c4",
  deep_water: "#1e5fa8",
  bridge: "#9e9e9e",
  urban: "#7a7a7a",
  mountain: "#8b7355",
};

// --- Facility icon colors (by type) ---

const FACILITY_COLORS: Record<string, string> = {
  headquarters: "#ff4444",
  barracks: "#ffaa00",
  shipyard: "#00aaff",
  airfield: "#aa66ff",
  radar: "#00ffaa",
  fuel_depot: "#ff8800",
  ammo_depot: "#ff4488",
  comm_tower: "#44ffff",
  rail_hub: "#ccaa00",
  repair_station: "#44ff44",
  defense_tower: "#ff6644",
};

const FACILITY_SYMBOLS: Record<string, string> = {
  headquarters: "HQ",
  barracks: "B",
  shipyard: "S",
  airfield: "A",
  radar: "R",
  fuel_depot: "\u2388", // ⎈ (fuel icon)
  ammo_depot: "\u25C6", // ◆
  comm_tower: "\u2606", // ☆
  rail_hub: "\u2550", // ═
  repair_station: "+",
  defense_tower: "\u25B2", // ▲
};

// --- Unit symbols (short letter per type) ---

const UNIT_SYMBOLS: Record<string, string> = {
  infantry: "I",
  light_tank: "L",
  main_tank: "T",
  artillery: "A",
  commander: "\u2605", // ★
  elite_guard: "E",
  patrol_boat: "P",
  destroyer: "D",
  cruiser: "C",
  carrier: "V",
  fighter: "F",
  bomber: "B",
  recon_plane: "R",
};

// --- MVP2: Shape drawing helpers ---

function drawStar(ctx: CanvasRenderingContext2D, cx: number, cy: number, radius: number, points: number = 5): void {
  ctx.beginPath();
  for (let i = 0; i < points * 2; i++) {
    const r = i % 2 === 0 ? radius : radius * 0.45;
    const angle = (Math.PI * i) / points - Math.PI / 2;
    const x = cx + Math.cos(angle) * r;
    const y = cy + Math.sin(angle) * r;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.closePath();
}

function drawHexagon(ctx: CanvasRenderingContext2D, cx: number, cy: number, radius: number): void {
  ctx.beginPath();
  for (let i = 0; i < 6; i++) {
    const angle = (Math.PI * 2 * i) / 6 - Math.PI / 6;
    const x = cx + Math.cos(angle) * radius;
    const y = cy + Math.sin(angle) * radius;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.closePath();
}

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
  const surface: OffscreenCanvas | HTMLCanvasElement =
    typeof OffscreenCanvas !== "undefined"
      ? new OffscreenCanvas(mmWidth, mmHeight)
      : (() => {
          const canvas = document.createElement("canvas");
          canvas.width = mmWidth;
          canvas.height = mmHeight;
          return canvas;
        })();

  const octx = surface.getContext("2d");
  if (!octx) {
    return new ImageData(mmWidth, mmHeight);
  }

  const terrainH = terrain.length;
  const terrainW = terrain[0]?.length ?? MAP_WIDTH;
  const pixelW = mmWidth / terrainW;
  const pixelH = mmHeight / terrainH;

  for (let row = 0; row < terrainH; row++) {
    for (let col = 0; col < terrainW; col++) {
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

  // Visible tile range (derive bounds from terrain array, not constants)
  const mapCols = terrain[0]?.length ?? MAP_WIDTH;
  const mapRows = terrain.length;
  const startCol = Math.max(0, Math.floor(camera.x / TILE_SIZE));
  const startRow = Math.max(0, Math.floor(camera.y / TILE_SIZE));
  const endCol = Math.min(
    mapCols,
    Math.ceil((camera.x + canvasWidth / camera.zoom) / TILE_SIZE),
  );
  const endRow = Math.min(
    mapRows,
    Math.ceil((camera.y + canvasHeight / camera.zoom) / TILE_SIZE),
  );

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

    // MVP2: HQ health bar (always visible)
    if (fac.type === "headquarters") {
      const hpRatio = fac.hp / fac.maxHp;
      const barWidth = iconSize * 2;
      const barHeight = Math.max(4, iconSize * 0.2);
      const barX = cx - barWidth / 2;
      const barY = cy - iconSize / 2 - barHeight - 4;

      // Background
      ctx.fillStyle = "rgba(0,0,0,0.7)";
      ctx.fillRect(barX, barY, barWidth, barHeight);

      // HP fill (green → yellow → red)
      let hpColor = "#44ff44";
      if (hpRatio < 0.3) hpColor = "#ff4444";
      else if (hpRatio < 0.6) hpColor = "#ffaa00";

      ctx.fillStyle = hpColor;
      ctx.fillRect(barX, barY, barWidth * hpRatio, barHeight);

      // HP text
      if (camera.zoom >= 0.6) {
        const hpText = `HP: ${Math.round(fac.hp)}/${fac.maxHp}`;
        ctx.font = `bold ${Math.max(8, 9 * camera.zoom)}px monospace`;
        ctx.fillStyle = "#fff";
        ctx.textAlign = "center";
        ctx.textBaseline = "bottom";
        ctx.strokeStyle = "#000";
        ctx.lineWidth = 2;
        ctx.strokeText(hpText, cx, barY - 1);
        ctx.fillText(hpText, cx, barY - 1);
      }
    }
  }

  // Reset text alignment
  ctx.textAlign = "start";
  ctx.textBaseline = "alphabetic";
}

// ──────────────────────────────────────────────
// Render: Units (circles with team color + HP bar)
// ──────────────────────────────────────────────

export function renderUnits(
  ctx: CanvasRenderingContext2D,
  units: Unit[],
  fog: Visibility[][],
  camera: Camera,
  canvasWidth: number,
  canvasHeight: number,
  gameTime: number,
  selectedUnitIds?: Set<number>,
): void {
  const tileScreenSize = TILE_SIZE * camera.zoom;

  for (const unit of units) {
    if (unit.state === "dead") continue;

    // Enemy units: only render if tile is "visible"
    if (unit.team === "enemy") {
      const tx = Math.floor(unit.position.x);
      const ty = Math.floor(unit.position.y);
      const fogW = fog[0]?.length ?? MAP_WIDTH;
      const fogH = fog.length;
      if (tx < 0 || ty < 0 || tx >= fogW || ty >= fogH) continue;
      if (fog[ty]?.[tx] !== "visible") continue;
    }

    const screenX = (unit.position.x * TILE_SIZE - camera.x) * camera.zoom;
    const screenY = (unit.position.y * TILE_SIZE - camera.y) * camera.zoom;

    // Cull off-screen units
    if (
      screenX < -40 ||
      screenY < -40 ||
      screenX > canvasWidth + 40 ||
      screenY > canvasHeight + 40
    ) {
      continue;
    }

    // MVP2: commander is 1.5x size
    const baseUnitSize = Math.max(8, tileScreenSize * 0.7);
    const unitSize = unit.type === "commander" ? baseUnitSize * 1.5 : baseUnitSize;
    const cx = screenX + tileScreenSize / 2;
    const cy = screenY + tileScreenSize / 2;

    const isSelected = selectedUnitIds?.has(unit.id) ?? false;

    // --- Selection highlight ring (drawn under unit) ---
    if (isSelected) {
      ctx.beginPath();
      ctx.arc(cx, cy, unitSize / 2 + 3, 0, Math.PI * 2);
      ctx.strokeStyle = "#00ff88";
      ctx.lineWidth = 2.5;
      ctx.stroke();
    }

    // --- Team colors ---
    const isPlayer = unit.team === "player";
    let fillColor: string;
    let borderColor: string;

    if (unit.type === "commander") {
      // Gold star for commander
      fillColor = "#FFD700";
      borderColor = "#B8860B";
    } else if (unit.type === "elite_guard") {
      // White hexagon for elite guard
      fillColor = isPlayer ? "#FFFFFF" : "rgba(255,180,180,0.95)";
      borderColor = isPlayer ? "#888888" : "#a02020";
    } else {
      fillColor = isPlayer
        ? "rgba(40,120,255,0.85)"
        : "rgba(220,50,50,0.85)";
      borderColor = isPlayer ? "#1a5ab8" : "#a02020";
    }

    // --- Attack flash: briefly brighten unit when it fires ---
    const timeSinceAttack = gameTime - unit.lastAttackTime;
    if (unit.state === "attacking" && timeSinceAttack < 0.12) {
      if (unit.type === "commander") {
        fillColor = "#FFEC80";
      } else if (unit.type === "elite_guard") {
        fillColor = "#FFFFAA";
      } else {
        fillColor = isPlayer
          ? "rgba(120,200,255,1.0)"
          : "rgba(255,150,100,1.0)";
      }
    }

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

    // --- Entrench visual (trench arcs around infantry) ---
    const entrench = unit.entrenchLevel ?? 0;
    if (entrench > 0) {
      ctx.save();
      const trenchRadius = unitSize * 0.75;
      if (entrench >= 2) {
        // Deep trench: double arc + sandbag dots
        ctx.strokeStyle = "#8B7355";
        ctx.lineWidth = Math.max(2, unitSize * 0.15);
        ctx.beginPath();
        ctx.arc(cx, cy, trenchRadius, Math.PI * 0.15, Math.PI * 0.85);
        ctx.stroke();
        ctx.beginPath();
        ctx.arc(cx, cy, trenchRadius + 2, Math.PI * 0.2, Math.PI * 0.8);
        ctx.stroke();
        // Sandbag dots
        ctx.fillStyle = "#A0916A";
        for (let a = 0.25; a <= 0.75; a += 0.1) {
          const sx = cx + Math.cos(Math.PI * a) * (trenchRadius + 4);
          const sy = cy + Math.sin(Math.PI * a) * (trenchRadius + 4);
          ctx.beginPath();
          ctx.arc(sx, sy, Math.max(1, unitSize * 0.06), 0, Math.PI * 2);
          ctx.fill();
        }
      } else {
        // Shallow trench: single arc
        ctx.strokeStyle = "#A09070";
        ctx.lineWidth = Math.max(1.5, unitSize * 0.1);
        ctx.beginPath();
        ctx.arc(cx, cy, trenchRadius, Math.PI * 0.2, Math.PI * 0.8);
        ctx.stroke();
      }
      ctx.restore();
    }

    // --- Unit type symbol ---
    const symbol = UNIT_SYMBOLS[unit.type] || "?";
    const fontSize = Math.max(7, unitSize * 0.55);
    ctx.font = `bold ${fontSize}px monospace`;
    ctx.fillStyle = "#fff";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(symbol, cx, cy);

    // --- Manual override indicator ---
    if (unit.manualOverride && isPlayer) {
      const indicatorSize = Math.max(8, unitSize * 0.45);
      const ix = cx + unitSize / 2 - 1;
      const iy = cy - unitSize / 2 - 1;

      // Yellow diamond background
      ctx.save();
      ctx.fillStyle = "#ffcc00";
      ctx.strokeStyle = "#000";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(ix, iy - indicatorSize / 2);
      ctx.lineTo(ix + indicatorSize / 2, iy);
      ctx.lineTo(ix, iy + indicatorSize / 2);
      ctx.lineTo(ix - indicatorSize / 2, iy);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();

      // "M" label
      ctx.font = `bold ${Math.max(6, indicatorSize * 0.6)}px monospace`;
      ctx.fillStyle = "#000";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText("M", ix, iy);
      ctx.restore();
    }

    // --- Health bar ---
    const hpRatio = unit.hp / unit.maxHp;
    if (hpRatio < 1.0) {
      // Only show HP bar if damaged
      const barWidth = unitSize * 1.2;
      const barHeight = Math.max(2, unitSize * 0.14);
      const barX = cx - barWidth / 2;
      const barY = cy - unitSize / 2 - barHeight - 2;

      // Background
      ctx.fillStyle = "rgba(0,0,0,0.6)";
      ctx.fillRect(barX, barY, barWidth, barHeight);

      // HP fill (green → yellow → red)
      let hpColor = "#44ff44";
      if (hpRatio < 0.3) hpColor = "#ff4444";
      else if (hpRatio < 0.6) hpColor = "#ffaa00";

      ctx.fillStyle = hpColor;
      ctx.fillRect(barX, barY, barWidth * hpRatio, barHeight);
    }
  }

  ctx.textAlign = "start";
  ctx.textBaseline = "alphabetic";
}

// ──────────────────────────────────────────────
// Render: Fog of War overlay
// ──────────────────────────────────────────────

export function renderFog(
  ctx: CanvasRenderingContext2D,
  fog: Visibility[][],
  camera: Camera,
  canvasWidth: number,
  canvasHeight: number,
): void {
  const tileScreenSize = TILE_SIZE * camera.zoom;

  // Visible tile range (derive bounds from fog array)
  const fogCols = fog[0]?.length ?? MAP_WIDTH;
  const fogRows = fog.length;
  const startCol = Math.max(0, Math.floor(camera.x / TILE_SIZE));
  const startRow = Math.max(0, Math.floor(camera.y / TILE_SIZE));
  const endCol = Math.min(
    fogCols,
    Math.ceil((camera.x + canvasWidth / camera.zoom) / TILE_SIZE),
  );
  const endRow = Math.min(
    fogRows,
    Math.ceil((camera.y + canvasHeight / camera.zoom) / TILE_SIZE),
  );

  // Pass 1: explored (semi-transparent dim)
  ctx.fillStyle = "rgba(8,8,18,0.5)";
  for (let row = startRow; row < endRow; row++) {
    for (let col = startCol; col < endCol; col++) {
      if (fog[row]?.[col] === "explored") {
        const sx = (col * TILE_SIZE - camera.x) * camera.zoom;
        const sy = (row * TILE_SIZE - camera.y) * camera.zoom;
        ctx.fillRect(sx, sy, tileScreenSize + 0.5, tileScreenSize + 0.5);
      }
    }
  }

  // Pass 2: unknown (nearly opaque black)
  ctx.fillStyle = "rgba(8,8,18,0.92)";
  for (let row = startRow; row < endRow; row++) {
    for (let col = startCol; col < endCol; col++) {
      if (fog[row]?.[col] === "unknown") {
        const sx = (col * TILE_SIZE - camera.x) * camera.zoom;
        const sy = (row * TILE_SIZE - camera.y) * camera.zoom;
        ctx.fillRect(sx, sy, tileScreenSize + 0.5, tileScreenSize + 0.5);
      }
    }
  }
}

// ──────────────────────────────────────────────
// Render: Minimap (bottom-right corner)
// ──────────────────────────────────────────────

export const MINIMAP_MAX_WIDTH = 200;
export const MINIMAP_PADDING = 10;

export function getMinimapRect(canvasWidth: number, canvasHeight: number, mapW: number = MAP_WIDTH, mapH: number = MAP_HEIGHT) {
  // Scale minimap to fit within max width while preserving aspect ratio
  const aspect = mapH / mapW;
  const w = MINIMAP_MAX_WIDTH;
  const h = Math.round(w * aspect);
  return {
    x: canvasWidth - w - MINIMAP_PADDING,
    y: canvasHeight - h - MINIMAP_PADDING,
    w,
    h,
  };
}

export function renderMinimap(
  ctx: CanvasRenderingContext2D,
  terrain: TerrainType[][],
  camera: Camera,
  canvasWidth: number,
  canvasHeight: number,
  facilities?: Facility[],
  units?: Unit[],
  fog?: Visibility[][],
  mapW: number = MAP_WIDTH,
  mapH: number = MAP_HEIGHT,
): void {
  const mm = getMinimapRect(canvasWidth, canvasHeight, mapW, mapH);

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

  const pixelW = mm.w / mapW;
  const pixelH = mm.h / mapH;

  // Facility dots on minimap
  if (facilities) {
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

  // Unit dots on minimap
  if (units) {
    for (const unit of units) {
      if (unit.state === "dead") continue;

      // Enemy units: only show if in visible fog
      if (unit.team === "enemy" && fog) {
        const tx = Math.floor(unit.position.x);
        const ty = Math.floor(unit.position.y);
        if (tx < 0 || ty < 0 || tx >= mapW || ty >= mapH) continue;
        if (fog[ty]?.[tx] !== "visible") continue;
      }

      const ux = mm.x + unit.position.x * pixelW;
      const uy = mm.y + unit.position.y * pixelH;

      ctx.beginPath();
      ctx.arc(ux, uy, 1.5, 0, Math.PI * 2);
      ctx.fillStyle = unit.team === "player" ? "#4488ff" : "#ff4444";
      ctx.fill();
    }
  }

  // Viewport rectangle
  const vpX = mm.x + (camera.x / TILE_SIZE) * pixelW;
  const vpY = mm.y + (camera.y / TILE_SIZE) * pixelH;
  const vpW = ((canvasWidth / camera.zoom) / TILE_SIZE) * pixelW;
  const vpH = ((canvasHeight / camera.zoom) / TILE_SIZE) * pixelH;

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

// ──────────────────────────────────────────────
// Render: Route name labels (drawn along roads)
// ──────────────────────────────────────────────

export function renderRouteLabels(
  ctx: CanvasRenderingContext2D,
  routes: { id: string; name: string; waypoints: { x: number; y: number }[] }[],
  camera: Camera,
): void {
  if (camera.zoom > 1.2) return; // hide when zoomed in too much (cluttered)

  const fontSize = Math.max(9, 11 * camera.zoom);
  ctx.font = `bold ${fontSize}px sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";

  for (const route of routes) {
    const wps = route.waypoints;
    if (wps.length < 2) continue;

    // Place label at the midpoint waypoint
    const midIdx = Math.floor(wps.length / 2);
    const wp = wps[midIdx];
    const screenX = (wp.x * TILE_SIZE - camera.x) * camera.zoom;
    const screenY = (wp.y * TILE_SIZE - camera.y) * camera.zoom;

    // Compute angle from adjacent waypoints for text rotation
    const prev = wps[Math.max(0, midIdx - 1)];
    const next = wps[Math.min(wps.length - 1, midIdx + 1)];
    let angle = Math.atan2((next.y - prev.y), (next.x - prev.x));
    // Keep text upright: flip if angle would render text upside-down
    if (angle > Math.PI / 2) angle -= Math.PI;
    if (angle < -Math.PI / 2) angle += Math.PI;

    ctx.save();
    ctx.translate(screenX, screenY);
    ctx.rotate(angle);

    // Background pill
    const textW = ctx.measureText(route.name).width + 12;
    ctx.fillStyle = "rgba(0,0,0,0.6)";
    const pillH = fontSize + 6;
    ctx.beginPath();
    const pillR = pillH / 2;
    ctx.roundRect(-textW / 2, -pillH / 2, textW, pillH, pillR);
    ctx.fill();

    // Text
    ctx.fillStyle = "#ddd";
    ctx.fillText(route.name, 0, 0);

    ctx.restore();
  }

  ctx.textAlign = "start";
  ctx.textBaseline = "alphabetic";
}

// ──────────────────────────────────────────────
// Render: Region labels (geographic area names on the map)
// ──────────────────────────────────────────────

export function renderRegionLabels(
  ctx: CanvasRenderingContext2D,
  regions: { id: string; name: string; bbox: [number, number, number, number] }[],
  camera: Camera,
): void {
  if (camera.zoom > 0.9) return; // only show when zoomed out enough

  const fontSize = Math.max(10, 12 * camera.zoom);
  ctx.font = `italic ${fontSize}px sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.globalAlpha = 0.5;

  for (const region of regions) {
    const [x1, y1, x2, y2] = region.bbox;
    const cx = ((x1 + x2) / 2) * TILE_SIZE;
    const cy = ((y1 + y2) / 2) * TILE_SIZE;
    const screenX = (cx - camera.x) * camera.zoom;
    const screenY = (cy - camera.y) * camera.zoom;

    // Skip off-screen
    if (screenX < -100 || screenY < -100 || screenX > ctx.canvas.width + 100 || screenY > ctx.canvas.height + 100) continue;

    ctx.fillStyle = "#c8c0b0";
    ctx.fillText(region.name, screenX, screenY);
  }

  ctx.globalAlpha = 1.0;
  ctx.textAlign = "start";
  ctx.textBaseline = "alphabetic";
}

// ──────────────────────────────────────────────
// Render: Selection box (green rectangle while dragging)
// ──────────────────────────────────────────────

export function renderSelectionBox(
  ctx: CanvasRenderingContext2D,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
): void {
  const left = Math.min(x1, x2);
  const top = Math.min(y1, y2);
  const w = Math.abs(x2 - x1);
  const h = Math.abs(y2 - y1);

  ctx.save();
  ctx.fillStyle = "rgba(0,255,136,0.12)";
  ctx.fillRect(left, top, w, h);
  ctx.strokeStyle = "#00ff88";
  ctx.lineWidth = 1.5;
  ctx.setLineDash([6, 3]);
  ctx.strokeRect(left, top, w, h);
  ctx.setLineDash([]);
  ctx.restore();
}

// ──────────────────────────────────────────────
// Render: Selected unit info panel (top-left)
// ──────────────────────────────────────────────

// Squad color hash — stable color per squadId
function squadColor(squadId: string): string {
  let h = 0;
  for (let i = 0; i < squadId.length; i++) {
    h = (h * 31 + squadId.charCodeAt(i)) | 0;
  }
  const hue = ((h & 0x7fffffff) % 360);
  return `hsl(${hue}, 65%, 55%)`;
}

export interface SelectedSquadInfo {
  squadId: string;
  count: number;
}

export function renderInfoPanel(
  ctx: CanvasRenderingContext2D,
  selectedUnits: Unit[],
  canvasWidth: number,
  canvasHeight: number,
  selectedSquads?: SelectedSquadInfo[],
): { returnToAIBtnRect: { x: number; y: number; w: number; h: number } | null } {
  if (selectedUnits.length === 0) return { returnToAIBtnRect: null };

  const panelW = 220;
  const lineH = 16;
  const padding = 10;
  const maxLines = 8;

  // Count types
  const typeCounts = new Map<string, number>();
  let totalHp = 0;
  let totalMaxHp = 0;
  let manualCount = 0;

  for (const u of selectedUnits) {
    typeCounts.set(u.type, (typeCounts.get(u.type) ?? 0) + 1);
    totalHp += u.hp;
    totalMaxHp += u.maxHp;
    if (u.manualOverride) manualCount++;
  }

  // Build info lines
  const lines: string[] = [];
  lines.push(`Selected: ${selectedUnits.length} unit${selectedUnits.length > 1 ? "s" : ""}`);
  for (const [type, count] of typeCounts) {
    const label = (UNIT_LABELS as Record<string, string>)[type] ?? type;
    lines.push(`  ${label}: ${count}`);
  }
  const hpPct = Math.round((totalHp / totalMaxHp) * 100);
  lines.push(`HP: ${Math.round(totalHp)}/${Math.round(totalMaxHp)} (${hpPct}%)`);
  if (manualCount > 0) {
    lines.push(`Manual: ${manualCount} unit${manualCount > 1 ? "s" : ""}`);
  }

  // Squad lines (max 4, then +N more)
  const squadLines: { text: string; color: string }[] = [];
  if (selectedSquads && selectedSquads.length > 0) {
    const maxSquadLines = 4;
    const shown = selectedSquads.slice(0, maxSquadLines);
    for (const sq of shown) {
      squadLines.push({ text: `  ${sq.squadId} ×${sq.count}`, color: squadColor(sq.squadId) });
    }
    if (selectedSquads.length > maxSquadLines) {
      squadLines.push({ text: `  +${selectedSquads.length - maxSquadLines} more`, color: "#64748b" });
    }
  }

  const totalTextLines = Math.min(lines.length, maxLines) + (squadLines.length > 0 ? 1 + squadLines.length : 0);
  const panelH = totalTextLines * lineH + padding * 2 + 28; // extra for button

  const px = 10;
  const py = 10;

  // Background
  ctx.save();
  ctx.fillStyle = "rgba(10,15,30,0.85)";
  ctx.fillRect(px, py, panelW, panelH);
  ctx.strokeStyle = "#3a5a8a";
  ctx.lineWidth = 1;
  ctx.strokeRect(px, py, panelW, panelH);

  // Text lines
  ctx.font = "12px monospace";
  ctx.fillStyle = "#c0d0e0";
  ctx.textAlign = "left";
  ctx.textBaseline = "top";

  const visibleLines = lines.slice(0, maxLines);
  let lineIdx = 0;
  for (let i = 0; i < visibleLines.length; i++) {
    ctx.fillText(visibleLines[i], px + padding, py + padding + lineIdx * lineH);
    lineIdx++;
  }

  // Squad section
  if (squadLines.length > 0) {
    ctx.fillStyle = "#94a3b8";
    ctx.fillText("Squads:", px + padding, py + padding + lineIdx * lineH);
    lineIdx++;
    for (const sq of squadLines) {
      // Color swatch
      ctx.fillStyle = sq.color;
      ctx.fillRect(px + padding, py + padding + lineIdx * lineH + 3, 8, 10);
      // Text
      ctx.fillStyle = "#c0d0e0";
      ctx.fillText(sq.text, px + padding + 12, py + padding + lineIdx * lineH);
      lineIdx++;
    }
  }

  // "Return to AI" button (always shown when units are selected)
  const btnW = panelW - padding * 2;
  const btnH = 20;
  const btnX = px + padding;
  const btnY = py + panelH - btnH - padding + 2;

  ctx.fillStyle = manualCount > 0 ? "#cc8800" : "#555555";
  ctx.fillRect(btnX, btnY, btnW, btnH);
  ctx.strokeStyle = "#ffcc00";
  ctx.lineWidth = 1;
  ctx.strokeRect(btnX, btnY, btnW, btnH);

  ctx.font = "bold 11px monospace";
  ctx.fillStyle = "#fff";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(
    manualCount > 0 ? "[ESC] Return to AI" : "[ESC] Deselect",
    btnX + btnW / 2,
    btnY + btnH / 2,
  );

  ctx.restore();
  ctx.textAlign = "start";
  ctx.textBaseline = "alphabetic";

  return { returnToAIBtnRect: { x: btnX, y: btnY, w: btnW, h: btnH } };
}

const UNIT_LABELS: Record<string, string> = {
  infantry: "Infantry",
  light_tank: "Light Tank",
  main_tank: "Main Tank",
  artillery: "Artillery",
  patrol_boat: "Patrol Boat",
  destroyer: "Destroyer",
  cruiser: "Cruiser",
  carrier: "Carrier",
  fighter: "Fighter",
  bomber: "Bomber",
  recon_plane: "Recon",
};

// ──────────────────────────────────────────────
// Render: Combat Effects (attack lines + explosions)
// ──────────────────────────────────────────────

export function renderCombatEffects(
  ctx: CanvasRenderingContext2D,
  effects: CombatEffects,
  camera: Camera,
  fog: Visibility[][],
  gameTime: number,
): void {
  const tileScreenSize = TILE_SIZE * camera.zoom;
  const halfTile = tileScreenSize / 2;

  const fogW = fog[0]?.length ?? MAP_WIDTH;
  const fogH = fog.length;
  const isVisibleTile = (x: number, y: number): boolean => {
    const tx = Math.floor(x);
    const ty = Math.floor(y);
    if (tx < 0 || tx >= fogW || ty < 0 || ty >= fogH) return false;
    return fog[ty]?.[tx] === "visible";
  };

  // --- Attack lines (tracer/projectile) ---
  for (const line of effects.attackLines) {
    const age = gameTime - line.startTime;
    if (age < 0 || age > line.duration) continue;
    if (!isVisibleTile(line.fromX, line.fromY) && !isVisibleTile(line.toX, line.toY)) {
      continue;
    }

    const alpha = 1.0 - age / line.duration; // fade out

    const x1 = (line.fromX * TILE_SIZE - camera.x) * camera.zoom + halfTile;
    const y1 = (line.fromY * TILE_SIZE - camera.y) * camera.zoom + halfTile;
    const x2 = (line.toX * TILE_SIZE - camera.x) * camera.zoom + halfTile;
    const y2 = (line.toY * TILE_SIZE - camera.y) * camera.zoom + halfTile;

    ctx.save();
    ctx.globalAlpha = alpha * 0.8;
    ctx.strokeStyle = line.color;
    ctx.lineWidth = Math.max(1, 2 * camera.zoom);
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    ctx.stroke();

    // Impact dot at target
    ctx.beginPath();
    ctx.arc(x2, y2, Math.max(2, 3 * camera.zoom), 0, Math.PI * 2);
    ctx.fillStyle = "#ffffff";
    ctx.globalAlpha = alpha;
    ctx.fill();
    ctx.restore();
  }

  // --- Explosions ---
  for (const exp of effects.explosions) {
    const age = gameTime - exp.startTime;
    if (age < 0 || age > exp.duration) continue;
    if (!isVisibleTile(exp.x, exp.y)) continue;

    const progress = age / exp.duration; // 0→1
    const currentRadius = exp.radius * TILE_SIZE * camera.zoom * progress;
    const alpha = 1.0 - progress;

    const sx = (exp.x * TILE_SIZE - camera.x) * camera.zoom + halfTile;
    const sy = (exp.y * TILE_SIZE - camera.y) * camera.zoom + halfTile;

    ctx.save();

    // Outer fireball
    ctx.beginPath();
    ctx.arc(sx, sy, currentRadius, 0, Math.PI * 2);
    ctx.fillStyle = `rgba(255,120,20,${alpha * 0.6})`;
    ctx.fill();

    // Inner core
    ctx.beginPath();
    ctx.arc(sx, sy, currentRadius * 0.5, 0, Math.PI * 2);
    ctx.fillStyle = `rgba(255,255,100,${alpha * 0.8})`;
    ctx.fill();

    // Bright center flash (first 30% of animation)
    if (progress < 0.3) {
      ctx.beginPath();
      ctx.arc(sx, sy, currentRadius * 0.2, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(255,255,255,${alpha})`;
      ctx.fill();
    }

    ctx.restore();
  }
}

// ──────────────────────────────────────────────
// Render: Battle Markers (Prompt 5: attack zones, deaths, critical fronts)
// ──────────────────────────────────────────────

export function drawBattleMarkers(
  ctx: CanvasRenderingContext2D,
  markers: BattleMarker[],
  camera: Camera,
  fog: Visibility[][],
  currentTime: number,
): void {
  const tileScreenSize = TILE_SIZE * camera.zoom;
  const halfTile = tileScreenSize / 2;

  const bmFogW = fog[0]?.length ?? MAP_WIDTH;
  const bmFogH = fog.length;
  const isVisibleTile = (x: number, y: number): boolean => {
    const tx = Math.floor(x);
    const ty = Math.floor(y);
    if (tx < 0 || tx >= bmFogW || ty < 0 || ty >= bmFogH) return false;
    return fog[ty]?.[tx] === "visible";
  };

  // Viewport culling bounds (world coords)
  const viewLeft = camera.x / TILE_SIZE - 1;
  const viewTop = camera.y / TILE_SIZE - 1;
  const viewRight = viewLeft + (ctx.canvas.width / camera.zoom) / TILE_SIZE + 2;
  const viewBottom = viewTop + (ctx.canvas.height / camera.zoom) / TILE_SIZE + 2;

  for (const m of markers) {
    // Viewport culling
    if (m.x < viewLeft || m.x > viewRight || m.y < viewTop || m.y > viewBottom) continue;
    // Fog check
    if (!isVisibleTile(m.x, m.y)) continue;
    if (m.opacity <= 0) continue;

    const sx = (m.x * TILE_SIZE - camera.x) * camera.zoom + halfTile;
    const sy = (m.y * TILE_SIZE - camera.y) * camera.zoom + halfTile;

    ctx.save();

    if (m.type === "death") {
      // Red × mark, fading out
      const size = Math.max(4, 6 * camera.zoom);
      ctx.globalAlpha = m.opacity * 0.8;
      ctx.strokeStyle = "#ff3333";
      ctx.lineWidth = Math.max(1.5, 2 * camera.zoom);
      ctx.lineCap = "round";
      ctx.beginPath();
      ctx.moveTo(sx - size, sy - size);
      ctx.lineTo(sx + size, sy + size);
      ctx.moveTo(sx + size, sy - size);
      ctx.lineTo(sx - size, sy + size);
      ctx.stroke();
    } else if (m.type === "attack_zone") {
      // Red pulsing translucent circle
      const baseRadius = (m.radius ?? 5) * tileScreenSize;
      const pulse = 1 + 0.1 * Math.sin(m.pulsePhase);
      const r = baseRadius * pulse;
      ctx.globalAlpha = m.opacity * 0.25;
      ctx.fillStyle = "#ff2200";
      ctx.beginPath();
      ctx.arc(sx, sy, r, 0, Math.PI * 2);
      ctx.fill();
      // Outline ring
      ctx.globalAlpha = m.opacity * 0.5;
      ctx.strokeStyle = "#ff4400";
      ctx.lineWidth = Math.max(1, 2 * camera.zoom);
      ctx.stroke();
    } else if (m.type === "critical_front") {
      // Breathing red highlight overlay
      const baseRadius = (m.radius ?? 6) * tileScreenSize;
      const breath = 0.5 + 0.5 * Math.sin(m.pulsePhase * 0.8);
      ctx.globalAlpha = m.opacity * 0.2 * breath;
      ctx.fillStyle = "#ff0000";
      ctx.beginPath();
      ctx.arc(sx, sy, baseRadius, 0, Math.PI * 2);
      ctx.fill();
      // Inner brighter ring
      ctx.globalAlpha = m.opacity * 0.4 * breath;
      ctx.strokeStyle = "#ff3300";
      ctx.lineWidth = Math.max(2, 3 * camera.zoom);
      ctx.setLineDash([8, 4]);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    ctx.restore();
  }
}

// ──────────────────────────────────────────────
// Render: Tags (player map markers, Day 15)
// ──────────────────────────────────────────────

export function renderTags(
  ctx: CanvasRenderingContext2D,
  tags: Tag[],
  camera: Camera,
  tagMode: boolean,
  mouseX: number,
  mouseY: number,
): void {
  for (const tag of tags) {
    const screenX = (tag.position.x * TILE_SIZE - camera.x) * camera.zoom;
    const screenY = (tag.position.y * TILE_SIZE - camera.y) * camera.zoom;

    drawFlag(ctx, screenX, screenY, camera.zoom, tag.name, 1.0);
  }

  // Tag mode preview: semi-transparent flag at cursor
  if (tagMode && mouseX >= 0 && mouseY >= 0) {
    drawFlag(ctx, mouseX, mouseY, camera.zoom, "?", 0.4);
  }
}

function drawFlag(
  ctx: CanvasRenderingContext2D,
  screenX: number,
  screenY: number,
  zoom: number,
  label: string,
  alpha: number,
): void {
  ctx.save();
  ctx.globalAlpha = alpha;

  const poleH = Math.max(16, 24 * zoom);
  const flagW = Math.max(10, 14 * zoom);
  const flagH = Math.max(8, 10 * zoom);

  // Pole
  ctx.strokeStyle = "#f59e0b";
  ctx.lineWidth = Math.max(1.5, 2 * zoom);
  ctx.beginPath();
  ctx.moveTo(screenX, screenY);
  ctx.lineTo(screenX, screenY - poleH);
  ctx.stroke();

  // Triangular flag
  ctx.fillStyle = "#f59e0b";
  ctx.beginPath();
  ctx.moveTo(screenX, screenY - poleH);
  ctx.lineTo(screenX + flagW, screenY - poleH + flagH / 2);
  ctx.lineTo(screenX, screenY - poleH + flagH);
  ctx.closePath();
  ctx.fill();

  // Label text
  const fontSize = Math.max(9, 11 * zoom);
  ctx.font = `bold ${fontSize}px monospace`;
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  ctx.strokeStyle = "#000";
  ctx.lineWidth = 2.5;
  ctx.strokeText(label, screenX + flagW + 3, screenY - poleH + flagH / 2);
  ctx.fillStyle = "#fff";
  ctx.fillText(label, screenX + flagW + 3, screenY - poleH + flagH / 2);

  ctx.restore();
  ctx.textAlign = "start";
  ctx.textBaseline = "alphabetic";
}
