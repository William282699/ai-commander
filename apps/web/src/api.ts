// ============================================================
// AI Commander — Frontend API URL (env-aware)
// ============================================================
//
// Single source of truth for the backend base URL. Resolution order:
//   1. VITE_API_URL  — explicit override (e.g. Railway/Render where the
//                      backend has a different hostname than the frontend).
//   2. DEV mode      — Vite dev server on :3000 reaches Express on :3001.
//   3. PROD default  — empty string. fetch("/api/...") becomes a relative
//                      request to the same origin that served the page,
//                      which is the same Express also serves the SPA from.
//                      Required for single-URL playtest deployments behind
//                      Cloudflare Tunnel, ngrok, Render, etc.
//
// Anything VITE_* prefixed is inlined into the client bundle at build time
// and visible to anyone who inspects DevTools. Never put server secrets
// (LLM API keys etc.) under a VITE_* name.

export const API_URL =
  import.meta.env.VITE_API_URL ??
  (import.meta.env.DEV ? "http://localhost:3001" : "");
