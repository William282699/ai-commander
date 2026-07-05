// ============================================================
// AI Commander — Step 7e: Decision review (battle-time retrospect)
//
// When the player commits a decision (an executed command with a real
// battlefield anchor, or the answer to a staff escalation question), the web
// layer records it here with a baseline snapshot. ~90s later the engine
// re-reads the REAL board, computes the structured delta, and (7e.1c) hands
// ONE persona the facts to voice ONE retrospective STATEMENT.
//
// ── Hard boundaries (Step 7 ironclad rule) ──
//   - Deterministic throughout: the ENGINE decides what gets recorded, when
//     it is reviewed, whether the outcome is significant enough to say
//     anything (silence is the default), and WHO says it (persona routing).
//   - The LLM only re-voices the structured facts. It never judges outcomes,
//     never issues orders, never asks the commander anything. This module
//     never touches resolveIntent/applyOrders — a retrospect cannot execute.
//   - Outcome labels are NEUTRAL engine reads (same discipline as `stake`):
//     e.g. "no_presence" states that no committed force remains — whether
//     that is a clean withdrawal or a broken line is voiced by the LLM from
//     kind + casualties, never asserted by the engine.
//   - Decision math is REUSED, not re-derived: collapse estimates come from
//     6a's `assessCrisisEscalation`; the power ratio and the presence gate
//     are the director's exported helpers. No thresholds in that math change.
//
// ── 7e.1 scope ──
//   Records come from the main ChatPanel command path only (handleApprove
//   after a successful dispatch). Staff-thread approvals (handleThreadApprove
//   — a second applyOrders call site), right-click manual orders,
//   produce/trade decisions, and 6b autonomous actions are deliberately NOT
//   recorded (deferred).
//
// Pure module: no I/O, no LLM, no React. The only mutation is the tiny queue
// helper `enqueueDecisionReview` (reportEvents-style).
// ============================================================

import type {
  GameState,
  Front,
  Team,
  Channel,
  CrisisEvent,
  DecisionReviewKind,
  DecisionReviewRecord,
  DecisionReviewBaseline,
  DecisionFrontSnapshot,
} from "@ai-commander/shared";
import { assessCrisisEscalation } from "./crisisResponse";
import { freshFrontPowerRatio, hasPlayerCombatPresence } from "./director";
import { findFront, findFacilityById } from "./tacticalPlanner";

// ── Tunables (one place, tuned from real playtest, not guesswork) ──

export const REVIEW_TUNING = {
  /** Seconds after the decision before the engine reviews its outcome. */
  REVIEW_DELAY_SEC: 90,
  /** A due-but-blocked review may retry this long past due before it is
   *  dropped, when the block is a FAST-clearing one (statement budget ≤12s /
   *  a voice already in flight). Safe to wait: facts are re-assessed fresh on
   *  every retry, so a late voice still states current deltas. */
  REVIEW_EXPIRY_GRACE_SEC: 60,
  /** When the block is a QUESTION occupancy on the target channel (an active
   *  escalation awaiting the player's answer, or an escalation voice in
   *  flight), the review waits longer: an unanswered escalation legitimately
   *  holds its channel for up to the web layer's ESCALATION_WINDOW_SEC (120s),
   *  so this must exceed 120s or the review starves and drops unvoiced right
   *  under the question (Codex blocker: Marcus reviews die here — a cross-front
   *  keypoint loss spawns the ops question AND the ops-routed review together).
   *  Back-to-back question chains can still outlast this — accepted: in that
   *  much crisis, a retrospect statement is the right thing to lose. */
  REVIEW_QUESTION_BLOCK_GRACE_SEC: 180,
  /** Non-escalation decisions need at least this many resolved assigned units
   *  (a 1-2 unit recon errand is not a decision worth a retrospect).
   *  Escalation answers only need 1 — the system asked, so we close the loop. */
  MIN_UNITS: 3,
  /** casualties / assignedAlive at/above this reads as heavy
   *  (mirrors reportSignals' SQUAD_HEAVY_LOSS 50% convention). */
  HEAVY_CASUALTY_RATIO: 0.5,
  /** fuel or ammo dropping by at least this much in-window is a significant
   *  resource fact... */
  RESOURCE_DROP_SIG: 30,
  /** ...as is the scarcer of fuel/ammo falling to/below this floor while it
   *  was above it at decision time (mirrors the supply-strain floor of 30). */
  RESOURCE_FLOOR: 30,
  /** Worsened needs the survival estimate to shrink by at least this many
   *  seconds — anti-flicker, same spirit as the director's TREND_EPSILON. */
  WORSEN_EPSILON_SEC: 10,
  /** Queue cap — oldest record dropped first. */
  QUEUE_CAP: 4,
  /** At most this many cross-front facts are surfaced (keeps one sentence one point). */
  CROSS_FRONT_MAX: 2,
} as const;

