/**
 * How orchestration reads in a transcript: a beat in the middle of the chat that
 * says who did what to whom (Beat.tsx), and nothing of what was said. A native
 * subagent and a Crew subagent are the same beat. The words are read where they
 * were said: an agent's thread, or a pair's conversation. Inside an agent's own
 * thread the letters are that thread's words, so they stay drawn in full.
 */
import {
  CircleStopIcon,
  EyeIcon,
  HandIcon,
  PencilIcon,
  Trash2Icon,
  UsersIcon,
  type LucideIcon,
} from "lucide-react";
import { lazy, memo, Suspense, useContext, useEffect, useState, type ReactNode } from "react";
import type { Block } from "../../lib/blocks";
import { botLabel } from "../../lib/botNames";
import { checkpointOf, letterIdOf, resolveParty, USER, type ThreadBlock } from "../../lib/letters";
import { clock } from "../../lib/time";
import {
  controlOf,
  exitedless,
  nativeName,
  nativeReport,
  nativeReportAt,
  sentOf,
  startedOf,
  startedSession,
  type Started,
} from "../../lib/orchestration";
import type { CrewTarget } from "../../lib/protocol";
import { agentDetail, entryOfCall, resumesEntry } from "../../lib/subagent";
import { useChatActions, useLetterScope, WorkContext } from "./context";
import { Note, UserMessage } from "./Message";
import type { Session } from "../../lib/types";
import { Beat, PeerMark, type Peer } from "./Beat";

/** streamdown is half a megabyte: a long text loads it when it is first drawn. */
const Markdown = lazy(() => import("./Markdown").then((m) => ({ default: m.Markdown })));

const lit = (id: string, marked: string | null) => (id === marked ? " crew-found" : "");

/** A one-line row: the node and a sentence. */
export function ToolLine({
  icon: Glyph,
  children,
  id,
  marked = null,
}: {
  icon: LucideIcon;
  children: ReactNode;
  id?: string;
  marked?: string | null;
}) {
  return (
    <div
      data-block={id}
      className={`flex min-h-6 items-center gap-2 text-[13px] leading-[18px] text-text-muted${id ? lit(id, marked) : ""}`}
    >
      <span className="crew-node">
        <Glyph className="size-3.5" />
      </span>
      <span className="min-w-0 flex-1 truncate">{children}</span>
    </div>
  );
}

/** A session or a bot as the chat's sessions know it: by id, else by name when the call named it by name only. */
function peerOf(sessions: readonly Session[], id: string | undefined, name: string, provider?: string): Peer {
  const session = id ? sessions.find((row) => row.id === id) : sessions.find((row) => row.name === name);
  return {
    id: id ?? session?.id,
    name: session?.name ?? name,
    provider: session?.provider ?? provider,
    bot: session ? session.kind === "bot" : undefined,
  };
}

function usePeer(id: string | undefined, name: string, provider?: string): Peer {
  const { sessions } = useLetterScope();
  return peerOf(sessions, id, name, provider);
}

/** A name inside a sentence: set off from the words before it, its mark a little apart from it, long names cut. */
const PEER_CHIP = "crew-peer ml-0.5 inline-flex h-[18px] max-w-[24em] items-center gap-1.5 align-top font-medium text-text";

/** The mark and the name, in `text-text`; a click opens that party (its thread, or a bot's chat). */
export function PeerName({ peer, focus }: { peer: Peer; focus?: string }) {
  const { openAgent } = useChatActions();
  const body = (
    <>
      <PeerMark peer={peer} className="size-3.5" />
      <span className="truncate">{peer.name}</span>
    </>
  );
  if (!peer.id) return <span className={PEER_CHIP}>{body}</span>;
  const id = peer.id;
  return (
    <button
      type="button"
      onClick={() => openAgent(id, focus ? { focus } : undefined)}
      className={`${PEER_CHIP} rounded-chrome hover:underline`}
    >
      {body}
    </button>
  );
}

