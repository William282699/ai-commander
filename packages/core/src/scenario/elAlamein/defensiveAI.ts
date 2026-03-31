// ============================================================
// AI Commander — Defensive AI for El Alamein
// Perception-driven + fog-limited strategic AI
// ============================================================

import type { GameState, Unit, Position, Order, UnitType } from "@ai-commander/shared";
import { getUnitCategory } from "@ai-commander/shared";
import { applyEnemyOrders } from "../../applyOrders";
import { canUnitEnterTile } from "../../sim";
import { enqueueProduction } from "../../economy";

// ── Constants ──
const DEFENSIVE_AI_INTERVAL = 5.0;
const MIN_HQ_GUARD = 4;
const GARRISON_RADIUS = 15;
const HQ_GUARD_RADIUS = 20;

// Cooldown durations (seconds)
const P0_COOLDOWN_SEC = 45;
const P1_COOLDOWN_SEC = 30;
const P2_COOLDOWN_SEC = 60;
const TRADE_COOLDOWN_SEC = 60;

// P2 massed offensive thresholds
const P2_MIN_IDLE_BASE = 6;
const P2_IDLE_PER_WAVE = 2;
const P2_COMMIT_RATIO = 0.6;
const P2_MAX_ATTACK = 8; // P1 cap

// Objective → front mapping (H6/H11)
const OBJECTIVE_FRONT_MAP: Record<string, string> = {
  ea_kidney_ridge: "front_ridge",
  ea_miteirya_ridge: "front_ridge",
  ea_alamein_town: "front_coastal",
  ea_himeimat: "front_south",
};

// P2 priority order (H6): deterministic target selection
const P2_OBJECTIVE_PRIORITY = [
  "ea_kidney_ridge",
  "ea_miteirya_ridge",
  "ea_alamein_town",
  "ea_himeimat",
];

// Trade type → resource key (H9)
type TradeTypeNarrow = "buy_fuel" | "buy_ammo";
const TRADE_RESOURCE_KEY: Record<TradeTypeNarrow, "fuel" | "ammo"> = {
  buy_fuel: "fuel",
  buy_ammo: "ammo",
};

// ── Module state ──
let defensiveAITimer = 0;
let offensiveWaveCount = 0;

// Persistent cross-tick: activeAttackerIds + their assigned targets
const activeAttackerIds = new Set<number>();
const attackerTargets = new Map<number, Position>(); // id → target position

// Per-tick (recomputed each runDefensiveAI)
const garrisonIds = new Set<number>();
const hqGuardIds = new Set<number>();
const reserveIds = new Set<number>();

// Cooldown timestamps (state.time based)
const p0Cooldowns = new Map<string, number>(); // per objective
let p1CooldownUntil = 0;
let p2CooldownUntil = 0;
const tradeCooldowns = new Map<TradeTypeNarrow, number>();

// ── Public interface (unchanged) ──

export function resetDefensiveAITimer(): void {
  defensiveAITimer = 0;
  offensiveWaveCount = 0;
  activeAttackerIds.clear();
  attackerTargets.clear();
  garrisonIds.clear();
  hqGuardIds.clear();
  reserveIds.clear();
  p0Cooldowns.clear();
  p1CooldownUntil = 0;
  p2CooldownUntil = 0;
  tradeCooldowns.clear();
}

export function processDefensiveAI(state: GameState, dt: number): void {
  if (state.gameOver) return;
  if (state.enemyAIMode !== "defensive") return;
  defensiveAITimer += dt;
  while (defensiveAITimer >= DEFENSIVE_AI_INTERVAL) {
    defensiveAITimer -= DEFENSIVE_AI_INTERVAL;
    runDefensiveAI(state);
  }
}

// ── Main loop ──

