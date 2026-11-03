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

/**
 * A machine that stays off is retried every few seconds for as long as it is: the
 * first tries are traced, then one in thirty, so a week away does not fill the file.
 * `attempt` counts from 1 and starts again when the machine comes up.
 */
export function loud(attempt: number): boolean {
  return attempt <= 5 || attempt % 30 === 0;
}

/** Fields that hold what something said when it failed: one line, cut, and without the values a parse error quotes. */
const SAID_KEYS = new Set(["error", "said", "reason"]);

/** The frames of a stack and not its first line, which is the error's message and may quote data. */
function frames(stack: string): string {
  return stack
    .split("\n")
    .filter((line) => /^\s+at /.test(line))
    .join("\n");
}

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
    else {
      const text = typeof value === "string" ? value : safeString(value);
      if (name === "stack") out[name] = cut(frames(text), MAX_STACK);
      else out[name] = SAID_KEYS.has(name) ? errorText(text) : cut(text);
    }
  }
  return out;
}

/** `user@host`, as ssh and git print it: the host is a name, an address or a bracketed one. */
const DESTINATION = /[A-Za-z0-9._+-]+@(?:\[[0-9A-Fa-f:.%]+\]|[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*)/g;

/**
 * An error as a record holds it. A parse error quotes the value it choked on,
 * and that value is the user's, so what sits in quotes goes (as in crewd), and so
 * does any URL, and where ssh or git was asked to go: `user@host`, the host ssh
 * could not reach or resolve, the address it adds to known_hosts. The cause stays.
 * One line, cut: the first that is not an ssh `Warning:` (a first connection prints
 * one before the real error), or the first warning when there is nothing else.
 */
export function errorText(error: unknown): string {
  const text = error instanceof Error ? error.message : typeof error === "string" ? error : safeString(error);
  const lines = text.split("\n");
  const first = lines.find((one) => one.trim() !== "" && !/^\s*Warning:/.test(one)) ?? lines[0] ?? "";
  // An address is not recorded: an error that names the URL it asked ("<url> answered 503") keeps the rest.
  const line = first
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s)"'<>\]]+/gi, "<url>")
    .replace(/(Permanently added )'[^']*'/g, "$1'<host>'")
    .replace(/\b(connect to host |Could not resolve hostname )(\S+?)(?=:\s|\s|$)/g, "$1<host>")
    .replace(DESTINATION, "<destination>");
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

/** A task that held the window's thread this long (ms) is written: the page was frozen for it. */
export const LONG_TASK_MS = 1000;

/**
 * `window.long_task` with its duration, for each task of a second or more. The browser reports
 * every task over 50 ms; only the ones the user would have felt as a freeze are kept.
 */
function watchLongTasks(Observer: typeof PerformanceObserver | undefined): void {
  if (!Observer) return;
  try {
    new Observer((list) => {
      for (const entry of list.getEntries()) {
        if (entry.duration >= LONG_TASK_MS) trace.warn("window.long_task", { duration_ms: Math.round(entry.duration) });
      }
    }).observe({ type: "longtask", buffered: true });
  } catch {
    // A browser without the longtask type: nothing to watch.
  }
}

/**
 * `window.onerror` and unhandled rejections, and the queue sent when the page
 * goes away. Once, at boot.
 */
export function installWindowTrace(target: Window = window, observer: typeof PerformanceObserver | undefined = globalThis.PerformanceObserver): void {
  try {
    watchLongTasks(observer);
    target.addEventListener("error", (event) => {
      trace.error("window.error", {
        error: errorText(event.error ?? event.message),
        // The script's name alone: its address may carry a query.
        file: event.filename ? event.filename.split("/").slice(-1)[0]?.split(/[?#]/)[0] : undefined,
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
