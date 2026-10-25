import { spawn } from "node:child_process";
import { createHash, type Hash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { app, BrowserWindow, ipcMain } from "electron";
import {
  notesOf,
  UPDATE_CHANNELS,
  type PublishedRelease,
  type ReleaseList,
  type ReleaseNote,
  type UpdateOffer,
  type UpdatePhase,
} from "../src/lib/update";
import { release } from "./build-info";
import { openSigned } from "./update-signature";

const REPO = "rogazth/crew";
const RELEASES = `https://github.com/${REPO}/releases`;
const RELEASES_API = `https://api.github.com/repos/${REPO}/releases?per_page=12`;
const RELEASES_TTL = 30 * 60 * 1000;
// latest.json signed; copies from before signing still read latest.json itself.
const MANIFEST = `${RELEASES}/latest/download/latest.signed.json`;
const FIRST_CHECK = 15_000;
const EVERY = 6 * 60 * 60 * 1000;
const PROGRESS_EVERY = 100;

/** `size`, `date` and `notes` are optional in latest.json: releases cut before they were added lack them. */
type Manifest = {
  version: string;
  zip: string;
  sha256: string;
  size: number | null;
  date: string | null;
  notes: ReleaseNote[];
};

/** A downloaded, unpacked release waiting to replace the bundle. */
type Staged = { stage: string; script: string; app: string; target: string };

let busy = false;
let skipped: string | null = null;
let phase: UpdatePhase = { phase: "idle" };
let checkedAt: number | null = null;
let offered: Manifest | null = null;
let staged: Staged | null = null;
let applied = false;
let auto = false;
let aborting: AbortController | null = null;
let ensureWindow: (() => void) | null = null;

function parseNotes(value: unknown): ReleaseNote[] {
  if (!Array.isArray(value)) return [];
  const notes: ReleaseNote[] = [];
  for (const item of value) {
    if (typeof item !== "object" || item === null) continue;
    const { kind, text } = item as Record<string, unknown>;
    if ((kind === "new" || kind === "improved" || kind === "fixed") && typeof text === "string" && text) {
      notes.push({ kind, text });
    }
  }
  return notes;
}

function parseManifest(value: unknown): Manifest | null {
  if (typeof value !== "object" || value === null) return null;
  const { version, zip, sha256, size, date, notes } = value as Record<string, unknown>;
  if (typeof version !== "string" || typeof zip !== "string" || typeof sha256 !== "string") return null;
  if (!/^[0-9a-f]{64}$/.test(sha256)) return null;
  // The url ends up as an argument to a shell script that replaces the bundle;
  // anything outside the release host is a redirect we did not publish.
  if (!zip.startsWith(`${RELEASES}/download/`)) return null;
  return {
    version,
    zip,
    sha256,
    size: typeof size === "number" && size > 0 ? size : null,
    date: typeof date === "string" && !Number.isNaN(new Date(date).getTime()) ? date : null,
    notes: parseNotes(notes),
  };
}

function offerOf(manifest: Manifest): UpdateOffer {
  return {
    version: manifest.version,
    current: app.getVersion(),
    size: manifest.size,
    date: manifest.date,
    notes: manifest.notes,
  };
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
  const parsed = parseManifest(JSON.parse(openSigned(await response.json())));
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
// Installing on quit leaves the app closed; restarting to install opens it.
const SWAP = `#!/bin/sh
pid="$1"; target="$2"; staged="$3"; stage="$4"; reopen="$5"
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
[ "$reopen" = 1 ] && /usr/bin/open "$target"
/bin/rm -rf "$stage"
`;

function snapshot() {
  return { ...phase, checkedAt };
}

/** Sends the phase to every window; one that opens later asks for it. */
function set(next: UpdatePhase): void {
  phase = next;
  for (const window of BrowserWindow.getAllWindows()) window.webContents.send(UPDATE_CHANNELS.state, snapshot());
}

function inFlight(): boolean {
  return (
    phase.phase === "downloading" ||
    phase.phase === "staging" ||
    phase.phase === "ready" ||
    phase.phase === "restarting"
  );
}

/** Downloads, verifies and unpacks the release next to the installed one; nothing is replaced yet. */
async function stage(manifest: Manifest, target: string): Promise<void> {
  const controller = new AbortController();
  aborting = controller;
  const offer = offerOf(manifest);
  let dir: string | null = null;
  try {
    dir = await mkdtemp(path.join(tmpdir(), "crew-update-"));
    const zip = path.join(dir, path.basename(manifest.zip));
    let sent = 0;
    await download(manifest.zip, zip, manifest.sha256, controller.signal, (received, total) => {
      // A chunk lands every few kilobytes; the bar only needs a few frames a second.
      const now = Date.now();
      if (now - sent < PROGRESS_EVERY && received !== total) return;
      sent = now;
      set({ phase: "downloading", offer, received, total });
    });
    aborting = null;
    set({ phase: "staging", offer });
    const unpacked = path.join(dir, "unpacked");
    await run("/usr/bin/ditto", ["-x", "-k", zip, unpacked]);
    const bundled = path.join(unpacked, path.basename(target));
    await access(path.join(bundled, "Contents", "Info.plist"));
    const script = path.join(dir, "swap.sh");
    await writeFile(script, SWAP, { mode: 0o755 });
    await rm(zip, { force: true });
    staged = { stage: dir, script, app: bundled, target };
    applied = false;
    set({ phase: "ready", offer });
  } catch (error) {
    if (dir) await rm(dir, { recursive: true, force: true });
    if (controller.signal.aborted) {
      set({ phase: "available", offer });
      return;
    }
    set({ phase: "error", message: error instanceof Error ? error.message : String(error) });
  } finally {
    aborting = null;
  }
}

/** Hands the swap to a shell that outlives this process. Once only. */
function applyStaged(reopen: boolean): boolean {
  if (!staged || applied) return false;
  applied = true;
  const { script, target, app: bundled, stage: dir } = staged;
  const swap = spawn("/bin/sh", [script, String(process.pid), target, bundled, dir, reopen ? "1" : "0"], {
    detached: true,
    stdio: "ignore",
  });
  swap.unref();
  return true;
}

/** The user quit with a release staged: it goes in as the app closes, and opens on the next launch. */
export function installStagedOnQuit(): void {
  applyStaged(false);
}

function startDownload(): void {
  const target = bundle();
  if (phase.phase !== "available" || !offered || !target) return;
  // Claim the download before stage() awaits anything, so a second click can't start another.
  set({ phase: "downloading", offer: offerOf(offered), received: 0, total: null });
  void stage(offered, target);
}

export async function checkForUpdates(manual = false): Promise<void> {
  if (inFlight()) return;
  if (busy) return;
  // A local build updating itself would turn into the release, on the installed app's data.
  if (!app.isPackaged || !release || !bundle()) {
    if (manual) set({ phase: "unpackaged" });
    return;
  }
  busy = true;
  if (manual) set({ phase: "checking" });
  try {
    const manifest = await fetchManifest();
    checkedAt = Date.now();
    if (!newer(manifest.version, app.getVersion())) {
      // A quiet check that finds nothing leaves the page as it was.
      set(manual || phase.phase === "available" ? { phase: "latest", version: app.getVersion() } : phase);
      return;
    }
    if (!manual && skipped === manifest.version) {
      set(phase);
      return;
    }
    offered = manifest;
    set({ phase: "available", offer: offerOf(manifest) });
    if (auto) startDownload();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (manual) set({ phase: "error", message });
    else {
      console.error(`update check failed: ${message}`);
      set(phase);
    }
  } finally {
    busy = false;
  }
}

/** The menu's "Check for Updates…": the About page opens on the answer. */
export function checkFromMenu(): void {
  const show = () => {
    for (const window of BrowserWindow.getAllWindows()) window.webContents.send(UPDATE_CHANNELS.show);
  };
  if (BrowserWindow.getAllWindows().length > 0) show();
  else {
    ensureWindow?.();
    // A window that is still loading has no one listening yet.
    BrowserWindow.getAllWindows()[0]?.webContents.once("did-finish-load", () => setTimeout(show, 600));
  }
  void checkForUpdates(true);
}

/* ── What's new: the published releases ─────────────────────────────── */

let memory: { at: number; releases: PublishedRelease[] } | null = null;

function cacheFile(): string {
  return path.join(app.getPath("userData"), "releases.json");
}

function parseReleases(value: unknown): PublishedRelease[] {
  if (!Array.isArray(value)) return [];
  const list: PublishedRelease[] = [];
  for (const item of value) {
    if (typeof item !== "object" || item === null) continue;
    const { tag_name, published_at, html_url, body, draft, prerelease } = item as Record<string, unknown>;
    if (draft === true || prerelease === true) continue;
    if (typeof tag_name !== "string" || typeof published_at !== "string" || typeof html_url !== "string") continue;
    if (!html_url.startsWith(`${RELEASES}/`)) continue;
    list.push({
      version: tag_name.replace(/^v/, ""),
      date: published_at,
      url: html_url,
      notes: notesOf(typeof body === "string" ? body : ""),
    });
  }
  return list;
}

/** Cached for half an hour in memory and kept on disk, so an offline Crew still shows the last it saw. */
async function publishedReleases(): Promise<ReleaseList> {
  if (memory && Date.now() - memory.at < RELEASES_TTL) return { releases: memory.releases, stale: false };
  try {
    const response = await fetch(RELEASES_API, {
      headers: { accept: "application/vnd.github+json" },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error(`${RELEASES_API} answered ${response.status}`);
    const releases = parseReleases(await response.json());
    memory = { at: Date.now(), releases };
    await writeFile(cacheFile(), JSON.stringify(releases)).catch(() => {});
    return { releases, stale: false };
  } catch {
    const cached = memory?.releases ?? parseStored(await readFile(cacheFile(), "utf8").catch(() => ""));
    return { releases: cached, stale: true };
  }
}

function parseStored(text: string): PublishedRelease[] {
  try {
    const value: unknown = JSON.parse(text);
    if (!Array.isArray(value)) return [];
    return value.filter(
      (item): item is PublishedRelease =>
        typeof item === "object" &&
        item !== null &&
        typeof (item as PublishedRelease).version === "string" &&
        typeof (item as PublishedRelease).date === "string" &&
        typeof (item as PublishedRelease).url === "string" &&
        Array.isArray((item as PublishedRelease).notes),
    );
  } catch {
    return [];
  }
}

function registerIpc(): void {
  ipcMain.handle(UPDATE_CHANNELS.current, () => snapshot());
  ipcMain.handle(UPDATE_CHANNELS.check, () => checkForUpdates(true));
  ipcMain.handle(UPDATE_CHANNELS.download, () => startDownload());
  ipcMain.handle(UPDATE_CHANNELS.restart, () => {
    if (phase.phase !== "ready" || !applyStaged(true)) return;
    set({ phase: "restarting", offer: phase.offer });
    app.quit();
  });
  ipcMain.handle(UPDATE_CHANNELS.dismiss, () => {
    // A staged release stays: it installs when Crew quits.
    if (inFlight()) return;
    if (phase.phase === "available") skipped = phase.offer.version;
    set({ phase: "idle" });
  });
  ipcMain.handle(UPDATE_CHANNELS.cancel, () => aborting?.abort());
  ipcMain.handle(UPDATE_CHANNELS.auto, (_event, on: unknown) => {
    auto = on === true;
    // Switched on while a release is waiting to be asked for: take it now.
    if (auto) startDownload();
  });
  ipcMain.handle(UPDATE_CHANNELS.releases, () => publishedReleases());
}

/** `open` brings a window back when the menu asks for a check and none is open. */
export function watchForUpdates(open: () => void): void {
  ensureWindow = open;
  registerIpc();
  if (!app.isPackaged || !release) return;
  const tick = () => void checkForUpdates();
  setTimeout(tick, FIRST_CHECK).unref();
  setInterval(tick, EVERY).unref();
}
