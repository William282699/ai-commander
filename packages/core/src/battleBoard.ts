// ============================================================
// AI Commander — Battle Board (board-v1a)
//
// THE single structured answer to the three questions every player-
// addressable force must support: 在哪 / 在干嘛 / 怎么样. DigestV1
// (Chen/combat) and BattleContextV2 (Marcus/ops) both project from this
// ONE builder — never from private recomputations.
//
// Contract (BATTLEFIELD_BOARD_V1A_PROPOSAL.md v3 §3):
// - Squad rows: every role="leader" squad with alive members. Fields come
//   from the V1b §3-contract helpers over ALL alive members (manualOverride
//   included — the row reflects the whole squad as it stands).
// - Unassigned group rows are consumed VERBATIM from
//   buildReinforceOptions(state, null).options with squad entries removed
//   by exact-label set. Compass/ordinal/unique-label assembly stays in the
//   V1b builder — rebuilding a group label here would be a second source
//   of truth.
// - No ETA (that is the escalation channel's question, not the board's).
//   No cumulative casualties (no roster snapshot exists — current
//   headcount/HP only).
// - task=unknown is OMITTED at serialization time, never printed:
//   uncertainty is dropped, not hard-labeled.
// - Friendly units and public place metadata (standing facility names,
//   front centers) are the only reads — hiding enemies or flipping the
//   fog matrix must not change the board.
// ============================================================

import type { GameState, Unit } from "@ai-commander/shared";
import {
  buildReinforceOptions,
  locationPhraseFor,
  groupTaskStatus,
  hpPctOf,
  type ReinforceTaskStatus,
} from "./frontEscalationPayload";

// ── Tunables (presentation only — the board itself is never truncated) ──

/** Digest UNASSIGNED_UNITS group lines shown; the rest collapse into a
 *  "...+N more groups (M units)" line carrying TRUE counts. */
const MAX_GROUP_LINES = 6;

/** FORCES lines shown in BattleContextV2. Ordering puts 交战中 first, so a
 *  crisis row is only ever cut when MORE THAN this many rows are themselves
 *  engaged — the omitted count below the list stays the true remainder. */
const MAX_FORCE_LINES = 8;

// ── Row model ──

export interface BoardSquadRow {
  squadId: string;
  leaderName: string;
  /** Alive members only — same filter as the SQUADS digest line prefix. */
  unitCount: number;
  /** Σhp / Σ maxHp of ALIVE members (dead excluded from both sides). */
  hpPct: number;
  task: ReinforceTaskStatus;
  /** "X附近" | "向X行进中" | null (phrase omitted — never fabricated). */
  location: string | null;
}

export interface BoardGroupRow {
  /** Verbatim V1b candidate label — the group's speakable handle. */
  label: string;
  unitCount: number;
  composition: string;
  hpPct: number;
  task: ReinforceTaskStatus;
}

export interface BattleBoard {
  squads: BoardSquadRow[];
  groups: BoardGroupRow[];
}

// ── Builder ──

export function buildBattleBoard(state: GameState): BattleBoard {
  const squads: BoardSquadRow[] = [];
  for (const sq of state.squads ?? []) {
    if (sq.role !== "leader") continue;
    const alive = sq.unitIds
      .map((id) => state.units.get(id))
      .filter((u): u is Unit => u !== undefined && u.state !== "dead");
    if (alive.length === 0) continue;
    squads.push({
      squadId: sq.id,
      leaderName: sq.leaderName,
      unitCount: alive.length,
      hpPct: hpPctOf(alive),
      task: groupTaskStatus(state, alive, sq.currentMission),
      location: locationPhraseFor(state, alive),
    });
  }

  // Squad entries are removed from the V1b options by EXACT label match
  // (leader squads only — mirrors the builder's own label construction);
  // what remains are the unassigned spatial groups, consumed as-is.
  const squadLabels = new Set(
    (state.squads ?? [])
      .filter((s) => s.role === "leader")
      .map((s) => `${s.leaderName}(${s.id})`),
  );
  const groups: BoardGroupRow[] = buildReinforceOptions(state, null)
    .options.filter((o) => !squadLabels.has(o.label))
    .map((o) => ({
      label: o.label,
      unitCount: o.unitCount,
      composition: o.composition,
      hpPct: o.hpPct,
      task: o.task,
    }));

  return { squads, groups };
}

