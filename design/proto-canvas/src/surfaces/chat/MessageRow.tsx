import { memo, useState, type ReactNode } from "react";
import {
  agentThreadLabel,
  clock,
  dayLabel,
  type AttachedFile,
  type Block,
  type Row,
} from "@crew/fixtures";
import { cx } from "@/lib/cx";
import { agentTint } from "@/lib/identity";
import { useStore } from "@/lib/store";
import { Avatar, AvatarStack } from "@/ui/Avatar";
import { Icon } from "@/ui/Icon";
import { Markdown } from "./Markdown";
import { StreamingText } from "./StreamingText";

const MENTION = /(@[\w./-]+\.\w{1,5}|@[\w./-]+\/)/g;

function UserText({ text }: { text: string }) {
  const { openFile } = useStore();
  const parts = text.split(MENTION);
  return (
    <p className="whitespace-pre-wrap break-words">
      {parts.map((part, index) =>
        index % 2 === 1 ? (
          <button
            key={index}
            type="button"
            onClick={() => openFile(part.slice(1))}
            className="mx-0.5 inline-flex h-[20px] translate-y-[3px] items-center gap-1 rounded-chip bg-[oklch(1_0_0_/_0.5)] px-1.5 font-mono text-xs text-ink hover:el-1 dark:bg-[oklch(1_0_0_/_0.12)]"
          >
            <Icon name="fileCode" size={11} className="opacity-70" />
            {part.slice(1)}
          </button>
        ) : (
          <span key={index}>{part}</span>
        ),
      )}
    </p>
  );
}

function Attachments({ files, align }: { files: AttachedFile[]; align: "left" | "right" }) {
  return (
    <div className={cx("mt-1.5 flex flex-wrap gap-1.5", align === "right" && "justify-end")}>
      {files.map((file) => (
        <span
          key={file.path}
          className="inline-flex h-7 items-center gap-1.5 rounded-chip bg-raised px-2 text-sm text-ink-70 el-1"
        >
          <Icon name={file.kind === "image" ? "eye" : "paperclip"} size={12} className="opacity-70" />
          <span className="max-w-[180px] truncate">{file.name}</span>
          {file.size !== undefined && (
            <span className="text-xs text-ink-38">{Math.round(file.size / 1024)} KB</span>
          )}
        </span>
      ))}
    </div>
  );
}

export const UserMessage = memo(function UserMessage({ block }: { block: Block }) {
  const [hover, setHover] = useState(false);
  return (
    <div
      className="flex justify-end"
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
    >
      <div className="flex min-w-0 max-w-[76%] flex-col items-end">
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            aria-label="Copy message"
            onClick={() => navigator.clipboard?.writeText(block.text)}
            className={cx(
              "grid size-6 shrink-0 place-items-center rounded-chip text-ink-38 transition-opacity hover:bg-raised hover:text-ink",
              hover ? "opacity-100" : "opacity-0",
            )}
          >
            <Icon name="copy" size={12} />
          </button>
          <div className="min-w-0 rounded-card bg-accent-soft px-3.5 py-2.5 text-base text-ink el-1">
            <UserText text={block.text} />
          </div>
        </div>
        {block.files && block.files.length > 0 && <Attachments files={block.files} align="right" />}
        {block.at !== undefined && (
          <span className="mt-1 select-none pr-1 text-xs text-ink-38">{clock(block.at)}</span>
        )}
      </div>
    </div>
  );
});

export const AssistantMessage = memo(function AssistantMessage({ block }: { block: Block }) {
  const [hover, setHover] = useState(false);

  const bubble = (content: ReactNode, key: string) => (
    <div key={key} className="my-1.5 inline-block max-w-full rounded-card bg-raised px-3.5 py-2.5 text-base text-ink el-1">
      {content}
    </div>
  );

  return (
    <div
      className="group/msg relative flex w-full flex-col items-start"
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
    >
      {block.streaming ? (
        bubble(<StreamingText text={block.text} />, "streaming")
      ) : (
        <Markdown source={block.text} bubble={bubble} />
      )}
      <button
        type="button"
        aria-label="Copy reply"
        onClick={() => navigator.clipboard?.writeText(block.text)}
        className={cx(
          "absolute -right-1 top-0 grid size-6 place-items-center rounded-chip text-ink-38 transition-opacity hover:bg-raised hover:text-ink",
          hover ? "opacity-100" : "opacity-0",
        )}
      >
        <Icon name="copy" size={12} />
      </button>
    </div>
  );
});

export function SystemNote({ block }: { block: Block }) {
  return (
    <p className="select-none px-2 text-center text-xs text-ink-38">
      <Icon name="info" size={11} className="mr-1 inline-block translate-y-[1px]" />
      {block.text}
    </p>
  );
}

export function DateBreak({ at }: { at: number }) {
  return (
    <div className="flex select-none items-center gap-3 px-2">
      <span className="h-px flex-1 bg-[var(--line-soft)]" />
      <span className="text-xs text-ink-38">{dayLabel(at)}</span>
      <span className="h-px flex-1 bg-[var(--line-soft)]" />
    </div>
  );
}

/**
 * The agent-to-agent row. A grouped pill, not a folded tool call: it carries
 * the peers' faces and opens a real thread in the drawer.
 */
export function AgentThreadRow({ row, sessionId }: { row: Extract<Row, { kind: "agent-thread" }>; sessionId: string }) {
  const { setDrawer, openSession, dark } = useStore();
  const [expanded, setExpanded] = useState(false);
  const at = row.messages.at(-1)?.block.at;
  const single = row.peers.length === 1;

  const open = (peerId: string) => setDrawer({ kind: "agent-thread", sessionId, peerId });

  return (
    <div className="flex w-full flex-col items-start gap-1.5">
      <button
        type="button"
        onClick={() => (single ? open(row.peers[0]!.id) : setExpanded((held) => !held))}
        className="rise-1 flex h-9 max-w-full items-center gap-2.5 rounded-full bg-raised py-1 pl-1.5 pr-3 el-1"
      >
        <AvatarStack seeds={row.peers.map((peer) => peer.name)} size={24} />
        <span className="min-w-0 truncate text-sm text-ink-70">{agentThreadLabel(row)}</span>
        {at !== undefined && <span className="shrink-0 text-xs text-ink-38">{clock(at)}</span>}
        <Icon name={single ? "chevronRight" : expanded ? "chevronDown" : "chevronRight"} size={13} className="shrink-0 text-ink-38" />
      </button>

      {!single && expanded && (
        <div className="flex w-full flex-col gap-1 pl-4">
          {row.peers.map((peer) => {
            const count = row.messages.filter((message) => message.peer.id === peer.id).length;
            return (
              <div key={peer.id} className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => open(peer.id)}
                  className="rise-1 flex h-8 flex-1 items-center gap-2 rounded-control bg-raised px-2 text-sm el-1"
                  style={{ borderLeft: `2px solid ${agentTint(peer.name, dark)}` }}
                >
                  <Avatar seed={peer.name} size={20} />
                  <span className="flex-1 text-left text-ink-70">
                    {count} {count === 1 ? "message" : "messages"} with {peer.name}
                  </span>
                  <Icon name="chevronRight" size={13} className="text-ink-38" />
                </button>
                <button
                  type="button"
                  onClick={() => openSession(peer.id)}
                  className="rise-1 grid size-7 place-items-center rounded-chip text-ink-38 hover:bg-raised hover:text-ink"
                  aria-label={`Open ${peer.name}`}
                >
                  <Icon name="arrowUpRight" size={13} />
                </button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
