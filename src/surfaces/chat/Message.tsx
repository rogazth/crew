import { memo } from "react";
import { FileTypeIcon } from "../../chrome/FileTypeIcon";
import { X } from "../../chrome/icons";
import type { AttachedFile, Block, TurnUsage } from "../../lib/blocks";
import { Markdown } from "./Markdown";

/** A document card in the chrome's own dialect: 6% ink, radius 8, no invert. */
export const UserMessage = memo(function UserMessage({ block }: { block: Block }) {
  return (
    <div className="flex justify-start">
      <div className="crew-prose flex w-fit max-w-full flex-col gap-1.5 rounded-lg bg-card px-3 py-2">
        {block.text ? <p className="whitespace-pre-wrap">{block.text}</p> : null}
        {block.files && block.files.length > 0 ? <FileChips files={block.files} /> : null}
      </div>
    </div>
  );
});

/** Flush prose on the canvas. The column is the container; nothing wraps it. */
export const AssistantMessage = memo(function AssistantMessage({ block }: { block: Block }) {
  return (
    <div>
      <Markdown text={block.text} {...(block.streaming ? { streaming: true } : {})} />
      {block.usage && !block.streaming ? <Usage usage={block.usage} /> : null}
    </div>
  );
});

export function Note({ block }: { block: Block }) {
  return <p className="text-[12px] leading-4 text-text-muted">{block.text}</p>;
}

function Usage({ usage }: { usage: TurnUsage }) {
  const parts: string[] = [];
  if (usage.inputTokens !== undefined || usage.outputTokens !== undefined) {
    parts.push(`${compact(usage.inputTokens ?? 0)} in · ${compact(usage.outputTokens ?? 0)} out`);
  }
  if (usage.costUsd !== undefined) parts.push(`$${usage.costUsd.toFixed(usage.costUsd < 0.1 ? 3 : 2)}`);
  if (usage.durationMs !== undefined) parts.push(`${Math.max(1, Math.round(usage.durationMs / 1000))}s`);
  if (parts.length === 0) return null;
  return (
    <p className="mt-1.5 text-[11px] leading-[14px] text-placeholder tabular-nums">{parts.join(" · ")}</p>
  );
}

function compact(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(n >= 10_000 ? 0 : 1)}k`;
  return String(n);
}

/** One chip recipe for the composer and the sent message. */
export function FileChips({
  files,
  onRemove,
}: {
  files: AttachedFile[];
  onRemove?: (path: string) => void;
}) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {files.map((file) => (
        <span
          key={file.path}
          title={file.path}
          className="inline-flex h-6 max-w-[180px] items-center gap-1.5 rounded-md bg-card px-2 text-[12px] leading-4"
        >
          <FileTypeIcon name={file.name} className="size-3.5" />
          <span className="min-w-0 truncate">{file.name}</span>
          {onRemove && (
            <button
              type="button"
              aria-label={`Remove ${file.name}`}
              onClick={() => onRemove(file.path)}
              className="-mr-0.5 flex size-4 items-center justify-center rounded text-kumo-subtle transition-colors hover:text-text"
            >
              <X className="size-3" />
            </button>
          )}
        </span>
      ))}
    </div>
  );
}