function runDefensiveAI(state: GameState): void {
  // H8: cleanup before role assignment
  cleanupActiveAttackers(state);
  assignRoles(state);
  manageEconomy(state);
  reactiveCounterattack(state);   // P0
  opportunisticAttack(state);     // P1
  massedOffensive(state);         // P2
  garrisonBehavior(state);
  reissueAttackerOrders(state);  // Re-order idle attackers that haven't reached target

  // Debug: role counts + attacker states
  const atkStates = new Map<string, number>();
  for (const id of activeAttackerIds) {
    const u = state.units.get(id);
    const s = u ? u.state : "gone";
    atkStates.set(s, (atkStates.get(s) ?? 0) + 1);
  }
  const atkDetail = [...atkStates.entries()].map(([s, n]) => `${s}:${n}`).join(",") || "none";
  state.diagnostics.push({
    time: state.time, code: "DEFAI_ROLES",
    message: `gar=${garrisonIds.size} hq=${hqGuardIds.size} res=${reserveIds.size} atk=${activeAttackerIds.size} [${atkDetail}]`,
  });
}

// ── Perception: fog-limited vision for AI (H4, H7) ──

function isVisibleToEnemy(state: GameState, target: Position): boolean {
  const tx = Math.floor(target.x);
  const ty = Math.floor(target.y);

  // Check enemy units
  let visible = false;
  state.units.forEach(u => {
    if (visible) return;
    if (u.team !== "enemy" || u.state === "dead" || u.hp <= 0) return;

    let vision = u.visionRange;

    // Forest penalty for ground units (H4)
    if (getUnitCategory(u.type) === "ground") {
      const ux = Math.floor(u.position.x);
      const uy = Math.floor(u.position.y);
      if (ux >= 0 && ux < state.mapWidth && uy >= 0 && uy < state.mapHeight) {
        const terrain = state.terrain[uy][ux];
        if (terrain === "forest") {
          vision = Math.max(1, vision - 2);
        }
      }
    }

    const dx = tx - u.position.x;
    const dy = ty - u.position.y;
    if (dx * dx + dy * dy <= vision * vision) {
      visible = true;
    }
  });
  if (visible) return true;

  // Check enemy facilities (H4)
  state.facilities.forEach(fac => {
    if (visible) return;
    if (fac.team !== "enemy") return;
    if (fac.hp <= 0) return;

    let facVision = 6;
    if (fac.type === "headquarters") facVision = 10;
    if (fac.type === "radar") facVision = 20;

    const fx = Math.floor(fac.position.x);
    const fy = Math.floor(fac.position.y);
    if (fx < 0 || fx >= state.mapWidth || fy < 0 || fy >= state.mapHeight) return;

    const dx = tx - fac.position.x;
    const dy = ty - fac.position.y;
    if (dx * dx + dy * dy <= facVision * facVision) {
      visible = true;
    }
  });
  return visible;
}

// ── Cleanup active attackers (H8) ──

function cleanupActiveAttackers(state: GameState): void {
  const ARRIVAL_RADIUS = 12; // tiles — close enough to target = mission done
  for (const id of activeAttackerIds) {
    const u = state.units.get(id);
    if (!u || u.state === "dead" || u.hp <= 0) {
      activeAttackerIds.delete(id);
      attackerTargets.delete(id);
      continue;
    }
    // Only release idle units that have REACHED their assigned target
    if (u.state === "idle") {
      const tgt = attackerTargets.get(id);
      if (!tgt) {
        // No target recorded (shouldn't happen), release
        activeAttackerIds.delete(id);
        continue;
      }
      const dx = u.position.x - tgt.x;
      const dy = u.position.y - tgt.y;
      if (dx * dx + dy * dy <= ARRIVAL_RADIUS * ARRIVAL_RADIUS) {
        // Arrived at target — mission complete, release
        activeAttackerIds.delete(id);
        attackerTargets.delete(id);
      }
      // Otherwise: idle but not at target — keep as attacker, will be re-ordered
    }
  }
}

// ── Role assignment (H5, H8, H10) ──

