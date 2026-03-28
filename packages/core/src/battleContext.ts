// ============================================================
// Battle Context V2 — deterministic compression for LLM input
// Pure function: same input → same output, no side effects
// ============================================================

import type { GameState, Channel, CommanderMemory } from "@ai-commander/shared";
import { isDispatchablePlayerUnit } from "@ai-commander/shared";

// ── Tier helpers (pure, not exported) ──

function strengthTier(playerPower: number, enemyPower: number, known: boolean): string {
  if (enemyPower === 0 && playerPower === 0) return known ? "EMPTY" : "EMPTY?";
  if (enemyPower === 0) return known ? "DOMINANT" : "DOMINANT?";
  const ratio = playerPower / enemyPower;
  let tier: string;
  if (ratio > 2.0) tier = "DOMINANT";
  else if (ratio > 1.3) tier = "STRONG";
  else if (ratio > 0.7) tier = "EVEN";
  else if (ratio > 0.4) tier = "WEAK";
  else tier = "CRITICAL";
  return known ? tier : tier + "?";
}

function frontStatus(intensity: number, supply: "OK" | "LOW" | "CRITICAL"): string {
  if (supply === "CRITICAL") return "SUPPLY_CRISIS";
  if (intensity > 0.6) return "HEAVY_CONTACT";
  if (intensity > 0.2) return "SKIRMISH";
  return "QUIET";
}

function reserveTier(count: number): string {
  if (count === 0) return "NONE";
  if (count <= 2) return "LOW";
  if (count <= 5) return "OK";
  return "STRONG";
}

function resourceTier(value: number, low: number, critical: number, flush: number): string {
  if (value <= critical) return "CRITICAL";
  if (value <= low) return "LOW";
  if (value >= flush) return "FLUSH";
  return "OK";
}

function computeHQRisk(state: GameState): string | null {
  // Find player HQ
  let hqAlive = false;
  state.facilities.forEach((fac) => {
    if (fac.type === "headquarters" && fac.team === "player" && fac.hp > 0) {
      hqAlive = true;
    }
  });
  if (!hqAlive) return "HQ destroyed";

  // Check if any front near center is weak with high engagement
  const weakFronts = state.fronts.filter((f) => {
    const ratio = f.enemyPower > 0 ? f.playerPower / f.enemyPower : 999;
    return ratio < 0.7 && f.engagementIntensity > 0.4;
  });

  if (weakFronts.length === 0) return null;

  // Count reserves
  const assignedIds = new Set<number>();
  for (const sq of state.squads) {
    for (const id of sq.unitIds) assignedIds.add(id);
  }
  let reserveCount = 0;
  state.units.forEach((u) => {
    if (isDispatchablePlayerUnit(u) && !assignedIds.has(u.id)) reserveCount++;
  });

  if (reserveCount <= 2) {
    const frontNames = weakFronts.map((f) => f.name).join(", ");
    return `${frontNames} WEAK under pressure, reserves ${reserveTier(reserveCount)}`;
  }

  return null;
}

function countReserves(state: GameState): number {
  const assignedIds = new Set<number>();
  for (const sq of state.squads) {
    for (const id of sq.unitIds) assignedIds.add(id);
  }
  let count = 0;
  state.units.forEach((u) => {
    if (isDispatchablePlayerUnit(u) && !assignedIds.has(u.id)) count++;
  });
  return count;
}

// ── Main export ──

export function buildBattleContextV2(
  state: GameState,
  _channel: Channel,
  memory: CommanderMemory,
): string {
  const MAX_FRONT_LINES = 3;
  const MAX_RISK_LINES = 2;
  const MAX_COMMITMENT_LINES = 2;
  const MAX_INTENT_CHARS = 96;
  const lines: string[] = [];

  // --- SITREP ---
  const m = Math.floor(state.time / 60);
  const s = Math.floor(state.time % 60);
  const timeStr = `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  const res = state.economy.player.resources;
  const moneyTier = resourceTier(res.money, 200, 50, 800);
  const fuelTier = resourceTier(res.fuel, 150, 50, 600);
  const ammoTier = resourceTier(res.ammo, 150, 50, 600);
  const reserves = countReserves(state);

  lines.push("---SITREP---");
  lines.push(`T=${timeStr} Ph=${state.phase} $=${moneyTier} Fu=${fuelTier} Am=${ammoTier} Reserves=${reserves}(${reserveTier(reserves)})`);

  // --- FRONT_BALANCE ---
  lines.push("---FRONT_BALANCE---");
  const frontLines = state.fronts.slice(0, MAX_FRONT_LINES);
  for (const front of frontLines) {
    const str = strengthTier(front.playerPower, front.enemyPower, front.enemyPowerKnown);
    const status = frontStatus(front.engagementIntensity, front.supplyStatus);
    lines.push(`${front.name}: ${str}/${status} supply=${front.supplyStatus}`);
  }
  if (state.fronts.length > MAX_FRONT_LINES) {
    lines.push(`...+${state.fronts.length - MAX_FRONT_LINES} fronts`);
  }

  // --- KEY_RISKS ---
  const risks: string[] = [];
  const hqRisk = computeHQRisk(state);
  if (hqRisk) risks.push(hqRisk);

  // Supply crisis on any front
  for (const front of state.fronts) {
    if (front.supplyStatus === "CRITICAL") {
      risks.push(`Supply crisis: ${front.name}`);
    }
  }

  // Flanking risk: a WEAK front adjacent to HEAVY_CONTACT
  for (let i = 0; i < state.fronts.length; i++) {
    const f = state.fronts[i];
    const ratio = f.enemyPower > 0 ? f.playerPower / f.enemyPower : 999;
    if (ratio < 0.7) {
      const hasAdjacentHeavy = (i > 0 && state.fronts[i - 1].engagementIntensity > 0.6) ||
        (i < state.fronts.length - 1 && state.fronts[i + 1].engagementIntensity > 0.6);
      if (hasAdjacentHeavy) {
        risks.push(`Flank risk: ${f.name} WEAK, adjacent front under heavy contact`);
      }
    }
  }

  lines.push("---KEY_RISKS---");
  const riskLines = Array.from(new Set(risks)).slice(0, MAX_RISK_LINES);
  if (riskLines.length === 0) {
    lines.push("None identified");
  } else {
    for (const r of riskLines) {
      lines.push(`- ${r}`);
    }
  }

  // --- OPEN_COMMITMENTS ---
  lines.push("---OPEN_COMMITMENTS---");
  const commitments = memory.openCommitments.slice(0, 4);
  if (commitments.length === 0) {
    lines.push("None");
  } else {
    const shown = commitments.slice(0, MAX_COMMITMENT_LINES);
    for (const c of shown) {
      lines.push(`- ${c}`);
    }
    if (commitments.length > shown.length) {
      lines.push(`- ...+${commitments.length - shown.length} more`);
    }
  }

  // --- PLAYER_INTENT ---
  lines.push("---PLAYER_INTENT---");
  const intent = (memory.playerIntent || "No standing intent").trim();
  lines.push(intent.slice(0, MAX_INTENT_CHARS));

  return lines.join("\n");
}
