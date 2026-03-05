// ============================================================
// AI Commander — Staff Message Feed (Day 7)
// Scrolling feed: info / warning / urgent, top-right corner
// ============================================================

import { useEffect, useState, useRef } from "react";
import {
  getMessages,
  subscribe,
  type FeedMessage,
  type MessageLevel,
} from "./messageStore";

const LEVEL_COLORS: Record<MessageLevel, string> = {
  info: "#60a5fa",
  warning: "#f59e0b",
  urgent: "#ef4444",
};

const LEVEL_LABELS: Record<MessageLevel, string> = {
  info: "INFO",
  warning: "WARN",
  urgent: "CRIT",
};

function formatTime(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

export function MessageFeed() {
  const [messages, setMessages] = useState<readonly FeedMessage[]>(
    getMessages(),
  );
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    return subscribe(() => {
      setMessages([...getMessages()]);
    });
  }, []);

  // Auto-scroll to bottom on new messages
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages.length]);

  return (
    <div style={panelStyle}>
      <div style={headerStyle}>STAFF FEED</div>
      <div ref={scrollRef} style={scrollStyle}>
        {messages.length === 0 && (
          <div style={{ color: "#475569", fontSize: 11, padding: "8px 0" }}>
            等待指令...
          </div>
        )}
        {messages.map((msg) => (
          <div key={msg.id} style={messageRowStyle}>
            <span style={timeStyle}>{formatTime(msg.time)}</span>
            <span
              style={{
                ...badgeStyle,
                color: LEVEL_COLORS[msg.level],
                background: `${LEVEL_COLORS[msg.level]}18`,
                borderColor: `${LEVEL_COLORS[msg.level]}40`,
              }}
            >
              {LEVEL_LABELS[msg.level]}
            </span>
            <span style={textStyle}>{msg.text}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Styles ──

const panelStyle: React.CSSProperties = {
  position: "absolute",
  top: 8,
  right: 12,
  width: 300,
  maxHeight: 260,
  background: "rgba(22, 33, 62, 0.92)",
  border: "1px solid #0f3460",
  borderRadius: 6,
  fontFamily: "monospace",
  zIndex: 100,
  pointerEvents: "auto",
  display: "flex",
  flexDirection: "column",
};

const headerStyle: React.CSSProperties = {
  padding: "5px 10px",
  fontSize: 10,
  fontWeight: "bold",
  color: "#64748b",
  letterSpacing: 1,
  borderBottom: "1px solid #0f3460",
};

const scrollStyle: React.CSSProperties = {
  flex: 1,
  overflowY: "auto",
  padding: "2px 8px",
  maxHeight: 220,
};

const messageRowStyle: React.CSSProperties = {
  padding: "3px 0",
  borderBottom: "1px solid rgba(15, 52, 96, 0.3)",
  display: "flex",
  alignItems: "baseline",
  gap: 4,
};

const timeStyle: React.CSSProperties = {
  color: "#475569",
  fontSize: 10,
  flexShrink: 0,
};

const badgeStyle: React.CSSProperties = {
  fontSize: 8,
  padding: "0 3px",
  borderRadius: 2,
  border: "1px solid",
  fontWeight: "bold",
  flexShrink: 0,
};

const textStyle: React.CSSProperties = {
  color: "#cbd5e1",
  fontSize: 11,
  wordBreak: "break-all",
};
