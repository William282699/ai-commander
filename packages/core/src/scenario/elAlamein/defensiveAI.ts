// ============================================================
// AI Commander — Defensive AI for El Alamein
// Perception-driven + fog-limited strategic AI
// ============================================================

import type { GameState, Unit, Position, Order, UnitType } from "@ai-commander/shared";
import { getUnitCategory, UNIT_STATS } from "@ai-commander/shared";
import { applyEnemyOrders } from "../../applyOrders";
import { canUnitEnterTile } from "../../sim";
import { enqueueProduction } from "../../economy";
import {
  PHASE_STRATEGY, getCurrentStrategicPhase, CONSOLIDATE_CONFIRM_SEC,
  buildOperationTargets, ATTACK_CORRIDORS, OBJECTIVE_FRONT_MAP, FRONT_PLAYER_POST_MAP,
  type PhaseConfig, type OperationTargetCandidate,
} from "./pressureDirector";
import {
  reserveOperationUnits, releaseOperationUnits, isOperationReserved, clearOperationRegistry,
} from "./operationRegistry";
import { getFormationOffset, computeHeading, type FormationStyle } from "../../formation";

// ── 5C-lite tuning history (3 rounds, cumulative) ──
//
// round 1 (codex): fallback target → player forward post (was: HQ).
//                  Design correction for K=3 win mode. Permanent.
// round 2 (codex): selectP2Target / findPlayerPressureTarget routes to forward
//                  post via FRONT_PLAYER_POST_MAP. Permanent.
// round 3 (V3):    P1/P2/P3 timing gates and caps pulled from PHASE_STRATEGY
//                  (defined in pressureDirector.ts). Hardcoded
//                  grace `state.time < 60` in opportunisticAttack /
//                  massedOffensive replaced with cfg.p1Grace / cfg.p2Grace.
//                  proactiveProbe uses cfg.p3Grace + cfg.p3MaxUnits.
//                  P2 uses cfg.p2CommitRatio + cfg.p2CooldownSec.
//                  P1 uses cfg.p1MaxAttack (instead of re-using P2_MAX_ATTACK).
//                  Non-El-Alamein scenarios get "legacy" phase whose config
//                  mirrors original baseline 1:1 → dual_island behavior unchanged.
//
// Original hardcoded const (PROBE_START_TIME / PROBE_MAX_UNITS /
// P2_COMMIT_RATIO / P2_COOLDOWN_SEC / P2_MAX_ATTACK) are KEPT below but
// no longer read by P1/P2/P3. They serve as fallback defaults for the
// "delete pressureDirector entirely" path (see STEP_5C_LITE_V3_WORKPLAN.md
// § 10.2 mechanical revert).

/** Read PHASE_STRATEGY config for current strategic phase. Pure lookup. */
function getPhaseConfig(state: GameState): PhaseConfig {
  return PHASE_STRATEGY[getCurrentStrategicPhase(state)];
}

// ── Constants ──
const DEFENSIVE_AI_INTERVAL = 5.0;
const MIN_HQ_GUARD = 3;  // v3: was 4, free up 1 for attacks
const GARRISON_RADIUS = 15;
const HQ_GUARD_RADIUS = 20;

// Cooldown durations (seconds)
const P0_COOLDOWN_SEC = 45;
const HARASS_STANDOFF_TILES = 7; // P1/P3 fight around objectives; operation owns capture
// EP-V1c 降噪: 20→45 — P1 fired near-continuously once fights were visible,
// feeding the "很多零散小波" noise that drowned out the main assault.
const P1_COOLDOWN_SEC = 45;
const P2_COOLDOWN_SEC = 50;   // §4: was 60
const TRADE_COOLDOWN_SEC = 60;

// P2 massed offensive thresholds
const P2_MIN_IDLE_BASE = 5;   // §4: was 6
const P2_IDLE_PER_WAVE = 1;   // §4: was 2
const P2_COMMIT_RATIO = 0.75;  // v3: was 0.6, commit more reserves
const P2_MAX_ATTACK = 8; // P1 cap

// ── EP-V1 final: armored-fist OPERATION (owner of the massed offensive for
// el_alamein; the legacy massedOffensive body below only serves "legacy"
// scenarios). Physics dictate the design: the engine has no en-route group
// cohesion, so a perceivable fist = co-located staging + simultaneous launch.
// light_tank (speed 3.0) launches AFTER the 2.0 core with an ETA-sync delay so
// both arrive together instead of the lt dying alone first (playtest). ──
const OP_CREATE_MIN_SEC = 8;         // create/claim at the t=10 tick (assembly ≠ attack;
                                     // 8 not 10: the 5s-tick float residue left t=15.0
                                     // fractionally under a same-valued gate). Still
                                     // beats P4's first gather (grace 15) to the vanguard.
const OP_FIST_MT_MIN = 4;            // launch gate: main tanks AT STAGING (spec: ≥4)
const OP_FIST_MT_TARGET = 6;         // claim up to
const OP_FIST_LT_TARGET = 4;         // claim up to (spec: 2-4)
const OP_FIST_INF_TARGET = 3;        // claim up to (spec: 0-3, cheap occupiers)
const OP_SLOT_GATHER_RADIUS = 2.5;   // "in position" = near OWN staging slot (arrival
                                     // snaps exact; slack covers autoBehavior nudges)
const OP_STAGING_PULLBACK = 15;      // staging = 2nd-to-last corridor wp shifted west
const OP_FORMATION_SCALE = 0.55;     // 13-unit global wedge is ~20 tiles deep; keep this fist compact
const OP_FIRE_STANDOFF = 4;          // tanks' endpoint line sits this short of the objective:
                                     // outside the 1.5 capture ring (occupation is the
                                     // infantry's job), inside main_tank range 6
const OP_SLOT_TOTAL = 13;            // fixed slot plan (6 mt + 3 inf + 4 lt) so formation
                                     // spacing stays stable as members trickle in
const OP_SLOT_BAND: Record<"main_tank" | "infantry" | "light_tank", [number, number]> = {
  main_tank: [0, 5],   // wedge tip rows
  infantry:  [6, 8],
  light_tank:[9, 12],  // trailing rows (they join late via the ETA-synced release)
};
const OP_ASSEMBLY_DEADLINE_SEC = 300;// past this: degraded launch or cancel
const OP_DEADLINE_MIN_UNITS = 4;     // degraded launch needs at least this many gathered
const OP_RETRY_SEC = 60;             // cancel → next create attempt
const OP_OCCUPIER_WAIT_SEC = 20;     // mt gate passed but occupiers still walking in:
                                     // hold the launch briefly so fists carry infantry
                                     // (bounded — never blocks on dead/stuck occupiers)
const OP_ARRIVE_RADIUS = 12;         // member "at formation slot" test (fire-line slots)
const OP_CAPTURE_RING = 1.5;         // mirrors economy.ts tickFacilityCapture's dist ≤ 1.5
const OP_CAPTURE_SLOT_R = 2;         // a slot this close to the objective IS a capture slot:
                                     // its holder is only "arrived" INSIDE the capture ring
                                     // (Codex: a tank idling 4 tiles out must be pushed in,
                                     // or the point never flips)
const OP_OCCUPY_KEEP = 3;            // ground units left to hold a captured player post
const OP_MEMBER_MIN_HP_RATIO = 0.35; // never recycle spent/retreating units into a new fist

// §3: P3 Proactive Probe
const PROBE_START_TIME = 60;          // First probe at 60s
// EP-V1c 降噪: 60→110 — probes every ~45-60s put 30-40 light units of pure
// noise on the board over 10 minutes; halving the cadence keeps the "敌军在
// 摸你" texture without the death-by-a-thousand-cuts grind on garrisons.
const PROBE_INTERVAL_BASE = 110;      // Base interval between probes (seconds)
const PROBE_INTERVAL_VARIANCE = 20;   // +/-20s randomness
const PROBE_MIN_UNITS = 3;
const PROBE_MAX_UNITS = 6;            // v3: was 5
const PROBE_MIN_FUEL = 50;            // Don't probe when fuel is critical
const MAX_ACTIVE_ATTACKERS = 24;      // v3: was 12 — P1/P3 soft cap
const MAX_ACTIVE_ATTACKERS_HARD = 32; // v3: P2 only — massed offensive hard cap
const TACTICAL_DEVIATION_MAX = 25;    // v3: max deviation tiles for visible-enemy targeting
const HQ_ASSAULT_START_SEC = 1200;    // 5C-lite: HQ is a late-game target, not default pressure
const HQ_ASSAULT_LOST_KEYPOINTS = 2;  // Or when player has already lost the forward screen