const REVIEW_KINDS: ReadonlySet<string> = new Set<DecisionReviewKind>([
  "attack", "defend", "retreat", "capture", "sabotage",
]);

/** Is this executed intent type one that 7e records? (produce/trade/recon/
 *  patrol/hold are out of 7e.1 scope — see module header.) */
export function isReviewableIntentType(type: string): type is DecisionReviewKind {
  return REVIEW_KINDS.has(type);
}

// ── Shared board-reading helpers (reuse director/6a math, never re-derive) ──

/** Which front contains a facility (via its region), if any. */
function frontForFacilityRegion(state: GameState, regionId: string): Front | undefined {
  return state.fronts.find((f) => f.regionIds.includes(regionId));
}

/** Which front a map position falls in (bbox walk, same convention as
 *  reportSignals.findFrontForPosition). */
function frontForPosition(state: GameState, x: number, y: number): Front | null {
  for (const front of state.fronts) {
    for (const regionId of front.regionIds) {
      const region = state.regions.get(regionId);
      if (!region) continue;
      const [x1, y1, x2, y2] = region.bbox;
      if (x >= x1 && x <= x2 && y >= y1 && y <= y2) return front;
    }
  }
  return null;
}

/** The front holding the most of the given units right now, if any. */
function dominantFrontForUnits(state: GameState, unitIds: number[]): Front | null {
  const counts = new Map<string, { front: Front; n: number }>();
  for (const uid of unitIds) {
    const u = state.units.get(uid);
    if (!u || u.state === "dead") continue;
    const front = frontForPosition(state, u.position.x, u.position.y);
    if (!front) continue;
    const entry = counts.get(front.id) ?? { front, n: 0 };
    entry.n++;
    counts.set(front.id, entry);
  }
  let best: { front: Front; n: number } | null = null;
  for (const entry of counts.values()) {
    if (!best || entry.n > best.n) best = entry;
  }
  return best?.front ?? null;
}

/**
 * Survival estimate (sec) of OUR committed force at a front, or null when
 * stable / no committed force. Applies the director's presence gate first —
 * without it, an empty front yields the tCollapse=0 fake (Codex blocker in
 * 7a; the identical trap exists here). Collapse math is 6a's, untouched.
 */
function frontCollapseSeconds(state: GameState, front: Front): number | null {
  if (!hasPlayerCombatPresence(state, front)) return null;
  const crisis: CrisisEvent = {
    type: "DOCTRINE_BREACH",
    severity: "critical",
    doctrineId: "__review__",
    locationTag: front.id,
    message: `${front.name} 复盘基线`,
    time: state.time,
  };
  const a = assessCrisisEscalation(state, crisis);
  if (!a || a.tCollapse === Infinity) return null;
  return Math.round(a.tCollapse);
}

/** Living player units among the given ids ("resolved assigned units"). */
function livingAssigned(state: GameState, unitIds: number[]): number[] {
  return unitIds.filter((uid) => {
    const u = state.units.get(uid);
    return !!u && u.team === "player" && u.state !== "dead" && u.hp > 0;
  });
}

