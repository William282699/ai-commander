// ============================================================
// Commander Presence V1 — engine-side judgment material (pure)
//
// Step A: FRONT_JUDGMENT — per-front survival / power-ratio / best-help
// columns rendered side by side, so "which front first" questions are
// answered from engine numbers, never from LLM mental arithmetic.
//
// Constitution: candidates + costs, never conclusions. Every number here
// is read from the ONE existing production estimator for that quantity:
//   - survival  → assessCrisisEscalation (6a collapse math, untouched)
//   - ratio     → freshFrontPowerRatio (7a fog-gated DPS read, untouched)
//   - best_help → buildReinforceOptions (V1b candidate set, untouched)
// No re-implementation of any of them lives in this file.
// ============================================================

import type { GameState, CrisisEvent } from "@ai-commander/shared";
import { assessCrisisEscalation } from "./crisisResponse";
import { hasPlayerCombatPresence, freshFrontPowerRatio } from "./director";
import { buildReinforceOptions } from "./frontEscalationPayload";

/**
 * Render the FRONT_JUDGMENT section: one line per front that has BOTH a real
 * committed player combat force AND visible enemy DPS to weigh it against.
 *
 * Gates (both required, in this order):
 *  1. hasPlayerCombatPresence — kills the tCollapse=0 fake on empty fronts
 *     (the 7a Codex blocker; same gate decisionReview applies).
 *  2. freshFrontPowerRatio !== null — fog-honest: no VISIBLE enemy weapons in
 *     the front means nothing to judge, and rendering survival there would
 *     leak hidden-enemy DPS through the collapse estimate.
 *
 * Empty result = section omitted entirely (宁缺勿假), so a healthy battlefield
 * carries no judgment frame and consultation answers stay non-alarmist.
 */
export function buildFrontJudgmentLines(state: GameState): string[] {
  const body: string[] = [];
  // Gate-① failures get an existence note (handtest 2026-07-25: the player was
  // weighing a fallen front the frame silently omitted — "哪条" had no second
  // option on the wire). Deployment absence is the player's OWN state, always
  // known, zero fog leak; the note carries NO enemy-derived data. Gate ② stays
  // silent as before — rendering survival there would leak hidden enemy DPS.
  const noForce: string[] = [];

  for (const front of state.fronts) {
    if (!hasPlayerCombatPresence(state, front)) {
      noForce.push(`${front.name}: 无我方作战部队（增援须从后方调兵）`);
      continue;
    }
    const ratio = freshFrontPowerRatio(state, front);
    if (ratio === null) continue;

    // Same synthetic-crisis pattern decisionReview uses to reach the ONE
    // collapse estimator through its exported entry point.
    const crisis: CrisisEvent = {
      type: "DOCTRINE_BREACH",
      severity: "critical",
      doctrineId: "__presence__",
      locationTag: front.id,
      message: `${front.name} 判读基线`,
      time: state.time,
    };
    const a = assessCrisisEscalation(state, crisis);
    const survival =
      a && a.tCollapse !== Infinity
        ? `survival≈${Math.round(a.tCollapse)}s`
        : "survival=stable";

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

  // No-force notes exist to COMPLETE a comparison frame; with zero real
  // judgment lines there is nothing to compare, so the whole section stays
  // omitted — the healthy battlefield keeps its byte-identical, non-alarmist
  // digest (Act-0 regression guard).
  if (body.length === 0) return [];
  return [
    "---FRONT_JUDGMENT--- (engine-computed compare frame: survival=committed HP vs visible enemy DPS, eta=straight-line terrain estimate; read these numbers — do NOT hand-compute distance/time from coordinates)",
    ...body,
    ...noForce,
  ];
}
