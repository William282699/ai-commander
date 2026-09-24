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
