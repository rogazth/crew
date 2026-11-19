import { client } from "./client";
import { LOCAL } from "./client/route";

/**
 * What one message carries. Every call shares one socket, so a piece holds up
 * whatever the UI sends that machine next, keystrokes included: on a slow link
 * a big one keeps the rest waiting for seconds. Small pieces keep it responsive.
 */
export const CHUNK = 128 * 1024;

/** Bytes to send somewhere else, read a piece at a time so a big file is never whole in memory. */
export type UploadSource = {
  name: string;
  size: number;
  /** `length` bytes from `offset`. */
  read(offset: number, length: number): Promise<Uint8Array>;
};

function base64OfBytes(bytes: Uint8Array): string {
  // fromCharCode takes the array as arguments, so a whole screenshot blows the stack.
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

function bytesOfBase64(data: string): Uint8Array {
  const binary = atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function bytesOf(blob: Blob): Promise<Uint8Array> {
  return new Uint8Array(await blob.arrayBuffer());
}

export const base64OfFile = async (file: File): Promise<string> => base64OfBytes(await bytesOf(file));

export function extensionFor(name: string, type = ""): string {
  return type.split("/")[1] ?? name.split(".").pop() ?? "bin";
}

export function fileSource(file: File): UploadSource {
  return {
    name: file.name,
    size: file.size,
    read: (offset, length) => bytesOf(file.slice(offset, offset + length)),
  };
}

/** A file on this Mac, read through the local daemon: the picker hands over paths, not bytes. */
export async function pathSource(path: string): Promise<UploadSource> {
  const { size } = await client.request<{ size: number; data: string }>(
    "read_file_range",
    { path, offset: 0, length: 0 },
    LOCAL,
  );
  return {
    name: path.split("/").pop() ?? path,
    size,
    read: (offset, length) =>
      client
        .request<{ size: number; data: string }>("read_file_range", { path, offset, length }, LOCAL)
        .then((range) => bytesOfBase64(range.data)),
  };
}

/** Rejects as soon as `signal` aborts, whatever the pending piece is doing. */
function abortable<T>(work: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return work;
  return new Promise<T>((resolve, reject) => {
    const stop = () => reject(signal.reason);
    if (signal.aborted) return stop();
    signal.addEventListener("abort", stop, { once: true });
    work.then(resolve, reject).finally(() => signal.removeEventListener("abort", stop));
  });
}

/** How many times one piece is sent again after the link drops under it. */
const RETRIES = 4;

const sleep = (ms: number, signal?: AbortSignal) =>
  abortable(new Promise<void>((resolve) => setTimeout(resolve, ms)), signal);

const dropped = (error: unknown) => error instanceof Error && error.name === "EnvDown";

/** `call` again after the link drops under it, with the same backoff a legacy piece gets. */
async function retried<T>(call: () => Promise<T>, signal: AbortSignal): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await abortable(call(), signal);
    } catch (error) {
      if (signal.aborted || !dropped(error) || attempt >= RETRIES) throw error;
      await sleep(1000 * (attempt + 1), signal);
    }
  }
}

/** Pieces in flight before anything is measured. */
export const WINDOW_START = 2;
export const WINDOW_MAX = 32;
/** How long a piece beyond what the link carries may queue on the socket, ahead of the heartbeat and every other call. */
export const SLACK_MS = 250;
/** Time between tries of one piece more than the formula allows; it doubles each time that piece turns out no faster. */
export const PROBE_MS = 4_000;

