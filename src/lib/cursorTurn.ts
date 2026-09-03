import { killAgent, resolveBinary, spawnAgent, watchAgent } from "./agent";
import type { ApprovalDecision, HarnessEvent } from "./blocks";
import {
  assistantDeltaText,
  buildCursorSpawnArgs,
  parseJsonLine,
  parseToolCall,
  personaPrompt,
  withPersona,
  sessionIdFromEvent,
  stringField,
  toolStatus,
  turnFailed,
  turnUsage,
  withAttachedFiles,
} from "./providers/cursor";
import type { ProviderRuntime, TurnInput } from "./providers/runtime";

const STDERR_TAIL = 12;

type Live = {
  cwd: string;
  onEvent: (event: HarnessEvent) => void;
  cancelled: boolean;
  settled: boolean;
  sawText: boolean;
  turnDone: (() => void) | null;
  seenTools: Set<string>;
  stderr: string[];
  unwatch: (() => void) | null;
};

const liveByThread = new Map<string, Live>();
const resumeByThread = new Map<string, { chatId: string; cwd: string }>();
const turns = new Map<string, Promise<void>>();

export const cursorRuntime: ProviderRuntime = {
  send: sendTurn,
  cancel: abortTurn,
  stop: abortTurn,
  respondApproval: (_sessionId: string, _requestId: number, _decision: ApprovalDecision) => undefined,
  isLive: (sessionId) => liveByThread.has(sessionId),
};

async function sendTurn(input: TurnInput): Promise<void> {
  const previous = turns.get(input.sessionId) ?? Promise.resolve();
  const current = previous.catch(() => undefined).then(() => runTurn(input));
  turns.set(input.sessionId, current);
  try {
    await current;
  } finally {
    if (turns.get(input.sessionId) === current) turns.delete(input.sessionId);
  }
}

async function abortTurn(sessionId: string): Promise<void> {
  const live = liveByThread.get(sessionId);
  if (live) {
    live.cancelled = true;
    finishTurn(sessionId, live, [{ type: "message.completed" }]);
  }
  await killAgent(sessionId).catch(() => undefined);
}

async function runTurn(input: TurnInput): Promise<void> {
  // A transcript belongs to the directory it was recorded in; after a move the
  // old chat would resume with paths that no longer exist.
  if (input.fresh) resumeByThread.delete(input.sessionId);
  const stored = resumeByThread.get(input.sessionId);
  const movedAway = stored != null && stored.cwd !== input.cwd;
  const fromInput = input.resume?.trim();
  const resume =
    movedAway || input.fresh ? undefined : (stored?.chatId ?? (fromInput ? fromInput : undefined));
  const model = input.model.trim();

  const live: Live = {
    cwd: input.cwd,
    onEvent: input.onEvent,
    cancelled: false,
    settled: false,
    sawText: false,
    turnDone: null,
    seenTools: new Set(),
    stderr: [],
    unwatch: null,
  };

  live.unwatch = watchAgent(
    input.sessionId,
    (line) => handleLine(input.sessionId, live, line),
    (code) => {
      if (live.settled) return;
      if (live.cancelled) {
        finishTurn(input.sessionId, live, [{ type: "message.completed" }]);
        return;
      }
      live.onEvent({ type: "session.ended", code });
      live.onEvent({ type: "session.error", message: exitMessage(code, live.stderr) });
      finishTurn(input.sessionId, live);
    },
    (line) => {
      live.stderr.push(line);
      if (live.stderr.length > STDERR_TAIL) live.stderr.shift();
    },
  );

  const turnPromise = new Promise<void>((resolve) => {
    live.turnDone = resolve;
  });

  liveByThread.set(input.sessionId, live);
  if (resume) {
    resumeByThread.set(input.sessionId, { chatId: resume, cwd: input.cwd });
    live.onEvent({ type: "session.providerBound", providerSessionId: resume });
  }

  try {
    const { path } = await resolveBinary("cursor-agent").catch(() => {
      throw new Error("Cursor Agent CLI not found. Install the Cursor CLI and run `cursor-agent login`.");
    });
    await spawnAgent(
      input.sessionId,
      path,
      buildCursorSpawnArgs({
        prompt: withPersona(
          withAttachedFiles(input.text.trim(), input.files ?? []),
          resume ? null : personaPrompt(input.name, input.description),
        ),
        autonomy: input.autonomy,
        ...(model ? { model } : {}),
        ...(resume ? { resume } : {}),
      }),
      input.cwd,
    );
    live.onEvent({ type: "session.started" });
    await turnPromise;
  } catch (error) {
    if (live.cancelled) return;
    if (live.settled) return;
    live.onEvent({
      type: "session.error",
      message: error instanceof Error ? error.message : String(error),
    });
    finishTurn(input.sessionId, live);
  } finally {
    live.unwatch?.();
    live.unwatch = null;
    if (liveByThread.get(input.sessionId) === live) liveByThread.delete(input.sessionId);
    await killAgent(input.sessionId).catch(() => undefined);
  }
}

function handleLine(sessionId: string, live: Live, line: string): void {
  const rec = parseJsonLine(line);
  if (!rec) return;

  const chatId = sessionIdFromEvent(rec);
  if (chatId && resumeByThread.get(sessionId)?.chatId !== chatId) {
    resumeByThread.set(sessionId, { chatId, cwd: live.cwd });
    live.onEvent({ type: "session.providerBound", providerSessionId: chatId });
  }

  if (live.settled || live.cancelled) return;

  const type = stringField(rec, "type");
  if (type === "assistant") {
    const text = assistantDeltaText(rec);
    if (!text) return;
    live.sawText = true;
    live.onEvent({ type: "message.delta", text });
    return;
  }
  if (type === "tool_call") {
    handleTool(live, rec);
    return;
  }
  if (type === "result") handleResult(sessionId, live, rec);
}

function handleTool(live: Live, rec: Record<string, unknown>): void {
  const call = parseToolCall(rec);
  if (!call) return;
  if (!live.seenTools.has(call.callId)) {
    live.seenTools.add(call.callId);
    live.onEvent({ type: "tool.started", callId: call.callId, name: call.name, title: call.title });
  }
  if (call.phase !== "completed") return;
  live.onEvent({ type: "tool.updated", callId: call.callId, status: toolStatus(call.failed) });
}

function handleResult(sessionId: string, live: Live, rec: Record<string, unknown>): void {
  const error = turnFailed(rec);
  if (error) live.onEvent({ type: "session.error", message: error });
  const fallback = stringField(rec, "result");
  if (!live.sawText && fallback && !error) {
    live.sawText = true;
    live.onEvent({ type: "message.delta", text: fallback });
  }
  finishTurn(sessionId, live, [{ type: "message.completed" }, { type: "turn.completed", usage: turnUsage(rec) }]);
}

function finishTurn(sessionId: string, live: Live, extra: HarnessEvent[] = []): void {
  if (live.settled) return;
  live.settled = true;
  if (liveByThread.get(sessionId) === live) liveByThread.delete(sessionId);
  for (const event of extra) live.onEvent(event);
  const done = live.turnDone;
  live.turnDone = null;
  done?.();
}

function exitMessage(code: number | null, stderr: string[]): string {
  const tail = stderr.join("\n").trim();
  const head = code === null ? "Cursor Agent stopped" : `Cursor Agent exited with code ${code}`;
  return tail ? `${head}.\n${tail}` : `${head}.`;
}
