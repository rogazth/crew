import {
  useCallback,
  useEffect,
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
import { AccessPicker, ModelControls } from "../../chrome/ComposerControls";
import type { Opener } from "../../chrome/ModelPicker";
import { useCommands } from "../../hooks/useCommands";
import type { AttachedFile } from "../../lib/blocks";
import { accessesOf, toggledFast, type Access, type AgentChoice, type Effort, type ProviderId } from "../../lib/providers";
import { nextAccess } from "../../lib/sessionOptions";
import { completeMention, mentionAt, searchFiles, splitMentions } from "../../lib/mentions";
import type { CommandEntry } from "../../lib/protocol";
import {
  completeSlash,
  opensMessage,
  refreshCommands,
  removeSlash,
  searchCommands,
  slashAt,
  splitTokens,
  tokenBefore,
} from "../../lib/slashCommands";
import type { ProjectFile, Session } from "../../lib/types";
import { crewAction } from "../../lib/turnRuntime";
import { AttachmentStrip } from "./Attachments";
import { ContextMeter } from "./ContextMeter";
import { McpSegment } from "./Mcp";
import { PausedSegment, WorkSegment, type PanelScope } from "./Panel";
import { QueueChips, QueueSegment, type QueueScope } from "./Queue";
import { useChatActions } from "./context";
import { MentionPicker } from "./MentionPicker";
import { SlashPicker } from "./SlashPicker";

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
  /** `mode` is how a message written while a turn runs goes: absent when no turn runs. */
  onSend: (mode?: "steer" | "queue") => void;
  onStop: () => void;
  /**
   * What a message sent while a turn runs becomes: `steer` goes into the
   * running turn, `queue` waits for it to end. Absent, nothing is sent until
   * the turn ends.
   */
  whileWorking?: "steer" | "queue";
  /** What the user sent while a turn ran and the transcript does not show yet. */
  queue?: QueueScope;
  /** What the session left running in the background: an agent, a shell, a process. Absent: no segment. */
  work?: PanelScope;
  /** The chips changed; absent, the composer has none. */
  onOptions?: (next: AgentChoice) => void;
  /** A change the next message carries to the CLI by relaunching it. */
  optionsPending?: boolean;
  /** Other providers are offered, not only the session's own. */
  switchProvider?: boolean;
  /** In a thread: Esc goes back one level and never stops the turn; the Stop button does. */
  escBack?: boolean;
};

/** What the session's row says it runs, as the chips show it. */
const choiceOf = (session: Session): AgentChoice => ({
  provider: session.provider as ProviderId,
  model: session.model,
  effort: session.effort as Effort | "",
  serviceTier: session.serviceTier ?? "",
  access: session.autonomy as Access,
});

const MAX_FIELD_PX = 160;

