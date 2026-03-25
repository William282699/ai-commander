// ============================================================
// AI Commander — Formation System
// Calculates position offsets for squad formation styles:
//   line, wedge, column, encircle
// ============================================================

import type { Position } from "@ai-commander/shared";

export type FormationStyle = "line" | "wedge" | "column" | "encircle";

const FORMATION_SPACING = 2.5; // tiles between units

/**
 * Compute an offset position for a unit within a formation.
 * @param target    The formation center / objective point
 * @param index     Unit's index within the squad (0 = leader)
 * @param total     Total units in the squad
 * @param style     Formation shape
 * @param heading   Direction the squad is moving (radians, 0 = east)
 * @returns         Offset position for this unit
 */
export function getFormationOffset(
  target: Position,
  index: number,
  total: number,
  style: FormationStyle,
  heading: number = 0,
): Position {
  if (total <= 1 || index === 0 && style !== "encircle") {
    return { ...target }; // leader goes to exact target (except encircle)
  }

  let dx = 0;
  let dy = 0;

  switch (style) {
    case "line":
      dx = lineOffset(index, total);
      dy = 0;
      break;
    case "wedge":
      ({ dx, dy } = wedgeOffset(index));
      break;
    case "column":
      dx = 0;
      dy = columnOffset(index);
      break;
    case "encircle":
      return encircleOffset(target, index, total);
  }

  // Rotate offset by heading
  const cos = Math.cos(heading);
  const sin = Math.sin(heading);
  const rx = dx * cos - dy * sin;
  const ry = dx * sin + dy * cos;

  return {
    x: Math.round(target.x + rx),
    y: Math.round(target.y + ry),
  };
}

/**
 * line: units spread horizontally, leader in center
 *   ○ ○ ○ ○ ★ ○ ○ ○ ○
 */
function lineOffset(index: number, total: number): number {
  // index 0 is leader at center, others alternate left/right
  const half = Math.ceil(index / 2);
  const sign = index % 2 === 1 ? -1 : 1;
  return sign * half * FORMATION_SPACING;
}

/**
 * wedge: V-shape, leader at front
 *       ★
 *     ○   ○
 *   ○       ○
 */
function wedgeOffset(index: number): { dx: number; dy: number } {
  const row = Math.ceil(index / 2);
  const sign = index % 2 === 1 ? -1 : 1;
  return {
    dx: sign * row * FORMATION_SPACING,
    dy: -row * FORMATION_SPACING, // behind leader
  };
}

/**
 * column: units in a single file, leader at front
 *   ★
 *   ○
 *   ○
 */
function columnOffset(index: number): number {
  return -index * FORMATION_SPACING; // behind leader
}

/**
 * encircle: units form a semicircle around the target
 *      ○ ○ ○
 *    ○       ○
 *   ○    🎯    ○
 *    ○       ○
 */
function encircleOffset(target: Position, index: number, total: number): Position {
  const radius = Math.max(4, total * 0.8); // radius scales with unit count
  const angleSpan = Math.PI * 1.5; // 270 degrees (leave a gap)
  const startAngle = -Math.PI * 0.75; // start from top-left

  const angle = startAngle + (index / Math.max(1, total - 1)) * angleSpan;
  return {
    x: Math.round(target.x + Math.cos(angle) * radius),
    y: Math.round(target.y + Math.sin(angle) * radius),
  };
}

/**
 * Compute the heading from a unit's current position to the target.
 */
export function computeHeading(from: Position, to: Position): number {
  return Math.atan2(to.y - from.y, to.x - from.x);
}
