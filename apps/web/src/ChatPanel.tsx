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
import { buildDigest, resolveIntent, applyOrders, updateStyleParam, findFront, enqueueProduction, cancelDoctrine } from "@ai-commander/core";
import type { GameState, AdvisorResponse, AdvisorOption, Intent, Channel, TaskCard, TaskPriority } from "@ai-commander/shared";
import type { StandingOrder, StandingOrderType, DoctrinePriority } from "@ai-commander/shared";
import { CHANNEL_LABELS } from "@ai-commander/shared";
import {
  addMessage,
  getActiveChannel,
  setActiveChannel,
  getGroupChatMessages,
  getMessagesByChannel,
  getActiveThreads,
  resolveThread,
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

// ── Voice confirmations per commander personality ──
const VOICE_CONFIRMS: Record<Commander, string[]> = {
  chen: [
    "Yes sir!", "Copy that!", "On it!", "Got it, moving out!",
    "Roger that, let's go!", "Hell yeah, consider it done!",
    "Loud and clear!", "You got it, boss!",
  ],
  marcus: [
    "Roger, executing now.", "Understood, sir.", "Copy that, General.",
    "Affirmative. Orders received.", "Yes sir, proceeding as planned.",
    "Acknowledged. Moving to execute.", "Will do, Commander.",
  ],
  emily: [
    "Got it!", "Copy that, on my way.", "Understood, I'll handle it.",
    "Roger, coordinating now.", "Affirmative, resources allocated.",
    "Right away, Commander.", "Consider it done, sir.",
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
  if (intent.targetFacility && !state.facilities.has(intent.targetFacility)) return false;
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

// ── Phase 1: Deterministic auto-execute gate (from CommandPanel) ──

function canAutoExecute(
  option: AdvisorOption,
  userMessage: string,
  state: GameState,
  selectedIds?: readonly number[],
  isGroupChat?: boolean,
): { auto: boolean; reason?: string } {
  // 0.5: group chat forces manual approval
  if (isGroupChat) return { auto: false, reason: "group_chat" };

  const intents = option.intents ?? [option.intent];

  if (intents.length !== 1) return { auto: false, reason: "multi_intent" };
  const intent = intents[0];

  const squadIdsInText = (userMessage.match(/\b[TIANF]\d+\b/gi) ?? []).map(s => s.toUpperCase());
  const hasSelectedAnchor = /\bselected\b/i.test(userMessage) || /选中|圈起来|这队|这支/.test(userMessage);
  const hasSquadAnchor = squadIdsInText.length > 0;

  // Phase 2: leaderName anchor — if fromSquad matches a leaderName (not a squad ID format),
  // force manual confirm since human names are less precise
  if (intent.fromSquad && typeof intent.fromSquad === "string") {
    const isSquadIdFormat = /^[A-Z]\d+$/i.test(intent.fromSquad);
    if (!isSquadIdFormat) {
      // leaderName reference → always confirm
      return { auto: false, reason: "leader_name_anchor" };
    }
  }

  if (!hasSquadAnchor && !hasSelectedAnchor) return { auto: false, reason: "no_anchor" };

  if (hasSquadAnchor) {
    if (!intent.fromSquad || !squadIdsInText.includes(intent.fromSquad.toUpperCase())) {
      return { auto: false, reason: "anchor_mismatch" };
    }
  }
  if (hasSelectedAnchor && !hasSquadAnchor) {
    if (!selectedIds || selectedIds.length === 0) return { auto: false, reason: "no_selected_units" };
    if (intent.fromSquad) return { auto: false, reason: "anchor_mismatch" };
  }


  if (!isValidTarget(intent, state)) return { auto: false, reason: "invalid_intent_fields" };

  const qty = intent.quantity;
  const isHighImpact = (qty === "all" || qty === "most") &&
    (intent.type === "attack" || intent.type === "sabotage");
  if (isHighImpact) return { auto: false, reason: "high_impact" };

  if (intent.fromSquad) {
    const squad = state.squads?.find(s => s.id === intent.fromSquad);
    if (squad?.currentMission !== null) return { auto: false, reason: "mission_conflict" };
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
    rec.lang = "en-US";
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
          addMessage("info", `持续命令已登记: ${soType} @ ${so.locationTag} [${soPriority.toUpperCase()}]`, state.time, ch, undefined, "command_ack");
        }
      }
    }

    // Doctrine cancellation
    if (typeof data.cancelDoctrine === "string" && data.cancelDoctrine.length > 0) {
      const result = cancelDoctrine(state, data.cancelDoctrine);
      if (result.cancelled) {
        addMessage("info", `${result.locationTag} 的 ${result.type} 命令已取消，部队恢复自由调度。`, state.time, result.channel, undefined, "command_ack");
      }
    }
  };

  // ── 0.5: Group chat — parallel requests (completion-order insertion) ──
  const sendGroupChat = async (userMsg: string, state: GameState, selectedIds: number[]) => {
    // Clear stale response/error from previous command
    setResponse(null);
    setError(null);
    setApprovedIdx(null);
    responseExecCtxRef.current = null;
    latestRequestIdRef.current = null;

    const channels = selectedCommanders.map(c => COMMANDER_CHANNEL[c]);
    const baseDigest = buildDigest(state, [], [], []);
    const styleNote = `risk=${state.style.riskTolerance.toFixed(2)} focus=${state.style.focusFireBias.toFixed(2)} obj=${state.style.objectiveBias.toFixed(2)} cas=${state.style.casualtyAversion.toFixed(2)}`;

    // Add player message to all channels
    for (const ch of channels) {
      pushContext(channelContextRef.current, ch, { role: "user", text: userMsg, time: state.time });
    }

    // Track first response with options for display (completion order)
    let firstOptionsShown = false;

    // Fire parallel requests — each resolves independently and inserts into chat on completion
    const requests = selectedCommanders.map(async (cmd) => {
      const ch = COMMANDER_CHANNEL[cmd];
      const requestId = crypto.randomUUID();
      const contextSuffix = formatContext(channelContextRef.current, ch);
      const digest = baseDigest + contextSuffix;

      try {
        const res = await fetch(`${API_URL}/api/command`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ digest, message: userMsg, styleNote, channel: ch }),
        });
        const data = await res.json();

        // Insert into chat flow immediately on completion (not waiting for others)
        if (data.error) {
          addMessage("urgent", `${COMMANDER_META[cmd].label}: ${data.error}`, state.time, ch, cmd, "command_ack", true);
          return;
        }

        if (data.brief) {
          pushContext(channelContextRef.current, ch, { role: "assistant", text: data.brief, time: state.time });
          addMessage("info", data.brief, state.time, ch, cmd, "command_ack", true);
        }

        if (data.responseType?.toUpperCase() === "NOOP") {
          // NOOP can carry cancelDoctrine (natural language cancellation doesn't need approval)
          if (typeof data.cancelDoctrine === "string" && data.cancelDoctrine.length > 0) {
            processDoctrineFields({ cancelDoctrine: data.cancelDoctrine }, state, ch);
          }
          return; // Conversational — already added brief above
        }

        if (Array.isArray(data.options) && data.options.length > 0 && !firstOptionsShown) {
          firstOptionsShown = true;
          responseExecCtxRef.current = { channel: ch, requestId };
          latestRequestIdRef.current = requestId;
          setResponse(data as DisplayResponse);
        }
      } catch {
        addMessage("urgent", `${COMMANDER_META[cmd].label}: 通信中断`, state.time, ch, cmd, "system", true);
      }
    });

    // Wait for all to finish (loading spinner stays until all done)
    await Promise.all(requests);
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

    const baseDigest = buildDigest(state, [], [], []);
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
            console.debug(`[P1 gate] no-auto: ${gate.reason}`);
          }
          responseExecCtxRef.current = execCtx;
          setResponse(data as DisplayResponse);
          setError(null);
          addMessage("info", "Advisor briefing received", state.time, ch, undefined, "command_ack");
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
      const primaryIntent = intents[0];
      // Always create TaskCard if orders executed successfully.
      // Even without resolved squads — the task tracker handles squadless tasks.
      {
      const locationHint = primaryIntent.toFront || primaryIntent.fromFront
        || primaryIntent.targetRegion || "";
      const titleMap: Record<string, string> = {
        defend: `防守 ${locationHint || "阵地"}`,
        attack: `进攻 ${locationHint || "目标"}`,
        retreat: `撤退整补 ${locationHint}`,
        recon: `侦察 ${locationHint || "区域"}`,
        hold: `固守 ${locationHint || "阵地"}`,
        patrol: `巡逻 ${locationHint || "区域"}`,
        reinforce: `增援 ${locationHint || "前线"}`,
        capture: `占领 ${primaryIntent.targetFacility || locationHint || "设施"}`,
        sabotage: `破坏 ${primaryIntent.targetFacility || locationHint || "设施"}`,
        produce: `生产 ${primaryIntent.produceType || "单位"}`,
        trade: `交易 ${primaryIntent.tradeAction || "资源"}`,
      };
      const taskTitle = (titleMap[primaryIntent.type] || primaryIntent.type).trim();

      // Find associated doctrine if standingOrder was just created
      const linkedDoctrine = state.doctrines.find(
        d => d.status === "active" && d.commander === ch &&
        d.createdAt === state.time,
      );

      const taskId = `task_${Date.now().toString(36)}_${state.tasks.length}`;
      const economyTypes = new Set(["produce", "trade"]);
      const taskKind = economyTypes.has(primaryIntent.type) ? "economy" as const : "combat" as const;
      const newTask: TaskCard = {
        id: taskId,
        title: taskTitle,
        commander: ch,
        assignedSquads: squads,
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

    // Brief flash then clear card
    setTimeout(() => {
      setResponse(null);
      setApprovedIdx(null);
      selectedIdsSnapshotRef.current = undefined;
      responseExecCtxRef.current = null;
      latestRequestIdRef.current = null;
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
    setResponse(null);
    setError(null);
    setApprovedIdx(null);
    selectedIdsSnapshotRef.current = undefined;
    responseExecCtxRef.current = null;
    latestRequestIdRef.current = null;
  };

  // ── Render ──
  // Capture exec context at render time so approve buttons use a frozen snapshot,
  // not the (potentially stale or updated) ref value at click time.
  const approveSnapshotCtx = responseExecCtxRef.current ? { ...responseExecCtxRef.current } : undefined;

  const detachedPanelStyle: React.CSSProperties = isDetached
    ? { position: "relative", width: "100%", height: "100%", background: "#0f172a", fontFamily: "monospace", fontSize: 12, color: "#a0c4ff", display: "flex", flexDirection: "column" as const }
    : { ...panelStyle, display: collapsed ? "none" : "flex" };

  return (
    <>
      {/* ── Toggle button (only in embedded mode) ── */}
      {!isDetached && (
        <button
          onClick={() => setCollapsed((c) => !c)}
          style={{
            position: "absolute",
            top: 8,
            right: collapsed ? 8 : 468,
            zIndex: 110,
            background: "rgba(15, 23, 42, 0.9)",
            border: "1px solid #334155",
            borderRadius: 4,
            color: "#94a3b8",
            fontSize: 14,
            width: 28,
            height: 28,
            cursor: "pointer",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            transition: "right 0.2s ease",
          }}
          title={collapsed ? "展开面板" : "收起面板"}
        >
          {collapsed ? "◀" : "▶"}
        </button>
      )}
    <div style={detachedPanelStyle}>
      {/* ── Top: Commander selection bar ── */}
      <div style={commanderBarStyle}>
        {COMMANDERS.map((cmd) => {
          const meta = COMMANDER_META[cmd];
          const isSelected = selectedCommanders.includes(cmd);
          return (
            <button
              key={cmd}
              onClick={() => selectSingleCommander(cmd)}
              onContextMenu={(e) => { e.preventDefault(); toggleCommander(cmd); }}
              style={{
                ...commanderBtnStyle,
                opacity: isSelected ? 1 : 0.4,
                borderColor: isSelected ? FROM_COLORS[cmd] : "transparent",
              }}
              title={`${meta.label} (${meta.role}) — 右键多选`}
            >
              <span style={{ fontSize: 16 }}>{meta.avatar}</span>
              <span style={{ fontSize: 10 }}>{meta.role}</span>
            </button>
          );
        })}
        <button
          onClick={selectAll}
          style={{
            ...commanderBtnStyle,
            opacity: selectedCommanders.length === 3 ? 1 : 0.4,
            borderColor: selectedCommanders.length === 3 ? "#fbbf24" : "transparent",
          }}
          title="全体指挥官"
        >
          <span style={{ fontSize: 14 }}>ALL</span>
          <span style={{ fontSize: 10 }}>全体</span>
        </button>
      </div>

      {/* ── Tab switcher: Chat / Org (hidden in detached mode — both shown) ── */}
      {!isDetached && (
        <div style={tabBarStyle}>
          <button
            onClick={() => setActiveTab("chat")}
            style={{
              ...tabBtnStyle,
              borderBottomColor: activeTab === "chat" ? "#3b82f6" : "transparent",
              color: activeTab === "chat" ? "#e2e8f0" : "#64748b",
            }}
          >
            聊天 💬
          </button>
          <button
            onClick={() => setActiveTab("org")}
            style={{
              ...tabBtnStyle,
              borderBottomColor: activeTab === "org" ? "#3b82f6" : "transparent",
              color: activeTab === "org" ? "#e2e8f0" : "#64748b",
            }}
          >
            编制 🏗️
          </button>
        </div>
      )}

      {/* ── Content area: left-right in detached, column in embedded ── */}
      <div style={isDetached ? { display: "flex", flex: 1, flexDirection: "row" as const, overflow: "hidden" } : { display: "flex", flex: 1, flexDirection: "column" as const, overflow: "hidden" }}>

      {/* ── Detached mode: OrgTree on left ── */}
      {isDetached && (() => {
        const st = getState();
        return (
          <div style={{ borderRight: "1px solid #1e293b", overflow: "auto", width: "40%", minWidth: 300, flexShrink: 0 }}>
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
              <div style={{ color: "#475569", textAlign: "center", padding: 12 }}>加载中...</div>
            )}
          </div>
        );
      })()}

      {/* ── Chat column (right side in detached, full area in embedded) ── */}
      <div style={{ display: "flex", flexDirection: "column" as const, flex: 1, overflow: "hidden" }}>

      {/* ── Embedded: tab-switched OrgTree or Chat ── */}
      {!isDetached && activeTab === "org" ? (
        (() => {
          const st = getState();
          if (!st) return <div style={{ flex: 1, color: "#475569", textAlign: "center", padding: 20 }}>加载中...</div>;
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
      <>
      <div ref={scrollRef} style={chatFlowStyle}>
        {displayMessages.length === 0 && (
          <div style={{ color: "#475569", fontSize: 11, padding: "12px 0", textAlign: "center" }}>
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
                background: isPlayer ? "rgba(30, 64, 175, 0.6)" : "rgba(15, 23, 42, 0.8)",
                borderColor: isPlayer ? "#2563eb" : "#334155",
                alignSelf: isPlayer ? "flex-end" : "flex-start",
                maxWidth: "85%",
              }}>
                <span style={{ color: isPlayer ? "#e2e8f0" : "#cbd5e1", fontSize: 12 }}>{msg.text}</span>
              </div>
              {isPlayer && (
                <span style={{ ...timeTagStyle, alignSelf: "flex-end" }}>{formatTime(msg.time)}</span>
              )}
            </div>
          );
        })}

        {/* Inline staff threads with ⚠ */}
        {activeThreads.length > 0 && !response && activeThreads.map((thread) => (
          <div key={thread.id} style={threadBubbleStyle}>
            <div style={{ fontSize: 10, color: "#f59e0b", marginBottom: 4, fontWeight: "bold" }}>
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
                      <div style={{ fontSize: 9, color: "#94a3b8", marginTop: 2 }}>{opt.description}</div>
                    </button>
                  );
                })}
              </div>
            )}
            <div style={{ fontSize: 9, color: "#475569", marginTop: 4 }}>
              Expires in {Math.max(0, Math.floor(thread.expiresAt - (getState()?.time ?? 0)))}s
            </div>
          </div>
        ))}

        {/* Streaming text bubble */}
        {streamingText !== null && (
          <div style={{ padding: "6px 10px", margin: "4px 0", background: "rgba(30, 41, 59, 0.9)", borderRadius: 6, border: "1px solid #334155", fontSize: 11, color: "#94a3b8", fontStyle: "italic" }}>
            {streamingText || "…"}
            <span style={{ display: "inline-block", width: 4, height: 12, background: "#fbbf24", marginLeft: 2, animation: "blink 1s step-end infinite" }} />
          </div>
        )}

        {/* Inline A/B/C option cards */}
        {response && (
          <div style={optionsInlineStyle}>
            <div style={{ color: "#fbbf24", fontWeight: "bold", fontSize: 12, marginBottom: 6 }}>
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
                    borderColor: isApproved ? "#22c55e" : isRecommended ? "#4ade80" : "#334155",
                    background: isApproved ? "rgba(34, 197, 94, 0.15)" : "rgba(15, 23, 42, 0.8)",
                  }}
                >
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                    <span style={{ fontWeight: "bold", color: "#e2e8f0", fontSize: 11 }}>{opt.label}</span>
                    {isRecommended && <span style={recommendedBadge}>推荐</span>}
                  </div>
                  <div style={{ fontSize: 10, color: "#94a3b8", marginTop: 3 }}>{opt.description}</div>
                  <div style={{ display: "flex", gap: 8, marginTop: 3, fontSize: 9, color: "#64748b" }}>
                    <span style={{ display: "flex", alignItems: "center", gap: 2 }}>
                      风险
                      <span style={barBg}><span style={{ ...barFill, width: `${opt.risk * 100}%`, background: opt.risk > 0.6 ? "#ef4444" : "#f59e0b" }} /></span>
                    </span>
                    <span style={{ display: "flex", alignItems: "center", gap: 2 }}>
                      收益
                      <span style={barBg}><span style={{ ...barFill, width: `${opt.reward * 100}%`, background: "#22c55e" }} /></span>
                    </span>
                  </div>
                  {(opt.intents ?? [opt.intent]).map((it, j) => (
                    <div key={j} style={{ fontSize: 9, color: "#475569", marginTop: 2 }}>
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
                  // Save current proposal context for next command
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

      {/* ── Style indicator ── */}
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
                    <span style={{ ...barFill, width: `${val * 100}%`, background: "#60a5fa" }} />
                  </span>
                  <span style={styleVal}>{(val * 100).toFixed(0)}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
      </>
      )}

      {/* ── Bottom: Input area ── */}
      <div style={inputContainerStyle}>
        <button
          onClick={() => handleProduce("infantry")}
          disabled={playerMoney < 100 || playerQueueLen >= 3}
          style={{
            ...prodBtnStyle,
            opacity: playerMoney >= 100 && playerQueueLen < 3 ? 1 : 0.35,
          }}
          title={`生产步兵 ($100)${playerQueueLen >= 3 ? " — 队列已满" : ""}`}
        >
          +兵$100
        </button>
        <button
          onClick={() => handleProduce("light_tank")}
          disabled={playerMoney < 250 || playerQueueLen >= 3}
          style={{
            ...prodBtnStyle,
            opacity: playerMoney >= 250 && playerQueueLen < 3 ? 1 : 0.35,
          }}
          title={`生产轻坦 ($250)${playerQueueLen >= 3 ? " — 队列已满" : ""}`}
        >
          +坦$250
        </button>
        <input
          ref={inputRef}
          type="text"
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={isGroupChat ? "全体指令..." : `对${COMMANDER_META[selectedCommanders[0]].label}下令...`}
          disabled={loading}
          style={inputStyle}
        />
        {/* Push-to-Talk button */}
        <button
          onPointerDown={(e) => { e.preventDefault(); startPTT(); }}
          onPointerUp={stopPTT}
          onPointerCancel={stopPTT}
          onPointerLeave={() => { if (pttStatus === "listening") stopPTT(); }}
          disabled={pttStatus === "unsupported" || loading}
          style={{
            ...pttBtnStyle,
            background: pttStatus === "listening" ? "#dc2626" : pttStatus === "error" ? "#7f1d1d" : "#1e3a5f",
            opacity: pttStatus === "unsupported" || loading ? 0.35 : 1,
            cursor: pttStatus === "unsupported" || loading ? "default" : "pointer",
          }}
          title={
            pttStatus === "unsupported" ? "浏览器不支持语音识别"
            : pttStatus === "error" ? "麦克风权限被拒绝，请在浏览器设置中允许"
            : pttStatus === "listening" ? "松开结束录音并发送"
            : "按住说话"
          }
        >
          {pttStatus === "listening" ? "🔴" : "🎤"}
        </button>
        {/* TTS toggle */}
        {hasTTS && (
          <button
            onClick={() => { setTtsEnabled(e => !e); if (ttsEnabled) ttsCancel(); }}
            style={{
              ...pttBtnStyle,
              background: ttsEnabled ? "#1d4ed8" : "#1e3a5f",
              opacity: 1,
              cursor: "pointer",
              fontSize: 14,
            }}
            title={ttsEnabled ? "关闭语音朗读" : "开启语音朗读（参谋回复会被读出来）"}
          >
            {ttsEnabled ? "🔊" : "🔇"}
          </button>
        )}
        {onCreateSquad && (
          <button
            onClick={() => onCreateSquad(selectedCommanders[0])}
            disabled={!squadBtnEnabled}
            style={{
              ...actionBtnStyle,
              opacity: squadBtnEnabled ? 1 : 0.35,
              cursor: squadBtnEnabled ? "pointer" : "default",
            }}
            title={squadBtnEnabled ? "将选中单位编为分队" : "请先框选未编队的单位"}
          >
            编队
          </button>
        )}
        {onDeclareWar && canDeclareWar && (
          <button onClick={onDeclareWar} style={warBtnStyle} title="向敌方宣战">
            宣战
          </button>
        )}
        <button
          data-send-btn
          onClick={sendCommand}
          disabled={loading || !message.trim()}
          style={{
            ...sendBtnStyle,
            opacity: loading || !message.trim() ? 0.5 : 1,
          }}
        >
          {loading ? "..." : "发送"}
        </button>
      </div>
      </div>
      </div>
    </div>
    </>
  );
}