// §9: Diagnostics cap
const MAX_DIAGNOSTICS = 200;

// Objective → front mapping (H6/H11): moved to pressureDirector (EP-V1 final —
// the operation target candidates carry frontId, so the tables live with the
// candidate builder). Imported above.

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

// ── EP-V1 final: operation module state (owner: this file's operation layer).
// Ownership ledger shared with P4 lives in operationRegistry (single Set, this
// module is the only writer). Two slots per spec: at most ONE launched op in
// the field, ONE assembling behind it.
interface Operation {
  seq: number;
  phase: "assembling" | "launched";
  kind: "fist" | "degraded";
  targetId: string;
  frontId: string;
  targetPos: Position;
  corridor: Position[];
  formation: FormationStyle;          // wedge = take player post, encircle = recapture
  staging: Position;
  memberIds: Set<number>;
  ltIds: Set<number>;                 // light tanks held back for ETA-synced release
  slotTargets: Map<number, Position>; // launched: per-member formation endpoint
  stagingSlots: Map<number, Position>;// assembling: per-member formation slot at staging
  slotIdx: Map<number, number>;       // stable formation index (staging AND endpoint use
                                      // the same index → the wedge translates in parallel
                                      // and stays readable en route)
  createdAt: number;
  launchedAt: number;
  ltReleaseAt: number;
  ltReleased: boolean;
  lastGatherLog: string;              // gather telemetry dedup key (bench diagnosis)
  mtReadyAt: number;                  // when the ≥4-mt launch gate first passed (occupier wait anchor)
}
let fieldOperation: Operation | null = null;
let assemblingOperation: Operation | null = null;
let opSeq = 0;
let opLaunchCooldownUntil = 0;
let opRecreateAfter = 0;
let opCaptureConfirmAt = 0;   // capture debounce clock for fieldOperation's target
// Captured PLAYER posts we hold: postId → owned defender ids (stay in registry).
// assignRoles doesn't classify captured friendlyKeypoints as garrison, so
// without this explicit ownership the hold force would drain back into reserve.
const occupationGarrisons = new Map<string, Set<number>>();

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
  // EP-V1 final: operation layer
  fieldOperation = null;
  assemblingOperation = null;
  opSeq = 0;
  opLaunchCooldownUntil = 0;
  opRecreateAfter = 0;
  opCaptureConfirmAt = 0;
  occupationGarrisons.clear();
  clearOperationRegistry();
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
  operationMaintain(state);       // EP-V1: prune fates + capture/occupation upkeep (releases
                                  // re-classify via assignRoles THIS tick)
  assignRoles(state);             // skips operation-reserved ids
  operationClaim(state);          // EP-V1: create/top-up/production demand — BEFORE
                                  // manageEconomy (queue priority) and P0/P1/P3 (claim priority)
  manageEconomy(state);
  reactiveCounterattack(state);   // P0
  opportunisticAttack(state);     // P1
  operationLaunch(state);         // P2 slot: gather-check → fist launch; lt ETA release
  massedOffensive(state);         // P2 legacy body (non-el_alamein scenarios only)
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

// ══════════════════════════════════════════════════════════════
// EP-V1 final: armored-fist operation layer (owner of the el_alamein massed
// offensive). Cycle: create → claim from reserve → assemble at staging →
// launch as one co-located strike (wedge/encircle endpoint slots) → capture →
// occupy → release; the NEXT op is created the tick after launch so the
// cadence never pays a from-zero organization tax.
//
// Ownership: every member id sits in operationRegistry from claim until
// death / retreat / cancel / operation end. assignRoles skips reserved ids
// (so P0/P1/P3/garrison, which all draw from reserveIds, can never poach),
// P4's pool gathering skips them in-module, and reissueAttackerOrders skips
// them so no generic nearest-enemy retarget ever hijacks a fist member.
// ══════════════════════════════════════════════════════════════

function opLog(state: GameState, msg: string): void {
  pushDiagnostic(state, `OP ${msg}`);
}

function opReleaseMember(op: Operation, id: number): void {
  op.memberIds.delete(id);
  op.ltIds.delete(id);
  op.slotTargets.delete(id);
  op.stagingSlots.delete(id);
  op.slotIdx.delete(id);   // frees the formation index for a replacement claim
  releaseOperationUnits([id]);
}

/** Formation offset shrunk toward its center by OP_FORMATION_SCALE (the raw
 *  13-unit wedge is ~20 tiles deep — too loose to read as one fist). */
function scaledFormationOffset(
  center: Position, idx: number, style: FormationStyle, heading: number,
): Position {
  const raw = getFormationOffset(center, idx, OP_SLOT_TOTAL, style, heading);
  return {
    x: Math.round(center.x + (raw.x - center.x) * OP_FORMATION_SCALE),
    y: Math.round(center.y + (raw.y - center.y) * OP_FORMATION_SCALE),
  };
}

/** Assign a stable formation index (per-type band) + its staging slot. The
 *  staging shape is always a wedge pointed at the target — members assemble
 *  INTO formation instead of stacking on one coordinate (playtest: "堆成一团").
 *  Impassable ideal tiles resolve to the nearest free passable one. */
function assignStagingSlot(state: GameState, op: Operation, u: Unit): void {
  const band = OP_SLOT_BAND[u.type as "main_tank" | "infantry" | "light_tank"] ?? [0, OP_SLOT_TOTAL - 1];
  const used = new Set(op.slotIdx.values());
  let idx = band[0];
  while (idx <= band[1] && used.has(idx)) idx++;
  if (idx > band[1]) idx = OP_SLOT_TOTAL + op.slotIdx.size; // band overflow (shouldn't happen under claim caps)
  op.slotIdx.set(u.id, idx);

  const heading = computeHeading(op.staging, op.targetPos);
  const ideal = scaledFormationOffset(op.staging, idx, "wedge", heading);
  const takenTiles = new Set([...op.stagingSlots.values()].map(p => `${p.x},${p.y}`));
  op.stagingSlots.set(u.id, resolveSlotTile(state, u, ideal, takenTiles, op.staging));
}

/** Recompute every member's staging slot (staging point or heading changed). */
function reassignStagingSlots(state: GameState, op: Operation): void {
  const heading = computeHeading(op.staging, op.targetPos);
  op.stagingSlots.clear();
  const takenTiles = new Set<string>();
  for (const [id, idx] of op.slotIdx) {
    const u = state.units.get(id);
    if (!u) continue;
    const ideal = scaledFormationOffset(op.staging, idx, "wedge", heading);
    op.stagingSlots.set(id, resolveSlotTile(state, u, ideal, takenTiles, op.staging));
  }
}

/** The next fist is ready and the old mission has used its launch window.
 *  Release ownership but keep surviving units in the existing attacker ledger:
 *  they may finish the local fight, while the hard cap still counts them. */
function handoffFieldOperation(state: GameState, op: Operation): void {
  for (const id of Array.from(op.memberIds)) releaseOperationUnits([id]);
  fieldOperation = null;
  opCaptureConfirmAt = 0;
  opLog(state, `#${op.seq} handoff (next fist ready; survivors remain local attackers)`);
}

/** Drop dead / retreating members (retreat was ordered by cleanupActiveAttackers
 *  at <35% HP, or by autoBehavior — either way the unit has left the fight). */
function pruneOperationMembers(state: GameState, op: Operation): void {
  for (const id of Array.from(op.memberIds)) {
    const u = state.units.get(id);
    if (!u || u.state === "dead" || u.hp <= 0) {
      opReleaseMember(op, id);
      opLog(state, `#${op.seq} member ${id} died`);
      continue;
    }
    if (u.state === "retreating") {
      opReleaseMember(op, id);
      opLog(state, `#${op.seq} member ${id} retreated`);
    }
  }
}