/** The chat's owner, as a beat names it. */
function useOwnerPeer(): Peer | undefined {
  const { owner, sessions } = useLetterScope();
  return owner ? peerOf(sessions, owner.id, owner.name) : undefined;
}

/**
 * A native subagent's call, whichever CLI ran it: `Lead started [mark] Explore`.
 * It opens the subagent's thread; one the work list has lost shows what it was asked.
 */
export const SubagentCall = memo(function SubagentCall({ block, marked }: { block: Block; marked: string | null }) {
  const entries = useContext(WorkContext);
  const { sessions, owner } = useLetterScope();
  const { openAgent } = useChatActions();
  const me = useOwnerPeer();
  const detail = agentDetail(block);
  if (!detail) return null;
  const entry = entryOfCall(entries, block);
  // A call that goes on with a subagent an earlier call started has its own steps and state: the entry is the whole subagent's.
  const resumed = resumesEntry(entry, block);
  const provider = entry?.provider ?? sessions.find((row) => row.id === owner?.id)?.provider;
  const peer: Peer = { name: nativeName(detail), provider };
  const asked = detail.prompt ?? detail.description ?? "";
  return (
    <Beat
      id={block.id}
      marked={marked}
      first={me}
      start
      verb={resumed ? "resumed" : "started"}
      second={peer}
      at={block.at}
      onOpen={entry ? () => openAgent(entry.id) : undefined}
      peek={asked ? { title: `What ${peer.name} was asked`, text: asked } : undefined}
    />
  );
});

/** A native subagent's report, drawn where it landed after the call. */
export const SubagentReport = memo(function SubagentReport({ block }: { block: Block }) {
  const entries = useContext(WorkContext);
  const { sessions, owner } = useLetterScope();
  const { openAgent } = useChatActions();
  const me = useOwnerPeer();
  const detail = agentDetail(block);
  const report = nativeReport(block);
  if (!detail || !report) return null;
  const entry = entryOfCall(entries, block);
  const provider = entry?.provider ?? sessions.find((row) => row.id === owner?.id)?.provider;
  const peer: Peer = { name: nativeName(detail), provider };
  return (
    <Beat
      report
      first={peer}
      verb="reported to"
      second={me}
      at={nativeReportAt(block) ?? block.at}
      onOpen={entry ? () => openAgent(entry.id) : undefined}
      peek={{ title: `What ${peer.name} reported`, text: report }}
    />
  );
});

/**
 * A Crew call that started something: `delegate` is a subagent, `start_session`
 * a session, `start_sessions` several, a beat each. The prompt is the session's
 * first letter, at the top of its thread.
 */
