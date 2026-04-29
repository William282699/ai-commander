// ============================================================
// AI Commander — Formation System
// Calculates position offsets for squad formation styles:
//   line, wedge, column, encircle
// ============================================================

import type { Position } from "@ai-commander/shared";

export type FormationStyle = "line" | "wedge" | "column" | "encircle";

const FORMATION_SPACING = 2.5;        // default tiles between units (≥5 squad)
const TIGHT_FORMATION_SPACING = 1.5;  // small-squad spacing (<5 units) — handoff D3
                                      // 0.6× of default; tighter than 1.25 (which risks clip)

/**
 * Compute an offset position for a unit within a formation.
 * Spacing is auto-tightened for small squads (<5 units) so 3-4-man strike
 * teams feel cohesive instead of looking like scattered skirmishers.
 * encircle uses radius scaling instead of spacing — unaffected by total count.
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

  const spacing = total < 5 ? TIGHT_FORMATION_SPACING : FORMATION_SPACING;
  let dx = 0;
  let dy = 0;

  // Body-frame convention: +x = forward (heading direction), ±y = perpendicular (left/right).
  // The rotation below maps body coords → world. Earlier the line/column/wedge offsets had
  // x and y swapped — line spread along movement axis, column stacked perpendicular, wedge
  // tip pointed perpendicular instead of forward. Fix: line spreads in body y, column
  // trails in body -x, wedge has both (leader at +x tip, trail in -x with ±y spread).
  switch (style) {
    case "line":
      dx = 0;
      dy = lineOffset(index, spacing);
      break;
    case "wedge":
      ({ dx, dy } = wedgeOffset(index, spacing));
      break;
    case "column":
      dx = columnOffset(index, spacing);
      dy = 0;
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
 * line: units spread perpendicular to movement, leader in center.
 * Returns body-y component (alternate left/right of forward axis).
 *   ○ ○ ○ ○ ★ ○ ○ ○ ○   (perpendicular to direction of travel)
 */
function lineOffset(index: number, spacing: number): number {
  const half = Math.ceil(index / 2);
  const sign = index % 2 === 1 ? -1 : 1;
  return sign * half * spacing;
}

/**
 * wedge: V-shape, leader at the tip (forward), others trail back + spread.
 * Body offset: dx = -row (behind leader along movement axis); dy = ±row (alternate sides).
 *       ★ (forward)
 *     ○   ○
 *   ○       ○
 */
function wedgeOffset(index: number, spacing: number): { dx: number; dy: number } {
  const row = Math.ceil(index / 2);
  const sign = index % 2 === 1 ? -1 : 1;
  return {
    dx: -row * spacing,        // behind leader (along movement axis)
    dy: sign * row * spacing,  // alternate L/R perpendicular
  };
}

/**
 * column: single file, leader at front, others trail directly behind along movement axis.
 * Returns body-x component (negative = behind).
 *   ★ (forward)
 *   ○
 *   ○
 */
function columnOffset(index: number, spacing: number): number {
  return -index * spacing; // behind leader along movement direction
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
