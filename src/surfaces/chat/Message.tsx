import { Collapsible } from "@base-ui/react/collapsible";
import { Tooltip } from "../../chrome/kit";
import { ChevronRightIcon, InfoIcon } from "lucide-react";
import { AgentAvatar } from "../../chrome/AgentAvatar";
import { lazy, memo, Suspense, useState } from "react";
import { FileTypeIcon } from "../../chrome/FileTypeIcon";
import type { AgentRef, Block, TurnUsage } from "../../lib/blocks";
import { splitMentions } from "../../lib/mentions";
import { AttachmentStrip } from "./Attachments";
import { useChatActions } from "./context";
import { CopyButton } from "./CopyButton";
import { clock, duration } from "../../lib/time";

/** streamdown and its parsers are half a megabyte; the window opens without them. */
const Markdown = lazy(() => import("./Markdown").then((m) => ({ default: m.Markdown })));

/**
 * What the user said sits on the right, in ink; the agent answers on the left
 * in grey. Attachments are their own row under the bubble: a picture inside it
 * would set the bubble's width, not the words.
 *
 * A turn another agent sent is still `role=user`, but it is not you: it reads
 * as an event in the run, like the row the sender sees for having written it,
 * so the bubbles stay the conversation you are actually in.
 */
export const UserMessage = memo(function UserMessage({ block }: { block: Block }) {
  if (block.fromAgent) return <AgentMessage block={block} from={block.fromAgent} />;
  return (
    <div className="flex flex-col items-end gap-1.5">
      {block.text ? (
        <div className="crew-md-row is-user">
          <div className="crew-bubble">
            <p className="whitespace-pre-wrap">
              <MentionText text={block.text} />
            </p>
          </div>
          <CopyButton text={block.text} className="crew-copy crew-copy-aside" />
        </div>
      ) : null}
      {block.files && block.files.length > 0 ? (
        <div className="flex justify-end">
          <AttachmentStrip files={block.files} />
        </div>
      ) : null}
    </div>
  );
});

/**
 * A letter another agent wrote, folded to one line: who sent it and how it
 * opens. Folded it still shows the first line — a message you cannot see at
 * all is one you have to click to know you can ignore.
 */
function AgentMessage({ block, from }: { block: Block; from: AgentRef }) {
  const { openSession } = useChatActions();
  const [open, setOpen] = useState(false);
  const first = block.text.split("\n").find((line) => line.trim() !== "") ?? "";
  return (
    <Collapsible.Root open={open} onOpenChange={setOpen}>
      <Collapsible.Trigger
        className="group flex w-full items-center gap-2.5 rounded-xl px-2.5 py-2 text-left text-[13px] leading-[18px] ring-1 ring-hairline transition-colors hover:bg-hover"
        data-block={block.id}
      >
        <AgentAvatar seed={from.id} bare className="size-5" />
        <span className="shrink-0">
          <span className="font-medium">{from.name}</span>
          <span className="text-text-muted"> wrote to you</span>
        </span>
        {open ? <span className="flex-1" /> : <span className="min-w-0 flex-1 truncate text-text-muted">{first}</span>}
        <ChevronRightIcon
          className={`size-3.5 shrink-0 text-icon transition-transform duration-150 ${open ? "rotate-90" : ""}`}
        />
      </Collapsible.Trigger>
      <Collapsible.Panel className="crew-phase-panel">
        <div className="flex flex-col items-start gap-1.5 pt-2">
          {block.text ? (
            <div className="crew-md-row">
              <div className="crew-bubble is-from-agent">
                <p className="whitespace-pre-wrap">{block.text}</p>
              </div>
              <CopyButton text={block.text} className="crew-copy crew-copy-aside" />
            </div>
          ) : null}
          {block.files && block.files.length > 0 ? <AttachmentStrip files={block.files} /> : null}
          <button
            type="button"
            onClick={() => openSession(from.id)}
            className="text-[11px] leading-4 text-placeholder transition-colors hover:text-text"
            title={`Open ${from.name}`}
          >
            Open {from.name}
          </button>
        </div>
      </Collapsible.Panel>
    </Collapsible.Root>
  );
}

