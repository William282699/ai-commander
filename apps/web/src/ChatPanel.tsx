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
import { resolveIntent, applyOrders, updateStyleParam, findFront, enqueueProduction, cancelDoctrine, captureDecisionReview, enqueueDecisionReview, isReviewableIntentType, previewHighImpactIntent, buildPreflightConcernFacts, serializePreflightFacts, buildPreflightFallbackLine, buildPlayerViewLines, isAllFrontHint } from "@ai-commander/core";
import { spokenNameOf, resolveTicketReference, ticketDispatchReceipt, burnEscalationTicket, isKnownForceRef, checkDispatchAuthority, retargetIntentForTicket, ticketDestinationVerdict, describeCommittedPull } from "@ai-commander/core";
import type { CommanderRef, EscalationTicket } from "@ai-commander/core";
import type { ViewportGeometry } from "@ai-commander/core";
import type { GameState, AdvisorResponse, AdvisorOption, Intent, Channel, CommanderMemory, TaskCard, TaskPriority } from "@ai-commander/shared";
import { buildDigestForChannel } from "./digestHelper";
// Phase 1 的闸已搬去 autoExecuteGate.ts（零行为变化）——留在组件闭包里台架够不到。
import { isKnownLocation, isValidTarget, detectStaleSquadRefs, canAutoExecute, decideBucket } from "./autoExecuteGate";
import type { StandingOrder, StandingOrderType, DoctrinePriority } from "@ai-commander/shared";
import { CHANNEL_LABELS, collectUnitsUnder, judgePendingConsumption, parsePendingDecision, pendingVerdictRoute } from "@ai-commander/shared";
import type { PendingRequestTag } from "@ai-commander/shared";
import { armVoiceCapture, isVoiceCaptureSupported, isVoiceWarmEnabled, getVoiceOpenDiag, type VoiceRecording, type VoiceCaptureArm } from "./voiceRecorder";
import { probeVoiceChannels, channelUsesVoiceCapture, isBaselineArm } from "./voiceCapability";
import { RadioCallRow } from "./RadioCallRow";
// spoken 层：一个回合里耳朵听见什么，由这一个纯函数一次算完（R2 听觉序列）。
import { planVoiceSpeech } from "./voiceSpeech";
import { setPlaybackObserver } from "./tts";
import {
  addMessage,
  updateLastPlayerMessage,
  getActiveChannel,
  setActiveChannel,
  getGroupChatMessages,
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
import { speak, flush, cancel, type Persona } from "./tts";
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
function buildGateQuestion(reason: string | undefined, brief: string, staleRefs: string[]): string {
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
      {
        // brief often ends with 。— strip trailing punctuation so the joined
        // sentence never reads "。，" (Codex polish round-2 #2).
        const cleanLead = (lead || "这道命令没点名部队，会抽动全军").replace(/[。．.，,！!？?\s]+$/, "");
        return `${cleanLead}——其它方向就空了。照打还是留兵，您一句话。`;
      }
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
  onCreateSquad?: (owner: "chen" | "marcus" | "emily") => void;
  canCreateSquad?: () => boolean;
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


export function ChatPanel({ getState, getSelectedUnitIds, getViewport, onCreateSquad, canCreateSquad, onDeclareWar, onSelectUnits, onMoveSquad, onRemoveFromParent, onRenameLeader, onTransferSquad, isDetached }: Props) {
  // ── Panel collapse state ──
  const [collapsed, setCollapsed] = useState(false);

  // ── Tab state: "chat" or "org" ──
  const [activeTab, setActiveTab] = useState<"chat" | "org">("chat");

  // ── Commander selection state ──
  const [selectedCommanders, setSelectedCommanders] = useState<Commander[]>(["chen"]);
  const isGroupChat = selectedCommanders.length > 1;
  const isChenChannel = !isGroupChat && selectedCommanders[0] === "chen";

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
  } | null>(null);
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
  // ── 延迟 A/B：松手 → 耳朵真听见（客户端自己量，搭下一次命令回服务端）──
  // 判据是"松手到出声"，而出声那一刻只有 TTS 模块知道。长官原话：「我真的不会去
  // f12 做这些，每次都整错」——**要长官去捞证据本身就是设计缺陷**（§8 那笔账的
  // 同一形状），所以这里自己量。两臂共用同一份构建 ⇒ 基线臂也照样自报。
  const releaseAtRef = useRef<number | null>(null);
  const speechDiagRef = useRef<{ firstSoundMs: number; text: string; baseline: boolean } | null>(null);
  useEffect(() => {
    setPlaybackObserver((text) => {
      const t0 = releaseAtRef.current;
      if (t0 == null) return;            // 打字回合/主动播报不计
      releaseAtRef.current = null;       // 一轮只记第一声
      speechDiagRef.current = {
        firstSoundMs: Math.round(performance.now() - t0),
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
  const [ttsEnabled, setTtsEnabled] = useState(false);

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
      setMessage(prev => {
        const clean = prev.replace(/\u200B.*$/, "");
        // Auto-send if we got final text
        if (clean.trim()) {
          setTimeout(() => {
            const sendBtn = document.querySelector("[data-send-btn]") as HTMLButtonElement | null;
            sendBtn?.click();
          }, 50);
        }
        return clean;
      });
      setPttStatus(s => (s === "error" ? s : "idle"));
      pttRecRef.current = null;
    };
    pttRecRef.current = rec;
    setPttStatus("listening");
    rec.start();
  }, [SpeechRecCtor, loading, selectedCommanders, isGroupChat]);

  const stopPTT = useCallback(() => {
    releaseAtRef.current = performance.now();   // 松手：计时起点（两臂同一处）
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
  }, []);

  // P1: snapshot selected unit IDs at sendCommand time
  const selectedIdsSnapshotRef = useRef<number[] | undefined>(undefined);

  // Fix #2: execution context bound to each response (+ requestId for approve validation)
  // 7e.1: also carries escalateId — processAdvisorData clears the active escalation
  // BEFORE handleApprove runs (setTimeout / manual click / pending-confirm), so the
  // decision-review record can only learn "this answered a staff question" through
  // this context. All four approve paths (auto, bucket-A, manual, high_impact
  // confirm) receive the same execCtx, so the correlation survives every route.
  type ExecContext = { channel: Channel; threadId?: string; requestId?: string; escalateId?: string };
  const responseExecCtxRef = useRef<ExecContext | null>(null);
  // Tracks the latest valid requestId — approve buttons capture a snapshot of execCtx at
  // render time and pass it in; handleApprove compares against this ref to reject stale approvals.
  const latestRequestIdRef = useRef<string | null>(null);

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

  // Auto-scroll to bottom on new messages
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [displayMessages.length]);

  // 动画R2 步 2：呼叫行是渲染态插进流末尾的，displayMessages.length 不变 →
  // 上面那个滚底 effect 不会为它触发，长会话里行会落在视野外。复用同一句滚底，
  // 不用 scrollIntoView（它会连带滚动祖先容器，嵌入态在 HUD 里有位移风险）。
  useEffect(() => {
    if (pttStatus === "listening" && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [pttStatus]);

  // P2: poll canCreateSquad every 200ms
  const [squadBtnEnabled, setSquadBtnEnabled] = useState(false);
  useEffect(() => {
    if (!canCreateSquad) return;
    const id = setInterval(() => setSquadBtnEnabled(canCreateSquad()), 200);
    return () => clearInterval(id);
  }, [canCreateSquad]);

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
    }, 200);
    return () => clearInterval(id);
  }, [getState, response]);

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

  // ── Phase 3: handle approving a staff thread option ──
  const handleThreadApprove = (thread: StaffThread, opt: AdvisorOption, idx: number) => {
    if (thread.status !== "open") return;
    if (!tryLockThread(thread.id)) return;

    try {
      const state = getState();
      if (!state) return;

      const letter = ["A", "B", "C"][idx] ?? "?";
      const cleanLabel = opt.label.replace(/^[ABC]:\s*/, '');
      const intents = opt.intents ?? [opt.intent];

      for (const intent of intents) {
        // Soft-fix: clear invalid fromSquad so engine auto-selects units
        if (intent.fromSquad) {
          const fs = intent.fromSquad.toLowerCase();
          const isSquad = state.squads?.some(s => s.id === intent.fromSquad || s.leaderName?.toLowerCase() === fs);
          const isCommander = COMMANDERS.some(c => c === fs || COMMANDER_META[c].label.includes(intent.fromSquad!));
          if (!isSquad && !isCommander) {
            addMessage("warning", `分队 ${intent.fromSquad} 不存在，将自动分配单位`, state.time, thread.channel, undefined, "command_ack");
            intent.fromSquad = undefined;
          }
        }

        // Soft-fix: clear hallucinated target fields (e.g. LLM invents a non-existent
        // tag/front/facility). Other valid fields in the same intent still drive execution.
        softFixTargetFields(intent, state, (field, value) => {
          addMessage("warning", `目标 ${field}=${value} 不存在，已忽略此字段`, state.time, thread.channel, undefined, "command_ack");
        });

        if (!isValidTarget(intent, state, COMMANDER_REFS)) {
          const field = intent.targetFacility || intent.toFront || intent.fromFront || intent.targetRegion || "unknown";
          addMessage("warning", `目标 ${field} 不存在`, state.time, thread.channel, undefined, "command_ack");
          return;
        }
      }

      const allOrders: ReturnType<typeof resolveIntent>["orders"] = [];
      const reserved = new Set<number>();

      for (const intent of intents) {
        const result = resolveIntent(intent, state, state.style, reserved);
        if (result.degraded) {
          addMessage("warning", result.log, state.time, thread.channel, undefined, "command_ack");
        } else {
          addMessage("info", `执行: ${result.log}`, state.time, thread.channel, undefined, "command_ack");
        }
        for (const id of result.assignedUnitIds) reserved.add(id);
        allOrders.push(...result.orders);
      }

      if (allOrders.length > 0) {
        addMessage("info", `Roger. Executing ${letter}: ${cleanLabel}`, state.time, thread.channel, undefined, "command_ack");
        applyOrders(state, allOrders);
        resolveThread(thread.id);
      }
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

      if (data.error) {
        addMessage("urgent", data.error, state.time, "combat", "chen", "command_ack", true);
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
          const ch = COMMANDER_CHANNEL[commander];
          pushContext(channelContextRef.current, ch, { role: "assistant", text: r.brief, time: state.time });
          addMessage("info", r.brief, state.time, ch, commander, "command_ack", true);
        }, cumulativeDelay);
      }

      // ALL channel is discussion-only — no options/execution handling

    } catch {
      addMessage("urgent", "全体指令通信中断", state.time, "combat", "chen", "system", true);
    }
  };

  // ── sendCommand (0.4: migrated from CommandPanel) ──
  // 语音输入 V1：带 voice 时这一轮的"长官说了什么"要等陈把 heard 交回来才知道
  // ——所有读文本的地方都推迟到 processAdvisorData 里结算（见那儿的语音结算块）。
  const sendCommand = async (voice?: VoiceRecording) => {
    const state = getState();
    if (state) syncGameEpoch(state); // synchronous — closes the poll race before the fast path
    if (!state || (!voice && !message.trim())) return;

    const isVoiceTurn = !!voice;
    const userMsg = voice ? "" : message.trim();
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
    const pendingNow = pendingContractRef.current;
    if (pendingNow) {
      if (pendingNow.epoch !== gameEpochRef.current) {
        pendingContractRef.current = null; // old-battle contract — dead on arrival
      } else if (state.time > pendingNow.expiresAt) {
        pendingContractRef.current = null; // expired — plain cleanup, no consumption
      } else if (pendingNow.channel === ch && pendingNow.phase === "awaiting_reply") {
        if (isConfirmReply(userMsg)) {
          pendingContractRef.current = null;
          handleApprove(pendingNow.opt, 0, "auto", pendingNow.execCtx, pendingNow.data);
          setLoading(false);
          return;
        }
        if (isCancelReply(userMsg)) {
          pendingContractRef.current = null;
          addMessage("info", "行，那就不动。", state.time, ch, undefined, "command_ack");
          setLoading(false);
          return;
        }
        // word-list miss → contract STAYS; the semantic pass below owns it.
      }
      // voicing phase / off-channel: no consumption of any kind here.
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
    const pcAtSend = pendingContractRef.current;
    const pendingTag: PendingRequestTag | null =
      pcAtSend && pcAtSend.channel === ch && pcAtSend.phase === "awaiting_reply" && state.time <= pcAtSend.expiresAt
        ? { pendingId: pcAtSend.id, channel: ch, sessionId: SESSION_ID }
        : null;
    const pendingContext = pendingTag && pcAtSend
      ? `\n---PENDING_CONTRACT---\n待确认命令(id=${pcAtSend.id}): ${pcAtSend.summary}\n指挥官下面这句话可能是对这份待确认命令的答复。`
      : "";
    // Step C: dialogue focus (---ACTIVE_ESCALATION---) and camera focus
    // (---PLAYER_VIEW---) ride the envelope SIDE BY SIDE — the model judges
    // which one the player's words attach to; the engine classifies nothing.
    const playerViewContext = buildPlayerViewContext(state, baseDigest, getViewport?.() ?? null, cmdSelectedIds);
    const digest = baseDigest + contextSuffix + threadContext + escalationContext + playerViewContext + pendingContext;
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
      const sayToEar = (prose: string) => {
        const plan = planVoiceSpeech({
          voiceTurn: isVoiceTurn,
          spoken: typeof data?.spoken === "string" ? data.spoken : undefined,
          prose,
          heard,   // 引擎闸的尺：要念的那段若整句复读它，就不许念
        });
        if (isVoiceTurn && ttsEnabled && plan.finalUtterance) {
          speak(plan.finalUtterance, ttsPersona);
          flush(ttsPersona); // 非流兜底路后面没有 flush，末句不许卡在句子缓冲里
        }
        return plan;
      };

      // ── 地基二: pending semantic consumption, judged BEFORE anything else.
      // The verdict maps through pendingVerdictRoute — the ONE bench-testable
      // table of what may execute. stale (wrong id / cross-channel / expired /
      // duplicate delivery such as a stream that errored after processing and
      // re-entered via the fallback path) is fully fail-closed: no old
      // contract, no new options, no doctrine (Codex step2-fix). Error
      // responses never consume — the contract survives them.
      if (!data.error) {
        const pcNow = pendingContractRef.current;
        // Restart guard: an old-battle contract is presented to the judge as
        // nonexistent (→ stale → fully inert) and dropped on the spot.
        if (pcNow && pcNow.epoch !== gameEpochRef.current) {
          pendingContractRef.current = null;
        }
        const pcSameEpoch = pcNow && pcNow.epoch === gameEpochRef.current ? pcNow : null;
        const verdict = judgePendingConsumption({
          requestTag: pendingTag,
          current: pcSameEpoch
            ? { id: pcSameEpoch.id, channel: pcSameEpoch.channel, sessionId: pcSameEpoch.sessionId, phase: pcSameEpoch.phase, expiresAt: pcSameEpoch.expiresAt }
            : null,
          now: state.time,
          decision: parsePendingDecision((data as Record<string, unknown>).pendingDecision),
        });
        const route = pendingVerdictRoute(verdict);

        // Contract lifecycle per verdict. Expiry cleanup may ONLY clear the
        // very contract this request was tagged with — never a newer one that
        // was registered while this response was in flight.
        if (verdict === "authorize" || verdict === "cancel" || verdict === "amend") {
          pendingContractRef.current = null;
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
          const fallbackLine =
            verdict === "authorize" ? "依令行事。"
            : verdict === "cancel" ? "行，那就不动。"
            : "……(指令未定，请再说一遍)"; // protocol_failure
          const line = (data.brief as string) || fallbackLine;
          addMessage(verdict === "protocol_failure" ? "warning" : "info", line, state.time, ch, undefined, "command_ack");
          pushContext(channelContextRef.current, ch, { role: "assistant", text: line, time: state.time });
          // 语音说「可以」批准就走这条路：耳朵拿到的是 spoken，缺席则是这句判词。
          const decisionPlan = sayToEar(line);
          if (route.executeOldContract && pcSameEpoch) {
            handleApprove(pcSameEpoch.opt, 0, "auto", pcSameEpoch.execCtx, pcSameEpoch.data, decisionPlan.speakExecReceipt);
          }
          return;
        }
        // amend / unrelated / no_pending → normal flow below (amend's old
        // contract is already cleared: ONLY the new intents may execute).
      }
      // 其余全部分支（error / NOOP / 空 options / 正常命令）合用这一处：它们
      // 屏上显示的都是 data.brief（或它为空时各自的兜底行），所以耳朵听的也是它。
      const speechPlan = sayToEar((data.brief as string) || "");
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
        addMessage("info", msg, state.time, ch, undefined, "command_ack");
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
            addMessage("info", data.brief as string, state.time, ch, undefined, "command_ack");
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
        if (data.brief) {
          pushContext(channelContextRef.current, ch, { role: "assistant", text: data.brief as string, time: state.time });
        }

        const gate: { auto: boolean; reason?: string; playerNamedSquad?: boolean } =
          (Array.isArray(data.options) && data.options.length >= 1)
          // ④ 语音回合喂 heard——闸靠正则在长官的话里找锚（番号/领队名/「选中」），
          //   没有文本它会把每一句都当成"长官没点名"。
          ? canAutoExecute((data.options as AdvisorOption[])[0], isVoiceTurn ? heard : userMsg, state, [], isGroupChat, COMMANDER_REFS)
          : { auto: false };

        const requestId = crypto.randomUUID();
        const execCtx: ExecContext = { channel: ch, threadId: activeThreadOnChannel?.id, requestId, escalateId };
        latestRequestIdRef.current = requestId;

        if (gate.auto && (data.options as AdvisorOption[]).length >= 1) {
          const autoData = data as DisplayResponse;
          setTimeout(() => handleApprove(autoData.options[0], 0, "auto", execCtx, autoData, speechPlan.speakExecReceipt), 0);
        } else {
          const reason = gate.reason;
          const opt0 = Array.isArray(data.options) ? (data.options as AdvisorOption[])[0] : undefined;
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
          const staleRefs = detectStaleSquadRefs(data.options as AdvisorOption[] | undefined, state, COMMANDER_REFS);

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
          const bucket = decideBucket({
            gate,
            hasOption: opt0 != null,
            staleRefCount: staleRefs.length,
            voiceTurn: isVoiceTurn,
            heardPresent: heard.length > 0,
          });

          // `&& opt0` 只为让 TS 收窄类型——decideBucket 判到 "A" 时 hasOption 必为真，
          // 语义上是重复的，不是第二道判定。
          if (bucket === "A" && opt0) {
            setClarification(null);
            setTimeout(() => handleApprove(opt0, 0, "auto", execCtx, data as DisplayResponse, speechPlan.speakExecReceipt), 0);
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
              pendingContractRef.current = {
                id: makePendingId(),
                phase: "voicing",
                channel: ch,
                sessionId: SESSION_ID,
                epoch: gameEpochRef.current,
                createdAt: state.time,
                expiresAt: state.time + HIGH_IMPACT_CONFIRM_WINDOW_SEC,
                opt: opt0,
                data: data as DisplayResponse,
                execCtx,
                summary: `${opt0.label} — ${opt0.description}`,
              };
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
                addMessage("warning", line, sNow.time, ch, undefined, "command_ack");
                pushContext(channelContextRef.current, ch, { role: "assistant", text: line, time: sNow.time });
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
              const q = buildGateQuestion(reason, (data.brief as string) || "", staleRefs);
              // Voice-polish v1 (Codex-approved): the question renders ONCE as a
              // chat bubble — no parallel clarification banner with the same
              // text. pushContext + the pending contract above stay unchanged.
              setClarification(null);
              addMessage("warning", q, state.time, ch, undefined, "command_ack");
              pushContext(channelContextRef.current, ch, { role: "assistant", text: q, time: state.time });
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
    try {
      const streamRes = await fetch(`${API_URL}/api/command-stream`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ digest, message: llmMessage, styleNote, channel: ch, sessionId: SESSION_ID, escalateId, audio: voice ? { data: voice.data, format: voice.format } : undefined, voiceDiag: voice ? getVoiceOpenDiag() ?? undefined : undefined, speechDiag: speechDiagRef.current ?? undefined }),
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
              if (ttsEnabled && sendPlan.speakProseWhileStreaming) speak(event.content, ttsPersona);
            } else if (event.type === "options") {
              gotOptions = true;
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
      const isStreamFailure = streamErr instanceof Error &&
        (streamErr.message === "stream_unavailable" || streamErr.message === "stream_no_options");

      if (isStreamFailure) {
        console.debug("[Streaming] falling back to /api/command");
      }

      try {
        const res = await fetch(`${API_URL}/api/command`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ digest, message: llmMessage, styleNote, channel: ch, sessionId: SESSION_ID, escalateId, audio: voice ? { data: voice.data, format: voice.format } : undefined, voiceDiag: voice ? getVoiceOpenDiag() ?? undefined : undefined, speechDiag: speechDiagRef.current ?? undefined }),
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
  const handleApprove = (opt: AdvisorOption, idx: number, mode: "auto" | "manual" = "manual", ctx?: ExecContext, sourceResponse?: DisplayResponse, speakReceipt: boolean = true) => {
    const state = getState();
    if (!state) return;

    const execCtx = ctx ?? responseExecCtxRef.current;
    const ch = execCtx?.channel ?? getActiveChannel();

    // Validate: reject approve if response has already been cleared (stale click).
    if (mode === "manual" && !response) {
      addMessage("warning", "响应已过期，请重新下令", state.time, ch, undefined, "system");
      return;
    }

    const letter = ["A", "B", "C"][idx] ?? "?";
    const cleanLabel = opt.label.replace(/^[ABC]:\s*/, '');
    const intents = opt.intents ?? [opt.intent];

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

    // 手测账③: who is being spoken to decides what they may move. This is the
    // ENGINE BACKSTOP — the primary fix is the prompt principle (a persona with
    // no forces should never emit a dispatch intent in the first place). By the
    // time we are here the model has already spoken, so this tier is the
    // degraded one: state the structural fact, execute nothing.
    const speakingPersona = COMMANDERS.find((c) => COMMANDER_CHANNEL[c] === ch) ?? COMMANDERS[0];

    for (const intent of intents) {
      const auth = checkDispatchAuthority(state, speakingPersona, intent);
      if (auth.kind === "denied") {
        const who = COMMANDER_META[speakingPersona].label;
        addMessage(
          "warning",
          auth.reason === "commands_no_forces"
            ? `${who}名下没有部队，这道命令未执行——调兵请对带兵的指挥官说。`
            : `那支部队不在${who}麾下，这道命令未执行——请对${COMMANDER_META[auth.ownerOfNamed!].label}下令。`,
          state.time, ch, undefined, "command_ack",
        );
        return;
      }

      // v4 刀2b: a G-number is the ONE legal handle for "那批兵". Resolved
      // before the squad check below, which would otherwise reject it as an
      // unknown squad name. Every non-dispatch outcome is a loud refusal with
      // a spoken reason — never a silent fallback (the soft-fix family).
      const tk = resolveTicketReference(state, intent.fromSquad, state.time);
      if (tk.kind === "refuse") {
        addMessage("warning", tk.line, state.time, ch, undefined, "command_ack");
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
          addMessage("warning", `${spokenNameOf(tk.ticket)} 不在${who}麾下，这道命令未执行——请对带这支部队的指挥官下令。`, state.time, ch, undefined, "command_ack");
          return;
        }
        ticketRosters.set(intent, lawful);
        ticketByIntent.set(intent, tk.ticket);
        // 刀C: NO receipt is written here. It used to be — with lawful.length,
        // before the resolver had run — and that is how a roster of 6 under a
        // quantity=2 order dispatched 2 units and printed "6个单位出发了"
        // (§7⑤). The receipt is settled after resolveIntent, off the real
        // assignedUnitIds, or not printed at all.
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
          addMessage("warning", `找不到叫「${intent.fromSquad}」的分队，命令未执行——请用编制里的编号或队长名字重新下令`, state.time, ch, undefined, "command_ack");
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
        addMessage("warning", `目标 ${field} 不存在`, state.time, ch, undefined, "command_ack");
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
          addMessage("warning", verdict.line, state.time, ch, undefined, "command_ack");
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
    const settled: { ticket: EscalationTicket; dispatched: number; mode: "moved" | "in_place" }[] = [];
    for (const intent of intents) {
      // v4 刀2b: a ticket's frozen roster wins over the box-select snapshot —
      // the player approved THAT batch, not whatever is currently framed.
      const result = resolveIntent(
        intent, state, state.style, reserved,
        ticketRosters.get(intent) ?? selectedIdsSnapshotRef.current,
      );
      if (result.degraded) {
        degradedCount++;
        addMessage("warning", result.log, state.time, ch, undefined, "command_ack");
      } else {
        addMessage("info", `执行: ${result.log}`, state.time, ch, undefined, "command_ack");
      }
      const boundTicket = ticketByIntent.get(intent);
      if (boundTicket && result.orders.length > 0) {
        settled.push({
          ticket: boundTicket,
          dispatched: result.assignedUnitIds.length,
          mode: ticketReceiptMode.get(intent) ?? "moved",
        });
      }
      for (const id of result.assignedUnitIds) reserved.add(id);
      allAssignedUnitIds.push(...result.assignedUnitIds);
      allOrders.push(...result.orders);
    }

    if (allOrders.length === 0 && degradedCount > 0) {
      addMessage("warning", "命令无法执行，请重新描述", state.time, ch, undefined, "command_ack");
      setClarification("命令不明确，请重述（示例：'北线全部坦克进攻桥头'）");
      setApprovedIdx(idx);
      setTimeout(() => setApprovedIdx(null), 400);
      return;
    }

    if (allOrders.length > 0) {
      // Pick personality-appropriate voice confirmation
      const approveCommander = COMMANDERS.find(c => COMMANDER_CHANNEL[c] === ch) ?? COMMANDERS[0];
      const voiceConfirm = pickVoiceConfirm(approveCommander);
      if (mode === "auto") {
        addMessage("info", `${voiceConfirm} ${cleanLabel}`, state.time, ch, undefined, "command_ack");
      } else {
        addMessage("info", `${voiceConfirm} Executing ${letter}: ${cleanLabel}`, state.time, ch, undefined, "command_ack");
      }
      // TTS readback of confirmation (its own short stream — speak()
      // detects persona switch from any prior stream and cancels cleanly).
      // spoken 层 R2：spoken 在场的语音回合里这一声并进 spoken 了（见
      // voiceSpeech.ts 的序列注释）——屏上那行照写，只是不再念第三遍。
      if (ttsEnabled && speakReceipt) {
        speak(voiceConfirm, approveCommander);
      }
      // H1 (§8 手测 03:15): read BEFORE applyOrders — that call overwrites
      // state/orders, after which every unit looks equally busy on the NEW
      // task and "what did we tear them off" is unrecoverable. Judgment is in
      // core; this layer only prints the verdict.
      const committedPull = describeCommittedPull(state, allAssignedUnitIds);

      const diagsBefore = new Set(state.diagnostics);
      applyOrders(state, allOrders);

      // v4 刀2b: burn AFTER the orders are actually applied — a ticket that
      // failed to produce orders must stay usable. One-shot from here on: the
      // same proposal can never dispatch twice.
      //
      // 刀C (§8 ⑤): burn and receipt are now PER TICKET and settled from that
      // intent's own result. A ticket whose order produced nothing is neither
      // burned nor receipted — it was never spent. The number in the receipt is
      // the number the resolver actually assigned, so quantity limits, terrain
      // skips and casualties are all reconciled out loud rather than assumed.
      for (const s of settled) {
        burnEscalationTicket(s.ticket.gNumber);
        addMessage(
          "info", ticketDispatchReceipt(s.ticket, s.dispatched, s.mode),
          state.time, ch, undefined, "command_ack",
        );
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
        const spent = settled.map((s) => s.ticket.gNumber);
        state.diagnostics.push({
          time: state.time,
          code: "V4_BARE_CONFIRM_EXEC",
          message: `escalateId=${bce.escalateId ?? "none"} viaTicket=${spent.length > 0}` +
            `${spent.length > 0 ? ` tickets=${spent.join(",")}` : ""}` +
            ` dispatched=${allAssignedUnitIds.length} target=${targets}`,
        });
      }

      // Surface economy failures (produce/trade) the engine recorded as
      // diagnostics during this apply — otherwise insufficient money/fuel/stock
      // stays silent. Affordability is the engine's decision; the frontend only
      // voices it. Object-identity diff is robust to the 50-entry ring buffer.
      for (const d of state.diagnostics) {
        if (diagsBefore.has(d)) continue;
        if (d.code === "PRODUCE_FAIL" || d.code === "TRADE_FAIL") {
          addMessage("warning", d.message, state.time, ch, undefined, "command_ack");
        }
      }

      // Process doctrine fields at approve time (not at response time)
      const docSource = sourceResponse ?? response;
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
      // ONLY this main command path records. handleThreadApprove (the OTHER
      // applyOrders call site, dormant since 6a), right-click manual orders and
      // produce/trade are deliberately NOT recorded (deferred — see decisionReview.ts).
      // The engine gates recording (battlefield anchor + unit floor) and later
      // decides whether/who reviews; nothing here executes or voices anything.
      // assignedUnitIds are resolveIntent's picks filtered to living units
      // ("resolved assigned units") — applyOrders returns void, so this is NOT a
      // claim about what was finally applied.
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
      if (response && letter !== response.recommended) {
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
        {pttStatus === "listening" && <RadioCallRow />}

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
                    onChange={(e) => setMessage(e.target.value)}
                    onKeyDown={handleKeyDown}
                    placeholder={isGroupChat ? "全体通信（仅讨论，不可下令）..." : `对${COMMANDER_META[selectedCommanders[0]].label}下令...`}
                    disabled={loading}
                  />
                  <button
                    data-ptt-btn
                    className="dp-dock-btn dp-dock-btn--ptt-main"
                    onPointerDown={(e) => { e.preventDefault(); startPTT(); }}
                    onPointerUp={stopPTT}
                    onPointerCancel={stopPTT}
                    onPointerLeave={() => { if (pttStatus === "listening") stopPTT(); }}
                    disabled={pttStatus === "unsupported" || loading}
                    style={{
                      background: pttStatus === "listening" ? "var(--hud-accent-red)" : pttStatus === "error" ? "rgba(127, 29, 29, 0.8)" : undefined,
                      opacity: pttStatus === "unsupported" || loading ? 0.35 : 1,
                    }}
                    title={
                      pttStatus === "unsupported" ? "浏览器不支持语音识别"
                      : pttStatus === "error" ? "麦克风权限被拒绝，请在浏览器设置中允许"
                      : pttStatus === "listening" ? "松开结束录音并发送"
                      : "按住说话"
                    }
                  >{pttStatus === "listening" ? "🔴" : "🎤"}</button>
                  {hasTTS && (
                    <button
                      className="dp-dock-btn dp-dock-btn--ptt"
                      onClick={() => { setTtsEnabled(e => !e); if (ttsEnabled) cancel(); }}
                      style={{ background: ttsEnabled ? "rgba(0, 212, 255, 0.2)" : undefined }}
                      title={ttsEnabled ? "关闭语音朗读" : "开启语音朗读（参谋回复会被读出来）"}
                    >{ttsEnabled ? "🔊" : "🔇"}</button>
                  )}
                  {onCreateSquad && isChenChannel && (
                    <button
                      className="dp-dock-btn dp-dock-btn--action"
                      onClick={() => onCreateSquad(selectedCommanders[0])}
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

          {/* RIGHT COLUMN: Org Tree */}
          <div className="dp-col-right">
            <div className="dp-section-header" style={{ padding: "0 0 6px 0" }}>BATTLEGROUP ORG TREE</div>
            <div className="dp-org-container">
              {st ? (
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
    <div style={embeddedPanelStyle}>
      {/* ── Top: Commander selection bar ── */}
      <div style={commanderBarStyle}>
        {COMMANDERS.map((cmd) => {
          const meta = COMMANDER_META[cmd];
          const isSelected = selectedCommanders.includes(cmd);
          const cmdColor = FROM_COLORS[cmd];
          return (
            <button
              key={cmd}
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

      {/* ── Tab switcher: Chat / Org ── */}
      <div style={tabBarStyle}>
          <button
            onClick={() => setActiveTab("chat")}
            style={{
              ...tabBtnStyle,
              borderBottomColor: activeTab === "chat" ? "var(--hud-accent-cyan)" : "transparent",
              color: activeTab === "chat" ? "var(--hud-accent-cyan)" : "var(--hud-text-secondary)",
            }}
          >
            通讯 ☎
          </button>
          <button
            onClick={() => setActiveTab("org")}
            style={{
              ...tabBtnStyle,
              borderBottomColor: activeTab === "org" ? "var(--hud-accent-cyan)" : "transparent",
              color: activeTab === "org" ? "var(--hud-accent-cyan)" : "var(--hud-text-secondary)",
            }}
          >
            编制 ☰
          </button>
        </div>

      {/* ── Content area ── */}
      <div style={{ display: "flex", flex: 1, flexDirection: "column" as const, overflow: "hidden" }}>
      <div style={{ display: "flex", flexDirection: "column" as const, flex: 1, overflow: "hidden" }}>

      {activeTab === "org" ? (
        (() => {
          const st = getState();
          if (!st) return <div style={{ flex: 1, color: "var(--hud-text-dim)", textAlign: "center", padding: 20 }}>加载中...</div>;
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
        <input ref={inputRef} type="text" value={message} onChange={(e) => setMessage(e.target.value)} onKeyDown={handleKeyDown} placeholder={isGroupChat ? "全体通信（仅讨论，不可下令）..." : `对${COMMANDER_META[selectedCommanders[0]].label}下令...`} disabled={loading} style={inputStyle} />
        <button data-ptt-btn onPointerDown={(e) => { e.preventDefault(); startPTT(); }} onPointerUp={stopPTT} onPointerCancel={stopPTT} onPointerLeave={() => { if (pttStatus === "listening") stopPTT(); }} disabled={pttStatus === "unsupported" || loading} style={{ ...pttBtnStyle, ...pttBigStyle, background: pttStatus === "listening" ? "var(--hud-accent-red)" : pttStatus === "error" ? "rgba(127, 29, 29, 0.8)" : undefined, opacity: pttStatus === "unsupported" || loading ? 0.35 : 1, cursor: pttStatus === "unsupported" || loading ? "default" : "pointer" }} title={pttStatus === "unsupported" ? "浏览器不支持语音识别" : pttStatus === "error" ? "麦克风权限被拒绝" : pttStatus === "listening" ? "松开结束录音并发送" : "按住说话"}>{pttStatus === "listening" ? "🔴" : "🎤"}</button>
        {hasTTS && (<button onClick={() => { setTtsEnabled(e => !e); if (ttsEnabled) cancel(); }} style={{ ...pttBtnStyle, background: ttsEnabled ? "rgba(0, 212, 255, 0.2)" : undefined, opacity: 1, cursor: "pointer", fontSize: 14 }} title={ttsEnabled ? "关闭语音朗读" : "开启语音朗读（参谋回复会被读出来）"}>{ttsEnabled ? "🔊" : "🔇"}</button>)}
        {onCreateSquad && isChenChannel && (<button onClick={() => onCreateSquad(selectedCommanders[0])} disabled={!squadBtnEnabled} style={{ ...actionBtnStyle, opacity: squadBtnEnabled ? 1 : 0.35, cursor: squadBtnEnabled ? "pointer" : "default" }} title={squadBtnEnabled ? "将选中单位编为分队" : "请先框选未编队的单位"}>编队</button>)}
        {onDeclareWar && canDeclareWar && (<button onClick={onDeclareWar} style={warBtnStyle} title="向敌方宣战">宣战</button>)}
        <button data-send-btn onClick={() => void sendCommand()} disabled={loading || !message.trim()} style={{ ...sendBtnStyle, opacity: loading || !message.trim() ? 0.5 : 1 }}>{loading ? "..." : "发送"}</button>
      </div>
      </div>
      </div>
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
