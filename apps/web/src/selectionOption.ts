import type { AdvisorOption, Intent } from "@ai-commander/shared";

/**
 * 消歧会跨过一个或多个网络回合；原 option 必须保持不可变。
 * Intent 目前只有这些嵌套可变值，逐项复制比 JSON 序列化更明确，也不会丢 undefined。
 */
export function cloneSelectionIntent(intent: Intent): Intent {
  return {
    ...intent,
    ...(intent._targetPos ? { _targetPos: { ...intent._targetPos } } : {}),
    ...(intent.routeIds ? { routeIds: [...intent.routeIds] } : {}),
    ...(intent.produceBudget ? { produceBudget: { ...intent.produceBudget } } : {}),
    ...(intent.tradeBudget ? { tradeBudget: { ...intent.tradeBudget } } : {}),
  };
}

/** 完整保留 label/description/risk/reward，并让工作副本与原响应彻底脱钩。 */
export function cloneSelectionOption(option: AdvisorOption): AdvisorOption {
  const sourceIntents = option.intents?.length > 0
    ? option.intents
    : option.intent
      ? [option.intent]
      : [];
  const intents = sourceIntents.map(cloneSelectionIntent);
  return {
    ...option,
    intent: intents[0] ?? cloneSelectionIntent(option.intent),
    intents,
  };
}

/**
 * 把 core 现查绑定后的 intents 放回不可变 option 的完整外壳。
 * 返回值仍是新对象，后续票据/目标预检可以安全原地改工作副本。
 */
export function optionWithResolvedIntents(
  snapshot: AdvisorOption,
  resolvedIntents: readonly Intent[],
): AdvisorOption {
  const option = cloneSelectionOption(snapshot);
  option.intents = resolvedIntents.map(cloneSelectionIntent);
  option.intent = option.intents[0] ?? option.intent;
  return option;
}

/**
 * 刀寅：「是哪一批」待答时随请求带给模型的那一节信封（唯一实现；ChatPanel 与诊断脚本共用）。
 *
 * 写的是**实际问的那种问法**：只剩一批时屏上问的是「是这一批吗？」，旧信封却一律写
 * 「你问了是哪一批」、规则又说"一句应答词不算选"——长官答「是的」必判没选、原样再问，
 * 绕圈。两种问法各自写明；判定仍归模型，闸仍在 candidate key 必须是这次给过的那几个。
 */
export function selectionEnvelope(sel: { id: string; kind?: "source" | "quantity"; candidates: readonly { selectionKey: string; label: string }[] }): string {
  // 第六轮：数量读法那一问单独一节（问的不是「是哪一批」，不借那一节的措辞与规则）。
  if (sel.kind === "quantity") {
    return `\n---QUANTITY_SELECTION---\n`
      + (sel.candidates.length === 1
        ? `你上一句问长官：这道令就照这样的人数派吗(id=${sel.id})。唯一的候选如下（行首那个 key 逐字抄进 dispatchSelection.candidate）：\n`
        : `你上一句问长官：这道令的人数是哪一种算法(id=${sel.id})。候选如下（行首那个 key 逐字抄进 dispatchSelection.candidate）：\n`)
      + sel.candidates.map((c) => `${c.selectionKey}  ${c.label}`).join("\n")
      + `\n指挥官下面这句话可能是对这一问的答复。`;
  }
  return `\n---DISPATCH_SELECTION---\n`
    + (sel.candidates.length === 1
      ? `你上一句问长官：现在只剩这一批，是不是它(id=${sel.id})。唯一的候选如下（行首那个 key 逐字抄进 dispatchSelection.candidate）：\n`
      : `你上一句问长官：这几批里是哪一批(id=${sel.id})。候选如下（行首那个 key 逐字抄进 dispatchSelection.candidate）：\n`)
    + sel.candidates.map((c) => `${c.selectionKey}  ${c.label}`).join("\n")
    + `\n指挥官下面这句话可能是对这一问的答复。`;
}