// ── Styles ──

const panelStyle: React.CSSProperties = {
  position: "absolute",
  top: 0,
  right: 0,
  width: 460,
  height: "100%",
  background: "rgba(15, 23, 42, 0.96)",
  borderLeft: "1px solid #0f3460",
  fontFamily: "monospace",
  fontSize: 12,
  color: "#a0c4ff",
  zIndex: 100,
  pointerEvents: "auto",
  display: "flex",
  flexDirection: "column",
};

const tabBarStyle: React.CSSProperties = {
  display: "flex",
  gap: 0,
  borderBottom: "1px solid #1e293b",
  flexShrink: 0,
};

const tabBtnStyle: React.CSSProperties = {
  flex: 1,
  background: "transparent",
  border: "none",
  borderBottom: "2px solid transparent",
  color: "#64748b",
  fontSize: 12,
  fontFamily: "monospace",
  padding: "6px 0",
  cursor: "pointer",
  transition: "color 0.15s, border-color 0.15s",
};

const commanderBarStyle: React.CSSProperties = {
  display: "flex",
  gap: 4,
  padding: "8px 10px",
  borderBottom: "1px solid #0f3460",
  flexShrink: 0,
};

const commanderBtnStyle: React.CSSProperties = {
  flex: 1,
  display: "flex",
  flexDirection: "column",
  alignItems: "center",
  gap: 2,
  padding: "6px 4px",
  background: "rgba(15, 23, 42, 0.6)",
  border: "2px solid transparent",
  borderRadius: 6,
  cursor: "pointer",
  fontFamily: "monospace",
  color: "#e2e8f0",
  transition: "opacity 0.15s",
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
  padding: "6px 10px",
  borderRadius: 8,
  border: "1px solid #334155",
  wordBreak: "break-word",
};