/** The menu before the daemon has answered: nothing to list or to paint. */
const NO_ENTRIES: CommandEntry[] = [];

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
  whileWorking,
  queue,
  work,
  onOptions,
  optionsPending = false,
  switchProvider = false,
  escBack = false,
}: Props) {
  const field = useRef<HTMLTextAreaElement>(null);
  const overlay = useRef<HTMLDivElement>(null);
  useImperativeHandle(ref, () => field.current as HTMLTextAreaElement);
  const { files: projectFiles, confirm } = useChatActions();
  const canSend = ready && (draft.trim().length > 0 || files.length > 0) && (!working || whileWorking !== undefined);

  // The caret is what decides whether an `@` is being typed; it moves without the text changing.
  const [cursor, setCursor] = useState(0);
  const [active, setActive] = useState(0);
  const mention = mentionAt(draft, cursor);
  const results = useMemo(
    () => (mention ? searchFiles(mention.query, projectFiles) : []),
    [mention?.query, projectFiles], // eslint-disable-line react-hooks/exhaustive-deps
  );
  const known = useMemo(() => new Set(projectFiles.map((file) => file.relative)), [projectFiles]);

  // The same for a `/`: a provider's commands only open a message, so the menu depends on where the slash is.
  const entries = useCommands(session.id)?.entries ?? NO_ENTRIES;
  const slash = mention ? null : slashAt(draft, cursor);
  const slashStarts = slash ? opensMessage(draft, slash.start) : false;
  const slashResults = useMemo(
    () => (slash ? searchCommands(entries, slash.query, slashStarts) : []),
    [slash?.query, slashStarts, entries], // eslint-disable-line react-hooks/exhaustive-deps
  );
  const choices = mention ? results.length : slashResults.length;
  // The daemon answers from its cache and reads again once that is stale: a menu opened late is current.
  const typingSlash = slash !== null;
  useEffect(() => {
    if (typingSlash) void refreshCommands(session.id);
  }, [typingSlash, session.id]);

  // One sheet over the composer at a time: the queue's, the background work's or the MCP servers'.
  const [sheet, setSheet] = useState<"queue" | "work" | "mcp" | null>(null);
  const openQueue = useCallback((open: boolean) => setSheet(open ? "queue" : null), []);
  const openWork = useCallback((open: boolean) => setSheet(open ? "work" : null), []);
  const openMcp = useCallback((open: boolean) => setSheet(open ? "mcp" : null), []);
  const focusField = useCallback(() => field.current?.focus(), []);

  const model = useRef<Opener>(null);
  const effort = useRef<Opener>(null);
  const access = useRef<Opener>(null);

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

  // The draft has just changed: the caret goes where the change left it once the field has the new text.
  const place = (at: number, then?: () => void) => {
    requestAnimationFrame(() => {
      const el = field.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(at, at);
      setCursor(at);
      then?.();
    });
  };

  const pick = (file: ProjectFile) => {
    const el = field.current;
    if (!el) return;
    const next = completeMention(draft, el.selectionStart, file);
    if (!next) return;
    onDraft(next.text);
    setActive(0);
    place(next.cursor);
  };

  // A command or skill stays in the draft as `/name `; a Crew action runs and leaves nothing.
  const pickSlash = (entry: CommandEntry) => {
    const el = field.current;
    if (!el) return;
    const acts = entry.kind === "crew";
    const next = acts ? removeSlash(draft, el.selectionStart) : completeSlash(draft, el.selectionStart, entry);
    if (!next) return;
    onDraft(next.text);
    setActive(0);
    // A menu it opens takes the focus, so it opens after the field has had it.
    place(next.cursor, acts ? () => runAction(entry.name) : undefined);
  };

  const runAction = (name: string) => {
    if (name === "model") model.current?.open();
    else if (name === "effort") effort.current?.open();
    else if (name === "access") access.current?.open();
    else if (name === "fast") {
      const next = toggledFast(choiceOf(session));
      if (next) onOptions?.(next);
    } else if (name === "restart" || name === "reload") void crewAction(session.id, name, confirm);
  };

  // ⌘↵ while it works: wait for the turn instead of joining it.
  const sendAs = (wait: boolean) => onSend(working ? (wait ? "queue" : whileWorking) : undefined);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (canSend) sendAs(false);
  };

  const onPaste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    const pasted = [...(event.clipboardData?.files ?? [])];
    if (pasted.length === 0) return;
    event.preventDefault();
    onPasteFiles(pasted);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    // A command or skill is one word to the eye, so one Backspace takes all of it.
    const el = field.current;
    if (event.key === "Backspace" && el && el.selectionStart === el.selectionEnd && !event.nativeEvent.isComposing) {
      const token = tokenBefore(draft, el.selectionStart, entries);
      if (token) {
        event.preventDefault();
        onDraft(draft.slice(0, token.start) + draft.slice(token.end));
        place(token.start);
        return;
      }
    }
    if (choices > 0) {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        const step = event.key === "ArrowDown" ? 1 : -1;
        setActive((index) => (index + step + choices) % choices);
        return;
      }
      if (event.key === "Enter" || event.key === "Tab") {
        event.preventDefault();
        const at = Math.min(active, choices - 1);
        if (mention) pick(results[at]!);
        else pickSlash(slashResults[at]!);
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        setCursor(-1);
        return;
      }
    }
    // ⇧Tab steps through the access modes, the way it does in Claude's own terminal.
    if (event.key === "Tab" && event.shiftKey && onOptions) {
      const next = nextAccess(session.autonomy, accessesOf(session.provider));
      event.preventDefault();
      if (next) onOptions({ ...choiceOf(session), access: next });
      return;
    }
    // Stopping is its own act: Esc or the Stop button, never Enter. Esc closes the work sheet first.
    if (event.key === "Escape" && working && sheet !== "work" && !escBack) {
      event.preventDefault();
      onStop();
      return;
    }
    if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
    event.preventDefault();
    if (canSend) sendAs(event.metaKey || event.ctrlKey);
  };

  const sendLabel = !working ? "Send" : whileWorking === "steer" ? "Add to the running turn" : "Queue for the next turn";
  // The one round button: Stop while a turn runs and there is nothing to send, Send as soon as there is.
  const stopping = working && draft.trim().length === 0 && files.length === 0;
  const sendTitle = working && whileWorking === "steer" ? `${sendLabel} (↵) · ⌘↵ queues for the next turn` : sendLabel;

  return (
    <div className={`relative mx-auto w-full max-w-[840px] shrink-0 px-6 ${centered ? "py-3" : "pb-3"}`}>
      <form onSubmit={submit} className="crew-composer relative">
        {mention && (
          <MentionPicker results={results} active={Math.min(active, Math.max(0, results.length - 1))} onHover={setActive} onPick={pick} />
        )}
        {slashResults.length > 0 && (
          <SlashPicker results={slashResults} active={Math.min(active, slashResults.length - 1)} onHover={setActive} onPick={pickSlash} />
        )}
        {queue && queue.items.length > 0 && <QueueChips queue={queue} />}
        {files.length > 0 && (
          <div className="mb-2">
            <AttachmentStrip files={files} onRemove={onRemoveFile} />
          </div>
        )}
        <div className="relative">
          <div ref={overlay} aria-hidden className="crew-composer-field crew-composer-overlay">
            {splitTokens(draft, entries)
              .flatMap<{ kind: string; text: string }>((part) => (part.kind === "token" ? [part] : splitMentions(part.text, known)))
              .map((segment, index) =>
                segment.kind === "text" ? (
                  <span key={index}>{segment.text}</span>
                ) : (
                  <mark key={index} className="crew-mention-run">
                    {segment.text}
                  </mark>
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
                  ? whileWorking === "steer"
                    ? `${session.name} is working — ↵ adds this to the running turn`
                    : whileWorking === "queue"
                      ? `${session.name} is working — ↵ queues this for the next turn`
                      : escBack
                        ? `${session.name} is working`
                        : `${session.name} is working — esc stops it`
                  : `Ask ${session.name} anything — @ to mention a file, / for commands`
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
            {onOptions && (
              <ModelControls
                lockProvider={!switchProvider}
                value={choiceOf(session)}
                onChange={onOptions}
                openers={{ model, effort }}
              />
            )}
          </div>
          <div className="flex shrink-0 items-center gap-1.5">
            {onOptions && (
              <AccessPicker
                ref={access}
                provider={session.provider}
                value={session.autonomy as Access}
                onChange={(access) => onOptions({ ...choiceOf(session), access })}
                hint="⇧Tab in the message box cycles them."
              />
            )}
            {stopping ? (
              <button
                type="button"
                onClick={onStop}
                aria-label="Stop"
                title={escBack ? "Stop the turn" : "Stop the turn (esc)"}
                className="flex size-[30px] shrink-0 items-center justify-center rounded-full crew-ink transition-colors duration-100 hover:bg-accent-hover focus-visible:ring-[1.5px] focus-visible:ring-focus/50 focus-visible:outline-none"
              >
                <SquareIcon className="size-3 fill-current" />
              </button>
            ) : (
              <button
                type="submit"
                disabled={!canSend}
                aria-label={sendLabel}
                title={sendTitle}
                className={`flex size-[30px] shrink-0 items-center justify-center rounded-full transition-colors duration-100 focus-visible:ring-[1.5px] focus-visible:ring-focus/50 focus-visible:outline-none ${
                  canSend ? "crew-ink hover:bg-accent-hover" : "bg-card text-text-muted"
                }`}
              >
                <ArrowUpIcon className="size-4" />
              </button>
            )}
          </div>
        </div>
      </form>
      <div data-status-line data-session={session.id} className="mt-1.5 flex min-h-6 items-center gap-2 px-1 text-[11.5px]">
        <ContextMeter sessionId={session.id} provider={session.provider} />
        {/* A steer is already the turn's: only what waits is counted, and opens the sheet. */}
        {queue && queue.items.some((message) => !message.steering) && (
          <QueueSegment queue={queue} working={working} open={sheet === "queue"} onOpenChange={openQueue} />
        )}
        {session.paused && <PausedSegment />}
        {work && <WorkSegment work={work} open={sheet === "work"} onOpenChange={openWork} onEscape={focusField} />}
        <McpSegment session={session} open={sheet === "mcp"} onOpenChange={openMcp} />
        <span className="flex-1" />
        <span className="truncate text-placeholder">
          {optionsPending ? (
            <>The new settings apply with your next message, which restarts {session.name} where it left off</>
          ) : working ? (
            <>
              <kbd className="font-sans">esc</kbd> {escBack ? "back" : "stop"}
              {whileWorking === "steer" && (
                <>
                  {" "}· <kbd className="font-sans">↵</kbd> add to the turn · <kbd className="font-sans">⌘↵</kbd> next turn
                </>
              )}
              {whileWorking === "queue" && (
                <>
                  {" "}· <kbd className="font-sans">↵</kbd> queue
                </>
              )}
            </>
          ) : (
            <>
              {escBack && (
                <>
                  <kbd className="font-sans">esc</kbd> back ·{" "}
                </>
              )}
              <kbd className="font-sans">↵</kbd> send · <kbd className="font-sans">⇧↵</kbd> new line · @ file · / command
              {onOptions && (
                <>
                  {" "}· <kbd className="font-sans">⇧⇥</kbd> access
                </>
              )}
            </>
          )}
        </span>
      </div>
    </div>
  );
}

