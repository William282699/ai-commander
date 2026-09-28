// ============================================================
// AI Commander — 把**存下的待批方案**说成人话（第八轮）
//
// 病（Codex 复现）：北、南前哨各派过 2 人 → 长官只说「是的」→ 模型重写北、南各增援 2 人 →
// 引擎只问「北线再派 2 个，要再派吗？」→ 长官答「对」→ 实际北、南各派 2 人。
// 问句是拿**第一条命中的那一条**拼的，存下待批的却是**整份方案**：长官点头的范围 ≠ 执行的范围。
// 去处收窄那一问（「按北线前哨办吗」）、高影响那一问（模型的 brief 当开头 / 只看单条的代价台词）
// 是同一个形状。
//
// 规则：**引擎发起的批准问题，由存下的那份完整方案逐条生成**——每一条都说动作、来源、数量、去处；
// 长官点头批的就是这几条，点头后执行的也正是这一份（执行前照旧全链复核）。本模块只负责把方案
// 翻成人话：名字全取自引擎状态（据点名、战线名、票上的群名、任务号），不取模型写的 label/brief。
// ============================================================

import type { GameState, Intent } from "@ai-commander/shared";
import { describeTargetForLog, findFront, UNIT_TYPE_WORD } from "./tacticalPlanner";
import { lookupEscalationTicket, isTicketRef, spokenNameOf } from "./escalationTicket";
import { findDispatch } from "./dispatchLedger";

// 动作的中文说法（封闭集合：把枚举翻成人话，不是穷举长官怎么说）。
const VERB: Record<string, string> = {
  attack: "进攻", defend: "设防", retreat: "撤退", recon: "侦察", hold: "原地待命", patrol: "巡逻",
  reinforce: "增援", capture: "占领", sabotage: "破坏", escort: "护送", produce: "生产", trade: "交易",
};
const QTY_WORD: Record<string, string> = { all: "全部", most: "大部分", some: "一部分", few: "少量" };

/** 这一条从哪儿调人（只用引擎认得的名字；认不出就照写字段值，不编）。没点来源 ⇒ null。 */
function sourceOf(state: GameState, it: Intent): string | null {
  if (it.fromDispatch) {
    const d = findDispatch(state, it.fromDispatch);
    return d?.targetName ? `刚才派去${d.targetName}的那批（${d.id}）` : `任务 ${it.fromDispatch} 那批`;
  }
  if (it.fromSquad) {
    if (isTicketRef(it.fromSquad)) {
      const look = lookupEscalationTicket(it.fromSquad, state.time);
      const t = look.ok ? look.ticket : look.ticket;
      if (t) return `${spokenNameOf(t)}（${t.gNumber}）`;
    }
    const fs = it.fromSquad.toLowerCase();
    const sq = state.squads?.find((q) => q.id === it.fromSquad || q.leaderName?.toLowerCase() === fs);
    if (sq) return `${sq.leaderName ?? sq.id}的分队`;
    return it.fromSquad;
  }
  if (it.fromFront) {
    const fr = findFront(state, it.fromFront);
    return `${fr?.name ?? it.fromFront}上的部队`;
  }
  return null;
}

/** 一条单子的完整说法：动作、来源、数量（含兵种）、去处。 */
export function describeIntentForApproval(state: GameState, it: Intent): string {
  const verb = VERB[it.type] ?? it.type;
  const src = sourceOf(state, it);
  const qty = typeof it.quantity === "number" ? `${it.quantity} 个` : it.quantity ? (QTY_WORD[it.quantity] ?? String(it.quantity)) : "";
  const kind = it.unitType ? (UNIT_TYPE_WORD[it.unitType] ?? "") : "";
  const wroteDest = !!(it._targetPos || it.targetFacility || it.targetRegion || it.toFront);
  const dest = wroteDest ? describeTargetForLog(it, state) : "";
  if (it.type === "produce" || it.type === "trade") {
    return `${verb}${it.produceType ?? it.tradeAction ?? ""}${qty ? ` ${qty}` : ""}`;
  }
  // 几个：数量＋兵种；没写数量时，点了一批人就是「全部」、没点来源就是「就近的」。
  const count = `${qty}${kind}` || (it.fromDispatch ? "全部" : "");
  // 数字前留一格（与回执「已下令 2 个」同一写法），「全部」「大部分」这种词前不留。
  const sp = /^\d/.test(count) ? " " : "";
  const place = dest ? `去${dest}` : "就地";
  if (it.type === "retreat" || it.type === "hold") {
    const whoMoves = src
      ? `${src}${count ? `的${sp}${count}` : ""}`
      : typeof it.quantity === "number" ? `就近的 ${count}` : count ? `${count}部队` : `就近的${kind || "部队"}`;
    if (it.type === "hold") return `${whoMoves}原地待命`;
    const where = it.returnTo === "origin" ? "撤回出发地" : dest ? `撤到${dest}` : "往安全方向撤退";
    return `${whoMoves}${where}`;
  }
  // 点了来源 ⇒「从 X 派 N 个去 Y 设防」；没点来源 ⇒ 由数量说清范围（派全部部队 / 派就近的 2 个）。
  if (src) return count ? `从${src}派${sp}${count}${place}${verb}` : `从${src}派兵${place}${verb}`;
  const who = typeof it.quantity === "number" ? `就近的 ${count}` : count ? `${count}部队` : `就近的${kind || "部队"}`;
  return `派${who}${place}${verb}`;
}

/** 整份方案：逐条、按单子原来的顺序，用「；」连起来。 */
export function describePlanForApproval(state: GameState, intents: readonly Intent[]): string {
  return intents.map((it) => describeIntentForApproval(state, it)).join("；");
}
