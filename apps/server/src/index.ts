// ============================================================
// AI Commander — Express Server
// ============================================================

import "dotenv/config";
import express from "express";
import cors from "cors";
import { callAdvisor, callLightBrief, isProviderConfigured } from "./ai.js";

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
  const { digest, message, styleNote } = req.body;

  if (!digest || typeof digest !== "string") {
    res.status(400).json({ error: "digest (string) 必填" });
    return;
  }
  if (!message || typeof message !== "string") {
    res.status(400).json({ error: "message (string) 必填" });
    return;
  }

  try {
    const result = await callAdvisor(digest, message, styleNote || "");
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

// Light brief call (periodic update)
app.post("/api/brief", async (req, res) => {
  const { digest } = req.body;
  if (!digest || typeof digest !== "string") {
    res.status(400).json({ error: "digest (string) 必填" });
    return;
  }

  const result = await callLightBrief(digest);
  if (!result) {
    res.status(502).json({ error: "简报生成失败" });
    return;
  }

  res.json(result);
});

// Startup
app.listen(PORT, () => {
  console.log(`AI Commander server running on http://localhost:${PORT}`);
  if (!isProviderConfigured()) {
    console.warn("⚠ LLM API key not configured. Set DEEPSEEK_API_KEY in .env");
    console.warn("  Server will return error on /api/command until key is set.");
  }
});