export const StartedRow = memo(function StartedRow({ block, marked }: { block: Block; marked: string | null }) {
  const entries = useContext(WorkContext);
  const { openAgent } = useChatActions();
  const { sessions, owner } = useLetterScope();
  const me = useOwnerPeer();
  const found = startedOf(block);
  // A call still out (a delegate that waits) has no answer to name its session yet: its row does.
  const made = found && found.kind !== "sessions" ? startedSession(sessions, owner?.id, block, found) : undefined;
  const madeId = made?.id;
  // Clicked before the row was there (an approval, a worktree being made): it opens once the row comes.
  const [opening, setOpening] = useState(false);
  const pending = block.tool?.status === "pending";
  const letterId = letterIdOf(block);
  useEffect(() => {
    if (!opening || !madeId) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- the open the click asked for, now that it can
    setOpening(false);
    openAgent(madeId, letterId ? { focus: letterId } : undefined);
  }, [opening, madeId, letterId, openAgent]);
  if (!found) return null;
  const started: Started = made && found.kind !== "sessions" ? { ...found, target: { ...found.target, id: made.id } } : found;
  // Until the row is there, the caller's own CLI: the one Crew picks when the call names none.
  const asked = sessions.find((row) => row.id === owner?.id)?.provider;
  const peerOf = (target: CrewTarget): Peer => {
    const session = target.id ? sessions.find((row) => row.id === target.id) : undefined;
    return { id: target.id, name: session?.name ?? target.name, provider: session?.provider ?? target.provider ?? asked, bot: false };
  };
  const letter = started.kind === "sessions" ? undefined : letterId;
  const focus = letter ? { focus: letter } : undefined;
  const open = (target: CrewTarget) => {
    const entry = target.id ? entries.find((one) => one.id === `session:${target.id}`) : undefined;
    return entry ? () => openAgent(entry.id, focus) : target.id && sessions.some((row) => row.id === target.id) ? () => openAgent(target.id!, focus) : undefined;
  };
  const targets = started.kind === "sessions" ? started.targets : [started.target];
  const prompt = started.kind === "sessions" ? undefined : started.prompt;
  return (
    <div className="flex flex-col gap-0.5">
      {targets.map((target, index) => {
        const peer = peerOf(target);
        return (
          <Beat
            key={target.id ?? `${target.name}-${index}`}
            {...(index === 0 ? { id: block.id } : {})}
            marked={marked}
            letter={letter}
            first={me}
            start={!target.note}
            verb={target.note ? "could not start" : "started"}
            second={peer}
            note={target.note}
            failed={Boolean(target.note)}
            at={block.at}
            onOpen={target.note ? undefined : (open(target) ?? (pending && started.kind !== "sessions" ? () => setOpening(true) : undefined))}
            peek={!target.note && prompt ? { title: `What ${peer.name} was asked`, text: prompt } : undefined}
          />
        );
      })}
    </div>
  );
});

/** A Crew subagent's report letter: that it came, where it arrived. Its name's thread opens at that turn. */
export const ReportLetter = memo(function ReportLetter({ block, marked }: { block: Block; marked: string | null }) {
  const from = block.fromBot;
  const { sessions } = useLetterScope();
  const { openAgent } = useChatActions();
  const peer = usePeer(from?.id, from?.name ?? "agent");
  const me = useOwnerPeer();
  if (!from || !block.letterId) return null;
  const letter = block.letterId;
  return (
    <Beat
      report
      id={block.id}
      marked={marked}
      letter={letter}
      first={peer}
      verb="reported to"
      second={me}
      at={block.at}
      onOpen={from.id && sessions.some((row) => row.id === from.id) ? () => openAgent(from.id, { focus: letter }) : undefined}
      peek={{ title: `What ${peer.name} reported`, text: exitedless(block) }}
    />
  );
});

/** A message out: `Message to [peer]` with how it went over, and the words in a card. */
const SentRow = memo(function SentRow({ block, marked }: { block: Block; marked: string | null }) {
  const sent = sentOf(block);
  const peer = usePeer(sent?.to.id, sent?.to.name ?? "", sent?.to.provider);
  const { inThread, sessions } = useLetterScope();
  const { openAgent } = useChatActions();
  const me = useOwnerPeer();
  if (!sent) return null;
  if (!inThread) {
    const letter = sent.letterId;
    const words = sent.text.trim();
    return (
      <Beat
        id={block.id}
        marked={marked}
        letter={letter}
        first={me}
        verb={sent.handoff ? "handed you" : "wrote to"}
        second={peer}
        note={sent.delivery ?? undefined}
        at={block.at}
        onOpen={peer.id && sessions.some((row) => row.id === peer.id) ? () => openAgent(peer.id!, letter ? { focus: letter } : undefined) : undefined}
        peek={words ? { title: `Message to ${peer.name}`, text: sent.text } : undefined}
      />
    );
  }
  return <Speech id={block.id} marked={marked} letter={sent.letterId} peer={me ?? peer} at={block.at} text={sent.text} />;
});

