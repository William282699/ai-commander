// ============================================================
// 邀请凭证与同意状态（纯规则，node 台架直接调）
//
// 浏览器打开邀请链接时（地址栏带着邀请，§4.1 ★24）：
//   · 本地没有邀请：存下它，问一次同意。
//   · 与本地是同一个邀请：不重问；但本地记录是“已拒绝/已撤回”时再问一次（撤回后唯一的恢复路径）。
//   · 与本地是不同的邀请：以地址栏为准，替换本地凭证，按新测试者问一次同意。
//     旧凭证名下还没上传的事件仍用旧凭证补传（待传队列按局保存各自的凭证），不改记。
// 地址栏里的邀请落地即抹掉，所以普通刷新不会反复问。
// ============================================================

export type Consent = "unanswered" | "granted" | "declined" | "withdrawn";

export interface Identity {
  token: string;
  consent: Consent;
  /** 最后一次变更同意状态的时间（毫秒）。 */
  at: number;
}

export const IDENTITY_KEY = "aic_rec_identity_v1";
export const INVITE_RE = /^[A-Za-z0-9_-]{16,128}$/;

export interface StorageLike {
  getItem(k: string): string | null;
  setItem(k: string, v: string): void;
  removeItem(k: string): void;
}

export function readIdentity(storage: StorageLike): Identity | null {
  try {
    const raw = storage.getItem(IDENTITY_KEY);
    if (!raw) return null;
    const o = JSON.parse(raw) as Record<string, unknown>;
    if (typeof o.token !== "string" || !INVITE_RE.test(o.token)) return null;
    const c = o.consent;
    const consent: Consent = c === "granted" || c === "declined" || c === "withdrawn" ? c : "unanswered";
    return { token: o.token, consent, at: typeof o.at === "number" ? o.at : 0 };
  } catch { return null; }
}

export function writeIdentity(storage: StorageLike, id: Identity): boolean {
  try {
    storage.setItem(IDENTITY_KEY, JSON.stringify(id));
    return readIdentity(storage)?.token === id.token;
  } catch { return false; }
}

export interface InviteResolution {
  identity: Identity | null;
  /** 这次是否要在游戏载入前问同意。 */
  ask: boolean;
  /** 换了测试者：被替换掉的旧凭证（它名下的积压仍用它补传）。 */
  replacedToken: string | null;
}

export function resolveInvite(urlToken: string | null, stored: Identity | null, now: number): InviteResolution {
  const valid = urlToken && INVITE_RE.test(urlToken) ? urlToken : null;
  if (!valid) return { identity: stored, ask: stored?.consent === "unanswered", replacedToken: null };
  if (!stored) return { identity: { token: valid, consent: "unanswered", at: now }, ask: true, replacedToken: null };
  if (stored.token === valid) {
    if (stored.consent === "declined" || stored.consent === "withdrawn") {
      return { identity: { token: valid, consent: "unanswered", at: now }, ask: true, replacedToken: null };
    }
    return { identity: stored, ask: stored.consent === "unanswered", replacedToken: null };
  }
  return { identity: { token: valid, consent: "unanswered", at: now }, ask: true, replacedToken: stored.token };
}

/** 从地址串里取出邀请，并给出抹掉它之后的地址（其余参数与 # 原样保留）。 */
export function extractInvite(search: string, pathname: string, hash: string): { token: string | null; cleanUrl: string | null } {
  try {
    const p = new URLSearchParams(search);
    if (!p.has("invite")) return { token: null, cleanUrl: null };
    const token = p.get("invite");
    p.delete("invite");
    const qs = p.toString();
    return { token, cleanUrl: `${pathname}${qs ? `?${qs}` : ""}${hash}` };
  } catch { return { token: null, cleanUrl: null }; }
}
