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
  patrol_boat: "P",
  destroyer: "D",
  cruiser: "C",
  carrier: "V",
  fighter: "F",
  bomber: "B",
  recon_plane: "R",
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
  const endCol = Math.min(
    MAP_WIDTH,
    Math.ceil((camera.x + canvasWidth / camera.zoom) / TILE_SIZE),
  );
  const endRow = Math.min(
    MAP_HEIGHT,
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
): void {
  const tileScreenSize = TILE_SIZE * camera.zoom;

  for (const unit of units) {
    if (unit.state === "dead") continue;

    // Enemy units: only render if tile is "visible"
    if (unit.team === "enemy") {
      const tx = Math.floor(unit.position.x);
      const ty = Math.floor(unit.position.y);
      if (tx < 0 || ty < 0 || tx >= MAP_WIDTH || ty >= MAP_HEIGHT) continue;
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

    const unitSize = Math.max(8, tileScreenSize * 0.7);
    const cx = screenX + tileScreenSize / 2;
    const cy = screenY + tileScreenSize / 2;

    // --- Team colors ---
    const isPlayer = unit.team === "player";
    let fillColor = isPlayer
      ? "rgba(40,120,255,0.85)"
      : "rgba(220,50,50,0.85)";
    const borderColor = isPlayer ? "#1a5ab8" : "#a02020";

    // --- Attack flash: briefly brighten unit when it fires ---
    const timeSinceAttack = gameTime - unit.lastAttackTime;
    if (unit.state === "attacking" && timeSinceAttack < 0.12) {
      fillColor = isPlayer
        ? "rgba(120,200,255,1.0)"
        : "rgba(255,150,100,1.0)";
    }

    // --- Draw unit body ---
    ctx.beginPath();
    ctx.arc(cx, cy, unitSize / 2, 0, Math.PI * 2);
    ctx.fillStyle = fillColor;
    ctx.fill();
    ctx.strokeStyle = borderColor;
    ctx.lineWidth = 2;
    ctx.stroke();

    // --- Unit type symbol ---
    const symbol = UNIT_SYMBOLS[unit.type] || "?";
    const fontSize = Math.max(7, unitSize * 0.55);
    ctx.font = `bold ${fontSize}px monospace`;
    ctx.fillStyle = "#fff";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(symbol, cx, cy);

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

  // Visible tile range (same culling as terrain)
  const startCol = Math.max(0, Math.floor(camera.x / TILE_SIZE));
  const startRow = Math.max(0, Math.floor(camera.y / TILE_SIZE));
  const endCol = Math.min(
    MAP_WIDTH,
    Math.ceil((camera.x + canvasWidth / camera.zoom) / TILE_SIZE),
  );
  const endRow = Math.min(
    MAP_HEIGHT,
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
  units?: Unit[],
  fog?: Visibility[][],
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

  const pixelW = mm.w / MAP_WIDTH;
  const pixelH = mm.h / MAP_HEIGHT;

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
        if (tx < 0 || ty < 0 || tx >= MAP_WIDTH || ty >= MAP_HEIGHT) continue;
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
// Render: Combat Effects (attack lines + explosions)
// ──────────────────────────────────────────────

export function renderCombatEffects(
  ctx: CanvasRenderingContext2D,
  effects: CombatEffects,
  camera: Camera,
  gameTime: number,
): void {
  const tileScreenSize = TILE_SIZE * camera.zoom;
  const halfTile = tileScreenSize / 2;

  // --- Attack lines (tracer/projectile) ---
  for (const line of effects.attackLines) {
    const age = gameTime - line.startTime;
    if (age < 0 || age > line.duration) continue;

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
