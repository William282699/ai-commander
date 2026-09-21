// ============================================================
// AI Commander — 「是哪一批」这一轮该做什么（刀己 / 审核 §二）
//
// 为什么整段搬进 core（同 `autoExecuteGate.decideBucket` 的理由）：
// 判定本体留在 ChatPanel 的闭包里，**没有任何机器断言看得见它**。刀C 的消歧
// 就是这么栽的——「问一次就相信模型」那句话写在闭包注释里，探针 C3c 只能绕开它
// 直接喂 `fromDispatch: M1`，于是"绑定"这件事从头到尾没有一条判据压着。
//
// 本模块＝这一轮的**全部判断**：合同裁决 → 按 key 现查绑定 → 权限复核 →
// 给出一个 plan。ChatPanel 降为 plan 的执行者（打屏、出声、进主链），
// 一个判断都不自己做。
// ============================================================

import type { GameState, Intent, CommanderKey } from "@ai-commander/shared";
import {
  judgeSelectionConsumption,
  selectionVerdictRoute,
  parseSelectionDecision,
  type SelectionRequestTag,
  type SelectionVerdict,
} from "@ai-commander/shared";
import {
  enumerateDispatchCandidates,
  bindDispatchSelection,
  type DispatchCandidate,
} from "./dispatchLedger";
import { checkDispatchAuthority } from "./commandAuthority";

/** 待决槽里与判定相关的那几样（名单**不在**其中——名单必须现查）。 */
export interface SelectionSlotState {
  id: string;
  channel: string;
  sessionId: string;
  epoch: number;
  expiresAt: number;
  /** 提问时印出去的候选（闸押在这一份 selectionKey 名单上）。 */
  candidates: DispatchCandidate[];
  /** 被问的那条原命令。绑定后执行的是**它**。 */
  intentSnapshot: Intent;
}

export type SelectionTurnPlan =
  /** 绑定成功 ⇒ 执行这条**原命令**（来源已换成他选的那一批），名单是硬约束。 */
  | { kind: "execute"; intent: Intent; unitIds: number[]; selectionKey: string; label: string }
  /** 零执行，说明原因（人没了 / 调不动 / 来源还原不了）。 */
  | { kind: "refuse"; line: string }
  /** 零执行，再问一次（候选已现查过滤）。 */
  | { kind: "reask"; candidates: DispatchCandidate[]; lead: string }
  /** 这一轮与那一问无关（或根本没问过）⇒ 走正常流程。 */
  | { kind: "passthrough" };

export interface SelectionTurnDecision {
  verdict: SelectionVerdict;
  plan: SelectionTurnPlan;
  /** 判完之后那一槽还留不留。 */
  keepSlot: boolean;
  /** 允许清掉**这次请求带的那一槽**（过期三方对齐那一格）。 */
  clearExpiredSlot: boolean;
}

/**
 * 这一轮该做什么。**纯函数**（只读 GameState，不改它）。
 *
 * 三条铁律都在这里落地：
 *   ① 「好的」不算选择 ⇒ 模型判 `unclear` ⇒ `reask`，零执行。
 *   ② candidate key 必须是本次**实际给过**的（judgeSelectionConsumption 的闸）。
 *   ③ 绑定后的名单一律**现查**，且必须过这位参谋的权限池。
 */
