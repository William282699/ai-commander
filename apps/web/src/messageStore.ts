// ============================================================
// AI Commander — Staff Message Feed Store (Day 7 + Day 16B)
// Simple pub/sub store for the message feed UI.
// Lives in the web app (rendering concern, not core logic).
// ============================================================

import type { Channel, ReportEventType, AdvisorOption } from "@ai-commander/shared";

export type MessageLevel = "info" | "warning" | "urgent";

/** Who sent the message (persona or player). */
export type MessageFrom = "player" | "chen" | "marcus" | "emily" | "system";

/** How the message originated. */
export type MessageSource = "heartbeat" | "event_report" | "command_ack" | "player" | "system";

/** Channel → default persona mapping. */
export const CHANNEL_PERSONA: Record<Channel, MessageFrom> = {
  combat: "chen",
  ops: "marcus",
  logistics: "emily",
};

export interface FeedMessage {
  id: number;
  level: MessageLevel;
  text: string;
  time: number; // game time in seconds
  channel: Channel;
  from?: MessageFrom;
  source?: MessageSource;
  groupChat?: boolean; // true = sent via ALL group chat, hidden in individual channel views
}

const MAX_MESSAGES = 200;

let nextId = 1;
const messages: FeedMessage[] = [];
const listeners = new Set<() => void>();

// ── Cross-window delegation ──
// ROOT CAUSE of "crisis cards don't appear in detached panel":
// When ChatPanel runs inside the detached pop-out window, its local messageStore
// module instance is a SEPARATE JS module from the main window's. Threads
// created by GameCanvas (in the main window) push into the main window's
// `_threads` array, while the pop-out's ChatPanel reads its OWN (empty)
// `_threads` array — so it never sees them.
//
// Fix: when we detect we're running in the panel pop-out (URL has ?mode=panel),
// delegate ALL messageStore reads/writes to the opener window's messageStore
// module, which is exposed via `window.opener.__GAME_BRIDGE__.messageStore`.
// That way both windows share a single source of truth.
interface MessageStoreShape {
  addMessage: typeof addMessage;
  clearMessages: typeof clearMessages;
  getMessages: typeof getMessages;
  getGroupChatMessages: typeof getGroupChatMessages;
  getMessagesByChannel: typeof getMessagesByChannel;
  getLastMessageTimeBySource: typeof getLastMessageTimeBySource;
  subscribe: typeof subscribe;
  getActiveChannel: typeof getActiveChannel;
  setActiveChannel: typeof setActiveChannel;
  createThread: typeof createThread;
  resolveThread: typeof resolveThread;
  dismissThread: typeof dismissThread;
  getActiveThread: typeof getActiveThread;
  getActiveThreads: typeof getActiveThreads;
  expireStaleThreads: typeof expireStaleThreads;
  clearThreads: typeof clearThreads;
}

function getOpenerStore(): MessageStoreShape | null {
  if (typeof window === "undefined") return null;
  // Only the panel pop-out delegates. The main window always uses its local state.
  // This avoids any ambiguity from `window.opener` being set in unrelated contexts.
  try {
    const params = new URLSearchParams(window.location.search);
    if (params.get("mode") !== "panel") return null;
  } catch {
    return null;
  }
  const opener = window.opener as Window | null;
  if (!opener || opener.closed) return null;
  const bridge = (opener as unknown as { __GAME_BRIDGE__?: { messageStore?: MessageStoreShape } }).__GAME_BRIDGE__;
  return bridge?.messageStore ?? null;
}

// Day 16B: active channel shared state (for CommandPanel to read)
let _activeChannel: Channel = "ops";

export function getActiveChannel(): Channel {
  const p = getOpenerStore();
  if (p) return p.getActiveChannel();
  return _activeChannel;
}

export function setActiveChannel(ch: Channel): void {
  const p = getOpenerStore();
  if (p) { p.setActiveChannel(ch); return; }
  _activeChannel = ch;
  listeners.forEach((fn) => fn());
}

export function addMessage(
  level: MessageLevel,
  text: string,
  gameTime: number,
  channel: Channel = "ops",
  from?: MessageFrom,
  source?: MessageSource,
  groupChat?: boolean,
): void {
  const p = getOpenerStore();
  if (p) { p.addMessage(level, text, gameTime, channel, from, source, groupChat); return; }
  // Auto-derive `from` from channel if not provided and source isn't player/system
  const resolvedFrom = from ?? (source === "player" ? "player" : source === "system" ? "system" : CHANNEL_PERSONA[channel]);
  messages.push({ id: nextId++, level, text, time: gameTime, channel, from: resolvedFrom, source, ...(groupChat ? { groupChat: true } : {}) });

  while (messages.length > MAX_MESSAGES) {
    messages.shift();
  }

  listeners.forEach((fn) => fn());
}

export function clearMessages(): void {
  const p = getOpenerStore();
  if (p) { p.clearMessages(); return; }
  messages.length = 0;
  nextId = 1;
  _activeChannel = "ops";
  listeners.forEach((fn) => fn());
}

/** All messages (internal / legacy). */
export function getMessages(): readonly FeedMessage[] {
  const p = getOpenerStore();
  if (p) return p.getMessages();
  return messages;
}

