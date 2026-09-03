import { killAgent, resolveBinary, spawnAgent, watchAgent, writeJson } from "./agent";
import type { ApprovalDecision, HarnessEvent } from "./blocks";
import {
  assistantTextBlocks,
  assistantToolUses,
  buildClaudeSpawnArgs,
  buildClaudeUserMessage,
  buildControlRequest,
  buildControlResponse,
  inputJsonDeltaFromEvent,
  isCompactBoundary,
  isMessageStart,
  isSubagentMessage,
  parseControlCancelId,
  parseControlRequest,
  parseJsonLine,
  personaPrompt,
  sessionIdFromMessage,
  streamTextDelta,
  stringField,
  toPermissionResult,
  toolLabel,
  toolResultsFromUserMessage,
  toolStartFromEvent,
  tryParseJsonRecord,
  turnFailed,
  turnUsage,
  type ClaudeControlRequest,
} from "./providers/claude";
import type { ProviderRuntime, TurnInput } from "./providers/runtime";

const INIT_TIMEOUT_MS = 15_000;
/** After an interrupt, how long to let claude write its own `result` before the kill. */
const INTERRUPT_GRACE_MS = 1_500;
/** A parked `claude` is a node process holding a couple hundred MB; resume is a few seconds. */
const IDLE_KILL_MS = 10 * 60_000;
const STDERR_TAIL = 12;

type PendingApproval = {
  requestId: string;
  input: Record<string, unknown>;
  resolve: (decision: ApprovalDecision | "cancelled") => void;
};

type InFlightTool = {
  id: string;
  name: string;
  input: Record<string, unknown>;
  partialJson: string;
};

type Live = {
  cwd: string;
  autonomy: TurnInput["autonomy"];
  model: string;
  claudeSessionId: string;
  onEvent: (event: HarnessEvent) => void;
  approvals: Map<number, PendingApproval>;
  nextApprovalUiId: number;
  nextControlId: number;
  toolsByIndex: Map<number, InFlightTool>;
  toolsById: Map<string, InFlightTool>;
  cancelled: boolean;
  muteUpdates: boolean;
  turns: Promise<void>;
  turnDone: (() => void) | null;
  turnFailed: ((error: Error) => void) | null;
  activeTurn: boolean;
  initDone: (() => void) | null;
  initialized: boolean;
  emittedAssistant: string;
  stderr: string[];
  idleTimer: number | null;
  unwatch: (() => void) | null;
};

const liveByThread = new Map<string, Live>();
const resumeByThread = new Map<string, { sessionId: string; cwd: string }>();

export const claudeRuntime: ProviderRuntime = {
  send: sendTurn,
  cancel: cancelTurn,
  stop: stopSession,
  respondApproval,
  isLive: (sessionId) => liveByThread.has(sessionId),
};

function respondApproval(sessionId: string, requestId: number, decision: ApprovalDecision): void {
  liveByThread.get(sessionId)?.approvals.get(requestId)?.resolve(decision);
}

async function cancelTurn(sessionId: string): Promise<void> {
  const live = liveByThread.get(sessionId);
  if (!live) {
    await killAgent(sessionId).catch(() => undefined);
    return;
  }
  live.cancelled = true;
  live.muteUpdates = true;
  for (const pending of live.approvals.values()) pending.resolve("deny");
  live.approvals.clear();
  if (live.activeTurn) {
    const settled = new Promise<void>((resolve) => {
      const previous = live.turnDone;
      live.turnDone = () => {
        previous?.();
        resolve();
      };
      window.setTimeout(resolve, INTERRUPT_GRACE_MS);
    });
    await writeJson(sessionId, buildControlRequest(nextControlId(live), { subtype: "interrupt" })).catch(
      () => undefined,
    );
    await settled;
  }
  finishTurn(live, [{ type: "message.completed" }]);
  detach(sessionId, live);
  await killAgent(sessionId).catch(() => undefined);
}