export function planSelectionTurn(args: {
  state: GameState;
  slot: SelectionSlotState | null;
  requestTag: SelectionRequestTag | null;
  epoch: number;
  now: number;
  persona: CommanderKey;
  /** 模型交回的原始字段（不做任何预处理——严格解析在合同里）。 */
  rawDecision: unknown;
  /** 参谋的显示名，只用于拼那句拒绝话。 */
  personaLabel: string;
}): SelectionTurnDecision {
  const { state, slot, requestTag, epoch, now, persona, rawDecision, personaLabel } = args;

  const judge = judgeSelectionConsumption({
    requestTag,
    current: slot
      ? {
          id: slot.id,
          channel: slot.channel,
          sessionId: slot.sessionId,
          epoch: slot.epoch,
          expiresAt: slot.expiresAt,
          candidateKeys: slot.candidates.map((c) => c.selectionKey),
        }
      : null,
    now,
    epoch,
    decision: parseSelectionDecision(rawDecision),
  });
  const route = selectionVerdictRoute(judge.verdict);
  const base = { verdict: judge.verdict, keepSlot: route.keepSlot, clearExpiredSlot: judge.expiredExactMatch };

  if (route.processResponse) return { ...base, plan: { kind: "passthrough" } };

  // 走到这儿一定有槽（executeBound / keepSlot 两族都要求三方对齐过）。
  if (!slot) {
    return { ...base, keepSlot: false, plan: { kind: "refuse", line: "刚才那一问已经作废了，请再说一遍要动哪一批。" } };
  }

  if (route.executeBound && judge.candidateKey) {
    const bound = bindDispatchSelection(state, slot.intentSnapshot, judge.candidateKey);
    if (!bound.ok) {
      return {
        ...base,
        keepSlot: false,
        plan: {
          kind: "refuse",
          line: bound.reason === "gone"
            ? "您说的那一批已经不在了（人没了，或者那次任务已经结束），这道命令没有执行。"
            : "那条命令的来源已经无法还原，这道命令没有执行——请重新说一遍。",
        },
      };
    }
    const lawful = lawfulSubset(state, persona, bound.intent, bound.unitIds);
    if (lawful.length === 0) {
      return {
        ...base,
        keepSlot: false,
        plan: {
          kind: "refuse",
          line: `${personaLabel}现在调不动那一批人，这道命令没有执行——请对带这支部队的指挥官下令。`,
        },
      };
    }
    return {
      ...base,
      keepSlot: false,
      plan: { kind: "execute", intent: bound.intent, unitIds: lawful, selectionKey: bound.selectionKey, label: bound.label },
    };
  }

  // unclear / protocol_failure / bad_key ⇒ 零执行，再问一遍。
  // ★ 候选**现查**一遍：等回复那几秒里死掉的人、关掉的任务，不该再出现在问句里。
  const fresh = enumerateDispatchCandidates(state, slot.intentSnapshot)
    .filter((c) => slot.candidates.some((old) => old.selectionKey === c.selectionKey));

  if (fresh.length === 0) {
    return { ...base, keepSlot: false, plan: { kind: "refuse", line: "刚才问的那几批现在都不在了，这道命令没有执行。" } };
  }
  if (fresh.length === 1) {
    // 只剩一批 ⇒ 指代已经唯一，再问就是缠人（撞「勿变 20 问」）。直接按它办。
    const only = fresh[0];
    const bound = bindDispatchSelection(state, slot.intentSnapshot, only.selectionKey);
    if (!bound.ok) {
      return { ...base, keepSlot: false, plan: { kind: "refuse", line: "刚才问的那几批现在都不在了，这道命令没有执行。" } };
    }
    const lawful = lawfulSubset(state, persona, bound.intent, bound.unitIds);
    if (lawful.length === 0) {
      return {
        ...base, keepSlot: false,
        plan: { kind: "refuse", line: `${personaLabel}现在调不动那一批人，这道命令没有执行。` },
      };
    }
    return {
      ...base, keepSlot: false,
      plan: { kind: "execute", intent: bound.intent, unitIds: lawful, selectionKey: bound.selectionKey, label: bound.label },
    };
  }

  return {
    ...base,
    keepSlot: true,
    plan: {
      kind: "reask",
      candidates: fresh,
      // bad_key 那一格要说清"我没听准"，别让长官以为自己答了个没用的答案。
      lead: judge.verdict === "bad_key"
        ? "我没听准您指的是哪一批，再确认一次：这道命令还没有执行。"
        : "这道命令还没有执行。",
    },
  };
}

/** 这位参谋此刻调得动的那一部分（走与主链同一个权限闸）。 */
function lawfulSubset(state: GameState, persona: CommanderKey, intent: Intent, unitIds: readonly number[]): number[] {
  const auth = checkDispatchAuthority(state, persona, intent);
  if (auth.kind === "denied") return [];
  const pool = auth.kind === "allowed" ? new Set(auth.pool) : null;
  return pool ? unitIds.filter((id) => pool.has(id)) : [...unitIds];
}
