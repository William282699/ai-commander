// ============================================================
// AI Commander — El Alamein Deployment
// 60 British units (player) + ~50 Axis units (enemy)
// Units deployed in tight formations near objectives/key positions
// ============================================================

import type { Unit, UnitType, Team, Position } from "@ai-commander/shared";
import { UNIT_STATS } from "@ai-commander/shared";

function createUnit(
  id: number,
  type: UnitType,
  team: Team,
  position: Position,
): Unit {
  const stats = UNIT_STATS[type];
  return {
    id,
    type,
    team,
    hp: stats.hp,
    maxHp: stats.hp,
    position: { ...position },
    state: "idle",
    target: null,
    attackTarget: null,
    visionRange: stats.vision,
    attackRange: stats.range,
    attackDamage: stats.attack,
    attackInterval: stats.attackInterval,
    moveSpeed: stats.speed,
    lastAttackTime: 0,
    manualOverride: false,
    detourCount: 0,
    waypoints: [],
    patrolPoints: [],
    orders: [],
    patrolTaskId: null,
  };
}

// ── Formation helpers ──────────────────────────────────────

/** Place N units in a grid block (rows × cols) centered on (cx, cy), spacing s */
function blockFormation(cx: number, cy: number, count: number, spacing: number = 2): [number, number][] {
  const cols = Math.ceil(Math.sqrt(count));
  const rows = Math.ceil(count / cols);
  const result: [number, number][] = [];
  const ox = cx - ((cols - 1) * spacing) / 2;
  const oy = cy - ((rows - 1) * spacing) / 2;
  for (let r = 0; r < rows && result.length < count; r++) {
    for (let c = 0; c < cols && result.length < count; c++) {
      result.push([ox + c * spacing, oy + r * spacing]);
    }
  }
  return result;
}

/** Place N units in a line (horizontal or vertical) centered on (cx, cy) */
function lineFormation(cx: number, cy: number, count: number, spacing: number = 2, vertical: boolean = false): [number, number][] {
  const result: [number, number][] = [];
  const offset = -((count - 1) * spacing) / 2;
  for (let i = 0; i < count; i++) {
    if (vertical) {
      result.push([cx, cy + offset + i * spacing]);
    } else {
      result.push([cx + offset + i * spacing, cy]);
    }
  }
  return result;
}

/** Place N units in a circle around (cx, cy) */
function circleFormation(cx: number, cy: number, count: number, radius: number = 3): [number, number][] {
  const result: [number, number][] = [];
  for (let i = 0; i < count; i++) {
    const angle = (2 * Math.PI * i) / count - Math.PI / 2;
    result.push([
      Math.round(cx + Math.cos(angle) * radius),
      Math.round(cy + Math.sin(angle) * radius),
    ]);
  }
  return result;
}

/** Place N units in a V/wedge formation pointing toward bearing angle */
function wedgeFormation(cx: number, cy: number, count: number, spacing: number = 2): [number, number][] {
  const result: [number, number][] = [[cx, cy]]; // leader at tip
  for (let i = 1; i < count; i++) {
    const row = Math.ceil(i / 2);
    const side = i % 2 === 1 ? 1 : -1;
    result.push([cx + side * row * spacing, cy + row * spacing]);
  }
  return result;
}

// ── Deployment function ────────────────────────────────────