/** Target is still worth marching on iff the facility stands and is not ours. */
function isOperationTargetValid(state: GameState, op: Operation): boolean {
  const fac = state.facilities.get(op.targetId);
  return !!fac && fac.hp > 0 && fac.team !== "enemy";
}

/** The rear assembly should not duplicate the field operation's locked target.
 *  Deconfliction here is what lets op N+1 stage on another axis while op N is
 *  still fighting, rather than crossing the map only after the first capture. */
function selectAssemblyTarget(state: GameState): OperationTargetCandidate | undefined {
  const occupiedTarget = fieldOperation?.targetId;
  const candidates = buildOperationTargets(state);
  return candidates.find((candidate) => candidate.targetId !== occupiedTarget)
    ?? candidates[0]; // one legal axis left: assemble a relief wave on the same target
}

/** Staging = 2nd-to-last corridor waypoint pulled OP_STAGING_PULLBACK west
 *  (outside player opening vision, past the minefield lane). The point anchors
 *  a ~±6-tile slot footprint, so demand a CLEAR CROSS (±2, tank-passable)
 *  around it — a bare-point check once parked the ridge staging on the edge of
 *  the Devil's Gardens and half the wedge slots fell in the swamp. */
function deriveStaging(state: GameState, cand: OperationTargetCandidate): Position {
  const corr = cand.corridor;
  const base = corr.length >= 2 ? corr[corr.length - 2]
    : (corr[0] ?? { x: Math.max(2, cand.position.x - 60), y: cand.position.y });
  // For recapture targets in Axis territory, never assemble east of (and march
  // through) the objective: every El Alamein ground unit can capture, so that
  // would dissolve the operation one unit at a time before launch.
  const desiredX = Math.min(
    base.x - OP_STAGING_PULLBACK,
    cand.position.x - OP_STAGING_PULLBACK,
  );
  for (let k = 0; k <= 5; k++) {
    for (const dy of [0, 2, -2, 4, -4]) {
      const x = Math.round(desiredX - k * 5);
      const y = Math.round(base.y + dy);
      if (x < 4 || y < 4 || y >= state.mapHeight - 4) continue;
      const clear = canUnitEnterTile("main_tank", x, y, state)
        && canUnitEnterTile("main_tank", x - 2, y, state)
        && canUnitEnterTile("main_tank", x + 2, y, state)
        && canUnitEnterTile("main_tank", x, y - 2, state)
        && canUnitEnterTile("main_tank", x, y + 2, state);
      if (clear) return { x, y };
    }
  }
  return { x: Math.round(base.x), y: Math.round(base.y) };
}

/** Deterministic near-ideal probe: first tile that is passable for THIS unit
 *  and not already someone else's slot. Members must never silently share a
 *  tile (the "堆成一团" bug was exactly this fallback stacking). */
const SLOT_PROBE_OFFSETS: [number, number][] = [
  [0, 0], [-1, 0], [1, 0], [0, -1], [0, 1], [-1, -1], [-1, 1], [1, -1], [1, 1],
  [-2, 0], [2, 0], [0, -2], [0, 2], [-2, -1], [-2, 1], [2, -1], [2, 1],
  [-3, 0], [0, -3], [0, 3], [-3, -1], [-3, 1], [-4, 0],
];
function resolveSlotTile(
  state: GameState, u: Unit, ideal: Position, takenTiles: Set<string>,
  anchor: Position, avoid?: { pos: Position; r: number },
): Position {
  const usable = (x: number, y: number): boolean => {
    if (x < 1 || y < 1 || x >= state.mapWidth - 1 || y >= state.mapHeight - 1) return false;
    if (takenTiles.has(`${x},${y}`)) return false;
    if (avoid) {
      const adx = x - avoid.pos.x, ady = y - avoid.pos.y;
      if (adx * adx + ady * ady <= avoid.r * avoid.r) return false; // e.g. tanks stay OUT of the capture ring
    }
    return canUnitEnterTile(u.type, x, y, state);
  };
  for (const [ox, oy] of SLOT_PROBE_OFFSETS) {
    if (usable(ideal.x + ox, ideal.y + oy)) {
      takenTiles.add(`${ideal.x + ox},${ideal.y + oy}`);
      return { x: ideal.x + ox, y: ideal.y + oy };
    }
  }
  // Local spiral exhausted (slot fell into sea/minefield — e.g. the coastal
  // staging's deep wedge rows reach the shoreline). Walk the ideal→anchor line
  // back toward the formation anchor: its neighborhood is the cross-verified
  // staging pocket / approach lane, so this terminates on good ground instead
  // of marching blindly west into more water.
  const steps = Math.max(1, Math.ceil(Math.hypot(anchor.x - ideal.x, anchor.y - ideal.y)));
  for (let s = 1; s <= steps + 3; s++) {
    const bx = Math.round(ideal.x + (anchor.x - ideal.x) * Math.min(1, s / steps));
    const by = Math.round(ideal.y + (anchor.y - ideal.y) * Math.min(1, s / steps));
    for (const [jx, jy] of [[0, 0], [0, -1], [0, 1], [-1, 0], [1, 0], [-1, -1], [-1, 1], [1, -1], [1, 1]]) {
      if (usable(bx + jx, by + jy)) {
        takenTiles.add(`${bx + jx},${by + jy}`);
        return { x: bx + jx, y: by + jy };
      }
    }
  }
  // Codex hardening: never silently hand back an unverified/duplicate tile —
  // log it so the bench can assert this path is NEVER taken.
  opLog(state, `slot-overflow id=${u.id} ideal=(${ideal.x},${ideal.y})`);
  return { ...ideal };
}

/** March one claimed unit to its STAGING SLOT along the corridor prefix
 *  (minefield bypass); only waypoints ahead of the unit and short of staging
 *  apply. Members assemble into wedge positions, not onto one point. */
function orderToStaging(state: GameState, op: Operation, u: Unit): void {
  const slot = op.stagingSlots.get(u.id) ?? op.staging;
  const route = op.corridor.filter(wp => wp.x > u.position.x && wp.x < op.staging.x);
  applyEnemyOrders(state, [{
    unitIds: [u.id],
    action: "attack_move",
    target: { ...slot },
    waypoints: [...route.map(p => ({ ...p })), { ...slot }],
    priority: "medium",
  }]);
}

/** Is this member standing on (within slack of) its own staging slot? */
function isAtStagingSlot(op: Operation, u: Unit): boolean {
  const slot = op.stagingSlots.get(u.id) ?? op.staging;
  const dx = u.position.x - slot.x, dy = u.position.y - slot.y;
  return dx * dx + dy * dy <= OP_SLOT_GATHER_RADIUS * OP_SLOT_GATHER_RADIUS;
}

function getOperationLaunchLeg(op: Operation): Position[] {
  return op.corridor
    .filter(wp => wp.x > op.staging.x && wp.x < op.targetPos.x - 5)
    .map(p => ({ ...p }));
}

function routeDistance(start: Position, points: Position[]): number {
  let total = 0;
  let prev = start;
  for (const point of points) {
    total += Math.hypot(point.x - prev.x, point.y - prev.y);
    prev = point;
  }
  return total;
}

/** Rejoin an operation member to the remaining strategic corridor, never to a
 *  generic nearest-visible-enemy target. */
function orderFieldMember(state: GameState, op: Operation, u: Unit, slot: Position): void {
  const leg = getOperationLaunchLeg(op).filter(wp => wp.x > u.position.x);
  applyEnemyOrders(state, [{
    unitIds: [u.id],
    action: "attack_move",
    target: { ...slot },
    waypoints: [...leg, { ...slot }],
    priority: "high",
  }]);
}