function assignRoles(state: GameState): void {
  garrisonIds.clear();
  hqGuardIds.clear();
  reserveIds.clear();

  // Collect objective positions
  const objectivePositions: Position[] = [];
  const objectives = state.captureObjectives ?? [];
  for (const objId of objectives) {
    const fac = state.facilities.get(objId);
    if (fac && fac.team === "enemy") {
      objectivePositions.push(fac.position);
    }
  }

  // Find enemy HQ position
  let hqPos: Position | null = null;
  state.facilities.forEach(f => {
    if (f.type === "headquarters" && f.team === "enemy") hqPos = f.position;
  });

  // Candidates for hqGuard: collect then sort deterministically (H10)
  const hqCandidates: { id: number; distSq: number }[] = [];

  state.units.forEach(u => {
    if (u.team !== "enemy" || u.state === "dead" || u.hp <= 0) return;
    if (getUnitCategory(u.type) !== "ground") return;
    if (u.type === "commander") return;

    // Active attackers keep their role
    if (activeAttackerIds.has(u.id)) return;

    // Check garrison: within GARRISON_RADIUS of any enemy objective
    let isGarrison = false;
    for (const objPos of objectivePositions) {
      const dx = u.position.x - objPos.x;
      const dy = u.position.y - objPos.y;
      if (dx * dx + dy * dy <= GARRISON_RADIUS * GARRISON_RADIUS) {
        isGarrison = true;
        break;
      }
    }
    if (isGarrison) {
      garrisonIds.add(u.id);
      return;
    }

    // Check HQ guard candidate
    if (hqPos) {
      const dx = u.position.x - hqPos.x;
      const dy = u.position.y - hqPos.y;
      const distSq = dx * dx + dy * dy;
      if (distSq <= HQ_GUARD_RADIUS * HQ_GUARD_RADIUS) {
        hqCandidates.push({ id: u.id, distSq });
        return; // handled below
      }
    }

    // Everything else is reserve
    reserveIds.add(u.id);
  });

  // H10: deterministic hqGuard selection
  hqCandidates.sort((a, b) => {
    if (a.distSq !== b.distSq) return a.distSq - b.distSq;
    return a.id - b.id;
  });
  for (let i = 0; i < hqCandidates.length; i++) {
    if (i < MIN_HQ_GUARD) {
      hqGuardIds.add(hqCandidates[i].id);
    } else {
      reserveIds.add(hqCandidates[i].id);
    }
  }
}

// ── Economy management (H3, H9) ──

function manageEconomy(state: GameState): void {
  const eco = state.economy.enemy;
  const money = eco.resources.money;
  const fuel = eco.resources.fuel;
  const ammo = eco.resources.ammo;

  // Buy fuel when low
  if (fuel < 80 && money >= 300) {
    tryTrade(state, "buy_fuel", TRADE_COOLDOWN_SEC);
  }
  // Buy ammo when low
  if (ammo < 50 && money >= 300) {
    tryTrade(state, "buy_ammo", TRADE_COOLDOWN_SEC);
  }

  // Production
  if (state.productionQueue.enemy.length >= 4) return;

  // Fuel-aware unit selection
  const roll = Math.random();
  if (fuel < 30) {
    // Only infantry when fuel critically low
    if (money >= 100) enqueueProduction(state, "enemy", "infantry");
  } else if (roll < 0.7 && money >= 100) {
    enqueueProduction(state, "enemy", "infantry");
  } else if (roll < 0.9 && money >= 250) {
    enqueueProduction(state, "enemy", "light_tank");
  } else if (money >= 500) {
    enqueueProduction(state, "enemy", "main_tank");
  } else if (money >= 100) {
    enqueueProduction(state, "enemy", "infantry");
  }
}

function tryTrade(state: GameState, tradeType: TradeTypeNarrow, cooldownSec: number): void {
  // Check cooldown — skip check on first invocation (no entry = never traded)
  if (tradeCooldowns.has(tradeType)) {
    if (state.time - tradeCooldowns.get(tradeType)! < cooldownSec) return;
  }

  const resourceKey = TRADE_RESOURCE_KEY[tradeType];
  const before = state.economy.enemy.resources[resourceKey];

  applyEnemyOrders(state, [{
    unitIds: [],
    action: "trade",
    target: null,
    priority: "high",
    tradeType,
  }]);

  const after = state.economy.enemy.resources[resourceKey];
  // H3: only record cooldown on success
  if (after > before) {
    tradeCooldowns.set(tradeType, state.time);
  }
}

