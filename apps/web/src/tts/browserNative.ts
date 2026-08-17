// ============================================================
// AI Commander — Browser native TTS fallback (Step 4, Phase B)
// ============================================================
//
// Wraps window.speechSynthesis. Used when Edge TTS fails before
// any audio of the current stream played (see index.ts pump catch).
//
// Critical design:
//   - lang = "zh-CN" — fixes the original "en-US voice mispronouncing
//     Chinese" bug. Same lang for all personas because zh-CN has only
//     one reliable native voice (Tingting), so persona differentiation
//     via native is impossible (historical lesson: Apr 29 personality
//     voice experiment failed twice).
//   - NO voice picking: rely on browser default for zh-CN.
//   - Browser maintains its own utterance queue, so sequential
//     nativeSpeak() calls play in order without our queue.

import { VOICE_CONFIG, type Persona } from "./voiceConfig";

const NATIVE_RATE = 1.1;

function hasNative(): boolean {
  return typeof window !== "undefined" && "speechSynthesis" in window;
}

/**
 * `onStart` 在 utterance 真开口那一刻叫一次（原生这边没有 timeupdate，onstart
 * 是唯一等价物）。被 autoplay 策略吞掉时它不会触发——这正是要的：播不出来就
 * 不该记一声（勘察档新 HIGH-3 的原生半边）。
 */
export function nativeSpeak(text: string, persona: Persona, onStart?: () => void): void {
  if (!hasNative()) return;
  const trimmed = text.trim();
  if (!trimmed) return;
  const utt = new SpeechSynthesisUtterance(trimmed);
  utt.lang = VOICE_CONFIG[persona].nativeLang;
  utt.rate = NATIVE_RATE;
  if (onStart) utt.onstart = () => { try { onStart(); } catch { /* 观察点不许影响播放 */ } };
  window.speechSynthesis.speak(utt);
}

export function nativeCancel(): void {
  if (!hasNative()) return;
  window.speechSynthesis.cancel();
  // ★步 5d 自愈：cancel() 偶尔不生效。探针找到的**唯一**能造出真重叠的路径就是
  //   这里——正常 0/41、退化 39/41，重叠的那对儿逐字是「native 马克斯 ＋ Edge 陈」
  //   同时说话，前置条件是那一轮 /api/tts 吃了 503（应答退到 native）。
  //   补一拍：还在说就再 cancel 一次。零风险（本来就该停），fail-safe。
  setTimeout(() => {
    try {
      if (window.speechSynthesis.speaking || window.speechSynthesis.pending) {
        window.speechSynthesis.cancel();
      }
    } catch { /* noop */ }
  }, 0);
}
