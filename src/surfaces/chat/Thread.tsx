import { ArrowLeftRightIcon, CornerUpLeftIcon, MessagesSquareIcon } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Kbd } from "../../chrome/Kbd";
import * as api from "../../lib/api";
import { client } from "../../lib/client";
import { mergeLetters, partyOf, rightSide, senderId, USER, type Party, type ThreadRef } from "../../lib/letters";
import type { ThreadLetter } from "../../lib/protocol";
import { clock } from "../../lib/time";
import type { Session } from "../../lib/types";
import { Face } from "./Letters";
import { AssistantMessage } from "./Message";

/** Letters a page holds. */
const PAGE = 40;
/** How many pages back a checkpoint's letter is looked for before the thread opens at its end. */
const FOCUS_PAGES = 10;
/** Where an opened letter lands: just under the floating header. */
const FOCUS_OFFSET = 72;
const NEAR_BOTTOM_PX = 16;
/** A burst of mailbox moves reads the newest page once. */
const SETTLE_MS = 250;

type Props = {
  thread: ThreadRef;
  /** The chat it opens over: its letters sit on the right. */
  owner: Party;
  /** The chat asking, which routes the reads to its daemon. */
  sessionId: string;
  sessions: readonly Session[];
  /** False while the tab sits behind another one: Esc is the shown one's. */
  active: boolean;
  /** Letters the transcript marks: those can take the reader back to their checkpoint. */
  inChat: ReadonlySet<string>;
  onClose: () => void;
  onShowInChat: (letterId: string) => void;
};

type Page = { letters: ThreadLetter[]; more: boolean; loading: boolean };

/**
 * One pair's thread, over the transcript in the same reading column: exactly
 * the two of them, in the order they wrote, the same from either side. Opens
 * already placed at its letter (or its end), with a fade and no travel; "Show
 * in chat" goes back to that letter's checkpoint, Esc or Close back to where
 * the reader was.
 */
export function Thread({ thread, owner, sessionId, sessions, active, inChat, onClose, onShowInChat }: Props) {
  const { a, b, focus } = thread;
  const ends = { a: a.id || USER, b: b.id || USER };
  const [page, setPage] = useState<Page>({ letters: [], more: false, loading: true });
  const scroller = useRef<HTMLDivElement>(null);
  const placed = useRef(false);
  const atBottom = useRef(true);
  /** The height before an earlier page went in above: what keeps the reader where they were. */
  const grew = useRef<number | null>(null);

  // The newest page, and back from there until the checkpoint's letter is in it.
  useEffect(() => {
    let cancelled = false;
    let timer = 0;
    const request = { a: ends.a, b: ends.b, sessionId, limit: PAGE };
    const open = async () => {
      let next = await api.threadMessages(request);
      let letters = next.letters;
      for (let pages = 1; focus && next.more && !letters.some((letter) => letter.id === focus) && pages < FOCUS_PAGES; pages += 1) {
        next = await api.threadMessages({ ...request, before: letters[0]!.id });
        letters = [...next.letters, ...letters];
      }
      if (!cancelled) setPage({ letters, more: next.more, loading: false });
    };
    void open().catch(() => !cancelled && setPage((prev) => ({ ...prev, loading: false })));
    // A letter written while it is open lands at its foot.
    const off = client.on("mailbox-changed", () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        void api
          .threadMessages(request)
          .then((newest) => !cancelled && setPage((prev) => ({ ...prev, letters: mergeLetters(prev.letters, newest.letters) })))
          .catch(() => {});
      }, SETTLE_MS);
    });
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
      off();
    };
  }, [ends.a, ends.b, focus, sessionId]);

  useEffect(() => {
    if (!active) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [active, onClose]);

  // Placed before the first paint, at the letter or at the newest: it opens there, it never travels.
  // After that, a page above keeps the reader's row, and a letter below follows them if they were at the end.
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el || page.loading) return;
    if (!placed.current) {
      placed.current = true;
      const target = focus ? el.querySelector(`[data-thread="${CSS.escape(focus)}"]`) : null;
      if (target) el.scrollTop += target.getBoundingClientRect().top - el.getBoundingClientRect().top - FOCUS_OFFSET;
      else el.scrollTop = el.scrollHeight;
      return;
    }
    if (grew.current !== null) {
      el.scrollTop += el.scrollHeight - grew.current;
      grew.current = null;
      return;
    }
    if (atBottom.current) el.scrollTop = el.scrollHeight;
  }, [focus, page]);

  const earlier = () => {
    const first = page.letters[0];
    if (!first || page.loading) return;
    setPage((prev) => ({ ...prev, loading: true }));
    void api
      .threadMessages({ a: ends.a, b: ends.b, sessionId, limit: PAGE, before: first.id })
      .then((older) => {
        grew.current = scroller.current?.scrollHeight ?? null;
        setPage((prev) => ({ letters: mergeLetters(prev.letters, older.letters), more: older.more, loading: false }));
      })
      .catch(() => setPage((prev) => ({ ...prev, loading: false })));
  };

  // Who opened the conversation reads first in the header.
  const opener = page.letters[0];
  const [first, second] = opener && senderId(opener) === (b.id || USER) ? [b, a] : [a, b];
  const right = rightSide(thread, owner);

  return (
    <div className="crew-thread absolute inset-0 z-20 flex flex-col bg-canvas">
      <div
        ref={scroller}
        data-selectable="blocks"
        onScroll={(event) => {
          const el = event.currentTarget;
          atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight <= NEAR_BOTTOM_PX;
        }}
        className="min-h-0 flex-1 overflow-y-auto"
      >
        <div className="pointer-events-none sticky top-0 z-10 flex justify-center bg-linear-to-b from-canvas via-canvas/90 to-transparent px-6 pt-3 pb-6">
          <div className="pointer-events-auto flex h-10 max-w-full items-center gap-2 rounded-full bg-surface px-3.5 text-[13px] font-medium shadow-float">
            <Face party={first} sessions={sessions} className="size-5" />
            <span className="truncate">{first.name}</span>
            <ArrowLeftRightIcon aria-label="and" className="size-3.5 shrink-0 text-placeholder" />
            <Face party={second} sessions={sessions} className="size-5" />
            <span className="truncate">{second.name}</span>
          </div>
        </div>
        <div className="crew-prose mx-auto flex w-full max-w-[760px] flex-col gap-5 px-6 pb-28">
          {page.more && (
            <div className="flex justify-center">
              <button
                type="button"
                disabled={page.loading}
                onClick={earlier}
                className="rounded-chrome px-2.5 py-1 text-[11px] text-icon transition-colors hover:bg-hover hover:text-text disabled:text-placeholder"
              >
                {page.loading ? "Loading…" : "Earlier messages"}
              </button>
            </div>
          )}
          {!page.loading && page.letters.length === 0 ? (
            <div className="flex flex-col items-center gap-2 py-20 text-center text-text-muted">
              <MessagesSquareIcon className="size-5 text-icon" />
              <p className="text-[13px]">
                Nothing written between {first.name} and {second.name} yet.
              </p>
            </div>
          ) : (
            page.letters.map((letter, index) => (
              <Letter
                key={letter.id}
                letter={letter}
                sessions={sessions}
                right={senderId(letter) === right}
                same={index > 0 && senderId(page.letters[index - 1]!) === senderId(letter)}
                {...(inChat.has(letter.id) ? { onShowInChat: () => onShowInChat(letter.id) } : {})}
              />
            ))
          )}
        </div>
      </div>
      <div className="pointer-events-none absolute inset-x-0 bottom-0 flex justify-center bg-linear-to-t from-canvas via-canvas/90 to-transparent pt-10 pb-4">
        <button
          type="button"
          onClick={onClose}
          className="pointer-events-auto flex h-9 items-center gap-2 rounded-full bg-surface pr-2.5 pl-4 text-[13px] shadow-float transition-colors hover:bg-hover"
        >
          Close
          <Kbd keys="esc" />
        </button>
      </div>
    </div>
  );
}