// ── P0: Reactive counterattack ──

function reactiveCounterattack(state: GameState): void {
  const objectives = state.captureObjectives ?? [];
  for (const objId of objectives) {
    const fac = state.facilities.get(objId);
    if (!fac) continue;

    // Trigger: objective captured or being captured by player
    const underThreat = fac.capturingTeam === "player" || fac.team === "player";
    if (!underThreat) continue;

    // Check cooldown per objective — skip check on first invocation
    if (p0Cooldowns.has(objId)) {
      if (state.time - p0Cooldowns.get(objId)! < P0_COOLDOWN_SEC) continue;
    }

    // Send 4-6 reserves to counterattack
    const reserves = getReserveUnitsNear(state, fac.position, 80);
    if (reserves.length === 0) continue;

    const attackers = reserves.slice(0, Math.min(6, Math.max(4, reserves.length)));
    const ids = attackers.map(u => u.id);

    const dispatch = applyEnemyOrders(state, [{
      unitIds: ids,
      action: "attack_move",
      target: { x: fac.position.x, y: fac.position.y },
      priority: "high",
    }]);

    const applied = dispatch.appliedPerOrder[0] ?? 0;
    if (applied === 0) continue; // dispatch failed, don't commit

    // Track as active attackers with target
    const p0Target = { x: fac.position.x, y: fac.position.y };
    for (const id of ids) {
      activeAttackerIds.add(id);
      attackerTargets.set(id, p0Target);
      reserveIds.delete(id);
    }
    p0Cooldowns.set(objId, state.time);
    state.diagnostics.push({
      time: state.time, code: "DEFAI_DBG",
      message: `P0 counterattack obj=${objId} atk=${applied}/${ids.length}`,
    });
  }
}

// ── P1: Opportunistic attack ──

function opportunisticAttack(state: GameState): void {
  if (state.time < 60) return; // grace period
  if (state.time < p1CooldownUntil) return;

  // Scan each front for visible weakness
  for (const front of state.fronts) {
    if (front.id === "front_axis_rear") continue;

    // Count visible player HP in this front
    let visiblePlayerHp = 0;
    let enemyHp = 0;
    const counted = new Set<number>();

    for (const regionId of front.regionIds) {
      const region = state.regions.get(regionId);
      if (!region) continue;
      const [x1, y1, x2, y2] = region.bbox;

      state.units.forEach(u => {
        if (u.state === "dead" || u.hp <= 0) return;
        if (counted.has(u.id)) return;
        if (u.position.x < x1 || u.position.x > x2 ||
            u.position.y < y1 || u.position.y > y2) return;
        counted.add(u.id);

        if (u.team === "player") {
          // Only count visible player units (H7)
          if (isVisibleToEnemy(state, u.position)) {
            visiblePlayerHp += u.hp;
          }
        } else if (u.team === "enemy") {
          enemyHp += u.hp;
        }
      });
    }

    // Condition: visible player HP < 50% of our HP in the area
    if (visiblePlayerHp <= 0 || enemyHp <= 0) continue;
    if (visiblePlayerHp >= enemyHp * 0.5) continue;

    // Found weakness — send nearby reserves, up to P2_MAX_ATTACK
    const frontCenter = getFrontCenter(state, front);
    if (!frontCenter) continue;

    const reserves = getReserveUnitsNear(state, frontCenter, 100);
    if (reserves.length === 0) continue;

    const attackers = reserves.slice(0, Math.min(P2_MAX_ATTACK, reserves.length));
    const leadType = getLeadType(attackers);
    const targetPos = getTargetPosition(state, front, leadType);
    const ids = attackers.map(u => u.id);

    const dispatch = applyEnemyOrders(state, [{
      unitIds: ids,
      action: "attack_move",
      target: targetPos,
      priority: "high",
    }]);

    const applied = dispatch.appliedPerOrder[0] ?? 0;
    if (applied === 0) continue; // dispatch failed, try next front

    for (const id of ids) {
      activeAttackerIds.add(id);
      attackerTargets.set(id, targetPos);
      reserveIds.delete(id);
    }

    p1CooldownUntil = state.time + P1_COOLDOWN_SEC;
    state.diagnostics.push({
      time: state.time, code: "DEFAI_DBG",
      message: `P1 opp-attack front=${front.id} atk=${applied}/${ids.length} visHP=${visiblePlayerHp.toFixed(0)} eHP=${enemyHp.toFixed(0)}`,
    });
    return; // one attack per tick
  }
}

