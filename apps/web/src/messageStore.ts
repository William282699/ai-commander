// ============================================================
// AI Commander — Staff Message Feed Store (Day 7 + Day 16B)
// Simple pub/sub store for the message feed UI.
// Lives in the web app (rendering concern, not core logic).
// ============================================================

import type { Channel } from "@ai-commander/shared";

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
