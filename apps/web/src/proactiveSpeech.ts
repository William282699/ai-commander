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
  /** 游戏钟上的落流时刻（闸④量新鲜度用同一把尺）。 */
  time?: number;
}

/** 闸④⑤要吃的当下世界状态。取值在 ChatPanel，判定在这里（纯函数才测得动）。 */
export interface SpeakContext {
  /** 当前游戏钟。 */
  nowGameTime: number;
  /**
   * 这条消息所在频道的升级请示还活着没有。
   * **只有 kind==="escalation" 时才会被读**——其余 kind 压根没有"活单"这回事，
   * 拿同一把尺去量会把 proactive/retrospect/advice 全判死（P1-13 的负对照就是
   * 钉这个：无 escalation 登记的 proactive 必须照样出声）。
   */
  escalationAlive?: boolean;
  /** 收音窗：麦克风正在（或刚刚还在）收音。真名三段见 ChatPanel 的取值处。 */
  capturing: boolean;
}

/**
 * 新鲜度上限（游戏秒，全 kind 通用）。
 *
 * 与引擎的 ESCALATION_WINDOW_SEC(120) 是两码事：那个是"请示还算不算数"，
 * 这个是"这句话还值不值得念"。回灌/暂存释放时一条三分钟前的话被念出来，
 * 比不念更伤——所以两把尺都要过。
 */
export const UTTERANCE_MAX_AGE_SEC = 30;

export type SpeakVerdict =
  | { speak: true; persona: Persona; kind: UtteranceKind }
  | { speak: false; reason: SpeakDenyReason };

export type SpeakDenyReason =
  | "no_utterance"      // 闸① 没标记＝不出声（fail-closed 地基）
  | "from_not_persona"  // 闸② from 不在白名单（system/player）
  | "persona_mismatch"  // 闸② 标记里的 persona 与 from 对不上（伪造/串台）
  | "group_chat"        // 闸③ 群聊回复不念（三个人 2.2-4.0s 依次落，会连珠炮）
  | "stale"             // 闸④ 太旧（回灌/暂存释放时的陈年台词）
  | "escalation_dead"   // 闸④ 请示已经不在了（只对 kind==="escalation"）
  | "capturing";        // 闸⑤ 正在收音——**可延后**，不是丢弃（见下）

/**
 * 这条 deny 是不是"等会儿还能再念"。
 *
 * ★只有收音窗是可延后的：麦克风一松，这句话仍然值得说（手测 6：按住时到达 →
 * 录音期不开口 → 松手未过期则补播）。其余 deny 都是终局的，调用方可以直接
 * 记进已播集合不再回头看。步 4 的暂存队列就靠这条分岔。
 */
export function isDeferrable(reason: SpeakDenyReason): boolean {
  return reason === "capturing";
}

/**
 * 五道闸。①②③判消息**自身**够不够格（步 2），④⑤吃当下的世界状态（步 3）。
 */
export function shouldSpeakMessage(msg: SpeakCandidate, ctx?: SpeakContext): SpeakVerdict {
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

  if (ctx) {
    // 闸⑤：收音窗。**排在闸④之前**——正在收音时这句话该被"押后"而不是"判旧"，
    //      顺序反了会把一条本可以补播的话提前钉成终局 deny。
    if (ctx.capturing) return { speak: false, reason: "capturing" };

    // 闸④之一：新鲜度（全 kind 通用）。msg.time 缺席＝无从判断，按 fail-closed 走。
    if (msg.time == null) return { speak: false, reason: "stale" };
    const age = ctx.nowGameTime - msg.time;
    // ★负龄也算不新鲜。勘察档记过：llm_advice 那条异步 post **没有重开守卫**
    //   （代码里自带认罪注释），上一局的台词会带着上一局的时钟落进新局——新局
    //   钟从 0 起，age 于是是个大负数，只写 `age > MAX` 的话它会被**放行**，
    //   正好把一句上一局的话念出来。
    if (age < 0 || age > UTTERANCE_MAX_AGE_SEC) return { speak: false, reason: "stale" };

    // 闸④之二：**只有请示**才查活单。其余 kind 没有活单这回事，不查。
    if (u.kind === "escalation" && ctx.escalationAlive !== true) {
      return { speak: false, reason: "escalation_dead" };
    }
  }

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
