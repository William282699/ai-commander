// ============================================================
// AI Commander — 延迟 A/B 探针的消费闸（纯函数）
//
// 为什么单独成模块（同 voiceSpeech.ts 的理由）：这几行原来散在 ChatPanel 的
// setPlaybackObserver 闭包里，node 台架一格都够不到，于是"这一声到底该不该记"
// 只能靠读源码判断——而这正是本刀在治的那类判据。搬成纯函数，绊索才落得下来。
//
// ★这颗闸治的是一个**真·现存 bug**（勘察档 T3，v3 定性）：
//   `releaseAtRef` 原来只有两个清点——观察者记下第一声时清、cancelPTT 清。
//   于是「松手了但这一轮压根没出声」的回合（喇叭没开／silent_echo 双层复读／
//   录音作废／断网）会把那颗计时起点**留在身上**，被**之后任意一回合**的第一声
//   消费掉——包括一个纯打字回合念正文。产出的 firstSoundMs 量级完全错误，
//   而且照样搭下一条命令回服务端进日志。
//
//   修法两道，缺一不可：
//     ① 绑回合——起点只能被**认领了它的那一个语音回合**消费。打字回合不认领，
//        所以永远吃不到上一轮的残值。
//     ② 超时——认领了但迟迟不出声（模型卡住／Edge 挂了）也作废，不留隔夜饭。
// ============================================================

import type { SpeakOrigin } from "./tts";

/** 松手那一刻钉下的计时起点。`turn` 为 null＝还没有任何回合认领它。 */
export interface ReleaseMark {
  /** performance.now() at PTT release. */
  at: number;
  /** 认领它的那一回合的序号；null＝无人认领（这一按没发出去 / 打字回合不认领）。 */
  turn: number | null;
}

/**
 * 上限取 30s：松手→耳朵的真实量级是秒级（STT＋LLM＋Edge fetch＋起播），
 * 30 秒以外的"测量"一定是残值搭车，不是慢，是错。宁可丢样本不许造样本。
 */
export const SPEECH_DIAG_MAX_AGE_MS = 30_000;

export interface SpeechDiagInput {
  mark: ReleaseMark | null;
  /** 当前在飞的回合序号（sendCommand 每次自增）。 */
  currentTurn: number;
  /** 这一声响起的时刻（performance.now()）。 */
  nowMs: number;
  /** 这一声是应答还是主动台词——主动台词不在"松手→耳朵"这条链上，一律不记。 */
  origin: SpeakOrigin;
}

export function shouldRecordSpeechDiag(input: SpeechDiagInput): boolean {
  const { mark, currentTurn, nowMs, origin } = input;
  // 主动台词不参与延迟 A/B：它没有"松手"这个起点，记进去就是往样本里掺沙子。
  if (origin !== "reply") return false;
  if (!mark) return false;
  // ①绑回合：只有认领了这颗起点的那一回合才能消费它。
  if (mark.turn === null || mark.turn !== currentTurn) return false;
  // ②超时：认领了也不能永远有效。
  if (nowMs - mark.at > SPEECH_DIAG_MAX_AGE_MS) return false;
  // 负龄（时钟回拨/参数写反）同样不是有效测量。
  if (nowMs < mark.at) return false;
  return true;
}
