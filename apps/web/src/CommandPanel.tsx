// ============================================================
// AI Commander — Command Panel (Day 7)
// Input box → call /api/command → display A/B/C options
// Click "批准" → resolveIntent → applyOrders (clean chain)
// ============================================================

import { useState, useRef, useEffect } from "react";
import { buildDigest, resolveIntent, applyOrders, updateStyleParam, findFront } from "@ai-commander/core";
import type { GameState, AdvisorResponse, AdvisorOption } from "@ai-commander/shared";
import { addMessage } from "./messageStore";

const API_URL = "http://localhost:3001";

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
    }, 200);
    return () => clearInterval(id);
  }, [getState, response]);

  const sendCommand = async () => {
    const state = getState();
    if (!state || !message.trim()) return;

    const userMsg = message.trim();
    setLoading(true);
    setError(null);
    setApprovedIdx(null);
    setClarification(null);

    addMessage("info", `发送指令: ${userMsg}`, state.time);

    // P1: lock selected unit IDs at send time
    const selectedIds = getSelectedUnitIds ? [...getSelectedUnitIds()] : [];
    selectedIdsSnapshotRef.current = selectedIds.length > 0 ? selectedIds : undefined;
    const digest = buildDigest(state, selectedIds, [], []);
    const styleNote = `risk=${state.style.riskTolerance.toFixed(2)} focus=${state.style.focusFireBias.toFixed(2)} obj=${state.style.objectiveBias.toFixed(2)} cas=${state.style.casualtyAversion.toFixed(2)}`;

    try {
      const res = await fetch(`${API_URL}/api/command`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ digest, message: userMsg, styleNote }),
      });

      const data = await res.json();
      if (data.error) {
        setError(data.error);
        setResponse(null);
        selectedIdsSnapshotRef.current = undefined;
        addMessage("urgent", `后端错误: ${data.error}`, state.time);
      } else if (Array.isArray(data.options) && data.options.length === 0) {
        // Day 13 Layer B: LLM rejected command (invalid target / nonsensical)
        setResponse(null);
        setError(null);
        const reason = data.brief || "命令目标不存在或不明确";
        setClarification(reason + " — 请重新描述指令");
        addMessage("warning", reason, state.time);
      } else {
        setResponse(data as DisplayResponse);
        setError(null);
        addMessage("info", "收到参谋简报", state.time);
      }
    } catch {
      const errMsg = "无法连接服务器，请确保后端运行在 localhost:3001";
      setError(errMsg);
      setResponse(null);
      selectedIdsSnapshotRef.current = undefined;
      addMessage("urgent", "通信中断: 无法连接后端", state.time);
    }
    setLoading(false);
    setMessage("");
  };

  // Day 13: clarification guard state
  const [clarification, setClarification] = useState<string | null>(null);

  const handleApprove = (opt: AdvisorOption, idx: number) => {
    const state = getState();
    if (!state) return;

    const letter = ["A", "B", "C"][idx] ?? "?";

    // Multi-intent chain: loop intents with reserved unit set
    const intents = opt.intents ?? [opt.intent];

    // Day 14 Layer B Gate: pre-validate structured fields before resolveIntent
    // Uses findFront from tacticalPlanner directly (alias table + normalize + substring)
    for (const intent of intents) {
      if (intent.fromSquad && !state.squads?.find(s => s.id === intent.fromSquad)) {
        addMessage("warning", `分队 ${intent.fromSquad} 不存在`, state.time);
        setClarification("命令引用了不存在的分队，请重新描述");
        return;
      }
      if (intent.targetFacility && !state.facilities.has(intent.targetFacility)) {
        addMessage("warning", `设施 ${intent.targetFacility} 不存在`, state.time);
        setClarification("命令引用了不存在的设施，请重新描述");
        return;
      }
      if (intent.toFront && !findFront(state, intent.toFront)) {
        addMessage("warning", `战线 ${intent.toFront} 不存在`, state.time);
        setClarification("命令引用了不存在的战线，请重新描述");
        return;
      }
      if (intent.fromFront && !findFront(state, intent.fromFront)) {
        addMessage("warning", `战线 ${intent.fromFront} 不存在`, state.time);
        setClarification("命令引用了不存在的战线，请重新描述");
        return;
      }
      // Stage C: targetRegion validation (tags, fronts, regions)
      if (intent.targetRegion) {
        const isTag = state.tags?.some(t => t.id === intent.targetRegion);
        const isFront = !!findFront(state, intent.targetRegion);
        const isRegion = state.regions.has(intent.targetRegion);
        // Also check fuzzy region name match (mirrors tacticalPlanner.getRegionCenter)
        const isRegionFuzzy = !isRegion && (() => {
          const lower = intent.targetRegion!.toLowerCase();
          for (const [, r] of state.regions) {
            if (r.id.toLowerCase().includes(lower) || r.name.toLowerCase().includes(lower)) return true;
          }
          return false;
        })();
        if (!isTag && !isFront && !isRegion && !isRegionFuzzy) {
          addMessage("warning", `目标区域 ${intent.targetRegion} 不存在`, state.time);
          setClarification("命令引用了不存在的目标区域，请重新描述");
          return;
        }
      }
    }

    // Gate passed — log approval
    addMessage("info", `批准方案 ${letter}: ${opt.label}`, state.time);
    const allOrders: ReturnType<typeof resolveIntent>["orders"] = [];
    const reserved = new Set<number>();
    let degradedCount = 0;

    for (const intent of intents) {
      const result = resolveIntent(intent, state, state.style, reserved, selectedIdsSnapshotRef.current);

      if (result.degraded) {
        degradedCount++;
        addMessage("warning", result.log, state.time);
      } else {
        addMessage("info", `执行: ${result.log}`, state.time);
      }

      // Add assigned units to reserved set for next intent
      for (const id of result.assignedUnitIds) {
        reserved.add(id);
      }

      allOrders.push(...result.orders);
    }

    // Day 13 Clarification Guard: if ALL intents degraded → don't execute, show prompt
    if (allOrders.length === 0 && degradedCount > 0) {
      addMessage("warning", "命令无法执行，请重新描述", state.time);
      setClarification("命令不明确，请重述（示例：'北线全部坦克进攻桥头'）");
      setApprovedIdx(idx);
      // Don't auto-dismiss — let user see clarification and re-type
      setTimeout(() => {
        setApprovedIdx(null);
      }, 400);
      return;
    }

    if (allOrders.length > 0) {
      applyOrders(state, allOrders);
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
