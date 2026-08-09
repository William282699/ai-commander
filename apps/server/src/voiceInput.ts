// ============================================================
// AI Commander — 语音输入 V1：命令路由的入场校验
//
// 单独成模块不是为了整齐，是为了**够得到**：校验逻辑留在 index.ts 里就只能
// 靠起服务器 + curl 才测得到（LEDGER H1「接线无台架可测」那一族）。放这儿之后
// 台架直接 import 这个纯函数，400 矩阵有机器断言看着。
// V1.5 的 /api/transcribe 会复用同一套形状检查（§X-5 第三缝）。
// ============================================================

import { channelAcceptsAudio, type AudioAttachment } from "./providers.js";

/**
 * 30s @16kHz mono 16-bit = 960KB 裸音频 → b64 1.28MB；上限留一点余量。
 * 16kHz 不是口味是承重：同样 30 秒换 48kHz 就是 b64 3.84MB，贴死 body 的 4mb
 * 那条线，连信封都没地方放。
 */
export const MAX_AUDIO_B64 = 1_400_000;

/**
 * 命令两路共用的入场校验。返回 null = 放行；返回字符串 = 400 的理由。
 * 三件事全部 fail-closed：
 *
 *  ① **audio/message 互斥**：语音回合的 message 是空串，这是合法的；两个都没有
 *     才是 400。旧的「message 必填」会把每一个语音回合挡在门外。
 *  ② **形状**：只认 wav + 非空 b64 + 长度上限。
 *  ③ **能力闸挂 provider 不挂 provider 类**：ops 的 deepseek 与 gemini 共用
 *     OpenAICompatibleProvider，音频若送进 ops 会被原样转发、换回一个 400，再被
 *     callAdvisor 的 catch 变成 createFallbackResponse——而那份兜底带着可执行
 *     intent、客户端从不看 warning ⇒ 一句听不懂的话最后变成自动下单。所以这道闸
 *     必须在服务端硬拦；客户端那层 capability 探测只是皮，不是闸。
 */
export function rejectCommandBody(audio: unknown, message: unknown, channel: unknown): string | null {
  const hasMessage = typeof message === "string" && message.trim().length > 0;
  if (audio === undefined || audio === null) {
    return hasMessage ? null : "message (string) 或 audio 至少要有一个";
  }
  if (typeof audio !== "object") return "audio 格式不合法";
  const a = audio as { data?: unknown; format?: unknown };
  if (typeof a.data !== "string" || a.data.length === 0) return "audio.data (base64) 必填";
  if (a.format !== "wav") return "audio.format 目前只支持 wav";
  if (a.data.length > MAX_AUDIO_B64) return "audio 超长（上限约 30 秒 16kHz 单声道）";
  if (!channelAcceptsAudio(typeof channel === "string" ? channel : undefined)) {
    return "该频道不接受语音输入";
  }
  return null;
}

/** 校验通过后取出附件；无音频回合返回 undefined（下游据此走原路）。 */
export function audioOf(body: { audio?: unknown }): AudioAttachment | undefined {
  return body.audio ? (body.audio as AudioAttachment) : undefined;
}
