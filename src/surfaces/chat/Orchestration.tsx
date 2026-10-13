/**
 * How orchestration reads in a transcript (orchestration plan, decisions
 * 19–21 and 27): a one-line tool row, and when there is more to read a card
 * hanging under it. A native subagent and a Crew subagent are the same row
 * and the same card; the card reads from the chat's work list, so it says
 * what the sheet says.
 */
import {
  BotIcon,
  CircleStopIcon,
  EyeIcon,
  HandIcon,
  MessageSquareIcon,
  MessagesSquareIcon,
  PencilIcon,
  SquareTerminalIcon,
  SendIcon,
  Trash2Icon,
  UsersIcon,
  type LucideIcon,
} from "lucide-react";
import { lazy, memo, Suspense, useContext, useState, type ReactNode } from "react";
import { BotAvatar } from "../../chrome/BotAvatar";
import { ProviderIcon } from "../../chrome/ProviderIcon";
import type { PanelEntry, PanelState } from "../../lib/backgroundPanel";
import { useOpenAsk } from "../../hooks/useOpenAsk";
import { isOpen, type Block } from "../../lib/blocks";
import { answer, respond } from "../../lib/turnRuntime";
import { ApprovalCard } from "./ApprovalCard";
import { QuestionCard } from "./QuestionCard";
import { botLabel } from "../../lib/botNames";
import { checkpointOf, resolveParty, USER } from "../../lib/letters";
import {
  agentMeta,
  controlOf,
  envelopeOf,
  firstLine,
  FOLD_LINES,
  foldsLongText,
  isQuickQuestion,
  exitedless,
  nativeName,
  nativeReport,
  sentOf,
  startedOf,
  startedSessionsSentence,
} from "../../lib/orchestration";
import type { CrewTarget } from "../../lib/protocol";
import { agentDetail, entryOfCall, resumesEntry, subagentView } from "../../lib/subagent";
import { useChatActions, useLetterScope, WorkContext } from "./context";
import { Note, UserMessage } from "./Message";
import { StateDot } from "./Panel";
import type { Session } from "../../lib/types";

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
  return <div className={`ml-[26px] overflow-hidden rounded-xl ring-1 ring-hairline ${className}`}>{children}</div>;
}

/** Who a name stands for: a bot is its face, an agent its CLI's mark. */
export type Peer = { id?: string | undefined; name: string; provider?: string | undefined; bot?: boolean | undefined };

