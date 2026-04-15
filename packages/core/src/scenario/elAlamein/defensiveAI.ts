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
const MIN_HQ_GUARD = 3;  // v3: was 4, free up 1 for attacks
const GARRISON_RADIUS = 15;
const HQ_GUARD_RADIUS = 20;

// Cooldown durations (seconds)
const P0_COOLDOWN_SEC = 45;
const P1_COOLDOWN_SEC = 20;   // §4: was 30
const P2_COOLDOWN_SEC = 50;   // §4: was 60
const TRADE_COOLDOWN_SEC = 60;

// P2 massed offensive thresholds
const P2_MIN_IDLE_BASE = 5;   // §4: was 6
const P2_IDLE_PER_WAVE = 1;   // §4: was 2
const P2_COMMIT_RATIO = 0.75;  // v3: was 0.6, commit more reserves
const P2_MAX_ATTACK = 8; // P1 cap

// §3: P3 Proactive Probe
const PROBE_START_TIME = 60;          // First probe at 60s
const PROBE_INTERVAL_BASE = 60;       // Base interval between probes (seconds)
const PROBE_INTERVAL_VARIANCE = 20;   // +/-20s randomness
const PROBE_MIN_UNITS = 3;
const PROBE_MAX_UNITS = 6;            // v3: was 5
const PROBE_MIN_FUEL = 50;            // Don't probe when fuel is critical
const MAX_ACTIVE_ATTACKERS = 24;      // v3: was 12 — P1/P3 soft cap
const MAX_ACTIVE_ATTACKERS_HARD = 32; // v3: P2 only — massed offensive hard cap
const TACTICAL_DEVIATION_MAX = 25;    // v3: max deviation tiles for visible-enemy targeting

// §9: Diagnostics cap
const MAX_DIAGNOSTICS = 200;

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

// §9: Unified diagnostic helper with cap
function pushDiagnostic(state: GameState, message: string): void {
  if (state.diagnostics.length >= MAX_DIAGNOSTICS) {
    state.diagnostics.splice(0, state.diagnostics.length - MAX_DIAGNOSTICS + 1);
  }
  state.diagnostics.push({
    time: state.time,
    code: "DEFAI_DBG",
    message,
  });
}

// ── Module state ──
let defensiveAITimer = 0;
let offensiveWaveCount = 0;

// Persistent cross-tick: activeAttackerIds + their assigned targets + remaining route
const activeAttackerIds = new Set<number>();
const attackerTargets = new Map<number, Position>();     // id → final target
const attackerWaypoints = new Map<number, Position[]>(); // id → remaining corridor waypoints

// Per-tick (recomputed each runDefensiveAI)
const garrisonIds = new Set<number>();
const hqGuardIds = new Set<number>();
const reserveIds = new Set<number>();

// §6: Units in transit to reinforce garrisons. Excluded from reserve selection.
const reinforcingIds = new Set<number>();

