// ⌘V with a screenshot on the clipboard pastes a path to it: the CLIs Crew
// hosts take images by path. On a machine that is not this Mac the image is
// written there first, so the path is one its CLI can open.
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { execFile } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { addRemote, launchCrew, MOD, pressChord, typeInTerminal, waitFor, type Crew, type RemoteDaemon } from "./harness.ts";

/** A 2×2 PNG, as a clipboard would hold a screenshot. */
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFklEQVR42mP8z8DwnwEJMDEgAUYGBgYAQiAEA6/2GkoAAAAASUVORK5CYII=",
  "base64",
);

/** Puts the image on the clipboard, then copies the file it pastes as into `out` from the shell on screen. */
async function pasteImageInto(crew: Crew, out: string): Promise<void> {
  // As a screenshot sits there: PNG data and nothing else.
  const png = path.join(crew.root, "clip.png");
  await writeFile(png, PNG);
  await promisify(execFile)("osascript", ["-e", `set the clipboard to (read (POSIX file "${png}") as «class PNGf»)`]);
  await typeInTerminal(crew, "clear");
  await crew.window.keyboard.type("cp ");
  // ⌘V is the Edit menu's paste, which a synthetic key press does not reach.
  await crew.app.evaluate(({ BrowserWindow }) => {
    for (const window of BrowserWindow.getAllWindows()) if (window.webContents.getURL().includes("index.html")) window.webContents.paste();
  });
  // The path arrives once the bytes are written, after the keys typed so far.
  await new Promise((resolve) => setTimeout(resolve, 1_000));
  await crew.window.keyboard.type(` ${out}`);
  await crew.window.keyboard.press("Enter");
  await waitFor(() => existsSync(out), { message: `the pasted image is copied to ${out}`, timeout: 10_000 });
  const copied = await readFile(out);
  assert.ok(copied.subarray(0, 8).equals(PNG.subarray(0, 8)), "the pasted file is a PNG");
}

async function openShell(crew: Crew): Promise<void> {
  await pressChord(crew, `${MOD}+t`);
  await crew.window.getByLabel("Open a tab").waitFor();
  await crew.window.keyboard.press("Enter");
  await typeInTerminal(crew, "echo ready");
}

test("⌘V pastes a screenshot as a path, here and on another machine", async () => {
  const crew = await launchCrew();
  let remote: RemoteDaemon | null = null;
  try {
    await openShell(crew);
    await pasteImageInto(crew, path.join(crew.root, "local.png"));

    remote = await addRemote(crew, "devbox");
    const api = await crew.makeRepo("api");
    const window = crew.window;
    await pressChord(crew, `${MOD}+o`);
    const machine = window.getByRole("option", { name: /devbox/ });
    await machine.waitFor();
    await waitFor(() => machine.evaluate((row) => /\d+ ms/.test(row.textContent ?? "")), { message: "the machine answers" });
    await window.keyboard.press(`${MOD}+2`);
    const field = window.getByLabel("Folder on devbox");
    await field.waitFor();
    await field.fill(`${api}/`);
    await window.keyboard.press(`${MOD}+Enter`);
    await window.locator(`nav[aria-label="Workspaces"][data-sidebar-rail] button[data-nav][aria-label="api"]`).waitFor();

    await openShell(crew);
    await pasteImageInto(crew, path.join(crew.root, "remote.png"));
  } finally {
    await remote?.stop();
    await crew.close();
  }
});