const CONTROL_ICON = {
  interrupt: HandIcon,
  read: EyeIcon,
  list: UsersIcon,
  stop: CircleStopIcon,
  rename: PencilIcon,
  delete: Trash2Icon,
} as const;

/** `interrupt_session`, `read_session`, `list_peers`, `stop_session`, `update_session`: one line. What a redirect said is in that agent's thread. */
export const ControlRow = memo(function ControlRow({ block, marked }: { block: Block; marked: string | null }) {
  const control = controlOf(block);
  const target = control?.target;
  const peer = usePeer(target?.id, target?.name ?? "", target?.provider);
  if (!control) return null;
  const icon = CONTROL_ICON[control.icon];
  return (
    <ToolLine icon={icon} id={block.id} marked={marked}>
      {control.before}
      {target ? (
        <>
          {" "}
          <PeerName peer={peer} />
        </>
      ) : null}
      {control.after}
    </ToolLine>
  );
});

/**
 * A letter from another party (a session, a bot, a parent): its mark in a tile,
 * its name, what kind of letter it is, and the words under it. Not a bubble: the
 * bubble is the user's. A session's question or approval carries its open
 * request under the words.
 */
const LetterIn = memo(function LetterIn({ block, marked }: { block: Block; marked: string | null }) {
  const { inThread } = useLetterScope();
  return inThread ? <LetterInThread block={block} marked={marked} /> : <LetterBeat block={block} marked={marked} />;
});

/**
 * A letter another party wrote to this chat. Its words open in that party's
 * thread when it works for this chat, else in the conversation between the two.
 */
function LetterBeat({ block, marked }: { block: Block; marked: string | null }) {
  const entries = useContext(WorkContext);
  const { sessions, owner, openThread } = useLetterScope();
  const { openAgent } = useChatActions();
  const from = block.fromBot;
  const peer = usePeer(from?.id, from?.name ?? "", undefined);
  const me = useOwnerPeer();
  if (!from) return null;
  const words = exitedless(block);
  if (block.letterKind === "started") {
    return <Beat id={block.id} marked={marked} letter={block.letterId} first={peer} verb="started" second={me} at={block.at} peek={{ title: `What ${peer.name} asked`, text: words }} />;
  }
  const asks = block.letterKind === "question" || block.letterKind === "approval";
  const child = from.id ? sessions.find((row) => row.id === from.id && row.kind !== "bot") : undefined;
  const letter = block.letterId;
  const focus = letter ? { focus: letter } : undefined;
  const open = () => {
    if (entries.some((one) => one.id === `session:${from.id}`)) return openAgent(from.id, focus);
    if (owner) openThread({ a: owner, b: resolveParty({ id: from.id, name: from.name }, sessions, owner.id), ...(focus ?? {}) });
  };
  return (
    <Beat
      id={block.id}
      marked={marked}
      letter={letter}
      first={peer}
      verb={asks ? "asked" : "wrote to"}
      second={me}
      waiting={asks && child?.status === "needs-input"}
      at={block.at}
      onOpen={child || sessions.some((row) => row.id === from.id) ? open : undefined}
      peek={{ title: `Message from ${peer.name}`, text: words }}
    />
  );
}

/** Inside an agent's thread: a letter's words are what the thread is made of. */
function LetterInThread({ block, marked }: { block: Block; marked: string | null }) {
  const from = block.fromBot;
  const peer = usePeer(from?.id, from?.name ?? "", undefined);
  if (!from) return null;
  const sentAt = (block as ThreadBlock).sentAt;
  const late = sentAt !== undefined && block.at !== undefined && block.at - sentAt > LATE_MS;
  return (
    <Speech
      id={block.id}
      marked={marked}
      letter={block.letterId}
      peer={peer}
      at={late ? sentAt : block.at}
      tag={block.letterKind === "started" ? "Brief" : block.letterKind === "report" ? "Report" : undefined}
      note={late ? `reached it ${clock(block.at!)}` : undefined}
      text={exitedless(block)}
    />
  );
}

