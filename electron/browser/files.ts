import { randomBytes } from "node:crypto";
import { statSync, watch, type FSWatcher } from "node:fs";
import { realpath, stat } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { ipcMain, net, protocol, shell, type Session, type WebContents } from "electron";
import { FILE_CHANNELS, FILE_SCHEME } from "../../src/lib/browser/files";
import { servedPath, urlFor, within } from "./serve";

/**
 * Each folder a preview was opened from, by the host its URLs carry. The host
 * is random per run, so no page can guess its way into another folder.
 */
const roots = new Map<string, string>();
const hosts = new Map<string, string>();

/** Before the app is ready: a standard, secure scheme gets relative URLs, fetch and storage like https. */
export function registerFileScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: FILE_SCHEME,
      privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true },
    },
  ]);
}

function hostOf(root: string): string {
  let host = hosts.get(root);
  if (!host) {
    host = randomBytes(8).toString("hex");
    hosts.set(root, host);
    roots.set(host, root);
  }
  return host;
}

/**
 * The URL a file previews at, its links resolving against `root`. A file in
 * a hidden folder, which the scheme never serves, gets its own folder as root.
 */
function fileUrl(root: string, file: string): string | null {
  if (!path.isAbsolute(root) || !path.isAbsolute(file)) return null;
  const relative = path.relative(root, file);
  const hidden = relative.split(path.sep).some((segment) => segment.startsWith("."));
  const base = hidden ? path.dirname(file) : root;
  return urlFor(hostOf(base), base, file);
}

/** The file a preview URL names, before symlinks are followed. */
function fileOf(url: string): string | null {
  try {
    const parsed = new URL(url);
    const root = parsed.protocol === `${FILE_SCHEME}:` ? roots.get(parsed.host) : undefined;
    return root ? servedPath(root, parsed.pathname) : null;
  } catch {
    return null;
  }
}

const notFound = () => new Response("Not found", { status: 404, headers: { "content-type": "text/plain" } });

async function serve(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const root = roots.get(url.host);
  const lexical = root ? servedPath(root, url.pathname) : null;
  if (!root || !lexical) return notFound();
  try {
    let target = lexical;
    if ((await stat(target)).isDirectory()) target = path.join(target, "index.html");
    // A symlink inside the worktree must not lead a page out of it.
    const [realRoot, real] = await Promise.all([realpath(root), realpath(target)]);
    if (!within(realRoot, real) || !(await stat(real)).isFile()) return notFound();
    const range = request.headers.get("range");
    return await net.fetch(pathToFileURL(real).href, range ? { headers: { range } } : {});
  } catch {
    return notFound();
  }
}

const served = new WeakSet<Session>();

/**
 * Makes a session answer the scheme: the previews', and the window's for its
 * image viewer. Never a workspace's pages': a web page cannot reach a file.
 */
export function serveFiles(ses: Session): void {
  if (served.has(ses)) return;
  served.add(ses);
  ses.protocol.handle(FILE_SCHEME, serve);
}

/**
 * Reloads a preview when its file changes on disk, so a report an agent
 * rewrites shows its new version. The folder is watched, not the file: an
 * editor or a script that saves by renaming a new file over it leaves a
 * watch on the old one blind.
 */
export function followFile(guest: WebContents): void {
  let watcher: FSWatcher | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const stop = () => {
    clearTimeout(timer);
    watcher?.close();
    watcher = null;
  };
  guest.on("did-navigate", (_event, url) => {
    stop();
    const file = fileOf(url);
    if (!file) return;
    try {
      if (!statSync(file).isFile()) return;
      const name = path.basename(file);
      watcher = watch(path.dirname(file), (_kind, changed) => {
        if (changed !== null && changed !== name) return;
        // One save can land as several events; the page reloads once they settle.
        clearTimeout(timer);
        timer = setTimeout(() => {
          if (!guest.isDestroyed()) guest.reload();
        }, 150);
      });
      watcher.on("error", stop);
    } catch {
      stop();
    }
  });
  guest.once("destroyed", stop);
}

const absolute = (value: unknown): value is string => typeof value === "string" && path.isAbsolute(value);

export function registerFileIpc(): void {
  ipcMain.handle(FILE_CHANNELS.url, (_event, root: unknown, file: unknown) =>
    absolute(root) && absolute(file) ? fileUrl(root, file) : null,
  );
  ipcMain.handle(FILE_CHANNELS.reveal, (_event, file: unknown) => {
    if (absolute(file)) shell.showItemInFolder(file);
  });
  // Resolves to macOS's complaint, or "" once the file is open.
  ipcMain.handle(FILE_CHANNELS.openExternal, (_event, file: unknown) =>
    absolute(file) ? shell.openPath(file) : "Not a file",
  );
}
