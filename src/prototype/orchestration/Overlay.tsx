// PROTOTYPE — what opens over a chat's transcript: its thread with other bots and sessions,
// or one background command's output. Same shell for both: a floating header, the reading
// column, a Close pill at the foot, Esc to leave.
import { ArrowLeftRightIcon, CornerUpLeftIcon, MessagesSquareIcon, SquareIcon, TerminalIcon } from "lucide-react";
import { useEffect, useLayoutEffect, useMemo, useRef, type ReactNode } from "react";
import { Kbd } from "../../chrome/Kbd";
import { clock } from "../../lib/time";
import { AssistantMessage } from "../../surfaces/chat/Message";
import { scrollToRow, showInChat } from "./focus";
import { pairKey, taskState } from "./labels";
import { Face, TaskDot } from "./parts";
import { proto, type Chat, type Checkpoint, type ProtoSession, type View, type World } from "./store";
import { tint } from "./tint";

export function Overlay({ world, chat, view }: { world: World; chat: Chat; view: View }) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") proto.closeView();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  return (
    <div className="proto-overlay absolute inset-0 z-10 flex flex-col bg-canvas">
      {view.kind === "thread" ? (
        <Thread key={view.pair} world={world} chat={chat} pair={view.pair} focus={view.focus} />
      ) : (
        <Output chat={chat} id={view.task} />
      )}
      <div className="pointer-events-none absolute inset-x-0 bottom-0 flex justify-center bg-linear-to-t from-canvas via-canvas/90 to-transparent pt-10 pb-4">
        <button
          type="button"
          onClick={proto.closeView}
          className="pointer-events-auto flex h-9 items-center gap-2 rounded-full bg-surface pr-2.5 pl-4 text-[13px] shadow-float transition-colors hover:bg-hover"
        >
          Close
          <Kbd keys="esc" />
        </button>
      </div>
    </div>
  );
}

/** The header both views share: a pill floating over the top of the reading column. */
function Header({ children }: { children: ReactNode }) {
  return (
    <div className="pointer-events-none sticky top-0 z-10 flex justify-center bg-linear-to-b from-canvas via-canvas/90 to-transparent px-6 pt-3 pb-6">
      <div className="pointer-events-auto flex h-10 max-w-full items-center gap-1 rounded-full bg-surface px-1.5 shadow-float">{children}</div>
    </div>
  );
}

// ——— Thread ——————————————————————————————————————————————————————————————————

type Item = { id: string; mark: Checkpoint };

