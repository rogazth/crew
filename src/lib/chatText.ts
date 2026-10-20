/** The chat's text size in px, read by the transcript and the composer through `--chat-text`. */
export const CHAT_TEXT_MIN = 12;
export const CHAT_TEXT_MAX = 18;
export const DEFAULT_CHAT_TEXT = 14;

export function parseChatText(raw: string | null | undefined): number {
  const value = Number(raw);
  if (raw == null || raw === "" || !Number.isFinite(value)) return DEFAULT_CHAT_TEXT;
  return clampChatText(value);
}

export function clampChatText(value: number): number {
  return Math.min(CHAT_TEXT_MAX, Math.max(CHAT_TEXT_MIN, Math.round(value)));
}
