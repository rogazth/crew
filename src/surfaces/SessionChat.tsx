import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type RefObject } from "react";
import { MessageSquareTextIcon, ShieldQuestionIcon, SquareTerminalIcon, TriangleAlertIcon } from "lucide-react";
import { Button } from "../chrome/kit";
import { useFileDrop } from "../hooks/useFileDrop";
import { showLetter, useChatLetters } from "../hooks/useLetters";
import * as api from "../lib/api";
import { attachedFrom } from "../lib/attachments";
import { terminalTray } from "../lib/background";
import type { Answers, ApprovalDecision, AttachedFile, Block } from "../lib/blocks";
import type { BlockingScreen } from "../lib/blockingScreen";
import {
  approvalKeys,
  messageKeys,
  modeKeys,
  ptyQueue,
  questionKeys,
  stopKeys,
  trustKeys,
  type Keystroke,
} from "../lib/ptySend";
import { delivered, openQuestion, overdue, queuedBlock, withAsk, type Queued } from "../lib/sessionChat";
import { holdHistory, loadEarlierHistory, readHistory, subscribeHistory } from "../lib/sessionHistory";
import { answeredAsk, liveHeard, readLive, stoppedTurn, subscribeLive } from "../lib/sessionLive";
import { providerLine, type AgentChoice } from "../lib/providers";
import { applyFor, readLaunched, setLaunched, subscribeLaunched } from "../lib/sessionOptions";
import { quotePath } from "../lib/terminalPaths";
import { reportsLive, startsAtLaunch } from "../lib/sessionView";
import type { Session } from "../lib/types";
import { BackgroundTray } from "./chat/Background";
import { ChatBar } from "./chat/ChatBar";
import { AlwaysAllow, LetterContext, useChatActions } from "./chat/context";
import { DefaultChatSurface } from "./chat/DefaultChatSurface";
import { Thread } from "./chat/Thread";

type Props = {
  session: Session;
  /** Every session, for its children, and for whoever its letters name. */
  sessions: readonly Session[];
  /** The terminal the CLI runs in, which the chat types into. */
  ptyId: string;
  cwd: string;
  active: boolean;
  /** A screen the CLI stopped on that a message cannot answer. */
  blocked: BlockingScreen | null;
  /** The CLI's screen shows the line a message is typed on (`takesInput`). */
  prompting: boolean;
  /** The terminal's own reading of whether the CLI is busy: its title, its output. */
  busy: boolean;
  onShowTerminal: () => void;
  /** Ends the CLI and starts it again on its conversation, with the row's options and `message` to start on. */
  onRestart: (message: string) => Promise<void>;
  /** Ends the CLI and starts `choice`'s in its place: only before anyone has talked to it. */
  onSwitchProvider: (choice: AgentChoice) => Promise<void>;
};

/** What each session's chat had in its composer; the chat comes and goes with the setting and the tab. */
const drafts = new Map<string, string>();
/** Sent from a chat and not in the CLI's history yet; kept across the chat unmounting. */
const pending = new Map<string, Queued[]>();

/**
 * A session's conversation in Crew's chat, drawn over its terminal. The CLI in
 * the terminal is the only thing talking to the provider: the chat reads its
 * history, types into it, and answers what it asks with the keys it expects.
 */
