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

/** 这一段话是"应答长官"还是"参谋主动开口"。探针只认 reply（延迟 A/B 量的是
 *  松手→耳朵，主动台词不在那条链上），板 2 的降级分流将来也读它。 */
export type SpeakOrigin = "reply" | "proactive";

const SENTENCE_END_RE = /(?<=[。！？；.!?;\n])\s*/;

type Job = {
  gen: number;
  persona: Persona;
  text: string;
  origin: SpeakOrigin;
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

export function speak(text: string, persona: Persona, origin: SpeakOrigin = "reply"): void {
  if (!text) return;
  if (activePersona !== null && persona !== activePersona) {
    cancel();
  }
  activePersona = persona;

  buffer += text;
  const { sentences, remainder } = pullSentences(buffer);
  buffer = remainder;

  for (const s of sentences) enqueue(s, persona, origin);
}

/**
 * 一段**完整的话**一次说完（主动台词专用）。
 *
 * ★为什么必须封装（勘察档 T4）：切句只认句末标点（`SENTENCE_END_RE`），
 * `speak()` 会把没有句末标点的整段留在句子缓冲里等下一次喂——「长官，请回话」
 * 这种短句只调 speak 就是**永远不出声**，而且残句还会嫁接进下一段同 persona 的
 * 语音。应答链是边流边喂、末尾另有 flush 兜底，所以从没暴露；主动台词是一次
 * 给全的，必须自带收尾。
 */
export function speakUtterance(text: string, persona: Persona, origin: SpeakOrigin = "proactive"): void {
  speak(text, persona, origin);
  flush(persona, origin);
}

export function flush(persona: Persona, origin: SpeakOrigin = "reply"): void {
  if (activePersona !== null && persona !== activePersona) {
    cancel();
    return;
  }
  const tail = buffer.trim();
  buffer = "";
  if (tail) enqueue(tail, persona, origin);
}

/**
 * VOICE_CONFIG 解引用设防（勘察档新 HIGH-5）：`MessageFrom` 有五个值而 `Persona`
 * 只有三个，一旦有 "system" 之类漏进来，`VOICE_CONFIG[persona].edge` 就是对
 * undefined 解引用＝同步 TypeError，而全仓没有 ErrorBoundary＝整个面板白屏。
 * 消费侧（proactiveSpeech 的闸②）是第一道，这里是第二道：拿不到条目就不出声。
 */
function voiceEntryOf(persona: Persona): (typeof VOICE_CONFIG)[Persona] | null {
  return VOICE_CONFIG[persona] ?? null;
}

function enqueue(text: string, persona: Persona, origin: SpeakOrigin): void {
  // Sticky terminal states for this generation:
  //   "silent" → no audio for the rest of this gen
  //   "native" → all remaining audio via browserNative
  if (streamEngine === "silent") return;
  const entry = voiceEntryOf(persona);
  if (!entry) return; // 设防：不认识的嗓子＝不出声，不崩
  if (streamEngine === "native") {
    // ★板 2（用户裁定）：主动台词**不落 native**。三人 nativeLang 全是 zh-CN 且
    //   代码里明写不挑 voice（"Apr 29 试过两次都失败"），降级到 native ＝三人同嗓；
    //   而主动台词是没有上下文的一声，嗓子是"谁在说话"的唯一线索，丢了身份的
    //   提醒不如不响——降级形态取 silent＋文字（文字照旧上屏，信息一个字不少）。
    //   ★判定按 **job 的 origin** 而不是模块级开关：streamEngine 是单个模块级
    //   变量，做成全局开关会把应答链的 native 兜底一起连累掉（板 2 双向判据的
    //   后半格就是钉这个）。
    if (origin === "proactive") return;
    // ★探针第二个调用点（勘察档新 HIGH-3 / plan 步1 P1-6）：原来这里在把话交给
    //   speechSynthesis **之前**就无条件报一声，与 playAudio 那处同病——修了一处
    //   不修这处，污染只是换个地方继续。改挂 utterance 的 onstart＝真开口那一刻。
    nativeSpeak(text, persona, () => playbackObserver?.(text, origin));
    return;
  }
  const gen = generation;
  const req = fetchEdgeMp3(text, entry.edge);
  // Swallow standalone rejection so it doesn't surface as
  // unhandledrejection — pump's await will re-throw and route it
  // through the proper fallback path.
  req.promise.catch(() => { /* handled inside pump */ });
  queue.push({ gen, persona, text, origin, mp3: req.promise, abort: req.abort });
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
            await playAudio(audio, job);
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
  const fallbackJobs: Array<{ text: string; origin: SpeakOrigin }> = [
    { text: failed.text, origin: failed.origin },
  ];
  const survivors: Job[] = [];
  for (const q of queue) {
    if (q.gen === failed.gen) {
      fallbackJobs.push({ text: q.text, origin: q.origin });
      revokeLater(q.mp3);
    } else {
      survivors.push(q);
    }
  }
  queue = survivors;
  // 兜底批原来完全绕过观察者（勘察档：降级后"零声零日志"的一半来源）——
  // 同样挂 onstart，真开口才报。
  // ★板 2 同一条规矩：这一批里属于**主动台词**的，降级形态是 silent＋文字，
  //   不落 native；应答链那些照旧走 native 兜底（两者在同一个批次里各走各的，
  //   因为判定挂在 job.origin 上，不是挂在 streamEngine 这个模块级开关上）。
  for (const f of fallbackJobs) {
    if (f.origin === "proactive") continue;
    nativeSpeak(f.text, failed.persona, () => playbackObserver?.(f.text, f.origin));
  }
}

function drainSameGen(gen: number): void {
  const survivors: Job[] = [];
  for (const q of queue) {
    if (q.gen === gen) revokeLater(q.mp3);
    else survivors.push(q);
  }
  queue = survivors;
}

/**
 * 出声观察点（延迟 A/B 用）：**声音真的开始走**那一刻叫一次，带上这段话的 origin。
 *
 * ★为什么要有这个钩子：判据是"松手→耳朵真听见"，而这个时刻只有 TTS 模块知道。
 * 以前的办法是让长官往控制台贴一段探针——他的原话是「我真的不会去 f12 做这些，
 * 每次都整错」。**要长官去捞证据本身就是设计缺陷**（同 §8 那笔账），所以改成
 * 客户端自己量、搭下一次命令的顺风车回服务端。
 *
 * ★三个发声出口全部挂在"真开口"事件上，一个都不许提前报（勘察档新 HIGH-3）：
 *   Edge 路＝首个 currentTime>0 的 timeupdate；native 路与降级兜底批＝utterance
 *   的 onstart。播不出来（autoplay 拒/静音/音量 0）就一声不报。
 */
let playbackObserver: ((text: string, origin: SpeakOrigin) => void) | null = null;
export function setPlaybackObserver(fn: ((text: string, origin: SpeakOrigin) => void) | null): void {
  playbackObserver = fn;
}

function playAudio(audio: HTMLAudioElement, job: Job): Promise<void> {
  currentAudio = audio;
  return new Promise<void>((resolve, reject) => {
    // ★真出声判据（勘察档新 HIGH-3，判据家法同形）：这一声原来报在 play() 之前，
    //   于是 autoplay 被拒 / 标签页被静音 / 音量 0 时**照报一声**——任何拿观察者当
    //   「真出声」证据的验收在全静音浏览器里也全绿。改挂首个 timeupdate：
    //   currentTime 真的走过才算数，播不出来就一声不报（宁可丢样本，不许造样本）。
    let announced = false;
    const announce = () => {
      if (announced || !(audio.currentTime > 0)) return;
      announced = true;
      try { playbackObserver?.(job.text, job.origin); } catch { /* 观察点不许影响播放 */ }
    };
    const cleanup = () => {
      audio.removeEventListener("timeupdate", announce);
      audio.removeEventListener("ended", onEnded);
      audio.removeEventListener("error", onError);
      try { URL.revokeObjectURL(audio.src); } catch { /* noop */ }
      if (currentAudio === audio) currentAudio = null;
    };
    const onEnded = () => { cleanup(); resolve(); };
    const onError = () => { cleanup(); reject(new Error("AUDIO_ERROR")); };
    audio.addEventListener("timeupdate", announce);
    audio.addEventListener("ended", onEnded);
    audio.addEventListener("error", onError);
    audio.play().catch((err) => {
      cleanup();
      reject(err instanceof Error ? err : new Error("AUDIO_PLAY_REJECTED"));
    });
  });
}
