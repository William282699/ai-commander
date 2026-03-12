// ============================================================
// AI Commander — Mission System (Day 11)
// Lifecycle: create → tick progress → success/fail
// Types: sabotage, destroy, capture, defend_area, cut_supply
// ============================================================

import type {
  GameState,
  Mission,
  MissionType,
  Position,
  Unit,
  Facility,
  DiagnosticEntry,
} from "@ai-commander/shared";

// ── Module-level ID counter (reset per game session is fine) ──

let missionIdCounter = 0;

/** Reset counter — call when starting a new game session. */
export function resetMissionCounter(): void {
  missionIdCounter = 0;
}

// ── Mission Creation ──

export interface CreateMissionOpts {
  name: string;
  description: string;
  targetFacilityId?: string;
  targetRegionId?: string;
  assignedUnitIds: number[];
  etaSec?: number;
  squadId?: string; // link squad.currentMission
}

/**
 * Create a new active mission and add it to state.missions.
 * Optionally binds a squad's currentMission to this mission.
 */
export function createMission(
  state: GameState,
  type: MissionType,
  opts: CreateMissionOpts,
): Mission {
  missionIdCounter++;
  const mission: Mission = {
    id: `M${missionIdCounter}`,
    type,
    name: opts.name,
    description: opts.description,
    targetFacilityId: opts.targetFacilityId,
    targetRegionId: opts.targetRegionId,
    assignedUnitIds: [...opts.assignedUnitIds],
    progress: 0,
    status: "active",
    etaSec: opts.etaSec ?? 120,
    threats: [],
    createdAt: state.time,
  };

  state.missions.push(mission);

  // Part B: bind squad → mission
  if (opts.squadId) {
    const squad = state.squads.find((s) => s.id === opts.squadId);
    if (squad) {
      squad.currentMission = mission.id;
    }
  }

  pushDiag(state, "MISSION_CREATED", `任务创建: ${mission.name} [${mission.type}]`);
  return mission;
}

// ── Process Missions (called every tick from game loop) ──

export function processMissions(state: GameState, dt: number): void {
  if (state.gameOver) return;
  for (const mission of state.missions) {
    if (mission.status !== "active") continue;

    // Prune dead units from assignment
    mission.assignedUnitIds = mission.assignedUnitIds.filter((id) => {
      const u = state.units.get(id);
      return u && u.state !== "dead";
    });

    // Part B: squad viability check — wipeout or morale collapse → auto-fail
    if (checkSquadFail(mission, state)) continue;

    // All assigned units dead → fail
    if (mission.assignedUnitIds.length === 0) {
      failMission(mission, state, "所有指派单位阵亡");
      continue;
    }

    // Tick progress by mission type
    switch (mission.type) {
      case "sabotage":
        tickSabotage(mission, state);
        break;
      case "destroy":
        tickDestroy(mission, state);
        break;
      case "capture":
        tickCapture(mission, state);
        break;
      case "defend_area":
        tickDefendArea(mission, state, dt);
        break;
      case "cut_supply":
        tickCutSupply(mission, state);
        break;
    }

    // Update threats
    updateThreats(mission, state);

    // Recalc ETA from progress
    if (mission.progress > 0 && mission.progress < 1) {
      const elapsed = state.time - mission.createdAt;
      const estimatedTotal = elapsed / mission.progress;
      mission.etaSec = Math.max(0, Math.round(estimatedTotal - elapsed));
    }
  }
}

// ── Per-type progress tickers ──

/** sabotage: damage ratio of target facility. Complete at 80%+ damage. */
function tickSabotage(mission: Mission, state: GameState): void {
  if (!mission.targetFacilityId) {
    failMission(mission, state, "破坏目标缺失");
    return;
  }
  const fac = state.facilities.get(mission.targetFacilityId);
  if (!fac) {
    completeMission(mission, state, "目标设施已不存在（可能已被摧毁）");
    return;
  }
  // Progress = damage dealt ratio
  const damageRatio = 1 - fac.hp / fac.maxHp;
  mission.progress = Math.min(1, damageRatio / 0.8); // normalize: 80% damage = 100% progress
  if (fac.hp <= 0 || damageRatio >= 0.8) {
    completeMission(mission, state, `设施 ${fac.name} 已被破坏`);
  }
}

/** destroy: eliminate all enemies in target region. */
function tickDestroy(mission: Mission, state: GameState): void {
  if (!mission.targetRegionId) {
    failMission(mission, state, "歼灭目标区域缺失");
    return;
  }
  const region = state.regions.get(mission.targetRegionId);
  if (!region) {
    failMission(mission, state, "目标区域不存在");
    return;
  }
  const enemies = getEnemiesInBbox(state, region.bbox);
  const friendlies = mission.assignedUnitIds
    .map((id) => state.units.get(id))
    .filter((u): u is Unit => !!u && u.state !== "dead");

  if (enemies.length === 0) {
    mission.progress = 1;
    completeMission(mission, state, `区域 ${region.name} 已肃清`);
    return;
  }
  // Progress based on force ratio (higher friendly:enemy = closer to completion)
  const ratio = friendlies.length / (friendlies.length + enemies.length);
  mission.progress = Math.min(0.95, ratio); // cap at 95% until fully clear
}

/** capture: mirror facility capture progress. */
function tickCapture(mission: Mission, state: GameState): void {
  if (!mission.targetFacilityId) {
    failMission(mission, state, "夺取目标缺失");
    return;
  }
  const fac = state.facilities.get(mission.targetFacilityId);
  if (!fac) {
    failMission(mission, state, "目标设施不存在");
    return;
  }
  if (fac.team === "player") {
    mission.progress = 1;
    completeMission(mission, state, `设施 ${fac.name} 已夺取`);
    return;
  }
  // Progress mirrors capture mechanic
  if (fac.capturingTeam === "player") {
    mission.progress = Math.min(0.95, fac.captureProgress);
  }
}

