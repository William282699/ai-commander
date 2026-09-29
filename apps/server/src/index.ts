// ============================================================
// AI Commander — Express Server
// ============================================================

import { config as dotenvConfig } from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

// Load .env explicitly relative to this source file. Avoids cwd ambiguity
// when running under npm workspaces / git worktrees.
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ENV_PATH = path.resolve(__dirname, "..", ".env");
const envResult = dotenvConfig({ path: ENV_PATH });

import express from "express";
import cors from "cors";
import { callAdvisor, callAdvisorStream, callGroupAdvisor, callLightBrief, isProviderConfigured, describeProviderConfig } from "./ai.js";
import { voiceEnabledChannels } from "./providers.js";
import { rejectCommandBody, audioOf } from "./voiceInput.js";
import { echoesHeard } from "@ai-commander/shared";
import { ttsRouter } from "./routes/tts.js";
import { traceWrite, envelopeOf, intentsOf } from "./traceLog.js";
// 试玩记录仪 V1：逐局记录（上传/管理员/服务端事实的请求上下文）
import { createRecorder, recorderConfigFromEnv, isRecorderPath } from "./recorder/routes.js";
import { commandContext } from "./recorder/context.js";

const app = express();
const PORT = parseInt(process.env.PORT || "3001", 10);

// PLAYTEST_ENABLED gate.
// Resolved once at startup; restart the server to flip. Only active in
// production — dev (NODE_ENV !== "production") always passes through so
// `npm run dev:server` is never affected.
// TODO(playtest): optional PLAYTEST_CODE / ?code=xxx + cookie gate.
const PLAYTEST_DISABLED =
  process.env.NODE_ENV === "production" &&
  process.env.PLAYTEST_ENABLED === "false";

app.use(cors());

// 语音输入 V1：只有两条命令路由允许大 body（b64 WAV，30s@16kHz ≈ 1.28MB）。
// ★ 不能靠"给这两条路由单独挂个大 limit"——全局解析器先跑，1.28MB 会在到达
// 路由之前就被 100kb 打回。所以在同一个位置按路径二选一：命令路由 4mb，
// 其余（/api/log-event、/api/brief、/api/tts…）一个字节没放宽。
const jsonSmall = express.json({ limit: "100kb" });
const jsonLarge = express.json({ limit: "4mb" });
const AUDIO_ROUTES = new Set(["/api/command", "/api/command-stream"]);
app.use((req, res, next) => (AUDIO_ROUTES.has(req.path) ? jsonLarge : jsonSmall)(req, res, next));

// Gate runs after JSON parser (so 503 JSON body is well-formed) but before
// every route, including /api/tts.
app.use((req, res, next) => {
  // 试玩记录仪：采集与管理员读档是另外两个开关——关了游戏，管理员仍须能看档案，
  // 上传也要能收到“采集已关闭”的专门应答（而不是一张 503 页面）。只放行记录仪自己的路由。
  if (!PLAYTEST_DISABLED || isRecorderPath(req.path)) return next();
  if (req.path.startsWith("/api")) {
    res.status(503).json({ error: "playtest closed" });
    return;
  }
  res.status(503).type("html").send(`<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><title>AI Commander — Playtest closed</title>
<style>
  body { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; background: #0a0f1e; color: #c0d0e0;
         display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; }
  div { max-width: 480px; text-align: center; padding: 24px 28px;
        border: 1px solid #3a5a8a; border-radius: 4px; background: rgba(10,15,30,0.85); }
  h1 { font-size: 18px; margin: 0 0 12px; color: #ffaa00; letter-spacing: 0.5px; }
  p { margin: 0; font-size: 14px; line-height: 1.6; }
</style></head>
<body><div>
  <h1>AI COMMANDER</h1>
  <p>Playtest is currently closed.<br>Please check back later.</p>
</div></body></html>`);
});

app.use("/api/tts", ttsRouter);

