import { randomBytes } from "node:crypto";
import { statSync, watch, type FSWatcher } from "node:fs";
import { realpath, stat } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { ipcMain, net, protocol, shell, type Session, type WebContents } from "electron";
import { FILE_CHANNELS, FILE_SCHEME } from "../../src/lib/browser/files";
import { servedPath, urlFor, within } from "./serve";

/** A folder whose files live on another machine's `GET /fs`. */
type RemoteRoot = { origin: string; token: string };

/**
 * Each folder a preview was opened from, by the host its URLs carry, with the
 * machine that has it when that is not this Mac. The host is random per run,
 * so no page can guess its way into another folder.
 */
const roots = new Map<string, { root: string; remote?: RemoteRoot }>();
const hosts = new Map<string, string>();

/** How main reaches a machine's daemon, by its id; remotes.ts knows the tokens. */
let resolveRemote: (envId: string) => Promise<RemoteRoot | null> = async () => null;

export function setRemoteResolver(resolve: (envId: string) => Promise<RemoteRoot | null>): void {
  resolveRemote = resolve;
}

/** Before the app is ready: a standard, secure scheme gets relative URLs, fetch and storage like https. */
export function registerFileScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: FILE_SCHEME,
      privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true },
    },
  ]);
}

/** The same folder on two machines is two roots, each with its own host. */
function hostOf(root: string, remote?: RemoteRoot): string {
  const key = remote ? `${remote.origin}|${root}` : root;
  let host = hosts.get(key);
  if (!host) {
    host = randomBytes(8).toString("hex");
    hosts.set(key, host);
    roots.set(host, remote ? { root, remote } : { root });
  }
  return host;
}

/**
 * The URL a file previews at, its links resolving against `root`. A file in
 * a hidden folder, which the scheme never serves, gets its own folder as root.
 */
function fileUrl(root: string, file: string, remote?: RemoteRoot): string | null {
  if (!path.isAbsolute(root) || !path.isAbsolute(file)) return null;
  const relative = path.relative(root, file);
  const hidden = relative.split(path.sep).some((segment) => segment.startsWith("."));
  const base = hidden ? path.dirname(file) : root;
  return urlFor(hostOf(base, remote), base, file);
}

/** The file a preview URL names, before symlinks are followed. */
function fileOf(url: string): string | null {
  try {
    const parsed = new URL(url);
    const entry = parsed.protocol === `${FILE_SCHEME}:` ? roots.get(parsed.host) : undefined;
    return entry && !entry.remote ? servedPath(entry.root, parsed.pathname) : null;
  } catch {
    return null;
  }
}

const notFound = () => new Response("Not found", { status: 404, headers: { "content-type": "text/plain" } });

async function serve(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const { root, remote } = roots.get(url.host) ?? {};
  const lexical = root ? servedPath(root, url.pathname) : null;
  if (!root || !lexical) return notFound();
  if (remote) return proxyRemote(remote, root, url.pathname, request);
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

async function proxyRemote(remote: RemoteRoot, root: string, pathname: string, request: Request): Promise<Response> {
  const target = new URL("/fs", remote.origin);
  target.searchParams.set("root", root);
  target.searchParams.set("path", pathname);
  const headers = new Headers({ authorization: `Bearer ${remote.token}` });
  const range = request.headers.get("range");
  if (range) headers.set("range", range);
  const method = request.method === "HEAD" ? "HEAD" : "GET";
  try {
    return await net.fetch(target.href, { method, headers });
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
function remoteFile(url: string): { remote: RemoteRoot; root: string; pathname: string } | null {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== `${FILE_SCHEME}:`) return null;
    const { root, remote } = roots.get(parsed.host) ?? {};
    if (!root || !remote || !servedPath(root, parsed.pathname)) return null;
    return { remote, root, pathname: parsed.pathname };
  } catch {
    return null;
  }
}

/** The remote file has no local watch. A changed length is a new save. */
function pollRemote(guest: WebContents, file: { remote: RemoteRoot; root: string; pathname: string }): ReturnType<typeof setInterval> {
  const target = new URL("/fs", file.remote.origin);
  target.searchParams.set("root", file.root);
  target.searchParams.set("path", file.pathname);
  let last = "";
  return setInterval(() => {
    void net
      .fetch(target.href, { method: "HEAD", headers: { authorization: `Bearer ${file.remote.token}` } })
      .then((response) => {
        const length = response.headers.get("content-length") ?? "";
        if (last && length && length !== last && !guest.isDestroyed()) guest.reload();
        if (length) last = length;
      })
      .catch(() => {});
  }, 1000);
}

export function followFile(guest: WebContents): void {
  let watcher: FSWatcher | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let poll: ReturnType<typeof setInterval> | undefined;
  const stop = () => {
    clearTimeout(timer);
    if (poll) clearInterval(poll);
    poll = undefined;
    watcher?.close();
    watcher = null;
  };
  guest.on("did-navigate", (_event, url) => {
    stop();
    const remote = remoteFile(url);
    if (remote) {
      poll = pollRemote(guest, remote);
      return;
    }
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

/** The renderer's name for this Mac (src/lib/client/route.ts). */
const LOCAL_ENV = "local";

const absolute = (value: unknown): value is string => typeof value === "string" && path.isAbsolute(value);

export function registerFileIpc(): void {
  // `envId` names the machine the file is on; this Mac when it is absent or "local".
  ipcMain.handle(FILE_CHANNELS.url, async (_event, root: unknown, file: unknown, envId: unknown) => {
    if (!absolute(root) || !absolute(file)) return null;
    if (typeof envId !== "string" || !envId || envId === LOCAL_ENV) return fileUrl(root, file);
    const remote = await resolveRemote(envId);
    return remote ? fileUrl(root, file, remote) : null;
  });
  ipcMain.handle(FILE_CHANNELS.reveal, (_event, file: unknown) => {
    if (absolute(file)) shell.showItemInFolder(file);
  });
  // Resolves to macOS's complaint, or "" once the file is open.
  ipcMain.handle(FILE_CHANNELS.openExternal, (_event, file: unknown) =>
    absolute(file) ? shell.openPath(file) : "Not a file",
  );
}
