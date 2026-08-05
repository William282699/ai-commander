// ============================================================
// AI Commander — "谁被抽走了" disclosure (H1, user ruling 2026-08-05)
//
// 现场 (hand-test 2026-08-05, 03:15): the commander says 「放弃北线前哨，我们现在
// 重要的是拿下山脊战线」; Chen emits attack + toFront + quantity=all; the engine's
// full-mobilization path takes the GLOBAL pool and skips the busy filter
// (tacticalPlanner resolveSourceUnits), so 14 units go — including the 10 the
// commander had personally committed to 中央战线 76 seconds earlier. They left a
// live defence without a word being said about it.
//
// ★ The ruling is DISCLOSURE, not a gate (user, 2026-08-05):
//   「全军池和 busy 旁路一行不动 —— "全军"就该是全军，清楚就办不打折。」
// Pulling committed troops is a legitimate command decision; doing it silently
// is not. So nothing here blocks, filters or re-selects anything. It reads the
// dispatch that already happened and states what it cost.
//
// Engine-authored on purpose (same family as ticketDispatchReceipt): this is a
// reconciliation of what the engine just did, never a line the model composes.
// A model-authored version would be free to round it, soften it, or omit it —
// and 台词自造执行事实 is a live open account (G3).
//
// The mis-trigger upstream — a strategic remark being translated into an
// offensive at all — is G1's account and deliberately NOT touched here.
// ============================================================

import type { Front, GameState, Position, Unit } from "@ai-commander/shared";
import { isInsideFront } from "./frontDestination";
import { isUnitIdle } from "./frontEscalationPayload";

export interface CommittedPullDisclosure {
  /** How many dispatched units were already on a task. Never 0 — an empty
   *  disclosure is null, so callers cannot print a "0 units" sentence. */
  count: number;
  /** The unit ids behind `count`, so a bench can recount instead of trusting
   *  the prose (家法：谁报的数字对方重算才作数). */
  unitIds: number[];
  /** Engine-authored, ready to print. */
  line: string;
}

/**
 * What this unit is doing, in the board's own vocabulary. Read from the unit's
 * OWN orders/state — never from a mission table that may have gone stale.
 */
function taskWordOf(u: Unit): string {
  // Vocabulary deliberately mirrors the board's (frontEscalationPayload's
  // orderTaskOf): the receipt must call a task the same thing the envelope
  // called it one turn earlier, or the commander reads two names for one job.
  switch (u.orders[0]?.action) {
    case "defend":
    case "hold":
      return "设防";
    case "patrol":
      return "巡逻";
    case "attack_move":
    case "flank":
      return "进攻";
    case "retreat":
      return "撤退";
    case "recon":
      return "侦察";
    case "escort":
      return "护送";
    case "sabotage":
      return "破坏";
    default:
      break;
  }
  switch (u.state) {
    case "defending": return "设防";
    case "patrolling": return "巡逻";
    case "attacking": return "进攻";
    case "retreating": return "撤退";
    case "moving": return "转移";
    default: return "任务";
  }
}

/** The front this unit currently stands in; null when it stands outside them all. */
function frontAt(state: GameState, pos: Position): Front | null {
  for (const f of state.fronts) {
    if (isInsideFront(state, f, pos)) return f;
  }
  return null;
}

/**
 * Read a completed dispatch and report which of its units were torn off
 * something. Returns null when every dispatched unit was idle — the silent case
 * is the common one and must stay silent, or the disclosure becomes noise the
 * commander learns to skip.
 *
 * Must be called BEFORE applyOrders: that is what overwrites unit.state and
 * unit.orders, and afterwards every unit looks equally busy on the NEW task.
 */
export function describeCommittedPull(
  state: GameState,
  unitIds: readonly number[],
): CommittedPullDisclosure | null {
  const buckets = new Map<string, number[]>();
  for (const id of unitIds) {
    const u = state.units.get(id);
    if (!u || u.hp <= 0 || u.state === "dead") continue;
    if (isUnitIdle(u)) continue;
    const front = frontAt(state, u.position);
    const key = `${front ? front.name : "战线外"}的${taskWordOf(u)}任务`;
    const bucket = buckets.get(key);
    if (bucket) bucket.push(id);
    else buckets.set(key, [id]);
  }
  if (buckets.size === 0) return null;

  // Biggest pull first; ties by descriptor so the sentence is deterministic.
  const parts = Array.from(buckets.entries()).sort(
    (a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]),
  );
  const ids = parts.flatMap(([, v]) => v);
  // One source reads as one sentence (裁定原文的例句形状); several need the
  // breakdown, because "12个被抽走" without saying from where is the same
  // silence in a shorter form.
  const line =
    parts.length === 1
      ? `其中${ids.length}个是从${parts[0][0]}上抽走的。`
      : `其中${ids.length}个原本有任务在身：${parts.map(([k, v]) => `${v.length}个从${k}`).join("、")}上抽走的。`;
  return { count: ids.length, unitIds: ids, line };
}
