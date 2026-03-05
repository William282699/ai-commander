// ============================================================
// AI Commander — Staff Message Feed Store (Day 7)
// Simple pub/sub store for the message feed UI.
// Lives in the web app (rendering concern, not core logic).
// ============================================================

export type MessageLevel = "info" | "warning" | "urgent";

export interface FeedMessage {
  id: number;
  level: MessageLevel;
  text: string;
  time: number; // game time in seconds
}

const MAX_MESSAGES = 50;

let nextId = 1;
const messages: FeedMessage[] = [];
const listeners = new Set<() => void>();

export function addMessage(
  level: MessageLevel,
  text: string,
  gameTime: number,
): void {
  messages.push({ id: nextId++, level, text, time: gameTime });

  while (messages.length > MAX_MESSAGES) {
    messages.shift();
  }

  listeners.forEach((fn) => fn());
}

export function getMessages(): readonly FeedMessage[] {
  return messages;
}

export function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
