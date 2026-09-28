// ============================================================
// AI Commander — Unified Chat Panel (Round 0)
// Replaces CommandPanel + MessageFeed with a single right-side
// chat-style interface.  Commander selection at the top,
// chat bubbles in the middle, input at the bottom.
// ============================================================

import { useState, useRef, useEffect, useMemo, useCallback } from "react";

// ── Push-to-Talk: SpeechRecognition type shim ──
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type SpeechRecClass = { new (): any };
declare global {
  interface Window {
    SpeechRecognition?: SpeechRecClass;
    webkitSpeechRecognition?: SpeechRecClass;
  }
}
import { OrgTree } from "./OrgTree";
import { VolumePopover } from "./VolumePopover";
import { ArsenalPanel } from "./ArsenalPanel";
import { resolveIntent, applyOrders, updateStyleParam, findFront, enqueueProduction, cancelDoctrine, captureDecisionReview, enqueueDecisionReview, isReviewableIntentType, previewHighImpactIntent, buildPreflightConcernFacts, serializePreflightFacts, buildPreflightFallbackLine, buildPlayerViewLines, isAllFrontHint } from "@ai-commander/core";
import { spokenNameOf, resolveTicketReference, ticketDispatchReceipt, burnEscalationTicket, isKnownForceRef, checkDispatchAuthority, retargetIntentForTicket, ticketDestinationVerdict, describeCommittedPull } from "@ai-commander/core";
// 刀寅：用过的票 → 真走了的那一批；票据差额的结构化原因
import { resolveTicketBatch, ticketGapFacts, checkDestinationQuote, isCompleteConfirmPlan, findQuantityAmbiguity, applyQuantityReading, contractReplyConflict, type TicketGapFacts, type QuantityAmbiguity } from "@ai-commander/core";
// 刀寅：本地对账日志（与服务端同一个请求编号）
import { newTraceId, traceClient, intentFacts } from "./advisorTrace";
// retreat-scope 刀C — 任务台账（「哪次任务」这一类指代）
import { findDispatch, liveDispatchMembers, findSameTaskInProgress, describePlanForApproval, type DispatchCandidate } from "@ai-commander/core";
// 刀己 — 这一轮该做什么，判断全在 core（这层只执行它给的 plan）
import { planSelectionTurn, planDispatchSelectionBatch } from "@ai-commander/core";
import type { DispatchSelectionKey, DispatchSelectionRequirement } from "@ai-commander/core";
// 刀甲：「这是不是经济单」的唯一真相源在 core（produce/trade），UI 不另抄一张表
import { isDispatchIntent } from "@ai-commander/core";
import type { CommanderRef, EscalationTicket } from "@ai-commander/core";
import type { ViewportGeometry } from "@ai-commander/core";
import type { GameState, AdvisorResponse, AdvisorOption, Intent, Channel, CommanderMemory, TaskCard, TaskPriority } from "@ai-commander/shared";
import { buildDigestForChannel } from "./digestHelper";
// Phase 1 的闸已搬去 autoExecuteGate.ts（零行为变化）——留在组件闭包里台架够不到。
import { isKnownLocation, isValidTarget, detectStaleSquadRefs, canAutoExecute, decideBucket } from "./autoExecuteGate";
import type { StandingOrder, StandingOrderType, DoctrinePriority } from "@ai-commander/shared";
import { CHANNEL_LABELS, collectUnitsUnder, judgePendingConsumption, parsePendingDecision, pendingVerdictRoute, buildProductionOptions, advisorFailureOf, advisorFailureLine } from "@ai-commander/shared";
import type { ProductionCategoryOptions } from "@ai-commander/shared";
import type { PendingRequestTag } from "@ai-commander/shared";
// 刀癸 — 跨局/延迟回调的局印（守局次与对象身份，不守游戏时间）
import { stampRun, runGuardAllows, judgeRunGuard, type RunStamp } from "@ai-commander/shared";
// 刀己 — 候选选择合同：这层只需要请求侧那个标签的类型，判定全在 core
import type { SelectionRequestTag } from "@ai-commander/shared";
// retreat-scope 刀C — 台账登记用的来源标记
import type { DispatchMeta, DispatchSourceKind } from "@ai-commander/shared";
import type { LeaderProfile, LeaderPersonality } from "@ai-commander/shared";
import { armVoiceCapture, isVoiceCaptureSupported, isVoiceWarmEnabled, getVoiceOpenDiag, type VoiceRecording, type VoiceCaptureArm } from "./voiceRecorder";
import { probeVoiceChannels, channelUsesVoiceCapture, isBaselineArm } from "./voiceCapability";
import { RadioCallRow } from "./RadioCallRow";
import { TelegraphKey } from "./TelegraphKey";
import { MicIcon, HornIcon } from "./InputRailIcons";
// spoken 层：一个回合里耳朵听见什么，由这一个纯函数一次算完（R2 听觉序列）。
import { planVoiceSpeech } from "./voiceSpeech";
import { buildExecReceipt, buildExecFeedback, type DispatchSlice } from "./execReceipt";
import { cloneSelectionOption, optionWithResolvedIntents, selectionEnvelope } from "./selectionOption";
import { setPlaybackObserver } from "./tts";
import { shouldRecordSpeechDiag, type ReleaseMark } from "./speechDiagGate";
import {
  addMessage,
  updateLastPlayerMessage,
  getActiveChannel,
  setActiveChannel,
  getGroupChatMessages,
  getLastMessageTimeBySource,
  getMessages,
  getSeenUtteranceId,
  markUtterancesSeen,
  getMessagesByChannel,
  getActiveThreads,
  resolveThread,
  dismissThread,
  getActiveEscalation,
  clearEscalation,
  subscribe,
  CHANNEL_PERSONA,
  type FeedMessage,
  type MessageLevel,
  type MessageFrom,
  type StaffThread,
} from "./messageStore";
import { speak, flush, cancel, speakUtterance, isBusy, type Persona } from "./tts";
import { shouldSpeakMessage, spokenKey, isDeferrable, personaOf, type SpeakContext } from "./proactiveSpeech";
import { decideEscalationFollowup, pickNagLine, EXPIRE_FALLBACK, type EscalationWatch } from "./nagContract";
import { API_URL } from "./api";
import { SESSION_ID } from "./session";

// ── 0.3: Commander ↔ Channel mapping ──

type Commander = "chen" | "marcus" | "emily";
const COMMANDERS: Commander[] = ["chen", "marcus", "emily"];

const COMMANDER_CHANNEL: Record<Commander, Channel> = {
  chen: "combat",
  marcus: "ops",
  emily: "logistics",
};

const COMMANDER_META: Record<Commander, { label: string; role: string; avatar: string }> = {
  chen: { label: "陈军士", role: "战斗", avatar: "⚔️" },
  marcus: { label: "马克斯上尉", role: "作战", avatar: "🎖️" },
  emily: { label: "艾米莉中尉", role: "后勤", avatar: "📦" },
};

/** 侧栏刀 步1: 第二页签的名字跟频道走——侧栏＝当前参谋的领域参考。
 *  陈的「编制 ☰」字形不动（教程里那句指路逐字指着它）。 */
const PANEL_TAB_LABEL: Record<Commander, string> = {
  chen: "编制 ☰",
  marcus: "计策",
  emily: "军械",
};

/** v4 §6c-3c: the slice of COMMANDER_META the core reference predicate needs.
 *  Passed in rather than moved to shared — avatar/role are UI data and have no
 *  business in the engine (minimal-change ruling). */
const COMMANDER_REFS: readonly CommanderRef[] = COMMANDERS.map((c) => ({
  key: c,
  label: COMMANDER_META[c].label,
}));

/** Map LLM "from" field back to Commander key */
const FROM_TO_COMMANDER: Record<string, Commander> = {
  chen: "chen",
  marcus: "marcus",
  emily: "emily",
};

// ── Voice confirmations per commander personality ──
const VOICE_CONFIRMS: Record<Commander, string[]> = {
  chen: [
    "收到。", "明白。", "执行。", "这就办。",
    "照办，长官。", "是，长官。", "依令。", "动手。",
  ],
  marcus: [
    "领会，长官。", "明白，即刻协调。", "方案已记录。",
    "按您的指示办。", "参谋部已备案。", "这就去安排。",
  ],
  emily: [
    "收到，安排。", "已记录，马上办。", "资源调配中。",
    "依令调度。", "物资已准备。", "这就处理。",
  ],
};
function pickVoiceConfirm(commander: Commander): string {
  const pool = VOICE_CONFIRMS[commander];
  return pool[Math.floor(Math.random() * pool.length)];
}

/**
 * 复呼／甩脸的时值（游戏秒）。**可被 URL 覆写**，只为台架不真等两分钟：
 *   ?nag=2&expire=5
 * ★这两个是本刀自己的新常量，与引擎的 ESCALATION_WINDOW_SEC / TICKET_TTL_SEC
 *   **是两码事，一个字节都不许碰那两个**（后者在 6b 禁改区）。
 * ★expire 覆写只是"提前把这张单当作已过期看"的**台架捷径**：不写这个参数时，
 *   过期的唯一真相源仍然是引擎 TTL（getActiveEscalation 返回 null），本刀不自数。
 */
/**
 * ★5b：本刀自己的两个时值参数**只在 DEV 生效**。它们是台架捷径，不该随生产包
 * 发出去——`?expire=` 尤其：它只改本刀的 followup 判定、不动引擎 TTL，玩家敲一个
 * 短值会造出"嘴说不等了、账本上这张单还能再执行一百多秒"的口径分裂。
 * （既有的 ?webspeech / ?novoicewarm 是别的刀的实验旗，一个字不碰。）
 */
function readSecParam(name: string, fallback: number | null): number | null {
  if (!import.meta.env.DEV) return fallback;
  try {
    const raw = new URLSearchParams(window.location.search).get(name);
    if (raw == null) return fallback;
    const n = Number(raw);
    return Number.isFinite(n) && n >= 0 ? n : fallback;
  } catch {
    return fallback;
  }
}
/**
 * 板 1 落地：喇叭默认仍关，但**记住长官的选择**（用户裁定：默认关＋持久化＋
 * 首局陈请开电台）。★读写各自 try/catch——隐私模式下裸调 localStorage 会在
 * **渲染期**抛错，而全仓没有 ErrorBoundary＝整个面板白屏，比"记不住"严重得多。
 * 键名走 `voice.` 前缀族（与既有的 voice.novoicewarm 同族），不新建 storage 封装。
 */
const TTS_PREF_KEY = "voice.ttsEnabled";
const RADIO_PROMPTED_KEY = "voice.radioPrompted";
function readTtsPref(): boolean {
  // ★ 默认**开着**（用户 2026-09-13：「这个音响，能不能确保最开始是开着的？」）。
  //   原来读不到就当关 ⇒ 新玩家第一次进来是哑的，而"参谋会主动跟你讲话"正是本作
  //   要验证的那件事——默认哑掉等于把核心体验藏起来。
  //   只有玩家**明确关过**（存了 "0"）才关；读不到、存储不可用，都当开。
  try {
    const raw = window.localStorage.getItem(TTS_PREF_KEY);
    return raw === null ? true : raw === "1";
  } catch { return true; }
}
function writeTtsPref(v: boolean): void {
  try { window.localStorage.setItem(TTS_PREF_KEY, v ? "1" : "0"); } catch { /* 记不住就记不住 */ }
}
function hasRadioPrompted(): boolean {
  try { return window.localStorage.getItem(RADIO_PROMPTED_KEY) === "1"; } catch { return true; }
}
function markRadioPrompted(): void {
  try { window.localStorage.setItem(RADIO_PROMPTED_KEY, "1"); } catch { /* noop */ }
}

/** 首局那句「请开电台」的存活窗口（游戏秒）：过了就不再脉冲（"过期"那一半）。 */
const RADIO_PROMPT_TTL_SEC = 90;

const NAG_AFTER_SEC = readSecParam("nag", 30) ?? 30;
const EXPIRE_OVERRIDE_SEC = readSecParam("expire", null);

// ── Phase 1: Shared intent target validator (from CommandPanel) ──

/**
 * Clear target fields that reference non-existent locations/facilities so the
 * intent can still execute on its remaining valid fields. The prior behavior
 * blanket-rejected the entire intent if ANY target field was hallucinated by
 * the LLM (e.g. "tag_hq_perimeter" with no such tag in state.tags). Now the
 * bogus field is silently cleared with a warning and the intent proceeds on
 * whichever fields are still valid.
 *
 * If every target field was bogus, the intent still falls through to
 * resolveIntent, which returns a clean "无法确定目标" diagnostic — a gentler
 * degradation than a blunt UI-layer reject that forces the player to retype.
 *
 * Mirrors the softer-than-strict architecture of the existing fromSquad
 * soft-fix in handleApprove / thread approval.
 */
function softFixTargetFields(
  intent: Intent,
  state: GameState,
  warn: (field: string, value: string) => void,
): void {
  if (intent.targetRegion && !isKnownLocation(intent.targetRegion, state)) {
    warn("targetRegion", intent.targetRegion);
    intent.targetRegion = undefined;
  }
  if (intent.targetFacility) {
    const trimmed = intent.targetFacility.trim();
    const hint = trimmed.toLowerCase();
    let found = trimmed.length > 0 && state.facilities.has(intent.targetFacility);
    if (!found && trimmed.length > 0) {
      for (const [, f] of state.facilities) {
        if (
          f.id.toLowerCase() === hint ||
          f.name.toLowerCase().includes(hint) ||
          f.tags.some(t => t.toLowerCase().includes(hint))
        ) {
          found = true;
          break;
        }
      }
    }
    if (!found) {
      warn("targetFacility", intent.targetFacility);
      intent.targetFacility = undefined;
    }
  }
  if (intent.toFront && !isKnownLocation(intent.toFront, state)) {
    warn("toFront", intent.toFront);
    intent.toFront = undefined;
  }
  if (intent.fromFront && !isKnownLocation(intent.fromFront, state)) {
    warn("fromFront", intent.fromFront);
    intent.fromFront = undefined;
  }
}

// Step 5 — high_impact local confirmation. Deterministic, frontend-only word lists
// (user-specified). A pending high_impact action executes directly on a confirm
// word — with NO fresh LLM call, which would re-emit the same unscoped intent and
// re-trigger high_impact (the confirm loop). A cancel word drops the pending.
// NEVER EXPAND — semantic fallback owns natural language (Codex preflight
// round-2 #4). These are a CLOSED literal shortcut for instant local confirm;
// ANY word-list miss goes to the LLM pendingDecision pass. No new synonyms,
// no regex, no additions on test failure — ever.
const HIGH_IMPACT_CONFIRM_WORDS = ["确认", "是", "对", "执行", "同意", "可以", "行", "yes", "ok"];
const HIGH_IMPACT_CANCEL_WORDS = ["不", "否", "取消", "算了", "no", "cancel"];
const HIGH_IMPACT_CONFIRM_WINDOW_SEC = 120;

// ── retreat-scope 刀C: 这条意图是**怎么**指出这批人的（台账的 provenance）──
// 台账要记下来源，否则「之前从南线派出去那批」将来无从匹配。判定只看字段在不在，
// 不看地名、不看措辞——对任何图成立。
function dispatchSourceOf(
  intent: Intent,
  selectedUnitIds: readonly number[] | undefined,
): { sourceKind: DispatchSourceKind; sourceKey: string } {
  if (intent.fromDispatch) return { sourceKind: "dispatch", sourceKey: intent.fromDispatch };
  if (intent.fromSquad) return { sourceKind: "squad", sourceKey: intent.fromSquad };
  if (intent.fromFront) return { sourceKind: "front", sourceKey: intent.fromFront };
  if (selectedUnitIds && selectedUnitIds.length > 0) return { sourceKind: "selection", sourceKey: "" };
  return { sourceKind: "pool", sourceKey: "" };
}

function normalizeReply(s: string): string {
  return s.trim().toLowerCase().replace(/[。.!！?？,，、\s]+$/g, "");
}
function isConfirmReply(s: string): boolean {
  return HIGH_IMPACT_CONFIRM_WORDS.includes(normalizeReply(s));
}
function isCancelReply(s: string): boolean {
  return HIGH_IMPACT_CANCEL_WORDS.includes(normalizeReply(s));
}

// 7c.1-stab (Fix 3): a small decline/defer set for DISMISSING an active escalation
// (a confirm/cancel-style mechanism, NOT command-keyword enumeration — we never
// parse an execution action out of these). A reply that opens with one of these
// means the player is waving off the question, so the escalation must be cleared
// or it bleeds into the next, unrelated command. Leading-match (not exact) because
// a real decline is usually phrased as a fuller sentence.
const ESCALATION_DECLINE_WORDS = ["不用", "暂时不用", "先不用", "别管", "先观察", "不处理", "先不动"];
function isDeclineReply(s: string): boolean {
  const n = normalizeReply(s);
  return ESCALATION_DECLINE_WORDS.some((w) => n.startsWith(w));
}

// Step 5: build the one-line question/concern for a gated command (buckets B & C).
// It embeds the advisor's brief (the concrete unit+target+task) so the player's
// short "确认"/"对" resolves via the prompt's SHORT FOLLOW-UP RESOLUTION rule.
// Bucket C (high_impact only) voices a concern + asks for a yes (resolved locally
// via the pending-confirm path, not a fresh LLM call); bucket B (ambiguous /
// missing target / wrong squad) asks for a clarification.
function buildGateQuestion(reason: string | undefined, brief: string, staleRefs: string[], plan?: string): string {
  const lead = brief ? brief.trim() : "";
  if (staleRefs.length > 0) {
    return `${lead ? lead + " " : ""}⚠ 这条引用的 ${staleRefs.join("、")} 已不在编 —— 确认要继续，还是另指部队？`;
  }
  switch (reason) {
    case "high_impact":
      // Polish: staff-voiced risk reminder, no robot meta-hint ("回'确认'执行").
      // Copy only — the deterministic confirm gate (HIGH_IMPACT_CONFIRM_WORDS +
      // pendingContractRef) is unchanged: an in-list affirmative executes the
      // saved option locally; any other reply falls through to the normal
      // command flow, so "直接改令" was already mechanically true.
      // ★第八轮：这一问是引擎发起的批准——长官点头批的就是存下的那份方案，所以问句由**那份方案**
      //   逐条生成（plan＝core.describePlanForApproval），不再拿模型的 brief 当开头（它可能只说了其中一条）。
      return `要办的是：${plan ?? "（方案缺失）"}——其它方向就空了。照打还是留兵，您一句话。`;
    case "no_selected_units":
      return `您说的"选中的部队"我没看到选中任何单位 —— 请先框选，或直接说明哪支部队。`;
    case "invalid_intent_fields":
      return `${lead || "命令目标不存在或不明确"} —— 请确认目标或重述。`;
    case "anchor_mismatch":
      return `${lead || "您指定的部队和我理解的可能不一致"} —— 请确认是哪支部队。`;
    default:
      return `${lead || "这条命令我需要再跟您确认一下"} —— 请确认或重述。`;
  }
}

// ── Day 16B: Context Memory (from CommandPanel) ──

const MAX_CONTEXT_ENTRIES = 3;
const MAX_CONTEXT_CHARS = 600;

interface ContextEntry {
  role: "user" | "assistant";
  text: string;
  time: number;
}

type ChannelContext = Record<Channel, ContextEntry[]>;

function createEmptyChannelContext(): ChannelContext {
  return { ops: [], logistics: [], combat: [] };
}

function pushContext(ctx: ChannelContext, channel: Channel, entry: ContextEntry): void {
  const arr = ctx[channel];
  arr.push(entry);
  while (arr.length > MAX_CONTEXT_ENTRIES * 2) arr.shift();
  let total = arr.reduce((s, e) => s + e.text.length, 0);
  while (total > MAX_CONTEXT_CHARS && arr.length > 0) {
    total -= arr[0].text.length;
    arr.shift();
  }
}

function formatContext(ctx: ChannelContext, channel: Channel): string {
  const arr = ctx[channel];
  if (arr.length === 0) return "";
  const lines = arr.map((e) => `[${e.role === "user" ? "指挥官" : "参谋"}] ${e.text}`);
  return "\n---CONTEXT---\n" + lines.join("\n");
}

const CHANNEL_LABEL: Record<Channel, string> = {
  combat: "Chen/combat",
  ops: "Marcus/ops",
  logistics: "Emily/logistics",
};

/** Merge all channel histories into a compressed summary for group chat */
function formatGroupContext(ctx: ChannelContext): string {
  const lines: string[] = [];
  for (const ch of ["ops", "combat", "logistics"] as Channel[]) {
    const arr = ctx[ch];
    if (arr.length === 0) continue;
    for (const e of arr) {
      const speaker = e.role === "user" ? "指挥官" : CHANNEL_LABEL[ch];
      // Truncate long entries to keep prompt compact
      const text = e.text.length > 120 ? e.text.slice(0, 117) + "..." : e.text;
      lines.push(`[${speaker}] ${text}`);
    }
  }
  if (lines.length === 0) return "";
  return "---各频道近期通信---\n" + lines.join("\n");
}

// ── Helpers ──

