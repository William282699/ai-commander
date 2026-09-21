// ============================================================
// AI Commander — 候选选择合同（刀己 / 审核 §二）
//
// 病：刀C 的消歧只做了"问一句"。`pendingSelectionRef` 只存了候选、从没被用来
// **选**；下一条可执行 intent 一到就把槽清空，然后**照模型这一轮填的字段执行**。
// 于是长官答「好的」、答非所问、或者模型又把 `fromFront` 写错，仍然调错兵——
// 实测：留守 3 ＋ 外派 10 的局面，模型仍填 fromFront ⇒ 只撤 3 个（该撤 10）。
// 探针 C3c 不是这条的依据：它是直接把 `fromDispatch: M1` 喂给引擎的。
//
// 本模块＝**独立的选择合同**，与「批准这个已确定的方案」是两种语义：
//   批准合同问的是"办不办"，这里问的是"办谁"。
// 形状逐条照抄 `pendingDecision` 那套已验证的机器（parse → judge → route），
// 因为它已经把"stale 执行零件事""缺字段＝协议失败"这些格子钉死过一遍。
//
// ★ 三条铁律
//   ① **不许有中文确认词表 / 同义词表**。语义分类归模型，本模块只做严格字面
//      解析＋身份校验（同 `parsePendingDecision` 的 NEVER EXPAND 规矩）。
//   ② 模型交回的 candidate key **必须是本次实际提供过的那几个之一**，
//      否则一律拒绝、零执行——prompt 只帮模型分类，闸在这儿。
//   ③ 「好的」不代表选定来源：模型判 `unclear` ⇒ 零执行、槽留着再问一次。
//      引擎不替长官挑，也不因为"问过了"就放行。
// ============================================================

/** 模型对「您说的是哪一批？」的答复。严格三值，缺失/非法 ⇒ undefined。 */
export type SelectionDecision =
  /** 明确选了某一批（key 必须是我们给过的）。 */
  | { kind: "chose"; candidateKey: string }
  /** 长官这句话没有指向任何一批（例：一句应答词）。 */
  | { kind: "unclear" }
  /** 这句话与刚才那一问无关，是一条新命令。 */
  | { kind: "unrelated" };

/**
 * STRICT 字面解析——只认下面三种形状，别的一律 undefined（＝协议失败）。
 * **NEVER EXPAND**：这里不做语义判断、不认同义词、不认中文确认词。
 *   { "decision": "chose", "candidate": "<key>" }
 *   { "decision": "unclear" }
 *   { "decision": "unrelated" }
 */
export function parseSelectionDecision(v: unknown): SelectionDecision | undefined {
  if (!v || typeof v !== "object") return undefined;
  const o = v as Record<string, unknown>;
  const d = o.decision;
  if (d === "unclear") return { kind: "unclear" };
  if (d === "unrelated") return { kind: "unrelated" };
  if (d === "chose") {
    const key = typeof o.candidate === "string" ? o.candidate.trim() : "";
    if (key.length === 0) return undefined; // 说"选了"却没说选哪个 ⇒ 协议失败
    return { kind: "chose", candidateKey: key };
  }
  return undefined;
}

/** 发请求那一刻捎上的标签；答复只有在标签仍然对得上时才可能消费那一槽。 */
export interface SelectionRequestTag {
  selectionId: string;
  channel: string;
  sessionId: string;
}

/** 给纯判官看的只读快照。**不含成员名单**——名单不是执行真相，执行前要现查。 */
export interface SelectionSlotView {
  id: string;
  channel: string;
  sessionId: string;
  /** 本局代号：重开一局即作废。 */
  epoch: number;
  expiresAt: number;
  /** 本次**实际提供过**的候选 key（闸就押在这一份名单上）。 */
  candidateKeys: readonly string[];
}