// §3: Probe state
let probeCooldownUntil = 0;
let probeCount = 0;

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
  attackerWaypoints.clear();
  garrisonIds.clear();
  hqGuardIds.clear();
  reserveIds.clear();
  p0Cooldowns.clear();
  p1CooldownUntil = 0;
  p2CooldownUntil = 0;
  tradeCooldowns.clear();
  reinforcingIds.clear();   // §6
  probeCooldownUntil = 0;   // §3
  probeCount = 0;           // §3
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
  proactiveProbe(state);          // P3 (§3)
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
  pushDiagnostic(state,
    `gar=${garrisonIds.size} hq=${hqGuardIds.size} res=${reserveIds.size} atk=${activeAttackerIds.size} [${atkDetail}]`
  );
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
  const ARRIVAL_RADIUS = 12;
  const RETREAT_HP_RATIO = 0.35;  // §5: Retreat at 35% HP

  for (const id of activeAttackerIds) {
    const u = state.units.get(id);
    if (!u || u.state === "dead" || u.hp <= 0) {
      activeAttackerIds.delete(id);
      attackerTargets.delete(id);
      attackerWaypoints.delete(id);
      continue;
    }

    // §5: Retreat badly damaged attackers
    if (u.hp / u.maxHp < RETREAT_HP_RATIO && u.state !== "retreating") {
      const retreatTarget = findSafeRetreatPosition(state, u.position);
      if (retreatTarget) {
        applyEnemyOrders(state, [{
          unitIds: [id],
          action: "retreat",
          target: retreatTarget,
          priority: "high",
        }]);
      }
      activeAttackerIds.delete(id);
      attackerTargets.delete(id);
      attackerWaypoints.delete(id);
      continue;
    }

    // Release idle units that reached FINAL target (not intermediate waypoints)
    if (u.state === "idle") {
      const tgt = attackerTargets.get(id);
      if (!tgt) {
        activeAttackerIds.delete(id);
        attackerWaypoints.delete(id);
        continue;
      }
      const dx = u.position.x - tgt.x;
      const dy = u.position.y - tgt.y;
      if (dx * dx + dy * dy <= ARRIVAL_RADIUS * ARRIVAL_RADIUS) {
        activeAttackerIds.delete(id);
        attackerTargets.delete(id);
        attackerWaypoints.delete(id);
      }
      // Otherwise: idle but not at final target — reissueAttackerOrders will handle
    }
  }
}

// ── Role assignment (H5, H8, H10) ──

function assignRoles(state: GameState): void {
  garrisonIds.clear();
  hqGuardIds.clear();
  reserveIds.clear();

  // §6: Clean up reinforcingIds: remove dead/arrived units
  for (const id of reinforcingIds) {
    const u = state.units.get(id);
    if (!u || u.state === "dead" || u.hp <= 0) {
      reinforcingIds.delete(id);
      continue;
    }
    // Check if arrived at any garrison objective
    for (const objId of (state.captureObjectives ?? [])) {
      const fac = state.facilities.get(objId);
      if (!fac || fac.team !== "enemy") continue;
      const dx = u.position.x - fac.position.x;
      const dy = u.position.y - fac.position.y;
      if (dx * dx + dy * dy <= GARRISON_RADIUS * GARRISON_RADIUS) {
        reinforcingIds.delete(id); // Arrived — will be assigned as garrison naturally
        break;
      }
    }
  }

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

    // Active attackers and reinforcing units keep their role
    if (activeAttackerIds.has(u.id)) return;
    if (reinforcingIds.has(u.id)) return;  // §6

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

  // §1: Buy resources when low (raised thresholds)
  if (fuel < 120 && money >= 300) {
    tryTrade(state, "buy_fuel", TRADE_COOLDOWN_SEC);
  }
  if (ammo < 80 && money >= 300) {
    tryTrade(state, "buy_ammo", TRADE_COOLDOWN_SEC);
  }

  // §7: Production — keep at 4 queued (NOT 6, avoids resource lock)
  if (state.productionQueue.enemy.length >= 4) return;

  // Count existing unit types for balance
  let tankCount = 0;
  let infantryCount = 0;
  state.units.forEach(u => {
    if (u.team !== "enemy" || u.state === "dead" || u.hp <= 0) return;
    if (u.type === "main_tank" || u.type === "light_tank") tankCount++;
    if (u.type === "infantry") infantryCount++;
  });

  // Maintain ~3:1 infantry:tank ratio
  const needsTanks = tankCount < infantryCount / 3;

  if (fuel < 30) {
    // Only infantry when fuel critically low (foot units = 0 fuel)
    if (money >= 100) enqueueProduction(state, "enemy", "infantry");
  } else if (needsTanks && money >= 250) {
    // Prioritize tanks if ratio is off
    enqueueProduction(state, "enemy", money >= 500 ? "main_tank" : "light_tank");
  } else {
    const roll = Math.random();
    if (roll < 0.6 && money >= 100) {
      enqueueProduction(state, "enemy", "infantry");
    } else if (roll < 0.85 && money >= 250) {
      enqueueProduction(state, "enemy", "light_tank");
    } else if (money >= 500) {
      enqueueProduction(state, "enemy", "main_tank");
    } else if (money >= 100) {
      enqueueProduction(state, "enemy", "infantry");
    }
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
    pushDiagnostic(state, `P0 counterattack obj=${objId} atk=${applied}/${ids.length}`);
  }
}