/**
 * How many pieces may be in flight: `rate * (rtt + SLACK_MS) / CHUNK`. Of the
 * bytes in flight, `rate * rtt` are travelling and hold up nothing; whatever
 * is beyond that queues on the socket ahead of the heartbeat and of every
 * other call to that machine, for about `SLACK_MS`. So a slow link stays at one
 * piece, a fast far one gets enough to fill the pipe, a LAN reaches the
 * ceiling, and the rest of the UI waits a quarter second more, not seconds.
 *
 * `rtt` is the shortest send-to-acknowledgement of any piece: a floor on the
 * link's round trip, which a slow spell cannot raise. `rate`, on each
 * acknowledgement, is the bytes acknowledged while that piece was out over the
 * time it was out. While the window is the limit that is `size * CHUNK / rtt`,
 * so each round trip grows the window by `1 + SLACK_MS / rtt`; once the link is
 * the limit it is the link's rate, and the window settles. Spanning a whole
 * round trip, it is not fooled by answers that arrive in bunches. A rate over
 * the last few seconds would be steadier but lags: it reads the rate of the
 * window of a second ago, and growth takes seconds instead of round trips.
 *
 * A piece only counts the pieces ahead of it, so pieces sent together read
 * one, two, three: the first ones would shrink the window, the next round
 * would go out together again, and on a far link the window would saw between
 * one and two for good. The window is the most any piece read over the last
 * round trip instead, so a whole round speaks, and a link that slows down is
 * followed a round trip later.
 *
 * The window outgrows itself only by `floor(size * (1 + SLACK_MS / rtt))`,
 * which needs `size >= rtt / SLACK_MS`: past a `SLACK_MS` round trip a small
 * window stays where it is, however fast the link (at 600 ms, under three).
 * The formula cannot tell a far link from a full one, so when it does not grow
 * the window it allows one piece more for a step, at most every `PROBE_MS`. That
 * piece's reading counts every answer during its flight, those of the pieces
 * ahead of it included: on a far link it reads `size + 1` even though the
 * answers of those pieces set the window back meanwhile, and the formula grows
 * from there; on a slow or full link it only queued, it reads the same, the
 * window falls back, and the next probe waits twice as long. The gap starts
 * over once the window passes where the last probe started.
 */
export class UploadWindow {
  /** Pieces allowed in flight. */
  size = WINDOW_START;
  /** Bytes acknowledged so far; a piece notes it when it goes out. */
  delivered = 0;
  private rtt = Infinity;
  /** What each acknowledgement of the last round trip says fits, oldest first. */
  private recent: Array<{ at: number; fits: number }> = [];
  private probeAt: number | null = null;
  private probeGap = PROBE_MS;
  /** The window the last probe started from, until the window passes it. */
  private probedFrom: number | null = null;

  /** A piece went out at `now`. */
  sent(now: number): void {
    this.probeAt ??= now + PROBE_MS;
  }

  /**
   * A piece of `bytes` was acknowledged at `now`, `took` ms after it went out,
   * when `delivered` was `before`.
   */
  acked(now: number, bytes: number, took: number, before: number): void {
    this.delivered += bytes;
    const out = Math.max(took, 1);
    this.rtt = Math.min(this.rtt, out);
    const rate = (this.delivered - before) / out;
    this.recent.push({ at: now, fits: Math.floor((rate * (this.rtt + SLACK_MS)) / CHUNK) });
    while ((this.recent[0]?.at ?? now) < now - this.rtt) this.recent.shift();
    const fits = Math.min(Math.max(...this.recent.map((sample) => sample.fits), 1), WINDOW_MAX);
    const was = this.size;
    this.size = fits;
    if (this.probedFrom !== null && fits > this.probedFrom) {
      this.probedFrom = null;
      this.probeGap = PROBE_MS;
      this.probeAt = now + PROBE_MS;
    } else if (fits <= was && fits < WINDOW_MAX && now >= (this.probeAt ?? now)) {
      this.probedFrom = fits;
      this.size = fits + 1;
      this.probeGap *= 2;
      this.probeAt = now + this.probeGap;
    }
  }
}

/**
 * Pieces as binary frames, several in flight. Reads stay in order, one at a
 * time; a piece goes out as soon as its slot opens. Writes on the machine are
 * idempotent, so a piece the link dropped is simply sent again, alone.
 */