async function stopSession(sessionId: string): Promise<void> {
  const live = liveByThread.get(sessionId);
  if (live) {
    live.muteUpdates = true;
    for (const pending of live.approvals.values()) pending.resolve("deny");
    live.approvals.clear();
    live.activeTurn = false;
    live.turnDone?.();
    live.turnDone = null;
    live.turnFailed = null;
    live.initDone?.();
    live.initDone = null;
    detach(sessionId, live);
  }
  await killAgent(sessionId).catch(() => undefined);
}

function detach(sessionId: string, live: Live): void {
  if (liveByThread.get(sessionId) === live) liveByThread.delete(sessionId);
  clearIdle(live);
  live.unwatch?.();
  live.unwatch = null;
}

async function sendTurn(input: TurnInput): Promise<void> {
  const live = await ensureLive(input);
  live.onEvent = input.onEvent;
  clearIdle(live);
  live.turns = live.turns.catch(() => undefined).then(async () => {
    live.cancelled = false;
    live.muteUpdates = false;
    try {
      await runTurn(live, input);
    } catch (error) {
      if (live.cancelled) return;
      throw error;
    } finally {
      scheduleIdle(input.sessionId, live);
    }
  });
  await live.turns;
}

async function ensureLive(input: TurnInput): Promise<Live> {
  const existing = liveByThread.get(input.sessionId);
  if (
    existing &&
    existing.cwd === input.cwd &&
    existing.autonomy === input.autonomy &&
    existing.model === input.model
  ) {
    existing.onEvent = input.onEvent;
    return existing;
  }
  if (existing) await stopSession(input.sessionId);

  // A transcript belongs to the directory it was recorded in; after a move the
  // old session would resume with paths that no longer exist.
  const stored = resumeByThread.get(input.sessionId);
  const movedAway = stored != null && stored.cwd !== input.cwd;
  const resume = movedAway ? undefined : (stored?.sessionId ?? input.resume?.trim() ?? undefined);
  const claudeSessionId = resume || crypto.randomUUID();

  const live: Live = {
    cwd: input.cwd,
    autonomy: input.autonomy,
    model: input.model,
    claudeSessionId,
    onEvent: input.onEvent,
    approvals: new Map(),
    nextApprovalUiId: 1,
    nextControlId: 1,
    toolsByIndex: new Map(),
    toolsById: new Map(),
    cancelled: false,
    muteUpdates: false,
    turns: Promise.resolve(),
    turnDone: null,
    turnFailed: null,
    activeTurn: false,
    initDone: null,
    initialized: false,
    emittedAssistant: "",
    stderr: [],
    idleTimer: null,
    unwatch: null,
  };

  live.unwatch = watchAgent(
    input.sessionId,
    (line) => handleLine(input.sessionId, live, line),
    (code) => {
      const mid = live.activeTurn;
      detach(input.sessionId, live);
      if (mid && !live.cancelled) {
        live.onEvent({ type: "session.ended", code });
        live.turnFailed?.(new Error(exitMessage(code, live.stderr)));
      }
      live.initDone?.();
      live.turnDone = null;
      live.turnFailed = null;
      live.initDone = null;
    },
    (line) => {
      live.stderr.push(line);
      if (live.stderr.length > STDERR_TAIL) live.stderr.shift();
    },
  );

  try {
    const { path } = await resolveBinary("claude").catch(() => {
      throw new Error(
        "Claude Code CLI not found. Install it from https://claude.com/product/claude-code and run `claude auth login`.",
      );
    });
    const spawn = {
      model: input.model,
      autonomy: input.autonomy,
      systemPrompt: personaPrompt(input.name, input.description),
      ...(resume ? { resume } : { sessionId: claudeSessionId }),
    };
    await spawnAgent(input.sessionId, path, buildClaudeSpawnArgs(spawn), input.cwd);
    liveByThread.set(input.sessionId, live);
    resumeByThread.set(input.sessionId, { sessionId: claudeSessionId, cwd: input.cwd });

    await writeJson(input.sessionId, buildControlRequest(nextControlId(live), { subtype: "initialize" }));
    await waitForInit(live);
    live.onEvent({ type: "session.providerBound", providerSessionId: live.claudeSessionId });
    live.onEvent({ type: "session.started" });
    return live;
  } catch (error) {
    detach(input.sessionId, live);
    await killAgent(input.sessionId).catch(() => undefined);
    throw error;
  }
}