// ── Capture (decision time) ──

export interface DecisionCaptureArgs {
  /** Pre-generated correlation id (web layer's makeActionId style). */
  id: string;
  channel: Channel;
  kind: DecisionReviewKind;
  /** intent.targetFacility, when set (already soft-fixed by the web layer). */
  facilityHint?: string;
  /** Target-LOCATION hint from the executed intent: toFront ?? targetRegion.
   *  May legitimately hold a front, tag, region, OR facility name — the
   *  command-parse prompt explicitly allows facility names in toFront and the
   *  planner normalizes that on an internal copy, so the pre-normalization
   *  intent we see here still has it in the location field. NEVER fromFront:
   *  the source front is not an outcome anchor. */
  targetHint?: string;
  /** Unit ids resolveIntent assigned (deduped by the caller). */
  assignedUnitIds: number[];
  /** Escalation correlation id when this decision answered a staff question. */
  escalateId?: string;
}

/**
 * Build a review record for a just-committed decision, or null when it does
 * not clear the recording gate (too few units / no battlefield anchor).
 * Pure — the caller pushes the record via `enqueueDecisionReview`.
 */
export function captureDecisionReview(
  state: GameState,
  args: DecisionCaptureArgs,
): DecisionReviewRecord | null {
  const alive = livingAssigned(state, args.assignedUnitIds);
  const minUnits = args.escalateId ? 1 : REVIEW_TUNING.MIN_UNITS;
  if (alive.length < minUnits) return null;

  // Anchor resolution — mirrors the ENGINE's own location convention
  // (tacticalPlanner resolveTarget / normalizeIntentLocations) instead of
  // forking a weaker copy. Playtest bug this fixes: "进攻阿拉曼镇" where the
  // LLM put the town in toFront → facility anchor never resolved → captured
  // town never entered the facts, and the dominant-front fallback anchored
  // the review to the units' SOURCE front ("出发地没人了" review).
  let facilityId: string | undefined;
  let frontId: string | undefined;
  if (args.facilityHint) {
    facilityId = findFacilityById(state, args.facilityHint)?.id;
  }
  if (!facilityId && args.targetHint) {
    const hint = args.targetHint;
    // Order matters: front → tag → region → facility-fuzzy LAST, because
    // findFacilityById substring-matches names (a front-ish hint like "北线"
    // must not get eaten by a facility named "北线前哨").
    const front = findFront(state, hint);
    if (front) {
      frontId = front.id;
    } else {
      const tag = state.tags.find((t) => t.id === hint || t.name === hint);
      if (tag) {
        frontId = frontForPosition(state, tag.position.x, tag.position.y)?.id;
      }
      if (!frontId) {
        const region = state.regions.get(hint);
        if (region) frontId = state.fronts.find((f) => f.regionIds.includes(region.id))?.id;
      }
      if (!frontId) {
        facilityId = findFacilityById(state, hint)?.id;
      }
    }
  }
  if (facilityId && !frontId) {
    const fac = state.facilities.get(facilityId);
    if (fac) frontId = frontForFacilityRegion(state, fac.regionId)?.id;
  }
  if (!facilityId && !frontId) {
    // No target anchor resolved. The units' CURRENT front is only a valid
    // anchor for kinds that act WHERE the force stands (defend in place /
    // retreat from here). For attack/capture/sabotage it is the SOURCE, not
    // the outcome — those record nothing rather than review the wrong place.
    if (args.kind === "defend" || args.kind === "retreat") {
      frontId = dominantFrontForUnits(state, alive)?.id;
    }
  }
  if (!facilityId && !frontId) return null; // no anchor → not a reviewable decision

  // Baseline snapshot — engine-read values only.
  const res = state.economy.player.resources;
  const fronts: DecisionFrontSnapshot[] = state.fronts.map((f) => ({
    frontId: f.id,
    engagementIntensity: f.engagementIntensity,
    collapseSeconds: frontCollapseSeconds(state, f),
  }));
  const keypointOwners: Record<string, Team> = {};
  for (const fid of [
    ...(state.scenarioWinConfig?.friendlyKeypoints ?? []),
    ...(state.captureObjectives ?? []),
  ]) {
    const f = state.facilities.get(fid);
    if (f) keypointOwners[fid] = f.team;
  }

  const anchorFront = frontId ? state.fronts.find((f) => f.id === frontId) : undefined;
  const anchorFacility = facilityId ? state.facilities.get(facilityId) : undefined;

  const baseline: DecisionReviewBaseline = {
    fuel: res.fuel,
    ammo: res.ammo,
    money: res.money,
    assignedAlive: alive.length,
    front: anchorFront
      ? {
          engagementIntensity: anchorFront.engagementIntensity,
          collapseSeconds:
            fronts.find((s) => s.frontId === anchorFront.id)?.collapseSeconds ?? null,
          powerRatio: freshFrontPowerRatio(state, anchorFront),
        }
      : undefined,
    facility: anchorFacility
      ? {
          team: anchorFacility.team,
          captureProgress: anchorFacility.captureProgress,
          hp: anchorFacility.hp,
        }
      : undefined,
    fronts,
    keypointOwners,
  };

  return {
    id: args.id,
    escalateId: args.escalateId,
    channel: args.channel,
    kind: args.kind,
    createdAt: state.time,
    dueAt: state.time + REVIEW_TUNING.REVIEW_DELAY_SEC,
    frontId,
    facilityId,
    assignedUnitIds: alive,
    baseline,
  };
}

