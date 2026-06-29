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
import { ttsRouter } from "./routes/tts.js";

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
app.use(express.json({ limit: "100kb" }));

// Gate runs after JSON parser (so 503 JSON body is well-formed) but before
// every route, including /api/tts.
app.use((req, res, next) => {
  if (!PLAYTEST_DISABLED) return next();
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
  console.log("[EVENT] " + JSON.stringify({ t: Date.now(), ...o }));
}

// Health check
app.get("/api/health", (_req, res) => {
  res.json({
    status: "ok",
    time: Date.now(),
    llmConfigured: isProviderConfigured(),
  });
});

// Full advisor call (player command → 3 options)
app.post("/api/command", async (req, res) => {
  const { digest, message, styleNote, channel, sessionId, escalateId } = req.body;

  if (!digest || typeof digest !== "string") {
    res.status(400).json({ error: "digest (string) 必填" });
    return;
  }
  if (!message || typeof message !== "string") {
    res.status(400).json({ error: "message (string) 必填" });
    return;
  }

  // Step 6a: escalateId (when present) ties this reply back to the crisis
  // escalation the player is responding to. JSON.stringify drops it when absent.
  logEvent({ type: "command", route: "command", sessionId, escalateId, channel: channel || "", message });

  try {
    const result = await callAdvisor(digest, message, styleNote || "", channel || "");
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
  if (!message || typeof message !== "string") {
    res.status(400).json({ error: "message (string) 必填" });
    return;
  }

  // Step 6a: escalateId (when present) ties this reply back to the crisis
  // escalation the player is responding to. JSON.stringify drops it when absent.
  logEvent({ type: "command", route: "command-stream", sessionId, escalateId, channel: channel || "", message });

  // SSE headers
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  try {
    for await (const event of callAdvisorStream(digest, message, styleNote || "", channel || "")) {
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
  // facts (never a question). Anything else keeps the legacy statement-style brief.
  const briefMode = mode === "escalation" ? "escalation" : mode === "proactive" ? "proactive" : "brief";
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
app.listen(PORT, "0.0.0.0", () => {
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
});