const timeTagStyle: React.CSSProperties = {
  fontSize: 9,
  color: "#475569",
};

const threadBubbleStyle: React.CSSProperties = {
  padding: "8px 10px",
  background: "rgba(245, 158, 11, 0.08)",
  border: "1px solid rgba(245, 158, 11, 0.3)",
  borderRadius: 8,
};

const threadOptionBtnStyle: React.CSSProperties = {
  display: "block",
  width: "100%",
  textAlign: "left",
  background: "rgba(15, 23, 42, 0.6)",
  border: "1px solid #334155",
  borderRadius: 4,
  padding: "6px 8px",
  fontSize: 11,
  fontFamily: "monospace",
  color: "#e2e8f0",
  cursor: "pointer",
};

const optionsInlineStyle: React.CSSProperties = {
  padding: "8px 10px",
  background: "rgba(15, 23, 42, 0.6)",
  border: "1px solid #334155",
  borderRadius: 8,
};

const optionCardStyle: React.CSSProperties = {
  background: "rgba(15, 23, 42, 0.8)",
  border: "1px solid #334155",
  borderRadius: 4,
  padding: "6px 8px",
  marginBottom: 4,
};

const recommendedBadge: React.CSSProperties = {
  fontSize: 9,
  background: "#166534",
  color: "#4ade80",
  padding: "1px 5px",
  borderRadius: 3,
  fontWeight: "bold",
};

