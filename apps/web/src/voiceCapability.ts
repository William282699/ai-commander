// ============================================================
// AI Commander — 语音输入 V1：频道能力探测
//
// 服务端 /api/health 报 `voiceChannels`（白名单 ∩ provider==="gemini"）。
// 客户端启动拉一次，不在名单里的频道，🎤 一个字节不改地走现状 Web Speech。
//
// ★ fail-closed 的方向在这儿要说清楚：拉不到、超时、字段缺席 —— 一律**当作
// 不支持**，回落到现状那条路。语音是新东西，新东西不可用时应该退回旧世界，
// 而不是让长官对着一个没接通的麦克风说话。
// （服务端另有一道硬闸：audio 送错频道直接 400。这里只是别让 UI 白忙。）
// ============================================================

import { API_URL } from "./api";
import type { Channel } from "@ai-commander/shared";

let voiceChannels: readonly string[] = [];
let probed = false;

export async function probeVoiceChannels(): Promise<void> {
  if (probed) return;
  probed = true;
  try {
    const res = await fetch(`${API_URL}/api/health`);
    if (!res.ok) return;
    const data = await res.json();
    if (Array.isArray(data?.voiceChannels)) {
      voiceChannels = data.voiceChannels.filter((c: unknown): c is string => typeof c === "string");
    }
  } catch {
    // 网络不通/老服务端没有这个字段 → 保持空名单 = 全部走 Web Speech
  }
}

export function channelUsesVoiceCapture(ch: Channel): boolean {
  return voiceChannels.includes(ch);
}

/** 只给诊断/手测用：现在到底认为哪些频道能录音。 */
export function knownVoiceChannels(): readonly string[] {
  return voiceChannels;
}
