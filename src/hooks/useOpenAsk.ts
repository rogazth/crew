import { useMemo } from "react";
import type { Block } from "../lib/blocks";
import { askOf } from "../lib/orchestration";
import { useThread } from "./useThread";

/**
 * A child's open question or approval, read from its own thread. Mounted only
 * while the child waits on one (and after, to say how it was answered), so a
 * chat does not hold a thread per letter.
 */
export function useOpenAsk(childId: string, kind: "question" | "approval", letterText: string): Block | null {
  const { blocks } = useThread(childId);
  return useMemo(() => askOf(blocks, kind, letterText), [blocks, kind, letterText]);
}