export type SelectionVerdict =
  /** 这次请求没带标签 ⇒ 本字段忽略，走正常流程。 */
  | "no_pending"
  /** 标签对不上活槽（id/频道/会话/局次不符或已过期）⇒ 不消费，走正常流程。 */
  | "stale"
  /** 槽对上了，但字段缺失/非法 ⇒ **零执行**，再问一次。 */
  | "protocol_failure"
  /** 长官这句话没指向任何一批 ⇒ **零执行**，槽留着再问一次。 */
  | "unclear"
  /** 明说是条新命令 ⇒ 撤掉旧槽，正常处理这条新命令。 */
  | "unrelated"
  /** 模型选了一个**我们没给过**的 key ⇒ 零执行，明确拒绝。 */
  | "bad_key"
  /** 明确选定了某一批 ⇒ 绑定，执行**原命令**（不是这一轮模型写的单子）。 */
  | "chose";

export interface SelectionJudgement {
  verdict: SelectionVerdict;
  /** verdict==="chose" 时那个 key，其余一律 null。 */
  candidateKey: string | null;
  /** 标签与活槽三方对齐且已过期 ⇒ 允许清掉**这一槽**（不许清更新的那一槽）。 */
  expiredExactMatch: boolean;
}

/**
 * 纯判官。规矩照抄 `judgePendingConsumption`：只有当请求**带了标签**、标签仍与
 * 活槽在 id + 频道 + 会话 + 局次上全部对齐、且未过期时，才谈得上消费。
 * 其余一律安全降级。
 */
export function judgeSelectionConsumption(args: {
  requestTag: SelectionRequestTag | null;
  current: SelectionSlotView | null;
  now: number;
  epoch: number;
  decision: SelectionDecision | undefined;
}): SelectionJudgement {
  const { requestTag, current, now, epoch, decision } = args;
  const none = { candidateKey: null, expiredExactMatch: false };
  if (!requestTag) return { verdict: "no_pending", ...none };

  const idMatch =
    current != null &&
    current.id === requestTag.selectionId &&
    current.channel === requestTag.channel &&
    current.sessionId === requestTag.sessionId &&
    current.epoch === epoch;

  if (!idMatch) return { verdict: "stale", ...none };
  if (now > current!.expiresAt) {
    // 过期：允许清掉**这一槽**（三方对齐过），但不消费、不执行。
    return { verdict: "stale", candidateKey: null, expiredExactMatch: true };
  }

  if (decision === undefined) return { verdict: "protocol_failure", ...none };
  if (decision.kind === "unclear") return { verdict: "unclear", ...none };
  if (decision.kind === "unrelated") return { verdict: "unrelated", ...none };

  // ★ 闸：只认本次实际提供过的 key。模型编一个、或者拿上一轮的旧 key 来，都不执行。
  if (!current!.candidateKeys.includes(decision.candidateKey)) {
    return { verdict: "bad_key", ...none };
  }
  return { verdict: "chose", candidateKey: decision.candidateKey, expiredExactMatch: false };
}

/**
 * 路由表（同 `pendingVerdictRoute` 的地位）：每种裁决**准许**做什么。
 * UI 层必须逐字服从——这是「零执行」那几格唯一可被台架量到的真相。
 */
export function selectionVerdictRoute(v: SelectionVerdict): {
  /** 执行**被绑定的原命令**（chose 专有）。 */
  executeBound: boolean;
  /** 正常处理这一轮的回复（options / NOOP / 教令）。 */
  processResponse: boolean;
  /** 保留待决槽（还没答清楚，下一句还要接着答）。 */
  keepSlot: boolean;
} {
  switch (v) {
    case "chose":            return { executeBound: true,  processResponse: false, keepSlot: false };
    case "unclear":          return { executeBound: false, processResponse: false, keepSlot: true };
    case "protocol_failure": return { executeBound: false, processResponse: false, keepSlot: true };
    case "bad_key":          return { executeBound: false, processResponse: false, keepSlot: true };
    case "unrelated":        return { executeBound: false, processResponse: true,  keepSlot: false };
    case "stale":            return { executeBound: false, processResponse: true,  keepSlot: false };
    case "no_pending":       return { executeBound: false, processResponse: true,  keepSlot: false };
  }
}
