// ============================================================
// 试玩记录仪 · 页面一加载就执行（main.tsx 第一个 import 它）
//
// 做两件事：把地址栏里的邀请存进本地并**立刻从地址栏抹掉**（进教学关 / 回主战役会整段改写
// location.search，不抹就会被带走或留在历史里）；按 ★24 的规则算出这次要不要问同意。
// 弹出面板（?mode=panel）什么都不做——它不是一局，也没有自己的记录器。
// ============================================================

import { extractInvite, readIdentity, resolveInvite, writeIdentity, type Identity, type StorageLike } from "./identity";

export type BootState =
  | { kind: "none" }
  /** 带着邀请，但浏览器不让存本地：本次不记录，游戏照玩。 */
  | { kind: "no_storage" }
  | { kind: "ask"; identity: Identity }
  | { kind: "granted"; identity: Identity }
  | { kind: "declined"; identity: Identity };

function computeBoot(): BootState {
  if (typeof window === "undefined") return { kind: "none" };
  let isPanel = false;
  try { isPanel = new URLSearchParams(window.location.search).get("mode") === "panel"; } catch { /* 当普通页 */ }
  if (isPanel) return { kind: "none" };
  const { token, cleanUrl } = extractInvite(window.location.search, window.location.pathname, window.location.hash);
  if (cleanUrl !== null) {
    try { window.history.replaceState(window.history.state, "", cleanUrl); } catch { /* 抹不掉也不影响记录 */ }
  }
  let storage: StorageLike | null = null;
  try {
    const ls = window.localStorage;
    const probe = "aic_rec_probe";
    ls.setItem(probe, "1");
    ls.removeItem(probe);
    storage = ls;
  } catch { storage = null; }
  if (!storage) return token ? { kind: "no_storage" } : { kind: "none" };
  const stored = readIdentity(storage);
  const r = resolveInvite(token, stored, Date.now());
  if (!r.identity) return { kind: "none" };
  if (r.identity !== stored && !writeIdentity(storage, r.identity)) return { kind: "no_storage" };
  if (r.ask) return { kind: "ask", identity: r.identity };
  return r.identity.consent === "granted" ? { kind: "granted", identity: r.identity } : { kind: "declined", identity: r.identity };
}

export const BOOT: BootState = computeBoot();

/** 玩家作答 / 撤回后改写本地同意状态。存不下就返回 false（调用方如实提示）。 */
export function saveConsent(identity: Identity, consent: Identity["consent"]): boolean {
  try { return writeIdentity(window.localStorage, { ...identity, consent, at: Date.now() }); } catch { return false; }
}
