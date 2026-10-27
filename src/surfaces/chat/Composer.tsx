import { UsageWarning } from "./UsageWarning";
import {
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type Ref,
} from "react";
import { AccessPicker, ModelControls } from "../../chrome/ComposerControls";
import type { Opener } from "../../chrome/ModelPicker";
import { useCommands } from "../../hooks/useCommands";
import type { AttachedFile } from "../../lib/blocks";
import { composerHints } from "../../lib/composerHints";
import { effortsOf, fitChoice, selectedEffort, toggledFast, type Access, type AgentChoice, type Effort, type ProviderId } from "../../lib/providers";
import { nextEffort } from "../../lib/sessionOptions";
import { completeAgentMention, searchAgents, searchTrees, type TreeMention } from "../../lib/agentMentions";
import {
  completeMention,
  mentionAt,
  rememberMention,
} from "../../lib/mentions";
import type { CommandEntry } from "../../lib/protocol";
import {
  completeSlash,
  opensMessage,
  refreshCommands,
  removeSlash,
  searchCommands,
  slashAt,
} from "../../lib/slashCommands";
import type { ProjectFile, Session } from "../../lib/types";
import { crewAction } from "../../lib/turnRuntime";
import type { Upload } from "../../hooks/useUploads";
import { AttachmentStrip } from "./Attachments";
import { McpSegment } from "./Mcp";
import { hasWorktreePicker, openWorktreePicker, usePanePlace } from "./panePlace";
import { activatePrompt, promptLetter, registerPrompt, type Prompt, type PromptPickers } from "../../chrome/promptKeys";
import { PausedSegment, WorkSegment, type PanelScope } from "./Panel";
import { QueueChips, QueueSegment, type QueueScope } from "./Queue";
import { useChatActions } from "./context";
import { AgentPicker, MentionPicker } from "./MentionPicker";
import { useAgentIcons } from "../../hooks/useAgentIcons";
import { useMentionMenu } from "./useMentionMenu";
import { usePickerAnchor } from "./usePickerAnchor";
import { SlashPicker } from "./SlashPicker";
import { continueList, indentList, onIndentedListLine, onListLine, removeListMarker, type TextEdit } from "../../lib/composerFormat";
import { PromptEditor, type PromptHandle } from "./PromptEditor";
import {
  AgentClip,
  clipOf,
  AttachMenu,
  ContextRing,
  SendButton,
  SessionRemoteSegment,
  WorktreeSegment,
} from "./ComposerParts";