// ── P1: Opportunistic attack ──

function opportunisticAttack(state: GameState): void {
  if (state.time < 60) return; // grace period
  if (state.time < p1CooldownUntil) return;
  if (activeAttackerIds.size >= MAX_ACTIVE_ATTACKERS) return;  // §4: global cap

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

    // §4: Condition: visible player HP < 65% of our HP in the area (was 50%)
    if (visiblePlayerHp <= 0 || enemyHp <= 0) continue;
    if (visiblePlayerHp >= enemyHp * 0.65) continue;

    // Found weakness — send nearby reserves, up to P2_MAX_ATTACK
    const frontCenter = getFrontCenter(state, front);
    if (!frontCenter) continue;

    const reserves = getReserveUnitsNear(state, frontCenter, 100);
    if (reserves.length === 0) continue;

    const p1Budget = MAX_ACTIVE_ATTACKERS - activeAttackerIds.size;
    const attackers = reserves.slice(0, Math.min(P2_MAX_ATTACK, reserves.length, p1Budget));
    if (attackers.length === 0) continue;
    const leadType = getLeadType(attackers);
    const { target: finalTarget, corridor } = getTargetPosition(state, front, leadType);
    const applied = dispatchAttack(state, attackers, finalTarget, corridor, "high");
    if (applied === 0) continue;

    p1CooldownUntil = state.time + P1_COOLDOWN_SEC;
    pushDiagnostic(state,
      `P1 opp-attack front=${front.id} atk=${applied} tgt=(${finalTarget.x},${finalTarget.y})`
    );
    return; // one attack per tick
  }
}

// ── P2: Massed offensive ──

function massedOffensive(state: GameState): void {
  if (state.time < 60) return;
  if (state.time < p2CooldownUntil) return;
  if (activeAttackerIds.size >= MAX_ACTIVE_ATTACKERS_HARD) return;  // v3: P2 uses hard cap (32)

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

  // v3: P2 uses HARD cap budget (32) — massed offensive should feel massive
  const budget = MAX_ACTIVE_ATTACKERS_HARD - activeAttackerIds.size;
  const commitCount = Math.min(Math.ceil(pool.length * P2_COMMIT_RATIO), budget);
  if (commitCount < 4) return; // not enough even after fuel filter

  const attackers = pool.slice(0, commitCount);

  // Target selection: prefer visible weakest front; if all invisible, H6 deterministic
  const targetFront = selectP2Target(state);
  if (!targetFront) return; // H11: all mappings failed, skip

  const leadType = getLeadType(attackers);
  const { target: finalTarget, corridor } = getTargetPosition(state, targetFront, leadType);
  const applied = dispatchAttack(state, attackers, finalTarget, corridor, "high");
  if (applied === 0) return;

  offensiveWaveCount++;
  p2CooldownUntil = state.time + P2_COOLDOWN_SEC;

  pushDiagnostic(state,
    `P2 massed wave=${offensiveWaveCount} atk=${applied}/${attackers.length} tgt=(${finalTarget.x},${finalTarget.y}) front=${targetFront.id}`
  );
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

  // §6: Reinforce depleted garrisons
  const objectives = state.captureObjectives ?? [];
  for (const objId of objectives) {
    const fac = state.facilities.get(objId);
    if (!fac || fac.team !== "enemy") continue;

    // Count garrison units near this objective
    let garrisonCount = 0;
    for (const id of garrisonIds) {
      const u = state.units.get(id);
      if (!u || u.state === "dead" || u.hp <= 0) continue;
      const dx = u.position.x - fac.position.x;
      const dy = u.position.y - fac.position.y;
      if (dx * dx + dy * dy <= GARRISON_RADIUS * GARRISON_RADIUS) {
        garrisonCount++;
      }
    }

    // Also count incoming reinforcements
    for (const _id of reinforcingIds) {
      garrisonCount++; // Count them even if not arrived yet — avoid double-sending
    }

    if (garrisonCount >= 2) continue; // Garrison is healthy

    // Search for reserves: local first, then global fallback
    let reserves = getReserveUnitsNear(state, fac.position, 120);
    if (reserves.length === 0) {
      reserves = getReserveUnitsNear(state, fac.position, 9999);
    }

    const reinforcements = reserves.slice(0, Math.min(3, reserves.length));
    if (reinforcements.length === 0) continue;

    const ids = reinforcements.map(u => u.id);
    applyEnemyOrders(state, [{
      unitIds: ids,
      action: "attack_move",
      target: { x: fac.position.x, y: fac.position.y },
      priority: "medium",
    }]);

    // Lock these units
    for (const id of ids) {
      reinforcingIds.add(id);
      reserveIds.delete(id);
    }

    pushDiagnostic(state, `Garrison reinforce obj=${objId} sent=${ids.length}`);
  }
}

