// ============================================================
// AI Commander — Command Panel (Day 7)
// Input box → call /api/command → display A/B/C options
// Click "批准" → resolveIntent → applyOrders (clean chain)
// ============================================================

import { useState, useRef, useEffect } from "react";
import { buildDigest, resolveIntent, applyOrders, updateStyleParam, findFront } from "@ai-commander/core";
import type { GameState, AdvisorResponse, AdvisorOption } from "@ai-commander/shared";
import type { Channel } from "@ai-commander/shared";
import { addMessage, getActiveChannel, getActiveThreads, resolveThread, subscribe, type StaffThread } from "./messageStore";

const API_URL = "http://localhost:3001";

// ── Phase 1: Shared intent target validator ──
// Used by both canAutoExecute gate and handleApprove pre-validation.
// Uses findFront (alias + normalize + substring) and fuzzy region match
// so gate and execution layer agree on what's valid.

import type { Intent } from "@ai-commander/shared";

function isValidTarget(intent: Intent, state: GameState): boolean {
  // targetRegion: tags → findFront → exact region → fuzzy region
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
  // targetFacility
  if (intent.targetFacility && !state.facilities.has(intent.targetFacility)) return false;
  // toFront / fromFront — use findFront (alias table + normalize + substring)
  if (intent.toFront && !findFront(state, intent.toFront)) return false;
  if (intent.fromFront && !findFront(state, intent.fromFront)) return false;
  // fromSquad
  if (intent.fromSquad && !state.squads?.find(s => s.id === intent.fromSquad)) return false;
  return true;
}

// ── Phase 1: Deterministic auto-execute gate ──
// Replaces LLM-dependent "CLEAR/AMBIGUOUS" with hard rules.

function canAutoExecute(
  option: AdvisorOption,
  userMessage: string,
  state: GameState,
  selectedIds?: readonly number[],
): { auto: boolean; reason?: string } {
  const intents = option.intents ?? [option.intent];

  // 1. Single intent only
  if (intents.length !== 1) return { auto: false, reason: "multi_intent" };
  const intent = intents[0];

  // 2. Explicit actor anchor: squad ID (T1/I3/A2) or "selected" / 中文选中词
  //    AND the intent must actually reference the same actor.
  const squadIdsInText = (userMessage.match(/\b[TIA]\d+\b/gi) ?? []).map(s => s.toUpperCase());
  const hasSelectedAnchor = /\bselected\b/i.test(userMessage) || /选中|圈起来|这队|这支/.test(userMessage);
  const hasSquadAnchor = squadIdsInText.length > 0;

  if (!hasSquadAnchor && !hasSelectedAnchor) return { auto: false, reason: "no_anchor" };

  // Cross-check: if user named squads, intent.fromSquad must match one of them
  if (hasSquadAnchor) {
    if (!intent.fromSquad || !squadIdsInText.includes(intent.fromSquad.toUpperCase())) {
      return { auto: false, reason: "anchor_mismatch" };
    }
  }
  // Cross-check: if user said "selected" (no squad ID), intent shouldn't name a specific squad
  //   (selected-unit dispatch uses selectedIdsSnapshot, not fromSquad)
  if (hasSelectedAnchor && !hasSquadAnchor) {
    // Must actually have selected units in this command snapshot.
    if (!selectedIds || selectedIds.length === 0) return { auto: false, reason: "no_selected_units" };
    if (intent.fromSquad) return { auto: false, reason: "anchor_mismatch" };
  }

  // 3. Validate ALL structured fields (actor + target), not just target-bearing intents
  if (!isValidTarget(intent, state)) return { auto: false, reason: "invalid_intent_fields" };

  // 4. Not high-impact action (quantity=all/most + attack/sabotage)
  const qty = intent.quantity;
  const isHighImpact = (qty === "all" || qty === "most") &&
    (intent.type === "attack" || intent.type === "sabotage");
  if (isHighImpact) return { auto: false, reason: "high_impact" };

  // 5. No mission conflict: fromSquad with active mission → no auto
  if (intent.fromSquad) {
    const squad = state.squads?.find(s => s.id === intent.fromSquad);
    if (squad?.currentMission !== null) return { auto: false, reason: "mission_conflict" };
  }

  return { auto: true };
}

// ── Day 16B: Context Memory ──
// Keeps recent command/response pairs per channel so the LLM sees conversation history.

const MAX_CONTEXT_ENTRIES = 3;
const MAX_CONTEXT_CHARS = 600;

