import type { AttachedFile } from "./blocks";

/** Something to send, and an agent ready to take it. */
export function canSend(ready: boolean, draft: string, files: AttachedFile[], working: boolean): boolean {
  return ready && (draft.trim().length > 0 || files.length > 0) && !working;
}

/** The send button and Enter both stop a running turn; otherwise they send, when there is something to. */
export function submitAction(working: boolean, sendable: boolean): "stop" | "send" | null {
  if (working) return "stop";
  return sendable ? "send" : null;
}

export type ComposerKey = { key: string; shiftKey: boolean; isComposing: boolean };

export type ComposerKeyAction =
  | { kind: "move"; step: 1 | -1 }
  | { kind: "pick" }
  | { kind: "dismiss" }
  | { kind: "submit" };

/**
 * While the mention picker has results it owns the arrows, Enter, Tab and
 * Escape. Otherwise Enter submits, unless Shift asks for a newline or an IME
 * is still composing the word.
 */
export function composerKey(event: ComposerKey, picking: boolean): ComposerKeyAction | null {
  if (picking) {
    if (event.key === "ArrowDown") return { kind: "move", step: 1 };
    if (event.key === "ArrowUp") return { kind: "move", step: -1 };
    if (event.key === "Enter" || event.key === "Tab") return { kind: "pick" };
    if (event.key === "Escape") return { kind: "dismiss" };
  }
  if (event.key !== "Enter" || event.shiftKey || event.isComposing) return null;
  return { kind: "submit" };
}

/** The highlighted row after a step, wrapping at both ends. */
export function stepActive(index: number, step: number, count: number): number {
  return (index + step + count) % count;
}
