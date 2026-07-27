// ============================================================
// Commander Presence V1 — engine-side judgment material (pure)
//
// Step A: FRONT_JUDGMENT — per-front survival / power-ratio / best-help
// columns rendered side by side, so "which front first" questions are
// answered from engine numbers, never from LLM mental arithmetic.
//
// Constitution: candidates + costs, never conclusions. Every number here
// is read from the ONE existing production estimator for that quantity:
//   - survival    → assessCrisisEscalation (6a collapse math, untouched)
//   - ratio       → freshFrontPowerRatio (7a fog-gated DPS read, untouched)
//   - best_help   → buildReinforceOptions (V1b candidate set, untouched)
//   - 交战中/hp%  → groupTaskStatus / hpPctOf (V1b own-evidence reads)
// No re-implementation of any of them lives in this file.
// ============================================================

import type { GameState, CrisisEvent, Front, Unit } from "@ai-commander/shared";
import { assessCrisisEscalation } from "./crisisResponse";
import { hasPlayerCombatPresence, freshFrontPowerRatio } from "./director";
import { buildReinforceOptions, groupTaskStatus, hpPctOf } from "./frontEscalationPayload";

/**
 * Player COMBAT units inside a front's bboxes. Mirrors the predicate inside
 * director's hasPlayerCombatPresence (which returns only a boolean; director.ts
 * is outside this rung's allowed change set, so the 4-line filter is repeated
 * here). Drift between the two fails SAFE: a unit the boolean counts but this
 * filter misses only suppresses an engaged-note — it can never leak.
 */
function playerCombatUnitsInFront(state: GameState, front: Front): Unit[] {
  const bboxes: [number, number, number, number][] = [];
  for (const rid of front.regionIds) {
    const r = state.regions.get(rid);
    if (r) bboxes.push(r.bbox);
  }
  const members: Unit[] = [];
  if (bboxes.length === 0) return members;
  state.units.forEach((u) => {
    if (u.team !== "player" || u.hp <= 0 || u.state === "dead") return;
    if (u.type === "commander" || u.attackDamage <= 0) return;
    const inFront = bboxes.some(
      ([x1, y1, x2, y2]) => u.position.x >= x1 && u.position.x <= x2 && u.position.y >= y1 && u.position.y <= y2,
    );
    if (inFront) members.push(u);
  });
  return members;
}

/**
 * Render the FRONT_JUDGMENT section. Three line kinds, all fog-honest:
 *
 *  - REAL line   — front has committed player combat force AND visible enemy
 *    DPS: survival≈/ratio=/best_help engine columns (gate ① kills the
 *    tCollapse=0 fake — the 7a Codex blocker; gate ② keeps hidden enemy DPS
 *    out of the survival estimate).
 *  - ENGAGED-UNKNOWN line — gate ① passes, gate ② fails, but OUR OWN units
 *    carry recent combat evidence (V1b isEngaged semantics via
 *    groupTaskStatus: the unit's own fired-at / took-damage timestamps —
 *    everything on the line is player-observable: own unit count, own hp%,
 *    own knowledge state, own-geometry best_help). Handtest 2026-07-25 round
 *    2: a front actively fighting under fog vanished from the frame — the
 *    MOST urgent front was the silent one. NOT rendered from
 *    engagementIntensity, which counts both teams and would leak enemy-only
 *    fights the player cannot see (battleAwareness.ts:235).
 *  - NO-FORCE note — gate ① fails: pure deployment fact (handtest round 1:
 *    the player was weighing a fallen front the frame silently omitted).
 *
 * Notes ride along only when at least one REAL or ENGAGED-UNKNOWN line
 * exists; a healthy battlefield (no visible enemies, no combat evidence)
 * keeps its byte-identical, section-free digest (Act-0 guard).
 */
export function buildFrontJudgmentLines(state: GameState): string[] {
  const body: string[] = [];
  const engagedUnknown: string[] = [];
  const noForce: string[] = [];

  for (const front of state.fronts) {
    if (!hasPlayerCombatPresence(state, front)) {
      // In-row void clause (fix4 followup): a numberless row gives the header's
      // "superseded by these" nothing to substitute, and the consultation
      // digit mandate then pulls the model toward the ONLY number source left —
      // a stale escalation snapshot ("全灭" recited as "还能撑1秒"). Voiding
      // the old numbers in the row the model actually reads for this front
      // kills that source; the categorical fact becomes the only compliant
      // answer. Vacuously true when no snapshot ever mentioned this front.
      noForce.push(`${front.name}: 无我方作战部队（增援须从后方调兵；早先提问里引用的该线存活/战力数字已作废）`);
      continue;
    }
    const ratio = freshFrontPowerRatio(state, front);
    if (ratio === null) {
      // Gate ② (fog). If our own units are trading fire here, that fact is on
      // the player's screen — silence would misreport the hottest front as
      // uneventful. hp%/count are instantaneous OWN quantities (no casualty
      // bookkeeping to invent, no cumulative-number fabrication — 07-20 口径).
      const members = playerCombatUnitsInFront(state, front);
      if (members.length > 0 && groupTaskStatus(state, members, null) === "交战中") {
        // Same in-row void clause as the no-force note: this row has no
        // survival/ratio either, so stale ask-time numbers would win by
        // being the only ones on offer.
        let line = `${front.name}: 交战中，我方${members.length}units hp=${hpPctOf(members)}%，敌军实力未明（无法给出存活估计；早先提问里引用的该线存活/战力数字已作废）`;
        const top = buildReinforceOptions(state, front).shown[0];
        if (top) {
          const eta = top.etaSec !== null ? `eta≈${top.etaSec}s` : "eta=unknown";
          line += ` best_help=${top.label}(${top.unitCount}units ${top.task} ${eta})`;
        }
        engagedUnknown.push(line);
      }
      continue;
    }

    const t = frontCollapseSeconds(state, front);
    const survival =
      t !== null && t !== Infinity ? `survival≈${Math.round(t)}s` : "survival=stable";

    let line = `${front.name}: ${survival} ratio=${ratio.toFixed(2)}`;

    // Top V1b candidate (无任务 first, then eta asc) — who could actually
    // steady this front and how long the engine says they need. eta=unknown
    // stays unknown; never a fabricated number.
    const top = buildReinforceOptions(state, front).shown[0];
    if (top) {
      const eta = top.etaSec !== null ? `eta≈${top.etaSec}s` : "eta=unknown";
      line += ` best_help=${top.label}(${top.unitCount}units ${top.task} ${eta})`;
    }

    body.push(line);
  }

  // Existence notes COMPLETE a comparison frame; with nothing real to compare
  // (no numeric line, no engaged front) the whole section stays omitted.
  if (body.length === 0 && engagedUnknown.length === 0) return [];
  return [
    // Header carries the precedence rule ON THE WIRE, right next to the fresh
    // numbers (handtest round-3 followup: Chen recited his own earlier
    // escalation question's ask-time numbers over this frame's current ones —
    // the stale source sits in the same envelope, so the correction must too).
    "---FRONT_JUDGMENT--- (CURRENT values for this reply — numbers quoted in earlier questions/escalations are ask-time snapshots, superseded by these; survival=committed HP vs visible enemy DPS, eta=straight-line terrain estimate; read these numbers — do NOT hand-compute distance/time from coordinates)",
    ...body,
    ...engagedUnknown,
    ...noForce,
  ];
}

