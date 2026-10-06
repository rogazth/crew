// S1: a new session keeps out of the sidebar until something is said in it.
// Its tab shows it from the start; the row comes with the first turn. Closed
// before that, it goes with its tab, so it never shows at all.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  holdsFor,
  launchCrew,
  newTerminal,
  sessionRow,
  sessionTab,
  storedStatus,
  typeInTerminal,
  waitFor,
} from "./harness.ts";

test("S1: a new session joins the sidebar with its first message", async (t) => {
  const crew = await launchCrew();
  t.after(() => crew.close());
  const [workspace] = crew.workspaces;
  assert.ok(workspace);

  // Every row the sidebar ever draws, however briefly.
  await crew.window.evaluate(() => {
    const drawn = new Set<string>();
    (window as unknown as { drawnRows: Set<string> }).drawnRows = drawn;
    const note = () => {
      for (const row of document.querySelectorAll("[data-sidebar-panel] button[data-session]")) drawn.add(row.textContent ?? "");
    };
    new MutationObserver(note).observe(document.body, { childList: true, subtree: true, characterData: true });
  });
  const session = await newTerminal(crew, workspace.id);
  await sessionTab(crew, session).waitFor();
  await holdsFor(1500, async () => (await sessionRow(crew, session.name).count()) === 0, "the blank session shows in the sidebar");
  const drawn = () => crew.window.evaluate(() => [...(window as unknown as { drawnRows: Set<string> }).drawnRows]);
  assert.ok(!(await drawn()).some((text) => text.includes(session.name)), "the blank session flashed in the sidebar");

  await typeInTerminal(crew, "hello");
  await waitFor(async () => (await storedStatus(crew, session.id)) === "working", { message: "the turn starts" });
  await sessionRow(crew, session.name).waitFor({ timeout: 5000 });
  assert.ok((await drawn()).some((text) => text.includes(session.name)), "the watch on the sidebar sees its rows");
  await waitFor(async () => (await storedStatus(crew, session.id)) === "idle", { message: "the turn ends" });
  await holdsFor(1000, async () => (await sessionRow(crew, session.name).count()) === 1, "the row leaves once the turn ends");
});
