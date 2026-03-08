// ============================================================
// AI Commander — Command Panel (Day 7)
// Input box → call /api/command → display A/B/C options
// Click "批准" → resolveIntent → applyOrders (clean chain)
// ============================================================

import { useState } from "react";
import { buildDigest, resolveIntent, applyOrders } from "@ai-commander/core";
import type { GameState, AdvisorResponse, AdvisorOption } from "@ai-commander/shared";
import { addMessage } from "./messageStore";

const API_URL = "http://localhost:3001";

interface Props {
  getState: () => GameState | null;
}

interface DisplayResponse extends AdvisorResponse {
  warning?: string;
}

export function CommandPanel({ getState }: Props) {
  const [message, setMessage] = useState("");
  const [loading, setLoading] = useState(false);
  const [response, setResponse] = useState<DisplayResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [approvedIdx, setApprovedIdx] = useState<number | null>(null);

  const sendCommand = async () => {
    const state = getState();
    if (!state || !message.trim()) return;

    const userMsg = message.trim();
    setLoading(true);
    setError(null);
    setApprovedIdx(null);

    addMessage("info", `发送指令: ${userMsg}`, state.time);

    const digest = buildDigest(state, [], [], []);
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
        addMessage("urgent", `后端错误: ${data.error}`, state.time);
      } else {
        setResponse(data as DisplayResponse);
        setError(null);
        addMessage("info", "收到参谋简报", state.time);
      }
    } catch {
      const errMsg = "无法连接服务器，请确保后端运行在 localhost:3001";
      setError(errMsg);
      setResponse(null);
      addMessage("urgent", "通信中断: 无法连接后端", state.time);
    }
    setLoading(false);
    setMessage("");
  };

  const handleApprove = (opt: AdvisorOption, idx: number) => {
    const state = getState();
    if (!state) return;

    const letter = ["A", "B", "C"][idx] ?? "?";
    addMessage("info", `批准方案 ${letter}: ${opt.label}`, state.time);

    // Multi-intent chain: loop intents with reserved unit set
    const intents = opt.intents ?? [opt.intent];
    const allOrders: ReturnType<typeof resolveIntent>["orders"] = [];
    const reserved = new Set<number>();

    for (const intent of intents) {
      const result = resolveIntent(intent, state, state.style, reserved);

      if (result.degraded) {
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

    if (allOrders.length > 0) {
      applyOrders(state, allOrders);
    } else {
      addMessage("warning", "无可执行命令", state.time);
    }

    setApprovedIdx(idx);

    // Auto-dismiss after brief delay so user sees the highlight
    setTimeout(() => {
      setResponse(null);
      setApprovedIdx(null);
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
