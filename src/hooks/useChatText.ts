import { useSyncExternalStore } from "react";
import { chatTextSetting, clampChatText, DEFAULT_CHAT_TEXT, parseChatText } from "../lib/chatText";
import { peekSetting, readSetting, saveSetting, watchSetting } from "../lib/settingsEngine/store";

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

/** Applies the size to <html> before the first render, then follows the stored pick, wherever it is made. */
export function bootChatText() {
  set(parseChatText(read()));
  watchSetting(chatTextSetting, () => set(peekSetting(chatTextSetting)));
  // The store not up yet leaves the mirror standing.
  readSetting(chatTextSetting).then(set, () => {});
}

export function setChatText(next: number) {
  saveSetting(chatTextSetting, clampChatText(next));
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

export function useChatText() {
  return { size: useSyncExternalStore(subscribe, () => current), update: setChatText };
}