/**
 * The ONE route to the production collapse estimator — the same synthetic-crisis
 * pattern decisionReview uses to reach it through its exported entry point.
 * null = estimator unavailable for this front (never substitute a number).
 */
function frontCollapseSeconds(state: GameState, front: Front): number | null {
  const crisis: CrisisEvent = {
    type: "DOCTRINE_BREACH",
    severity: "critical",
    doctrineId: "__presence__",
    locationTag: front.id,
    message: `${front.name} 判读基线`,
    time: state.time,
  };
  const a = assessCrisisEscalation(state, crisis);
  return a ? a.tCollapse : null;
}

// ============================================================
// Step B: commanderMood — battlefield temperature for the voice
//
// Same frame as FRONT_JUDGMENT, read for tone instead of columns. Three
// gates, IDENTICAL sources to the three line kinds above:
//   ① hasPlayerCombatPresence — the tCollapse=0 fake (7a Codex blocker)
//     must not raise the voice either.
//   ② engagement evidence = our OWN units' fired-at / took-damage
//     timestamps (groupTaskStatus). NEVER engagementIntensity — it counts
//     BOTH teams (battleAwareness), so a pure enemy-vs-enemy fight the
//     player cannot see would tighten the voice; a tone jump is a sneakier
//     leak than a number because the player can't ask where it came from.
//   ③ collapse seconds may drive the level and appear in the reason ONLY
//     where freshFrontPowerRatio is non-null (visible enemy DPS on the
//     line — estimateCollapseTime counts unseen enemies, FOG-TODO in
//     crisisResponse.ts). A fogged brawl is tense on own observable facts
//     alone and its reason carries no seconds.
// ============================================================

export type CommanderMoodLevel = "calm" | "tense" | "critical";

export interface CommanderMood {
  level: CommanderMoodLevel;
  /** One engine-fact line justifying the level — player-observable sources only. */
  reason: string;
}

/** critical = a front passes all three gates AND collapse is this close (≤, sec). */
const CRITICAL_COLLAPSE_SEC = 30;

export function commanderMood(state: GameState): CommanderMood {
  // Worst front wins: higher band first; inside a band, smaller collapse time.
  let best: { rank: number; t: number; reason: string } | null = null;
  const consider = (rank: number, t: number, reason: string) => {
    if (!best || rank > best.rank || (rank === best.rank && t < best.t)) {
      best = { rank, t, reason };
    }
  };

  for (const front of state.fronts) {
    if (!hasPlayerCombatPresence(state, front)) continue; // gate ①
    const members = playerCombatUnitsInFront(state, front);
    if (members.length === 0 || groupTaskStatus(state, members, null) !== "交战中") continue; // gate ②

    const ratio = freshFrontPowerRatio(state, front);
    if (ratio === null) {
      // Gate ③ fog branch: own facts only, no seconds.
      consider(1, Infinity, `${front.name}交战中，敌军实力未明`);
      continue;
    }
    const t = frontCollapseSeconds(state, front);
    if (t !== null && t <= CRITICAL_COLLAPSE_SEC) {
      consider(2, t, `${front.name}约${Math.max(1, Math.round(t))}秒内承压加剧`);
    } else {
      // Engaged with a visible enemy but no imminent collapse: tense on the
      // fight itself; the ratio is the fog-gated fact that sizes it.
      consider(1, t ?? Infinity, `${front.name}交战中，战力比${ratio.toFixed(2)}`);
    }
  }

  if (best === null) return { level: "calm", reason: "我方部队无接战" };
  const b: { rank: number; t: number; reason: string } = best;
  return { level: b.rank === 2 ? "critical" : "tense", reason: b.reason };
}

/**
 * Envelope line for both digest routes. calm renders NOTHING — a battlefield
 * with no engaged player force keeps its byte-identical pre-presence envelope
 * (same Act-0 guard as FRONT_JUDGMENT); the prompts read the line's absence
 * as the calm register.
 */
export function buildCommanderMoodLine(state: GameState): string | null {
  const mood = commanderMood(state);
  if (mood.level === "calm") return null;
  return `mood: ${mood.level}（${mood.reason}）`;
}
