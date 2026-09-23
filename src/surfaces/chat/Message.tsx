import { Collapsible, Tooltip } from "@cloudflare/kumo";
import { CaretRightIcon, PaperPlaneTiltIcon } from "@phosphor-icons/react";
import { lazy, memo, Suspense, useState } from "react";
import { FileTypeIcon } from "../../chrome/FileTypeIcon";
import type { AgentRef, Block, TurnUsage } from "../../lib/blocks";
import { splitMentions } from "../../lib/mentions";
import { AttachmentStrip } from "./Attachments";
import { useChatActions } from "./context";
import { CopyButton } from "./CopyButton";
import { firstLine, footerLine, usageDetail } from "../../lib/transcriptView";

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
  const first = firstLine(block.text);
  return (
    <Collapsible.Root open={open} onOpenChange={setOpen}>
      <Collapsible.Trigger
        className="group flex min-h-5 w-full items-center gap-2 py-0.5 text-left text-[13px] leading-[18px]"
        data-block={block.id}
      >
        <span className="relative flex size-3.5 shrink-0 items-center justify-center text-kumo-subtle">
          <PaperPlaneTiltIcon className="size-3.5 transition-opacity group-hover:opacity-0" />
          <CaretRightIcon
            weight="bold"
            className={`absolute size-3 opacity-0 transition-[opacity,transform] duration-150 group-hover:opacity-100 ${open ? "rotate-90" : ""}`}
          />
        </span>
        <span className="shrink-0 text-text-muted transition-colors group-hover:text-text">
          {from.name} messaged you
        </span>
        {open ? null : <span className="min-w-0 truncate text-placeholder">{first}</span>}
      </Collapsible.Trigger>
      <Collapsible.Panel className="crew-phase-panel">
        <div className="crew-tool-body flex flex-col items-start gap-1.5">
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
  const text = footerLine(usage, at);
  if (text === null) return null;
  const detail = usageDetail(usage);
  const line = (
    <span className="cursor-default text-[11px] leading-4 text-placeholder tabular-nums">
      {text}
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