// ── 试玩记录仪 V1 ──
// 采集默认关（RECORDER_COLLECT=on 才开）；生产必须显式给 RECORDER_DATA_DIR（持久卷）。
// 命令路由前的上下文中间件只做一件事：认出“这一请求属于哪个测试者的哪一局”，
// 认不出就当不存在——绝不拒命令、绝不改请求体。
const recorder = createRecorder(recorderConfigFromEnv(
  process.env, __dirname,
  describeProviderConfig().map((d) => ({ channel: d.channel, profile: d.profile, model: d.model })),
));
app.use(commandContext);
app.use(recorder.router);

// ──────────────────────────────────────────────────────────────
// Step 1 — structured event logging.
// One line per player command (and per staff-initiated prompt), tagged by
// `type`, so we can later tell whether a tester actually played and mine
// their phrasing for personalization. Visible in `fly logs`. console.log
// only — no persistence yet (a Fly volume + JSONL comes later). Pure
// observability: it never gates or changes a request, and `digest` (the
// large battlefield snapshot) is deliberately omitted to keep lines small.
//   type:"command"     → player's own words (/api/command{,-stream,-group})
//   type:"staff_event" → system-triggered advisor prompt (/api/staff-ask);
//                        NOT player input, kept separate via `type`.
// /api/brief (periodic system brief) is intentionally not logged.
// ──────────────────────────────────────────────────────────────
function logEvent(o: Record<string, unknown>): void {
  const line = { t: Date.now(), ...o };
  console.log("[EVENT] " + JSON.stringify(process.env.NODE_ENV === "production" ? consoleSafe(line) : line));
}

/**
 * 试玩记录仪 V1（§5.3）：生产控制台只打长度与编号，不打正文。
 * 玩家原话、听写、模型的话只进经过同意的逐局记录；`fly logs` 里只剩“多长”。
 * 代价（已知、接受）：线上日志里看不到原话，改去管理员页看。
 */
const CONSOLE_SAFE_KEYS = new Set([
  "t", "type", "route", "sessionId", "escalateId", "channel", "voice", "actionId", "frontId", "kind", "eventType",
  "responseType", "echo", "baseline", "cold", "warmup",
  "fromFront", "fromSquad", "fromDispatch", "toFront", "targetFacility", "targetRegion", "quantity", "unitType", "candidateKey",
]);
function consoleSafe(v: unknown, key = ""): unknown {
  if (typeof v === "string") return CONSOLE_SAFE_KEYS.has(key) && v.length <= 80 ? v : `(len=${v.length})`;
  if (Array.isArray(v)) return v.map((x) => consoleSafe(x, key));
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) out[k] = consoleSafe(x, k);
    return out;
  }
  return v;
}

/**
 * 刀寅（B 的证据）：这一轮模型交回的单子**经过 schema/归一化之后**长什么样。
 *
 * 起因：玩家说「南部战线和北部战线的部队全部撤退」，北线却被执行成「设防」。
 * 事后能看到的只有屏上的回执，分不清是模型写成了设防、服务端换了型
 * （normalizeAdvisorForDay7 会把 reinforce/escort 换成 defend，换了会带 warning）、
 * 还是更后面哪一层改的。有了这一行，下一次同样的事就能直接对账到层。
 * 只记动作与来源/去向字段；不记 digest、不记密钥、不要求长官去开开发者工具。
 */
function logAdvisorIntents(sessionId: unknown, channel: unknown, data: unknown): void {
  if (!data || typeof data !== "object") return;
  const d = data as Record<string, unknown>;
  const pick = (i: Record<string, unknown>) => {
    const out: Record<string, unknown> = {};
    for (const k of ["type", "fromFront", "fromSquad", "fromDispatch", "toFront", "targetFacility", "targetRegion", "quantity", "unitType"]) {
      if (i[k] !== undefined) out[k] = i[k];
    }
    return out;
  };
  const options = Array.isArray(d.options) ? d.options as Record<string, unknown>[] : [];
  logEvent({
    type: "advisor_intents",
    sessionId, channel: channel || "",
    responseType: d.responseType,
    warning: d.warning,
    dispatchSelection: d.dispatchSelection,
    options: options.map((o) => (Array.isArray(o.intents) ? o.intents as Record<string, unknown>[] : []).map(pick)),
  });
}

