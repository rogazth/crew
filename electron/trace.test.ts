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