/** A letter this long after it was sent says so: the agent worked without it until then. */
const LATE_MS = 60_000;

/**
 * Someone other than the user, in a thread: on the left, with their mark and
 * name. The user is the bubble on the right, in any conversation.
 */
function Speech({ id, marked, letter, peer, at, tag, note, text }: { id: string; marked: string | null; letter?: string | undefined; peer: Peer; at?: number | undefined; tag?: string | undefined; note?: string | undefined; text: string }) {
  return (
    <div data-block={id} data-letter={letter} className={`flex gap-2.5 rounded-xl${id === marked ? " crew-found" : ""}`}>
      <span className="mt-0.5 grid size-7 shrink-0 place-items-center">
        <PeerMark peer={peer} className="size-6" />
      </span>
      <div className="flex min-w-0 flex-1 flex-col items-start gap-1">
        <div className="flex items-baseline gap-1.5 px-0.5 text-[12px] leading-4">
          <span className="font-medium text-text">{peer.name}</span>
          {at !== undefined ? <span className="text-placeholder tabular-nums">{clock(at)}</span> : null}
          {note ? <span className="text-placeholder">· {note}</span> : null}
        </div>
        <div className="max-w-full min-w-0 rounded-2xl rounded-tl-md bg-card px-3.5 py-2.5">
          {tag ? <div className="mb-1 text-[11px] font-medium text-text-muted">{tag}</div> : null}
          <Suspense fallback={<p className="whitespace-pre-wrap">{text}</p>}>
            <Markdown text={text} />
          </Suspense>
        </div>
      </div>
    </div>
  );
}

/** What an agent said at the end of a turn, in its own thread. */
export function AgentAnswer({ block, report }: { block: Block; report: boolean }) {
  const { speaker } = useLetterScope();
  const me = useOwnerPeer();
  const peer: Peer = speaker ?? me ?? { name: "Agent" };
  return <Speech id={block.id} marked={null} letter={block.letterId} peer={peer} at={block.at} tag={report ? "Report" : undefined} text={block.text} />;
}

/** The user's words on the right; a native subagent's prompt is the words of whoever asked it. */
export function AskedOrSaid({ block }: { block: Block }) {
  const { asker } = useLetterScope();
  if (!asker) return <UserMessage block={block} />;
  return <Speech id={block.id} marked={null} peer={asker} at={block.at} tag="Brief" text={block.text} />;
}

/** The beat a note leaves when the user writes to a child: its name opens that child's thread at the letter. */
const WroteLine = memo(function WroteLine({ block, marked }: { block: Block; marked: string | null }) {
  const { owner, sessions } = useLetterScope();
  const { openAgent } = useChatActions();
  const mark = owner ? checkpointOf(block, owner, botLabel) : null;
  const to = mark && owner ? resolveParty(mark.to, sessions, owner.id) : null;
  const peer = peerOf(sessions, to?.id || undefined, to?.name ?? "");
  if (!mark || mark.from.id !== USER) return block.role === "user" ? <UserMessage block={block} /> : <Note block={block} />;
  const target = peer.id && sessions.some((row) => row.id === peer.id) ? peer.id : undefined;
  return <Beat id={block.id} marked={marked} letter={mark.letterId} first="you" verb="wrote to" second={peer} at={block.at} onOpen={target ? () => openAgent(target, { focus: mark.letterId }) : undefined} />;
});

/** A letter row: the message this chat sent, the letter it received, or the note a write to a child leaves. */
export const LetterRow = memo(function LetterRow({ block, marked }: { block: Block; marked: string | null }) {
  if (block.role === "tool") return <SentRow block={block} marked={marked} />;
  if (block.role === "user" && block.fromBot) return <LetterIn block={block} marked={marked} />;
  return <WroteLine block={block} marked={marked} />;
});