// ── P2: Massed offensive ──

function massedOffensive(state: GameState): void {
  if (state.time < 60) return;
  if (state.time < p2CooldownUntil) return;

  // Count idle reserves
  let idleReserves = 0;
  const idleReserveUnits: Unit[] = [];
  for (const id of reserveIds) {
    const u = state.units.get(id);
    if (!u || u.state === "dead" || u.hp <= 0) continue;
    if (u.state === "idle" || u.state === "defending" || u.state === "patrolling") {
      idleReserves++;
      idleReserveUnits.push(u);
    }
  }

  const threshold = P2_MIN_IDLE_BASE + P2_IDLE_PER_WAVE * offensiveWaveCount;
  if (idleReserves < threshold) return;

  // Sort deterministically: light_tank > main_tank > infantry, then HP desc, then id asc
  const typePriority: Record<string, number> = { light_tank: 0, main_tank: 1, infantry: 2 };
  idleReserveUnits.sort((a, b) => {
    const pa = typePriority[a.type] ?? 3;
    const pb = typePriority[b.type] ?? 3;
    if (pa !== pb) return pa - pb;
    if (b.hp !== a.hp) return b.hp - a.hp;
    return a.id - b.id;
  });

  // Fuel-aware filtering
  const enemyFuel = state.economy.enemy.resources.fuel;
  let pool: Unit[];
  if (enemyFuel < 30) {
    pool = idleReserveUnits.filter(u => u.type === "infantry");
  } else {
    pool = [...idleReserveUnits];
  }

  const commitCount = Math.ceil(pool.length * P2_COMMIT_RATIO);
  if (commitCount < 4) return; // not enough even after fuel filter

  const attackers = pool.slice(0, commitCount);

  // Target selection: prefer visible weakest front; if all invisible, H6 deterministic
  const targetFront = selectP2Target(state);
  if (!targetFront) return; // H11: all mappings failed, skip

  const leadType = getLeadType(attackers);
  const targetPos = getTargetPosition(state, targetFront, leadType);
  const ids = attackers.map(u => u.id);

  const dispatch = applyEnemyOrders(state, [{
    unitIds: ids,
    action: "attack_move",
    target: targetPos,
    priority: "high",
  }]);

  const applied = dispatch.appliedPerOrder[0] ?? 0;
  if (applied === 0) return; // dispatch failed, don't commit wave

  for (const id of ids) {
    activeAttackerIds.add(id);
    attackerTargets.set(id, targetPos);
    reserveIds.delete(id);
  }

  offensiveWaveCount++;
  p2CooldownUntil = state.time + P2_COOLDOWN_SEC;

  state.diagnostics.push({
    time: state.time, code: "DEFAI_DBG",
    message: `P2 massed wave=${offensiveWaveCount} atk=${applied}/${ids.length} tgt=(${targetPos.x},${targetPos.y}) front=${targetFront.id}`,
  });
}

