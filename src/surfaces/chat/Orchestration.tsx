/**
 * How orchestration reads in a transcript (orchestration plan, decisions
 * 19–21 and 27): a one-line tool row, and when there is more to read a card
 * hanging under it. A native subagent and a Crew subagent are the same row
 * and the same card; the card reads from the chat's work list, so it says
 * what the sheet says.
 */
import { BotIcon, MessagesSquareIcon, type LucideIcon } from "lucide-react";
import { lazy, memo, Suspense, useContext, useState, type ReactNode } from "react";
import { BotAvatar } from "../../chrome/BotAvatar";
import { ProviderIcon } from "../../chrome/ProviderIcon";
import type { PanelEntry, PanelState } from "../../lib/backgroundPanel";
import type { Block } from "../../lib/blocks";
import {
  agentMeta,
  firstLine,
  FOLD_LINES,
  foldsLongText,
  nativeName,
  nativeReport,
  startedOf,
  startedSessionsSentence,
} from "../../lib/orchestration";
import type { CrewTarget } from "../../lib/protocol";
import { agentDetail, subagentView } from "../../lib/subagent";
import { useChatActions, useLetterScope, WorkContext } from "./context";
import { StateDot } from "./Panel";

/** streamdown is half a megabyte: a long text loads it when it is first drawn. */
const Markdown = lazy(() => import("./Markdown").then((m) => ({ default: m.Markdown })));

const lit = (id: string, marked: string | null) => (id === marked ? " crew-found" : "");

/** A one-line row: the node, a sentence, and the tool's own name as a muted aside. */
export function ToolLine({
  icon: Glyph,
  aside,
  children,
  id,
  marked = null,
}: {
  icon: LucideIcon;
  aside?: ReactNode;
  children: ReactNode;
  id?: string;
  marked?: string | null;
}) {
  return (
    <div
      data-block={id}
      className={`flex min-h-[26px] items-center gap-2 py-0.5 text-[13px] leading-[18px] text-text-muted${id ? lit(id, marked) : ""}`}
    >
      <span className="crew-node">
        <Glyph className="size-3.5" />
      </span>
      <span className="min-w-0 flex-1 truncate">{children}</span>
      {aside ? <span className="shrink-0 text-[11px] text-placeholder">{aside}</span> : null}
    </div>
  );
}

/** A card hanging under a row: indented to the row's text, hairline, the app's radius. */
export function Hang({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <div className={`ml-[26px] overflow-hidden rounded-xl ring-1 ring-hairline ${className}`}>{children}</div>;
}

/** Who a name stands for: a bot is its face, an agent its CLI's mark. */
export type Peer = { id?: string | undefined; name: string; provider?: string | undefined; bot?: boolean | undefined };

function PeerMark({ peer, className }: { peer: Peer; className: string }) {
  if (peer.bot && peer.id) return <BotAvatar seed={peer.id} bare className={`${className} shrink-0`} />;
  if (peer.provider) return <ProviderIcon provider={peer.provider} className={`${className} shrink-0`} />;
  return <BotIcon aria-hidden className={`${className} shrink-0 text-icon`} />;
}

/** A session or a bot as the chat's sessions know it. */
function usePeer(id: string | undefined, name: string, provider?: string): Peer {
  const { sessions } = useLetterScope();
  const session = id ? sessions.find((row) => row.id === id) : undefined;
  return {
    id,
    name,
    provider: session?.provider ?? provider,
    bot: session ? session.kind === "bot" : undefined,
  };
}

/** The mark and the name, in `text-text`; a click opens that party (its thread, or a bot's chat). */
export function PeerName({ peer, focus }: { peer: Peer; focus?: string }) {
  const { openAgent } = useChatActions();
  const body = (
    <>
      <PeerMark peer={peer} className="size-3.5" />
      {peer.name}
    </>
  );
  if (!peer.id) return <span className="inline-flex items-center gap-1 align-[-3px] text-text">{body}</span>;
  const id = peer.id;
  return (
    <button
      type="button"
      onClick={() => openAgent(id, focus ? { focus } : undefined)}
      className="inline-flex items-center gap-1 rounded-chrome align-[-3px] text-text hover:underline"
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
export function LongText({ text, lines = FOLD_LINES }: { text: string; lines?: number }) {
  const [open, setOpen] = useState(false);
  const folds = foldsLongText(text, lines);
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

/** What an agent said when it was done, where it arrived: the label opens its thread at that turn. */
export function Report({ peer, text, target, focus }: { peer: Peer; text: string; target: string | undefined; focus?: string }) {
  const { openAgent } = useChatActions();
  const label = (
    <>
      Report from
      <PeerMark peer={peer} className="size-3.5" />
      <span className="text-text">{peer.name}</span>
    </>
  );
  return (
    <div className="ml-[26px] flex flex-col gap-1" data-report>
      {target ? (
        <button
          type="button"
          onClick={() => openAgent(target, focus ? { focus } : undefined)}
          className="inline-flex items-center gap-1 self-start rounded-chrome text-[12px] text-text-muted hover:underline"
        >
          {label}
        </button>
      ) : (
        <span className="inline-flex items-center gap-1 text-[12px] text-text-muted">{label}</span>
      )}
      <div className="rounded-xl bg-card px-3.5 py-2.5">
        <LongText text={text} />
      </div>
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
  const entry = block.tool ? entries.find((one) => one.callId === block.tool?.callId) : undefined;
  const provider = entry?.provider ?? sessions.find((row) => row.id === owner?.id)?.provider;
  const peer: Peer = { name: nativeName(detail), provider };
  const state = entry?.state ?? view.state;
  const meta = agentMeta(entry ? entryFacts(entry) : { state, activity: view.current });
  const report = state === "done" ? nativeReport(block) : null;
  return (
    <div className="flex flex-col gap-1.5">
      <ToolLine icon={BotIcon} aside={block.tool?.name} id={block.id} marked={marked}>
        Started a subagent{" "}
        {entry ? (
          <button type="button" onClick={() => openAgent(entry.id)} className="inline-flex items-center gap-1 rounded-chrome align-[-3px] text-text hover:underline">
            <PeerMark peer={peer} className="size-3.5" />
            {peer.name}
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
        <ToolLine icon={MessagesSquareIcon} aside="start_sessions" id={block.id} marked={marked}>
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
        aside={subagent ? "delegate" : "start_session"}
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
      <Report peer={peer} text={block.text} target={from.id} focus={block.letterId} />
    </div>
  );
});
