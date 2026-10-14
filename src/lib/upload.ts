import { client } from "./client";
import { LOCAL } from "./client/route";

/** What one message carries: a whole PSD base64'd would be bigger than the socket takes. */
const CHUNK = 4 * 1024 * 1024;

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

/**
 * Sends the file to `envId`'s temp dir in pieces and resolves to its path
 * there. `onProgress` gets the bytes sent so far.
 */
export async function upload(
  source: UploadSource,
  envId: string,
  extension: string,
  onProgress?: (sent: number) => void,
): Promise<string> {
  const id = crypto.randomUUID();
  let path: string;
  let offset = 0;
  do {
    const length = Math.min(CHUNK, source.size - offset);
    const base64Contents = await source.read(offset, length);
    path = await client.request<string>("upload_chunk", { id, extension, offset, base64Contents }, envId);
    offset += length;
    onProgress?.(offset);
  } while (offset < source.size);
  return path;
}
