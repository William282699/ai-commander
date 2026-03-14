// ============================================================
// AI Commander — Staff Message Feed (Day 7 + Day 16B)
// Scrolling feed with 3-channel tabs: ops / logistics / combat
// ============================================================

import { useEffect, useState, useRef } from "react";
import {
  getMessagesByChannel,
  getActiveChannel,
  setActiveChannel,
  getMessages,
  subscribe,
  type FeedMessage,
  type MessageLevel,
} from "./messageStore";
import type { Channel } from "@ai-commander/shared";
import { CHANNEL_LABELS } from "@ai-commander/shared";

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

const CHANNELS: Channel[] = ["ops", "logistics", "combat"];

function formatTime(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

export function MessageFeed() {
  const [messages, setMessages] = useState<readonly FeedMessage[]>([]);
  const [activeChannel, setActiveLocal] = useState<Channel>(getActiveChannel());
  const scrollRef = useRef<HTMLDivElement>(null);

  // Track last-read message id per channel for unread dots
  const lastReadRef = useRef<Record<Channel, number>>({
    ops: 0, logistics: 0, combat: 0,
  });
  const [unread, setUnread] = useState<Record<Channel, boolean>>({
    ops: false, logistics: false, combat: false,
  });

  useEffect(() => {
    return subscribe(() => {
      const ch = getActiveChannel();
      setActiveLocal(ch);
      const allMsgs = getMessages();

      // Reset unread/read cursors when feed was cleared (e.g. new game restart).
      if (allMsgs.length === 0) {
        lastReadRef.current = { ops: 0, logistics: 0, combat: 0 };
        setUnread({ ops: false, logistics: false, combat: false });
        setMessages([]);
        return;
      }

      setMessages([...getMessagesByChannel(ch)]);

      // Update unread indicators
      const newUnread: Record<Channel, boolean> = { ops: false, logistics: false, combat: false };
      for (const c of CHANNELS) {
        if (c === ch) continue; // current channel is "read"
        const chMsgs = allMsgs.filter((m) => m.channel === c);
        const lastId = chMsgs.length > 0 ? chMsgs[chMsgs.length - 1].id : 0;
        newUnread[c] = lastId > lastReadRef.current[c];
      }
      setUnread(newUnread);

      // Mark current channel as read
      const currentMsgs = allMsgs.filter((m) => m.channel === ch);
      if (currentMsgs.length > 0) {
        lastReadRef.current[ch] = currentMsgs[currentMsgs.length - 1].id;
      }
    });
  }, []);

  // Also refresh on initial mount
  useEffect(() => {
    setMessages([...getMessagesByChannel(activeChannel)]);
  }, [activeChannel]);

  // Auto-scroll to bottom on new messages
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages.length]);

  const switchChannel = (ch: Channel) => {
    setActiveChannel(ch);
    setActiveLocal(ch);
    setMessages([...getMessagesByChannel(ch)]);
    // Mark as read
    const allMsgs = getMessages();
    const chMsgs = allMsgs.filter((m) => m.channel === ch);
    if (chMsgs.length > 0) {
      lastReadRef.current[ch] = chMsgs[chMsgs.length - 1].id;
    }
    setUnread((prev) => ({ ...prev, [ch]: false }));
  };

  return (
    <div style={panelStyle}>
      <div style={headerStyle}>
        <span>STAFF FEED</span>
      </div>
      {/* Channel tabs */}
      <div style={tabBarStyle}>
        {CHANNELS.map((ch) => (
          <button
            key={ch}
            onClick={() => switchChannel(ch)}
            style={{
              ...tabStyle,
              color: ch === activeChannel ? "#60a5fa" : "#64748b",
              borderBottom: ch === activeChannel ? "2px solid #60a5fa" : "2px solid transparent",
            }}
          >
            {CHANNEL_LABELS[ch]}
            {unread[ch] && <span style={unreadDotStyle}>●</span>}
          </button>
        ))}
      </div>
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
  maxHeight: 280,
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
};

const tabBarStyle: React.CSSProperties = {
  display: "flex",
  borderBottom: "1px solid #0f3460",
  padding: "0 6px",
};

const tabStyle: React.CSSProperties = {
  flex: 1,
  background: "none",
  border: "none",
  fontFamily: "monospace",
  fontSize: 10,
  fontWeight: "bold",
  padding: "4px 0",
  cursor: "pointer",
  textAlign: "center",
  position: "relative",
};

const unreadDotStyle: React.CSSProperties = {
  color: "#f59e0b",
  fontSize: 8,
  marginLeft: 2,
  verticalAlign: "super",
};

const scrollStyle: React.CSSProperties = {
  flex: 1,
  overflowY: "auto",
  padding: "2px 8px",
  maxHeight: 200,
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
