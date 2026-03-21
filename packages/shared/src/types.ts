// ============================================================
// AI Commander — Shared Types (永不推倒)
// All game data models live here.
// ============================================================

// --- Teams & Phases ---

export type Team = "player" | "enemy" | "neutral";
export type GamePhase = "PEACE" | "CONFLICT" | "WAR" | "ENDGAME";

// --- Channels (Day 16B: multi-channel Staff Feed) ---

export type Channel = "ops" | "logistics" | "combat";

export const CHANNEL_LABELS: Record<Channel, string> = {
  ops: "作战",
  logistics: "后勤",
  combat: "战斗",
};

// --- Position ---

export interface Position {
  x: number; // tile col
  y: number; // tile row
}

// --- Terrain ---

export type TerrainType =
  | "plains"
  | "hills"
  | "forest"
  | "swamp"
  | "road"
  | "shallow_water"
  | "deep_water"
  | "bridge"
  | "urban"
  | "mountain";

// --- Unit Types ---

export type GroundUnitType = "infantry" | "light_tank" | "main_tank" | "artillery";
export type NavalUnitType = "patrol_boat" | "destroyer" | "cruiser" | "carrier";
export type AirUnitType = "fighter" | "bomber" | "recon_plane";
export type UnitType = GroundUnitType | NavalUnitType | AirUnitType;

export type UnitCategory = "ground" | "naval" | "air";

export function getUnitCategory(type: UnitType): UnitCategory {
  const ground: UnitType[] = ["infantry", "light_tank", "main_tank", "artillery"];
  const naval: UnitType[] = ["patrol_boat", "destroyer", "cruiser", "carrier"];
  if (ground.includes(type)) return "ground";
  if (naval.includes(type)) return "naval";
  return "air";
}

// --- Unit State ---

export type UnitState =
  | "idle"
  | "moving"
  | "attacking"
  | "defending"
  | "retreating"
  | "patrolling"
  | "dead";

// --- Unit ---

export interface Unit {
  id: number;
  type: UnitType;
  team: Team;
  hp: number;
  maxHp: number;
  position: Position;
  state: UnitState;
  target: Position | null;
  attackTarget: number | null; // target unit id
  visionRange: number;
  attackRange: number;
  attackDamage: number;
  attackInterval: number; // seconds
  moveSpeed: number; // tiles per second
  lastAttackTime: number; // game time of last attack
  manualOverride: boolean; // player took over
  detourCount: number; // consecutive local detours to avoid waypoint growth loops
  waypoints: Position[];
  patrolPoints: Position[];
  orders: Order[];
  patrolTaskId: number | null; // Day 9.5: active PatrolTask id, null if not in a task
}

// --- Facility Types ---

export type FacilityType =
  | "headquarters"
  | "barracks"
  | "shipyard"
  | "airfield"
  | "radar"
  | "fuel_depot"
  | "ammo_depot"
  | "comm_tower"
  | "rail_hub"
  | "repair_station"
  | "defense_tower";

// --- Facility ---

export interface Facility {
  id: string;
  name: string;
  type: FacilityType;
  tags: string[];
  position: Position;
  team: Team;
  hp: number;
  maxHp: number;
  regionId: string;
  strategicEffect: string;
  captureProgress: number; // 0-1, who is capturing
  capturingTeam: Team | null;
}

// --- Region (LLM sees this, not tiles) ---

export interface Region {
  id: string;
  name: string;
  bbox: [number, number, number, number]; // [x1, y1, x2, y2]
  terrainMix: Partial<Record<TerrainType, number>>;
  passability: {
    armor: boolean;
    infantry: boolean;
    naval: boolean;
  };
  chokepoints: string[];
  adjacent: string[];
  strategicValue: string[];
  facilities: string[];
}

// --- Chokepoint ---