function formatTime(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

// 步 7 · 页底风格条（弹窗态独有）。顺序钉死 r/f/o/c/s，与 styleRows 同序。
// ★ 底色按下标映射，不按中文 label：label 是显示文字，绑措辞则将来改一个字
//   颜色就静默串位，而五条底色没有断言能发现串位。
const STYLE_KEYS = ["r", "f", "o", "c", "s"] as const;
const STYLE_BAR_COLORS = ["cyan", "amber", "green", "purple", "yellow"] as const;
const STYLE_FLASH_MS = 1200;

const FROM_LABELS: Record<string, string> = {
  chen: "陈军士",
  marcus: "马克斯",
  emily: "艾米莉",
  player: "指挥官",
  system: "系统",
};

const FROM_COLORS: Record<string, string> = {
  chen: "#ef4444",
  marcus: "#60a5fa",
  emily: "#4ade80",
  player: "#e2e8f0",
  system: "#64748b",
};

const FROM_AVATARS: Record<string, string> = {
  chen: "⚔️",
  marcus: "🎖️",
  emily: "📦",
  player: "🎯",
  system: "⚙️",
};

// Step 3: a feed message is a "system report" (vs conversation) iff it comes from
// a non-conversational source. Classify by `source`/`from` — NEVER assume a
// persona `from` means conversation: addMessage auto-wraps event_report / heartbeat
// with a channel persona. Only command_ack / player are conversation.
function isReportMessage(msg: FeedMessage): boolean {
  return msg.source === "heartbeat" || msg.source === "event_report"
    || msg.source === "system" || msg.from === "system";
}

// Low-key report line: dimmed, small, no avatar; urgent → amber standout.
// Shared by the embedded inline lane and the detached battle-report panel.
function renderReportLine(msg: FeedMessage) {
  const urgent = msg.level === "urgent";
  return (
    <div key={msg.id} style={{
      ...reportLineStyle,
      borderLeft: `2px solid ${urgent ? "var(--hud-accent-amber)" : "var(--hud-border-base)"}`,
    }}>
      <span style={timeTagStyle}>{formatTime(msg.time)}</span>
      <span style={{
        color: urgent ? "var(--hud-accent-amber)" : "var(--hud-text-dim)",
        fontSize: 11,
        fontWeight: urgent ? 600 : 400,
      }}>{msg.text}</span>
    </div>
  );
}

// Circular portrait avatars for the three advisors (PNG in apps/web/public/avatars/).
const AVATAR_IMG: Record<Commander, string> = {
  chen: "/avatars/chen.png",
  marcus: "/avatars/marcus.png",
  emily: "/avatars/emily.png",
};

function CmdAvatar({ cmd, size, ring }: { cmd: Commander; size: number; ring: string }) {
  return (
    <img
      src={AVATAR_IMG[cmd]}
      alt=""
      style={{ width: size, height: size, borderRadius: "50%", objectFit: "cover", border: `2px solid ${ring}`, display: "block", flexShrink: 0 }}
    />
  );
}

// ── Presence Step C: PLAYER_VIEW envelope block ──
// Assembled HERE, not inside the digest builders, so BOTH routes (DigestV1
// and BattleContextV2) carry it while the builders' existing sections stay
// byte-untouched. Selected ids ride the envelope's own ---PLAYER_SELECTED---
// section wherever the route renders one; only a route without that section
// (BattleContextV2) receives them through PLAYER_VIEW — judged by looking at
// the built envelope itself, never by re-deriving the route decision
// (digestHelper owns that decision alone).
function buildPlayerViewContext(
  state: GameState,
  baseDigest: string,
  view: ViewportGeometry | null,
  selectedIds: number[],
): string {
  if (!view) return "";
  const idsForView = baseDigest.includes("---PLAYER_SELECTED---") ? [] : selectedIds;
  const lines = buildPlayerViewLines(state, view, idsForView);
  return lines.length > 0 ? `\n${lines.join("\n")}` : "";
}

// ── Props ──

interface Props {
  getState: () => GameState | null;
  getSelectedUnitIds?: () => number[];
  /** Presence Step C: raw viewport geometry from the render layer (null until ready). */
  getViewport?: () => ViewportGeometry | null;
  onCreateSquad?: (owner: "chen" | "marcus" | "emily", choice?: { leaderName: string | null }) => void;
  canCreateSquad?: () => boolean;
  /** 教学引导：这一步该点哪个键（null＝不提示）。 */
  /** 教学引导：这一步要点亮的目标（`btn:*` / `chan:*` / `hud:*` 归本组件认领）。 */
  getGuideTargets?: () => readonly string[];
  /** 玩家真发出一条消息时喊一声（教学关用）。 */
  onPlayerSpoke?: (ch: Channel) => void;
  /** 玩家点开第二页签（艾米莉那儿＝军械）时喊一声（教学关用）。 */
  onOpenPanelTab?: (ch: Channel) => void;
  /** 参谋正在回话（流式还没完）。教学引导拿它决定"要不要先别说下一句"。 */
  onAdvisorBusy?: (busy: boolean) => void;
  /** 名册上此刻派得出去的将军（点将弹窗的内容）。缺省＝没接（走引擎自动挑）。 */
  getAssignableLeaders?: () => LeaderProfile[];
  onDeclareWar?: () => void;
  onSelectUnits?: (unitIds: number[]) => void;
  onMoveSquad?: (squadId: string, newParentId: string) => void;
  onRemoveFromParent?: (squadId: string) => void;
  onRenameLeader?: (squadId: string, newName: string) => void;
  onTransferSquad?: (squadId: string, newOwner: "chen" | "marcus" | "emily") => void;
  isDetached?: boolean;
}

interface DisplayResponse extends AdvisorResponse {
  warning?: string;
}

// UI 简化 V1 步1：快捷购买键下架——只藏按钮，造兵能力仍在（走 Emily 对话）。
// round 2 要开回改 true 即可；handleProduce 与按钮 JSX 全保留。
const SHOW_QUICK_BUY = false;


export function ChatPanel({ getState, getSelectedUnitIds, getViewport, onCreateSquad, canCreateSquad, getGuideTargets, onPlayerSpoke, onOpenPanelTab, onAdvisorBusy, getAssignableLeaders, onDeclareWar, onSelectUnits, onMoveSquad, onRemoveFromParent, onRenameLeader, onTransferSquad, isDetached }: Props) {
  // ── Panel collapse state ──
  const [collapsed, setCollapsed] = useState(false);

  // ── Tab state: "chat" or "panel" ──
  // 侧栏刀 步1: "panel" ＝「本频道的第二页签，不管它叫什么」——陈是编制树，
  // 马克斯是计策，艾米莉是军械。原来叫 "org" 时页签内容与频道无关，停在编制页
  // 切到马克斯会照旧渲染陈的部队树（串台）。
  const [activeTab, setActiveTab] = useState<"chat" | "panel">("chat");

  // ── Commander selection state ──
  const [selectedCommanders, setSelectedCommanders] = useState<Commander[]>(["chen"]);
  const isGroupChat = selectedCommanders.length > 1;
  const isChenChannel = !isGroupChat && selectedCommanders[0] === "chen";
  // 群聊没有第二页签（领域参考是某一个参谋的，不是三人共有的）。判据用
  // isGroupChat（length>1）而不是 length===3：右键 toggleCommander 能选出两人组，
  // 写 ===3 会漏网。
  const channelHasPanel = !isGroupChat;
  // 渲染时钳位，不用 useEffect 重置：activeTab 本身留着不动，所以切到群聊只是
  // 这一帧显示对话（无闪帧），从艾米莉切回陈还记得他刚才停在编制页。
  const effectiveTab: "chat" | "panel" = channelHasPanel ? activeTab : "chat";

  // ── Message display state ──
  const [displayMessages, setDisplayMessages] = useState<readonly FeedMessage[]>([]);
  const scrollRef = useRef<HTMLDivElement>(null);

  // ── Command/response state ──
  const [message, setMessage] = useState("");
  const [loading, setLoading] = useState(false);
  const [response, setResponse] = useState<DisplayResponse | null>(null);
  const pendingGroupResponsesRef = useRef<{ data: DisplayResponse; channel: Channel; requestId: string }[]>([]);
  // Step 5: a high_impact action awaiting the player's local confirm word. Resolved
  // in sendCommand without a fresh LLM call (avoids the high_impact confirm loop).
  // 地基二: FULL pending contract with a phase machine. "voicing" = the concern
  // is not yet visible → NOTHING may consume (no informed consent before the
  // player has seen the warning); "awaiting_reply" = the only phase where the
  // literal fast path or the LLM pendingDecision may consume. Unique id +
  // channel + session are re-verified at consumption (judgePendingConsumption).
  /** v4 刀2b P1: set at send time on ANY bare confirm; consumed at applyOrders.
   *  The instrument behind 刀A's revival ruling. escalateId === null means no
   *  proposal was on the table — the Bucket A population itself (刀E §8 ⑧). */
  const bareConfirmExecRef = useRef<{ escalateId: string | null } | null>(null);
  const pendingContractRef = useRef<{
    id: string;
    phase: "voicing" | "awaiting_reply";
    channel: Channel;
    sessionId: string;
    /** Game-run identity at creation — a contract never crosses a restart. */
    epoch: number;
    createdAt: number;
    expiresAt: number;
    opt: AdvisorOption;
    data: DisplayResponse;
    execCtx: ExecContext;
    summary: string;
    /** 刀寅（审核 B）：这份方案是参谋在本频道第几轮回复里问出来的（replyTurnOf）。 */
    createdTurn: number;
    /** 刀寅（审核 C）：引擎提出的修正方案要连同**已经选好的那一批**一起存；执行时照这份重新现查。 */
    selection?: SelectionProgress;
  } | null>(null);
  // 刀寅（审核 B）：**一次只挂一个问题**。每个频道记"参谋答到第几轮了"；待确认方案记下
  //   它是哪一轮问出来的。参谋之后只要又答了一轮（不管答的是什么），这份方案就不能再被
  //   一句「对」消费——长官那句「对」答的是最新那一问，不是翻篇之前的旧方案。
  //   同一次回复的重复投递（流断了走兜底）按请求编号去重，不算新一轮；通讯出错那一轮不算。
  const replyTurnRef = useRef<Partial<Record<Channel, { n: number; traceId: string }>>>({});
  const replyTurnOf = (ch: Channel): number => replyTurnRef.current[ch]?.n ?? 0;
  const bumpReplyTurn = (ch: Channel, tid: string) => {
    const cur = replyTurnRef.current[ch];
    if (cur && cur.traceId === tid) return;
    replyTurnRef.current[ch] = { n: (cur?.n ?? 0) + 1, traceId: tid };
  };
  // 第七轮：请求身份的幂等——同一个请求编号（traceId）的回复只处理一次（最近 32 个）。
  const handledRepliesRef = useRef<string[]>([]);
  const pendingSeqRef = useRef(0);
  const makePendingId = () => `pf-${Date.now().toString(36)}-${++pendingSeqRef.current}`;
  const [error, setError] = useState<string | null>(null);
  const [approvedIdx, setApprovedIdx] = useState<number | null>(null);
  const [clarification, setClarification] = useState<string | null>(null);
  const [declinedContext, setDeclinedContext] = useState<string | null>(null);
  const [streamingText, setStreamingText] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // ── Push-to-Talk state ──
  type PTTStatus = "idle" | "listening" | "error" | "unsupported";
  const SpeechRecCtor = typeof window !== "undefined"
    ? (window.SpeechRecognition ?? window.webkitSpeechRecognition ?? null)
    : null;
  const [pttStatus, setPttStatus] = useState<PTTStatus>(
    SpeechRecCtor || isVoiceCaptureSupported() ? "idle" : "unsupported",
  );
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const pttRecRef = useRef<any>(null);

  // ── 语音输入 V1：录音路（陈/Emily 的频道走这条，马克斯与群聊仍走 Web Speech）──
  // session 而不是裸 handle：长官可能在 getUserMedia 还没弹完权限就松手，
  // 那一下必须把还没到手的录音也取消掉，否则麦克风一直开着。
  // 刀 C：整局握着的那一件。`pressWantedRef` 记"手指还按着没"——设备还在路上时
  // 长官就松手的那一格，靠它把已经在飞的 arm 收回来。
  const voiceArmRef = useRef<VoiceCaptureArm | null>(null);
  const voiceArmingRef = useRef<Promise<VoiceCaptureArm | null> | null>(null);
  const pressWantedRef = useRef(false);
  // ── 动画R2 步 3：滑开取消 ──
  // pttPressed 只用来驱动"按住期间"的临时监听（Esc / window blur）；一切**判闸**
  // 走 ref——同 tick 内 setState 还没生效，用 state 判会放行不该放行的那一发。
  const [pttPressed, setPttPressed] = useState(false);
  const pttPressedRef = useRef(false);
  const [pttCancelIntent, setPttCancelIntent] = useState(false);
  const pttCancelIntentRef = useRef(false);
  const setPressed = useCallback((v: boolean) => { pttPressedRef.current = v; setPttPressed(v); }, []);
  const setCancelIntent = useCallback((v: boolean) => { pttCancelIntentRef.current = v; setPttCancelIntent(v); }, []);
  // Web Speech 臂取消时把输入框回滚到按下前那一刻：识别文字是边听边实时写进框里的，
  // 不回滚＝半句错令留在框里等着被下一次回车误发。
  const pttCancelledRef = useRef(false);
  const messageSnapshotRef = useRef<string | null>(null);
  // 步 5 · B3：马克斯的语音识别完是**模拟点击发送键**发出去的，与打字发送共用
  // 同一颗键。这个标记就是"这一发的来源"——电报机只认打字的那一发，语音的收尾
  // 归电台隐喻（呼叫行消失），两套隐喻不许串。
  const voiceAutoSendRef = useRef(false);
  // ── 延迟 A/B：松手 → 耳朵真听见（客户端自己量，搭下一次命令回服务端）──
  // 判据是"松手到出声"，而出声那一刻只有 TTS 模块知道。长官原话：「我真的不会去
  // f12 做这些，每次都整错」——**要长官去捞证据本身就是设计缺陷**（§8 那笔账的
  // 同一形状），所以这里自己量。两臂共用同一份构建 ⇒ 基线臂也照样自报。
  // ★步1：起点从裸时间戳换成「带回合号的 mark」，判定搬去 speechDiagGate（纯函数，
  //   node 台架够得到）。治的是 T3 那个真·现存 bug：无声回合的残值会被之后任意
  //   一回合的首声吃掉。`turn: null`＝还没有回合认领它。
  const releaseMarkRef = useRef<ReleaseMark | null>(null);
  /** 回合序号：sendCommand 每进一次自增；语音回合会把当前的 mark 认领到自己名下。 */
  const speechTurnRef = useRef(0);
  const speechDiagRef = useRef<{ firstSoundMs: number; text: string; baseline: boolean } | null>(null);
  /**
   * ★步1：取一次就清（原来只读不清）。原行为＝一次成功测量之后，**每一条命令**
   * 都把同一份样本再发一次（打字回合也照带，body 里那个字段是无条件拼的），
   * 直到下一次测量覆盖它；同一条命令走流式失败兜底时还会在一条命令里报两次。
   * 后果是纯统计污染：服务端日志里同一个数被重复计数，两臂的样本量与均值都偏。
   */
  const takeSpeechDiag = () => {
    const d = speechDiagRef.current;
    speechDiagRef.current = null;
    return d ?? undefined;
  };
  useEffect(() => {
    setPlaybackObserver((text, origin) => {
      const now = performance.now();
      if (!shouldRecordSpeechDiag({
        mark: releaseMarkRef.current,
        currentTurn: speechTurnRef.current,
        nowMs: now,
        origin,
      })) return;
      const t0 = releaseMarkRef.current!.at;
      releaseMarkRef.current = null;     // 一轮只记第一声
      speechDiagRef.current = {
        firstSoundMs: Math.round(now - t0),
        text: text.slice(0, 40),
        baseline: isBaselineArm(),
      };
    });
    return () => setPlaybackObserver(null);
  }, []);
  const sendVoiceRef = useRef<((v: VoiceRecording) => void) | null>(null);

  // 能力名单启动拉一次；拉不到就保持空名单＝全部走 Web Speech（fail-closed 回现状）。
  useEffect(() => { void probeVoiceChannels(); }, []);

  // ── TTS (Text-to-Speech) for streaming readback ──
  // Implementation lives in ./tts/* — ChatPanel only touches 3 functions
  // (speak / flush / cancel) imported above. Sentence buffer, queue,
  // generation tokens, fallback state all owned by the module.
  const hasTTS = typeof Audio !== "undefined" || (typeof window !== "undefined" && "speechSynthesis" in window);
  const [ttsEnabled, setTtsEnabled] = useState<boolean>(readTtsPref);
  /** 喇叭开关的唯一入口：两颗键（嵌入态／弹窗 dock）都走它，顺手落盘。 */
  const toggleTts = useCallback(() => {
    setTtsEnabled((prev) => {
      const next = !prev;
      writeTtsPref(next);
      if (!next) cancel(); // 关的时候把正在播的掐掉（原行为）
      return next;
    });
  }, []);

  /**
   * 刀 C：把麦克风握在手里。
   *
   * 预热开着（默认）＝开局第一个用户手势就握住，之后每次按下都是零启动；
   * 预热关掉（`?novoicewarm`）＝退回旧行为，按下才开设备——那是负对照臂。
   * 两条路共用同一个采集件，**只差 arm 的时点**。
   */
  const ensureVoiceArm = useCallback((): Promise<VoiceCaptureArm | null> => {
    if (voiceArmRef.current) return Promise.resolve(voiceArmRef.current);
    if (voiceArmingRef.current) return voiceArmingRef.current;
    const p = armVoiceCapture().then(
      (arm) => { voiceArmRef.current = arm; voiceArmingRef.current = null; return arm; },
      () => { voiceArmingRef.current = null; setPttStatus("error"); return null; },
    );
    voiceArmingRef.current = p;
    return p;
  }, []);

  // 开局预热（C2 并进 C1）：借第一个用户手势——浏览器只在手势里肯弹权限。
  // 一次性，拿到就摘监听。频道不收音 / 浏览器不支持 → 不碰麦克风。
  useEffect(() => {
    if (!isVoiceWarmEnabled() || !isVoiceCaptureSupported()) return;
    const warm = () => {
      document.removeEventListener("pointerdown", warm, true);
      if (isGroupChat) return;
      if (!channelUsesVoiceCapture(COMMANDER_CHANNEL[selectedCommanders[0]])) return;
      void ensureVoiceArm();
    };
    document.addEventListener("pointerdown", warm, true);
    return () => document.removeEventListener("pointerdown", warm, true);
  }, [ensureVoiceArm, isGroupChat, selectedCommanders]);

  // 卸载才真撒手（松手不撒手是本刀的本体）。
  useEffect(() => () => { voiceArmRef.current?.dispose(); voiceArmRef.current = null; }, []);

  const startPTT = useCallback(() => {
    if (loading) return;

    // 语音输入 V1：这个频道的耳朵吃得下音频、且浏览器录得了音 → 走录音路。
    // 群聊不在名单里（GROUP_SYSTEM_PROMPT 冻结），ops 也不在（deepseek 的脑子）。
    const voiceCh = COMMANDER_CHANNEL[selectedCommanders[0]];
    if (!isGroupChat && channelUsesVoiceCapture(voiceCh) && isVoiceCaptureSupported()) {
      // 按下即掐 TTS：陈的声音正从喇叭里出来，AEC 之外再加一道——
      // 让他的话被录进长官的命令里，是这条路独有的新病。
      cancel();
      pressWantedRef.current = true;
      // 步 3：置"按住中"必须在本臂的早退之后（上面的 if (loading) return），
      // 否则 loading 边界会留下一副永远摘不掉的 Esc/blur 监听。
      setPressed(true);
      void ensureVoiceArm().then((arm) => {
        // 设备还在路上时长官就松手了 ⇒ 这一按作废（预热臂上这一格几乎不发生，
        // 负对照臂上它就是常态——那正是这个病的形状）。
        if (!arm || !pressWantedRef.current) return;
        // ★C3 指示灯不许撒谎：只有 press() 真的进入 collecting 才亮 🔴。
        //   旧代码在这里无条件 setPttStatus("listening")，而设备还没开——
        //   长官看着红灯开口，说的话没人收。
        if (arm.press()) setPttStatus("listening");
      });
      return;
    }

    if (!SpeechRecCtor) return;
    // 步 3：同上，置位在本臂早退（上一行 unsupported）之后。
    setPressed(true);
    const rec = new SpeechRecCtor();
    rec.lang = "zh-CN";
    rec.interimResults = true;
    rec.continuous = true;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    rec.onresult = (e: any) => {
      let interim = "";
      let final_ = "";
      for (let i = 0; i < e.results.length; i++) {
        const r = e.results[i];
        if (r.isFinal) final_ += r[0].transcript;
        else interim += r[0].transcript;
      }
      setMessage(prev => {
        const base = prev.replace(/\u200B.*$/, ""); // strip previous interim
        if (final_) return base + final_ + (interim ? "\u200B" + interim : "");
        return base + (interim ? "\u200B" + interim : "");
      });
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    rec.onerror = (e: any) => {
      if (e.error === "not-allowed") setPttStatus("error");
      if (e.error !== "aborted") console.warn("[PTT] error:", e.error);
    };
    rec.onend = () => {
      // ★步 3 封口：abort() 之后 onend 照样 fire，且已 final 的文字可能非空——
      //   不在这里拦住，下面那段会把长官取消掉的半句话自动发出去。
      if (pttCancelledRef.current) {
        pttCancelledRef.current = false;
        const snap = messageSnapshotRef.current;
        if (snap !== null) setMessage(snap);   // 回滚到按下前那一刻，不是清空
        messageSnapshotRef.current = null;
        setPttStatus(s => (s === "error" ? s : "idle"));
        pttRecRef.current = null;
        return;                                 // 不自动发送、不点 [data-send-btn]
      }
      messageSnapshotRef.current = null;         // 正常收尾也把快照清掉，别留残值
      setMessage(prev => {
        const clean = prev.replace(/\u200B.*$/, "");
        // Auto-send if we got final text
        if (clean.trim()) {
          setTimeout(() => {
            const sendBtn = document.querySelector("[data-send-btn]") as HTMLButtonElement | null;
            // ★步 5 · B3 来源分流：标记必须钉在**这里**——setTimeout 回调体内、
            //   紧贴 click()。外头裹着两层（setMessage 的 state updater ＋ 这个
            //   50ms setTimeout）；写在 onend 函数体或 updater 里，标记会在 click
            //   真正发生前 50ms 就被清掉，分流直接失效。
            //   click() → onClick → sendCommand 首段同步跑完，所以 finally 里同步
            //   清掉就够（按钮 disabled 空点也不留残值）。
            voiceAutoSendRef.current = true;
            try { sendBtn?.click(); } finally { voiceAutoSendRef.current = false; }
          }, 50);
        }
        return clean;
      });
      setPttStatus(s => (s === "error" ? s : "idle"));
      pttRecRef.current = null;
    };
    pttRecRef.current = rec;
    setPttStatus("listening");
    // 步 3 快照点：必须在 rec.start() 之前抓——识别文字是边听边实时写进框里的。
    // startPTT 的闭包里没有新鲜的 message，用函数式 set 拿真值（React 对同值更新
    // 有 bail-out，不产生副作用）。
    setMessage(prev => { messageSnapshotRef.current = prev; return prev; });
    rec.start();
  }, [SpeechRecCtor, loading, selectedCommanders, isGroupChat, setPressed]);

  const stopPTT = useCallback(() => {
    setPressed(false);                          // 步 3：发送路径也必须落闸，否则
                                                // Esc/blur 监听留在身上不摘
    // 松手：计时起点（两臂同一处）。turn 先留 null——要等 sendCommand 里那个
    // **语音**回合把它认领走才算数；这一按若没发出去（太短/无声/解码失败），
    // 它就永远无人认领，不会再搭任何一回合的顺风车。
    releaseMarkRef.current = { at: performance.now(), turn: null };
    if (pressWantedRef.current) {
      pressWantedRef.current = false;
      const arm = voiceArmRef.current;
      const wasCollecting = !!arm?.snapshot().collecting;
      setPttStatus("idle");
      // 负对照臂（预热关掉）用完就撒手，下一次按下重新付设备开启的钱——
      // 这样"关掉修复"才真的等于旧行为，而不是"第一次慢、后面照样快"。
      const releaseDevice = () => {
        if (!isVoiceWarmEnabled()) { voiceArmRef.current?.dispose(); voiceArmRef.current = null; }
      };
      if (arm && wasCollecting) {
        void arm.release().then((rec) => {
          releaseDevice();
          // 太短/无声/解码失败 → rec 为 null，什么都不发（不猜、不发空包）。
          if (rec) sendVoiceRef.current?.(rec);
        });
      } else {
        // 设备还没到手就松手了：这一按作废，不产出、不发包。
        arm?.cancel();
        releaseDevice();
      }
      return;
    }
    if (pttRecRef.current) {
      pttRecRef.current.stop();
    }
  }, [setPressed]);

  /**
   * 步 3 · 取消这一按（两臂一函数）。滑出按钮范围松手 / Esc / pointercancel /
   * 切窗都走这里：**什么都不发**。
   *
   * ★真首行闸不许挪位、不许省。lostpointercapture 不是异常路径——规范规定
   *   pointerup 派发完浏览器隐式释放 capture 并补发它，**每次正常松手都响**。
   *   没有这道闸，cancelPTT 会紧跟着 stopPTT 再跑一遍：
   *     ① 清掉 stopPTT 刚写的 releaseMarkRef（延迟 A/B 探针对每个语音回合永久哑）；
   *     ② 落进 Web Speech 分支 abort 掉 pending 的 onend——马克斯每一次正常语音
   *        发送都会被自己的兜底网静默取消并回滚。
   *   修错位置（顺手删 lostpointercapture 兜底行）会把"异常丢 capture 时麦克风
   *   保持 unmuted"那个隐私逃生口一起删掉，所以闸钉在这里，兜底行不许删。
   */
  const cancelPTT = useCallback(() => {
    if (!pttPressedRef.current) return;         // ★真首行闸
    setPressed(false);
    setCancelIntent(false);
    // cancelPTT 不写计时起点，但残值也要清：stopPTT 首行那句 performance.now()
    // 是发送回合专属，取消回合不参与延迟 A/B，否则假 firstSoundMs 会搭下一次
    // 顺风车回服务端。
    releaseMarkRef.current = null;

    // 录音臂（含"设备还在路上"那一格：pressWantedRef 为真就算）
    if (pressWantedRef.current) {
      pressWantedRef.current = false;
      voiceArmRef.current?.cancel();            // 真丢弃 chunks，不产出、不发包
      // 与 stopPTT 的 releaseDevice 完全对齐：预热关掉就撒手，不然两条路
      // 对"下一次按下要不要重新付开设备的钱"给出不同答案。
      if (!isVoiceWarmEnabled()) { voiceArmRef.current?.dispose(); voiceArmRef.current = null; }
      setPttStatus(s => (s === "error" ? s : "idle"));
      return;
    }

    // Web Speech 臂：abort 后 onend 仍会 fire，回滚在那儿做（见 onend 头部封口）
    if (pttRecRef.current) {
      pttCancelledRef.current = true;
      pttRecRef.current.abort();
      return;
    }

    // 两臂都没挂上（按下与 arm 赋值之间的极窄同步窗口）：至少把灯收回来。
    setPttStatus(s => (s === "error" ? s : "idle"));
  }, [setPressed, setCancelIntent]);

  /**
   * 步 3 · 按住期间才挂的两副临时监听。
   *
   * Esc 走 **document capture 相 ＋ stopImmediatePropagation**：主窗 input.ts 的
   * Escape（释放选区）挂在 window 冒泡相（已核 `window.addEventListener("keydown",
   * onKeyDown)` 无 capture 参数），capture 相在它之前截断，长官取消录音时地图选区
   * 不会跟着被释放。弹窗态没有 GameCanvas，本就无此冲突。
   * 只在按住期间挂载，松手即摘——不留常驻监听。
   */
  useEffect(() => {
    if (!pttPressed) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopImmediatePropagation();
      cancelPTT();
    };
    // 切窗＝系统打断，与 pointercancel 同语义：取消，不发送。
    const onBlur = () => cancelPTT();
    document.addEventListener("keydown", onKey, true);
    window.addEventListener("blur", onBlur);
    return () => {
      document.removeEventListener("keydown", onKey, true);
      window.removeEventListener("blur", onBlur);
    };
  }, [pttPressed, cancelPTT]);

  // ── 步 3 · 两处 PTT 按钮共用的一套指针 handler（弹窗态/嵌入态对称）──
  const onPttPointerDown = useCallback((e: React.PointerEvent<HTMLButtonElement>) => {
    e.preventDefault();
    // 抓 capture：滑出按钮之后 move/up 仍然回到这颗键上，否则一出界就收不到事件、
    // 取消态永远判不出来。pointerId 已失效时会抛 NotFoundError——包起来，
    // 不许连累 startPTT（拿不到 capture 最多退化成不跟手，功能不塌）。
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* 拿不到就算了 */ }
    setCancelIntent(false);
    startPTT();
  }, [setCancelIntent, startPTT]);

  const onPttPointerMove = useCallback((e: React.PointerEvent<HTMLButtonElement>) => {
    if (!pttPressedRef.current) return;
    const r = e.currentTarget.getBoundingClientRect();
    // 微信手感：滑出去是"要取消"，滑回来可以反悔。
    const outside =
      e.clientX < r.left - PTT_CANCEL_SLOP || e.clientX > r.right + PTT_CANCEL_SLOP ||
      e.clientY < r.top - PTT_CANCEL_SLOP || e.clientY > r.bottom + PTT_CANCEL_SLOP;
    setCancelIntent(outside);
  }, [setCancelIntent]);

  const onPttPointerUp = useCallback((e: React.PointerEvent<HTMLButtonElement>) => {
    // ★这道闸是 pointerup 自己的，不能只靠 cancelPTT 里那道——这里要挡的是 stopPTT：
    //   Esc 取消后长官的手指还按在键上，随后必然来一发 pointerup。放行的话
    //   ① releaseMarkRef 被钉上假的计时起点，之后任何一次 TTS 出声都会被算成
    //      "这次已取消按下"的 firstSoundMs 送回服务端；
    //   ② Web Speech 臂会对已经 abort 掉的 recognition 再 stop() 一次。
    if (!pttPressedRef.current) return;
    // 早退跳过 release 无害：pointerup 之后浏览器本就隐式释放 capture。
    try { e.currentTarget.releasePointerCapture(e.pointerId); } catch { /* 已释放 */ }
    if (pttCancelIntentRef.current) cancelPTT(); else stopPTT();
  }, [cancelPTT, stopPTT]);

  const onPttPointerCancel = useCallback(() => {
    if (!pttPressedRef.current) return;
    // 系统夺走指针 ≠ 长官下令。旧行为是 stopPTT＝照发，半句错令直接出门，
    // 那正是本刀要治的病（有意手感变更，用户 2026-08-15 拍板）。
    cancelPTT();
  }, [cancelPTT]);

  const onPttLostCapture = useCallback(() => {
    // 每次正常松手浏览器都会补发这一发（pointerup 后隐式释放 capture），
    // 空转由 cancelPTT 的真首行闸挡住，不靠运气。异常丢 capture 时它才真咬：
    // 不兜则 collecting 卡在真、麦克风轨道保持 unmuted，踩 voiceCaptureState
    // 的隐私不变量「没按下 ⇒ 一个样本都不许留」。★此行不许删。
    cancelPTT();
  }, [cancelPTT]);

  // 取消态视觉的统一判据：按住中 ＋ 已滑出。两态同一个开关。
  const pttCancelArmed = pttPressed && pttCancelIntent;

  // 步 6：断言锚从"按钮文本"迁到这里。换皮之后按钮里是 SVG 没有文字，
  // 判据必须挂在**与皮无关的状态派生值**上。取消态优先，其余直接沿用 pttStatus
  // （于是 error/unsupported 也如实报出来，不被糊成 idle——超集，比规格更诚实）。
  const pttStateAttr = pttCancelArmed ? "cancel" : pttStatus;

  // ── 步 4 · 电报机敲键 ──
  // 挂 onChange 不挂裸 keydown：Shift/方向键不该响，粘贴一段字该响一串。
  // ★onChange 只被**真实 DOM 输入**触发；rec.onresult 那种 setMessage 是程序写入，
  //   走不到这里——「语音写字不敲电报键」的隔离是免费的（仍有断言盯着，隐喻不许串）。
  const [telegraphPulses, setTelegraphPulses] = useState(0);
  // 步 5：发报动画计数（B2）。一次真发送 +1，组件据此放一次性动画。
  const [telegraphTransmits, setTelegraphTransmits] = useState(0);
  const fireTransmit = useCallback(() => setTelegraphTransmits(t => t + 1), []);
  const handleTypedChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const next = e.target.value;
    // 旧值取闭包里的 message；长度差＝敲几下，至少 1 下（等长替换也算敲），
    // 上限 8（粘一整段响一串，但别响到天荒地老）。
    const delta = Math.abs(next.length - message.length);
    setTelegraphPulses(p => p + Math.min(Math.max(delta, 1), 8));
    setMessage(next);
  }, [message]);

  // P1: snapshot selected unit IDs at sendCommand time
  const selectedIdsSnapshotRef = useRef<number[] | undefined>(undefined);

  // Fix #2: execution context bound to each response (+ requestId for approve validation)
  // 7e.1: also carries escalateId — processAdvisorData clears the active escalation
  // BEFORE handleApprove runs (setTimeout / manual click / pending-confirm), so the
  // decision-review record can only learn "this answered a staff question" through
  // this context. All four approve paths (auto, bucket-A, manual, high_impact
  // confirm) receive the same execCtx, so the correlation survives every route.
  // ★刀癸 (审核 §六)：ExecContext 带上**来源局的印**（局次 + GameState 对象身份）。
  //   processAdvisorData 头上那道重开守卫是对的，但它**过了之后**还要
  //   `setTimeout(..., 0)` 才真去 handleApprove，而 ctx 里没有来源局的任何印记
  //   ——中间那一跳撞上重开一局，上一局的单子就落进新局。
  //   守局次与对象身份，**不守游戏时间**（新局钟从 0 起，按时间写的闸全失效）。
  type ExecContext = {
    channel: Channel; threadId?: string; requestId?: string; escalateId?: string;
    /** 出发那一刻的局印。缺席 ⇒ fail-closed，按作废处理。 */
    run?: RunStamp;
    /** 刀寅：本地对账日志的请求编号（纯观测）。 */
    traceId?: string;
    /** 刀寅：产生这份方案的那一句长官原话（打字＝原文，语音＝heard）。目的地忠实度用。 */
    playerText?: string;
    /**
     * 第六轮：这是模型**这一轮新写**的单子（自动执行 / 桶 A 那两处才带）。只有它要过
     * 「同一道令又下了一遍」那道判定；长官批准过的存档方案、答完问题执行的原命令都不带。
     * handleApprove 一进门就把它从要存下来的那份上下文里摘掉——存档方案永远不带它。
     */
    freshPlan?: boolean;
  };
  type SelectionProgress = {
    /** 玩家原先批准的完整 option；永远不把预检改写反灌回来。 */
    optionSnapshot: AdvisorOption;
    /** 已明确选过的稳定 key。名单在每轮及最终执行前统一现查。 */
    selectionKeys: DispatchSelectionKey[];
    requirements: DispatchSelectionRequirement[];
    /** 整道命令沿用首次提问的期限；转到下一问也不续命。 */
    expiresAt: number;
    selectedUnitIds?: number[];
    /** 原响应供 doctrine/复盘收尾；消歧不能把它丢掉。 */
    sourceResponse?: DisplayResponse;
    /** 原 option 下标，供批准动画/审计保持身份。 */
    optionIndex: number;
    /**
     * 第六轮：这道命令里**已经问过数量读法**的那几组（按组的身份，不按下标）。
     * 长官答过就不再问同一组；读法本身已经写进 optionSnapshot（total ⇒ 合成一条）。
     */
    quantityConfirmed?: string[];
  };
  const responseExecCtxRef = useRef<ExecContext | null>(null);
  // Tracks the latest valid requestId — approve buttons capture a snapshot of execCtx at
  // render time and pass it in; handleApprove compares against this ref to reject stale approvals.
  const latestRequestIdRef = useRef<string | null>(null);
  // 刀寅：正在处理的这一轮命令的对账编号（发出时生成，服务端与浏览器各层共用）。
  const traceIdRef = useRef<string | null>(null);


  // Day 16B: per-channel context memory
  const channelContextRef = useRef<ChannelContext>(createEmptyChannelContext());

  // Commander memory for battle context compression (consumed by buildBattleContextV2)
  const MAX_COMMITMENTS = 4;
  const commanderMemoryRef = useRef<Record<Channel, CommanderMemory>>({
    ops: { playerIntent: "", openCommitments: [] },
    logistics: { playerIntent: "", openCommitments: [] },
    combat: { playerIntent: "", openCommitments: [] },
  });
  const pushCommitment = (ch: Channel, text: string) => {
    const mem = commanderMemoryRef.current[ch];
    if (mem.openCommitments.includes(text)) return;
    mem.openCommitments.push(text);
    if (mem.openCommitments.length > MAX_COMMITMENTS) mem.openCommitments.shift();
  };
  const removeCommitment = (ch: Channel, text: string) => {
    const mem = commanderMemoryRef.current[ch];
    mem.openCommitments = mem.openCommitments.filter(c => c !== text);
  };

  // Phase 3: active staff threads
  const [activeThreads, setActiveThreads] = useState<StaffThread[]>([]);

  // Fix #1 + #3: atomic thread execution lock
  const executingThreadRef = useRef<string | null>(null);
  const [executingThreadId, setExecutingThreadId] = useState<string | null>(null);

  function tryLockThread(id: string): boolean {
    if (executingThreadRef.current) return false;
    executingThreadRef.current = id;
    setExecutingThreadId(id);
    return true;
  }
  function unlockThread(id: string): void {
    if (executingThreadRef.current === id) {
      executingThreadRef.current = null;
      setExecutingThreadId(null);
    }
  }

  // ── Subscribe to messageStore ──
  useEffect(() => {
    const update = () => {
      setActiveThreads(getActiveThreads());
      // Show messages for all selected commanders' channels
      if (selectedCommanders.length === 1) {
        const ch = COMMANDER_CHANNEL[selectedCommanders[0]];
        setDisplayMessages([...getMessagesByChannel(ch)]);
      } else {
        // Group (ALL): only show group-chat messages, not individual heartbeats/reports
        setDisplayMessages([...getGroupChatMessages()]);
      }
    };
    update();
    return subscribe(update);
  }, [selectedCommanders]);

  // ── 「请示要缠人」刀 · 主动台词出声（步 2 的心脏）──────────────────────
  //
  // 病：speak/flush 六个调用点全在 sendCommand 与 handleApprove 的闭包里，
  // 消息侧零接线 ⇒ 参谋主动开口的台词结构上从不发声。这个 hook 就是那条线。
  //
  // ★判闸**必须**在 effect 里跑，不许写进 subscribe 回调体内同步执行：
  //   GameCanvas 的发射点是 `addMessage(...)` 紧跟 `setActiveEscalation(...)`，
  //   而 addMessage 的 listeners 是**同步 fire** 的——在订阅回调里当场判闸，
  //   闸④（步 3 要查 escalation 还活着没）读到的必然是 null，陈的请示恒定不
  //   出声＝本刀的病换个姿势原样复发。订阅只翻一个计数，判闸留给 effect。
  const [feedTick, setFeedTick] = useState(0);
  useEffect(() => subscribe(() => setFeedTick((t) => t + 1)), []);
  /** 已播集合，键＝`${epoch}:${id}`（epoch 见 spokenKey 的注释：重开局 id 会从 1 复用）。 */
  const spokenRef = useRef<Set<string>>(new Set());
  const spokenPrimedRef = useRef(false);
  const spokenEpochRef = useRef<number | null>(null);
  // 出声闸读 ttsEnabled 走 ref：用依赖数组会让"开关喇叭"这个动作把 effect 重跑一遍，
  // 而重跑不该补播任何已经过去的话。
  const ttsEnabledRef = useRef(false);
  ttsEnabledRef.current = ttsEnabled;
  const loadingRef = useRef(false);
  loadingRef.current = loading;
  // 把"参谋正在回话"递给教学引导——它靠这个决定要不要先闭嘴。
  useEffect(() => { onAdvisorBusy?.(loading); }, [loading, onAdvisorBusy]);
  /**
   * 暂存队列。★**建在 tts 模块之外**：模块内的 queue 会被 cancel() 清空，而
   * cancel 恰恰在按下 PTT、打字回合起流、关喇叭这三处被调用——押后的话正好死在
   * 这些时刻。押在组件这边，cancel 碰不到。
   */
  const stashRef = useRef<FeedMessage[]>([]);

  /** 闸④⑤ 要吃的当下世界状态。主判定与释放前的重判共用同一处取值。 */
  const buildSpeakCtx = useCallback((m: FeedMessage): SpeakContext => {
    const s = getState();
    const nowGameTime = s?.time ?? 0;
    /**
     * 闸⑤ 收音窗——**三段真名，一个都不许少，也不许去复刻那个 300ms**：
     *   · `pttPressedRef.current`      手指还按着（两臂通吃的那一个）
     *   · `snapshot().collecting`      录音臂的采集态。release() 里那 300ms 尾窗
     *                                  （TAIL_GRACE_MS，voiceRecorder 模块私有）
     *                                  排在 stopCollecting() **之前**，所以尾窗内
     *                                  它仍为 true＝天然超集。读真状态，不抄常量。
     *   · `pttRecRef.current !== null` Web Speech 臂：onend 两个分支才置 null。
     * ★ `pttStatus` 不能用：stopPTT 在 arm.release() **之前**就把它打回 idle。
     */
    const capturing =
      pttPressedRef.current ||
      voiceArmRef.current?.snapshot().collecting === true ||
      pttRecRef.current !== null;
    return {
      nowGameTime,
      // 只有请示才查活单；其余 kind 传 undefined，闸④压根不读它。
      escalationAlive:
        m.utterance?.kind === "escalation"
          ? getActiveEscalation(m.channel, nowGameTime) !== null
          : undefined,
      capturing,
    };
  }, [getState]);

  /**
   * 放一段出去。★每段先走 cancel 协议（T2 解毒）：streamEngine 是模块级单变量、
   * 只在 cancel 里归零，一次 Edge 503 / autoplay 拒之后，**同一个人接着说的**
   * 下一段会被钉在 native 或 silent 上。释放条件里有 !isBusy()，所以这一下
   * cancel 不会掐到任何正在播的东西。
   */
  /**
   * 步 5e：应答上屏行的标记。**只为算未读**，不由钩子出声（kind==="reply" 在
   * proactiveSpeech 那边是终局 deny）。群聊不标——群聊回复按裁定不算未读。
   */
  const replyMark = useCallback((ch: Channel) => {
    const p = personaOf(CHANNEL_PERSONA[ch]);
    return p ? ({ persona: p, kind: "reply" } as const) : undefined;
  }, []);

  const releaseOne = useCallback((m: FeedMessage, persona: Persona) => {
    cancel();
    speakUtterance(m.text, persona);
  }, []);

  // ── 步 5：复呼／甩脸 ───────────────────────────────────────────────
  // （步 5d 撤销：这里原来有一句 soundManager.init()，是为弹窗态的到达提示音补的；
  //   提示音整件事已撤，ChatPanel 不再碰音效系统。）

  /**
   * 板 1 的第三件：首局让**陈自己开口**请长官打开电台（对话是唯一界面——提醒是
   * 角色行为，不是弹一个设置引导）。它同时替两个窗都挣到那次真实用户手势：
   * 主窗有教程遮罩兜着，而弹出面板**没有任何必点按钮**、`window.open` 也不继承
   * opener 的 user activation，第一声很可能撞上 autoplay 策略。
   * ★这句话自己**不带 utterance 标记**：喇叭还没开，念它是个悖论；fail-closed
   *   之下它天然只上屏不出声。
   */
  useEffect(() => {
    if (ttsEnabled) return;          // 已经开着就不啰嗦
    if (hasRadioPrompted()) return;  // 只在"首局新档"发生一次
    const s = getState();
    if (!s) return;
    markRadioPrompted();
    radioPromptRef.current = { at: s.time };
    setRadioPulse(true);
    addMessage("info", "长官，电台还没开——右下角那个喇叭点一下，我说话您就听得见了。",
      s.time, "combat", "chen", "command_ack");
    // 只跑一次：依赖留空是有意的（ttsEnabled 后续变化不该再触发这句）。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const escWatchRef = useRef<Record<Channel, (EscalationWatch & { question: string }) | null>>({
    ops: null, logistics: null, combat: null,
  });
  /**
   * 频道键上的记号。**三值**，因为视觉必须分两级：
   *   "pending" 有一张还在等长官回话的请示 → 闪
   *   "unread"  参谋对你说过话、你还没看到那一条 → **静态点，不闪**
   *   "none"    什么都没有
   * ★为什么不能只用一档：主动陈述十来秒就能来一条，未读若也用 1.1s 无限闪，
   *   频道键会常亮成背景噪音——那时候灯就不再是信息了。
   *
   * ★铁律：**凡出声 ⇒ 要么那句话当场就在你眼前，要么频道键上有记号。**
   *   （反过来不成立：不出声的东西不欠记号——proactive/retrospect/advice 与群聊
   *   回复都不点灯，用户 2026-08-16 裁定。）
   */
  const [channelAlert, setChannelAlert] = useState<Record<Channel, "none" | "unread" | "pending">>({
    ops: "none", logistics: "none", combat: "none",
  });
  /** 未读水位的打底（与出声侧 spokenPrimedRef 同形）：挂载/换局那一刻店里已有的
   *  参谋台词一律算"看过"，否则一挂载就满屏未读。 */
  const alertPrimedRef = useRef(false);
  const alertEpochRef = useRef<number | null>(null);
  /** 首局那句「请开电台」：脉冲**绑它的生命周期**，不是常驻 affordance。 */
  const radioPromptRef = useRef<{ at: number } | null>(null);
  const [radioPulse, setRadioPulse] = useState(false);

  /** 复呼／甩脸都由 ChatPanel 发射 ⇒ 弹窗态会真走跨窗口委托那行（第 8 参必须到得了）。*/
  const postFollowup = useCallback((ch: Channel, persona: Persona, kind: "nag" | "expire", line: string) => {
    const s = getState();
    if (!s) return;
    addMessage("warning", line, s.time, ch, undefined, "command_ack", undefined, { persona, kind });
  }, [getState]);

  /**
   * 甩脸走 LLM（审核决断点①：它承载内容与情绪，固定句正撞「台词禁死模板」判死的
   * 形态；而它只在 120s 空窗之后发生，多一次调用的延迟无所谓），拿不到就用兜底句。
   * 复用既有的 /api/brief 那条路，**不新增服务端 mode**（本刀纯 web 层）。
   */
  const fireExpire = useCallback((ch: Channel, persona: Persona, question: string) => {
    const fallback = EXPIRE_FALLBACK[persona];
    // ★5b/B1：异步回包必须带重开守卫（同文件应答链的既有形状）。6s abort 窗内
    //   长官重开一局 ⇒ 上一局的甩脸会投进新局。守 epoch 不守时间：postFollowup
    //   落地时重取 s.time，本来就盖掉了任何按时间写的迟到闸。
    const firedEpoch = gameEpochRef.current;
    const stillSameRun = () => {
      const s2 = getState();
      return !!s2 && syncGameEpoch(s2) === firedEpoch;
    };
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 6000);
    // ★步 5c（真模型实测后改）：digest **只描述处境，不递公文词**。
    //   原文写的是「未答请示已过期／到点作废了」，模型照抄那套register，于是
    //   ①句子变成系统日志腔（"请示已过期，我已按无令处置"）；②更要命的是
    //   **4/10 会凭空编战况**（"北线前哨已无我方成建制部队"——引擎从没说过，
    //   却用参谋的嗓子说出来，撞「禁虚构战况」铁律）。
    //   实测（真模型，N=10/组）：现行 4/10 编造；只改语气 0/10；只加"不许提
    //   战况"的约束句而留着公文腔 0/10 但仍是官腔。⇒ **编造是被报告体带出来的**，
    //   语气一改就没了，那条约束句在语气对了之后不承重，故不加（不堆无用规则）。
    //   ★末行不写"像个老兵那样说"之类的人设——那是给陈量身的，Emily（后勤中尉）
    //   与马克斯（上尉）会被带偏；persona 由服务端 retrospect 提示词自己带。
    const digest = [
      "[长官一直没回话]",
      `你刚才向长官报告过：「${question}」`,
      "你等了很久，他那边一直没动静。你不等了。",
      "用一句话告诉长官你打算怎么办：这事你先压着不动，等他想起来再说。",
      "按你平时跟长官说话的口气说，一句话，别提问，别把原话重复一遍。",
    ].join("\n");
    fetch(`${API_URL}/api/brief`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      // ★5b/B2：**必须传 mode**。不传 ⇒ 服务端落 briefMode="brief" ⇒ 用的是
      //   战报提示词（那条**明禁**首字 acknowledgment，而甩脸正是一句交代），
      //   而 web 侧唯一的守卫只有问号检测——一句合格战报（没有问号）会原样被
      //   当成甩脸念出去。retrospect 是三个兄弟里语义最贴的：一句话陈述、
      //   禁问句、禁建议，且甩脸本就是在复盘"这张单没等到回答"。
      body: JSON.stringify({ digest, channel: ch, mode: "retrospect" }),
      signal: ac.signal,
    })
      .then((r) => r.json())
      .then((d) => {
        clearTimeout(timer);
        if (!stillSameRun()) return; // 重开了：这句话属于上一局，丢掉
        const b = typeof d?.brief === "string" ? d.brief.trim() : "";
        // 问号校验同 proactive/retrospect：甩脸是**交代**，不是又抛一个问题。
        postFollowup(ch, persona, "expire", b && !/[？?]/.test(b) ? b : fallback);
      })
      .catch(() => {
        clearTimeout(timer);
        if (!stillSameRun()) return;
        postFollowup(ch, persona, "expire", fallback);
      });
  }, [postFollowup, getState]);

  useEffect(() => {
    const s = getState();
    const epoch = s ? syncGameEpoch(s) : gameEpochRef.current;
    // 换局＝集合作废重打底。旧局的键留着也只是浪费内存（前缀不同不会误判），
    // 但重开一局本就该重新打底：那一刻店里只剩「等待指令...」一条。
    if (spokenEpochRef.current !== epoch) {
      spokenRef.current.clear();
      stashRef.current.length = 0; // 换局：上一局押着的话不许带进新局
      // ★5b/P0-B：盯单的快照也必须跟着清。漏了它 ⇒ 重开局第一拍 live=null、
      //   w=上一局快照、lastPlayerMsgTime=null ⇒ 直接判 expire ⇒ **上一局的脸
      //   甩进新局**，还把上一局的问句逐字送进 LLM 请求；kind:"expire" 不查活单、
      //   age≈0 过新鲜度，闸④两道都拦不住。
      for (const c of ["ops", "logistics", "combat"] as Channel[]) escWatchRef.current[c] = null;
      spokenEpochRef.current = epoch;
      spokenPrimedRef.current = false;
    }
    const primed = spokenPrimedRef.current;
    // 全频道读（plan §4 裁定）：声音管"听得见"，闪烁管"看得见是哪个频道"——
    // 只读当前频道的话，长官在马克斯频道时陈的请示照样零声＝病只治一半。
    for (const m of getMessages()) {
      const key = spokenKey(epoch, m.id);
      if (spokenRef.current.has(key)) continue;
      // 首跑只打底：挂载/换局那一刻店里已有的消息一律视为"已播"，否则一挂载
      // 就把整个 backlog 从头念一遍。
      if (!primed) { spokenRef.current.add(key); continue; }
      const verdict = shouldSpeakMessage(m, buildSpeakCtx(m));
      // 到这儿这条消息就算"处理过了"，无论结局如何——押后的那些由暂存队列接手，
      // 不靠"留在集合外等下一次重扫"。
      spokenRef.current.add(key);
      if (!verdict.speak) {
        // ★可延后的 deny 进暂存队列（麦克风一松这句话仍然值得说，手测 6 的补播）；
        //   其余 deny 是终局的，到此为止。
        if (isDeferrable(verdict.reason) && ttsEnabledRef.current) stashRef.current.push(m);
        continue;
      }
      if (!ttsEnabledRef.current) continue;
      // ★仲裁：回合还在跑（loading）或喇叭还有活（isBusy）⇒ 押后，不抢话。
      //   isBusy 这一半是关键：setLoading(false) 落在流结束处，与音频队列毫无
      //   关系——一次应答的朗读常常还有好几句在队列里，只看 loading 就释放，
      //   等于把长官正在听的回答从中间掐断。
      if (loadingRef.current || isBusy()) { stashRef.current.push(m); continue; }
      releaseOne(m, verdict.persona);
    }
    spokenPrimedRef.current = true;
  }, [feedTick, getState, buildSpeakCtx, releaseOne]);

  // Auto-scroll to bottom on new messages
  //
  // ★ 依赖里必须有 `effectiveTab`（用户 2026-09-12 实拍：「点开编制，再点回通讯，
  //   就直接加载到最上面的对话」）。原因：切到编制页时这个滚动容器**整个卸载**，
  //   切回来是新挂的一个，`scrollTop` 自然是 0；而这期间 `displayMessages.length`
  //   一条没变 ⇒ 这个 effect 不触发 ⇒ 停在最顶上，长官得自己往下拖到今天。
  //   形状是"判据只盯着内容变没变，没盯着它自己有没有被重建"。
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [displayMessages.length, effectiveTab]);

  // 动画R2 步 2：呼叫行是渲染态插进流末尾的，displayMessages.length 不变 →
  // 上面那个滚底 effect 不会为它触发，长会话里行会落在视野外。复用同一句滚底，
  // 不用 scrollIntoView（它会连带滚动祖先容器，嵌入态在 HUD 里有位移风险）。
  useEffect(() => {
    if (pttStatus === "listening" && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [pttStatus]);

  // ── 步 2 点将弹窗 ──
  // 战场还在跑，所以它**不是模态框**：没有遮罩、不拦点击、Esc 可取消。
  // 只记锚点坐标与 owner；名单每次打开时现取（名册随编队实时变短）。
  // ★ 只存锚点，**不存名单**。名单必须每次渲染现算——
  //   缓存下来的名单会过期，玩家就可能选到一个已经被派出去的队长，
  //   于是两支队顶着同一个人，稀缺模型当场就破了。
  //   （落地那一侧 GameCanvas.handleCreateSquad 还有一道唯一性强制，双保险。）
  const [leaderPicker, setLeaderPicker] = useState<
    { owner: "chen" | "marcus" | "emily"; x: number; y: number } | null
  >(null);
  // 名单是从 ref 里现算的，React 不会因为它变了而重渲染；弹窗开着时定时打一拍，
  // 保证玩家看到的就是此刻真实可派的人。
  const [, setPickerTick] = useState(0);
  useEffect(() => {
    if (!leaderPicker) return;
    const id = setInterval(() => setPickerTick((n) => n + 1), 250);
    return () => clearInterval(id);
  }, [leaderPicker]);

  const openLeaderPicker = useCallback((owner: "chen" | "marcus" | "emily", e: React.MouseEvent) => {
    // 没接 getAssignableLeaders（例如被别的宿主复用）就退回步 1 的引擎自动挑，
    // 不弹窗、不报错——少一个可选依赖不该让"编队"这个基本操作失灵。
    if (!getAssignableLeaders) { onCreateSquad?.(owner); return; }
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    setLeaderPicker({ owner, x: r.left, y: r.top });
  }, [getAssignableLeaders, onCreateSquad]);

  const closeLeaderPicker = useCallback(() => setLeaderPicker(null), []);

  // Esc 取消 + 点别处取消。战场在跑，玩家随时可能想放弃这次编队。
  useEffect(() => {
    if (!leaderPicker) return;
    const onKey = (ev: KeyboardEvent) => { if (ev.key === "Escape") { ev.stopPropagation(); closeLeaderPicker(); } };
    const onDown = (ev: MouseEvent) => {
      if (!(ev.target as HTMLElement)?.closest?.("[data-leader-picker]")) closeLeaderPicker();
    };
    // capture 阶段接 Esc，抢在别的全局 Esc 处理（取消选择等）之前
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("mousedown", onDown);
    return () => { window.removeEventListener("keydown", onKey, true); window.removeEventListener("mousedown", onDown); };
  }, [leaderPicker, closeLeaderPicker]);

  const confirmLeader = useCallback((leaderName: string | null) => {
    if (!leaderPicker) return;
    onCreateSquad?.(leaderPicker.owner, { leaderName });
    setLeaderPicker(null);
  }, [leaderPicker, onCreateSquad]);

  // P2: poll canCreateSquad every 200ms
  // ★教学引导的脉冲**搭这口现成的轮询**，不新开计时器——它本来就是管「编队」键的。
  const [squadBtnEnabled, setSquadBtnEnabled] = useState(false);
  // 这一步要亮的目标集合。一个 Set 顶掉一堆布尔——加新目标不用再加一个 state。
  const [guideSet, setGuideSet] = useState<ReadonlySet<string>>(new Set());
  const onGuide = (t: string) => guideSet.has(t);
  useEffect(() => {
    if (!canCreateSquad) return;
    const id = setInterval(() => {
      setSquadBtnEnabled(canCreateSquad());
      // 引导没接（正式局）时 getGuideHint 缺席 ⇒ 恒 false，脉冲不会误伤正式局
      // 引导没接（正式局）时 getGuideTargets 缺席 ⇒ 恒空，脉冲不会误伤正式局
      const tg = getGuideTargets?.() ?? [];
      setGuideSet((prev) => {
        if (prev.size === tg.length && tg.every((t) => prev.has(t))) return prev;
        return new Set(tg);
      });
    }, 200);
    return () => clearInterval(id);
  }, [canCreateSquad, getGuideTargets]);

  // Day 13 P3-6: style visibility — poll style params at 1Hz
  const [showStyle, setShowStyle] = useState(false);
  const [styleSnapshot, setStyleSnapshot] = useState<{ r: number; f: number; o: number; c: number; s: number } | null>(null);
  useEffect(() => {
    const id = setInterval(() => {
      const s = getState();
      if (s) {
        setStyleSnapshot({
          r: s.style.riskTolerance,
          f: s.style.focusFireBias,
          o: s.style.objectiveBias,
          c: s.style.casualtyAversion,
          s: s.style.reconPriority,
        });
      }
    }, 1000);
    return () => clearInterval(id);
  }, [getState]);

  // 步 7: 值变闪红。玩家真实看到的一次风格变化是 ±STYLE_LEARNING_RATE=0.03
  // （50→53），3 个百分点的条宽肉眼不可见 —— 闪红是它被看见的唯一手段。
  // ★ prevRef 存的是"上一拍的五个数值"，比值不比对象：1Hz 轮询每拍都
  //   setStyleSnapshot({...}) 新建对象，比 identity 会变成每秒全条闪红。
  const stylePrevRef = useRef<{ r: number; f: number; o: number; c: number; s: number } | null>(null);
  const [styleFlash, setStyleFlash] = useState<Record<string, boolean>>({});
  const styleFlashTimersRef = useRef<Record<string, ReturnType<typeof setTimeout>>>({});
  useEffect(() => {
    // 只服务弹窗态页底风格条（嵌入态折叠条不碰）。
    if (!isDetached || !styleSnapshot) return;
    const prev = stylePrevRef.current;
    stylePrevRef.current = styleSnapshot;
    if (!prev) return; // 首拍不闪：没有"上一拍"就谈不上变过
    const changed = STYLE_KEYS.filter((k) => prev[k] !== styleSnapshot[k]);
    if (changed.length === 0) return;
    setStyleFlash((f) => {
      const next = { ...f };
      for (const k of changed) next[k] = true;
      return next;
    });
    // 每条自己的计时器：轮询每秒重跑本 effect，若把 timeout 挂在 effect
    // cleanup 上会被下一拍清掉，红色再也不退。
    for (const k of changed) {
      clearTimeout(styleFlashTimersRef.current[k]);
      styleFlashTimersRef.current[k] = setTimeout(() => {
        delete styleFlashTimersRef.current[k];
        setStyleFlash((f) => {
          const next = { ...f };
          delete next[k];
          return next;
        });
      }, STYLE_FLASH_MS);
    }
  }, [styleSnapshot, isDetached]);
  useEffect(() => {
    const timers = styleFlashTimersRef.current;
    return () => { for (const k of Object.keys(timers)) clearTimeout(timers[k]); };
  }, []);

  // Production button state
  const [playerMoney, setPlayerMoney] = useState(0);
  const [playerQueueLen, setPlayerQueueLen] = useState(0);
  // 侧栏刀 步2: 军械页的数据源。GameState 是被引擎**原地 mutate** 的，对象身份
  // 不变 ⇒ 光靠 getState() 拿不到"变了"的信号；也不许赌 playerMoney 恰好跟着动
  // （兵营被拆而钱没动＝表说谎）。所以每拍算一份签名，只有内容真变了才换新对象。
  const [arsenalCategories, setArsenalCategories] = useState<ProductionCategoryOptions[] | null>(null);
  const arsenalSigRef = useRef<string>("");

  // Poll war declaration eligibility + clear panel on game over + detect restart + production state
  const lastSeenTimeRef = useRef(0);
  // Game-run identity: bumped whenever the GameState OBJECT is replaced.
  // Pending contracts record their epoch; every consumption path requires it
  // to match the CURRENT epoch.
  const gameEpochRef = useRef(0);
  const lastGameStateRef = useRef<GameState | null>(null);
  // Synchronous restart detection by OBJECT IDENTITY (Codex 地基三-fix-2):
  // the 200ms poll alone leaves a race window after restart. This runs at the
  // head of every consumption path, so a replaced GameState invalidates old
  // contracts BEFORE anything can consume them — even when the new clock is
  // 0 and nothing has expired.
  const syncGameEpoch = (s: GameState): number => {
    if (lastGameStateRef.current !== s) {
      if (lastGameStateRef.current !== null) {
        gameEpochRef.current++;
        pendingContractRef.current = null;
      }
      lastGameStateRef.current = s;
    }
    return gameEpochRef.current;
  };
  const [canDeclareWar, setCanDeclareWar] = useState(false);
  useEffect(() => {
    const id = setInterval(() => {
      const s = getState();
      setCanDeclareWar(!!s && s.phase === "CONFLICT" && !s.warDeclared && !s.gameOver);
      if (s) {
        setPlayerMoney(s.economy.player.resources.money);
        setPlayerQueueLen(s.productionQueue.player.length);
        // 军械页：引擎算，UI 只读。签名覆盖面板可能显示的一切（含设施闸 alive
        // 与每种的 now），所以打掉兵营这种"钱没动、表要变"的事也逃不掉。
        const prod = buildProductionOptions(s, "player").categories;
        const sig = JSON.stringify(prod);
        if (sig !== arsenalSigRef.current) {
          arsenalSigRef.current = sig;
          setArsenalCategories(prod);
        }
      }
      if (s?.gameOver && response) {
        setResponse(null);
        setApprovedIdx(null);
        setClarification(null);
      }
      if (s) syncGameEpoch(s); // object-identity restart guard (authoritative)
      if (s && s.time < lastSeenTimeRef.current - 5) {
        channelContextRef.current = createEmptyChannelContext();
      }
      if (s) lastSeenTimeRef.current = s.time;

      // ── 复呼／甩脸（同一口轮询，游戏钟；四条合同全在 decideEscalationFollowup）──
      if (s) {
        const now = s.time;
        const nextAlert: Record<Channel, "none" | "unread" | "pending"> = { ops: "none", logistics: "none", combat: "none" };
        const epochNow = gameEpochRef.current;
        // ★5b/B4：群聊那条回话也要消账。玩家消息只落 `primaryChannel`（ALL 模式下
        //   就是首位那人的频道，且带 groupChat 标记）⇒ 只按频道查的话，长官刚在
        //   群里说完话，另两个频道的活单照样复呼/甩脸＝本刀立案时最怕的
        //   「你答了他还骂你」。所以：本频道的玩家消息 ∪ 任何频道的群聊玩家消息。
        const feed = getMessages();
        let lastGroupPlayer: number | null = null;
        const lastPlayerByCh: Record<Channel, number | null> = { ops: null, logistics: null, combat: null };
        // 同时收 5b/B3 要的"这张单已经复呼过没有"——**从消息流读**，不只看 ref：
        // 弹窗二次挂载会拿到一个全新的 ref（nagged 复位）⇒ 同一张单被复呼第二次、
        // 收回面板再来第三次。消息流是跨 realm 共享的那份真相，洗不掉。
        const nagAtByCh: Record<Channel, number | null> = { ops: null, logistics: null, combat: null };
        // ★未读水位用的两个量：**比 id 不比 time**（游戏钟同一拍会有多条、暂停时还冻住）。
        const maxUttIdByCh: Record<Channel, number> = { ops: 0, logistics: 0, combat: 0 };
        const lastPlayerIdByCh: Record<Channel, number> = { ops: 0, logistics: 0, combat: 0 };
        let lastGroupPlayerId = 0;
        for (const m of feed) {
          if (m.from === "player") {
            if (m.groupChat) {
              lastGroupPlayer = Math.max(lastGroupPlayer ?? -Infinity, m.time);
              lastGroupPlayerId = Math.max(lastGroupPlayerId, m.id);
            }
            const cur = lastPlayerByCh[m.channel];
            lastPlayerByCh[m.channel] = cur == null ? m.time : Math.max(cur, m.time);
            lastPlayerIdByCh[m.channel] = Math.max(lastPlayerIdByCh[m.channel], m.id);
          } else if (m.utterance) {
            // 只数**带标记**的（＝会出声的那一族：escalation/nag/expire）。
            // 不出声的主动陈述/复盘/建议不点灯（用户裁定），群聊回复也不带标记。
            maxUttIdByCh[m.channel] = Math.max(maxUttIdByCh[m.channel], m.id);
            if (m.utterance.kind === "nag") {
              const cur = nagAtByCh[m.channel];
              nagAtByCh[m.channel] = cur == null ? m.time : Math.max(cur, m.time);
            }
          }
        }
        // 打底：挂载/换局各一次。
        const CHS = ["ops", "logistics", "combat"] as Channel[];
        if (alertEpochRef.current !== epochNow) { alertEpochRef.current = epochNow; alertPrimedRef.current = false; }
        if (!alertPrimedRef.current) {
          for (const c of CHS) markUtterancesSeen(c, maxUttIdByCh[c]);
          alertPrimedRef.current = true;
        }
        const viewingCh = selectedCommanders.length === 1 ? COMMANDER_CHANNEL[selectedCommanders[0]] : null;
        for (const ch of ["ops", "logistics", "combat"] as Channel[]) {
          const persona = personaOf(CHANNEL_PERSONA[ch]);
          if (!persona) continue;
          const raw = getActiveEscalation(ch, now); // ①引擎 TTL＝唯一真相源
          // 台架捷径（**只在 DEV 生效**，见 EXPIRE_OVERRIDE_SEC 的注释）：带了
          // ?expire= 才提前把它当作已过期看；不带就完全由引擎说了算。
          const live =
            EXPIRE_OVERRIDE_SEC != null && raw && now - raw.createdAt >= EXPIRE_OVERRIDE_SEC
              ? null
              : raw;
          const chLastPlayer = lastPlayerByCh[ch];
          const lastP =
            chLastPlayer == null ? lastGroupPlayer
            : lastGroupPlayer == null ? chLastPlayer
            : Math.max(chLastPlayer, lastGroupPlayer);
          const wRef = escWatchRef.current[ch];
          // B3：ref 说没复呼过，也要问一句消息流——两处任一说复呼过就算数。
          const naggedAlready =
            !!wRef && (wRef.nagged || (nagAtByCh[ch] != null && nagAtByCh[ch]! >= wRef.createdAt));
          const w = wRef && naggedAlready !== wRef.nagged ? { ...wRef, nagged: naggedAlready } : wRef;
          const d = decideEscalationFollowup({
            now,
            live,
            watch: w,
            lastPlayerMsgTime: lastP, // ④反问也算回话（含群聊那一句）
            nagAfterSec: NAG_AFTER_SEC,
          });
          if (d.action === "track") {
            escWatchRef.current[ch] = { ...d.watch, question: raw?.question ?? "" };
          } else if (d.action === "drop") {
            escWatchRef.current[ch] = null;
          } else if (d.action === "nag" && w) {
            escWatchRef.current[ch] = { ...w, nagged: true }; // 先记账再说话：复呼只一次
            postFollowup(ch, persona, "nag", pickNagLine(persona));
          } else if (d.action === "expire" && w) {
            escWatchRef.current[ch] = null; // 同步清账，异步回来才发话，防重复
            fireExpire(ch, persona, w.question);
          }
          // ★5b/P0-C：闪烁的真状态**读 live，不读被同一拍改写的 ref**。
          //   原来读 `escWatchRef.current[ch]`（mutate 之后）⇒ 撞上 drop↔track 的
          //   5Hz 振荡：已回话但活单仍被保活时（NOOP/澄清有意保活），drop 那一拍
          //   wNow=null ⇒ pending 判成 true，track 那一拍又 false——灯一半时间在
          //   撒谎，还让整条面板每 200ms 重渲染。`live` 在本循环里从不被改写，
          //   且它的 createdAt 就是这张单的 createdAt，判定天然稳定。
          // ── 未读水位：两处顶 ──
          // ① 正看着这个频道（单选）⇒ 一直顶到最新，看着就等于看过了。
          if (viewingCh === ch) markUtterancesSeen(ch, maxUttIdByCh[ch]);
          // ② 长官在这个频道（或群聊里）说过话，且那句比最新的参谋台词还新
          //    ⇒ 他显然看到了。**这条是「回话后停灯」不红的关键**：只靠 pending
          //    那一半会停，但未读那一半仍为真，并集下灯照亮。
          const lastPId = Math.max(lastPlayerIdByCh[ch], lastGroupPlayerId);
          if (lastPId > maxUttIdByCh[ch]) markUtterancesSeen(ch, maxUttIdByCh[ch]);

          const pending = live !== null && !(lastP != null && lastP > live.createdAt);
          const unread = maxUttIdByCh[ch] > getSeenUtteranceId(ch);
          nextAlert[ch] = pending ? "pending" : unread ? "unread" : "none";
        }
        setChannelAlert((prev) =>
          CHS.every((c) => prev[c] === nextAlert[c])
            ? prev // 5Hz 轮询：值没变就不换引用，免得整条面板每 200ms 重渲染
            : nextAlert);

        // 脉冲只在那句台词活着的时候亮：长官点开喇叭＝被回答，超窗＝过期，两头都停。
        const rp = radioPromptRef.current;
        const pulse = rp != null && !ttsEnabledRef.current && now - rp.at <= RADIO_PROMPT_TTL_SEC;
        setRadioPulse((prev) => (prev === pulse ? prev : pulse));
      }

      // ── 主动台词暂存队列的释放（复用这口 200ms 轮询，不新开计时器、不忙等）──
      // 一拍只放一段：释放条件里有 !isBusy()，所以下一段自然要等这一段播完的下一拍
      // ——既把"每段一次 cancel 协议"做实（cancel 时确实没东西在播），也天然串行。
      if (stashRef.current.length > 0 && ttsEnabledRef.current && !loadingRef.current && !isBusy()) {
        const m = stashRef.current.shift()!;
        // ★释放前逐条**重过闸④⑤**：排队期间世界变了——活单可能已经被答掉/过期，
        //   长官可能又按住了麦克风，这条也可能已经太旧。押后不等于免检。
        const verdict = shouldSpeakMessage(m, buildSpeakCtx(m));
        if (verdict.speak) {
          releaseOne(m, verdict.persona);
        } else if (isDeferrable(verdict.reason)) {
          stashRef.current.unshift(m); // 又在收音了：放回队头，下一拍再看
        }
        // 其余（过期/活单已死）＝就此作罢，不念也不再排队
      }
    }, 200);
    return () => clearInterval(id);
  }, [getState, response, buildSpeakCtx, releaseOne, postFollowup, fireExpire]);

  // ── Production handlers ──
  const handleProduce = (unitType: "infantry" | "light_tank") => {
    const state = getState();
    if (!state) return;
    const result = enqueueProduction(state, "player", unitType);
    const label = unitType === "infantry" ? "步兵" : "轻坦";
    if (result.ok) {
      addMessage("info", `已下令生产${label}`, state.time, "logistics", "player", "command_ack");
    } else {
      addMessage("warning", `无法生产${label}: ${result.reason}`, state.time, "logistics", "player", "command_ack");
    }
  };

  // ── Commander selection logic (0.3) ──
  const toggleCommander = (cmd: Commander) => {
    setSelectedCommanders(prev => {
      if (prev.includes(cmd)) {
        // Deselect — but keep at least one
        if (prev.length <= 1) return prev;
        const next = prev.filter(c => c !== cmd);
        // Sync activeChannel to first remaining
        setActiveChannel(COMMANDER_CHANNEL[next[0]]);
        return next;
      } else {
        const next = [...prev, cmd];
        // If going from 1 to multi, keep channel on first
        if (prev.length === 1) {
          setActiveChannel(COMMANDER_CHANNEL[prev[0]]);
        }
        return next;
      }
    });
  };

  const selectSingleCommander = (cmd: Commander) => {
    setSelectedCommanders([cmd]);
    setActiveChannel(COMMANDER_CHANNEL[cmd]);
  };

  const selectAll = () => {
    setSelectedCommanders([...COMMANDERS]);
    setActiveChannel(COMMANDER_CHANNEL[COMMANDERS[0]]);
  };

  // ── 刀C: 待决「选哪批部队」槽 ──
  //
  // ★ 与「批准这个已经确定的方案」是**两种语义**，必须是独立的待决类型：
  //   批准合同问的是"办不办"，这里问的是"办谁"。把"选择"塞进"批准"的判定里，
  //   改完会把刚收口的批准流程弄坏。UI 与过期检查沿用同一套（setClarification
  //   + 同寿命窗口），判定本身各走各的。
  //
  // ★刀己 (审核 §二)：槽里现在存**原命令的安全快照**与**候选的稳定 key**。
  //   刀C 那一版只存了候选、从没用它来选——下一条可执行 intent 一到就把槽清空，
  //   然后照模型这一轮填的字段执行。于是「好的」、答非所问、或者模型又把
  //   fromFront 写错，仍然调错兵（实测：留守 3 ＋ 外派 10 ⇒ 只撤 3 个）。
  //   ★ **绝不存旧名单当执行真相**：名单在绑定那一刻从当前 GameState 现查
  //     （bindDispatchSelection）——等回复那几秒里人会死、会被改派、任务会关。
  const pendingSelectionRef = useRef<SelectionProgress & {
    id: string;
    channel: Channel;
    sessionId: string;
    epoch: number;
    /** 提问时印出去的候选（key 稳定，label 仅供显示）。 */
    candidates: Pick<DispatchCandidate, "selectionKey" | "label">[];
    /** 当前正在问哪一条；原 intent 从不可变 optionSnapshot 按下标读取。 */
    intentIndex: number;
    /** 原回合的执行上下文（频道/线程/升级单），绑定执行时沿用。 */
    execCtx?: ExecContext;
    /** 第六轮：这一槽问的是什么。缺席＝「是哪一批」。 */
    kind?: "source" | "quantity";
    /** 第六轮：kind==="quantity" 时，问的是哪一组、「一共」读法的总数、原问句（再问时照说）。 */
    quantity?: Pick<QuantityAmbiguity, "signature" | "indexes" | "total" | "question">;
  } | null>(null);

  /** 还活着的那一槽（过期 / 换频道 / 重开一局都作废，绝不悬挂）。 */
  const livePendingSelection = (now: number, ch: Channel) => {
    const p = pendingSelectionRef.current;
    if (!p) return null;
    if (p.channel !== ch || p.sessionId !== SESSION_ID || p.epoch !== gameEpochRef.current || now > p.expiresAt) {
      pendingSelectionRef.current = null;
      return null;
    }
    return p;
  };

  /**
   * 刀寅（审核 B）：此刻还能被长官这一句答复消费的那份待确认方案。
   *
   * 作废（当场清掉，绝不悬挂）：换了局、过了期、参谋在它之后又答了一轮、或者之后又升级了
   * 一个新请示——任何一条都说明长官眼前的"最新一问"已经不是它了。
   * 只是"此刻不可答"（别的频道、代价还没念完）⇒ 返回 null，但不清。
   * send 的确认词捷径和发请求时的合同标签**共用这一个判定**（台架直接调它）。
   */
  const livePendingContract = (st: GameState, ch: Channel) => {
    const pc = pendingContractRef.current;
    if (!pc) return null;
    const esc = getActiveEscalation(pc.channel, st.time);
    if (
      pc.epoch !== gameEpochRef.current ||
      st.time > pc.expiresAt ||
      pc.createdTurn !== replyTurnOf(pc.channel) ||
      (esc != null && esc.createdAt > pc.createdAt)
    ) {
      pendingContractRef.current = null;
      return null;
    }
    if (pc.channel !== ch || pc.phase !== "awaiting_reply") return null;
    return pc;
  };

  /**
   * 确认词捷径（不问模型）：只有 livePendingContract 认的那一份、且长官这句是封闭词表里的
   * 确认/取消词，才在这里直接办。返回 true ＝ 这一句已经处理完。词表以外的话照常交给模型。
   */
  const tryPendingShortcut = (st: GameState, ch: Channel, userMsg: string): boolean => {
    const pc = livePendingContract(st, ch);
    if (!pc) return false;
    if (isConfirmReply(userMsg)) {
      pendingContractRef.current = null;
      traceClient(traceIdRef.current, "pending_shortcut", { reply: "confirm", pendingId: pc.id, planTraceId: pc.execCtx.traceId ?? null });
      handleApprove(pc.opt, 0, "auto", pc.execCtx, pc.data, true, pc.selection);
      return true;
    }
    if (isCancelReply(userMsg)) {
      pendingContractRef.current = null;
      traceClient(traceIdRef.current, "pending_shortcut", { reply: "cancel", pendingId: pc.id, planTraceId: pc.execCtx.traceId ?? null });
      addMessage("info", "行，那就不动。", st.time, ch, undefined, "command_ack");
      return true;
    }
    return false;
  };

  /**
   * ★第九轮：**登记待批准方案的唯一入口**（模型 CONFIRM、引擎提议「要再派吗」/去处收窄、高影响三处都走这里）。
   *
   * 规矩：展示的完整方案＝保存的方案＝批准后执行的方案。完整方案由 core.describePlanForApproval 从
   * **这份 opt 本身**逐条生成（动作、来源、数量、去处）；返回这一句，调用方把它原样放进屏上／耳朵／context
   * 的那一问；给下一轮模型看的 summary 也是同一句。存下的 opt、选择进度、期限、一次只挂一个问题照旧。
   */
  const registerApprovalPlan = (st: GameState, ch: Channel, a: {
    opt: AdvisorOption; data: DisplayResponse; execCtx: ExecContext;
    phase: "voicing" | "awaiting_reply"; question: string; selection?: SelectionProgress;
  }): string => {
    const plan = describePlanForApproval(st, a.opt.intents?.length ? a.opt.intents : [a.opt.intent]);
    const expiresAt = st.time + HIGH_IMPACT_CONFIRM_WINDOW_SEC;
    pendingSelectionRef.current = null; // 一次只挂一个问题（审核 B）
    pendingContractRef.current = {
      id: makePendingId(), createdTurn: replyTurnOf(ch), phase: a.phase, channel: ch, sessionId: SESSION_ID,
      epoch: gameEpochRef.current, createdAt: st.time, expiresAt,
      opt: a.opt, data: a.data, execCtx: a.execCtx,
      summary: `要办的是：${plan}（陈刚问长官：${a.question}）`,
      ...(a.selection ? { selection: { ...a.selection, expiresAt } } : {}),
    };
    return plan;
  };

  /**
   * ★刀乙：引擎拒掉这道命令时，**屏上黄字和耳朵是同一句**。
   *
   * 病：`planVoiceSpeech` 在 execTurn 时 `finalUtterance=""`（刀B 有意为之，
   * 是对的），而执行回执只在 `applyOrders` 真跑完才出声。可是 handleApprove 有
   * 一排在 apply **之前**就 return 的路——权限拒绝、任务不在麾下、消歧追问、
   * 票据不可用、找不到分队、目标不存在、目的地判退、零 orders 的规划失败。
   * 结果：语音下了一条命令被引擎拒了 ⇒ 屏上黄字、**耳朵全静音**。
   * 基线上至少还念一句 spoken。交接文档 §4 点名要求过"选兵/权限/规划阶段
   * 零 orders 的失败也要如实反馈"——屏上做到了，耳朵没有。
   *
   * 一处补声，所有早退路都好：新增第 N 条早退路只要走这个出口就自带声音，
   * 不走就会被 probe 的源码级判据当场抓住（防"复制六遍漏第七遍"）。
   *
   * `screen:false` 可用于调用方已经发布过屏幕行的情况。
   */
  const refuseAloud = (
    st: GameState,
    ch: Channel,
    msg: string,
    speakReceipt: boolean,
    opts?: { screen?: boolean; context?: boolean },
  ) => {
    traceClient(traceIdRef.current, "refuse", { line: msg });
    if (opts?.screen !== false) {
      addMessage("warning", msg, st.time, ch, undefined, "command_ack");
    }
    if (ttsEnabled && speakReceipt && msg.trim()) {
      const persona = COMMANDERS.find((c) => COMMANDER_CHANNEL[c] === ch) ?? COMMANDERS[0];
      speak(msg, persona);
      flush(persona);
    }
    // ★刀壬 (审核 §五)：**同一份事实**也要进对话 context。
    //   病：这个出口原先只上屏、出声，不写 context。而可执行回合又先把模型写的
    //   `data.brief`（"准备执行…"）推了进去 ⇒ 下一轮模型记得的是"我要办了"，
    //   根本不知道这道命令被权限/分队/目标/零 orders 拦下了。
    //   `screen:false` 只表示"不重复上屏"，**不表示不进 context**——真实结果
    //   一律进；要压掉重复的那一格（问句自己已经推过）才传 `context:false`。
    if (opts?.context !== false && msg.trim()) {
      pushContext(channelContextRef.current, ch, { role: "assistant", text: msg, time: st.time });
    }
  };

  /**
   * 问一句：候选逐项列出，**不替他挑一个**，这一轮什么都不执行。
   *
   * ★刀己：连同**原命令的快照**一起存进槽。下一轮长官答了，执行的是这条快照
   *   （来源字段被换成他选的那一批），不是模型那一轮重新写的单子。
   *   屏上只印人话（谁、多少人、去了哪）——key 只进信封给模型抄，长官永远
   *   不必念出 `dispatch:M1`。
   */
  const askWhichDispatch = (
    state: GameState,
    ch: Channel,
    candidates: DispatchCandidate[],
    speakReceipt: boolean,
    progress: SelectionProgress,
    execCtx: ExecContext | undefined,
    intentIndex: number,
    reask = false,
    /** 只剩一批时换个问法——问的仍是"是不是它"，不是替他定了。 */
    soleCandidate = false,
  ) => {
    // 刀寅（审核 B）：一次只挂一个问题——这一问一出，之前等着点头的方案作废。
    pendingContractRef.current = null;
    pendingSelectionRef.current = {
      ...progress,
      // 再问一次沿用**同一个 id**：它标识的是"这一次消歧"，不是"这一句话"。
      id: reask && pendingSelectionRef.current ? pendingSelectionRef.current.id : makePendingId(),
      channel: ch,
      sessionId: SESSION_ID,
      epoch: gameEpochRef.current,
      candidates: candidates.map(({ selectionKey, label }) => ({ selectionKey, label })),
      intentIndex,
      // 每次都重新复制，防调用方后续的票据/目标预检原地改写污染待决合同。
      optionSnapshot: cloneSelectionOption(progress.optionSnapshot),
      selectionKeys: progress.selectionKeys.map((s) => ({ ...s })),
      execCtx,
      kind: "source",
      quantity: undefined,
    };
    const question = soleCandidate
      // ★复审 §一：只剩一批也**照样问**。引擎不替长官挑——"少数变成唯一"
      //   不等于他同意了。问法换掉，零执行这条不松动。
      ? `现在只剩${candidates[0]?.label ?? "一批"}，是这一批吗？`
      : `您说的是哪一批？${candidates.map((c) => c.label).join("，还是")}？`;
    // 刀乙：问句也要进耳朵——用嘴下的令被问回来，听不见就等于石沉大海。
    // 刀壬：出口现在自己写 context，这儿就别推第二遍（`context:false`）。
    refuseAloud(state, ch, question, speakReceipt, { context: false });
    pushContext(channelContextRef.current, ch, { role: "assistant", text: question, time: state.time });
    traceClient(traceIdRef.current, "ask_selection", { intentIndex, question, keys: candidates.map((c) => c.selectionKey) });
    setClarification("请指明是哪一批部队");
  };

  /**
   * 第六轮：问**数量读法**（「一共 2 个，还是每种各 2 个」），这一轮零执行。
   *
   * 旧做法只问一句、不存任何东西，并让紧接着的那一轮**跳过检查**（防绕圈）——下一轮模型
   * 只要照旧交两条，就派出 4 个（Codex 复现：长官答「一共两个」，实际派了 4 个）。
   * 现在它是一个真正的待决选择，与「是哪一批」同一套合同：存下**原命令**与两种已明确的
   * 读法（稳定 key），模型只负责分类长官选了哪一种；执行的是按那种读法改写的**原命令**，
   * 不是模型那一轮重写的单子。多候选只回「对」、缺字段、编造 key、跨局、过期、重复投递 ⇒ 零执行。
   */
  const askQuantityReading = (
    state: GameState,
    ch: Channel,
    amb: QuantityAmbiguity | NonNullable<NonNullable<typeof pendingSelectionRef.current>["quantity"]> & { candidates: { selectionKey: string; label: string }[] },
    speakReceipt: boolean,
    progress: SelectionProgress,
    execCtx: ExecContext | undefined,
    reask = false,
  ) => {
    pendingContractRef.current = null; // 一次只挂一个问题（审核 B）
    pendingSelectionRef.current = {
      ...progress,
      id: reask && pendingSelectionRef.current ? pendingSelectionRef.current.id : makePendingId(),
      channel: ch,
      sessionId: SESSION_ID,
      epoch: gameEpochRef.current,
      candidates: amb.candidates.map(({ selectionKey, label }) => ({ selectionKey, label })),
      intentIndex: amb.indexes[0] ?? 0,
      optionSnapshot: cloneSelectionOption(progress.optionSnapshot),
      selectionKeys: progress.selectionKeys.map((k) => ({ ...k })),
      requirements: progress.requirements.map((r) => ({ ...r, offeredKeys: [...r.offeredKeys] })),
      quantityConfirmed: [...(progress.quantityConfirmed ?? [])],
      execCtx,
      kind: "quantity",
      quantity: { signature: amb.signature, indexes: [...amb.indexes], total: amb.total, question: amb.question },
    };
    refuseAloud(state, ch, amb.question, speakReceipt, { context: false });
    pushContext(channelContextRef.current, ch, { role: "assistant", text: amb.question, time: state.time });
    traceClient(traceIdRef.current, "ask_quantity", { signature: amb.signature, question: amb.question, keys: amb.candidates.map((c) => c.selectionKey) });
    setClarification(null);
  };

  // ── Phase 3: 参谋线程的批准 —— **委派给主执行链** ──
  //
  // ★刀子 (审核 §七)：这里原本是 handleApprove 的一份复制品，而且是**退化**的
  //   那一份——它绕过了整条主安全链：
  //     · 没有 `checkDispatchAuthority`（谁在说话决定他能动谁）；
  //     · 无效 `fromSquad` 被**删掉**后让引擎自动选兵 —— 正是
  //       dispatch-scope-v1 裁定过的"静默扩大范围"那一族（74/85 那笔账的形状）；
  //     · 不解析、不复查 `fromDispatch`，也不判指代歧义；
  //     · 下的是**裸 order**（没有 `origin:"advisor"` / `dispatchMeta`）⇒ 台账
  //       一条不记，此后「刚派去那批」就指不着这些兵；
  //     · 不写对话 context；没有局印复核（跨局回调照样落地）。
  //
  //   当前生产者休眠：pendingByChannel 没有非空写入；UNDER_ATTACK 走 crisis
  //   conversation。保留这处委派，使将来恢复生产者时也沿用主执行链。
  //
  //   修法是最小的那个：主链**本来就**认 `execCtx.threadId`（跑完会
  //   `resolveThread(threadId)`），所以这里只要造一份带 threadId 与局印的 ctx，
  //   把选项交给 `handleApprove`。第二个执行入口就此消失——预检、权限、选兵、
  //   apply、回执、台账、context 全都只有一份实现。
  const handleThreadApprove = (thread: StaffThread, opt: AdvisorOption, idx: number) => {
    if (thread.status !== "open") return;
    if (!tryLockThread(thread.id)) return;
    try {
      const state = getState();
      if (!state) return;
      // mode 传 "auto" 而不是 "manual"：主链里 `mode === "manual"` **只**用在一处
      // ——「聊天卡片已经过期」那道闸（`!response`）。线程选项不来自 `response`，
      // 它有自己的新鲜度检查（`status === "open"` + 执行锁 + expireStaleThreads），
      // 传 "manual" 会被那道闸误伤，把所有线程批准都拦掉。
      handleApprove(opt, idx, "auto", {
        channel: thread.channel,
        threadId: thread.id,
        requestId: crypto.randomUUID(),
        // 刀癸：这条路也盖局印——它同样是"点一下才执行"，中间隔着用户的手。
        run: stampRun(gameEpochRef.current, state),
      });
    } finally {
      unlockThread(thread.id);
    }
  };

  // ── Doctrine: process standingOrder / cancelDoctrine from LLM response ──
  // Returns true if any doctrine action succeeded (created/cancelled/dup-idempotent),
  // false only when standingOrder field is present but rejected (e.g. must_hold w/ unresolvable locationTag).
  const processDoctrineFields = (data: Record<string, unknown>, state: GameState, ch: Channel, approvedIntents?: Intent[]): boolean => {
    let processed = false;

    // Standing order creation
    if (data.standingOrder && typeof data.standingOrder === "object") {
      const so = data.standingOrder as Record<string, unknown>;
      if (typeof so.type === "string" && typeof so.locationTag === "string") {
        const VALID_SO_TYPES: StandingOrderType[] = ["must_hold", "can_trade_space", "preserve_force", "no_retreat", "delay_only"];
        const VALID_PRIORITIES: string[] = ["low", "normal", "high", "critical"];
        const rawType = so.type.trim().toLowerCase();
        if (!VALID_SO_TYPES.includes(rawType as StandingOrderType)) {
          addMessage(
            "warning",
            `持续命令类型 "${rawType}" 无效，未登记。`,
            state.time, ch, undefined, "command_ack",
          );
          return false;
        }
        const soType = rawType as StandingOrderType;
        const rawPriority = typeof so.priority === "string" ? so.priority.trim().toLowerCase() : "";
        const soPriority = VALID_PRIORITIES.includes(rawPriority)
          ? rawPriority as DoctrinePriority : "normal";
        const rawLocation = (so.locationTag as string).trim();
        if (!rawLocation) {
          addMessage("warning", "持续命令缺少有效地点，未登记。", state.time, ch, undefined, "command_ack");
          return false;
        }

        // Step 2 hardening: canonicalize locationTag.
        // - must_hold: STRICT — engine ratio monitoring (doctrine.ts:checkDoctrines) only matches
        //   front IDs/names + region IDs (NOT facility/tag). Reject if findFront fails to avoid
        //   silent monitoring failure.
        // - other types: LENIENT — canonicalize known front/facility/tag/region IDs when possible,
        //   then preserve raw locationTag if no match (don't break existing loose prompts).
        const matched = findFront(state, rawLocation);
        let resolvedLocationTag = matched ? matched.id : rawLocation;
        if (!matched && soType !== "must_hold") {
          // Exact match only (id or full name) — substring matching risks silent
          // semantic mismatch (e.g. "Coastal" partial-matching "Coastal Highway Junction"
          // facility when player meant Coastal front). Order tag → facility → region
          // matches the prompt's location priority convention (line 240).
          const lower = rawLocation.toLowerCase();
          const facility = state.facilities.get(rawLocation) ?? Array.from(state.facilities.values()).find(f =>
            f.id.toLowerCase() === lower ||
            f.name.toLowerCase() === lower ||
            f.tags.some(t => t.toLowerCase() === lower),
          );
          const tag = state.tags?.find(t =>
            t.id === rawLocation ||
            t.id.toLowerCase() === lower ||
            t.name.toLowerCase() === lower,
          );
          const region = state.regions.get(rawLocation) ?? Array.from(state.regions.values()).find(r =>
            r.id.toLowerCase() === lower ||
            r.name.toLowerCase() === lower,
          );
          resolvedLocationTag = tag?.id ?? facility?.id ?? region?.id ?? rawLocation;
        }

        if (soType === "must_hold" && !matched) {
          addMessage(
            "warning",
            `长官，"${rawLocation}" 不是可识别防线，must_hold 需要明确防线名才能监控，请重新指定。`,
            state.time, ch, undefined, "command_ack",
          );
          // Reject: do not create doctrine. processed stays false for this attempt.
        } else {
          // Deduplicate: skip if an active doctrine with same type+canonical location already exists
          const dup = state.doctrines.find(d => d.status === "active" && d.type === soType && d.locationTag === resolvedLocationTag);
          if (!dup) {
            const docId = `doc_${String(state.doctrines.length + 1).padStart(3, "0")}`;
            // Extract assigned squads from approved intents
            const squads: string[] = [];
            if (approvedIntents) {
              for (const intent of approvedIntents) {
                if (intent.fromSquad) squads.push(intent.fromSquad);
              }
            }
            const newDoc: StandingOrder = {
              id: docId,
              type: soType,
              commander: ch,
              locationTag: resolvedLocationTag,
              priority: soPriority,
              allowAutoReinforce: typeof so.allowAutoReinforce === "boolean" ? so.allowAutoReinforce : false,
              assignedSquads: squads,
              createdAt: state.time,
              status: "active",
            };
            state.doctrines.push(newDoc);
            const commitDesc = `${soType} @ ${resolvedLocationTag}`;
            pushCommitment(ch, commitDesc);
            addMessage("info", `持续命令已登记: ${commitDesc} [${soPriority.toUpperCase()}]`, state.time, ch, undefined, "command_ack");
          }
          processed = true; // dup considered idempotent success
        }
      }
    }

    // Doctrine cancellation
    if (typeof data.cancelDoctrine === "string" && data.cancelDoctrine.length > 0) {
      const result = cancelDoctrine(state, data.cancelDoctrine);
      if (result.cancelled) {
        removeCommitment(result.channel, `${result.type} @ ${result.locationTag}`);
        addMessage("info", `${result.locationTag} 的 ${result.type} 命令已取消，部队恢复自由调度。`, state.time, result.channel, undefined, "command_ack");
        processed = true;
      }
    }

    return processed;
  };

  // ── 0.5: Group chat — single LLM call, 3 personas ──
  // ALL mode sends ONE request to /api/command-group.
  // LLM responds as all 3 officers in one shot — feels like a real war room.
  const sendGroupChat = async (userMsg: string, state: GameState, _selectedIds: number[]) => {
    // Clear stale response/error from previous command
    setResponse(null);
    setError(null);
    setApprovedIdx(null);
    responseExecCtxRef.current = null;
    latestRequestIdRef.current = null;
    pendingGroupResponsesRef.current = [];

    const channels = selectedCommanders.map(c => COMMANDER_CHANNEL[c]);
    const styleNote = `risk=${state.style.riskTolerance.toFixed(2)} focus=${state.style.focusFireBias.toFixed(2)} obj=${state.style.objectiveBias.toFixed(2)} cas=${state.style.casualtyAversion.toFixed(2)}`;

    // Add player message to all channels' context
    for (const ch of channels) {
      commanderMemoryRef.current[ch].playerIntent = userMsg;
      pushContext(channelContextRef.current, ch, { role: "user", text: userMsg, time: state.time });
    }

    // Build digest from combat channel (most complete battlefield view).
    // Step C: water the existing selected-ids pipe + append PLAYER_VIEW.
    const groupSelectedIds = getSelectedUnitIds?.() ?? [];
    const baseDigest = buildDigestForChannel(state, "combat", commanderMemoryRef.current.combat, groupSelectedIds);
    const playerViewContext = buildPlayerViewContext(state, baseDigest, getViewport?.() ?? null, groupSelectedIds);
    // Compressed cross-channel context so LLM knows what was discussed before
    const groupCtx = formatGroupContext(channelContextRef.current);

    // ★刀癸 / 复审 §五：出发盖一枚局印，**这条路上每一处落地都拿它复核**——
    //   `data.error`、`catch`、以及每条押了 2.2–4 秒才上屏的延迟回调。
    //   群聊是全仓最长的那条异步链，上一局的话最容易从这儿投进新局。
    const groupRun = stampRun(gameEpochRef.current, state);

    try {
      const res = await fetch(`${API_URL}/api/command-group`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          digest: baseDigest + playerViewContext,
          message: userMsg,
          styleNote,
          channelContext: groupCtx,
          sessionId: SESSION_ID,
        }),
      });
      const data = await res.json();

      // ★复审 §五：群聊这条路**整条**都要用出发时的局印复核，不只是那几个延迟
      //   回调。`data.error` 与下面的 `catch` 同样是"等了一会儿才回来"的东西
      //   ——上一局的报错投进新局，屏上就会冒出一条与这一局无关的红字。
      if (!runGuardAllows(groupRun, gameEpochRef.current, getState())) return;

      if (data.error) {
        const nowErr = getState();
        if (!nowErr) return;
        addMessage("urgent", data.error, nowErr.time, "combat", "chen", "command_ack", true);
        return;
      }

      // Dispatch each persona's brief to their respective channel.
      // Stagger display: shuffle order + 2.2-4.0s intervals (mean ~3s) so each
      // persona has clear breathing room — tight ranges felt synchronous, and
      // bimodal made fast bursts indistinguishable from the original dump.
      const responses: Array<{ from: string; brief: string }> = data.responses || [];
      const shuffled = [...responses].sort(() => Math.random() - 0.5);
      let cumulativeDelay = 0;
      for (let i = 0; i < shuffled.length; i++) {
        const r = shuffled[i];
        if (i > 0) cumulativeDelay += 2200 + Math.random() * 1800;
        setTimeout(() => {
          const commander = FROM_TO_COMMANDER[r.from];
          if (!commander) return;
          const now = getState();
          // 跨局 / 换了 GameState ⇒ 静默作废：不上屏、不进 context。
          if (!now || !runGuardAllows(groupRun, gameEpochRef.current, now)) return;
          const ch = COMMANDER_CHANNEL[commander];
          // 时间取**落地这一刻**当前局的钟，不用出发时那个旧值。
          pushContext(channelContextRef.current, ch, { role: "assistant", text: r.brief, time: now.time });
          addMessage("info", r.brief, now.time, ch, commander, "command_ack", true);
        }, cumulativeDelay);
      }

      // ALL channel is discussion-only — no options/execution handling

    } catch {
      // ★复审 §五：报错也可能是**上一局**那次请求的回声，同样要过局印。
      const nowCatch = getState();
      if (!runGuardAllows(groupRun, gameEpochRef.current, nowCatch)) return;
      addMessage("urgent", "全体指令通信中断", nowCatch!.time, "combat", "chen", "system", true);
    }
  };

  // ── sendCommand (0.4: migrated from CommandPanel) ──
  // 语音输入 V1：带 voice 时这一轮的"长官说了什么"要等陈把 heard 交回来才知道
  // ——所有读文本的地方都推迟到 processAdvisorData 里结算（见那儿的语音结算块）。
  const sendCommand = async (voice?: VoiceRecording) => {
    const state = getState();
    if (state) syncGameEpoch(state); // synchronous — closes the poll race before the fast path
    if (!state || (!voice && !message.trim())) return;

    // ── 步 5 · B2 发报动画（挂点必须在整条守卫之后）──
    // 空输入回车被上面 `!message.trim()` 弹回 ⇒ 天然不响；`!state` 那项同样承重，
    // 状态没起来时不许放空炮。loading 中 input/按钮双 disabled，事件根本进不来。
    // `voice` 参数在 ⇒ 陈/Emily 的语音回合不响（语音归电台隐喻，不许串）；
    // voiceAutoSendRef 在 ⇒ 马克斯的语音自动发送不响（B3 来源分流）。四格全封。
    if (!voice && !voiceAutoSendRef.current) fireTransmit();

    const isVoiceTurn = !!voice;
    // ★步1 探针绑回合：每进一次 sendCommand 开一个新回合号；**只有语音回合**
    //   认领松手那颗起点。打字回合刻意不认领——它没有"松手"这件事，认了就正好
    //   复现 T3 那个 bug（上一轮的残值被这一轮念正文的第一声吃掉）。
    const speechTurn = ++speechTurnRef.current;
    if (isVoiceTurn && releaseMarkRef.current) {
      releaseMarkRef.current = { ...releaseMarkRef.current, turn: speechTurn };
    }
    const userMsg = voice ? "" : message.trim();
    // 刀寅：这一轮的对账编号。发出时生成、随请求带给服务端，之后浏览器各层也用它记。
    const traceId = newTraceId();
    traceIdRef.current = traceId;
    setLoading(true);
    setError(null);
    setApprovedIdx(null);
    setClarification(null);
    setResponse(null);
    setStreamingText(null);
    responseExecCtxRef.current = null;
    latestRequestIdRef.current = null;

    // Determine channel from selection
    const primaryChannel = COMMANDER_CHANNEL[selectedCommanders[0]];

    // Add player message to feed (mark as groupChat if in ALL mode so it stays out of individual channels)
    // 语音回合先放一个占位；陈说完话之后（options 事件到达时）换成他听到的原话。
    // (a) 案：回填时点是"整条回复念完之后"，不是 ~2s——用户 2026-08-09 拍板，
    // (b) 流首 heard 事件登记为 demo 后升级项。
    addMessage("info", isVoiceTurn ? "🎤 …" : userMsg, state.time, primaryChannel, "player", "player", isGroupChat ? true : undefined);
    onPlayerSpoke?.(primaryChannel);   // 教学关：这才是"玩家开口"的唯一真事件

    // Chat commands are not constrained by map box-selection.
    // Only manual unit control (right-click move) uses selectedUnitIds as hard constraint.
    selectedIdsSnapshotRef.current = undefined;

    setMessage("");

    if (isGroupChat) {
      await sendGroupChat(userMsg, state, []);
      setLoading(false);
      return;
    }

    // ── Single commander path ──
    const ch = primaryChannel;


    // Step 5 (地基二 rework) — pending high-impact contract handling.
    // The literal fast path stays instant and CLOSED (see NEVER EXPAND above);
    // a word-list miss no longer destroys the contract — it rides to the LLM
    // as a tagged ---PENDING_CONTRACT--- context and comes back as a semantic
    // pendingDecision, judged fail-closed in processAdvisorData.
    // 刀寅（审核 B）：判定抽成生产函数（livePendingContract / tryPendingShortcut），
    //   这里与台架调的是同一份；过期、换局、翻篇（参谋又答了一轮 / 又来了新请示）都在里面作废。
    //   词表以外的话，合同留给下面的语义那一轮（仍须 livePendingContract 认它）。
    if (tryPendingShortcut(state, ch, userMsg)) {
      setLoading(false);
      return;
    }

    // ── v4 刀2b P1: instrument the ONE branch that decides whether 刀A (the
    // shelved approval contract) has to come back. A bare confirm answering a
    // live proposal is exactly the case where the LLM — not a structural gate —
    // decides which batch the player just approved. If the external playtest
    // shows it mis-binds, 刀A revives; if it doesn't, the contract stays
    // shelved. Either way the ruling is made on counted evidence, not vibes.
    // Stamped here (send time), consumed at applyOrders so only executions that
    // really moved troops are counted.
    // 刀E (§8 ⑧, 2026-08-04): the getActiveEscalation precondition excluded the
    // exact population this instrument exists to observe. Bucket A is "a bare
    // confirm with NO structural handle" — no escalation on the table, no
    // ticket — and the old condition recorded a row only when an escalation WAS
    // on the table. The blind spot was the subject. Now every bare confirm is
    // recorded; escalateId=null IS the Bucket A cell.
    bareConfirmExecRef.current = isConfirmReply(userMsg)
      ? { escalateId: getActiveEscalation(ch, state.time)?.actionId ?? null }
      : null;

    // ── 绊索已删除（B 刀 2026-08-02）──────────────────────────────────────
    // v4 刀2b put a blocker here: a bare confirm with no pending contract and
    // no active escalation was answered by the engine with a canned line and
    // NEVER reached the LLM. Two standing laws broken at once:
    //
    //   1. 禁关键词枚举 — the same 15-word list that Codex had explicitly fenced
    //      as a CLOSED FAST PATH ("semantic fallback owns natural language; ANY
    //      word-list miss goes to the LLM") was reused INVERTED: a hit now
    //      blocked the semantic fallback instead of skipping ahead of it. The
    //      list stopped being an accelerator and became a judge.
    //   2. 台词禁死模板 — the canned refusal was an engine-authored line three
    //      personas would recite verbatim.
    //
    // Blast radius (hand-test 2026-08-02): the staff gives a consultation with
    // real numbers, the commander says 「可以」, and the engine answers "我这儿
    // 没有待批的方案" — because a suggestion is neither a pending contract nor a
    // registered escalation. The most natural way to accept advice was the one
    // sentence the model could never hear. SHORT FOLLOW-UP RESOLUTION (ai.ts)
    // was structurally dead for those words.
    //
    // What the blocker was actually afraid of — a bare confirm turning into an
    // invented dispatch — is NOT a routing problem and is not solved by keeping
    // the words away from the model. It belongs to the auto-execute gate below,
    // where it is judged on the INTENT (does this dispatch have a real handle),
    // never on the wording.

    // Capture persona once for the entire stream. selectedCommanders[0]
    // could in theory drift if user switches tabs mid-stream; ttsPersona
    // is the locked persona used by every speak()/flush() call below.
    const ttsPersona: Persona = selectedCommanders[0];

    // ── spoken 层：这一轮耳朵的安排 ──
    // spoken 还没到（它在 JSON 里，随 options 事件才来），但**流式期间念不念
    // 正文**这一件只取决于"这是不是语音回合"，此刻就判得出来。剩下两件
    // （念哪一句、回执出不出声）在 processAdvisorData 里拿到 spoken 后再算。
    const sendPlan = planVoiceSpeech({ voiceTurn: isVoiceTurn, prose: "" });
    // ★本地即时应答音已砍（用户手测判退 2026-08-10，理由见 voiceSpeech.ts 顶部）：
    //   墨迹 + 承诺早于理解（问句被回了一句「动手。」）。这一槽现在空着。

    // Phase 3: thread context (threads are dormant in 6a; kept as a safety net)
    const activeThreadOnChannel = activeThreads.find(t => t.channel === ch);
    const threadContext = activeThreadOnChannel
      ? `\n---ACTIVE_THREAD---\n[${activeThreadOnChannel.eventType}] ${activeThreadOnChannel.eventMessage}\nStaff brief: ${activeThreadOnChannel.brief}`
      : "";

    // Step 6a: if Chen escalated a crisis on this channel, this reply is answering
    // it. Carry the correlation id to the server log (action ↔ reaction) and feed
    // the question back as context so a short reply resolves against it. The reply
    // still runs through the normal command path — 6a never auto-executes.
    const activeEsc = getActiveEscalation(ch, state.time);
    const escalateId = activeEsc?.actionId;
    const escalationContext = activeEsc
      ? `\n---ACTIVE_ESCALATION---\n参谋刚问:「${activeEsc.question}」\n指挥官下面这句是对它的回应。` +
        // v4 刀2b: the engine-minted ticket numbers for THIS proposal. The
        // digest's standing "group labels are NOT valid fromSquad" rule stays
        // true — this grants the NUMBER, which is a different handle, and the
        // line says so in as many words.
        (activeEsc.ticketLine ? `\n${activeEsc.ticketLine}` : "")
      : "";
    // 7c.1-stab (A2 Tier 1): do NOT clear the escalation on every first reply — a
    // multi-step answer ("调用Drake去" then "可以") must keep the question context so
    // the follow-up still lands. Clear on an explicit cancel/decline here; an executed
    // (actionable) reply clears it in processAdvisorData below; an abandoned one
    // auto-expires (getActiveEscalation drops it after 120s). While it stays active,
    // this channel's commands carry the escalation context — bounded by that window
    // plus clear-on-execute. (Deterministic resolve of a confirm is Tier 2, deferred.)
    // Fix 3: a decline/defer reply ("不用/先观察/...") dismisses the escalation so it
    // can't bleed into the player's NEXT, unrelated command.
    if (activeEsc && (isCancelReply(userMsg) || isDeclineReply(userMsg))) clearEscalation(ch);

    // 语音回合此刻还不知道长官说了什么——写空串会把上一条意图抹掉，
    // 所以推迟到 heard 结算（打字回合逐字不变）。
    if (!isVoiceTurn) commanderMemoryRef.current[ch].playerIntent = userMsg;
    // Step C: water the existing selected-ids pipe (DigestV1's PLAYER_SELECTED
    // section renders from it; BattleContextV2 ignores it and gets the ids via
    // PLAYER_VIEW below instead).
    const cmdSelectedIds = getSelectedUnitIds?.() ?? [];
    // B 刀: this is the ONE path where the staff both speaks to the commander
    // and can execute what he answers, so it is the only path that mints force
    // handles. Every force the judgment frame names this turn gets a G-number
    // the model may write into fromSquad — that is what makes 「让她们去支援」
    // land on the force that was actually named instead of on whoever happens
    // to be standing at the destination.
    const baseDigest = buildDigestForChannel(state, ch, commanderMemoryRef.current[ch], cmdSelectedIds, undefined, undefined, true);
    const contextSuffix = formatContext(channelContextRef.current, ch);
    // 地基二: tag the request with the live contract ONLY when it is visible
    // (awaiting_reply), same channel, unexpired. voicing is never tagged — a
    // reply the player typed before seeing the concern cannot authorize it.
    const pcAtSend = livePendingContract(state, ch);
    const pendingTag: PendingRequestTag | null = pcAtSend
      ? { pendingId: pcAtSend.id, channel: ch, sessionId: SESSION_ID }
      : null;
    const pendingContext = pendingTag && pcAtSend
      ? `\n---PENDING_CONTRACT---\n待确认命令(id=${pcAtSend.id}): ${pcAtSend.summary}\n指挥官下面这句话可能是对这份待确认命令的答复。`
      : "";
    // ── 刀己 (审核 §二): 候选选择合同的请求侧 ──
    //
    // 规矩照抄 pendingContract：只在**同频道、未过期、同一局**的活槽上打标签，
    // 答复也只有在标签仍与活槽三方对齐时才可能消费（judgeSelectionConsumption）。
    // ★ key 只进信封给模型逐字抄；屏上给长官的问句里没有 key，他永远不必念
    //   `dispatch:M1`。
    const selAtSend = livePendingSelection(state.time, ch);
    const selectionTag: SelectionRequestTag | null = selAtSend
      ? { selectionId: selAtSend.id, channel: ch, sessionId: SESSION_ID }
      : null;
    // ★刀寅：信封里写**实际问的那种问法**。只剩一批时屏上问的是「是这一批吗？」，
    //   旧信封却一律写「你问了是哪一批」、规则又说"一句应答词不算选"——于是长官答
    //   「是的」必判没选、原样再问，绕圈。两种问法各自写明，判定仍归模型、闸仍在 key。
    const selectionContext = selAtSend ? selectionEnvelope(selAtSend) : "";
    // Step C: dialogue focus (---ACTIVE_ESCALATION---) and camera focus
    // (---PLAYER_VIEW---) ride the envelope SIDE BY SIDE — the model judges
    // which one the player's words attach to; the engine classifies nothing.
    const playerViewContext = buildPlayerViewContext(state, baseDigest, getViewport?.() ?? null, cmdSelectedIds);
    const digest = baseDigest + contextSuffix + threadContext + escalationContext + playerViewContext + pendingContext + selectionContext;
    const styleNote = `risk=${state.style.riskTolerance.toFixed(2)} focus=${state.style.focusFireBias.toFixed(2)} obj=${state.style.objectiveBias.toFixed(2)} cas=${state.style.casualtyAversion.toFixed(2)}`;

    // Append declined context if player is refining a rejected proposal
    let llmMessage = userMsg;
    if (declinedContext) {
      llmMessage += `\n---DECLINED---\n之前的命令和方案：${declinedContext}\n指挥官对以上方案都不满意，请根据补充说明重新制定方案。`;
      setDeclinedContext(null);
    }

    // 语音回合的 user 侧同样推迟到 heard 结算——必须排在 assistant 文本入 context
    // 之前，才保得住 user→assistant 的顺序（本轮信封在上面就拼好了，不受影响）。
    if (!isVoiceTurn) pushContext(channelContextRef.current, ch, { role: "user", text: userMsg, time: state.time });

    // Helper: process a completed AdvisorResponse (shared by streaming & non-streaming paths)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const processAdvisorData = (data: any) => {
      // Restart guard (Codex 地基三-fix-2): if the battle this request was
      // sent from no longer exists, the WHOLE response is dropped silently —
      // its digest, gate decisions and intents all described a replaced
      // GameState. Object identity, not time: catches the poll race even at
      // new-game time 0.
      if (getState() !== state) {
        syncGameEpoch(getState() ?? state);
        return;
      }
      // ★第七轮：**同一个请求的回复只处理一次**（请求身份＝发出时生成的 traceId）。
      //   同一份回复被投递两次（同一条 SSE 里两个 options 事件、流尾巴出错后的重入……）⇒ 第二次
      //   完全 inert：不上屏、不进 context、不执行。这是执行幂等，不看内容、不看目的地——
      //   长官**另说一句**（哪怕一字不差）是一个新请求、新编号，照常处理。
      if (handledRepliesRef.current.includes(traceId)) return;
      handledRepliesRef.current = [...handledRepliesRef.current.slice(-31), traceId];

      // ── 语音输入 V1：heard 结算（本轮唯一一次，打字回合整块跳过）──
      //
      // send 时长官这句话还没被听写出来，所有读文本的地方都推迟到了这里。
      // 顺序讲究：user 侧 pushContext 必须排在下面那些 assistant 推送之前，
      // 否则下一轮的"最近在聊什么"会变成一段没人问的独白（直接喂大 F2）。
      const heard = typeof data?.heard === "string" && data.heard.trim().length > 0
        ? data.heard.trim()
        : "";
      if (isVoiceTurn) {
        if (heard) {
          updateLastPlayerMessage(ch, heard);                       // ① 气泡：🎤 → 他听到的原话
          commanderMemoryRef.current[ch].playerIntent = heard;      // ③
          pushContext(channelContextRef.current, ch, { role: "user", text: heard, time: state.time }); // ②
          if (activeEsc && (isCancelReply(heard) || isDeclineReply(heard))) clearEscalation(ch);       // ⑤
          bareConfirmExecRef.current = isConfirmReply(heard)        // ⑥ 记账时点从 send 挪到这里
            ? { escalateId: getActiveEscalation(ch, state.time)?.actionId ?? null }
            : null;
        } else {
          // 没听清：气泡如实停在占位，上下文补一行——不补的话下一轮只剩
          // assistant 的话，"最近在聊什么"会变成单边独白。
          pushContext(channelContextRef.current, ch, { role: "user", text: "（语音·未转写）", time: state.time });
        }
      }

      // ── spoken 层：这一轮说给耳朵的那一句（本轮只播一次）──
      //
      // prose 传的是**屏上真出现的那一段**，不是别的什么摘要：正常流是
      // data.brief，合同判决那条路是它自己那句判词。spoken 缺席就念它——
      // 一条规则覆盖四种缺席（模型忘写 / 白名单吃掉 / 兜底回执 / 通讯中断）。
      //
      // 调用点只有两处，且互斥（第一处走完就 return）：合同判决路一处、
      // 其余全部分支合用一处。放在这里而不是更早，是因为 stale 那一格的规矩是
      // 「displays NOTHING and writes NOTHING」——它也不该出声。
      //
      // ★刀B（办法一）改了两件事：
      //   ① 打字回合也走这里。流式期间不再边流边念（voiceSpeech 的 typed 分支
      //      已改判），正文缓在 accumulatedText 里，到这一刻才整段放出去。
      //   ② 多认一个输入 `execTurn`：会动兵的回合，这一段（spoken/正文）一声
      //      不出——它是引擎跑**之前**写的那一版，照念就是假确认。耳朵等
      //      `ApplyResult` 出来的执行回执（handleApprove 里那一声）。
      // ★第七轮：第三个参数说明这一段是谁的话。"engine"＝引擎已经裁定（拒绝／没执行／要问）：
      //   只念 prose（即屏上那一句），spoken 一概不念；"model"＝模型的咨询内容：语音回合念 spoken。
      //   这是本轮唯一改动的播报分流点——各失败分支不另写播报代码，引擎的话一律经这里或 refuseAloud。
      // 第九轮：appendix＝引擎附在这一段后面的事实（批准问题里的完整方案），不论念 spoken 还是正文都照念。
      const sayToEar = (prose: string, execTurn: boolean, authority: "model" | "engine" = "model", appendix?: string) => {
        const plan = planVoiceSpeech({
          voiceTurn: isVoiceTurn,
          spoken: typeof data?.spoken === "string" ? data.spoken : undefined,
          prose,
          heard,   // 引擎闸的尺：要念的那段若整句复读它，就不许念
          execTurn,
          authority,
          appendix,
        });
        if (ttsEnabled && plan.finalUtterance) {
          speak(plan.finalUtterance, ttsPersona);
          flush(ttsPersona); // 非流兜底路后面没有 flush，末句不许卡在句子缓冲里
        }
        return plan;
      };

      // ══ 第六轮：失败轮（服务端没拿到可用的参谋答复）══
      //
      // 服务端兜底标了 `failure`（解析失败 / 通讯中断 / 限流）⇒ 这一轮**什么都不执行**：
      // options、持续命令一律不看；待批准的方案、待答的选择一律不碰——它们原样留着，长官
      // 再说一遍还能接着办；也不算参谋又答了一轮（同 data.error）。屏上／耳朵／context 只放
      // 引擎那句事实，模型流出来的半截正文一个字都不采信。
      // ★排在一切判官之前：否则兜底会被判成「对待确认方案没给判词」⇒ 协议失败 ⇒ 方案作废，
      //   或者带着可执行 intent 一路走到闸与桶（台架 F1-F5 的原病：真实初始局下了 3 个设防令）。
      const failure = advisorFailureOf(data);
      if (failure) {
        setResponse(null);
        setError(null);
        setClarification(null);
        const line = advisorFailureLine(failure);
        traceClient(traceId, "model_failure", { failure });
        addMessage("warning", line, state.time, ch, undefined, "command_ack");
        pushContext(channelContextRef.current, ch, { role: "assistant", text: line, time: state.time });
        sayToEar(line, false, "engine");
        return;
      }

      // ── 地基二: pending semantic consumption, judged BEFORE anything else.
      // The verdict maps through pendingVerdictRoute — the ONE bench-testable
      // table of what may execute. stale (wrong id / cross-channel / expired /
      // duplicate delivery such as a stream that errored after processing and
      // re-entered via the fallback path) is fully fail-closed: no old
      // contract, no new options, no doctrine (Codex step2-fix). Error
      // responses never consume — the contract survives them.
      // 刀寅（审核 B）：参谋答了新的一轮（出错那一轮不算）。之后登记的方案记这一轮。
      if (!data.error) bumpReplyTurn(ch, traceId);
      if (!data.error) {
        const pcNow = pendingContractRef.current;
        // Restart guard: an old-battle contract is presented to the judge as
        // nonexistent (→ stale → fully inert) and dropped on the spot.
        if (pcNow && pcNow.epoch !== gameEpochRef.current) {
          pendingContractRef.current = null;
        }
        const pcSameEpoch = pcNow && pcNow.epoch === gameEpochRef.current ? pcNow : null;
        const judged = judgePendingConsumption({
          requestTag: pendingTag,
          current: pcSameEpoch
            ? { id: pcSameEpoch.id, channel: pcSameEpoch.channel, sessionId: pcSameEpoch.sessionId, phase: pcSameEpoch.phase, expiresAt: pcSameEpoch.expiresAt }
            : null,
          now: state.time,
          decision: parsePendingDecision((data as Record<string, unknown>).pendingDecision),
        });
        // 第七轮：判词与同一份回复里的单子在结构上合不合法（core.contractReplyConflict，唯一判定处）：
        //   authorize ⇒ 回复里**每一张**单子都得是存下方案的复述；amend ⇒ 只能有一种改法。
        //   不合法 ⇒ 按协议失败（零执行、旧方案作废、用引擎的话说清哪里对不上，请长官再说一遍）。
        //   不看第几张、不看 recommended——任何一张「碰巧与旧方案一致」都掩盖不了另一张的修改。
        const conflict = pcSameEpoch && (judged === "authorize" || judged === "amend")
          ? contractReplyConflict(state, pcSameEpoch.opt, judged, data.options) : null;
        const verdict = conflict ? "protocol_failure" as const : judged;
        const route = pendingVerdictRoute(verdict);
        if (pendingTag) traceClient(traceId, "pending", { verdict, judged, pendingId: pendingTag.pendingId, conflict: conflict ?? undefined });

        // Contract lifecycle per verdict. Expiry cleanup may ONLY clear the
        // very contract this request was tagged with — never a newer one that
        // was registered while this response was in flight.
        if (verdict === "authorize" || verdict === "cancel" || verdict === "amend") {
          pendingContractRef.current = null;
        } else if (verdict === "unrelated" || verdict === "protocol_failure") {
          // 刀寅（审核 B）：长官这句不是在答它（或答得不清），参谋接着又开了口——一次只挂一个
          //   问题，旧方案作废；要办就再说一次。只清这次标签指着的那一份，绝不碰更新的。
          if (pcSameEpoch && pendingTag && pcSameEpoch.id === pendingTag.pendingId) pendingContractRef.current = null;
        } else if (verdict === "stale") {
          // Expiry cleanup strictly THREE-way matched (id + channel + session)
          // AND expired — a newer contract registered mid-flight, or one with
          // a colliding id from another channel/session, is never touched.
          if (
            pcSameEpoch && pendingTag &&
            pcSameEpoch.id === pendingTag.pendingId &&
            pcSameEpoch.channel === pendingTag.channel &&
            pcSameEpoch.sessionId === pendingTag.sessionId &&
            state.time > pcSameEpoch.expiresAt
          ) {
            pendingContractRef.current = null;
          }
          // Truly inert (Codex step2-fix-2): a stale delivery — duplicate
          // stream-fallback re-entry, expired or cross-channel — displays
          // NOTHING and writes NOTHING; no second receipt, no context echo.
          setResponse(null);
          setError(null);
          return;
        }

        if (!route.processResponse) {
          setResponse(null);
          setError(null);
          // 第六轮（交接档 §5）：协议失败是**引擎拒绝**的路——屏上／耳朵／context 只说引擎的事实
          //   （什么都没执行、那份方案作废了），模型那一轮写的 brief 一个字都不采信（实测它会写
          //   「已经派过去了」，而实际零执行）。批准 / 取消两条路照旧用参谋自己的话。
          const line = verdict === "protocol_failure"
            ? (conflict?.kind === "authorize_changed"
                ? `您这句跟待确认的方案对不上（${conflict.differences.join("；")}）——那个方案没有执行，也不再挂着；要怎么办请再说一遍。`
                : conflict?.kind === "amend_ambiguous"
                ? `您要改方案，可我这边拿出了 ${conflict.plans} 种不同的改法——什么都没有执行，那个方案也不再挂着；请说要哪一种。`
                : "这句我没判断清是不是在答刚才待确认的方案——什么都没有执行，那个方案也不再挂着；要办请再说一遍。")
            : (data.brief as string) || (verdict === "authorize" ? "依令行事。" : "行，那就不动。");
          addMessage(verdict === "protocol_failure" ? "warning" : "info", line, state.time, ch, undefined, "command_ack", undefined, replyMark(ch));
          pushContext(channelContextRef.current, ch, { role: "assistant", text: line, time: state.time });
          // 语音说「可以」批准就走这条路：耳朵拿到的是 spoken，缺席则是这句判词。
          // 刀B：这条路**会执行**旧合同时，判词也不念——耳朵等执行回执。
          //   v2 把这条路排除在外是错的：它和流式那两条是同一个病（先说、后执行）。
          const willExecuteOldContract = route.executeOldContract && pcSameEpoch != null;
          const decisionPlan = sayToEar(line, willExecuteOldContract, verdict === "protocol_failure" ? "engine" : "model");
          if (route.executeOldContract && pcSameEpoch) {
            handleApprove(pcSameEpoch.opt, 0, "auto", pcSameEpoch.execCtx, pcSameEpoch.data, decisionPlan.speakExecReceipt, pcSameEpoch.selection);
          }
          return;
        }
        // amend / unrelated / no_pending → normal flow below (amend's old
        // contract is already cleared: ONLY the new intents may execute).
      }

      // ══ 刀己 (审核 §二): 候选选择合同的答复侧 ══
      //
      // 排在批准合同之后、耳朵开口之前。两份合同互不干涉：批准问的是"办不办"，
      // 这里问的是"办谁"。
      //
      // ★ 这一段就是「问完必须真正绑定候选」的落点，而**判断全在 core**
      //   （`planSelectionTurn`）——这里只执行它给的 plan，一个判断都不自己做。
      //   刀C 那一版把判断写在这层的闭包里，于是没有任何机器断言看得见它。
      const selSlotAtJudge = pendingSelectionRef.current;
      const selPersona = COMMANDERS.find((c) => COMMANDER_CHANNEL[c] === ch) ?? COMMANDERS[0];
      // ★复审 §一：`data.error` 那一轮**不许消费候选、也不许触发旧命令**。
      //   后端出错时模型根本没给出裁决，任何"顺手消费"都是引擎自己在决定。
      //   做法：这一轮当作没带标签（no_pending）⇒ passthrough ⇒ 下面的 error
      //   分支照常报错，待决槽原封不动留着，长官下一句还能接着答。
      const selTagThisTurn = data.error ? null : selectionTag;
      const selTurn = planSelectionTurn({
        state,
        slot: selSlotAtJudge && selSlotAtJudge.channel === ch
          ? {
              kind: selSlotAtJudge.kind,
              id: selSlotAtJudge.id,
              channel: selSlotAtJudge.channel,
              sessionId: selSlotAtJudge.sessionId,
              epoch: selSlotAtJudge.epoch,
              expiresAt: selSlotAtJudge.expiresAt,
              candidates: selSlotAtJudge.candidates,
              intentSnapshot: selSlotAtJudge.optionSnapshot.intents[selSlotAtJudge.intentIndex],
              allIntents: selSlotAtJudge.optionSnapshot.intents,
              intentIndex: selSlotAtJudge.intentIndex,
              selectionKeys: selSlotAtJudge.selectionKeys,
            }
          : null,
        requestTag: selTagThisTurn,
        epoch: gameEpochRef.current,
        now: state.time,
        persona: selPersona,
        // 服务端已转换成内部格式；core 只做内部形状校验，不再二次原始解析。
        decision: (data as Record<string, unknown>).dispatchSelection,
        personaLabel: COMMANDER_META[selPersona].label,
      });
      if (selTagThisTurn) traceClient(traceId, "selection", { verdict: selTurn.verdict, plan: selTurn.plan.kind });
      {
        // 槽的生命周期。过期清理**只许**清掉这次请求带的那一槽——等回复那几秒里
        // 若登记了更新的一槽，绝不碰它（照抄 pendingContract 的三方匹配规矩）。
        const sameSlot =
          selSlotAtJudge != null && selTagThisTurn != null &&
          selSlotAtJudge.id === selTagThisTurn.selectionId &&
          selSlotAtJudge.channel === selTagThisTurn.channel &&
          selSlotAtJudge.sessionId === selTagThisTurn.sessionId;
        if (!selTurn.keepSlot && sameSlot) {
          if (selTurn.verdict !== "stale" || selTurn.clearExpiredSlot) pendingSelectionRef.current = null;
        }
      }

      // ★复审 §二：inert ⇒ 一件事都不做。不上屏、不进 context、新旧 options
      //   一律不执行——它多半是**同一次回复的重复投递**（SSE 已经处理过 options，
      //   随后 stream error 又走了 /api/command 兜底）。规矩逐字照抄
      //   pendingContract 的 stale 那一格：displays NOTHING and writes NOTHING。
      if (selTurn.plan.kind === "inert") {
        setResponse(null);
        setError(null);
        return;
      }
      if (selTurn.plan.kind !== "passthrough") {
        setResponse(null);
        setError(null);
        // 这一轮的走向已经定了，上面那一层（spoken/正文）一声不出——它是模型在
        // 引擎跑**之前**写的那一版（刀B 的规矩）。声音由下面各自那一句带。
        // 第七轮：这一轮归引擎裁定（执行／拒绝／再问），模型的 spoken 一声都不念；要说的话由
        //   执行回执或 refuseAloud / ask* 那一句带（它们本来就上屏、进 context、出声）。
        const selPlan = sayToEar("", selTurn.plan.kind === "execute" || selTurn.plan.kind === "quantity_chosen", "engine");
        if (selTurn.plan.kind === "quantity_chosen") {
          // 第六轮：按长官选的读法改写**原命令**（不是模型这一轮写的单子），整组重走主链。
          const slot = selSlotAtJudge!;
          const q = slot.quantity;
          const read = q ? applyQuantityReading(slot.optionSnapshot.intents, q, selTurn.plan.key) : null;
          // 已选来源的 key 按下标记账：合并后跟着挪；挪到同一格却是不同的 key ⇒ 来源记录失效。
          const keys = read ? slot.selectionKeys.map((k) => ({ ...k, intentIndex: read.indexMap.get(k.intentIndex) ?? -1 })) : [];
          const reqs = read ? slot.requirements.map((r) => ({ ...r, intentIndex: read.indexMap.get(r.intentIndex) ?? -1, offeredKeys: [...r.offeredKeys] })) : [];
          const clash = keys.some((k, i) => k.intentIndex < 0 || keys.some((o, j) => j !== i && o.intentIndex === k.intentIndex && o.selectionKey !== k.selectionKey));
          if (!read || !q || clash) {
            refuseAloud(state, ch, "刚才那道命令的人数记录已经失效，整道命令没有执行，请重新下令。", true);
          } else {
            const snapshot = optionWithResolvedIntents(slot.optionSnapshot, read.intents);
            const uniq = <T extends { intentIndex: number }>(xs: T[]) => xs.filter((x, i) => xs.findIndex((y) => y.intentIndex === x.intentIndex) === i);
            traceClient(traceId, "quantity_chosen", { key: selTurn.plan.key, signature: q.signature });
            handleApprove(snapshot, slot.optionIndex, "auto", slot.execCtx, slot.sourceResponse, selPlan.speakExecReceipt, {
              optionSnapshot: snapshot,
              optionIndex: slot.optionIndex,
              selectionKeys: uniq(keys),
              requirements: uniq(reqs),
              expiresAt: slot.expiresAt,
              selectedUnitIds: slot.selectedUnitIds,
              sourceResponse: slot.sourceResponse,
              quantityConfirmed: [...(slot.quantityConfirmed ?? []), q.signature],
            });
          }
        } else if (selTurn.plan.kind === "reask_quantity") {
          const slot = selSlotAtJudge!;
          addMessage("info", selTurn.plan.lead, state.time, ch, undefined, "command_ack");
          pushContext(channelContextRef.current, ch, { role: "assistant", text: selTurn.plan.lead, time: state.time });
          if (slot.quantity) {
            askQuantityReading(state, ch, { ...slot.quantity, candidates: slot.candidates }, true, slot, slot.execCtx, true);
          }
        } else if (selTurn.plan.kind === "execute") {
          const p = selTurn.plan;
          // ★复审 §三：交给主链的是**整组** intents（绑定结果已放回原位置），
          //   不是只有绑定那一条——其余 intents 一条都不许丢。整组重走主链预检。
          handleApprove(
            selSlotAtJudge!.optionSnapshot,
            selSlotAtJudge!.optionIndex, "auto", selSlotAtJudge!.execCtx,
            selSlotAtJudge!.sourceResponse, selPlan.speakExecReceipt,
            { ...selSlotAtJudge!, selectionKeys: p.selectionKeys },
          );
        } else if (selTurn.plan.kind === "refuse") {
          refuseAloud(state, ch, selTurn.plan.line, true);
        } else {
          // reask：零执行，把没执行这件事说清楚，再问一遍（候选已现查过滤）。
          const p = selTurn.plan;
          addMessage("info", p.lead, state.time, ch, undefined, "command_ack");
          pushContext(channelContextRef.current, ch, { role: "assistant", text: p.lead, time: state.time });
          askWhichDispatch(
            state, ch, p.candidates, true,
            selSlotAtJudge!, selSlotAtJudge!.execCtx, selSlotAtJudge!.intentIndex,
            true, p.soleCandidate,
          );
        }
        return;
      }
      // ══ 刀己 段落结束（no_pending / unrelated 走下面的正常流程）══

      // ══ 刀寅：陈要长官点头的**具体方案**（只认 CONFIRM ＋ 一个完整方案）══
      //
      // 病（实测，玩家那局的原对话复现 6/10）：陈反问「您指的是 G2 吗？」时手里没有
      // 结构化的方案，长官答「是的」，模型只能凭记忆把命令**重写一遍**——重写时把
      // 「北线前哨」丢了、只剩「北部战线」。修法＝陈要长官点头一个**已经完整**的方案时
      // （responseType CONFIRM），这一刻把方案存成待确认合同（复用高影响确认那套：
      // 同频道、同局、有期限、只消费一次）；长官同意就执行**存下的这份**，执行前全链复核。
      //   · 只认 CONFIRM ＋ 恰好一个 ＋ 完整（isCompleteConfirmPlan）。**开放问题**（ASK，
      //     哪怕夹着一张暂定单子）不进批准流程——长官一句「对」会走确认词捷径直接执行草稿
      //     （审核实测复现）。
      //   · 高影响方案不在这里存，交给下面现成的高影响链（先把代价说出来再等批准）；
      //   · 这一轮零执行。以前 ASK/CONFIRM 带方案会掉进下面的可执行分支，可能直接执行。
      {
        const rtNow = typeof data.responseType === "string" ? (data.responseType as string).toUpperCase() : "";
        const askOpts = Array.isArray(data.options) ? (data.options as AdvisorOption[]) : [];
        if (!data.error && (rtNow === "CONFIRM" || rtNow === "ASK") && askOpts.length > 0) {
          const plan = rtNow === "CONFIRM" && askOpts.length === 1 && isCompleteConfirmPlan(askOpts[0]) ? askOpts[0] : null;
          const planGate = plan
            ? canAutoExecute(plan, isVoiceTurn ? heard : userMsg, state, [], isGroupChat, COMMANDER_REFS)
            : null;
          if (!(plan && planGate?.reason === "high_impact")) {
            setResponse(null);
            setError(null);
            const question = (data.brief as string) || "长官，按这个方案办吗？";
            // 第九轮：登记了待批方案，这一问就必须带上**存下的那份完整方案**（模型的问句可能只说了其中一条）。
            let planLine = "";
            if (plan) {
              const planText = registerApprovalPlan(state, ch, {
                opt: plan, data: data as DisplayResponse, phase: "awaiting_reply", question, // 问句这一刻就上屏了
                execCtx: {
                  channel: ch, threadId: activeThreadOnChannel?.id, requestId: crypto.randomUUID(), escalateId,
                  run: stampRun(gameEpochRef.current, state), traceId,
                  playerText: isVoiceTurn ? heard : userMsg,
                },
              });
              planLine = `要办的是：${planText}。`;
              setClarification(null);
            } else {
              // 开放问题：不存、不执行，长官下一句照常交给模型理解。
              setClarification(question + " — 请回答或重新下令");
            }
            traceClient(traceId, "confirm_captured", {
              captured: !!plan, responseType: rtNow, options: askOpts.length,
              intents: plan ? (plan.intents ?? []).map((i) => intentFacts(i as unknown as Record<string, unknown>)) : undefined,
            });
            const shown = planLine ? `${question} ${planLine}` : question;
            addMessage("info", shown, state.time, ch, undefined, "command_ack", undefined, replyMark(ch));
            pushContext(channelContextRef.current, ch, { role: "assistant", text: shown, time: state.time });
            // 耳朵：模型那半句照旧（语音回合念 spoken），后面接同一句完整方案（屏上那一串原样）。
            sayToEar(question, false, "model", planLine || undefined);
            return;
          }
          // 高影响方案：落到下面的高影响链（bucket B → 先说代价 → 登记合同），不在这里另登记。
        }
      }

      // ── 刀B：这一回合到底会不会动兵，必须在耳朵开口之前就算出来 ──
      //
      // 闸与桶原本算在下面那个 actionable 分支里，而耳朵在这一行就开口了——
      // 于是"先说、后执行"是结构决定的，不是谁忘了改。把判定提到开口之前，
      // 下面的分支**直接用这三个值，不再算第二遍**（算两遍就会漂）。
      // ★控制流逐字保持：willExecute 的公式与下面的分支条件一模一样
      //   （gate.auto 捷径在前、decideBucket 在后），本刀不趁机改闸。
      const optionsArr = Array.isArray(data.options) ? (data.options as AdvisorOption[]) : [];
      const actionableTurn =
        !data.error &&
        !(typeof data.responseType === "string" && (data.responseType as string).toUpperCase() === "NOOP") &&
        optionsArr.length > 0;
      const execGate: { auto: boolean; reason?: string; playerNamedSquad?: boolean } = actionableTurn
        // ④ 语音回合喂 heard——闸靠正则在长官的话里找锚（番号/领队名/「选中」），
        //   没有文本它会把每一句都当成"长官没点名"。
        ? canAutoExecute(optionsArr[0], isVoiceTurn ? heard : userMsg, state, [], isGroupChat, COMMANDER_REFS)
        : { auto: false };
      const execOpt0 = actionableTurn ? optionsArr[0] : undefined;
      const execStaleRefs = actionableTurn ? detectStaleSquadRefs(optionsArr, state, COMMANDER_REFS) : [];
      const execBucket = actionableTurn
        ? decideBucket({
            gate: execGate,
            hasOption: execOpt0 != null,
            staleRefCount: execStaleRefs.length,
            voiceTurn: isVoiceTurn,
            heardPresent: heard.length > 0,
          })
        : "B";
      const willExecute =
        actionableTurn &&
        ((execGate.auto && optionsArr.length >= 1) || (execBucket === "A" && execOpt0 != null));
      traceClient(traceId, "route", {
        responseType: data.responseType, options: optionsArr.length, error: data.error ?? undefined,
        gateAuto: execGate.auto, gateReason: execGate.reason, bucket: actionableTurn ? execBucket : undefined, willExecute,
      });

      // 选择合同已在上方处理：模型做语义分类，引擎核对本次给出的 key；
      // unclear 再问且零执行，不复用普通批准的确认词表。

      // 其余全部分支（error / NOOP / 空 options / 正常命令）合用这一处：它们
      // 屏上显示的都是 data.brief（或它为空时各自的兜底行），所以耳朵听的也是它。
      // ★第七轮：会动兵却**不自动执行**的那一格（桶 B 问一句／桶 C 先说代价）是引擎的裁定——
      //   这里一声不出，那一问在它真正上屏的地方由 refuseAloud 念（静态问句当场、代价台词到了再念）。
      //   旧写法在这里念模型的 spoken（「两个这就过去」「全军这就压上去」），而引擎其实没执行、在问长官。
      const engineAsks = actionableTurn && !willExecute;
      const speechPlan = engineAsks
        ? sayToEar("", false, "engine")
        : sayToEar((data.brief as string) || "", willExecute);
      if (data.error) {
        setError(data.error as string);
        setResponse(null);
        selectedIdsSnapshotRef.current = undefined;
        addMessage("urgent", `后端错误: ${data.error}`, state.time, ch, undefined, "system");
      } else if (typeof data.responseType === "string" && (data.responseType as string).toUpperCase() === "NOOP") {
        setResponse(null);
        setError(null);
        setClarification(null);
        const msg = (data.brief as string) || "Copy, standing by.";
        addMessage("info", msg, state.time, ch, undefined, "command_ack", undefined, replyMark(ch));
        if (data.brief) {
          pushContext(channelContextRef.current, ch, { role: "assistant", text: data.brief as string, time: state.time });
        }
        // Step 2: Process BOTH standingOrder and cancelDoctrine on NOOP path.
        // NOOP doctrine is location-scoped only (no approved intents → assignedSquads stays empty;
        // squad-binding requires schema extension, out of scope for Step 2).
        processDoctrineFields(data as unknown as Record<string, unknown>, state, ch);
      } else if (Array.isArray(data.options) && data.options.length === 0) {
        // Step 2 hardening: doctrine-only commands may emit options:[] without explicit responseType:"NOOP".
        // Schema validator (schema.ts:175 Day 13 Layer B path) preserves standingOrder/cancelDoctrine
        // through this code path, but previously they were silently dropped. Check for doctrine fields
        // BEFORE treating as failed clarification.
        const hasDoctrineFields =
          (data.standingOrder && typeof data.standingOrder === "object")
          || (typeof data.cancelDoctrine === "string" && data.cancelDoctrine.length > 0);
        if (hasDoctrineFields) {
          setResponse(null);
          setError(null);
          setClarification(null);
          if (data.brief) {
            addMessage("info", data.brief as string, state.time, ch, undefined, "command_ack", undefined, replyMark(ch));
            pushContext(channelContextRef.current, ch, { role: "assistant", text: data.brief as string, time: state.time });
          }
          // processDoctrineFields surfaces its own warning when must_hold locationTag can't be canonicalized.
          processDoctrineFields(data as unknown as Record<string, unknown>, state, ch);
        } else {
          setResponse(null);
          setError(null);
          const reason = (data.brief as string) || "命令目标不存在或不明确";
          setClarification(reason + " — 请重新描述指令");
          addMessage("warning", reason, state.time, ch, undefined, "command_ack");
          // Preserve the clarification question in context so a follow-up
          // short confirmation ("对的"/"yes") can be resolved against it.
          pushContext(channelContextRef.current, ch, {
            role: "assistant",
            text: reason,
            time: state.time,
          });
        }
      } else {
        // 7c.1-stab (A2 Tier 1): an actionable reply (≥1 option) resolves the
        // escalation it was answering — clear it so later commands aren't biased by
        // stale context. Guard by id so a newer escalation arriving mid-round-trip
        // isn't dropped. The NOOP / clarification branches above deliberately keep
        // the escalation alive for a follow-up.
        if (escalateId && getActiveEscalation(ch, state.time)?.actionId === escalateId) {
          clearEscalation(ch);
        }
        // ★刀壬 (审核 §五)：**会动兵的回合不把 data.brief 推进 context**。
        //   它是模型在引擎跑之前写的方案（"准备让北线部队撤回前哨"）。推进去 ⇒
        //   下一轮模型记得的是它以为发生的事；而真实结果（真人数、真落点、
        //   被拒的原因）随后才由执行回执 / refuseAloud 推进来，覆盖不掉它。
        //   计划不许压过结果：会动兵就不写，等结果那一句。
        //   不会动兵的回合（咨询/反问）照旧写——那句话本身就是这一轮的全部事实。
        if (data.brief && !willExecute) {
          pushContext(channelContextRef.current, ch, { role: "assistant", text: data.brief as string, time: state.time });
        }

        // 刀B：闸已在耳朵开口之前算过（willExecute 那一段）。这里**复用**，
        // 不再算第二遍——两处各算一遍就会漂，而播报的诚实性正押在"说的和做的
        // 是同一个判定"上。
        const gate = execGate;

        const requestId = crypto.randomUUID();
        const execCtx: ExecContext = {
          channel: ch, threadId: activeThreadOnChannel?.id, requestId, escalateId,
          // 刀癸：盖印。四条批准路（auto / bucket A / 手点 / 高影响确认）共用这一份 ctx。
          run: stampRun(gameEpochRef.current, state),
          traceId,
          playerText: isVoiceTurn ? heard : userMsg,
        };
        latestRequestIdRef.current = requestId;

        if (gate.auto && (data.options as AdvisorOption[]).length >= 1) {
          const autoData = data as DisplayResponse;
          setTimeout(() => handleApprove(autoData.options[0], 0, "auto", { ...execCtx, freshPlan: true }, autoData, speechPlan.speakExecReceipt), 0);
        } else {
          const reason = gate.reason;
          const opt0 = execOpt0; // 刀B：与 willExecute 同一份候选，不另取
          if (reason) {
            const intent0 = opt0?.intents?.[0] ?? opt0?.intent;
            console.log(`[P1 gate] no-auto reason=${reason}`, {
              numIntents: opt0?.intents?.length ?? (opt0?.intent ? 1 : 0),
              fromSquad: intent0?.fromSquad,
              quantity: intent0?.quantity,
              type: intent0?.type,
              toFront: intent0?.toFront,
            });
          }
          responseExecCtxRef.current = execCtx;
          // Step 5 — no more A/B/C command card. Route the safety gate's false reason
          // into 3 buckets; setResponse(card) is never shown for a command now.
          setResponse(null);
          setError(null);

          // Safety net stays: a brief that references squads which died in-flight must
          // never blind-execute — it disqualifies bucket A and falls through to ask/warn.
          const staleRefs = execStaleRefs;

          // Bucket A — clear command, player named no squad of their own → the advisor
          // picked. Auto-execute the recommended option; the persona's own reply and
          // the execution receipt already name who was picked and where they went.
          //
          // 手测账② (用户判退 2026-08-02)：the fixed "您没点名部队，我按战况替您
          // 安排" note is gone. It was a machine explaining itself in a channel that
          // is supposed to contain only people talking — 台词禁死模板 (07-22) +
          // 对话是唯一界面 (07-22), both standing law. Nothing is lost: the very next
          // lines are 「执行: 调度 9 个单位进攻2. 山脊战线」 and the persona's own
          // 「是，长官。Aiden继续推进」, which carry who/where between them.
          // If "I picked for you" ever needs saying again, it is the LLM's line to
          // write in its own voice — never a template that three personas recite.
          //
          // 判定本体已搬进 autoExecuteGate.decideBucket（这里只路由）——它是本刀
          // 那条新安全行为的落点，留在闭包里就没有任何机器断言看得见它。
          // voiceTurn/heardPresent 由步 3 的语音回合接线喂进来；打字回合两者恒 false，
          // decideBucket 逐字等价于原来这两行。
          const bucket = execBucket;

          // `&& opt0` 只为让 TS 收窄类型——decideBucket 判到 "A" 时 hasOption 必为真，
          // 语义上是重复的，不是第二道判定。
          if (bucket === "A" && opt0) {
            setClarification(null);
            setTimeout(() => handleApprove(opt0, 0, "auto", { ...execCtx, freshPlan: true }, data as DisplayResponse, speechPlan.speakExecReceipt), 0);
          } else {
            // Bucket B (clarify) / C (confirm high_impact). Voice the concern/question.
            // high_impact → stash a LOCAL pending-confirm so the player's next confirm
            // word executes THIS option directly (resolved in sendCommand), with no LLM
            // round-trip that would re-emit the unscoped intent and re-trigger
            // high_impact (the loop). Bucket B still resolves via the LLM's SHORT
            // FOLLOW-UP RESOLUTION. Nothing executes here.
            if (reason === "high_impact" && opt0) {
              // 地基二: register the FULL contract BEFORE the concern is voiced
              // (phase "voicing" — nothing can consume it yet). 地基三 will slot
              // the async preflight voice between this registration and the
              // awaiting_reply flip below.
              registerApprovalPlan(state, ch, {
                opt: opt0, data: data as DisplayResponse, execCtx, phase: "voicing", question: "照打还是留兵",
              });
            }
            // ── 地基三: preflight VOICE for single-intent high-impact contracts.
            // The engine previews the order (pure), hands the exact cost facts
            // to the dedicated mode:"preflight" channel, and Chen voices the
            // concern in character. Outside the preview scope (multi-intent /
            // preview null) the static gate question stays — cost claims are
            // never made off-mirror. While the voice is in flight the contract
            // stays "voicing": nothing can consume it (no informed consent
            // before the concern is visible).
            const contractForVoice = reason === "high_impact" ? pendingContractRef.current : null;
            const voiceIntents = opt0?.intents?.length ? opt0.intents : (opt0?.intent ? [opt0.intent] : []);
            const concernFacts = (() => {
              if (!contractForVoice || voiceIntents.length !== 1) return null;
              const pv = previewHighImpactIntent(voiceIntents[0], state, state.style);
              return pv ? buildPreflightConcernFacts(state, pv) : null;
            })();
            if (contractForVoice && concernFacts) {
              setClarification(null);
              const voicedContractId = contractForVoice.id;
              const factsPayload = serializePreflightFacts(concernFacts);
              const engineFallback = buildPreflightFallbackLine(concernFacts);
              const voicedEpoch = gameEpochRef.current;
              const postConcern = (line: string) => {
                // Async guards (Codex 地基三-fix): post + flip ONLY if the very
                // contract we started voicing is still alive — same id, same
                // channel, same session, SAME GAME EPOCH (a restart mid-voice
                // discards the concern: it belongs to a battle that no longer
                // exists), still voicing, and unexpired against the FRESH clock.
                const pcLive = pendingContractRef.current;
                const sNow = getState();
                // Object identity first (fix-2): the voice belongs to the very
                // battle it was computed from; a replaced GameState discards it
                // even before the poll or epoch has caught up.
                if (sNow !== state) {
                  if (sNow) syncGameEpoch(sNow);
                  return;
                }
                if (
                  !pcLive ||
                  pcLive.id !== voicedContractId ||
                  pcLive.phase !== "voicing" ||
                  pcLive.channel !== ch ||
                  pcLive.sessionId !== SESSION_ID ||
                  pcLive.epoch !== voicedEpoch ||
                  pcLive.epoch !== gameEpochRef.current ||
                  !sNow
                ) return;
                if (sNow.time > pcLive.expiresAt) {
                  pendingContractRef.current = null;
                  return;
                }
                // 第七轮：代价那一问是引擎的裁定——屏／耳／context 同一句，经同一个出口。
                // 第八轮：代价台词后面跟上**存下方案**的完整说法——点头批的就是这一份。
                refuseAloud(sNow, ch, `${line} 要办的是：${describePlanForApproval(sNow, pcLive.opt.intents?.length ? pcLive.opt.intents : [pcLive.opt.intent])}。`, true);
                pendingContractRef.current = { ...pcLive, phase: "awaiting_reply" };
              };
              const ac = new AbortController();
              const voiceTimer = setTimeout(() => ac.abort(), 6000);
              fetch(`${API_URL}/api/brief`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ digest: factsPayload, channel: ch, mode: "preflight" }),
                signal: ac.signal,
              })
                .then((r) => r.json())
                .then((resp: { brief?: unknown }) => {
                  clearTimeout(voiceTimer);
                  const briefText = typeof resp?.brief === "string" ? resp.brief.trim() : "";
                  // 问号校验: the concern MUST be a question; anything else →
                  // engine fallback with the real numbers.
                  const line = briefText.length > 0 && /[？?]\s*$/.test(briefText) ? briefText : engineFallback;
                  postConcern(line);
                })
                .catch(() => {
                  clearTimeout(voiceTimer);
                  postConcern(engineFallback);
                });
            } else {
              const q = buildGateQuestion(reason, (data.brief as string) || "", staleRefs,
                reason === "high_impact" && pendingContractRef.current?.phase === "voicing"
                  ? describePlanForApproval(state, pendingContractRef.current.opt.intents?.length ? pendingContractRef.current.opt.intents : [pendingContractRef.current.opt.intent])
                  : undefined);
              // Voice-polish v1 (Codex-approved): the question renders ONCE as a
              // chat bubble — no parallel clarification banner with the same
              // text. pushContext + the pending contract above stay unchanged.
              setClarification(null);
              // 第七轮：引擎不自动执行、要问长官——这一问屏／耳／context 同一句（refuseAloud）。
              refuseAloud(state, ch, q, true);
              if (reason === "high_impact" && pendingContractRef.current?.phase === "voicing") {
                // The concern is now VISIBLE — only from this moment may a reply
                // consume the contract (no informed consent before display).
                pendingContractRef.current = { ...pendingContractRef.current, phase: "awaiting_reply" };
              }
            }
          }
        }
      }
    };

    // ── Streaming path (default), with fallback to non-streaming ──
    //
    // ★复审 §二：**同一条命令只能执行一次**。
    //   病：SSE 收到 options 后 `processAdvisorData` 已经执行了这一轮，可万一
    //   之后读流再抛错（连接断在末尾、EOF 解析失败…），catch 会去走
    //   `/api/command` 兜底、把**同一条命令再执行一遍**。标记放在 try 之外，
    //   catch 才看得见。
    let optionsProcessed = false;
    try {
      const streamRes = await fetch(`${API_URL}/api/command-stream`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ digest, message: llmMessage, styleNote, channel: ch, sessionId: SESSION_ID, escalateId, traceId, audio: voice ? { data: voice.data, format: voice.format } : undefined, voiceDiag: voice ? getVoiceOpenDiag() ?? undefined : undefined, speechDiag: takeSpeechDiag() }),
      });

      if (!streamRes.ok || !streamRes.body) {
        throw new Error("stream_unavailable");
      }

      // SSE streaming
      const reader = streamRes.body.getReader();
      const decoder = new TextDecoder();
      let sseBuffer = "";
      let accumulatedText = "";
      let gotOptions = false;

      setStreamingText("");
      // 打字回合照旧：新流开始前清掉上一段 TTS。
      // 语音回合**不清**——队列里此刻只有刚播的那声本地应答，一清就把"我在听"
      // 掐掉了；而这条路上的 TTS 早在按下 🎤 的那一瞬间就 cancel() 过一次
      // （startPTT:502，防陈的声音被录进长官的命令里），没有旧队列可清。
      if (!isVoiceTurn) cancel(); // reset TTS for new stream

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        sseBuffer += decoder.decode(value, { stream: true });

        const lines = sseBuffer.split("\n");
        sseBuffer = lines.pop() ?? "";

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || !trimmed.startsWith("data: ")) continue;
          const payload = trimmed.slice(6);
          if (payload === "[DONE]") continue;

          try {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const event = JSON.parse(payload) as { type: string; content: any };
            if (event.type === "text") {
              accumulatedText += event.content;
              setStreamingText(accumulatedText);
              // 语音回合正文不进耳朵（它是写给眼睛的那一版）——耳朵等 spoken。
              // ★刀B（办法一）起，**打字回合也不在这里出声**：流式这一刻还不知道
              //   这回合会不会动兵（模型先写正文、后写 JSON），念出去就收不回来。
              //   正文改由 accumulatedText 缓着，裁决完在 sayToEar 整段放出。
              //   这一行保留着不删：它是"边流边念"唯一的接线口，将来若改用
              //   服务端先报回合类型（办法二），翻 planVoiceSpeech 一个字段即可复活。
              if (ttsEnabled && sendPlan.speakProseWhileStreaming) speak(event.content, ttsPersona);
            } else if (event.type === "options") {
              gotOptions = true;
              optionsProcessed = true;   // ★这一轮已经处理过：兜底不许再来一遍
              setStreamingText(null);
              const data = event.content; // already an object, no double-parse
              // Override brief with streamed text if LLM didn't include it in JSON
              if (accumulatedText && !data.brief) {
                data.brief = accumulatedText.trim();
              }
              processAdvisorData(data);
            } else if (event.type === "error") {
              throw new Error(event.content);
            }
          } catch (parseErr) {
            if (parseErr instanceof SyntaxError) continue; // skip malformed SSE
            throw parseErr;
          }
        }
      }

      // Flush remaining buffer on EOF
      if (sseBuffer.trim()) {
        const trimmed = sseBuffer.trim();
        if (trimmed.startsWith("data: ")) {
          const payload = trimmed.slice(6);
          if (payload !== "[DONE]") {
            try {
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              const event = JSON.parse(payload) as { type: string; content: any };
              if (event.type === "text") {
                accumulatedText += event.content;
                setStreamingText(accumulatedText);
                if (ttsEnabled && sendPlan.speakProseWhileStreaming) speak(event.content, ttsPersona);
              } else if (event.type === "options") {
                gotOptions = true;
                optionsProcessed = true;   // ★同上：EOF 兜底那一处也算处理过
                setStreamingText(null);
                const data = event.content;
                if (accumulatedText && !data.brief) data.brief = accumulatedText.trim();
                processAdvisorData(data);
              }
            } catch { /* skip */ }
          }
        }
      }

      // Flush any remaining TTS sentence buffer (held inside ./tts module).
      if (ttsEnabled) flush(ttsPersona);

      if (!gotOptions) {
        setStreamingText(null);
        throw new Error("stream_no_options");
      }
    } catch (streamErr) {
      // Fallback to non-streaming /api/command
      setStreamingText(null);
      // ★复审 §二：这一轮的 options **已经处理过**（SSE 那一程执行完了），
      //   之后才抛的错只是流尾巴上的事故。再走一次 `/api/command` 等于把同一条
      //   命令执行第二遍——屏上两份回执、兵被派两次、台账记两笔。
      //   选择合同的 stale 那一格是第二道网（同一个 selectionId 的第二次投递会
      //   被判 inert），这一道是第一道：**根本不发第二个请求**。
      if (optionsProcessed) {
        console.debug("[Streaming] options already processed — fallback suppressed", streamErr);
        setLoading(false);
        return;
      }

      const isStreamFailure = streamErr instanceof Error &&
        (streamErr.message === "stream_unavailable" || streamErr.message === "stream_no_options");

      if (isStreamFailure) {
        console.debug("[Streaming] falling back to /api/command");
      }

      try {
        const res = await fetch(`${API_URL}/api/command`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ digest, message: llmMessage, styleNote, channel: ch, sessionId: SESSION_ID, escalateId, traceId, audio: voice ? { data: voice.data, format: voice.format } : undefined, voiceDiag: voice ? getVoiceOpenDiag() ?? undefined : undefined, speechDiag: takeSpeechDiag() }),
        });
        const data = await res.json();
        processAdvisorData(data);
      } catch {
        const errMsg = "无法连接服务器，请检查网络或稍后再试";
        setError(errMsg);
        setResponse(null);
        selectedIdsSnapshotRef.current = undefined;
        addMessage("urgent", "通信中断: 无法连接后端", state.time, ch, undefined, "system");
      }
    }
    setLoading(false);
  };

  // 松手时 stopPTT 要把这次录音发出去，而它是 useCallback、定义在 sendCommand
  // 之前——用 ref 转一手。（现状那条 Web Speech 路的旧解法是"去点一下发送按钮"，
  // 同一个问题；录音路不经过输入框，就不必再借 DOM。）
  sendVoiceRef.current = (v: VoiceRecording) => { void sendCommand(v); };

  // ── handleApprove (0.4: migrated from CommandPanel) ──
  /** spoken 层 R2：`speakReceipt=false` ⇒ 这一轮耳朵已经从 spoken 那儿听过这件事，
   *  回执不再单独出声（屏上那行一个字不动）。默认 true＝分层之前的行为，
   *  所以没被改过的调用点（手点批准、打字词表快路）逐字等价。 */
  const handleApprove = (
    opt: AdvisorOption,
    idx: number,
    mode: "auto" | "manual" = "manual",
    ctx?: ExecContext,
    sourceResponse?: DisplayResponse,
    speakReceipt: boolean = true,
    /** 连续选择的原命令与稳定 key；名单在本次调用中重新取。 */
    selectionProgress?: SelectionProgress,
  ) => {
    const state = getState();
    if (!state) return;

    const execCtx0 = ctx ?? responseExecCtxRef.current;
    // 第六轮：「模型这一轮新写的」只对这一次调用有意义；存进待确认方案 / 待答问题的那份上下文一律不带它。
    const freshPlan = execCtx0?.freshPlan === true;
    const execCtx = execCtx0 && freshPlan ? { ...execCtx0, freshPlan: undefined } : execCtx0;
    const ch = execCtx?.channel ?? getActiveChannel();

    // ★刀癸 (审核 §六)：局印复核，排在**任何**写状态 / 发消息 / 下单之前。
    //   四条批准路都带同一份 ctx，所以这一道一处就罩住全部；
    //   跨局的旧回调静默作废（只留一条诊断，不污染新局的屏幕与 context）。
    //   没盖印的 ctx 同样按作废处理（fail-closed）——但手点批准那条路
    //   `ctx` 可能为空、由 responseExecCtxRef 兜底，它也是盖过印的。
    if (!runGuardAllows(execCtx?.run, gameEpochRef.current, state)) {
      state.diagnostics.push({
        time: state.time, code: "STALE_RUN_DROPPED",
        message: `跨局回调已作废（${judgeRunGuard(execCtx?.run, gameEpochRef.current, state)}）`,
      });
      return;
    }

    // Validate: reject approve if response has already been cleared (stale click).
    if (mode === "manual" && !response) {
      addMessage("warning", "响应已过期，请重新下令", state.time, ch, undefined, "system");
      return;
    }

    // 刀B：A/B/C 那个字母不再上屏（卡片早已砍掉，而它只出现在那句执行前的
    // 方案标题里）。方案标题本身留着进诊断，供对账用。
    const speakingPersona = COMMANDERS.find((c) => COMMANDER_CHANNEL[c] === ch) ?? COMMANDERS[0];
    const progress: SelectionProgress = selectionProgress ?? {
      optionSnapshot: cloneSelectionOption(opt),
      optionIndex: idx,
      selectionKeys: [],
      requirements: [],
      expiresAt: state.time + HIGH_IMPACT_CONFIRM_WINDOW_SEC,
      selectedUnitIds: selectedIdsSnapshotRef.current ? [...selectedIdsSnapshotRef.current] : undefined,
      sourceResponse: sourceResponse ?? response ?? undefined,
    };
    if (selectionProgress && state.time > progress.expiresAt) {
      refuseAloud(state, ch, "刚才那道命令已经过期，整道命令没有执行，请重新下令。", speakReceipt);
      return;
    }
    // 保持原有顺序：名下没兵／点名了别人麾下的队，先拒绝，不追问“哪一批”。
    // 这里只读原命令；不冻结权限池，最终绑定和票据解析仍按实时权限取交集。
    for (const intent of progress.optionSnapshot.intents) {
      const auth = checkDispatchAuthority(state, speakingPersona, intent);
      if (auth.kind === "denied") {
        const who = COMMANDER_META[speakingPersona].label;
        refuseAloud(state, ch,
          auth.reason === "commands_no_forces"
            ? `${who}名下没有部队，这道命令未执行——调兵请对带兵的指挥官说。`
            : `那支部队不在${who}麾下，这道命令未执行——请对${COMMANDER_META[auth.ownerOfNamed!].label}下令。`,
          speakReceipt);
        return;
      }
    }
    // ── 第六轮：数量读法（「两个」被按兵种拆成坦克两个＋步兵两个）⇒ 先问，零执行 ──
    //   判定在 core（findQuantityAmbiguity）。排在「是哪一批」之前：「一共」读法会把一组合成一条，
    //   来源的选择按下标记账，先定数量再选来源，下标就不会挪。答过的组记在 quantityConfirmed，
    //   同一道命令里不再问同一组——**没有"下一轮豁免"**：豁免只认这份存下的答案，不认模型那一轮写了什么。
    {
      const said = execCtx?.playerText;
      const confirmed = new Set(progress.quantityConfirmed ?? []);
      const amb = findQuantityAmbiguity(progress.optionSnapshot.intents, said).find((a) => !confirmed.has(a.signature));
      if (amb) {
        traceClient(traceIdRef.current, "quantity_split", { signature: amb.signature, indexes: amb.indexes, said });
        askQuantityReading(state, ch, amb, speakReceipt, progress, execCtx ?? undefined);
        return;
      }
    }
    // 在任何票据/目标原地改写之前扫描整组。未答完时，本次没有执行副作用。
    const batch = planDispatchSelectionBatch({
      state, allIntents: progress.optionSnapshot.intents,
      selectionKeys: progress.selectionKeys, requirements: progress.requirements,
      selectedUnitIds: progress.selectedUnitIds,
      persona: speakingPersona, personaLabel: COMMANDER_META[speakingPersona].label,
    });
    if (batch.kind === "refuse") {
      refuseAloud(state, ch, batch.line, speakReceipt);
      return;
    }
    if (batch.kind === "ask") {
      askWhichDispatch(
        state, ch, batch.candidates, speakReceipt,
        { ...progress, requirements: batch.requirements }, execCtx ?? undefined,
        batch.intentIndex, false, batch.soleCandidate,
      );
      return;
    }
    // ── 引擎提出一份**完整方案**请长官点头（零执行）：存成待确认合同（同频道、同局、有期限、只消费一次），
    //   长官同意时照常全链复核。第七轮把原先收窄提议里的那段登记抽成这一处，「要再派吗」共用它。
    //   ★连同**已经选好的那一批**与答过的数量读法一起存（稳定 key，不存名单）——点头时照这份现查。
    //   ★第八轮：问句**由存下的这份方案逐条生成**（core.describePlanForApproval：动作、来源、数量、去处），
    //   调用方只给「为什么问」（reason）和「问什么」（ask）。长官点头批的＝问句里列出的＝存下的＝执行的。
    //   旧写法由调用方拼问句：「要再派吗」只拿第一条命中的那一条说，「按北线前哨办吗」只说收窄的那一条，
    //   而点头后执行的是整份方案（Codex 复现：只问北线再派 2 个，执行了北、南各 2 个）。
    const proposeForApproval = (proposal: AdvisorOption, reason: string, ask: string) => {
      const question = `${reason}——${ask}？`;
      let line = `${question}这道命令先没有执行。`;
      if (execCtx) {
        const planText = registerApprovalPlan(state, ch, {
          opt: proposal, data: (progress.sourceResponse ?? response) as DisplayResponse, execCtx,
          phase: "awaiting_reply", question,
          selection: {
            ...progress,
            optionSnapshot: cloneSelectionOption(proposal),
            selectionKeys: progress.selectionKeys.map((k) => ({ ...k })),
            requirements: batch.requirements.map((r) => ({ ...r, offeredKeys: [...r.offeredKeys] })),
            selectedUnitIds: progress.selectedUnitIds ? [...progress.selectedUnitIds] : undefined,
          },
        });
        line = `${question}要办的是：${planText}。这道命令先没有执行。`;
      }
      refuseAloud(state, ch, line, speakReceipt);
      setClarification(null);
    };

    // 原 option 保持完整；后续 G-ticket/soft-fix 只改这份工作副本。
    const workingOption = optionWithResolvedIntents(progress.optionSnapshot, batch.intents);
    const cleanLabel = workingOption.label.replace(/^[ABC]:\s*/, '');
    const intents = workingOption.intents;
    const boundRosters = new Map<Intent, number[]>(
      batch.bindings.map((b) => [intents[b.intentIndex], b.unitIds]),
    );

    // ── 刀寅：用过的 G 号 ⇒ 指**真走了的那一批**（台账任务），走主链 ──
    //
    // 票是一次性方案（烧了就不能按票上的名单再派一次），派出去的人是一条任务。
    // 这里只把号换成任务号（fromDispatch），后面照旧过本局/权限/活成员现查/
    // ApplyResult 回执——不另开一条执行入口。判定在 core（resolveTicketBatch）。
    //   · 拆成了几拨 ⇒ 列出来问，整道命令零执行（不合并）；
    //   · 一个活人都不剩 ⇒ 明说，零执行；
    //   · 票没用过 ⇒ 原封不动交给下面的票据路。
    // 整组先扫一遍再改写：任何一条要拒，整组都不动（与上面的整组预检同一个原则）。
    const batchByIntent = new Map<Intent, string>();
    for (const intent of intents) {
      const tb = resolveTicketBatch(state, intent.fromSquad);
      if (tb.kind === "refuse" || tb.kind === "split") {
        refuseAloud(state, ch, tb.line, speakReceipt);
        setClarification(tb.kind === "split" ? "请指明是哪一拨" : "那批人已经调不动了，请重新指明部队");
        return;
      }
      if (tb.kind === "batch") batchByIntent.set(intent, tb.dispatchId);
    }
    for (const [intent, dispatchId] of batchByIntent) {
      intent.fromSquad = undefined;
      intent.fromFront = undefined; // 来源就是那一批人；战线字段在这里只会与它打架
      intent.fromDispatch = dispatchId;
    }

    // ── 第七轮：模型这一轮新写的单子，与一次**还在办**的外派是同一件事，而长官这句话里没有它 ──
    //   这时引擎分不清是「多余的答复」还是「要增援」——两种都可能，谁也不许替长官定：
    //   不另派（不当增援），也不谎称「已经在办」（不当重复）。把这份单子原样存成待确认方案、
    //   说清刚才那批还在路上，问他要不要再派；他点头才执行（批准过的方案不再过这一道）。
    //   「这句话里有没有它」只用原话片段作证据（core.findSameTaskInProgress）：片段出自这一句
    //   （「再派两个去北线前哨」）⇒ 新命令，照常增援。网络重投不走这里——同一请求只处理一次，见 processAdvisorData 顶部。
    if (freshPlan) {
      const hits = [...new Set(intents.map((it) => findSameTaskInProgress(state, it, execCtx?.playerText)?.dispatchId)
        .filter((id): id is string => !!id))];
      if (hits.length > 0) {
        // 为什么问：每一次在办的外派各说一句（事实）；问什么、批什么：整份方案（proposeForApproval 生成）。
        const reason = hits.map((id) => {
          const d = findDispatch(state, id);
          const live = d ? liveDispatchMembers(state, d).length : 0;
          return `${d?.targetName ? `${d.targetName}那边` : "那边"}已经有 ${live} 个是刚才派去的，还在办`;
        }).join("；");
        traceClient(traceIdRef.current, "same_task_in_progress", { dispatchIds: hits, said: execCtx?.playerText ?? null });
        proposeForApproval(cloneSelectionOption(progress.optionSnapshot), reason, "要再派吗");
        return;
      }
    }

    // ── 刀寅：每条命令自己的「去处原话」与它的目的地字段对一遍（判定在 core）──
    //   只用**这份方案绑定的那一句原话**（execCtx.playerText：发出这份方案的那一轮；
    //   确认回合执行的是存下的方案，用的也是存它那一轮的原话）。不翻历史、不借别的命令的地名。
    //   整组先看完再动：任何一条对不上，整道命令都不执行，先问。
    {
      const said = execCtx?.playerText;
      const checks = intents.map((it) => checkDestinationQuote(state, it, said));
      if (checks.some((v) => v.kind !== "no_check" || v.reason !== "not_dispatch")) {
        traceClient(traceIdRef.current, "destination_quote", { said, verdicts: checks });
      }
      const conflict = checks.find((v) => v.kind === "conflict");
      if (conflict && conflict.kind === "conflict") {
        refuseAloud(state, ch, conflict.verified
          ? `您说的去处是「${conflict.quote}」，这道令写的是${conflict.wrote}，两处对不上——您要去哪儿？这道命令先没有执行。`
          : `这道令写的去处是${conflict.wrote}，可它记下的去处原话是「${conflict.quote}」，两处对不上——您要去哪儿？这道命令先没有执行。`, speakReceipt);
        setClarification("请说清楚去哪儿");
        return;
      }
      const narrowed = checks.flatMap((v, i) => (v.kind === "narrowed" ? [{ v, i }] : []));
      if (narrowed.length > 0) {
        // 字段只写到了战线、长官点的是战线里的那个设施：**提出**按设施办，他点头才执行。
        // 存成待确认合同（同频道、同局、有期限、只消费一次），执行时照常全链复核。
        const proposal = cloneSelectionOption(progress.optionSnapshot);
        for (const { v, i } of narrowed) {
          if (v.kind !== "narrowed") continue;
          const it = proposal.intents[i];
          it.targetFacility = v.facilityId;
          it.toFront = undefined;
          it.targetRegion = undefined;
        }
        proposal.intent = proposal.intents[0] ?? proposal.intent;
        // 为什么问：每一条被收窄的各说一句；问什么、批什么：整份方案（含没收窄的那几条）。
        const fixes = narrowed.flatMap(({ v }) => (v.kind === "narrowed" ? [v] : []));
        const reason = fixes.map((v) => v.verified
          ? `您说的是${v.facilityName}，这道令只写到了${v.frontName}`
          : `这道令只写到了${v.frontName}，记下的去处却是${v.facilityName}`).join("；");
        const ask = `按${fixes.map((v) => v.facilityName).join("、")}办吗`;
        proposeForApproval(proposal, reason, ask);
        return;
      }
      // （不再"按引用补上去处"：字段没写去处本身就是完整的意思——审核实测补错一半以上。）
      // （数量读法的检查已挪到「是哪一批」之前，见上。）
    }

    // v4 刀2b: ticket rosters resolved for this option, keyed by the intent
    // they belong to. A ticket REPLACES scope resolution — the frozen roster
    // goes in through resolveIntent's selectedUnitIds hard constraint (the
    // Day 10.5 box-select parameter), so tacticalPlanner is untouched and the
    // global pool is never consulted.
    const ticketRosters = new Map<Intent, number[]>();
    // v4 §8 刀B/刀C: the ticket itself has to survive to the dispatch loop now —
    // the destination verdict needs it (which front was this raised for?) and
    // the receipt needs it (whose label, and how many REALLY left). Keyed by
    // intent identity; the intents array holds the same objects throughout.
    const ticketByIntent = new Map<Intent, EscalationTicket>();
    const ticketReceiptMode = new Map<Intent, "moved" | "in_place">();
    // 刀寅（C）：票上原报的人与这次能派的人之间，**有证据的**差额原因（下令之前数清）。
    const ticketGap = new Map<Intent, TicketGapFacts>();
    // 刀C: fromDispatch 解析出来的合法名单（已与本参谋的可调池取交集）。
    // 走新字段不等于绕过权限——G 号那条路踩过这个坑（手测账③ × B 刀）。
    const dispatchRosters = new Map<Intent, number[]>();

    // 手测账③: who is being spoken to decides what they may move. This is the
    // ENGINE BACKSTOP — the primary fix is the prompt principle (a persona with
    // no forces should never emit a dispatch intent in the first place). By the
    // time we are here the model has already spoken, so this tier is the
    // degraded one: state the structural fact, execute nothing.

    for (const intent of intents) {
      const auth = checkDispatchAuthority(state, speakingPersona, intent);

      // ── 刀C: fromDispatch 的权限闸 ──
      // 任务号既不是分队名也不是 G 号，上面那道 checkDispatchAuthority 看不见它
      // ——不补这一刀，一份冻结的名单就会不经过滤地执行。
      // 名单本身由引擎在 resolveSourceUnits 里**现查**（人会死、会被改派）；
      // 这里只做"这位参谋调不调得动他们"。交集为空 ⇒ 明确拒绝，绝不静默少派。
      if (intent.fromDispatch) {
        const d = findDispatch(state, intent.fromDispatch);
        if (d) {
          const live = liveDispatchMembers(state, d).map((u) => u.id);
          const pool = auth.kind === "allowed" ? new Set(auth.pool) : null;
          const lawful = pool ? live.filter((id) => pool.has(id)) : live;
          if (lawful.length === 0) {
            const who = COMMANDER_META[speakingPersona].label;
            refuseAloud(state, ch, `任务 ${d.id} 那批人不在${who}麾下，这道命令未执行——请对带这支部队的指挥官下令。`, speakReceipt);
            return;
          }
          dispatchRosters.set(intent, lawful);
        }
        // 找不到这条任务 ⇒ 不在这里兜底。引擎的 resolveSourceUnits 会明确失败
        // （「任务 M3 已经不在了」），那条路只废掉这一条意图，不连坐同批的其它意图。
      }

      // 整组歧义已在上述无副作用预检完成；从这里开始不再中途挂起提问。

      // v4 刀2b: a G-number is the ONE legal handle for "那批兵". Resolved
      // before the squad check below, which would otherwise reject it as an
      // unknown squad name. Every non-dispatch outcome is a loud refusal with
      // a spoken reason — never a silent fallback (the soft-fix family).
      const tk = resolveTicketReference(state, intent.fromSquad, state.time);
      if (tk.kind === "refuse") {
        refuseAloud(state, ch, tk.line, speakReceipt);
        setClarification("增援案不可用，请重新指明部队");
        return;
      }
      if (tk.kind === "dispatch") {
        // 手测账③ × B 刀: a handle must not become an authority bypass. The
        // check above only asks "does this persona command anything" and "is a
        // NAMED squad theirs" — a G-number is neither, so without this the
        // frozen roster would execute unfiltered. Now the roster is intersected
        // with what this persona may lawfully move; an empty intersection is a
        // loud refusal, never a silent partial dispatch.
        const pool = auth.kind === "allowed" ? new Set(auth.pool) : null;
        const lawful = pool ? tk.unitIds.filter((id) => pool.has(id)) : tk.unitIds;
        if (lawful.length === 0) {
          const who = COMMANDER_META[speakingPersona].label;
          refuseAloud(state, ch, `${spokenNameOf(tk.ticket)} 不在${who}麾下，这道命令未执行——请对带这支部队的指挥官下令。`, speakReceipt);
          return;
        }
        ticketRosters.set(intent, lawful);
        ticketByIntent.set(intent, tk.ticket);
        ticketGap.set(intent, ticketGapFacts(state, tk.ticket, lawful));
        // 刀C: NO receipt is written here. It used to be — with lawful.length,
        // before the resolver had run — and that is how a roster of 6 under a
        // quantity=2 order dispatched 2 units and printed "6个单位出发了"
        // (§7⑤). The receipt is settled after resolveIntent, off
        // assignedUnitIds, or not printed at all.
        // ★刀B 之后这句注释的措辞要改口：assignedUnitIds 是**解析器选中的人**，
        //   不是"the real"——真下出去的令在 ApplyResult 里。这条升级票回执仍从
        //   assignedUnitIds 取数，是**第二个真相源**，登记为技术债：今天两个数
        //   恒等（isDispatchablePlayerUnit 覆盖了 applyOrders 四道过滤的全部四种
        //   情况），所以是债不是 bug；哪天那个覆盖关系变了，这里会先说谎。
        // The roster IS the scope now; leaving the G-number in fromSquad would
        // send the squad resolver looking for a squad that does not exist.
        intent.fromSquad = undefined;

        // ★ B 刀 fix (hand-test 2026-08-02): the roster must REPLACE source
        // resolution, not be intersected with it. The judgment itself lives in
        // core (retargetIntentForTicket) where the bench can reach it — this
        // layer only applies the verdict, per the ChatPanel-has-no-harness rule.
        Object.assign(intent, retargetIntentForTicket(state, intent, tk.ticket));
      }

      // dispatch-scope-v1 (2a): fromSquad is a SCOPE. The old soft-fix deleted
      // an unresolvable fromSquad and let the engine "auto-select" — which for
      // retreat/attack + quantity=all meant the order silently went broad (the
      // same family as the 74/85 mis-retreat). Ruling: 解析失败必须明确报错，
      // 不许静默通过 — a missed reference costs the player one sentence; a
      // silently widened one costs the battle.
      if (intent.fromSquad) {
        const fs = intent.fromSquad.toLowerCase();
        const isSquad = state.squads?.some(s => s.id === intent.fromSquad || s.leaderName?.toLowerCase() === fs);
        const isCommander = COMMANDERS.some(c => c === fs || COMMANDER_META[c].label.includes(intent.fromSquad!));
        if (!isSquad && !isCommander) {
          refuseAloud(state, ch, `找不到叫「${intent.fromSquad}」的分队，命令未执行——请用编制里的编号或队长名字重新下令`, speakReceipt);
          setClarification(`分队「${intent.fromSquad}」无法识别，请重述`);
          return;
        }
      }

      // Snapshot BEFORE the soft-fix: afterwards "named a place that does not
      // exist" and "named no place" are indistinguishable, and the ticket
      // verdict below has to tell them apart (§7③).
      const wroteDestination = !!(
        intent._targetPos || intent.targetFacility || intent.targetRegion || intent.toFront
      );

      // Soft-fix: clear hallucinated target fields (e.g. LLM invents a non-existent
      // tag/front/facility). Other valid fields in the same intent still drive execution.
      softFixTargetFields(intent, state, (field, value) => {
        addMessage("warning", `目标 ${field}=${value} 不存在，已忽略此字段`, state.time, ch, undefined, "command_ack");
      });

      if (!isValidTarget(intent, state, COMMANDER_REFS)) {
        const field = intent.targetFacility || intent.toFront || intent.fromFront || intent.targetRegion || "unknown";
        refuseAloud(state, ch, `目标 ${field} 不存在`, speakReceipt);
        setClarification("命令引用了不存在的目标，请重新描述");
        return;
      }

      // v4 §8 刀B: a ticket is a handle on PEOPLE — it can never answer "where".
      // Decided in core, routed here. TICKET-BOUND INTENTS ONLY: ordinary
      // commands keep going through untouched, because the engine cannot tell a
      // clear order that named no squad from a follow-up that got mis-bound, and
      // gating both would put a confirmation card back in front of clear orders.
      const boundTicket = ticketByIntent.get(intent);
      if (boundTicket) {
        const verdict = ticketDestinationVerdict(state, intent, boundTicket, wroteDestination);
        if (verdict.kind === "refuse") {
          refuseAloud(state, ch, verdict.line, speakReceipt);
          setClarification(
            verdict.reason === "unknown_place" ? "目的地无法定位，请换个地名" : "请指明目的地",
          );
          return;
        }
        if (verdict.injectTargetRegion) intent.targetRegion = verdict.injectTargetRegion;
        // 刀1：设施票带来的精确目的地。镜像上面 injectTargetRegion 的既有模式——
        // 引擎自己的 id，与该模式同样不过 isValidTarget：合法性已经在 verdict 的
        // 设施档里判过（据点还在、还是我们的，才会走到这里）。
        if (verdict.injectTargetFacility) intent.targetFacility = verdict.injectTargetFacility;
        ticketReceiptMode.set(intent, verdict.receipt);
      }
    }

    const allOrders: ReturnType<typeof resolveIntent>["orders"] = [];
    const reserved = new Set<number>();
    let degradedCount = 0;

    const allAssignedUnitIds: number[] = [];
    // 刀C: settled per intent, off what that intent's resolver actually assigned.
    // An intent that produced no orders contributes NOTHING here — no receipt,
    // and its ticket is not burned, so the proposal stays usable (the degraded
    // warning above is already the honest word about what happened).
    // 刀寅：只记「哪张票对应哪一条回执」；烧不烧票、报几个，一律等 ApplyResult。
    const settled: { ticket: EscalationTicket; sliceIndex: number }[] = [];
    // 刀寅：这些人是按**他们自己那一批的身份**被叫到的（fromDispatch）——对那批人改令，
    //   不是"把带任务的人抽走"，不进 H1 的抽调披露。
    const readdressed = new Set<number>();
    // 刀B：意图 → 它的 order 下标 + 落点名。执行回执唯一的取数口。
    const slices: DispatchSlice[] = [];
    // 刀乙：规划阶段失败的理由，原样留一份给"零 orders"那条早退路念出去。
    const degradedLines: string[] = [];
    // 刀寅：对账行——改写之后真正交给解析器的意图、解析出的落点、下出去的令。
    const execTrace: Record<string, unknown>[] = [];
    // 刀寅：解析器带回的「同一条意图里没动的人」及原因（例：没记下出发地）。并进同一句回执。
    const shortfallLines: string[] = [];
    for (let intentIdx = 0; intentIdx < intents.length; intentIdx++) {
      const intent = intents[intentIdx];
      // v4 刀2b: a ticket's frozen roster wins over the box-select snapshot —
      // the player approved THAT batch, not whatever is currently framed.
      // 刀C/刀己: 名单优先级 —— 票据 > **绑定选择** > 框选 > 任务。
      // 绑定选择排在框选之前：它是长官对"是哪一批"这一问的**当场答复**，
      // 比可能早已陈旧的框选快照更贴这一条命令（框选那条路自己也不会进到这儿
      // ——有框选时枚举直接返回空，根本不会问）。
      const result = resolveIntent(
        intent, state, state.style, reserved,
        ticketRosters.get(intent) ?? boundRosters.get(intent) ?? progress.selectedUnitIds ?? dispatchRosters.get(intent),
      );
      execTrace.push({
        i: intentIdx, intent: intentFacts(intent as unknown as Record<string, unknown>),
        destination: result.destinationName, degraded: result.degraded ? result.log : undefined,
        orders: result.orders.map((o) => ({ action: o.action, units: o.unitIds, target: o.target })),
      });
      if (result.degraded) {
        // 先收集事实，整批完成后按同一顺序送到屏、声音与 context。
        degradedCount++;
        degradedLines.push(result.log);
      } else {
        // ★刀B：`执行: ${result.log}` 不许再上屏。它来自执行**之前**的计划——
        //   计划选中 8 个、applyOrders 的四道过滤只放行 5 个，留着它就会出现
        //   "屏上 8 个、耳朵 5 个"。计划日志降为对账用的诊断，玩家面前的执行
        //   回执一律等 ApplyResult（见下面 buildExecReceipt 那一段）。
        state.diagnostics.push({
          time: state.time,
          code: "PLAN_LOG",
          message: result.log,
        });
        if (result.note) shortfallLines.push(result.note);
      }
      const boundTicket = ticketByIntent.get(intent);
      if (boundTicket && result.orders.length > 0) {
        settled.push({ ticket: boundTicket, sliceIndex: slices.length });
      }
      if (intent.fromDispatch) for (const id of result.assignedUnitIds) readdressed.add(id);
      for (const id of result.assignedUnitIds) reserved.add(id);
      allAssignedUnitIds.push(...result.assignedUnitIds);
      // 刀B：记下这条意图占了 allOrders 的哪几格，外加**引擎真送他们去的地方**。
      // applyOrders 按下标回报结果，回执据此逐条意图对账——不靠猜、不靠合并。
      if (result.orders.length > 0) {
        const base = allOrders.length;
        // 刀甲/刀庚：经济单（produce/trade）没有人头，不参与按人头的结局判定；
        // 它的回执由引擎回报的**真实结算**生成（真件数/真花费/真原因），
        // 计划那一行不再进回执。判的是字段形状（意图类型），不是措辞。
        const economy = !isDispatchIntent(intent.type);
        // 刀寅（C）：票据那一条的回执就是这一条的**唯一一句**，按实际下令人数现写。
        const gap = ticketGap.get(intent);
        const receiptMode = ticketReceiptMode.get(intent) ?? "moved";
        const destinationName = result.destinationName;
        // 刀寅：按批次指代时，「已在办」说那批人正在去的地方（台账记的，下令之前读）。
        const addressedBatch = intent.fromDispatch ? findDispatch(state, intent.fromDispatch) : undefined;
        slices.push({
          action: intent.type,
          destinationName,
          orderIndexes: result.orders.map((_, k) => base + k),
          ...(economy ? { economy: true } : {}),
          ...(addressedBatch?.targetName && addressedBatch.action === intent.type
            ? { alreadyDestinationName: addressedBatch.targetName } : {}),
          ...(boundTicket ? {
            appliedLine: (n: number) => ticketDispatchReceipt(boundTicket, n, receiptMode, { destinationName, gap }),
          } : {}),
        });
        // ── 刀C: 给这批 order 盖上来源标记，台账据此登记 ──
        // 记账只认这个标记，不认调用的是哪个函数：对话派兵走 applyOrders，
        // 鼠标派兵走 applyPlayerCommands（后者还会盖 manualOverride）。
        // ★ 一句话安排两个任务 ⇒ 两个 group ⇒ 两条记录，各记各的名单。
        // ★ advisor 这条路**不设 manualOverride**——陈派的兵不算"玩家手动接管"。
        const meta: DispatchMeta = {
          group: `i${intentIdx}`,
          // 刀寅：凭票派的兵，来源就是那张票。票据改写已经把 fromSquad/fromFront
          //   清掉了，这时再按字段判只剩 pool／空串——台账从此查不到它从哪儿来。
          ...(boundTicket
            ? { sourceKind: "ticket" as const, sourceKey: boundTicket.gNumber, ticketLabel: spokenNameOf(boundTicket) }
            : dispatchSourceOf(intent, progress.selectedUnitIds)),
          ...(intent.returnTo === "origin" ? { returnTo: "origin" as const } : {}),
          action: intent.type,
          targetName: result.destinationName,
        };
        allOrders.push(...result.orders.map((o) => ({ ...o, origin: "advisor" as const, dispatchMeta: meta })));
      } else {
        allOrders.push(...result.orders);
      }
    }

    if (allOrders.length === 0 && degradedCount > 0) {
      traceClient(traceIdRef.current, "exec", { intents: execTrace, applied: [], receipt: degradedLines });
      // 全部在规划阶段失败时也走同一个拒绝出口，屏、声音与 context 一起发布。
      // 不再追加泛化的“无法执行／请重述”，只发布引擎给出的具体理由。
      refuseAloud(state, ch, degradedLines.join(" "), speakReceipt);
      setApprovedIdx(idx);
      setTimeout(() => setApprovedIdx(null), 400);
      return;
    }

    if (allOrders.length > 0) {
      // Pick personality-appropriate voice confirmation
      const approveCommander = COMMANDERS.find(c => COMMANDER_CHANNEL[c] === ch) ?? COMMANDERS[0];
      const voiceConfirm = pickVoiceConfirm(approveCommander);
      // ★刀B：`${voiceConfirm} ${cleanLabel}` 这一行原先打在 applyOrders **之前**，
      //   而 cleanLabel 是模型写的方案标题——「让北线部队撤回前哨」。四道过滤把
      //   人全挡住时，屏上照样留着这句，正是"没司令感"那笔账的同一张脸。
      //   现在它拆成两半：`voiceConfirm`（应答，不宣称结果）留在这儿，
      //   方案标题连同人数/落点一起并进执行后的回执。
      //   方案标题进诊断（EXEC_PLAN_LABEL）留作对账，不再当执行回执用。
      addMessage("info", voiceConfirm, state.time, ch, undefined, "command_ack");
      state.diagnostics.push({ time: state.time, code: "EXEC_PLAN_LABEL", message: cleanLabel });
      // H1 (§8 手测 03:15): read BEFORE applyOrders — that call overwrites
      // state/orders, after which every unit looks equally busy on the NEW
      // task and "what did we tear them off" is unrecoverable. Judgment is in
      // core; this layer only prints the verdict.
      const committedPull = describeCommittedPull(state, allAssignedUnitIds.filter((id) => !readdressed.has(id)));

      const diagsBefore = new Set(state.diagnostics);
      const applyRes = applyOrders(state, allOrders);
      // 刀寅（审核 B）：这个频道刚真办了一道令——之前还挂着等点头的方案作废（一次只挂一个问题）。
      if (applyRes.appliedUnitIds.length > 0 && pendingContractRef.current?.channel === ch) {
        pendingContractRef.current = null;
      }

      // ── ★刀B 的落点：执行回执。文字与声音共用**这同一个字符串** ──
      //
      // 取数只认 `applyRes`（执行层真对谁下了令），不认 result.assignedUnitIds
      // （那是"计划选中的人"，还要再过四道过滤），更不认 data.brief。
      // 「人数/对象/目的地/成败」四项一致因此是构造保证，不是事后比对。
      // 措辞只说"下令"，不说"抵达"——到没到由战场自己说。
      const execReceipt = buildExecReceipt(applyRes, slices);
      // 规划失败与实际执行结果先合并，再以同一顺序发布到屏、声音与 context。
      const feedback = buildExecFeedback(execReceipt, degradedLines, shortfallLines);
      traceClient(traceIdRef.current, "exec", {
        intents: execTrace, applied: applyRes.appliedUnitIds, already: applyRes.alreadyDoingUnitIds,
        rejected: applyRes.rejectedUnitIds, receipt: feedback.lines,
      });
      for (const line of feedback.lines) {
        addMessage(
          // ★刀辛：只要有没办成的部分，整条就不许伪装成纯成功的 info。
          feedback.outcome === "none" || feedback.outcome === "partial" ? "warning" : "info",
          line, state.time, ch, undefined, "command_ack",
        );
        // 喂给模型的上下文与**真正播报出去的那句**同步。旧写法只推 data.brief
        // ——那是执行之前的方案标题，于是下一轮模型记得的是它以为发生的事。
        pushContext(channelContextRef.current, ch, { role: "assistant", text: line, time: state.time });
      }
      // 耳朵：会动兵的回合，上面那一层（spoken/正文）已经一声不出，这里才是
      // 这一轮唯一的一声——而且它念的是真结果。屏上那句 voiceConfirm 一起念，
      // 免得耳朵从"数字"开头。
      if (ttsEnabled && speakReceipt && feedback.spokenText) {
        // 念的是**合并后的那一段**：成功与没办成的两部分都在里面。
        speak(`${voiceConfirm} ${feedback.spokenText}`, approveCommander);
        flush(approveCommander);
      }

      // v4 刀2b: burn AFTER the orders are actually applied — a ticket that
      // failed to produce orders must stay usable. One-shot from here on: the
      // same proposal can never dispatch twice.
      //
      // 刀C (§8 ⑤): burn and receipt are now PER TICKET and settled from that
      // intent's own result. A ticket whose order produced nothing is neither
      // burned nor receipted — it was never spent. The number in the receipt is
      // the number the resolver actually assigned, so quantity limits, terrain
      // skips and casualties are all reconciled out loud rather than assumed.
      //
      // 刀寅：烧票只看 **ApplyResult**——这张票对应的那一条真有人接到命令才烧。
      //   回执已经在上面那份 feedback 里（同一句屏/耳/context），这里不再补第二行。
      const spentTickets: string[] = [];
      for (const s of settled) {
        if ((execReceipt.facts[s.sliceIndex]?.appliedCount ?? 0) === 0) continue;
        burnEscalationTicket(s.ticket.gNumber);
        spentTickets.push(s.ticket.gNumber);
      }

      // H1: pulling committed troops is the commander's call — doing it without
      // saying so is not. Disclosure only: nothing above was gated by this.
      if (committedPull) {
        addMessage("info", committedPull.line, state.time, ch, undefined, "command_ack");
      }

      // v4 刀2b P1: one exportable row per bare-confirm execution that actually
      // moved troops. viaTicket=false is the interesting population — that is
      // the LLM binding a nod with no structural handle, i.e. the risk 刀A was
      // built to remove. Exported by counting these against mis-dispatch
      // reports from the external playtest.
      const bce = bareConfirmExecRef.current;
      if (bce) {
        bareConfirmExecRef.current = null;
        const targets = intents
          .map((i) => i.toFront ?? i.targetFacility ?? i.targetRegion ?? i.fromFront ?? "unspecified")
          .join("+");
        const spent = spentTickets;
        state.diagnostics.push({
          time: state.time,
          code: "V4_BARE_CONFIRM_EXEC",
          message: `escalateId=${bce.escalateId ?? "none"} viaTicket=${spent.length > 0}` +
            `${spent.length > 0 ? ` tickets=${spent.join(",")}` : ""}` +
            ` dispatched=${allAssignedUnitIds.length} target=${targets}`,
        });
      }

      // ★刀庚 (审核 §三)：经济结算的**权威回执已经在上面那份 execReceipt 里**
      //   （真件数 / 真花费 / 真原因，来自引擎回报的 EconomyOutcome）。
      //
      //   刀丁当时是从 `state.diagnostics` 里捞 PRODUCE_FAIL / TRADE_FAIL 补上屏
      //   与补声——那是把诊断当回执的数据总线，而且只捞到两个码：预算结算走的是
      //   PRODUCE_BUDGET / TRADE_BUDGET，完全失败时屏上一句失败都没有、只有那句
      //   假成功。现在原因随结算一起回来，屏/耳/context 同源，这一圈**整段退场**。
      //   诊断本身照旧推（调试与系统日志要它），只是不再当玩家回执用。
      //   ——被 degraded 拦在 resolver 的那些（未知单位类型 / 不可生产）走的是
      //   上面 `result.log` 那条路，与本段无关，一个字节没动。
      void diagsBefore;

      // Process doctrine fields at approve time (not at response time)
      const docSource = progress.sourceResponse;
      if (docSource) {
        processDoctrineFields(docSource as unknown as Record<string, unknown>, state, ch, intents);
      }

      // Create TaskCard — resolve squads from intents + assigned unit reverse-lookup
      const intentSquads = intents.map(i => i.fromSquad).filter((s): s is string => !!s);
      // Reverse-lookup: find squads owning assigned units
      if (intentSquads.length === 0 && allAssignedUnitIds.length > 0) {
        const unitIdSet = new Set(allAssignedUnitIds);
        for (const sq of state.squads) {
          if (sq.unitIds.some(id => unitIdSet.has(id))) {
            intentSquads.push(sq.id);
          }
        }
      }
      const squads = [...new Set(intentSquads)];
      // Create TaskCard for each distinct intent type (e.g. attack + produce → 2 cards)
      const economyTypes = new Set(["produce", "trade"]);
      // Find associated doctrine if standingOrder was just created
      const linkedDoctrine = state.doctrines.find(
        d => d.status === "active" && d.commander === ch &&
        d.createdAt === state.time,
      );

      for (const intent of intents) {
        const locationHint = intent.toFront || intent.fromFront
          || intent.targetRegion || "";
        const titleMap: Record<string, string> = {
          defend: `防守 ${locationHint || "阵地"}`,
          attack: `进攻 ${locationHint || "目标"}`,
          retreat: `撤退整补 ${locationHint}`,
          recon: `侦察 ${locationHint || "区域"}`,
          hold: `固守 ${locationHint || "阵地"}`,
          patrol: `巡逻 ${locationHint || "区域"}`,
          reinforce: `增援 ${locationHint || "前线"}`,
          capture: `占领 ${intent.targetFacility || locationHint || "设施"}`,
          sabotage: `破坏 ${intent.targetFacility || locationHint || "设施"}`,
          produce: `生产 ${intent.produceType || "单位"}`,
          trade: `交易 ${intent.tradeAction || "资源"}`,
        };
        const taskTitle = (titleMap[intent.type] || intent.type).trim();
        const taskId = `task_${Date.now().toString(36)}_${state.tasks.length}`;
        const taskKind = economyTypes.has(intent.type) ? "economy" as const : "combat" as const;
        // Combat tasks get squad assignments; economy tasks are squadless
        const taskSquads = taskKind === "combat" ? squads : [];
        const newTask: TaskCard = {
          id: taskId,
          title: taskTitle,
          commander: ch,
          assignedSquads: taskSquads,
          status: "assigned",
          priority: linkedDoctrine?.priority as TaskPriority ?? "normal",
          kind: taskKind,
          constraint: linkedDoctrine?.type,
          createdAt: state.time,
          statusChangedAt: state.time,
          doctrineId: linkedDoctrine?.id,
        };
        state.tasks.push(newTask);
      }

      // ── Step 7e.1: record this decision for the engine's later outcome review ──
      // Only this main command path records (thread approvals delegate here).
      // Right-click manual orders and produce/trade are not recorded.
      // The engine gates recording (battlefield anchor + unit floor) and later
      // decides whether/who reviews; nothing here executes or voices anything.
      // assignedUnitIds are resolveIntent's picks filtered to living units
      // ("resolved assigned units"), not a claim about what was finally applied.
      const reviewIntent = intents.find((i) => isReviewableIntentType(i.type));
      if (reviewIntent && isReviewableIntentType(reviewIntent.type)) {
        const record = captureDecisionReview(state, {
          id: crypto.randomUUID(),
          channel: ch,
          kind: reviewIntent.type,
          facilityHint: reviewIntent.targetFacility,
          // toFront/targetRegion only — fromFront is the SOURCE, never an
          // outcome anchor (core resolves the hint as front/tag/region/facility).
          targetHint: reviewIntent.toFront ?? reviewIntent.targetRegion,
          assignedUnitIds: Array.from(new Set(allAssignedUnitIds)),
          escalateId: execCtx?.escalateId,
        });
        if (record) enqueueDecisionReview(state, record);
      }

      if (execCtx?.threadId) {
        resolveThread(execCtx.threadId);
      }
    }

    // Style learning
    if (allOrders.length > 0) {
      if (opt.risk > 0.6) updateStyleParam(state.style, "riskTolerance", 1);
      else if (opt.risk < 0.3) updateStyleParam(state.style, "riskTolerance", -1);
      if (opt.reward > 0.6) updateStyleParam(state.style, "objectiveBias", 1);
      else if (opt.reward < 0.3) updateStyleParam(state.style, "objectiveBias", -1);
      const letter = ["A", "B", "C"][idx];
      if (progress.sourceResponse && letter !== progress.sourceResponse.recommended) {
        updateStyleParam(state.style, "casualtyAversion", 1);
      }
    }

    setClarification(null);
    setApprovedIdx(idx);

    // Brief flash then clear card (or show next queued group response)
    setTimeout(() => {
      const next = pendingGroupResponsesRef.current.shift();
      if (next) {
        setResponse(next.data);
        responseExecCtxRef.current = { channel: next.channel, requestId: next.requestId };
        latestRequestIdRef.current = next.requestId;
      } else {
        setResponse(null);
        responseExecCtxRef.current = null;
        latestRequestIdRef.current = null;
      }
      setApprovedIdx(null);
      selectedIdsSnapshotRef.current = undefined;
    }, 400);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    e.stopPropagation();
    // ★ 中文输入法还在选字的时候，这个 Enter 是**给输入法的**，不是给我们的。
    //   用户 2026-09-12 实拍：打 Aiden，候选还浮在输入法里没落进框，一按回车
    //   整条空/半截的话就发出去了。浏览器对 composing 中的按键报 isComposing=true
    //   （老浏览器只给 keyCode 229），两个都认，谁先到算谁。
    if ((e.nativeEvent as KeyboardEvent).isComposing || e.keyCode === 229) return;
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendCommand();
    }
  };

  const dismiss = () => {
    const next = pendingGroupResponsesRef.current.shift();
    if (next) {
      setResponse(next.data);
      responseExecCtxRef.current = { channel: next.channel, requestId: next.requestId };
      latestRequestIdRef.current = next.requestId;
    } else {
      setResponse(null);
      responseExecCtxRef.current = null;
      latestRequestIdRef.current = null;
    }
    setError(null);
    setApprovedIdx(null);
    selectedIdsSnapshotRef.current = undefined;
  };

  // ── Render ──
  // Capture exec context at render time so approve buttons use a frozen snapshot,
  // not the (potentially stale or updated) ref value at click time.
  const approveSnapshotCtx = responseExecCtxRef.current ? { ...responseExecCtxRef.current } : undefined;

  // ── Shared chat content fragment (used in both detached and embedded) ──
  // Step 3: split conversation from system reports. Embedded keeps reports inline
  // as a low-key lane (no layout change). Detached pulls them out of the
  // conversation pane entirely and shows them in a dedicated panel under the org
  // tree (see dp-col-right) so battle reports never push the dialogue off-screen.
  const reportMessages = displayMessages.filter(isReportMessage);
  const conversationMessages = isDetached
    ? displayMessages.filter((m) => !isReportMessage(m))
    : displayMessages;
  // 风格五元组只在这里定义一次：嵌入态的折叠风格条与弹窗态页底 dp-style-bar
  // 都读它。抄成两份必然漂移（改了一处忘另一处），故禁止复制。
  const styleRows: [string, number][] = styleSnapshot
    ? [
        ["冒险", styleSnapshot.r],
        ["集火", styleSnapshot.f],
        ["目标", styleSnapshot.o],
        ["惜兵", styleSnapshot.c],
        ["侦察", styleSnapshot.s],
      ]
    : [];

  const chatContentFragment = (
    <>
      <div ref={scrollRef} className={isDetached ? "dp-chat-scroll" : undefined} style={isDetached ? undefined : chatFlowStyle}>
        {conversationMessages.length === 0 && (
          <div className="hud-empty-state">
            等待指令...
          </div>
        )}
        {conversationMessages.map((msg) => {
          // Embedded: system reports stay inline as a low-key lane. Detached:
          // conversationMessages already excludes them, so this only fires embedded.
          if (isReportMessage(msg)) return renderReportLine(msg);
          const isPlayer = msg.from === "player";
          return (
            <div key={msg.id} style={{ ...bubbleRowStyle, justifyContent: isPlayer ? "flex-end" : "flex-start" }}>
              {!isPlayer && (
                <div style={bubbleMetaStyle}>
                  <span style={{ fontSize: 14 }}>{FROM_AVATARS[msg.from ?? "system"] ?? "⚙️"}</span>
                  <span style={{ color: FROM_COLORS[msg.from ?? "system"] ?? "#64748b", fontWeight: "bold", fontSize: 10 }}>
                    {FROM_LABELS[msg.from ?? "system"] ?? "系统"}
                  </span>
                  <span style={timeTagStyle}>{formatTime(msg.time)}</span>
                </div>
              )}
              <div style={{
                ...bubbleStyle,
                background: isPlayer ? "rgba(0, 212, 255, 0.08)" : "var(--hud-bg-tertiary)",
                borderLeft: isPlayer ? undefined : `2px solid ${FROM_COLORS[msg.from ?? "system"] ?? "var(--hud-text-dim)"}`,
                borderRight: isPlayer ? "2px solid var(--hud-accent-cyan)" : undefined,
                alignSelf: isPlayer ? "flex-end" : "flex-start",
                maxWidth: "85%",
              }}>
                <span style={{ color: "var(--hud-text-primary)", fontSize: 12 }}>{msg.text}</span>
              </div>
              {isPlayer && (
                <span style={{ ...timeTagStyle, alignSelf: "flex-end" }}>{formatTime(msg.time)}</span>
              )}
            </div>
          );
        })}

        {/* 动画R2 步 2：无线电呼叫行。挂 pttStatus === "listening" ＝ 与 🔴 红灯同源
            （录音臂只有 arm.press() 真返回 true 才置 listening），两态共用本 fragment
            故弹窗/嵌入都有。纯渲染态，不进 messageStore。 */}
        {pttStatus === "listening" && <RadioCallRow cancelIntent={pttCancelIntent} />}

        {/* Inline staff threads */}
        {activeThreads.length > 0 && !response && activeThreads.map((thread) => (
          <div key={thread.id} style={threadBubbleStyle}>
            <button
              onClick={() => dismissThread(thread.id)}
              style={crisisDismissBtn}
              title="关闭这条紧急通报（你自己用对话处理）"
            >×</button>
            <div className="hud-thread-header">
              ⚠ {thread.eventType} — {thread.brief}
            </div>
            {thread.options && thread.options.length > 0 && (
              <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                {thread.options.map((opt, i) => {
                  const letter = ["A", "B", "C"][i];
                  return (
                    <button
                      key={i}
                      onClick={() => handleThreadApprove(thread, opt, i)}
                      disabled={executingThreadId === thread.id}
                      style={{
                        ...threadOptionBtnStyle,
                        opacity: executingThreadId === thread.id ? 0.4 : 1,
                      }}
                    >
                      <span style={{ fontWeight: "bold" }}>{letter}:</span> {opt.label.replace(/^[ABC]:\s*/, '')}
                      <div style={{ fontSize: 9, color: "var(--hud-text-secondary)", marginTop: 2 }}>{opt.description}</div>
                    </button>
                  );
                })}
              </div>
            )}
            <div style={{ fontSize: 9, color: "var(--hud-text-dim)", marginTop: 4 }}>
              Expires in {Math.max(0, Math.floor(thread.expiresAt - (getState()?.time ?? 0)))}s
            </div>
          </div>
        ))}

        {/* Streaming text bubble */}
        {streamingText !== null && (
          <div className="hud-streaming-text">
            {streamingText || "…"}
            <span className="hud-cursor-blink" style={{ marginLeft: 2 }} />
          </div>
        )}

        {/* Inline A/B/C option cards */}
        {response && (
          <div style={optionsInlineStyle}>
            <div className="hud-options-header" style={{ marginBottom: 6 }}>
              {response.brief}
              <button onClick={dismiss} style={dismissBtn} title="关闭">×</button>
            </div>

            {response.options.map((opt, i) => {
              const letter = ["A", "B", "C"][i];
              const isRecommended = response.recommended === letter;
              const isApproved = approvedIdx === i;
              return (
                <div
                  key={i}
                  style={{
                    ...optionCardStyle,
                    borderColor: isApproved ? "var(--hud-accent-green)" : isRecommended ? "var(--hud-accent-green)" : undefined,
                    background: isApproved ? "var(--hud-accent-green-dim)" : undefined,
                  }}
                >
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                    <span className="hud-option-label">{opt.label}</span>
                    {isRecommended && <span className="hud-recommended-badge">推荐</span>}
                  </div>
                  <div className="hud-option-desc">{opt.description}</div>
                  <div style={{ display: "flex", gap: 8, marginTop: 3, fontSize: 9, color: "var(--hud-text-dim)" }}>
                    <span style={{ display: "flex", alignItems: "center", gap: 2 }}>
                      风险
                      <span style={barBg}><span style={{ ...barFill, width: `${opt.risk * 100}%`, background: opt.risk > 0.6 ? "var(--hud-accent-red)" : "var(--hud-accent-amber)" }} /></span>
                    </span>
                    <span style={{ display: "flex", alignItems: "center", gap: 2 }}>
                      收益
                      <span style={barBg}><span style={{ ...barFill, width: `${opt.reward * 100}%`, background: "var(--hud-accent-green)" }} /></span>
                    </span>
                  </div>
                  {(opt.intents ?? [opt.intent]).map((it, j) => (
                    <div key={j} style={{ fontSize: 9, color: "var(--hud-text-dim)", marginTop: 2 }}>
                      [{it.type}]{it.unitType ? ` ${it.unitType}` : ""}{it.urgency ? ` ${it.urgency}` : ""}
                    </div>
                  ))}
                  <button
                    onClick={() => handleApprove(opt, i, "manual", approveSnapshotCtx)}
                    disabled={approvedIdx !== null}
                    style={{
                      ...approveBtnStyle,
                      opacity: approvedIdx !== null ? 0.4 : 1,
                    }}
                  >
                    {isApproved ? `已批准 ${letter}` : `批准 ${letter}`}
                  </button>
                </div>
              );
            })}

            {response.warning && (
              <div style={warningStyle}>{response.warning}</div>
            )}

            {/* Cancel + Supplement buttons */}
            <div style={{ display: "flex", gap: 6, marginTop: 6 }}>
              <button
                onClick={() => {
                  const state = getState();
                  setResponse(null);
                  setApprovedIdx(null);
                  setClarification(null);
                  responseExecCtxRef.current = null;
                  latestRequestIdRef.current = null;
                  if (state) addMessage("info", "指挥官取消了命令", state.time, getActiveChannel(), undefined, "system");
                }}
                style={cancelBtnStyle}
              >
                ✕ 取消
              </button>
              <button
                onClick={() => {
                  const summary = response.brief + " | " + response.options.map((o, i) => `${["A","B","C"][i]}:${o.label}`).join("; ");
                  setDeclinedContext(summary);
                  setResponse(null);
                  setApprovedIdx(null);
                  setClarification(null);
                  responseExecCtxRef.current = null;
                  latestRequestIdRef.current = null;
                  setTimeout(() => inputRef.current?.focus(), 50);
                }}
                style={supplementBtnStyle}
              >
                💬 补充
              </button>
            </div>
          </div>
        )}

        {error && <div style={errorBubbleStyle}>{error}</div>}
        {clarification && <div style={clarificationStyle}>{clarification}</div>}
      </div>

      {/* Style indicator — 仅嵌入态。弹窗态的风格五条挪到了页底 dp-style-bar
          （步 5 中栏对掉），这里加 !isDetached 守卫免得两处重复出现。 */}
      {!isDetached && styleSnapshot && (
        <div style={styleRowStyle}>
          <button onClick={() => setShowStyle(!showStyle)} style={styleToggleBtn}>
            {showStyle ? "▾ 风格" : "▸ 风格"}
          </button>
          {showStyle && (
            <div style={styleBarContainer}>
              {styleRows.map(([label, val]) => (
                <div key={label} style={styleBarItem}>
                  <span style={styleLabel}>{label}</span>
                  <span style={barBg}>
                    <span style={{ ...barFill, width: `${val * 100}%`, background: "var(--hud-accent-cyan)" }} />
                  </span>
                  <span style={styleVal}>{(val * 100).toFixed(0)}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </>
  );

  // ── Detached panel: 3-column layout ──
  if (isDetached) {
    const st = getState();
    const activeMissions = st?.missions.filter(m => m.status === "active") ?? [];
    const activeTasks = st?.tasks.filter(t => t.status !== "completed" && t.status !== "cancelled") ?? [];
    const res = st?.economy.player.resources;
    const readiness = st ? Math.round(st.economy.player.readiness * 100) : 0;

    // Unit pool: count alive units by type
    const unitCounts = new Map<string, number>();
    if (st) {
      for (const [, u] of st.units) {
        if (u.state === "dead" || u.team !== "player") continue;
        unitCounts.set(u.type, (unitCounts.get(u.type) || 0) + 1);
      }
    }
    const UNIT_TYPE_LABELS: Record<string, string> = {
      infantry: "Infantry", main_tank: "Main Tank", light_tank: "Light Tank",
      artillery: "Artillery", patrol_boat: "Patrol Boat", destroyer: "Destroyer",
      cruiser: "Cruiser", carrier: "Carrier", fighter: "Fighter",
      bomber: "Bomber", recon_plane: "Recon Plane",
      elite_guard: "Elite Guard", commander: "Commander",
    };
    const CMD_LABELS_SHORT: Record<string, string> = { combat: "Chen", ops: "Marcus", logistics: "Emily" };
    const MISSION_STATUS_COLOR: Record<string, string> = { active: "var(--hud-accent-cyan)", completed: "var(--hud-accent-green)", failed: "var(--hud-accent-red)", cancelled: "var(--hud-text-dim)" };
    const TASK_STATUS_COLOR: Record<string, string> = { assigned: "#94a3b8", moving: "#38bdf8", engaged: "#f97316", holding: "#22c55e", failing: "#ef4444" };

    return (
      <div className="dp-root">
        {/* Top Strip */}
        <div className="dp-top-strip">
          <span className="dp-title">BATTLE BOARD</span>
          <span className="hud-status-badge">
            <span className="hud-status-badge__dot" />
            OPERATIONAL
          </span>
          <span className="dp-mode-label">Detached Comms Mode</span>
        </div>

        {/* Body: 3-column grid */}
        <div className="dp-body">

          {/* LEFT COLUMN: Missions / Tasks / Logistics / Unit Pool */}
          <div className="dp-col-left">
            {/* Active Missions */}
            <div className="dp-section">
              <div className="dp-section-header">ACTIVE MISSIONS ({activeMissions.length})</div>
              {activeMissions.length === 0 && (
                <div style={{ fontSize: 10, color: "var(--hud-text-dim)" }}>No active missions</div>
              )}
              {activeMissions.slice(0, 6).map(m => (
                <div key={m.id} className="dp-card">
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                    <span style={{ color: "var(--hud-accent-cyan)", fontSize: 10, fontWeight: 600 }}>{m.id}</span>
                    <span style={{ color: "var(--hud-accent-amber)", fontSize: 9 }}>{m.type}</span>
                  </div>
                  <div style={{ fontSize: 11, color: "var(--hud-text-primary)", marginTop: 2 }}>{m.name}</div>
                  <div className="dp-progress-track">
                    <div className="dp-progress-fill" style={{ width: `${Math.round(m.progress * 100)}%` }} />
                  </div>
                  <div style={{ display: "flex", justifyContent: "space-between", marginTop: 2 }}>
                    <span style={{ fontSize: 9, color: MISSION_STATUS_COLOR[m.status] ?? "var(--hud-text-dim)" }}>{m.status}</span>
                    {m.etaSec > 0 && <span style={{ fontSize: 9, color: "var(--hud-text-dim)" }}>ETA {Math.round(m.etaSec)}s</span>}
                  </div>
                </div>
              ))}
            </div>

            {/* Task Queue */}
            <div className="dp-section">
              <div className="dp-section-header">TASKS ({activeTasks.length})</div>
              {activeTasks.length === 0 && (
                <div style={{ fontSize: 10, color: "var(--hud-text-dim)" }}>No active tasks</div>
              )}
              {activeTasks.slice(0, 6).map(t => (
                <div key={t.id} className="dp-card" style={{ borderLeft: `2px solid ${TASK_STATUS_COLOR[t.status] ?? "var(--hud-text-dim)"}` }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                    <span style={{ fontSize: 11, color: "var(--hud-text-primary)", fontWeight: t.priority === "critical" ? "bold" : "normal", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: 140 }}>
                      {t.title}
                    </span>
                    <span style={{ fontSize: 9, color: "var(--hud-text-dim)" }}>{CMD_LABELS_SHORT[t.commander] ?? t.commander}</span>
                  </div>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 2 }}>
                    <span style={{ fontSize: 10, color: TASK_STATUS_COLOR[t.status] ?? "var(--hud-text-secondary)" }}>{t.status}</span>
                    <span className={`hud-badge hud-badge--${t.priority}`} style={{ fontSize: 8 }}>{t.priority.toUpperCase()}</span>
                  </div>
                </div>
              ))}
            </div>

            {/* Logistics Snapshot */}
            <div className="dp-section">
              <div className="dp-section-header">LOGISTICS</div>
              <div className="dp-logistics-grid">
                <div className="dp-resource-cell">
                  <div className="dp-resource-cell__label">Money</div>
                  <div className={`dp-resource-cell__value ${(res?.money ?? 0) < 500 ? "dp-resource-cell__value--crit" : "dp-resource-cell__value--good"}`}>
                    ${Math.floor(res?.money ?? 0).toLocaleString()}
                  </div>
                </div>
                <div className="dp-resource-cell">
                  <div className="dp-resource-cell__label">Fuel</div>
                  <div className={`dp-resource-cell__value ${(res?.fuel ?? 0) <= 20 ? "dp-resource-cell__value--crit" : (res?.fuel ?? 0) <= 50 ? "dp-resource-cell__value--warn" : "dp-resource-cell__value--good"}`}>
                    {Math.floor(res?.fuel ?? 0)}%
                  </div>
                </div>
                <div className="dp-resource-cell">
                  <div className="dp-resource-cell__label">Ammo</div>
                  <div className={`dp-resource-cell__value ${(res?.ammo ?? 0) <= 20 ? "dp-resource-cell__value--crit" : (res?.ammo ?? 0) <= 50 ? "dp-resource-cell__value--warn" : "dp-resource-cell__value--good"}`}>
                    {Math.floor(res?.ammo ?? 0)}%
                  </div>
                </div>
                <div className="dp-resource-cell">
                  <div className="dp-resource-cell__label">Intel</div>
                  <div className="dp-resource-cell__value dp-resource-cell__value--good">
                    {Math.floor(res?.intel ?? 0)}
                  </div>
                </div>
                <div className="dp-resource-cell" style={{ gridColumn: "span 2" }}>
                  <div className="dp-resource-cell__label">Readiness</div>
                  <div className={`dp-resource-cell__value ${readiness < 30 ? "dp-resource-cell__value--crit" : readiness < 60 ? "dp-resource-cell__value--warn" : "dp-resource-cell__value--ok"}`}>
                    {readiness}%
                  </div>
                </div>
              </div>
            </div>

            {/* Unit Pool — amber accent to break up the all-blue sidebar */}
            <div className="dp-section dp-section--amber">
              <div className="dp-section-header">UNIT POOL</div>
              <div className="dp-unit-pool">
                {unitCounts.size === 0 && (
                  <div style={{ fontSize: 10, color: "var(--hud-text-dim)", padding: "2px 8px" }}>No units</div>
                )}
                {Array.from(unitCounts.entries())
                  .sort((a, b) => b[1] - a[1])
                  .map(([type, count]) => (
                    <div key={type} className="dp-unit-row">
                      <span className="dp-unit-row__type">{UNIT_TYPE_LABELS[type] ?? type}</span>
                      <span className="dp-unit-row__count">{count}</span>
                    </div>
                  ))
                }
                {unitCounts.size > 0 && (
                  <div className="dp-unit-row dp-unit-row--total">
                    <span className="dp-unit-row__type">Total Units</span>
                    <span className="dp-unit-row__count">{Array.from(unitCounts.values()).reduce((a, b) => a + b, 0)}</span>
                  </div>
                )}
              </div>
            </div>
          </div>

          {/* CENTER COLUMN: Commander Comms */}
          <div className="dp-col-center">
            <div className="dp-comms">
              {/* Channel Rail */}
              <div className="dp-channel-rail">
                {COMMANDERS.map((cmd) => {
                  const meta = COMMANDER_META[cmd];
                  const isActive = selectedCommanders.length === 1 && selectedCommanders[0] === cmd;
                  const cmdColor = FROM_COLORS[cmd];
                  return (
                    <button
                      key={cmd}
                      className={`dp-channel-btn${isActive ? " dp-channel-btn--active" : ""}`}
                      data-channel-alert={channelAlert[COMMANDER_CHANNEL[cmd]]}
              data-guide-pulse={onGuide("chan:" + COMMANDER_CHANNEL[cmd]) && !isActive ? "on" : "off"}
                                            onClick={() => selectSingleCommander(cmd)}
                      style={{ borderLeftColor: isActive ? cmdColor : "transparent" }}
                      title={`${meta.label} (${meta.role})`}
                    >
                      <span className="dp-channel-btn__avatar"><CmdAvatar cmd={cmd} size={30} ring={cmdColor} /></span>
                      <span className="dp-channel-btn__name" style={{ color: isActive ? cmdColor : undefined }}>{meta.label}</span>
                      <span className="dp-channel-btn__role">{meta.role}</span>
                    </button>
                  );
                })}
                <button
                  className={`dp-channel-btn${selectedCommanders.length === 3 ? " dp-channel-btn--active" : ""}`}
                  onClick={selectAll}
                  style={{ borderLeftColor: selectedCommanders.length === 3 ? "#fbbf24" : "transparent" }}
                  title="全体指挥官"
                >
                  <span className="dp-channel-btn__avatar" style={{ fontSize: 11, fontWeight: 700 }}>ALL</span>
                  <span className="dp-channel-btn__name" style={{ color: selectedCommanders.length === 3 ? "#fbbf24" : undefined }}>全体</span>
                  <span className="dp-channel-btn__role">comms</span>
                </button>
              </div>

              {/* Conversation Pane */}
              <div className="dp-conv-pane">
                <div className="dp-conv-header">
                  <span style={{ color: isGroupChat ? "#fbbf24" : FROM_COLORS[selectedCommanders[0]] }}>
                    {isGroupChat ? "📡" : <CmdAvatar cmd={selectedCommanders[0]} size={22} ring={FROM_COLORS[selectedCommanders[0]]} />}
                  </span>
                  <span>
                    {isGroupChat ? "全体通信" : `${COMMANDER_META[selectedCommanders[0]].label} — ${COMMANDER_META[selectedCommanders[0]].role}`}
                  </span>
                  {isGroupChat && <span style={{ fontSize: 9, color: "var(--hud-text-dim)", marginLeft: "auto" }}>COMMS ONLY</span>}
                </div>
                {chatContentFragment}
                {/* Conversation Dock — 步 5 从页底搬进对话栏正下方，handler/props 未动 */}
                <div className="dp-conv-dock">
                  {SHOW_QUICK_BUY && (<>
                  <button
                    className="dp-dock-btn dp-dock-btn--prod"
                    onClick={() => handleProduce("infantry")}
                    disabled={playerMoney < 80 || playerQueueLen >= 3}
                    style={{ opacity: playerMoney >= 80 && playerQueueLen < 3 ? 1 : 0.35 }}
                    title={`生产步兵 ($80)${playerQueueLen >= 3 ? " — 队列已满" : ""}`}
                  >+兵$80</button>
                  <button
                    className="dp-dock-btn dp-dock-btn--prod"
                    onClick={() => handleProduce("light_tank")}
                    disabled={playerMoney < 200 || playerQueueLen >= 3}
                    style={{ opacity: playerMoney >= 200 && playerQueueLen < 3 ? 1 : 0.35 }}
                    title={`生产轻坦 ($200)${playerQueueLen >= 3 ? " — 队列已满" : ""}`}
                  >+坦$200</button>
                  </>)}
                  <input
                    ref={inputRef}
                    type="text"
                    className="dp-dock-input"
                    value={message}
                    onChange={handleTypedChange}
                    onKeyDown={handleKeyDown}
                    data-guide-pulse={onGuide("btn:input") ? "on" : "off"}
                    placeholder={isGroupChat ? "全体通信（仅讨论，不可下令）..." : `对${COMMANDER_META[selectedCommanders[0]].label}下令...`}
                    disabled={loading}
                  />
                  {/* 步 4：电报机钉在输入框右侧、PTT 键左侧（不进对话流，铁律 3）。 */}
                  <TelegraphKey pulses={telegraphPulses} transmits={telegraphTransmits} />
                  {/* 步 3：onPointerLeave 的 stopPTT 已删——它就是「说到一半手一歪、
                      错令直接发出去」的病本体。删它还是必要的而不是顺手：释放
                      pointer capture 时浏览器会向 capture 目标补发 pointerout/leave，
                      旧 handler 若还在、同 tick 里 pttStatus 仍是 listening，就会在
                      cancelPTT 之后再补一发 stopPTT，把刚取消的话发出去。 */}
                  <button
                    data-ptt-btn
                    data-ptt-state={pttStateAttr}
                    data-guide-pulse={onGuide("btn:mic") ? "on" : "off"}
                    className={`dp-dock-btn dp-dock-btn--ptt-main${pttCancelArmed ? " ptt-cancel-armed" : ""}`}
                    onPointerDown={onPttPointerDown}
                    onPointerMove={onPttPointerMove}
                    onPointerUp={onPttPointerUp}
                    onPointerCancel={onPttPointerCancel}
                    onLostPointerCapture={onPttLostCapture}
                    disabled={pttStatus === "unsupported" || loading}
                    style={{
                      background: pttCancelArmed ? "var(--hud-accent-red-dim)" : pttStatus === "listening" ? "var(--hud-accent-red)" : pttStatus === "error" ? "rgba(127, 29, 29, 0.8)" : undefined,
                      borderColor: pttCancelArmed ? "var(--hud-accent-red)" : undefined,
                      color: pttCancelArmed ? "var(--hud-accent-red)" : undefined,
                      opacity: pttStatus === "unsupported" || loading ? 0.35 : 1,
                    }}
                    title={
                      pttCancelArmed ? "松手取消"
                      : pttStatus === "unsupported" ? "浏览器不支持语音识别"
                      : pttStatus === "error" ? "麦克风权限被拒绝，请在浏览器设置中允许"
                      : pttStatus === "listening" ? "松开结束录音并发送"
                      : "按住说话"
                    }
                  >{pttCancelArmed ? "✕" : <MicIcon listening={pttStatus === "listening"} />}</button>
                  {hasTTS && (
                    <VolumePopover
                      ttsEnabled={ttsEnabled}
                      radioPulse={radioPulse}
                      onToggleTts={toggleTts}
                      className="dp-dock-btn dp-dock-btn--ptt"
                      style={{ background: ttsEnabled ? "rgba(0, 212, 255, 0.2)" : undefined }}
                    />
                  )}
                  {onCreateSquad && isChenChannel && (
                    <button
                      className="dp-dock-btn dp-dock-btn--action"
                      // 教学引导：这一步该点它的时候呼吸一下。★只有键**可点**时才亮——
                      //   亮一个按不下去的键是在耍玩家（没框选时它是 disabled 的）。
                      data-guide-pulse={onGuide("btn:squad") && squadBtnEnabled ? "on" : "off"}
                      onClick={(e) => openLeaderPicker(selectedCommanders[0], e)}
                      disabled={!squadBtnEnabled}
                      style={{ opacity: squadBtnEnabled ? 1 : 0.35, cursor: squadBtnEnabled ? "pointer" : "default" }}
                      title={squadBtnEnabled ? "将选中单位编为分队" : "请先框选未编队的单位"}
                    >编队</button>
                  )}
                  {onDeclareWar && canDeclareWar && (
                    <button className="dp-dock-btn dp-dock-btn--war" onClick={onDeclareWar} title="向敌方宣战">宣战</button>
                  )}
                  <button
                    data-send-btn
                    className="dp-dock-btn dp-dock-btn--send"
                    onClick={() => void sendCommand()}
                    disabled={loading || !message.trim()}
                    style={{ opacity: loading || !message.trim() ? 0.5 : 1 }}
                  >{loading ? "..." : "发送"}</button>
                </div>
              </div>
            </div>
          </div>

          {/* RIGHT COLUMN: 跟频道走的领域参考（步 3）＋战报 feed（一字未动） */}
          <div className="dp-col-right">
            {/* 侧栏刀 步3: 只换 .dp-org-container 那一格的内容——外加它头顶这行小标题。
                标题原本写死 BATTLEGROUP ORG TREE，艾米莉频道换成军械表后它就成了
                屏上的假话（与步 1 修掉的教程假指路同一类），所以跟着频道走。
                ★要退回"标题永远是 ORG TREE"＝把下面这个三元换回字面量，一行的事。
                群选（ALL／两人组）维持 OrgTree 现状：弹窗右栏是三人共有的看板位。 */}
            <div className="dp-section-header" style={{ padding: "0 0 6px 0" }}>
              {channelHasPanel && selectedCommanders[0] === "emily" ? "军械 ARSENAL"
                : channelHasPanel && selectedCommanders[0] === "marcus" ? "计策 STAFF PLAN"
                : "BATTLEGROUP ORG TREE"}
            </div>
            <div className="dp-org-container" data-dp-panel={channelHasPanel ? selectedCommanders[0] : "group"}>
              {channelHasPanel && selectedCommanders[0] === "emily" ? (
                <ArsenalPanel categories={arsenalCategories} />
              ) : channelHasPanel && selectedCommanders[0] === "marcus" ? (
                <div style={panelPlaceholderStyle}>参谋部尚未拟定方案。</div>
              ) : st ? (
                <OrgTree
                  squads={st.squads}
                  units={st.units}
                  state={st}
                  onSelectUnits={onSelectUnits ?? (() => {})}
                  onMoveSquad={onMoveSquad ?? (() => {})}
                  onRemoveFromParent={onRemoveFromParent ?? (() => {})}
                  onRenameLeader={onRenameLeader ?? (() => {})}
                  onTransferSquad={onTransferSquad ?? (() => {})}
                />
              ) : (
                <div style={{ color: "var(--hud-text-dim)", textAlign: "center", padding: 12 }}>加载中...</div>
              )}
            </div>

            {/* Battle reports — system feed split out of the conversation pane (Step 3) */}
            <div className="dp-section-header" style={{ padding: "10px 0 6px 0" }}>战报 BATTLE REPORTS</div>
            <div className="dp-report-feed">
              {reportMessages.length === 0 && (
                <div style={{ fontSize: 10, color: "var(--hud-text-dim)" }}>暂无战报</div>
              )}
              {reportMessages.map(renderReportLine)}
            </div>
          </div>
        </div>

        {/* Style Bar — 步 5 中栏对掉：风格五条常显横排，占原 dock 的位置 */}
        {styleSnapshot && (
          <div className="dp-style-bar">
            <span className="dp-style-bar__title">领导风格：</span>
            {styleRows.map(([label, val], i) => {
              const key = STYLE_KEYS[i];
              const fillClass =
                `dp-style-bar__fill dp-style-bar__fill--${STYLE_BAR_COLORS[i]}` +
                (styleFlash[key] ? " dp-style-bar__fill--changed" : "");
              return (
                <div key={label} className="dp-style-bar__item">
                  <span className="dp-style-bar__label">{label}</span>
                  <span className="dp-style-bar__track">
                    <span className={fillClass} style={{ width: `${val * 100}%` }} />
                  </span>
                  <span className="dp-style-bar__val">{(val * 100).toFixed(0)}</span>
                </div>
              );
            })}
          </div>
        )}
      </div>
    );
  }

  // ── Embedded panel (original layout, unchanged) ──
  const embeddedPanelStyle: React.CSSProperties = { ...panelStyle, display: collapsed ? "none" : "flex" };

  return (
    <>
      {/* ── Toggle button (only in embedded mode) ── */}
      {!isDetached && (
        <button
          onClick={() => setCollapsed((c) => !c)}
          className="hud-panel-toggle"
          style={{
            top: 8,
            right: collapsed ? 8 : 468,
            width: 28,
            height: 28,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
          }}
          title={collapsed ? "展开面板" : "收起面板"}
        >
          {collapsed ? "◀" : "▶"}
        </button>
      )}
    {/* ★ data-hud-dock：GameCanvas 靠它量"右边被盖住多少"（镜头下限与边界要用）。
        量 DOM 而不是照抄 460——收起/弹出/换宽度都自动跟上，不会两处数字打架。 */}
    <div style={embeddedPanelStyle} data-hud-dock="1">
      {/* ── Top: Commander selection bar ── */}
      <div style={commanderBarStyle}>
        {COMMANDERS.map((cmd) => {
          const meta = COMMANDER_META[cmd];
          const isSelected = selectedCommanders.includes(cmd);
          const cmdColor = FROM_COLORS[cmd];
          return (
            <button
              key={cmd}
              data-channel-alert={channelAlert[COMMANDER_CHANNEL[cmd]]}
              data-guide-pulse={onGuide("chan:" + COMMANDER_CHANNEL[cmd]) && !isSelected ? "on" : "off"}
              onClick={() => selectSingleCommander(cmd)}
              onContextMenu={(e) => { e.preventDefault(); toggleCommander(cmd); }}
              style={{
                ...commanderBtnStyle,
                opacity: isSelected ? 1 : 0.35,
                borderColor: isSelected ? cmdColor : "rgba(255,255,255,0.06)",
                boxShadow: isSelected ? `0 0 15px ${cmdColor}40, inset 0 0 20px ${cmdColor}10` : "none",
                background: isSelected
                  ? `linear-gradient(180deg, ${cmdColor}18 0%, rgba(10, 14, 26, 1) 100%)`
                  : "linear-gradient(180deg, rgba(25, 38, 65, 1) 0%, rgba(16, 24, 42, 1) 100%)",
              }}
              title={`${meta.label} (${meta.role}) — 右键多选`}
            >
              <span style={{
                width: 28, height: 28, borderRadius: "50%",
                background: isSelected ? `${cmdColor}25` : "rgba(255,255,255,0.06)",
                border: `2px solid ${isSelected ? cmdColor : "rgba(255,255,255,0.1)"}`,
                display: "flex", alignItems: "center", justifyContent: "center",
                fontSize: 14, flexShrink: 0,
                boxShadow: isSelected ? `0 0 8px ${cmdColor}40` : "none",
              }}><img src={AVATAR_IMG[cmd]} alt="" style={{ width: "100%", height: "100%", borderRadius: "50%", objectFit: "cover", display: "block" }} /></span>
              <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: "0.5px", textTransform: "uppercase" as const }}>{meta.label}</span>
              <span style={{ fontSize: 8, color: "var(--hud-text-dim)", textTransform: "uppercase" as const, letterSpacing: "1px" }}>{meta.role}</span>
            </button>
          );
        })}
        <button
          onClick={selectAll}
          style={{
            ...commanderBtnStyle,
            opacity: selectedCommanders.length === 3 ? 1 : 0.35,
            borderColor: selectedCommanders.length === 3 ? "#fbbf24" : "rgba(255,255,255,0.06)",
            boxShadow: selectedCommanders.length === 3 ? "0 0 15px rgba(251, 191, 36, 0.25), inset 0 0 20px rgba(251, 191, 36, 0.08)" : "none",
            background: selectedCommanders.length === 3
              ? "linear-gradient(180deg, rgba(251, 191, 36, 0.1) 0%, rgba(10, 14, 26, 1) 100%)"
              : "linear-gradient(180deg, rgba(25, 38, 65, 1) 0%, rgba(16, 24, 42, 1) 100%)",
          }}
          title="全体指挥官"
        >
          <span style={{
            width: 28, height: 28, borderRadius: "50%",
            background: selectedCommanders.length === 3 ? "rgba(251, 191, 36, 0.15)" : "rgba(255,255,255,0.06)",
            border: `2px solid ${selectedCommanders.length === 3 ? "#fbbf24" : "rgba(255,255,255,0.1)"}`,
            display: "flex", alignItems: "center", justifyContent: "center",
            fontSize: 12, fontWeight: 700, flexShrink: 0,
          }}>ALL</span>
          <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: "0.5px", textTransform: "uppercase" as const }}>全体</span>
          <span style={{ fontSize: 7, opacity: 0.5, letterSpacing: "0.5px", textTransform: "uppercase" as const }}>COMMS ONLY</span>
        </button>
      </div>

      {/* ── Tab switcher: Chat / 本频道的领域参考 ──
          整条只在有第二页签时渲染：群聊里连页签栏都不该出现，只有通讯。 */}
      {channelHasPanel && (
      <div style={tabBarStyle} data-tab-bar>
          <button
            data-guide-pulse={onGuide("btn:chattab") && effectiveTab !== "chat" ? "on" : "off"}
            onClick={() => setActiveTab("chat")}
            style={{
              ...tabBtnStyle,
              borderBottomColor: effectiveTab === "chat" ? "var(--hud-accent-cyan)" : "transparent",
              color: effectiveTab === "chat" ? "var(--hud-accent-cyan)" : "var(--hud-text-secondary)",
            }}
          >
            通讯 ☎
          </button>
          <button
            data-panel-tab={selectedCommanders[0]}
            data-guide-pulse={onGuide("btn:paneltab") && effectiveTab !== "panel" ? "on" : "off"}
            onClick={() => {
              setActiveTab("panel");
              onOpenPanelTab?.(COMMANDER_CHANNEL[selectedCommanders[0]]);
            }}
            style={{
              ...tabBtnStyle,
              borderBottomColor: effectiveTab === "panel" ? "var(--hud-accent-cyan)" : "transparent",
              color: effectiveTab === "panel" ? "var(--hud-accent-cyan)" : "var(--hud-text-secondary)",
            }}
          >
            {PANEL_TAB_LABEL[selectedCommanders[0]]}
          </button>
        </div>
      )}

      {/* ── Content area ── */}
      <div style={{ display: "flex", flex: 1, flexDirection: "column" as const, overflow: "hidden" }}>
      <div style={{ display: "flex", flexDirection: "column" as const, flex: 1, overflow: "hidden" }}>

      {effectiveTab === "panel" ? (
        (() => {
          // 侧栏刀 步1: 第二页签的内容跟频道走。陈＝编制树（props 一字未动），
          // 马克斯＝计策（占位，实时内容缓办立账），艾米莉＝军械（步 2 接表）。
          // effectiveTab==="panel" 已蕴含 channelHasPanel，此处必是单人频道。
          const cmd = selectedCommanders[0];
          if (cmd === "chen") {
            const st = getState();
            if (!st) return <div style={{ flex: 1, color: "var(--hud-text-dim)", textAlign: "center", padding: 20 }}>加载中...</div>;
            // 不套 wrapper：OrgTree 靠自己的滚动容器活，多一层 flex 就是回归风险。
            // 断言走页签的 data-panel-tab ＋ 树自身的内容。
            return (
              <OrgTree
                squads={st.squads}
                units={st.units}
                state={st}
                onSelectUnits={onSelectUnits ?? (() => {})}
                onMoveSquad={onMoveSquad ?? (() => {})}
                onRemoveFromParent={onRemoveFromParent ?? (() => {})}
                onRenameLeader={onRenameLeader ?? (() => {})}
                onTransferSquad={onTransferSquad ?? (() => {})}
              />
            );
          }
          if (cmd === "emily") {
            // 步 2：军械页。只吃 buildProductionOptions 那份构造（轮询里算好的
            // arsenalCategories），组件内再叠 ground 过滤——UI 自己筛 UNIT_STATS
            // 会把 cost=0 的指挥官/精锐卫队也筛进生产清单。
            return (
              <div style={panelContentBoxStyle} data-panel-content="emily">
                <ArsenalPanel categories={arsenalCategories} />
              </div>
            );
          }
          // 马克斯的计策页：真内容缓办立账，点进去纯空白像是坏了——一行占位话顶着。
          return (
            <div style={panelPlaceholderStyle} data-panel-content={cmd}>
              参谋部尚未拟定方案。
            </div>
          );
        })()
      ) : (
        chatContentFragment
      )}

      {/* ── Bottom: Input area ── */}
      <div style={inputContainerStyle}>
        {SHOW_QUICK_BUY && (<>
        <button onClick={() => handleProduce("infantry")} disabled={playerMoney < 80 || playerQueueLen >= 3} style={{ ...prodBtnStyle, opacity: playerMoney >= 80 && playerQueueLen < 3 ? 1 : 0.35 }} title={`生产步兵 ($80)${playerQueueLen >= 3 ? " — 队列已满" : ""}`}>+兵$80</button>
        <button onClick={() => handleProduce("light_tank")} disabled={playerMoney < 200 || playerQueueLen >= 3} style={{ ...prodBtnStyle, opacity: playerMoney >= 200 && playerQueueLen < 3 ? 1 : 0.35 }} title={`生产轻坦 ($200)${playerQueueLen >= 3 ? " — 队列已满" : ""}`}>+坦$200</button>
        </>)}
        <input ref={inputRef} data-guide-pulse={onGuide("btn:input") ? "on" : "off"} type="text" value={message} onChange={handleTypedChange} onKeyDown={handleKeyDown} placeholder={isGroupChat ? "全体通信（仅讨论，不可下令）..." : `对${COMMANDER_META[selectedCommanders[0]].label}下令...`} disabled={loading} style={inputStyle} />
        <TelegraphKey pulses={telegraphPulses} transmits={telegraphTransmits} />
        {/* 步 3：onPointerLeave 的 stopPTT 已删（理由同弹窗态那处注释：它既是
            "滑出即发送"的病本体，又会在 capture 释放时补发一脚踩掉 cancelPTT）。 */}
        <button data-ptt-btn data-ptt-state={pttStateAttr} data-guide-pulse={onGuide("btn:mic") ? "on" : "off"} className={pttCancelArmed ? "ptt-cancel-armed" : undefined} onPointerDown={onPttPointerDown} onPointerMove={onPttPointerMove} onPointerUp={onPttPointerUp} onPointerCancel={onPttPointerCancel} onLostPointerCapture={onPttLostCapture} disabled={pttStatus === "unsupported" || loading} style={{ ...pttBtnStyle, ...pttBigStyle, background: pttCancelArmed ? "var(--hud-accent-red-dim)" : pttStatus === "listening" ? "var(--hud-accent-red)" : pttStatus === "error" ? "rgba(127, 29, 29, 0.8)" : pttBtnStyle.background, borderColor: pttCancelArmed ? "var(--hud-accent-red)" : "var(--hud-border-bright)", color: pttCancelArmed ? "var(--hud-accent-red)" : "var(--hud-text-primary)", opacity: pttStatus === "unsupported" || loading ? 0.35 : 1, cursor: pttStatus === "unsupported" || loading ? "default" : "pointer" }} title={pttCancelArmed ? "松手取消" : pttStatus === "unsupported" ? "浏览器不支持语音识别" : pttStatus === "error" ? "麦克风权限被拒绝" : pttStatus === "listening" ? "松开结束录音并发送" : "按住说话"}>{pttCancelArmed ? "✕" : <MicIcon listening={pttStatus === "listening"} />}</button>
        {hasTTS && (<VolumePopover ttsEnabled={ttsEnabled} radioPulse={radioPulse} onToggleTts={toggleTts} style={{ ...pttBtnStyle, background: ttsEnabled ? "rgba(0, 212, 255, 0.2)" : pttBtnStyle.background, opacity: 1, cursor: "pointer", fontSize: 14 }} />)}
        {onCreateSquad && isChenChannel && (<button data-guide-pulse={onGuide("btn:squad") && squadBtnEnabled ? "on" : "off"} onClick={(e) => openLeaderPicker(selectedCommanders[0], e)} disabled={!squadBtnEnabled} style={{ ...actionBtnStyle, opacity: squadBtnEnabled ? 1 : 0.35, cursor: squadBtnEnabled ? "pointer" : "default" }} title={squadBtnEnabled ? "将选中单位编为分队" : "请先框选未编队的单位"}>编队</button>)}
        {onDeclareWar && canDeclareWar && (<button onClick={onDeclareWar} style={warBtnStyle} title="向敌方宣战">宣战</button>)}
        <button data-send-btn onClick={() => void sendCommand()} disabled={loading || !message.trim()} style={{ ...sendBtnStyle, opacity: loading || !message.trim() ? 0.5 : 1 }}>{loading ? "..." : "发送"}</button>
      </div>
      </div>
      </div>
      {leaderPicker && (
        <LeaderPicker
          p={leaderPicker}
          list={getAssignableLeaders ? getAssignableLeaders() : []}
          onPick={confirmLeader}
        />
      )}
    </div>
    </>
  );
}

// ── Styles (HUD theme) ──

const panelStyle: React.CSSProperties = {
  position: "absolute",
  top: 0,
  right: 0,
  width: 460,
  height: "100%",
  background: "radial-gradient(ellipse at 50% 0%, rgba(0, 212, 255, 0.06) 0%, transparent 60%), linear-gradient(180deg, rgba(20, 30, 55, 1) 0%, rgba(12, 18, 35, 1) 15%, rgba(10, 14, 26, 1) 50%, rgba(8, 11, 22, 1) 100%)",
  borderLeft: "2px solid rgba(0, 212, 255, 0.25)",
  fontFamily: "var(--hud-font-mono)",
  fontSize: 12,
  color: "var(--hud-text-primary)",
  zIndex: 100,
  pointerEvents: "auto",
  display: "flex",
  flexDirection: "column",
  boxShadow: "-6px 0 30px rgba(0, 0, 0, 0.7), inset 3px 0 15px rgba(0, 212, 255, 0.06), inset 0 0 60px rgba(0, 0, 0, 0.3)",
};

/** 侧栏刀 步2: 第二页签真内容的外框。ArsenalPanel 自带滚动，这一层只负责
 *  在两层 overflow:hidden 的包裹里把高度撑开。 */
const panelContentBoxStyle: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  flex: 1,
  overflow: "hidden",
};