/**
 * 延迟 A/B：客户端量到的「松手 → 耳朵真听见」，搭下一条命令的顺风车回来。
 *
 * ★两臂靠 `baseline` 分开：`?webspeech` 的那一局走现状 Web Speech，其余走本刀。
 * **同一份构建、同一处计时**，所以两边的数直接可比；长官一行控制台都不用碰
 * （他的原话：「我真的不会去 f12 做这些，每次都整错」——要长官去捞证据本身
 * 就是设计缺陷，§8 那笔账的同一形状）。纯观测，不参与任何判定。
 */
function speechDiagOf(body: unknown): Record<string, unknown> | undefined {
  const b = body && typeof body === "object" ? (body as Record<string, unknown>).speechDiag : null;
  const d = b && typeof b === "object" ? b as Record<string, unknown> : null;
  if (!d || typeof d.firstSoundMs !== "number") return undefined;
  return { firstSoundMs: d.firstSoundMs, baseline: d.baseline === true, text: d.text };
}

/**
 * 语音输入 V1：把陈听到的原话落一行。
 *
 * 这就是 I2「必须基于真 STT log，禁脑内枚举」等的那份样本——第一次有了长官
 * 说了什么的逐字记录，可以拿去跟票据实派的部队对账（D4/F2 也吃这份数据）。
 * 现状只到 console / `fly logs`：JSONL 落盘属 O6，随 A5 记录仪缓办（§P 已裁），
 * 手测阶段的样本人工归档。
 */
function logHeard(sessionId: unknown, channel: unknown, heard: unknown, diag?: unknown, spoken?: unknown): void {
  if (typeof heard !== "string" || heard.length === 0) return;
  // spoken 层：**这一轮到底有没有交回 spoken**。
  // ★起因＝用户手测 2026-08-10：一个命令回合耳朵里出了三段（应答→正文→回执），
  //   而"三段"只可能是 spoken 缺席的兜底路（spoken 在场时回执不出声）。
  //   台架用小信封量到 21/21 在场，真信封下是不是掉了——只有这一行答得了。
  //   纯观测，不参与判定。
  // 刀 C：客户端量到的设备开启耗时搭这趟顺风车回来（Fable 附加条件②）。
  // ★为什么不让它只待在浏览器控制台：长官找不到那一行——而"要长官去 DevTools
  // 里捞证据"正是提案 §8 记的那笔账（上一局的 voice_heard 落在没人够得到的地方，
  // 一次真麦手测的原始证据就这么没了）。证据要自己跑到能被读到的地方去。
  // 纯观测：不参与任何判定，形状不对就当没有。
  const d = diag && typeof diag === "object" ? diag as Record<string, unknown> : null;
  const open = d && typeof d.gumMs === "number"
    ? { gumMs: d.gumMs, firstFrameMs: d.firstFrameMs, cold: d.cold, warmup: d.warm }
    : undefined;
  const spokenText = typeof spoken === "string" ? spoken.trim() : "";
  logEvent({
    type: "voice_heard", sessionId, channel: channel || "", heard, open,
    spoken: spokenText.length > 0 ? spokenText : null,   // null = 缺席 ⇒ 耳朵退回念正文
    // ★复读计数器（Fable 裁定 2026-08-10）：客户端的引擎闸把这一格拦下来不出声，
    //   拦掉之后从外面就再也看不见它犯过病——所以犯病率在这里记。
    //   **与运行时闸共用同一个谓词**（packages/shared/speechEcho），不许两份。
    echo: echoesHeard(spokenText, heard) || undefined,
  });
}

// Health check
app.get("/api/health", (_req, res) => {
  res.json({
    status: "ok",
    time: Date.now(),
    llmConfigured: isProviderConfigured(),
    // 语音输入 V1：客户端启动拉一次，只有名单里的频道 🎤 走录音路。
    // 拉不到时客户端 fail-closed 回现状 Web Speech（web 侧负责）。
    voiceChannels: voiceEnabledChannels(),
  });
});

