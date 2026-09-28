// ============================================================
// AI Commander — 「这张新单子与一次还在办的外派是不是同一件事」（第六轮立、第七轮改语义）
//
// 只做**识别**，不做裁决。返回那次外派的台账号，调用方据此**问长官**（存成待确认方案）；
// 本模块不判「这是重复答复」，也不把单子改成「对那批人」——
// 第六轮曾那样做（⇒「已经在办」），交接复审指出这是语义推断：长官若真要增援，会被谎称「已在办」。
//
// 两个问题分开：
//   · 同一请求/同一回复被网络重复投递 ⇒ 请求身份的幂等（processAdvisorData 顶部：一个请求编号只处理一次），
//     不在这里；
//   · 长官又说了一句（「是的」「再派两个」）⇒ 答复指向，归长官说。本模块只提供两样**事实**：
//     ① 这张单子的原话片段（去处 / 数量）有没有一个出自长官这一句——有 ⇒ 他这句就在下这道令，不必问；
//        没有（含根本没写片段）⇒ 这句话没说它，引擎只能问（**不把「没有片段」当成「必然重复」**）；
//     ② 有没有一次**还在办**的外派与它同动作、同去处（或它所在的战线）、同谱系
//        （同一张用过的票及其剩下的人 / 同一条战线 / 同一个分队）——没有 ⇒ 没有重复可言，照常执行。
//   不按目的地合并两批不同的人：谱系对不上就不算同一件事。
// ============================================================

import type { GameState, Intent } from "@ai-commander/shared";
import { activeDispatches, liveDispatchMembers } from "./dispatchLedger";
import { burnedAncestorsOf } from "./escalationTicket";
import { destinationCovers } from "./tacticalPlanner";
import { isDispatchIntent } from "./commandAuthority";

export function findSameTaskInProgress(
  state: GameState,
  intent: Intent,
  playerText: string | null | undefined,
): { dispatchId: string } | null {
  if (!isDispatchIntent(intent.type) || intent.fromDispatch) return null;
  const said = (playerText ?? "").trim();
  const quotes = [intent.destinationQuote, intent.quantityQuote].map((q) => (q ?? "").trim()).filter((q) => q.length > 0);
  if (said && quotes.some((q) => said.includes(q))) return null; // ① 这一句说了它 ⇒ 新命令

  const norm = (v: string | undefined) => (v ?? "").trim().toLowerCase();
  const ancestors = new Set(burnedAncestorsOf(intent.fromSquad));
  const hits = activeDispatches(state).filter((d) => {
    if (d.action !== intent.type) return false;
    const live = liveDispatchMembers(state, d);
    if (live.length === 0) return false;
    const sameBatch =
      (!!d.ticketRef && ancestors.has(d.ticketRef)) ||
      (!!intent.fromFront && d.sourceKind === "front" && norm(d.sourceKey) === norm(intent.fromFront)) ||
      (!!intent.fromSquad && d.sourceKind === "squad" && norm(d.sourceKey) === norm(intent.fromSquad));
    if (!sameBatch) return false;
    return live.some((u) => {
      const t = u.orders[0]?.target;
      return !!t && destinationCovers(state, intent, t);
    });
  });
  if (hits.length === 0) return null;
  hits.sort((a, b) => b.atGameTime - a.atGameTime);
  return { dispatchId: hits[0].id };
}
