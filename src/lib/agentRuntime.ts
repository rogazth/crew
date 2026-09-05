import * as api from "./api";
import { client } from "./client";
import { type Answers, type ApprovalDecision, type AttachedFile, type HarnessEvent } from "./blocks";
import { notify } from "./notify";
import * as transcript from "./transcript";
import type { Session, SessionStatus } from "./types";
import type { SessionStatusEvent, TranscriptApply, TurnStart } from "./protocol";

/** Runtime-owned columns. The sidebar renders them; only this module writes them. */
export type SessionPatch = Partial<Pick<Session, "status" | "providerSessionId" | "updatedAt">>;

type PatchListener = (id: string, patch: SessionPatch) => void;

type KnownSession = { name: string; notifications: boolean };

const patchListeners = new Set<PatchListener>();
const statuses = new Map<string, SessionStatus>();
const known = new Map<string, KnownSession>();
const waiters = new Map<string, Array<(ok: boolean) => void>>();
let foreground: string | null = null;
let booted = false;

export function onSessionPatch(listener: PatchListener): () => void {
  patchListeners.add(listener);
  return () => {
    patchListeners.delete(listener);
  };
}

export function boot(): Promise<void> {
  if (!booted) {
    booted = true;
    client.on("transcript-apply", (payload) => {
      const apply = payload as TranscriptApply;
      onHarness(apply.sessionId, apply.event);
    });
    client.on("session-status", (payload) => {
      onStatus(payload as SessionStatusEvent);
    });
    client.onReconnect(() => {
      for (const id of statuses.keys()) {
        void transcript.reload(id);
      }
    });
  }
  return Promise.resolve();
}

/** Sessions the store says are busy stay busy: the daemon still owns the turn. */
export async function reconcile(sessions: Session[]): Promise<Session[]> {
  await boot();
  return sessions.map((session) => {
    remember(session);
    statuses.set(session.id, session.status);
    return session;
  });
}

/** The chat the user is looking at; its turns end quiet instead of flagged. */
export function setForeground(id: string | null): void {
  foreground = id;
  if (id && statuses.get(id) === "done") markIdle(id);
}

export function isWorking(id: string): boolean {
  return transcript.read(id).working;
}

export async function send(
  session: Session,
  cwd: string,
  text: string,
  files: AttachedFile[] = [],
  options: { fresh?: boolean; hidden?: boolean; mentions?: string[] } = {},
): Promise<boolean> {
  const id = session.id;
  remember(session);
  if (transcript.read(id).working) return false;
  await boot();
  await transcript.load(id);
  const finished = whenSettled(id);
  const params: TurnStart = {
    sessionId: id,
    cwd,
    text,
    ...(files.length > 0 ? { files } : {}),
    ...(options.mentions && options.mentions.length > 0 ? { mentions: options.mentions } : {}),
    ...(options.hidden ? { hidden: true } : {}),
    ...(options.fresh ? { fresh: true } : {}),
  };
  try {
    await api.turnStart(params);
  } catch (error) {
    finishWaiters(id, false);
    transcript.apply(id, {
      type: "session.error",
      message: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
  await transcript.reload(id);
  return finished;
}

function lastReply(id: string): string {
  const blocks = transcript.read(id).blocks;
  for (let i = blocks.length - 1; i >= 0; i -= 1) {
    const block = blocks[i];
    if (block?.role === "assistant" && block.text.trim()) return block.text.trim().split("\n")[0] ?? "Done";
  }
  return "Done";
}

export async function stop(session: Session): Promise<void> {
  remember(session);
  await boot();
  await api.turnStop(session.id).catch(() => undefined);
}

export function respond(session: Session, requestId: number, decision: ApprovalDecision): void {
  void api.turnRespond(session.id, requestId, decision);
}

export function answer(session: Session, requestId: number, answers: Answers | null): void {
  void api.turnAnswer(session.id, requestId, answers);
}

/** Session deleted: kill whatever it was running and drop its transcript cache. */
export async function dispose(id: string): Promise<void> {
  const busy = transcript.read(id).working || statuses.get(id) === "working" || statuses.get(id) === "needs-input";
  if (busy) await api.turnStop(id).catch(() => undefined);
  transcript.forget(id);
  statuses.delete(id);
  finishWaiters(id, false);
}

function onHarness(id: string, event: HarnessEvent) {
  if (event.type === "approval.requested") {
    const name = sessionName(id);
    if (name && !isWatching(id)) void notify(name, `Wants to run: ${event.title}`);
  }
  if (event.type === "question.requested") {
    const name = sessionName(id);
    const first = event.questions[0];
    if (name && first && !isWatching(id)) void notify(name, `Asks: ${first.question}`);
  }
}

function onStatus(event: SessionStatusEvent) {
  const id = event.sessionId;
  const status = event.status as SessionStatus;
  statuses.set(id, status);
  transcript.setWorking(id, status === "working" || status === "needs-input");
  const display = status === "done" && foreground === id ? "idle" : status;
  if (display === "idle" && status === "done") markIdle(id);
  else {
    patch(id, {
      status: display,
      updatedAt: event.updatedAt,
      ...(event.providerSessionId ? { providerSessionId: event.providerSessionId } : {}),
    });
  }
  if (status === "done" || status === "idle" || status === "error") {
    finishWaiters(id, status !== "error");
    if (status !== "idle" && !isWatching(id)) {
      const name = sessionName(id);
      if (name) void notify(name, status === "error" ? "Ran into an error" : lastReply(id));
    }
  }
}

function markIdle(id: string) {
  statuses.set(id, "idle");
  transcript.setWorking(id, false);
  patch(id, { status: "idle", updatedAt: Date.now() });
  void api.setSessionStatus(id, "idle").catch(() => {});
}

function remember(session: Session) {
  known.set(session.id, { name: session.name, notifications: session.notifications });
}

function sessionName(id: string): string | null {
  return known.get(id)?.name ?? null;
}

function isWatching(id: string): boolean {
  const row = known.get(id);
  if (row && !row.notifications) return true;
  return foreground === id && typeof document !== "undefined" && document.hasFocus();
}

function whenSettled(id: string): Promise<boolean> {
  return new Promise((resolve) => {
    const list = waiters.get(id) ?? [];
    list.push(resolve);
    waiters.set(id, list);
  });
}

function finishWaiters(id: string, ok: boolean) {
  const list = waiters.get(id);
  if (!list) return;
  waiters.delete(id);
  for (const resolve of list) resolve(ok);
}

function patch(id: string, change: SessionPatch): void {
  for (const listener of patchListeners) listener(id, change);
}
