// ⌘C in a terminal copies, as in any Mac app, and never interrupts what runs
// there: not over nothing, and not over a TUI that took the mouse (its drag
// selected nothing xterm knows of). What such a program copies itself, over
// OSC 52 (tmux, full-screen TUIs), lands on the Mac's clipboard.
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { launchCrew, MOD, pressChord, typeInTerminal, waitFor, type Crew } from "./harness.ts";

async function openShell(crew: Crew): Promise<void> {
  await pressChord(crew, `${MOD}+t`);
  await crew.window.getByLabel("Open a tab").waitFor();
  await crew.window.keyboard.press("Enter");
}

const clipboard = (crew: Crew) => crew.app.evaluate(({ clipboard }) => clipboard.readText());

test("⌘C copies and never interrupts; OSC 52 reaches the clipboard", async () => {
  const crew = await launchCrew();
  try {
    const dir = crew.workspaces[0]!.path;
    await openShell(crew);
    await crew.app.evaluate(({ clipboard }) => clipboard.writeText("before"));

    // A program that took the mouse, still running when ⌘C comes.
    await typeInTerminal(crew, "printf '\\033[?1002h\\033[?1006h'; sleep 2; touch survived");
    await crew.window.keyboard.press("Meta+c");
    await waitFor(() => existsSync(path.join(dir, "survived")), { message: "⌘C did not interrupt the command", timeout: 10_000 });
    assert.equal(await clipboard(crew), "before");

    await typeInTerminal(crew, "printf '\\033[?1002l\\033[?1006l\\033]52;c;%s\\a' \"$(printf 'from tmux' | base64)\"");
    await waitFor(async () => (await clipboard(crew)) === "from tmux", { message: "OSC 52 writes the clipboard" });
  } finally {
    await crew.close();
  }
});
