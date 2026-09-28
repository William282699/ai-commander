// ============================================================
// AI Commander — Shared Types (永不推倒)
// All game data models live here.
// ============================================================

import type { TradeBudget, ProduceBudget, IntentType } from "./intents";
import type { SelectionDecision } from "./dispatchSelection"; // 刀己：选来源的答复 // 7b.1 / emily-production-v1: Orders carry budget intents through to settlement；IntentType：刀C 台账登记动作

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

export type GroundUnitType = "infantry" | "light_tank" | "main_tank" | "artillery" | "commander" | "elite_guard";
export type NavalUnitType = "patrol_boat" | "destroyer" | "cruiser" | "carrier";
export type AirUnitType = "fighter" | "bomber" | "recon_plane";
export type UnitType = GroundUnitType | NavalUnitType | AirUnitType;

export type UnitCategory = "ground" | "naval" | "air";

export function getUnitCategory(type: UnitType): UnitCategory {
  const ground: UnitType[] = ["infantry", "light_tank", "main_tank", "artillery", "commander", "elite_guard"];
  const naval: UnitType[] = ["patrol_boat", "destroyer", "cruiser", "carrier"];
  if (ground.includes(type)) return "ground";
  if (naval.includes(type)) return "naval";
  return "air";
}

/**
 * Foot / biological-infantry unit types. These share gameplay rules with
 * regular infantry: they do NOT consume fuel to move, they DO benefit from
 * urban/forest cover, they can entrench, and they can capture facilities in
 * scenarios that allow infantry capture.
 *
 * Previously there was no single source of truth for this and each subsystem
 * did its own ad-hoc check like `type !== "infantry"`, which incorrectly
 * treated commander and elite_guard as mechanized — causing a silent shared-
 * pool fuel drain that stalled entire squads.
 */
export function isFootUnit(type: UnitType): boolean {
  return type === "infantry" || type === "commander" || type === "elite_guard";
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
  isPlayerControlled?: boolean; // MVP2: commander + elite_guard can receive mouse commands
  lastDamagedAt?: number;       // MVP2: game time of last damage taken (for regen delay)
  lastDamagedById?: number;     // unit id of last attacker (for chase/response logic)
  entrenchLevel?: 0 | 1 | 2;   // El Alamein: infantry trench level (0=none, 1=shallow, 2=deep)
}

/**
 * Units that are hard-reserved for direct player control.
 * They may still auto-fire in combat, but they are not dispatchable by LLM/planner/auto-behavior.
 */
export function isManualOnlyUnit(unit: Pick<Unit, "isPlayerControlled">): boolean {
  return unit.isPlayerControlled === true;
}

/**
 * Player units available to planner/LLM dispatch.
 * Excludes dead, manually overridden, and manual-only units.
 */
export function isDispatchablePlayerUnit(
  unit: Pick<Unit, "team" | "state" | "manualOverride" | "isPlayerControlled">,
): boolean {
  return (
    unit.team === "player" &&
    unit.state !== "dead" &&
    !unit.manualOverride &&
    !isManualOnlyUnit(unit)
  );
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
  lastDamagedAt?: number;  // MVP2: game time of last damage taken (for HQ regen delay)
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
  /** Don't draw this region's name on the map (第 8 级 fix A).
   *
   *  刀3 把三个大矩形切成了子块，好让"一点至多属于一条战线"成立。那是**归属判定**
   *  需要的粒度，不是长官需要看见的粒度——屏上多出四个"…东段/…西段/…南缘/…北段"，
   *  读起来像地图变复杂了，其实地形一格没动。
   *
   *  用数据标记，不用名字模式：将来谁给子块起个不带"段"字的名字，基于后缀的过滤
   *  会静默失效，这个 flag 不会。可选字段，additive——不写就照旧画。 */
  hideMapLabel?: true;
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
  waypoints?: Position[]; // optional multi-waypoint path (from named routes)
  provisional?: boolean; // local engine guess, will be replaced by LLM
  isPlayerCommand?: boolean; // allows player-issued orders on manualOverride units
  produceUnitType?: UnitType; // for "produce" action: which unit type to build
  produceBudget?: ProduceBudget; // emily-production-v1: budget-scaled produce, settled in applyOrders
  tradeType?: TradeType;      // for "trade" action: which trade to execute
  tradeBudget?: TradeBudget;  // 7b.1: budget-scaled trade (absent/single = one buy)
  patrolTaskParams?: {        // Day 9.5: patrol task creation params (integer tile coords)
    centerTileX: number;
    centerTileY: number;
    radius: number;
  };
  crisisFrontId?: string;     // Tag: this order is a reinforcement for this front (dedup)
  // Step 6a groundwork (issued only from 6b onward): mark an engine-initiated
  // autonomous order and carry a correlation id so a player's later reaction can
  // be tied back to the action in the [EVENT] log. 6a poses questions only and
  // issues NO autonomous orders, so these stay undefined until 6b.
  autonomous?: boolean;
  actionId?: string;
  /** retreat-scope 刀C: 谁下的这道令。缺席 ⇒ 视同 "auto"，**不记台账**
   *  （fail-safe 方向：忘了填最多是漏记一条，绝不会记错一条）。 */
  origin?: OrderOrigin;
  /** 刀C: 记账用的其余信息。只有 origin 是 advisor/mouse 时才有意义。 */
  dispatchMeta?: DispatchMeta;
}