interface ContextEntry {
  role: "user" | "assistant";
  text: string;
  time: number; // game time
}

type ChannelContext = Record<Channel, ContextEntry[]>;

function createEmptyChannelContext(): ChannelContext {
  return { ops: [], logistics: [], combat: [] };
}

function pushContext(ctx: ChannelContext, channel: Channel, entry: ContextEntry): void {
  const arr = ctx[channel];
  arr.push(entry);
  // Trim to MAX_CONTEXT_ENTRIES
  while (arr.length > MAX_CONTEXT_ENTRIES * 2) arr.shift(); // *2 for user+assistant pairs
  // Trim to MAX_CONTEXT_CHARS total
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

export function CommandPanel({ getState, getSelectedUnitIds, onCreateSquad, canCreateSquad, onDeclareWar }: Props) {
  const [message, setMessage] = useState("");
  const [loading, setLoading] = useState(false);
  const [response, setResponse] = useState<DisplayResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [approvedIdx, setApprovedIdx] = useState<number | null>(null);

  // P1: snapshot selected unit IDs at sendCommand time, use in handleApprove
  const selectedIdsSnapshotRef = useRef<number[] | undefined>(undefined);

  // Fix #2: execution context bound to each response (replaces channelSnapshotRef)
  type ExecContext = { channel: Channel; threadId?: string };
  const responseExecCtxRef = useRef<ExecContext | null>(null);

  // Day 16B: per-channel context memory
  const channelContextRef = useRef<ChannelContext>(createEmptyChannelContext());

  // Phase 3: active staff threads (subscribe to messageStore changes)
  const [activeThreads, setActiveThreads] = useState<StaffThread[]>([]);

  // Fix #1 + #3: atomic thread execution lock (ref = sync guard, state = UI only)
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
  useEffect(() => {
    const update = () => setActiveThreads(getActiveThreads());
    update();
    return subscribe(update);
  }, []);

  // P2: poll canCreateSquad every 200ms for button state
  const [squadBtnEnabled, setSquadBtnEnabled] = useState(false);
  useEffect(() => {
    if (!canCreateSquad) return;
    const id = setInterval(() => setSquadBtnEnabled(canCreateSquad()), 200);
    return () => clearInterval(id);
  }, [canCreateSquad]);

  // Day 13 P3-6: style visibility — poll style params at low frequency
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
    }, 1000); // 1Hz — low overhead
    return () => clearInterval(id);
  }, [getState]);

  // Day 12: poll war declaration eligibility + clear panel on game over
  // Day 16B: also detect restart (time resets) → clear context memory
  const lastSeenTimeRef = useRef(0);
  const [canDeclareWar, setCanDeclareWar] = useState(false);
  useEffect(() => {
    const id = setInterval(() => {
      const s = getState();
      setCanDeclareWar(!!s && s.phase === "CONFLICT" && !s.warDeclared && !s.gameOver);
      // Clear stale advisor response when game ends
      if (s?.gameOver && response) {
        setResponse(null);
        setApprovedIdx(null);
        setClarification(null);
      }
      // Day 16B: detect restart (time went backward) → clear context
      if (s && s.time < lastSeenTimeRef.current - 5) {
        channelContextRef.current = createEmptyChannelContext();
      }
      if (s) lastSeenTimeRef.current = s.time;
    }, 200);
    return () => clearInterval(id);
  }, [getState, response]);

  // Phase 3: handle approving a staff thread option (same flow as handleApprove but resolves thread)
  // Fix #1: try/finally guarantees unlock on every code path (including invalid target early return)
  // Fix #3: tryLockThread uses ref (sync), not state (async), so double-click can't slip through
  const handleThreadApprove = (thread: StaffThread, opt: AdvisorOption, idx: number) => {
    if (thread.status !== "open") return;
    if (!tryLockThread(thread.id)) return;

    try {
      const state = getState();
      if (!state) return;

      const letter = ["A", "B", "C"][idx] ?? "?";
      const cleanLabel = opt.label.replace(/^[ABC]:\s*/, '');
      const intents = opt.intents ?? [opt.intent];

      // Pre-validate structured fields
      for (const intent of intents) {
        if (!isValidTarget(intent, state)) {
          const field = intent.fromSquad || intent.targetFacility || intent.toFront || intent.fromFront || intent.targetRegion || "unknown";
          addMessage("warning", `目标 ${field} 不存在`, state.time, thread.channel);
          return; // finally will unlock
        }
      }

      // Resolve intents to orders
      const allOrders: ReturnType<typeof resolveIntent>["orders"] = [];
      const reserved = new Set<number>();

      for (const intent of intents) {
        const result = resolveIntent(intent, state, state.style, reserved);
        if (result.degraded) {
          addMessage("warning", result.log, state.time, thread.channel);
        } else {
          addMessage("info", `执行: ${result.log}`, state.time, thread.channel);
        }
        for (const id of result.assignedUnitIds) reserved.add(id);
        allOrders.push(...result.orders);
      }

      if (allOrders.length > 0) {
        addMessage("info", `Roger. Executing ${letter}: ${cleanLabel}`, state.time, thread.channel);
        applyOrders(state, allOrders);
        resolveThread(thread.id);
      }
    } finally {
      unlockThread(thread.id);
    }
  };

  const sendCommand = async () => {
    const state = getState();
    if (!state || !message.trim()) return;

    const userMsg = message.trim();
    setLoading(true);
    setError(null);
    setApprovedIdx(null);
    setClarification(null);
    // Fix #2: clear stale response context so old buttons can't act on wrong channel
    setResponse(null);
    responseExecCtxRef.current = null;

    // Day 16B fix: snapshot active channel at send time (avoid mid-request tab switch)
    const ch = getActiveChannel();

    addMessage("info", `发送指令: ${userMsg}`, state.time, ch);

    // P1: lock selected unit IDs at send time
    const selectedIds = getSelectedUnitIds ? [...getSelectedUnitIds()] : [];
    selectedIdsSnapshotRef.current = selectedIds.length > 0 ? selectedIds : undefined;

    // Phase 3: if there's an active thread on this channel, include thread context in digest
    const activeThreadOnChannel = activeThreads.find(t => t.channel === ch);
    const threadContext = activeThreadOnChannel
      ? `\n---ACTIVE_THREAD---\n[${activeThreadOnChannel.eventType}] ${activeThreadOnChannel.eventMessage}\nStaff brief: ${activeThreadOnChannel.brief}`
      : "";

    const baseDigest = buildDigest(state, selectedIds, [], []);
    const contextSuffix = formatContext(channelContextRef.current, ch);
    const digest = baseDigest + contextSuffix + threadContext;
    const styleNote = `risk=${state.style.riskTolerance.toFixed(2)} focus=${state.style.focusFireBias.toFixed(2)} obj=${state.style.objectiveBias.toFixed(2)} cas=${state.style.casualtyAversion.toFixed(2)}`;

    // Push user message to context memory (bound to snapshotted channel)
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
        addMessage("urgent", `后端错误: ${data.error}`, state.time, ch);
      } else if (typeof data.responseType === "string" && data.responseType.toUpperCase() === "NOOP") {
        // Phase 2: NOOP — conversational response, no execution.
        // Must come BEFORE options.length===0 clarification branch.
        setResponse(null);
        setError(null);
        setClarification(null);
        const msg = data.brief || "Copy, standing by.";
        addMessage("info", msg, state.time, ch);
        if (data.brief) {
          pushContext(channelContextRef.current, ch, { role: "assistant", text: data.brief, time: state.time });
        }
      } else if (Array.isArray(data.options) && data.options.length === 0) {
        // Day 13 Layer B: LLM rejected command (invalid target / nonsensical)
        // (responseType is NOT "NOOP" here — that case is handled above)
        setResponse(null);
        setError(null);
        const reason = data.brief || "命令目标不存在或不明确";
        setClarification(reason + " — 请重新描述指令");
        addMessage("warning", reason, state.time, ch);
      } else {
        // Day 16B: push assistant brief to context memory (use snapshotted ch)
        if (data.brief) {
          pushContext(channelContextRef.current, ch, { role: "assistant", text: data.brief, time: state.time });
        }

        // Phase 1: deterministic auto-execute gate
        const gate = (Array.isArray(data.options) && data.options.length >= 1)
          ? canAutoExecute(data.options[0], userMsg, state, selectedIds)
          : { auto: false };

        // Fix #2: build execution context bound to this specific response
        const execCtx: ExecContext = { channel: ch, threadId: activeThreadOnChannel?.id };

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
          addMessage("info", "Advisor briefing received", state.time, ch);
        }
      }
    } catch {
      const errMsg = "无法连接服务器，请确保后端运行在 localhost:3001";
      setError(errMsg);
      setResponse(null);
      selectedIdsSnapshotRef.current = undefined;
      addMessage("urgent", "通信中断: 无法连接后端", state.time, ch);
    }
    setLoading(false);
    setMessage("");
  };

  // Day 13: clarification guard state
  const [clarification, setClarification] = useState<string | null>(null);

  const handleApprove = (opt: AdvisorOption, idx: number, mode: "auto" | "manual" = "manual", ctx?: ExecContext) => {
    const state = getState();
    if (!state) return;

    // Fix #2: use bound execution context (from sendCommand), not current tab
    const execCtx = ctx ?? responseExecCtxRef.current;
    const ch = execCtx?.channel ?? getActiveChannel();

    const letter = ["A", "B", "C"][idx] ?? "?";
    const cleanLabel = opt.label.replace(/^[ABC]:\s*/, '');

    // Multi-intent chain: loop intents with reserved unit set
    const intents = opt.intents ?? [opt.intent];

    // Pre-validate structured fields via shared isValidTarget
    for (const intent of intents) {
      if (!isValidTarget(intent, state)) {
        const field = intent.fromSquad || intent.targetFacility || intent.toFront || intent.fromFront || intent.targetRegion || "unknown";
        addMessage("warning", `目标 ${field} 不存在`, state.time, ch);
        setClarification("命令引用了不存在的目标，请重新描述");
        return;
      }
    }

    // Resolve intents to orders
    const allOrders: ReturnType<typeof resolveIntent>["orders"] = [];
    const reserved = new Set<number>();
    let degradedCount = 0;

    for (const intent of intents) {
      const result = resolveIntent(intent, state, state.style, reserved, selectedIdsSnapshotRef.current);

      if (result.degraded) {
        degradedCount++;
        addMessage("warning", result.log, state.time, ch);
      } else {
        addMessage("info", `执行: ${result.log}`, state.time, ch);
      }

      // Add assigned units to reserved set for next intent
      for (const id of result.assignedUnitIds) {
        reserved.add(id);
      }

      allOrders.push(...result.orders);
    }

    // Day 13 Clarification Guard: if ALL intents degraded → don't execute, show prompt
    if (allOrders.length === 0 && degradedCount > 0) {
      addMessage("warning", "命令无法执行，请重新描述", state.time, ch);
      setClarification("命令不明确，请重述（示例：'北线全部坦克进攻桥头'）");
      setApprovedIdx(idx);
      setTimeout(() => {
        setApprovedIdx(null);
      }, 400);
      return;
    }

    // Confirmation message — only after we know orders succeeded
    if (allOrders.length > 0) {
      if (mode === "auto") {
        addMessage("info", `Copy that sir. ${cleanLabel}`, state.time, ch);
      } else {
        addMessage("info", `Roger. Executing ${letter}: ${cleanLabel}`, state.time, ch);
      }
      applyOrders(state, allOrders);

      // Phase 3: resolve bound thread after successful execution
      if (execCtx?.threadId) {
        resolveThread(execCtx.threadId);
      }
    }

    // Day 13 P3-6: Style learning — nudge params based on approved option
    if (allOrders.length > 0) {
      // High risk chosen → increase riskTolerance
      if (opt.risk > 0.6) updateStyleParam(state.style, "riskTolerance", 1);
      else if (opt.risk < 0.3) updateStyleParam(state.style, "riskTolerance", -1);
      // High reward chosen → increase objectiveBias
      if (opt.reward > 0.6) updateStyleParam(state.style, "objectiveBias", 1);
      else if (opt.reward < 0.3) updateStyleParam(state.style, "objectiveBias", -1);
      // If user picks non-recommended → slight casualtyAversion signal
      const letter = ["A", "B", "C"][idx];
      if (response && letter !== response.recommended) {
        updateStyleParam(state.style, "casualtyAversion", 1);
      }
    }

    setClarification(null);
    setApprovedIdx(idx);

    // Auto-dismiss after brief delay so user sees the highlight
    setTimeout(() => {
      setResponse(null);
      setApprovedIdx(null);
      selectedIdsSnapshotRef.current = undefined;
      responseExecCtxRef.current = null;
    }, 800);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    // Prevent game controls (WASD etc) when typing
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
  };

  return (
    <div style={panelStyle}>
      {/* Response area */}
      {response && (
        <div style={responseStyle}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <div style={briefStyle}>{response.brief}</div>
            <button onClick={dismiss} style={dismissBtn} title="关闭">x</button>
          </div>

          <div style={optionsContainerStyle}>
            {response.options.map((opt, i) => {
              const letter = ["A", "B", "C"][i];
              const isRecommended = response.recommended === letter;
              const isApproved = approvedIdx === i;
              return (
                <div
                  key={i}
                  style={{
                    ...optionStyle,
                    borderColor: isApproved
                      ? "#22c55e"
                      : isRecommended
                        ? "#4ade80"
                        : "#334155",
                    background: isApproved
                      ? "rgba(34, 197, 94, 0.15)"
                      : "rgba(15, 23, 42, 0.8)",
                  }}
                >
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                    <span style={{ fontWeight: "bold", color: "#e2e8f0" }}>{opt.label}</span>
                    {isRecommended && <span style={recommendedBadge}>推荐</span>}
                  </div>
                  <div style={{ fontSize: 11, color: "#94a3b8", marginTop: 4 }}>{opt.description}</div>
                  <div style={{ display: "flex", gap: 8, marginTop: 4, fontSize: 10, color: "#64748b" }}>
                    <span style={{ display: "flex", alignItems: "center", gap: 2 }}>
                      风险
                      <span style={{ ...barBg }}><span style={{ ...barFill, width: `${opt.risk * 100}%`, background: opt.risk > 0.6 ? "#ef4444" : "#f59e0b" }} /></span>
                    </span>
                    <span style={{ display: "flex", alignItems: "center", gap: 2 }}>
                      收益
                      <span style={{ ...barBg }}><span style={{ ...barFill, width: `${opt.reward * 100}%`, background: "#22c55e" }} /></span>
                    </span>
                  </div>
                  {(opt.intents ?? [opt.intent]).map((it, j) => (
                    <div key={j} style={{ fontSize: 10, color: "#475569", marginTop: 2 }}>
                      [{it.type}]{it.unitType ? ` ${it.unitType}` : ""}{it.urgency ? ` ${it.urgency}` : ""}
                    </div>
                  ))}
                  {/* Approve button */}
                  <button
                    onClick={() => handleApprove(opt, i)}
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
          </div>

          {response.warning && (
            <div style={warningStyle}>{response.warning}</div>
          )}
        </div>
      )}

      {error && <div style={errorStyle}>{error}</div>}

      {/* Day 13: Clarification prompt */}
      {clarification && (
        <div style={clarificationStyle}>{clarification}</div>
      )}

      {/* Phase 3: Active staff threads with decision options */}
      {activeThreads.length > 0 && !response && activeThreads.map((thread) => (
        <div key={thread.id} style={threadStyle}>
          <div style={{ fontSize: 10, color: "#f59e0b", marginBottom: 4 }}>
            ⚠ {thread.eventType} — {thread.brief}
          </div>
          {thread.options && thread.options.length > 0 && (
            <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              {thread.options.map((opt, i) => {
                const letter = ["A", "B", "C"][i];
                return (
                  <div key={i} style={threadOptionStyle}>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                      <span style={{ fontWeight: "bold", color: "#e2e8f0", fontSize: 11 }}>{opt.label}</span>
                      <button
                        onClick={() => handleThreadApprove(thread, opt, i)}
                        disabled={executingThreadId === thread.id}
                        style={{
                          ...threadApproveBtnStyle,
                          opacity: executingThreadId === thread.id ? 0.4 : 1,
                        }}
                      >
                        {letter}
                      </button>
                    </div>
                    <div style={{ fontSize: 10, color: "#94a3b8", marginTop: 2 }}>{opt.description}</div>
                  </div>
                );
              })}
            </div>
          )}
          <div style={{ fontSize: 9, color: "#475569", marginTop: 4 }}>
            Expires in {Math.max(0, Math.floor(thread.expiresAt - (getState()?.time ?? 0)))}s
          </div>
        </div>
      ))}

      {/* Day 13 P3-6: Compact style indicator */}
      {styleSnapshot && (
        <div style={styleRowStyle}>
          <button onClick={() => setShowStyle(!showStyle)} style={styleToggleBtn} title="指挥风格参数">
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

      {/* Input area */}
      <div style={inputContainerStyle}>
        <input
          type="text"
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="输入指令... (例: 北线撤退)"
          disabled={loading}
          style={inputStyle}
        />
        {onCreateSquad && (
          <button
            onClick={onCreateSquad}
            disabled={!squadBtnEnabled}
            style={{
              ...squadBtnStyle,
              opacity: squadBtnEnabled ? 1 : 0.35,
              cursor: squadBtnEnabled ? "pointer" : "default",
            }}
            title={squadBtnEnabled ? "将选中单位编为分队" : "请先框选未编队的单位"}
          >
            编队
          </button>
        )}
        {onDeclareWar && canDeclareWar && (
          <button
            onClick={onDeclareWar}
            style={warBtnStyle}
            title="向敌方宣战，进入全面战争阶段"
          >
            宣战
          </button>
        )}
        <button
          onClick={sendCommand}
          disabled={loading || !message.trim()}
          style={{
            ...buttonStyle,
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
  bottom: 12,
  left: 12,
  width: 340,
  background: "rgba(22, 33, 62, 0.95)",
  border: "1px solid #0f3460",
  borderRadius: 6,
  padding: 10,
  fontFamily: "monospace",
  fontSize: 12,
  color: "#a0c4ff",
  zIndex: 100,
  pointerEvents: "auto",
};

const responseStyle: React.CSSProperties = {
  marginBottom: 8,
  maxHeight: 360,
  overflowY: "auto",
};

const briefStyle: React.CSSProperties = {
  color: "#fbbf24",
  fontWeight: "bold",
  fontSize: 12,
  marginBottom: 8,
  flex: 1,
};

const dismissBtn: React.CSSProperties = {
  background: "none",
  border: "none",
  color: "#64748b",
  cursor: "pointer",
  fontSize: 14,
  padding: "0 4px",
  lineHeight: 1,
};

const optionsContainerStyle: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 6,
};

const optionStyle: React.CSSProperties = {
  background: "rgba(15, 23, 42, 0.8)",
  border: "1px solid #334155",
  borderRadius: 4,
  padding: "6px 8px",
};

const recommendedBadge: React.CSSProperties = {
  fontSize: 9,
  background: "#166534",
  color: "#4ade80",
  padding: "1px 5px",
  borderRadius: 3,
  fontWeight: "bold",
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

const warningStyle: React.CSSProperties = {
  color: "#f59e0b",
  fontSize: 10,
  marginTop: 6,
  padding: "4px 6px",
  background: "rgba(245, 158, 11, 0.1)",
  borderRadius: 3,
};

const errorStyle: React.CSSProperties = {
  color: "#ef4444",
  fontSize: 11,
  marginBottom: 6,
  padding: "4px 6px",
  background: "rgba(239, 68, 68, 0.1)",
  borderRadius: 3,
};

const clarificationStyle: React.CSSProperties = {
  color: "#fbbf24",
  fontSize: 11,
  marginBottom: 6,
  padding: "6px 8px",
  background: "rgba(251, 191, 36, 0.12)",
  border: "1px solid rgba(251, 191, 36, 0.3)",
  borderRadius: 4,
};

const inputContainerStyle: React.CSSProperties = {
  display: "flex",
  gap: 6,
};

const inputStyle: React.CSSProperties = {
  flex: 1,
  background: "#0f172a",
  border: "1px solid #334155",
  borderRadius: 4,
  padding: "6px 8px",
  color: "#e2e8f0",
  fontSize: 12,
  fontFamily: "monospace",
  outline: "none",
};

const buttonStyle: React.CSSProperties = {
  background: "#1e40af",
  color: "#e2e8f0",
  border: "none",
  borderRadius: 4,
  padding: "6px 12px",
  fontSize: 12,
  fontFamily: "monospace",
  cursor: "pointer",
};

const squadBtnStyle: React.CSSProperties = {
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

const approveBtnStyle: React.CSSProperties = {
  marginTop: 6,
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

// Day 13 P3-6: Style visibility styles
const styleRowStyle: React.CSSProperties = {
  marginBottom: 6,
  fontSize: 10,
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

// Phase 3: Staff thread styles

const threadStyle: React.CSSProperties = {
  marginBottom: 8,
  padding: "8px 10px",
  background: "rgba(245, 158, 11, 0.08)",
  border: "1px solid rgba(245, 158, 11, 0.3)",
  borderRadius: 4,
};

const threadOptionStyle: React.CSSProperties = {
  background: "rgba(15, 23, 42, 0.6)",
  border: "1px solid #334155",
  borderRadius: 3,
  padding: "4px 6px",
};

const threadApproveBtnStyle: React.CSSProperties = {
  background: "#1e3a5f",
  color: "#60a5fa",
  border: "1px solid #2563eb",
  borderRadius: 3,
  padding: "2px 8px",
  fontSize: 10,
  fontFamily: "monospace",
  fontWeight: "bold",
  cursor: "pointer",
};
