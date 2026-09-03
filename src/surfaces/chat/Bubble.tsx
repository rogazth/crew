import { FileTypeIcon } from "../../chrome/FileTypeIcon";
import { X } from "../../chrome/icons";
import type { AttachedFile, Block } from "../../lib/blocks";
import { Markdown } from "./Markdown";

type Props = { block: Block };

/** R3 conversation shape, Cursor radius and ink. */
export function Bubble({ block }: Props) {
  if (block.role === "user") {
    return (
      <div className="flex justify-end">
        <div className="crew-bubble crew-ink flex flex-col gap-2">
          {block.text ? <p className="whitespace-pre-wrap">{block.text}</p> : null}
          {block.files && block.files.length > 0 ? <FileChips files={block.files} onInk /> : null}
        </div>
      </div>
    );
  }

  if (block.role === "system") {
    return <p className="text-[12px] leading-4 text-text-muted">{block.text}</p>;
  }

  return (
    <div className="flex justify-start">
      <div className="crew-bubble crew-bubble-agent">
        {block.text || block.streaming ? (
          <Markdown text={block.text} {...(block.streaming ? { streaming: true } : {})} />
        ) : null}
      </div>
    </div>
  );
}

export function FileChips({
  files,
  onInk,
  onRemove,
}: {
  files: AttachedFile[];
  onInk?: boolean;
  onRemove?: (path: string) => void;
}) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {files.map((file) => (
        <span
          key={file.path}
          className={`inline-flex max-w-[210px] items-center gap-1.5 rounded-lg px-2 py-1 ${
            onInk ? "crew-chip-on-ink" : "border border-border bg-card"
          }`}
        >
          <FileTypeIcon name={file.name} className="size-3.5" />
          <span className="min-w-0 truncate">{file.name}</span>
          {onRemove && (
            <button
              type="button"
              aria-label={`Remove ${file.name}`}
              onClick={() => onRemove(file.path)}
              className="text-text-muted hover:text-text"
            >
              <X className="size-3" />
            </button>
          )}
        </span>
      ))}
    </div>
  );
}