// Full advisor call (player command → 3 options)
app.post("/api/command", async (req, res) => {
  const { digest, message, styleNote, channel, sessionId, escalateId } = req.body;

  if (!digest || typeof digest !== "string") {
    res.status(400).json({ error: "digest (string) 必填" });
    return;
  }
  const reject = rejectCommandBody(req.body?.audio, message, channel);
  if (reject) {
    res.status(400).json({ error: reject });
    return;
  }
  const audio = audioOf(req.body);
  const playerText = typeof message === "string" ? message : "";

  // Step 6a: escalateId (when present) ties this reply back to the crisis
  // escalation the player is responding to. JSON.stringify drops it when absent.
  // voice: 语音回合 message 为空，这一行会是空的——heard 日志在步 2 补。
  logEvent({ type: "command", route: "command", sessionId, escalateId, channel: channel || "", message: playerText, voice: audio ? true : undefined, prevSpeech: speechDiagOf(req.body) });
  const traceId = req.body?.traceId;
  traceWrite(traceId, "request", { route: "command", channel: channel || "", sessionId, escalateId, message: playerText, voice: !!audio, envelope: envelopeOf(digest) });

  try {
    const result = await callAdvisor(digest, playerText, styleNote || "", channel || "", audio, typeof traceId === "string" ? traceId : undefined);
    if (audio) logHeard(sessionId, channel, result.data.heard, req.body?.voiceDiag, result.data.spoken);
    logAdvisorIntents(sessionId, channel, result.warning ? { ...result.data, warning: result.warning } : result.data);
    traceResult(traceId, result.warning ? { ...result.data, warning: result.warning } : result.data);
    // result always has data (fallback if LLM failed)
    if (result.warning) {
      res.json({ ...result.data, warning: result.warning });
    } else {
      res.json(result.data);
    }
  } catch (err) {
    // Only API key missing reaches here
    const msg = err instanceof Error ? err.message : "服务器内部错误";
    res.status(503).json({ error: msg });
  }
});

// Streaming advisor call (SSE) — same input as /api/command
app.post("/api/command-stream", async (req, res) => {
  const { digest, message, styleNote, channel, sessionId, escalateId } = req.body;

  if (!digest || typeof digest !== "string") {
    res.status(400).json({ error: "digest (string) 必填" });
    return;
  }
  const reject = rejectCommandBody(req.body?.audio, message, channel);
  if (reject) {
    res.status(400).json({ error: reject });
    return;
  }
  const audio = audioOf(req.body);
  const playerText = typeof message === "string" ? message : "";

  // Step 6a: escalateId (when present) ties this reply back to the crisis
  // escalation the player is responding to. JSON.stringify drops it when absent.
  logEvent({ type: "command", route: "command-stream", sessionId, escalateId, channel: channel || "", message: playerText, voice: audio ? true : undefined, prevSpeech: speechDiagOf(req.body) });
  const traceId = req.body?.traceId;
  traceWrite(traceId, "request", { route: "command-stream", channel: channel || "", sessionId, escalateId, message: playerText, voice: !!audio, envelope: envelopeOf(digest) });

  // SSE headers
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  try {
    for await (const event of callAdvisorStream(digest, playerText, styleNote || "", channel || "", audio, typeof traceId === "string" ? traceId : undefined)) {
      if (audio && event.type === "options") logHeard(sessionId, channel, event.content?.heard, req.body?.voiceDiag, event.content?.spoken);
      if (event.type === "options") { logAdvisorIntents(sessionId, channel, event.content); traceResult(traceId, event.content); }
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    }
    res.write("data: [DONE]\n\n");
    res.end();
  } catch (err) {
    const msg = err instanceof Error ? err.message : "服务器内部错误";
    // If headers already sent, write error as SSE event
    res.write(`data: ${JSON.stringify({ type: "error", content: msg })}\n\n`);
    res.write("data: [DONE]\n\n");
    res.end();
  }
});

