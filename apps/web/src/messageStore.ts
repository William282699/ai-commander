// ============================================================
// AI Commander — Staff Message Feed Store (Day 7 + Day 16B)
// Simple pub/sub store for the message feed UI.
// Lives in the web app (rendering concern, not core logic).
// ============================================================

import type { Channel, ReportEventType, AdvisorOption } from "@ai-commander/shared";

export type MessageLevel = "info" | "warning" | "urgent";

export interface FeedMessage {
  id: number;
  level: MessageLevel;
  text: string;
  time: number; // game time in seconds
  channel: Channel;
}

const MAX_MESSAGES = 50;

let nextId = 1;
const messages: FeedMessage[] = [];
const listeners = new Set<() => void>();

// Day 16B: active channel shared state (for CommandPanel to read)
let _activeChannel: Channel = "ops";

export function getActiveChannel(): Channel {
  return _activeChannel;
}

export function setActiveChannel(ch: Channel): void {
  _activeChannel = ch;
  listeners.forEach((fn) => fn());
}

export function addMessage(
  level: MessageLevel,
  text: string,
  gameTime: number,
  channel: Channel = "ops",
): void {
  messages.push({ id: nextId++, level, text, time: gameTime, channel });

  while (messages.length > MAX_MESSAGES) {
    messages.shift();
  }

  listeners.forEach((fn) => fn());
}

export function clearMessages(): void {
  messages.length = 0;
  nextId = 1;
  _activeChannel = "ops";
  listeners.forEach((fn) => fn());
}

export function getMessages(): readonly FeedMessage[] {
  return messages;
}

export function getMessagesByChannel(channel: Channel): readonly FeedMessage[] {
  return messages.filter((m) => m.channel === channel);
}

export function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

// ── Phase 3: Staff Thread System ──

export interface StaffThread {
  id: string;
  topicKey: string;          // "POSITION_CRITICAL:front_north"
  eventType: ReportEventType;
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
  eventType: ReportEventType,
  channel: Channel,
  brief: string,
  eventMessage: string,
  options: AdvisorOption[] | undefined,
  gameTime: number,
): StaffThread {
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
  const t = _threads.find((th) => th.id === threadId);
  if (t && t.status === "open") {
    t.status = "resolved";
    listeners.forEach((fn) => fn());
  }
}

export function getActiveThread(): StaffThread | undefined {
  return _threads.find((t) => t.status === "open");
}

export function getActiveThreads(): StaffThread[] {
  return _threads.filter((t) => t.status === "open");
}

export function expireStaleThreads(gameTime: number): void {
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
  _threads = [];
  _nextThreadId = 1;
}
