// ============================================================
// AI Commander — TTS public API (Step 4, Phase B)
// ============================================================
//
// 3-function contract for ChatPanel (Phase C):
//   speak(text, persona)   — incremental feed; sentence buffer internal
//   flush(persona)         — stream end; speak remaining buffer
//   cancel()               — kill queue + audio + native + reset state
//
// Invariants:
//   - Queue preserves SUBMISSION order, not fetch completion order
//     (jobs reserve a seat at speak() time; playback awaits in order).
//   - generation token bumps on cancel / persona switch; two stale
//     checkpoints inside pump (before await mp3, after await mp3).
//   - No mid-stream engine switch within one generation:
//       * Edge fail BEFORE any Edge audio of this gen played → fallback
//         current+remaining same-gen jobs to native, lock streamEngine
//         to "native" for the rest of this generation.
//       * Edge fail AFTER some Edge audio played → silent-skip
//         remaining TTS for this generation (text/UI unaffected).
//   - Persona change while activePersona set → cancel old gen first,
//     start fresh gen with new persona.
//   - pump lost-wakeup fix: finally clears playingPromise then
//     re-pumps if queue still has work.

import { fetchEdgeMp3 } from "./edgeTts";
import { nativeSpeak, nativeCancel } from "./browserNative";
import { VOICE_CONFIG, type Persona } from "./voiceConfig";

export type { Persona };

const SENTENCE_END_RE = /(?<=[。！？；.!?;\n])\s*/;

type Job = {
  gen: number;
  persona: Persona;
  text: string;
  mp3: Promise<HTMLAudioElement>;
  abort: () => void;
};

let generation = 0;
let activePersona: Persona | null = null;
let buffer = "";
let queue: Job[] = [];
let playingPromise: Promise<void> | null = null;
let currentAudio: HTMLAudioElement | null = null;
let currentJob: Job | null = null;
// streamEngine state machine (per generation):
//   null     — no decision yet, next enqueue attempts Edge
//   "edge"   — Edge audio has played; future jobs continue Edge
//   "native" — Edge failed before any audio played; rest of gen goes native
//   "silent" — Edge played then failed mid-stream; rest of gen produces
//              NO audio (text/UI unaffected). Sticky for the gen so
//              new speak() calls don't retry Edge or switch voices.
let streamEngine: "edge" | "native" | "silent" | null = null;
let streamHasPlayedEdge = false;

function pullSentences(text: string): { sentences: string[]; remainder: string } {
  if (!text) return { sentences: [], remainder: "" };
  const parts = text.split(SENTENCE_END_RE);
  const last = parts[parts.length - 1] ?? "";
  const lastComplete = last === "" || /[。！？；.!?;\n]$/.test(last);
  const candidates = lastComplete ? parts : parts.slice(0, -1);
  const sentences = candidates.filter((s) => s.trim().length > 0);
  const remainder = lastComplete ? "" : last;
  return { sentences, remainder };
}

function revokeLater(p: Promise<HTMLAudioElement>): void {
  p.then((a) => {
    try { URL.revokeObjectURL(a.src); } catch { /* noop */ }
  }).catch(() => { /* fetch failed — nothing to revoke */ });
}

function resetStreamState(): void {
  buffer = "";
  streamEngine = null;
  streamHasPlayedEdge = false;
}

export function cancel(): void {
  generation++;
  activePersona = null;
  resetStreamState();
  // Abort the job currently being processed by pump (fetch in-flight,
  // or already past fetch — abort() is a no-op for completed requests).
  if (currentJob) {
    try { currentJob.abort(); } catch { /* noop */ }
    revokeLater(currentJob.mp3);
    currentJob = null;
  }
  // Abort + revoke every queued job (their fetches are also in-flight
  // in parallel — we kicked them off at enqueue time).
  for (const job of queue) {
    try { job.abort(); } catch { /* noop */ }
    revokeLater(job.mp3);
  }
  queue.length = 0;
  if (currentAudio) {
    try {
      currentAudio.pause();
      // Force playAudio's "ended" listener to resolve so pump
      // doesn't hang awaiting a paused audio.
      currentAudio.dispatchEvent(new Event("ended"));
    } catch { /* noop */ }
    currentAudio = null;
  }
  nativeCancel();
}

export function speak(text: string, persona: Persona): void {
  if (!text) return;
  if (activePersona !== null && persona !== activePersona) {
    cancel();
  }
  activePersona = persona;

  buffer += text;
  const { sentences, remainder } = pullSentences(buffer);
  buffer = remainder;

  for (const s of sentences) enqueue(s, persona);
}

export function flush(persona: Persona): void {
  if (activePersona !== null && persona !== activePersona) {
    cancel();
    return;
  }
  const tail = buffer.trim();
  buffer = "";
  if (tail) enqueue(tail, persona);
}

