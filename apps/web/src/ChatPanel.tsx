// ============================================================
// AI Commander — Unified Chat Panel (Round 0)
// Replaces CommandPanel + MessageFeed with a single right-side
// chat-style interface.  Commander selection at the top,
// chat bubbles in the middle, input at the bottom.
// ============================================================

import { useState, useRef, useEffect } from "react";
import { buildDigest, resolveIntent, applyOrders, updateStyleParam, findFront } from "@ai-commander/core";
import type { GameState, AdvisorResponse, AdvisorOption, Intent, Channel } from "@ai-commander/shared";
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

// ── Phase 1: Shared intent target validator (from CommandPanel) ──

function isValidTarget(intent: Intent, state: GameState): boolean {
  if (intent.targetRegion) {
    const isTag = state.tags?.some(t => t.id === intent.targetRegion);
    const isFront = !!findFront(state, intent.targetRegion);
    const isRegion = state.regions.has(intent.targetRegion);
    const isRegionFuzzy = !isRegion && (() => {
      const lower = intent.targetRegion!.toLowerCase();
      for (const [, r] of state.regions) {
        if (r.id.toLowerCase().includes(lower) || r.name.toLowerCase().includes(lower)) return true;
      }
      return false;
    })();
    if (!isTag && !isFront && !isRegion && !isRegionFuzzy) return false;
  }
  if (intent.targetFacility && !state.facilities.has(intent.targetFacility)) return false;
  if (intent.toFront && !findFront(state, intent.toFront)) return false;
  if (intent.fromFront && !findFront(state, intent.fromFront)) return false;
  if (intent.fromSquad && !state.squads?.find(s => s.id === intent.fromSquad)) return false;
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

  const squadIdsInText = (userMessage.match(/\b[TIA]\d+\b/gi) ?? []).map(s => s.toUpperCase());
  const hasSelectedAnchor = /\bselected\b/i.test(userMessage) || /选中|圈起来|这队|这支/.test(userMessage);
  const hasSquadAnchor = squadIdsInText.length > 0;

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
  onCreateSquad?: () => void;
  canCreateSquad?: () => boolean;
  onDeclareWar?: () => void;
}

interface DisplayResponse extends AdvisorResponse {
  warning?: string;
}