function retargetAssembly(state: GameState, op: Operation, next: OperationTargetCandidate): void {
  op.targetId = next.targetId;
  op.frontId = next.frontId;
  op.targetPos = { ...next.position };
  op.corridor = next.corridor;
  op.formation = next.kind === "recapture" ? "encircle" : "wedge";
  op.staging = deriveStaging(state, next);
  reassignStagingSlots(state, op);   // staging point + heading moved with the target
  opLog(state, `#${op.seq} retarget → ${op.targetId} (${next.kind}) staging=(${op.staging.x},${op.staging.y})`);
  for (const id of op.memberIds) {
    const u = state.units.get(id);
    if (u && u.hp > 0 && u.state !== "dead") orderToStaging(state, op, u);
  }
}

function cancelOperation(state: GameState, op: Operation, reason: string): void {
  for (const id of Array.from(op.memberIds)) {
    activeAttackerIds.delete(id);
    attackerTargets.delete(id);
    attackerWaypoints.delete(id);
    opReleaseMember(op, id);
  }
  if (assemblingOperation === op) assemblingOperation = null;
  if (fieldOperation === op) { fieldOperation = null; opCaptureConfirmAt = 0; }
  opRecreateAfter = state.time + OP_RETRY_SEC;
  opLog(state, `#${op.seq} cancel (${reason})`);
}

/** Operation end. On a captured PLAYER post, keep an explicit hold force
 *  (occupation ownership — assignRoles never garrisons friendlyKeypoints);
 *  a recaptured AXIS objective needs none: assignRoles' normal garrison
 *  radius takes over the moment the released units re-classify. */
function completeOperation(state: GameState, op: Operation, captured: boolean): void {
  const isPlayerPost = (state.scenarioWinConfig?.friendlyKeypoints ?? []).includes(op.targetId);
  if (captured && isPlayerPost) {
    const near: Unit[] = [];
    for (const id of op.memberIds) {
      const u = state.units.get(id);
      if (!u || u.hp <= 0 || u.state === "dead") continue;
      const dx = u.position.x - op.targetPos.x, dy = u.position.y - op.targetPos.y;
      if (dx * dx + dy * dy <= 25 * 25) near.push(u);
    }
    // Cheap holders first: infantry (entrench) > light_tank > main_tank —
    // armor flows back to the next fist instead of standing static guard.
    // Hard cap: at most ONE main_tank ever stays (seed 7: an all-tank keep
    // parked 3 mt on the post and starved the next fist into degraded; a thin
    // hold force is topped up with reserve infantry within a few ticks).
    const pref: Record<string, number> = { infantry: 0, light_tank: 1, main_tank: 2 };
    near.sort((a, b) => ((pref[a.type] ?? 3) - (pref[b.type] ?? 3)) || (a.id - b.id));
    const keep: Unit[] = [];
    for (const u of near) {
      if (keep.length >= OP_OCCUPY_KEEP) break;
      if (u.type === "main_tank" && keep.some(k => k.type === "main_tank")) continue;
      keep.push(u);
    }
    if (keep.length > 0) {
      const keepSet = new Set(keep.map(u => u.id));
      occupationGarrisons.set(op.targetId, keepSet);
      applyEnemyOrders(state, keep.map(u => ({
        unitIds: [u.id], action: "defend" as const, target: { ...op.targetPos }, priority: "low" as const,
      })));
      for (const id of keepSet) {
        // stays in the registry — occupation ownership continues
        op.memberIds.delete(id);
        op.ltIds.delete(id);
        op.slotTargets.delete(id);
        activeAttackerIds.delete(id);
        attackerTargets.delete(id);
        attackerWaypoints.delete(id);
      }
      opLog(state, `#${op.seq} occupy ${op.targetId} keep=[${keep.map(u => u.id).join(",")}]`);
    }
  }
  for (const id of Array.from(op.memberIds)) {
    activeAttackerIds.delete(id);
    attackerTargets.delete(id);
    attackerWaypoints.delete(id);
    opReleaseMember(op, id);
  }
  if (fieldOperation === op) { fieldOperation = null; opCaptureConfirmAt = 0; }
  opLog(state, `#${op.seq} complete${captured ? " (captured)" : " (target gone)"}`);
}

function maintainOccupationGarrisons(state: GameState): void {
  for (const [postId, ids] of occupationGarrisons) {
    for (const id of Array.from(ids)) {
      const u = state.units.get(id);
      if (!u || u.state === "dead" || u.hp <= 0) {
        ids.delete(id);
        releaseOperationUnits([id]);
      }
    }
    const fac = state.facilities.get(postId);
    if (!fac || fac.hp <= 0 || fac.team !== "enemy") {
      // Post lost or destroyed — the hold force returns to the pool.
      releaseOperationUnits(ids);
      occupationGarrisons.delete(postId);
      opLog(state, `occupation ${postId} released (post lost)`);
    }
  }
}

/** Tick step 1 (before assignRoles): fates, capture handoff, march upkeep. */
function operationMaintain(state: GameState): void {
  maintainOccupationGarrisons(state);

  const asm = assemblingOperation;
  if (asm) {
    pruneOperationMembers(state, asm);
    if (!isOperationTargetValid(state, asm)) {
      const next = selectAssemblyTarget(state);
      if (next) retargetAssembly(state, asm, next);
      else cancelOperation(state, asm, "no_valid_target");
    } else {
      for (const id of asm.memberIds) {
        const u = state.units.get(id);
        if (!u) continue;
        const atSlot = isAtStagingSlot(asm, u);
        if ((u.state === "idle" || (u.state === "defending" && !u.target)) && atSlot) {
          // Stand fast with HOLD, not defend. A defend posture falls through
          // to autoBehavior's assist rules by design — and 4c projects an
          // ally's STALE cross-map attack lock into the cluster (seed 7: the
          // whole gathered fist got siphoned 180 tiles back to the coastal
          // fight at t=416, one leash round-trip per member, forever). HOLD is
          // the committed "explicit stand-fast" order: exempt from 4a/4b/4c,
          // while in-range return fire (combat.ts) and the low-HP retreat
          // override (autoBehavior priority 2) both still apply.
          if (u.orders[0]?.action !== "hold") {
            applyEnemyOrders(state, [{ unitIds: [id], action: "hold", target: null, priority: "low" }]);
          }
        } else if ((u.state === "idle" || (u.state === "defending" && !u.target)) && !atSlot) {
          // Fell out of the march (A* hiccup / autoBehavior episode over) —
          // push it back onto its staging slot. Never a generic enemy chase.
          orderToStaging(state, asm, u);
        }
      }

      // Gather telemetry (bench diagnosis; dedup so it only logs on change).
      let gMt = 0, gAll = 0;
      for (const id of asm.memberIds) {
        const u = state.units.get(id);
        if (!u || u.hp <= 0 || u.state === "dead") continue;
        if (isAtStagingSlot(asm, u)) {
          gAll++;
          if (u.type === "main_tank") gMt++;
        }
      }
      const gatherKey = `${gMt}/${gAll}`;
      if (gatherKey !== asm.lastGatherLog) {
        asm.lastGatherLog = gatherKey;
        opLog(state, `#${asm.seq} gather mt=${gMt} units=${gAll}`);
      }
    }
  }

  const op = fieldOperation;
  if (!op) return;
  pruneOperationMembers(state, op);
  if (op.memberIds.size === 0) {
    opLog(state, `#${op.seq} wiped`);
    fieldOperation = null;
    opCaptureConfirmAt = 0;
    return;
  }
  const fac = state.facilities.get(op.targetId);
  if (!fac || fac.hp <= 0) {
    completeOperation(state, op, false);
    return;
  }
  if (fac.team === "enemy") {
    // Captured (maybe by us, maybe a P4 wave got there first — either way the
    // fist inherits the prize). Confirm past the blip window, then hand off.
    if (opCaptureConfirmAt === 0) opCaptureConfirmAt = state.time;
    if (state.time - opCaptureConfirmAt >= CONSOLIDATE_CONFIRM_SEC) {
      completeOperation(state, op, true);
    }
    return;
  }
  opCaptureConfirmAt = 0;

  // Fix C fallback: occupation is the infantry's job, but if every occupier is
  // gone while the target still stands, the nearest survivor takes the breach
  // slot — tanks MAY capture here (all El Alamein ground units can).
  const hasAliveInf = [...op.memberIds].some(id => {
    const u = state.units.get(id);
    return !!u && u.hp > 0 && u.state !== "dead" && u.type === "infantry";
  });
  if (!hasAliveInf) {
    const hasBreachSlot = [...op.slotTargets.values()].some(p => {
      const dx = p.x - op.targetPos.x, dy = p.y - op.targetPos.y;
      return dx * dx + dy * dy <= 1.5 * 1.5;
    });
    if (!hasBreachSlot) {
      let nearest: Unit | null = null;
      let nd = Infinity;
      for (const id of op.memberIds) {
        const u = state.units.get(id);
        if (!u || u.hp <= 0 || u.state === "dead" || u.state === "retreating") continue;
        const dx = u.position.x - op.targetPos.x, dy = u.position.y - op.targetPos.y;
        const d = dx * dx + dy * dy;
        if (d < nd) { nd = d; nearest = u; }
      }
      if (nearest) {
        op.slotTargets.set(nearest.id, { ...op.targetPos });
        if (nearest.state === "idle") {
          orderFieldMember(state, op, nearest, op.targetPos);
          activeAttackerIds.add(nearest.id);
          attackerTargets.set(nearest.id, { ...op.targetPos });
        }
        opLog(state, `#${op.seq} fallback-capture id=${nearest.id} (no infantry left)`);
      }
    }
  }

  // March upkeep: idle short of the slot → re-push to the SLOT only (spec: no
  // nearest-visible-enemy retarget for operation members, ever).
  // Arrival is slot-type aware: a CAPTURE slot (within OP_CAPTURE_SLOT_R of
  // the objective) only counts as reached INSIDE the capture ring — this is
  // also what guarantees a fallback-capture unit that was moving/attacking
  // when its slot was rewritten gets pushed into the ring once it idles.
  for (const id of op.memberIds) {
    if (op.ltIds.has(id) && !op.ltReleased) continue; // still staged, waiting on ETA sync
    const u = state.units.get(id);
    if (!u || u.state !== "idle") continue;
    const slot = op.slotTargets.get(id) ?? op.targetPos;
    const sdx = slot.x - op.targetPos.x, sdy = slot.y - op.targetPos.y;
    const isCaptureSlot = sdx * sdx + sdy * sdy <= OP_CAPTURE_SLOT_R * OP_CAPTURE_SLOT_R;
    if (isCaptureSlot) {
      const tdx = u.position.x - op.targetPos.x, tdy = u.position.y - op.targetPos.y;
      if (tdx * tdx + tdy * tdy <= OP_CAPTURE_RING * OP_CAPTURE_RING) continue; // capturing
    } else {
      const dx = u.position.x - slot.x, dy = u.position.y - slot.y;
      if (dx * dx + dy * dy <= OP_ARRIVE_RADIUS * OP_ARRIVE_RADIUS) continue; // holding at slot
    }
    orderFieldMember(state, op, u, slot);
    activeAttackerIds.add(id);
    attackerTargets.set(id, { ...slot });
  }
}

