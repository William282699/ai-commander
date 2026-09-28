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

import type { ApplyResult, OrderRejectReason, IntentType, EconomyOutcome } from "@ai-commander/shared";

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
   * 「执行: 生产步兵 ×3」还差。
   *
   * ★刀庚 (审核 §三) 又修了一层：刀甲当时让经济条**无条件** `applied` 并复述
   *   resolver 的计划那一行。那同样不是执行事实——实测 $170 造 3 个步兵，队列
   *   真的只进 2 个、钱剩 $10，回执照说「生产步兵 ×3。」；预算生产/预算交易
   *   完全失败（钱一分没动）时还说「全力生产主战坦克。」。
   *   现在经济条读的是引擎回报的 `ApplyOrderOutcome.economy`（真实件数、真实
   *   花费、真实原因），计划那一行**不再进回执**。
   */
  economy?: boolean;
  /**
   * 刀寅（C）：这一条「真接到命令的有几个」那半句由调用方按**实际下令人数**现写
   * （临时编队票那一条要说出是哪一批、原报几个、差额里有证据的原因）。
   * 缺席 ⇒ 通用的「已下令 N 个单位…」。
   *
   * ★ 为什么走这里而不是另起一行：过去票据回执是回执之后**再补一行**、只上屏，
   *   同一批人报两次数、耳朵和 context 还听不到第二行。放进这一格，它就是这一条
   *   意图**唯一**的一句，屏/耳/context 同一份字符串；已在办/被拒两栏照旧追加。
   */
  appliedLine?: (appliedCount: number) => string;
  /**
   * 刀寅：「已经在办」那半句说的去处。按批次指代时＝那批人**正在执行的**任务的落点
   * （台账记的），不是这一轮重发的单子写的——两者在 5 格内才判"已在办"，可名字可能不同
   * （实测：人在去北线前哨，重发的单子写的是「1. 北部战线」）。缺席 ⇒ 用 destinationName。
   */
  alreadyDestinationName?: string;
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
  /** 刀庚：经济单的真实结算（判据从这里取数，不做字符串 diff）。 */
  economyFact?: EconomyAgg;
}