/** 侧栏刀 步1: 第二页签还没有真内容时的一行占位（马克斯的计策页）。
 *  flex:1 顶住高度，免得内容区塌成一条缝。 */
const panelPlaceholderStyle: React.CSSProperties = {
  flex: 1,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  padding: 20,
  color: "var(--hud-text-dim)",
  fontSize: 12,
  textAlign: "center",
};

const tabBarStyle: React.CSSProperties = {
  display: "flex",
  gap: 0,
  borderBottom: "1px solid rgba(0, 212, 255, 0.1)",
  flexShrink: 0,
  background: "linear-gradient(180deg, rgba(12, 18, 32, 1) 0%, rgba(8, 12, 22, 1) 100%)",
  boxShadow: "inset 0 -1px 0 rgba(0, 212, 255, 0.05)",
};

const tabBtnStyle: React.CSSProperties = {
  flex: 1,
  background: "transparent",
  border: "none",
  borderBottom: "2px solid transparent",
  color: "var(--hud-text-dim)",
  fontSize: 12,
  fontFamily: "var(--hud-font-display)",
  fontWeight: 600,
  letterSpacing: 1,
  textTransform: "uppercase",
  padding: "6px 0",
  cursor: "pointer",
  transition: "color 0.15s, border-color 0.15s",
};