function enqueue(text: string, persona: Persona): void {
  // Sticky terminal states for this generation:
  //   "silent" → no audio for the rest of this gen
  //   "native" → all remaining audio via browserNative
  if (streamEngine === "silent") return;
  if (streamEngine === "native") {
    nativeSpeak(text, persona);
    return;
  }
  const gen = generation;
  const req = fetchEdgeMp3(text, VOICE_CONFIG[persona].edge);
  // Swallow standalone rejection so it doesn't surface as
  // unhandledrejection — pump's await will re-throw and route it
  // through the proper fallback path.
  req.promise.catch(() => { /* handled inside pump */ });
  queue.push({ gen, persona, text, mp3: req.promise, abort: req.abort });
  void pump();
}

async function pump(): Promise<void> {
  if (playingPromise) return;
  playingPromise = (async () => {
    try {
      while (queue.length > 0) {
        const job = queue.shift()!;
        // Expose to cancel() so it can abort the in-flight fetch.
        currentJob = job;
        try {
          // Checkpoint 1: stale before await (cancel happened before fetch settled)
          if (job.gen !== generation) {
            revokeLater(job.mp3);
            continue;
          }

          let audio: HTMLAudioElement;
          try {
            audio = await job.mp3;
          } catch {
            handleEdgeFailure(job);
            continue;
          }

          // Checkpoint 2: stale during await (cancel happened while fetch in flight)
          if (job.gen !== generation) {
            try { URL.revokeObjectURL(audio.src); } catch { /* noop */ }
            continue;
          }

          try {
            await playAudio(audio);
          } catch {
            // play() rejected (e.g. NotAllowedError autoplay policy)
            handleEdgeFailure(job);
            continue;
          }

          // Only mark Edge as the locked engine if still same generation
          // (cancel during play would have bumped gen).
          if (job.gen === generation) {
            streamHasPlayedEdge = true;
            streamEngine = "edge";
          }
        } finally {
          // Don't clobber a fresh currentJob assignment from a future
          // iteration (defensive — pump is serial so this is just safety).
          if (currentJob === job) currentJob = null;
        }
      }
    } finally {
      playingPromise = null;
      // Lost-wakeup fix: a speak() that landed between the while-exit
      // and this assignment would have seen playingPromise truthy and
      // returned, leaving its job stranded. Re-pump if so.
      if (queue.length > 0) void pump();
    }
  })();
}

function handleEdgeFailure(failed: Job): void {
  // Cancellation during fetch/play is not a real failure — gen mismatch
  // already handled the cleanup. Don't trigger fallback.
  if (failed.gen !== generation) return;

  // Already in a terminal/sticky state — leftover in-flight Edge jobs
  // can finish rejecting, just drain idempotently.
  if (streamEngine === "native" || streamEngine === "silent") {
    drainSameGen(failed.gen);
    return;
  }

  // Edge already played in this gen but now failing → lock the rest
  // of this generation to silent. Future speak() calls in this gen
  // produce NO audio (text/UI unaffected); no Edge retry, no voice
  // switch mid-stream. Sticky until cancel() resets streamEngine.
  if (streamHasPlayedEdge) {
    streamEngine = "silent";
    drainSameGen(failed.gen);
    return;
  }

  // First failure with nothing played yet → fallback whole same-gen
  // stream (failed job + queued same-gen jobs) to native.
  streamEngine = "native";
  const fallbackTexts: string[] = [failed.text];
  const survivors: Job[] = [];
  for (const q of queue) {
    if (q.gen === failed.gen) {
      fallbackTexts.push(q.text);
      revokeLater(q.mp3);
    } else {
      survivors.push(q);
    }
  }
  queue = survivors;
  for (const t of fallbackTexts) nativeSpeak(t, failed.persona);
}

function drainSameGen(gen: number): void {
  const survivors: Job[] = [];
  for (const q of queue) {
    if (q.gen === gen) revokeLater(q.mp3);
    else survivors.push(q);
  }
  queue = survivors;
}

function playAudio(audio: HTMLAudioElement): Promise<void> {
  currentAudio = audio;
  return new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      audio.removeEventListener("ended", onEnded);
      audio.removeEventListener("error", onError);
      try { URL.revokeObjectURL(audio.src); } catch { /* noop */ }
      if (currentAudio === audio) currentAudio = null;
    };
    const onEnded = () => { cleanup(); resolve(); };
    const onError = () => { cleanup(); reject(new Error("AUDIO_ERROR")); };
    audio.addEventListener("ended", onEnded);
    audio.addEventListener("error", onError);
    audio.play().catch((err) => {
      cleanup();
      reject(err instanceof Error ? err : new Error("AUDIO_PLAY_REJECTED"));
    });
  });
}
