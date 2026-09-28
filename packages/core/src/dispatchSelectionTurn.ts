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
  validateSelectionDecision,
  type SelectionRequestTag,
  type SelectionVerdict,
} from "@ai-commander/shared";
import {
  enumerateDispatchCandidates,
  findDispatchAmbiguity,
  bindDispatchSelection,
  type DispatchCandidate,
} from "./dispatchLedger";
import { checkDispatchAuthority } from "./commandAuthority";

/**
 * 一次复合命令里已经明确选过的来源。这里只存稳定 key，绝不存旧 roster；
 * 每次继续消歧、以及最终执行前，名单都从当前 GameState 重新绑定。
 */
export interface DispatchSelectionKey {
  intentIndex: number;
  selectionKey: string;
}

export interface DispatchSelectionRequirement {
  intentIndex: number;
  /** 首次发现歧义时提供的候选范围，等待期间不擅自加入新候选。 */
  offeredKeys: string[];
}

export type DispatchSelectionBatchPlan =
  | { kind: "ask"; intentIndex: number; candidates: DispatchCandidate[]; soleCandidate: boolean;
      requirements: DispatchSelectionRequirement[] }
  | { kind: "ready"; intents: Intent[]; bindings: ResolvedDispatchSelection[];
      requirements: DispatchSelectionRequirement[] }
  | { kind: "refuse"; line: string };

/**
 * 整组消歧预检：在票据或目标字段改写之前运行，纯读状态。
 * 首次扫描整组，记住每个需回答的下标；候选后来缩成一个也仍须回答。
 * 只有全部回答后才 ready；每次调用对所有已选 key 重新取人、验权。
 */
export function planDispatchSelectionBatch(args: {
  state: GameState;
  allIntents: readonly Intent[];
  selectionKeys?: readonly DispatchSelectionKey[];
  requirements?: readonly DispatchSelectionRequirement[];
  selectedUnitIds?: number[];
  persona: CommanderKey;
  personaLabel: string;
}): DispatchSelectionBatchPlan {
  const { state, allIntents, persona, personaLabel } = args;
  const requirements = (args.requirements ?? []).map((r) => ({ ...r, offeredKeys: [...r.offeredKeys] }));
  const validIndex = (i: number) => Number.isInteger(i) && i >= 0 && i < allIntents.length;
  if (requirements.some((r) => !validIndex(r.intentIndex)) ||
      new Set(requirements.map((r) => r.intentIndex)).size !== requirements.length) {
    return { kind: "refuse", line: "这道命令的来源记录已经失效，整道命令没有执行，请重新下令。" };
  }
  for (let i = 0; i < allIntents.length; i++) {
    if (requirements.some((r) => r.intentIndex === i)) continue;
    const amb = findDispatchAmbiguity(state, allIntents[i], args.selectedUnitIds);
    if (amb) requirements.push({ intentIndex: i, offeredKeys: amb.map((c) => c.selectionKey) });
  }
  requirements.sort((a, b) => a.intentIndex - b.intentIndex);
  const choices = args.selectionKeys ?? [];
  if (new Set(choices.map((s) => s.intentIndex)).size !== choices.length || choices.some((s) =>
    !validIndex(s.intentIndex) || !requirements.some((r) =>
      r.intentIndex === s.intentIndex && r.offeredKeys.includes(s.selectionKey)))) {
    return { kind: "refuse", line: "选定的来源不属于这道命令原先的候选，整道命令没有执行。" };
  }
  const intents = [...allIntents];
  const bindings: ResolvedDispatchSelection[] = [];
  for (const selected of choices) {
    const bound = bindDispatchSelection(state, allIntents[selected.intentIndex], selected.selectionKey);
    if (!bound.ok) return { kind: "refuse", line: "您先前选定的那一批已经不在了，整道命令没有执行，请重新指明来源。" };
    const lawful = lawfulSubset(state, persona, bound.intent, bound.unitIds);
    if (lawful.length === 0) return { kind: "refuse", line: `${personaLabel}现在调不动您先前选定的那一批人，整道命令没有执行。` };
    intents[selected.intentIndex] = bound.intent;
    bindings.push({ ...selected, intent: bound.intent, unitIds: lawful, label: bound.label });
  }
  for (const requirement of requirements) {
    if (choices.some((s) => s.intentIndex === requirement.intentIndex)) continue;
    const candidates = enumerateDispatchCandidates(state, allIntents[requirement.intentIndex], args.selectedUnitIds)
      .filter((c) => requirement.offeredKeys.includes(c.selectionKey));
    if (candidates.length === 0) return { kind: "refuse", line: "刚才待选的那几批现在都不在了，整道命令没有执行。" };
    return { kind: "ask", intentIndex: requirement.intentIndex, candidates,
      soleCandidate: candidates.length === 1, requirements };
  }
  return { kind: "ready", intents, bindings, requirements };
}

/** 当前状态下重新绑定后的执行事实。 */
export interface ResolvedDispatchSelection extends DispatchSelectionKey {
  intent: Intent;
  unitIds: number[];
  label: string;
}

