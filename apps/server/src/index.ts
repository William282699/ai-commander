// ============================================================
// AI Commander — Express Server
// ============================================================

import "dotenv/config";
import express from "express";
import cors from "cors";
import { callAdvisor, callLightBrief } from "./ai.js";

const app = express();
const PORT = parseInt(process.env.PORT || "3001", 10);

app.use(cors());
app.use(express.json());

// Health check
app.get("/api/health", (_req, res) => {
  res.json({ status: "ok", time: Date.now() });
});

// Full advisor call (player command → 3 options)
app.post("/api/command", async (req, res) => {
  const { digest, message, styleNote } = req.body;
  if (!digest || !message) {
    res.status(400).json({ error: "digest and message required" });
    return;
  }

  const result = await callAdvisor(digest, message, styleNote || "");
  if (!result) {
    res.status(502).json({ error: "LLM call failed" });
    return;
  }

  res.json(result);
});

// Light brief call (periodic update)
app.post("/api/brief", async (req, res) => {
  const { digest } = req.body;
  if (!digest) {
    res.status(400).json({ error: "digest required" });
    return;
  }

  const result = await callLightBrief(digest);
  if (!result) {
    res.status(502).json({ error: "LLM call failed" });
    return;
  }

  res.json(result);
});

app.listen(PORT, () => {
  console.log(`AI Commander server running on http://localhost:${PORT}`);
});
