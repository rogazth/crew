// A TUI that draws by difference, as Claude Code does: one full frame, then
// only the cells that change. Once its output passes the daemon's ring, a
// window opening onto it again cannot rebuild the frame from the tail alone;
// the program has to draw it again. Here on a machine that is not this Mac,
// where the report came from.
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import type { Workspace } from "../src/lib/types.ts";
import { addRemote, launchCrew, MOD, pressChord, remoteRequest, typeInTerminal, waitFor, type Crew, type RemoteDaemon } from "./harness.ts";

// Draws a frame, then rewrites one line in place, padded so the ring wraps
// within a second. On SIGWINCH it clears and draws the whole frame, as Ink does.
const DRAW = String.raw`
let n = 0;
const frame = () => {
  const cols = process.stdout.columns;
  process.stdout.write("\x1b[2J\x1b[H" + "TOP-MARKER\r\n" + "─".repeat(cols - 2) + "\r\n" + "❯ PROMPT-MARKER\r\n" + "─".repeat(cols - 2) + "\r\n" + "STATUS-MARKER\r\n" + "COUNT " + n + "\r\n");
};
process.stdout.on("resize", frame);
frame();
setInterval(() => {
  n += 1;
  process.stdout.write("\x1b[1A\r\x1b[2KCOUNT " + n + "\r\n" + "\x1b[0m".repeat(500));
}, 5);
`;

/** How many times ⌘F finds `text` in the terminal on screen, scrollback included. */
async function found(crew: Crew, text: string): Promise<number> {
  const field = crew.window.getByLabel("Find in terminal");
  if (!(await field.isVisible())) await pressChord(crew, `${MOD}+f`);
  await field.fill("");
  await field.fill(text);
  await new Promise((resolve) => setTimeout(resolve, 150));
  const count = (await field.locator("xpath=following-sibling::span[1]").textContent()) ?? "";
  return Number(/of (\d+)/.exec(count)?.[1] ?? 0);
}

test("a TUI that draws by difference shows its whole frame after the window reloads onto it", async () => {
  const crew = await launchCrew();
  let remote: RemoteDaemon | null = null;
  try {
    remote = await addRemote(crew, "devbox");
    const api = await crew.makeRepo("api");
    await writeFile(path.join(api, "draw.cjs"), DRAW);
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
    const workspaces = await remoteRequest<Workspace[]>(remote, "workspace_list");
    assert.equal(workspaces.length, 1);

    await pressChord(crew, `${MOD}+t`);
    await window.getByLabel("Open a tab").waitFor();
    await window.keyboard.press("Enter");
    await typeInTerminal(crew, "node draw.cjs");
    await waitFor(async () => (await found(crew, "PROMPT-MARKER")) > 0, { message: "the frame is drawn" });
    // 2.5 KB a tick: well past the 256 KB ring.
    await new Promise((resolve) => setTimeout(resolve, 4_000));

    await crew.reload();
    await waitFor(async () => (await found(crew, "COUNT")) > 0, { message: "the terminal is back", timeout: 20_000 });
    await waitFor(
      async () => (await found(crew, "TOP-MARKER")) > 0 && (await found(crew, "PROMPT-MARKER")) > 0 && (await found(crew, "STATUS-MARKER")) > 0,
      { message: "the whole frame is back", timeout: 5_000 },
    );
  } finally {
    await remote?.stop();
    await crew.close();
  }
});