export interface Chokepoint {
  id: string;
  name: string;
  position: Position;
  type: "bridge" | "pass" | "gate";
  connects: [string, string]; // region ids
  passableFor: ("armor" | "infantry" | "naval")[];
  destructible: boolean;
  hp: number;
  maxHp: number;
}

// --- Resources ---

export interface Resources {
  money: number;
  fuel: number;
  ammo: number;
  intel: number;
}

// --- Economy State ---

export interface EconomyState {
  resources: Resources;
  readiness: number; // 0-1
  baseIncome: Resources; // per 30s
  bonusIncome: Resources; // from captured facilities
  lastIncomeTime: number;
}

// --- Orders (the 11 allowed actions) ---

export type OrderAction =
  | "attack_move"
  | "defend"
  | "retreat"
  | "flank"
  | "hold"
  | "patrol"
  | "escort"
  | "sabotage"
  | "recon"
  | "produce"
  | "trade";

export interface Order {
  unitIds: number[];
  action: OrderAction;
  target: Position | null;
  targetUnitId?: number;
  targetFacilityId?: string;
  priority: "low" | "medium" | "high";
  provisional?: boolean; // local engine guess, will be replaced by LLM
  isPlayerCommand?: boolean; // allows player-issued orders on manualOverride units
  produceUnitType?: UnitType; // for "produce" action: which unit type to build
  tradeType?: TradeType;      // for "trade" action: which trade to execute
  patrolTaskParams?: {        // Day 9.5: patrol task creation params (integer tile coords)
    centerTileX: number;
    centerTileY: number;
    radius: number;
  };
}

// --- Production ---

export interface ProductionOrder {
  unitType: UnitType;
  facilityId: string; // which building produces it
  startTime: number;
  duration: number;
  cost: number;
  fuelCost: number;
}

// --- Trade ---

export type TradeType = "buy_fuel" | "buy_ammo" | "buy_intel" | "sell_fuel" | "sell_ammo";

export interface TradeAction {
  type: TradeType;
  cost: number;
  gain: number;
  cooldown: number;
  lastTradeTime: number;
}

// --- Conditional Orders ---

export type ConditionalTrigger =
  | "enemy_reinforcement_detected"
  | "unit_losses_exceed_threshold"
  | "target_destroyed"
  | "timer_elapsed"
  | "force_ratio_changed"
  | "supply_critical";

export interface ConditionalOrder {
  id: string;
  trigger: ConditionalTrigger;
  action: OrderAction;
  targetPosition?: Position;
  unitIds?: number[];
  notifyPlayer: boolean;
  message: string;
  expiresSec?: number;
  createdAt: number;
}

// --- Mission ---

export type MissionType = "sabotage" | "destroy" | "cut_supply" | "capture" | "defend_area";
export type MissionStatus = "active" | "completed" | "failed" | "cancelled";

export interface Mission {
  id: string;
  type: MissionType;
  name: string;
  description: string;
  targetFacilityId?: string;
  targetRegionId?: string;
  assignedUnitIds: number[];
  progress: number; // 0-1
  status: MissionStatus;
  etaSec: number;
  threats: string[];
  createdAt: number;
}

// --- Style Params (AI learns your style) ---

export interface StyleParams {
  riskTolerance: number;    // 0-1 higher = more aggressive
  focusFireBias: number;    // 0-1 higher = focus fire one target
  objectiveBias: number;    // 0-1 higher = complete mission at any cost
  casualtyAversion: number; // 0-1 higher = retreat sooner
  reconPriority: number;    // 0-1 higher = scout before attacking
  tempoBias: number;        // 0-1 higher = prefer fast attacks
}

export const DEFAULT_STYLE: StyleParams = {
  riskTolerance: 0.5,
  focusFireBias: 0.5,
  objectiveBias: 0.5,
  casualtyAversion: 0.5,
  reconPriority: 0.5,
  tempoBias: 0.5,
};

// --- Front / Battle Line ---

