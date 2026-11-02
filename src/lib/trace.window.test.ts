import { afterEach, describe, expect, it, vi } from "vitest";
import type { TraceHost, TraceRecord } from "./trace";

type Listener = (event: unknown) => void;

/** A window with the parts `installWindowTrace` touches, and a bridge that keeps what it is given. */
function rig(withBridge = true) {
  const listeners = new Map<string, Listener>();
  const documentListeners = new Map<string, Listener>();
  const sent: TraceRecord[] = [];
  const host: TraceHost = { write: (records) => void sent.push(...records) };
  const fake = {
    crewHost: withBridge ? { trace: host } : undefined,
    addEventListener: (type: string, listener: Listener) => void listeners.set(type, listener),
    document: {
      visibilityState: "visible",
      addEventListener: (type: string, listener: Listener) => void documentListeners.set(type, listener),
    },
  };
  vi.stubGlobal("window", fake);
  return { fake, listeners, documentListeners, sent };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe("installWindowTrace", () => {
  it("writes a thrown error and an unhandled rejection as one line each, and flushes at once", async () => {
    const { listeners, sent, fake } = rig();
    const { installWindowTrace } = await import("./trace");
    installWindowTrace(fake as never, undefined);
    listeners.get("error")?.({ error: new Error('invalid type: string "hunter2", expected u32'), filename: "http://x/app/main.js?token=SECRET", lineno: 12 });
    listeners.get("unhandledrejection")?.({ reason: "Session abc not found\nat somewhere" });
    expect(sent.map((record) => [record.level, record.message])).toEqual([
      ["ERROR", "window.error"],
      ["ERROR", "window.unhandledrejection"],
    ]);
    expect(sent[0]?.fields).toEqual({ error: 'invalid type: string "…", expected u32', file: "main.js", line: 12 });
    expect(sent[1]?.fields).toEqual({ error: "Session abc not found" });
  });

  it("sends what is queued when the page is hidden or goes away", async () => {
    const { listeners, documentListeners, sent, fake } = rig();
    const { installWindowTrace, trace } = await import("./trace");
    installWindowTrace(fake as never, undefined);
    trace.info("ui.command", { command: "open-launcher", via: "keyboard" });
    expect(sent).toEqual([]);
    listeners.get("pagehide")?.({});
    expect(sent.map((record) => record.message)).toEqual(["ui.command"]);
    trace.info("workspace.switch", { workspace: "w2" });
    fake.document.visibilityState = "hidden";
    documentListeners.get("visibilitychange")?.({});
    expect(sent.map((record) => record.message)).toEqual(["ui.command", "workspace.switch"]);
    // Coming back to the page sends nothing more.
    fake.document.visibilityState = "visible";
    documentListeners.get("visibilitychange")?.({});
    expect(sent).toHaveLength(2);
  });

  it("writes a task of a second or more as window.long_task and ignores shorter ones", async () => {
    const { sent, fake } = rig();
    const { installWindowTrace, trace } = await import("./trace");
    let observed: ((list: { getEntries(): Array<{ duration: number }> }) => void) | undefined;
    class Observer {
      constructor(callback: typeof observed) {
        observed = callback;
      }
      observe = vi.fn();
    }
    installWindowTrace(fake as never, Observer as never);
    observed?.({ getEntries: () => [{ duration: 80 }, { duration: 999 }, { duration: 1000.4 }, { duration: 5300 }] });
    trace.flush();
    expect(sent.map((record) => [record.level, record.message, record.fields])).toEqual([
      ["WARN", "window.long_task", { duration_ms: 1000 }],
      ["WARN", "window.long_task", { duration_ms: 5300 }],
    ]);
  });

  it("survives a browser with no long task type and with no observer at all", async () => {
    const { fake } = rig();
    const { installWindowTrace } = await import("./trace");
    class Refusing {
      observe() {
        throw new TypeError("type longtask is not supported");
      }
    }
    expect(() => installWindowTrace(fake as never, Refusing as never)).not.toThrow();
    expect(() => installWindowTrace(fake as never, undefined)).not.toThrow();
  });

  it("does nothing without the bridge: a plain browser, mock mode", async () => {
    const { listeners, sent, fake } = rig(false);
    const { installWindowTrace, trace } = await import("./trace");
    installWindowTrace(fake as never, undefined);
    listeners.get("error")?.({ error: new Error("boom") });
    trace.warn("window.long_task", { duration_ms: 3000 });
    trace.flush();
    expect(sent).toEqual([]);
  });
});
