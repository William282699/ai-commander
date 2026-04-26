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

const app = express();
const PORT = parseInt(process.env.PORT || "3001", 10);

app.use(cors());
app.use(express.json({ limit: "100kb" }));

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
  const { digest, message, styleNote, channel } = req.body;

  if (!digest || typeof digest !== "string") {
    res.status(400).json({ error: "digest (string) 必填" });
    return;
  }
  if (!message || typeof message !== "string") {
    res.status(400).json({ error: "message (string) 必填" });
    return;
  }

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
  const { digest, message, styleNote, channel } = req.body;

  if (!digest || typeof digest !== "string") {
    res.status(400).json({ error: "digest (string) 必填" });
    return;
  }
  if (!message || typeof message !== "string") {
    res.status(400).json({ error: "message (string) 必填" });
    return;
  }

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

// Group chat advisor call (ALL mode — one LLM call, 3 personas)
app.post("/api/command-group", async (req, res) => {
  const { digest, message, styleNote, channelContext } = req.body;

  if (!digest || typeof digest !== "string") {
    res.status(400).json({ error: "digest (string) 必填" });
    return;
  }
  if (!message || typeof message !== "string") {
    res.status(400).json({ error: "message (string) 必填" });
    return;
  }

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
  const { digest, channel } = req.body;
  if (!digest || typeof digest !== "string") {
    res.status(400).json({ error: "digest (string) 必填" });
    return;
  }

  const result = await callLightBrief(digest, channel);
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

// Startup
app.listen(PORT, () => {
  console.log(`AI Commander server running on http://localhost:${PORT}`);
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
