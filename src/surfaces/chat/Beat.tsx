/**
 * What a transcript says happened between agents: who, to whom, and when, in
 * the middle of the chat. Never the words of the letter: those are a click away,
 * in the agent's thread, or in a dialog when there is no thread to open.
 */
import { SquareTerminalIcon } from "lucide-react";
import { lazy, Suspense, useState, type ReactNode } from "react";
import { BotAvatar } from "../../chrome/BotAvatar";
import { Overlay } from "../../chrome/kit";
import { ProviderIcon } from "../../chrome/ProviderIcon";
import { clock } from "../../lib/time";
import { useLetterScope } from "./context";

/** streamdown is half a megabyte: a dialog loads it when it first opens. */
const Markdown = lazy(() => import("./Markdown").then((m) => ({ default: m.Markdown })));

/** Who a name stands for: a bot is its face, an agent its CLI's mark. */
export type Peer = { id?: string | undefined; name: string; provider?: string | undefined; bot?: boolean | undefined };

export function PeerMark({ peer, className }: { peer: Peer; className: string }) {
  if (peer.bot && peer.id) return <BotAvatar seed={peer.id} bare className={`${className} shrink-0`} />;
  if (peer.provider) return <ProviderIcon provider={peer.provider} className={`${className} shrink-0`} />;
  // A session whose CLI is not known (gone, or named only by a call): a neutral mark. Only a bot has a face.
  return <SquareTerminalIcon aria-hidden className={`${className} shrink-0 text-icon`} />;
}

/** A name in a beat, with its mark. The person has neither face nor mark here: "You" says it. */
function Named({ who }: { who: Peer | "you" }) {
  if (who === "you") return <span className="shrink-0 font-medium text-text">You</span>;
  return (
    <span className="inline-flex min-w-0 items-center gap-1 font-medium text-text">
      <PeerMark peer={who} className="size-3.5" />
      <span className="truncate">{who.name}</span>
    </span>
  );
}

export type BeatProps = {
  /** The block it stands for: what a search hit is sent to. */
  id?: string;
  marked?: string | null;
  /** The letter it stands for: what a thread opened from elsewhere goes back to. */
  letter?: string | undefined;
  /** Who did it. Absent in a chat with no owner to name. */
  first?: Peer | "you" | undefined;
  verb: string;
  second?: Peer | undefined;
  /** How it went, after the names: "read mid-turn". */
  note?: string | undefined;
  /** It waits on an answer: the one beat that raises its voice. */
  waiting?: boolean;
  /** It did not happen. */
  failed?: boolean;
  at?: number | undefined;
  /** Opens where the words are. */
  onOpen?: (() => void) | undefined;
  /** No thread to open: the words, in a dialog. */
  peek?: { title: string; text: string; extra?: ReactNode } | undefined;
  report?: boolean;
  /** It says an agent was started or resumed. */
  start?: boolean;
};

export function Beat({ id, marked = null, letter, first, verb, second, note, waiting = false, failed = false, at, onOpen, peek, report = false, start = false }: BeatProps) {
  const [peeking, setPeeking] = useState(false);
  const { openLetter } = useLetterScope();
  const selected = letter !== undefined && letter === openLetter;
  const body = (
    <>
      {waiting ? <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-warning" /> : null}
      {first ? <Named who={first} /> : null}
      <span className={`shrink-0 ${failed ? "text-danger" : ""}`}>{verb}</span>
      {second ? <Named who={second} /> : null}
      {note ? <span className={`shrink-0 ${failed ? "text-danger" : "text-placeholder"}`}>· {note}</span> : null}
      {waiting ? <span className="shrink-0 text-warning">· waiting for an answer</span> : null}
      {at !== undefined ? <span className="shrink-0 pl-0.5 text-[11.5px] text-placeholder tabular-nums">{clock(at)}</span> : null}
    </>
  );
  const shape = "flex h-7 max-w-full min-w-0 items-center gap-1.5 rounded-full px-2.5 text-[12.5px] whitespace-nowrap text-text-muted";
  const open = onOpen ?? (peek ? () => setPeeking(true) : undefined);
  return (
    <div
      data-beat
      {...(id ? { "data-block": id } : {})}
      {...(letter ? { "data-letter": letter } : {})}
      {...(report ? { "data-report": "" } : {})}
      className={`flex justify-center${id && id === marked ? " crew-found" : ""}`}
    >
      {open ? (
        <button type="button" {...(start ? { "data-agent-start": "" } : {})} onClick={open} className={`${shape} transition-colors ${selected ? "bg-card" : "hover:bg-hover"}`}>
          {body}
        </button>
      ) : (
        <div {...(start ? { "data-agent-start": "" } : {})} className={shape}>{body}</div>
      )}
      {peeking && peek ? (
        <Overlay onClose={() => setPeeking(false)} label={peek.title} width="w-[640px]">
          <div className="shrink-0 border-b border-border px-4 py-3 text-[13px] font-medium">{peek.title}</div>
          <div data-selectable className="crew-prose min-h-0 flex-1 overflow-y-auto px-4 py-3">
            <Suspense fallback={<p className="whitespace-pre-wrap">{peek.text}</p>}>
              <Markdown text={peek.text} />
            </Suspense>
            {peek.extra}
          </div>
        </Overlay>
      ) : null}
    </div>
  );
}