const commanderBarStyle: React.CSSProperties = {
  display: "flex",
  gap: 6,
  padding: "10px 12px",
  borderBottom: "2px solid rgba(0, 212, 255, 0.15)",
  flexShrink: 0,
  background: "linear-gradient(180deg, rgba(16, 24, 45, 1) 0%, rgba(10, 14, 28, 1) 100%)",
  boxShadow: "inset 0 -1px 0 rgba(0, 212, 255, 0.1), 0 2px 8px rgba(0, 0, 0, 0.3)",
};

const commanderBtnStyle: React.CSSProperties = {
  flex: 1,
  display: "flex",
  flexDirection: "column",
  alignItems: "center",
  gap: 2,
  padding: "8px 4px",
  background: "linear-gradient(180deg, rgba(25, 38, 65, 1) 0%, rgba(16, 24, 42, 1) 100%)",
  border: "2px solid rgba(255, 255, 255, 0.06)",
  borderRadius: 0,
  cursor: "pointer",
  fontFamily: "var(--hud-font-mono)",
  color: "var(--hud-text-primary)",
  transition: "all 0.2s ease",
};

const chatFlowStyle: React.CSSProperties = {
  flex: 1,
  overflowY: "auto",
  padding: "8px 12px",
  display: "flex",
  flexDirection: "column",
  gap: 6,
};