/** Push a record onto the queue, capped (oldest dropped first). */
export function enqueueDecisionReview(state: GameState, record: DecisionReviewRecord): void {
  state.decisionReviews.push(record);
  while (state.decisionReviews.length > REVIEW_TUNING.QUEUE_CAP) {
    state.decisionReviews.shift();
  }
}

// ── Assessment (review time) ──

/** Neutral engine reads of what happened at the anchor front.
 *  "no_presence" = no committed force remains — clean withdrawal vs broken
 *  line is voiced from kind+casualties, never asserted here. */
export type FrontOutcome = "eased" | "no_presence" | "worsened" | "still_contested" | "unchanged";

export type FacilityOutcome =
  | "captured_by_us"
  | "lost_by_us"
  | "destroyed"
  | "still_contested"
  | "unchanged";

export type CasualtyLevel = "none" | "light" | "heavy";

export interface CrossFrontFact {
  frontName: string;
  kind: "keypoint_lost" | "pressure_emerged";
  facilityName?: string;       // keypoint_lost
  collapseSecondsNow?: number; // pressure_emerged
}

/** Structured review facts — everything the voice may say, nothing it may invent. */
export interface DecisionReviewFacts {
  recordId: string;
  escalateId?: string;
  decisionKind: DecisionReviewKind;
  decidedSecondsAgo: number;
  wasEscalationAnswer: boolean;
  /** Persona routing — the ENGINE's pick of who voices this (deterministic). */
  channel: Channel;
  frontName?: string;
  facilityName?: string;
  frontOutcome?: FrontOutcome;
  collapseThen?: number | null;
  collapseNow?: number | null;
  engagementThen?: number;
  engagementNow?: number;
  powerRatioThen?: number | null;
  powerRatioNow?: number | null;
  facilityOutcome?: FacilityOutcome;
  captureProgressNowPct?: number;
  assignedThen: number;
  assignedNow: number;
  casualties: number;
  casualtyLevel: CasualtyLevel;
  fuelNow: number;
  ammoNow: number;
  fuelDelta: number;
  ammoDelta: number;
  moneyDelta: number;
  resourceSignificant: boolean;
  crossFront: CrossFrontFact[];
  /** Below the worthiness bar → the caller stays silent (drop, no voice). */
  significant: boolean;
}

