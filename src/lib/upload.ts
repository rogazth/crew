import { client } from "./client";
import { LOCAL } from "./client/route";

/**
 * What one message carries. Every call shares one socket, so a piece holds up
 * the heartbeat behind it: on a slow link a big one outlasts the ping timeout
 * and the machine reads as dead mid-upload. Small pieces keep it answering.
 */
export const CHUNK = 128 * 1024;

/** Bytes to send somewhere else, read a piece at a time so a big file is never whole in memory. */
export type UploadSource = {
  name: string;
  size: number;
  /** Base64 of `length` bytes from `offset`. */
  read(offset: number, length: number): Promise<string>;
};

async function base64Of(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  // fromCharCode takes the array as arguments, so a whole screenshot blows the stack.
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

export const base64OfFile = (file: File): Promise<string> => base64Of(file);

export function extensionFor(name: string, type = ""): string {
  return type.split("/")[1] ?? name.split(".").pop() ?? "bin";
}

export function fileSource(file: File): UploadSource {
  return {
    name: file.name,
    size: file.size,
    read: (offset, length) => base64Of(file.slice(offset, offset + length)),
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
        .then((range) => range.data),
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
      const dropped = error instanceof Error && error.name === "EnvDown";
      if (!dropped || attempt >= RETRIES) throw error;
      await sleep(1000 * (attempt + 1), signal);
    }
  }
}

/**
 * Sends the file to `envId`'s temp dir in pieces and resolves to its path
 * there. `onProgress` gets the bytes sent so far; aborting `signal` stops
 * after the piece in flight and rejects with its reason.
 */
export async function upload(
  source: UploadSource,
  envId: string,
  extension: string,
  onProgress?: (sent: number) => void,
  signal?: AbortSignal,
): Promise<string> {
  const id = crypto.randomUUID();
  let path: string;
  let offset = 0;
  do {
    signal?.throwIfAborted();
    const length = Math.min(CHUNK, source.size - offset);
    const base64Contents = await abortable(source.read(offset, length), signal);
    path = await sendPiece(envId, { id, extension, offset, base64Contents }, length, signal);
    offset += length;
    onProgress?.(offset);
  } while (offset < source.size);
  return path;
}
