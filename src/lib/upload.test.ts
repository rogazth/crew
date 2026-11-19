import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const request = vi.fn();
const uploadPiece = vi.fn();
vi.mock("./client", () => ({
  client: {
    request: (...args: unknown[]) => request(...args),
    uploadPiece: (...args: unknown[]) => uploadPiece(...args),
  },
}));

import {
  CHUNK,
  fileSource,
  PROBE_MS,
  SLACK_MS,
  upload,
  UploadWindow,
  WINDOW_MAX,
  WINDOW_START,
  type UploadSource,
} from "./upload";

const down = () => Object.assign(new Error("That machine is offline"), { name: "EnvDown" });

/** Bytes that say where they came from, so a piece sent from the wrong offset shows. */
function memory(size: number): UploadSource & { bytes: Uint8Array } {
  const bytes = new Uint8Array(size).map((_, i) => (i * 7 + (i >> 17)) & 0xff);
  return { name: "banner.psd", size, bytes, read: async (offset, length) => bytes.slice(offset, offset + length) };
}

/** A machine that knows `upload_begin`; `log` is every call in the order it was made. */
function modern(path = "/tmp/crew/x.psd") {
  const log: string[] = [];
  request.mockImplementation(async (method: string) => {
    log.push(method);
    return method === "upload_finish" ? path : null;
  });
  uploadPiece.mockImplementation(async (_id: string, offset: number) => {
    log.push(`piece ${offset}`);
    return null;
  });
  return log;
}

