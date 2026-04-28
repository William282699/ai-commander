// ============================================================
// AI Commander — Event Detection & Auto-Report (Day 16A)
// Reads state each frame, detects notable events, pushes
// ReportEvent entries into state.reportEvents for the UI to drain.
// ============================================================

import type { GameState, ReportEvent, ReportEventType, Front } from "@ai-commander/shared";

// --- Module-level snapshot state (reset on new game) ---

let prevUnitHp = new Map<number, number>();
let prevFacilityTeams = new Map<string, string>();
let prevFacilityHp = new Map<string, number>();
let prevPlayerHQHp: number | null = null;
let cooldowns = new Map<string, number>();
let reportedHeavyLoss = new Set<string>();
let missionProgressSnapshot = new Map<string, { progress: number; time: number }>();
let initialized = false;

// --- Reset (must be called on restart / StrictMode remount) ---

export function resetReportSignals(): void {
  prevUnitHp = new Map();
  prevFacilityTeams = new Map();
  prevFacilityHp = new Map();
  prevPlayerHQHp = null;
  cooldowns = new Map();
  reportedHeavyLoss = new Set();
  missionProgressSnapshot = new Map();
  initialized = false;
}

// --- Cooldown helper ---

function canFire(state: GameState, key: string, cooldownSec: number): boolean {
  const last = cooldowns.get(key) ?? -Infinity;
  if (state.time - last < cooldownSec) return false;
  cooldowns.set(key, state.time);
  return true;
}

// --- Emit helper ---

function emit(
  state: GameState,
  type: ReportEventType,
  message: string,
  severity: "info" | "warning" | "critical",
  entityId?: string,
  actionRequired?: boolean,
): void {
  state.reportEvents.push({ type, time: state.time, message, severity, entityId, actionRequired });
}

// --- Find which front a position belongs to ---

function findFrontForPosition(
  state: GameState,
  x: number,
  y: number,
): Front | null {
  for (const front of state.fronts) {
    for (const regionId of front.regionIds) {
      const region = state.regions.get(regionId);
      if (!region) continue;
      const [x1, y1, x2, y2] = region.bbox;
      if (x >= x1 && x <= x2 && y >= y1 && y <= y2) {
        return front;
      }
    }
  }
  return null;
}

function circleIntersectsRect(
  cx: number,
  cy: number,
  radius: number,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
): boolean {
  const nearestX = Math.max(x1, Math.min(cx, x2));
  const nearestY = Math.max(y1, Math.min(cy, y2));
  const dx = cx - nearestX;
  const dy = cy - nearestY;
  return dx * dx + dy * dy <= radius * radius;
}

// --- Main detection function ---

export function processReportSignals(state: GameState, _dt: number): void {
  // First call: build snapshots only, no events (avoid false alarms on game start)
  if (!initialized) {
    initialized = true;
    buildSnapshots(state);
    return;
  }

  // 1. UNDER_ATTACK (cooldown 30s, aggregated by front)
  detectUnderAttack(state);

  // 2. SUPPLY_LOW (cooldown 60s)
  detectSupplyLow(state);

  // 3. FACILITY_CAPTURED / FACILITY_LOST (event-based, no cooldown)
  detectFacilityChanges(state);

  // 3.5. FACILITY_CONTESTED (capture-in-progress on a player facility)
  detectFacilityContested(state);

  // 4. MISSION_DONE / MISSION_FAILED (each mission reports once)
  detectMissionStatus(state);

  // 5. HQ_DAMAGED (cooldown 30s)
  detectHQDamaged(state);

  // 6. SQUAD_HEAVY_LOSS (each squad reports once)
  detectSquadHeavyLoss(state);

  // 7. POSITION_CRITICAL (cooldown 60s, actionRequired)
  detectPositionCritical(state);

  // 8. MISSION_STALLED (cooldown 120s, actionRequired)
  detectMissionStalled(state);

  // 9. ECONOMY_SURPLUS (cooldown 120s, report only)
  detectEconomySurplus(state);

  // 10. ECONOMY_REPORT (periodic 120s economy status)
  detectEconomyReport(state);

  // Update snapshots for next frame
  buildSnapshots(state);
}