export function PeerMark({ peer, className }: { peer: Peer; className: string }) {
  if (peer.bot && peer.id) return <BotAvatar seed={peer.id} bare className={`${className} shrink-0`} />;
  if (peer.provider) return <ProviderIcon provider={peer.provider} className={`${className} shrink-0`} />;
  // A session whose CLI is not known (gone, or named only by a call): a neutral mark. Only a bot has a face.
  return <SquareTerminalIcon aria-hidden className={`${className} shrink-0 text-icon`} />;
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
const PEER_CHIP = "ml-0.5 inline-flex h-[18px] max-w-[24em] items-center gap-1.5 align-top font-medium text-text";

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

/**
 * One agent's line inside a card: where it is, what it was asked, and how far
 * it got. The whole line opens its thread when there is one to open.
 */
export function AgentLine({
  state,
  title,
  meta,
  peer,
  onOpen,
}: {
  state: PanelState;
  title: string;
  meta: string;
  /** Set when the line names the agent: a card of several lines. */
  peer?: Peer;
  onOpen?: (() => void) | undefined;
}) {
  const body = (
    <>
      <StateDot state={state} />
      {peer ? <PeerMark peer={peer} className="size-3.5" /> : null}
      <span className="min-w-0 shrink truncate text-text">{title}</span>
      <span className="min-w-0 flex-1" />
      <span className="max-w-[55%] shrink-0 truncate text-text-muted tabular-nums">{meta}</span>
    </>
  );
  const className = "flex w-full items-center gap-2.5 px-3 py-2 text-left text-[12.5px] leading-[18px]";
  if (!onOpen) return <div data-agent-card className={className}>{body}</div>;
  return (
    <button type="button" data-agent-card onClick={onOpen} className={`${className} transition-colors hover:bg-hover`}>
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
        className={`relative text-[14px] leading-[21px] ${folds && !open ? "overflow-hidden [mask-image:linear-gradient(to_bottom,black_60%,transparent)]" : ""}`}
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

/**
 * That an agent reported, where the report arrived: one row like the one that started it, and its name opens
 * its thread at that turn, where the report is read whole. An agent with no thread to open shows the words here, whole.
 */
export function Report({ peer, text, target, focus }: { peer: Peer; text: string; target: string | undefined; focus?: string }) {
  return (
    <div className="flex flex-col gap-1" data-report>
      <ToolLine icon={BotIcon}>
        Report from <PeerName peer={{ ...peer, id: target }} {...(focus ? { focus } : {})} />
      </ToolLine>
      {target ? null : (
        <Hang className="bg-card px-3.5 py-2.5">
          <LongText text={text} fold={false} />
        </Hang>
      )}
    </div>
  );
}

/** What the work list knows about a Crew session an agent row names. */
function entryOf(entries: readonly PanelEntry[], sessionId: string | undefined): PanelEntry | undefined {
  return sessionId ? entries.find((entry) => entry.id === `session:${sessionId}`) : undefined;
}

/** The facts a card says about one entry. */
function entryFacts(entry: PanelEntry) {
  return {
    state: entry.state,
    tokens: entry.tokens,
    activity: entry.activity,
    startedAt: entry.startedAt,
    endedAt: entry.endedAt,
  };
}

/**
 * A native subagent's call, whichever CLI ran it: `Started a subagent [mark]
 * Explore` and a card with what it was asked and where it stands. When it has
 * answered, its report is drawn under the card, at the point its call ended.
 */
export const SubagentCall = memo(function SubagentCall({ block, marked }: { block: Block; marked: string | null }) {
  const entries = useContext(WorkContext);
  const { sessions, owner } = useLetterScope();
  const { openAgent } = useChatActions();
  const detail = agentDetail(block);
  const view = subagentView(block);
  if (!detail || !view) return null;
  const entry = entryOfCall(entries, block);
  // A call that goes on with a subagent an earlier call started has its own steps and state: the entry is the whole subagent's.
  const resumed = resumesEntry(entry, block);
  const provider = entry?.provider ?? sessions.find((row) => row.id === owner?.id)?.provider;
  const peer: Peer = { name: nativeName(detail), provider };
  const state = detail.thread ? view.state : (entry?.state ?? view.state);
  const meta = agentMeta(entry ? { ...entryFacts(entry), state } : { state, activity: view.current });
  const report = state === "done" ? nativeReport(block) : null;
  return (
    <div className="flex flex-col gap-1.5">
      <ToolLine icon={BotIcon} id={block.id} marked={marked}>
        {resumed ? "Resumed a subagent" : "Started a subagent"}{" "}
        {entry ? (
          <button type="button" onClick={() => openAgent(entry.id)} className={`${PEER_CHIP} rounded-chrome hover:underline`}>
            <PeerMark peer={peer} className="size-3.5" />
            <span className="truncate">{peer.name}</span>
          </button>
        ) : (
          <PeerName peer={peer} />
        )}
      </ToolLine>
      <Hang>
        <AgentLine
          state={state}
          title={firstLine(detail.prompt ?? "") || detail.description || "Subagent"}
          meta={meta}
          onOpen={entry ? () => openAgent(entry.id) : undefined}
        />
      </Hang>
      {report ? <Report peer={peer} text={report} target={entry?.id} /> : null}
    </div>
  );
});

/** The line a Crew start makes for one session: the work list's entry, else what the call said. */
function lineOf(entries: readonly PanelEntry[], target: CrewTarget, block: Block) {
  const entry = entryOf(entries, target.id);
  if (entry) return { state: entry.state, meta: agentMeta(entryFacts(entry)), entry };
  const failed = block.tool?.status === "failed";
  const state: PanelState = failed ? "failed" : block.tool?.status === "pending" ? "running" : "done";
  return { state, meta: agentMeta({ state }), entry: undefined };
}

/**
 * A Crew call that started something: `delegate` is a subagent, `start_session`
 * a session, `start_sessions` several, one line each. The prompt is not
 * unfolded here: it is the session's first letter, at the top of its thread.
 */
export const StartedRow = memo(function StartedRow({ block, marked }: { block: Block; marked: string | null }) {
  const entries = useContext(WorkContext);
  const { openAgent } = useChatActions();
  const { sessions } = useLetterScope();
  const started = startedOf(block);
  if (!started) return null;
  const peerOf = (target: CrewTarget): Peer => {
    const session = target.id ? sessions.find((row) => row.id === target.id) : undefined;
    return { id: target.id, name: session?.name ?? target.name, provider: session?.provider ?? target.provider, bot: false };
  };

  if (started.kind === "sessions") {
    const { targets } = started;
    return (
      <div className="flex flex-col gap-1.5">
        <ToolLine icon={MessagesSquareIcon} id={block.id} marked={marked}>
          {startedSessionsSentence(targets)}
        </ToolLine>
        <span className="-mt-0.5 ml-[26px] text-[11.5px] text-placeholder">They're yours: in the sidebar, and in Work while they run.</span>
        <Hang className="divide-y divide-hairline">
          {targets.map((target, index) => {
            const peer = peerOf(target);
            if (target.note) {
              return (
                <div key={`${target.name}-${index}`} className="flex items-center gap-2.5 px-3 py-2 text-[12.5px] leading-[18px] text-danger">
                  <StateDot state="failed" />
                  <span className="min-w-0 truncate">
                    {target.name} · {target.note}
                  </span>
                </div>
              );
            }
            const line = lineOf(entries, target, block);
            return (
              <AgentLine
                key={target.id ?? `${target.name}-${index}`}
                state={line.state}
                title={peer.name}
                meta={line.meta}
                peer={peer}
                onOpen={line.entry ? () => openAgent(line.entry!.id) : undefined}
              />
            );
          })}
        </Hang>
      </div>
    );
  }

  const peer = peerOf(started.target);
  const subagent = started.kind === "subagent";
  const line = lineOf(entries, started.target, block);
  return (
    <div className="flex flex-col gap-1.5">
      <ToolLine
        icon={subagent ? BotIcon : MessagesSquareIcon}
        id={block.id}
        marked={marked}
      >
        {subagent ? "Started a subagent" : "Started a session"} <PeerName peer={peer} />
      </ToolLine>
      <Hang>
        <AgentLine
          state={line.state}
          title={firstLine(started.prompt) || peer.name}
          meta={line.meta}
          onOpen={line.entry ? () => openAgent(line.entry!.id) : undefined}
        />
      </Hang>
    </div>
  );
});

/** A Crew subagent's report letter: the words it brought back, where they arrived. */
export const ReportLetter = memo(function ReportLetter({ block, marked }: { block: Block; marked: string | null }) {
  const from = block.fromBot;
  const peer = usePeer(from?.id, from?.name ?? "agent");
  if (!from || !block.letterId) return null;
  return (
    <div data-block={block.id} className={`rounded-xl${lit(block.id, marked)}`}>
      <Report peer={peer} text={exitedless(block)} target={from.id} focus={block.letterId} />
    </div>
  );
});

/** A message out: `Message to [peer]` with how it went over, and the words in a card. */
const SentRow = memo(function SentRow({ block, marked }: { block: Block; marked: string | null }) {
  const sent = sentOf(block);
  const peer = usePeer(sent?.to.id, sent?.to.name ?? "", sent?.to.provider);
  if (!sent) return null;
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
              className={`h-7 rounded-md px-2.5 text-[12.5px] ring-1 transition-colors ${
                picked === option.label ? "bg-selected text-text ring-border-strong" : "ring-hairline enabled:hover:bg-hover disabled:opacity-50"
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
    <div data-letter={block.letterId} className={`flex gap-2.5 rounded-xl py-1${lit(block.id, marked)}`}>
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
          {tagged ? <span className="text-placeholder">· {tag}</span> : null}
        </div>
        <LongText text={exitedless(block)} fold={block.letterKind !== "started"} />
        {child && ask ? <ChildAsk child={child} ask={ask} by={by} onBy={onBy} /> : null}
      </div>
    </div>
  );
}

/** The line a note leaves when the user writes to a child: its name opens that child's thread at the letter. */
const WroteLine = memo(function WroteLine({ block, marked }: { block: Block; marked: string | null }) {
  const { owner, sessions } = useLetterScope();
  const mark = owner ? checkpointOf(block, owner, botLabel) : null;
  const to = mark && owner ? resolveParty(mark.to, sessions, owner.id) : null;
  const peer = peerOf(sessions, to?.id || undefined, to?.name ?? "");
  if (!mark || mark.from.id !== USER) return block.role === "user" ? <UserMessage block={block} /> : <Note block={block} />;
  return (
    <div data-letter={mark.letterId}>
      <ToolLine icon={MessageSquareIcon} id={block.id} marked={marked}>
        You wrote to <PeerName peer={peer} focus={mark.letterId} />
      </ToolLine>
    </div>
  );
});

/** A letter row: the message this chat sent, the letter it received, or the note a write to a child leaves. */
export const LetterRow = memo(function LetterRow({ block, marked }: { block: Block; marked: string | null }) {
  if (block.role === "tool") return <SentRow block={block} marked={marked} />;
  if (block.role === "user" && block.fromBot) return <LetterIn block={block} marked={marked} />;
  return <WroteLine block={block} marked={marked} />;
});