/** `@path` runs become pills that open the file; the rest is the text as typed. */
function MentionText({ text }: { text: string }) {
  const { openPath } = useChatActions();
  const segments = splitMentions(text);
  return (
    <>
      {segments.map((segment, index) =>
        segment.kind === "mention" ? (
          // react-doctor-disable-next-line react-doctor/no-array-index-as-key -- segments of a sent message never reorder
          <button
            key={index}
            type="button"
            title={segment.path}
            onClick={() => openPath(segment.path)}
            className="crew-mention-pill"
          >
            <FileTypeIcon name={segment.path.split("/").pop() ?? segment.path} className="size-3" />
            {segment.path.split("/").pop()}
          </button>
        ) : (
          <span key={index}>{segment.text}</span>
        ),
      )}
    </>
  );
}

export const AssistantMessage = memo(function AssistantMessage({ block }: { block: Block }) {
  return (
    <Suspense
      fallback={
        <div className="crew-md">
          <div className="crew-md-prose whitespace-pre-wrap">{block.text}</div>
        </div>
      }
    >
      <Markdown text={block.text} {...(block.streaming ? { streaming: true } : {})} />
    </Suspense>
  );
});

/** Something the session itself said: a quiet line with a mark, not a message. */
export const Note = memo(function Note({ block }: { block: Block }) {
  return (
    <p className="flex items-start gap-2 text-[13px] leading-[19px] text-text-muted">
      <InfoIcon className="mt-0.5 size-3.5 shrink-0 text-icon" />
      {block.text}
    </p>
  );
});

/** A day turning over: a hairline with the date on it, as chat apps mark one. */
export const DateBreak = memo(function DateBreak({ label }: { label: string }) {
  return (
    <p className="flex items-center gap-3 text-[11px] leading-4 font-medium text-text-muted">
      <span className="h-px flex-1 bg-hairline" />
      {label}
      <span className="h-px flex-1 bg-hairline" />
    </p>
  );
});

/**
 * Closes a turn: how long it took, when. Tokens and cost wait in the tooltip.
 * Memoised because every footer above the live turn would otherwise rebuild its
 * tooltip on each streamed token.
 */
export const TurnFooter = memo(function TurnFooter({ usage, at, text }: { usage: TurnUsage; at?: number; text?: string }) {
  const worked = usage.durationMs !== undefined ? `Worked ${duration(usage.durationMs)}` : null;
  const parts = [worked, at !== undefined ? clock(at) : null].filter((p): p is string => p !== null);
  if (parts.length === 0 && !text) return null;
  const detail = usageDetail(usage);
  const line = (
    <span className="cursor-default text-[11.5px] leading-4 text-text-muted tabular-nums">{parts.join(" · ")}</span>
  );
  // The reply's actions, as ChatGPT sets them under an answer: copy first, then what it cost.
  return (
    <div className="-ml-1 flex items-center gap-1.5">
      {text ? <CopyButton text={text.trim()} className="crew-copy" /> : null}
      {detail ? (
        <Tooltip content={detail} side="top" align="start" delay={300} render={<span />}>
          {line}
        </Tooltip>
      ) : (
        line
      )}
    </div>
  );
});

function usageDetail(usage: TurnUsage): string | null {
  const parts: string[] = [];
  if (usage.inputTokens !== undefined || usage.outputTokens !== undefined) {
    parts.push(`${compact(usage.inputTokens ?? 0)} in · ${compact(usage.outputTokens ?? 0)} out`);
  }
  if (usage.costUsd !== undefined) parts.push(`$${usage.costUsd.toFixed(usage.costUsd < 0.1 ? 3 : 2)}`);
  return parts.length > 0 ? parts.join(" · ") : null;
}

function compact(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(n >= 10_000 ? 0 : 1)}k`;
  return String(n);
}
