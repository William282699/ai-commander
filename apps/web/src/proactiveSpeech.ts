// ============================================================
// AI Commander — 主动台词出声闸（纯谓词，voiceSpeech.ts 先例）
//
// 病：TTS 只接在「玩家动作」链上（speak/flush 六个调用点全在 sendCommand 与
// handleApprove 的闭包里），消息侧零接线 ⇒ 陈主动提问、导演插话、复盘这些
// **参谋主动开口**的台词结构上从来不发声，只弹文字。长官盯着地图打仗，问题
// 静默过期，兵一直没动，事后回看聊天记录才发现。
//
// 为什么闸做成纯函数：判据要能进 node 台架（plan §4「判据下沉」）。闸的判定
// 若留在 ChatPanel 的订阅闭包里，就只能靠读源码验证——而"读源码验证"正是本刀
// 一路在治的那类假判据。
//
// ★fail-closed 是这一层的地基：**没有显式标记的消息一律不出声**。
//   不按 source 猜（陈的请示 source=command_ack，与执行回执同源，按 source 分流
//   要么复读要么漏），而是发射侧显式声明"这句该由谁的嗓子说出来、是哪一类"。
// ============================================================

import type { Persona } from "./tts";

/**
 * 这句主动台词是哪一类。**闸④（步 3）要靠 kind 认请示**——只有 escalation 那类
 * 才去查 escalation 还活着没有；proactive/retrospect/advice 没有对应的"活单"，
 * 拿同一把尺量会把它们全判死。
 */
export type UtteranceKind =
  | "escalation"   // 陈/参谋的升级请示（会等长官回话的那种）
  | "proactive"    // 导演层主动陈述（7c.2）
  | "retrospect"   // 决策复盘（7e）
  | "advice"       // llm_advice 主动建议（原走 event_report，只出声不迁渲染）
  | "nag"          // 复呼（步 5）
  | "expire";      // 过期甩脸（步 5）

/** 发射侧钉在消息上的"可配音声明"。缺席＝不出声（fail-closed）。 */
export interface Utterance {
  persona: Persona;
  kind: UtteranceKind;
}

/** 只有这三个人有嗓子。system/player 不在其列——这是白名单不是黑名单。 */
const SPEAKABLE: readonly string[] = ["chen", "marcus", "emily"];

/**
 * 把 MessageFrom 收窄成 Persona。
 *
 * ★为什么必须有这一步：`MessageFrom` 有五个值（player/chen/marcus/emily/system），
 * 而 `Persona` 只有三个。勘察档新 HIGH-5：`from:"system"` 能穿过「from!=="player"
 * ＋!groupChat」那种黑名单式否决，然后在 `VOICE_CONFIG[persona].edge` 上解引用
 * undefined ⇒ 同步 TypeError，而全仓没有 ErrorBoundary＝整个面板白屏。
 * 收窄不到就返回 null，调用方按"不出声"处理。
 */
export function personaOf(from: string | undefined | null): Persona | null {
  return from != null && SPEAKABLE.includes(from) ? (from as Persona) : null;
}

/** 闸要看的那几个字段（结构化子集，避免与 messageStore 循环依赖，也让台架好造样本）。 */
export interface SpeakCandidate {
  id: number;
  from?: string;
  groupChat?: boolean;
  utterance?: Utterance;
}

export type SpeakVerdict =
  | { speak: true; persona: Persona; kind: UtteranceKind }
  | { speak: false; reason: SpeakDenyReason };

export type SpeakDenyReason =
  | "no_utterance"      // 闸① 没标记＝不出声（fail-closed 地基）
  | "from_not_persona"  // 闸② from 不在白名单（system/player）
  | "persona_mismatch"  // 闸② 标记里的 persona 与 from 对不上（伪造/串台）
  | "group_chat";       // 闸③ 群聊回复不念（三个人 2.2-4.0s 依次落，会连珠炮）

/**
 * 步 2 的三道闸。闸④（新鲜度/escalation 存活）与闸⑤（收音窗）在步 3 接上，
 * 那两道要吃当下的世界状态，这一层只判消息**自身**够不够格。
 */
export function shouldSpeakMessage(msg: SpeakCandidate): SpeakVerdict {
  // 闸①：fail-closed。发射侧没有显式声明可配音性，一律不出声。
  const u = msg.utterance;
  if (!u) return { speak: false, reason: "no_utterance" };

  // 闸②：白名单制。from 与标记里的 persona 都必须是那三个人，且**互相一致**
  //      ——两道一起过才算数（纵深防御：伪造一个 from:"system"+utterance 的
  //      不可能态，也得在进 VOICE_CONFIG 之前被挡住）。
  const fromPersona = personaOf(msg.from);
  if (!fromPersona) return { speak: false, reason: "from_not_persona" };
  if (!personaOf(u.persona) || u.persona !== fromPersona) {
    return { speak: false, reason: "persona_mismatch" };
  }

  // 闸③：群聊不念。ALL 频道里三个人的回复是 2.2-4.0s 依次落下的，念出来是连珠炮。
  if (msg.groupChat) return { speak: false, reason: "group_chat" };

  return { speak: true, persona: fromPersona, kind: u.kind };
}

/**
 * 已播集合的键。
 *
 * ★为什么必须带 epoch（勘察档新 HIGH-1）：`clearMessages()` 把 `nextId` 重置回 1
 * （重开一局走 handleRestart → clearMessages），而 ChatPanel 挂载点没有 key、
 * 重开时**不会重挂** ⇒ 只按 id 去重的话，第一局的已播集合会带着 1..N 进第二局，
 * 把同号的新台词全判成"已播"＝第二局整局哑。
 */
export function spokenKey(epoch: number, id: number): string {
  return `${epoch}:${id}`;
}
