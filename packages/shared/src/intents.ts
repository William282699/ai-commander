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
  | "escort"
  | "air_support"
  | "produce"
  | "trade";

export type UrgencyLevel = "low" | "medium" | "high" | "critical";
export type QuantityHint = "all" | "most" | "some" | "few" | number;
export type UnitCategoryHint = "armor" | "infantry" | "air" | "naval";

export interface Intent {
  type: IntentType;

  // Source & destination (region/front names, NOT coordinates)
  fromFront?: string;
  toFront?: string;
  targetFacility?: string;
  targetRegion?: string;

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
  tradeAction?: string;  // buy_fuel, sell_ammo, etc.
}