const dismissBtn: React.CSSProperties = {
  background: "none",
  border: "none",
  color: "#64748b",
  cursor: "pointer",
  fontSize: 14,
  padding: "0 4px",
  marginLeft: 8,
};

const barBg: React.CSSProperties = {
  display: "inline-block",
  width: 40,
  height: 4,
  background: "#1e293b",
  borderRadius: 2,
  overflow: "hidden",
  verticalAlign: "middle",
};

const barFill: React.CSSProperties = {
  display: "block",
  height: "100%",
  borderRadius: 2,
};

const approveBtnStyle: React.CSSProperties = {
  marginTop: 4,
  width: "100%",
  background: "#1e3a5f",
  color: "#60a5fa",
  border: "1px solid #2563eb",
  borderRadius: 3,
  padding: "4px 0",
  fontSize: 11,
  fontFamily: "monospace",
  fontWeight: "bold",
  cursor: "pointer",
  letterSpacing: 1,
};

const cancelBtnStyle: React.CSSProperties = {
  flex: 1,
  padding: "4px 0",
  fontSize: 10,
  border: "1px solid #475569",
  borderRadius: 4,
  background: "rgba(71, 85, 105, 0.2)",
  color: "#94a3b8",
  cursor: "pointer",
};

const supplementBtnStyle: React.CSSProperties = {
  flex: 1,
  padding: "4px 0",
  fontSize: 10,
  border: "1px solid #3b82f6",
  borderRadius: 4,
  background: "rgba(59, 130, 246, 0.1)",
  color: "#60a5fa",
  cursor: "pointer",
};