const bubbleRowStyle: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 2,
};

const bubbleMetaStyle: React.CSSProperties = {
  display: "flex",
  gap: 6,
  alignItems: "baseline",
  paddingLeft: 2,
};

const bubbleStyle: React.CSSProperties = {
  padding: "10px 14px",
  border: "1px solid var(--hud-border-dim)",
  wordBreak: "break-word",
  clipPath: "var(--hud-chamfer-sm)",
};

const timeTagStyle: React.CSSProperties = {
  fontSize: 9,
  color: "var(--hud-text-dim)",
};

// Step 3: low-key "report lane" for system reports (heartbeat / event_report /
// system notices) — a compact log line, visually distinct from persona bubbles.
const reportLineStyle: React.CSSProperties = {
  display: "flex",
  gap: 6,
  alignItems: "baseline",
  padding: "2px 8px",
};

const threadBubbleStyle: React.CSSProperties = {
  position: "relative",
  padding: "10px 32px 10px 12px", // extra right padding so text doesn't run under × button
  background: "linear-gradient(180deg, rgba(240, 160, 48, 0.15) 0%, rgba(240, 160, 48, 0.05) 100%)",
  border: "1px solid rgba(240, 160, 48, 0.35)",
  borderLeft: "4px solid #f0a030",
  boxShadow: "0 3px 15px rgba(0, 0, 0, 0.35), 0 0 15px rgba(240, 160, 48, 0.08), inset 0 0 30px rgba(240, 160, 48, 0.05)",
};

