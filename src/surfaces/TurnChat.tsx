import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { callsOfEntry } from "../lib/subagent";
import { useBackgroundPanel } from "../hooks/useBackgroundPanel";
import { useCommands as useShortcuts } from "../hooks/useCommand";
import { useCommands } from "../hooks/useCommands";
import { useDefaultAgent } from "../hooks/useDefaultAgent";
import { showLetter, useAgentLetters, useChatLetters, usePending } from "../hooks/useLetters";
import { useMarkSeen } from "../hooks/useMarkSeen";
import { useThread } from "../hooks/useThread";
import { useUploads } from "../hooks/useUploads";
import { onAgentRequest, peekAgentRequest, takeAgentRequest } from "../lib/agentRoute";
import { answer, pass, respond, send, stop } from "../lib/turnRuntime";
import { mailboxDispose, pickFiles, setSessionOptions, switchSessionProvider, updateSession, writeTempFile } from "../lib/api";
import { attachedFrom } from "../lib/attachments";
import { focusEnv } from "../lib/client/registry";
import { LOCAL } from "../lib/client/route";
import { extensionFor, pathSource, upload } from "../lib/upload";
import { markedCalls, turnTray } from "../lib/background";
import { commandEntryId, conversationsOf, isAgentEntry, type PanelEntry } from "../lib/backgroundPanel";
import type { ThreadRef } from "../lib/letters";
import { queuedLetters, sessionParty, withLetters } from "../lib/letters";
import { clearFirstPrompt, forgetUnsent, noteUnsent, peekFirstFiles, peekFirstPrompt, takeCarried } from "../lib/firstPrompt";
import { agentNote, mentionedAgents, mentionedTrees, treeMentions } from "../lib/agentMentions";
import { mentionedFiles, mentionTokens, wasPicked } from "../lib/mentions";
import { dispatchOf } from "../lib/slashCommands";
import { transcriptPending, userQueue, whileWorkingOf } from "../lib/queue";
import type { AgentChoice } from "../lib/providers";
import { BackgroundContext, WorkContext, ChatContext, LetterContext, useChatActions, type BackgroundScope, type LetterScope } from "./chat/context";
import { useFileDrop } from "../hooks/useFileDrop";
import type { Answers, ApprovalDecision, AttachedFile } from "../lib/blocks";
import type { Session } from "../lib/types";
import type { PanelScope } from "./chat/Panel";
import type { QueueScope } from "./chat/Queue";
import { AgentList } from "./chat/AgentList";
import type { AgentNoticeItem, AgentsLine } from "./chat/ComposerParts";
import { DefaultChatSurface } from "./chat/DefaultChatSurface";
import { SidePanel } from "./chat/SidePanel";
import { AgentView, type Crumb } from "./chat/AgentView";
import { Thread } from "./chat/Thread";
import { useRepoTrees } from "./chat/where";
import type { PromptHandle } from "./chat/PromptEditor";

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
  // A fresh session moved to another worktree arrives with what was written in the one it replaces.
  const [carried] = useState(() => takeCarried(session.id));
  const [draft, setDraft] = useState(carried?.draft ?? "");
  const [files, setFiles] = useState<AttachedFile[]>(carried?.files ?? []);
  useEffect(() => {
    noteUnsent(session.id, { draft, files });
  }, [session.id, draft, files]);
  useEffect(() => () => forgetUnsent(session.id), [session.id]);
  const field = useRef<PromptHandle>(null);
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
  // What waits in its box, all of it under the turn that is running: others' letters, the user's steers and their messages for the next turn.
  const pending = usePending(session.id, true);
  // An agent's thread also has what was said to it that its transcript has no place for.
  const told = useAgentLetters(embedded ? session.id : null, trail?.at(-1)?.id);
  const blocks = useMemo(
    () => [...(embedded ? withLetters(held, told, session.id) : held), ...queuedLetters(transcriptPending(pending), held)],
    [embedded, held, pending, session.id, told],
  );
  // A session with history draws nothing until it is read: drawn early, its empty chat (the intro, the
  // composer centred) would show for a beat and then jump away as the transcript lands.
  const settling = !ready && held.length === 0 && (!!session.providerSessionId || (session.cursor ?? 0) > 0);
  const waiting = useMemo(() => userQueue(pending, held), [held, pending]);
  const whileWorking = whileWorkingOf(session.provider);
  const panel = useBackgroundPanel(session, sessions, processes);
  const menu = useCommands(session.id);
  const commands = useMemo(() => turnTray(panel.board), [panel.board]);
  // One thing over the transcript at a time: a pair's thread, or an entry of the background panel.
  const [output, setOutput] = useState<{ sessionId: string; id: string; focus?: string } | null>(null);
  // Everyone this chat has worked with, in the right panel, under whichever agent is open there.
  const [listOpen, setListOpen] = useState(false);
  const [panelEl, setPanelEl] = useState<HTMLElement | null>(null);
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
      setListOpen(false);
      setOutput({ sessionId: session.id, id: entry.id, ...(focus ? { focus } : {}) });
    },
    [closeThread, openProcessRun, processes, session.id],
  );
  // An agent opens in place, from wherever it is named: an entry of the work, or a session by its id.
  const openThread = useCallback(
    (ref: ThreadRef) => {
      setOutput(null);
      setListOpen(false);
      openLetters(ref);
    },
    [openLetters],
  );
  const allEntries = panel.all;
  const openAgent = useCallback(
    (target: string, options?: { focus?: string }) => {
      const entry = allEntries.find((one) => one.id === target || one.id === `session:${target}`);
      if (entry) return openEntry(entry, options?.focus);
      // A bot only has conversations: its name opens the letters between it and this chat.
      const other = sessions.find((row) => row.id === target);
      if (other?.kind === "bot") {
        return openThread({ a: letters.owner, b: sessionParty(other), ...(options?.focus ? { focus: options.focus } : {}) });
      }
      openSession(target);
    },
    [allEntries, letters.owner, openEntry, openSession, openThread, sessions],
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
  const agents = useMemo(
    () => sessions.filter((row) => row.workspaceId === session.workspaceId && row.id !== session.id),
    [sessions, session.workspaceId, session.id],
  );
  const trees = useRepoTrees(cwd);
  const worktrees = useMemo(() => treeMentions(trees), [trees]);
  const chatActions = useMemo(() => ({ ...actions, openAgent, agents, worktrees }), [actions, openAgent, agents, worktrees]);
  const openOutput = useCallback(
    (commandId: string) => {
      closeThread();
      setOutput({ sessionId: session.id, id: commandEntryId(commandId) });
    },
    [closeThread, session.id],
  );
  const openLetter = !embedded && output?.sessionId === session.id ? output.focus : undefined;
  const letterScope = useMemo<LetterScope>(() => ({ ...letters.scope, openThread, inThread: embedded, openLetter }), [embedded, letters.scope, openLetter, openThread]);
  const backgroundScope = useMemo<BackgroundScope>(() => ({ calls: markedCalls(commands), open: openOutput }), [commands, openOutput]);

  // Opening the tab means "talk to this session"; the caret should already be there.
  useEffect(() => {
    if (active) field.current?.focus();
  }, [active]);

  // Opened from a letter: the thread starts at the block carrying it.
  useEffect(() => {
    if (focusLetter && ready) showLetter(pane.current, focusLetter, !embedded);
  }, [embedded, focusLetter, ready]);

  // What home's composer wrote before the session existed is its first turn.
  useEffect(() => {
    const prompt = peekFirstPrompt(session.id);
    if (!prompt) return;
    const files = peekFirstFiles(session.id);
    clearFirstPrompt(session.id);
    void send(session, cwd, prompt, files);
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

  const { uploads, start: startUploads, dismiss: dismissUpload, busy: uploading } = useUploads(addPaths);

  // A file the machine in front cannot read from this Mac's disk goes to its temp dir first, with how far it got.
  const uploadFiles = useCallback(
    (list: File[]) => {
      const env = focusEnv();
      startUploads(
        list.map((file) => ({
          name: file.name || "pasted file",
          size: file.size,
          run: (onProgress, signal) => writeTempFile(file, env, onProgress, signal),
        })),
      );
    },
    [startUploads],
  );

  const attach = useCallback(async () => {
    const paths = await pickFiles();
    const env = focusEnv();
    if (env === LOCAL) return addPaths(paths);
    // The picker names files on this Mac; a remote workspace needs them on its own machine.
    for (const path of paths) {
      const source = await pathSource(path).catch(() => null);
      if (!source) continue;
      startUploads([{ name: source.name, size: source.size, run: (onProgress, signal) => upload(source, env, extensionFor(source.name), onProgress, signal) }]);
    }
  }, [addPaths, startUploads]);

  const over = useFileDrop(pane, addPaths, uploadFiles);

  // Nobody has talked to a session of the user's yet: it can still be another provider's CLI.
  const fresh = session.kind === "terminal" && ready && held.length === 0 && pending.length === 0 && !working;
  // A bot is an identity, not a CLI: between turns it moves to another provider, which starts it a new conversation.
  const botSwitch = session.kind === "bot" && ready && !working;
  const { update: remember } = useDefaultAgent();
  // Each turn starts its CLI from the row: the next one runs what the chips say.
  // A pick is also what the next new session starts with.
  const changeOptions = useCallback(
    (next: AgentChoice) => {
      remember(next);
      const options = {
        model: next.model,
        effort: next.effort,
        serviceTier: next.serviceTier ?? "",
        autonomy: next.access,
      };
      if (next.provider === session.provider) void setSessionOptions(session.id, options).catch(() => {});
      else if (fresh) void switchSessionProvider(session.id, { provider: next.provider, ...options }).catch(() => {});
      else if (botSwitch)
        void updateSession(session.id, {
          name: session.name,
          provider: next.provider,
          model: next.model,
          description: session.description,
          notifications: session.notifications,
          autonomy: next.access,
        })
          .then(() => setSessionOptions(session.id, options))
          .catch(() => {});
    },
    [botSwitch, fresh, remember, session],
  );

  const submit = useCallback(
    (mode?: "steer" | "queue") => {
      const text = draft.trim();
      if ((!text && files.length === 0) || !ready || uploading) return;
      // A message while it works goes into the turn or after it.
      if (working && !mode) return;
      const attached = files;
      const mentions = mentionedFiles(text, projectFiles).map((file) => file.path);
      // A folder, or a file the index leaves out, goes too when it was picked from the menu.
      for (const token of mentionTokens(text)) {
        const path = actions.resolvePath(token)?.replace(/\/+$/, "");
        if (path && wasPicked(path) && !mentions.includes(path)) mentions.push(path);
      }
      const { command, skills } = dispatchOf(text, menu?.entries ?? []);
      const asked = { mentions, ...(command ? { command } : {}), skills };
      // The agents and worktrees it names go under it with their ids and paths, which the agent acts on; a command's arguments take none.
      const sent = command ? text : text + agentNote(mentionedAgents(text, agents), mentionedTrees(text, worktrees, agents));
      setDraft("");
      setFiles([]);
      // What is held after a stop goes with the next message: the daemon queues it behind them.
      if (working || waiting.length > 0) void pass(session, cwd, sent, attached, mode ?? "queue", asked);
      else void send(session, cwd, sent, attached, asked);
    },
    [actions, agents, cwd, draft, files, menu, projectFiles, ready, session, uploading, waiting.length, whileWorking, working, worktrees],
  );

  const conversations = useMemo(() => conversationsOf(letters.pairs, letters.owner), [letters.pairs, letters.owner]);
  // Agents are the clip's and the right panel's; the sheet keeps what they left running.
  const work = useMemo<PanelScope>(
    () => ({
      entries: panel.entries.filter((entry) => !isAgentEntry(entry)),
      failed: panel.failed,
      onOpen: openEntry,
      onStop: panel.stop,
      onClear: panel.clear,
    }),
    [openEntry, panel.clear, panel.entries, panel.failed, panel.stop],
  );

  const agentEntries = useMemo(() => panel.all.filter(isAgentEntry), [panel.all]);
  const [dismissed, setDismissed] = useState<readonly string[]>([]);
  const openedId = output?.sessionId === session.id ? output.id : null;
  const notices = useMemo<AgentNoticeItem[]>(
    () =>
      agentEntries.flatMap((entry): AgentNoticeItem[] => {
        if (entry.id === openedId) return [];
        const child = entry.source.type === "session" ? sessions.find((row) => row.id === entry.source.id) : undefined;
        const asks = entry.attention ?? (entry.state === "failed" && child?.lastEvent && child.lastEvent.cursor > (child.userSeen ?? 0) ? "failed" : null);
        if (!asks) return [];
        const key = `${entry.id}@${child?.lastEvent?.cursor ?? entry.startedAt}`;
        return dismissed.includes(key) ? [] : [{ key, entry, asks }];
      }),
    [agentEntries, dismissed, openedId, sessions],
  );
  const closePanel = useCallback(() => {
    setOutput(null);
    setListOpen(false);
    closeThread();
  }, [closeThread]);
  const showList = useCallback(() => {
    setOutput(null);
    closeThread();
    setListOpen(true);
  }, [closeThread]);
  // One agent at work and nothing else to list: the clip opens it, not a list of one.
  const [first] = agentEntries;
  const sole = agentEntries.length === 1 && conversations.length === 0 && first?.state === "running" && !first.attention ? first : undefined;
  const soleOpen = sole !== undefined && openedId === sole.id;
  const agentsLine = useMemo<AgentsLine>(
    () => ({
      notices,
      agents: agentEntries,
      conversations: conversations.length,
      open: (listOpen && !output) || soleOpen,
      working: agentEntries.filter((entry) => entry.state === "running" && !entry.attention).length,
      any: agentEntries.length + conversations.length > 0,
      onOpenNotice: () => {
        const [only] = notices;
        // In a thread there is no list to open: the first that wants the user.
        if (only && (notices.length === 1 || embedded)) openEntry(only.entry);
        else showList();
      },
      onDismiss: () => setDismissed((was) => [...was, ...notices.map((one) => one.key)]),
      onToggleList: () => {
        if ((listOpen && !output) || soleOpen) closePanel();
        else if (sole) openEntry(sole);
        else showList();
      },
    }),
    [agentEntries, closePanel, conversations.length, embedded, listOpen, notices, openEntry, output, showList, sole, soleOpen],
  );

  const queue = useMemo<QueueScope>(
    () => ({
      items: waiting,
      onDispose: (letterId) => void mailboxDispose({ sessionId: session.id, letterId }).catch(() => {}),
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

  const threadBody =
    letters.thread && (
      <Thread
        key={`${letters.thread.a.id}|${letters.thread.b.id}|${letters.thread.focus ?? ""}`}
        thread={letters.thread}
        sessionId={session.id}
        sessions={sessions}
        active={active}
        inChat={letters.inChat}
        onClose={letters.closeThread}
        onShowInChat={(letterId) => {
          letters.closeThread();
          showLetter(pane.current, letterId);
        }}
      />
    );
  // A pair's conversation opens in the right panel, as an agent does; inside a thread, over it.
  const thread = embedded && threadBody && host ? createPortal(threadBody, host) : null;
  const live = panel.board?.live ?? false;

  // What the opened entry is made of: a board command, a Crew subagent's session.
  const openedCommand = shown?.source.type === "command" ? commands.find((command) => command.id === shown.source.id) : undefined;
  const openedChild = shown?.source.type === "session" ? sessions.find((row) => row.id === shown.source.id) : undefined;
  useMarkSeen(sessions, openedChild?.id ?? null);
  // A Claude subagent's steps live in the call that started it.
  const openedCalls = useMemo(() => (shown?.source.type === "command" ? callsOfEntry(held, shown) : []), [held, shown]);
  const path = useMemo<readonly Crumb[]>(
    () => [
      ...(trail ?? []),
      { id: session.id, name: session.name, provider: session.provider, bot: session.kind === "bot", back: () => setOutput(null) },
    ],
    [trail, session.id, session.name, session.provider, session.kind],
  );
  // A shell's output still takes the whole pane; an agent and a conversation open beside the chat.
  const shellOpen = shown?.kind === "shell";
  const threadOpen = embedded ? Boolean(shown) || Boolean(letters.thread) : shellOpen;
  const panelOpen = !embedded && (listOpen || (Boolean(shown) && !shellOpen) || Boolean(letters.thread));

  // ⌘F finds in the chat you see: under a thread, the thread's own chat has it.
  const [finding, setFinding] = useState<number | null>(null);
  const openFind = useCallback(() => setFinding((token) => (token ?? 0) + 1), []);
  const closeFind = useCallback(() => {
    setFinding(null);
    field.current?.focus();
  }, []);
  useShortcuts(active && !threadOpen && held.length > 0 ? { find: openFind } : {});
  const agentBody =
    shown &&
    !letters.thread && (
      <AgentView
        key={shown.id}
        entry={shown}
        crumbs={path}
        {...(openedChild ? { startedBy: openedChild.launchedByName ?? openedChild.parentName ?? "a session", worktree: openedChild.worktree } : {})}
        blocks={openedCalls}
        {...(openedCommand ? { command: openedCommand } : {})}
        sessionId={session.id}
        live={live}
        error={panel.failed[shown.id]}
        active={active}
        onStop={() => panel.stop(shown)}
        onClose={embedded || shellOpen ? () => setOutput(null) : closePanel}
        {...(shellOpen ? {} : { onBack: embedded ? () => setOutput(null) : showList })}
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
      />
    );
  const agentView = agentBody && host && (embedded || shellOpen) ? createPortal(agentBody, host) : null;

  // The list and whoever is open over it. Mounted from the first time it opens: a thread keeps its draft and its scroll.
  const [everOpen, setEverOpen] = useState(false);
  if (panelOpen && !everOpen) setEverOpen(true);
  const side = !embedded && everOpen && (
    <SidePanel open={panelOpen} active={active} onHost={setPanelEl}>
      <AgentList
        entries={agentEntries}
        conversations={conversations}
        sessions={sessions}
        failed={panel.failed}
        onOpen={(entry) => openEntry(entry)}
        onOpenConversation={openThread}
        onStop={panel.stop}
        onClose={closePanel}
      />
      <PaneContext value={panelEl}>{!shellOpen && agentBody}</PaneContext>
      {threadBody}
    </SidePanel>
  );

  // Esc closes the list; an agent and a conversation answer it themselves.
  const listOnly = panelOpen && !shown && !letters.thread;
  useEffect(() => {
    if (!active || !listOnly) return;
    const key = (event: KeyboardEvent) => {
      // A menu open over the list takes its own Esc.
      if (event.key === "Escape" && !event.defaultPrevented && !document.querySelector('[role="menu"]')) closePanel();
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [active, closePanel, listOnly]);

  return (
    <div
      ref={bindPane}
      data-file-drop={over || undefined}
      className={`relative flex flex-col bg-canvas ${embedded ? "min-h-0 flex-1" : "h-full"}`}
    >
      <PaneContext value={host}>
        <ChatContext value={chatActions}>
        <LetterContext value={letterScope}>
          <BackgroundContext value={backgroundScope}>
            <WorkContext value={panel.all}>
            {/* Under a thread the chat stays mounted, hidden and inert: its scroll, draft and open sheet come back as they were. */}
            <div inert={threadOpen} className={`flex min-h-0 flex-1 flex-col ${threadOpen || settling ? "invisible" : ""}`}>
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
              whileWorking={whileWorking}
              queue={queue}
              onAttach={() => void attach()}
              onPasteFiles={uploadFiles}
              onRemoveFile={(path) => setFiles((prev) => prev.filter((file) => file.path !== path))}
              uploads={uploads}
              onDismissUpload={dismissUpload}
              onApprove={approve}
              onAnswer={reply}
              onOptions={changeOptions}
              switchProvider={fresh || botSwitch}
              {...(embedded ? { inThread: true, agents: { ...agentsLine, any: false } } : { agents: agentsLine })}
              readOnly={readOnly}
              finding={finding}
              onCloseFind={closeFind}
            />
            </div>
            {agentView}
            {thread}
            {side}
            </WorkContext>
          </BackgroundContext>
        </LetterContext>
        </ChatContext>
      </PaneContext>
    </div>
  );
}
