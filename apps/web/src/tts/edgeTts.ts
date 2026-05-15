// ============================================================
// AI Commander — Edge TTS engine adapter (Step 4, Phase B)
// ============================================================
//
// Fetches MP3 from /api/tts (server proxy to msedge-tts) and wraps
// it into an HTMLAudioElement playable by index.ts's queue.
//
// Returns { promise, abort } so callers can:
//   - await promise to get the Audio (or catch error/abort)
//   - call abort() to cancel the in-flight request immediately
//     (closes the fetch + body read; index.ts uses this on cancel()
//     so the server-side WebSocket connection isn't held open while
//     the audio gets thrown away anyway).
//
// Caller (index.ts) owns the URL lifetime — revokes via
// URL.revokeObjectURL(audio.src) after playback ends / errors / on cancel.
//
// Timeout: the 6s budget covers the ENTIRE lifecycle (header fetch +
// response.blob() body read + Audio creation). If the server starts
// streaming the body but stalls partway, controller.abort() still
// kicks in. The try/finally wraps everything, not just the headers.
//
// Throws on:
//   - HTTP non-200 (server validation / endpoint failure)
//   - AbortError (6s timeout OR caller-initiated abort())
//   - Network error

const API_URL = "http://localhost:3001";
const FETCH_TIMEOUT_MS = 6000;

export type EdgeRequest = {
  promise: Promise<HTMLAudioElement>;
  abort: () => void;
};

export function fetchEdgeMp3(text: string, voice: string): EdgeRequest {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  const promise = (async () => {
    try {
      const response = await fetch(`${API_URL}/api/tts`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text, voice }),
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new Error(`EDGE_TTS_HTTP_${response.status}`);
      }
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      return new Audio(url);
    } finally {
      clearTimeout(timeoutId);
    }
  })();

  return {
    promise,
    abort: () => controller.abort(),
  };
}
