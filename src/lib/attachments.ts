import { readFileBase64 } from "./api";
import type { AttachedFile } from "./blocks";

/** What Claude's image blocks accept; anything else travels as a path. */
const INLINE_IMAGE: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
};

function extension(name: string): string {
  const index = name.lastIndexOf(".");
  return index > 0 ? name.slice(index + 1).toLowerCase() : "";
}

export function imageMime(name: string): string | null {
  return INLINE_IMAGE[extension(name)] ?? null;
}

export function isImage(file: AttachedFile): boolean {
  return file.kind === "image" || (file.kind === undefined && imageMime(file.name) !== null);
}

export function attachedFrom(path: string, size?: number): AttachedFile {
  const name = path.split("/").pop() ?? path;
  return {
    name,
    path,
    kind: imageMime(name) ? "image" : "file",
    ...(size !== undefined ? { size } : {}),
  };
}

export type InlineImage = { path: string; mediaType: string; data: string };

/** Base64 for the images the provider will get inline; unreadable ones fall back to the path. */
export async function loadInlineImages(files: AttachedFile[]): Promise<InlineImage[]> {
  const images = await Promise.all(
    files.filter(isImage).map(async (file) => {
      const mediaType = imageMime(file.name);
      if (!mediaType) return null;
      try {
        const { data } = await readFileBase64(file.path);
        return { path: file.path, mediaType, data };
      } catch {
        return null;
      }
    }),
  );
  return images.filter((image): image is InlineImage => image !== null);
}

const MAX_CACHED = 64;
const cache = new Map<string, Promise<string>>();

/** A `data:` URL for the thumbnail and the lightbox; the last 64 stay warm. */
export function imageSrc(path: string): Promise<string> {
  let pending = cache.get(path);
  if (!pending) {
    pending = readFileBase64(path).then(({ mime, data }) => `data:${mime};base64,${data}`);
    pending.catch(() => cache.delete(path));
    cache.set(path, pending);
    if (cache.size > MAX_CACHED) {
      const oldest = cache.keys().next().value;
      if (oldest !== undefined) cache.delete(oldest);
    }
  }
  return pending;
}

export function formatBytes(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 10 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  if (size < 1024 * 1024) return `${Math.round(size / 1024)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}
