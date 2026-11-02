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
  SendIcon,
  Trash2Icon,
  UsersIcon,
  type LucideIcon,
} from "lucide-react";
import { lazy, memo, Suspense, useContext, useState, type ReactNode } from "react";
import { useOpenAsk } from "../../hooks/useOpenAsk";
import { isOpen, type Block } from "../../lib/blocks";
import { answer, respond } from "../../lib/turnRuntime";
import { ApprovalCard } from "./ApprovalCard";
import { QuestionCard } from "./QuestionCard";
import { botLabel } from "../../lib/botNames";
import { checkpointOf, resolveParty, USER } from "../../lib/letters";
import {
  controlOf,
  envelopeOf,
  FOLD_LINES,
  foldsLongText,
  isQuickQuestion,
  exitedless,
  nativeName,
  optionless,
  nativeReport,
  nativeReportAt,
  sentOf,
  startedOf,
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

/** A card hanging under a row: indented to the row's text, hairline, the app's radius. */
export function Hang({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <div data-hang className={`ml-[26px] overflow-hidden rounded-xl ring-1 ring-hairline ${className}`}>{children}</div>;
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

/** A long text, folded at seven lines with a way to read it all. */
export function LongText({ text, lines = FOLD_LINES, fold = true }: { text: string; lines?: number; fold?: boolean }) {
  const [open, setOpen] = useState(false);
  const folds = fold && foldsLongText(text, lines);
  const total = text.split("\n").length;
  return (
    <div className="flex flex-col">
      <div
        className={`relative text-[length:var(--chat-text)] leading-[21px] ${folds && !open ? "overflow-hidden [mask-image:linear-gradient(to_bottom,black_60%,transparent)]" : ""}`}
        style={folds && !open ? { maxHeight: `${lines * 21}px` } : undefined}
      >
        <Suspense fallback={<p className="whitespace-pre-wrap">{text}</p>}>
          <Markdown text={text} />
        </Suspense>
      </div>
      {folds ? (
        <button
          type="button"
          onClick={() => setOpen((was) => !was)}
          className="-ml-1.5 mt-1 self-start rounded-chrome px-1.5 py-0.5 text-[12px] text-text-muted transition-colors hover:bg-hover hover:text-text"
        >
          {open ? "Show less" : `Show all · ${total} lines`}
        </button>
      ) : null}
    </div>
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
  const { sessions } = useLetterScope();
  const me = useOwnerPeer();
  const started = startedOf(block);
  if (!started) return null;
  const peerOf = (target: CrewTarget): Peer => {
    const session = target.id ? sessions.find((row) => row.id === target.id) : undefined;
    return { id: target.id, name: session?.name ?? target.name, provider: session?.provider ?? target.provider, bot: false };
  };
  const open = (target: CrewTarget) => {
    const entry = target.id ? entries.find((one) => one.id === `session:${target.id}`) : undefined;
    return entry ? () => openAgent(entry.id) : target.id && sessions.some((row) => row.id === target.id) ? () => openAgent(target.id!) : undefined;
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
            first={me}
            start={!target.note}
            verb={target.note ? "could not start" : "started"}
            second={peer}
            note={target.note}
            failed={Boolean(target.note)}
            at={block.at}
            onOpen={target.note ? undefined : open(target)}
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
  return (
    <div data-letter={sent.letterId} className="flex flex-col gap-1.5">
      <ToolLine icon={SendIcon} id={block.id} marked={marked}>
        {sent.handoff ? "Handed" : "Message to"} <PeerName peer={peer} {...(sent.letterId ? { focus: sent.letterId } : {})} />
        {sent.handoff ? " to you" : ""}
        {sent.delivery ? <span className="text-placeholder"> · {sent.delivery}</span> : null}
      </ToolLine>
      {sent.text.trim() ? (
        <Hang className="px-3.5 py-2.5">
          <LongText text={sent.text} />
        </Hang>
      ) : null}
    </div>
  );
});

const CONTROL_ICON = {
  interrupt: HandIcon,
  read: EyeIcon,
  list: UsersIcon,
  stop: CircleStopIcon,
  rename: PencilIcon,
  delete: Trash2Icon,
} as const;

/** `interrupt_session`, `read_session`, `list_peers`, `stop_session`, `update_session`: one line, and a card only for text. */
export const ControlRow = memo(function ControlRow({ block, marked }: { block: Block; marked: string | null }) {
  const control = controlOf(block);
  const target = control?.target;
  const peer = usePeer(target?.id, target?.name ?? "", target?.provider);
  if (!control) return null;
  const icon = CONTROL_ICON[control.icon];
  return (
    <div className="flex flex-col gap-1.5">
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
      {control.text ? (
        <Hang className="px-3.5 py-2.5 text-[13.5px] leading-[20px] text-text-muted">
          <span className="whitespace-pre-wrap">{control.text}</span>
        </Hang>
      ) : null}
    </div>
  );
});

/** What a child's open request says once it is settled: how it ended, in the card's own words. */
function settledOf(block: Block): string {
  if (block.role === "approval") return block.approval?.decided === "deny" ? "Denied" : "Allowed";
  return block.question?.dismissed ? "Dismissed" : "Answered";
}

/**
 * The child's open question or approval, under the letter that carries it
 * (orchestration plan, decision 25): a single choice as chips, a longer form as
 * the question card, an approval as its card. Answered here or in the thread,
 * the first answer counts and the rest disable.
 */
function ChildAsk({ child, ask, by, onBy }: { child: Session; ask: Block; by: boolean; onBy: () => void }) {
  const { owner } = useLetterScope();
  const open = isOpen(ask);
  const who = owner?.name ?? "the parent";
  if (open && ask.role === "approval") {
    return (
      <div className="mt-1 max-w-[560px]" data-ask="approval">
        <ApprovalCard
          block={ask}
          onApprove={(requestId, decision) => {
            onBy();
            respond(child, requestId, decision);
          }}
        />
        <span className="text-[11.5px] text-placeholder">You or {who} can decide · the first answer counts</span>
      </div>
    );
  }
  if (open && !isQuickQuestion(ask)) {
    return (
      <div className="mt-1 max-w-[560px]" data-ask="question">
        <QuestionCard
          block={ask}
          onAnswer={(requestId, answers) => {
            onBy();
            answer(child, requestId, answers);
          }}
        />
        <span className="text-[11.5px] text-placeholder">You or {who} can answer · the first answer counts</span>
      </div>
    );
  }
  const note = open ? `You or ${who} can answer` : `${settledOf(ask)}${by ? " by you" : ""} · the first answer counts`;
  const question = ask.question?.questions[0];
  const picked = ask.question?.answers?.[question?.question ?? ""];
  return (
    <div className="mt-1.5 flex flex-wrap gap-1.5" data-ask={ask.role} data-settled={open ? undefined : ""}>
      {ask.role === "question"
        ? question?.options.map((option) => (
            <button
              key={option.label}
              type="button"
              disabled={!open}
              onClick={() => {
                onBy();
                answer(child, ask.question!.requestId, { [question.question]: option.label });
              }}
              data-picked={picked === option.label ? "" : undefined}
              className={`h-7 rounded-md px-2.5 text-[12.5px] ring-1 transition-colors ${
                picked === option.label ? "text-text ring-border-strong" : "ring-hairline enabled:hover:bg-hover disabled:opacity-50"
              }`}
            >
              {option.label}
            </button>
          ))
        : null}
      <span className="self-center text-[11.5px] text-placeholder">{note}</span>
    </div>
  );
}

/** Reads the child's thread, so it is only mounted while the child asks (and after, to show how it ended). */
function WatchedLetter({ child, block, marked, by, onBy }: { child: Session; block: Block; marked: string | null; by: boolean; onBy: () => void }) {
  const kind = block.letterKind === "approval" ? "approval" : "question";
  const ask = useOpenAsk(child.id, kind, block.text);
  return <LetterFrame block={block} marked={marked} child={child} ask={ask} by={by} onBy={onBy} />;
}

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
const LetterInThread = memo(function LetterInThread({ block, marked }: { block: Block; marked: string | null }) {
  const { sessions } = useLetterScope();
  const [watching, setWatching] = useState(false);
  const [by, setBy] = useState(false);
  const asks = block.letterKind === "question" || block.letterKind === "approval";
  const child = asks && block.fromBot?.id ? sessions.find((row) => row.id === block.fromBot?.id && row.kind !== "bot") : undefined;
  // Once it has asked it stays mounted: the answer is read from the same thread.
  if (child?.status === "needs-input" && !watching) setWatching(true);
  if (child && watching) return <WatchedLetter child={child} block={block} marked={marked} by={by} onBy={() => setBy(true)} />;
  return <LetterFrame block={block} marked={marked} child={child} ask={null} by={by} onBy={() => setBy(true)} />;
});

function LetterFrame({ block, marked, child, ask, by, onBy }: { block: Block; marked: string | null; child: Session | undefined; ask: Block | null; by: boolean; onBy: () => void }) {
  const from = block.fromBot;
  const peer = usePeer(from?.id, from?.name ?? "", undefined);
  const { openAgent } = useChatActions();
  if (!from) return null;
  const { word, tag } = envelopeOf(block.letterKind);
  const id = peer.id;
  // A session's question names its tag only while its request is open.
  const tagged = tag && (!child || (ask && isOpen(ask)));
  return (
    <div data-letter={block.letterId} data-letter-in className={`flex gap-2.5 rounded-xl py-1${lit(block.id, marked)}`}>
      <span className="mt-px grid size-6 shrink-0 place-items-center rounded-md bg-card">
        <PeerMark peer={peer} className="size-3.5" />
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <div className="flex items-baseline gap-1.5 text-[12.5px]">
          {id ? (
            <button
              type="button"
              onClick={() => openAgent(id, block.letterId ? { focus: block.letterId } : undefined)}
              className="rounded-chrome font-medium text-text hover:underline"
            >
              {peer.name}
            </button>
          ) : (
            <span className="font-medium text-text">{peer.name}</span>
          )}
          <span className="text-text-muted">{word}</span>
          {tagged ? <span data-letter-tag className="text-placeholder"><span data-sep>· </span>{tag}</span> : null}
        </div>
        {/* The options are buttons under it: the letter's own list of them would say them twice. */}
        <LongText text={child && ask?.role === "question" ? optionless(exitedless(block)) : exitedless(block)} fold={block.letterKind !== "started"} />
        {child && ask ? <ChildAsk child={child} ask={ask} by={by} onBy={onBy} /> : null}
      </div>
    </div>
  );
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
