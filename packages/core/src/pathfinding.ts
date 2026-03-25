// ============================================================
// A* Pathfinding — tile-based shortest path with terrain awareness
//
// Design principles:
//   1. Works for any map size (200×150 or 500×300+)
//   2. Respects per-unit-type terrain passability
//   3. Returns waypoints in tile coordinates
//   4. Cached per unit — path recalculated only when target changes
//   5. Max search budget to prevent frame drops
// ============================================================

import type { GameState, UnitType, Position } from "@ai-commander/shared";
import { canUnitEnterTile } from "./sim";

/** Maximum nodes to expand before giving up (prevents frame stalls).
 *  500×300 map with large obstacles (minefields) needs ~8000-12000 to route around.
 *  This runs once per unit when target changes, not every frame (cached). */
const MAX_EXPANSIONS = 15000;

/** 8-directional neighbors: [dx, dy, cost] — diagonals cost √2 */
const NEIGHBORS: [number, number, number][] = [
  [1, 0, 1], [-1, 0, 1], [0, 1, 1], [0, -1, 1],
  [1, 1, 1.414], [-1, 1, 1.414], [1, -1, 1.414], [-1, -1, 1.414],
];

interface PathNode {
  x: number;
  y: number;
  g: number;      // cost from start
  f: number;      // g + heuristic
  parentKey: string | null;
}

/**
 * A* pathfinding from start tile to goal tile.
 * Returns an array of tile-center positions [{x, y}, ...] or null if no path.
 * The returned path does NOT include the start position.
 */
export function findPath(
  startX: number,
  startY: number,
  goalX: number,
  goalY: number,
  unitType: UnitType,
  state: GameState,
): Position[] | null {
  const sx = Math.floor(startX);
  const sy = Math.floor(startY);
  const gx = Math.floor(goalX);
  const gy = Math.floor(goalY);

  // Trivial: already at goal
  if (sx === gx && sy === gy) return [{ x: goalX, y: goalY }];

  // If goal tile is impassable, find nearest passable tile around it
  let finalGx = gx;
  let finalGy = gy;
  if (!canUnitEnterTile(unitType, gx, gy, state)) {
    const alt = findNearestPassable(gx, gy, unitType, state, 8);
    if (!alt) return null; // completely surrounded by impassable
    finalGx = alt.x;
    finalGy = alt.y;
  }

  // Binary heap (min-heap by f-score) for open set
  const open: PathNode[] = [];
  const closed = new Set<string>();
  const nodeMap = new Map<string, PathNode>();

  const startKey = `${sx},${sy}`;
  const h0 = heuristic(sx, sy, finalGx, finalGy);
  const startNode: PathNode = { x: sx, y: sy, g: 0, f: h0, parentKey: null };
  open.push(startNode);
  nodeMap.set(startKey, startNode);

  let expansions = 0;

  while (open.length > 0) {
    // Pop lowest f-score (simple linear scan — fast enough for our budget)
    let bestIdx = 0;
    for (let i = 1; i < open.length; i++) {
      if (open[i].f < open[bestIdx].f) bestIdx = i;
    }
    const current = open[bestIdx];
    open[bestIdx] = open[open.length - 1];
    open.pop();

    const cx = current.x;
    const cy = current.y;
    const currentKey = `${cx},${cy}`;

    if (closed.has(currentKey)) continue;
    closed.add(currentKey);

    // Goal reached
    if (cx === finalGx && cy === finalGy) {
      return reconstructPath(current, nodeMap, goalX, goalY);
    }

    if (++expansions > MAX_EXPANSIONS) {
      // Budget exhausted — return null (unreachable within budget).
      // Returning a partial path causes oscillation: unit walks to end of
      // partial path, recalculates, gets slightly different partial path, repeats.
      return null;
    }

    // Expand neighbors
    for (const [dx, dy, cost] of NEIGHBORS) {
      const nx = cx + dx;
      const ny = cy + dy;
      const nKey = `${nx},${ny}`;

      if (closed.has(nKey)) continue;
      if (!canUnitEnterTile(unitType, nx, ny, state)) continue;

      // Diagonal movement: both adjacent axis tiles must also be passable
      // (prevents cutting corners through walls)
      if (dx !== 0 && dy !== 0) {
        if (!canUnitEnterTile(unitType, cx + dx, cy, state) ||
            !canUnitEnterTile(unitType, cx, cy + dy, state)) {
          continue;
        }
      }

      const tentativeG = current.g + cost;
      const existing = nodeMap.get(nKey);

      if (!existing || tentativeG < existing.g) {
        const h = heuristic(nx, ny, finalGx, finalGy);
        const node: PathNode = { x: nx, y: ny, g: tentativeG, f: tentativeG + h, parentKey: currentKey };
        nodeMap.set(nKey, node);
        open.push(node);
      }
    }
  }

  return null; // No path found
}

/** Octile distance heuristic (admissible for 8-directional movement) */
function heuristic(x1: number, y1: number, x2: number, y2: number): number {
  const dx = Math.abs(x1 - x2);
  const dy = Math.abs(y1 - y2);
  return Math.max(dx, dy) + 0.414 * Math.min(dx, dy);
}