/** Tick step 2 (after assignRoles, BEFORE manageEconomy and P0/P1/P3):
 *  create the next op, claim from reserve, voice production demand. Claiming
 *  strictly consumes reserveIds — assignRoles' output is the single
 *  role-eligibility truth (no rescanning state.units). */
function operationClaim(state: GameState): void {
  const phase = getCurrentStrategicPhase(state);
  if (phase === "legacy") return;
  if (state.time < OP_CREATE_MIN_SEC) return;

  if (phase === "endgame_defense") {
    // 总防: no offensive operations. Stand the assembly down (field op, if
    // any, runs to its end; occupation holds are defensive and stay).
    if (assemblingOperation) cancelOperation(state, assemblingOperation, "endgame_defense");
  } else if (!assemblingOperation && state.time >= opRecreateAfter) {
    const best = selectAssemblyTarget(state);
    if (best) {
      opSeq++;
      const staging = deriveStaging(state, best);
      assemblingOperation = {
        seq: opSeq, phase: "assembling", kind: "fist",
        targetId: best.targetId, frontId: best.frontId,
        targetPos: { ...best.position }, corridor: best.corridor,
        formation: best.kind === "recapture" ? "encircle" : "wedge",
        staging,
        memberIds: new Set(), ltIds: new Set(), slotTargets: new Map(),
        stagingSlots: new Map(), slotIdx: new Map(),
        createdAt: state.time, launchedAt: 0, ltReleaseAt: 0, ltReleased: false,
        lastGatherLog: "", mtReadyAt: 0,
      };
      opLog(state, `#${opSeq} create target=${best.targetId} kind=${best.kind} front=${best.frontId} staging=(${staging.x},${staging.y})`);
    }
  }

  const asm = assemblingOperation;
  if (asm) {
    // Current composition
    let haveMt = 0, haveLt = 0, haveInf = 0;
    for (const id of asm.memberIds) {
      const u = state.units.get(id);
      if (!u || u.hp <= 0) continue;
      if (u.type === "main_tank") haveMt++;
      else if (u.type === "light_tank") haveLt++;
      else if (u.type === "infantry") haveInf++;
    }

    // Reserve pool by type (liveness mirror of getReserveUnitsNear)
    const pool: Record<"main_tank" | "light_tank" | "infantry", Unit[]> =
      { main_tank: [], light_tank: [], infantry: [] };
    for (const id of reserveIds) {
      const u = state.units.get(id);
      if (!u || u.state === "dead" || u.hp <= 0) continue;
      if (u.hp / u.maxHp < OP_MEMBER_MIN_HP_RATIO) continue;
      if (u.state !== "idle" && u.state !== "defending" && u.state !== "patrolling") continue;
      if (u.type === "main_tank" || u.type === "light_tank" || u.type === "infantry") {
        pool[u.type].push(u);
      }
    }
    const byDistToStaging = (a: Unit, b: Unit) => {
      const da = (a.position.x - asm.staging.x) ** 2 + (a.position.y - asm.staging.y) ** 2;
      const db = (b.position.x - asm.staging.x) ** 2 + (b.position.y - asm.staging.y) ** 2;
      return (da - db) || (a.id - b.id);
    };
    const claims: Unit[] = [];
    const take = (arr: Unit[], n: number) => {
      if (n <= 0) return;
      arr.sort(byDistToStaging);
      for (const u of arr.slice(0, n)) claims.push(u);
    };
    take(pool.main_tank, OP_FIST_MT_TARGET - haveMt);
    take(pool.light_tank, OP_FIST_LT_TARGET - haveLt);
    take(pool.infantry, OP_FIST_INF_TARGET - haveInf);

    if (claims.length > 0) {
      reserveOperationUnits(claims.map(u => u.id));
      for (const u of claims) {
        asm.memberIds.add(u.id);
        if (u.type === "light_tank") asm.ltIds.add(u.id);
        reserveIds.delete(u.id);   // out of THIS tick's P0/P1/P3/garrison pool too
        assignStagingSlot(state, asm, u);  // fix B: assemble INTO formation
        orderToStaging(state, asm, u);
      }
      opLog(state, `#${asm.seq} claim +${claims.length} (mt=${haveMt + claims.filter(u => u.type === "main_tank").length}/${OP_FIST_MT_TARGET})`);
    }

    // Production demand — runs BEFORE manageEconomy's random fill, so the
    // fist's armor gap owns the queue slots (restrained: ≤2 mt queued).
    const mtTotal = haveMt + claims.filter(u => u.type === "main_tank").length;
    if (mtTotal < OP_FIST_MT_TARGET) {
      const queuedMt = state.productionQueue.enemy.filter(p => p.unitType === "main_tank").length;
      if (queuedMt < 2 && state.productionQueue.enemy.length < 4
          && state.economy.enemy.resources.money >= UNIT_STATS.main_tank.cost) {
        const r = enqueueProduction(state, "enemy", "main_tank");
        if (r.ok) opLog(state, `#${asm.seq} demand main_tank (have=${mtTotal}, queued=${queuedMt + 1})`);
      }
    }
  }

  // Occupation top-up: ≥2 holders per captured player post. Infantry only —
  // never drain fist armor into static guard duty.
  for (const [postId, ids] of occupationGarrisons) {
    const fac = state.facilities.get(postId);
    if (!fac || fac.team !== "enemy") continue;
    let alive = 0;
    for (const id of ids) {
      const u = state.units.get(id);
      if (u && u.hp > 0 && u.state !== "dead") alive++;
    }
    if (alive >= 2) continue;
    const inf: Unit[] = [];
    for (const id of reserveIds) {
      const u = state.units.get(id);
      if (!u || u.type !== "infantry" || u.hp <= 0 || u.state === "dead") continue;
      if (u.hp / u.maxHp < OP_MEMBER_MIN_HP_RATIO) continue;
      if (u.state !== "idle" && u.state !== "defending" && u.state !== "patrolling") continue;
      inf.push(u);
    }
    inf.sort((a, b) => {
      const da = (a.position.x - fac.position.x) ** 2 + (a.position.y - fac.position.y) ** 2;
      const db = (b.position.x - fac.position.x) ** 2 + (b.position.y - fac.position.y) ** 2;
      return (da - db) || (a.id - b.id);
    });
    const add = inf.slice(0, 2 - alive);
    if (add.length === 0) continue;
    reserveOperationUnits(add.map(u => u.id));
    for (const u of add) {
      ids.add(u.id);
      reserveIds.delete(u.id);
    }
    applyEnemyOrders(state, add.map(u => ({
      unitIds: [u.id], action: "defend" as const, target: { ...fac.position }, priority: "medium" as const,
    })));
    opLog(state, `occupation ${postId} +${add.length} inf`);
  }
}

