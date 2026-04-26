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
import { resolveIntent, applyOrders, updateStyleParam, findFront, enqueueProduction, cancelDoctrine } from "@ai-commander/core";
import type { GameState, AdvisorResponse, AdvisorOption, Intent, Channel, CommanderMemory, TaskCard, TaskPriority } from "@ai-commander/shared";
import { buildDigestForChannel } from "./digestHelper";
import type { StandingOrder, StandingOrderType, DoctrinePriority } from "@ai-commander/shared";
import { CHANNEL_LABELS, collectUnitsUnder } from "@ai-commander/shared";
import {
  addMessage,
  getActiveChannel,
  setActiveChannel,
  getGroupChatMessages,
  getMessagesByChannel,
  getActiveThreads,
  resolveThread,
  dismissThread,
  subscribe,
  CHANNEL_PERSONA,
  type FeedMessage,
  type MessageLevel,
  type MessageFrom,
  type StaffThread,
} from "./messageStore";

const API_URL = "http://localhost:3001";

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

/** Check if a string matches any known location: front, tag, region, or facility. */
function isKnownLocation(val: string, state: GameState): boolean {
  if (findFront(state, val)) return true;
  if (state.tags?.some(t => t.id === val)) return true;
  if (state.regions.has(val)) return true;
  const lower = val.toLowerCase();
  for (const [, r] of state.regions) {
    if (r.id.toLowerCase().includes(lower) || r.name.toLowerCase().includes(lower)) return true;
  }
  for (const [, f] of state.facilities) {
    if (f.id.toLowerCase() === lower || f.name.toLowerCase().includes(lower)) return true;
  }
  return false;
}