export interface Front {
  id: string;
  name: string;
  regionIds: string[];
  playerPower: number;  // aggregated force index
  enemyPower: number;   // visible enemy force (? if unknown)
  enemyPowerKnown: boolean;
  engagementIntensity: number; // 0-1
  supplyStatus: "OK" | "LOW" | "CRITICAL";
  keyEvents: string[];
}

// --- Fog State ---

export type Visibility = "unknown" | "explored" | "visible";

// --- Supply Event ---

export interface SupplyOption {
  label: string;
  description: string;
  units?: { type: UnitType; count: number }[];
  resources?: Partial<Resources>;
}

// --- Combat Visual Effects ---

export interface AttackLine {
  fromX: number;
  fromY: number;
  toX: number;
  toY: number;
  startTime: number; // game time when created
  duration: number;   // seconds to display
  color: string;
}

export interface Explosion {
  x: number;
  y: number;
  startTime: number;
  duration: number;   // seconds to display
  radius: number;     // max radius in tiles
}

export interface CombatEffects {
  attackLines: AttackLine[];
  explosions: Explosion[];
}

// --- Patrol Task (Day 9.5) ---

export interface PatrolTask {
  id: number;
  center: Position;
  radius: number;            // patrol area radius in tiles (5=small, 10=medium, 15=large)
  unitIds: number[];
  cooldownSec: number;       // seconds between re-targeting attempts (default 6)
  lastTargetTime: number;    // game time of last target assignment
  consecutiveFails: number;  // how many consecutive cycles all units failed to find target
  paused: boolean;           // true when fail-paused
  pauseUntil: number;        // game time when pause expires
}

// --- Squad / Formation System (Day 10.5) ---

export type SquadRank = "squad_leader" | "platoon_leader" | "company_commander" | "battalion_commander";

export interface SquadLeader {
  name: string;                    // auto-generated captain name
  rank: SquadRank;                 // determined by squad size
  personality: "cautious" | "balanced" | "aggressive";
}

export type CommanderKey = "chen" | "marcus" | "emily";
export type SquadRole = "leader" | "commander";

export interface Squad {
  id: string;                      // "T5", "I3", etc.
  name: string;                    // "坦克5分队"
  unitIds: number[];               // unit roster
  leader: SquadLeader;
  currentMission: string | null;   // "advance", "defend", etc.
  missionTarget: Position | null;
  morale: number;                  // 0-1, affected by casualties
  formationStyle: "line" | "wedge" | "column";
  // Phase 2: tree hierarchy fields
  parentSquadId?: string;                // 上级 squad，undefined = 直属根指挥官
  ownerCommander: CommanderKey;          // 所属根指挥官
  leaderName: string;                    // 组长名字（可自定义）
  role: SquadRole;                       // leader=直管兵，commander=管 leader
}

// --- Tag (player map markers, Day 15) ---

export interface Tag {
  id: string;        // "tag_1", "tag_2", ...
  name: string;      // player-chosen label, e.g. "制高点"
  position: { x: number; y: number };
  createdAt: number; // game time
}

// --- Report Events (Day 16A: auto-report system) ---

export type ReportEventType =
  | "UNDER_ATTACK"
  | "SUPPLY_LOW"
  | "FACILITY_CAPTURED"
  | "FACILITY_LOST"
  | "MISSION_DONE"
  | "MISSION_FAILED"
  | "HQ_DAMAGED"
  | "SQUAD_HEAVY_LOSS"
  | "POSITION_CRITICAL"
  | "MISSION_STALLED"
  | "ECONOMY_SURPLUS"
  | "ECONOMY_REPORT";

export interface ReportEvent {
  type: ReportEventType;
  time: number;
  message: string;
  severity: "info" | "warning" | "critical";
  entityId?: string;
  actionRequired?: boolean; // true = ASK_DECISION (staff-ask), false/undefined = REPORT_ONLY
}

// --- Diagnostics (engine → UI message channel) ---

