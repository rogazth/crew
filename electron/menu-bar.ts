// macOS only: the menu bar extra, a Swift helper (macos/menubar) that reads
// crewd itself. It lives as long as the app: it exits when its stdin closes,
// and asks main on stdout to bring the window up on a session.

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";
import { app } from "electron";
import type { NotificationTarget } from "../src/lib/notify";

type Ask = { open?: NotificationTarget };

function helperPath(): string {
  if (app.isPackaged) return path.join(process.resourcesPath, "crew-menubar");
  return path.join(app.getAppPath(), "macos/menubar/.build/debug/CrewMenuBar");
}

export function startMenuBar(open: (target: NotificationTarget) => void): void {
  if (process.platform !== "darwin") return;
  const bin = helperPath();
  if (!existsSync(bin)) {
    console.warn(`crew: no menu bar helper at ${bin}`);
    return;
  }
  const child: ChildProcess = spawn(bin, ["--data-dir", app.getPath("userData")], {
    stdio: ["pipe", "pipe", "inherit"],
  });
  child.once("error", (error) => console.warn(`crew: menu bar helper: ${error.message}`));
  createInterface({ input: child.stdout! }).on("line", (line) => {
    let ask: Ask;
    try {
      ask = JSON.parse(line) as Ask;
    } catch {
      return;
    }
    if (ask.open && typeof ask.open.sessionId === "string") open(ask.open);
  });
  app.once("will-quit", () => child.kill());
}
