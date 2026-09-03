import { closeAgentStdin, killAgent, resolveBinary, spawnAgent, watchAgent } from "./agent";
import type { HarnessEvent } from "./blocks";
import {
  agentMessageText,
  buildCodexPrompt,
  buildCodexSpawnArgs,
  completedToolStatus,
  itemErrorMessage,
  itemFromEvent,
  isToolItem,
  parseJsonLine,
  streamErrorMessage,
  stringField,
  threadIdFromEvent,
  toolCallId,
  toolLabel,
  toolName,
  turnUsage,
} from "./providers/codex";
import type { ProviderRuntime, TurnInput } from "./providers/runtime";

const STDERR_TAIL = 12;

type Live = {
  cwd: string;
  onEvent: (event: HarnessEvent) => void;
  cancelled: boolean;
  turnDone: (() => void) | null;
  turnFailed: ((error: Error) => void) | null;
  activeTurn: boolean;
  emittedAssistant: string;
  seenTools: Set<string>;
  stderr: string[];
  unwatch: (() => void) | null;
};

const liveBySession = new Map<string, Live>();
const resumeBySession = new Map<string, { threadId: string; cwd: string }>();

export const codexRuntime: ProviderRuntime = {
  send: sendTurn,
  cancel: cancelTurn,
  stop: stopSession,
  respondApproval: () => undefined,
  respondQuestion: () => undefined,
  isLive: (sessionId) => liveBySession.has(sessionId),
};

async function cancelTurn(sessionId: string): Promise<void> {
  const live = liveBySession.get(sessionId);
  if (!live) {
    await killAgent(sessionId).catch(() => undefined);
    return;
  }
  live.cancelled = true;
  finishTurn(live, [{ type: "message.completed" }]);
  detach(sessionId, live);
  await killAgent(sessionId).catch(() => undefined);
}

async function stopSession(sessionId: string): Promise<void> {
  await cancelTurn(sessionId);
}

function detach(sessionId: string, live: Live): void {
  if (liveBySession.get(sessionId) === live) liveBySession.delete(sessionId);
  live.unwatch?.();
  live.unwatch = null;
}

async function sendTurn(input: TurnInput): Promise<void> {
  if (liveBySession.has(input.sessionId)) await stopSession(input.sessionId);

  if (input.fresh) resumeBySession.delete(input.sessionId);
  const stored = resumeBySession.get(input.sessionId);
  const movedAway = stored != null && stored.cwd !== input.cwd;
  const fromInput = input.resume?.trim();
  const resume =
    movedAway || input.fresh ? undefined : (stored?.threadId ?? (fromInput ? fromInput : undefined));
  const model = input.model.trim() || undefined;

  const live: Live = {
    cwd: input.cwd,
    onEvent: input.onEvent,
    cancelled: false,
    turnDone: null,
    turnFailed: null,
    activeTurn: false,
    emittedAssistant: "",
    seenTools: new Set(),
    stderr: [],
    unwatch: null,
  };

  live.unwatch = watchAgent(
    input.sessionId,
    (line) => handleLine(input.sessionId, live, line),
    (code) => {
      if (live.cancelled) {
        detach(input.sessionId, live);
        return;
      }
      const mid = live.activeTurn;
      detach(input.sessionId, live);
      if (mid) {
        live.onEvent({ type: "session.ended", code });
        live.turnFailed?.(new Error(exitMessage(code, live.stderr)));
      }
    },
    (line) => {
      live.stderr.push(line);
      if (live.stderr.length > STDERR_TAIL) live.stderr.shift();
    },
  );

  const turnPromise = new Promise<void>((resolve, reject) => {
    live.turnDone = resolve;
    live.turnFailed = reject;
  });
  live.activeTurn = true;
  liveBySession.set(input.sessionId, live);

  try {
    const { path } = await resolveBinary("codex").catch(() => {
      throw new Error(
        "Codex CLI not found. Install it from https://github.com/openai/codex and run `codex login`.",
      );
    });
    // The thread already carries the persona after the first turn; resending it is paid twice.
    const prompt = buildCodexPrompt(
      resume ? "" : input.name,
      resume ? "" : input.description,
      input.text,
      input.files ?? [],
      resume === undefined,
    );
    await spawnAgent(
      input.sessionId,
      path,
      buildCodexSpawnArgs({
        prompt,
        autonomy: input.autonomy,
        cwd: input.cwd,
        ...(model ? { model } : {}),
        ...(resume ? { resume } : {}),
      }),
      input.cwd,
    );
    // Piped stdin stays open; exec then waits to append a `<stdin>` block.
    await closeAgentStdin(input.sessionId).catch(() => undefined);
    if (resume) bindThread(input.sessionId, live, resume);
    live.onEvent({ type: "session.started" });
    await turnPromise;
  } catch (error) {
    if (live.cancelled) return;
    live.onEvent({
      type: "session.error",
      message: error instanceof Error ? error.message : String(error),
    });
    throw error;
  } finally {
    live.activeTurn = false;
    live.turnDone = null;
    live.turnFailed = null;
    detach(input.sessionId, live);
  }
}