export function SessionChat({
  session,
  sessions,
  ptyId,
  cwd,
  active,
  blocked,
  prompting,
  busy,
  onShowTerminal,
  onRestart,
  onSwitchProvider,
}: Props) {
  const id = session.id;
  const [draft, setDraft] = useState(() => drafts.get(id) ?? "");
  const [files, setFiles] = useState<AttachedFile[]>([]);
  const field = useRef<HTMLTextAreaElement>(null);
  const root = useRef<HTMLDivElement>(null);

  // The daemon reads the CLI's file while the chat's tab is open, shown or
  // not: letting go of it empties the transcript, and the reader's place, and
  // the pages they loaded above it, with it.
  useEffect(() => holdHistory(id, cwd), [cwd, id]);
  const history = useSyncExternalStore(
    useCallback((listener: () => void) => subscribeHistory(id, listener), [id]),
    () => readHistory(id),
  );
  const live = useSyncExternalStore(
    useCallback((listener: () => void) => subscribeLive(id, listener), [id]),
    () => readLive(id),
  );

  const heard = useSyncExternalStore(
    useCallback((listener: () => void) => subscribeLive(id, listener), [id]),
    () => liveHeard(id),
  );
  const hooked = reportsLive(session.provider) && heard;
  // The hooks start a turn; Claude's title, back at rest, also ends one that
  // was stopped with Esc in the terminal, which no hook reports.
  const working = hooked ? (live?.working ?? false) && busy : busy;
  const gone = useGone(hooked && live !== null && !live.started);
  const [switching, setSwitching] = useState(false);
  // Keys typed before the CLI reads them are lost, or answer its trust prompt.
  const ready =
    !switching && !blocked && prompting && (!hooked || !startsAtLaunch(session.provider) || live?.started === true);
  const ask = live?.ask ?? null;
  // What the last turn left running, as its Stop hook said: read-only, since
  // only the CLI in the terminal can stop it.
  const leftRunning = useMemo(() => (hooked ? terminalTray(live) : []), [hooked, live]);

  const queue = useMemo(() => ptyQueue(ptyId, (data) => api.writePty(ptyId, data)), [ptyId]);
  const type = useCallback((keys: Keystroke[]) => queue.send(keys).done, [queue]);

  const editDraft = useCallback(
    (next: string) => {
      setDraft(next);
      if (next) drafts.set(id, next);
      else drafts.delete(id);
    },
    [id],
  );

  const { waiting, keepQueued } = useQueued(id, history.blocks);

  const blocks = useMemo(
    () => [...withAsk(history.blocks, ask), ...waiting.map(queuedBlock)],
    [ask, history.blocks, waiting],
  );

  useFocusWhenShown(root, field, active);
  const { openSession } = useChatActions();
  const letters = useChatLetters(session, sessions, history.blocks);

  const addPaths = useCallback((paths: string[]) => {
    if (paths.length === 0) return;
    setFiles((prev) => {
      const seen = new Set(prev.map((file) => file.path));
      return [...prev, ...paths.flatMap((path) => (seen.has(path) ? [] : [attachedFrom(path)]))];
    });
    field.current?.focus();
  }, []);
  const over = useFileDrop(root, addPaths);

  const launched = useSyncExternalStore(
    useCallback((listener: () => void) => subscribeLaunched(id, listener), [id]),
    () => readLaunched(id),
  );
  const apply = applyFor(session, launched);

  // ⇧Tab is the one change Claude takes as it runs: it lasts the session and saves nothing.
  // One walk at a time: presses counted from a mode the last walk is still leaving would overshoot.
  const shifting = useRef<Promise<boolean> | null>(null);
  const shiftMode = useCallback(
    (presses: number) => {
      if (shifting.current) return shifting.current;
      const running = readLaunched(id);
      if (!running) return Promise.resolve(true);
      const walk = type(modeKeys(presses)).then((ok) => {
        if (ok) setLaunched(id, { ...running, access: session.autonomy });
        shifting.current = null;
        return ok;
      });
      shifting.current = walk;
      return walk;
    },
    [id, session.autonomy, type],
  );

  // Nobody has talked to it yet, here or in its terminal: it can still be another provider's CLI.
  const fresh =
    !history.loading && history.state !== "error" && history.blocks.length === 0 && waiting.length === 0 && !working && !ask;

  const changeOptions = useCallback(
    (next: AgentChoice) => {
      if (next.provider !== session.provider) {
        if (!fresh || switching) return;
        setSwitching(true);
        void onSwitchProvider(next)
          .catch(() => {})
          .finally(() => setSwitching(false));
        return;
      }
      void api.setSessionOptions(id, { model: next.model, effort: next.effort, autonomy: next.access }).catch(() => {});
    },
    [fresh, id, onSwitchProvider, session.provider, switching],
  );

  // A mode change reaches an idle CLI at once; mid-turn or on a prompt, keys would answer something else.
  const idle = ready && !working && !ask;
  const presses = apply.kind === "keys" ? apply.presses : 0;
  useEffect(() => {
    if (presses > 0 && idle) void shiftMode(presses);
  }, [presses, idle, shiftMode]);

  const submit = useCallback(() => {
    const text = draft.trim();
    if ((!text && files.length === 0) || !ready) return;
    const sent: Queued = { id: crypto.randomUUID(), text, files, at: Date.now() };
    editDraft("");
    setFiles([]);
    // The ones the history has by now go; this one waits for its turn.
    keepQueued(() => [...waiting, sent]);
    const paths = files.map((file) => file.path);
    const now = applyFor(session, readLaunched(id));
    if (now.kind === "relaunch") {
      // The message is the restarted CLI's first: no keys to time against its start.
      void onRestart([...paths.map(quotePath), text].filter(Boolean).join(" "));
      return;
    }
    const mode = now.kind === "keys" ? shiftMode(now.presses) : Promise.resolve(true);
    void mode
      .then(() => type(messageKeys(session.provider, text, paths)))
      .then((ok) => {
        if (!ok) keepQueued((prev) => prev.filter((row) => row.id !== sent.id));
      });
  }, [draft, editDraft, files, id, keepQueued, onRestart, ready, session, shiftMode, type, waiting]);

  // Esc takes back what the CLI had not started on: Claude puts it back on its
  // own line, where the next send clears it. It is not coming.
  const stop = useCallback(() => {
    keepQueued(() => []);
    void type(stopKeys(session.provider)).then(() => stoppedTurn(id));
  }, [id, keepQueued, session.provider, type]);

  const approve = useCallback(
    (requestId: number, decision: ApprovalDecision) => {
      void type(approvalKeys(session.provider, decision));
      answeredAsk(id, requestId);
    },
    [id, session.provider, type],
  );

  const reply = useCallback(
    (_requestId: number, answers: Answers | null) => {
      // The form on screen is the hook's, or else the one the history shows open.
      const questions = ask?.questions.length ? ask.questions : (openQuestion(history.blocks)?.question?.questions ?? []);
      void type(questionKeys(questions, answers));
      if (ask) answeredAsk(id, ask.id);
    },
    [ask, history.blocks, id, type],
  );

  const stopped: StopReason | null = blocked
    ? { kind: "screen", screen: blocked }
    : gone
      ? { kind: "gone" }
      : history.state === "error"
        ? { kind: "unreadable", error: history.error }
        : null;

  return (
    <div ref={root} className="absolute inset-0 z-10 flex flex-col bg-canvas" data-session-chat={id}>
      <ChatBar
        session={session}
        sessions={sessions}
        kids={letters.kids}
        pairs={letters.pairs}
        onOpenSession={openSession}
        onOpenThread={letters.openThread}
        // A blocking screen offers the terminal itself, front and centre.
        trailing={
          blocked ? null : (
            <Button variant="ghost" icon={SquareTerminalIcon} className="h-7 px-2.5 text-text-muted" onClick={onShowTerminal}>
              Show terminal
            </Button>
          )
        }
      />
      {stopped ? (
        <Stopped
          reason={stopped}
          provider={session.provider}
          onTrust={(trust) => void type(trustKeys(session.provider, trust))}
          onShowTerminal={onShowTerminal}
        />
      ) : (
        <AlwaysAllow value={ask?.always ?? true}>
          <LetterContext value={letters.scope}>
            <DefaultChatSurface
              session={session}
              blocks={blocks}
              working={working}
              ready={ready}
              active={active}
              more={history.more}
              loadingEarlier={history.loadingEarlier}
              onLoadEarlier={() => void loadEarlierHistory(id)}
              focusId={null}
              draft={draft}
              files={files}
              over={over}
              field={field}
              onDraft={editDraft}
              onSend={submit}
              onStop={stop}
              onAttach={() => void api.pickFiles().then(addPaths)}
              onPasteFiles={(pasted) =>
                void Promise.all(pasted.map((file) => api.writeTempFile(file).catch(() => null))).then((paths) =>
                  addPaths(paths.filter((path): path is string => path !== null)),
                )
              }
              onRemoveFile={(path) => setFiles((prev) => prev.filter((file) => file.path !== path))}
              onApprove={approve}
              onAnswer={reply}
              loading={history.loading}
              onOptions={changeOptions}
              optionsPending={apply.kind === "relaunch"}
              switchProvider={fresh && !switching}
              tray={leftRunning.length > 0 && <BackgroundTray sessionId={id} commands={leftRunning} live={false} readOnly />}
              overlay={
                letters.thread && (
                  <Thread
                    key={`${letters.thread.a.id}|${letters.thread.b.id}|${letters.thread.focus ?? ""}`}
                    thread={letters.thread}
                    owner={letters.owner}
                    sessionId={id}
                    sessions={sessions}
                    active={active}
                    inChat={letters.inChat}
                    onClose={letters.closeThread}
                    onShowInChat={(letterId) => {
                      letters.closeThread();
                      showLetter(root.current, letterId);
                    }}
                  />
                )
              }
            />
          </LetterContext>
        </AlwaysAllow>
      )}
    </div>
  );
}