async function runTurn(live: Live, input: TurnInput): Promise<void> {
  live.emittedAssistant = "";
  live.toolsByIndex.clear();
  live.toolsById.clear();

  const turnPromise = new Promise<void>((resolve, reject) => {
    live.turnDone = resolve;
    live.turnFailed = reject;
  });
  live.activeTurn = true;

  try {
    await writeJson(
      input.sessionId,
      buildClaudeUserMessage(live.claudeSessionId, input.text.trim(), input.files ?? []),
    );
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
  }
}

function handleLine(sessionId: string, live: Live, line: string): void {
  const rec = parseJsonLine(line);
  if (!rec || stringField(rec, "type") === "keep_alive") return;

  const cancelId = parseControlCancelId(rec);
  if (cancelId) {
    for (const [uiId, pending] of live.approvals) {
      if (pending.requestId === cancelId) {
        pending.resolve("cancelled");
        live.approvals.delete(uiId);
      }
    }
    return;
  }

  const control = parseControlRequest(rec);
  if (control) {
    void handleControl(sessionId, live, control);
    return;
  }

  if (live.muteUpdates) return;

  const fromLine = sessionIdFromMessage(rec);
  if (fromLine && fromLine !== live.claudeSessionId) {
    live.claudeSessionId = fromLine;
    resumeByThread.set(sessionId, { sessionId: fromLine, cwd: live.cwd });
    live.onEvent({ type: "session.providerBound", providerSessionId: fromLine });
  }

  const type = stringField(rec, "type");
  const subtype = stringField(rec, "subtype");
  if (
    type === "control_response" ||
    (type === "system" && (subtype === "init" || subtype === "initialized"))
  ) {
    markInitialized(live);
    return;
  }

  if (isCompactBoundary(rec)) {
    live.onEvent({ type: "session.note", message: "Context compacted" });
    return;
  }
  if (type === "stream_event") {
    handleStream(live, rec);
    return;
  }
  if (type === "assistant") {
    handleAssistant(live, rec);
    return;
  }
  if (type === "user") {
    handleUser(live, rec);
    return;
  }
  if (type === "result") {
    const error = turnFailed(rec);
    if (error && !live.cancelled) live.onEvent({ type: "session.error", message: error });
    finishTurn(live, [{ type: "turn.completed", usage: turnUsage(rec) }]);
  }
}

function handleStream(live: Live, rec: Record<string, unknown>): void {
  if (isSubagentMessage(rec)) return;
  // Each API message starts its own text; the running total belongs to the last one.
  if (isMessageStart(rec)) {
    live.emittedAssistant = "";
    return;
  }
  const text = streamTextDelta(rec);
  if (text) {
    live.emittedAssistant += text;
    live.onEvent({ type: "message.delta", text });
    return;
  }

  const started = toolStartFromEvent(rec);
  if (started) {
    const tool: InFlightTool = { id: started.id, name: started.name, input: started.input, partialJson: "" };
    if (started.index >= 0) live.toolsByIndex.set(started.index, tool);
    live.toolsById.set(started.id, tool);
    live.onEvent({
      type: "tool.started",
      callId: tool.id,
      name: tool.name,
      title: toolLabel(tool.name, tool.input),
    });
    return;
  }

  const jsonDelta = inputJsonDeltaFromEvent(rec);
  if (!jsonDelta) return;
  const tool = live.toolsByIndex.get(jsonDelta.index);
  if (!tool) return;
  tool.partialJson += jsonDelta.partial;
  const parsed = tryParseJsonRecord(tool.partialJson);
  if (!parsed) return;
  tool.input = parsed;
  live.onEvent({ type: "tool.updated", callId: tool.id, title: toolLabel(tool.name, parsed) });
}

