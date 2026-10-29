// What the open specs (terminals, big-files) watch in the window: the input's
// own time, each crewd request by method from send to answer, the first PTY
// frame, long tasks, and a CPU profile around one interaction.
import { writeFile } from "node:fs/promises";
import type { CDPSession } from "playwright-core";
import type { Crew } from "../harness.ts";

export type Request = { method: string; sent: number; answered: number };
export type Window = {
  input: number;
  requests: Request[];
  /** The first binary frame (a PTY's bytes) since the reset. */
  firstFrame: number;
  longTasks: { t: number; d: number }[];
  /** Files the window fetched since the reset (lazy chunks, workers, fonts). */
  resources: { name: string; t: number; end: number }[];
};

/** Runs before the app's own scripts. */
export function probe() {
  type Open = Window & { pending: Map<number, Request>; reset(): void };
  const open: Open = {
    input: 0,
    requests: [],
    firstFrame: 0,
    longTasks: [],
    resources: [],
    pending: new Map(),
    reset() {
      open.input = 0;
      open.requests = [];
      open.firstFrame = 0;
      open.longTasks = [];
      open.resources = [];
    },
  };
  (window as unknown as { __open: Open }).__open = open;
  const mark = (event: Event) => {
    open.input = event.timeStamp;
  };
  addEventListener("keydown", mark, true);
  addEventListener("pointerdown", mark, true);
  new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) open.longTasks.push({ t: entry.startTime, d: entry.duration });
  }).observe({ type: "longtask", buffered: true });
  new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) {
      open.resources.push({ name: entry.name.split("/").pop() ?? entry.name, t: entry.startTime, end: entry.startTime + entry.duration });
    }
  }).observe({ type: "resource" });

  const Native = WebSocket;
  const send = Native.prototype.send;
  Native.prototype.send = function (this: WebSocket, data: string | ArrayBufferLike | Blob | ArrayBufferView) {
    if (typeof data === "string") {
      try {
        const { id, method } = JSON.parse(data) as { id?: number; method?: string };
        if (typeof id === "number" && method) {
          const request = { method, sent: performance.now(), answered: 0 };
          open.pending.set(id, request);
          open.requests.push(request);
        }
      } catch {
        // Not a request.
      }
    }
    return send.call(this, data);
  };
  window.WebSocket = class extends Native {
    constructor(url: string | URL, protocols?: string | string[]) {
      super(url, protocols);
      this.addEventListener("message", (event: MessageEvent) => {
        if (typeof event.data !== "string") {
          if (!open.firstFrame) open.firstFrame = performance.now();
          return;
        }
        if (!event.data.startsWith('{"id":')) return;
        try {
          const { id } = JSON.parse(event.data) as { id?: number };
          const request = id === undefined ? undefined : open.pending.get(id);
          if (request) {
            request.answered = performance.now();
            open.pending.delete(id!);
          }
        } catch {
          // Not an answer.
        }
      });
    }
  };
}

export async function reset(crew: Crew): Promise<number> {
  return crew.window.evaluate(() => {
    (window as unknown as { __open: { reset(): void } }).__open.reset();
    return performance.now();
  });
}

export function read(crew: Crew): Promise<Window> {
  return crew.window.evaluate(() => {
    const { input, requests, firstFrame, longTasks, resources } = (window as unknown as { __open: Window }).__open;
    return { input, requests, firstFrame, longTasks, resources };
  });
}

/** The first answer to `method` since the reset, as [sent, answered]. */
export function requestOf(win: Window, method: string): [number, number] {
  const request = win.requests.find((r) => r.method === method);
  return request ? [request.sent, request.answered] : [0, 0];
}

/**
 * Waits until nothing long ran, and nothing was asked of crewd, for `quiet` ms.
 * A window that never goes quiet gives up after `max` ms, at the last it saw.
 */
export async function settle(crew: Crew, quiet = 400, max = 20_000): Promise<number> {
  const until = Date.now() + max;
  for (;;) {
    const last = await crew.window.evaluate(() => {
      const open = (window as unknown as { __open: Window }).__open;
      const ends = [...open.longTasks.map((l) => l.t + l.d), ...open.requests.map((r) => r.answered || r.sent)];
      return { now: performance.now(), last: Math.max(0, ...ends) };
    });
    if (last.now - last.last >= quiet || Date.now() >= until) return last.last;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

export function stats(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  const at = (p: number) => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] ?? 0;
  return { n: sorted.length, p50: Math.round(at(0.5)), p95: Math.round(at(0.95)), max: Math.round(sorted.at(-1) ?? 0) };
}

type ProfileNode = { id: number; callFrame: { functionName: string; url: string; lineNumber: number }; children?: number[] };
type Profile = { nodes: ProfileNode[]; samples: number[]; timeDeltas: number[] };

/** Samples the renderer's CPU while `fn` runs; resolves to the heaviest functions by self time. */
export async function profiled<T>(
  crew: Crew,
  file: string | undefined,
  fn: () => Promise<T>,
): Promise<{ value: T; top: string[] }> {
  const cdp: CDPSession = await crew.window.context().newCDPSession(crew.window);
  await cdp.send("Profiler.enable");
  await cdp.send("Profiler.setSamplingInterval", { interval: 200 });
  await cdp.send("Profiler.start");
  let value: T;
  let profile: Profile;
  try {
    value = await fn();
  } finally {
    ({ profile } = (await cdp.send("Profiler.stop")) as unknown as { profile: Profile });
    await cdp.detach().catch(() => {});
  }
  if (file) await writeFile(file, JSON.stringify(profile));
  const byNode = new Map(profile.nodes.map((n) => [n.id, n]));
  const self = new Map<string, number>();
  profile.samples.forEach((id, i) => {
    const node = byNode.get(id);
    if (!node) return;
    const { functionName, url, lineNumber } = node.callFrame;
    if (functionName === "(idle)" || functionName === "(program)") return;
    const where = url ? `${url.split("/").pop()}:${lineNumber + 1}` : "";
    const key = `${functionName || "(anonymous)"} ${where}`.trim();
    self.set(key, (self.get(key) ?? 0) + (profile.timeDeltas[i] ?? 0) / 1000);
  });
  const top = [...self.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 12)
    .map(([key, ms]) => `${Math.round(ms)}ms ${key}`);
  return { value, top };
}
