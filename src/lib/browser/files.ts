/**
 * Files shown as pages: what the window and main agree on. A file previews
 * through its own scheme, in its own session, never through `file:`: the
 * scheme serves only what lies inside the folder it was opened from, and the
 * session holds none of the workspace pages' sign-ins. Imported by both sides,
 * so it stays free of DOM and Electron.
 */

export const FILE_SCHEME = "crew-file";

/** In memory: a preview keeps nothing once the app quits. */
export const FILES_PARTITION = "crew-files";

export const FILE_CHANNELS = {
  /** window → main: the URL that serves a file, under the folder it resolves against. */
  url: "files:url",
  reveal: "files:reveal",
  /** Opens the file in the app macOS picks for it. */
  openExternal: "files:open-external",
} as const;

/**
 * How a file tab shows a file. `page` renders it and has a source to edit;
 * `image` opens in the app's viewer; `media` renders in Chromium's own;
 * `text` is the editor.
 */
export type FileView = "page" | "image" | "media" | "text";

const PAGE = new Set(["html", "htm", "svg"]);
const IMAGE = new Set(["png", "jpg", "jpeg", "gif", "webp", "avif", "bmp", "ico"]);
const MEDIA = new Set([
  "pdf",
  "mp4",
  "webm",
  "mov",
  "m4v",
  "mp3",
  "wav",
  "ogg",
  "m4a",
  "flac",
]);

export function fileView(name: string): FileView {
  const dot = name.lastIndexOf(".");
  const ext = dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
  if (PAGE.has(ext)) return "page";
  if (IMAGE.has(ext)) return "image";
  if (MEDIA.has(ext)) return "media";
  return "text";
}

/**
 * The folder a file's relative links resolve against: the worktree it was
 * opened from, or its own folder for a file outside one.
 */
export function previewRoot(path: string, relative: string): string {
  if (!relative.startsWith("/") && path.endsWith(`/${relative}`)) return path.slice(0, -relative.length - 1);
  return path.slice(0, path.lastIndexOf("/")) || "/";
}

/** Whether a URL is one the scheme serves. */
export function isFileUrl(url: string): boolean {
  try {
    return new URL(url).protocol === `${FILE_SCHEME}:`;
  } catch {
    return false;
  }
}
