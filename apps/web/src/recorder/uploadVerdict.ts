// ============================================================
// 上传应答三分类（写死，§5.3 ★26）——纯函数，node 台架直接调它。
//
//   ① 专门应答：状态码 410 ＋ JSON 里 recorder === "closed" | "invite_revoked"
//      ⇒ 清空这个凭证名下的待传队列（采集已关闭／邀请已作废）。**只认这一种**。
//   ② 针对这一批的拒收：400/413 且 JSON 里 recorder === "rejected" 并逐条点名
//      ⇒ 只删被点名的那几条（记“丢弃 N 条”）。没点名的 400/413：多条就拆小再发，单条就退避重试——**不删**。
//   ③ 其余一切（网络错误、超时、429、5xx、代理的 HTML 页面、看不懂的应答、甚至 200 却不是我们的格式）
//      ⇒ 原样保留、退避重试、显示故障。
// ============================================================

import { REC_STATUS_CLEAR } from "@ai-commander/shared/src/recorderProtocol";

export type UploadVerdict =
  | { kind: "acked"; acked: string[]; rejected: { eid: string; reason: string }[] }
  | { kind: "clear"; reason: "closed" | "invite_revoked" }
  | { kind: "reject_named"; rejected: { eid: string; reason: string }[] }
  | { kind: "split" }
  | { kind: "retry"; fault: string };

function parseJson(text: string): Record<string, unknown> | null {
  try {
    const v = JSON.parse(text);
    return v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : null;
  } catch { return null; }
}

function namedList(v: unknown, batch: ReadonlySet<string>): { eid: string; reason: string }[] | null {
  if (!Array.isArray(v)) return null;
  const out: { eid: string; reason: string }[] = [];
  for (const x of v) {
    if (!x || typeof x !== "object") return null;
    const eid = (x as Record<string, unknown>).eid;
    const reason = (x as Record<string, unknown>).reason;
    // 只认本批里真有的编号：点到批外的名字不算点名（防把别的事件误删）。
    if (typeof eid !== "string" || !batch.has(eid)) continue;
    out.push({ eid, reason: typeof reason === "string" ? reason.slice(0, 60) : "rejected" });
  }
  return out;
}

/**
 * @param status HTTP 状态码；网络层失败传 0。
 * @param bodyText 应答原文（读不到传 ""）。
 * @param batchEids 这一批的事件编号。
 */
export function classifyUploadResponse(status: number, bodyText: string, batchEids: readonly string[]): UploadVerdict {
  const batch = new Set(batchEids);
  if (status === 0) return { kind: "retry", fault: "network" };
  const j = parseJson(bodyText);
  const rec = j && typeof j.recorder === "string" ? j.recorder : null;
  if (status === 200 && rec === "ok" && Array.isArray(j!.acked)) {
    const acked = (j!.acked as unknown[]).filter((x): x is string => typeof x === "string" && batch.has(x));
    const rejected = namedList(j!.rejected, batch) ?? [];
    return { kind: "acked", acked, rejected };
  }
  if (status === REC_STATUS_CLEAR && (rec === "closed" || rec === "invite_revoked")) {
    return { kind: "clear", reason: rec };
  }
  if ((status === 400 || status === 413) && rec === "rejected") {
    const named = namedList(j!.rejected, batch);
    if (named && named.length > 0) return { kind: "reject_named", rejected: named };
  }
  if ((status === 400 || status === 413) && batch.size > 1) return { kind: "split" };
  if (status === 429) return { kind: "retry", fault: "http_429" };
  if (status >= 500) return { kind: "retry", fault: `http_${status}${rec ? `_${rec}` : ""}` };
  return { kind: "retry", fault: `http_${status}${rec ? `_${rec}` : j ? "" : "_non_json"}` };
}