const warningStyle: React.CSSProperties = {
  color: "#f59e0b",
  fontSize: 10,
  marginTop: 4,
  padding: "4px 6px",
  background: "rgba(245, 158, 11, 0.1)",
  borderRadius: 3,
};

const errorBubbleStyle: React.CSSProperties = {
  color: "#ef4444",
  fontSize: 11,
  padding: "6px 8px",
  background: "rgba(239, 68, 68, 0.1)",
  border: "1px solid rgba(239, 68, 68, 0.3)",
  borderRadius: 6,
};

const clarificationStyle: React.CSSProperties = {
  color: "#fbbf24",
  fontSize: 11,
  padding: "6px 8px",
  background: "rgba(251, 191, 36, 0.12)",
  border: "1px solid rgba(251, 191, 36, 0.3)",
  borderRadius: 6,
};

const styleRowStyle: React.CSSProperties = {
  padding: "4px 10px",
  borderTop: "1px solid #0f3460",
  flexShrink: 0,
};

const styleToggleBtn: React.CSSProperties = {
  background: "none",
  border: "none",
  color: "#64748b",
  cursor: "pointer",
  fontSize: 10,
  fontFamily: "monospace",
  padding: "2px 0",
};

const styleBarContainer: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 2,
  marginTop: 3,
  padding: "4px 6px",
  background: "rgba(15, 23, 42, 0.6)",
  borderRadius: 3,
};

