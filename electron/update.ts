import { spawn } from "node:child_process";
import { createHash, type Hash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { app, BrowserWindow, ipcMain } from "electron";
import { UPDATE_CHANNELS, type UpdateState } from "../src/lib/update";

const RELEASES = "https://github.com/rogazth/crew/releases";
const MANIFEST = `${RELEASES}/latest/download/latest.json`;
const FIRST_CHECK = 15_000;
const EVERY = 6 * 60 * 60 * 1000;
const PROGRESS_EVERY = 100;

type Manifest = { version: string; zip: string; sha256: string };

let busy = false;
let skipped: string | null = null;
let state: UpdateState = { phase: "idle" };
let offered: Manifest | null = null;
let aborting: AbortController | null = null;
let ensureWindow: (() => void) | null = null;

function parseManifest(value: unknown): Manifest | null {
  if (typeof value !== "object" || value === null) return null;
  const { version, zip, sha256 } = value as Record<string, unknown>;
  if (typeof version !== "string" || typeof zip !== "string" || typeof sha256 !== "string") return null;
  if (!/^[0-9a-f]{64}$/.test(sha256)) return null;
  // The url ends up as an argument to a shell script that replaces the bundle;
  // anything outside the release host is a redirect we did not publish.
  if (!zip.startsWith(`${RELEASES}/download/`)) return null;
  return { version, zip, sha256 };
}

function newer(latest: string, current: string): boolean {
  const parts = (value: string): number[] | null => {
    const numbers = value.split(".").map((part) => Number(part));
    if (numbers.length !== 3) return null;
    return numbers.every((n) => Number.isInteger(n) && n >= 0) ? numbers : null;
  };
  const a = parts(latest);
  const b = parts(current);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i += 1) {
    if (a[i] !== b[i]) return (a[i] as number) > (b[i] as number);
  }
  return false;
}

function bundle(): string | null {
  const marker = `.app${path.sep}Contents${path.sep}MacOS${path.sep}`;
  const at = app.getPath("exe").indexOf(marker);
  if (at < 0) return null;
  return app.getPath("exe").slice(0, at + 4);
}

