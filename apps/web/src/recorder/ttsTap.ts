// ============================================================
// 交给 TTS 的那句话：记一笔，再原样交给 tts 模块。
// tts/index.ts 一个字节不动；既有的单槽 playbackObserver 不碰。
// 只记“交出去了什么、谁的嗓子”，不宣称念完、也不宣称玩家听见。
// ============================================================

import { speak as ttsSpeak, speakUtterance as ttsSpeakUtterance, type Persona, type SpeakOrigin } from "../tts";
import { recordTts } from "./index";

export function speak(text: string, persona: Persona, origin?: SpeakOrigin): void {
  recordTts(text, persona, "speak");
  if (origin === undefined) ttsSpeak(text, persona);
  else ttsSpeak(text, persona, origin);
}

export function speakUtterance(text: string, persona: Persona, origin?: SpeakOrigin): void {
  recordTts(text, persona, "utterance");
  if (origin === undefined) ttsSpeakUtterance(text, persona);
  else ttsSpeakUtterance(text, persona, origin);
}
