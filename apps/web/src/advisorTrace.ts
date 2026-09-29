// ============================================================
// 刀寅：浏览器这一侧的对账行（与服务端同一个请求编号，写进同一份本地日志）
//
// 纯观测：发不出去就算了，绝不阻塞、绝不影响执行。服务端 /api/trace 负责截断与滚动。
// 只在开发构建里发（import.meta.env.DEV）。
// 只送与「谁、做什么、去哪、真下令给了谁、回执说了什么」有关的字段。
// ============================================================

import { API_URL } from "./api";
import { recordTrace } from "./recorder";

export function newTraceId(): string {
  try {
    return globalThis.crypto.randomUUID();
  } catch {
    return `t${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  }
}

/**
 * @param run      试玩记录仪认局用：调用点手里的**出发** GameState（有 execCtx 时是 execCtx.run.state）。
 * @param turnFrom 认回合的固定字段："current" ＝ traceId 读自 traceIdRef.current（当前轮），不是调用点手里的不可变编号。
 * 两个参数只给记录仪；本地开发那条对账日志的请求体不变。
 */
export function traceClient(traceId: string | null | undefined, stage: string, data: Record<string, unknown>, run?: unknown, turnFrom?: "current"): void {
  // 试玩记录仪：同一个取数点顺手交给逐局记录（没邀请/没同意时它第一行就返回）。
  recordTrace(traceId, stage, data, run, turnFrom);
  // 只在本地开发构建里送（生产包里这一行整段不发请求；服务端那头生产默认也不落盘）。
  if (!traceId || !import.meta.env.DEV) return;
  try {
    void fetch(`${API_URL}/api/trace`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ traceId, stage, data }),
    }).catch(() => {});
  } catch { /* 纯观测 */ }
}

export { intentFacts } from "./traceFacts";
