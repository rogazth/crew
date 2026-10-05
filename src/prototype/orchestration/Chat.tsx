// PROTOTYPE — a chat as Crew draws it, with the orchestration added: checkpoints, a native
// subagent, the bar over the chat (sessions and the way into the thread), and the tray of
// background commands above the composer.
import { Collapsible } from "@base-ui/react/collapsible";
import {
  ArrowRightIcon,
  BotIcon,
  CheckIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  CircleCheckIcon,
  CornerDownRightIcon,
  GitBranchIcon,
  LoaderCircleIcon,
  MessageSquareIcon,
  MessagesSquareIcon,
  TerminalIcon,
  XIcon,
} from "lucide-react";
import { useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ProviderIcon } from "../../chrome/ProviderIcon";
import { awaitsUser, type Block } from "../../lib/blocks";
import { clock, duration } from "../../lib/time";
import { foldTurns, gapBefore, groupRows, speaker, type Row } from "../../lib/transcriptRows";
import { ActivityGroup, WorkingLine } from "../../surfaces/chat/Activity";
import { Composer } from "../../surfaces/chat/Composer";
import { AssistantMessage, DateBreak, Note, TurnFooter, UserMessage } from "../../surfaces/chat/Message";
import { Overlay } from "./Overlay";
import { Menu } from "@base-ui/react/menu";
import { PANEL, ROW } from "../../chrome/kit";
import { pairKey, taskState } from "./labels";
import { Face, TaskDot } from "./parts";
import { proto, type Chat, type Checkpoint, type Mark, type ProtoSession, type Refused, type Subagent, type Task, type World } from "./store";

const NOOP = () => undefined;
/** When the running turn began: fake, and fixed, so the clock ticks from a believable start. */
const TURN_SINCE = Date.now() - 74_000;
const EMPTY: Chat = { blocks: [], working: false, queued: [], marks: {}, tasks: [], read: [] };

// ——— Rows the prototype adds ————————————————————————————————————————————————

/**
 * Who wrote to whom, at the point it happened, and nothing else: the words
 * live in that pair's thread, one click away.
 */
function CheckpointRow({ id, mark, sessions }: { id: string; mark: Checkpoint; sessions: ProtoSession[] }) {
  return (
    <button
      type="button"
      onClick={() => proto.thread(pairKey(mark.from, mark.to), id)}
      title={`Open the conversation between ${mark.from} and ${mark.to}`}
      className="group flex min-h-[26px] w-full items-center gap-2 py-0.5 text-left text-[13px] leading-[18px]"
    >
      <span className="crew-node">
        <MessageSquareIcon className={`size-3.5 ${mark.failed ? "text-danger" : ""}`} />
      </span>
      <span className="flex min-w-0 items-center gap-1.5 text-text-muted transition-colors group-hover:text-text">
        <Face name={mark.from} sessions={sessions} className="size-3.5" />
        <span className="truncate">{mark.from}</span>
        <ArrowRightIcon aria-label="to" className="size-3 shrink-0 text-placeholder" />
        <Face name={mark.to} sessions={sessions} className="size-3.5" />
        <span className="truncate">{mark.to}</span>
      </span>
      <span className="h-px min-w-4 flex-1 bg-hairline" />
      <span className="shrink-0 text-[11px] text-placeholder tabular-nums">{clock(mark.at)}</span>
    </button>
  );
}