const styleBarItem: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 4,
};

const styleLabel: React.CSSProperties = {
  width: 24,
  color: "#94a3b8",
  fontSize: 9,
};

const styleVal: React.CSSProperties = {
  width: 20,
  color: "#64748b",
  fontSize: 9,
  textAlign: "right",
};

const inputContainerStyle: React.CSSProperties = {
  display: "flex",
  gap: 6,
  padding: "8px 10px",
  borderTop: "1px solid #0f3460",
  flexShrink: 0,
};

const inputStyle: React.CSSProperties = {
  flex: 1,
  background: "#0f172a",
  border: "1px solid #334155",
  borderRadius: 4,
  padding: "8px 10px",
  color: "#e2e8f0",
  fontSize: 12,
  fontFamily: "monospace",
  outline: "none",
};

const prodBtnStyle: React.CSSProperties = {
  background: "#1a3a2a",
  color: "#4ade80",
  border: "1px solid #166534",
  borderRadius: 4,
  padding: "6px 6px",
  fontSize: 10,
  fontFamily: "monospace",
  cursor: "pointer",
  whiteSpace: "nowrap",
};

const actionBtnStyle: React.CSSProperties = {
  background: "#1e3a5f",
  color: "#60a5fa",
  border: "1px solid #2563eb",
  borderRadius: 4,
  padding: "6px 8px",
  fontSize: 11,
  fontFamily: "monospace",
  cursor: "pointer",
  whiteSpace: "nowrap",
};

const warBtnStyle: React.CSSProperties = {
  background: "#7f1d1d",
  color: "#fca5a5",
  border: "1px solid #dc2626",
  borderRadius: 4,
  padding: "6px 8px",
  fontSize: 11,
  fontFamily: "monospace",
  fontWeight: "bold",
  cursor: "pointer",
  whiteSpace: "nowrap",
};

const pttBtnStyle: React.CSSProperties = {
  background: "#1e3a5f",
  color: "#e2e8f0",
  border: "1px solid #2563eb",
  borderRadius: 4,
  padding: "6px 8px",
  fontSize: 11,
  fontFamily: "monospace",
  cursor: "pointer",
  whiteSpace: "nowrap",
  userSelect: "none",
  touchAction: "none",
};

const sendBtnStyle: React.CSSProperties = {
  background: "#1e40af",
  color: "#e2e8f0",
  border: "none",
  borderRadius: 4,
  padding: "6px 14px",
  fontSize: 12,
  fontFamily: "monospace",
  cursor: "pointer",
};