function handleLine(sessionId: string, live: Live, line: string): void {
  const rec = parseJsonLine(line);
  if (!rec) return;

  const threadId = threadIdFromEvent(rec);
  if (threadId) bindThread(sessionId, live, threadId);

  const fatal = streamErrorMessage(rec);
  if (fatal && !live.cancelled) live.onEvent({ type: "session.error", message: fatal });

  const type = stringField(rec, "type");
  if (type === "turn.completed") {
    const usage = turnUsage(rec);
    finishTurn(live, [
      { type: "message.completed" },
      usage ? { type: "turn.completed", usage } : { type: "turn.completed" },
    ]);
    return;
  }
  if (type === "turn.failed") {
    finishTurn(live, [{ type: "message.completed" }, { type: "turn.completed" }]);
    return;
  }

  const item = itemFromEvent(rec);
  if (!item || live.cancelled) return;

  const itemError = itemErrorMessage(item);
  if (itemError) {
    live.onEvent({ type: "session.note", message: itemError });
    return;
  }

  const text = agentMessageText(item);
  if (text !== null) {
    handleAgentText(live, text, type === "item.completed");
    return;
  }

  if (!isToolItem(item)) return;
  emitTool(live, item, type === "item.completed");
}

function handleAgentText(live: Live, text: string, completed: boolean): void {
  if (live.emittedAssistant && text !== live.emittedAssistant && !text.startsWith(live.emittedAssistant)) {
    live.onEvent({ type: "message.completed" });
    live.emittedAssistant = "";
  }
  if (text.startsWith(live.emittedAssistant)) {
    const extra = text.slice(live.emittedAssistant.length);
    if (extra) {
      live.emittedAssistant = text;
      live.onEvent({ type: "message.delta", text: extra });
    }
  } else if (text) {
    live.emittedAssistant = text;
    live.onEvent({ type: "message.delta", text });
  }
  if (completed) {
    live.onEvent({ type: "message.completed" });
    live.emittedAssistant = "";
  }
}

function emitTool(live: Live, item: Record<string, unknown>, completed: boolean): void {
  const callId = toolCallId(item);
  if (!callId) return;
  const title = toolLabel(item);
  if (!live.seenTools.has(callId)) {
    live.seenTools.add(callId);
    live.onEvent({ type: "tool.started", callId, name: toolName(item), title });
  } else {
    live.onEvent({ type: "tool.updated", callId, title });
  }
  if (completed) live.onEvent({ type: "tool.updated", callId, status: completedToolStatus(item) });
}

function bindThread(sessionId: string, live: Live, threadId: string): void {
  const prev = resumeBySession.get(sessionId);
  if (prev?.threadId === threadId && prev.cwd === live.cwd) return;
  resumeBySession.set(sessionId, { threadId, cwd: live.cwd });
  live.onEvent({ type: "session.providerBound", providerSessionId: threadId });
}

function finishTurn(live: Live, extra: HarnessEvent[] = []): void {
  if (!live.activeTurn) return;
  live.activeTurn = false;
  for (const event of extra) live.onEvent(event);
  const done = live.turnDone;
  live.turnDone = null;
  live.turnFailed = null;
  done?.();
}

function exitMessage(code: number | null, stderr: string[]): string {
  const tail = stderr.join("\n").trim();
  const head = code === null ? "Codex stopped" : `Codex exited with code ${code}`;
  return tail ? `${head}.\n${tail}` : `${head}.`;
}
