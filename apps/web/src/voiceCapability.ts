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

/**
 * 延迟 A/B 的**基线臂开关**：`?webspeech` ⇒ 一律当作不支持 ⇒ 走现状 Web Speech。
 *
 * 为什么用同一份构建做两臂，而不是另起主仓库的前端：Web Speech 那条路在本
 * worktree 里**一个字节没改**（startPTT 的 SpeechRecCtor 分支原样），而两臂共用
 * 同一份构建就意味着**两边的计时探针也是同一份**——基线臂因此同样会自己上报，
 * 长官不必碰控制台。差的只有"耳朵"这一件。
 */
function webSpeechForced(): boolean {
  if (typeof window === "undefined") return false;
  try { return new URLSearchParams(window.location.search).has("webspeech"); } catch { return false; }
}

export function channelUsesVoiceCapture(ch: Channel): boolean {
  if (webSpeechForced()) return false;
  return voiceChannels.includes(ch);
}

/** 这一局是不是基线臂（进日志，两臂靠它分开）。 */
export function isBaselineArm(): boolean {
  return webSpeechForced();
}

/** 只给诊断/手测用：现在到底认为哪些频道能录音。 */
export function knownVoiceChannels(): readonly string[] {
  return voiceChannels;
}
