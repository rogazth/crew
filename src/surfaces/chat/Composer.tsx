import {
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ClipboardEvent,
  type FormEvent,
  type KeyboardEvent,
  type Ref,
} from "react";
import { ArrowUpIcon, PaperclipIcon, SquareIcon } from "lucide-react";
import type { AttachedFile } from "../../lib/blocks";
import { completeMention, mentionAt, searchFiles, splitMentions } from "../../lib/mentions";
import type { ProjectFile, Session } from "../../lib/types";
import { AttachmentStrip } from "./Attachments";
import { useChatActions } from "./context";
import { MentionPicker } from "./MentionPicker";

type Props = {
  ref?: Ref<HTMLTextAreaElement>;
  session: Session;
  draft: string;
  files: AttachedFile[];
  working: boolean;
  ready: boolean;
  /** Something above waits on the user: an approval or a question. */
  waiting?: boolean;
  /** An empty chat: the well is the page, so it sits in the middle. */
  centered?: boolean;
  onDraft: (value: string) => void;
  onAttach: () => void;
  /** Files pasted from the clipboard (screenshots); they have no path yet. */
  onPasteFiles: (files: File[]) => void;
  onRemoveFile: (path: string) => void;
  onSend: () => void;
  onStop: () => void;
};

const MAX_FIELD_PX = 160;

/** A control well in the chrome's dialect: hairline, radius 16, plus and model left, send right. */
export function Composer({
  ref,
  session,
  draft,
  files,
  working,
  ready,
  waiting = false,
  centered = false,
  onDraft,
  onAttach,
  onPasteFiles,
  onRemoveFile,
  onSend,
  onStop,
}: Props) {
  const field = useRef<HTMLTextAreaElement>(null);
  const overlay = useRef<HTMLDivElement>(null);
  useImperativeHandle(ref, () => field.current as HTMLTextAreaElement);
  const { files: projectFiles } = useChatActions();
  const canSend = ready && (draft.trim().length > 0 || files.length > 0) && !working;

  // The caret is what decides whether an `@` is being typed; it moves without the text changing.
  const [cursor, setCursor] = useState(0);
  const [active, setActive] = useState(0);
  const mention = mentionAt(draft, cursor);
  const results = useMemo(
    () => (mention ? searchFiles(mention.query, projectFiles) : []),
    [mention?.query, projectFiles], // eslint-disable-line react-hooks/exhaustive-deps
  );
  const known = useMemo(() => new Set(projectFiles.map((file) => file.relative)), [projectFiles]);

  // Grows with the draft up to the cap; the browser's own sizing is one line.
  useLayoutEffect(() => {
    const el = field.current;
    if (!el) return;
    el.style.height = "0px";
    el.style.height = `${Math.min(el.scrollHeight, MAX_FIELD_PX)}px`;
    if (overlay.current) overlay.current.style.height = el.style.height;
  }, [draft]);

  const syncCursor = () => {
    const el = field.current;
    if (el) setCursor(el.selectionStart);
  };

  const pick = (file: ProjectFile) => {
    const el = field.current;
    if (!el) return;
    const next = completeMention(draft, el.selectionStart, file);
    if (!next) return;
    onDraft(next.text);
    setActive(0);
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(next.cursor, next.cursor);
      setCursor(next.cursor);
    });
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (working) onStop();
    else if (canSend) onSend();
  };

  const onPaste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    const pasted = [...(event.clipboardData?.files ?? [])];
    if (pasted.length === 0) return;
    event.preventDefault();
    onPasteFiles(pasted);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (mention && results.length > 0) {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        const step = event.key === "ArrowDown" ? 1 : -1;
        setActive((index) => (index + step + results.length) % results.length);
        return;
      }
      if (event.key === "Enter" || event.key === "Tab") {
        event.preventDefault();
        pick(results[Math.min(active, results.length - 1)]!);
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        setCursor(-1);
        return;
      }
    }
    if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
    event.preventDefault();
    if (working) onStop();
    else if (canSend) onSend();
  };

  return (
    <div className={`mx-auto w-full max-w-[760px] shrink-0 px-6 ${centered ? "py-3" : "pb-3"}`}>
      <form onSubmit={submit} className="crew-composer relative">
        {mention && (
          <MentionPicker results={results} active={Math.min(active, Math.max(0, results.length - 1))} onHover={setActive} onPick={pick} />
        )}
        {files.length > 0 && (
          <div className="mb-2">
            <AttachmentStrip files={files} onRemove={onRemoveFile} />
          </div>
        )}
        <div className="relative">
          <div ref={overlay} aria-hidden className="crew-composer-field crew-composer-overlay">
            {splitMentions(draft, known).map((segment, index) =>
              segment.kind === "mention" ? (
                <mark key={index} className="crew-mention-run">
                  {segment.text}
                </mark>
              ) : (
                <span key={index}>{segment.text}</span>
              ),
            )}
            {"​"}
          </div>
          <textarea
            ref={field}
            rows={1}
            value={draft}
            placeholder={
              waiting
                ? `${session.name} is waiting on you — answer above`
                : working
                  ? `${session.name} is working — ↵ stops it`
                  : `Ask ${session.name} anything — @ to mention a file`
            }
            spellCheck={false}
            onChange={(event) => {
              onDraft(event.target.value);
              setCursor(event.target.selectionStart);
              setActive(0);
            }}
            onSelect={syncCursor}
            onKeyUp={syncCursor}
            onClick={syncCursor}
            onBlur={() => setCursor(-1)}
            onScroll={(event) => {
              if (overlay.current) overlay.current.scrollTop = event.currentTarget.scrollTop;
            }}
            onKeyDown={onKeyDown}
            onPaste={onPaste}
            className="crew-composer-field crew-composer-input"
          />
        </div>
        <div className="mt-1.5 flex h-8 items-center justify-between gap-2">
          <div className="flex min-w-0 items-center gap-1.5">
            <button
              type="button"
              aria-label="Attach files"
              title="Attach files"
              onClick={onAttach}
              className="crew-composer-plus shrink-0"
            >
              <PaperclipIcon className="size-4" />
            </button>
          </div>
          <button
            type="submit"
            disabled={!working && !canSend}
            aria-label={working ? "Stop" : "Send"}
            className={`flex size-[30px] shrink-0 items-center justify-center rounded-full transition-colors duration-100 focus-visible:ring-[1.5px] focus-visible:ring-focus/50 focus-visible:outline-none ${
              working || canSend
                ? "crew-ink hover:bg-accent-hover"
                : "bg-card text-text-muted"
            }`}
          >
            {working ? <SquareIcon className="size-2.5 fill-current" /> : <ArrowUpIcon className="size-4" />}
          </button>
        </div>
      </form>
      <p className="mt-2 text-center text-[11px] text-placeholder">
        <kbd className="font-sans">↵</kbd> send · <kbd className="font-sans">⇧↵</kbd> new line · @ file · drop or paste to attach
      </p>
    </div>
  );
}

