// Settings › General › Command line: a symlink to the `crew` binary in the
// bundle, so the CLI updates with the app. See install-cli-plan.ts for where
// it goes.

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { access, constants, lstat, mkdir, readlink, symlink, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { app, dialog, ipcMain } from "electron";
import { CLI_CHANNELS, type CliResult, type CliStatus } from "../src/lib/cli";
import {
  adminRemoveScript,
  adminScript,
  chooseDir,
  classify,
  onPath,
  parseMarkedPath,
  PATH_SCRIPT,
  SYSTEM_BIN,
  type Existing,
} from "./install-cli-plan";

// A slow .zshrc should not hang the settings row; past this the app's own PATH is used.
const SHELL_TIMEOUT = 5000;

function cliBinary(): string {
  if (app.isPackaged) return path.join(process.resourcesPath, "crew");
  return path.join(app.getAppPath(), "target/debug/crew");
}

function run(file: string, args: string[], timeout?: number): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { timeout, encoding: "utf8" }, (error, stdout, stderr) => {
      if (error) reject(Object.assign(error, { stderr }));
      else resolve({ stdout, stderr });
    });
  });
}

// A GUI app inherits launchd's PATH, not the one the user's shell builds; -i
// because zsh reads .zshrc, where most PATH edits live, only when interactive.
async function loginShellPath(): Promise<string[]> {
  const shell = process.env.SHELL || "/bin/zsh";
  try {
    const { stdout } = await run(shell, ["-ilc", PATH_SCRIPT], SHELL_TIMEOUT);
    const dirs = parseMarkedPath(stdout);
    if (dirs) return dirs;
  } catch {
    // Fall through to what the app was started with.
  }
  return (process.env.PATH ?? "").split(":").filter(Boolean);
}

async function existing(link: string, source: string): Promise<Existing> {
  try {
    const stat = await lstat(link);
    const target = stat.isSymbolicLink() ? path.resolve(path.dirname(link), await readlink(link)) : null;
    return classify({ isSymbolicLink: stat.isSymbolicLink(), target }, source);
  } catch {
    return classify(null, source);
  }
}

async function writable(dir: string): Promise<boolean> {
  try {
    await access(dir, constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

// Either place install could have chosen.
async function ourLink(source: string): Promise<string | null> {
  for (const dir of [path.join(homedir(), ".local/bin"), SYSTEM_BIN]) {
    const link = path.join(dir, "crew");
    if ((await existing(link, source)) === "ours") return link;
  }
  return null;
}

async function linkAsUser(source: string, link: string): Promise<void> {
  await mkdir(path.dirname(link), { recursive: true });
  await unlink(link).catch(() => {});
  await symlink(source, link);
}

export async function cliStatus(): Promise<CliStatus> {
  const source = cliBinary();
  if (!existsSync(source)) return { state: "unavailable", source };
  const dirs = await loginShellPath();
  const link = await ourLink(source);
  if (link) return { state: "installed", link, onPath: onPath(dirs, path.dirname(link)) };
  return { state: "absent", dir: chooseDir(dirs, homedir()) };
}

// One change to the disk: as the user where they can write (a Homebrew-owned
// /usr/local/bin needs no password), behind macOS's password prompt where
// they cannot. Resolves to what went wrong, if anything.
async function change(dir: string, mine: () => Promise<void>, admin: string): Promise<string | undefined> {
  try {
    if (dir.startsWith(homedir()) || (await writable(dir))) await mine();
    else await run("/usr/bin/osascript", ["-e", admin]);
  } catch (error) {
    const stderr = (error as { stderr?: string }).stderr ?? "";
    // -128 is the password prompt's Cancel: the user said no, nothing failed.
    if (stderr.includes("-128")) return undefined;
    return stderr.trim() || String(error);
  }
  return undefined;
}

export async function installCli(): Promise<CliResult> {
  const status = await cliStatus();
  if (status.state !== "absent") return { status };
  const source = cliBinary();
  const link = path.join(status.dir, "crew");
  const found = await existing(link, source);
  if (found !== "none") {
    const what = found === "file" ? "a file that is not Crew's" : "a link to another crew";
    const { response } = await dialog.showMessageBox({
      type: "warning",
      message: `${link} already exists`,
      detail: `It is ${what}. Replace it with Crew's crew command?`,
      buttons: ["Replace", "Cancel"],
      defaultId: 1,
      cancelId: 1,
    });
    if (response !== 0) return { status };
  }
  const error = await change(status.dir, () => linkAsUser(source, link), adminScript(source, link));
  return { status: await cliStatus(), error };
}

// Only ever Crew's own link: a crew of the user's is not Crew's to remove.
export async function uninstallCli(): Promise<CliResult> {
  const status = await cliStatus();
  if (status.state !== "installed") return { status };
  const { link } = status;
  const error = await change(path.dirname(link), () => unlink(link), adminRemoveScript(link));
  return { status: await cliStatus(), error };
}

export function registerCliIpc(): void {
  ipcMain.handle(CLI_CHANNELS.status, () => cliStatus());
  ipcMain.handle(CLI_CHANNELS.install, () => installCli());
  ipcMain.handle(CLI_CHANNELS.uninstall, () => uninstallCli());
}