// Step 6a: pure-observability endpoint for client-originated events (crisis
// escalations). Like logEvent itself — it never gates or changes anything, just
// records. The escalate's actionId reappears as `escalateId` on the player's
// next /api/command{,-stream}, correlating action ↔ reaction in [EVENT] logs.
app.post("/api/log-event", (req, res) => {
  const { type, actionId, channel, frontId, kind, message, sessionId } = req.body ?? {};
  logEvent({ type: type || "client_event", actionId, channel: channel || "", frontId, kind, message, sessionId });
  res.json({ ok: true });
});

// 刀寅：浏览器那边的对账行（走了哪条路、改写后的意图、引擎解析出的落点、真下令结果、回执），
// 与服务端同一个请求编号写进同一份本地日志。纯观测，永远 200。
app.post("/api/trace", (req, res) => {
  const { traceId, stage, data } = req.body ?? {};
  if (typeof stage === "string" && /^[a-z_]{1,40}$/.test(stage) && data && typeof data === "object") {
    traceWrite(traceId, `client:${stage}`, data as Record<string, unknown>);
  }
  res.json({ ok: true });
});

/** schema/归一化之后、发给浏览器之前的那份单子。 */
function traceResult(traceId: unknown, data: unknown): void {
  const d = data && typeof data === "object" ? data as Record<string, unknown> : {};
  traceWrite(traceId, "result", {
    responseType: d.responseType, warning: d.warning, brief: d.brief,
    dispatchSelection: d.dispatchSelection, pendingDecision: d.pendingDecision, heard: d.heard,
    options: intentsOf(d),
  });
}

// Group chat advisor call (ALL mode — one LLM call, 3 personas)
app.post("/api/command-group", async (req, res) => {
  const { digest, message, styleNote, channelContext, sessionId } = req.body;

  if (!digest || typeof digest !== "string") {
    res.status(400).json({ error: "digest (string) 必填" });
    return;
  }
  if (!message || typeof message !== "string") {
    res.status(400).json({ error: "message (string) 必填" });
    return;
  }

  logEvent({ type: "command", route: "command-group", sessionId, channel: "group", message });

  try {
    const result = await callGroupAdvisor(digest, message, styleNote || "", channelContext || "");
    res.json(result);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "服务器内部错误";
    res.status(503).json({ error: msg });
  }
});

// Light brief call (periodic update, Day 16B: channel-aware)
app.post("/api/brief", async (req, res) => {
  const { digest, channel, mode } = req.body;
  if (!digest || typeof digest !== "string") {
    res.status(400).json({ error: "digest (string) 必填" });
    return;
  }

  // 7c.1: mode="escalation" voices a decision question from the beat facts.
  // 7c.2a: mode="proactive" voices a one-line situational statement from the beat
  // facts (never a question). 7e: mode="retrospect" voices a one-line decision-review
  // statement from the engine's outcome facts. Anything else keeps the legacy brief.
  const briefMode =
    mode === "escalation" ? "escalation"
    : mode === "preflight" ? "preflight"
    : mode === "proactive" ? "proactive"
    : mode === "retrospect" ? "retrospect"
    : "brief";
  const result = await callLightBrief(digest, channel, briefMode);
  if (!result) {
    res.status(502).json({ error: "简报生成失败" });
    return;
  }

  res.json(result);
});