// --- Dispatch ledger (retreat-scope 刀C) ---
//
// 「某条战线的部队」过去只有一种解释：此刻站在那条线包围盒里的可调单位（纯几何）。
// 部队一开拔就不再"属于"原战线——而玩家心里的「南线的部队」可能是**位置**
// （现在守在那儿的），也可能是**来源**（之前从那儿派出去的）。
// 这是两种指代，而 intent 里只有一种表达方式（LEDGER §F2 的一张脸）。
//
// 台账让「刚从南线派去山脊那批」有地方可写：每次玩家命令真的派出了兵，
// 引擎记一条 Dispatch，号由引擎生成（M#，避开 G# 那套临时编队号的命名空间）。
// ★ 由**引擎在真派兵那一刻**写，不是从对话历史反推——§F2 就是被上下文带偏的。

/** 这批人当时是被怎么指出来的。
 *  `ticket`（刀寅）：凭陈报出的临时编队号（G#）派出，sourceKey 是那个号。
 *  过去这一类在票据改写 intent 之后只剩 `pool`／空串——台账里查不到它从哪儿来。 */
export type DispatchSourceKind = "front" | "squad" | "dispatch" | "selection" | "pool" | "ticket";

export interface Dispatch {
  /** 本局内的短号，形如 "M3"。 */
  id: string;
  atGameTime: number;
  sourceKind: DispatchSourceKind;
  /** 当时那条 intent 的来源字段原文（战线 id / 分队号 / 旧任务号 …）。 */
  sourceKey: string;
  action: IntentType;
  /** 引擎真送他们去的地方（与回执同源）。空串＝没有去处可宣称。 */
  targetName: string;
  /** 登记时的名单。**活成员要现查**（liveDispatchMembers）——名单是快照，
   *  战场不是：人会死、会被改派。 */
  memberIds: number[];
  status: "active" | "closed";
  /**
   * 刀寅：每个成员**当初从哪条战线出发**（战线 id；null＝当时不在任何一条战线上）。
   *
   * 是**来源事实**，与执行选兵约束分开：按接到命令那一刻的实际位置判，不从
   * 「北线前哨附近未编组群」这类显示文本里猜，也不拿临时编队票的**目标**战线充数。
   * 一批人可以来自几条线，所以逐人记，不硬塞成一个来源。
   * 对这批人改令（fromDispatch）时逐人继承——撤回一次之后，它仍是「从南线派出去的那批」。
   */
  originFrontById?: Record<number, string | null>;
  /**
   * 刀寅：这批人是凭哪张临时编队票（G#）派出去的。**只作身份关联**：
   * 名单永远是 memberIds（真接到命令的人），不是票上报的那份候选名单。
   * 改令时继承。
   */
  ticketRef?: string;
  /** 刀寅：那张票当时给长官的叫法（「中央前哨附近未编组群」）。只进信封，帮模型把「刚才那几个」对上这一条。 */
  ticketLabel?: string;
  /**
   * 刀寅：这次外派每个人的**出发位置**（接到命令那一刻的真实坐标）。
   * 「叫回来」回的就是这里——逐人记，来自几处就是几处，不编一个共同据点。
   * 生命周期（**与长官用任务号还是分队名指人无关**）：一次外派从离开驻地开始，到**到达**
   * 为止（到了目的地，或叫回后回到出发地）。还在路上时，不管下什么令、怎么称呼，起点都延续；
   * 「回原处」的令永远延续起点；到达之后再接到别的令，才从到达的地方开始新的一次。
   * 「在路上」按接到新令**之前**那道令的落点判（离落点还远＝在路上）。
   */
  originPosById?: Record<number, { x: number; y: number }>;
  /**
   * 刀寅：出发时就近的我方据点（只作**叫法**：「出发地（中央前哨附近）」）。
   * 坐标永远用 originPosById，据点不当坐标来源；附近没有我方据点就不记，回执也不提据点。
   */
  originFacilityById?: Record<number, string>;
  /** 刀寅：这条记录是一道「回原处」的令（叫回）。 */
  recall?: boolean;
}