/** The harness's own subagent, nested: its steps live while it runs, one line once it is back. */
function SubagentRow({ mark }: { mark: Subagent }) {
  const [pinned, setPinned] = useState<boolean | null>(null);
  const open = pinned ?? mark.live;
  return (
    <Collapsible.Root open={open} onOpenChange={setPinned}>
      <Collapsible.Trigger className="group flex min-h-[26px] w-full items-center gap-2 py-0.5 text-left text-[13px] leading-[18px]">
        <span className="crew-node relative">
          {mark.live ? (
            <LoaderCircleIcon className="size-3.5 animate-spin text-warning" />
          ) : (
            <>
              <BotIcon className="size-3.5 transition-opacity group-hover:opacity-0" />
              <ChevronRightIcon
                className={`absolute size-3 opacity-0 transition-[opacity,transform] duration-150 group-hover:opacity-100 ${open ? "rotate-90" : ""}`}
              />
            </>
          )}
        </span>
        <span className={`min-w-0 truncate ${mark.live ? "crew-shimmer" : "text-text-muted transition-colors group-hover:text-text"}`}>
          {mark.title}
        </span>
        <span className="shrink-0 text-[11px] text-placeholder">subagent · {mark.agentType}</span>
      </Collapsible.Trigger>
      <Collapsible.Panel className="crew-phase-panel">
        <div className="ml-[9px] mt-1 flex flex-col gap-0.5 border-l-[1.5px] border-border-strong py-0.5 pl-4">
          {mark.steps.map((step) => (
            <div key={step.text} className="flex min-h-[24px] items-center gap-2 text-[12.5px] leading-[18px]">
              {step.done ? (
                <CheckIcon className="size-3 shrink-0 text-success" />
              ) : (
                <LoaderCircleIcon className="size-3 shrink-0 animate-spin text-warning" />
              )}
              <span className={`min-w-0 truncate font-mono text-[12px] ${step.done ? "text-text-muted" : "text-text"}`}>{step.text}</span>
            </div>
          ))}
          {mark.summary && (
            <div className="flex items-start gap-2 pt-1 text-[12.5px] leading-[18px]">
              <CornerDownRightIcon className="mt-0.5 size-3 shrink-0 text-icon" />
              <span className="text-text">{mark.summary}</span>
            </div>
          )}
        </div>
      </Collapsible.Panel>
    </Collapsible.Root>
  );
}

/** Where commands went to the background: a line in the run, each command a link to its output. */
function BackgroundRow({ ids, tasks }: { ids: string[]; tasks: Task[] }) {
  const mine = tasks.filter((task) => ids.includes(task.id));
  return (
    <div className="flex min-h-[26px] flex-wrap items-center gap-x-2 gap-y-1 py-0.5 text-[13px] leading-[18px]">
      <span className="crew-node">
        <TerminalIcon className="size-3.5" />
      </span>
      <span className="text-text-muted">
        Sent {mine.length === 1 ? "a command" : `${mine.length} commands`} to the background
      </span>
      {mine.map((task) => (
        <button
          key={task.id}
          type="button"
          onClick={() => proto.output(task.id)}
          title="Open its output"
          className="flex h-5 items-center gap-1.5 rounded-md bg-card px-1.5 font-mono text-[11.5px] text-text-muted transition-colors hover:bg-hover hover:text-text"
        >
          <TaskDot task={task} />
          {task.command}
        </button>
      ))}
    </div>
  );
}

/** A send Crew refused: the call failed, nothing was delivered, and the row says why. */
function RefusedRow({ mark }: { mark: Refused }) {
  return (
    <div className="flex min-h-[26px] items-start gap-2 py-0.5 text-[13px] leading-[18px]">
      <span className="crew-node mt-0.5">
        <XIcon className="size-3 text-danger" />
      </span>
      <span className="min-w-0">
        <span className="text-danger">send_message to {mark.to}</span>
        <span className="text-placeholder"> · “{mark.text}”</span>
        <span className="block text-[12px] text-text-muted">{mark.reason}</span>
      </span>
    </div>
  );
}

// ——— Rows ————————————————————————————————————————————————————————————————————

/** What stays on the rail when a turn folds: who wrote to whom, and what was refused. */
const staysOut = (row: Row, marks: Record<string, Mark>) =>
  row.kind === "message" && (marks[row.block.id]?.kind === "checkpoint" || marks[row.block.id]?.kind === "refused");

/** A finished turn folds its work; the checkpoints in it stay out on the rail, where they happened. */
function hoist(rows: Row[], marks: Record<string, Mark>): Row[] {
  return rows.flatMap((row) => {
    if (row.kind !== "fold") return [row];
    const kept = row.rows.filter((inner) => !staysOut(inner, marks));
    const out = row.rows.filter((inner) => staysOut(inner, marks));
    // A fold of nothing but checkpoints is no fold at all.
    if (kept.length === 0) return out;
    return [{ ...row, rows: kept }, ...out];
  });
}

