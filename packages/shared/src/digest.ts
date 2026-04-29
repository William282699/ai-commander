// ============================================================
// AI Commander — DigestV1 Format
// Compressed battlefield summary fed to LLM (200-400 tokens)
// ============================================================

import type { GameState, Front, Resources, StyleParams, Unit, Mission, Squad, Position, CommanderKey } from "./types";
import { isManualOnlyUnit } from "./types";
import { collectUnitsUnder } from "./squadHierarchy";

/**
 * Generate a DigestV1 text summary from GameState.
 * This is what the LLM sees — no raw tiles, no full unit lists.
 */
export function generateDigestV1(
  state: GameState,
  playerSelectedUnitIds: number[],
  markedTargets: { id: string; position: [number, number] }[],
  recentEvents: string[],
): string {
  const t = formatTime(state.time);
  const ph = state.phase;
  const rd = state.economy.player.readiness.toFixed(2);
  const res = state.economy.player.resources;

  let digest = `T=${t} Ph=${ph} Rd=${rd} $=${res.money} Fu=${res.fuel} Am=${res.ammo} In=${res.intel}\n`;
  digest += `---FRONTS--- (CombatPwr=DPS-based strength, NOT headcount; Comp=unit-type breakdown)\n`;

  for (const front of state.fronts) {
    const ep = front.enemyPowerKnown ? Math.round(front.enemyPower) : "?";
    const { ourComp, enemyEngagedComp, enemyMassingComp } = computeFrontComposition(state, front);
    digest += `${front.id}:${front.name} OurPwr=${Math.round(front.playerPower)} EnemyPwr=${ep}`;
    if (ourComp) digest += ` OurComp=[${ourComp}]`;
    if (enemyEngagedComp) digest += ` EnemyEngaged=[${enemyEngagedComp}]`;
    if (enemyMassingComp) digest += ` EnemyMassing=[${enemyMassingComp}]`;
    digest += ` Engagement=${front.engagementIntensity.toFixed(1)} Supply=${front.supplyStatus}`;
    if (front.keyEvents.length > 0) {
      digest += ` key=[${front.keyEvents.join(", ")}]`;
    }
    digest += `\n`;
  }

  // Active missions (max 8 lines, consistent with SQUADS/PLAYER_SELECTED)
  const activeMissions = state.missions.filter(m => m.status === "active");
  if (activeMissions.length > 0) {
    digest += `---MISSIONS---\n`;
    const maxMissions = 8;
    for (let i = 0; i < Math.min(activeMissions.length, maxMissions); i++) {
      const m = activeMissions[i];
      digest += `${m.id}:${m.type}`;
      if (m.targetFacilityId) digest += `@${m.targetFacilityId}`;
      digest += ` prog=${(m.progress * 100).toFixed(0)}% eta=${m.etaSec}s`;
      if (m.threats.length > 0) digest += ` th=[${m.threats.join(",")}]`;
      digest += `\n`;
    }
    if (activeMissions.length > maxMissions) {
      digest += `...+${activeMissions.length - maxMissions} more\n`;
    }
  }

  // Air summary
  const playerAir = getPlayerAir(state);
  if (playerAir.length > 0) {
    digest += `---AIR---\n`;
    digest += playerAir.join(" | ") + "\n";
  }

  // Recent events
  if (recentEvents.length > 0) {
    digest += `---EVENTS(90s)---\n`;
    for (const ev of recentEvents.slice(-5)) {
      digest += `${ev}\n`;
    }
  }

  // Facilities — so LLM knows available buildings and can fill targetFacility
  // MVP: include all facilities (map is small). TODO: fog-filter when fog is polished.
  const facilityLines: string[] = [];
  state.facilities.forEach((f) => {
    facilityLines.push(
      `${f.id}:${f.type} "${f.name}" team=${f.team} hp=${f.hp}/${f.maxHp} @(${f.position.x},${f.position.y})`,
    );
  });
  if (facilityLines.length > 0) {
    digest += `---FACILITIES---\n`;
    for (const line of facilityLines) {
      digest += `${line}\n`;
    }
  }

  // Day 12: ENDGAME / GAMEOVER compact lines
  if (state.phase === "ENDGAME" && state.endgameStartTime !== null) {
    const eta = Math.max(0, 300 - (state.time - state.endgameStartTime));
    digest += `ENDGAME: eta=${Math.round(eta)}s\n`;
  }
  if (state.gameOver) {
    digest += `GAMEOVER: winner=${state.winner} reason=${state.gameOverReason ?? "unknown"}\n`;
  }

  // Day 15: Tags (player map markers)
  if (state.tags && state.tags.length > 0) {
    digest += `---TAGS---\n`;
    const maxTags = 12;
    for (let i = 0; i < Math.min(state.tags.length, maxTags); i++) {
      const t = state.tags[i];
      digest += `${t.id}:"${t.name}" @(${Math.round(t.position.x)},${Math.round(t.position.y)})\n`;
    }
    if (state.tags.length > maxTags) {
      digest += `...+${state.tags.length - maxTags} more\n`;
    }
  }

  // Doctrines (active standing orders)
  const activeDoctrines = state.doctrines?.filter(d => d.status === "active") ?? [];
  if (activeDoctrines.length > 0) {
    digest += `---DOCTRINES---\n`;
    for (const d of activeDoctrines) {
      digest += `${d.id} ${d.type} ${d.locationTag} ${d.priority.toUpperCase()} squads=[${d.assignedSquads.join(",")}] reinforce=${d.allowAutoReinforce}\n`;
    }
  }

  // Named routes (El Alamein etc.)
  if (state.namedRoutes && state.namedRoutes.length > 0) {
    digest += `---ROUTES---\n`;
    for (const nr of state.namedRoutes) {
      const from = nr.waypoints[0];
      const to = nr.waypoints[nr.waypoints.length - 1];
      digest += `${nr.id}:"${nr.name}" (${Math.round(from.x)},${Math.round(from.y)})→(${Math.round(to.x)},${Math.round(to.y)}) for:${nr.passableFor.join(",")}\n`;
    }
  }

  // Style
  digest += `---STYLE---\n`;
  digest += `risk=${state.style.riskTolerance.toFixed(2)} focus=${state.style.focusFireBias.toFixed(2)} obj=${state.style.objectiveBias.toFixed(2)} cas_aversion=${state.style.casualtyAversion.toFixed(2)}\n`;

  // Phase 2: Squad summary with hierarchy (flat + parent field)
  if (state.squads && state.squads.length > 0) {
    digest += `---SQUADS---\n`;
    const commanders: CommanderKey[] = ["chen", "marcus", "emily"];
    const cmdLabels: Record<CommanderKey, string> = { chen: "Chen(combat)", marcus: "Marcus(ops)", emily: "Emily(logistics)" };
    for (const cmd of commanders) {
      const cmdSquads = state.squads.filter((s) => s.ownerCommander === cmd);
      if (cmdSquads.length === 0) {
        digest += `${cmdLabels[cmd]}: (empty)\n`;
        continue;
      }
      digest += `${cmdLabels[cmd]}:\n`;
      let lineCount = 0;
      for (const sq of cmdSquads) {
        if (lineCount >= 12) { digest += `  ...+${cmdSquads.length - lineCount} more\n`; break; }
        const parentLabel = sq.parentSquadId ?? cmd;
        if (sq.role === "commander") {
          const childIds = state.squads.filter((s) => s.parentSquadId === sq.id).map((s) => s.id);
          const totalUnits = collectUnitsUnder(state, sq.id).length;
          const pos = squadAvgPos(sq.unitIds.length > 0 ? sq.unitIds : collectUnitsUnder(state, sq.id), state);
          digest += `  ${sq.leaderName}(${sq.id},CMD) parent:${parentLabel} manages:[${childIds.join(",")}] ${totalUnits}units @(${pos.x},${pos.y})\n`;
        } else {
          const alive = sq.unitIds.filter((id) => { const u = state.units.get(id); return u && u.state !== "dead"; });
          if (alive.length === 0) continue;
          const types = summarizeSquadTypes(alive, state);
          const pos = squadAvgPos(alive, state);
          digest += `  ${sq.leaderName}(${sq.id},leader) parent:${parentLabel} ${alive.length}units(${types}) @(${pos.x},${pos.y}) morale=${sq.morale.toFixed(1)} mission=${sq.currentMission || "idle"}\n`;
        }
        lineCount++;
      }
    }
  }

  // Manual-only units — visible to the LLM for awareness, but not dispatchable.
  const manualOnlyUnits = Array.from(state.units.values()).filter(
    (u) => u.team === "player" && u.state !== "dead" && isManualOnlyUnit(u),
  );
  if (manualOnlyUnits.length > 0) {
    digest += `---MANUAL_UNITS---\n`;

    const commander = manualOnlyUnits.find((u) => u.type === "commander");
    if (commander) {
      digest += `commander#${commander.id} hp=${Math.round(commander.hp)}/${commander.maxHp} @(${Math.round(commander.position.x)},${Math.round(commander.position.y)}) manual-only\n`;
    }

    const eliteGuards = manualOnlyUnits.filter((u) => u.type === "elite_guard");
    if (eliteGuards.length > 0) {
      const pos = unitsAvgPos(eliteGuards);
      const totalHp = eliteGuards.reduce((sum, u) => sum + Math.round(u.hp), 0);
      const totalMaxHp = eliteGuards.reduce((sum, u) => sum + u.maxHp, 0);
      digest += `elite_guard×${eliteGuards.length} hp=${totalHp}/${totalMaxHp} @(${pos.x},${pos.y}) manual-only\n`;
    }
  }

  // Unassigned units summary — dispatchable unit types outside squads
  {
    const assignedIds = new Set<number>();
    for (const sq of state.squads) {
      for (const id of sq.unitIds) assignedIds.add(id);
    }
    const unassignedCounts = new Map<string, number>();
    state.units.forEach((u) => {
      if (u.team !== "player" || u.state === "dead") return;
      if (isManualOnlyUnit(u)) return;
      if (assignedIds.has(u.id)) return;
      unassignedCounts.set(u.type, (unassignedCounts.get(u.type) || 0) + 1);
    });
    if (unassignedCounts.size > 0) {
      digest += `---UNASSIGNED_UNITS---\n`;
      for (const [type, count] of unassignedCounts) {
        digest += `${count}×${type}\n`;
      }
    }
  }

  // Day 10.5: Player selected units — detailed info (max 8 lines, P2-5)
  if (playerSelectedUnitIds.length > 0) {
    digest += `---PLAYER_SELECTED---\n`;
    for (const id of playerSelectedUnitIds.slice(0, 8)) {
      const u = state.units.get(id);
      if (!u || u.state === "dead") continue;
      const sqId = state.squads?.find((s) => s.unitIds.includes(id))?.id || "none";
      digest += `#${u.id} ${u.type} hp=${u.hp}/${u.maxHp} @(${u.position.x},${u.position.y}) sq=${sqId}\n`;
    }
  }

  // Marked targets
  if (markedTargets.length > 0) {
    digest += `---MARKED_TARGETS---\n`;
    for (const mt of markedTargets) {
      digest += `${mt.id}@[${mt.position.join(",")}]\n`;
    }
  }

  return digest;
}