/** Tick step 3 (the P2 slot): ETA-synced lt release + the launch decision. */
function operationLaunch(state: GameState): void {
  // Light-tank release: lts (3.0) depart once the 2.0 core has the head start
  // that lands both together — delay = D/2.0 − D/3.0 = D/6 (speeds from
  // UNIT_STATS; per spec no complex flank machine, just ETA sync).
  const fop = fieldOperation;
  if (fop && !fop.ltReleased && state.time >= fop.ltReleaseAt) {
    fop.ltReleased = true;
    const ltOrders: Order[] = [];
    for (const id of fop.ltIds) {
      const u = state.units.get(id);
      if (!u || u.hp <= 0 || u.state === "dead") continue;
      const slot = fop.slotTargets.get(id) ?? fop.targetPos;
      const leg = getOperationLaunchLeg(fop);
      ltOrders.push({
        unitIds: [id], action: "attack_move", target: { ...slot },
        waypoints: [...leg, { ...slot }], priority: "high",
      });
      activeAttackerIds.add(id);
      attackerTargets.set(id, { ...slot });
    }
    if (ltOrders.length > 0) {
      applyEnemyOrders(state, ltOrders);
      opLog(state, `#${fop.seq} lt-release n=${ltOrders.length}`);
    }
  }

  const asm = assemblingOperation;
  if (!asm) return;
  const cfg = getPhaseConfig(state);
  if (state.time < cfg.p2Grace) return;
  if (state.time < opLaunchCooldownUntil) return;

  const gathered: Unit[] = [];
  for (const id of asm.memberIds) {
    const u = state.units.get(id);
    if (!u || u.hp <= 0 || u.state === "dead" || u.state === "retreating") continue;
    if (isAtStagingSlot(asm, u)) gathered.push(u);
  }
  const gatheredMt = gathered.filter(u => u.type === "main_tank").length;

  let kind: "fist" | "degraded" | null = null;
  if (gatheredMt >= OP_FIST_MT_MIN) kind = "fist";
  else if (state.time - asm.createdAt >= OP_ASSEMBLY_DEADLINE_SEC) {
    if (gathered.length >= OP_DEADLINE_MIN_UNITS) kind = "degraded";
    else {
      cancelOperation(state, asm, `deadline gathered=${gathered.length}`);
      return;
    }
  }
  if (!kind) return;

  // Fix C: don't launch the fist tank-only while its occupiers are seconds
  // out — hold up to OP_OCCUPIER_WAIT_SEC for at least one infantry to reach
  // its slot. Bounded, and skipped entirely when no live occupier remains.
  if (kind === "fist") {
    const gatheredInf = gathered.filter(u => u.type === "infantry").length;
    const hasLiveOccupier = [...asm.memberIds].some(id => {
      const u = state.units.get(id);
      return !!u && u.hp > 0 && u.state !== "dead" && u.state !== "retreating"
        && u.type === "infantry";
    });
    if (gatheredInf === 0 && hasLiveOccupier) {
      if (asm.mtReadyAt === 0) asm.mtReadyAt = state.time;
      if (state.time - asm.mtReadyAt < OP_OCCUPIER_WAIT_SEC) return;
    }
  }

  if (fieldOperation) {
    const fieldTarget = state.facilities.get(fieldOperation.targetId);
    // A just-captured target is inside the 20s ownership debounce. Let that
    // complete and establish its occupation garrison instead of discarding it.
    if (fieldTarget?.team === "enemy") return;
    handoffFieldOperation(state, fieldOperation);
  }

  // Hard cap: the WHOLE strike (incl. the lt wing releasing seconds later)
  // must fit under MAX_ACTIVE_ATTACKERS_HARD — if it doesn't, WAIT; never
  // shrink the fist below spec to sneak under the cap.
  if (activeAttackerIds.size + gathered.length > MAX_ACTIVE_ATTACKERS_HARD) {
    opLog(state, `#${asm.seq} hold (cap ${activeAttackerIds.size}+${gathered.length}>${MAX_ACTIVE_ATTACKERS_HARD})`);
    return;
  }

  launchOperation(state, asm, gathered, kind, cfg);
}

