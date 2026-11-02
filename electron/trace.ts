// Main's side of the trace: `<data>/trace/app.ndjson`, in the shape crewd's
// own files have (`timestamp`, `level`, `fields.message`, `target`), so
// `crew trace` merges them by time. `target` says who wrote it: `app.main`, or
// `app.window` for what the window sent over IPC. See src/lib/trace.ts for
// what may be recorded, which is ids, kinds, durations, sizes, counts and
// error text, and never what a user typed or a model said.
//
// Lines are batched for a moment and written in one go; 10 MB x 3 files, 0600.
// A failure to write is counted and survived: the app does not stop for a log.

import { chmodSync, closeSync, fstatSync, mkdirSync, openSync, renameSync, rmSync, writeSync } from "node:fs";
import path from "node:path";
import { errorText, readRecord, sanitizeFields, type TraceFields, type TraceLevel } from "../src/lib/trace";

export const TRACE_FILE = "app.ndjson";
const MAX_BYTES = 10 * 1024 * 1024;
const KEEP = 3;
const FLUSH_MS = 250;
/** Flushed at once past this, so a burst is written in chunks rather than held. */
const BUFFER_BYTES = 256 * 1024;
const EARLY_CAP = 200;
const REOPEN_MS = 1000;

export type AppTraceOptions = {
  dir: string;
  file?: string;
  maxBytes?: number;
  /** Files in all: the active one and its `.1`, `.2` backups. */
  keep?: number;
  flushMs?: number;
  now?: () => Date;
};

export class AppTrace {
  private readonly path: string;
  private readonly maxBytes: number;
  private readonly keep: number;
  private readonly flushMs: number;
  private readonly now: () => Date;
  private fd: number | null = null;
  private size = 0;
  private buffer: string[] = [];
  private bufferBytes = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private failedAt = 0;
  private failures = 0;
  private reported = 0;

  constructor(private readonly options: AppTraceOptions) {
    this.path = path.join(options.dir, options.file ?? TRACE_FILE);
    this.maxBytes = options.maxBytes ?? MAX_BYTES;
    this.keep = Math.max(1, options.keep ?? KEEP);
    this.flushMs = options.flushMs ?? FLUSH_MS;
    this.now = options.now ?? (() => new Date());
  }

  info(message: string, fields?: TraceFields): void {
    this.add("INFO", "app.main", message, fields);
  }

  warn(message: string, fields?: TraceFields): void {
    this.add("WARN", "app.main", message, fields);
  }

  /** Written out at once: an error is often the last thing a process does. */
  error(message: string, fields?: TraceFields): void {
    this.add("ERROR", "app.main", message, fields);
    this.flushSync();
  }

  /** What the window sent. Anything that is not a record is dropped, whatever the sender claims. */
  window(records: unknown): void {
    if (!Array.isArray(records)) return;
    for (const value of records.slice(0, 100)) {
      const record = readRecord(value);
      if (record) this.line(record.level, "app.window", record.message, record.fields, record.timestamp);
    }
  }

  private add(level: TraceLevel, target: string, message: string, fields?: TraceFields): void {
    this.line(level, target, message, sanitizeFields(fields), this.now().toISOString());
  }

  private line(level: TraceLevel, target: string, message: string, fields: Record<string, unknown>, timestamp: string): void {
    try {
      const text = JSON.stringify({ timestamp, level, fields: { message, ...fields }, target }) + "\n";
      this.buffer.push(text);
      this.bufferBytes += text.length;
      if (this.bufferBytes >= BUFFER_BYTES) this.flushSync();
      else if (this.timer === null) {
        this.timer = setTimeout(() => this.flushSync(), this.flushMs);
        // A pending write must not keep the process up.
        this.timer.unref?.();
      }
    } catch {
      this.failures += 1;
    }
  }

