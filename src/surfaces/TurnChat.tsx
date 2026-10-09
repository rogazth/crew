import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useBackground } from "../hooks/useBackground";
import { showLetter, useChatLetters, usePending } from "../hooks/useLetters";
import { useThread } from "../hooks/useThread";
import { answer, pass, respond, send, stop } from "../lib/turnRuntime";
import { mailboxDispose, mailboxEdit, mailboxReorder, pickFiles, setSessionOptions, switchSessionProvider, turnSendNow, writeTempFile } from "../lib/api";
import { attachedFrom } from "../lib/attachments";
import { markedCalls, turnTray } from "../lib/background";
import type { ThreadRef } from "../lib/letters";
import { queuedLetters } from "../lib/letters";
import { clearFirstPrompt, peekFirstPrompt } from "../lib/firstPrompt";
import { mentionedFiles } from "../lib/mentions";
import { moved, othersPending, userQueue, whileWorkingOf } from "../lib/queue";
import type { AgentChoice } from "../lib/providers";
import { BackgroundContext, LetterContext, useChatActions, type BackgroundScope, type LetterScope } from "./chat/context";
import { useFileDrop } from "../hooks/useFileDrop";
import type { Answers, ApprovalDecision, AttachedFile } from "../lib/blocks";
import type { Session } from "../lib/types";
import { BackgroundOutputView, BackgroundTray } from "./chat/Background";
import type { QueueScope } from "./chat/Queue";
import { ChatBar } from "./chat/ChatBar";
import { DefaultChatSurface } from "./chat/DefaultChatSurface";
import { Thread } from "./chat/Thread";

type Props = {
  session: Session;
  /** Every session, for its children, and for whoever its letters name. */
  sessions: readonly Session[];
  cwd: string;
  active: boolean;
};

export function TurnChat({ session, sessions, cwd, active }: Props) {
  const { blocks: held, ready, working, more, loadingEarlier, loadEarlier, focusId } = useThread(session.id);
  const [draft, setDraft] = useState("");
  const [files, setFiles] = useState<AttachedFile[]>([]);
  const field = useRef<HTMLTextAreaElement>(null);
  const pane = useRef<HTMLDivElement>(null);
  const { files: projectFiles, openSession } = useChatActions();
  const letters = useChatLetters(session, sessions, held);
  // What waits in its box for the next turn: others' letters under the turn
  // that is running, the user's own above the composer.
  const pending = usePending(session.id, true);
  const blocks = useMemo(() => [...held, ...queuedLetters(othersPending(pending), held)], [held, pending]);
  const waiting = useMemo(() => userQueue(pending, held), [held, pending]);
  const whileWorking = whileWorkingOf(session.kind, session.provider);
  const background = useBackground(session.id);
  const commands = useMemo(() => turnTray(background), [background]);
  // One thing over the transcript at a time: a pair's thread, or a command's output.
  const [output, setOutput] = useState<{ sessionId: string; id: string } | null>(null);
  const shown = output?.sessionId === session.id ? commands.find((command) => command.id === output.id) : undefined;
  const { closeThread, openThread: openLetters } = letters;
  const openOutput = useCallback(
    (id: string) => {
      closeThread();
      setOutput({ sessionId: session.id, id });
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
      else if (fresh) void switchSessionProvider(session.id, cwd, { provider: next.provider, ...options }).catch(() => {});
    },
    [cwd, fresh, session.id, session.provider],
  );

  const submit = useCallback(
    (mode?: "steer" | "queue") => {
      const text = draft.trim();
      if ((!text && files.length === 0) || !ready) return;
      // A message while it works goes into the turn or after it; a bot takes none.
      if (working && !(mode && whileWorking)) return;
      const attached = files;
      const mentions = mentionedFiles(text, projectFiles).map((file) => file.path);
      setDraft("");
      setFiles([]);
      // What is held after a stop goes with the next message: the daemon queues it behind them.
      if ((working || waiting.length > 0) && whileWorking) void pass(session, cwd, text, attached, mode ?? "queue", mentions);
      else void send(session, cwd, text, attached, mentions.length > 0 ? { mentions } : {});
    },
    [cwd, draft, files, projectFiles, ready, session, waiting.length, whileWorking, working],
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

  const thread = letters.thread && (
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
    />
  );
  const live = background?.live ?? false;

  return (
    <div ref={pane} className="relative flex h-full flex-col bg-canvas">
      <LetterContext value={letterScope}>
        <BackgroundContext value={backgroundScope}>
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
            {...(whileWorking ? { whileWorking, queue } : {})}
            onAttach={() => void attach()}
            onPasteFiles={pasteFiles}
            onRemoveFile={(path) => setFiles((prev) => prev.filter((file) => file.path !== path))}
            onApprove={approve}
            onAnswer={reply}
            onOptions={changeOptions}
            switchProvider={fresh}
            bar={
              <ChatBar
                session={session}
                sessions={sessions}
                kids={letters.kids}
                pairs={letters.pairs}
                onOpenSession={openSession}
                onOpenThread={openThread}
              />
            }
            tray={
              commands.length > 0 && (
                <BackgroundTray sessionId={session.id} commands={commands} live={live} onOpen={openOutput} />
              )
            }
            overlay={
              shown && !letters.thread ? (
                <BackgroundOutputView
                  key={shown.id}
                  sessionId={session.id}
                  command={shown}
                  live={live}
                  active={active}
                  onClose={() => setOutput(null)}
                />
              ) : (
                thread
              )
            }
          />
        </BackgroundContext>
      </LetterContext>
    </div>
  );
}
