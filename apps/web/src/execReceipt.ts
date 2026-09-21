// ============================================================
// AI Commander — 执行回执：屏上和耳朵，都按**实际下令结果**说
//   （retreat-scope 刀B。计划 §B）
//
// 为什么单独成模块（同 voiceSpeech.ts 的理由）：这是一条**诚实合同**，而它
// 原本散在 ChatPanel 的两三个闭包里，node 台架一格都够不到。搬成纯函数，
// 判据才落得下来。
//
// 病在哪（两层，缺一层就还是假确认）：
//   第一层 计划 ≠ 执行。`applyOrders` 对每条 order 的 unitIds 还要再过四道
//     过滤（单位不在了 / 不是我方 / 指挥官亲兵 / 已被手动接管）。计划选中 8 个、
//     实际只对 5 个下了令，而它过去返回 void ⇒ 外界照样报"8 个"。
//   第二层 真相源有两个。耳朵拿 data.brief（模型在引擎跑之前写的方案标题），
//     屏上拿 result.log（计划日志）。两边都早于执行。
//
// 本模块的合同：
//   ① 回执**只**从 ApplyResult 取数；计划里的数字一个都不进来。
//   ② 屏上那句和耳朵那句是**同一次调用的同一个字符串**——"四项一致"
//      （人数/对象/目的地/成败）因此是构造保证，不是事后比对。
//   ③ ★只宣称"命令下出去了"，绝不宣称"人已经到了"。到没到是战场自己的事。
//   ④ 三类结局分开说：办了 / 已经在办 / 没办成（带原因）。
//      「已经在办」既不算新派兵也不算失败——它是第三类。
//
// 这是**机器读数**（回执），不是人物台词：陈自己那段话仍旧由模型写。
// 「台词禁死模板」管的是人物说话，不管引擎报数——引擎报数本来就该是死的，
// 它一活就开始编。
// ============================================================

import type { ApplyResult, OrderRejectReason, IntentType } from "@ai-commander/shared";

/** 一条意图交给执行层的东西：它占了 orders 数组里的哪几格，以及去哪。 */
export interface DispatchSlice {
  action: IntentType;
  /** 引擎真送他们去的地方（ResolveResult.destinationName）。空串＝没有去处
   *  可宣称（就地设防 / 原地待命 / 经济单）。 */
  destinationName: string;
  /** 这条意图的 order 在 applyOrders 收到的数组里的下标。 */
  orderIndexes: number[];
  /**
   * ★刀甲：这是一张**经济单**（produce / trade）。
   *
   * 病：经济 order 的 `unitIds` 天生为空 ⇒ `ApplyOrderOutcome` 三栏全空 ⇒
   * 下面按"人"算结局的那段判成 `none`，于是生产明明成了（队列 0→3、钱真扣了），
   * 屏上和耳朵却都说「没有执行」，还是红字，还被 pushContext 喂给模型——
   * 下一轮参谋记得的是"生产失败了"。Emily 的生产每条都中。
   *
   * 修法不是"在上层跳过经济意图"——那样生产连一行正面回执都没有，比基线的
   * 「执行: 生产步兵 ×3」还差。经济单走自己的一行（planLog），结局记 applied，
   * 且**不参与按人头的统计**（它本来就没有人头）。
   * 真失败仍由引擎的 PRODUCE_FAIL / TRADE_FAIL 诊断上屏，那条路一个字不动。
   */
  economy?: boolean;
  /** 经济单的回执行：取该 resolver 的 log（「生产步兵 ×3」/「按预算生产步兵」/
   *  「下达交易命令: buy_fuel」）。只有 economy 为真时才读。 */
  planLog?: string;
}

export type ExecOutcome = "applied" | "partial" | "already_doing" | "none";

/** 结构化事实：判据从这里取数做比对，**不做字符串 diff**（口语表达自由）。 */
export interface ExecFact {
  action: IntentType;
  destinationName: string;
  appliedCount: number;
  alreadyDoingCount: number;
  rejectedCount: number;
  outcome: ExecOutcome;
  /** 刀甲：这一条是经济单 ⇒ 三个人头计数恒为 0，不许拿它们判结局。 */
  economy: boolean;
}

export interface ExecReceipt {
  /** 全批的总结局。 */
  outcome: ExecOutcome;
  /** 一条意图一句。屏上逐条打，耳朵把它们连起来念——同一份字符串。 */
  lines: string[];
  /** 耳朵念的那一段（lines 连起来）。 */
  spokenText: string;
  facts: ExecFact[];
}

// 动作的中文说法。封闭集合，与 tacticalPlanner 的 SUPPORTED_INTENTS 同源；
// 这是把枚举翻成人话，不是"穷举玩家可能怎么说"。
const ACTION_VERB: Record<string, string> = {
  attack: "进攻",
  defend: "设防",
  retreat: "撤退",
  recon: "侦察",
  hold: "原地待命",
  patrol: "巡逻",
  reinforce: "增援",
  capture: "占领",
  sabotage: "破坏",
  produce: "生产",
  trade: "交易",
};

// 没接到命令的原因。引擎的四道过滤，一一对应，说人话。
const REJECT_WORD: Record<OrderRejectReason, string> = {
  unit_gone: "已经不在了",
  not_player_unit: "不是我们的人",
  player_controlled: "在您自己手里",
  manual_override: "已被您手动接管",
};