function handleAssistant(live: Live, rec: Record<string, unknown>): void {
  if (isSubagentMessage(rec)) return;
  const snapshot = assistantTextBlocks(rec);
  if (snapshot.startsWith(live.emittedAssistant)) {
    if (snapshot.length > live.emittedAssistant.length) {
      const extra = snapshot.slice(live.emittedAssistant.length);
      live.emittedAssistant = snapshot;
      live.onEvent({ type: "message.delta", text: extra });
    }
  } else if (snapshot) {
    // Without partial messages this is the first sight of a later message.
    live.onEvent({ type: "message.completed" });
    live.emittedAssistant = snapshot;
    live.onEvent({ type: "message.delta", text: snapshot });
  }
  for (const use of assistantToolUses(rec)) {
    if (live.toolsById.has(use.id)) continue;
    live.toolsById.set(use.id, { id: use.id, name: use.name, input: use.input, partialJson: "" });
    live.onEvent({
      type: "tool.started",
      callId: use.id,
      name: use.name,
      title: toolLabel(use.name, use.input),
    });
  }
}

function handleUser(live: Live, rec: Record<string, unknown>): void {
  for (const result of toolResultsFromUserMessage(rec)) {
    live.onEvent({
      type: "tool.updated",
      callId: result.toolUseId,
      status: result.isError ? "failed" : "completed",
    });
  }
}

async function handleControl(
  sessionId: string,
  live: Live,
  control: ClaudeControlRequest,
): Promise<void> {
  if (control.subtype !== "can_use_tool" && control.subtype !== "permission") {
    await writeJson(sessionId, buildControlResponse(control.requestId, {})).catch(() => undefined);
    return;
  }

  const input = control.input;
  if (live.cancelled || live.muteUpdates) {
    await writeJson(
      sessionId,
      buildControlResponse(control.requestId, toPermissionResult("deny", input)),
    ).catch(() => undefined);
    return;
  }

  const uiId = live.nextApprovalUiId++;
  live.onEvent({
    type: "approval.requested",
    requestId: uiId,
    name: control.toolName ?? "tool",
    title: toolLabel(control.toolName ?? "tool", input),
  });
  const decision = await new Promise<ApprovalDecision | "cancelled">((resolve) => {
    live.approvals.set(uiId, { requestId: control.requestId, input, resolve });
  });
  live.approvals.delete(uiId);
  live.onEvent({ type: "approval.resolved", requestId: uiId, decision });
  if (decision === "cancelled") return;
  await writeJson(
    sessionId,
    buildControlResponse(control.requestId, toPermissionResult(decision, input)),
  ).catch(() => undefined);
}

function finishTurn(live: Live, extra: HarnessEvent[] = []): void {
  live.activeTurn = false;
  for (const event of extra) live.onEvent(event);
  const done = live.turnDone;
  live.turnDone = null;
  live.turnFailed = null;
  done?.();
}

function scheduleIdle(sessionId: string, live: Live): void {
  clearIdle(live);
  live.idleTimer = window.setTimeout(() => {
    live.idleTimer = null;
    if (live.activeTurn || liveByThread.get(sessionId) !== live) return;
    void stopSession(sessionId);
  }, IDLE_KILL_MS);
}

function clearIdle(live: Live): void {
  if (live.idleTimer === null) return;
  window.clearTimeout(live.idleTimer);
  live.idleTimer = null;
}

function exitMessage(code: number | null, stderr: string[]): string {
  const tail = stderr.join("\n").trim();
  const head = code === null ? "Claude Code stopped" : `Claude Code exited with code ${code}`;
  return tail ? `${head}.\n${tail}` : `${head}.`;
}

function markInitialized(live: Live): void {
  if (live.initialized) return;
  live.initialized = true;
  live.initDone?.();
  live.initDone = null;
}

function waitForInit(live: Live): Promise<void> {
  if (live.initialized) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => {
      live.initDone = null;
      const tail = live.stderr.join("\n").trim();
      reject(new Error(tail ? `Claude Code did not start.\n${tail}` : "Claude Code did not answer in time."));
    }, INIT_TIMEOUT_MS);
    live.initDone = () => {
      window.clearTimeout(timer);
      if (live.initialized) resolve();
      else reject(new Error(exitMessage(null, live.stderr)));
    };
  });
}

function nextControlId(live: Live): string {
  return `ctrl-${live.nextControlId++}`;
}
