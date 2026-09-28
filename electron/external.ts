import { appendFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { shell } from "electron";

/**
 * The default browser. e2e records the URL instead: on Linux Electron would
 * run `xdg-open` from PATH, and on macOS it would open the user's browser.
 * The harness reads the same `$HOME/xdg-open.log` either way.
 */
export async function openExternal(url: string): Promise<void> {
  if (process.env.CREW_E2E === "1") {
    appendFileSync(path.join(homedir(), "xdg-open.log"), `${url}\n`);
    return;
  }
  await shell.openExternal(url);
}
