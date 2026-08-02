// ============================================================
// AI Commander — Escalation tickets (approval-contract-v4 刀2)
//
// THE machine handle for "那批兵". When Chen proposes a reinforcement, the
// engine mints a short ticket number (G1, G2, …) per candidate and FREEZES
// that candidate's member ids. The number rides the ---ACTIVE_ESCALATION---
// block into the prompt; the model may echo it back as `fromSquad`, and the
// translation layer resolves it to the frozen roster — never to a live
// re-scan, never through the global pool.
//
// Why the ticket is minted on the ESCALATION candidate and NOT on the board
// row (user ruling 2026-08-02, B 案):
//   battleBoard calls buildReinforceOptions(state, null) while the escalation
//   calls it with the front. The two produce IDENTICALLY LABELLED groups with
//   DIFFERENT membership (measured: board 10 units vs escalation 5 units for
//   the same "东方向未编组群" when a cluster straddles the front boundary).
//   Numbering the board row would let Chen promise 5 and the engine dispatch
//   10 — silently, and invisibly to any label-only assertion. Minting on the
//   candidate makes 承诺 == 执行 true by construction.
//   Second reason: board rows are recomputed every frame, so a stable board
//   number would need cluster-identity tracking across frames. Not a problem
//   the candidate snapshot has.
//
// Lifecycle is deliberately NOT the shelved contract's five triggers: a ticket
// is NAMED by the model, so there is no "which proposal did 可以 mean" to
// disambiguate. One-shot + lazy expiry, checked only at consumption. No timer,
// no background task, no single slot — tickets are naturally multi-instance.
// ============================================================

import type { GameState, Front, Position } from "@ai-commander/shared";
import { isDispatchablePlayerUnit } from "@ai-commander/shared";
import { buildReinforceOptions } from "./frontEscalationPayload";

/** Ticket validity (seconds of game time). Matches the ACTIVE_ESCALATION
 *  window in messageStore — a ticket must never outlive the question that
 *  minted it, or "可以" could land on a proposal long off the screen. */
export const TICKET_TTL_SEC = 120;

export interface EscalationTicket {
  /** "G7" — monotonic within a battle, never reused (a recycled number is the
   *  P0-1 "old G7 / new G7" impersonation in miniature). */
  gNumber: string;
  /** Frozen at mint. The ONLY roster this ticket will ever dispatch. */
  unitIds: number[];
  /** Human label as Chen speaks it, for receipts. Never a bare internal id. */
  label: string;
  /** unitIds.length at mint — the number Chen promised out loud. */
  unitCount: number;
  targetFrontId: string;
  anchor: Position;
  mintedAt: number;
  burned: boolean;
}

export type TicketLookup =
  | { ok: true; ticket: EscalationTicket }
  | { ok: false; reason: "unknown" | "expired" | "burned"; ticket?: EscalationTicket };

let seq = 0;
const tickets = new Map<string, EscalationTicket>();

/** New battle → the numbering restarts and every old ticket is unreachable. */
export function resetEscalationTickets(): void {
  seq = 0;
  tickets.clear();
}

/**
 * Mint one ticket per SHOWN candidate for this front's escalation.
 *
 * Shown (not just top) on purpose: the payload hands Chen up to DISPLAY_BUDGET
 * candidates and he may name any of them. Numbering only the top would leave
 * the model one number for a proposal about a different group — the exact
 * promise/execution split this knife exists to close.
 *
 * Same-state determinism with the payload: both read the one builder
 * synchronously off the same GameState.
 */
export function mintEscalationTickets(state: GameState, front: Front): EscalationTicket[] {
  const result = buildReinforceOptions(state, front);
  const anchorSource = result.shown;
  const out: EscalationTicket[] = [];
  for (const opt of anchorSource) {
    if (opt.memberIds.length === 0) continue;
    seq += 1;
    const t: EscalationTicket = {
      gNumber: `G${seq}`,
      unitIds: [...opt.memberIds],
      label: opt.label,
      unitCount: opt.memberIds.length,
      targetFrontId: front.id,
      anchor: { x: 0, y: 0 }, // filled by caller when it has the battle anchor
      mintedAt: state.time,
      burned: false,
    };
    tickets.set(t.gNumber, t);
    out.push(t);
  }
  return out;
}

/** Record the rally point the ETA promise was made against (刀1's anchor). */
export function setTicketAnchor(gNumber: string, anchor: Position): void {
  const t = tickets.get(gNumber);
  if (t) t.anchor = { x: anchor.x, y: anchor.y };
}

/**
 * Resolve a model-written reference. Fail-closed and LOUD: an unknown,
 * expired or already-burned number returns a reason, never a silent fallback
 * to "pick something reasonable" (that soft-fix is the 74/85 family).
 */
export function lookupEscalationTicket(raw: string, now: number): TicketLookup {
  const key = raw.trim().toUpperCase();
  const t = tickets.get(key);
  if (!t) return { ok: false, reason: "unknown" };
  if (t.burned) return { ok: false, reason: "burned", ticket: t };
  if (now - t.mintedAt > TICKET_TTL_SEC) return { ok: false, reason: "expired", ticket: t };
  return { ok: true, ticket: t };
}

/** True iff the string looks like a ticket reference at all (G + digits). */
export function isTicketRef(raw: string): boolean {
  return /^G\d+$/i.test(raw.trim());
}

/** One-shot: a consumed ticket can never dispatch twice. */
export function burnEscalationTicket(gNumber: string): void {
  const t = tickets.get(gNumber.trim().toUpperCase());
  if (t) t.burned = true;
}

/**
 * The frozen roster filtered to who can still go: alive and dispatchable.
 * Casualties and units the player has since re-tasked simply drop out — the
 * receipt then reports the REAL number that left, never the promised one.
 */
export function liveMembersOf(state: GameState, ticket: EscalationTicket): number[] {
  const out: number[] = [];
  for (const id of ticket.unitIds) {
    const u = state.units.get(id);
    if (!u || u.hp <= 0 || u.state === "dead") continue;
    if (!isDispatchablePlayerUnit(u)) continue;
    out.push(id);
  }
  return out;
}

/**
 * The permission line injected next to the escalation question. States the
 * mapping explicitly because the digest's standing rule says the opposite
 * ("group labels are NOT valid fromSquad") — that rule stays TRUE for labels;
 * this grants the NUMBER, which is a different handle.
 */
export function ticketPromptLine(minted: EscalationTicket[]): string | null {
  if (minted.length === 0) return null;
  const list = minted.map((t) => `${t.gNumber}=${t.label}(${t.unitCount}units)`).join("｜");
  return `本案候选编号：${list}\nfromSquad="G编号" 即调陈所述那批（编号是合法把手，群名仍然不是）。`;
}

/** Bench-only view of the registry. */
export function _ticketsForTest(): EscalationTicket[] {
  return Array.from(tickets.values());
}
