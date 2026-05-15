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

export function nativeSpeak(text: string, persona: Persona): void {
  if (!hasNative()) return;
  const trimmed = text.trim();
  if (!trimmed) return;
  const utt = new SpeechSynthesisUtterance(trimmed);
  utt.lang = VOICE_CONFIG[persona].nativeLang;
  utt.rate = NATIVE_RATE;
  window.speechSynthesis.speak(utt);
}

export function nativeCancel(): void {
  if (!hasNative()) return;
  window.speechSynthesis.cancel();
}
