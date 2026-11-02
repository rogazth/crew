import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, chmodSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AppTrace } from "./trace";

const dirs: string[] = [];
function temp(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "crew-app-trace-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  vi.useRealTimers();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const read = (dir: string, name = "app.ndjson") =>
  readFileSync(path.join(dir, name), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);

describe("app.ndjson", () => {
  it("writes the shape crewd's lines have, so crew trace can merge them", () => {
    const dir = temp();
    const t = new AppTrace({ dir, now: () => new Date("2026-11-02T13:06:07.356Z") });
    t.info("app.start", { version: "1.2.3", packaged: true });
    t.flushSync();
    expect(read(dir)).toEqual([
      {
        timestamp: "2026-11-02T13:06:07.356Z",
        level: "INFO",
        fields: { message: "app.start", version: "1.2.3", packaged: true },
        target: "app.main",
      },
    ]);
    t.dispose();
  });

  it("marks the window's events app.window, keeping the time the window gave", () => {
    const dir = temp();
    const t = new AppTrace({ dir });
    t.window([{ timestamp: "2026-11-02T10:00:00.000Z", level: "WARN", message: "socket.closed", fields: { machine: "m1", code: 1006 } }]);
    t.flushSync();
    const [line] = read(dir);
    expect(line).toMatchObject({ target: "app.window", level: "WARN", timestamp: "2026-11-02T10:00:00.000Z" });
    expect(line?.fields).toEqual({ message: "socket.closed", machine: "m1", code: 1006 });
    t.dispose();
  });

  it("takes nothing but records from the window", () => {
    const dir = temp();
    const t = new AppTrace({ dir });
    t.window("not an array");
    t.window([null, 3, { message: 5 }, { message: "ok", fields: { nested: { a: 1 } } }]);
    t.flushSync();
    const lines = read(dir);
    expect(lines).toHaveLength(1);
    expect(typeof (lines[0]?.fields as Record<string, unknown>).nested).toBe("string");
    t.dispose();
  });

  it("batches: nothing is written until the timer, and then it is one write", () => {
    vi.useFakeTimers();
    const dir = temp();
    const t = new AppTrace({ dir, flushMs: 200 });
    for (let i = 0; i < 50; i += 1) t.info("tick", { i });
    expect(existsSync(path.join(dir, "app.ndjson"))).toBe(false);
    vi.advanceTimersByTime(199);
    expect(existsSync(path.join(dir, "app.ndjson"))).toBe(false);
    vi.advanceTimersByTime(2);
    expect(read(dir)).toHaveLength(50);
    t.dispose();
  });

  it("writes an error at once and flushes the rest with it", () => {
    vi.useFakeTimers();
    const dir = temp();
    const t = new AppTrace({ dir });
    t.info("before");
    t.error("main.uncaught", { error: "boom" });
    expect(read(dir).map((l) => (l.fields as { message: string }).message)).toEqual(["before", "main.uncaught"]);
    t.dispose();
  });

  it("is 0600 in a private folder, whatever the file was before", () => {
    const dir = path.join(temp(), "trace");
    const t = new AppTrace({ dir });
    t.info("a");
    t.flushSync();
    expect(statSync(path.join(dir, "app.ndjson")).mode & 0o777).toBe(0o600);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    t.dispose();
    const loose = path.join(dir, "app.ndjson");
    chmodSync(loose, 0o644);
    const again = new AppTrace({ dir });
    again.info("b");
    again.flushSync();
    expect(statSync(loose).mode & 0o777).toBe(0o600);
    again.dispose();
  });

  it("rotates at the size boundary into app.ndjson.1, .2, and keeps no more than three files", () => {
    const dir = temp();
    const t = new AppTrace({ dir, maxBytes: 600, keep: 3 });
    for (let i = 0; i < 40; i += 1) {
      t.info("line", { i, pad: "x".repeat(40) });
      t.flushSync();
    }
    t.dispose();
    const names = readdirSync(dir).sort();
    expect(names).toEqual(["app.ndjson", "app.ndjson.1", "app.ndjson.2"]);
    for (const name of names) {
      expect(statSync(path.join(dir, name)).size).toBeLessThanOrEqual(600);
      expect(statSync(path.join(dir, name)).mode & 0o777).toBe(0o600);
    }
    // Newest last across the chain, and the active file is the newest.
    const last = (name: string) => (read(dir, name).at(-1)?.fields as { i: number }).i;
    expect(last("app.ndjson")).toBe(39);
    expect(last("app.ndjson.1")).toBeLessThan(last("app.ndjson"));
    expect(last("app.ndjson.2")).toBeLessThan(last("app.ndjson.1"));
  });

  it("does not throw, or stop, when the folder cannot be written; it says what it lost once it can", () => {
    const base = temp();
    const blocker = path.join(base, "blocked");
    writeFileSync(blocker, "a file where the folder should be");
    const t = new AppTrace({ dir: path.join(blocker, "trace") });
    expect(() => {
      t.info("lost");
      t.error("also lost");
      t.flushSync();
      t.dispose();
    }).not.toThrow();
    // The folder appears: the next batch is written, with a note of the loss.
    rmSync(blocker);
    vi.useFakeTimers({ now: Date.now() + 5000 });
    const dir = path.join(base, "blocked", "trace");
    const later = new AppTrace({ dir });
    later.info("kept");
    later.flushSync();
    expect(read(dir).map((l) => (l.fields as { message: string }).message)).toContain("kept");
    later.dispose();
  });

  it("never lets a line it cannot encode fail the caller", () => {
    const dir = temp();
    const t = new AppTrace({ dir });
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => {
      t.info("x", { cyclic: cyclic as never });
      t.flushSync();
    }).not.toThrow();
    t.dispose();
  });
});

