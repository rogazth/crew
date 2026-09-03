import { killAgent, resolveClaude, spawnAgent, watchAgent, writeJson } from "./agent";
import type { ApprovalDecision, HarnessEvent } from "./blocks";
import {
  assistantTextBlocks,
  assistantToolUses,
  buildClaudeSpawnArgs,
  buildClaudeUserMessage,
  buildControlRequest,
  buildControlResponse,
  inputJsonDeltaFromEvent,
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
  type ClaudeControlRequest,
} from "./providers/claude";

const INIT_TIMEOUT_MS = 8_000;

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
  unwatch: (() => void) | null;
};

export type SendTurnInput = {
  sessionId: string;
  cwd: string;
  model: string;
  name: string;
  description: string;
  resume?: string | null;
  text: string;
  files?: string[];
  onEvent: (event: HarnessEvent) => void;
};

const liveByThread = new Map<string, Live>();
const resumeByThread = new Map<string, { sessionId: string; cwd: string }>();

export function bindClaudeSession(threadId: string, providerSessionId: string, cwd: string): void {
  const sessionId = providerSessionId.trim();
  if (!threadId || !sessionId || !cwd.trim()) return;
  resumeByThread.set(threadId, { sessionId, cwd });
}

export function respondApproval(
  sessionId: string,
  requestId: number,
  decision: ApprovalDecision,
): void {
  liveByThread.get(sessionId)?.approvals.get(requestId)?.resolve(decision);
}

export async function cancelTurn(sessionId: string): Promise<void> {
  const live = liveByThread.get(sessionId);
  if (!live) return;
  live.cancelled = true;
  live.muteUpdates = true;
  for (const pending of live.approvals.values()) pending.resolve("deny");
  live.approvals.clear();
  await writeJson(sessionId, buildControlRequest(nextControlId(live), { subtype: "interrupt" })).catch(
    () => undefined,
  );
  finishTurn(live, [{ type: "message.completed" }]);
  liveByThread.delete(sessionId);
  live.unwatch?.();
  live.unwatch = null;
  await killAgent(sessionId).catch(() => undefined);
}

export async function stopSession(sessionId: string): Promise<void> {
  const live = liveByThread.get(sessionId);
  liveByThread.delete(sessionId);
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
    live.unwatch?.();
    live.unwatch = null;
  }
  await killAgent(sessionId).catch(() => undefined);
}

export async function sendTurn(input: SendTurnInput): Promise<void> {
  const live = await ensureLive(input);
  live.onEvent = input.onEvent;
  live.turns = live.turns.catch(() => undefined).then(async () => {
    live.cancelled = false;
    live.muteUpdates = false;
    try {
      await runTurn(live, input);
    } catch (error) {
      if (live.cancelled) return;
      throw error;
    }
  });
  await live.turns;
}

async function ensureLive(input: SendTurnInput): Promise<Live> {
  const existing = liveByThread.get(input.sessionId);
  if (existing && existing.cwd === input.cwd) {
    existing.onEvent = input.onEvent;
    return existing;
  }
  if (existing) await stopSession(input.sessionId);

  const stored = resumeByThread.get(input.sessionId);
  const canResume = stored != null && stored.cwd === input.cwd;
  const resume = canResume ? stored.sessionId : input.resume?.trim() || undefined;
  const claudeSessionId = resume ?? crypto.randomUUID();

  const live: Live = {
    cwd: input.cwd,
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
    unwatch: null,
  };

  live.unwatch = watchAgent(
    input.sessionId,
    (line) => handleLine(input.sessionId, live, line),
    (code) => {
      liveByThread.delete(input.sessionId);
      live.unwatch?.();
      live.unwatch = null;
      live.onEvent({ type: "session.ended", code });
      live.turnFailed?.(new Error("Claude Code exited"));
      live.initDone?.();
      live.turnDone = null;
      live.turnFailed = null;
      live.initDone = null;
    },
  );

  const { path } = await resolveClaude();
  const spawn = resume
    ? { model: input.model, resume, systemPrompt: personaPrompt(input.name, input.description) }
    : {
        model: input.model,
        sessionId: claudeSessionId,
        systemPrompt: personaPrompt(input.name, input.description),
      };
  await spawnAgent(input.sessionId, path, buildClaudeSpawnArgs(spawn), input.cwd);

  liveByThread.set(input.sessionId, live);
  resumeByThread.set(input.sessionId, { sessionId: claudeSessionId, cwd: input.cwd });

  try {
    await writeJson(input.sessionId, buildControlRequest(nextControlId(live), { subtype: "initialize" }));
    await waitForInit(live);
    live.onEvent({ type: "session.providerBound", providerSessionId: live.claudeSessionId });
    live.onEvent({ type: "session.started" });
    return live;
  } catch (error) {
    await stopSession(input.sessionId);
    throw error;
  }
}

async function runTurn(live: Live, input: SendTurnInput): Promise<void> {
  live.emittedAssistant = "";
  live.toolsByIndex.clear();
  live.toolsById.clear();

  const turnPromise = new Promise<void>((resolve, reject) => {
    live.turnDone = resolve;
    live.turnFailed = reject;
  });
  live.activeTurn = true;

  try {
    await writeJson(input.sessionId, buildClaudeUserMessage(input.text.trim(), input.files ?? []));
    await turnPromise;
  } catch (error) {
    if (live.cancelled) return;
    live.onEvent({
      type: "session.error",
      message: error instanceof Error ? error.message : String(error),
    });
    throw error;
  } finally {
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
    finishTurn(live, [{ type: "message.completed" }]);
  }
}

function handleStream(live: Live, rec: Record<string, unknown>): void {
  if (isSubagentMessage(rec)) return;
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
    live.onEvent({ type: "tool.started", callId: tool.id, title: toolLabel(tool.name, tool.input) });
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
  if (snapshot.startsWith(live.emittedAssistant) && snapshot.length > live.emittedAssistant.length) {
    const extra = snapshot.slice(live.emittedAssistant.length);
    live.emittedAssistant = snapshot;
    live.onEvent({ type: "message.delta", text: extra });
  }
  for (const use of assistantToolUses(rec)) {
    if (live.toolsById.has(use.id)) continue;
    live.toolsById.set(use.id, { id: use.id, name: use.name, input: use.input, partialJson: "" });
    live.onEvent({ type: "tool.started", callId: use.id, title: toolLabel(use.name, use.input) });
  }
}

function handleUser(live: Live, rec: Record<string, unknown>): void {
  for (const result of toolResultsFromUserMessage(rec)) {
    if (!live.toolsById.has(result.toolUseId)) continue;
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

function markInitialized(live: Live): void {
  if (live.initialized) return;
  live.initialized = true;
  live.initDone?.();
  live.initDone = null;
}

function waitForInit(live: Live): Promise<void> {
  if (live.initialized) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = window.setTimeout(() => {
      live.initDone = null;
      markInitialized(live);
      resolve();
    }, INIT_TIMEOUT_MS);
    live.initDone = () => {
      window.clearTimeout(timer);
      resolve();
    };
  });
}

function nextControlId(live: Live): string {
  return `ctrl-${live.nextControlId++}`;
}
