// "Install `crew` Command…": a symlink to the `crew` binary in the bundle, so
// the CLI updates with the app. See install-cli-plan.ts for where it goes.

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { access, constants, lstat, mkdir, readlink, symlink, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { app, dialog } from "electron";
import { adminScript, chooseDir, classify, onPath, parseMarkedPath, PATH_SCRIPT, type Existing } from "./install-cli-plan";

// A slow .zshrc should not hang the menu; past this the app's own PATH is used.
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

async function linkAsUser(source: string, link: string): Promise<void> {
  await mkdir(path.dirname(link), { recursive: true });
  await unlink(link).catch(() => {});
  await symlink(source, link);
}

export async function installCli(): Promise<void> {
  const source = cliBinary();
  if (!existsSync(source)) {
    await dialog.showMessageBox({
      type: "error",
      message: "The crew command is missing from this build",
      detail: app.isPackaged
        ? `Expected it at ${source}. Reinstalling Crew puts it back.`
        : `Expected it at ${source}. Build it with: cargo build -p crew-cli`,
    });
    return;
  }
  const dirs = await loginShellPath();
  const dir = chooseDir(dirs, homedir());
  const link = path.join(dir, "crew");
  const found = await existing(link, source);
  if (found === "ours") {
    await dialog.showMessageBox({ type: "info", message: "The crew command is already installed", detail: `${link} → ${source}` });
    return;
  }
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
    if (response !== 0) return;
  }
  // A Homebrew-owned /usr/local/bin is the user's to write, and needs no password.
  const asUser = dir.startsWith(homedir()) || (await writable(dir));
  try {
    if (asUser) {
      await linkAsUser(source, link);
    } else {
      await run("/usr/bin/osascript", ["-e", adminScript(source, link)]);
    }
  } catch (error) {
    const stderr = (error as { stderr?: string }).stderr ?? "";
    // -128 is the password prompt's Cancel: the user said no, nothing failed.
    if (stderr.includes("-128")) return;
    await dialog.showMessageBox({
      type: "error",
      message: "Couldn't install the crew command",
      detail: stderr.trim() || String(error),
    });
    return;
  }
  const note = onPath(dirs, dir) ? "" : `\n\n${dir} is not on your shell's PATH yet; add it to use crew by name.`;
  await dialog.showMessageBox({
    type: "info",
    message: "Installed the crew command",
    detail: `${link} → ${source}\n\nOpen a new terminal and run: crew status${note}`,
  });
}