const crisisDismissBtn: React.CSSProperties = {
  position: "absolute",
  top: 6,
  right: 8,
  background: "rgba(0, 0, 0, 0.35)",
  border: "1px solid rgba(240, 160, 48, 0.55)",
  borderRadius: 4,
  color: "#f0a030",
  cursor: "pointer",
  fontSize: 16,
  fontWeight: "bold",
  lineHeight: "16px",
  padding: "2px 7px",
};

const threadOptionBtnStyle: React.CSSProperties = {
  display: "block",
  width: "100%",
  textAlign: "left",
  background: "var(--hud-bg-secondary)",
  border: "1px solid var(--hud-border-dim)",
  padding: "6px 8px",
  fontSize: 11,
  fontFamily: "var(--hud-font-mono)",
  color: "var(--hud-text-primary)",
  cursor: "pointer",
  transition: "border-color 0.15s, background 0.15s",
};

const optionsInlineStyle: React.CSSProperties = {
  padding: "12px 14px",
  background: "linear-gradient(180deg, rgba(15, 22, 40, 0.97) 0%, rgba(10, 14, 26, 0.99) 100%)",
  border: "1px solid rgba(0, 212, 255, 0.2)",
  boxShadow: "0 4px 20px rgba(0, 0, 0, 0.5), 0 0 20px rgba(0, 212, 255, 0.06), inset 0 1px 0 rgba(0, 212, 255, 0.08)",
  clipPath: "var(--hud-chamfer-sm)",
  backdropFilter: "blur(8px)",
};

