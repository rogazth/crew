import { Tooltip } from "@cloudflare/kumo";
import { lazy, memo, Suspense } from "react";
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
 * A turn another agent sent is still `role=user`, but it is not you: it keeps
 * to the left with its sender named, so the right-hand side stays the things
 * you typed.
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

function AgentMessage({ block, from }: { block: Block; from: AgentRef }) {
  const { openSession } = useChatActions();
  return (
    <div className="flex flex-col items-start gap-1">
      <button
        type="button"
        onClick={() => openSession(from.id)}
        className="text-[11px] leading-4 text-placeholder transition-colors hover:text-text"
        title={`Open ${from.name}`}
      >
        {from.name}
      </button>
      {block.text ? (
        <div className="crew-md-row">
          <div className="crew-bubble is-from-agent">
            <p className="whitespace-pre-wrap">{block.text}</p>
          </div>
          <CopyButton text={block.text} className="crew-copy crew-copy-aside" />
        </div>
      ) : null}
      {block.files && block.files.length > 0 ? <AttachmentStrip files={block.files} /> : null}
    </div>
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

export const Note = memo(function Note({ block }: { block: Block }) {
  return <p className="text-[13px] leading-[18px] text-text-muted">{block.text}</p>;
});

export const DateBreak = memo(function DateBreak({ label }: { label: string }) {
  return <p className="text-center text-[11px] leading-4 text-placeholder">{label}</p>;
});

/**
 * Closes a turn: how long it took, when. Tokens and cost wait in the tooltip.
 * Memoised because every footer above the live turn would otherwise rebuild its
 * tooltip on each streamed token.
 */
export const TurnFooter = memo(function TurnFooter({ usage, at }: { usage: TurnUsage; at?: number }) {
  const worked = usage.durationMs !== undefined ? `Worked for ${duration(usage.durationMs)}` : null;
  const parts = [worked, at !== undefined ? clock(at) : null].filter((p): p is string => p !== null);
  if (parts.length === 0) return null;
  const detail = usageDetail(usage);
  const line = (
    <span className="cursor-default text-[11px] leading-4 text-placeholder tabular-nums">
      {parts.join(" · ")}
    </span>
  );
  return (
    <div className="flex">
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
