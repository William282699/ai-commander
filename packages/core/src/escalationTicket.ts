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

import type { GameState, Front, Position, CrisisEvent, Intent, IntentType } from "@ai-commander/shared";
import { isDispatchablePlayerUnit } from "@ai-commander/shared";
import { isDispatchIntent } from "./commandAuthority";
import { buildReinforceOptions, buildFrontEscalationPayload, filterLateCandidates } from "./frontEscalationPayload";
import type { ReinforceOptionsResult } from "./frontEscalationPayload";
import { battleAnchorFor } from "./crisisResponse";
import { findFront } from "./tacticalPlanner";
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
   *  (0,0) placeholder waiting for someone to remember to backfill it.
   *
   *  ★ v4 §8 (2026-08-04): READ-ONLY provenance for the ETA. It is no longer
   *  injected into the dispatch path. It used to be, and a frozen point that
   *  outlives the situation it was frozen in is how a bare 「快撤」 became
   *  "retreat onto the enemy's position" (§7④) and how an unknown place name
   *  became a silent rewrite to an old anchor (§7③). Execution now re-resolves
   *  the destination at dispatch time through frontDestinationFor — the same
   *  ladder the anchor itself came from, so the two still agree by
   *  construction, they just no longer agree by freezing. */
  anchor: Position | null;
  /** Arrival estimate at mint time; null = unknown. Carried so the receipt can
   *  state the cost of sending a force the engine already called too slow —
   *  B 刀: a handle is an ADDRESS, not an endorsement, so late forces DO get
   *  numbered, and the receipt is where their lateness is reconciled out loud. */
  etaSec: number | null;
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
    const t = mintOne(state, front, opt, anchor);
    if (t) out.push(t);
  }
  return out;
}

/** The one place a ticket is actually created. Roster frozen at this instant. */
function mintOne(
  state: GameState,
  front: Front | null,
  opt: { label: string; memberIds: number[]; etaSec: number | null },
  anchor: Position | null,
): EscalationTicket | null {
  if (opt.memberIds.length === 0) return null;
  seq += 1;
  const t: EscalationTicket = {
    gNumber: `G${seq}`,
    unitIds: [...opt.memberIds],
    label: opt.label,
    unitCount: opt.memberIds.length,
    targetFrontId: front?.id ?? "",
    anchor: anchor ? { x: anchor.x, y: anchor.y } : null,
    etaSec: opt.etaSec,
    mintedAt: state.time,
    burned: false,
  };
  tickets.set(t.gNumber, t);
  return t;
}

/**
 * B 刀 (2026-08-02): mint a handle for a force the staff is about to NAME OUT
 * LOUD outside the escalation machine — the board's best_help row, and the
 * disclosure row that names a force it just said cannot arrive in time.
 *
 * Why this exists: a spatial group's spoken name ("东北方向第一未编组群") is not
 * a legal fromSquad and never can be — the label is recomputed every frame and
 * the same words can mean a different roster seconds later. Before this, naming
 * such a force in conversation was a dead end: the commander says 「让她们去
 * 支援」, the model has nothing to bind to, falls back to a destination-only
 * intent, and the engine dispatches whoever already stands at the destination
 * (live hand-test: 6 idle tanks promised, 1 surviving defender actually moved).
 *
 * ★ A handle is an ADDRESS, not an endorsement. The engine mints one even for a
 * force it has just declared too slow — refusing to RECOMMEND it (诚实闸) and
 * refusing to let the commander REACH it are different things, and only the
 * first is the engine's call. Overriding "赶不到" is a legitimate command
 * decision (counter-attack, screen, retake).
 *
 * Roster + anchor are frozen here exactly as the escalation path freezes them,
 * so 承诺 == 执行 holds for this face too.
 */
