import { useCallback, useState } from "react";
import { stillBlank } from "../lib/blankSessions";
import { read } from "../lib/transcript";
import type { Session } from "../lib/types";

const NONE: ReadonlySet<string> = new Set();

/**
 * The sessions this window opened that nothing has been said in yet. The
 * sidebar leaves them out: closing one deletes it, so it only lists them once
 * they hold a conversation. `markBlank` takes one as it opens.
 */
export function useBlankSessions(sessions: Session[]) {
  const [marked, setMarked] = useState(NONE);
  const blank = stillBlank(marked, sessions, (id) => read(id).blocks.length > 0);
  // One that spoke is let go for good, so it stays listed when its turn ends idle.
  if (blank !== marked) setMarked(blank);
  const markBlank = useCallback((id: string) => setMarked((prev) => new Set(prev).add(id)), []);
  return { blank, markBlank };
}
