import { listen } from "@tauri-apps/api/event";
import * as api from "./api";

type LinesPayload = { sessionId: string; lines: string[] };
type ExitPayload = { sessionId: string; code: number | null; pid: number };

type LineHandler = (line: string) => void;
type ExitHandler = (code: number | null) => void;

const stdout = new Map<string, LineHandler>();
const stderr = new Map<string, LineHandler>();
const exits = new Map<string, ExitHandler>();
const stdoutBuf = new Map<string, string[]>();
const stderrBuf = new Map<string, string[]>();
const MAX_BUFFERED = 1000;

let bridge: Promise<Array<() => void>> | null = null;
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
  const handler = handlers.get(sessionId);
  if (handler) for (const line of lines) handler(line);
  else push(buffer, sessionId, lines);
}

function ensureBridge() {
  if (bridge) return;
  bridge = Promise.all([
    listen<LinesPayload>("agent-stdout", (event) => deliver(stdout, stdoutBuf, event.payload)),
    listen<LinesPayload>("agent-stderr", (event) => deliver(stderr, stderrBuf, event.payload)),
    listen<ExitPayload>("agent-exit", (event) => {
      exits.get(event.payload.sessionId)?.(event.payload.code);
    }),
  ]);
}

/**
 * Subscribe before spawn. `listen` resolves late; lines that arrive first sit
 * in the buffer until the handler is registered.
 */
export function watchAgent(
  sessionId: string,
  onLine: LineHandler,
  onExit: ExitHandler,
  onStderr?: LineHandler,
): () => void {
  users += 1;
  ensureBridge();
  stdout.set(sessionId, onLine);
  exits.set(sessionId, onExit);
  if (onStderr) stderr.set(sessionId, onStderr);
  flush(stdoutBuf, stdout, sessionId);
  if (onStderr) flush(stderrBuf, stderr, sessionId);
  return () => {
    stdout.delete(sessionId);
    stderr.delete(sessionId);
    exits.delete(sessionId);
    users -= 1;
    if (users === 0) {
      void bridge?.then((stops) => {
        for (const stop of stops) stop();
      });
      bridge = null;
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