/** 刀庚：一条经济意图（可能拆成多条 order）的真实结算合计。 */
export interface EconomyAgg {
  kind: "produce" | "trade" | null;
  subjectLabel: string;
  requested: number;
  succeeded: number;
  failed: number;
  moneySpent: number;
  moneyGained: number;
  resourceGained: number;
  /** 同因合并后的原因（**只合并措辞，不合并计数**）。 */
  reasons: string[];
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

/**
 * 把解析阶段没能变成 order 的理由与执行层回执合成**同一份玩家反馈**。
 *
 * `buildExecReceipt` 只知道真正送进 `applyOrders` 的 slices；同一批命令里若还有
 * resolver-degraded 的 intent，那些失败也属于这次执行结果。屏幕、耳朵与下一轮
 * context 必须共同消费这里返回的 `lines` / `spokenText`，不能各自再拼一遍。
 *
 * 纯函数：不改传入的 receipt、lines 或 facts。规划失败不制造新的执行事实，
 * 所以 facts 只做数组拷贝；总结局则按“整批是否含失败”降级：有成功或已在办的
 * 同时又有 degraded ⇒ partial，原执行回执本就 none ⇒ 整批仍是 none。
 */
export function buildExecFeedback(
  receipt: ExecReceipt,
  degradedLines: readonly string[],
  /**
   * 刀寅：已下令的那部分之外、**同一条意图里没动的人**为什么没动（解析器带回的结构化原因，
   * 如「另有 1 个没有记下出发地，没有动。」）。排在回执之后，同样降级为 partial。
   */
  shortfallLines: readonly string[] = [],
): ExecReceipt {
  const lines = [...degradedLines, ...receipt.lines, ...shortfallLines];
  const hasDegraded = degradedLines.length > 0 || shortfallLines.length > 0;
  const outcome: ExecOutcome = hasDegraded
    ? (receipt.outcome === "none" ? "none" : "partial")
    : receipt.outcome;

  return {
    outcome,
    lines,
    spokenText: lines.join(" "),
    facts: [...receipt.facts],
  };
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
 * 刀庚：把一条经济意图的多条 order 合成一份真实结算。
 * 数量生产会被 resolver 展开成 N 条 order，所以"真成了几件"必须在这里相加——
 * 去重只作用在**原因措辞**上，绝不因此丢掉件数。
 */
function aggregateEconomy(rows: readonly EconomyOutcome[]): EconomyAgg {
  const agg: EconomyAgg = {
    kind: rows[0]?.kind ?? null,
    subjectLabel: rows[0]?.subjectLabel ?? "",
    requested: 0, succeeded: 0, failed: 0,
    moneySpent: 0, moneyGained: 0, resourceGained: 0,
    reasons: [],
  };
  for (const r of rows) {
    agg.requested += r.requested;
    agg.succeeded += r.succeeded;
    agg.failed += r.failed;
    agg.moneySpent += r.moneySpent;
    agg.moneyGained += r.moneyGained;
    agg.resourceGained += r.resourceGained;
    for (const why of r.failReasons) if (!agg.reasons.includes(why)) agg.reasons.push(why);
  }
  return agg;
}

/** 经济单那一行。★成了几件、花了多少、没成的那部分为什么——全从真实结算取数。 */
function economyLine(action: IntentType, agg: EconomyAgg, outcome: ExecOutcome): string {
  const why = agg.reasons.join("；");
  if (outcome === "none") {
    // ★完全失败：绝不许先说一句正面成功句。
    return why ? `没有执行——${why}` : `没有执行。`;
  }
  const cost = agg.moneySpent > 0 ? `，花了 $${agg.moneySpent}` : "";
  const got = agg.moneyGained > 0 ? `，到手 $${agg.moneyGained}` : "";
  const head = agg.kind === "trade"
    ? (agg.moneyGained > 0
        ? `卖出${agg.subjectLabel} ${Math.abs(agg.resourceGained)}`
        : `买进${agg.subjectLabel} ${agg.resourceGained}`)
    : `${verbOf(action)}${agg.subjectLabel} ×${agg.succeeded}`;
  if (outcome === "partial") {
    // ★部分成功：真实成功数 + 没成的那部分各说清楚。
    return `${head}${cost}${got}；还差 ${agg.failed} 件没办成${why ? `（${why}）` : ""}。`;
  }
  return `${head}${cost}${got}。`;
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
    // ── 经济单：没有人头，按人头判结局必然判成"没有执行"（刀甲）；
    //    但也不能一律记 applied 复述计划那一行（刀庚）——那同样不是执行事实。
    //    ★现在按引擎回报的**真实结算**说话（EconomyOutcome）。
    if (slice.economy) {
      const econRows = slice.orderIndexes
        .map((i) => result.perOrder[i]?.economy)
        .filter((e): e is NonNullable<typeof e> => e != null);
      const agg = aggregateEconomy(econRows);
      const outcome: ExecOutcome =
        agg.succeeded > 0 && agg.failed === 0 ? "applied"
        : agg.succeeded > 0 ? "partial"
        : "none";
      facts.push({
        action: slice.action,
        destinationName: slice.destinationName,
        appliedCount: 0,
        alreadyDoingCount: 0,
        rejectedCount: 0,
        outcome,
        economy: true,
        economyFact: agg,
      });
      lines.push(economyLine(slice.action, agg, outcome));
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

    // ★刀辛：`already_doing` **只在没有任何被拒时**才是纯第三类结局。
    //   `applied=0 / already=1 / rejected=1` 旧版判成 already_doing，屏上还是普通
    //   info，被拒那个一个字都不提——所以有被拒就降级成 partial（不是纯成功）。
    const outcome: ExecOutcome =
      appliedCount > 0 && rejectedCount === 0 ? "applied"
      : appliedCount > 0 ? "partial"
      : alreadyCount > 0 && rejectedCount === 0 ? "already_doing"
      : alreadyCount > 0 ? "partial"
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

    // ── ★刀辛 (审核 §四): 三栏**分别**追加事实片段，不许互斥四分支丢掉非零栏 ──
    //
    // 旧写法是互斥四分支：applied=1 / already=1 / rejected=1 同时非零时只报
    // applied + rejected，**already 那一栏整个消失**；而 applied=0 / already=1 /
    // rejected=1 被判成 already_doing，只说"已经在执行"，被拒那个**一个字都不提**，
    // 屏上还是普通 info。真实的 applyOrders 能产生这些组合，所以它们不是假设。
    const phrase = actionPhrase(slice.action, slice.destinationName);
    const alreadyPhrase = slice.alreadyDestinationName
      ? actionPhrase(slice.action, slice.alreadyDestinationName) : phrase;
    const parts: string[] = [];
    if (appliedCount > 0) {
      parts.push(slice.appliedLine
        ? slice.appliedLine(appliedCount).replace(/[。.]+$/, "")
        : `已下令 ${appliedCount} 个单位${phrase}`);
    }
    // alreadyDoing 是第三类结局：不算新派兵、不算失败，措辞里绝不许出现"已下令"。
    if (alreadyCount > 0) parts.push(`另有 ${alreadyCount} 个已经在${alreadyPhrase}了，没有重新下令`);
    if (rejectedCount > 0) parts.push(`${rejectPhrase(liveRejected)}，没接到命令`);
    if (parts.length === 0) {
      // 三栏全空：明说没有执行，**不许出现"已下令…前往 X"**。
      lines.push(`没有执行——没有部队接到这道命令。`);
    } else if (appliedCount === 0 && alreadyCount === 0) {
      // 只有被拒：整句从"没有执行"起头，不许读着像办成了。
      lines.push(`没有执行——${rejectPhrase(liveRejected)}，一个都没接到命令。`);
    } else if (appliedCount === 0) {
      // 没有新派兵：不许以"已下令"起头（already 不是新派兵）。
      lines.push(`没有重新下令——${parts.join("；")}。`);
    } else {
      lines.push(`${parts.join("；")}。`);
    }
  }

  // ── 第六轮（交接档 §5）：同一件事拆成了几条（同一个动作、同一个去处）⇒ 补一句**合计**。
  //   病：「派其中两个」被按兵种拆成两条，回执两句各说「2 个已经出发」，读着像派了 2 个，
  //   实际派了 4 个。合计按**真实单位 ID** 去重（同一个人先后接两条令只算一个），
  //   已下令 / 已在办 / 没接到命令分开数。逐条那几句照旧保留。
  {
    const groups = new Map<string, DispatchSlice[]>();
    for (const slice of slices) {
      if (slice.economy) continue;
      const key = `${slice.action}§${slice.destinationName}`;
      groups.set(key, [...(groups.get(key) ?? []), slice]);
    }
    for (const group of groups.values()) {
      if (group.length < 2) continue;
      const rows = group.flatMap((sl) => sl.orderIndexes.map((i) => result.perOrder[i]).filter((r): r is NonNullable<typeof r> => r !== undefined));
      const applied = new Set(rows.flatMap((r) => r.appliedUnitIds));
      const already = new Set(rows.flatMap((r) => r.alreadyDoingUnitIds).filter((id) => !applied.has(id)));
      const rejected = new Set(rows.flatMap((r) => r.rejected.map((x) => x.unitId)).filter((id) => !applied.has(id) && !already.has(id)));
      if (applied.size + already.size === 0) continue; // 全没办成：逐条已经说了「没有执行」
      const phrase = actionPhrase(group[0].action, group[0].destinationName);
      const parts = [
        applied.size > 0 ? `新下令 ${applied.size} 个单位${phrase}` : "",
        already.size > 0 ? `${already.size} 个已经在${phrase}` : "",
        rejected.size > 0 ? `${rejected.size} 个没接到命令` : "",
      ].filter(Boolean);
      lines.push(`合计：${parts.join("，")}。`);
    }
  }

  // 总结局按**每条的结局**汇总，不按人头（刀甲）。
  // ★刀庚/刀辛 又补一层：汇总必须看得见**经济单的失败**。此前 `anyRejected` 只数
  //   人头被拒，而经济单的三栏人头恒为 0 ⇒ 「$170 造 3 个只成 2 个」整批仍判
  //   applied，屏上是普通 info，看不出有一件没办成。现在"有没有失败"按每条的
  //   结局判：outcome ∈ {partial, none} 就是有失败。
  const anySucceeded = facts.some((f) => f.outcome === "applied" || f.outcome === "partial");
  const anyFailed = facts.some((f) => f.outcome === "partial" || f.outcome === "none");
  const anyAlready = facts.some((f) => f.outcome === "already_doing" || f.alreadyDoingCount > 0);
  const outcome: ExecOutcome =
    anySucceeded && !anyFailed ? "applied"
    : anySucceeded ? "partial"
    // ★复审 §四：`already_doing` **只在没有任何失败时**才是纯第三类结局。
    //   一句话里一条"已经在办"＋一条"没办成"，上一版汇总成 already_doing ⇒
    //   屏上是普通 info，没办成那条读起来像没发生过。有失败就 partial。
    : anyAlready && !anyFailed ? "already_doing"
    : anyAlready ? "partial"
    : "none";

  return { outcome, lines, spokenText: lines.join(" "), facts };
}