/** ALL view: only group-chat messages (player asked in ALL → commanders replied). */
export function getGroupChatMessages(): readonly FeedMessage[] {
  const p = getOpenerStore();
  if (p) return p.getGroupChatMessages();
  return messages.filter((m) => m.groupChat);
}

/** Single-channel view: that channel's messages + group-chat messages on same channel. */
export function getMessagesByChannel(channel: Channel): readonly FeedMessage[] {
  const p = getOpenerStore();
  if (p) return p.getMessagesByChannel(channel);
  return messages.filter((m) => m.channel === channel);
}

/** Return the game-time of the most recent message matching channel+source, or null. */
export function getLastMessageTimeBySource(channel: Channel, source: MessageSource): number | null {
  const p = getOpenerStore();
  if (p) return p.getLastMessageTimeBySource(channel, source);
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.channel === channel && m.source === source) return m.time;
  }
  return null;
}

export function subscribe(listener: () => void): () => void {
  const p = getOpenerStore();
  if (p) {
    // Delegate subscription to the opener's store so that when the main
    // window mutates state (addMessage, createThread, etc.), our cross-window
    // React subscribers fire here in the pop-out window.
    const unsub = p.subscribe(listener);
    // Cleanup on pop-out window close, so we don't leak dead listeners into
    // the main window's Set (which would break notifications to other listeners).
    const onUnload = () => { try { unsub(); } catch { /* dead */ } };
    window.addEventListener("beforeunload", onUnload);
    return () => {
      window.removeEventListener("beforeunload", onUnload);
      try { unsub(); } catch { /* dead */ }
    };
  }
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

// ── Phase 3: Staff Thread System ──

/** Extended event type for threads — includes doctrine crisis types beyond ReportEventType. */
export type StaffEventType = ReportEventType | "DOCTRINE_BREACH" | "DOCTRINE_WARNING";

export interface StaffThread {
  id: string;
  topicKey: string;          // "POSITION_CRITICAL:front_north"
  eventType: StaffEventType;
  channel: Channel;
  brief: string;             // LLM in-character brief
  eventMessage: string;      // original event message
  status: "open" | "resolved" | "expired";
  options?: AdvisorOption[];
  createdAt: number;         // game time
  expiresAt: number;         // game time + 120s
}

const THREAD_EXPIRY_SEC = 120;
let _threads: StaffThread[] = [];
let _nextThreadId = 1;

export function createThread(
  topicKey: string,
  eventType: StaffEventType,
  channel: Channel,
  brief: string,
  eventMessage: string,
  options: AdvisorOption[] | undefined,
  gameTime: number,
): StaffThread {
  const p = getOpenerStore();
  if (p) return p.createThread(topicKey, eventType, channel, brief, eventMessage, options, gameTime);

  // OQ2: deduplicate — only 1 open thread per channel allowed.
  // If an open thread already exists on this channel, expire it before creating a new one.
  for (const existing of _threads) {
    if (existing.channel === channel && existing.status === "open") {
      existing.status = "expired";
    }
  }

  const thread: StaffThread = {
    id: `thread_${_nextThreadId++}`,
    topicKey,
    eventType,
    channel,
    brief,
    eventMessage,
    status: "open",
    options,
    createdAt: gameTime,
    expiresAt: gameTime + THREAD_EXPIRY_SEC,
  };
  _threads.push(thread);
  listeners.forEach((fn) => fn());
  return thread;
}

export function resolveThread(threadId: string): void {
  const p = getOpenerStore();
  if (p) { p.resolveThread(threadId); return; }
  const t = _threads.find((th) => th.id === threadId);
  if (t && t.status === "open") {
    t.status = "resolved";
    listeners.forEach((fn) => fn());
  }
}

/**
 * Dismiss a thread without taking any of its options. Used when the player
 * doesn't want any of A/B/C and would rather handle the situation via direct
 * chat. Treats as immediate expiration (matches "expired" status semantics).
 */
export function dismissThread(threadId: string): void {
  const p = getOpenerStore();
  if (p) { p.dismissThread(threadId); return; }
  const t = _threads.find((th) => th.id === threadId);
  if (t && t.status === "open") {
    t.status = "expired";
    listeners.forEach((fn) => fn());
  }
}

export function getActiveThread(): StaffThread | undefined {
  const p = getOpenerStore();
  if (p) return p.getActiveThread();
  return _threads.find((t) => t.status === "open");
}

export function getActiveThreads(): StaffThread[] {
  const p = getOpenerStore();
  if (p) return p.getActiveThreads();
  return _threads.filter((t) => t.status === "open");
}

export function expireStaleThreads(gameTime: number): void {
  const p = getOpenerStore();
  if (p) { p.expireStaleThreads(gameTime); return; }
  let changed = false;
  for (const t of _threads) {
    if (t.status === "open" && gameTime >= t.expiresAt) {
      t.status = "expired";
      changed = true;
    }
  }
  // Prune old resolved/expired threads (keep last 10)
  if (_threads.length > 10) {
    _threads = _threads.filter((t) => t.status === "open").concat(
      _threads.filter((t) => t.status !== "open").slice(-5),
    );
    changed = true;
  }
  if (changed) listeners.forEach((fn) => fn());
}

export function clearThreads(): void {
  const p = getOpenerStore();
  if (p) { p.clearThreads(); return; }
  _threads = [];
  _nextThreadId = 1;
}

