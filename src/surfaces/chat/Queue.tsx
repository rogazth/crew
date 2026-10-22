import { useEffect, useRef, useState, type ReactNode } from "react";
import { splitAgentNote } from "../../lib/agentMentions";
import { ArrowDownIcon, ArrowUpIcon, CornerDownLeftIcon, PaperclipIcon, PencilIcon, Trash2Icon, XIcon } from "lucide-react";
import type { QueuedMessage } from "../../lib/queue";

/** The user's queue as the composer draws it, and what can be done with each message. */
export type QueueScope = {
  items: QueuedMessage[];
  onEdit: (id: string, text: string) => void;
  onDispose: (id: string) => void;
  onMove: (id: string, step: -1 | 1) => void;
  onSendNow: (id: string) => void;
};

/** When a message lands, in the words of its row. */
function when(message: QueuedMessage, working: boolean) {
  if (message.steering) return "at its next step";
  return working ? "after this turn" : "held — goes with your next message";
}

/**
 * One chip per message waiting for the next turn, above the field: its text
 * and a way to drop it. A steer is the running turn's already: the
 * transcript shows it, at its foot.
 */
export function QueueChips({ queue }: { queue: QueueScope }) {
  return (
    <div className="mb-2 flex flex-wrap gap-1.5">
      {queue.items
        .filter((message) => !message.steering)
        .map((message) => (
          <span key={message.id} data-queue-chip className="flex h-7 max-w-full items-center gap-1.5 rounded-full bg-card pr-1 pl-2.5 text-[12px]">
            <span className="shrink-0 text-[11px] text-text-muted">next turn</span>
            {message.files.length > 0 && <PaperclipIcon className="size-3 shrink-0 text-icon" />}
            <span className="max-w-[260px] truncate">{splitAgentNote(message.text).body}</span>
            <button
              type="button"
              aria-label="Remove from the queue"
              title="Remove from the queue"
              onClick={() => queue.onDispose(message.id)}
              className="grid size-5 shrink-0 place-items-center rounded-full text-text-muted hover:bg-selected hover:text-text"
            >
              <XIcon className="size-3" />
            </button>
          </span>
        ))}
    </div>
  );
}

/**
 * The status line's "N waiting", and the sheet it opens over the composer.
 * A click outside the sheet closes it; Esc is left to the composer, which
 * stops the turn with it. The composer owns whether it is open: only one
 * sheet is open at a time.
 */
export function QueueSegment({
  queue,
  working,
  open,
  onOpenChange,
}: {
  queue: QueueScope;
  working: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const sheet = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const shown = open && queue.items.length > 0;

  useEffect(() => {
    if (!shown) return;
    const down = (event: MouseEvent) => {
      const target = event.target as Node;
      if (sheet.current?.contains(target) || trigger.current?.contains(target)) return;
      onOpenChange(false);
    };
    document.addEventListener("mousedown", down);
    return () => document.removeEventListener("mousedown", down);
  }, [shown, onOpenChange]);

  return (
    <>
      <button
        ref={trigger}
        type="button"
        onClick={() => onOpenChange(!open)}
        className="flex h-6 items-center gap-1.5 rounded-md px-1.5 text-text-muted transition-colors hover:bg-hover hover:text-text"
      >
        {queue.items.filter((message) => !message.steering).length} waiting
      </button>
      {shown && (
        <div
          ref={sheet}
          data-queue-sheet
          className="absolute inset-x-6 bottom-full z-10 mb-2 flex max-h-[min(60vh,460px)] flex-col overflow-y-auto overscroll-contain rounded-2xl bg-surface p-1.5 shadow-float ring-1 ring-border"
        >
          {queue.items.map((message, index) => (
            <QueuedRow key={message.id} message={message} index={index} working={working} queue={queue} />
          ))}
        </div>
      )}
    </>
  );
}

/** One queued message: what it is, when it lands, and what can be done with it. */
function QueuedRow({ message, index, working, queue }: { message: QueuedMessage; index: number; working: boolean; queue: QueueScope }) {
  const [editing, setEditing] = useState(false);
  // The note naming the agents it mentions stays under it through an edit; only what you wrote is shown.
  const body = splitAgentNote(message.text).body;
  const note = message.text.slice(body.length);
  const [text, setText] = useState(body);
  const save = () => {
    setEditing(false);
    if (text.trim() && text !== body) queue.onEdit(message.id, text + note);
    else setText(body);
  };
  return (
    <div data-queued className="group flex items-start gap-2 rounded-lg px-2 py-1.5 hover:bg-hover">
      <span className="mt-0.5 grid size-4 shrink-0 place-items-center text-[10.5px] text-text-muted tabular-nums">{index + 1}</span>
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        {editing ? (
          <input
            autoFocus
            aria-label="Queued message"
            value={text}
            onChange={(event) => setText(event.target.value)}
            onBlur={save}
            onKeyDown={(event) => {
              if (event.key === "Enter") event.currentTarget.blur();
              if (event.key === "Escape") {
                setText(body);
                setEditing(false);
              }
            }}
            className="w-full rounded bg-canvas px-1.5 py-0.5 text-[13px] ring-1 ring-border outline-none"
          />
        ) : (
          <span data-queued-text className="truncate text-[13px]">{body}</span>
        )}
        <span className="flex items-center gap-1 text-[11px] text-text-muted">
          {message.steering ? "Into this turn" : "Next turn"} · {when(message, working)}
          {message.files.length > 0 && (
            <span title={message.files.join("\n")} className="flex items-center gap-0.5">
              {" · "}
              <PaperclipIcon className="size-3" />
              {message.files.length}
            </span>
          )}
        </span>
      </div>
      {!message.steering && (
        <span className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100">
          <RowButton title="Move up" onClick={() => queue.onMove(message.id, -1)}>
            <ArrowUpIcon className="size-3.5" />
          </RowButton>
          <RowButton title="Move down" onClick={() => queue.onMove(message.id, 1)}>
            <ArrowDownIcon className="size-3.5" />
          </RowButton>
          <RowButton title="Edit" onClick={() => setEditing(true)}>
            <PencilIcon className="size-3.5" />
          </RowButton>
          <RowButton title="Delete" onClick={() => queue.onDispose(message.id)}>
            <Trash2Icon className="size-3.5" />
          </RowButton>
          <button
            type="button"
            onClick={() => queue.onSendNow(message.id)}
            title={working ? "Stops the turn and sends this now" : "Sends this now"}
            className="ml-1 flex h-6 items-center gap-1 rounded-md px-1.5 text-[11.5px] text-text-muted ring-1 ring-hairline hover:bg-selected hover:text-text"
          >
            <CornerDownLeftIcon className="size-3" />
            Send now
          </button>
        </span>
      )}
    </div>
  );
}

function RowButton({ title, onClick, children }: { title: string; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      onClick={onClick}
      className="grid size-6 place-items-center rounded-md text-text-muted hover:bg-selected hover:text-text"
    >
      {children}
    </button>
  );
}
