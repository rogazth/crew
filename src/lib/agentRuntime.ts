import * as api from "./api";
import { newBlock, type ApprovalDecision, type AttachedFile, type HarnessEvent } from "./blocks";
import { anyLive, runtimeFor, stopEverywhere } from "./providers/runtime";
import * as transcript from "./transcript";
import type { Session, SessionStatus } from "./types";

/** Runtime-owned columns. The sidebar renders them; only this module writes them. */
export type SessionPatch = Partial<Pick<Session, "status" | "providerSessionId">>;

type PatchListener = (id: string, patch: SessionPatch) => void;

const patchListeners = new Set<PatchListener>();
const statuses = new Map<string, SessionStatus>();
let foreground: string | null = null;
let booted: Promise<void> | null = null;

export function onSessionPatch(listener: PatchListener): () => void {
  patchListeners.add(listener);
  return () => {
    patchListeners.delete(listener);
  };
}

/**
 * A webview reload keeps the Rust host and its children but drops every
 * parser, so whatever was running is now an orphan. Clear them before the
 * first turn rather than letting a stale spinner outlive its process.
 */
export function boot(): Promise<void> {
  if (!booted) booted = api.killAllAgents().catch(() => undefined);
  return booted;
}

/** Sessions the store says are busy but nothing here is driving. */
export async function reconcile(sessions: Session[]): Promise<Session[]> {
  await boot();
  return sessions.map((session) => {
    statuses.set(session.id, session.status);
    if (session.kind !== "agent") return session;
    const stale =
      (session.status === "working" || session.status === "needs-input") && !anyLive(session.id);
    if (!stale) return session;
    setStatus(session.id, "idle");
    return { ...session, status: "idle" };
  });
}

/** The chat the user is looking at; its turns end quiet instead of flagged. */
export function setForeground(id: string | null): void {
  foreground = id;
  if (id && statuses.get(id) === "done") setStatus(id, "idle");
}

export function isWorking(id: string): boolean {
  return transcript.read(id).working;
}

export async function send(
  session: Session,
  cwd: string,
  text: string,
  files: AttachedFile[] = [],
): Promise<void> {
  const id = session.id;
  if (transcript.read(id).working) return;
  await boot();
  await transcript.load(id);

  const user = newBlock("user", text);
  transcript.append(id, files.length > 0 ? { ...user, files } : user);
  transcript.setWorking(id, true);
  setStatus(id, "working");

  let failed = false;
  const onEvent = (event: HarnessEvent) => {
    if (event.type === "session.providerBound") {
      patch(id, { providerSessionId: event.providerSessionId });
      void api.setProviderSession(id, event.providerSessionId).catch(() => {});
      return;
    }
    if (event.type === "approval.requested") setStatus(id, "needs-input");
    if (event.type === "approval.resolved") setStatus(id, "working");
    if (event.type === "session.error") failed = true;
    transcript.apply(id, event);
  };

  try {
    await runtimeFor(session.provider).send({
      sessionId: id,
      cwd,
      model: session.model,
      name: session.name,
      description: session.description,
      autonomy: session.autonomy,
      resume: session.providerSessionId,
      text,
      ...(files.length > 0 ? { files: files.map((file) => file.path) } : {}),
      onEvent,
    });
  } catch (error) {
    failed = true;
    transcript.apply(id, {
      type: "session.error",
      message: error instanceof Error ? error.message : String(error),
    });
  } finally {
    transcript.setWorking(id, false);
    transcript.settle(id);
    transcript.flush(id);
    setStatus(id, failed ? "error" : foreground === id ? "idle" : "done");
  }
}

export async function stop(session: Session): Promise<void> {
  const id = session.id;
  await runtimeFor(session.provider).cancel(id);
  transcript.settle(id);
  transcript.append(id, newBlock("system", "Stopped"));
  transcript.setWorking(id, false);
  transcript.flush(id);
  setStatus(id, "idle");
}

export function respond(session: Session, requestId: number, decision: ApprovalDecision): void {
  runtimeFor(session.provider).respondApproval(session.id, requestId, decision);
}

/** Session deleted: kill whatever it was running and drop its transcript cache. */
export async function dispose(id: string): Promise<void> {
  await stopEverywhere(id);
  transcript.forget(id);
  statuses.delete(id);
}

function setStatus(id: string, status: SessionStatus): void {
  if (statuses.get(id) === status) return;
  statuses.set(id, status);
  patch(id, { status });
  void api.setSessionStatus(id, status).catch(() => {});
}

function patch(id: string, change: SessionPatch): void {
  for (const listener of patchListeners) listener(id, change);
}