function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
}

function getPlayerAir(state: GameState): string[] {
  const result: string[] = [];
  const airUnits: Unit[] = [];

  state.units.forEach(u => {
    if (u.team === "player" && (u.type === "fighter" || u.type === "bomber" || u.type === "recon_plane")) {
      airUnits.push(u);
    }
  });

  const grouped = new Map<string, Unit[]>();
  for (const u of airUnits) {
    const existing = grouped.get(u.type) || [];
    existing.push(u);
    grouped.set(u.type, existing);
  }

  for (const [type, units] of grouped) {
    result.push(`${type}×${units.length} ${units[0].state}:${describePosition(units[0])}`);
  }

  return result;
}

function describePosition(unit: Unit): string {
  return `(${unit.position.x},${unit.position.y})`;
}

// Day 10.5: Squad digest helpers

function summarizeSquadTypes(unitIds: number[], state: GameState): string {
  const counts = new Map<string, number>();
  for (const id of unitIds) {
    const u = state.units.get(id);
    if (!u) continue;
    counts.set(u.type, (counts.get(u.type) || 0) + 1);
  }
  return Array.from(counts.entries())
    .map(([t, c]) => `${c}×${t}`)
    .join(",");
}

function squadAvgPos(unitIds: number[], state: GameState): { x: number; y: number } {
  let sx = 0;
  let sy = 0;
  let n = 0;
  for (const id of unitIds) {
    const u = state.units.get(id);
    if (!u) continue;
    sx += u.position.x;
    sy += u.position.y;
    n++;
  }
  if (n === 0) return { x: 0, y: 0 };
  return { x: Math.round(sx / n), y: Math.round(sy / n) };
}

