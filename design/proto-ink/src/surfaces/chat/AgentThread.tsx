import { useMemo, useState } from "react";
import { agentThreadLabel, clock, detailOf } from "@crew/fixtures";
import type { AgentMessage, AgentRef, Row } from "@crew/fixtures";
import { cx } from "@/lib/cx";
import { Icon } from "@/lib/icon";
import { useApp } from "@/lib/store";
import { Avatar, Tooltip } from "@/ui";

type ThreadRow = Extract<Row, { kind: "agent-thread" }>;

function textOf(message: AgentMessage): string {
  const detail = detailOf(message.block);
  return detail?.kind === "message" ? detail.text : message.block.text;
}

/**
 * Two agents writing to each other is a conversation, so it renders as one: a
 * single meta line on the rail that opens into a two-sided mini-transcript,
 * theirs on the left and ours on the right. The old design showed each half as
 * an unrelated row in a different transcript, which is why "what did those two
 * agree on" was not a question the window could answer.
 */
export function AgentThread({
  row,
  waiting,
  focusId,
}: {
  row: ThreadRow;
  waiting: Set<string>;
  focusId: string | null;
}) {
  const { actions } = useApp();
  const holdsFocus = focusId !== null && row.messages.some((m) => m.block.id === focusId);
  const [open, setOpen] = useState(holdsFocus);

  const byPeer = useMemo(() => {
    const map = new Map<string, { peer: AgentRef; messages: AgentMessage[] }>();
    for (const message of row.messages) {
      const held = map.get(message.peer.id);
      if (held) held.messages.push(message);
      else map.set(message.peer.id, { peer: message.peer, messages: [message] });
    }
    return [...map.values()];
  }, [row.messages]);

  const stillWaiting = row.messages.filter((m) => waiting.has(m.block.id)).length;
  const at = row.messages.at(-1)?.block.at;

  return (
    <div data-block={row.id} className="flex flex-col">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className={cx(
          "group flex min-h-[20px] w-full min-w-0 items-center gap-1.5 rounded-sm pr-1 text-left",
          "transition-colors duration-[var(--dur-1)] hover:bg-[var(--fill-quaternary)]",
        )}
      >
        <span className="flex size-3.5 shrink-0 items-center justify-center">
          <Icon name="mail" size={12} className="text-icon-tertiary" />
        </span>
        <span className="flex min-w-0 items-center gap-1 text-small text-tertiary">
          <span className="shrink-0">{agentThreadLabel(row)}</span>
        </span>
        <span className="flex shrink-0 -space-x-1">
          {row.peers.slice(0, 3).map((peer) => (
            <Avatar key={peer.id} seed={peer.name} size={14} className="ring-1 ring-[var(--surface-canvas)]" />
          ))}
        </span>
        {stillWaiting > 0 && (
          <Tooltip content="Delivered to their box; they are mid-turn.">
            <span className="flex shrink-0 items-center gap-1 rounded-sm bg-[var(--attention-fill)] px-1 text-micro text-[var(--status-attention)]">
              <Icon name="inbox" size={11} />
              {stillWaiting} waiting
            </span>
          </Tooltip>
        )}
        <span className="flex-1" />
        {at !== undefined && (
          <time className="shrink-0 text-micro text-quaternary">{clock(at)}</time>
        )}
        <Icon
          name={open ? "chevronUp" : "chevronDown"}
          size={12}
          className="shrink-0 text-icon-tertiary opacity-0 transition-opacity group-hover:opacity-100"
        />
      </button>

      {open && (
        <div className="my-1.5 overflow-hidden rounded-card bg-[var(--fill-quaternary)]">
          {byPeer.map((group, index) => (
            <section
              key={group.peer.id}
              className={cx(index > 0 && "border-t border-[var(--stroke-tertiary)]")}
            >
              <header className="flex items-center gap-1.5 px-2.5 pb-1 pt-2">
                <Avatar seed={group.peer.name} size={16} />
                <button
                  type="button"
                  onClick={() => actions.openSession(group.peer.id)}
                  className="group/peer flex items-center gap-1 text-small text-secondary transition-colors hover:text-primary"
                >
                  <span className="underline decoration-[var(--stroke-secondary)] underline-offset-2 group-hover/peer:decoration-[var(--accent)]">
                    {group.peer.name}
                  </span>
                  <Icon
                    name="external"
                    size={11}
                    className="opacity-0 transition-opacity group-hover/peer:opacity-100"
                  />
                </button>
                <span className="flex-1" />
                <span className="text-micro text-quaternary tnum">
                  {group.messages.length === 1 ? "1 message" : `${group.messages.length} messages`}
                </span>
              </header>
              <div className="flex flex-col gap-1.5 px-2.5 pb-2.5">
                {group.messages.map((message) => (
                  <Letter
                    key={message.block.id}
                    message={message}
                    peer={group.peer}
                    waiting={waiting.has(message.block.id)}
                    focused={focusId === message.block.id}
                  />
                ))}
              </div>
            </section>
          ))}
        </div>
      )}
    </div>
  );
}

function Letter({
  message,
  peer,
  waiting,
  focused,
}: {
  message: AgentMessage;
  peer: AgentRef;
  waiting: boolean;
  focused: boolean;
}) {
  const inbound = message.direction === "in";
  return (
    <div
      data-block={message.block.id}
      className={cx("flex gap-2", inbound ? "justify-start" : "justify-end", focused && "ink-flash rounded-md")}
    >
      {inbound && <Avatar seed={peer.name} size={18} className="mt-0.5" />}
      <div className={cx("flex min-w-0 max-w-[80%] flex-col", inbound ? "items-start" : "items-end")}>
        <div
          className={cx(
            "rounded-card px-2.5 py-1.5 text-body",
            inbound
              ? "rounded-tl-sm bg-canvas text-secondary hairline"
              : "rounded-tr-sm bg-[var(--fill-secondary)] text-primary",
          )}
        >
          <p className="whitespace-pre-wrap">{textOf(message)}</p>
        </div>
        <span className="mt-0.5 flex items-center gap-1 px-0.5 text-micro text-quaternary">
          {message.block.at !== undefined && <time>{clock(message.block.at)}</time>}
          {waiting && (
            <>
              <span>·</span>
              <span className="text-[var(--status-attention)]">in their box</span>
            </>
          )}
        </span>
      </div>
    </div>
  );
}
