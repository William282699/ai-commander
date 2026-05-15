// ============================================================
// AI Commander — TTS voice config (Step 4, Phase B)
// ============================================================
//
// Persona → voice mapping. Pure data, no logic. Engines treat this
// as a lookup table. To add a new persona (e.g. "general card"),
// extend Persona type and add an entry — nothing else changes.

export type Persona = "chen" | "marcus" | "emily";

export type VoiceEntry = {
  /** Microsoft Edge Neural voice name for Edge TTS engine. */
  edge: string;
  /** BCP-47 lang tag for browserNative SpeechSynthesisUtterance fallback. */
  nativeLang: string;
};

export const VOICE_CONFIG: Record<Persona, VoiceEntry> = {
  chen:   { edge: "zh-CN-YunjianNeural",  nativeLang: "zh-CN" }, // 男低音
  marcus: { edge: "zh-CN-YunyangNeural",  nativeLang: "zh-CN" }, // 男播音
  emily:  { edge: "zh-CN-XiaoxiaoNeural", nativeLang: "zh-CN" }, // 女温柔
};