const optionCardStyle: React.CSSProperties = {
  background: "linear-gradient(180deg, rgba(21, 32, 54, 0.9) 0%, rgba(15, 22, 40, 0.7) 100%)",
  border: "1px solid var(--hud-border-base)",
  padding: "10px 12px",
  marginBottom: 6,
  transition: "all 0.2s ease",
  boxShadow: "0 2px 10px rgba(0, 0, 0, 0.45), inset 0 1px 0 rgba(255, 255, 255, 0.03)",
  clipPath: "var(--hud-chamfer-sm)",
  cursor: "pointer",
};

const recommendedBadge: React.CSSProperties = {
  fontSize: 9,
  background: "rgba(0, 224, 112, 0.2)",
  color: "var(--hud-accent-green)",
  padding: "1px 5px",
  fontWeight: "bold",
  fontFamily: "var(--hud-font-display)",
  letterSpacing: 0.5,
  textTransform: "uppercase",
};

const dismissBtn: React.CSSProperties = {
  background: "none",
  border: "none",
  color: "var(--hud-text-dim)",
  cursor: "pointer",
  fontSize: 14,
  padding: "0 4px",
  marginLeft: 8,
};

const barBg: React.CSSProperties = {
  display: "inline-block",
  width: 40,
  height: 6,
  background: "var(--hud-bg-primary)",
  border: "1px solid var(--hud-border-dim)",
  overflow: "hidden",
  verticalAlign: "middle",
  position: "relative",
};

