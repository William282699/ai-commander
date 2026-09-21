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
  /**
   * ★复审 §三：那条歧义 intent 在**整份 option** 里的下标。
   *
   * 病：上一版只存了那一条 intent，绑定后也只执行它 ⇒ 同一句话里的其余 intents
   * **静默消失**（「南线的都撤回来，顺便让 Aiden 去中央」⇒ 只剩撤退那半条）。
   * 现在把整组 intents 一起存，绑定结果**放回原位置**，整组重走主链预检。
   */
  intentIndex: number;
  /** 被问的那一句里**全部** intents（按原顺序）。 */
  allIntents: Intent[];
}

export type SelectionTurnPlan =
  /** 绑定成功 ⇒ 执行这条**原命令**（来源已换成他选的那一批），名单是硬约束。
   *  ★只有 verdict==="chose" 能走到这里。 */
  | {
      kind: "execute";
      /** 绑定后的那一条（来源已换成他选的那一批）。 */
      intent: Intent;
      /**
       * ★复审 §三：**整组** intents，绑定结果已放回原位置。
       * 执行层必须把这一整组交给主链，不许只执行 `intent` 那一条。
       */
      intents: Intent[];
      unitIds: number[];
      selectionKey: string;
      label: string;
    }
  /** 零执行，说明原因（人没了 / 调不动 / 来源还原不了）。 */
  | { kind: "refuse"; line: string }
  /** 零执行，再问一次（候选已现查过滤）。
   *  `soleCandidate` ⇒ 现查后只剩一批：问法换成「现在只剩这一批，是否就是它」，
   *  但**仍然是问**，绝不替长官定。 */
  | { kind: "reask"; candidates: DispatchCandidate[]; lead: string; soleCandidate: boolean }
  /** 这一轮与那一问无关（或根本没问过）⇒ 走正常流程。 */
  | { kind: "passthrough" }
  /** ★这一次投递完全 inert：不上屏、不进 context、新旧 options 一律不执行。 */
  | { kind: "inert" };

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

  // ★复审 §二：stale ⇒ **完全 inert**，一件事都不做（多半是同一次回复的重复
  //   投递：SSE 已处理过 options，随后 stream error 又走了 /api/command 兜底）。
  if (route.inert) return { ...base, plan: { kind: "inert" } };
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
    // ★复审 §三：绑定结果放回它在整份 option 里的原位置，其余 intents 原样带上。
    //   一条都不许丢——丢了就是"只执行了半句话"，而长官以为整句都办了。
    // 深度防御：TS 已强制这两个字段，但 JS 调用方（台架/将来的新入口）漏传时
    // 不许崩——退回"只有这一条"，与 intentIndex=0 自洽。
    const all = Array.isArray(slot.allIntents) && slot.allIntents.length > 0
      ? slot.allIntents : [slot.intentSnapshot];
    const at = Number.isInteger(slot.intentIndex) && slot.intentIndex >= 0 && slot.intentIndex < all.length
      ? slot.intentIndex : 0;
    const merged = all.map((it, i) => (i === at ? bound.intent : it));
    return {
      ...base,
      keepSlot: false,
      plan: {
        kind: "execute",
        intent: bound.intent,
        intents: merged,
        unitIds: lawful,
        selectionKey: bound.selectionKey,
        label: bound.label,
      },
    };
  }

  // unclear / protocol_failure / bad_key ⇒ 零执行，再问一遍。
  // ★ 候选**现查**一遍：等回复那几秒里死掉的人、关掉的任务，不该再出现在问句里。
  const fresh = enumerateDispatchCandidates(state, slot.intentSnapshot)
    .filter((c) => slot.candidates.some((old) => old.selectionKey === c.selectionKey));

  if (fresh.length === 0) {
    return { ...base, keepSlot: false, plan: { kind: "refuse", line: "刚才问的那几批现在都不在了，这道命令没有执行。" } };
  }

  // ★★复审 §一：**候选只剩一个也必须零执行**。
  //
  //   上一版写的是「只剩一批 ⇒ 指代已经唯一，直接按它办」，理由是"再问就是缠人"。
  //   那条理由不成立：长官这一句**根本没有选**（unclear / 缺字段 / 报了个不存在
  //   的 key），引擎替他挑了仅剩的那一批——这正是本刀要废掉的那件事，只是把
  //   "替他从两批里挑"换成了"替他从一批里挑"。少数变成唯一，不等于他同意了。
  //   现在改成：照样问，只是问法换成「现在只剩这一批，是否就是它」。
  //   零执行这条不因候选数目而松动。
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
      // 只剩一批时换个问法——问的仍是"是不是它"，不是替他定了。
      soleCandidate: fresh.length === 1,
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