export interface DiagnosticEntry {
  time: number;
  code: string;
  message: string;
}

// --- Battle Markers (Prompt 5: battlefield visual awareness) ---

export interface BattleMarker {
  id: string;
  type: "attack_zone" | "death" | "critical_front";
  x: number;
  y: number;
  radius?: number;
  createdAt: number;
  expiresAt?: number;
  opacity: number;
  pulsePhase: number;
}

// --- Game State (the big one) ---

export interface GameState {
  tick: number;
  time: number; // elapsed seconds
  phase: GamePhase;
  mapWidth: number;
  mapHeight: number;
  terrain: TerrainType[][]; // [row][col]
  units: Map<number, Unit>;
  facilities: Map<string, Facility>;
  regions: Map<string, Region>;
  chokepoints: Map<string, Chokepoint>;
  fronts: Front[];
  economy: { player: EconomyState; enemy: EconomyState };
  fog: Visibility[][]; // [row][col] for player
  missions: Mission[];
  conditionalOrders: ConditionalOrder[];
  style: StyleParams;
  productionQueue: { player: ProductionOrder[]; enemy: ProductionOrder[] };
  nextUnitId: number;
  supplyTimer: number; // seconds until next supply
  warDeclared: boolean;
  gameOver: boolean;
  winner: Team | null;
  phaseStartTime: number;
  endgameStartTime: number | null;
  logisticsZeroSec: { player: number; enemy: number };
  warEngageSec: number;
  gameOverReason?: string;
  combatEffects: CombatEffects;
  diagnostics: DiagnosticEntry[];
  reportEvents: ReportEvent[];
  patrolTasks: PatrolTask[];
  nextPatrolTaskId: number;
  squads: Squad[];
  nextSquadNum: { [prefix: string]: number };
  tags: Tag[];
  nextTagNum: number;
  doctrines: import("./doctrine").StandingOrder[];
  doctrineCooldowns: Record<string, number>; // doctrineId → last alert game time
  tasks: TaskCard[];
  battleMarkers: BattleMarker[];
  recentDeaths: { x: number; y: number; time: number }[];
  battleMarkerScanAccum: number;
  battleMarkerDeathCursor: number;
}

// --- Task Card (Prompt 3: visible task tracking) ---

export type TaskStatus = "assigned" | "moving" | "engaged" | "holding" | "failing" | "completed" | "cancelled";
export type TaskPriority = "low" | "normal" | "high" | "critical";
export type TaskKind = "combat" | "economy";

export interface TaskCard {
  id: string;
  title: string;
  commander: Channel;
  assignedSquads: string[];
  status: TaskStatus;
  priority: TaskPriority;
  kind: TaskKind;             // "combat" = squad-tracked, "economy" = fire-and-forget
  constraint?: string;       // e.g. "must_hold", "delay_only"
  createdAt: number;
  statusChangedAt: number;   // every status transition must update this
  doctrineId?: string;
}

// --- LLM Response Types ---

export interface AdvisorOption {
  label: string;
  description: string;
  risk: number;
  reward: number;
  /** @deprecated Use intents[] instead. Kept for backward compat with single-intent LLM output. */
  intent: import("./intents").Intent;
  /** Array of intents for this option. Multi-intent allows compound commands. */
  intents: import("./intents").Intent[];
}

export type ResponseType = "EXECUTE" | "CONFIRM" | "ASK" | "NOOP";

export interface AdvisorResponse {
  brief: string;
  options: AdvisorOption[];
  recommended: "A" | "B" | "C";
  urgency: number; // 0-1
  responseType?: ResponseType;
  suggestProduction?: {
    type: UnitType;
    reason: string;
  };
  standingOrder?: {
    type: string;
    locationTag: string;
    priority: string;
    allowAutoReinforce: boolean;
  };
  cancelDoctrine?: string; // doctrine ID to cancel
}

export interface LightAdvisorResponse {
  brief: string;
  urgency: number;
}
