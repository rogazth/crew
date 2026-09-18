import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { rankBy, type AttachedFile } from "@crew/fixtures";
import { useStore } from "@/lib/store";
import { cx } from "@/lib/cx";
import { IconButton } from "@/ui/Button";
import { Icon } from "@/ui/Icon";
import { Kbd } from "@/ui/Kbd";
import { Pulse } from "@/ui/Pulse";
import { ModelPicker } from "@/chrome/ModelPicker";

const MENTION_TOKEN = /(@[\w./-]+)/g;
const MAX_HEIGHT = 160;

export function Composer({
  agentName,
  provider,
  model,
  onModel,
  working,
  onSend,
  onStop,
  attachments,
  onAttach,
  onRemoveAttachment,
  centred,
}: {
  agentName: string;
  provider: string;
  model: string;
  onModel: (provider: string, model: string) => void;
  working: boolean;
  onSend: (text: string) => void;
  onStop: () => void;
  attachments: AttachedFile[];
  onAttach: (files: AttachedFile[]) => void;
  onRemoveAttachment: (path: string) => void;
  centred?: boolean;
}) {
  const { files } = useStore();
  const [text, setText] = useState("");
  const [mention, setMention] = useState<{ query: string; start: number } | null>(null);
  const [cursor, setCursor] = useState(0);
  const areaRef = useRef<HTMLTextAreaElement>(null);
  const mirrorRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const area = areaRef.current;
    if (!area) return;
    area.style.height = "auto";
    area.style.height = `${Math.min(MAX_HEIGHT, area.scrollHeight)}px`;
  }, [text]);

  // The highlight layer must scroll with the textarea or the two drift apart.
  const syncScroll = () => {
    if (mirrorRef.current && areaRef.current) mirrorRef.current.scrollTop = areaRef.current.scrollTop;
  };

  const matches = useMemo(() => {
    if (!mention) return [];
    return rankBy(files, mention.query, (file) => file.relative).slice(0, 7);
  }, [mention, files]);

  useEffect(() => setCursor(0), [mention?.query]);

  const detectMention = (value: string, caret: number) => {
    const before = value.slice(0, caret);
    const at = before.lastIndexOf("@");
    if (at < 0) {
      setMention(null);
      return;
    }
    const between = before.slice(at + 1);
    if (/\s/.test(between) || (at > 0 && !/\s/.test(before[at - 1] ?? " "))) {
      setMention(null);
      return;
    }
    setMention({ query: between, start: at });
  };

  const complete = (relative: string) => {
    if (!mention) return;
    const area = areaRef.current;
    const caret = area?.selectionStart ?? text.length;
    const next = `${text.slice(0, mention.start)}@${relative} ${text.slice(caret)}`;
    setText(next);
    setMention(null);
    requestAnimationFrame(() => {
      area?.focus();
      const pos = mention.start + relative.length + 2;
      area?.setSelectionRange(pos, pos);
    });
  };

  const send = () => {
    const body = text.trim();
    if (!body || working) return;
    onSend(body);
    setText("");
    setMention(null);
  };

  return (
    <div className={cx("relative w-full", centred ? "" : "px-6 pb-5")}>
      {attachments.length > 0 && (
        <div className="mb-2 flex flex-wrap gap-1.5">
          {attachments.map((file) => (
            <span key={file.path} className="inline-flex h-7 items-center gap-1.5 rounded-chip bg-raised px-2 text-sm text-ink-70 el-1">
              <Icon name={file.kind === "image" ? "eye" : "paperclip"} size={12} className="opacity-70" />
              <span className="max-w-[160px] truncate">{file.name}</span>
              <button
                type="button"
                aria-label={`Remove ${file.name}`}
                onClick={() => onRemoveAttachment(file.path)}
                className="grid size-4 place-items-center rounded-full text-ink-38 hover:bg-sunken hover:text-ink"
              >
                <Icon name="x" size={11} />
              </button>
            </span>
          ))}
        </div>
      )}

      {mention && matches.length > 0 && (
        <div className="absolute bottom-full left-6 z-30 mb-2 w-[min(460px,calc(100%-48px))] overflow-hidden rounded-card bg-overlay p-1.5 el-3">
          <div className="px-2 pb-1 pt-0.5 text-xs font-semibold uppercase tracking-[0.06em] text-ink-38">Files</div>
          {matches.map((file, index) => (
            <button
              key={file.relative}
              type="button"
              onMouseMove={() => setCursor(index)}
              onClick={() => complete(file.relative)}
              className={cx(
                "flex h-8 w-full items-center gap-2 rounded-[8px] px-2 text-left text-base",
                index === cursor ? "bg-accent-soft" : "",
              )}
            >
              <Icon name="fileCode" size={14} className="shrink-0 text-ink-38" />
              <span className="truncate text-ink">{file.name}</span>
              <span className="min-w-0 flex-1 truncate text-sm text-ink-38">{file.relative}</span>
            </button>
          ))}
        </div>
      )}

      <div className="rounded-panel bg-raised p-2 el-2">
        <div className="relative">
          <div
            ref={mirrorRef}
            aria-hidden
            className="pointer-events-none absolute inset-0 overflow-hidden whitespace-pre-wrap break-words px-2 py-1.5 text-base text-transparent"
          >
            {text.split(MENTION_TOKEN).map((part, index) =>
              index % 2 === 1 ? (
                <span key={index} className="rounded-[4px] bg-accent-soft text-transparent">
                  {part}
                </span>
              ) : (
                <span key={index}>{part}</span>
              ),
            )}
          </div>
          <textarea
            ref={areaRef}
            rows={2}
            value={text}
            placeholder={`Message ${agentName}`}
            onScroll={syncScroll}
            onChange={(event) => {
              setText(event.target.value);
              detectMention(event.target.value, event.target.selectionStart);
            }}
            onClick={(event) => detectMention(text, event.currentTarget.selectionStart)}
            onPaste={(event) => {
              const images = [...event.clipboardData.items].filter((item) => item.type.startsWith("image/"));
              if (images.length === 0) return;
              event.preventDefault();
              onAttach(
                images.map((_, index) => ({
                  name: `pasted-${Date.now()}-${index}.png`,
                  path: `/tmp/pasted-${Date.now()}-${index}.png`,
                  kind: "image" as const,
                  size: 148_220,
                })),
              );
            }}
            onKeyDown={(event) => {
              if (mention && matches.length > 0) {
                if (event.key === "ArrowDown") {
                  event.preventDefault();
                  setCursor((held) => Math.min(matches.length - 1, held + 1));
                  return;
                }
                if (event.key === "ArrowUp") {
                  event.preventDefault();
                  setCursor((held) => Math.max(0, held - 1));
                  return;
                }
                if (event.key === "Enter" || event.key === "Tab") {
                  event.preventDefault();
                  complete(matches[cursor]!.relative);
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
            }}
            className="relative block max-h-[160px] w-full resize-none bg-transparent px-2 py-1.5 text-base text-ink caret-[var(--accent)] outline-none placeholder:text-ink-38"
          />
        </div>

        <div className="mt-1 flex items-center gap-1.5">
          <IconButton icon="paperclip" label="Attach a file" size="sm" variant="ghost" onClick={() => onAttach([{ name: "screenshot.png", path: `/tmp/shot-${Date.now()}.png`, kind: "image", size: 92_118 }])} />
          <ModelPicker provider={provider} model={model} onChange={onModel} shape="chip" />
          <span className="flex-1" />
          <span className="hidden items-center gap-1 text-xs text-ink-38 sm:flex">
            <Kbd>⏎</Kbd> send
            <Kbd>⇧⏎</Kbd> newline
          </span>
          {working ? (
            <button
              type="button"
              onClick={onStop}
              className="rise inline-flex h-8 items-center gap-2 rounded-control bg-raised px-3 text-sm font-medium text-ink el-2"
            >
              <Pulse className="text-ink-52" />
              Stop
            </button>
          ) : (
            <button
              type="button"
              onClick={send}
              disabled={!text.trim()}
              className="rise inline-flex size-8 items-center justify-center rounded-control bg-accent text-on-accent el-2 disabled:pointer-events-none disabled:opacity-40"
              aria-label="Send"
            >
              <Icon name="send" size={15} />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