const barFill: React.CSSProperties = {
  display: "block",
  height: "100%",
};

const approveBtnStyle: React.CSSProperties = {
  marginTop: 6,
  width: "100%",
  background: "linear-gradient(180deg, rgba(0, 212, 255, 0.25) 0%, rgba(0, 212, 255, 0.1) 100%)",
  color: "#00d4ff",
  border: "2px solid rgba(0, 212, 255, 0.7)",
  padding: "8px 0",
  fontSize: 12,
  fontFamily: "var(--hud-font-display)",
  fontWeight: "bold",
  cursor: "pointer",
  letterSpacing: 2,
  transition: "all 0.2s ease",
  boxShadow: "0 0 15px rgba(0, 212, 255, 0.35), 0 0 30px rgba(0, 212, 255, 0.12), inset 0 1px 0 rgba(0, 212, 255, 0.2)",
  textShadow: "0 0 10px rgba(0, 212, 255, 0.7)",
  textTransform: "uppercase",
  clipPath: "var(--hud-chamfer-sm)",
};

const cancelBtnStyle: React.CSSProperties = {
  flex: 1,
  padding: "6px 0",
  fontSize: 10,
  border: "1px solid rgba(255, 48, 64, 0.5)",
  background: "linear-gradient(180deg, rgba(255, 48, 64, 0.12) 0%, rgba(255, 48, 64, 0.04) 100%)",
  color: "var(--hud-accent-red)",
  cursor: "pointer",
  fontFamily: "var(--hud-font-display)",
  fontWeight: 700,
  letterSpacing: 1,
  textTransform: "uppercase",
  transition: "all 0.2s ease",
  boxShadow: "0 0 8px rgba(255, 48, 64, 0.1)",
  clipPath: "var(--hud-chamfer-sm)",
};

const supplementBtnStyle: React.CSSProperties = {
  flex: 1,
  padding: "5px 0",
  fontSize: 10,
  border: "1px solid var(--hud-accent-cyan)",
  background: "linear-gradient(180deg, rgba(0, 212, 255, 0.12) 0%, rgba(0, 212, 255, 0.04) 100%)",
  color: "var(--hud-accent-cyan)",
  cursor: "pointer",
  fontFamily: "var(--hud-font-display)",
  fontWeight: 600,
  letterSpacing: 0.5,
  textTransform: "uppercase",
  transition: "all 0.2s ease",
  boxShadow: "0 0 6px rgba(0, 212, 255, 0.1)",
  textShadow: "0 0 4px rgba(0, 212, 255, 0.3)",
};

const warningStyle: React.CSSProperties = {
  color: "var(--hud-accent-amber)",
  fontSize: 10,
  marginTop: 4,
  padding: "4px 6px",
  background: "var(--hud-accent-amber-dim)",
};

const errorBubbleStyle: React.CSSProperties = {
  color: "var(--hud-accent-red)",
  fontSize: 11,
  padding: "6px 8px",
  background: "var(--hud-accent-red-dim)",
  border: "1px solid rgba(255, 48, 64, 0.3)",
};

const clarificationStyle: React.CSSProperties = {
  color: "var(--hud-accent-amber)",
  fontSize: 11,
  padding: "6px 8px",
  background: "var(--hud-accent-amber-dim)",
  border: "1px solid rgba(240, 160, 48, 0.3)",
};

const styleRowStyle: React.CSSProperties = {
  padding: "4px 10px",
  borderTop: "1px solid var(--hud-border-base)",
  flexShrink: 0,
};

const styleToggleBtn: React.CSSProperties = {
  background: "none",
  border: "none",
  color: "var(--hud-text-dim)",
  cursor: "pointer",
  fontSize: 10,
  fontFamily: "var(--hud-font-mono)",
  padding: "2px 0",
};

const styleBarContainer: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 2,
  marginTop: 3,
  padding: "4px 6px",
  background: "var(--hud-bg-tertiary)",
  borderRadius: 3,
};

const styleBarItem: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 4,
};

const styleLabel: React.CSSProperties = {
  width: 24,
  color: "var(--hud-text-secondary)",
  fontSize: 9,
};

const styleVal: React.CSSProperties = {
  width: 20,
  color: "var(--hud-text-dim)",
  fontSize: 9,
  textAlign: "right",
};

const inputContainerStyle: React.CSSProperties = {
  display: "flex",
  gap: 6,
  padding: "10px 12px",
  borderTop: "2px solid rgba(0, 212, 255, 0.2)",
  flexShrink: 0,
  background: "linear-gradient(180deg, rgba(14, 20, 38, 0.98) 0%, rgba(8, 12, 24, 1) 100%)",
  boxShadow: "inset 0 2px 8px rgba(0, 0, 0, 0.3), 0 -2px 15px rgba(0, 0, 0, 0.4)",
};

const inputStyle: React.CSSProperties = {
  flex: 1,
  background: "linear-gradient(180deg, rgba(8, 12, 24, 0.95) 0%, rgba(6, 8, 18, 0.98) 100%)",
  border: "1px solid var(--hud-border-base)",
  padding: "8px 10px",
  color: "var(--hud-text-primary)",
  fontSize: 12,
  fontFamily: "var(--hud-font-mono)",
  outline: "none",
  caretColor: "var(--hud-accent-cyan)",
  transition: "border-color 0.2s, box-shadow 0.2s",
  boxShadow: "inset 0 2px 4px rgba(0, 0, 0, 0.3)",
};

const prodBtnStyle: React.CSSProperties = {
  background: "var(--hud-accent-green-dim)",
  color: "var(--hud-accent-green)",
  border: "1px solid rgba(0, 224, 112, 0.4)",
  padding: "6px 6px",
  fontSize: 10,
  fontFamily: "var(--hud-font-mono)",
  cursor: "pointer",
  whiteSpace: "nowrap",
  transition: "background 0.15s",
};

const actionBtnStyle: React.CSSProperties = {
  background: "var(--hud-accent-cyan-dim)",
  color: "var(--hud-accent-cyan)",
  border: "1px solid var(--hud-accent-cyan)",
  padding: "6px 8px",
  fontSize: 11,
  fontFamily: "var(--hud-font-display)",
  fontWeight: 600,
  letterSpacing: 0.5,
  cursor: "pointer",
  whiteSpace: "nowrap",
  transition: "background 0.15s, box-shadow 0.15s",
};

const warBtnStyle: React.CSSProperties = {
  background: "var(--hud-accent-red-dim)",
  color: "var(--hud-accent-red)",
  border: "1px solid var(--hud-accent-red)",
  padding: "6px 8px",
  fontSize: 11,
  fontFamily: "var(--hud-font-display)",
  fontWeight: "bold",
  letterSpacing: 1,
  textTransform: "uppercase",
  cursor: "pointer",
  whiteSpace: "nowrap",
  transition: "background 0.15s, box-shadow 0.15s",
};

const pttBtnStyle: React.CSSProperties = {
  background: "var(--hud-bg-elevated)",
  color: "var(--hud-text-primary)",
  border: "1px solid var(--hud-border-bright)",
  padding: "6px 8px",
  fontSize: 11,
  fontFamily: "var(--hud-font-mono)",
  cursor: "pointer",
  whiteSpace: "nowrap",
  userSelect: "none",
  touchAction: "none",
  transition: "background 0.15s, border-color 0.15s",
};

/* 动画R2 步 1：PTT 单独加量。pttBtnStyle 被 TTS 喇叭键复用，动它喇叭会跟着长个，
   故加量走这层覆盖、只贴 PTT 一处。44 = 触屏 a11y 触点下限，桌面鼠标场景只当首版
   起点（滑开取消要更大的落点，终值等截图目测再调）。 */
/** 步 3：滑出按钮边界多远算「要取消」。鼠标尺度的手感参数，首版 12px。 */
const PTT_CANCEL_SLOP = 12;

const pttBigStyle: React.CSSProperties = {
  padding: "10px 14px",
  fontSize: 16,
  minWidth: 44,
  minHeight: 44,
};

const sendBtnStyle: React.CSSProperties = {
  background: "linear-gradient(180deg, rgba(0, 212, 255, 0.3) 0%, rgba(0, 212, 255, 0.12) 100%)",
  color: "#00d4ff",
  border: "2px solid rgba(0, 212, 255, 0.6)",
  padding: "6px 16px",
  fontSize: 12,
  fontFamily: "var(--hud-font-display)",
  fontWeight: 700,
  letterSpacing: 2,
  cursor: "pointer",
  transition: "all 0.2s ease",
  boxShadow: "0 0 12px rgba(0, 212, 255, 0.3), 0 0 25px rgba(0, 212, 255, 0.08)",
  textShadow: "0 0 10px rgba(0, 212, 255, 0.6)",
  textTransform: "uppercase",
  clipPath: "var(--hud-chamfer-sm)",
};


// ════════════════════════════════════════════════════════════
// 步 2 · 点将弹窗
//
// 交接档 §3 的硬约束，逐条落在这里：
//   · **不是挡屏的模态框**——没有遮罩层、不拦背景点击。战场还在跑。
//   · 小、贴着触发它的那个按钮弹出（不是屏幕中央）。
//   · Esc 可取消，点别处也取消。
//   · **必须让人感觉到"用掉一个就少一个"**：标题直接写「可用队长（N）」，
//     并把剩下的人一个个列出来。如果每支队都配得到激进的，"激进"就没有意义，
//     这个功能会退化成一个带名字的下拉框——稀缺是地基，不是省事。
//   · 名册空了**仍然可以编队**，只是这支队没有队长（吃兜底档 balanced，
//     也没人替它说话）。不报错——"人手不够"是一种处境。
// ════════════════════════════════════════════════════════════

const PICKER_PERSONALITY_LABEL: Record<LeaderPersonality, string> = {
  aggressive: "激进", balanced: "稳健", cautious: "保守",
};
const PICKER_PERSONALITY_COLOR: Record<LeaderPersonality, string> = {
  aggressive: "#f87171", balanced: "var(--hud-text-dim)", cautious: "#60a5fa",
};
/**
 * 一句话说清这档队长会怎么打——玩家要凭这个做用人决策，不能只给个标签。
 *
 * ★ 措辞铁律：**任何一档都不许说"看得见就管"**（2026-08-30 用户抓出来的错）。
 *   引擎的交战半径是 8/11/14 格，而阿拉曼视野是 15~18 格（fog.ts
 *   EL_ALAMEIN_UNIT_VISION）——每一档的交战半径都**小于**视野，中间那 4~7 格
 *   是"看得见但不管"的带。而首轮外部试玩者的原话正是"能看到敌军坦克在不远处
 *   但部队不动"：说"看得见就管"等于把那个 bug 重新承诺一遍，而 balanced
 *   还是兜底档（全部敌军 + 未编队部队都吃它），承诺面最大。
 *   改数值时这三句要跟着数值一起核，别只核数值。
 */
const PICKER_PERSONALITY_HINT: Record<LeaderPersonality, string> = {
  aggressive: "十几格外的敌人也会主动扑上去",   // engage 14
  balanced: "十格内的敌人会管，不追远",         // engage 11 —— 说"十格内"是真的；说"看得见"是假的
  cautious: "守住阵地，不为路过的目标脱离",     // engage 8
};

function LeaderPicker({ p, list, onPick }: {
  p: { owner: "chen" | "marcus" | "emily"; x: number; y: number };
  /** 每次渲染由调用方现算传入——**不要在这里缓存**，理由见 leaderPicker 状态处。 */
  list: LeaderProfile[];
  onPick: (leaderName: string | null) => void;
}) {
  const empty = list.length === 0;
  // 贴着按钮往上弹；夹在视口内，别被挤出屏幕。
  const width = 208;
  const left = Math.max(8, Math.min(p.x, window.innerWidth - width - 8));
  const bottom = Math.max(8, window.innerHeight - p.y + 8);
  return (
    <div
      data-leader-picker
      style={{
        position: "fixed", left, bottom, width, zIndex: 9000,
        background: "var(--hud-bg-secondary)", border: "1px solid var(--hud-border-bright)",
        borderRadius: 8, padding: 8, boxShadow: "0 6px 24px rgba(0,0,0,0.55)",
        fontFamily: "var(--hud-font-mono)", maxHeight: 320, overflowY: "auto",
      }}
    >
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", marginBottom: 6 }}>
        <span style={{ fontSize: 11, color: "var(--hud-text-primary)", fontWeight: "bold" }}>
          可用队长（{list.length}）
        </span>
        <span style={{ fontSize: 9, color: "var(--hud-text-dim)" }}>Esc 取消</span>
      </div>

      {empty ? (
        <>
          <div style={{ fontSize: 10, color: "var(--hud-text-dim)", lineHeight: 1.5, marginBottom: 8 }}>
            名册已空，没有军官可派。仍然可以编队——这支队不会有队长，
            按<span style={{ color: "var(--hud-text-primary)" }}>稳健</span>行动，也没人替它说话。
          </div>
          <button
            onClick={() => onPick(null)}
            style={{
              width: "100%", padding: "6px 8px", fontSize: 10, cursor: "pointer",
              background: "transparent", color: "var(--hud-text-primary)",
              border: "1px dashed var(--hud-border-bright)", borderRadius: 6,
              fontFamily: "var(--hud-font-mono)",
            }}
          >仍然编队（无队长）</button>
        </>
      ) : (
        list.map((lp) => (
          <button
            key={lp.name}
            onClick={() => onPick(lp.name)}
            style={{
              display: "block", width: "100%", textAlign: "left", marginBottom: 3,
              padding: "5px 7px", cursor: "pointer", borderRadius: 6,
              background: "transparent", border: "1px solid var(--hud-border-dim, rgba(255,255,255,0.08))",
              fontFamily: "var(--hud-font-mono)",
            }}
            onMouseEnter={(e) => { e.currentTarget.style.background = "rgba(0,212,255,0.10)"; }}
            onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; }}
          >
            <div style={{ display: "flex", alignItems: "baseline", gap: 6 }}>
              <span style={{ fontSize: 11, color: "var(--hud-text-primary)", fontWeight: "bold" }}>{lp.name}</span>
              <span style={{ fontSize: 10, fontWeight: "bold", color: PICKER_PERSONALITY_COLOR[lp.personality] }}>
                {PICKER_PERSONALITY_LABEL[lp.personality]}
              </span>
            </div>
            <div style={{ fontSize: 8, color: "var(--hud-text-dim)", marginTop: 1 }}>
              {PICKER_PERSONALITY_HINT[lp.personality]}
            </div>
          </button>
        ))
      )}
      {!empty && (
        <div style={{ fontSize: 8, color: "var(--hud-text-dim)", marginTop: 5, lineHeight: 1.4 }}>
          派出去就少一个。名册共 12 人。
        </div>
      )}
    </div>
  );
}