function selectP2Target(state: GameState): typeof state.fronts[0] | null {
  // Try visible fronts: find weakest visible player presence
  type FrontInfo = { front: typeof state.fronts[0]; visibleHp: number };
  const visibleFronts: FrontInfo[] = [];

  for (const front of state.fronts) {
    if (front.id === "front_axis_rear") continue;

    let visibleHp = 0;
    const counted = new Set<number>();
    for (const regionId of front.regionIds) {
      const region = state.regions.get(regionId);
      if (!region) continue;
      const [x1, y1, x2, y2] = region.bbox;
      state.units.forEach(u => {
        if (u.team !== "player" || u.state === "dead" || u.hp <= 0) return;
        if (counted.has(u.id)) return;
        if (u.position.x < x1 || u.position.x > x2 ||
            u.position.y < y1 || u.position.y > y2) return;
        counted.add(u.id);
        if (isVisibleToEnemy(state, u.position)) {
          visibleHp += u.hp;
        }
      });
    }

    if (visibleHp > 0) {
      visibleFronts.push({ front, visibleHp });
    }
  }

  if (visibleFronts.length > 0) {
    // Attack weakest visible front
    visibleFronts.sort((a, b) => a.visibleHp - b.visibleHp);
    return visibleFronts[0].front;
  }

  // H6: all fronts invisible → deterministic objective priority
  for (const objId of P2_OBJECTIVE_PRIORITY) {
    const frontId = OBJECTIVE_FRONT_MAP[objId];
    if (!frontId || frontId === "front_axis_rear") continue;
    const front = state.fronts.find(f => f.id === frontId);
    if (front) return front;
  }
  return null; // H11: all failed, skip this tick
}

// ── Garrison behavior ──

function garrisonBehavior(state: GameState): void {
  const defendOrders: Order[] = [];

  // Garrison units: defend at position
  for (const id of garrisonIds) {
    const u = state.units.get(id);
    if (!u || u.state === "dead" || u.hp <= 0) continue;
    if (u.state === "idle") {
      defendOrders.push({
        unitIds: [u.id],
        action: "defend",
        target: null,
        priority: "low",
      });
    }
  }

  // HQ guards: defend at position
  for (const id of hqGuardIds) {
    const u = state.units.get(id);
    if (!u || u.state === "dead" || u.hp <= 0) continue;
    if (u.state === "idle") {
      defendOrders.push({
        unitIds: [u.id],
        action: "defend",
        target: null,
        priority: "low",
      });
    }
  }

  // Idle reserves: defend
  for (const id of reserveIds) {
    const u = state.units.get(id);
    if (!u || u.state === "dead" || u.hp <= 0) continue;
    if (u.state === "idle") {
      defendOrders.push({
        unitIds: [u.id],
        action: "defend",
        target: null,
        priority: "low",
      });
    }
  }

  if (defendOrders.length > 0) {
    applyEnemyOrders(state, defendOrders);
  }
}

// ── Re-issue orders to idle active attackers ──

function reissueAttackerOrders(state: GameState): void {
  const reorderIds: number[] = [];
  const targetGroups = new Map<string, { target: Position; ids: number[] }>();

  for (const id of activeAttackerIds) {
    const u = state.units.get(id);
    if (!u || u.state === "dead" || u.hp <= 0) continue;
    if (u.state !== "idle") continue; // still moving/fighting, leave alone

    const tgt = attackerTargets.get(id);
    if (!tgt) continue;

    // Group by target for batch orders
    const key = `${tgt.x},${tgt.y}`;
    let group = targetGroups.get(key);
    if (!group) {
      group = { target: tgt, ids: [] };
      targetGroups.set(key, group);
    }
    group.ids.push(id);
  }

  // Re-issue attack_move for each group
  for (const [, group] of targetGroups) {
    state.diagnostics.push({
      time: state.time, code: "DEFAI_REISSUE",
      message: `reissue ${group.ids.length} units → (${group.target.x},${group.target.y})`,
    });
    applyEnemyOrders(state, [{
      unitIds: group.ids,
      action: "attack_move",
      target: { x: group.target.x, y: group.target.y },
      priority: "high",
    }]);
  }
}

// ── Helpers ──

function getReserveUnitsNear(state: GameState, pos: Position, radius: number): Unit[] {
  const units: Unit[] = [];
  for (const id of reserveIds) {
    const u = state.units.get(id);
    if (!u || u.state === "dead" || u.hp <= 0) continue;
    if (u.state !== "idle" && u.state !== "defending" && u.state !== "patrolling") continue;
    const dx = u.position.x - pos.x;
    const dy = u.position.y - pos.y;
    if (dx * dx + dy * dy <= radius * radius) {
      units.push(u);
    }
  }
  // Sort: HP descending, id ascending for stability
  units.sort((a, b) => {
    if (b.hp !== a.hp) return b.hp - a.hp;
    return a.id - b.id;
  });
  return units;
}