describe("trace.dropped", () => {
  it("is written by the same trace once it can write again, with how many writes it lost", () => {
    const base = temp();
    const blocker = path.join(base, "blocked");
    writeFileSync(blocker, "a file where the folder should be");
    vi.useFakeTimers({ now: new Date("2026-11-02T10:00:00Z") });
    const dir = path.join(blocker, "trace");
    const t = new AppTrace({ dir });
    t.info("lost one");
    t.flushSync();
    t.info("lost two");
    t.flushSync();
    // The folder is made; the trace tries again a second later.
    rmSync(blocker);
    vi.setSystemTime(new Date("2026-11-02T10:00:05Z"));
    t.info("kept");
    t.flushSync();
    const lines = read(dir).map((line) => line.fields as { message: string; write_failures?: number });
    expect(lines.map((line) => line.message)).toEqual(["kept", "trace.dropped"]);
    expect(lines[1]?.write_failures).toBeGreaterThanOrEqual(1);
    const dropped = read(dir).at(-1);
    expect(dropped).toMatchObject({ level: "WARN", target: "app.main" });
    // Said once: nothing is lost since, so nothing more is reported.
    t.info("after");
    t.flushSync();
    expect(read(dir).map((line) => (line.fields as { message: string }).message)).toEqual(["kept", "trace.dropped", "after"]);
    t.dispose();
  });
});

describe("main's one trace", () => {
  const load = async () => {
    vi.resetModules();
    return import("./trace");
  };
  const messages = (dir: string) => read(dir).map((line) => (line.fields as { message: string }).message);

  it("keeps what is said before the data dir is known and writes it, in order, once it is", async () => {
    const dir = temp();
    const { trace, initTrace } = await load();
    trace.info("app.start", { version: "1.0.0" });
    trace.warn("daemon.decision");
    trace.error("main.uncaught", { error: "boom" });
    expect(existsSync(path.join(dir, "app.ndjson"))).toBe(false);
    initTrace(dir);
    trace.info("after");
    trace.flush();
    expect(messages(dir)).toEqual(["app.start", "daemon.decision", "main.uncaught", "after"]);
    expect(read(dir).map((line) => line.level)).toEqual(["INFO", "WARN", "ERROR", "INFO"]);
  });

  it("holds the first two hundred of what is said early and drops the rest", async () => {
    const dir = temp();
    const { trace, initTrace } = await load();
    for (let i = 0; i < 250; i += 1) trace.info("early", { i });
    initTrace(dir);
    trace.flush();
    const lines = read(dir);
    expect(lines).toHaveLength(200);
    expect((lines.at(-1)?.fields as { i: number }).i).toBe(199);
  });

  it("writes the window's records as app.window and ignores them before it is open", async () => {
    const dir = temp();
    const { trace, initTrace } = await load();
    trace.window([{ message: "too early" }]);
    initTrace(dir);
    trace.window([{ timestamp: "2026-11-02T10:00:00.000Z", level: "WARN", message: "socket.closed", fields: { machine: "local" } }]);
    trace.flush();
    expect(read(dir)).toEqual([
      {
        timestamp: "2026-11-02T10:00:00.000Z",
        level: "WARN",
        fields: { message: "socket.closed", machine: "local" },
        target: "app.window",
      },
    ]);
  });

  it("lets go of the file it had when it is opened again somewhere else", async () => {
    const [first, second] = [temp(), temp()];
    const { trace, initTrace } = await load();
    initTrace(first);
    trace.info("in the first");
    initTrace(second);
    trace.info("in the second");
    trace.flush();
    expect(messages(first)).toEqual(["in the first"]);
    expect(messages(second)).toEqual(["in the second"]);
  });
});