/**
 * Compare the live board against the record's baseline and produce structured
 * review facts. Returns null when the anchor no longer resolves (silent drop).
 * Pure read — never mutates state, never issues anything.
 */
export function assessDecisionReview(
  state: GameState,
  record: DecisionReviewRecord,
): DecisionReviewFacts | null {
  const front = record.frontId ? state.fronts.find((f) => f.id === record.frontId) : undefined;
  const facility = record.facilityId ? state.facilities.get(record.facilityId) : undefined;
  if (!front && !facility) return null;

  // Casualties among the resolved assigned units.
  const assignedNow = livingAssigned(state, record.assignedUnitIds).length;
  const assignedThen = record.baseline.assignedAlive;
  const casualties = Math.max(0, assignedThen - assignedNow);
  const casualtyLevel: CasualtyLevel =
    casualties === 0
      ? "none"
      : casualties / Math.max(1, assignedThen) >= REVIEW_TUNING.HEAVY_CASUALTY_RATIO
        ? "heavy"
        : "light";

  // Anchor front delta.
  let frontOutcome: FrontOutcome | undefined;
  let collapseThen: number | null | undefined;
  let collapseNow: number | null | undefined;
  let engagementNow: number | undefined;
  let powerRatioNow: number | null | undefined;
  if (front && record.baseline.front) {
    collapseThen = record.baseline.front.collapseSeconds;
    collapseNow = frontCollapseSeconds(state, front);
    engagementNow = front.engagementIntensity;
    powerRatioNow = freshFrontPowerRatio(state, front);
    const presenceNow = hasPlayerCombatPresence(state, front);
    if (collapseThen !== null && collapseNow === null && presenceNow) {
      frontOutcome = "eased"; // was under a measured clock, now stable with force present
    } else if (collapseThen !== null && !presenceNow) {
      frontOutcome = "no_presence"; // was a measured fight; no committed force remains
    } else if (
      (collapseThen === null && collapseNow !== null) ||
      (collapseThen !== null && collapseNow !== null &&
        collapseNow < collapseThen - REVIEW_TUNING.WORSEN_EPSILON_SEC)
    ) {
      frontOutcome = "worsened";
    } else if (collapseThen !== null && collapseNow !== null) {
      frontOutcome = "still_contested";
    } else {
      frontOutcome = "unchanged";
    }
  }

  // Anchor facility delta.
  let facilityOutcome: FacilityOutcome | undefined;
  let captureProgressNowPct: number | undefined;
  if (facility && record.baseline.facility) {
    const thenTeam = record.baseline.facility.team;
    captureProgressNowPct = Math.round(facility.captureProgress * 100);
    if (facility.hp <= 0 && record.baseline.facility.hp > 0) {
      facilityOutcome = "destroyed";
    } else if (thenTeam !== "player" && facility.team === "player") {
      facilityOutcome = "captured_by_us";
    } else if (thenTeam === "player" && facility.team !== "player") {
      facilityOutcome = "lost_by_us";
    } else if (facility.capturingTeam !== null && facility.captureProgress > 0) {
      facilityOutcome = "still_contested";
    } else {
      facilityOutcome = "unchanged";
    }
  }

  // Window resource delta (facts about the WINDOW, not a causal claim —
  // the voice states cost during the window, never "all because of this").
  const res = state.economy.player.resources;
  const fuelDelta = Math.round(res.fuel - record.baseline.fuel);
  const ammoDelta = Math.round(res.ammo - record.baseline.ammo);
  const moneyDelta = Math.round(res.money - record.baseline.money);
  const scarcerThen = Math.min(record.baseline.fuel, record.baseline.ammo);
  const scarcerNow = Math.min(res.fuel, res.ammo);
  const resourceSignificant =
    fuelDelta <= -REVIEW_TUNING.RESOURCE_DROP_SIG ||
    ammoDelta <= -REVIEW_TUNING.RESOURCE_DROP_SIG ||
    (scarcerThen > REVIEW_TUNING.RESOURCE_FLOOR && scarcerNow <= REVIEW_TUNING.RESOURCE_FLOOR);

  // Cross-front facts (Marcus's domain): what happened ELSEWHERE in-window.
  const crossFront: CrossFrontFact[] = [];
  for (const [fid, thenTeam] of Object.entries(record.baseline.keypointOwners)) {
    if (fid === record.facilityId) continue; // the anchor itself is the main story
    const f = state.facilities.get(fid);
    if (!f) continue;
    if (thenTeam === "player" && (f.team !== "player" || f.hp <= 0)) {
      const fFront = frontForFacilityRegion(state, f.regionId);
      crossFront.push({
        frontName: fFront?.name ?? f.name,
        kind: "keypoint_lost",
        facilityName: f.name,
      });
    }
  }
  for (const snap of record.baseline.fronts) {
    if (snap.frontId === record.frontId) continue;
    if (snap.collapseSeconds !== null) continue; // was already under pressure — not new
    const other = state.fronts.find((f) => f.id === snap.frontId);
    if (!other) continue;
    const nowC = frontCollapseSeconds(state, other);
    if (nowC !== null) {
      crossFront.push({ frontName: other.name, kind: "pressure_emerged", collapseSecondsNow: nowC });
    }
  }
  crossFront.splice(REVIEW_TUNING.CROSS_FRONT_MAX);

  // Worthiness: something must have actually RESOLVED or COST something.
  // still_contested / unchanged with light-or-no casualties stays silent —
  // an escalation answer does NOT bypass this bar (its positive delta, e.g.
  // collapse-clock → stable, already counts as "eased").
  const outcomeResolved =
    (frontOutcome !== undefined && frontOutcome !== "unchanged" && frontOutcome !== "still_contested") ||
    (facilityOutcome !== undefined && facilityOutcome !== "unchanged" && facilityOutcome !== "still_contested");
  const significant =
    outcomeResolved || casualtyLevel === "heavy" || crossFront.length > 0 || resourceSignificant;

  // Persona routing (deterministic, exactly one voice):
  //   Marcus (ops)      — a cross-front fact exists: the review is about what the
  //                       tradeoff cost elsewhere. Statement only; the retrospect
  //                       path never reaches resolveIntent/applyOrders.
  //   Emily (logistics) — nothing resolved at the anchor and casualties aren't the
  //                       story, but the window's resource cost is significant.
  //   Chen (combat)     — default: the combat outcome of a combat decision.
  let channel: Channel;
  if (crossFront.length > 0) {
    channel = "ops";
  } else if (resourceSignificant && !outcomeResolved && casualtyLevel !== "heavy") {
    channel = "logistics";
  } else {
    channel = "combat";
  }

  return {
    recordId: record.id,
    escalateId: record.escalateId,
    decisionKind: record.kind,
    decidedSecondsAgo: Math.round(state.time - record.createdAt),
    wasEscalationAnswer: record.escalateId !== undefined,
    channel,
    frontName: front?.name,
    facilityName: facility?.name,
    frontOutcome,
    collapseThen,
    collapseNow,
    engagementThen: record.baseline.front?.engagementIntensity,
    engagementNow,
    powerRatioThen: record.baseline.front?.powerRatio,
    powerRatioNow,
    facilityOutcome,
    captureProgressNowPct,
    assignedThen,
    assignedNow,
    casualties,
    casualtyLevel,
    fuelNow: Math.floor(res.fuel),
    ammoNow: Math.floor(res.ammo),
    fuelDelta,
    ammoDelta,
    moneyDelta,
    resourceSignificant,
    crossFront,
    significant,
  };
}

