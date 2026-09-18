import { createContext, useContext } from "react";
import type { ThreadHandle } from "@crew/fixtures";

export type ChatCtx = {
  sessionId: string;
  sessionName: string;
  runtime: ThreadHandle;
  /** Only the newest open card is hot: it is the one Enter and Escape reach. */
  hotApproval: number | null;
  hotQuestion: number | null;
};

export const ChatContext = createContext<ChatCtx | null>(null);

export function useChat(): ChatCtx {
  const found = useContext(ChatContext);
  if (!found) throw new Error("useChat outside a chat surface");
  return found;
}

/** A typing target owns its own Enter; a hot card must not steal it. */
export function isTypingTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el) return false;
  const tag = el.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || el.isContentEditable;
}
