import { isOpen, type Block } from "./blocks";

type GroupProps = {
  blocks: Block[];
  live: boolean;
  focusId: string | null;
  marked: string | null;
  onApprove: unknown;
  onAnswer: unknown;
};

/**
 * The transcript regroups its rows every frame a turn streams, so `blocks` is a
 * fresh array holding the same blocks. Comparing it by element is what lets a
 * settled group sit out the turn instead of rebuilding its phases 60 times a second.
 */
export function sameGroup(prev: GroupProps, next: GroupProps): boolean {
  if (
    prev.live !== next.live ||
    prev.focusId !== next.focusId ||
    prev.marked !== next.marked ||
    prev.onApprove !== next.onApprove ||
    prev.onAnswer !== next.onAnswer
  ) {
    return false;
  }
  if (prev.blocks.length !== next.blocks.length) return false;
  return prev.blocks.every((block, index) => block === next.blocks[index]);
}

/** Keys go to one card: the newest thing waiting on the user, in the live group only. */
export function hotBlockId(blocks: Block[], live: boolean): string | undefined {
  return live ? blocks.filter(isOpen).at(-1)?.id : undefined;
}

/**
 * A row nobody can see is a row nobody can be sent to, and the mark outlives
 * the request, so whatever holds the row stays open after the reader got there.
 */
export function holdsRow(blocks: Block[], focusId: string | null, marked: string | null): boolean {
  const sent = (id: string | null) => id !== null && blocks.some((block) => block.id === id);
  return sent(focusId) || sent(marked);
}

/** Open while something waits on the user; otherwise the reader's pin, else open while it holds the focus or is live. */
export function foldOpen(waiting: boolean, pinned: boolean | null, holds: boolean, live: boolean): boolean {
  return waiting || (pinned ?? (holds || live));
}

export function anyFailed(blocks: Block[]): boolean {
  return blocks.some((block) => block.tool?.status === "failed");
}

/** A thought's folded line: live while it streams, its gist once settled. */
export function reasoningLabel(streaming: boolean, summary: string): string {
  if (streaming) return "Thinking";
  return summary || "Thought";
}