function launchOperation(
  state: GameState,
  op: Operation,
  gathered: Unit[],
  kind: "fist" | "degraded",
  cfg: PhaseConfig,
): void {
  // Stragglers (claimed, still marching in) return to the pool — the next op,
  // created next tick, re-claims them from wherever they stand (closer now).
  const gatheredIds = new Set(gathered.map(u => u.id));
  for (const id of Array.from(op.memberIds)) {
    if (!gatheredIds.has(id)) opReleaseMember(op, id);
  }

  // Endpoint slots preserve each member's STAGING index → the staging wedge
  // and the endpoint wedge are parallel translations of the same shape, so the
  // formation stays readable the whole march (fix B), instead of re-shuffling
  // members across the axis at launch.
  //
  // Occupation doctrine (fix C): every El Alamein ground unit CAN capture
  // (economy.ts blacklist rule), so slot GEOMETRY decides who does. Gathered
  // infantry take the capture slots ON the objective (≤1.5 ring); tanks form
  // the fire line OP_FIRE_STANDOFF short of it — outside the capture ring,
  // inside main_tank range 6. Only with no infantry gathered does the
  // lowest-index tank take the breach slot itself.
  const typeOrder: Record<string, number> = { main_tank: 0, infantry: 1, light_tank: 2 };
  const ordered = [...gathered].sort((a, b) =>
    ((typeOrder[a.type] ?? 3) - (typeOrder[b.type] ?? 3)) || (a.id - b.id));
  const heading = computeHeading(op.staging, op.targetPos);
  const hx = Math.cos(heading), hy = Math.sin(heading);
  const infs = gathered.filter(u => u.type === "infantry")
    .sort((a, b) => (op.slotIdx.get(a.id) ?? 99) - (op.slotIdx.get(b.id) ?? 99));
  const nonInf = gathered.filter(u => u.type !== "infantry");
  const fireCenter: Position = op.formation === "encircle"
    ? { ...op.targetPos }   // encircle slots already ring the target at ~5-6 tiles
    : { x: op.targetPos.x - hx * OP_FIRE_STANDOFF, y: op.targetPos.y - hy * OP_FIRE_STANDOFF };

  op.slotTargets.clear();
  const endpointTaken = new Set<string>();
  infs.forEach((u, k) => {
    // Capture slots: the objective itself ± 1 tile perpendicular — every one
    // inside the 1.5 capture ring.
    const slot = {
      x: Math.round(op.targetPos.x + (k === 1 ? -hy : k === 2 ? hy : 0)),
      y: Math.round(op.targetPos.y + (k === 1 ? hx : k === 2 ? -hx : 0)),
    };
    op.slotTargets.set(u.id, slot);
    endpointTaken.add(`${slot.x},${slot.y}`);
  });
  // No occupiers → the lowest-index tank takes the breach slot itself; every
  // OTHER non-inf slot is verified passable, unique, AND outside the capture
  // ring (Codex: geometry, not luck, keeps tanks out of the occupation zone).
  const breachId = infs.length === 0 && nonInf.length > 0
    ? [...nonInf].sort((a, b) =>
        (op.slotIdx.get(a.id) ?? 99) - (op.slotIdx.get(b.id) ?? 99))[0].id
    : null;
  for (const u of nonInf) {
    if (u.id === breachId) {
      op.slotTargets.set(u.id, { ...op.targetPos });
      endpointTaken.add(`${op.targetPos.x},${op.targetPos.y}`);
      continue;
    }
    const idx = op.slotIdx.get(u.id) ?? 0;
    const ideal = scaledFormationOffset(fireCenter, idx, op.formation, heading);
    op.slotTargets.set(u.id, resolveSlotTile(state, u, ideal, endpointTaken,
      fireCenter, { pos: op.targetPos, r: OP_CAPTURE_SLOT_R }));
  }
  for (const [id, p] of op.slotTargets) {
    op.slotTargets.set(id, {
      x: Math.max(0, Math.min(state.mapWidth - 1, p.x)),
      y: Math.max(0, Math.min(state.mapHeight - 1, p.y)),
    });
  }

  // Launch leg: corridor waypoints strictly BETWEEN staging and target — the
  // old full-corridor dispatch marched fists through a dogleg past the post
  // (seed42: the (380,50) wp dragged the ridge fist into the coastal fight).
  const leg = getOperationLaunchLeg(op);

  op.ltIds = new Set(ordered.filter(u => u.type === "light_tank").map(u => u.id));
  const core = ordered.filter(u => !op.ltIds.has(u.id));

  const orders: Order[] = core.map(u => ({
    unitIds: [u.id],
    action: "attack_move" as const,
    target: { ...op.slotTargets.get(u.id)! },
    waypoints: [...leg.map(p => ({ ...p })), { ...op.slotTargets.get(u.id)! }],
    priority: "high" as const,
  }));
  const res = applyEnemyOrders(state, orders);
  let applied = 0;
  core.forEach((u, i) => {
    if ((res.appliedPerOrder[i] ?? 0) > 0) {
      applied++;
      activeAttackerIds.add(u.id);
      attackerTargets.set(u.id, { ...op.slotTargets.get(u.id)! });
    }
  });
  if (applied === 0 && core.length > 0) {
    cancelOperation(state, op, "dispatch_failed");
    return;
  }

  const D = routeDistance(op.staging, [...leg, op.targetPos]);
  op.phase = "launched";
  op.kind = kind;
  op.launchedAt = state.time;
  op.ltReleaseAt = state.time + D * (
    1 / UNIT_STATS.main_tank.speed - 1 / UNIT_STATS.light_tank.speed
  );
  op.ltReleased = op.ltIds.size === 0;

  fieldOperation = op;
  assemblingOperation = null;
  opCaptureConfirmAt = 0;
  opLaunchCooldownUntil = state.time + cfg.p2CooldownSec;

  const mt = core.filter(u => u.type === "main_tank").length;
  const inf = core.filter(u => u.type === "infantry").length;
  opLog(state,
    `#${op.seq} LAUNCH kind=${kind} mt=${mt} inf=${inf} lt=${op.ltIds.size} form=${op.formation} target=${op.targetId} tgt=(${Math.round(op.targetPos.x)},${Math.round(op.targetPos.y)}) ids=[${ordered.map(u => u.id).join(",")}]`);
  // Endpoint-slot audit line (bench asserts: unique, passable, non-inf outside
  // the capture ring). Same tick as LAUNCH so the bench sees launch state.
  const slotAudit = ordered.map(u => {
    const p = op.slotTargets.get(u.id)!;
    const t = u.type === "main_tank" ? "mt" : u.type === "light_tank" ? "lt" : "inf";
    return `${u.id}:${t}:${p.x},${p.y}`;
  }).join(" ");
  opLog(state, `#${op.seq} endpoints ${slotAudit}`);
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
    // EP-V1: operation / occupation property never enters the reserve pool —
    // this single gate is what keeps P0/P1/P3/garrison (all reserve-fed) from
    // poaching fist members.
    if (isOperationReserved(u.id)) return;

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
    if (money >= UNIT_STATS.infantry.cost) enqueueProduction(state, "enemy", "infantry");
  } else if (needsTanks && money >= UNIT_STATS.light_tank.cost) {
    // Prioritize tanks if ratio is off
    enqueueProduction(state, "enemy", money >= UNIT_STATS.main_tank.cost ? "main_tank" : "light_tank");
  } else {
    const roll = Math.random();
    if (roll < 0.6 && money >= UNIT_STATS.infantry.cost) {
      enqueueProduction(state, "enemy", "infantry");
    } else if (roll < 0.85 && money >= UNIT_STATS.light_tank.cost) {
      enqueueProduction(state, "enemy", "light_tank");
    } else if (money >= UNIT_STATS.main_tank.cost) {
      enqueueProduction(state, "enemy", "main_tank");
    } else if (money >= UNIT_STATS.infantry.cost) {
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
  const cfg = getPhaseConfig(state);
  if (state.time < cfg.p1Grace) return; // V3: phase-gated grace (was hardcoded 60)
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
    // V3: P1 uses its own cfg.p1MaxAttack cap (was reusing P2_MAX_ATTACK=8)
    const attackers = reserves.slice(0, Math.min(cfg.p1MaxAttack, reserves.length, p1Budget));
    if (attackers.length === 0) continue;
    const leadType = getLeadType(attackers);
    const { target: rawTarget, corridor } = getTargetPosition(state, front, leadType);
    const finalTarget = getHarassmentApproachTarget(state, rawTarget, attackers);
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
  const cfg = getPhaseConfig(state);
  // EP-V1 final: for el_alamein the massed offensive is OWNED by the operation
  // layer above (operationClaim/operationLaunch). This legacy body is the
  // committed pre-EP baseline, kept 1:1 for non-keypoint scenarios only.
  if (getCurrentStrategicPhase(state) !== "legacy") return;
  if (state.time < cfg.p2Grace) return; // V3: phase-gated grace (was hardcoded 60)
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
  // V3: phase-driven commit ratio (was hardcoded P2_COMMIT_RATIO=0.75)
  const commitCount = Math.min(Math.ceil(pool.length * cfg.p2CommitRatio), budget);
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
  // V3: phase-driven cooldown (was hardcoded P2_COOLDOWN_SEC=50)
  p2CooldownUntil = state.time + cfg.p2CooldownSec;

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

    // Search for reserves: local first, then global fallback.
    // EP-V1b polish (playtest: six forward MBTs drove home across the map for
    // rear garrison duty — pure fuel waste that also stripped the front of its
    // only armor): garrison reinforcement is a REAR-AREA job. Only units
    // standing closer to our HQ than to the player's qualify (generic, no map
    // coordinates), and among them the NEAREST go — getReserveUnitsNear's
    // HP-desc sort is an assault heuristic that otherwise always recalls the
    // fattest tanks regardless of distance. If no rear reserve exists, the
    // post stays thin and P0 reacts on contact instead.
    let reserves = getReserveUnitsNear(state, fac.position, 120).filter(u => isRearUnit(state, u));
    if (reserves.length === 0) {
      reserves = getReserveUnitsNear(state, fac.position, 9999).filter(u => isRearUnit(state, u));
    }
    reserves.sort((a, b) => {
      const da = (a.position.x - fac.position.x) ** 2 + (a.position.y - fac.position.y) ** 2;
      const db = (b.position.x - fac.position.x) ** 2 + (b.position.y - fac.position.y) ** 2;
      return da - db;
    });

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
    // EP-V1: operation members are re-issued by operationMaintain toward their
    // own formation slot ONLY — the phase-2 nearest-visible-enemy retarget
    // below must never hijack a fist member off its axis.
    if (isOperationReserved(id)) continue;
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
      // ── Phase 3: No visible enemies — continue toward the assigned pressure target.
      // 5C-lite: avoid turning idle attackers into default HQ rushers.
      newTarget = storedTarget
        ? { ...storedTarget }
        : findNearestPlayerPressureTarget(state, u.position);
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

/** EP-V1b polish: is this unit in our REAR half — closer to our own HQ than to
 *  the player's? Generic geometric test, no hardcoded coordinates. Used to keep
 *  garrison recalls from stripping forward-committed units. */
function isRearUnit(state: GameState, u: Unit): boolean {
  let ownHQ: Position | null = null;
  let playerHQ: Position | null = null;
  state.facilities.forEach(f => {
    if (f.type !== "headquarters" || f.hp <= 0) return;
    if (f.team === "enemy") ownHQ = f.position;
    else if (f.team === "player") playerHQ = f.position;
  });
  if (!ownHQ || !playerHQ) return true; // degenerate map — don't block reinforcement
  const o = ownHQ as Position, p = playerHQ as Position;
  const dOwn = (u.position.x - o.x) ** 2 + (u.position.y - o.y) ** 2;
  const dPlayer = (u.position.x - p.x) ** 2 + (u.position.y - p.y) ** 2;
  return dOwn < dPlayer;
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

function countLostFriendlyKeypoints(state: GameState): number {
  const winCfg = state.scenarioWinConfig;
  if (!winCfg) return 0;
  return winCfg.friendlyKeypoints.filter(id => {
    const f = state.facilities.get(id);
    return !f || f.hp <= 0 || f.team !== "player";
  }).length;
}

function shouldAssaultPlayerHQ(state: GameState): boolean {
  return state.time >= HQ_ASSAULT_START_SEC
    || countLostFriendlyKeypoints(state) >= HQ_ASSAULT_LOST_KEYPOINTS;
}

function getPlayerHQFallback(state: GameState): Position {
  const hq = findPlayerHQ(state);
  return hq ? { ...hq.position } : { x: 430, y: 90 };
}

function isTargetableForwardPost(state: GameState, facilityId: string): Position | null {
  const f = state.facilities.get(facilityId);
  if (!f || f.hp <= 0 || f.team === "enemy") return null;
  return { ...f.position };
}

function findPlayerPressureTarget(state: GameState, front: typeof state.fronts[0]): Position {
  if (shouldAssaultPlayerHQ(state)) return getPlayerHQFallback(state);

  const mappedPostId = FRONT_PLAYER_POST_MAP[front.id];
  if (mappedPostId) {
    const mapped = isTargetableForwardPost(state, mappedPostId);
    if (mapped) return mapped;
  }

  const center = getFrontCenter(state, front);
  return findNearestPlayerPressureTarget(state, center ?? getPlayerHQFallback(state));
}

function findNearestPlayerPressureTarget(state: GameState, from: Position): Position {
  if (shouldAssaultPlayerHQ(state)) return getPlayerHQFallback(state);

  const candidates: { pos: Position; distSq: number }[] = [];
  for (const kpId of state.scenarioWinConfig?.friendlyKeypoints ?? []) {
    const pos = isTargetableForwardPost(state, kpId);
    if (!pos) continue;
    const dx = pos.x - from.x;
    const dy = pos.y - from.y;
    candidates.push({ pos, distSq: dx * dx + dy * dy });
  }
  candidates.sort((a, b) => a.distSq - b.distSq);
  return candidates[0]?.pos ?? getPlayerHQFallback(state);
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

// FRONT_PLAYER_POST_MAP + ATTACK_CORRIDORS: moved to pressureDirector (EP-V1
// final — single source shared with the operation target candidates). Imported
// at the top of this file; P1/P3's fallback chain below is unchanged.

/** v3: Result of getTargetPosition */
interface AttackTargetResult {
  target: Position;        // Final destination (objective, forward post, visible enemy, or HQ)
  corridor: Position[];    // Corridor waypoints to prepend (may be empty)
}

/** P1/P3 are harassment, not seizure. If their strategic target is exactly a
 * capturable objective, stop on the attackers' side of its capture circle.
 * Tactical deviations toward a visible unit remain untouched. */
function getHarassmentApproachTarget(
  state: GameState,
  target: Position,
  attackers: Unit[],
): Position {
  if (state.scenarioId !== "el_alamein" || attackers.length === 0) return target;
  const objectiveIds = [
    ...(state.scenarioWinConfig?.friendlyKeypoints ?? []),
    ...(state.captureObjectives ?? []),
  ];
  const objective = objectiveIds
    .map((id) => state.facilities.get(id))
    .find((facility) => {
      if (!facility || facility.hp <= 0 || facility.team === "enemy") return false;
      const dx = facility.position.x - target.x;
      const dy = facility.position.y - target.y;
      return dx * dx + dy * dy <= 2 * 2;
    });
  if (!objective) return target;

  const centroid = {
    x: attackers.reduce((sum, unit) => sum + unit.position.x, 0) / attackers.length,
    y: attackers.reduce((sum, unit) => sum + unit.position.y, 0) / attackers.length,
  };
  const dx = centroid.x - objective.position.x;
  const dy = centroid.y - objective.position.y;
  const length = Math.hypot(dx, dy) || 1;
  return {
    x: objective.position.x + (dx / length) * HARASS_STANDOFF_TILES,
    y: objective.position.y + (dy / length) * HARASS_STANDOFF_TILES,
  };
}

/**
 * v3: Select attack target — strategic-first, vision-second.
 *
 * Priority 1: Player/neutral objective in this front (always known, no vision needed)
 * Priority 2: Visible weak enemy within TACTICAL_DEVIATION_MAX of strategic target
 * Priority 3: Allied forward post in this front (5C-lite tug-of-war)
 * Priority 4: Player HQ only after late-game escalation / forward-screen collapse
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

  // If all objectives in this front are already enemy-held, pressure the matching
  // Allied forward post. HQ is reserved for late-game / near-collapse escalation.
  const fallbackTarget = findPlayerPressureTarget(state, front);
  const finalStrategic = strategicTarget ?? fallbackTarget;

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
  const cfg = getPhaseConfig(state);
  if (state.time < cfg.p3Grace) return;         // V3: phase-gated grace (was PROBE_START_TIME=60)
  if (cfg.p3MaxUnits === 0) return;             // V3: phase explicitly disables probe (endgame_defense)
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

  // Cap by both phase config p3MaxUnits and remaining attacker budget
  // (V3: was hardcoded PROBE_MAX_UNITS=6)
  const budget = MAX_ACTIVE_ATTACKERS - activeAttackerIds.size;
  const count = Math.min(cfg.p3MaxUnits, sorted.length, budget);
  const probeUnits = sorted.slice(0, count);
  if (probeUnits.length < PROBE_MIN_UNITS) return;

  const leadType = getLeadType(probeUnits);
  const { target: rawTarget, corridor } = getTargetPosition(state, front, leadType);
  const finalTarget = getHarassmentApproachTarget(state, rawTarget, probeUnits);
  const applied = dispatchAttack(state, probeUnits, finalTarget, corridor, "medium");
  if (applied === 0) return;

  probeCount++;
  // Interval decreases slightly over time (more aggressive later).
  // EP-V1c 降噪: floor 45→90, shrink 3→2 — see PROBE_INTERVAL_BASE note.
  const interval = Math.max(90, PROBE_INTERVAL_BASE - probeCount * 2)
    + (Math.random() * 2 - 1) * PROBE_INTERVAL_VARIANCE;
  probeCooldownUntil = state.time + interval;

  pushDiagnostic(state,
    `P3 probe #${probeCount} front=${front.id} units=${applied} next≈${interval.toFixed(0)}s`
  );
}
