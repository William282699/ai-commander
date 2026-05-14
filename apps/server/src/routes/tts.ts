// ============================================================
// AI Commander — TTS Route (Step 4, Phase A spike)
// ============================================================
//
// Privacy boundary: text submitted here is forwarded to Microsoft
// Edge's Read Aloud endpoint (speech.platform.bing.com) via the
// msedge-tts package. NOT a local/offline pipeline. Acceptable for
// family/friend playtest; for production swap to paid Azure Speech.
//
// Contract:
//   POST /api/tts        { text: string, voice: string } → audio/mpeg
//   GET  /api/tts/health                                 → { ok, engine, check }
//
// Hard rules (Step 4 v2.1):
//   - Input validation: text.trim().length > 0, text.length <= 800,
//     voice ∈ VOICE_ALLOWLIST (3 entries)
//   - XML escape input before letting msedge-tts wrap it in SSML
//   - 5s timeout (Promise.race) — WebSocket may hang
//   - MP3 enum + audio/mpeg MIME, format ↔ MIME bound
//   - In-memory LRU cache, 200 entries, key = sha1(voice + ":" + text)
//   - /health is module-load only, does NOT call the endpoint

import { Router, type Request, type Response } from "express";
import { createHash } from "crypto";
import { MsEdgeTTS, OUTPUT_FORMAT } from "msedge-tts";

const VOICE_ALLOWLIST = new Set([
  "zh-CN-YunjianNeural",   // chen — 男低音
  "zh-CN-YunyangNeural",   // marcus — 男播音
  "zh-CN-XiaoxiaoNeural",  // emily — 女温柔
]);

const MAX_TEXT_LEN = 800;
const TTS_TIMEOUT_MS = 5000;
const CACHE_MAX = 200;

const cache = new Map<string, Buffer>();

function cacheGet(key: string): Buffer | undefined {
  const v = cache.get(key);
  if (v !== undefined) {
    cache.delete(key);
    cache.set(key, v);
  }
  return v;
}

function cacheSet(key: string, val: Buffer): void {
  if (cache.has(key)) cache.delete(key);
  cache.set(key, val);
  while (cache.size > CACHE_MAX) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

function xmlEscape(s: string): string {
  return s.replace(/[&<>"']/g, (c) => {
    switch (c) {
      case "&": return "&amp;";
      case "<": return "&lt;";
      case ">": return "&gt;";
      case '"': return "&quot;";
      case "'": return "&apos;";
      default: return c;
    }
  });
}

async function synthesize(text: string, voice: string): Promise<Buffer> {
  const tts = new MsEdgeTTS();
  try {
    const run = (async () => {
      await tts.setMetadata(voice, OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3);
      const { audioStream } = tts.toStream(xmlEscape(text));
      const chunks: Buffer[] = [];
      await new Promise<void>((resolve, reject) => {
        audioStream.on("data", (c: Buffer) => chunks.push(c));
        audioStream.on("close", () => resolve());
        audioStream.on("error", (err: Error) => reject(err));
      });
      return Buffer.concat(chunks);
    })();

    const timeout = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("TTS_TIMEOUT")), TTS_TIMEOUT_MS),
    );

    return await Promise.race([run, timeout]);
  } finally {
    try { tts.close(); } catch { /* ignore close errors */ }
  }
}

export const ttsRouter = Router();

ttsRouter.get("/health", (_req: Request, res: Response) => {
  res.json({ ok: true, engine: "edge", check: "module_loaded" });
});

ttsRouter.post("/", async (req: Request, res: Response) => {
  const { text, voice } = req.body ?? {};

  if (typeof text !== "string" || text.trim().length === 0) {
    res.status(400).json({ error: "text (non-empty string) required" });
    return;
  }
  if (text.length > MAX_TEXT_LEN) {
    res.status(400).json({ error: `text exceeds ${MAX_TEXT_LEN} chars` });
    return;
  }
  if (typeof voice !== "string" || !VOICE_ALLOWLIST.has(voice)) {
    res.status(400).json({ error: "voice not in allowlist" });
    return;
  }

  const key = createHash("sha1").update(`${voice}:${text}`).digest("hex");
  const cached = cacheGet(key);
  if (cached) {
    res.type("audio/mpeg").send(cached);
    return;
  }

  try {
    const mp3 = await synthesize(text, voice);
    cacheSet(key, mp3);
    res.type("audio/mpeg").send(mp3);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "TTS_ERROR";
    const status = msg === "TTS_TIMEOUT" ? 504 : 502;
    res.status(status).json({ error: msg });
  }
});