// ── Re-issue orders to idle active attackers ──

function reissueAttackerOrders(state: GameState): void {
  for (const id of activeAttackerIds) {
    const u = state.units.get(id);
    if (!u || u.state === "dead" || u.hp <= 0) continue;
    if (u.state !== "idle") continue; // still moving/fighting

    const storedTarget = attackerTargets.get(id);
    const remainingWps = attackerWaypoints.get(id);

    // ── Phase 1: If corridor waypoints remain, continue the route ──
    if (remainingWps && remainingWps.length > 0) {
      // Drop waypoints we've already passed (x ≤ unit.x)
      while (remainingWps.length > 0 && remainingWps[0].x <= u.position.x) {
        remainingWps.shift();
      }

      if (remainingWps.length > 0 || storedTarget) {
        const target = storedTarget ?? remainingWps[remainingWps.length - 1];
        const wps = [...remainingWps, target];

        // Skip reissue if already targeting same position (avoid spam)
        if (u.target && Math.abs(u.target.x - target.x) < 2 && Math.abs(u.target.y - target.y) < 2) {
          continue;
        }

        applyEnemyOrders(state, [{
          unitIds: [id],
          action: "attack_move",
          target,
          waypoints: wps,
          priority: "high",
        }]);
        continue;
      }
    }

    // ── Phase 2: Corridor exhausted — search for nearest visible enemy ──
    let nearestEnemy: { pos: Position } | null = null;
    let nearestDist = Infinity;
    state.units.forEach(pu => {
      if (pu.team !== "player" || pu.state === "dead" || pu.hp <= 0) return;
      if (!isVisibleToEnemy(state, pu.position)) return;
      const dx = pu.position.x - u.position.x;
      const dy = pu.position.y - u.position.y;
      const d2 = dx * dx + dy * dy;
      if (d2 < nearestDist) { nearestDist = d2; nearestEnemy = { pos: { ...pu.position } }; }
    });

    const found = nearestEnemy as { pos: Position } | null;
    let newTarget: Position;
    if (found) {
      newTarget = found.pos;
    } else {
      // ── Phase 3: No visible enemies — push toward player HQ ──
      const hq = findPlayerHQ(state);
      newTarget = hq ? { ...hq.position } : { x: 430, y: 90 };
    }

    // Skip reissue if already targeting same position
    if (u.target && Math.abs(u.target.x - newTarget.x) < 2 && Math.abs(u.target.y - newTarget.y) < 2) {
      continue;
    }

    attackerTargets.set(id, newTarget);
    attackerWaypoints.delete(id); // no more corridor
    applyEnemyOrders(state, [{
      unitIds: [id],
      action: "attack_move",
      target: newTarget,
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

/** §2: Check if a position falls within any of the front's regions */
function isPositionInFront(state: GameState, front: typeof state.fronts[0], pos: Position): boolean {
  for (const regionId of front.regionIds) {
    const region = state.regions.get(regionId);
    if (!region) continue;
    const [x1, y1, x2, y2] = region.bbox;
    if (pos.x >= x1 && pos.x <= x2 && pos.y >= y1 && pos.y <= y2) {
      return true;
    }
  }
  return false;
}

/** §2: Find the player's HQ facility */
function findPlayerHQ(state: GameState): { position: Position; hp: number } | undefined {
  let hq: { position: Position; hp: number } | undefined;
  state.facilities.forEach(f => {
    if (f.type === "headquarters" && f.team === "player" && f.hp > 0) hq = f;
  });
  return hq;
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

// ── v3: Strategic maps ──

// Front → objective ids (strategic targets the AI always knows about)
const FRONT_OBJECTIVE_MAP: Record<string, string[]> = {
  front_coastal: ["ea_alamein_town"],
  front_ridge:   ["ea_kidney_ridge", "ea_miteirya_ridge"],
  front_center:  ["ea_miteirya_ridge", "ea_kidney_ridge"],
  front_south:   ["ea_himeimat"],
};

// Multi-waypoint attack corridors (west→east, bypassing Devil's Gardens minefield)
const ATTACK_CORRIDORS: Record<string, Position[]> = {
  front_coastal: [
    { x: 200, y: 30 },   // coastal highway start
    { x: 300, y: 25 },   // north of minefield
    { x: 380, y: 35 },   // approach player area
  ],
  front_ridge: [
    { x: 200, y: 80 },   // ridge direction
    { x: 320, y: 60 },   // through ridge gap
    { x: 380, y: 50 },   // approach objective
  ],
  front_center: [
    { x: 200, y: 140 },  // central start
    { x: 320, y: 150 },  // south of minefield
    { x: 370, y: 140 },  // approach player
  ],
  front_south: [
    { x: 200, y: 200 },  // southern desert
    { x: 320, y: 210 },  // open desert march
    { x: 380, y: 200 },  // approach Himeimat
  ],
};

/** v3: Result of getTargetPosition */
interface AttackTargetResult {
  target: Position;        // Final destination (objective, visible enemy, or HQ)
  corridor: Position[];    // Corridor waypoints to prepend (may be empty)
}

/**
 * v3: Select attack target — strategic-first, vision-second.
 *
 * Priority 1: Player/neutral objective in this front (always known, no vision needed)
 * Priority 2: Visible weak enemy within TACTICAL_DEVIATION_MAX of strategic target
 * Priority 3: Player HQ (ultimate fallback, always known)
 *
 * Corridor waypoints from ATTACK_CORRIDORS are returned for the caller to
 * trim (drop waypoints behind the wave's starting position) and prepend to order.
 */
function getTargetPosition(
  state: GameState,
  front: typeof state.fronts[0],
  _leadType: UnitType,
): AttackTargetResult {
  const corridor = ATTACK_CORRIDORS[front.id] ?? [];

  // ── Priority 1: Strategic objective in this front ──
  const objIds = FRONT_OBJECTIVE_MAP[front.id] ?? [];
  let strategicTarget: Position | null = null;
  for (const objId of objIds) {
    const fac = state.facilities.get(objId);
    if (!fac || fac.hp <= 0) continue;
    // Target objectives held by player or neutral (not already enemy-owned)
    if (fac.team !== "enemy") {
      strategicTarget = { ...fac.position };
      break;
    }
  }

  // If all objectives in this front are already enemy-held, fall through to HQ
  const playerHQ = findPlayerHQ(state);
  const hqFallback = playerHQ ? { ...playerHQ.position } : { x: 430, y: 90 };
  const finalStrategic = strategicTarget ?? hqFallback;

  // ── Priority 2: Tactical deviation — visible weak enemy near strategic target ──
  let weakest: { pos: Position; hp: number } | null = null;
  state.units.forEach(u => {
    if (u.team !== "player" || u.state === "dead" || u.hp <= 0) return;
    if (!isVisibleToEnemy(state, u.position)) return;
    if (!isPositionInFront(state, front, u.position)) return;
    // Only deviate if enemy is close to strategic target (avoid chasing decoys)
    const dx = u.position.x - finalStrategic.x;
    const dy = u.position.y - finalStrategic.y;
    if (dx * dx + dy * dy > TACTICAL_DEVIATION_MAX * TACTICAL_DEVIATION_MAX) return;
    if (!weakest || u.hp < weakest.hp) {
      weakest = { pos: { ...u.position }, hp: u.hp };
    }
  });
  const w = weakest as { pos: Position; hp: number } | null;

  const target = w ? w.pos : finalStrategic;
  return { target, corridor: corridor.map(p => ({ ...p })) };
}

/**
 * v3: Trim corridor — drop waypoints that are behind/west of the wave centroid.
 * Prevents U-turn: only keep points that are AHEAD (higher x) of where units are now.
 */
function trimCorridor(corridor: Position[], centroidX: number): Position[] {
  return corridor.filter(wp => wp.x > centroidX);
}

/**
 * v3: Build the full waypoint chain for an attack order.
 * corridor (trimmed) + final target, deduped.
 */
function buildWaypoints(corridor: Position[], target: Position): Position[] {
  const wps = [...corridor, target];
  return wps;
}

/**
 * v3: Compute centroid x of a set of units (for corridor trimming).
 */
function getCentroidX(units: Unit[]): number {
  if (units.length === 0) return 0;
  let sum = 0;
  for (const u of units) sum += u.position.x;
  return sum / units.length;
}

/**
 * v3: Dispatch attack and register attackers with corridor waypoints.
 * Returns number of units actually dispatched.
 */
function dispatchAttack(
  state: GameState,
  units: Unit[],
  target: Position,
  corridor: Position[],
  priority: "high" | "medium",
): number {
  const centroidX = getCentroidX(units);
  const trimmed = trimCorridor(corridor, centroidX);
  const wps = buildWaypoints(trimmed, target);
  const ids = units.map(u => u.id);

  const dispatch = applyEnemyOrders(state, [{
    unitIds: ids,
    action: "attack_move",
    target,
    waypoints: wps,
    priority,
  }]);

  const applied = dispatch.appliedPerOrder[0] ?? 0;
  if (applied === 0) return 0;

  for (const id of ids) {
    activeAttackerIds.add(id);
    attackerTargets.set(id, target);
    attackerWaypoints.set(id, [...trimmed]); // store remaining corridor
    reserveIds.delete(id);
  }
  return applied;
}

/**
 * §5: Find a safe retreat position. Prefers enemy facilities NOT near player units.
 */
function findSafeRetreatPosition(state: GameState, from: Position): Position | null {
  const DANGER_RADIUS = 25;

  interface Candidate { pos: Position; dist: number; safe: boolean }
  const candidates: Candidate[] = [];

  state.facilities.forEach(f => {
    if (f.team !== "enemy" || f.hp <= 0) return;
    const dx = from.x - f.position.x;
    const dy = from.y - f.position.y;
    const dist = dx * dx + dy * dy;

    // Check if any player units are near this facility
    let safe = true;
    state.units.forEach(pu => {
      if (pu.team !== "player" || pu.state === "dead" || pu.hp <= 0) return;
      const pdx = pu.position.x - f.position.x;
      const pdy = pu.position.y - f.position.y;
      if (pdx * pdx + pdy * pdy <= DANGER_RADIUS * DANGER_RADIUS) {
        safe = false;
      }
    });

    candidates.push({ pos: { ...f.position }, dist, safe });
  });

  // Prefer safe facilities, sorted by distance
  candidates.sort((a, b) => {
    if (a.safe !== b.safe) return a.safe ? -1 : 1;
    return a.dist - b.dist;
  });

  if (candidates.length > 0) return candidates[0].pos;

  // Fallback: enemy HQ
  let hq: Position | null = null;
  state.facilities.forEach(f => {
    if (f.type === "headquarters" && f.team === "enemy" && f.hp > 0) {
      hq = { ...f.position };
    }
  });

  return hq;
}

/**
 * §3: Proactive probe — send small raiding parties to test player defenses.
 */
function proactiveProbe(state: GameState): void {
  if (state.time < PROBE_START_TIME) return;
  if (state.time < probeCooldownUntil) return;

  // Global attacker cap
  if (activeAttackerIds.size >= MAX_ACTIVE_ATTACKERS) return;

  // Fuel gate
  const eco = state.economy.enemy;
  if (eco.resources.fuel < PROBE_MIN_FUEL) return;

  // Pick target front (NOT axis_rear)
  const targetFronts = state.fronts.filter(f => f.id !== "front_axis_rear");
  if (targetFronts.length === 0) return;

  // Weighted random: prefer fronts with FEWER enemy units
  const frontWeights = targetFronts.map(front => {
    let enemyCount = 0;
    state.units.forEach(u => {
      if (u.team !== "enemy" || u.state === "dead" || u.hp <= 0) return;
      if (isPositionInFront(state, front, u.position)) enemyCount++;
    });
    // Weight = inverse of enemy presence (min 1 to avoid division by zero)
    return { front, weight: 1 / Math.max(1, enemyCount) };
  });
  const totalWeight = frontWeights.reduce((sum, fw) => sum + fw.weight, 0);
  let roll = Math.random() * totalWeight;
  let front = frontWeights[0].front;
  for (const fw of frontWeights) {
    roll -= fw.weight;
    if (roll <= 0) { front = fw.front; break; }
  }

  // Gather reserves near front center
  const center = getFrontCenter(state, front) ?? { x: 200, y: 100 };
  let allReserves = getReserveUnitsNear(state, center, 150);

  // Fallback: if local radius finds too few, search globally
  if (allReserves.length < PROBE_MIN_UNITS) {
    allReserves = getReserveUnitsNear(state, center, 9999);
  }
  if (allReserves.length < PROBE_MIN_UNITS) return;

  // Sort: light_tank first (fast probes), then infantry
  const sorted = [...allReserves].sort((a, b) => {
    const priority: Record<string, number> = { light_tank: 0, infantry: 1, main_tank: 2 };
    return (priority[a.type] ?? 3) - (priority[b.type] ?? 3);
  });

  // Cap by both PROBE_MAX_UNITS and remaining attacker budget
  const budget = MAX_ACTIVE_ATTACKERS - activeAttackerIds.size;
  const count = Math.min(PROBE_MAX_UNITS, sorted.length, budget);
  const probeUnits = sorted.slice(0, count);
  if (probeUnits.length < PROBE_MIN_UNITS) return;

  const leadType = getLeadType(probeUnits);
  const { target: finalTarget, corridor } = getTargetPosition(state, front, leadType);
  const applied = dispatchAttack(state, probeUnits, finalTarget, corridor, "medium");
  if (applied === 0) return;

  probeCount++;
  // Interval decreases slightly over time (more aggressive later), min 45s
  const interval = Math.max(45, PROBE_INTERVAL_BASE - probeCount * 3)
    + (Math.random() * 2 - 1) * PROBE_INTERVAL_VARIANCE;
  probeCooldownUntil = state.time + interval;

  pushDiagnostic(state,
    `P3 probe #${probeCount} front=${front.id} units=${applied} next≈${interval.toFixed(0)}s`
  );
}
