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
 * Where a file opens. `browser`: a page tab, Chromium's own viewer, with
 * nothing to edit (a PDF, a video); `image`: the app's viewer; `text`: the
 * editor, whose page files have a button to render them in a page tab.
 */
export type FileView = "browser" | "image" | "text";

/** Source a page tab can render: the editor offers to open it there. */
const PAGE = new Set(["html", "htm", "svg"]);
const IMAGE = new Set(["png", "jpg", "jpeg", "gif", "webp", "avif", "bmp", "ico"]);
const BROWSER = new Set([
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

function extension(name: string): string {
  const base = name.slice(name.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : "";
}

export function fileView(name: string): FileView {
  const ext = extension(name);
  if (IMAGE.has(ext)) return "image";
  if (BROWSER.has(ext)) return "browser";
  return "text";
}

/** An HTML or SVG file, which the editor can hand to a page tab to render. */
export function rendersAsPage(name: string): boolean {
  return PAGE.has(extension(name));
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