// ── Facts formatting (for LLM voice + console observability) ──

/**
 * Structured mini-facts for ONE review — concrete names/numbers only, no
 * player wording, no verdict prose. The LLM (7e.1c, /api/brief
 * mode="retrospect") writes ONE in-character STATEMENT from these. Same
 * shape discipline as the escalation/proactive fact packs: one situation,
 * never the full digest, never an example sentence.
 */
export function buildRetrospectMiniFacts(facts: DecisionReviewFacts): string {
  const survivalTime = (seconds: number | null | undefined): string =>
    seconds == null ? "stable" : `${Math.round(seconds)}秒`;

  const lines = [
    "DECISION REVIEW (voice ONE in-character STATEMENT about how the commander's earlier decision turned out — NOT a question, NOT advice):",
    `decision_kind: ${facts.decisionKind}`,
    `decided_seconds_ago: ${facts.decidedSecondsAgo}`,
    `was_answering_staff_question: ${facts.wasEscalationAnswer}`,
  ];
  if (facts.frontName) lines.push(`front: ${facts.frontName}`);
  if (facts.facilityName) lines.push(`facility: ${facts.facilityName}`);
  if (facts.frontOutcome) {
    lines.push(`front_outcome: ${facts.frontOutcome}`);
    lines.push(
      `estimated_survival_time_then_vs_now: ${survivalTime(facts.collapseThen)} → ${survivalTime(facts.collapseNow)}`,
    );
    if (facts.powerRatioThen != null || facts.powerRatioNow != null) {
      lines.push(
        `local_power_ratio_then_vs_now: ${facts.powerRatioThen ?? "unknown"} → ${facts.powerRatioNow ?? "unknown"}`,
      );
    }
  }
  if (facts.facilityOutcome) {
    lines.push(`facility_outcome: ${facts.facilityOutcome}`);
    if (facts.captureProgressNowPct !== undefined && facts.facilityOutcome === "still_contested") {
      lines.push(`capture_progress_now_pct: ${facts.captureProgressNowPct}`);
    }
  }
  lines.push(`units_dispatched: ${facts.assignedThen}`);
  lines.push(`units_lost: ${facts.casualties}`);
  lines.push(`casualty_level: ${facts.casualtyLevel}`);
  lines.push(`fuel_now: ${facts.fuelNow} (window_delta ${facts.fuelDelta})`);
  lines.push(`ammo_now: ${facts.ammoNow} (window_delta ${facts.ammoDelta})`);
  for (const cf of facts.crossFront) {
    lines.push(
      cf.kind === "keypoint_lost"
        ? `meanwhile_elsewhere: ${cf.frontName} keypoint_lost (${cf.facilityName})`
        : `meanwhile_elsewhere: ${cf.frontName} pressure_emerged (estimated survival time ~${survivalTime(cf.collapseSecondsNow)})`,
    );
  }
  return lines.join("\n");
}

