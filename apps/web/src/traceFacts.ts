// 刀寅：对账行里意图的取字段（纯函数，Node 台架可直接引用；不碰 Vite 的 import.meta.env）。

/** 意图里与「谁、做什么、去哪」有关的字段。 */
export function intentFacts(i: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of ["type", "fromFront", "fromSquad", "fromDispatch", "toFront", "targetFacility",
    "targetRegion", "returnTo", "destinationQuote", "quantityQuote", "quantity", "unitType"]) {
    if (i[k] !== undefined) out[k] = i[k];
  }
  return out;
}
