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

import type { GameState, Front, Position, CrisisEvent } from "@ai-commander/shared";
import { isDispatchablePlayerUnit } from "@ai-commander/shared";
import { buildReinforceOptions, buildFrontEscalationPayload } from "./frontEscalationPayload";
import type { ReinforceOptionsResult } from "./frontEscalationPayload";
import { battleAnchorFor } from "./crisisResponse";
import { frontEscalationFacts } from "./director";

/**
 * Ticket validity, in seconds of GAME time (state.time) — the same clock and
 * the same 120s as messageStore's ESCALATION_WINDOW_SEC, which gates
 * ---ACTIVE_ESCALATION--- via getActiveEscalation(ch, state.time).
 *
 * ⇄ The two MUST stay equal: a ticket outliving its question would let "可以"
 * land on a proposal that is no longer on screen (the P0-1 shape); a ticket
 * dying first would make a visible proposal silently unexecutable. If you
 * change one, change the other (messageStore.ts ESCALATION_WINDOW_SEC).
 */
export const TICKET_TTL_SEC = 120;

/** What Chen says when a bare "可以" arrives with no proposal on the table.
 *  Engine-authored: this branch must never reach the LLM (绊索), so there is
 *  no model turn in which to phrase it. */
export const NO_PROPOSAL_GUIDANCE = "我这儿没有待批的方案——您说「派谁去哪」我就动。";

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
  /** Rally point the ETA promise was measured to (刀1 battleAnchorFor).
   *  null only when the front has no resolvable geometry at all — never a
   *  (0,0) placeholder waiting for someone to remember to backfill it. */
  anchor: Position | null;
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
export function mintEscalationTickets(
  state: GameState,
  front: Front,
  /** The candidate set already built for this tick. Production ALWAYS passes it
   *  (via buildFrontEscalationWithTickets) so the payload Chen speaks from and
   *  the tickets are literally the same objects — not two constructions that
   *  happen to agree today. */
  precomputed?: ReinforceOptionsResult,
): EscalationTicket[] {
  const result = precomputed ?? buildReinforceOptions(state, front);
  // The rally point the ETA promise was made against (刀1). Computed HERE, not
  // backfilled by the caller: a placeholder that depends on a later call is a
  // placeholder that eventually ships.
  const anchor = battleAnchorFor(state, front);
  const out: EscalationTicket[] = [];
  for (const opt of result.shown) {
    if (opt.memberIds.length === 0) continue;
    seq += 1;
    const t: EscalationTicket = {
      gNumber: `G${seq}`,
      unitIds: [...opt.memberIds],
      label: opt.label,
      unitCount: opt.memberIds.length,
      targetFrontId: front.id,
      anchor: anchor ? { x: anchor.x, y: anchor.y } : null,
      mintedAt: state.time,
      burned: false,
    };
    tickets.set(t.gNumber, t);
    out.push(t);
  }
  return out;
}

export interface EscalationWithTickets {
  /** The SITUATION payload the voice is written from (byte-identical to V1b). */
  payload: string;
  tickets: EscalationTicket[];
  /** Permission line for ---ACTIVE_ESCALATION---; null when nothing was minted. */
  promptLine: string | null;
}

/**
 * THE production entry for a front escalation: one candidate construction
 * feeding both the spoken payload and the tickets.
 *
 * Why this exists instead of two calls in GameCanvas (user ruling 2026-08-02
 * item 1): "same tick, same state, pure function" is true today, but it is an
 * argument, not a structure. Building once and handing the SAME result to both
 * consumers makes promise/ticket drift impossible rather than merely unlikely.
 * It also keeps buildReinforceOptions out of core/index.ts, which stays
 * builder-only for production (Codex round-4 P1-4).
 */
export function buildFrontEscalationWithTickets(
  state: GameState,
  crisis: CrisisEvent,
): EscalationWithTickets {
  const facts = frontEscalationFacts(state, crisis);
  const front = facts ? state.fronts.find((f) => f.id === facts.frontId) ?? null : null;
  const result = buildReinforceOptions(state, front);
  const payload = buildFrontEscalationPayload(state, crisis, result);
  const minted = front ? mintEscalationTickets(state, front, result) : [];
  return { payload, tickets: minted, promptLine: ticketPromptLine(minted) };
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

// ── The translation decision (pure; ChatPanel keeps only thin glue) ──
//
// GameCanvas/ChatPanel have no node harness — a reversed frame label once
// shipped through exactly that blind spot (GameCanvas.tsx:463). So every
// judgment lives here where the bench can reach it, and the UI layer only
// routes the verdict: dispatch these ids, or say this line.

export type TicketResolution =
  /** fromSquad is not a G-number at all → normal command path, untouched. */
  | { kind: "not_a_ticket" }
  /** Execute EXACTLY these ids (they are the frozen roster, filtered to alive). */
  | { kind: "dispatch"; ticket: EscalationTicket; unitIds: number[] }
  /** Zero execution + this in-character line. Never a silent fallback. */
  | { kind: "refuse"; reason: "unknown" | "expired" | "burned" | "all_gone"; line: string };

/**
 * Resolve a model-written `fromSquad` against the ticket registry.
 *
 * Fail-closed by construction: every non-dispatch outcome is a REFUSAL with a
 * spoken reason, never "pick something reasonable". The silently-widening
 * soft-fix is the 74/85 family and is what dispatch-scope-v1 removed.
 */
export function resolveTicketReference(
  state: GameState,
  rawFromSquad: string | undefined | null,
  now: number,
): TicketResolution {
  if (!rawFromSquad || !isTicketRef(rawFromSquad)) return { kind: "not_a_ticket" };

  const look = lookupEscalationTicket(rawFromSquad, now);
  if (!look.ok) {
    const g = rawFromSquad.trim().toUpperCase();
    const line =
      look.reason === "expired"
        ? `那个增援案已经过时了——现在还要动兵的话，您说一声，我按当下的情况重新点人。`
        : look.reason === "burned"
          ? `${look.ticket?.label ?? g} 已经派出去了，不重复下令。`
          : `我这儿没有编号 ${g} 的方案——您说「派谁去哪」我就动。`;
    return { kind: "refuse", reason: look.reason, line };
  }

  const live = liveMembersOf(state, look.ticket);
  if (live.length === 0) {
    return {
      kind: "refuse",
      reason: "all_gone",
      line: `${look.ticket.label} 已经没人能动了——要增援得另外点人。`,
    };
  }
  return { kind: "dispatch", ticket: look.ticket, unitIds: live };
}

/** Receipt after a dispatch: the REAL number that left, never the promised one. */
export function ticketDispatchReceipt(ticket: EscalationTicket, dispatched: number): string {
  return dispatched === ticket.unitCount
    ? `${ticket.label} ${dispatched}个单位出发了。`
    : `${ticket.label} 实际能走的 ${dispatched} 个已经出发（原报 ${ticket.unitCount} 个，其余已不在编）。`;
}

/** Bench-only view of the registry. */
export function _ticketsForTest(): EscalationTicket[] {
  return Array.from(tickets.values());
}
