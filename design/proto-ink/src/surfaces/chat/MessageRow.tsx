import { memo, useEffect, useState } from "react";
import { clock, compactNumber, dayLabel, duration } from "@crew/fixtures";
import type { AttachedFile, Block, TurnUsage } from "@crew/fixtures";
import { cx } from "@/lib/cx";
import { Icon } from "@/lib/icon";
import { fileIcon } from "@/lib/files";
import { useApp } from "@/lib/store";
import { Tooltip } from "@/ui";
import { Markdown, StreamingMarkdown } from "./Markdown";

/** `@src/lib/tabs.ts` in a sent message is a pill that opens the file. */
const MENTION = /@((?:[\w.-]+\/)*[\w.-]+\.[a-zA-Z]{1,5})/g;

function UserText({ text }: { text: string }) {
  const { actions } = useApp();
  const parts: React.ReactNode[] = [];
  let last = 0;
  for (const match of text.matchAll(MENTION)) {
    const at = match.index ?? 0;
    if (at > last) parts.push(text.slice(last, at));
    const relative = match[1]!;
    parts.push(
      <button
        key={`${at}-${relative}`}
        type="button"
        onClick={() => actions.openFile(relative)}
        className="mx-px inline-flex items-baseline gap-1 rounded-sm bg-[var(--fill-tertiary)] px-1 align-baseline font-mono text-[0.9em] text-secondary transition-colors hover:bg-[var(--fill-primary)] hover:text-primary"
      >
        {relative}
      </button>,
    );
    last = at + match[0].length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return <span className="whitespace-pre-wrap">{parts}</span>;
}

function CopyRail({ text, side }: { text: string; side: "left" | "right" }) {
  const [done, setDone] = useState(false);
  useEffect(() => {
    if (!done) return;
    const timer = window.setTimeout(() => setDone(false), 1_200);
    return () => window.clearTimeout(timer);
  }, [done]);
  return (
    <button
      type="button"
      aria-label="Copy message"
      onClick={() => {
        void navigator.clipboard?.writeText(text);
        setDone(true);
      }}
      className={cx(
        "ink-noselect mt-1 flex size-5 shrink-0 items-center justify-center rounded-sm text-icon-faint",
        "opacity-0 transition-opacity duration-[var(--dur-2)] group-hover/msg:opacity-100 focus-visible:opacity-100",
        "hover:bg-[var(--fill-tertiary)] hover:text-icon",
        side === "left" ? "order-first" : "order-last",
      )}
    >
      <Icon name={done ? "check" : "copy"} size={13} />
    </button>
  );
}

/** Attachments live below the bubble, never inside it. */
function Attachments({ files }: { files: AttachedFile[] }) {
  const { actions } = useApp();
  return (
    <div className="mt-1 flex flex-wrap justify-end gap-1">
      {files.map((file) => (
        <button
          key={file.path}
          type="button"
          onClick={() => actions.openFile(file.path.replace(/^\/Users\/[^/]+\/[^/]+\//, ""))}
          className={cx(
            "flex h-6 items-center gap-1.5 rounded-md bg-chrome px-2 e1",
            "text-micro text-tertiary transition-colors hover:text-primary",
          )}
        >
          <Icon
            name={file.kind === "image" ? "image" : fileIcon(file.name)}
            size={12}
            className="text-icon-faint"
          />
          <span className="max-w-40 truncate font-mono">{file.name}</span>
          {file.size !== undefined && (
            <span className="text-quaternary tnum">{Math.round(file.size / 1024)}k</span>
          )}
        </button>
      ))}
    </div>
  );
}

export const UserMessage = memo(function UserMessage({ block }: { block: Block }) {
  return (
    <div data-block={block.id} className="group/msg flex flex-col items-end">
      <div className="flex w-full items-start justify-end gap-1.5">
        <CopyRail text={block.text} side="left" />
        <div className="max-w-[78%] rounded-card rounded-tr-sm bg-[var(--fill-secondary)] px-3 py-2 text-prose text-primary">
          <UserText text={block.text} />
        </div>
      </div>
      {block.files && block.files.length > 0 && <Attachments files={block.files} />}
    </div>
  );
});

export const AssistantMessage = memo(function AssistantMessage({
  block,
  focused,
}: {
  block: Block;
  focused: boolean;
}) {
  return (
    <div
      data-block={block.id}
      className={cx("group/msg flex items-start gap-1.5", focused && "ink-flash rounded-md")}
    >
      <div className="min-w-0 flex-1">
        {block.streaming ? (
          <StreamingMarkdown text={block.text} />
        ) : (
          <Markdown text={block.text} />
        )}
      </div>
      <CopyRail text={block.text} side="right" />
    </div>
  );
});

export function SystemNote({ block }: { block: Block }) {
  return (
    <p
      data-block={block.id}
      className="ink-noselect flex items-start gap-1.5 text-small text-quaternary"
    >
      <Icon name="info" size={12} className="mt-[2px] shrink-0" />
      <span className="min-w-0">{block.text}</span>
      {block.at !== undefined && (
        <time className="shrink-0 tnum">{clock(block.at)}</time>
      )}
    </p>
  );
}

export function DateBreak({ at }: { at: number }) {
  return (
    <div className="ink-noselect flex items-center gap-3 py-1">
      <span className="h-px flex-1 bg-[var(--stroke-tertiary)]" />
      <time className="text-micro text-quaternary tnum">{dayLabel(at)}</time>
      <span className="h-px flex-1 bg-[var(--stroke-tertiary)]" />
    </div>
  );
}

export function TurnFooter({ usage, at }: { usage: TurnUsage; at?: number }) {
  const worked = usage.durationMs ? `Worked for ${duration(usage.durationMs)}` : "Finished";
  return (
    <Tooltip
      side="top"
      align="start"
      content={
        <span className="flex flex-col gap-0.5 tnum">
          {usage.inputTokens !== undefined && (
            <span>{compactNumber(usage.inputTokens)} tokens in</span>
          )}
          {usage.outputTokens !== undefined && (
            <span>{compactNumber(usage.outputTokens)} tokens out</span>
          )}
          {usage.costUsd !== undefined && <span>${usage.costUsd.toFixed(4)}</span>}
        </span>
      }
    >
      <p className="ink-noselect inline-flex w-fit items-center gap-1.5 text-micro text-quaternary tnum">
        {worked}
        {at !== undefined && (
          <>
            <span aria-hidden>·</span>
            <time>{clock(at)}</time>
          </>
        )}
      </p>
    </Tooltip>
  );
}