function unitsAvgPos(units: Unit[]): { x: number; y: number } {
  if (units.length === 0) return { x: 0, y: 0 };
  const sx = units.reduce((sum, u) => sum + u.position.x, 0);
  const sy = units.reduce((sum, u) => sum + u.position.y, 0);
  return { x: Math.round(sx / units.length), y: Math.round(sy / units.length) };
}

/**
 * "Engaged" cutoff: an enemy within this many tiles of any player unit in the
 * same front is reported as `EnemyEngaged`; beyond it, as `EnemyMassing`. The
 * split lets advisors distinguish "what's actively in contact with our units"
 * from "what's in the area but distant" — the prior single-bucket EnemyComp
 * lumped passing/distant enemies into the engaged signal and confused Chen
 * into recommending reinforcement when local terrain was already cleared.
 *
 * Tunable post-playtest. 10 ≈ typical attack range × 1.5 + a small buffer.
 */
const ENGAGED_RADIUS = 10;

/**
 * Per-front unit-type composition for LLM tactical briefings.
 *
 * Returns three "3×main_tank,8×infantry" style strings:
 *   - ourComp:           player units inside the front bbox
 *   - enemyEngagedComp:  visible enemies within ENGAGED_RADIUS of any player unit in the front
 *   - enemyMassingComp:  visible enemies in the front bbox but beyond ENGAGED_RADIUS
 *
 * Enemy units respect fog — only visible ones are counted, mirroring
 * updateFrontPower's fog-gated enemy power sum in intelDigest.ts. This
 * keeps OurPwr/EnemyPwr and the *Comp fields semantically aligned: what
 * the digest reports is what the player can actually see.
 *
 * Returns empty strings (not rendered by caller) when no units occupy a
 * given bucket.
 */
