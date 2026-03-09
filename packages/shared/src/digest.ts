// ============================================================
// AI Commander — DigestV1 Format
// Compressed battlefield summary fed to LLM (200-400 tokens)
// ============================================================

import type { GameState, Front, Resources, StyleParams, Unit, Mission } from "./types";

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

  // Active missions
  const activeMissions = state.missions.filter(m => m.status === "active");
  if (activeMissions.length > 0) {
    digest += `---MISSIONS---\n`;
    for (const m of activeMissions) {
      digest += `${m.id}:${m.type}`;
      if (m.targetFacilityId) digest += `@${m.targetFacilityId}`;
      digest += ` prog=${(m.progress * 100).toFixed(0)}% eta=${m.etaSec}s`;
      if (m.threats.length > 0) digest += ` th=[${m.threats.join(",")}]`;
      digest += `\n`;
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

  // Style
  digest += `---STYLE---\n`;
  digest += `risk=${state.style.riskTolerance.toFixed(2)} focus=${state.style.focusFireBias.toFixed(2)} obj=${state.style.objectiveBias.toFixed(2)} cas_aversion=${state.style.casualtyAversion.toFixed(2)}\n`;

  // Player selected units
  if (playerSelectedUnitIds.length > 0) {
    digest += `---PLAYER_SELECTED---\n`;
    digest += `units=[${playerSelectedUnitIds.join(",")}]\n`;
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
