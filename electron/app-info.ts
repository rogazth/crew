import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { app, ipcMain, shell } from "electron";
import { APP_INFO_CHANNEL, LICENSES_CHANNEL, type AppInfo } from "../src/lib/appInfo";
import { release, sha } from "./build-info";
import { parseDaemonFile } from "./daemon-agent-plan";

/** The crewd this app talks to writes its version into its data directory. */
async function crewdVersion(): Promise<string | null> {
  const text = await readFile(path.join(app.getPath("userData"), "daemon.json"), "utf8").catch(() => "");
  return parseDaemonFile(text)?.version ?? null;
}

function osLabel(): string {
  const version = process.getSystemVersion();
  if (process.platform === "darwin") return `macOS ${version}`;
  if (process.platform === "win32") return `Windows ${version}`;
  return `Linux ${version}`;
}

async function appInfo(): Promise<AppInfo> {
  return {
    version: app.getVersion(),
    commit: sha,
    arch: process.arch,
    electron: process.versions.electron ?? "",
    chrome: process.versions.chrome ?? "",
    node: process.versions.node,
    os: osLabel(),
    crewd: await crewdVersion(),
    release: app.isPackaged && release,
  };
}

/** The third-party notices file `scripts/licenses.mjs` generates, packaged beside crewd. */
function licensesFile(): string {
  if (app.isPackaged) return path.join(process.resourcesPath, "licenses.txt");
  return path.join(app.getAppPath(), "target", "licenses.txt");
}

export function registerAppInfoIpc(): void {
  ipcMain.handle(APP_INFO_CHANNEL, () => appInfo());
  // Resolves why it could not be opened, or "".
  ipcMain.handle(LICENSES_CHANNEL, async () => {
    const file = licensesFile();
    if (!existsSync(file)) return "The licenses file is generated at build time (npm run licenses).";
    return shell.openPath(file);
  });
}
