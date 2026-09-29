// ============================================================
// 试玩记录仪 · 服务端事实的“这一请求属于哪一局”上下文
//
// 命令路由的处理函数一字不改：本模块在它们前面挂一个中间件，按 HTTP 头
// （X-Rec-Invite / X-Rec-Run）认出测试者与局，放进 AsyncLocalStorage；
// 既有的 traceWrite(…) 取数点（request / model_raw / result / parse_failed / model_error）
// 在同一个异步链里看得见它，顺手把事实交给记录仪。
//
// 纪律：
//   · 头不对、局不属于这个测试者、采集关着 ⇒ 只是不记录，命令照常处理（绝不拒命令）；
//   · 同步返回、全程 try/catch；游戏请求体与发给模型的内容一个字节不动。
// ============================================================

import { AsyncLocalStorage } from "async_hooks";
import crypto from "crypto";
import type { Request, Response, NextFunction } from "express";
import { REC_ID_RE, REC_HEADER_INVITE, REC_HEADER_RUN } from "@ai-commander/shared/src/recorderProtocol";
import type { RecorderStore } from "./store.js";

interface Ctx { store: RecorderStore; runId: string; tid: string; attempt: string; route: string; t0: number }

const als = new AsyncLocalStorage<Ctx>();

/** 由 routes.ts 在启动完成后设置；没有＝记录仪不在（开发未配置、或采集关闭）。 */
let active: { store: RecorderStore; collect: boolean } | null = null;
export function setRecorderActive(a: { store: RecorderStore; collect: boolean } | null): void { active = a; }

const COMMAND_ROUTES = new Set(["/api/command", "/api/command-stream"]);
const STAGE_TYPE: Record<string, string> = {
  request: "srv_request",
  model_raw: "srv_model_raw",
  result: "srv_result",
  parse_failed: "srv_parse_failed",
  model_error: "srv_model_error",
};

export function commandContext(req: Request, res: Response, next: NextFunction): void {
  let ctx: Ctx | null = null;
  try {
    const a = active;
    if (a && a.collect && !a.store.isClosing && COMMAND_ROUTES.has(req.path)) {
      const inv = a.store.testerForToken(req.get(REC_HEADER_INVITE));
      const runId = req.get(REC_HEADER_RUN);
      if (inv && !inv.revokedAt && typeof runId === "string" && REC_ID_RE.test(runId)) {
        const owner = a.store.ownerOf(runId);
        if (!owner || owner === inv.tid) {
          ctx = { store: a.store, runId, tid: inv.tid, attempt: crypto.randomBytes(6).toString("base64url"), route: req.path, t0: Date.now() };
          const c = ctx;
          const tr = (req.body as Record<string, unknown> | undefined)?.traceId;
          const turn = typeof tr === "string" && /^[A-Za-z0-9-]{4,64}$/.test(tr) ? tr : undefined;
          res.on("close", () => {
            try {
              c.store.appendServerFact(c.runId, c.tid, "srv_attempt_end", turn, {
                attempt: c.attempt, route: c.route, status: res.statusCode, aborted: !res.writableFinished, ms: Date.now() - c.t0,
              });
            } catch { /* 纯观测 */ }
          });
        }
      }
    }
  } catch { ctx = null; }
  if (ctx) als.run(ctx, () => next());
  else next();
}

/** traceWrite 的旁观挂点：有上下文才记，没有就当不存在。 */
export function recordServerTrace(traceId: unknown, stage: string, data: Record<string, unknown>): void {
  try {
    const c = als.getStore();
    if (!c) return;
    const type = STAGE_TYPE[stage];
    if (!type) return;
    const turn = typeof traceId === "string" && /^[A-Za-z0-9-]{4,64}$/.test(traceId) ? traceId : undefined;
    // 浏览器编号（sessionId）不进档案：它不是这一局的事实，也用不上。
    const { sessionId: _s, ...rest } = data ?? {};
    c.store.appendServerFact(c.runId, c.tid, type, turn, { attempt: c.attempt, ...rest });
  } catch { /* 纯观测 */ }
}