/** One pair's thread: exactly the two of them, in the order they wrote. */
function Thread({ world, chat, pair, focus }: { world: World; chat: Chat; pair: string; focus: string | null }) {
  const list = useRef<HTMLDivElement>(null);
  // A pair's thread is the same from either side: what this chat holds of it,
  // then whatever only the other side's chat has (a child's reports live in its parent's).
  const items = useMemo<Item[]>(() => {
    const seen = new Set<string>();
    const out: Item[] = [];
    for (const source of [chat, ...Object.values(world.chats).filter((other) => other !== chat)]) {
      for (const block of source.blocks) {
        const mark = source.marks[block.id];
        if (mark?.kind !== "checkpoint" || pairKey(mark.from, mark.to) !== pair) continue;
        const key = `${mark.from}|${mark.to}|${mark.text}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({ id: block.id, mark });
      }
    }
    return out.sort((x, y) => x.mark.at - y.mark.at);
  }, [chat, world.chats, pair]);
  // Who opened the conversation reads first in the header.
  const first = items[0]?.mark;
  const [a, b] = first ? [first.from, first.to] : pair.split(" ⇄ ");

  // Placed before the first paint, at the message or at the newest: the view opens there, it never travels.
  useLayoutEffect(() => {
    const scroller = list.current;
    if (!scroller) return;
    const target = focus ? scroller.querySelector(`[data-thread="${CSS.escape(focus)}"]`) : null;
    if (target) scrollToRow(scroller, target, 72);
    else scroller.scrollTop = scroller.scrollHeight;
  }, [focus, pair]);

  return (
    <div ref={list} className="min-h-0 flex-1 overflow-y-auto">
      <Header>
        <span className="flex h-7 items-center gap-2 px-2 text-[13px] font-medium">
          <Face name={a ?? ""} sessions={world.sessions} className="size-5" />
          {a}
          <ArrowLeftRightIcon aria-label="and" className="size-3.5 shrink-0 text-placeholder" />
          <Face name={b ?? ""} sessions={world.sessions} className="size-5" />
          {b}
        </span>
      </Header>
      <div className="crew-prose mx-auto flex w-full max-w-[760px] flex-col gap-5 px-6 pb-28">
        {items.length === 0 ? (
          <div className="flex flex-col items-center gap-2 py-20 text-center text-text-muted">
            <MessagesSquareIcon className="size-5 text-icon" />
            <p className="text-[13px]">Nothing written between {a} and {b} yet.</p>
          </div>
        ) : (
          items.map((item, index) => (
            <Message key={item.id} item={item} quiet={item.mark.from === a} sessions={world.sessions} same={items[index - 1]?.mark.from === item.mark.from} />
          ))
        )}
      </div>
    </div>
  );
}

/**
 * One message: who sent it over the bubble, their face at its foot, the words
 * as the chat renders them. One side wears its colour, the other reads quiet;
 * a run from the same sender sits closer and names them once.
 */
function Message({ item, quiet, sessions, same }: { item: Item; quiet: boolean; sessions: ProtoSession[]; same: boolean }) {
  const { mark } = item;
  return (
    <div data-thread={item.id} className={`group/msg flex items-end gap-3 ${same ? "-mt-3" : ""}`}>
      <span className="mb-1 grid size-7 shrink-0 place-items-center">
        <Face name={mark.from} sessions={sessions} className="size-7" />
      </span>
      <div className="flex min-w-0 flex-1 flex-col items-start gap-1.5">
        <div className="flex w-full items-center gap-1.5 px-1 text-[12px] leading-4">
          {!same && (
            <span className={`shrink-0 font-medium ${quiet ? "text-text-muted" : ""}`} style={quiet ? undefined : tint(mark.from)}>
              {mark.from}
            </span>
          )}
          <span className="shrink-0 text-placeholder tabular-nums">{clock(mark.at)}</span>
          <span className="flex-1" />
          <button
            type="button"
            onClick={() => {
              proto.closeView();
              showInChat(item.id);
            }}
            className="flex shrink-0 items-center gap-1 text-[11px] text-placeholder opacity-0 transition-[opacity,color] group-hover/msg:opacity-100 hover:text-text focus-visible:opacity-100"
          >
            <CornerUpLeftIcon className="size-3" />
            Show in chat
          </button>
        </div>
        <div className="proto-thread-bubble" data-selectable>
          <AssistantMessage block={{ id: `thread-${item.id}`, role: "assistant", text: mark.text }} />
        </div>
      </div>
    </div>
  );
}

// ——— A background command's output ——————————————————————————————————————————

function Output({ chat, id }: { chat: Chat; id: string }) {
  const task = chat.tasks.find((t) => t.id === id);
  const scroller = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = scroller.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [task?.output]);
  if (!task) return null;
  const running = task.state === "running";
  return (
    <div ref={scroller} className="min-h-0 flex-1 overflow-y-auto">
      <Header>
        <span className="flex h-7 min-w-0 items-center gap-2 px-2 text-[13px]">
          <TerminalIcon className="size-3.5 shrink-0 text-icon" />
          <span className="truncate font-mono text-[12.5px]">{task.command}</span>
        </span>
        <span className="flex h-7 shrink-0 items-center gap-1.5 rounded-full bg-card px-2.5 text-[12px] text-text-muted tabular-nums">
          <TaskDot task={task} />
          {taskState(task)}
        </span>
        {running && (
          <button
            type="button"
            onClick={() => proto.stopTask(task.id)}
            className="flex h-7 shrink-0 items-center gap-1.5 rounded-full px-2.5 text-[12.5px] text-text transition-colors hover:bg-hover"
          >
            <SquareIcon className="size-3" />
            Stop
          </button>
        )}
      </Header>
      <div className="mx-auto w-full max-w-[760px] px-6 pb-28">
        <p className="mb-2 px-1 text-[12px] text-text-muted">
          Started {clock(task.startedAt)} · {running ? "following its output" : "its last output"}
        </p>
        <pre data-selectable className="overflow-x-auto rounded-xl border border-border bg-sidebar px-4 py-3 font-mono text-[12.5px] leading-[19px] whitespace-pre-wrap text-text">
          {task.output}
          {running && <span className="proto-caret" aria-hidden />}
        </pre>
      </div>
    </div>
  );
}