export function mintSpokenForce(
  state: GameState,
  front: Front | null,
  opt: { label: string; memberIds: number[]; etaSec: number | null },
): string | null {
  // front === null: the board's force rows are front-agnostic (they are built
  // with buildReinforceOptions(state, null)), so there is no rally point and no
  // ETA to freeze — only the ROSTER, which is the part that matters. The order
  // itself supplies the destination. Handing these rows a handle is what makes
  // 「东方向第四未编组群」 addressable at all: the staff reads that name off the
  // board when the commander asks 「附近有空闲部队吗」, and without a number the
  // model can only write the LABEL into fromSquad — which the gate then refuses
  // as a squad that was never in the order of battle (live hand-test 02:42).
  const t = front
    ? mintOne(state, front, opt, battleAnchorFor(state, front))
    : mintOne(state, null, opt, null);
  return t ? t.gNumber : null;
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
  // 诚实闸 (刀3) is applied ONCE, here, and the SAME filtered set feeds both the
  // payload and the mint — a ticket must never exist for a candidate Chen was
  // not allowed to mention.
  const result = filterLateCandidates(
    buildReinforceOptions(state, front),
    facts?.estimatedCollapseSeconds ?? null,
  );
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

/** A commander as the reference predicate needs to see one: the key the model
 *  may write ("chen") and the display label a player may say ("陈军士").
 *  Passed IN so core never carries UI data (avatar/role stay in the web layer). */
export interface CommanderRef {
  key: string;
  label: string;
}

/**
 * THE one answer to "is this string a force reference the system knows about".
 *
 * v4 §6c-3c (P0 fix): `detectStaleSquadRefs` and `isValidTarget` each carried a
 * private copy of this judgement, and neither had heard of tickets — so a
 * correctly-written `fromSquad="G1"` was rejected as a dead squad before the
 * translation layer ever ran. Two private definitions of "legal reference" IS
 * the bug class; this collapses them to one.
 *
 * ★ Ticket refs pass on SHAPE ALONE. Whether G1 is unknown / expired / burned
 * is decided by resolveTicketReference and NOWHERE ELSE — a gate that also
 * consulted the registry would recreate the second source of truth this fix
 * exists to remove. A hallucinated G99 therefore passes the gate and is refused
 * loudly one layer down: same zero-execution outcome, one owner.
 */
export function isKnownForceRef(
  state: GameState,
  raw: string | undefined | null,
  commanders: readonly CommanderRef[],
): boolean {
  if (!raw) return false;
  const s = raw.trim();
  if (s.length === 0) return false;
  if (isTicketRef(s)) return true;

  const lower = s.toLowerCase();
  if (state.squads?.some((sq) => sq.id === s || sq.leaderName?.toLowerCase() === lower)) return true;
  // Semantics preserved verbatim from the two former copies: key matches
  // case-insensitively and exactly; label matches by CONTAINING the reference.
  return commanders.some((c) => c.key.toLowerCase() === lower || c.label.includes(s));
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

/**
 * Demote a ticket-bound intent's front hints from SOURCE to DESTINATION.
 *
 * The frozen roster reaches the planner through resolveIntent's selectedUnitIds,
 * which is a hard FILTER over whatever pool resolveSourceUnits built. With
 * toFront set, that pool is "units already standing at the destination", so
 * roster ∩ pool = ∅ and the order dies as 「框选的单位不在可调度范围内」 — after
 * the receipt already promised the batch (live hand-test 2026-08-02; measured
 * 0 dispatched with toFront, 6 with the hints cleared).
 *
 * A ticket HAS no source front: its source is the roster. So fromFront is
 * dropped and toFront is moved to targetRegion, where resolveTarget resolves a
 * front id through the §8 destination ladder.
 *
 * ★ v4 §8 (2026-08-04): the anchor-injection branch that used to sit here is
 * GONE. It existed only to route around getFrontCenterPos, and now that the
 * front branches of resolveTarget resolve properly there is nothing to route
 * around. Its three measured defects go with it: a bare retreat rewritten to
 * "retreat onto the fight" (§7④), an unknown place name silently rewritten to
 * an old anchor with the offending field deleted before isValidTarget could
 * see it (§7③), and a board-minted ticket (anchor === null) falling through to
 * the geometric center anyway (§7①).
 *
 * ★ An UNRESOLVABLE toFront is left in place on purpose. Demoting it to
 * targetRegion would make the downstream warning name a field the model never
 * wrote — a silent rewrite of the commander's own words. Left where it is,
 * softFixTargetFields reports 「toFront=<原话>」 and ticketDestinationVerdict
 * turns it into a question instead of a guess.
 *
 * Pure, and in core on purpose: ChatPanel has no bench harness, and this is
 * exactly the kind of judgment that shipped reversed once already.
 */
export function retargetIntentForTicket(
  state: GameState,
  intent: Intent,
  /** Kept in the signature, no longer read: the one thing this took from the
   *  ticket was its frozen anchor, and §8 deleted that path. */
  _ticket: EscalationTicket,
): Intent {
  const out: Intent = { ...intent };
  // A ticket has no SOURCE front — its source is the frozen roster.
  out.fromFront = undefined;

  // Precise, player-meant destinations win outright (a facility, a map tag, an
  // explicit coordinate): those name a POINT, and the commander chose it.
  const hasPreciseTarget = !!(out.targetFacility || out.targetRegion || out._targetPos);

  if (hasPreciseTarget) {
    out.toFront = undefined;
  } else if (out.toFront && findFront(state, out.toFront)) {
    // Front hint demoted from SOURCE to DESTINATION (targetRegion resolves a
    // front id) — it must never reach resolveSourceUnits, where it would make
    // the pool "units already at the destination" and leave the roster with an
    // empty intersection (measured: 0 dispatched with toFront, 6 without).
    out.targetRegion = out.toFront;
    out.toFront = undefined;
  }
  return out;
}

// ── Where does a ticket-bound order actually go? (v4 §8 条件二, 2026-08-04) ──

export type TicketDestinationVerdict =
  /** Dispatch it. `injectTargetRegion` (when set) is the destination the engine
   *  supplies because the order named none; `receipt` picks the wording. */
  | { kind: "execute"; injectTargetRegion?: string; receipt: "moved" | "in_place" }
  /** Zero execution + this question. A ticket is a handle on PEOPLE, never on a
   *  place, so "where" is the one thing it can never fill in for the commander. */
  | { kind: "refuse"; reason: "unknown_place" | "no_destination"; line: string };

/** Verbs that are already complete without a destination: they act where the
 *  force stands. Everything else needs somewhere to go. */
const IN_PLACE_TYPES: ReadonlySet<IntentType> = new Set<IntentType>(["defend", "hold"]);

/**
 * THE destination decision for a ticket-bound order, in three cases:
 *
 *   1. a destination was written and survived validation → execute it;
 *   2. one was written and did NOT survive (no such place) → refuse and ask,
 *      never substitute (§7③: the substitute was an anchor frozen minutes ago);
 *   3. none was written at all:
 *      · defend/hold act in place — legal, and the receipt must say so
 *        rather than claim a march that never happened (§7②);
 *      · retreat keeps the retreat-semantics-v1 default (toward HQ, pinned
 *        byte-for-byte in ab-retreat-semantics);
 *      · an ESCALATION ticket knows which front it was raised for, so that
 *        front becomes the destination and rides the §8 ladder;
 *      · a BOARD ticket (targetFrontId === "") knows no front — and inventing
 *        one is the whole family of soft-fixes this rung removes. Ask.
 *
 * Called only for intents the ticket layer actually bound. Non-ticket commands
 * are untouched on purpose: the engine cannot tell "a new order that named no
 * squad" from "a follow-up that got mis-bound", and gating both would put a
 * confirmation card back in front of clear orders — the thing the 砍卡法 ruling
 * removed (Bucket A, 审核档 §3-6).
 */
export function ticketDestinationVerdict(
  intent: Intent,
  ticket: EscalationTicket,
  /** Did the model write ANY destination field before softFixTargetFields ran?
   *  This is what separates case 2 from case 3 — after the soft-fix they look
   *  identical, and treating "you named a place I can't find" as "you named no
   *  place" is how a typo turns into a dispatch to somewhere else. */
  wroteDestination: boolean,
): TicketDestinationVerdict {
  const hasDestination = !!(
    intent._targetPos || intent.targetFacility || intent.targetRegion || intent.toFront
  );
  if (hasDestination) return { kind: "execute", receipt: "moved" };

  if (wroteDestination) {
    return {
      kind: "refuse",
      reason: "unknown_place",
      line: `${ticket.label} 还在原地——您说的那个地方我在图上找不着。换个地名，或者说「原地守住」，我立刻办。`,
    };
  }

  // Economy intents carry no destination by nature and can never be a dispatch.
  if (!isDispatchIntent(intent.type)) return { kind: "execute", receipt: "moved" };
  if (IN_PLACE_TYPES.has(intent.type)) return { kind: "execute", receipt: "in_place" };
  if (intent.type === "retreat") return { kind: "execute", receipt: "moved" };
  if (ticket.targetFrontId) {
    return { kind: "execute", injectTargetRegion: ticket.targetFrontId, receipt: "moved" };
  }
  return {
    kind: "refuse",
    reason: "no_destination",
    line: `${ticket.label}（${ticket.gNumber}）去哪？您给个地名或据点，我这就派。`,
  };
}

/** Receipt after a dispatch: the REAL number that left, never the promised one.
 *  B 刀: when the handle carries an arrival estimate, the receipt states it —
 *  a force the engine called too slow may still be sent, but the commander is
 *  told what he just bought rather than only that it left.
 *
 *  刀C (v4 §8 ⑤, 2026-08-04): `dispatched` must be counted from the resolver's
 *  assignedUnitIds AFTER the dispatch, not from the roster before it. Measured
 *  §7⑤: roster 6 + quantity=2 → 2 units moved, receipt said 6. And `mode`
 *  exists because 「出发了」 is a lie about a defend-in-place order — the units
 *  did what was asked without going anywhere (§7②). The ETA belongs only to
 *  the marching case; there is no arrival to estimate when nobody departs. */
export function ticketDispatchReceipt(
  ticket: EscalationTicket,
  dispatched: number,
  mode: "moved" | "in_place" = "moved",
): string {
  if (mode === "in_place") {
    return dispatched === ticket.unitCount
      ? `${ticket.label} ${dispatched}个单位就地设防。`
      : `${ticket.label} 实际能动的 ${dispatched} 个已就地设防（原报 ${ticket.unitCount} 个，其余已不在编）。`;
  }
  const eta = ticket.etaSec !== null ? `，按估算约 ${ticket.etaSec} 秒到位` : "";
  return dispatched === ticket.unitCount
    ? `${ticket.label} ${dispatched}个单位出发了${eta}。`
    : `${ticket.label} 实际能走的 ${dispatched} 个已经出发${eta}（原报 ${ticket.unitCount} 个，其余已不在编）。`;
}

/** Bench-only view of the registry. */
export function _ticketsForTest(): EscalationTicket[] {
  return Array.from(tickets.values());
}