/**
 * Messages sent and not in the CLI's history yet. They outlive the chat, which
 * the setting and the tab mount and unmount, and show until their turn is in.
 */
function useQueued(id: string, blocks: Block[]) {
  const [queued, setQueued] = useState<Queued[]>(() => pending.get(id) ?? []);
  useEffect(() => {
    if (queued.length > 0) pending.set(id, queued);
    else pending.delete(id);
  }, [id, queued]);
  const waiting = useMemo(() => {
    const done = delivered(queued, blocks);
    // One the CLI had its turn for and never matched is not still coming.
    const late = overdue(queued, blocks);
    return queued.filter((sent) => !done.has(sent.id) && !late.has(sent.id));
  }, [blocks, queued]);
  return { waiting, keepQueued: setQueued };
}

/**
 * The caret goes where the keys are wanted: when the tab comes up, and when a
 * page such as Settings that hid the whole workspace goes away again.
 */
function useFocusWhenShown(root: RefObject<HTMLElement | null>, field: RefObject<HTMLTextAreaElement | null>, active: boolean) {
  useEffect(() => {
    const el = root.current;
    if (!active || !el) return;
    field.current?.focus();
    let shown = el.clientHeight > 0;
    const observer = new ResizeObserver(() => {
      const now = el.clientHeight > 0;
      if (now && !shown && (document.activeElement === document.body || document.activeElement === null)) {
        field.current?.focus();
      }
      shown = now;
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [active, field, root]);
}

/**
 * The CLI ended, for longer than a `/clear` takes to end one conversation and
 * start the next.
 */
function useGone(ended: boolean): boolean {
  const [gone, setGone] = useState(false);
  useEffect(() => {
    if (!ended) return;
    const timer = window.setTimeout(() => setGone(true), GONE_AFTER_MS);
    return () => {
      window.clearTimeout(timer);
      setGone(false);
    };
  }, [ended]);
  return ended && gone;
}

const GONE_AFTER_MS = 1500;

/** Why the chat cannot take a message now. */
type StopReason =
  | { kind: "screen"; screen: BlockingScreen }
  | { kind: "gone" }
  | { kind: "unreadable"; error: string | null };

/** In the conversation's place: why the chat can't go on, and the way to the terminal. */
function Stopped({
  reason,
  provider,
  onTrust,
  onShowTerminal,
}: {
  reason: StopReason;
  provider: string;
  onTrust: (trust: boolean) => void;
  onShowTerminal: () => void;
}) {
  if (reason.kind === "screen" && reason.screen.kind === "trust" && (provider === "claude" || provider === "cursor")) {
    return <TrustCard title={reason.screen.title} onAnswer={onTrust} onShowTerminal={onShowTerminal} />;
  }
  if (reason.kind === "screen") {
    return (
      <Notice
        title={reason.screen.title}
        detail="The chat picks up once it's answered in the terminal."
        onShowTerminal={onShowTerminal}
      />
    );
  }
  if (reason.kind === "gone") {
    return (
      <Notice
        title={`${providerLine(provider, "")} isn't running in this terminal`}
        detail="It exited. Its conversation is kept; restart the terminal to pick it up again."
        onShowTerminal={onShowTerminal}
      />
    );
  }
  return (
    <Notice
      title="Crew couldn't read this conversation"
      detail={reason.error ?? "Its history is there, but none of it could be read."}
      onShowTerminal={onShowTerminal}
    />
  );
}

/** The CLI's folder trust prompt, answered from the chat. */
function TrustCard({
  title,
  onAnswer,
  onShowTerminal,
}: {
  title: string;
  onAnswer: (trust: boolean) => void;
  onShowTerminal: () => void;
}) {
  return (
    <div className="flex min-h-0 flex-1 items-center justify-center px-6" role="status">
      <div className="crew-card flex w-full max-w-[440px] flex-col gap-3">
        <div className="flex items-center gap-2.5">
          <span className="grid size-7 shrink-0 place-items-center rounded-lg bg-warning/15 text-warning">
            <ShieldQuestionIcon className="size-4" />
          </span>
          <div className="flex min-w-0 flex-col">
            <span className="font-semibold">{title}</span>
            <span className="text-[12px] text-text-muted">It will be able to read, edit and run files here.</span>
          </div>
        </div>
        <div className="flex items-center gap-1.5">
          <Button variant="ghost" className="h-7 px-2.5 text-text-muted" icon={SquareTerminalIcon} onClick={onShowTerminal}>
            Show terminal
          </Button>
          <span className="flex-1" />
          <Button className="h-7 px-2.5" onClick={() => onAnswer(false)}>
            Exit
          </Button>
          <Button variant="primary" className="h-7 px-2.5" onClick={() => onAnswer(true)}>
            Trust
          </Button>
        </div>
      </div>
    </div>
  );
}

/** The CLI stopped where the chat cannot follow; it says why, and hands over to the terminal. */
function Notice({ title, detail, onShowTerminal }: { title: string; detail: string; onShowTerminal: () => void }) {
  return (
    <div className="flex min-h-0 flex-1 items-center justify-center px-6" role="status">
      <div className="crew-card flex w-full max-w-[440px] flex-col gap-3">
        <div className="flex items-center gap-2.5">
          <span className="grid size-7 shrink-0 place-items-center rounded-lg bg-warning/15 text-warning">
            <TriangleAlertIcon className="size-4" />
          </span>
          <div className="flex min-w-0 flex-col">
            <span className="font-semibold">{title}</span>
            <span className="text-[12px] text-text-muted">{detail}</span>
          </div>
        </div>
        <div className="flex justify-end">
          <Button variant="primary" className="h-7 px-2.5" icon={SquareTerminalIcon} onClick={onShowTerminal}>
            Show terminal
          </Button>
        </div>
      </div>
    </div>
  );
}

/** Over a terminal the setting would draw as the chat: the way back to it. */
export function BackToChat({ onClick }: { onClick: () => void }) {
  return (
    <Button
      variant="secondary"
      icon={MessageSquareTextIcon}
      className="h-7 shrink-0 px-2.5 opacity-80 shadow-float hover:opacity-100"
      onClick={onClick}
    >
      Back to chat
    </Button>
  );
}
