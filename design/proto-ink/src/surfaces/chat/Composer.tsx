import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ClipboardEvent,
  type DragEvent,
  type KeyboardEvent,
} from "react";
import type { AttachedFile, ProjectFile, Session } from "@crew/fixtures";
import { cx } from "@/lib/cx";
import { Icon } from "@/lib/icon";
import { fileIcon } from "@/lib/files";
import { applyMention, mentionAt, mentionCandidates, mentionSegments } from "@/lib/mentions";
import { useApp } from "@/lib/store";
import { IconButton, Tooltip } from "@/ui";
import { ModelChip } from "@/chrome/ModelPicker";

const MAX_HEIGHT = 160;

export function Composer({
  session,
  working,
  centred,
  onSend,
  onStop,
}: {
  session: Session;
  working: boolean;
  centred: boolean;
  onSend: (text: string, files: AttachedFile[]) => void;
  onStop: () => void;
}) {
  const { actions, files: pickerFiles } = useApp();
  const known = useMemo(
    () => new Set(pickerFiles.map((file) => file.relative)),
    [pickerFiles],
  );
  const [text, setText] = useState("");
  const [files, setFiles] = useState<AttachedFile[]>([]);
  const [dragging, setDragging] = useState(false);
  const [mention, setMention] = useState<{ query: string; start: number; end: number } | null>(null);
  const [cursor, setCursor] = useState(0);
  const area = useRef<HTMLTextAreaElement>(null);
  const overlay = useRef<HTMLDivElement>(null);

  const candidates = useMemo<ProjectFile[]>(
    () => (mention ? mentionCandidates(pickerFiles, mention.query) : []),
    [mention, pickerFiles],
  );

  useLayoutEffect(() => {
    const node = area.current;
    if (!node) return;
    node.style.height = "0px";
    node.style.height = `${Math.min(node.scrollHeight, MAX_HEIGHT)}px`;
  }, [text]);

  const syncMention = useCallback((value: string, caret: number) => {
    const hit = mentionAt(value, caret);
    setMention(hit);
    setCursor(0);
  }, []);

  const complete = (file: ProjectFile) => {
    if (!mention) return;
    const next = applyMention(text, mention, file.relative);
    setText(next.text);
    setMention(null);
    requestAnimationFrame(() => {
      area.current?.focus();
      area.current?.setSelectionRange(next.caret, next.caret);
    });
  };

  const send = () => {
    const body = text.trim();
    if (!body && files.length === 0) return;
    onSend(body, files);
    setText("");
    setFiles([]);
    setMention(null);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (mention && candidates.length > 0) {
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setCursor((value) => Math.min(value + 1, candidates.length - 1));
        return;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        setCursor((value) => Math.max(value - 1, 0));
        return;
      }
      if (event.key === "Enter" || event.key === "Tab") {
        event.preventDefault();
        const picked = candidates[cursor];
        if (picked) complete(picked);
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        setMention(null);
        return;
      }
    }
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      send();
    }
  };

  const onPaste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    const image = [...event.clipboardData.items].find((item) => item.type.startsWith("image/"));
    if (!image) return;
    event.preventDefault();
    const name = `pasted-${new Date().toISOString().slice(11, 19).replace(/:/g, "")}.png`;
    setFiles((prev) => [...prev, { name, path: `/tmp/${name}`, kind: "image", size: 184_320 }]);
  };

  const onDrop = (event: DragEvent) => {
    event.preventDefault();
    setDragging(false);
    const dropped = [...event.dataTransfer.files].map<AttachedFile>((file) => ({
      name: file.name,
      path: `/Users/you/crew/${file.name}`,
      kind: file.type.startsWith("image/") ? "image" : "file",
      size: file.size,
    }));
    if (dropped.length) setFiles((prev) => [...prev, ...dropped]);
  };

  // The overlay only exists to tint completed mentions, so it has to scroll with
  // the text it sits behind.
  useEffect(() => {
    const node = area.current;
    if (!node) return;
    const sync = () => {
      if (overlay.current) overlay.current.scrollTop = node.scrollTop;
    };
    node.addEventListener("scroll", sync);
    return () => node.removeEventListener("scroll", sync);
  }, []);

  const segments = mentionSegments(text, known);

  return (
    <div
      className={cx("relative w-full", centred ? "max-w-[38rem]" : "mx-auto max-w-[46rem]")}
      onDragOver={(event) => {
        event.preventDefault();
        setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={onDrop}
    >
      {dragging && (
        <div className="absolute inset-0 z-10 flex items-center justify-center rounded-composer bg-[var(--accent-fill)] shadow-[inset_0_0_0_1.5px_var(--accent-stroke)]">
          <span className="flex items-center gap-1.5 text-body text-[var(--accent)]">
            <Icon name="paperclip" size={14} />
            Drop to attach
          </span>
        </div>
      )}

      {mention && candidates.length > 0 && (
        <div className="absolute bottom-full left-0 z-20 mb-1.5 w-80 overflow-hidden rounded-card bg-canvas p-1 e2">
          {candidates.map((file, index) => (
            <button
              key={file.relative}
              type="button"
              onMouseMove={() => setCursor(index)}
              onMouseDown={(event) => {
                event.preventDefault();
                complete(file);
              }}
              className={cx(
                "flex h-7 w-full items-center gap-2 rounded-md px-2 text-left",
                index === cursor ? "bg-[var(--fill-tertiary)]" : "hover:bg-[var(--fill-quaternary)]",
              )}
            >
              <Icon name={fileIcon(file.relative)} size={13} className="shrink-0 text-icon-faint" />
              <span className="min-w-0 flex-1 truncate font-mono text-small text-primary">
                {file.name}
              </span>
              <span className="min-w-0 max-w-40 shrink-0 truncate text-micro text-quaternary">
                {file.relative}
              </span>
            </button>
          ))}
        </div>
      )}

      <div className="overflow-hidden rounded-composer bg-chrome e1">
        {files.length > 0 && (
          <div className="flex flex-wrap gap-1 border-b border-[var(--stroke-tertiary)] px-2 py-1.5">
            {files.map((file, index) => (
              <span
                key={`${file.path}-${index}`}
                className="flex h-6 items-center gap-1.5 rounded-md bg-canvas px-2 text-micro text-tertiary hairline"
              >
                <Icon
                  name={file.kind === "image" ? "image" : fileIcon(file.name)}
                  size={12}
                  className="text-icon-faint"
                />
                <span className="max-w-40 truncate font-mono">{file.name}</span>
                <button
                  type="button"
                  aria-label={`Remove ${file.name}`}
                  onClick={() => setFiles((prev) => prev.filter((_, i) => i !== index))}
                  className="text-icon-faint transition-colors hover:text-primary"
                >
                  <Icon name="close" size={11} />
                </button>
              </span>
            ))}
          </div>
        )}

        <div className="relative px-3 pt-2.5">
          <div
            ref={overlay}
            aria-hidden
            className="pointer-events-none absolute inset-0 overflow-hidden px-3 pt-2.5 text-prose"
            style={{ whiteSpace: "pre-wrap", wordBreak: "break-word" }}
          >
            {segments.map((segment, index) =>
              segment.mention ? (
                <span
                  key={index}
                  className="rounded-sm bg-[var(--accent-fill)] text-transparent"
                >
                  {segment.text}
                </span>
              ) : (
                <span key={index} className="text-transparent">
                  {segment.text}
                </span>
              ),
            )}
          </div>
          <textarea
            ref={area}
            rows={2}
            value={text}
            placeholder={`Message ${session.name}`}
            onChange={(event) => {
              setText(event.target.value);
              syncMention(event.target.value, event.target.selectionStart);
            }}
            onKeyUp={(event) => syncMention(text, event.currentTarget.selectionStart)}
            onClick={(event) => syncMention(text, event.currentTarget.selectionStart)}
            onKeyDown={onKeyDown}
            onPaste={onPaste}
            className="ink-scroll relative block w-full resize-none bg-transparent text-prose text-primary outline-none placeholder:text-quaternary"
            style={{ maxHeight: MAX_HEIGHT, wordBreak: "break-word" }}
          />
        </div>

        <div className="flex items-center gap-1 px-2 pb-2 pt-1">
          <Tooltip content="Attach a file">
            <IconButton
              icon="plus"
              size="sm"
              label="Attach a file"
              onClick={() =>
                setFiles((prev) => [
                  ...prev,
                  {
                    name: "codex-stream.jsonl",
                    path: "/Users/you/crew/docs/protocols/codex.jsonl",
                    kind: "file",
                    size: 48_211,
                  },
                ])
              }
            />
          </Tooltip>
          <ModelChip
            value={{ provider: session.provider, model: session.model }}
            onChange={(next) =>
              actions.updateSession(session.id, { provider: next.provider, model: next.model })
            }
          />
          <span className="flex-1" />
          <span className="pr-1 text-micro text-quaternary">
            {text.includes("@") ? "@ mentions a file" : "⇧⏎ for a newline"}
          </span>
          {working ? (
            <Tooltip content="Stop the turn">
              <button
                type="button"
                aria-label="Stop"
                onClick={onStop}
                className="flex size-7 items-center justify-center rounded-full bg-[var(--fill-primary)] text-primary transition-colors hover:bg-[var(--fill-secondary)]"
              >
                <Icon name="stop" size={12} className="fill-current" />
              </button>
            </Tooltip>
          ) : (
            <button
              type="button"
              aria-label="Send"
              disabled={!text.trim() && files.length === 0}
              onClick={send}
              className={cx(
                "flex size-7 items-center justify-center rounded-full transition-opacity duration-[var(--dur-2)]",
                "bg-[var(--ink)] text-[var(--surface-canvas)]",
                "disabled:opacity-25",
              )}
            >
              <Icon name="send" size={14} strokeWidth={2} />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