function computeFrontComposition(
  state: GameState,
  front: Front,
): { ourComp: string; enemyEngagedComp: string; enemyMassingComp: string } {
  const regionBboxes: [number, number, number, number][] = [];
  for (const rid of front.regionIds) {
    const region = state.regions.get(rid);
    if (region) regionBboxes.push(region.bbox);
  }
  if (regionBboxes.length === 0) {
    return { ourComp: "", enemyEngagedComp: "", enemyMassingComp: "" };
  }

  const inFront = (x: number, y: number): boolean =>
    regionBboxes.some(([x1, y1, x2, y2]) => x >= x1 && x <= x2 && y >= y1 && y <= y2);

  // First pass: collect player positions in front, used to classify enemies.
  const playerPositionsInFront: Position[] = [];
  state.units.forEach((unit) => {
    if (unit.team !== "player" || unit.hp <= 0 || unit.state === "dead") return;
    if (inFront(unit.position.x, unit.position.y)) {
      playerPositionsInFront.push(unit.position);
    }
  });

  // Second pass: tally counts. Player units bucketed simply; enemies split
  // engaged vs massing by min squared distance to any player position in front.
  const ourCounts = new Map<string, number>();
  const enemyEngagedCounts = new Map<string, number>();
  const enemyMassingCounts = new Map<string, number>();
  const radiusSq = ENGAGED_RADIUS * ENGAGED_RADIUS;

  state.units.forEach((unit) => {
    if (unit.hp <= 0 || unit.state === "dead") return;
    if (!inFront(unit.position.x, unit.position.y)) return;

    if (unit.team === "player") {
      ourCounts.set(unit.type, (ourCounts.get(unit.type) || 0) + 1);
      return;
    }
    if (unit.team !== "enemy") return;

    // Fog gate — match updateFrontPower's rule
    const tx = Math.floor(unit.position.x);
    const ty = Math.floor(unit.position.y);
    if (state.fog[ty]?.[tx] !== "visible") return;

    // Classify: closest player unit in front decides engaged vs massing.
    // Empty playerPositionsInFront → minDistSq stays Infinity → goes to massing
    // (correct: no player in front to be "engaged with").
    let minDistSq = Infinity;
    for (const p of playerPositionsInFront) {
      const dx = unit.position.x - p.x;
      const dy = unit.position.y - p.y;
      const d2 = dx * dx + dy * dy;
      if (d2 < minDistSq) minDistSq = d2;
    }

    if (minDistSq <= radiusSq) {
      enemyEngagedCounts.set(unit.type, (enemyEngagedCounts.get(unit.type) || 0) + 1);
    } else {
      enemyMassingCounts.set(unit.type, (enemyMassingCounts.get(unit.type) || 0) + 1);
    }
  });

  const fmt = (m: Map<string, number>): string =>
    Array.from(m.entries())
      .sort((a, b) => b[1] - a[1]) // heaviest first — headline tactical detail
      .map(([t, c]) => `${c}×${t}`)
      .join(",");

  return {
    ourComp: fmt(ourCounts),
    enemyEngagedComp: fmt(enemyEngagedCounts),
    enemyMassingComp: fmt(enemyMassingCounts),
  };
}