/** Reconstruct path from goal node back to start, return as Position[] */
function reconstructPath(
  goalNode: PathNode,
  nodeMap: Map<string, PathNode>,
  finalX: number,
  finalY: number,
): Position[] {
  const raw: Position[] = [];
  let node: PathNode | undefined = goalNode;
  while (node && node.parentKey !== null) {
    raw.push({ x: node.x + 0.5, y: node.y + 0.5 }); // tile center
    node = nodeMap.get(node.parentKey);
  }
  raw.reverse();

  // Simplify: remove collinear intermediate points (keep only turns)
  const simplified = simplifyPath(raw);

  // Replace last point with exact target position
  if (simplified.length > 0) {
    simplified[simplified.length - 1] = { x: finalX, y: finalY };
  }

  return simplified;
}

/** Remove collinear points — keep only where direction changes */
function simplifyPath(path: Position[]): Position[] {
  if (path.length <= 2) return [...path];

  const result: Position[] = [path[0]];
  for (let i = 1; i < path.length - 1; i++) {
    const prev = path[i - 1];
    const curr = path[i];
    const next = path[i + 1];
    const dx1 = Math.sign(curr.x - prev.x);
    const dy1 = Math.sign(curr.y - prev.y);
    const dx2 = Math.sign(next.x - curr.x);
    const dy2 = Math.sign(next.y - curr.y);
    if (dx1 !== dx2 || dy1 !== dy2) {
      result.push(curr);
    }
  }
  result.push(path[path.length - 1]);
  return result;
}

/** Spiral search for nearest passable tile around a target */
function findNearestPassable(
  cx: number, cy: number,
  unitType: UnitType,
  state: GameState,
  maxRadius: number,
): { x: number; y: number } | null {
  for (let r = 1; r <= maxRadius; r++) {
    for (let dx = -r; dx <= r; dx++) {
      for (let dy = -r; dy <= r; dy++) {
        if (Math.abs(dx) !== r && Math.abs(dy) !== r) continue; // only perimeter
        if (canUnitEnterTile(unitType, cx + dx, cy + dy, state)) {
          return { x: cx + dx, y: cy + dy };
        }
      }
    }
  }
  return null;
}

// ── Path cache (per unit) ─────────────────────────────────

const pathCache = new Map<number, { goalX: number; goalY: number; path: Position[] }>();

/**
 * Group path cache — keyed by "unitType:goalTileX,goalTileY".
 * When multiple units of the same type go to the same target, the first one
 * computes A* and all others reuse the same path. This prevents squad members
 * from taking different routes around obstacles.
 * Expires after 2 seconds (cleared by age check).
 */
const groupPathCache = new Map<string, { path: Position[]; timestamp: number }>();
const GROUP_CACHE_TTL = 2000; // ms

function getGroupCacheKey(unitType: UnitType, goalX: number, goalY: number): string {
  return `${unitType}:${Math.floor(goalX)},${Math.floor(goalY)}`;
}

/**
 * Get a cached A* path for a unit, or compute a new one.
 * Uses group cache so same-type units going to the same target share one path.
 */
export function getOrComputePath(
  unitId: number,
  startX: number,
  startY: number,
  goalX: number,
  goalY: number,
  unitType: UnitType,
  state: GameState,
): Position[] | null {
  const cached = pathCache.get(unitId);
  const cgx = Math.floor(goalX);
  const cgy = Math.floor(goalY);

  if (cached && Math.floor(cached.goalX) === cgx && Math.floor(cached.goalY) === cgy && cached.path.length > 0) {
    return cached.path;
  }

  // Check group cache — another unit of same type already computed this route
  const groupKey = getGroupCacheKey(unitType, goalX, goalY);
  const groupCached = groupPathCache.get(groupKey);
  const now = Date.now();
  if (groupCached && (now - groupCached.timestamp) < GROUP_CACHE_TTL && groupCached.path.length > 0) {
    const sharedPath = groupCached.path.map(p => ({ ...p })); // deep copy
    pathCache.set(unitId, { goalX, goalY, path: sharedPath });
    return sharedPath;
  }

  // Compute new A* path
  const path = findPath(startX, startY, goalX, goalY, unitType, state);
  if (path && path.length > 0) {
    pathCache.set(unitId, { goalX, goalY, path });
    // Store in group cache for other units of same type
    groupPathCache.set(groupKey, { path: path.map(p => ({ ...p })), timestamp: now });
  } else {
    pathCache.delete(unitId);
  }
  return path;
}

/** Clear cached path for a unit (call when target changes or unit stops) */
export function clearPathCache(unitId: number): void {
  pathCache.delete(unitId);
}

/** Advance the cached path: remove waypoints the unit has already passed */
export function advancePath(unitId: number, currentX: number, currentY: number): Position | null {
  const cached = pathCache.get(unitId);
  if (!cached || cached.path.length === 0) return null;

  // Remove waypoints we've already reached (within 0.6 tile)
  while (cached.path.length > 0) {
    const wp = cached.path[0];
    const dx = wp.x - currentX;
    const dy = wp.y - currentY;
    if (dx * dx + dy * dy < 0.36) { // 0.6^2
      cached.path.shift();
    } else {
      break;
    }
  }

  return cached.path.length > 0 ? cached.path[0] : null;
}
