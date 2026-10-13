import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useBackgroundPanel } from "../hooks/useBackgroundPanel";
import { useCommands } from "../hooks/useCommands";
import { showLetter, useChatLetters, usePending } from "../hooks/useLetters";
import { useMarkSeen } from "../hooks/useMarkSeen";
import { useThread } from "../hooks/useThread";
import { onAgentRequest, peekAgentRequest, takeAgentRequest } from "../lib/agentRoute";
import { answer, pass, respond, send, stop } from "../lib/turnRuntime";
import { mailboxDispose, mailboxEdit, mailboxReorder, pickFiles, setSessionOptions, switchSessionProvider, turnSendNow, writeTempFile } from "../lib/api";
import { attachedFrom } from "../lib/attachments";
import { markedCalls, turnTray } from "../lib/background";
import { commandEntryId, conversationsOf, type PanelEntry } from "../lib/backgroundPanel";
import type { ThreadRef } from "../lib/letters";
import { queuedLetters } from "../lib/letters";
import { clearFirstPrompt, peekFirstPrompt } from "../lib/firstPrompt";
import { mentionedFiles } from "../lib/mentions";
import { dispatchOf } from "../lib/slashCommands";
import { moved, othersPending, userQueue, whileWorkingOf } from "../lib/queue";
import type { AgentChoice } from "../lib/providers";
import { BackgroundContext, WorkContext, ChatContext, LetterContext, useChatActions, type BackgroundScope, type LetterScope } from "./chat/context";
import { useFileDrop } from "../hooks/useFileDrop";
import type { Answers, ApprovalDecision, AttachedFile } from "../lib/blocks";
import type { Session } from "../lib/types";
import type { PanelScope } from "./chat/Panel";
import type { QueueScope } from "./chat/Queue";
import { DefaultChatSurface } from "./chat/DefaultChatSurface";
import { AgentView, type Crumb } from "./chat/AgentView";
import { Thread } from "./chat/Thread";

type Props = {
  session: Session;
  /** Every session, for its children, and for whoever its letters name. */
  sessions: readonly Session[];
  cwd: string;
  active: boolean;
  /**
   * Set when this chat is the body of an agent's thread: the sessions above it,
   * outermost first. The thread's header says whose it is, Esc goes back instead of stopping its turn, and what it opens in
   * place stacks on the thread.
   */
  trail?: readonly Crumb[];
  /** The thread has no composer: the agent exited. */
  readOnly?: boolean;
  /** A letter the thread opens scrolled to. */
  focusLetter?: string;
};

/** The pane a thread covers: the outermost chat's, so a thread opened from inside another covers it whole. */
const PaneContext = createContext<HTMLElement | null>(null);