type RowsProps = { rows: Row[]; working: boolean; chat: Chat; sessions: ProtoSession[] };

/** Crew's Rows, with a block the prototype marks drawn as that mark. */
function ProtoRows({ rows, working, chat, sessions }: RowsProps) {
  return (
    <>
      {rows.map((row, index) => {
        const className = gapBefore(rows[index - 1], row);
        switch (row.kind) {
          case "activity":
            return (
              <div key={row.id} className={className}>
                <ActivityGroup blocks={row.blocks} live={working && index === rows.length - 1} focusId={null} marked={null} onApprove={NOOP} onAnswer={NOOP} />
              </div>
            );
          case "fold":
            return (
              <div key={row.id} className={className}>
                <Fold row={row}>
                  <ProtoRows rows={row.rows} working={false} chat={chat} sessions={sessions} />
                </Fold>
              </div>
            );
          case "footer":
            return (
              <div key={row.id} className={className}>
                <TurnFooter
                  usage={row.usage}
                  {...(row.at !== undefined ? { at: row.at } : {})}
                  {...(row.text !== undefined ? { text: row.text } : {})}
                  {...(row.folded ? { folded: true } : {})}
                />
              </div>
            );
          case "date":
            return (
              <div key={row.id} className={className}>
                <DateBreak label="Today" />
              </div>
            );
          case "message": {
            const { block } = row;
            const mark = chat.marks[block.id];
            return (
              <div key={block.id} data-block={block.id} className={className}>
                {mark?.kind === "checkpoint" ? (
                  <CheckpointRow id={block.id} mark={mark} sessions={sessions} />
                ) : mark?.kind === "subagent" ? (
                  <SubagentRow mark={mark} />
                ) : mark?.kind === "refused" ? (
                  <RefusedRow mark={mark} />
                ) : mark?.kind === "background" ? (
                  <BackgroundRow ids={mark.tasks} tasks={chat.tasks} />
                ) : block.role === "user" ? (
                  <UserMessage block={block} />
                ) : block.role === "system" ? (
                  <Note block={block} />
                ) : (
                  <AssistantMessage block={block} />
                )}
              </div>
            );
          }
        }
      })}
    </>
  );
}