/** One-line console string for debug/observability (7e.1b). Pure; engine
 *  facts only, NOT a player line. */
export function describeDecisionReview(facts: DecisionReviewFacts | null): string {
  if (!facts) return "[review] (anchor gone — dropped)";
  const bits = [
    `kind=${facts.decisionKind}`,
    `ch=${facts.channel}`,
    facts.frontName ? `front=${facts.frontName}` : null,
    facts.facilityName ? `fac=${facts.facilityName}` : null,
    facts.frontOutcome ? `frontOut=${facts.frontOutcome}` : null,
    facts.facilityOutcome ? `facOut=${facts.facilityOutcome}` : null,
    `cas=${facts.casualties}/${facts.assignedThen}(${facts.casualtyLevel})`,
    `fuelΔ=${facts.fuelDelta}`,
    `ammoΔ=${facts.ammoDelta}`,
    facts.crossFront.length > 0
      ? `cross=[${facts.crossFront.map((c) => `${c.frontName}:${c.kind}`).join(",")}]`
      : null,
    facts.wasEscalationAnswer ? `esc=${facts.escalateId}` : null,
    `sig=${facts.significant}`,
  ].filter(Boolean);
  return `[review] ${facts.significant ? "SPEAK" : "silent"} (${bits.join(" ")})`;
}