/**
 * One letter: who sent it over the bubble, their face at its foot, the words
 * as the chat renders them. The chat owner's sit on the right; a run from the
 * same sender sits closer and names them once.
 */
function Letter({
  letter,
  sessions,
  right,
  same,
  onShowInChat,
}: {
  letter: ThreadLetter;
  sessions: readonly Session[];
  right: boolean;
  same: boolean;
  onShowInChat?: () => void;
}) {
  const from = partyOf(letter.from);
  return (
    <div data-thread={letter.id} className={`group/msg flex items-end gap-3 ${right ? "flex-row-reverse" : ""} ${same ? "-mt-3" : ""}`}>
      <span className="mb-1 grid size-7 shrink-0 place-items-center">
        <Face party={from} sessions={sessions} className="size-7" />
      </span>
      <div className={`flex min-w-0 flex-1 flex-col gap-1.5 ${right ? "items-end" : "items-start"}`}>
        <div className={`flex w-full items-center gap-1.5 px-1 text-[12px] leading-4 ${right ? "flex-row-reverse" : ""}`}>
          {!same && <span className="shrink-0 font-medium">{from.name}</span>}
          <span className="shrink-0 text-placeholder tabular-nums">{clock(letter.at)}</span>
          {letter.state === "pending" && <span className="shrink-0 text-text-muted">· queued</span>}
          <span className="flex-1" />
          {onShowInChat && (
            <button
              type="button"
              onClick={onShowInChat}
              className="flex shrink-0 items-center gap-1 text-[11px] text-placeholder opacity-0 transition-[opacity,color] group-hover/msg:opacity-100 hover:text-text focus-visible:opacity-100"
            >
              <CornerUpLeftIcon className="size-3" />
              Show in chat
            </button>
          )}
        </div>
        <div className="crew-thread-bubble" data-selectable>
          <AssistantMessage block={{ id: `letter-${letter.id}`, role: "assistant", text: letter.text }} />
        </div>
      </div>
    </div>
  );
}