/** 下令方是谁。记账只认这个标记，**不认调用的是哪个函数**：
 *  `applyPlayerCommands` 是鼠标专用（它给每个单位盖 manualOverride），
 *  而对话派兵走的是 `applyOrders`——按函数认会漏掉说话派出去的每一个兵。 */
export type OrderOrigin = "advisor" | "mouse" | "auto";

/** 记账要用、而 Order 本身没有的那几样。缺席 ⇒ 按单条 order 各记各的。 */
export interface DispatchMeta {
  /** 同一 key 的 order 合成一条任务。一句话安排两个任务 ⇒ 两个 key，两条记录。 */
  group: string;
  sourceKind: DispatchSourceKind;
  sourceKey: string;
  action: IntentType;
  targetName: string;
  /** 刀寅：凭票派兵时那张票的叫法（sourceKind==="ticket" 才有）。 */
  ticketLabel?: string;
  /** 刀寅：这道令是「回到这次外派的出发地」——起点一律延续，不管长官用什么称呼指的人。 */
  returnTo?: "origin";
}

// --- Order execution result (retreat-scope 刀B) ---
//
// 为什么必须有这个类型：`applyOrders` 过去返回 `void`，而它对每条 order 的
// unitIds 还要再过四道过滤（单位不在了 / 不是我方 / 指挥官亲兵 / 已被手动接管）。
// 「计划选中 8 个、实际只对 5 个下了令」在旧结构里**外界无从得知**，于是屏上
// 和耳朵只能照着"计划"报数——换了个位置的假确认。
//
// 三类结局必须分开，不许合并：
//   applied      真对它下了令
//   alreadyDoing 它已经在执行等价的命令（幂等跳过）——不算新派兵，**也不算失败**
//   rejected     没接到命令，且带原因
export type OrderRejectReason =
  | "unit_gone"           // 单位不在了（阵亡 / 已移除）
  | "not_player_unit"     // 不是我方单位
  | "player_controlled"   // 指挥官亲兵，非玩家亲自下令不动它
  | "manual_override";    // 已被玩家手动接管

export interface ApplyOrderOutcome {
  /** 在传入的 orders 数组里的下标——调用方据此把结果对回自己的意图。 */
  orderIndex: number;
  action: OrderAction;
  appliedUnitIds: number[];
  /** 幂等跳过：已经在执行等价命令。第三类结局，不许塞进 rejected 冒充失败。 */
  alreadyDoingUnitIds: number[];
  rejected: { unitId: number; reason: OrderRejectReason }[];
  /**
   * 刀庚：经济单（produce / trade）的**真实结算**。
   *
   * 经济单没有"人头"，三栏 unitIds 天生是空的——刀甲当时的权宜是"经济单一律记
   * applied，复述计划那一行"。那不是执行事实：实测 $170 造 3 个步兵，队列真的
   * 只进了 2 个、钱剩 $10，回执照样说「生产步兵 ×3。」；预算生产/预算交易
   * 完全失败（钱一分没动）时回执还说「全力生产主战坦克。」。
   *
   * 所以经济单也要有一等的执行结果。**屏幕、TTS、对话 context 一律从这里取数**；
   * `state.diagnostics` 降为调试/系统日志，不再当前端回执的数据总线。
   */
  economy?: EconomyOutcome;
}

// --- 刀庚: 经济单的真实结算结果 ---

export type EconomyOpKind = "produce" | "trade";

export interface EconomyOutcome {
  kind: EconomyOpKind;
  /** produce: UnitType；trade: TradeType。机器用。 */
  subject: string;
  /** 给玩家看的中文名（「步兵」/「燃油」）。 */
  subjectLabel: string;
  /** 这一条 order 想办成几件（引擎自己算出来的那个数，不是模型说的）。 */
  requested: number;
  /** **真的**办成了几件。 */
  succeeded: number;
  /** **真的**没办成几件。 */
  failed: number;
  /** 真的花出去多少钱。 */
  moneySpent: number;
  /** 真的到手多少钱（卖出）。 */
  moneyGained: number;
  /** 真的到手多少资源（买燃油 +N）。 */
  resourceGained: number;
  /** 失败原因（引擎自己那句人话；成功就是空数组）。 */
  failReasons: string[];
}