export function ChatPanel({ getState, getSelectedUnitIds, onCreateSquad, canCreateSquad, onDeclareWar }: Props) {
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

  // Poll war declaration eligibility + clear panel on game over + detect restart
  const lastSeenTimeRef = useRef(0);
  const [canDeclareWar, setCanDeclareWar] = useState(false);
  useEffect(() => {
    const id = setInterval(() => {
      const s = getState();
      setCanDeclareWar(!!s && s.phase === "CONFLICT" && !s.warDeclared && !s.gameOver);
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
        if (!isValidTarget(intent, state)) {
          const field = intent.fromSquad || intent.targetFacility || intent.toFront || intent.fromFront || intent.targetRegion || "unknown";
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

  // ── 0.5: Group chat — parallel requests (completion-order insertion) ──
  const sendGroupChat = async (userMsg: string, state: GameState, selectedIds: number[]) => {
    const channels = selectedCommanders.map(c => COMMANDER_CHANNEL[c]);
    const baseDigest = buildDigest(state, selectedIds, [], []);
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
    responseExecCtxRef.current = null;
    latestRequestIdRef.current = null;

    // Determine channel from selection
    const primaryChannel = COMMANDER_CHANNEL[selectedCommanders[0]];

    // Add player message to feed (mark as groupChat if in ALL mode so it stays out of individual channels)
    addMessage("info", userMsg, state.time, primaryChannel, "player", "player", isGroupChat ? true : undefined);

    // P1: lock selected unit IDs at send time
    const selectedIds = getSelectedUnitIds ? [...getSelectedUnitIds()] : [];
    selectedIdsSnapshotRef.current = selectedIds.length > 0 ? selectedIds : undefined;

    setMessage("");

    if (isGroupChat) {
      await sendGroupChat(userMsg, state, selectedIds);
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

    const baseDigest = buildDigest(state, selectedIds, [], []);
    const contextSuffix = formatContext(channelContextRef.current, ch);
    const digest = baseDigest + contextSuffix + threadContext;
    const styleNote = `risk=${state.style.riskTolerance.toFixed(2)} focus=${state.style.focusFireBias.toFixed(2)} obj=${state.style.objectiveBias.toFixed(2)} cas=${state.style.casualtyAversion.toFixed(2)}`;

    pushContext(channelContextRef.current, ch, { role: "user", text: userMsg, time: state.time });

    try {
      const res = await fetch(`${API_URL}/api/command`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ digest, message: userMsg, styleNote, channel: ch }),
      });

      const data = await res.json();
      if (data.error) {
        setError(data.error);
        setResponse(null);
        selectedIdsSnapshotRef.current = undefined;
        addMessage("urgent", `后端错误: ${data.error}`, state.time, ch, undefined, "system");
      } else if (typeof data.responseType === "string" && data.responseType.toUpperCase() === "NOOP") {
        setResponse(null);
        setError(null);
        setClarification(null);
        const msg = data.brief || "Copy, standing by.";
        addMessage("info", msg, state.time, ch, undefined, "command_ack");
        if (data.brief) {
          pushContext(channelContextRef.current, ch, { role: "assistant", text: data.brief, time: state.time });
        }
      } else if (Array.isArray(data.options) && data.options.length === 0) {
        setResponse(null);
        setError(null);
        const reason = data.brief || "命令目标不存在或不明确";
        setClarification(reason + " — 请重新描述指令");
        addMessage("warning", reason, state.time, ch, undefined, "command_ack");
      } else {
        if (data.brief) {
          pushContext(channelContextRef.current, ch, { role: "assistant", text: data.brief, time: state.time });
        }

        const gate = (Array.isArray(data.options) && data.options.length >= 1)
          ? canAutoExecute(data.options[0], userMsg, state, selectedIds, isGroupChat)
          : { auto: false };

        const requestId = crypto.randomUUID();
        const execCtx: ExecContext = { channel: ch, threadId: activeThreadOnChannel?.id, requestId };
        latestRequestIdRef.current = requestId;

        if (gate.auto && data.options.length >= 1) {
          const autoData = data as DisplayResponse;
          setTimeout(() => handleApprove(autoData.options[0], 0, "auto", execCtx), 0);
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
    } catch {
      const errMsg = "无法连接服务器，请确保后端运行在 localhost:3001";
      setError(errMsg);
      setResponse(null);
      selectedIdsSnapshotRef.current = undefined;
      addMessage("urgent", "通信中断: 无法连接后端", state.time, ch, undefined, "system");
    }
    setLoading(false);
  };

  // ── handleApprove (0.4: migrated from CommandPanel) ──
  const handleApprove = (opt: AdvisorOption, idx: number, mode: "auto" | "manual" = "manual", ctx?: ExecContext) => {
    const state = getState();
    if (!state) return;

    const execCtx = ctx ?? responseExecCtxRef.current;
    const ch = execCtx?.channel ?? getActiveChannel();

    // Validate requestId: the ctx captured at render must match the latest valid requestId.
    // This rejects stale approve clicks after a newer response has arrived.
    if (mode === "manual" && latestRequestIdRef.current && execCtx?.requestId
        && latestRequestIdRef.current !== execCtx.requestId) {
      addMessage("warning", "响应已过期，请重新下令", state.time, ch, undefined, "system");
      return;
    }

    const letter = ["A", "B", "C"][idx] ?? "?";
    const cleanLabel = opt.label.replace(/^[ABC]:\s*/, '');
    const intents = opt.intents ?? [opt.intent];

    for (const intent of intents) {
      if (!isValidTarget(intent, state)) {
        const field = intent.fromSquad || intent.targetFacility || intent.toFront || intent.fromFront || intent.targetRegion || "unknown";
        addMessage("warning", `目标 ${field} 不存在`, state.time, ch, undefined, "command_ack");
        setClarification("命令引用了不存在的目标，请重新描述");
        return;
      }
    }

    const allOrders: ReturnType<typeof resolveIntent>["orders"] = [];
    const reserved = new Set<number>();
    let degradedCount = 0;

    for (const intent of intents) {
      const result = resolveIntent(intent, state, state.style, reserved, selectedIdsSnapshotRef.current);
      if (result.degraded) {
        degradedCount++;
        addMessage("warning", result.log, state.time, ch, undefined, "command_ack");
      } else {
        addMessage("info", `执行: ${result.log}`, state.time, ch, undefined, "command_ack");
      }
      for (const id of result.assignedUnitIds) reserved.add(id);
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
      if (mode === "auto") {
        addMessage("info", `Copy that sir. ${cleanLabel}`, state.time, ch, undefined, "command_ack");
      } else {
        addMessage("info", `Roger. Executing ${letter}: ${cleanLabel}`, state.time, ch, undefined, "command_ack");
      }
      applyOrders(state, allOrders);

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

    setTimeout(() => {
      setResponse(null);
      setApprovedIdx(null);
      selectedIdsSnapshotRef.current = undefined;
      responseExecCtxRef.current = null;
      latestRequestIdRef.current = null;
    }, 800);
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

  return (
    <div style={panelStyle}>
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

      {/* ── Middle: Chat message flow ── */}
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

      {/* ── Bottom: Input area ── */}
      <div style={inputContainerStyle}>
        <input
          type="text"
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={isGroupChat ? "全体指令..." : `对${COMMANDER_META[selectedCommanders[0]].label}下令...`}
          disabled={loading}
          style={inputStyle}
        />
        {onCreateSquad && (
          <button
            onClick={onCreateSquad}
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