/** Pieces that wait until the test answers them. */
function held() {
  const out: Array<{ offset: number; resolve: (value: null) => void; reject: (error: Error) => void }> = [];
  uploadPiece.mockImplementation(
    (_id: string, offset: number) =>
      new Promise((resolve, reject) => {
        out.push({ offset, resolve, reject });
      }),
  );
  return out;
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("upload", () => {
  beforeEach(() => {
    request.mockReset();
    uploadPiece.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("begins, sends every piece as bytes, and finishes with the size once all are acknowledged", async () => {
    const log = modern();
    const source = memory(CHUNK * 2 + 1000);
    const seen: number[] = [];
    const path = await upload(source, "devbox", "psd", (sent) => seen.push(sent));
    expect(path).toBe("/tmp/crew/x.psd");

    expect(log[0]).toBe("upload_begin");
    expect(log.at(-1)).toBe("upload_finish");
    expect(log.slice(1, -1).sort()).toEqual([`piece ${CHUNK * 2}`, `piece ${CHUNK}`, "piece 0"].sort());

    const [, beginParams, beginEnv] = request.mock.calls[0] as [string, { id: string }, string];
    const [, finishParams, finishEnv] = request.mock.calls[1] as [string, object, string];
    expect(beginEnv).toBe("devbox");
    expect(finishEnv).toBe("devbox");
    expect(finishParams).toEqual({ id: beginParams.id, extension: "psd", size: CHUNK * 2 + 1000 });
    for (const [id, offset, bytes, env] of uploadPiece.mock.calls as Array<[string, number, Uint8Array, string]>) {
      expect(id).toBe(beginParams.id);
      expect(env).toBe("devbox");
      expect(bytes).toEqual(source.bytes.slice(offset, offset + CHUNK));
    }
    expect(seen.at(-1)).toBe(CHUNK * 2 + 1000);
    expect(seen).toEqual([...seen].sort((a, b) => a - b));
  });

  it("reads a File's slices as bytes", async () => {
    modern();
    const file = new File([new Uint8Array([1, 2, 3, 4, 5])], "a.txt");
    await upload(fileSource(file), "devbox", "txt");
    expect(uploadPiece.mock.calls[0]?.[2]).toEqual(new Uint8Array([1, 2, 3, 4, 5]));
  });

  it("sends a zero byte file as one empty piece", async () => {
    const log = modern();
    const seen: number[] = [];
    await upload(memory(0), "devbox", "txt", (sent) => seen.push(sent));
    expect(log).toEqual(["upload_begin", "piece 0", "upload_finish"]);
    expect((uploadPiece.mock.calls[0]?.[2] as Uint8Array).byteLength).toBe(0);
    expect(request.mock.calls[1]?.[1]).toMatchObject({ size: 0 });
    expect(seen).toEqual([0]);
  });

  it("starts with WINDOW_START pieces out and never has more out than the window allows", async () => {
    let now = 0;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    request.mockImplementation(async (method: string) => (method === "upload_finish" ? "/tmp/x" : null));
    const pieces = held();
    const count = 60;
    const sending = upload(memory(CHUNK * count), "devbox", "bin");

    // The same window the upload keeps, fed the same measurements.
    const twin = new UploadWindow();
    twin.sent(0);
    await vi.waitFor(() => expect(pieces).toHaveLength(WINDOW_START));
    let acked = 0;
    let most = 0;
    // When each piece went out, and how much had been acknowledged then.
    const sent = new Map<number, { at: number; before: number }>(pieces.map((piece) => [piece.offset, { at: 0, before: 0 }]));
    while (acked < count) {
      const piece = pieces.shift();
      const out = piece && sent.get(piece.offset);
      if (!piece || !out) throw new Error("nothing in flight");
      // 100 ms after it went out, or now if that has passed.
      now = Math.max(now, out.at + 100);
      twin.acked(now, CHUNK, now - out.at, out.before);
      piece.resolve(null);
      acked++;
      const expected = Math.min(twin.size, count - acked);
      await vi.waitFor(() => expect(pieces.length).toBe(expected), { interval: 1 });
      for (const next of pieces) if (!sent.has(next.offset)) sent.set(next.offset, { at: now, before: twin.delivered });
      most = Math.max(most, pieces.length);
    }
    await expect(sending).resolves.toBe("/tmp/x");
    expect(most).toBeGreaterThan(WINDOW_START);
    expect(most).toBeLessThanOrEqual(WINDOW_MAX);
  });

  it("reports the sum of acknowledged pieces when they come back out of order", async () => {
    vi.spyOn(performance, "now").mockReturnValue(0);
    request.mockImplementation(async (method: string) => (method === "upload_finish" ? "/tmp/x" : null));
    const pieces = held();
    const seen: number[] = [];
    const sending = upload(memory(CHUNK * 2 + 1000), "devbox", "bin", (sent) => seen.push(sent));
    await vi.waitFor(() => expect(pieces).toHaveLength(2));
    pieces[1]?.resolve(null);
    await vi.waitFor(() => expect(pieces).toHaveLength(3));
    pieces[2]?.resolve(null);
    await tick();
    pieces[0]?.resolve(null);
    await expect(sending).resolves.toBe("/tmp/x");
    expect(seen).toEqual([CHUNK, CHUNK + 1000, CHUNK * 2 + 1000]);
  });

  it("sends again only the piece the link dropped", async () => {
    vi.useFakeTimers();
    const log = modern();
    let dropOnce = true;
    uploadPiece.mockImplementation(async (_id: string, offset: number) => {
      log.push(`piece ${offset}`);
      if (offset === CHUNK && dropOnce) {
        dropOnce = false;
        throw down();
      }
      return null;
    });
    const sending = upload(memory(CHUNK * 3), "devbox", "bin");
    await vi.advanceTimersByTimeAsync(1000);
    await expect(sending).resolves.toBe("/tmp/crew/x.psd");
    const offsets = uploadPiece.mock.calls.map((call) => call[1] as number);
    expect(offsets.filter((offset) => offset === CHUNK)).toHaveLength(2);
    expect(offsets.filter((offset) => offset !== CHUNK).sort()).toEqual([0, CHUNK * 2]);
    expect(log.filter((entry) => entry === "upload_begin")).toHaveLength(1);
    expect(log.at(-1)).toBe("upload_finish");
  });

  it("gives up on a piece the link keeps dropping", async () => {
    vi.useFakeTimers();
    modern();
    uploadPiece.mockImplementation(async () => {
      throw down();
    });
    const sending = upload(memory(10), "devbox", "txt");
    const failed = expect(sending).rejects.toThrow("offline");
    await vi.advanceTimersByTimeAsync(20_000);
    await failed;
    expect(uploadPiece).toHaveBeenCalledTimes(5);
    expect(request.mock.calls.map((call) => call[0])).toEqual(["upload_begin"]);
  });

  it("begins and finishes again when the link drops under them", async () => {
    vi.useFakeTimers();
    modern();
    const answer = request.getMockImplementation();
    request.mockRejectedValueOnce(down()).mockImplementation(async (method: string, ...rest: unknown[]) => {
      if (method === "upload_finish" && request.mock.calls.filter((call) => call[0] === "upload_finish").length === 1) {
        throw down();
      }
      return answer?.(method, ...rest);
    });
    const sending = upload(memory(10), "devbox", "txt");
    await vi.advanceTimersByTimeAsync(5000);
    await expect(sending).resolves.toBe("/tmp/crew/x.psd");
    expect(request.mock.calls.map((call) => call[0])).toEqual(["upload_begin", "upload_begin", "upload_finish", "upload_finish"]);
  });

  it("stops at the first error that is not a dropped link, sends nothing more, and rejects once", async () => {
    modern();
    const pieces = held();
    const sending = upload(memory(CHUNK * 10), "devbox", "bin");
    const failed = expect(sending).rejects.toThrow("Disk full");
    await vi.waitFor(() => expect(pieces).toHaveLength(2));
    pieces[1]?.reject(new Error("Disk full"));
    await failed;
    // A late answer, good or bad, changes nothing.
    pieces[0]?.reject(new Error("Something else"));
    await tick();
    expect(uploadPiece).toHaveBeenCalledTimes(2);
    expect(request.mock.calls.map((call) => call[0])).toEqual(["upload_begin"]);
  });

  it("stops at once when cancelled, without waiting for the pieces in flight", async () => {
    modern();
    const pieces = held();
    const controller = new AbortController();
    const sending = upload(memory(CHUNK * 10), "devbox", "bin", undefined, controller.signal);
    const cancelled = expect(sending).rejects.toThrow("Cancelled");
    await vi.waitFor(() => expect(pieces).toHaveLength(2));
    controller.abort(new Error("Cancelled"));
    await cancelled;
    for (const piece of pieces) piece.resolve(null);
    await tick();
    expect(uploadPiece).toHaveBeenCalledTimes(2);
    expect(request.mock.calls.map((call) => call[0])).toEqual(["upload_begin"]);
  });

  it("stops at once when cancelled while it begins", async () => {
    request.mockImplementation(() => new Promise(() => {}));
    const controller = new AbortController();
    const sending = upload(memory(CHUNK * 3), "devbox", "bin", undefined, controller.signal);
    const cancelled = expect(sending).rejects.toThrow("Cancelled");
    await tick();
    controller.abort(new Error("Cancelled"));
    await cancelled;
    expect(request).toHaveBeenCalledTimes(1);
    expect(uploadPiece).not.toHaveBeenCalled();
  });

  it("sends nothing when it is cancelled before it starts", async () => {
    await expect(upload(memory(10), "devbox", "txt", undefined, AbortSignal.abort())).rejects.toThrow();
    expect(request).not.toHaveBeenCalled();
    expect(uploadPiece).not.toHaveBeenCalled();
  });

  it("stops when the machine refuses to begin for another reason", async () => {
    request.mockRejectedValueOnce(new Error("File is too large to upload"));
    await expect(upload(memory(10), "devbox", "txt")).rejects.toThrow("too large");
    expect(uploadPiece).not.toHaveBeenCalled();
  });
});

describe("upload to a machine older than upload_begin", () => {
  const chunks = () => request.mock.calls.filter((call) => call[0] === "upload_chunk");

  /** `answer` gets each upload_chunk; upload_begin is refused the way an old daemon does. */
  function old(answer: (params: { offset: number }) => Promise<unknown>) {
    request.mockImplementation(async (method: string, params: { offset: number }) => {
      if (method === "upload_begin") throw new Error("Unknown method: upload_begin");
      return answer(params);
    });
  }

  beforeEach(() => {
    request.mockReset();
    uploadPiece.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("sends a big file in base64 pieces, in order, and reports how far it got", async () => {
    old(async () => "/tmp/crew/x.psd");
    const file = new File([new Uint8Array(CHUNK * 2 + 1000).fill(65)], "banner.psd");
    const seen: number[] = [];
    const path = await upload(fileSource(file), "devbox", "psd", (sent) => seen.push(sent));
    expect(path).toBe("/tmp/crew/x.psd");
    expect(chunks().map((call) => (call[1] as { offset: number }).offset)).toEqual([0, CHUNK, CHUNK * 2]);
    expect(request.mock.calls.every((call) => call[2] === "devbox")).toBe(true);
    expect((chunks()[2]?.[1] as { base64Contents: string }).base64Contents).toBe(btoa("A".repeat(1000)));
    expect(seen).toEqual([CHUNK, CHUNK * 2, CHUNK * 2 + 1000]);
    const ids = new Set(request.mock.calls.map((call) => (call[1] as { id: string }).id));
    expect(ids.size).toBe(1);
    expect(uploadPiece).not.toHaveBeenCalled();
  });

  it("stops at the first piece the machine refuses", async () => {
    old(async () => {
      throw new Error("Unknown method: upload_chunk");
    });
    const file = new File([new Uint8Array(CHUNK * 2)], "banner.psd");
    await expect(upload(fileSource(file), "devbox", "psd")).rejects.toThrow("Unknown method: upload_chunk");
    expect(chunks()).toHaveLength(1);
  });

  it("sends a piece again when the link drops under it", async () => {
    vi.useFakeTimers();
    let first = true;
    old(async () => {
      if (first) {
        first = false;
        throw down();
      }
      return "/tmp/crew/x.txt";
    });
    const sending = upload(fileSource(new File([new Uint8Array(10)], "a.txt")), "devbox", "txt");
    await vi.advanceTimersByTimeAsync(1000);
    await expect(sending).resolves.toBe("/tmp/crew/x.txt");
    expect(chunks()).toHaveLength(2);
  });

  it("asks only for the path when the dropped piece had landed after all", async () => {
    vi.useFakeTimers();
    const answers = [
      () => Promise.reject(down()),
      () => Promise.reject(new Error("Upload is out of order: 10 bytes arrived, the next piece starts at 0")),
    ];
    old(() => answers.shift()?.() ?? Promise.resolve("/tmp/crew/x.txt"));
    const sending = upload(fileSource(new File([new Uint8Array(10)], "a.txt")), "devbox", "txt");
    await vi.advanceTimersByTimeAsync(1000);
    await expect(sending).resolves.toBe("/tmp/crew/x.txt");
    const last = chunks().at(-1)?.[1] as { offset: number; base64Contents: string };
    expect(last.offset).toBe(10);
    expect(last.base64Contents).toBe("");
  });

  it("gives up on a piece the machine keeps dropping", async () => {
    vi.useFakeTimers();
    old(async () => {
      throw down();
    });
    const sending = upload(fileSource(new File([new Uint8Array(10)], "a.txt")), "devbox", "txt");
    const failed = expect(sending).rejects.toThrow("offline");
    await vi.advanceTimersByTimeAsync(20_000);
    await failed;
    expect(chunks()).toHaveLength(5);
  });

  it("stops at once when cancelled, without waiting for the piece in flight", async () => {
    old(() => new Promise(() => {}));
    const controller = new AbortController();
    const sending = upload(memory(CHUNK * 3), "devbox", "bin", undefined, controller.signal);
    const cancelled = expect(sending).rejects.toThrow("Cancelled");
    await vi.waitFor(() => expect(chunks()).toHaveLength(1));
    controller.abort(new Error("Cancelled"));
    await cancelled;
    expect(chunks()).toHaveLength(1);
  });
});

/**
 * A link in fake time: pieces go out one after another at `bandwidth(t)` bytes
 * per ms, and each is acknowledged `latency` ms after its last byte left.
 */
function simulate(latency: number, bandwidth: (at: number) => number, until: number) {
  const window = new UploadWindow();
  const flight: Array<{ sentAt: number; ackAt: number; before: number }> = [];
  const sizes: Array<{ at: number; size: number }> = [];
  let now = 0;
  let free = 0;
  let most = 0;
  const fill = () => {
    while (flight.length < window.size) {
      window.sent(now);
      const start = Math.max(now, free);
      free = start + CHUNK / bandwidth(start);
      flight.push({ sentAt: now, ackAt: free + latency, before: window.delivered });
    }
    most = Math.max(most, flight.length);
  };
  fill();
  while (now < until) {
    const piece = flight.shift();
    if (!piece) break;
    now = piece.ackAt;
    window.acked(now, CHUNK, now - piece.sentAt, piece.before);
    sizes.push({ at: now, size: window.size });
    fill();
  }
  return { sizes, most, final: window.size };
}

/** The most the formula can reach on a steady link: its rate times the shortest round trip plus slack. */
const ceilingOf = (latency: number, bandwidth: number) =>
  Math.min(WINDOW_MAX, Math.floor((bandwidth * (latency + CHUNK / bandwidth + SLACK_MS)) / CHUNK));

describe("UploadWindow", () => {
  it("grows on a fast far link until the link, not the window, is the limit, and stays there", () => {
    // 145 ms away at 10 MB/s.
    const run = simulate(145, () => 10_000, 10_000);
    const ceiling = ceilingOf(145, 10_000);
    expect(ceiling).toBeGreaterThan(20);
    const sizes = run.sizes.map((step) => step.size);
    // One more for a step when a probe goes out.
    expect(Math.max(...sizes)).toBeLessThanOrEqual(ceiling + 1);
    // It never shrinks on a steady link while growing.
    const top = sizes.indexOf(Math.max(...sizes));
    for (let i = 1; i <= top; i++) expect(sizes[i]).toBeGreaterThanOrEqual(sizes[i - 1] ?? 0);
    // A few round trips, not seconds.
    const reached = run.sizes.find((step) => step.size >= ceiling - 1);
    expect(reached?.at).toBeLessThan(1_000);
    expect(run.sizes.filter((step) => step.at > 5_000).every((step) => step.size >= ceiling - 1)).toBe(true);
  });

  it("grows by 1 + SLACK_MS / rtt a round trip while the window is the limit", () => {
    // A link far faster than the window: a round, sent together, comes back a round trip later.
    const window = new UploadWindow();
    const rtt = 145;
    window.sent(0);
    let now = 0;
    const rounds: number[] = [];
    while (rounds.at(-1) !== WINDOW_MAX && rounds.length < 10) {
      const size = window.size;
      const before = window.delivered;
      rounds.push(size);
      now += rtt;
      for (let i = 0; i < size; i++) window.acked(now, CHUNK, rtt, before);
    }
    // 1 + 250 / 145 is 2.7: 2, 5, 13, then the ceiling.
    expect(rounds).toEqual([2, 5, 13, WINDOW_MAX]);
    for (let i = 1; i < rounds.length; i++) {
      expect(rounds[i]).toBe(Math.min(WINDOW_MAX, Math.floor((rounds[i - 1] ?? 0) * (1 + SLACK_MS / rtt))));
    }
  });

  it("reaches the ceiling on a LAN", () => {
    const run = simulate(1, () => 100_000, 2_000);
    expect(run.final).toBe(WINDOW_MAX);
    expect(run.most).toBe(WINDOW_MAX);
  });

  it("stays at one piece on a slow link, but for a rare probe of two, further apart each time", () => {
    // 100 KB/s: one piece takes 1.3 s.
    const run = simulate(145, () => 100, 120_000);
    expect(run.most).toBeLessThanOrEqual(2);
    const above = run.sizes.filter((step) => step.size > 1);
    expect(above.length).toBeLessThanOrEqual(5);
    expect(above[0]?.at).toBeGreaterThanOrEqual(PROBE_MS);
    // Each probe finds nothing, so the next one waits twice as long.
    const probes = run.sizes.filter((step, i) => step.size > 1 && (run.sizes[i - 1]?.size ?? 1) === 1).map((step) => step.at);
    expect(probes.length).toBeGreaterThanOrEqual(3);
    for (let i = 2; i < probes.length; i++) {
      expect((probes[i] ?? 0) - (probes[i - 1] ?? 0)).toBeGreaterThan(1.5 * ((probes[i - 1] ?? 0) - (probes[i - 2] ?? 0)));
    }
    expect(run.final).toBe(1);
  });

  it.each([
    // The link measured stuck at two: 600 ms at 2 MB/s.
    { latency: 600, bandwidth: 2_000, within: 15_000 },
    { latency: 1000, bandwidth: 2_000, within: 40_000 },
    { latency: 1000, bandwidth: 10_000, within: 35_000 },
  ])("fills a $latency ms link at $bandwidth bytes/ms, where the formula alone stays at two", ({ latency, bandwidth, within }) => {
    const run = simulate(latency, () => bandwidth, 60_000);
    const ceiling = ceilingOf(latency, bandwidth);
    // Below rtt / SLACK_MS pieces, floor(size * (1 + SLACK_MS / rtt)) is size again.
    expect(ceiling).toBeGreaterThan(latency / SLACK_MS);
    const reached = run.sizes.find((step) => step.size >= ceiling - 1);
    expect(reached?.at).toBeLessThan(within);
    expect(run.most).toBeLessThanOrEqual(ceiling + 1);
    expect(run.final).toBeGreaterThanOrEqual(ceiling - 1);
  });

  it("holds a link limited window where it is, but for a single probe piece now and then", () => {
    // 140 ms at 3 MB/s: the link, not the window, is the limit.
    const run = simulate(140, () => 3_000, 60_000);
    const ceiling = ceilingOf(140, 3_000);
    const settled = run.sizes.findIndex((step) => step.size >= ceiling);
    expect(run.sizes[settled]?.at).toBeLessThan(2_000);
    const after = run.sizes.slice(settled);
    for (const [i, step] of after.entries()) {
      expect(step.size).toBeGreaterThanOrEqual(ceiling);
      expect(step.size).toBeLessThanOrEqual(ceiling + 1);
      // The probe piece is one step: the next acknowledgement takes it back.
      if (step.size > ceiling) expect(after[i + 1]?.size ?? ceiling).toBe(ceiling);
    }
    // At PROBE_MS, then twice as far apart: 4, 12, 28 s.
    expect(after.filter((step) => step.size > ceiling).length).toBeLessThanOrEqual(3);
    expect(run.most).toBeLessThanOrEqual(ceiling + 1);
    expect(run.final).toBe(ceiling);
  });

  it("leaves one piece once a link that was slow when it started recovers (round trip under SLACK_MS)", () => {
    const run = simulate(145, (at) => (at < 6_000 ? 100 : 10_000), 20_000);
    const after = run.sizes.find((step) => step.at > 6_000 && step.size > 1);
    expect(after?.at).toBeLessThan(6_000 + 3_000);
    expect(run.final).toBeGreaterThanOrEqual(ceilingOf(145, 10_000) - 1);
  });

  it("leaves one piece once a far link that was slow when it started recovers (round trip over SLACK_MS)", () => {
    // At one piece the formula alone gives 1 + 250 / 400: the probe is what gets it out.
    const run = simulate(400, (at) => (at < 6_000 ? 100 : 10_000), 40_000);
    const ceiling = ceilingOf(400, 10_000);
    const settled = run.sizes.find((step) => step.at > 6_000 && step.size >= ceiling - 1);
    // The first probe, at PROBE_MS, met the slow link; the next comes PROBE_MS * 2 later.
    expect(settled?.at).toBeLessThan(PROBE_MS * 3 + 5_000);
    expect(run.final).toBeGreaterThanOrEqual(ceiling - 1);
  });
});
