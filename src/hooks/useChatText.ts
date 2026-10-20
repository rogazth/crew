import { useSyncExternalStore } from "react";
import * as api from "../lib/api";
import { clampChatText, DEFAULT_CHAT_TEXT, parseChatText } from "../lib/chatText";

const KEY = "app:chat-text";
/** This window's copy of the pick, so the first paint is already in the right size. */
const MIRROR = "crew-chat-text";

let current = DEFAULT_CHAT_TEXT;
const listeners = new Set<() => void>();

function read(): string | null {
  try {
    return localStorage.getItem(MIRROR);
  } catch {
    return null;
  }
}

function set(next: number) {
  document.documentElement.style.setProperty("--chat-text", `${next}px`);
  if (next === current) return;
  current = next;
  try {
    localStorage.setItem(MIRROR, String(next));
  } catch {
    // Storage can be unavailable; the pick still holds for this window.
  }
  for (const listener of listeners) listener();
}

/** Applies the size to <html> before the first render, then reconciles with the stored pick. */
export function bootChatText() {
  set(parseChatText(read()));
  api
    .stateGet(KEY)
    .then((stored) => set(parseChatText(stored)))
    .catch(() => {
      // The store is not up yet: the mirror stands.
    });
}

export function setChatText(next: number) {
  const size = clampChatText(next);
  set(size);
  void api.stateSet(KEY, String(size)).catch(() => {});
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

export function useChatText() {
  return { size: useSyncExternalStore(subscribe, () => current), update: setChatText };
}