export function TurnChat({ session, sessions, cwd, active, trail, readOnly = false, focusLetter }: Props) {
  const embedded = trail !== undefined;
  const { blocks: held, ready, working, more, loadingEarlier, loadEarlier, focusId } = useThread(session.id);
  const [draft, setDraft] = useState("");
  const [files, setFiles] = useState<AttachedFile[]>([]);
  const field = useRef<HTMLTextAreaElement>(null);
  const pane = useRef<HTMLDivElement | null>(null);
  const [paneEl, setPaneEl] = useState<HTMLElement | null>(null);
  const bindPane = useCallback((el: HTMLDivElement | null) => {
    pane.current = el;
    setPaneEl(el);
  }, []);
  const outerPane = useContext(PaneContext);
  const host = outerPane ?? paneEl;
  const actions = useChatActions();
  const { files: projectFiles, openSession, processes, openProcessRun } = actions;
  const letters = useChatLetters(session, sessions, held);
  // What waits in its box for the next turn: others' letters under the turn
  // that is running, the user's own above the composer.
  const pending = usePending(session.id, true);
  const blocks = useMemo(() => [...held, ...queuedLetters(othersPending(pending), held)], [held, pending]);
  const waiting = useMemo(() => userQueue(pending, held), [held, pending]);
  const whileWorking = whileWorkingOf(session.kind, session.provider);
  const panel = useBackgroundPanel(session, sessions, processes);
  const menu = useCommands(session.id);
  const commands = useMemo(() => turnTray(panel.board), [panel.board]);
  // One thing over the transcript at a time: a pair's thread, or an entry of the background panel.
  const [output, setOutput] = useState<{ sessionId: string; id: string; focus?: string } | null>(null);
  const shown = output?.sessionId === session.id ? panel.all.find((entry) => entry.id === output.id) : undefined;
  const { closeThread, openThread: openLetters } = letters;
  const openEntry = useCallback(
    (entry: PanelEntry, focus?: string) => {
      const { source } = entry;
      // A process has a tab of its own: the panel leaves the chat to it.
      if (source.type === "process") {
        const process = processes.find((row) => row.id === source.id);
        if (process) openProcessRun(process, source.worktree);
        return;
      }
      closeThread();
      setOutput({ sessionId: session.id, id: entry.id, ...(focus ? { focus } : {}) });
    },
    [closeThread, openProcessRun, processes, session.id],
  );
  // An agent opens in place, from wherever it is named: an entry of the work, or a session by its id.
  const allEntries = panel.all;
  const openAgent = useCallback(
    (target: string, options?: { focus?: string }) => {
      const entry = allEntries.find((one) => one.id === target || one.id === `session:${target}`);
      if (entry) openEntry(entry, options?.focus);
      else openSession(target);
    },
    [allEntries, openEntry, openSession],
  );
  // A subagent opened from outside (a notification, the sidebar, a restored tab) arrives as a request for this chat.
  const takeRequest = useCallback(() => {
    const request = peekAgentRequest(session.id);
    if (!request) return;
    // Its row may not have arrived yet: the request waits for the next list.
    const entry = allEntries.find((one) => one.id === `session:${request.childId}`);
    if (!entry) return;
    takeAgentRequest(session.id);
    openEntry(entry, request.focus);
  }, [allEntries, openEntry, session.id]);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- a request made before this chat showed
    takeRequest();
    return onAgentRequest(takeRequest);
  }, [takeRequest]);
  const chatActions = useMemo(() => ({ ...actions, openAgent }), [actions, openAgent]);
  const openOutput = useCallback(
    (commandId: string) => {
      closeThread();
      setOutput({ sessionId: session.id, id: commandEntryId(commandId) });
    },
    [closeThread, session.id],
  );
  const openThread = useCallback(
    (ref: ThreadRef) => {
      setOutput(null);
      openLetters(ref);
    },
    [openLetters],
  );
  const letterScope = useMemo<LetterScope>(() => ({ ...letters.scope, openThread }), [letters.scope, openThread]);
  const backgroundScope = useMemo<BackgroundScope>(() => ({ calls: markedCalls(commands), open: openOutput }), [commands, openOutput]);

  // Opening the tab means "talk to this session"; the caret should already be there.
  useEffect(() => {
    if (active) field.current?.focus();
  }, [active]);

  // Opened from a letter: the thread starts at the block carrying it.
  useEffect(() => {
    if (focusLetter && ready) showLetter(pane.current, focusLetter);
  }, [focusLetter, ready]);

  // What home's composer wrote before the session existed is its first turn.
  useEffect(() => {
    const prompt = peekFirstPrompt(session.id);
    if (!prompt) return;
    clearFirstPrompt(session.id);
    void send(session, cwd, prompt);
  }, [cwd, session]);

  const addPaths = useCallback((paths: string[]) => {
    if (paths.length === 0) return;
    setFiles((prev) => {
      const seen = new Set(prev.map((file) => file.path));
      const next: AttachedFile[] = [];
      for (const path of paths) {
        if (seen.has(path)) continue;
        seen.add(path);
        next.push(attachedFrom(path));
      }
      return [...prev, ...next];
    });
    field.current?.focus();
  }, []);

  const attach = useCallback(async () => addPaths(await pickFiles()), [addPaths]);

  // A pasted screenshot has no path; it gets one in the temp dir, like the terminal does.
  const pasteFiles = useCallback(
    (pasted: File[]) => {
      void Promise.all(pasted.map((file) => writeTempFile(file).catch(() => null))).then((paths) =>
        addPaths(paths.filter((path): path is string => path !== null)),
      );
    },
    [addPaths],
  );

  const over = useFileDrop(pane, addPaths);

  // Nobody has talked to a session of the user's yet: it can still be another provider's CLI.
  const fresh = session.kind === "terminal" && ready && held.length === 0 && pending.length === 0 && !working;
  // Each turn starts its CLI from the row: the next one runs what the chips say.
  const changeOptions = useCallback(
    (next: AgentChoice) => {
      const options = {
        model: next.model,
        effort: next.effort,
        serviceTier: next.serviceTier ?? "",
        autonomy: next.access,
      };
      if (next.provider === session.provider) void setSessionOptions(session.id, options).catch(() => {});
      else if (fresh) void switchSessionProvider(session.id, { provider: next.provider, ...options }).catch(() => {});
    },
    [fresh, session.id, session.provider],
  );

  const submit = useCallback(
    (mode?: "steer" | "queue") => {
      const text = draft.trim();
      if ((!text && files.length === 0) || !ready) return;
      // A message while it works goes into the turn or after it; a bot takes none.
      if (working && !(mode && whileWorking)) return;
      const attached = files;
      const mentions = mentionedFiles(text, projectFiles).map((file) => file.path);
      const { command, skills } = dispatchOf(text, menu?.entries ?? []);
      const asked = { mentions, ...(command ? { command } : {}), skills };
      setDraft("");
      setFiles([]);
      // What is held after a stop goes with the next message: the daemon queues it behind them.
      if ((working || waiting.length > 0) && whileWorking) void pass(session, cwd, text, attached, mode ?? "queue", asked);
      else void send(session, cwd, text, attached, asked);
    },
    [cwd, draft, files, menu, projectFiles, ready, session, waiting.length, whileWorking, working],
  );

  const conversations = useMemo(() => conversationsOf(letters.pairs, letters.owner), [letters.pairs, letters.owner]);
  const work = useMemo<PanelScope>(
    () => ({
      entries: panel.entries,
      failed: panel.failed,
      onOpen: openEntry,
      onStop: panel.stop,
      onClear: panel.clear,
      conversations,
      sessions,
      onOpenConversation: openThread,
    }),
    [conversations, openEntry, openThread, panel.clear, panel.entries, panel.failed, panel.stop, sessions],
  );

  const queue = useMemo<QueueScope>(
    () => ({
      items: waiting,
      onEdit: (letterId, text) => void mailboxEdit({ sessionId: session.id, letterId, text }).catch(() => {}),
      onDispose: (letterId) => void mailboxDispose({ sessionId: session.id, letterId }).catch(() => {}),
      onMove: (letterId, step) =>
        void mailboxReorder({ sessionId: session.id, letterIds: moved(waiting, letterId, step) }).catch(() => {}),
      onSendNow: (letterId) => void turnSendNow({ sessionId: session.id, letterId }).catch(() => {}),
    }),
    [session.id, waiting],
  );

  const approve = useCallback(
    (requestId: number, decision: ApprovalDecision) => respond(session, requestId, decision),
    [session],
  );
  const reply = useCallback(
    (requestId: number, answers: Answers | null) => answer(session, requestId, answers),
    [session],
  );

  const thread =
    letters.thread &&
    host &&
    createPortal(
      <Thread
        key={`${letters.thread.a.id}|${letters.thread.b.id}|${letters.thread.focus ?? ""}`}
        thread={letters.thread}
        owner={letters.owner}
        sessionId={session.id}
        sessions={sessions}
        active={active}
        inChat={letters.inChat}
        onClose={letters.closeThread}
        onShowInChat={(letterId) => {
          letters.closeThread();
          showLetter(pane.current, letterId);
        }}
      />,
      host,
    );
  const live = panel.board?.live ?? false;

  // What the opened entry is made of: a board command, a Crew subagent's session.
  const openedCommand = shown?.source.type === "command" ? commands.find((command) => command.id === shown.source.id) : undefined;
  const openedChild = shown?.source.type === "session" ? sessions.find((row) => row.id === shown.source.id) : undefined;
  useMarkSeen(sessions, openedChild?.id ?? null);
  // A Claude subagent's steps live in the call that started it.
  const openedCall = openedCommand?.toolCallId ? (held.find((block) => block.tool?.callId === openedCommand.toolCallId) ?? null) : null;
  const path = useMemo<readonly Crumb[]>(
    () => [
      ...(trail ?? []),
      { id: session.id, name: session.name, provider: session.provider, bot: session.kind === "bot", back: () => setOutput(null) },
    ],
    [trail, session.id, session.name, session.provider, session.kind],
  );
  const threadOpen = Boolean(shown) || Boolean(letters.thread);
  const agentView =
    shown &&
    !letters.thread &&
    host &&
    createPortal(
      <AgentView
        key={shown.id}
        entry={shown}
        crumbs={path}
        {...(openedChild ? { startedBy: openedChild.launchedByName ?? openedChild.parentName ?? "a session", worktree: openedChild.worktree } : {})}
        block={openedCall}
        {...(openedCommand ? { command: openedCommand } : {})}
        sessionId={session.id}
        live={live}
        error={panel.failed[shown.id]}
        active={active}
        onStop={() => panel.stop(shown)}
        onClose={() => setOutput(null)}
        {...(openedChild
          ? {
              chat: (
                <TurnChat
                  session={openedChild}
                  sessions={sessions}
                  cwd={cwd}
                  active={active}
                  trail={path}
                  readOnly={!shown.writable}
                  {...(output?.focus ? { focusLetter: output.focus } : {})}
                />
              ),
            }
          : {})}
      />,
      host,
    );

  return (
    <div
      ref={bindPane}
      className={`relative flex flex-col bg-canvas ${embedded ? "min-h-0 flex-1" : "h-full"}`}
    >
      <PaneContext value={host}>
        <ChatContext value={chatActions}>
        <LetterContext value={letterScope}>
          <BackgroundContext value={backgroundScope}>
            <WorkContext value={panel.all}>
            {/* Under a thread the chat stays mounted, hidden and inert: its scroll, draft and open sheet come back as they were. */}
            <div inert={threadOpen} className={`flex min-h-0 flex-1 flex-col ${threadOpen ? "invisible" : ""}`}>
            <DefaultChatSurface
              session={session}
              blocks={blocks}
              working={working}
              ready={ready}
              active={active}
              more={more}
              loadingEarlier={loadingEarlier}
              onLoadEarlier={loadEarlier}
              focusId={focusId}
              draft={draft}
              files={files}
              over={over}
              field={field}
              onDraft={setDraft}
              onSend={submit}
              onStop={() => void stop(session)}
              work={work}
              {...(whileWorking ? { whileWorking, queue } : {})}
              onAttach={() => void attach()}
              onPasteFiles={pasteFiles}
              onRemoveFile={(path) => setFiles((prev) => prev.filter((file) => file.path !== path))}
              onApprove={approve}
              onAnswer={reply}
              onOptions={changeOptions}
              switchProvider={fresh}
              {...(embedded ? { inThread: true } : {})}
              readOnly={readOnly}
            />
            </div>
            {agentView}
            {thread}
            </WorkContext>
          </BackgroundContext>
        </LetterContext>
        </ChatContext>
      </PaneContext>
    </div>
  );
}