type Props = {
  ref?: Ref<PromptHandle>;
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
  uploads: Upload[];
  onDismissUpload: (id: number) => void;
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

/** The menu before the daemon has answered: nothing to list or to paint. */
const NO_ENTRIES: CommandEntry[] = [];
const NO_AGENTS: readonly Session[] = [];
const NO_TREES: readonly TreeMention[] = [];

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
  uploads,
  onDismissUpload,
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
  const field = useRef<PromptHandle>(null);
  useImperativeHandle(ref, () => ({
    focus: () => field.current?.focus(),
    read: () => field.current?.read() ?? { value: draft, from: draft.length, to: draft.length },
    select: (at: number) => field.current?.select(at),
    apply: (edit: TextEdit) => field.current?.apply(edit),
    coordsAt: (at: number) => field.current?.coordsAt(at) ?? null,
  }));
  const { files: projectFiles, agents = NO_AGENTS, worktrees = NO_TREES, confirm, resolvePath } = useChatActions();
  // A file still travelling has no path to send yet.
  const uploading = uploads.some((upload) => upload.error === undefined);
  const canSend = ready && !uploading && (draft.trim().length > 0 || files.length > 0) && (!working || whileWorking !== undefined);

  // The caret is what decides whether an `@` is being typed; it moves without the text changing.
  const [cursor, setCursor] = useState(0);
  const [active, setActive] = useState(0);
  const { mention, indexed, results } = useMentionMenu(draft, cursor, projectFiles, resolvePath);
  const [picked, setPicked] = useState<readonly string[]>([]);
  const known = useMemo(() => new Set([...indexed.map((file) => file.relative), ...picked]), [indexed, picked]);

  // An `@` names a bot or a session of the workspace, or a worktree of its repo; its chip wears the menu's icon.
  const agentIcons = useAgentIcons(agents);
  const chipAgents = useMemo(
    () => [
      ...agents.map((agent) => ({ name: agent.name, icon: agentIcons.get(agent.id) })),
      ...worktrees.map((tree) => ({ name: tree.name, kind: "worktree" })),
    ],
    [agents, agentIcons, worktrees],
  );
  const agentResults = useMemo(
    () => (mention ? searchAgents(mention.query, agents) : []),
    [mention?.query, agents], // eslint-disable-line react-hooks/exhaustive-deps
  );
  const treeResults = useMemo(
    () => (mention ? searchTrees(mention.query, worktrees) : []),
    [mention?.query, worktrees], // eslint-disable-line react-hooks/exhaustive-deps
  );
  // Once something is typed, the files it matches follow the agents and worktrees; the menu's last row turns the
  // `@` into a file search of its own. A path being typed is one already; with no agents or worktrees, it is only files.
  const [filesAt, setFilesAt] = useState<number | null>(null);
  const searchingFiles =
    mention !== null && (filesAt === mention.start || mention.query.includes("/") || agents.length + worktrees.length === 0);
  const agentMention = mention && !searchingFiles ? mention : null;
  const fileMention = searchingFiles ? mention : null;
  const fileHits = agentMention && agentMention.query ? results.slice(0, 3) : [];

  // The same for a `/`: a provider's commands only open a message, so the menu depends on where the slash is.
  const entries = useCommands(session.id)?.entries ?? NO_ENTRIES;
  const slash = mention ? null : slashAt(draft, cursor);
  const slashStarts = slash ? opensMessage(draft, slash.start) : false;
  const slashResults = useMemo(
    () => (slash ? searchCommands(entries, slash.query, slashStarts) : []),
    [slash?.query, slashStarts, entries], // eslint-disable-line react-hooks/exhaustive-deps
  );
  // The agents' menu has one more row than its matches: Files.
  const choices = fileMention
    ? results.length
    : agentMention
      ? agentResults.length + treeResults.length + fileHits.length + 1
      : slashResults.length;
  // The open picker hangs from the character that opened it, and stays there as the query is typed.
  const well = useRef<HTMLFormElement>(null);
  const trigger = mention?.start ?? (slashResults.length > 0 ? slash?.start : undefined) ?? null;
  const pickerLeft = usePickerAnchor(field, well, trigger);
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
  const movable = usePanePlace(session.id) !== null;
  const movableNow = useRef(movable);
  useEffect(() => {
    movableNow.current = movable;
  });
  // What the picker keys open, from this composer and from a picker it opened.
  const pickers = useMemo<PromptPickers>(
    () => ({
      has: (letter) => letter === "P" || (movableNow.current && hasWorktreePicker()),
      open: (letter) => (letter === "P" ? model.current?.open() : openWorktreePicker()),
    }),
    [],
  );
  const stepEffort = () => {
    if (!onOptions) return false;
    const fitted = fitChoice(choiceOf(session));
    const next = nextEffort(selectedEffort(fitted.provider, fitted.model, fitted.effort), effortsOf(fitted.provider, fitted.model));
    if (next) onOptions(fitChoice({ ...fitted, effort: next }));
    return true;
  };
  const stepNow = useRef(stepEffort);
  useEffect(() => {
    stepNow.current = stepEffort;
  });
  const prompt = useMemo<Prompt>(
    () => ({ pickers, element: () => well.current, field: () => field.current, stepEffort: () => stepNow.current() }),
    [pickers],
  );
  useEffect(() => registerPrompt(prompt), [prompt]);
  const effort = useRef<Opener>(null);
  const access = useRef<Opener>(null);

  // The draft has just changed: the caret goes where the change left it once the field has the new text.
  const place = (at: number, then?: () => void) => {
    requestAnimationFrame(() => {
      field.current?.select(at);
      setCursor(at);
      then?.();
    });
  };

  // ↵ and a click finish the mention and close the menu; ⇥ on a folder goes into it instead.
  const pick = (file: ProjectFile, into = false) => {
    const el = field.current;
    if (!el) return;
    const next = completeMention(draft, el.read().from, file, { into });
    if (!next) return;
    rememberMention(file.path);
    setPicked((list) => (list.includes(file.relative) ? list : [...list, file.relative]));
    onDraft(next.text);
    setActive(0);
    place(next.cursor);
  };

  const searchFiles = () => {
    if (!mention) return;
    setFilesAt(mention.start);
    setActive(0);
  };

  const pickAgent = (agent: Session | TreeMention) => {
    const el = field.current;
    if (!el) return;
    const next = completeAgentMention(draft, el.read().from, agent);
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
    const at = el.read().from;
    const next = acts ? removeSlash(draft, at) : completeSlash(draft, at, entry);
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

  const onKeyDown = (event: KeyboardEvent) => {
    const el = field.current;
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
        if (fileMention) pick(results[at]!, event.key === "Tab");
        else if (agentMention) {
          const target = agentResults[at] ?? treeResults[at - agentResults.length];
          const file = fileHits[at - agentResults.length - treeResults.length];
          if (target) pickAgent(target);
          else if (file) pick(file, event.key === "Tab");
          else searchFiles();
        }
        else pickSlash(slashResults[at]!);
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        // Out of the files it went into, back to the agents; from there, the menu closes.
        if (fileMention && filesAt === fileMention.start) {
          setFilesAt(null);
          setActive(0);
        } else setCursor(-1);
        return;
      }
    }
    // Lists carry on and indent as you type; the text stays plain markdown. Enter still sends, even on a
    // list item: the key that writes a new line here is ⇧↵, so that is the one that continues the list
    // (and ends it on an empty item). Making ↵ continue instead would change what ↵ means mid-message.
    if (el && !event.isComposing && !event.altKey && !event.metaKey && !event.ctrlKey) {
      const { value, from: selectionStart, to: selectionEnd } = el.read();
      if (event.key === "Backspace" && !event.shiftKey) {
        const edit = removeListMarker(value, selectionStart, selectionEnd);
        if (edit) {
          event.preventDefault();
          el.apply(edit);
          return;
        }
      }
      if (event.key === "Enter" && event.shiftKey) {
        const edit = continueList(value, selectionStart, selectionEnd);
        if (edit) {
          event.preventDefault();
          el.apply(edit);
          return;
        }
      }
      // Tab indents a list item; ⇧Tab outdents one that is indented, and otherwise steps the modes below.
      if (event.key === "Tab" && (event.shiftKey ? onIndentedListLine(value, selectionStart) : onListLine(value, selectionStart))) {
        const edit = indentList(value, selectionStart, selectionEnd, event.shiftKey ? -1 : 1);
        if (edit) {
          event.preventDefault();
          el.apply(edit);
          return;
        }
      }
    }
    // ⌥P opens the model picker, as in Claude Code; ⌥W the worktree, while the session can still move.
    const letter = promptLetter(event);
    if (letter && pickers.has(letter)) {
      event.preventDefault();
      pickers.open(letter);
      return;
    }
    // ⇧Tab steps the effort levels; access stays a deliberate pick.
    if (event.key === "Tab" && event.shiftKey && stepEffort()) {
      event.preventDefault();
      return;
    }
    // Stopping is its own act: Esc or the Stop button, never Enter. Esc closes the work sheet first.
    if (event.key === "Escape" && working && sheet !== "work" && !escBack) {
      event.preventDefault();
      onStop();
      return;
    }
    if (event.key !== "Enter" || event.shiftKey || event.isComposing) return;
    event.preventDefault();
    if (canSend) sendAs(event.metaKey || event.ctrlKey);
  };

  const sendLabel = !working ? "Send" : whileWorking === "steer" ? "Add to the running turn" : "Queue for the next turn";
  // The one round button: Stop while a turn runs and there is nothing to send, Send as soon as there is.
  const stopping = working && draft.trim().length === 0 && files.length === 0;
  const sendTitle = working && whileWorking === "steer" ? `${sendLabel} (↵) · ⌘↵ queues for the next turn` : sendLabel;
  const current = fitChoice(choiceOf(session));
  const stepsEffort = !!onOptions && effortsOf(current.provider, current.model).length > 1;
  const hasClip = clipOf(work) !== null;
  const hints = composerHints({ working, escBack, whileWorking, stepsEffort });

  // What the plus menu types for you: an `@` or a `/` at the caret, so the pickers open as if typed.
  const typeAtCaret = (mark: string) => {
    const el = field.current;
    const at = mark === "/" && draft.trim() === "" ? 0 : (el?.read().from ?? draft.length);
    const before = mark === "/" && at === 0 ? "" : draft.slice(0, at);
    const gap = before.length > 0 && !/\s$/.test(before) ? " " : "";
    const text = `${before}${gap}${mark}${draft.slice(at)}`;
    onDraft(text);
    // The menu hands the focus back to its trigger as it closes: the caret goes in after that.
    window.setTimeout(() => place(before.length + gap.length + 1), 40);
  };
  const queued = queue && queue.items.some((message) => !message.steering);
  const placeholder = waiting
    ? `Answer ${session.name} above, or write here`
    : working
      ? whileWorking === "steer"
        ? "Add to the running turn…"
        : whileWorking === "queue"
          ? "Queue a message for the next turn…"
          : `${session.name} is working…`
      : centered
        ? "Ask anything…"
        : `Message ${session.name}…`;
  return (
    <div className={`ds-composer-wrap relative mx-auto w-full max-w-chat shrink-0 px-6 ${centered ? "py-1" : "pb-2"}`}>
      <AgentClip work={work} open={sheet === "work"} onToggle={() => openWork(sheet !== "work")}>
        {work && hasClip && (
          <WorkSegment
            work={work}
            open={sheet === "work"}
            onOpenChange={openWork}
            onEscape={focusField}
          />
        )}
      </AgentClip>
      <UsageWarning provider={session.provider} />
      <form ref={well} onSubmit={submit} onFocusCapture={() => activatePrompt(prompt)} data-composer data-session={session.id} className="ds-composer" {...(centered ? { "data-roomy": "" } : {})}>
        {fileMention && (
          <MentionPicker
            results={results}
            active={Math.min(active, Math.max(0, results.length - 1))}
            onHover={setActive}
            onPick={pick}
            left={pickerLeft}
          />
        )}
        {agentMention && (
          <AgentPicker
            results={agentResults}
            trees={treeResults}
            files={fileHits}
            active={Math.min(active, agentResults.length + treeResults.length + fileHits.length)}
            onHover={setActive}
            onPick={pickAgent}
            onPickFile={pick}
            onFiles={searchFiles}
            left={pickerLeft}
          />
        )}
        {slashResults.length > 0 && (
          <SlashPicker
            results={slashResults}
            active={Math.min(active, slashResults.length - 1)}
            onHover={setActive}
            onPick={pickSlash}
            left={pickerLeft}
          />
        )}
        {queued && (
          <div className="px-1.5">
            <QueueChips queue={queue} />
          </div>
        )}
        {(files.length > 0 || uploads.length > 0) && (
          <div className="px-1.5">
            <AttachmentStrip files={files} onRemove={onRemoveFile} uploads={uploads} onDismissUpload={onDismissUpload} />
          </div>
        )}
        <div className="ds-composer-text">
          <PromptEditor
            ref={field}
            roomy={centered}
            value={draft}
            placeholder={placeholder}
            label={`Message ${session.name}`}
            known={known}
            agents={chipAgents}
            entries={entries}
            onChange={(value, caret) => {
              onDraft(value);
              setCursor(caret);
              setActive(0);
              // The file search lasts as long as the `@` it was opened for.
              if (filesAt !== null && mentionAt(value, caret)?.start !== filesAt) setFilesAt(null);
            }}
            onCaret={setCursor}
            onKeyDown={onKeyDown}
            onPasteFiles={onPasteFiles}
          />
        </div>
        <div className="flex h-8 items-center justify-between gap-2">
          <div className="flex min-w-0 items-center gap-1.5">
            <AttachMenu onAttach={onAttach} onMention={() => typeAtCaret("@")} onCommand={() => typeAtCaret("/")} />
            {onOptions && (
              <div className="ds-model-group">
                <ModelControls
                  lockProvider={!switchProvider}
                  value={choiceOf(session)}
                  onChange={onOptions}
                  openers={{ model, effort }}
                />
              </div>
            )}
          </div>
          <div className="flex shrink-0 items-center gap-1">
            {onOptions && (
              <div className="ds-access">
                <AccessPicker
                  ref={access}
                  provider={session.provider}
                  value={session.autonomy as Access}
                  onChange={(next) => onOptions({ ...choiceOf(session), access: next })}
                />
              </div>
            )}
            {/* A bot starts every message blank, so its context never fills. */}
            {!session.botId && <ContextRing sessionId={session.id} provider={session.provider} />}
            <SendButton
              stopping={stopping}
              canSend={canSend}
              label={sendLabel}
              title={sendTitle}
              stopTitle={escBack ? "Stop the turn" : "Stop the turn (esc)"}
              onStop={onStop}
            />
          </div>
        </div>
      </form>
      <div data-status-line data-session={session.id} className="ds-status">
        <SessionRemoteSegment session={session} hidePlace={centered} />
        {!centered && <WorktreeSegment session={session} />}
        {queued && <QueueSegment queue={queue} working={working} open={sheet === "queue"} onOpenChange={openQueue} />}
        {session.paused && <PausedSegment />}
        {/* Shells, processes and conversations with no agent to put a clip up still have their sheet: this opens it. */}
        {work && !hasClip && <WorkSegment segment work={work} open={sheet === "work"} onOpenChange={openWork} onEscape={focusField} />}
        <McpSegment session={session} open={sheet === "mcp"} onOpenChange={openMcp} />
        <span className="flex-1" />
        {optionsPending ? (
          <span className="truncate text-info">
            The new settings apply with your next message, which restarts {session.name} where it left off
          </span>
        ) : (
          !centered && (
            // While a turn runs the keys do something other than they seem to; idle, only ⇧Tab's effort stepping is named.
            <span className="ds-hints" data-key-hints data-shown>
              {hints.map(({ key, does }) => (
                <span key={key}>
                  <kbd>{key}</kbd>
                  {does}
                </span>
              ))}
            </span>
          )
        )}
      </div>
    </div>
  );
}