// Phase 3: Staff-initiated decision request (event-driven)
app.post("/api/staff-ask", async (req, res) => {
  const { digest, eventType, eventMessage, channel, styleNote } = req.body;

  if (!digest || typeof digest !== "string") {
    res.status(400).json({ error: "digest (string) required" });
    return;
  }
  if (!eventMessage || typeof eventMessage !== "string") {
    res.status(400).json({ error: "eventMessage (string) required" });
    return;
  }

  logEvent({ type: "staff_event", route: "staff-ask", eventType: eventType || "UNKNOWN", channel: channel || "", message: eventMessage });

  try {
    const prompt = `[EVENT:${eventType || "UNKNOWN"}] ${eventMessage}\n\nProvide 2-3 response options for the commander.`;
    const result = await callAdvisor(digest, prompt, styleNote || "", channel || "");
    if (result.warning) {
      res.json({ ...result.data, warning: result.warning });
    } else {
      res.json(result.data);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Server error";
    res.status(503).json({ error: msg });
  }
});

// ──────────────────────────────────────────────────────────────
// Static SPA serving (playtest single-URL deploy).
// Goes AFTER all /api routes so they win route matching first.
// The SPA fallback uses a regex with negative lookahead so a typo'd
// /api/whatever still returns 404 from Express's default handler instead
// of being served the SPA index.html (which would mask the bug).
// ──────────────────────────────────────────────────────────────
const WEB_DIST = path.resolve(__dirname, "..", "..", "web", "dist");
app.use(express.static(WEB_DIST));
app.get(/^(?!\/api).*/, (_req, res) => {
  res.sendFile(path.join(WEB_DIST, "index.html"));
});

// Startup. Bind 0.0.0.0 so the server is reachable from outside the loopback
// interface — required for Cloudflare Tunnel / ngrok / Render / Railway.
const httpServer = app.listen(PORT, "0.0.0.0", () => {
  console.log(`AI Commander server running on http://localhost:${PORT}`);
  console.log(`[boot] static SPA dir: ${WEB_DIST}`);
  console.log(`[boot] NODE_ENV=${process.env.NODE_ENV ?? "(unset)"} PLAYTEST_ENABLED=${process.env.PLAYTEST_ENABLED ?? "(unset)"} → ${PLAYTEST_DISABLED ? "CLOSED" : "open"}`);
  const loadedKeys = envResult.parsed ? Object.keys(envResult.parsed).join(",") : "(none)";
  console.log(`[boot] .env=${ENV_PATH} loaded=${!envResult.error} keys=${loadedKeys}`);
  console.log(`[boot] LLM provider mapping:`);
  for (const d of describeProviderConfig()) {
    const status = d.keyPresent ? "✓" : `✗ MISSING ${d.keyEnvVar}`;
    console.log(`  [${d.channel}] profile=${d.profile} model=${d.model} ${status}`);
  }
  if (!isProviderConfigured()) {
    console.warn("⚠ Some channels missing API keys — they will fail at runtime");
  }
  const rc = recorder.config;
  console.log(`[boot] recorder: data=${rc.dataDir ? "configured" : "(none)"} collect=${rc.collect ? "on" : "off"} admin=${rc.adminToken ? "on" : "off"}`);
});

// ── 停机：先排空记录仪的写队列并落盘，再退出（试玩记录仪 V1 §4.4-8）──
// push main 自动部署、Fly 闲置自动停机都会发停机信号：Fly 默认 SIGINT，docker stop 是 SIGTERM。
// 以前这里没有任何处理（默认动作＝立刻死）；现在两种都接住，排空须在 Fly 默认 5 秒宽限内完成，
// 这里自己再设 4 秒上限，到点照样退出（不拖到被 SIGKILL）。
let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  const t0 = Date.now();
  console.log(`[shutdown] ${signal} received; draining recorder`);
  try { httpServer.close(); } catch { /* 已关 */ }
  const cap = new Promise<"timeout">((r) => { const t = setTimeout(() => r("timeout"), 4000); t.unref(); });
  try {
    const out = await Promise.race([recorder.drain(), cap]);
    console.log(`[shutdown] recorder drain ${out === "timeout" ? "TIMED OUT at 4000ms" : out ? `done ms=${out.ms} leftover=${out.leftover}` : "skipped (no store)"}; exiting after ${Date.now() - t0}ms`);
  } catch {
    console.log(`[shutdown] recorder drain failed; exiting after ${Date.now() - t0}ms`);
  }
  process.exit(0);
}
process.on("SIGINT", () => { void shutdown("SIGINT"); });
process.on("SIGTERM", () => { void shutdown("SIGTERM"); });
