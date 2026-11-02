/**
 * The window's side of the trace. An event goes to Electron main over IPC (the
 * preload's `crewHost.trace`), which writes it to `<data>/trace/app.ndjson`
 * beside crewd's own files; `crew trace` merges them. It does not go over the
 * WebSocket: that socket may be the very thing that is failing.
 *
 * Imported by both sides, so it stays free of DOM and Electron. What is
 * recorded: ids, kinds, durations, sizes, counts, status names and error text.
 * Never a prompt, a reply, terminal input or output, request params, file
 * contents, a token or a cookie.
 *
 *     trace.info("socket.closed", { machine, code, retry });
 */

export const TRACE_CHANNELS = { window: "trace:window" } as const;

export type TraceLevel = "DEBUG" | "INFO" | "WARN" | "ERROR";
export type TraceValue = string | number | boolean | null;
export type TraceFields = Record<string, TraceValue | undefined>;
/** One line of `app.ndjson`, less the `target`, which main stamps. */
export type TraceRecord = { timestamp: string; level: TraceLevel; message: string; fields: Record<string, TraceValue> };

/** What the preload hands the window. */
export type TraceHost = { write(records: TraceRecord[]): void };

const MAX_TEXT = 300;
const MAX_FIELDS = 24;
const MAX_KEY = 40;
/** A stack is the one field worth more room: it is how a crash is found. */
const MAX_STACK = 2000;
export const MAX_BATCH = 100;
const LEVELS: readonly string[] = ["DEBUG", "INFO", "WARN", "ERROR"];

/** Values a record can hold: anything else is turned into text and cut. */
export function sanitizeFields(fields: TraceFields | undefined): Record<string, TraceValue> {
  const out: Record<string, TraceValue> = {};
  if (!fields || typeof fields !== "object") return out;
  let count = 0;
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined || key === "message") continue;
    if (++count > MAX_FIELDS) break;
    const name = key.slice(0, MAX_KEY);
    if (typeof value === "number") out[name] = Number.isFinite(value) ? value : null;
    else if (typeof value === "boolean" || value === null) out[name] = value;
    else out[name] = cut(typeof value === "string" ? value : safeString(value), name === "stack" ? MAX_STACK : MAX_TEXT);
  }
  return out;
}

/**
 * An error as a record holds it. A parse error quotes the value it choked on,
 * and that value is the user's, so what sits in quotes goes (as in crewd). One
 * line, cut.
 */
export function errorText(error: unknown): string {
  const text = error instanceof Error ? error.message : typeof error === "string" ? error : safeString(error);
  const line = text.split("\n", 1)[0] ?? "";
  const parse = /^(invalid (type|value|length)|unknown (variant|field)|missing field|expected |trailing)|, expected /.test(line);
  return cut(parse ? line.replace(/"[^"]*"/g, '"…"').replace(/`[^`]*`/g, "`…`") : line);
}

function cut(text: string, max = MAX_TEXT): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function safeString(value: unknown): string {
  try {
    return String(value);
  } catch {
    return "";
  }
}

/** A record main will accept from the window, or null. Main applies the same check to what arrives over IPC. */
export function readRecord(value: unknown): TraceRecord | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  const level = typeof raw.level === "string" && LEVELS.includes(raw.level) ? (raw.level as TraceLevel) : "INFO";
  if (typeof raw.message !== "string" || raw.message === "") return null;
  const stamp = typeof raw.timestamp === "string" && !Number.isNaN(Date.parse(raw.timestamp)) ? raw.timestamp : new Date().toISOString();
  return {
    timestamp: stamp,
    level,
    message: raw.message.slice(0, MAX_KEY * 2),
    fields: sanitizeFields(raw.fields as TraceFields | undefined),
  };
}

export type Trace = {
  debug(message: string, fields?: TraceFields): void;
  info(message: string, fields?: TraceFields): void;
  warn(message: string, fields?: TraceFields): void;
  error(message: string, fields?: TraceFields): void;
  /** Sends what is queued now. */
  flush(): void;
};

export type TraceDeps = {
  /** The preload's bridge, looked up at each event: null in a plain browser, mock mode and tests. */
  host(): TraceHost | null | undefined;
  now?(): Date;
  setTimer?(run: () => void, ms: number): unknown;
  clearTimer?(timer: unknown): void;
  flushMs?: number;
  maxQueue?: number;
};

/** Batches events and hands them to the bridge. It never throws, and does nothing without a bridge. */
export function createTrace(deps: TraceDeps): Trace {
  const now = deps.now ?? (() => new Date());
  const setTimer = deps.setTimer ?? ((run, ms) => setTimeout(run, ms));
  const clearTimer = deps.clearTimer ?? ((timer) => clearTimeout(timer as ReturnType<typeof setTimeout>));
  const flushMs = deps.flushMs ?? 250;
  const maxQueue = deps.maxQueue ?? 500;
  let queue: TraceRecord[] = [];
  let timer: unknown = null;
  let dropped = 0;

  const flush = () => {
    try {
      if (timer !== null) clearTimer(timer);
      timer = null;
      if (queue.length === 0) return;
      const host = deps.host();
      const batch = queue;
      queue = [];
      if (!host) return;
      if (dropped > 0) {
        batch.unshift({ timestamp: now().toISOString(), level: "WARN", message: "trace.dropped", fields: { count: dropped } });
        dropped = 0;
      }
      for (let at = 0; at < batch.length; at += MAX_BATCH) host.write(batch.slice(at, at + MAX_BATCH));
    } catch {
      // A trace is never worth a failure in the window.
    }
  };

  const add = (level: TraceLevel, message: string, fields?: TraceFields) => {
    try {
      if (!deps.host()) return;
      if (queue.length >= maxQueue) {
        queue.shift();
        dropped += 1;
      }
      queue.push({ timestamp: now().toISOString(), level, message: String(message), fields: sanitizeFields(fields) });
      if (level === "ERROR" || queue.length >= MAX_BATCH) flush();
      else if (timer === null) timer = setTimer(flush, flushMs);
    } catch {
      // As above.
    }
  };

  return {
    debug: (message, fields) => add("DEBUG", message, fields),
    info: (message, fields) => add("INFO", message, fields),
    warn: (message, fields) => add("WARN", message, fields),
    error: (message, fields) => add("ERROR", message, fields),
    flush,
  };
}

function bridge(): TraceHost | undefined {
  return typeof window !== "undefined" ? (window as { crewHost?: { trace?: TraceHost } }).crewHost?.trace : undefined;
}

/** The window's trace, through the preload's bridge. */
export const trace: Trace = createTrace({ host: bridge });

/**
 * `window.onerror` and unhandled rejections, and the queue sent when the page
 * goes away. Once, at boot.
 */
export function installWindowTrace(target: Window = window): void {
  try {
    target.addEventListener("error", (event) => {
      trace.error("window.error", {
        error: errorText(event.error ?? event.message),
        file: event.filename ? event.filename.split("/").slice(-1)[0] : undefined,
        line: event.lineno || undefined,
      });
    });
    target.addEventListener("unhandledrejection", (event) => {
      trace.error("window.unhandledrejection", { error: errorText(event.reason) });
    });
    target.addEventListener("pagehide", () => trace.flush());
    target.document.addEventListener("visibilitychange", () => {
      if (target.document.visibilityState === "hidden") trace.flush();
    });
  } catch {
    // Not a page (a test, a worker): nothing to watch.
  }
}