// --- Snapshot builder ---

function buildSnapshots(state: GameState): void {
  // Unit HP snapshot
  prevUnitHp = new Map();
  state.units.forEach((u) => {
    if (u.team === "player" && u.state !== "dead") {
      prevUnitHp.set(u.id, u.hp);
    }
  });

  // Facility team + hp snapshots
  prevFacilityTeams = new Map();
  prevFacilityHp = new Map();
  state.facilities.forEach((f) => {
    prevFacilityTeams.set(f.id, f.team);
    prevFacilityHp.set(f.id, f.hp);
  });

  // Player HQ hp
  state.facilities.forEach((f) => {
    if (f.type === "headquarters" && f.team === "player") {
      prevPlayerHQHp = f.hp;
    }
  });
}

// --- Detection: UNDER_ATTACK ---

function detectUnderAttack(state: GameState): void {
  // Collect fronts that have units taking damage, AND the squads of those units.
  // The squad annotation in the emitted message lets Chen's prompt (rule [D])
  // recognize victim squads and avoid the self-relief fallacy ("send X to relieve
  // the front X is already dying on").
  const damagedFronts = new Set<string>();
  const damagedSquadsByFront = new Map<string, Set<string>>();

  state.units.forEach((u) => {
    if (u.team !== "player" || u.state === "dead") return;
    const prev = prevUnitHp.get(u.id);
    if (prev === undefined) return; // new unit, no comparison
    if (u.hp < prev) {
      // This unit took damage — find its front
      const front = findFrontForPosition(state, u.position.x, u.position.y);
      if (!front) return;
      damagedFronts.add(front.id);
      const squad = state.squads.find((s) => s.unitIds.includes(u.id));
      if (squad) {
        let set = damagedSquadsByFront.get(front.id);
        if (!set) {
          set = new Set();
          damagedSquadsByFront.set(front.id, set);
        }
        set.add(squad.id);
      }
    }
  });

  for (const frontId of damagedFronts) {
    if (canFire(state, `UNDER_ATTACK:${frontId}`, 15)) {
      const front = state.fronts.find((f) => f.id === frontId);
      const name = front?.name ?? frontId;
      const squadSet = damagedSquadsByFront.get(frontId);
      const squadTag = squadSet && squadSet.size > 0
        ? ` [战斗中: ${Array.from(squadSet).join(",")}]`
        : "";
      emit(state, "UNDER_ATTACK", `${name} 遭到攻击！${squadTag}`, "warning", frontId);
    }
  }
}

// --- Detection: SUPPLY_LOW ---

function detectSupplyLow(state: GameState): void {
  const res = state.economy.player.resources;
  if (res.fuel < 30 && canFire(state, "SUPPLY_LOW:fuel", 60)) {
    emit(state, "SUPPLY_LOW", `燃料告急！(${Math.floor(res.fuel)})`, "warning");
  }
  if (res.ammo < 30 && canFire(state, "SUPPLY_LOW:ammo", 60)) {
    emit(state, "SUPPLY_LOW", `弹药告急！(${Math.floor(res.ammo)})`, "warning");
  }
}

// --- Detection: FACILITY_CAPTURED / FACILITY_LOST ---

function detectFacilityChanges(state: GameState): void {
  state.facilities.forEach((f) => {
    const prevTeam = prevFacilityTeams.get(f.id);
    const prevHp = prevFacilityHp.get(f.id);
    if (prevTeam === undefined) return; // new facility

    // Check for destruction (hp dropped to 0)
    if (prevHp !== undefined && prevHp > 0 && f.hp <= 0) {
      if (prevTeam === "player") {
        emit(state, "FACILITY_LOST", `${f.name} 被摧毁！`, "critical", f.id);
      }
      return;
    }

    // Check for ownership change
    if (f.team !== prevTeam) {
      if (f.team === "player" && prevTeam !== "player") {
        emit(state, "FACILITY_CAPTURED", `夺取设施: ${f.name}`, "info", f.id);
      } else if (f.team !== "player" && prevTeam === "player") {
        emit(state, "FACILITY_LOST", `失去设施: ${f.name}`, "critical", f.id);
      }
    }
  });
}