/** Crew's TurnFold, unchanged but for living here. */
function Fold({ row, children }: { row: Extract<Row, { kind: "fold" }>; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const label = row.durationMs !== undefined ? `Worked for ${duration(row.durationMs)}` : "Worked";
  return (
    <Collapsible.Root open={open} onOpenChange={setOpen}>
      <Collapsible.Trigger className="group flex min-h-[26px] w-full items-center gap-2 py-0.5 text-left text-[13px] leading-[18px]">
        <span className="crew-node relative">
          <CircleCheckIcon className="size-3.5 transition-opacity group-hover:opacity-0" />
          <ChevronRightIcon
            className={`absolute size-3 opacity-0 transition-[opacity,transform] duration-150 group-hover:opacity-100 ${open ? "rotate-90" : ""}`}
          />
        </span>
        <span className="text-text-muted tabular-nums transition-colors group-hover:text-text">{label}</span>
        <span className="h-px flex-1 bg-hairline" />
      </Collapsible.Trigger>
      <Collapsible.Panel className="crew-phase-panel">
        <div className="pt-2.5">{children}</div>
      </Collapsible.Panel>
    </Collapsible.Root>
  );
}

// ——— The bar over the chat ———————————————————————————————————————————————————

const CHILD_STATE = {
  working: { label: "Working", glyph: <LoaderCircleIcon className="size-3 animate-spin text-warning" /> },
  waiting: { label: "Background", glyph: <span className="proto-bg-ring size-3" aria-hidden /> },
  reported: { label: "Reported", glyph: <CheckIcon className="size-3 text-success" /> },
  failed: { label: "Failed", glyph: <XIcon className="size-3 text-danger" /> },
} as const;

/** How many reported children it takes before they fold into one chip. */
const FOLD_DONE_AT = 3;

/** One child: the tab pill's shape, the CLI's mark, its name and where it stands. */
function ChildChip({ child }: { child: ProtoSession }) {
  const state = CHILD_STATE[child.childState ?? "working"];
  return (
    <button
      type="button"
      onClick={() => proto.open(child.id)}
      title={`${child.name}: ${state.label.toLowerCase()}. Open its chat.`}
      className="flex h-7 max-w-[220px] shrink-0 items-center gap-1.5 rounded-chrome bg-card pr-2 pl-2 text-[12.5px] transition-colors hover:bg-hover"
    >
      <ProviderIcon provider={child.provider} className="size-3.5" />
      <span className="min-w-0 truncate">{child.name}</span>
      <span className="flex shrink-0 items-center gap-1 pl-0.5 text-[11px] text-text-muted">
        {state.glyph}
        {state.label}
      </span>
    </button>
  );
}

/** A bot's children, where they live now: inside its chat, not in the sidebar. */
function Sessions({ kids, doneOpen }: { kids: ProtoSession[]; doneOpen: boolean }) {
  const reported = kids.filter((child) => child.childState === "reported");
  const folds = reported.length >= FOLD_DONE_AT && !doneOpen;
  const shown = folds ? kids.filter((child) => child.childState !== "reported") : kids;
  return (
    <div className="no-scrollbar flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
      <span className="mr-1.5 shrink-0 text-[12px] text-text-muted">Sessions</span>
      {shown.map((child) => (
        <ChildChip key={child.id} child={child} />
      ))}
      {reported.length >= FOLD_DONE_AT && (
        <button
          type="button"
          onClick={proto.toggleDone}
          aria-expanded={!folds}
          className="flex h-7 shrink-0 items-center gap-1 rounded-chrome px-2 text-[12px] text-text-muted transition-colors hover:bg-hover hover:text-text"
        >
          <CheckIcon className="size-3 text-success" />
          {folds ? `${reported.length} done` : "Fold done"}
          <ChevronDownIcon className={`size-3 transition-transform duration-150 ${folds ? "" : "rotate-180"}`} />
        </button>
      )}
    </div>
  );
}

/** A child's chat says whose it is; a handoff says it is yours now. */
function Owner({ session, sessions }: { session: ProtoSession; sessions: ProtoSession[] }) {
  const parent = session.parentName ?? "";
  return (
    <div className="flex min-w-0 flex-1 items-center gap-2 text-[12.5px] text-text-muted">
      <Face name={parent} sessions={sessions} className="size-4" />
      {session.owner === "user" ? (
        <span className="truncate">
          Handed off by <span className="text-text">{parent}</span> · yours, reports to no one
        </span>
      ) : (
        <span className="truncate">
          Started by <span className="text-text">{parent}</span> · reports to it when a turn ends
        </span>
      )}
      {session.branch && (
        <span className="flex shrink-0 items-center gap-1 rounded-md bg-card px-1.5 py-0.5 font-mono text-[11px]">
          <GitBranchIcon className="size-3" />
          {session.branch}
        </span>
      )}
    </div>
  );
}

type Pair = { key: string; peer: string; with: string | null; last: Checkpoint; unread: boolean };

/** This chat's conversations, one per pair, newest first. */
function pairsOf(chat: Chat, owner: string): Pair[] {
  const byKey = new Map<string, Checkpoint>();
  for (const block of chat.blocks) {
    const mark = chat.marks[block.id];
    if (mark?.kind === "checkpoint") byKey.set(pairKey(mark.from, mark.to), mark);
  }
  return [...byKey.entries()]
    .map(([key, last]) => {
      const involved = last.from === owner || last.to === owner;
      const peer = last.from === owner ? last.to : last.from;
      // Unread: the peer wrote last, and the thread has not been opened since.
      const unread = involved && last.to === owner && !chat.read.includes(key);
      return { key, peer, with: involved ? null : last.to, last, unread };
    })
    .sort((a, b) => b.last.at - a.last.at);
}

const BAR_BUTTON = "flex h-7 shrink-0 items-center gap-1.5 rounded-chrome px-2 text-[12.5px] text-icon transition-colors hover:bg-hover hover:text-text data-popup-open:bg-hover data-popup-open:text-text";

/** The way into this chat's threads: straight in when there is one, a menu of pairs when there are more. */
function Conversations({ world, session, chat }: { world: World; session: ProtoSession; chat: Chat }) {
  const pairs = pairsOf(chat, session.name);
  if (pairs.length === 0) return null;
  const unread = pairs.some((pair) => pair.unread);
  const label = (
    <>
      <span className="relative">
        <MessagesSquareIcon className="size-3.5" />
        {unread && <span className="absolute -top-0.5 -right-0.5 size-1.5 rounded-full bg-info ring-2 ring-canvas" />}
      </span>
      Conversations
      <span className="text-text-muted tabular-nums">{pairs.length}</span>
    </>
  );
  if (pairs.length === 1)
    return (
      <button type="button" onClick={() => proto.thread(pairs[0]!.key)} className={BAR_BUTTON}>
        {label}
      </button>
    );
  return (
    <Menu.Root modal={false} open={world.menu} onOpenChange={(open) => proto.menu(open)}>
      <Menu.Trigger className={BAR_BUTTON}>
        {label}
        <ChevronDownIcon className="size-3 text-icon" />
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Positioner side="bottom" align="end" sideOffset={4} className="z-50">
          <Menu.Popup className={`${PANEL} w-72`}>
            <div className="px-2 pt-1 pb-1.5 text-[11px] text-text-muted">Conversations</div>
            {pairs.map((pair) => (
              <Menu.Item key={pair.key} onClick={() => proto.thread(pair.key)} className={`${ROW} h-10`}>
                <Face name={pair.peer} sessions={world.sessions} className="size-5" />
                <span className="flex min-w-0 flex-1 flex-col leading-4">
                  <span className={`truncate text-[13px] ${pair.unread ? "font-medium" : ""}`}>
                    {pair.with ? `${pair.peer} → ${pair.with}` : pair.peer}
                  </span>
                  <span className="truncate text-[11.5px] text-text-muted">{pair.last.from} wrote · {clock(pair.last.at)}</span>
                </span>
                {pair.unread && <span aria-label="Unread" className="size-2 shrink-0 rounded-full bg-info" />}
              </Menu.Item>
            ))}
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}

/** The bar over a chat: its sessions or its owner on the left, its conversations on the right. */
function ChatBar({ world, session, chat }: { world: World; session: ProtoSession; chat: Chat }) {
  const kids = world.sessions.filter((s) => s.parentId === session.id && s.owner === "me");
  const talks = Object.values(chat.marks).some((m) => m.kind === "checkpoint");
  const owned = session.owner === "me" || session.owner === "user";
  if (kids.length === 0 && !owned && !talks) return null;
  return (
    <div className="flex h-11 shrink-0 items-center gap-3 border-b border-hairline pr-2 pl-4">
      {kids.length > 0 ? <Sessions kids={kids} doneOpen={world.doneOpen} /> : owned ? <Owner session={session} sessions={world.sessions} /> : <span className="flex-1" />}
      <Conversations world={world} session={session} chat={chat} />
    </div>
  );
}

// ——— Background tray ————————————————————————————————————————————————————————

/**
 * What this chat left running, above the composer: it stays put however far
 * the transcript scrolls. A row opens its output; Stop is the one action.
 */
function Tray({ tasks, open }: { tasks: Task[]; open: boolean }) {
  const running = tasks.filter((task) => task.state === "running").length;
  return (
    <div className="mx-auto w-full max-w-[760px] shrink-0 px-6 pb-2">
      <Collapsible.Root open={open} onOpenChange={proto.tray} className="rounded-2xl bg-card">
        <Collapsible.Trigger className="group flex h-9 w-full items-center gap-2 px-3.5 text-left text-[12.5px]">
          <TerminalIcon className="size-3.5 text-icon" />
          <span className="text-text">Background</span>
          <span className="text-text-muted">
            · {running > 0 ? `${running} running` : "nothing running"}
            {tasks.length > running ? ` · ${tasks.length - running} finished` : ""}
          </span>
          <span className="flex-1" />
          <ChevronDownIcon className={`size-3.5 text-icon transition-transform duration-150 ${open ? "rotate-180" : ""}`} />
        </Collapsible.Trigger>
        <Collapsible.Panel className="crew-phase-panel">
          <div className="flex flex-col px-1.5 pb-1.5">
            {tasks.map((task) => (
              <div
                key={task.id}
                role="button"
                tabIndex={0}
                title="Open its output"
                onClick={() => proto.output(task.id)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    proto.output(task.id);
                  }
                }}
                className="flex h-8 items-center gap-2.5 rounded-lg px-2 outline-none transition-colors hover:bg-hover focus-visible:bg-hover"
              >
                <span className="grid size-3.5 place-items-center">
                  <TaskDot task={task} />
                </span>
                <span className={`min-w-0 truncate font-mono text-[12px] ${task.state === "running" ? "text-text" : "text-text-muted"}`}>{task.command}</span>
                <span className="shrink-0 text-[11.5px] text-text-muted tabular-nums">{taskState(task)}</span>
                <span className="flex-1" />
                {task.state === "running" && (
                  <button
                    type="button"
                    onClick={(event) => {
                      event.stopPropagation();
                      proto.stopTask(task.id);
                    }}
                    className="flex h-6 shrink-0 items-center rounded-md px-2 text-[12px] text-text-muted transition-colors hover:bg-selected hover:text-text"
                  >
                    Stop
                  </button>
                )}
              </div>
            ))}
          </div>
        </Collapsible.Panel>
      </Collapsible.Root>
    </div>
  );
}

