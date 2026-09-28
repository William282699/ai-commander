// ============================================================
// AI Commander — Intent System (LLM outputs these, not Orders)
// TacticalPlanner converts Intents → precise Orders
// ============================================================

export type IntentType =
  | "reinforce"
  | "attack"
  | "defend"
  | "retreat"
  | "flank"
  | "sabotage"
  | "recon"
  | "patrol"
  | "escort"
  | "hold"
  | "air_support"
  | "produce"
  | "trade"
  | "capture"
  | "cover_retreat";

export type UrgencyLevel = "low" | "medium" | "high" | "critical";
export type QuantityHint = "all" | "most" | "some" | "few" | number;
export type UnitCategoryHint = "armor" | "infantry" | "air" | "naval";

/**
 * Step 7b.1 — budget-scaled trade. The LLM only classifies the budget INTENT into
 * this struct; the engine computes how many buys / how much spend / what remains
 * from TRADE_COSTS + current money (never the LLM). Absent or `single` = the old
 * one-shot buy (unchanged behavior). `fraction_of_money` means "spend this share of
 * current money on the trade" — e.g. 1 = all-in, 0.5 = half, 0.75 = three-quarters.
 * Generic on purpose: ammo/intel reuse the same struct — no `buy_all_xxx` fields.
 */
export interface TradeBudget {
  mode: "single" | "fraction_of_money";
  fraction?: number; // 0–1, only meaningful for fraction_of_money; engine clamps
}

/**
 * emily-production-v1 — budget-scaled PRODUCTION, the full tradeBudget anatomy
 * ported to produce: the LLM only classifies the budget intent ("全部钱造X" →
 * fraction 1); ONE Order carries it and applyOrders settles with LIVE resources
 * (unit count, spend, fuel constraint, per-order cap — never the LLM, and never
 * the resolver, which would pre-announce counts the settlement could miss).
 * Absent or `single` = the old numeric-quantity path (unchanged behavior).
 */
export interface ProduceBudget {
  mode: "single" | "fraction_of_money";
  fraction?: number; // 0–1, only meaningful for fraction_of_money; engine clamps
}

export interface Intent {
  type: IntentType;

  // Squad-level dispatch (Day 10.5) — takes priority over fromFront
  fromSquad?: string;  // squad ID like "T5", "I3"

  // retreat-scope 刀C — 按**任务**指代那批人（不是按位置、也不是按编制）。
  //
  // 「现在守南线的部队」= fromFront（位置）
  // 「刚从南线派去山脊那批」= fromDispatch（来源／那一次任务）
  // 两个字段各自独立解析，**不互相兜底、不静默合并**。任务号由引擎生成（M#），
  // 只从该任务的**活成员**里取人；任务不在了就明确失败，不退化成别的选法。
  fromDispatch?: string;  // dispatch id like "M3"

  // Source & destination (region/front names, NOT coordinates)
  fromFront?: string;
  toFront?: string;
  targetFacility?: string;
  targetRegion?: string;

  /**
   * 刀寅：结构化的目的地模式。`"origin"`＝回到这批人**这次外派的出发地**
   * （「刚才派出去那批回来」）。只对 retreat 生效，仍走撤退执行链（途中不追敌、到达后防守）。
   * 出发地由引擎从任务台账里取（真实出发位置），模型只负责认出"回原处"这个意思。
   * 长官另点了地名 ⇒ 以地名为准，本字段不起作用；只说「快撤」⇒ 不写本字段，走老的安全后撤。
   */
  returnTo?: "origin";

  /**
   * 刀寅：长官原话里说**这条命令去处**的那几个字（模型逐字照抄，错别字也照抄）。
   * 引擎只用它核对"字段解析出的去处"与"长官说的去处"是否一致；对不上就问，不静默改目标。
   * 它能证明"确实出自长官的话"，证明不了是正向的去处——语义判断仍归模型。
   */
  destinationQuote?: string;

  /**
   * 刀寅：长官原话里说**这条命令人数**的那几个字（模型逐字照抄）。一句话被拆成几条同源同去处
   * 的单子、却都抄的是同一处数量（「两个」只说了一次）⇒ 多半是把"一共两个"拆成了"每种各两个"，
   * 引擎先问，不多派。
   */
  quantityQuote?: string;

  // Constraints (LLM extracts from player speech)
  unitType?: UnitCategoryHint;
  quantity?: QuantityHint;
  urgency?: UrgencyLevel;
  minimizeLosses?: boolean;
  timeLimitSec?: number;

  // Additional hints
  airCover?: boolean;
  holdAfter?: boolean;   // hold position after completing objective
  stealth?: boolean;     // try to stay hidden

  // Production / trade specifics
  produceType?: string;  // unit type to produce
  produceBudget?: ProduceBudget; // emily-production-v1: budget-scaled produce (absent/single = numeric path)
  tradeAction?: string;  // buy_fuel, sell_ammo, etc.
  tradeBudget?: TradeBudget; // 7b.1: budget-scaled trade (absent/single = one buy)

  // Patrol specifics (Day 9.5)
  patrolRadius?: number; // 小=5, 中=10, 大=15 (clamped [3,30])

  // Named route (El Alamein scenario)
  routeId?: string;       // "via_balbia" — single named route
  routeIds?: string[];    // multi-segment route chain

  // Formation override (P1.F): when set, makes squad.formationStyle sticky-update
  // before per-handler resolution. Mirrors the literal union on Squad.formationStyle
  // (kept inline rather than imported to avoid shared→core dependency).
  // Future extension hook: add `formationDoctrine?` for type-aware placement.
  formationStyle?: "line" | "wedge" | "column" | "encircle";

  // Source filtering (internal, set by crisis card system).
  // Units physically inside this front are excluded from dispatch.
  excludeFront?: string;

  // Internal: override target position (raw coordinates).
  // Set by crisis card system to direct reinforcements to the enemy
  // centroid instead of region/front geometric center.
  // resolveTarget checks this FIRST, before targetRegion/toFront.
  _targetPos?: { x: number; y: number };
}