function getFrontCenter(state: GameState, front: typeof state.fronts[0]): Position | null {
  let totalX = 0, totalY = 0, count = 0;
  for (const regionId of front.regionIds) {
    const region = state.regions.get(regionId);
    if (!region) continue;
    const [x1, y1, x2, y2] = region.bbox;
    totalX += (x1 + x2) / 2;
    totalY += (y1 + y2) / 2;
    count++;
  }
  if (count === 0) return null;
  return { x: totalX / count, y: totalY / count };
}

function getLeadType(units: Unit[]): UnitType {
  const counts = new Map<UnitType, number>();
  for (const u of units) {
    counts.set(u.type, (counts.get(u.type) ?? 0) + 1);
  }
  let best: UnitType = "infantry";
  let bestCount = 0;
  for (const [type, count] of counts) {
    if (count > bestCount) { best = type; bestCount = count; }
  }
  return best;
}

// Pre-defined attack waypoints that avoid the minefield (Devil's Gardens bbox 248-315, 38-125).
// AI must go around it: north via coastal highway or south via desert.
const ATTACK_WAYPOINTS: Record<string, { x: number; y: number }> = {
  front_coastal: { x: 380, y: 35 },   // North: along Via Balbia toward player HQ
  front_ridge:   { x: 370, y: 30 },    // Ridge forces go north around minefield
  front_center:  { x: 370, y: 150 },   // Center: south of minefield
  front_south:   { x: 380, y: 200 },   // South: through open desert
};

function getTargetPosition(
  state: GameState,
  front: typeof state.fronts[0],
  leadType: UnitType,
): { x: number; y: number } {
  // 1. If there are visible player units anywhere, target the nearest one
  const visibleTargets: { x: number; y: number; hp: number }[] = [];
  state.units.forEach(u => {
    if (u.team !== "player" || u.state === "dead" || u.hp <= 0) return;
    if (isVisibleToEnemy(state, u.position)) {
      visibleTargets.push({ x: u.position.x, y: u.position.y, hp: u.hp });
    }
  });

  if (visibleTargets.length > 0) {
    // Target weakest visible player unit
    visibleTargets.sort((a, b) => a.hp - b.hp);
    const t = visibleTargets[0];
    const tx = Math.floor(t.x);
    const ty = Math.floor(t.y);
    // Find passable tile near target
    for (let r = 0; r <= 5; r++) {
      for (let dx = -r; dx <= r; dx++) {
        for (let dy = -r; dy <= r; dy++) {
          if (Math.abs(dx) === r || Math.abs(dy) === r) {
            if (canUnitEnterTile(leadType, tx + dx, ty + dy, state)) {
              return { x: tx + dx, y: ty + dy };
            }
          }
        }
      }
    }
  }

  // 2. No visible targets — use pre-defined waypoints that bypass the minefield
  const waypoint = ATTACK_WAYPOINTS[front.id];
  if (waypoint) {
    // Find passable tile near waypoint
    for (let r = 0; r <= 10; r++) {
      for (let dx = -r; dx <= r; dx++) {
        for (let dy = -r; dy <= r; dy++) {
          if (Math.abs(dx) === r || Math.abs(dy) === r) {
            if (canUnitEnterTile(leadType, waypoint.x + dx, waypoint.y + dy, state)) {
              return { x: waypoint.x + dx, y: waypoint.y + dy };
            }
          }
        }
      }
    }
  }

  // 3. Ultimate fallback: player HQ area
  let bestDist = Infinity;
  let bestPos = { x: 400, y: 88 };
  state.facilities.forEach(f => {
    if (f.team !== "player") return;
    const d = Math.hypot(f.position.x - 100, f.position.y - 100);
    if (d < bestDist) {
      bestDist = d;
      bestPos = { x: f.position.x, y: f.position.y };
    }
  });
  return bestPos;
}