function isValidTarget(intent: Intent, state: GameState): boolean {
  if (intent.targetRegion && !isKnownLocation(intent.targetRegion, state)) return false;
  if (intent.targetFacility) {
    // Guard: empty string would match everything via includes("")
    const trimmed = intent.targetFacility.trim();
    if (trimmed.length === 0) return false;
    // Fuzzy match: accept facility ID, name, or tag (not just strict ID).
    // This lets LLM output like "El Alamein" match facility ea_alamein_town.
    const hint = trimmed.toLowerCase();
    let found = state.facilities.has(intent.targetFacility);
    if (!found) {
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
    if (!found) return false;
  }
  if (intent.toFront && !isKnownLocation(intent.toFront, state)) return false;
  if (intent.fromFront && !isKnownLocation(intent.fromFront, state)) return false;
  if (intent.fromSquad) {
    const fs = intent.fromSquad.toLowerCase();
    const isSquad = state.squads?.some(s => s.id === intent.fromSquad || s.leaderName?.toLowerCase() === fs);
    const isCommander = COMMANDERS.some(c => c === fs || COMMANDER_META[c].label.includes(intent.fromSquad!));
    if (!isSquad && !isCommander) return false;
  }
  return true;
}

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

/**
 * LLM responses can reference squads that died while the request was in flight
 * (the digest sent ~5-10s ago named them alive; by the time the response comes
 * back, they're KIA). The engine-layer soft-fix in handleApprove catches this
 * when the player approves the option, but the advisor's *spoken* brief is
 * already on screen saying things like "长官，Aiden 带兵撤回总部…" — a false
 * narrative about a dead squad.
 *
 * This returns the list of fromSquad references in the response that no longer
 * resolve to a living squad (or a commander key). Caller can surface a warning
 * after the brief so the player immediately sees that the response is stale
 * without tearing down the streaming brief itself.
 */
function detectStaleSquadRefs(
  options: AdvisorOption[] | undefined,
  state: GameState,
): string[] {
  if (!options || options.length === 0) return [];
  const opt = options[0];
  const intents = opt.intents ?? (opt.intent ? [opt.intent] : []);
  const stale = new Set<string>();
  for (const intent of intents) {
    if (!intent?.fromSquad) continue;
    const fs = intent.fromSquad.toLowerCase();

    // Commander key → always treat as alive (aggregates many squads;
    // we don't flag it stale unless the player specifically named a dead one)
    if (COMMANDERS.some(c => c === fs || COMMANDER_META[c].label.includes(intent.fromSquad!))) {
      continue;
    }

    // Leader-name or squad-ID → find the squad entity
    const squad = state.squads?.find(s =>
      s.id === intent.fromSquad || s.leaderName?.toLowerCase() === fs,
    );
    if (!squad) {
      // Entity doesn't exist at all — clearly stale
      stale.add(intent.fromSquad);
      continue;
    }

    // Entity exists, but it may be "KIA-but-lingering": the squad shell
    // persists in state.squads while all its units are dead. resolveSourceUnits
    // rejects this downstream with "分队 X 无可用单位", but by that point the
    // player has already read the advisor brief claiming the squad will do
    // things. Treat any squad with zero living dispatchable units as stale.
    const unitIds = collectUnitsUnder(state, squad.id);
    const hasLiving = unitIds.some(id => {
      const u = state.units.get(id);
      return u && u.state !== "dead" && u.hp > 0;
    });
    if (!hasLiving) stale.add(intent.fromSquad);
  }
  return [...stale];
}

// ── Phase 1: Deterministic auto-execute gate (from CommandPanel) ──

function canAutoExecute(
  option: AdvisorOption,
  userMessage: string,
  state: GameState,
  selectedIds?: readonly number[],
  isGroupChat?: boolean,
): { auto: boolean; reason?: string } {
  // Group chat forces manual approval
  if (isGroupChat) return { auto: false, reason: "group_chat" };

  const intents = option.intents ?? [option.intent];
  if (intents.length === 0) return { auto: false, reason: "no_intents" };

  // Parse user text for anchors: squad IDs (T3, I1, ...) and selected-units keywords
  const squadIdsInText = new Set(
    (userMessage.match(/\b[TIANF]\d+\b/gi) ?? []).map(s => s.toUpperCase()),
  );
  const hasSelectedKeyword =
    /\bselected\b/i.test(userMessage) || /选中|圈起来|这队|这支/.test(userMessage);

  // Collect anchor names (active squad leaders + commander keys) present in the user's text.
  // ASCII names use \b word boundary; CJK names fall back to substring match.
  const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const mentionedAnchors = new Set<string>();
  const anchorCandidates: string[] = [];
  for (const sq of state.squads ?? []) {
    if (sq.leaderName) anchorCandidates.push(sq.leaderName);
  }
  for (const c of ["chen", "marcus", "emily"]) anchorCandidates.push(c);
  for (const name of anchorCandidates) {
    const lower = name.toLowerCase();
    const isAscii = /^[\x00-\x7f]+$/.test(name);
    const pattern = isAscii ? `\\b${escapeRegex(name)}\\b` : escapeRegex(name);
    if (new RegExp(pattern, "i").test(userMessage)) mentionedAnchors.add(lower);
  }

  // Validate each intent independently — multi-intent is fine as long as every
  // intent clears the same safety bar a single intent would.
  for (const intent of intents) {
    if (!isValidTarget(intent, state)) return { auto: false, reason: "invalid_intent_fields" };

    // high_impact only fires when the intent has NO explicit scope (no fromSquad).
    // With fromSquad set (squad ID / leader name / commander key), resolveIntent
    // restricts "all" to units under that squad/commander — not global conscription,
    // so it's safe to auto-execute. Unscoped "all" IS a global draft → force confirm.
    const qty = intent.quantity;
    const isHighImpact = !intent.fromSquad &&
      (qty === "all" || qty === "most") &&
      (intent.type === "attack" || intent.type === "sabotage");
    if (isHighImpact) return { auto: false, reason: "high_impact" };

    if (intent.fromSquad) {
      const fs = intent.fromSquad.toLowerCase();
      const isSquadId = /^[A-Z]\d+$/i.test(intent.fromSquad);
      const squad = state.squads?.find(s =>
        s.id === intent.fromSquad || s.leaderName?.toLowerCase() === fs,
      );

      // Accept anchor if user's text mentions this intent's source in any form:
      // the exact squad ID, the intent's leaderName/commander, or (if fromSquad is
      // a squad ID) the squad's leaderName. Covers "Aiden去..." (leader name) and
      // "T3 attack" (squad ID) and LLM-translated cross-refs between them.
      let anchored = false;
      if (isSquadId && squadIdsInText.has(intent.fromSquad.toUpperCase())) anchored = true;
      if (!anchored && mentionedAnchors.has(fs)) anchored = true;
      if (!anchored && squad) {
        if (squad.id && squadIdsInText.has(squad.id.toUpperCase())) anchored = true;
        if (squad.leaderName && mentionedAnchors.has(squad.leaderName.toLowerCase())) anchored = true;
      }
      if (!anchored) return { auto: false, reason: "anchor_mismatch" };

      if (squad && squad.currentMission !== null) {
        return { auto: false, reason: "mission_conflict" };
      }
    } else {
      // No fromSquad — auto only if player has selected units AND used a selected keyword
      if (!hasSelectedKeyword) return { auto: false, reason: "no_anchor" };
      if (!selectedIds || selectedIds.length === 0) return { auto: false, reason: "no_selected_units" };
    }
  }

  return { auto: true };
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

// ── Props ──

interface Props {
  getState: () => GameState | null;
  getSelectedUnitIds?: () => number[];
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


export function ChatPanel({ getState, getSelectedUnitIds, onCreateSquad, canCreateSquad, onDeclareWar, onSelectUnits, onMoveSquad, onRemoveFromParent, onRenameLeader, onTransferSquad, isDetached }: Props) {
  // ── Panel collapse state ──
  const [collapsed, setCollapsed] = useState(false);

  // ── Tab state: "chat" or "org" ──
  const [activeTab, setActiveTab] = useState<"chat" | "org">("chat");

  // ── Commander selection state ──
  const [selectedCommanders, setSelectedCommanders] = useState<Commander[]>(["marcus"]);
  const isGroupChat = selectedCommanders.length > 1;

  // ── Message display state ──
  const [displayMessages, setDisplayMessages] = useState<readonly FeedMessage[]>([]);
  const scrollRef = useRef<HTMLDivElement>(null);

  // ── Command/response state ──
  const [message, setMessage] = useState("");
  const [loading, setLoading] = useState(false);
  const [response, setResponse] = useState<DisplayResponse | null>(null);
  const pendingGroupResponsesRef = useRef<{ data: DisplayResponse; channel: Channel; requestId: string }[]>([]);
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
  const [pttStatus, setPttStatus] = useState<PTTStatus>(SpeechRecCtor ? "idle" : "unsupported");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const pttRecRef = useRef<any>(null);

  // ── TTS (Text-to-Speech) for streaming readback ──
  const hasTTS = typeof window !== "undefined" && "speechSynthesis" in window;
  const [ttsEnabled, setTtsEnabled] = useState(false);
  const ttsBufferRef = useRef("");        // accumulates streamed text not yet spoken
  const ttsSpokenLenRef = useRef(0);      // how many chars of accumulatedText we already spoke

  const ttsSpeakSentence = useCallback((text: string) => {
    if (!hasTTS || !text.trim()) return;
    const synth = window.speechSynthesis;
    const utt = new SpeechSynthesisUtterance(text.trim());
    utt.lang = "en-US";
    utt.rate = 1.1;
    synth.speak(utt);
  }, [hasTTS]);

  /** Feed new accumulated text; extracts complete sentences and queues them for TTS */
  const ttsFeedChunk = useCallback((accumulated: string) => {
    if (!ttsEnabled || !hasTTS) return;
    const newText = accumulated.slice(ttsSpokenLenRef.current);
    if (!newText) return;
    // Split on sentence-ending punctuation, keeping delimiters
    const parts = newText.split(/(?<=[.!?;,\n])\s*/);
    // If last part doesn't end with punctuation, keep it buffered
    const lastPart = parts[parts.length - 1];
    const lastComplete = /[.!?;,\n]$/.test(lastPart);
    const toSpeak = lastComplete ? parts : parts.slice(0, -1);
    const spoken = toSpeak.join(" ");
    if (spoken.trim()) {
      ttsSpeakSentence(spoken);
      ttsSpokenLenRef.current += spoken.length;
    }
  }, [ttsEnabled, hasTTS, ttsSpeakSentence]);

  /** Flush remaining buffered TTS text (call on stream end) */
  const ttsFlush = useCallback((accumulated: string) => {
    if (!ttsEnabled || !hasTTS) return;
    const remaining = accumulated.slice(ttsSpokenLenRef.current);
    if (remaining.trim()) ttsSpeakSentence(remaining);
    ttsSpokenLenRef.current = 0;
  }, [ttsEnabled, hasTTS, ttsSpeakSentence]);

  /** Cancel all queued TTS and reset */
  const ttsCancel = useCallback(() => {
    if (hasTTS) window.speechSynthesis.cancel();
    ttsSpokenLenRef.current = 0;
  }, [hasTTS]);

  const startPTT = useCallback(() => {
    if (!SpeechRecCtor || loading) return;
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
  }, [SpeechRecCtor, loading]);

  const stopPTT = useCallback(() => {
    if (pttRecRef.current) {
      pttRecRef.current.stop();
    }
  }, []);

  // P1: snapshot selected unit IDs at sendCommand time
  const selectedIdsSnapshotRef = useRef<number[] | undefined>(undefined);

  // Fix #2: execution context bound to each response (+ requestId for approve validation)
  type ExecContext = { channel: Channel; threadId?: string; requestId?: string };
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

  // Production button state
  const [playerMoney, setPlayerMoney] = useState(0);
  const [playerQueueLen, setPlayerQueueLen] = useState(0);

  // Poll war declaration eligibility + clear panel on game over + detect restart + production state
  const lastSeenTimeRef = useRef(0);
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

        if (!isValidTarget(intent, state)) {
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
  const processDoctrineFields = (data: Record<string, unknown>, state: GameState, ch: Channel, approvedIntents?: Intent[]) => {
    // Standing order creation
    if (data.standingOrder && typeof data.standingOrder === "object") {
      const so = data.standingOrder as Record<string, unknown>;
      if (typeof so.type === "string" && typeof so.locationTag === "string") {
        const VALID_SO_TYPES: string[] = ["must_hold", "can_trade_space", "preserve_force", "no_retreat", "delay_only"];
        const VALID_PRIORITIES: string[] = ["low", "normal", "high", "critical"];
        const soType = VALID_SO_TYPES.includes(so.type) ? so.type as StandingOrderType : "must_hold";
        const soPriority = (typeof so.priority === "string" && VALID_PRIORITIES.includes(so.priority))
          ? so.priority as DoctrinePriority : "normal";

        // Deduplicate: skip if an active doctrine with same type+location already exists
        const dup = state.doctrines.find(d => d.status === "active" && d.type === soType && d.locationTag === so.locationTag);
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
            locationTag: so.locationTag as string,
            priority: soPriority,
            allowAutoReinforce: typeof so.allowAutoReinforce === "boolean" ? so.allowAutoReinforce : false,
            assignedSquads: squads,
            createdAt: state.time,
            status: "active",
          };
          state.doctrines.push(newDoc);
          const commitDesc = `${soType} @ ${so.locationTag}`;
          pushCommitment(ch, commitDesc);
          addMessage("info", `持续命令已登记: ${commitDesc} [${soPriority.toUpperCase()}]`, state.time, ch, undefined, "command_ack");
        }
      }
    }

    // Doctrine cancellation
    if (typeof data.cancelDoctrine === "string" && data.cancelDoctrine.length > 0) {
      const result = cancelDoctrine(state, data.cancelDoctrine);
      if (result.cancelled) {
        removeCommitment(result.channel, `${result.type} @ ${result.locationTag}`);
        addMessage("info", `${result.locationTag} 的 ${result.type} 命令已取消，部队恢复自由调度。`, state.time, result.channel, undefined, "command_ack");
      }
    }
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

    // Build digest from combat channel (most complete battlefield view)
    const baseDigest = buildDigestForChannel(state, "combat", commanderMemoryRef.current.combat);
    // Compressed cross-channel context so LLM knows what was discussed before
    const groupCtx = formatGroupContext(channelContextRef.current);

    try {
      const res = await fetch(`${API_URL}/api/command-group`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          digest: baseDigest,
          message: userMsg,
          styleNote,
          channelContext: groupCtx,
        }),
      });
      const data = await res.json();

      if (data.error) {
        addMessage("urgent", data.error, state.time, "combat", "chen", "command_ack", true);
        return;
      }

      // Dispatch each persona's brief to their respective channel.
      // Stagger display: shuffle order + 800-2300ms intervals so the war room
      // feels like 3 officers chiming in, not a synchronous bot dump.
      const responses: Array<{ from: string; brief: string }> = data.responses || [];
      const shuffled = [...responses].sort(() => Math.random() - 0.5);
      let cumulativeDelay = 0;
      for (let i = 0; i < shuffled.length; i++) {
        const r = shuffled[i];
        if (i > 0) cumulativeDelay += 800 + Math.random() * 1500;
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
  const sendCommand = async () => {
    const state = getState();
    if (!state || !message.trim()) return;

    const userMsg = message.trim();
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
    addMessage("info", userMsg, state.time, primaryChannel, "player", "player", isGroupChat ? true : undefined);

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

    // Phase 3: thread context
    const activeThreadOnChannel = activeThreads.find(t => t.channel === ch);
    const threadContext = activeThreadOnChannel
      ? `\n---ACTIVE_THREAD---\n[${activeThreadOnChannel.eventType}] ${activeThreadOnChannel.eventMessage}\nStaff brief: ${activeThreadOnChannel.brief}`
      : "";

    commanderMemoryRef.current[ch].playerIntent = userMsg;
    const baseDigest = buildDigestForChannel(state, ch, commanderMemoryRef.current[ch]);
    const contextSuffix = formatContext(channelContextRef.current, ch);
    const digest = baseDigest + contextSuffix + threadContext;
    const styleNote = `risk=${state.style.riskTolerance.toFixed(2)} focus=${state.style.focusFireBias.toFixed(2)} obj=${state.style.objectiveBias.toFixed(2)} cas=${state.style.casualtyAversion.toFixed(2)}`;

    // Append declined context if player is refining a rejected proposal
    let llmMessage = userMsg;
    if (declinedContext) {
      llmMessage += `\n---DECLINED---\n之前的命令和方案：${declinedContext}\n指挥官对以上方案都不满意，请根据补充说明重新制定方案。`;
      setDeclinedContext(null);
    }

    pushContext(channelContextRef.current, ch, { role: "user", text: userMsg, time: state.time });

    // Helper: process a completed AdvisorResponse (shared by streaming & non-streaming paths)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const processAdvisorData = (data: any) => {
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
        if (typeof data.cancelDoctrine === "string" && data.cancelDoctrine.length > 0) {
          processDoctrineFields({ cancelDoctrine: data.cancelDoctrine }, state, ch);
        }
      } else if (Array.isArray(data.options) && data.options.length === 0) {
        setResponse(null);
        setError(null);
        const reason = (data.brief as string) || "命令目标不存在或不明确";
        setClarification(reason + " — 请重新描述指令");
        addMessage("warning", reason, state.time, ch, undefined, "command_ack");
      } else {
        if (data.brief) {
          pushContext(channelContextRef.current, ch, { role: "assistant", text: data.brief as string, time: state.time });
        }

        const gate = (Array.isArray(data.options) && data.options.length >= 1)
          ? canAutoExecute((data.options as AdvisorOption[])[0], userMsg, state, [], isGroupChat)
          : { auto: false };

        const requestId = crypto.randomUUID();
        const execCtx: ExecContext = { channel: ch, threadId: activeThreadOnChannel?.id, requestId };
        latestRequestIdRef.current = requestId;

        if (gate.auto && (data.options as AdvisorOption[]).length >= 1) {
          const autoData = data as DisplayResponse;
          setTimeout(() => handleApprove(autoData.options[0], 0, "auto", execCtx, autoData), 0);
        } else {
          if (!gate.auto && gate.reason) {
            const opt0 = (data.options as AdvisorOption[])[0];
            const intent0 = opt0?.intents?.[0] ?? opt0?.intent;
            console.log(`[P1 gate] no-auto reason=${gate.reason}`, {
              numIntents: opt0?.intents?.length ?? (opt0?.intent ? 1 : 0),
              fromSquad: intent0?.fromSquad,
              quantity: intent0?.quantity,
              type: intent0?.type,
              toFront: intent0?.toFront,
            });
          }
          responseExecCtxRef.current = execCtx;
          setResponse(data as DisplayResponse);
          setError(null);
          // Stale-state post-check: surface a warning when the advisor's brief
          // references squads that died while the LLM request was in flight.
          // The message lands right under the streamed brief so the player sees
          // the dissonance immediately rather than discovering it only on approve.
          const staleRefs = detectStaleSquadRefs(data.options as AdvisorOption[] | undefined, state);
          if (staleRefs.length > 0) {
            addMessage(
              "warning",
              `⚠ 参谋回复引用 ${staleRefs.join(", ")} 已阵亡或不存在，以下方案基于过时战况`,
              state.time, ch, undefined, "command_ack",
            );
          }
          addMessage("info", "参谋简报送达。", state.time, ch, undefined, "command_ack");
        }
      }
    };

    // ── Streaming path (default), with fallback to non-streaming ──
    try {
      const streamRes = await fetch(`${API_URL}/api/command-stream`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ digest, message: llmMessage, styleNote, channel: ch }),
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
      ttsCancel(); // reset TTS for new stream
      ttsSpokenLenRef.current = 0;

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
              ttsFeedChunk(accumulatedText);
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

      // Flush any remaining TTS text
      ttsFlush(accumulatedText);

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
          body: JSON.stringify({ digest, message: llmMessage, styleNote, channel: ch }),
        });
        const data = await res.json();
        processAdvisorData(data);
      } catch {
        const errMsg = "无法连接服务器，请确保后端运行在 localhost:3001";
        setError(errMsg);
        setResponse(null);
        selectedIdsSnapshotRef.current = undefined;
        addMessage("urgent", "通信中断: 无法连接后端", state.time, ch, undefined, "system");
      }
    }
    setLoading(false);
  };

  // ── handleApprove (0.4: migrated from CommandPanel) ──
  const handleApprove = (opt: AdvisorOption, idx: number, mode: "auto" | "manual" = "manual", ctx?: ExecContext, sourceResponse?: DisplayResponse) => {
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

    for (const intent of intents) {
      // Soft-fix: if fromSquad is invalid, clear it so the engine auto-selects units
      if (intent.fromSquad) {
        const fs = intent.fromSquad.toLowerCase();
        const isSquad = state.squads?.some(s => s.id === intent.fromSquad || s.leaderName?.toLowerCase() === fs);
        const isCommander = COMMANDERS.some(c => c === fs || COMMANDER_META[c].label.includes(intent.fromSquad!));
        if (!isSquad && !isCommander) {
          addMessage("warning", `分队 ${intent.fromSquad} 不存在，将自动分配单位`, state.time, ch, undefined, "command_ack");
          intent.fromSquad = undefined;
        }
      }

      // Soft-fix: clear hallucinated target fields (e.g. LLM invents a non-existent
      // tag/front/facility). Other valid fields in the same intent still drive execution.
      softFixTargetFields(intent, state, (field, value) => {
        addMessage("warning", `目标 ${field}=${value} 不存在，已忽略此字段`, state.time, ch, undefined, "command_ack");
      });

      if (!isValidTarget(intent, state)) {
        const field = intent.targetFacility || intent.toFront || intent.fromFront || intent.targetRegion || "unknown";
        addMessage("warning", `目标 ${field} 不存在`, state.time, ch, undefined, "command_ack");
        setClarification("命令引用了不存在的目标，请重新描述");
        return;
      }
    }

    const allOrders: ReturnType<typeof resolveIntent>["orders"] = [];
    const reserved = new Set<number>();
    let degradedCount = 0;

    const allAssignedUnitIds: number[] = [];
    for (const intent of intents) {
      const result = resolveIntent(intent, state, state.style, reserved, selectedIdsSnapshotRef.current);
      if (result.degraded) {
        degradedCount++;
        addMessage("warning", result.log, state.time, ch, undefined, "command_ack");
      } else {
        addMessage("info", `执行: ${result.log}`, state.time, ch, undefined, "command_ack");
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
      // TTS readback of confirmation
      if (ttsEnabled && hasTTS) {
        ttsSpeakSentence(voiceConfirm);
      }
      applyOrders(state, allOrders);

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
  const chatContentFragment = (
    <>
      <div ref={scrollRef} className={isDetached ? "dp-chat-scroll" : undefined} style={isDetached ? undefined : chatFlowStyle}>
        {displayMessages.length === 0 && (
          <div className="hud-empty-state">
            等待指令...
          </div>
        )}
        {displayMessages.map((msg) => {
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

      {/* Style indicator */}
      {styleSnapshot && (
        <div style={styleRowStyle}>
          <button onClick={() => setShowStyle(!showStyle)} style={styleToggleBtn}>
            {showStyle ? "▾ 风格" : "▸ 风格"}
          </button>
          {showStyle && (
            <div style={styleBarContainer}>
              {([
                ["冒险", styleSnapshot.r],
                ["集火", styleSnapshot.f],
                ["目标", styleSnapshot.o],
                ["惜兵", styleSnapshot.c],
                ["侦察", styleSnapshot.s],
              ] as [string, number][]).map(([label, val]) => (
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
                      <span className="dp-channel-btn__avatar">{meta.avatar}</span>
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
                    {isGroupChat ? "📡" : FROM_AVATARS[selectedCommanders[0]]}
                  </span>
                  <span>
                    {isGroupChat ? "全体通信" : `${COMMANDER_META[selectedCommanders[0]].label} — ${COMMANDER_META[selectedCommanders[0]].role}`}
                  </span>
                  {isGroupChat && <span style={{ fontSize: 9, color: "var(--hud-text-dim)", marginLeft: "auto" }}>COMMS ONLY</span>}
                </div>
                {chatContentFragment}
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
          </div>
        </div>

        {/* Bottom Dock */}
        <div className="dp-bottom-dock">
          <button
            className="dp-dock-btn dp-dock-btn--prod"
            onClick={() => handleProduce("infantry")}
            disabled={playerMoney < 100 || playerQueueLen >= 3}
            style={{ opacity: playerMoney >= 100 && playerQueueLen < 3 ? 1 : 0.35 }}
            title={`生产步兵 ($100)${playerQueueLen >= 3 ? " — 队列已满" : ""}`}
          >+兵$100</button>
          <button
            className="dp-dock-btn dp-dock-btn--prod"
            onClick={() => handleProduce("light_tank")}
            disabled={playerMoney < 250 || playerQueueLen >= 3}
            style={{ opacity: playerMoney >= 250 && playerQueueLen < 3 ? 1 : 0.35 }}
            title={`生产轻坦 ($250)${playerQueueLen >= 3 ? " — 队列已满" : ""}`}
          >+坦$250</button>
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
            className="dp-dock-btn dp-dock-btn--ptt"
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
              onClick={() => { setTtsEnabled(e => !e); if (ttsEnabled) ttsCancel(); }}
              style={{ background: ttsEnabled ? "rgba(0, 212, 255, 0.2)" : undefined }}
              title={ttsEnabled ? "关闭语音朗读" : "开启语音朗读（参谋回复会被读出来）"}
            >{ttsEnabled ? "🔊" : "🔇"}</button>
          )}
          {onCreateSquad && (
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
            onClick={sendCommand}
            disabled={loading || !message.trim()}
            style={{ opacity: loading || !message.trim() ? 0.5 : 1 }}
          >{loading ? "..." : "发送"}</button>
        </div>
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
              }}>{meta.avatar}</span>
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
              color: activeTab === "chat" ? "var(--hud-accent-cyan)" : undefined,
            }}
          >
            聊天 💬
          </button>
          <button
            onClick={() => setActiveTab("org")}
            style={{
              ...tabBtnStyle,
              borderBottomColor: activeTab === "org" ? "var(--hud-accent-cyan)" : "transparent",
              color: activeTab === "org" ? "var(--hud-accent-cyan)" : undefined,
            }}
          >
            编制 🏗️
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
        <button onClick={() => handleProduce("infantry")} disabled={playerMoney < 100 || playerQueueLen >= 3} style={{ ...prodBtnStyle, opacity: playerMoney >= 100 && playerQueueLen < 3 ? 1 : 0.35 }} title={`生产步兵 ($100)${playerQueueLen >= 3 ? " — 队列已满" : ""}`}>+兵$100</button>
        <button onClick={() => handleProduce("light_tank")} disabled={playerMoney < 250 || playerQueueLen >= 3} style={{ ...prodBtnStyle, opacity: playerMoney >= 250 && playerQueueLen < 3 ? 1 : 0.35 }} title={`生产轻坦 ($250)${playerQueueLen >= 3 ? " — 队列已满" : ""}`}>+坦$250</button>
        <input ref={inputRef} type="text" value={message} onChange={(e) => setMessage(e.target.value)} onKeyDown={handleKeyDown} placeholder={isGroupChat ? "全体通信（仅讨论，不可下令）..." : `对${COMMANDER_META[selectedCommanders[0]].label}下令...`} disabled={loading} style={inputStyle} />
        <button onPointerDown={(e) => { e.preventDefault(); startPTT(); }} onPointerUp={stopPTT} onPointerCancel={stopPTT} onPointerLeave={() => { if (pttStatus === "listening") stopPTT(); }} disabled={pttStatus === "unsupported" || loading} style={{ ...pttBtnStyle, background: pttStatus === "listening" ? "var(--hud-accent-red)" : pttStatus === "error" ? "rgba(127, 29, 29, 0.8)" : undefined, opacity: pttStatus === "unsupported" || loading ? 0.35 : 1, cursor: pttStatus === "unsupported" || loading ? "default" : "pointer" }} title={pttStatus === "unsupported" ? "浏览器不支持语音识别" : pttStatus === "error" ? "麦克风权限被拒绝" : pttStatus === "listening" ? "松开结束录音并发送" : "按住说话"}>{pttStatus === "listening" ? "🔴" : "🎤"}</button>
        {hasTTS && (<button onClick={() => { setTtsEnabled(e => !e); if (ttsEnabled) ttsCancel(); }} style={{ ...pttBtnStyle, background: ttsEnabled ? "rgba(0, 212, 255, 0.2)" : undefined, opacity: 1, cursor: "pointer", fontSize: 14 }} title={ttsEnabled ? "关闭语音朗读" : "开启语音朗读（参谋回复会被读出来）"}>{ttsEnabled ? "🔊" : "🔇"}</button>)}
        {onCreateSquad && (<button onClick={() => onCreateSquad(selectedCommanders[0])} disabled={!squadBtnEnabled} style={{ ...actionBtnStyle, opacity: squadBtnEnabled ? 1 : 0.35, cursor: squadBtnEnabled ? "pointer" : "default" }} title={squadBtnEnabled ? "将选中单位编为分队" : "请先框选未编队的单位"}>编队</button>)}
        {onDeclareWar && canDeclareWar && (<button onClick={onDeclareWar} style={warBtnStyle} title="向敌方宣战">宣战</button>)}
        <button data-send-btn onClick={sendCommand} disabled={loading || !message.trim()} style={{ ...sendBtnStyle, opacity: loading || !message.trim() ? 0.5 : 1 }}>{loading ? "..." : "发送"}</button>
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