/** defend_area: hold region for etaSec. Progress = time held / original etaSec. */
function tickDefendArea(mission: Mission, state: GameState, dt: number): void {
  if (!mission.targetRegionId) {
    failMission(mission, state, "防守目标区域缺失");
    return;
  }
  const region = state.regions.get(mission.targetRegionId);
  if (!region) {
    failMission(mission, state, "目标区域不存在");
    return;
  }
  const enemies = getEnemiesInBbox(state, region.bbox);
  const friendlies = mission.assignedUnitIds
    .map((id) => state.units.get(id))
    .filter((u): u is Unit => !!u && u.state !== "dead");

  // Check if area is still held (friendlies present and outnumber enemies)
  if (friendlies.length === 0) {
    failMission(mission, state, "防守区域失守，无友军存在");
    return;
  }

  // Accumulate hold time via progress (originalEtaSec stored at creation)
  const originalEta = mission.etaSec + (state.time - mission.createdAt) * mission.progress;
  const requiredTime = Math.max(originalEta, 60); // minimum 60s hold
  const elapsed = state.time - mission.createdAt;
  mission.progress = Math.min(1, elapsed / requiredTime);

  if (mission.progress >= 1) {
    completeMission(mission, state, `区域 ${region.name} 防守成功`);
  }
}

/** cut_supply: similar to sabotage, target supply facilities. */
function tickCutSupply(mission: Mission, state: GameState): void {
  // Reuse sabotage logic — cut_supply targets supply-chain facilities
  tickSabotage(mission, state);
}

// ── Squad viability check (Part B) ──

/**
 * If a mission is linked to a squad and that squad is wiped or morale ≤ 0.1,
 * auto-fail the mission.
 * Returns true if mission was failed.
 */
function checkSquadFail(mission: Mission, state: GameState): boolean {
  // Find squad linked to this mission
  const squad = state.squads.find((s) => s.currentMission === mission.id);
  if (!squad) return false;

  // Check morale
  if (squad.morale <= 0.1) {
    failMission(mission, state, `分队 ${squad.id} 士气崩溃`);
    squad.currentMission = null;
    return true;
  }

  // Check alive count
  const alive = squad.unitIds.filter((id) => {
    const u = state.units.get(id);
    return u && u.state !== "dead";
  });
  if (alive.length === 0) {
    failMission(mission, state, `分队 ${squad.id} 全灭`);
    squad.currentMission = null;
    return true;
  }

  return false;
}

// ── Threat detection ──

function updateThreats(mission: Mission, state: GameState): void {
  const threats: string[] = [];
  const bbox = getMissionBbox(mission, state);
  if (!bbox) {
    mission.threats = [];
    return;
  }

  const enemies = getEnemiesInBbox(state, bbox);
  if (enemies.length > 0) {
    // Categorize threats
    const types = new Map<string, number>();
    for (const e of enemies) {
      types.set(e.type, (types.get(e.type) || 0) + 1);
    }
    for (const [t, c] of types) {
      threats.push(`${c}×${t}`);
    }
  }

  mission.threats = threats;
}

// ── Completion / Failure ──

function completeMission(mission: Mission, state: GameState, reason: string): void {
  mission.status = "completed";
  mission.progress = 1;
  pushDiag(state, "MISSION_COMPLETE", `任务完成: ${mission.name} — ${reason}`);
  unlinkSquad(mission, state);
}

function failMission(mission: Mission, state: GameState, reason: string): void {
  mission.status = "failed";
  pushDiag(state, "MISSION_FAILED", `任务失败: ${mission.name} — ${reason}`);
  unlinkSquad(mission, state);
}

function unlinkSquad(mission: Mission, state: GameState): void {
  for (const sq of state.squads) {
    if (sq.currentMission === mission.id) {
      sq.currentMission = null;
    }
  }
}

// ── Helpers ──

function getMissionBbox(
  mission: Mission,
  state: GameState,
): [number, number, number, number] | null {
  if (mission.targetRegionId) {
    const region = state.regions.get(mission.targetRegionId);
    if (region) return region.bbox;
  }
  if (mission.targetFacilityId) {
    const fac = state.facilities.get(mission.targetFacilityId);
    if (fac) {
      // Expand facility position to a small bbox (10 tile radius)
      return [fac.position.x - 10, fac.position.y - 10, fac.position.x + 10, fac.position.y + 10];
    }
  }
  return null;
}

function getEnemiesInBbox(
  state: GameState,
  bbox: [number, number, number, number],
): Unit[] {
  const [x1, y1, x2, y2] = bbox;
  const enemies: Unit[] = [];
  state.units.forEach((u) => {
    if (
      u.team === "enemy" &&
      u.state !== "dead" &&
      u.position.x >= x1 &&
      u.position.x <= x2 &&
      u.position.y >= y1 &&
      u.position.y <= y2
    ) {
      enemies.push(u);
    }
  });
  return enemies;
}

const DIAG_DEDUP_SEC = 5;

function pushDiag(state: GameState, code: string, message: string): void {
  const recent = state.diagnostics;
  for (let i = recent.length - 1; i >= 0; i--) {
    if (recent[i].code === code && state.time - recent[i].time < DIAG_DEDUP_SEC) return;
    if (state.time - recent[i].time >= DIAG_DEDUP_SEC) break;
  }
  state.diagnostics.push({ time: state.time, code, message });
  if (state.diagnostics.length > 50) state.diagnostics.shift();
}
