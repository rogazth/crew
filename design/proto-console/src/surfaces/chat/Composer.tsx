import clsx from "clsx";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Paperclip, Square, X } from "lucide-react";
import type { AttachedFile, Session } from "@crew/fixtures";
import { Kbd } from "@/ui";
import { ModelPicker } from "@/chrome/ModelPicker";
import { store } from "@/lib/store";
import { rankFiles } from "@/lib/files";
import { bytes } from "@/lib/format";
import { completeMention, mentionAt, segmentsOf } from "@/lib/mentions";

const MAX_HEIGHT = 160;

export function Composer({
  session,
  working,
  active,
  onSend,
  onStop,
}: {
  session: Session;
  working: boolean;
  /** True while this surface is the visible tab, so it can take the caret. */
  active?: boolean;
  onSend: (text: string, files: AttachedFile[]) => void;
  onStop: () => void;
}) {
  const [text, setText] = useState("");
  const [files, setFiles] = useState<AttachedFile[]>([]);
  const [caret, setCaret] = useState(0);
  const [pick, setPick] = useState(0);
  const [dragging, setDragging] = useState(false);
  const area = useRef<HTMLTextAreaElement>(null);

  const mention = mentionAt(text, caret);
  const matches = mention ? rankFiles(mention.query, 7) : [];

  useLayoutEffect(() => {
    const node = area.current;
    if (!node) return;
    node.style.height = "auto";
    node.style.height = `${Math.min(MAX_HEIGHT, node.scrollHeight)}px`;
  }, [text]);

  useEffect(() => {
    setPick(0);
  }, [mention?.query]);

  /**
   * The composer does not steal the caret on mount — that would swallow `?`,
   * the arrow keys and every other bare-key binding the shell owns. Typing a
   * printable character anywhere else hands it over instead.
   */
  useEffect(() => {
    if (!active) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      if (event.key.length !== 1 || event.key === "?") return;
      const node = event.target as HTMLElement | null;
      if (node && (/^(input|textarea|select)$/i.test(node.tagName) || node.isContentEditable)) return;
      event.preventDefault();
      area.current?.focus({ preventScroll: true });
      setText((held) => held + event.key);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [active]);

  const send = () => {
    const body = text.trim();
    if (!body && files.length === 0) return;
    onSend(body, files);
    setText("");
    setFiles([]);
  };

  const complete = (relative: string) => {
    if (!mention) return;
    const next = completeMention(text, mention, relative);
    setText(next.text);
    requestAnimationFrame(() => {
      area.current?.setSelectionRange(next.caret, next.caret);
      setCaret(next.caret);
      area.current?.focus();
    });
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (mention && matches.length > 0) {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        const delta = event.key === "ArrowDown" ? 1 : -1;
        setPick((held) => (((held + delta) % matches.length) + matches.length) % matches.length);
        return;
      }
      if (event.key === "Enter" || event.key === "Tab") {
        event.preventDefault();
        complete(matches[pick]!.relative);
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        setCaret(-1);
        return;
      }
    }
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      send();
    }
  };

  const attach = (name: string, kind: AttachedFile["kind"], size: number) => {
    setFiles((held) => [...held, { name, path: `/tmp/${name}`, kind: kind ?? "file", size }]);
  };

  return (
    <div
      onDragOver={(event) => {
        event.preventDefault();
        setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={(event) => {
        event.preventDefault();
        setDragging(false);
        for (const file of Array.from(event.dataTransfer.files)) {
          attach(file.name, file.type.startsWith("image/") ? "image" : "file", file.size);
        }
        if (event.dataTransfer.files.length === 0) attach("dropped.txt", "file", 2_048);
      }}
      className="relative"
    >
      {dragging ? (
        <div className="absolute inset-0 z-20 grid place-items-center rounded-[var(--r)] border border-dashed border-accent bg-bg/90 font-mono text-sm text-accent-ink">
          drop to attach
        </div>
      ) : null}

      {files.length > 0 ? (
        <div className="mb-1 flex flex-wrap gap-1">
          {files.map((file, index) => (
            <span
              key={`${file.name}-${index}`}
              className="flex items-center gap-1.5 rounded-[var(--r)] border border-rule bg-raised px-1.5 py-0.5"
            >
              <span className="font-mono text-xs text-ink-4">{file.kind === "image" ? "img" : "file"}</span>
              <span className="font-mono text-xs text-ink-2">{file.name}</span>
              {file.size ? <span className="font-mono text-xs text-ink-4">{bytes(file.size)}</span> : null}
              <button
                type="button"
                aria-label={`Remove ${file.name}`}
                onClick={() => setFiles((held) => held.filter((_, at) => at !== index))}
                className="grid size-3.5 place-items-center text-ink-4 hover:text-red-ink"
              >
                <X size={11} strokeWidth={1.5} />
              </button>
            </span>
          ))}
        </div>
      ) : null}

      <div className="rounded-[var(--r)] border border-rule bg-sunken focus-within:border-accent">
        <div className="relative">
          {/* Behind the textarea: the same text, with completed mentions tinted. */}
          <div
            aria-hidden
            className="pointer-events-none absolute inset-0 overflow-hidden px-2 py-1.5 text-md leading-[var(--lh-md)] whitespace-pre-wrap text-transparent"
          >
            {segmentsOf(text).map((segment, index) =>
              segment.path ? (
                <span key={index} className="rounded-[2px] bg-accent-wash">
                  {segment.text}
                </span>
              ) : (
                <span key={index}>{segment.text}</span>
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
              setCaret(event.target.selectionStart);
            }}
            onKeyUp={(event) => setCaret(event.currentTarget.selectionStart)}
            onClick={(event) => setCaret(event.currentTarget.selectionStart)}
            onKeyDown={onKeyDown}
            onPaste={(event) => {
              const image = Array.from(event.clipboardData.items).find((item) =>
                item.type.startsWith("image/"),
              );
              if (!image) return;
              event.preventDefault();
              attach(`pasted-${Date.now().toString(36)}.png`, "image", 184_320);
            }}
            className="relative block max-h-[160px] w-full resize-none bg-transparent px-2 py-1.5 text-md leading-[var(--lh-md)] outline-none placeholder:text-ink-4"
          />
        </div>

        <div className="flex items-center gap-2 border-t border-rule px-1.5 py-1">
          <button
            type="button"
            aria-label="Attach a file"
            title="Attach a file"
            onClick={() => attach(`notes-${files.length + 1}.md`, "file", 4_096)}
            className="grid size-5 shrink-0 place-items-center rounded-[var(--r)] text-ink-4 hover:text-ink"
          >
            <Paperclip size={13} strokeWidth={1.25} />
          </button>
          <ModelPicker
            provider={session.provider}
            model={session.model}
            shape="chip"
            onChange={(next) => store.updateSession(session.id, next)}
          />
          <span className="ml-auto flex items-center gap-2 font-mono text-xs text-ink-4">
            <Kbd>@</Kbd>
            <span>file</span>
            <Kbd>⇧⏎</Kbd>
            <span>newline</span>
          </span>
          {working ? (
            <button
              type="button"
              onClick={onStop}
              className="flex h-[var(--control-h)] shrink-0 items-center gap-1.5 rounded-[var(--r)] border border-rule bg-raised px-2 text-md hover:border-red"
            >
              <Square size={10} strokeWidth={2} className="text-red-ink" />
              Stop
            </button>
          ) : (
            <button
              type="button"
              onClick={send}
              disabled={!text.trim() && files.length === 0}
              className="flex h-[var(--control-h)] shrink-0 items-center gap-1.5 rounded-[var(--r)] border border-ink bg-ink px-2 text-md text-on-ink disabled:opacity-30"
            >
              Send
              <Kbd className="border-on-ink/40 text-on-ink">⏎</Kbd>
            </button>
          )}
        </div>
      </div>

      {mention && matches.length > 0 ? (
        <div className="float absolute bottom-[calc(100%+4px)] left-0 z-30 max-h-[220px] w-[380px] overflow-auto py-1">
          <div className="px-2 pb-1 font-mono text-xs text-ink-4">mention a file</div>
          {matches.map((file, index) => (
            <button
              key={file.relative}
              type="button"
              onMouseMove={() => setPick(index)}
              onClick={() => complete(file.relative)}
              className={clsx(
                "flex h-[var(--row-h)] w-full items-baseline gap-2 px-2 text-left font-mono text-sm",
                index === pick && "bg-raised",
              )}
            >
              <span className="truncate text-ink">{file.name}</span>
              <span className="truncate text-xs text-ink-4">{file.relative}</span>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
