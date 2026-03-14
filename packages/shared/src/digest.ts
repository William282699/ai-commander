// ============================================================
// AI Commander — DigestV1 Format
// Compressed battlefield summary fed to LLM (200-400 tokens)
// ============================================================

import type { GameState, Front, Resources, StyleParams, Unit, Mission, Squad, Position } from "./types";

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
  digest += `---FRONTS---\n`;

  for (const front of state.fronts) {
    const ep = front.enemyPowerKnown ? Math.round(front.enemyPower) : "?";
    digest += `${front.id}:${front.name} P=${Math.round(front.playerPower)} E=${ep} X=${front.engagementIntensity.toFixed(1)} S=${front.supplyStatus}`;
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
  const facilityLines: string[] = [];
  state.facilities.forEach((f) => {
    // Show player + neutral + enemy HQ (always visible as strategic objective)
    if (f.team === "player" || f.team === "neutral" || f.type === "headquarters") {
      facilityLines.push(
        `${f.id}:${f.type} "${f.name}" team=${f.team} hp=${f.hp}/${f.maxHp} @(${f.position.x},${f.position.y})`,
      );
    }
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

  // Style
  digest += `---STYLE---\n`;
  digest += `risk=${state.style.riskTolerance.toFixed(2)} focus=${state.style.focusFireBias.toFixed(2)} obj=${state.style.objectiveBias.toFixed(2)} cas_aversion=${state.style.casualtyAversion.toFixed(2)}\n`;

  // Day 10.5: Squad summary (max 8 lines, P2-5)
  if (state.squads && state.squads.length > 0) {
    digest += `---SQUADS---\n`;
    let squadCount = 0;
    for (const sq of state.squads) {
      if (squadCount >= 8) break;
      const alive = sq.unitIds.filter((id) => {
        const u = state.units.get(id);
        return u && u.state !== "dead";
      });
      if (alive.length === 0) continue;
      const types = summarizeSquadTypes(alive, state);
      const pos = squadAvgPos(alive, state);
      digest += `${sq.id}:"${sq.name}" ${types} @(${pos.x},${pos.y}) morale=${sq.morale.toFixed(1)} mission=${sq.currentMission || "idle"}\n`;
      squadCount++;
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
