// ============================================================
// 试玩记录仪 · HTTP 入口
//
// 三个开关各管各的：
//   · 游戏开放（PLAYTEST_ENABLED，index.ts 既有）——不在这里；
//   · 记录采集（RECORDER_COLLECT=on）——关着时上传一律回专门应答 410 {recorder:"closed"}，
//     服务端事实也不记；
//   · 管理员读档（RECORDER_ADMIN_TOKEN）——没配就整组管理路由 404。
// 管理员凭证只走 Authorization 头；不进 URL、不进日志、不进前端包。
// ============================================================

import express, { type Request, type Response, type Router } from "express";
import crypto from "crypto";
import path from "path";
import { execFileSync } from "child_process";
import { REC_ID_RE, REC_STATUS_CLEAR, REC_HEADER_INVITE } from "@ai-commander/shared/src/recorderProtocol";
import { RecorderStore, type StoreLimits } from "./store.js";
import { exportRun, listRuns } from "./export.js";
import { setRecorderActive } from "./context.js";
import { ADMIN_PAGE_HTML, ADMIN_PAGE_JS } from "./adminPage.js";

export interface RecorderConfig {
  dataDir: string | null;
  collect: boolean;
  adminToken: string | null;
  limits: Partial<StoreLimits>;
  buildInfo: Record<string, unknown>;
}