/** 待决槽里与判定相关的那几样（名单**不在**其中——名单必须现查）。 */
export interface SelectionSlotState {
  /**
   * 第六轮：这一槽问的是什么。缺席＝「是哪一批」（来源）。
   * "quantity"＝「一共几个，还是按兵种各算」：候选是两种**读法**，不绑人；
   * 选中后由调用方按读法改写整份方案，再整组重走主链（名单照旧现查）。
   */
  kind?: "source" | "quantity";
  id: string;
  channel: string;
  sessionId: string;
  epoch: number;
  expiresAt: number;
  /** 提问时印出去的候选（闸押在这一份 selectionKey 名单上）。 */
  candidates: Pick<DispatchCandidate, "selectionKey" | "label">[];
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
  /** 此前已经明确选过的来源；只存 key，继续回答时全部现查重绑。 */
  selectionKeys: DispatchSelectionKey[];
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
      /** 本轮以前加本轮，按 intent 下标去重后的全部稳定选择。 */
      selectionKeys: DispatchSelectionKey[];
      /** 上述 key 在当前 GameState 下重新绑定出的全部名单。 */
      bindings: ResolvedDispatchSelection[];
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
  /** 第六轮：长官明确选了一种数量读法（key 已核过是这次给过的）。调用方改写方案后整组重走主链。 */
  | { kind: "quantity_chosen"; key: string }
  /** 第六轮：数量那一问没答清（没指明 / 缺字段 / 编造 key）⇒ 零执行，原样再问。 */
  | { kind: "reask_quantity"; lead: string }
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
  /**
   * 浏览器收到的 `dispatchSelection`——**已经是内部格式** `{kind, candidateKey}`
   * （服务端 `validateAdvisorResponse` 转换过一次）。这里只做内部形状的严格校验，
   * **绝不**再拿原始 parser 解析第二遍（那正是"连答两次仍重问第一问"的病根）。
   */
  decision: unknown;
  /** 参谋的显示名，只用于拼那句拒绝话。 */
  personaLabel: string;
}): SelectionTurnDecision {
  const { state, slot, requestTag, epoch, now, persona, decision, personaLabel } = args;

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
    decision: validateSelectionDecision(decision),
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

  // ── 第六轮：数量读法那一问。候选是读法、不是人：不绑定、不现查名单（执行前主链照旧现查）。
  //   规矩与来源那一问完全相同：只认这次给过的 key；没指明 / 缺字段 / 编造 key ⇒ 零执行再问。
  if (slot.kind === "quantity") {
    if (route.executeBound && judge.candidateKey) {
      return { ...base, keepSlot: false, plan: { kind: "quantity_chosen", key: judge.candidateKey } };
    }
    return {
      ...base,
      keepSlot: true,
      plan: {
        kind: "reask_quantity",
        lead: judge.verdict === "bad_key"
          ? "我没听准您要的是哪一种算法，再确认一次：这道命令还没有执行。"
          : "这道命令还没有执行。",
      },
    };
  }

  if (route.executeBound && judge.candidateKey) {
    // 复合命令可能连续问两次以上。槽里累计的是 intentIndex → stable key；
    // roster 绝不累计，因为等第二个回答的几秒里，人会死、任务会关、权限会变。
    // 每次回答都把**全部** key 在当前 GameState 下重新绑定并重新验权。
    const all = Array.isArray(slot.allIntents) && slot.allIntents.length > 0
      ? slot.allIntents : [slot.intentSnapshot];
    const at = Number.isInteger(slot.intentIndex) && slot.intentIndex >= 0 && slot.intentIndex < all.length
      ? slot.intentIndex : 0;
    const keyed = new Map<number, string>();
    for (const prior of slot.selectionKeys ?? []) {
      if (!Number.isInteger(prior.intentIndex) || prior.intentIndex < 0 || prior.intentIndex >= all.length) {
        return {
          ...base,
          keepSlot: false,
          plan: { kind: "refuse", line: "刚才那道复合命令的来源记录已经损坏，没有执行——请重新说一遍。" },
        };
      }
      keyed.set(prior.intentIndex, prior.selectionKey);
    }
    keyed.set(at, judge.candidateKey);

    const selectionKeys = [...keyed.entries()]
      .sort(([a], [b]) => a - b)
      .map(([intentIndex, selectionKey]) => ({ intentIndex, selectionKey }));
    const merged = [...all];
    const bindings: ResolvedDispatchSelection[] = [];

    for (const selected of selectionKeys) {
      const bound = bindDispatchSelection(state, all[selected.intentIndex], selected.selectionKey);
      if (!bound.ok) {
        return {
          ...base,
          keepSlot: false,
          plan: {
            kind: "refuse",
            line: bound.reason === "gone"
              ? "您先前选定的那一批已经不在了（人没了，或者那次任务已经结束），整道命令没有执行。"
              : "那道复合命令里有一条来源已经无法还原，整道命令没有执行——请重新说一遍。",
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
            line: `${personaLabel}现在调不动您先前选定的那一批人，整道命令没有执行——请对带这支部队的指挥官下令。`,
          },
        };
      }
      merged[selected.intentIndex] = bound.intent;
      bindings.push({
        intentIndex: selected.intentIndex,
        selectionKey: selected.selectionKey,
        intent: bound.intent,
        unitIds: lawful,
        label: bound.label,
      });
    }

    const current = bindings.find((b) => b.intentIndex === at)!;
    return {
      ...base,
      keepSlot: false,
      plan: {
        kind: "execute",
        intent: current.intent,
        intents: merged,
        selectionKeys,
        bindings,
        unitIds: current.unitIds,
        selectionKey: current.selectionKey,
        label: current.label,
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