export function deployElAlameinUnits(): { units: Map<number, Unit>; nextUnitId: number } {
  const units = new Map<number, Unit>();
  let uid = 1;

  function placeGroup(
    type: UnitType, team: Team,
    positions: [number, number][],
    opts?: { playerControlled?: boolean },
  ) {
    for (const [x, y] of positions) {
      const u = createUnit(uid, type, team, { x, y });
      if (opts?.playerControlled) u.isPlayerControlled = true;
      units.set(uid, u);
      uid++;
    }
  }

  // ═══════════════════════════════════════════
  // PLAYER (British 8th Army) — East side
  // Organized into combat groups at key staging areas
  // ═══════════════════════════════════════════

  // ── HQ Compound (430, 88) ──
  // Commander + elite guard ring
  const commander = createUnit(uid, "commander", "player", { x: 432, y: 88 });
  commander.isPlayerControlled = true;
  units.set(uid, commander);
  uid++;
  placeGroup("elite_guard", "player", circleFormation(432, 88, 10, 4), { playerControlled: true });

  // ── Northern Battle Group (390, 30) — for coastal push ──
  // 5 infantry in block + 3 light tanks in line behind
  placeGroup("infantry", "player", blockFormation(388, 28, 5, 2));
  placeGroup("light_tank", "player", lineFormation(388, 35, 3, 3));

  // ── Central Armored Group (380, 85) — main assault force ──
  // 6 main tanks in 2×3 block + 4 infantry screening in front line
  placeGroup("main_tank", "player", blockFormation(378, 82, 6, 3));
  placeGroup("infantry", "player", lineFormation(378, 76, 4, 3));

  // ── Central Support Group (390, 100) — second wave ──
  // 4 main tanks wedge + 4 infantry block
  placeGroup("main_tank", "player", wedgeFormation(392, 98, 4, 3));
  placeGroup("infantry", "player", blockFormation(392, 106, 4, 2));

  // ── Southern Strike Force (385, 170) — flanking group ──
  // 4 infantry block + 3 light tanks line + 2 light tanks scout
  placeGroup("infantry", "player", blockFormation(384, 168, 4, 2));
  placeGroup("light_tank", "player", lineFormation(384, 175, 3, 3));
  placeGroup("light_tank", "player", [[378, 162], [390, 162]]);

  // ── Reserve Infantry (415, 110) — rear reserve ──
  placeGroup("infantry", "player", blockFormation(416, 112, 3, 2));

  // ── Artillery Battery (425, 65) — northern battery ──
  placeGroup("artillery", "player", lineFormation(425, 62, 3, 4));

  // ── Artillery Battery (430, 130) — southern battery ──
  placeGroup("artillery", "player", lineFormation(430, 132, 3, 4));

  // ── Air Wing (450, 128) ──
  placeGroup("recon_plane", "player", lineFormation(452, 124, 3, 3));
  placeGroup("fighter", "player", [[448, 130], [456, 130]]);

  // ═══════════════════════════════════════════
  // ENEMY (Afrika Korps + Italian) — West side + strongpoints
  // Garrisoned at each capture objective in defensive formations
  // ═══════════════════════════════════════════

  // ── Rommel HQ (82, 98) ──
  const rommel = createUnit(uid, "commander", "enemy", { x: 82, y: 98 });
  units.set(uid, rommel);
  uid++;
  placeGroup("infantry", "enemy", circleFormation(82, 98, 3, 3));
  placeGroup("main_tank", "enemy", [[76, 92], [88, 92]]);

  // ── Alamein Town Garrison (280, 30) — Objective 1 ──
  placeGroup("infantry", "enemy", circleFormation(280, 30, 5, 3));
  placeGroup("main_tank", "enemy", lineFormation(280, 38, 2, 4));
  placeGroup("artillery", "enemy", [[274, 24], [286, 24]]);

  // ── Kidney Ridge Garrison (220, 55) — Objective 2 ──
  placeGroup("infantry", "enemy", blockFormation(220, 55, 4, 2));
  placeGroup("main_tank", "enemy", lineFormation(220, 62, 2, 4));
  placeGroup("artillery", "enemy", [[214, 48]]);

  // ── Miteirya Ridge Garrison (230, 70) — Objective 3 ──
  placeGroup("infantry", "enemy", blockFormation(230, 70, 4, 2));
  placeGroup("main_tank", "enemy", [[224, 76], [236, 76]]);
  placeGroup("artillery", "enemy", [[230, 64]]);

  // ── Himeimat Heights Garrison (250, 218) — Objective 4 ──
  placeGroup("infantry", "enemy", circleFormation(250, 218, 3, 3));
  placeGroup("light_tank", "enemy", lineFormation(250, 225, 2, 3));
  placeGroup("artillery", "enemy", [[244, 212]]);

  // ── Mobile Reserve — scattered between strongpoints ──
  // Central mobile reserve (160, 80)
  placeGroup("light_tank", "enemy", blockFormation(160, 78, 4, 3));
  placeGroup("light_tank", "enemy", blockFormation(140, 100, 2, 3));

  // Rear patrol (110, 110)
  placeGroup("infantry", "enemy", blockFormation(110, 108, 3, 2));
  placeGroup("light_tank", "enemy", [[105, 115], [115, 115]]);

  // ── Air Wing (58, 128) ──
  placeGroup("fighter", "enemy", lineFormation(58, 128, 3, 3));
  placeGroup("bomber", "enemy", [[56, 134], [64, 134]]);

  return { units, nextUnitId: uid };
}