export interface ApplyResult {
  perOrder: ApplyOrderOutcome[];
  /** 全批汇总（去重）——播报层取数只取这里，不在 UI 里重算一遍。 */
  appliedUnitIds: number[];
  alreadyDoingUnitIds: number[];
  rejectedUnitIds: number[];
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

/**
 * 队长性格。**闭集**——三个值，不是可扩展的关键词表。
 * 引擎侧靠它决定部队自动交战多远（见 core/autoBehavior.ts 的 PERSONALITY_RANGE）。
 * 提出来单独命名，是因为 namePool（名册）/ autoBehavior（求值）/ OrgTree（显示）
 * 三处都要引用同一个类型；写成三份字面量联合就是三个真相源。
 */
export type LeaderPersonality = "cautious" | "balanced" | "aggressive";

export interface SquadLeader {
  name: string;                    // auto-generated captain name
  rank: SquadRank;                 // determined by squad size
  /** 天生的，不可由玩家调整（用人是决策，调数值是配置界面）。名册建队时钉死。 */
  personality: LeaderPersonality;
}

export type CommanderKey = "chen" | "marcus" | "emily";

/** All commanders, in display order. */
export const COMMANDER_KEYS: readonly CommanderKey[] = ["chen", "marcus", "emily"];

/**
 * Which channel (=role) each commander holds. GAME DATA, not UI decoration —
 * 手测账③ needs it in the engine to answer "who owns the unassigned units",
 * and the answer must be a ROLE lookup, never the hardcoded string "chen"
 * (re-assign the combat role and the rule follows it).
 */
export const COMMANDER_CHANNEL: Record<CommanderKey, Channel> = {
  chen: "combat",
  marcus: "ops",
  emily: "logistics",
};

export type SquadRole = "leader" | "commander";

export interface Squad {
  id: string;                      // "T5", "I3", etc.
  name: string;                    // "坦克5分队"
  unitIds: number[];               // unit roster
  leader: SquadLeader;
  currentMission: string | null;   // "advance", "defend", etc.
  missionTarget: Position | null;
  morale: number;                  // 0-1, affected by casualties
  formationStyle: "line" | "wedge" | "column" | "encircle";
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
  | "FACILITY_CONTESTED"
  | "CAPTURE_STALLED"
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

// --- Decision Review (Step 7e: battle-time decision retrospect) ---
// Minimal serializable record shapes ONLY — they live on GameState, so they
// must be defined here (shared never imports core). All capture/assess logic
// lives in packages/core/src/decisionReview.ts.

/** Intent types 7e records for review. produce/trade/recon/patrol/hold are
 *  deliberately excluded in 7e.1 (economy review deferred; tiny dispatches
 *  aren't decisions worth a retrospect). */
export type DecisionReviewKind = "attack" | "defend" | "retreat" | "capture" | "sabotage";

/** Per-front mini snapshot at decision time (cross-front delta baseline). */
export interface DecisionFrontSnapshot {
  frontId: string;
  engagementIntensity: number;
  /** Survival estimate (sec) of our committed force there; null = stable or no committed force. */
  collapseSeconds: number | null;
}

/** Baseline captured at decision time. Engine-read values only, serializable. */
export interface DecisionReviewBaseline {
  fuel: number;
  ammo: number;
  money: number;
  /** Count of resolved assigned units alive at decision time (casualty basis). */
  assignedAlive: number;
  front?: {
    engagementIntensity: number;
    collapseSeconds: number | null;
    powerRatio: number | null;
  };
  facility?: {
    team: Team;
    captureProgress: number;
    hp: number;
  };
  /** ALL fronts at decision time (anchor included; cross-front delta uses the others). */
  fronts: DecisionFrontSnapshot[];
  /** Keypoint/objective facility owners at decision time (facilityId → team). */
  keypointOwners: Record<string, Team>;
}

/**
 * One recorded player decision awaiting engine review (Step 7e). The web
 * layer records these from the main ChatPanel command path after orders
 * dispatch; the engine reviews the outcome ~90s later. `assignedUnitIds` are
 * the units resolveIntent assigned, filtered to living player units at
 * decision time ("resolved assigned units") — NOT a claim about what
 * applyOrders finally applied (it returns void; some may still be skipped).
 */
export interface DecisionReviewRecord {
  id: string;
  /** Correlation id of the escalation question this decision answered, if any. */
  escalateId?: string;
  /** Channel the command was given on. */
  channel: Channel;
  kind: DecisionReviewKind;
  createdAt: number; // game time
  dueAt: number;     // game time the engine reviews the outcome
  /** Battlefield anchor — at least one is set (anchorless decisions are never recorded). */
  frontId?: string;
  facilityId?: string;
  assignedUnitIds: number[];
  baseline: DecisionReviewBaseline;
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

// --- Scenario ---

export type ScenarioId = "dual_island" | "el_alamein" | "tutorial";

// --- Named Route (scenario-specific pre-defined movement paths) ---

export interface NamedRoute {
  id: string;           // "via_balbia"
  name: string;         // "沿海公路"
  waypoints: Position[];// ordered waypoints
  passableFor: UnitCategory[];
  connectedRoutes: string[]; // IDs of routes that intersect
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
  /** 5C-lite: 30-min rating; absent on immediate win/loss. */
  gameOverRating?: "major_victory" | "victory" | "minor_victory" | "draw" | "minor_defeat" | "defeat";
  /** 5C-lite: score breakdown for game-over UI. */
  gameOverBreakdown?: { capturedObjectives: number; lostKeypoints: number; score: number };
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
  /** retreat-scope 刀C: 任务台账。重开一局即清空（它活在 GameState 里）。 */
  dispatches: Dispatch[];
  nextDispatchNum: number;
  battleMarkers: BattleMarker[];
  /** Step 7e: recorded player decisions awaiting engine review (queue, capped). */
  decisionReviews: DecisionReviewRecord[];
  recentDeaths: { x: number; y: number; time: number }[];
  battleMarkerScanAccum: number;
  battleMarkerDeathCursor: number;
  advisorTriggerCooldowns: Record<string, number>; // ruleKey → last trigger game time