// --- Detection: FACILITY_CONTESTED ---
// Eager-fire: any non-zero capture progress by an enemy on a player facility
// triggers a warning. Cooldown 30s/facility caps spam during sustained capture.
// If post-playtest noise level is too high (e.g. enemy scouts brushing past),
// raise the floor with a `f.captureProgress > 0.05` gate.

function detectFacilityContested(state: GameState): void {
  state.facilities.forEach((f) => {
    if (f.team !== "player") return;
    if (f.capturingTeam !== "enemy") return;
    if (canFire(state, `FACILITY_CONTESTED:${f.id}`, 30)) {
      const progress = Math.round(f.captureProgress * 100);
      emit(
        state,
        "FACILITY_CONTESTED",
        `${f.name} 正在被夺取！(${progress}%)`,
        "warning",
        f.id,
        true, // actionRequired
      );
    }
  });
}

// --- Detection: MISSION_DONE / MISSION_FAILED ---

function detectMissionStatus(state: GameState): void {
  for (const m of state.missions) {
    if (m.status === "completed" && canFire(state, `MISSION_DONE:${m.id}`, Infinity)) {
      emit(state, "MISSION_DONE", `任务完成: ${m.name}`, "info", m.id);
    }
    if (m.status === "failed" && canFire(state, `MISSION_FAILED:${m.id}`, Infinity)) {
      emit(state, "MISSION_FAILED", `任务失败: ${m.name}`, "warning", m.id);
    }
  }
}

// --- Detection: HQ_DAMAGED ---

function detectHQDamaged(state: GameState): void {
  state.facilities.forEach((f) => {
    if (f.type !== "headquarters" || f.team !== "player") return;
    if (prevPlayerHQHp !== null && f.hp < prevPlayerHQHp) {
      if (canFire(state, "HQ_DAMAGED", 30)) {
        emit(state, "HQ_DAMAGED", `总部遭到攻击！(HP: ${Math.floor(f.hp)}/${f.maxHp})`, "critical");
      }
    }
  });
}

// --- Detection: SQUAD_HEAVY_LOSS ---

function detectSquadHeavyLoss(state: GameState): void {
  for (const sq of state.squads) {
    if (reportedHeavyLoss.has(sq.id)) continue;
    const total = sq.unitIds.length;
    if (total === 0) continue;
    const alive = sq.unitIds.filter((id) => {
      const u = state.units.get(id);
      return u && u.state !== "dead";
    }).length;
    if (alive / total < 0.5) {
      reportedHeavyLoss.add(sq.id);
      emit(
        state,
        "SQUAD_HEAVY_LOSS",
        `${sq.name} 减员严重！(存活 ${alive}/${total})`,
        "warning",
        sq.id,
      );
    }
  }
}

// --- Detection: POSITION_CRITICAL ---
// Front where local playerPower/enemyPower < 0.3 AND actively engaged
// Engagement check: engagementIntensity > 0.3 OR attack_zone battleMarker within front bbox

