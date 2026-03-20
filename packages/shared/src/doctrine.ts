// ============================================================
// AI Commander — Doctrine Layer (Standing Orders)
// Persistent player directives that the system remembers and
// continuously enforces via rule-engine checks each tick.
// ============================================================

import type { Channel } from "./types";

// --- Standing Order Types ---

export type StandingOrderType =
  | "must_hold"
  | "can_trade_space"
  | "preserve_force"
  | "no_retreat"
  | "delay_only";

export type DoctrinePriority = "low" | "normal" | "high" | "critical";

export type DoctrineStatus = "active" | "completed" | "cancelled";

export interface StandingOrder {
  id: string;
  type: StandingOrderType;
  commander: Channel;
  locationTag: string;         // region ID or front ID
  priority: DoctrinePriority;
  allowAutoReinforce: boolean;
  assignedSquads: string[];
  createdAt: number;           // game time
  status: DoctrineStatus;
}

// --- Crisis Event (returned by checkDoctrines, NOT a ReportEvent) ---

export type CrisisEventType = "DOCTRINE_BREACH" | "DOCTRINE_WARNING";

export interface CrisisEvent {
  type: CrisisEventType;
  severity: "warning" | "critical";
  doctrineId: string;
  locationTag: string;
  message: string;
  time: number;
}

// --- Doctrine Cancel Result ---

export interface DoctrineCancelResult {
  cancelled: boolean;
  doctrineId: string;
  locationTag: string;
  type: StandingOrderType;
  channel: Channel;
  associatedTaskIds: string[];
}