async function fetchManifest(): Promise<Manifest> {
  const response = await fetch(MANIFEST, {
    headers: { "cache-control": "no-cache" },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`${MANIFEST} answered ${response.status}`);
  const parsed = parseManifest(await response.json());
  if (!parsed) throw new Error("latest.json is not a manifest Crew can use");
  return parsed;
}

async function download(
  url: string,
  dest: string,
  sha256: string,
  signal: AbortSignal,
  progress: (received: number, total: number | null) => void,
): Promise<void> {
  const response = await fetch(url, { signal });
  if (!response.ok) throw new Error(`${url} answered ${response.status}`);
  if (!response.body) throw new Error(`${url} answered without a body`);
  const length = Number(response.headers.get("content-length"));
  const total = Number.isFinite(length) && length > 0 ? length : null;
  const hash = createHash("sha256");
  let received = 0;
  const hashing = async function* (chunks: AsyncIterable<Uint8Array>, into: Hash) {
    for await (const chunk of chunks) {
      into.update(chunk);
      received += chunk.byteLength;
      progress(received, total);
      yield chunk;
    }
  };
  await pipeline(hashing(response.body as AsyncIterable<Uint8Array>, hash), createWriteStream(dest), { signal });
  const got = hash.digest("hex");
  if (got !== sha256) throw new Error(`checksum mismatch: the manifest says ${sha256}, the download is ${got}`);
}

function run(command: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} exited ${code ?? "?"}: ${stderr.trim()}`));
    });
  });
}

// The bundle cannot replace itself while it is the running executable, so the
// swap happens from a detached shell that waits for this process to be gone.
const SWAP = `#!/bin/sh
pid="$1"; target="$2"; staged="$3"; stage="$4"
while /bin/kill -0 "$pid" 2>/dev/null; do sleep 0.2; done
old="$target.crew-old"
/bin/rm -rf "$old"
if /bin/mv "$target" "$old"; then
  if /usr/bin/ditto "$staged" "$target"; then
    /bin/rm -rf "$old"
  else
    /bin/rm -rf "$target"
    /bin/mv "$old" "$target"
  fi
fi
/usr/bin/xattr -dr com.apple.quarantine "$target" 2>/dev/null
/usr/bin/open "$target"
/bin/rm -rf "$stage"
`;

/** Sends the phase to every window; one that opens later asks for it. */
function set(next: UpdateState): void {
  state = next;
  for (const window of BrowserWindow.getAllWindows()) window.webContents.send(UPDATE_CHANNELS.state, next);
}

function inFlight(): boolean {
  return state.phase === "downloading" || state.phase === "installing" || state.phase === "restarting";
}

async function install(manifest: Manifest, target: string): Promise<void> {
  const controller = new AbortController();
  aborting = controller;
  const stage = await mkdtemp(path.join(tmpdir(), "crew-update-"));
  try {
    const zip = path.join(stage, path.basename(manifest.zip));
    set({ phase: "downloading", version: manifest.version, received: 0, total: null });
    let sent = 0;
    await download(manifest.zip, zip, manifest.sha256, controller.signal, (received, total) => {
      // A chunk lands every few kilobytes; the bar only needs a few frames a second.
      const now = Date.now();
      if (now - sent < PROGRESS_EVERY && received !== total) return;
      sent = now;
      set({ phase: "downloading", version: manifest.version, received, total });
    });
    aborting = null;
    set({ phase: "installing", version: manifest.version });
    const unpacked = path.join(stage, "unpacked");
    await run("/usr/bin/ditto", ["-x", "-k", zip, unpacked]);
    const staged = path.join(unpacked, path.basename(target));
    await access(path.join(staged, "Contents", "Info.plist"));
    const script = path.join(stage, "swap.sh");
    await writeFile(script, SWAP, { mode: 0o755 });
    set({ phase: "restarting", version: manifest.version });
    const swap = spawn("/bin/sh", [script, String(process.pid), target, staged, stage], {
      detached: true,
      stdio: "ignore",
    });
    swap.unref();
    app.quit();
  } catch (error) {
    await rm(stage, { recursive: true, force: true });
    if (controller.signal.aborted) {
      set({ phase: "idle" });
      return;
    }
    set({ phase: "error", message: error instanceof Error ? error.message : String(error) });
  } finally {
    aborting = null;
  }
}

export async function checkForUpdates(manual = false): Promise<void> {
  if (manual) ensureWindow?.();
  if (inFlight()) {
    // The dialog may have been closed by a reload; the menu brings it back.
    if (manual) set(state);
    return;
  }
  if (busy) return;
  if (!app.isPackaged || !bundle()) {
    if (manual) set({ phase: "unpackaged" });
    return;
  }
  busy = true;
  if (manual) set({ phase: "checking" });
  try {
    const manifest = await fetchManifest();
    if (!newer(manifest.version, app.getVersion())) {
      if (manual) set({ phase: "latest", version: app.getVersion() });
      return;
    }
    if (!manual && skipped === manifest.version) return;
    offered = manifest;
    set({ phase: "available", version: manifest.version, current: app.getVersion() });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (manual) set({ phase: "error", message });
    else console.error(`update check failed: ${message}`);
  } finally {
    busy = false;
  }
}

function registerIpc(): void {
  ipcMain.handle(UPDATE_CHANNELS.current, () => state);
  ipcMain.handle(UPDATE_CHANNELS.install, () => {
    const target = bundle();
    if (state.phase !== "available" || !offered || !target) return;
    void install(offered, target);
  });
  ipcMain.handle(UPDATE_CHANNELS.dismiss, () => {
    if (inFlight()) return;
    if (state.phase === "available") skipped = state.version;
    set({ phase: "idle" });
  });
  ipcMain.handle(UPDATE_CHANNELS.cancel, () => aborting?.abort());
}

/** `open` brings a window back when the menu asks for a check and none is open. */
export function watchForUpdates(open: () => void): void {
  ensureWindow = open;
  registerIpc();
  if (!app.isPackaged) return;
  const tick = () => void checkForUpdates();
  setTimeout(tick, FIRST_CHECK).unref();
  setInterval(tick, EVERY).unref();
}