function detectPositionCritical(state: GameState): void {
  const attackZones = state.battleMarkers.filter((m) => m.type === "attack_zone");

  for (const front of state.fronts) {
    // Local realtime power stats (avoid stale front.playerPower/enemyPower from digest)
    let localPlayerHp = 0;
    let localEnemyHp = 0;
    const counted = new Set<number>();
    for (const regionId of front.regionIds) {
      const region = state.regions.get(regionId);
      if (!region) continue;
      const [x1, y1, x2, y2] = region.bbox;
      state.units.forEach(u => {
        if (u.state === "dead" || u.hp <= 0) return;
        if (counted.has(u.id)) return;
        if (u.position.x >= x1 && u.position.x <= x2 &&
            u.position.y >= y1 && u.position.y <= y2) {
          counted.add(u.id);
          if (u.team === "player") localPlayerHp += u.hp;
          else if (u.team === "enemy") localEnemyHp += u.hp;
        }
      });
    }

    if (localEnemyHp <= 0) continue;
    const ratio = localPlayerHp / localEnemyHp;
    if (ratio >= 0.3) continue;

    // Engagement check: engagementIntensity OR attack_zone circle intersects front bbox
    let engaged = front.engagementIntensity > 0.3;
    if (!engaged && attackZones.length > 0) {
      for (const regionId of front.regionIds) {
        const region = state.regions.get(regionId);
        if (!region) continue;
        const [x1, y1, x2, y2] = region.bbox;
        for (const m of attackZones) {
          const radius = Math.max(0, m.radius ?? 0);
          if (circleIntersectsRect(m.x, m.y, radius, x1, y1, x2, y2)) {
            engaged = true;
            break;
          }
        }
        if (engaged) break;
      }
    }
    if (!engaged) continue;

    if (canFire(state, `POSITION_CRITICAL:${front.id}`, 30)) {
      emit(
        state,
        "POSITION_CRITICAL",
        `${front.name} 即将失守。战力比 ${(ratio * 100).toFixed(0)}%，承受重火力。`,
        "critical",
        front.id,
        true, // actionRequired
      );
    }
  }
}

// --- Detection: MISSION_STALLED ---
// Mission progress hasn't changed in 180s (3 minutes)

function detectMissionStalled(state: GameState): void {
  for (const m of state.missions) {
    if (m.status !== "active") continue;

    const snap = missionProgressSnapshot.get(m.id);
    if (!snap) {
      // First time seeing this mission — record snapshot
      missionProgressSnapshot.set(m.id, { progress: m.progress, time: state.time });
      continue;
    }

    // Update snapshot if progress changed
    if (m.progress !== snap.progress) {
      missionProgressSnapshot.set(m.id, { progress: m.progress, time: state.time });
      continue;
    }

    // Progress unchanged — check if 180s have passed
    if (state.time - snap.time >= 180) {
      if (canFire(state, `MISSION_STALLED:${m.id}`, 120)) {
        emit(
          state,
          "MISSION_STALLED",
          `任务"${m.name}"卡在 ${(m.progress * 100).toFixed(0)}%，三分钟无进展。`,
          "warning",
          m.id,
          true, // actionRequired
        );
      }
    }
  }

  // Clean up completed/failed missions from snapshot
  for (const [id] of missionProgressSnapshot) {
    if (!state.missions.some(m => m.id === id && m.status === "active")) {
      missionProgressSnapshot.delete(id);
    }
  }
}

// --- Detection: ECONOMY_SURPLUS ---
// Money > 500 and no active production queue

function detectEconomySurplus(state: GameState): void {
  const money = state.economy.player.resources.money;
  const queueEmpty = state.productionQueue.player.length === 0;
  if (money > 500 && queueEmpty) {
    if (canFire(state, "ECONOMY_SURPLUS", 120)) {
      emit(
        state,
        "ECONOMY_SURPLUS",
        `$${Math.floor(money)} available, no production queued. Recommend spending.`,
        "info",
        undefined,
        false, // report only, no decision needed
      );
    }
  }
}

// --- Detection: ECONOMY_REPORT ---
// Periodic economy status report every 120s (info, not actionRequired)

function detectEconomyReport(state: GameState): void {
  if (!canFire(state, "ECONOMY_REPORT", 120)) return;

  const res = state.economy.player.resources;
  const queueLen = state.productionQueue.player.length;
  const income = state.economy.player.baseIncome.money + state.economy.player.bonusIncome.money;
  emit(
    state,
    "ECONOMY_REPORT",
    `经济概况: $${Math.floor(res.money)} | 燃料${Math.floor(res.fuel)} | 弹药${Math.floor(res.ammo)} | 收入$${Math.floor(income)}/30s | 生产队列${queueLen}`,
    "info",
    undefined,
    false,
  );
}

// --- Drain helper (UI calls this to consume events) ---

export function drainReportEvents(state: GameState, maxN = 10): ReportEvent[] {
  return state.reportEvents.splice(0, maxN);
}