function verbOf(action: IntentType): string {
  return ACTION_VERB[action] ?? String(action);
}

/** 「撤退至南线前哨」／「撤退」（没有去处可宣称时不硬凑地名）。 */
function actionPhrase(action: IntentType, destinationName: string): string {
  const verb = verbOf(action);
  if (!destinationName) return verb;
  if (action === "retreat") return `${verb}至${destinationName}`;
  if (action === "defend") return `前往${destinationName}${verb}`;
  return `${verb}${destinationName}`;
}

/** 把被拒的原因归并成一句（同因合并，不逐个念 id）。 */
function rejectPhrase(rejected: { unitId: number; reason: OrderRejectReason }[]): string {
  const byReason = new Map<OrderRejectReason, number>();
  for (const r of rejected) byReason.set(r.reason, (byReason.get(r.reason) ?? 0) + 1);
  return [...byReason.entries()]
    .map(([reason, n]) => `${n} 个${REJECT_WORD[reason]}`)
    .join("、");
}

/**
 * 从**执行层的回报**造一份回执。屏上和耳朵拿到的是同一份。
 *
 * ★ 措辞只说"下令"，不说"抵达"：`ApplyResult` 证明的是命令下出去了，
 *   不证明人到了。
 */
export function buildExecReceipt(result: ApplyResult, slices: DispatchSlice[]): ExecReceipt {
  const facts: ExecFact[] = [];
  const lines: string[] = [];

  for (const slice of slices) {
    // ── 刀甲：经济单没有人头，按人头判结局必然判成"没有执行" ──
    if (slice.economy) {
      facts.push({
        action: slice.action,
        destinationName: slice.destinationName,
        appliedCount: 0,
        alreadyDoingCount: 0,
        rejectedCount: 0,
        outcome: "applied",
        economy: true,
      });
      const line = (slice.planLog ?? "").trim();
      if (line) lines.push(line.endsWith("。") ? line : `${line}。`);
      continue;
    }

    const rows = slice.orderIndexes
      .map((i) => result.perOrder[i])
      .filter((r): r is NonNullable<typeof r> => r !== undefined);

    const applied = new Set<number>();
    const already = new Set<number>();
    const rejected: { unitId: number; reason: OrderRejectReason }[] = [];
    for (const row of rows) {
      for (const id of row.appliedUnitIds) applied.add(id);
      for (const id of row.alreadyDoingUnitIds) already.add(id);
      rejected.push(...row.rejected);
    }
    // 同一个单位若在多条 order 里出现，以"办了"为准（它确实接到了命令）。
    for (const id of applied) already.delete(id);
    const rejectedIds = new Set(rejected.map((r) => r.unitId));
    for (const id of applied) rejectedIds.delete(id);
    for (const id of already) rejectedIds.delete(id);
    const liveRejected = rejected.filter((r) => rejectedIds.has(r.unitId));

    const appliedCount = applied.size;
    const alreadyCount = already.size;
    const rejectedCount = rejectedIds.size;

    const outcome: ExecOutcome =
      appliedCount > 0 && rejectedCount === 0 ? "applied"
      : appliedCount > 0 ? "partial"
      : alreadyCount > 0 ? "already_doing"
      : "none";

    facts.push({
      action: slice.action,
      destinationName: slice.destinationName,
      appliedCount,
      alreadyDoingCount: alreadyCount,
      rejectedCount,
      outcome,
      economy: false,
    });

    const phrase = actionPhrase(slice.action, slice.destinationName);
    if (outcome === "applied") {
      lines.push(`已下令 ${appliedCount} 个单位${phrase}。`);
    } else if (outcome === "partial") {
      lines.push(`已下令 ${appliedCount} 个单位${phrase}；还有 ${rejectPhrase(liveRejected)}，没接到命令。`);
    } else if (outcome === "already_doing") {
      // 第三类结局：不算新派兵、不算失败。措辞里不许出现"已下令"。
      lines.push(`这 ${alreadyCount} 个单位已经在${phrase}了，没有重新下令。`);
    } else {
      // ★ 一个都没执行：明说没有执行 + 原因，**不许出现"已下令…前往 X"**。
      lines.push(
        rejectedCount > 0
          ? `没有执行——${rejectPhrase(liveRejected)}，一个都没接到命令。`
          : `没有执行——没有部队接到这道命令。`,
      );
    }
  }

  // 刀甲：总结局按**每条的结局**汇总，不再按人头。对纯作战单逐字等价
  //（作战条的 outcome ∈ {applied, partial} ⟺ appliedCount > 0），
  // 只是经济条这类"没有人头但确实办成了"的也算数了。
  const anyApplied = facts.some((f) => f.outcome === "applied" || f.outcome === "partial");
  const anyRejected = facts.some((f) => f.rejectedCount > 0);
  const anyAlready = facts.some((f) => f.alreadyDoingCount > 0);
  const outcome: ExecOutcome =
    anyApplied && !anyRejected ? "applied"
    : anyApplied ? "partial"
    : anyAlready ? "already_doing"
    : "none";

  return { outcome, lines, spokenText: lines.join(" "), facts };
}
