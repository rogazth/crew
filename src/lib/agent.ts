import * as api from "./api";
import { client } from "./client";

type LinesPayload = { sessionId: string; lines: string[] };
type ExitPayload = { sessionId: string; code: number | null; pid: number };

type LineHandler = (line: string) => void;
type ExitHandler = (code: number | null) => void;

const stdout = new Map<string, LineHandler>();
const stderr = new Map<string, LineHandler>();
const exits = new Map<string, ExitHandler>();
const stdoutBuf = new Map<string, string[]>();
const stderrBuf = new Map<string, string[]>();
const exitBuf = new Map<string, ExitPayload>();
const seenLive = new Set<string>();
const MAX_BUFFERED = 1000;

let stops: Array<() => void> | null = null;
let users = 0;

function push(map: Map<string, string[]>, sessionId: string, lines: string[]) {
  const queued = map.get(sessionId) ?? [];
  queued.push(...lines);
  if (queued.length > MAX_BUFFERED) queued.splice(0, queued.length - MAX_BUFFERED);
  map.set(sessionId, queued);
}

function flush(map: Map<string, string[]>, handlers: Map<string, LineHandler>, sessionId: string) {
  const queued = map.get(sessionId);
  const handler = handlers.get(sessionId);
  if (!queued || !handler) return;
  map.delete(sessionId);
  for (const line of queued) handler(line);
}

function deliver(
  handlers: Map<string, LineHandler>,
  buffer: Map<string, string[]>,
  { sessionId, lines }: LinesPayload,
) {
  seenLive.add(sessionId);
  const handler = handlers.get(sessionId);
  if (handler) for (const line of lines) handler(line);
  else push(buffer, sessionId, lines);
}

function deliverExit(event: ExitPayload) {
  seenLive.delete(event.sessionId);
  const handler = exits.get(event.sessionId);
  if (handler) handler(event.code);
  else exitBuf.set(event.sessionId, event);
}

function recoverExits() {
  void client
    .request<string[]>("agent_running")
    .then((running) => {
      const live = new Set(running);
      for (const sessionId of [...exits.keys()]) {
        if (live.has(sessionId) || !seenLive.has(sessionId)) continue;
        deliverExit({ sessionId, code: null, pid: 0 });
      }
    })
    .catch(() => {});
}

function ensureBridge() {
  if (stops) return;
  stops = [
    client.on("agent-stdout", (payload) => deliver(stdout, stdoutBuf, payload as LinesPayload)),
    client.on("agent-stderr", (payload) => deliver(stderr, stderrBuf, payload as LinesPayload)),
    client.on("agent-exit", (payload) => deliverExit(payload as ExitPayload)),
    client.onReconnect(recoverExits),
  ];
}

/**
 * Subscribe before spawn. Lines that arrive first sit in the buffer until the
 * handler is registered.
 */
export function watchAgent(
  sessionId: string,
  onLine: LineHandler,
  onExit: ExitHandler,
  onStderr?: LineHandler,
): () => void {
  users += 1;
  ensureBridge();
  seenLive.delete(sessionId);
  stdout.set(sessionId, onLine);
  exits.set(sessionId, onExit);
  if (onStderr) stderr.set(sessionId, onStderr);
  flush(stdoutBuf, stdout, sessionId);
  if (onStderr) flush(stderrBuf, stderr, sessionId);
  const queuedExit = exitBuf.get(sessionId);
  if (queuedExit) {
    exitBuf.delete(sessionId);
    onExit(queuedExit.code);
  }
  return () => {
    stdout.delete(sessionId);
    stderr.delete(sessionId);
    exits.delete(sessionId);
    users -= 1;
    if (users === 0) {
      for (const stop of stops ?? []) stop();
      stops = null;
    }
  };
}

export const resolveBinary = api.resolveBinary;
export const spawnAgent = api.spawnAgent;
export const writeAgent = api.writeAgent;
export const closeAgentStdin = api.closeAgentStdin;
export const killAgent = api.killAgent;

export function writeJson(sessionId: string, value: unknown): Promise<void> {
  return writeAgent(sessionId, JSON.stringify(value));
}
