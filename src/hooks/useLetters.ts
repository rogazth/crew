import { useCallback, useEffect, useMemo, useState } from "react";
import * as api from "../lib/api";
import type { Block } from "../lib/blocks";
import { client } from "../lib/client";
import { childrenOf, isLetter, letterIdOf, sessionParty, type ThreadRef } from "../lib/letters";
import type { MailboxChanged, ThreadLetter, ThreadPair } from "../lib/protocol";
import type { Session } from "../lib/types";
import type { LetterScope } from "../surfaces/chat/context";

/** How long a burst of mailbox moves (a letter claimed, then delivered) waits before one read. */
const SETTLE_MS = 250;

/**
 * Reads `load` now, again when `again` moves, and whenever a box `concerns`
 * changes: once per burst, and never into a chat that unmounted meanwhile.
 * What it read stays on screen while the next read is out.
 */
function useMailbox<T>(
  key: string | null,
  again: number,
  load: () => Promise<T>,
  concerns: (sessionId: string) => boolean,
  empty: T,
): T {
  const [value, setValue] = useState<{ key: string | null; value: T }>({ key, value: empty });
  useEffect(() => {
    if (!key) return;
    let cancelled = false;
    let timer = 0;
    const read = () =>
      load()
        .then((next) => {
          if (!cancelled) setValue({ key, value: next });
        })
        .catch(() => {});
    void read();
    const off = client.on("mailbox-changed", (payload) => {
      if (!concerns((payload as MailboxChanged).sessionId)) return;
      window.clearTimeout(timer);
      timer = window.setTimeout(() => void read(), SETTLE_MS);
    });
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
      off();
    };
    // `load` and `concerns` are read fresh by the key: a new chat is a new key.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, again]);
  // What another chat read is not this one's.
  return value.key === key ? value.value : empty;
}

const NO_PAIRS: ThreadPair[] = [];
const NO_LETTERS: ThreadLetter[] = [];

/**
 * The pairs a chat's Conversations menu lists, newest first. A letter this
 * session sends lands in someone else's box, so any box moving is a reason to
 * read again; `letters` (how many the transcript marks) is another.
 */
export function usePairs(sessionId: string, letters: number): ThreadPair[] {
  return useMailbox(sessionId, letters, () => api.threadPairs(sessionId), () => true, NO_PAIRS);
}

/** What waits in a session's box for its next turn, and what a turn took and has not finished. */
export function usePending(sessionId: string, enabled: boolean): ThreadLetter[] {
  return useMailbox(
    enabled ? sessionId : null,
    0,
    () => api.mailboxPending(sessionId),
    (changed) => changed === sessionId,
    NO_LETTERS,
  );
}

/**
 * What a chat needs to draw its letters: its children for the Sessions strip,
 * its pairs for the Conversations menu, the scope its checkpoints read, and
 * the thread open over it, if any.
 */
export function useChatLetters(session: Session, sessions: readonly Session[], blocks: readonly Block[]) {
  const [thread, setThread] = useState<{ id: string; ref: ThreadRef } | null>(null);
  const kids = useMemo(() => childrenOf(sessions).get(session.id) ?? NO_KIDS, [session.id, sessions]);
  const inChat = useMemo(
    () => new Set(blocks.flatMap((block) => (isLetter(block) ? [letterIdOf(block)!] : []))),
    [blocks],
  );
  const pairs = usePairs(session.id, inChat.size);
  // By its name, not the row: a status change must not redraw every checkpoint.
  const { id, name, kind } = session;
  const owner = useMemo(() => sessionParty({ id, name, kind }), [id, name, kind]);
  const openThread = useCallback((ref: ThreadRef) => setThread({ id: session.id, ref }), [session.id]);
  const closeThread = useCallback(() => setThread(null), []);
  const scope = useMemo<LetterScope>(() => ({ owner, sessions, openThread }), [owner, sessions, openThread]);
  return {
    kids,
    pairs,
    owner,
    scope,
    inChat,
    // One opened from another chat's mount is not this one's.
    thread: thread?.id === session.id ? thread.ref : null,
    openThread,
    closeThread,
  };
}

const NO_KIDS: Session[] = [];

/**
 * Back in the transcript, at a letter's checkpoint. The thread closes first;
 * the row is there on the next frame, near the top, nothing else moved.
 */
export function showLetter(root: HTMLElement | null, letterId: string) {
  requestAnimationFrame(() => {
    const row = root?.querySelector(`[data-letter="${CSS.escape(letterId)}"]`);
    const scroller = row?.closest<HTMLElement>("[data-selectable='blocks']");
    // Not scrollIntoView: that also scrolls every clipped ancestor, which is the jump.
    if (row && scroller) scroller.scrollTop += row.getBoundingClientRect().top - scroller.getBoundingClientRect().top - 24;
  });
}
