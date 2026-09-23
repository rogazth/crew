import { spawn } from "node:child_process";
import { createHash, type Hash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { app, dialog } from "electron";

const RELEASES = "https://github.com/rogazth/crew/releases";
const MANIFEST = `${RELEASES}/latest/download/latest.json`;
const FIRST_CHECK = 15_000;
const EVERY = 6 * 60 * 60 * 1000;

type Manifest = { version: string; zip: string; sha256: string };

let busy = false;
let skipped: string | null = null;

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
  const response = await fetch(MANIFEST, { headers: { "cache-control": "no-cache" } });
  if (!response.ok) throw new Error(`${MANIFEST} answered ${response.status}`);
  const parsed = parseManifest(await response.json());
  if (!parsed) throw new Error("latest.json is not a manifest Crew can use");
  return parsed;
}

async function download(url: string, dest: string, sha256: string): Promise<void> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url} answered ${response.status}`);
  if (!response.body) throw new Error(`${url} answered without a body`);
  const hash = createHash("sha256");
  const hashing = async function* (chunks: AsyncIterable<Uint8Array>, into: Hash) {
    for await (const chunk of chunks) {
      into.update(chunk);
      yield chunk;
    }
  };
  await pipeline(hashing(response.body as AsyncIterable<Uint8Array>, hash), createWriteStream(dest));
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

async function install(manifest: Manifest, target: string): Promise<void> {
  const stage = await mkdtemp(path.join(tmpdir(), "crew-update-"));
  try {
    const zip = path.join(stage, path.basename(manifest.zip));
    await download(manifest.zip, zip, manifest.sha256);
    const unpacked = path.join(stage, "unpacked");
    await run("/usr/bin/ditto", ["-x", "-k", zip, unpacked]);
    const staged = path.join(unpacked, path.basename(target));
    await access(path.join(staged, "Contents", "Info.plist"));
    const script = path.join(stage, "swap.sh");
    await writeFile(script, SWAP, { mode: 0o755 });
    const swap = spawn("/bin/sh", [script, String(process.pid), target, staged, stage], {
      detached: true,
      stdio: "ignore",
    });
    swap.unref();
    // Quitting before the shell runs would leave Crew closed and not updated.
    await new Promise<void>((resolve, reject) => {
      swap.once("spawn", () => resolve());
      swap.once("error", reject);
    });
  } catch (error) {
    await rm(stage, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
  // From here the stage belongs to the swap script, which removes it last.
  app.quit();
}

export async function checkForUpdates(manual = false): Promise<void> {
  if (busy) return;
  const target = bundle();
  if (!app.isPackaged || !target) {
    if (manual) {
      await dialog.showMessageBox({
        type: "info",
        message: "Updates apply to the installed app",
        detail: "This window runs from the checkout, so there is nothing to replace.",
      });
    }
    return;
  }
  busy = true;
  try {
    const manifest = await fetchManifest();
    if (!newer(manifest.version, app.getVersion())) {
      if (manual) {
        await dialog.showMessageBox({
          type: "info",
          message: `Crew ${app.getVersion()} is the latest version`,
        });
      }
      return;
    }
    if (!manual && skipped === manifest.version) return;
    const { response } = await dialog.showMessageBox({
      type: "info",
      message: `Crew ${manifest.version} is available`,
      detail: `You are on ${app.getVersion()}. Crew will replace itself and reopen.`,
      buttons: ["Update and Restart", "Later"],
      defaultId: 0,
      cancelId: 1,
    });
    if (response !== 0) {
      skipped = manifest.version;
      return;
    }
    await install(manifest, target);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    if (manual) {
      await dialog.showMessageBox({ type: "error", message: "Could not update Crew", detail });
    } else {
      console.error(`update check failed: ${detail}`);
    }
  } finally {
    busy = false;
  }
}

export function watchForUpdates(): void {
  if (!app.isPackaged) return;
  const tick = () => void checkForUpdates();
  setTimeout(tick, FIRST_CHECK).unref();
  setInterval(tick, EVERY).unref();
}