// ── DigestV1 projection (precomputed lines; shared/digest.ts receives them
//    as plain strings — the shared package never imports core) ──

function squadSuffix(row: BoardSquadRow): string {
  let s = "";
  if (row.task !== "unknown") s += ` task=${row.task}`;
  s += ` hp=${row.hpPct}%`;
  if (row.location !== null) s += ` loc=${row.location}`;
  return s;
}

function groupLine(row: BoardGroupRow): string {
  const task = row.task !== "unknown" ? ` ${row.task}` : "";
  return `- ${row.label}: ${row.unitCount}units(${row.composition}) hp=${row.hpPct}%${task}`;
}

export function boardToDigestLines(board: BattleBoard): {
  squadLineSuffixById: Record<string, string>;
  unassignedGroupLines: string[];
} {
  const squadLineSuffixById: Record<string, string> = {};
  for (const row of board.squads) squadLineSuffixById[row.squadId] = squadSuffix(row);

  const shown = board.groups.slice(0, MAX_GROUP_LINES);
  const unassignedGroupLines = shown.map(groupLine);
  const omitted = board.groups.length - shown.length;
  if (omitted > 0) {
    const units = board.groups
      .slice(MAX_GROUP_LINES)
      .reduce((sum, g) => sum + g.unitCount, 0);
    unassignedGroupLines.push(`...+${omitted} more groups (${units} units)`);
  }
  return { squadLineSuffixById, unassignedGroupLines };
}

// ── BattleContextV2 projection (---FORCES--- body lines) ──

/** Deterministic four-tier order (proposal §5): ops cares most about what is
 *  fighting and what is free. Engaged-first means a crisis row is only cut
 *  when >MAX_FORCE_LINES rows are engaged — declared, not papered over. */
function forceTier(task: ReinforceTaskStatus): number {
  switch (task) {
    case "交战中":
      return 0;
    case "无任务":
      return 1;
    case "守卫":
    case "巡逻":
      return 2;
    default:
      return 3; // unknown — still listed, just last
  }
}

export function boardToForcesLines(board: BattleBoard): string[] {
  const entries = [
    ...board.squads.map((r) => ({
      label: `${r.leaderName}(${r.squadId})`,
      unitCount: r.unitCount,
      hpPct: r.hpPct,
      task: r.task,
      location: r.location,
    })),
    ...board.groups.map((r) => ({
      label: r.label,
      unitCount: r.unitCount,
      hpPct: r.hpPct,
      task: r.task,
      location: null as string | null, // group labels already carry the place
    })),
  ];
  if (entries.length === 0) return ["None"];

  entries.sort((a, b) => {
    const t = forceTier(a.task) - forceTier(b.task);
    if (t !== 0) return t;
    return a.label.localeCompare(b.label);
  });

  const shown = entries.slice(0, MAX_FORCE_LINES);
  const lines = shown.map((e) => {
    const task = e.task !== "unknown" ? ` ${e.task}` : "";
    const loc = e.location !== null ? ` ${e.location}` : "";
    return `- ${e.label}: ${e.unitCount}units hp=${e.hpPct}%${task}${loc}`;
  });
  const omitted = entries.length - shown.length;
  if (omitted > 0) {
    // Carry the omitted UNIT total, not just the row count — manual test
    // showed Marcus summing only the visible rows into a wrong reserve total.
    const units = entries.slice(MAX_FORCE_LINES).reduce((sum, e) => sum + e.unitCount, 0);
    lines.push(`...+${omitted} more (${units} units)`);
  }
  return lines;
}
