// ============================================================
// AI Commander — Frontend session identity
// ============================================================
//
// Stable per-browser id attached to player command requests so the server
// can group one tester's commands across a play session (and across reloads).
//
// Step 1 (logging foundation): used ONLY for [EVENT] log correlation — it
// gates nothing, changes no behavior, and carries no PII. Persisted in
// localStorage so a reload keeps the same id; falls back to a volatile
// in-memory id when storage is unavailable (private mode / sandbox).

const STORAGE_KEY = "ai_commander_session_id";

function makeId(): string {
  try {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
      return crypto.randomUUID();
    }
  } catch {
    // fall through to manual generation
  }
  // Fallback for non-secure contexts / older browsers without randomUUID.
  return "sess-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 10);
}

function resolveSessionId(): string {
  try {
    const existing = localStorage.getItem(STORAGE_KEY);
    if (existing) return existing;
    const fresh = makeId();
    localStorage.setItem(STORAGE_KEY, fresh);
    return fresh;
  } catch {
    // localStorage blocked — use a volatile id (still valid for this load).
    return makeId();
  }
}

export const SESSION_ID = resolveSessionId();
