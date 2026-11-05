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
import { usePanePlace } from "./panePlace";
import { ConnectorsSegment } from "./Connectors";
import { WorkSegment, type PanelScope } from "./Panel";
import { useChatActions } from "./context";
import type { PromptHandle } from "./PromptEditor";
import { PromptWell } from "./PromptWell";
import { AgentsClip, type AgentsLine, ContextRing, QuotaSegment, SendButton, SessionRemoteSegment, useQuota, WorktreeSegment } from "./ComposerParts";
import { useWhere } from "./where";

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
  /** What the session left running in the background: an agent, a shell, a process. Absent: no segment. */
  work?: PanelScope;
  /** The chips changed; absent, the composer has none. */
  onOptions?: (next: AgentChoice) => void;
  /** Other providers are offered, not only the session's own. */
  switchProvider?: boolean;
  /** In a thread: Esc goes back one level and never stops the turn; the Stop button does. */
  escBack?: boolean;
  /** The chat's agents: the clip on the prompt's top edge, and the way to all of them. */
  agentsLine?: AgentsLine;
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
  work,
  onOptions,
  switchProvider = false,
  escBack = false,
  agentsLine,
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

  // One sheet over the composer at a time: the background work's or the connectors'.
  const [sheet, setSheet] = useState<"work" | "connectors" | null>(null);
  const openWork = useCallback((open: boolean) => setSheet(open ? "work" : null), []);
  const openConnectors = useCallback((open: boolean) => setSheet(open ? "connectors" : null), []);
  const focusField = useCallback(() => field.current?.focus(), []);

  const movable = usePanePlace(session.id) !== null;
  const runAction = (name: string) => {
    if (name === "restart" || name === "reload") void crewAction(session.id, name, confirm);
  };
  // Stopping is its own act: only the Stop button, never a key. How a message goes while a turn runs is the
  // provider's to decide and nobody's to read: sending is sending. ⌘↵ waits for the turn, for whoever knows it.
  const sendAs = (wait: boolean) => onSend(working ? (wait ? "queue" : whileWorking) : undefined);
  // The one round button: Stop while a turn runs and there is nothing to send, Send as soon as there is.
  const stopping = working && draft.trim().length === 0 && files.length === 0;
  const current = fitChoice(choiceOf(session));
  const stepsEffort = !!onOptions && effortsOf(current.provider, current.model).length > 1;
  const hints = composerHints({ working, escBack, stepsEffort });
  // The keys are the first to go: with every indicator on, the line has no room for them.
  const quota = useQuota(session.provider);
  const remote = useWhere(session).remote;
  const crowded = [(work?.entries.length ?? 0) > 0, !!quota, remote].filter(Boolean).length >= 2;
  // A long name leaves the placeholder rather than crowd it.
  const shortName = session.name.length > 24 ? "" : ` ${session.name}`;

  const placeholder = waiting
    ? `Answer ${session.name} above, or write here`
    : working && !whileWorking
      ? `${session.name} is working…`
      : centered
        ? "Ask anything…"
        : `Message${shortName}…`;
  return (
    <div className={`ds-composer-wrap @container relative mx-auto w-full max-w-chat shrink-0 px-6 ${centered ? "py-1" : "pb-2"}`}>
      {/* It tucks behind the well's top edge. */}
      {agentsLine && !centered && <AgentsClip line={agentsLine} />}
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
        choice={onOptions && !escBack ? choiceOf(session) : undefined}
        onChoice={escBack ? undefined : onOptions}
        lockedChoice={escBack ? choiceOf(session) : undefined}
        lockProvider={!switchProvider}
        movable={movable}
        placeholder={placeholder}
        label={`Message ${session.name}`}
        roomy={centered}
        canSend={canSend}
        onSend={sendAs}
        trailing={
          <>
            {/* A bot starts every message blank, so its context never fills. */}
            {!session.botId && <ContextRing sessionId={session.id} provider={session.provider} />}
            <SendButton
              stopping={stopping}
              canSend={canSend}
              label="Send"
              title="Send"
              stopTitle="Stop the turn"
              onStop={onStop}
            />
          </>
        }
      />
      <div data-status-line data-session={session.id} className="ds-status">
        <SessionRemoteSegment session={session} hidePlace={centered} />
        {!centered && <WorktreeSegment session={session} />}
        {/* Shells and processes the chat left running: this opens their sheet. */}
        {work && <WorkSegment work={work} open={sheet === "work"} onOpenChange={openWork} onEscape={focusField} />}
        <ConnectorsSegment session={session} open={sheet === "connectors"} onOpenChange={openConnectors} onEscape={focusField} />
        <span className="flex-1" />
        <QuotaSegment provider={session.provider} />
        {!centered && !crowded && (
          <span className="ds-hints" data-key-hints data-shown>
            {hints.map(({ key, does }) => (
              <span key={key}>
                <kbd>{key}</kbd>
                {does}
              </span>
            ))}
          </span>
        )}
      </div>
    </div>
  );
}
