import { describe, expect, it, vi } from "vitest";
import { createTrace, errorText, loud, readRecord, sanitizeFields, type TraceHost, type TraceRecord } from "./trace";

function rig(overrides: { host?: () => TraceHost | null | undefined; maxQueue?: number } = {}) {
  const sent: TraceRecord[][] = [];
  const timers: Array<() => void> = [];
  const host: TraceHost = { write: (records) => void sent.push(records) };
  const trace = createTrace({
    host: overrides.host ?? (() => host),
    now: () => new Date("2026-11-02T13:00:00.000Z"),
    setTimer: (run) => timers.push(run),
    clearTimer: () => {},
    ...(overrides.maxQueue === undefined ? {} : { maxQueue: overrides.maxQueue }),
  });
  return { trace, sent, timers };
}

describe("the window's trace", () => {
  it("batches events and sends them together when the timer runs", () => {
    const { trace, sent, timers } = rig();
    trace.info("socket.closed", { machine: "local", code: 1006, retry: true });
    trace.warn("socket.retry", { machine: "local", in_ms: 500 });
    expect(sent).toEqual([]);
    expect(timers).toHaveLength(1);
    timers[0]!();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toEqual([
      {
        timestamp: "2026-11-02T13:00:00.000Z",
        level: "INFO",
        message: "socket.closed",
        fields: { machine: "local", code: 1006, retry: true },
      },
      {
        timestamp: "2026-11-02T13:00:00.000Z",
        level: "WARN",
        message: "socket.retry",
        fields: { machine: "local", in_ms: 500 },
      },
    ]);
  });

  it("sends an error at once, since the page may be about to go", () => {
    const { trace, sent } = rig();
    trace.error("window.error", { error: "boom" });
    expect(sent[0]?.[0]?.level).toBe("ERROR");
  });

  it("sends a hundred at a time", () => {
    const { trace, sent } = rig();
    for (let i = 0; i < 250; i += 1) trace.info("tick", { i });
    trace.flush();
    expect(sent.map((batch) => batch.length)).toEqual([100, 100, 50]);
  });

  it("is a no-op with no bridge: plain browser, mock mode, tests", () => {
    const { trace, timers } = rig({ host: () => undefined });
    expect(() => {
      trace.info("a");
      trace.warn("b");
      trace.error("c");
      trace.flush();
    }).not.toThrow();
    expect(timers).toHaveLength(0);
  });

  it("never throws, whatever the bridge or the fields do", () => {
    const hostile = {
      write: () => {
        throw new Error("ipc is gone");
      },
    };
    const { trace } = rig({ host: () => hostile });
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => {
      trace.error("x", { value: cyclic as never });
      trace.info("y", {
        value: {
          toString: () => {
            throw new Error("no");
          },
        } as never,
      });
      trace.flush();
    }).not.toThrow();
    const lookup = rig({
      host: () => {
        throw new Error("no window");
      },
    });
    expect(() => lookup.trace.info("z")).not.toThrow();
  });

  it("keeps the newest when it is flooded, and says how many it dropped", () => {
    const { trace, sent } = rig({ maxQueue: 3 });
    for (let i = 0; i < 5; i += 1) trace.info("tick", { i });
    trace.flush();
    const records = sent.flat();
    expect(records.map((r) => r.message)).toEqual(["trace.dropped", "tick", "tick", "tick"]);
    expect(records[0]?.fields.count).toBe(2);
    expect(records.slice(1).map((r) => r.fields.i)).toEqual([2, 3, 4]);
  });

  it("reads the host at each event, so a bridge that appears later is used", () => {
    const bridge: { host?: TraceHost } = {};
    const sent: TraceRecord[][] = [];
    const trace = createTrace({ host: () => bridge.host, setTimer: () => 0, clearTimer: () => {} });
    trace.info("early");
    bridge.host = { write: (records) => void sent.push(records) };
    trace.info("late");
    trace.flush();
    expect(sent.flat().map((r) => r.message)).toEqual(["late"]);
  });
});

describe("what a record may hold", () => {
  it("keeps primitives, cuts long text, and turns anything else into text", () => {
    const fields = sanitizeFields({
      a: 1,
      b: "x".repeat(1000),
      c: false,
      d: null,
      e: undefined,
      f: NaN,
      g: [1, 2] as never,
    });
    expect(fields.a).toBe(1);
    expect((fields.b as string).length).toBeLessThan(400);
    expect(fields).toMatchObject({ c: false, d: null, f: null, g: "1,2" });
    expect("e" in fields).toBe(false);
  });

  it("does not let a field called message replace the message", () => {
    expect(sanitizeFields({ message: "x", other: 1 })).toEqual({ other: 1 });
  });

  it("drops the value a parse error quotes, and all but the first line", () => {
    expect(errorText(new Error('invalid type: string "hunter2", expected u32'))).toBe('invalid type: string "…", expected u32');
    expect(errorText("Session not found\n  at stack")).toBe("Session not found");
  });

  it("keeps the words around an address and never the address", () => {
    expect(errorText("https://example.com/releases/latest.json answered 503")).toBe("<url> answered 503");
    expect(errorText(new Error("fetch to (wss://host:1/p?token=SECRET) failed"))).toBe("fetch to (<url>) failed");
    expect(sanitizeFields({ error: "no answer from http://127.0.0.1:9 at all" }).error).toBe("no answer from <url> at all");
  });

  it("accepts a record from the window and refuses what is not one", () => {
    expect(readRecord({ level: "WARN", message: "m", fields: { a: 1 } })?.level).toBe("WARN");
    expect(readRecord({ level: "LOUD", message: "m" })?.level).toBe("INFO");
    expect(readRecord({ message: "" })).toBeNull();
    expect(readRecord("text")).toBeNull();
    expect(readRecord(null)).toBeNull();
    expect(readRecord({ message: "m", timestamp: "not a date" })?.timestamp).toMatch(/^\d{4}-/);
  });
});

describe("the default instance", () => {
  it("is quiet where there is no window", async () => {
    vi.resetModules();
    const { trace } = await import("./trace");
    expect(() => trace.info("nothing listens")).not.toThrow();
  });
});

describe("what a record keeps of an error", () => {
  it("cuts every error-like field to one line without the values a parse error quotes", () => {
    const out = sanitizeFields({
      error: 'invalid type: string "hunter2", expected u32\nsecond line',
      said: "ssh: refused\nmore",
      reason: "x".repeat(1000),
    });
    expect(out.error).toBe('invalid type: string "…", expected u32');
    expect(out.said).toBe("ssh: refused");
    expect(String(out.reason).length).toBeLessThanOrEqual(301);
  });

  it("keeps the frames of a stack and not the message that heads it", () => {
    const out = sanitizeFields({ stack: 'SyntaxError: Unexpected token "hunter2" in JSON\n    at parse (a.js:1:1)\n    at run (b.js:2:2)' });
    expect(out.stack).toBe("    at parse (a.js:1:1)\n    at run (b.js:2:2)");
  });

  it("speaks for the first few tries of a stretch and then one in thirty", () => {
    const spoken = Array.from({ length: 61 }, (_, i) => i + 1).filter(loud);
    expect(spoken).toEqual([1, 2, 3, 4, 5, 30, 60]);
  });
});