/**
 * What the composer sent while the turn ran: your bubbles, dimmed and stacked,
 * and one label for all of them.
 */
function Queued({ queued }: { queued: Chat["queued"] }) {
  return (
    <div className="flex flex-col items-end gap-1.5 opacity-60">
      {queued.map((q) => (
        <div key={q.id} className="crew-md-row is-user">
          <div className="crew-bubble">
            <p className="whitespace-pre-wrap">{q.text}</p>
          </div>
        </div>
      ))}
      <span className="text-[11px] text-text-muted">{queued.length > 1 ? `${queued.length} queued` : "Queued"}</span>
    </div>
  );
}

// ——— The chat ——————————————————————————————————————————————————————————————

export function ProtoChat({ world, session }: { world: World; session: ProtoSession }) {
  const chat: Chat = world.chats[session.id] ?? EMPTY;
  const [draft, setDraft] = useState("");
  const field = useRef<HTMLTextAreaElement>(null);
  const scroller = useRef<HTMLDivElement>(null);

  const blocks: Block[] = chat.blocks;
  const rows = useMemo(() => hoist(foldTurns(groupRows(blocks), chat.working), chat.marks), [blocks, chat.working, chat.marks]);

  useLayoutEffect(() => {
    const el = scroller.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [session.id, rows.length]);

  return (
    <div className="relative flex min-w-0 flex-1 flex-col bg-canvas">
      <ChatBar world={world} session={session} chat={chat} />
      <div className="relative flex min-h-0 flex-1 flex-col">
        <div ref={scroller} data-selectable="blocks" data-proto-scroller className="min-h-0 flex-1 overflow-y-auto">
          <div className="crew-prose mx-auto w-full max-w-[760px] px-6 pt-8 pb-10">
            <ProtoRows rows={rows} working={chat.working} chat={chat} sessions={world.sessions} />
            {chat.working && (
              <div className={rows.length > 0 ? (speaker(rows.at(-1)!) === "agent" ? "mt-2.5" : "mt-7") : ""}>
                <WorkingLine since={TURN_SINCE} waiting={blocks.some(awaitsUser)} />
              </div>
            )}
            {chat.queued.length > 0 && (
              <div className="mt-7">
                <Queued queued={chat.queued} />
              </div>
            )}
          </div>
        </div>
        {chat.tasks.length > 0 && <Tray tasks={chat.tasks} open={world.trayOpen} />}
        <Composer
          ref={field}
          session={session}
          draft={draft}
          files={[]}
          working={chat.working}
          ready
          onDraft={setDraft}
          onAttach={NOOP}
          onPasteFiles={NOOP}
          onRemoveFile={NOOP}
          onSend={() => {
            const text = draft.trim();
            if (!text) return;
            setDraft("");
            proto.send(text);
          }}
          onStop={proto.stop}
          onOptions={NOOP}
        />
        {world.view && <Overlay world={world} chat={chat} view={world.view} />}
      </div>
    </div>
  );
}
