import clsx from "clsx";
import { memo, useState } from "react";
import {
  agentThreadLabel,
  clock,
  conversationBetween,
  detailOf,
  type AgentRef,
  type Letter,
  type Row,
} from "@crew/fixtures";
import { Avatar, Badge } from "@/ui";
import { store } from "@/lib/store";
import { rosterNow } from "@/lib/roster";
import { LogLine, LogRow } from "./LogRow";

type ThreadRow = Extract<Row, { kind: "agent-thread" }>;

function leadText(row: ThreadRow): string {
  const lead = row.messages[0];
  if (!lead) return agentThreadLabel(row);
  if (lead.block.fromAgent) return lead.block.text;
  const detail = detailOf(lead.block);
  return detail?.kind === "message" ? detail.text : lead.block.text;
}

/**
 * Inbound letters and outbound `message` calls are two halves of one exchange.
 * The folded row is a routed log line; opening it shows the conversation, built
 * from the shared roster so each letter is counted once and a letter still
 * sitting in a mailbox says so.
 */
export const AgentThread = memo(function AgentThread({
  row,
  sessionId,
  me,
}: {
  row: ThreadRow;
  sessionId: string;
  me: string;
}) {
  const [open, setOpen] = useState(false);
  const single = row.peers.length === 1 ? row.peers[0]! : null;
  const lead = row.messages[0];

  const gutterStamp = single
    ? `${lead?.direction === "out" ? "→" : "←"} ${single.name.toLowerCase()}`
    : `${row.peers.length} agents`;

  if (!open) {
    return (
      <LogRow gutter="msg" stamp={gutterStamp}>
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="flex w-full items-baseline text-left"
        >
          <LogLine
            text={row.messages.length === 1 ? leadText(row) : agentThreadLabel(row)}
            trail={<span className="font-mono text-xs text-ink-4">▸</span>}
          />
        </button>
      </LogRow>
    );
  }

  const roster = rosterNow(store.state.sessions);
  return (
    <LogRow gutter="msg" stamp={gutterStamp}>
      <div className="mt-1 flex flex-col gap-1">
        {row.peers.map((peer) => (
          <Thread
            key={peer.id}
            peer={peer}
            me={me}
            letters={conversationBetween(roster, sessionId, peer.id)?.letters ?? []}
            fallback={row.messages
              .filter((message) => message.peer.id === peer.id)
              .map((message) => ({
                id: message.block.id,
                from: message.direction === "in" ? peer : { id: sessionId, name: me },
                to: message.direction === "in" ? { id: sessionId, name: me } : peer,
                text:
                  message.direction === "in"
                    ? message.block.text
                    : ((detailOf(message.block) as { text?: string } | undefined)?.text ??
                      message.block.text),
                at: message.block.at ?? 0,
                state: "delivered" as const,
              }))}
            onClose={() => setOpen(false)}
          />
        ))}
      </div>
    </LogRow>
  );
});

function Thread({
  peer,
  me,
  letters,
  fallback,
  onClose,
}: {
  peer: AgentRef;
  me: string;
  letters: Letter[];
  fallback: Letter[];
  onClose: () => void;
}) {
  const shown = letters.length > 0 ? letters : fallback;
  const waiting = shown.filter((letter) => letter.state === "waiting").length;

  return (
    <div className="overflow-hidden rounded-[var(--r)] border border-rule bg-raised">
      <header className="flex items-center gap-2 border-b border-rule px-2 py-1">
        <Avatar seed={peer.name} size={18} />
        <button
          type="button"
          onClick={() => store.openSession(peer.id)}
          className="font-mono text-sm text-ink hover:text-accent-ink hover:underline"
        >
          {peer.name}
        </button>
        <span className="font-mono text-xs text-ink-4">
          {shown.length} {shown.length === 1 ? "message" : "messages"} · {me}
        </span>
        {waiting > 0 ? <Badge tone="amber">{waiting} waiting</Badge> : null}
        <button
          type="button"
          onClick={onClose}
          className="ml-auto font-mono text-xs text-ink-4 hover:text-ink"
        >
          ▾ close
        </button>
      </header>
      <div className="flex flex-col gap-2 px-2 py-2">
        {shown.map((letter) => (
          <Exchange key={letter.id} letter={letter} me={me} peer={peer} />
        ))}
      </div>
    </div>
  );
}

function Exchange({ letter, me, peer }: { letter: Letter; me: string; peer: AgentRef }) {
  const outbound = letter.to.id === peer.id;
  return (
    <div className="grid grid-cols-[72px_1fr] items-start gap-2">
      <span
        className={clsx(
          "flex items-baseline gap-1 truncate pt-px font-mono text-xs select-none",
          outbound ? "text-ink-3" : "text-accent-ink",
        )}
      >
        <span>{outbound ? "→" : "←"}</span>
        <button
          type="button"
          onClick={() => !outbound && store.openSession(peer.id)}
          className={clsx("truncate", outbound ? "cursor-default" : "hover:underline")}
        >
          {outbound ? me : peer.name.toLowerCase()}
        </button>
      </span>
      <div className="min-w-0">
        <p className="text-md whitespace-pre-wrap text-ink-2">{letter.text}</p>
        <span className="flex items-center gap-2 font-mono text-xs text-ink-4">
          {letter.at ? clock(letter.at) : null}
          {letter.state === "waiting" ? <span className="text-amber-ink">waiting</span> : null}
        </span>
      </div>
    </div>
  );
}