async function sendPieces(
  source: UploadSource,
  id: string,
  envId: string,
  onProgress: ((sent: number) => void) | undefined,
  stop: AbortController,
): Promise<void> {
  const signal = stop.signal;
  const window = new UploadWindow();
  // A zero byte file is still one piece, so the machine has something to finish.
  const count = Math.max(1, Math.ceil(source.size / CHUNK));
  let inFlight = 0;
  let acked = 0;
  let opened: (() => void) | null = null;
  const slot = () =>
    abortable(
      new Promise<void>((resolve) => {
        opened = resolve;
      }),
      signal,
    );

  for (let index = 0; index < count; index++) {
    while (inFlight >= window.size) await slot();
    const offset = index * CHUNK;
    const length = Math.min(CHUNK, source.size - offset);
    const bytes = await abortable(source.read(offset, length), signal);
    signal.throwIfAborted();
    inFlight++;
    window.sent(performance.now());
    void retried(async () => {
      const started = performance.now();
      const before = window.delivered;
      await client.uploadPiece(id, offset, bytes, envId);
      return { took: performance.now() - started, before };
    }, signal)
      .then(({ took, before }) => {
        if (signal.aborted) return;
        inFlight--;
        acked += length;
        window.acked(performance.now(), length, took, before);
        onProgress?.(acked);
        const wake = opened;
        opened = null;
        wake?.();
      })
      // The first error stops the rest; the answers of pieces still out are ignored.
      .catch((error: unknown) => {
        if (!signal.aborted) stop.abort(error);
      });
  }
  while (inFlight > 0) await slot();
}

/**
 * One piece. A link that drops mid-call says nothing of whether the machine
 * got it, so the piece goes again once the link is back. If it had landed, the
 * machine answers that the file is already past `offset`: an empty piece at
 * the end of it returns the path without writing anything.
 */
async function sendPiece(
  envId: string,
  piece: { id: string; extension: string; offset: number; base64Contents: string },
  length: number,
  signal?: AbortSignal,
): Promise<string> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await abortable(client.request<string>("upload_chunk", piece, envId), signal);
    } catch (error) {
      if (signal?.aborted) throw error;
      const message = error instanceof Error ? error.message : "";
      const arrived = /out of order: (\d+) bytes arrived/.exec(message);
      if (attempt > 0 && arrived && Number(arrived[1]) === piece.offset + length) {
        return abortable(
          client.request<string>("upload_chunk", { ...piece, offset: piece.offset + length, base64Contents: "" }, envId),
          signal,
        );
      }
      if (!dropped(error) || attempt >= RETRIES) throw error;
      await sleep(1000 * (attempt + 1), signal);
    }
  }
}

/** A machine older than `upload_begin`: base64 pieces, one at a time, each waiting for the last. */
async function uploadInOrder(
  source: UploadSource,
  id: string,
  envId: string,
  extension: string,
  onProgress: ((sent: number) => void) | undefined,
  signal: AbortSignal,
): Promise<string> {
  let path: string;
  let offset = 0;
  do {
    signal.throwIfAborted();
    const length = Math.min(CHUNK, source.size - offset);
    const base64Contents = base64OfBytes(await abortable(source.read(offset, length), signal));
    path = await sendPiece(envId, { id, extension, offset, base64Contents }, length, signal);
    offset += length;
    onProgress?.(offset);
  } while (offset < source.size);
  return path;
}

/**
 * Sends the file to `envId`'s temp dir in pieces and resolves to its path
 * there. `onProgress` gets the bytes the machine has acknowledged so far;
 * aborting `signal` rejects at once with its reason and sends nothing more.
 *
 * A machine that does not know `upload_begin` has not been updated yet (remotes
 * update only when idle), so it gets the older way. Nothing is remembered
 * between uploads: it may be updated by the next one.
 */
export async function upload(
  source: UploadSource,
  envId: string,
  extension: string,
  onProgress?: (sent: number) => void,
  signal?: AbortSignal,
): Promise<string> {
  signal?.throwIfAborted();
  const id = crypto.randomUUID();
  // The caller's abort, or the first error that is not a dropped link, stops every piece at once.
  const stop = new AbortController();
  const cancel = () => stop.abort(signal?.reason);
  signal?.addEventListener("abort", cancel, { once: true });
  try {
    try {
      await retried(() => client.request("upload_begin", { id }, envId), stop.signal);
    } catch (error) {
      if (!stop.signal.aborted && error instanceof Error && error.message.includes("Unknown method: upload_begin")) {
        return await uploadInOrder(source, id, envId, extension, onProgress, stop.signal);
      }
      throw error;
    }
    await sendPieces(source, id, envId, onProgress, stop);
    return await retried(
      () => client.request<string>("upload_finish", { id, extension, size: source.size }, envId),
      stop.signal,
    );
  } catch (error) {
    throw stop.signal.aborted ? stop.signal.reason : error;
  } finally {
    signal?.removeEventListener("abort", cancel);
    if (!stop.signal.aborted) stop.abort();
  }
}