export function recorderConfigFromEnv(env: NodeJS.ProcessEnv, serverDir: string, models: unknown): RecorderConfig {
  const production = env.NODE_ENV === "production";
  // 生产环境必须显式给数据目录（挂持久卷的地方）；开发默认落在 apps/server/recorder-data（已排除出 git/docker）。
  const dataDir = env.RECORDER_DATA_DIR || (production ? null : path.resolve(serverDir, "..", "recorder-data"));
  const admin = env.RECORDER_ADMIN_TOKEN && env.RECORDER_ADMIN_TOKEN.length >= 16 ? env.RECORDER_ADMIN_TOKEN : null;
  const limits: Partial<StoreLimits> = {};
  const num = (k: string) => (env[k] && Number.isFinite(Number(env[k])) ? Number(env[k]) : undefined);
  if (num("RECORDER_GLOBAL_MAX_MB") !== undefined) limits.globalMaxBytes = num("RECORDER_GLOBAL_MAX_MB")! * 1024 * 1024;
  if (num("RECORDER_RUN_MAX_MB") !== undefined) limits.runMaxBytes = num("RECORDER_RUN_MAX_MB")! * 1024 * 1024;
  if (num("RECORDER_RETENTION_DAYS") !== undefined) limits.retentionMs = num("RECORDER_RETENTION_DAYS")! * 24 * 3600 * 1000;
  let build = env.RECORDER_BUILD || "";
  if (!build) {
    try { build = execFileSync("git", ["rev-parse", "HEAD"], { cwd: serverDir, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim(); } catch { build = "unknown"; }
  }
  return {
    dataDir,
    collect: env.RECORDER_COLLECT === "on" && !!dataDir,
    adminToken: admin,
    limits,
    buildInfo: { build, node: process.version, models },
  };
}

const digest = (s: string) => crypto.createHash("sha256").update(s).digest();

export interface RecorderHandle {
  router: Router;
  store: () => RecorderStore | null;
  ready: Promise<void>;
  drain: () => Promise<{ ms: number; leftover: number } | null>;
  config: RecorderConfig;
}

export function createRecorder(cfg: RecorderConfig): RecorderHandle {
  let store: RecorderStore | null = null;
  let initError: string | null = null;
  const ready = (async () => {
    if (!cfg.dataDir) return;
    try {
      store = await RecorderStore.open(cfg.dataDir, cfg.limits, { buildInfo: cfg.buildInfo });
      setRecorderActive({ store, collect: cfg.collect });
      // 到期清理：启动一次，之后每小时一次（进行中的局不碰）。
      const t = setInterval(() => { void store?.sweepRetention().catch(() => {}); }, 3600 * 1000);
      t.unref();
    } catch (e) {
      initError = (e as NodeJS.ErrnoException)?.code ?? "EINIT";
      console.error(`[recorder] store init failed: ${initError}`);
    }
  })();

  const router = express.Router();
  const noStore = (res: Response) => { res.setHeader("Cache-Control", "no-store"); };

  // ── 玩家侧：上传与状态 ─────────────────────────────────────
  router.post("/api/rec/events", async (req: Request, res: Response) => {
    noStore(res);
    try {
      if (!cfg.collect) { res.status(REC_STATUS_CLEAR).json({ recorder: "closed" }); return; }
      if (!store) { res.status(503).json({ recorder: "write_failed" }); return; }
      const inv = store.testerForToken(req.get(REC_HEADER_INVITE));
      if (!inv) { res.status(403).json({ recorder: "invite_unknown" }); return; }
      if (inv.revokedAt) { res.status(REC_STATUS_CLEAR).json({ recorder: "invite_revoked" }); return; }
      const body = (req.body ?? {}) as Record<string, unknown>;
      if (body.v !== 1) { res.status(400).json({ recorder: "bad_batch", reason: "bad_version" }); return; }
      const out = await store.ingest(inv.tid, body.run, body.events);
      res.status(out.status).json(out.body);
    } catch {
      res.status(503).json({ recorder: "write_failed" });
    }
  });

  router.get("/api/rec/status", (req: Request, res: Response) => {
    noStore(res);
    if (!cfg.collect) { res.json({ recorder: "closed" }); return; }
    if (!store) { res.json({ recorder: "starting" }); return; }
    const inv = store.testerForToken(req.get(REC_HEADER_INVITE));
    if (!inv) { res.json({ recorder: "invite_unknown" }); return; }
    res.json({ recorder: inv.revokedAt ? "invite_revoked" : "ok" });
  });

  // ── 管理员 ─────────────────────────────────────────────────
  const adminOk = (req: Request): boolean => {
    if (!cfg.adminToken) return false;
    const h = req.get("Authorization") ?? "";
    const m = /^Bearer\s+(.+)$/.exec(h);
    if (!m) return false;
    return crypto.timingSafeEqual(digest(m[1].trim()), digest(cfg.adminToken));
  };
  const admin = (fn: (req: Request, res: Response, s: RecorderStore) => Promise<void> | void) => async (req: Request, res: Response) => {
    noStore(res);
    if (!cfg.adminToken) { res.status(404).json({ error: "not found" }); return; }
    if (!adminOk(req)) { res.status(401).json({ error: "unauthorized" }); return; }
    if (!store) { res.status(503).json({ error: initError ? `store unavailable (${initError})` : "store not configured" }); return; }
    try { await fn(req, res, store); } catch { res.status(500).json({ error: "internal" }); }
  };

  router.get("/api/rec/admin/runs", admin((_req, res, s) => {
    res.json({ runs: listRuns(s), usage: s.usage(), collect: cfg.collect });
  }));
  router.get("/api/rec/admin/runs/:runId/report", admin(async (req, res, s) => {
    const id = String(req.params.runId);
    if (!REC_ID_RE.test(id)) { res.status(400).json({ error: "bad run id" }); return; }
    const out = await exportRun(s, id);
    if (!out) { res.status(404).json({ error: "no such run" }); return; }
    res.type("text/plain; charset=utf-8").send(out.reportHtml);
  }));
  router.get("/api/rec/admin/runs/:runId/zip", admin(async (req, res, s) => {
    const id = String(req.params.runId);
    if (!REC_ID_RE.test(id)) { res.status(400).json({ error: "bad run id" }); return; }
    const out = await exportRun(s, id);
    if (!out) { res.status(404).json({ error: "no such run" }); return; }
    res.setHeader("Content-Type", "application/zip");
    res.setHeader("Content-Disposition", `attachment; filename="${out.filename}"`);
    res.send(out.zip);
  }));
  router.get("/api/rec/admin/invites", admin((_req, res, s) => {
    res.json({ invites: s.listInvites().map(({ hash: _h, ...r }) => r) });
  }));
  router.post("/api/rec/admin/invites", admin(async (_req, res, s) => {
    const { tid, token } = await s.createInvite();
    // 凭证只在这一次应答里出现；服务端只存它的哈希。
    res.json({ tid, token });
  }));
  router.post("/api/rec/admin/invites/:tid/revoke", admin(async (req, res, s) => {
    const tid = String(req.params.tid);
    if (!/^[A-Z]{1,8}X*$/.test(tid)) { res.status(400).json({ error: "bad tester id" }); return; }
    res.json({ revoked: await s.revokeInvite(tid) });
  }));

  // 管理员页面本身不含任何数据；数据要凭 Authorization 头去取。
  const pageCsp = "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; frame-src 'self' blob:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
  router.get("/rec-admin", (_req, res) => {
    noStore(res);
    if (!cfg.adminToken) { res.status(404).send("not found"); return; }
    res.setHeader("Content-Security-Policy", pageCsp);
    res.type("html").send(ADMIN_PAGE_HTML);
  });
  router.get("/rec-admin/app.js", (_req, res) => {
    noStore(res);
    if (!cfg.adminToken) { res.status(404).send("not found"); return; }
    res.type("application/javascript").send(ADMIN_PAGE_JS);
  });

  const drain = async () => {
    const s = store;
    if (!s) return null;
    return s.drain();
  };
  return { router, store: () => store, ready, drain, config: cfg };
}

/** 游戏关闭闸的例外：只有记录仪自己的路由（上传回专门应答、管理员读档）。 */
export function isRecorderPath(p: string): boolean {
  return p.startsWith("/api/rec/") || p === "/rec-admin" || p === "/rec-admin/app.js";
}