  /** Writes what is buffered, now. Safe from a crash path and `process.on("exit")`. */
  flushSync(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    try {
      if (this.failures > this.reported) {
        const lost = this.failures - this.reported;
        this.reported = this.failures;
        this.buffer.push(
          JSON.stringify({
            timestamp: this.now().toISOString(),
            level: "WARN",
            fields: { message: "trace.dropped", write_failures: lost },
            target: "app.main",
          }) + "\n",
        );
      }
      if (this.buffer.length === 0) return;
      const text = this.buffer.join("");
      this.buffer = [];
      this.bufferBytes = 0;
      this.write(text);
    } catch {
      this.failures += 1;
    }
  }

  private write(text: string): void {
    const bytes = Buffer.byteLength(text);
    if (this.fd === null && !this.open()) {
      this.failures += 1;
      return;
    }
    try {
      // A line is never split across files; an empty file takes a batch however long.
      if (this.size > 0 && this.size + bytes > this.maxBytes) this.rotate();
      if (this.fd === null && !this.open()) throw new Error("closed");
      writeSync(this.fd as number, text);
      this.size += bytes;
    } catch {
      this.failures += 1;
      this.close();
    }
  }

  private open(): boolean {
    if (Date.now() - this.failedAt < REOPEN_MS && this.failedAt !== 0) return false;
    try {
      mkdirSync(this.options.dir, { recursive: true, mode: 0o700 });
      const fd = openSync(this.path, "a", 0o600);
      try {
        chmodSync(this.path, 0o600);
      } catch {
        // Not ours to change; it is still appended to.
      }
      this.fd = fd;
      this.size = fstatSync(fd).size;
      this.failedAt = 0;
      return true;
    } catch {
      this.failedAt = Date.now();
      return false;
    }
  }

  private close(): void {
    if (this.fd !== null) {
      try {
        closeSync(this.fd);
      } catch {
        // Already gone.
      }
    }
    this.fd = null;
  }

  /** `app.ndjson` -> `.1` -> `.2`, the oldest dropped. Best effort: a failed rename leaves the file to grow. */
  private rotate(): void {
    this.close();
    try {
      if (this.keep > 1) {
        rmSync(`${this.path}.${this.keep - 1}`, { force: true });
        for (let n = this.keep - 2; n >= 1; n -= 1) {
          try {
            renameSync(`${this.path}.${n}`, `${this.path}.${n + 1}`);
          } catch {
            // That backup does not exist yet.
          }
        }
        renameSync(this.path, `${this.path}.1`);
      } else {
        rmSync(this.path, { force: true });
      }
    } catch {
      this.failures += 1;
    }
    this.open();
  }

  /** Flushes and lets go of the file. */
  dispose(): void {
    this.flushSync();
    this.close();
  }
}

// ---- the app's one trace -----------------------------------------------------

let active: AppTrace | null = null;
const early: Array<[TraceLevel, string, TraceFields | undefined]> = [];

function send(level: TraceLevel, message: string, fields?: TraceFields): void {
  if (!active) {
    // Before the data dir is known: kept for a moment, written when it is.
    if (early.length < EARLY_CAP) early.push([level, message, fields]);
    return;
  }
  if (level === "ERROR") active.error(message, fields);
  else if (level === "WARN") active.warn(message, fields);
  else active.info(message, fields);
}

/** `trace.info("daemon.kickstart", { reason })`: main's events, written once `initTrace` has run. Never throws. */
export const trace = {
  info: (message: string, fields?: TraceFields) => send("INFO", message, fields),
  warn: (message: string, fields?: TraceFields) => send("WARN", message, fields),
  error: (message: string, fields?: TraceFields) => send("ERROR", message, fields),
  /** The window's records, as they arrive over IPC. */
  window: (records: unknown) => active?.window(records),
  flush: () => active?.flushSync(),
};

export { errorText };

/** Opens `<dir>/app.ndjson` for this process. Once the data dir is final. */
export function initTrace(dir: string): AppTrace {
  active?.dispose();
  active = new AppTrace({ dir });
  for (const [level, message, fields] of early.splice(0)) send(level, message, fields);
  return active;
}
