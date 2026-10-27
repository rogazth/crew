import { UsageWarning } from "./UsageWarning";
import { useCallback, useImperativeHandle, useRef, useState, type Ref } from "react";
import { useCommands } from "../../hooks/useCommands";
import type { AttachedFile } from "../../lib/blocks";
import { composerHints } from "../../lib/composerHints";
import { effortsOf, fitChoice, type Access, type AgentChoice, type Effort, type ProviderId } from "../../lib/providers";
import type { TreeMention } from "../../lib/agentMentions";
import type { CommandEntry } from "../../lib/protocol";
import { refreshCommands } from "../../lib/slashCommands";
import type { Session } from "../../lib/types";
import { crewAction } from "../../lib/turnRuntime";
import type { Upload } from "../../hooks/useUploads";
import { McpSegment } from "./Mcp";
import { usePanePlace } from "./panePlace";
import { PausedSegment, WorkSegment, type PanelScope } from "./Panel";
import { QueueChips, QueueSegment, type QueueScope } from "./Queue";
import { useChatActions } from "./context";
import type { PromptHandle } from "./PromptEditor";
import { PromptWell } from "./PromptWell";
import {
  AgentClip,
  clipOf,
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
    apply: (edit) => field.current?.apply(edit),
    coordsAt: (at: number) => field.current?.coordsAt(at) ?? null,
  }));
  const { files: projectFiles, agents = NO_AGENTS, worktrees = NO_TREES, confirm, resolvePath } = useChatActions();
  // A file still travelling has no path to send yet.
  const uploading = uploads.some((upload) => upload.error === undefined);
  const canSend = ready && !uploading && (draft.trim().length > 0 || files.length > 0) && (!working || whileWorking !== undefined);
  const entries = useCommands(session.id)?.entries ?? NO_ENTRIES;
  // The daemon answers from its cache and reads again once that is stale: a menu opened late is current.
  const readCommands = useCallback(() => void refreshCommands(session.id), [session.id]);

  // One sheet over the composer at a time: the queue's, the background work's or the MCP servers'.
  const [sheet, setSheet] = useState<"queue" | "work" | "mcp" | null>(null);
  const openQueue = useCallback((open: boolean) => setSheet(open ? "queue" : null), []);
  const openWork = useCallback((open: boolean) => setSheet(open ? "work" : null), []);
  const openMcp = useCallback((open: boolean) => setSheet(open ? "mcp" : null), []);
  const focusField = useCallback(() => field.current?.focus(), []);

  const movable = usePanePlace(session.id) !== null;
  const runAction = (name: string) => {
    if (name === "restart" || name === "reload") void crewAction(session.id, name, confirm);
  };
  // ⌘↵ while it works: wait for the turn instead of joining it.
  const sendAs = (wait: boolean) => onSend(working ? (wait ? "queue" : whileWorking) : undefined);
  // Stopping is its own act: Esc or the Stop button, never Enter. Esc closes the work sheet first.
  const escape = () => {
    if (!working || sheet === "work" || escBack) return false;
    onStop();
    return true;
  };

  const sendLabel = !working ? "Send" : whileWorking === "steer" ? "Add to the running turn" : "Queue for the next turn";
  // The one round button: Stop while a turn runs and there is nothing to send, Send as soon as there is.
  const stopping = working && draft.trim().length === 0 && files.length === 0;
  const sendTitle = working && whileWorking === "steer" ? `${sendLabel} (↵) · ⌘↵ queues for the next turn` : sendLabel;
  const current = fitChoice(choiceOf(session));
  const stepsEffort = !!onOptions && effortsOf(current.provider, current.model).length > 1;
  const hasClip = clipOf(work) !== null;
  const hints = composerHints({ working, escBack, whileWorking, stepsEffort });

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
      <PromptWell
        ref={field}
        session={session.id}
        draft={draft}
        onDraft={onDraft}
        files={files}
        uploads={uploads}
        onRemoveFile={onRemoveFile}
        onDismissUpload={onDismissUpload}
        onAttach={onAttach}
        onPasteFiles={onPasteFiles}
        projectFiles={projectFiles}
        resolvePath={resolvePath}
        agents={agents}
        worktrees={worktrees}
        commands={entries}
        onSlash={readCommands}
        onAction={runAction}
        choice={onOptions ? choiceOf(session) : undefined}
        onChoice={onOptions}
        lockProvider={!switchProvider}
        movable={movable}
        placeholder={placeholder}
        label={`Message ${session.name}`}
        roomy={centered}
        canSend={canSend}
        onSend={sendAs}
        onEscape={escape}
        above={
          queued && (
            <div className="px-1.5">
              <QueueChips queue={queue} />
            </div>
          )
        }
        trailing={
          <>
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
          </>
        }
      />
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