  // --- Scenario system ---
  scenarioId: ScenarioId;
  namedRoutes: NamedRoute[];
  captureObjectives?: string[];  // facility IDs that may count toward victory (subset required via scenarioWinConfig)
  /**
   * Scenario-driven win/loss tuning (Step 5B). When set, warPhase.checkGameOver
   * evaluates victory/defeat against these thresholds instead of the legacy
   * "all captureObjectives taken" path. Leave undefined for scenarios that
   * still use legacy capture-all logic (currently dual_island).
   */
  scenarioWinConfig?: {
    timeLimitSec: number;
    requiredCapturedObjectives: number;   // K-of-N from captureObjectives
    friendlyKeypoints: string[];          // facility IDs whose loss is a defeat trigger
    maxFriendlyKeypointsLost: number;     // defeat when this many keypoints are lost
    /** 达成 K-of-N 时那句通关文案。缺席＝沿用旧的写死句（`warPhase.ts`）。
     *  ★ 加它是因为胜利文案里写死了"阿拉曼大捷！"，教学关通关会恭喜玩家
     *  打赢了阿拉曼（审核挖出）。场景专属的话就该由场景自己带。 */
    victoryLabel?: string;
    /** 5C-lite: 30-min timeout rating thresholds on score = captured - lost. */
    ratingThresholds?: {
      majorVictory: number; victory: number; minorVictory: number;
      draw: number; minorDefeat: number; defeat: number;
    };
  };
  /** 敌方 AI 选择器。
   *  - `"defensive"` = El Alamein 那套（`scenario/elAlamein/defensiveAI.ts`）
   *  - `"offensive"` / 缺席 = 老的全局 `enemyAI.ts::runEnemyAI`
   *  - `"none"` = **都不跑**（教学关）
   *
   *  ★ 为什么要有 `"none"`：`enemyAI.ts` 与 `battleAwareness.ts` 里那两道闸是
   *  **反向**的（`=== "defensive"` 才 return），所以"字段缺席"并不等于"没有敌方
   *  AI"——它等于"跑老的那套"。教学关一度就栽在这：以为不设就是敌人不动，
   *  实测敌军一路向西游到中央谷地、守军离岗。 */
  enemyAIMode?: "offensive" | "defensive" | "none";
  entrenchTimers: Map<number, number>;  // unitId → seconds spent stationary in defend
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

// ── Command-Preflight 地基二: pending semantic decision ──
// The LLM's verdict on a player reply while a high-impact contract awaits
// approval. STRICT four-value contract: undefined (field missing/invalid)
// is a PROTOCOL FAILURE — distinct from explicit null ("unrelated command").
export type PendingDecision = "authorize" | "cancel" | "amend" | null;
export type PendingPhase = "voicing" | "awaiting_reply";
/** Captured at REQUEST time; the response is only consumed if it still matches. */
export interface PendingRequestTag {
  pendingId: string;
  channel: string;
  sessionId: string;
}
/** Read-only view of the live contract for the pure consumption judge. */
export interface PendingContractView {
  id: string;
  channel: string;
  sessionId: string;
  phase: PendingPhase;
  expiresAt: number;
}
export type PendingVerdict =
  | "no_pending"        // request carried no tag → field ignored, normal flow
  | "stale"             // tag no longer matches a live awaiting contract (wrong
                        //   id/channel/session, expired, or still voicing) —
                        //   the contract must NOT execute
  | "unrelated"         // explicit null → normal flow; contract stays till expiry
  | "authorize"         // execute ONLY the captured old contract
  | "amend"             // execute ONLY the new intents
  | "cancel"            // execute neither; drop the contract
  | "protocol_failure"; // field missing/invalid while a contract was tagged →
                        //   execute NOTHING on either side

/** 服务端兜底的原因：模型回了东西但解析不出来 / 根本没回来（网络、限流、报错）。 */
export type AdvisorFailure = "parse" | "comms";

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
  /** 地基二: present on BOTH schema return paths (empty & non-empty options).
   *  undefined = field missing/invalid (protocol failure when a contract was
   *  pending); null = model explicitly判定为普通新命令. */
  pendingDecision?: PendingDecision;
  /** 语音输入 V1：模型转写的长官原话（只有语音回合才有）。
   *
   *  它不是装饰，是三样东西的输入：长官气泡的正文、`canAutoExecute` 找锚点的
   *  文本、以及 I2/D4 要的真语音日志。**缺席即 fail-closed**——语音回合没有
   *  heard 时引擎不许替长官猜他说了什么（客户端据此禁入 bucket A）。
   *  与 pendingDecision 同族：白名单重建会静默吃掉没登记的根级字段，
   *  schema 的**两条 return 路径**都必须带。 */
  heard?: string;
  /** spoken 层：这一轮**只说给耳朵**的那一两句（只有语音回合才有）。
   *
   *  病根＝同一份正文要同时伺候眼睛和耳朵：屏上要番号 `[临时编队G13]`、
   *  精确数字、英文代号，同一段话念出来就是播报员。分层之后正文照旧写给
   *  眼睛，spoken 是同一件事的口语版，语音回合的 TTS 只念它。
   *
   *  **它从属于正文**（审定 R1）：不得携带正文与单子里没有的事实、不得与
   *  它们相左，有出入以屏上为准——spoken 是"说给你听的那一版"，不是第二
   *  张嘴（否则又开一个「嘴与账本」缺口）。
   *
   *  与 heard/pendingDecision 同族：白名单重建会静默吃掉没登记的根级字段，
   *  schema 的**两条 return 路径**都必须带。**缺席一律退回念正文**（现状
   *  行为），绝不静默哑掉——一条规则覆盖四种缺席：模型忘写 / 白名单吃掉 /
   *  JSON 解析失败走兜底 / 通讯中断。 */
  spoken?: string;
  /** 刀己：对「您说的是哪一批？」的答复。与 heard/spoken/pendingDecision **同族**
   *  ——白名单重建会静默吃掉没登记的根级字段，schema 的**两条 return 路径**都
   *  必须带。缺席/非法一律按协议失败处理（零执行、再问一次），绝不放行。 */
  dispatchSelection?: SelectionDecision;
  /** 第六轮：**服务端没拿到可用的参谋答复**（解析失败 / 通讯中断 / 限流）。
   *
   *  只由服务端兜底（`createFallbackResponse`）写入，模型写不进来（白名单重建不登记它）。
   *  在场 ⇒ 这一轮是**失败轮**：客户端零执行（options / 持续命令一律不看）、不消费任何
   *  待决合同或选择、不算参谋又答了一轮，屏上与耳朵只说引擎的事实（没收到答复、什么都没执行）。
   *  ★不能拿 `warning` 判：正常答复也会带提示（例：意图类型被自动换型）。 */
  failure?: AdvisorFailure;
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

/** Per-channel memory for battle context compression. Fields are consumed by buildBattleContextV2. */
export interface CommanderMemory {
  /** Latest player intent (overwrite on each command) */
  playerIntent: string;
  /** Open commitments / standing orders — FIFO, max 4 */
  openCommitments: string[];
}
