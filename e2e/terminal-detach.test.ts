// Closing a terminal session's tab lets go of its CLI instead of ending it:
// the fake claude keeps its pid, a turn left running ends unseen and its row
// says so, and opening the session again attaches the new tab to the same
// process, its screen repainted from crewd's ring, with no second launch.
// Stop, from the row or the tab, is what ends it, and asks first while the
// CLI is at work. The fake's own launch log is the witness.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { Session } from "../src/lib/types.ts";
import {
  holdsFor,
  launchCrew,
  lightIn,
  MOD,
  newTerminal,
  pressChord,
  sessionRow,
  sessionTab,
  storedStatus,
  typeInTerminal,
  waitFor,
  type ClaudeLaunch,
  type Crew,
} from "./harness.ts";

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/** The one launch of `session`'s CLI so far. */
async function launchOf(crew: Crew, session: Session): Promise<ClaudeLaunch> {
  const runs = (await crew.claudeLaunches()).filter((run) => run.argv.includes(session.id));
  assert.equal(runs.length, 1, `${session.name} was launched ${runs.length} times`);
  return runs[0]!;
}

/** The row in the sidebar, under whatever name the session has now. */
async function rowOf(crew: Crew, session: Session) {
  const row = await crew.request<Session | null>("session_get", { id: session.id });
  return sessionRow(crew, row?.name ?? session.name);
}

/** Right-clicks the row and picks `item` from its menu. */
async function fromRow(crew: Crew, session: Session, item: string): Promise<void> {
  // force: dnd-kit's sortable wrapper reads as a disabled button while dragging is off.
  await (await rowOf(crew, session)).click({ button: "right", force: true });
  await crew.window.getByRole("menu").getByRole("menuitem", { name: item }).click();
}

/**
 * How many times ⌘F finds `text` in the terminal on screen, scrollback
 * included. Not the clipboard: other specs run beside this one and use it.
 */
async function found(crew: Crew, text: string): Promise<number> {
  const field = crew.window.getByLabel("Find in terminal");
  // ⌘F finds in the terminal that has the keys, not in the sidebar row just clicked.
  await crew.window.evaluate(() =>
    [...document.querySelectorAll<HTMLTextAreaElement>(".xterm-helper-textarea")]
      .find((area) => area.closest("[hidden]") === null && area.getClientRects().length > 0)
      ?.focus(),
  );
  if (!(await field.isVisible())) await pressChord(crew, `${MOD}+f`);
  await field.fill("", { timeout: 2000 });
  await field.fill(text);
  await new Promise((resolve) => setTimeout(resolve, 150));
  const count = (await field.locator("xpath=following-sibling::span[1]").textContent()) ?? "";
  await crew.window.keyboard.press("Escape");
  return Number(/of (\d+)/.exec(count)?.[1] ?? 0);
}

async function closeTab(crew: Crew, session: Session): Promise<void> {
  const tab = sessionTab(crew, session);
  await tab.getByRole("button", { name: "Close tab" }).click();
  await tab.waitFor({ state: "detached" });
}

test("a closed terminal session's CLI runs on, and reopening attaches to it", async (t) => {
  const crew = await launchCrew();
  t.after(() => crew.close());
  const [workspace] = crew.workspaces;
  assert.ok(workspace);

  const session = await newTerminal(crew, workspace.id);
  const marker = `kept-${Date.now().toString(36)}`;
  await typeInTerminal(crew, `!echo ${marker}`);
  await waitFor(async () => (await found(crew, marker)) > 0, { message: "the marker reaches the screen" });
  const { pid } = await launchOf(crew, session);

  // Closed mid-turn: no question asked, and the turn goes on out of sight.
  await typeInTerminal(crew, "work 3");
  await waitFor(async () => (await storedStatus(crew, session.id)) === "working", { message: "the turn starts" });
  await closeTab(crew, session);
  assert.equal(await crew.window.getByRole("alertdialog").count(), 0, "closing the tab asked first");
  await holdsFor(1000, () => alive(pid), "closing the tab ended the CLI");

  // Its row follows the turn to its end, unseen, from the CLI's hooks.
  await waitFor(async () => (await lightIn(await rowOf(crew, session))) === "Unread", {
    timeout: 10_000,
    message: "the turn that ended with the tab closed reads as unread",
  });
  assert.ok(alive(pid), "the CLI exited once its turn ended");

  // Opened again: the same process, the screen it drew, and keys reach it.
  await (await rowOf(crew, session)).click({ force: true });
  await sessionTab(crew, session).waitFor();
  await waitFor(async () => (await found(crew, marker)) > 0, {
    message: "the reopened tab repaints what the CLI drew before it closed",
  });
  assert.equal((await launchOf(crew, session)).pid, pid, "reopening launched the CLI again");
  await typeInTerminal(crew, "hello");
  await waitFor(async () => (await storedStatus(crew, session.id)) === "working", { message: "a turn starts in the reattached CLI" });
  await waitFor(async () => (await storedStatus(crew, session.id)) === "idle", { message: "the turn ends" });
  assert.equal((await crew.claudeLaunches()).filter((run) => run.argv.includes(session.id)).length, 1);

  // A reload of the window finds it running too: closed again, then reopened.
  await closeTab(crew, session);
  await crew.reload();
  await (await rowOf(crew, session)).click({ force: true });
  await sessionTab(crew, session).waitFor();
  await waitFor(async () => (await found(crew, marker)) > 0, { message: "the tab reopened after a reload repaints" });
  assert.equal((await launchOf(crew, session)).pid, pid, "the reload launched the CLI again");
  assert.ok(alive(pid));
});

test("Stop ends a terminal session's CLI, tab open or closed, and asks first while it works", async (t) => {
  const crew = await launchCrew();
  t.after(() => crew.close());
  const [workspace] = crew.workspaces;
  assert.ok(workspace);

  // At rest with its tab closed: Stop from the row ends it at once, and the session stays.
  const resting = await newTerminal(crew, workspace.id);
  await typeInTerminal(crew, "hello");
  await waitFor(async () => (await storedStatus(crew, resting.id)) === "working", { message: "the turn starts" });
  await waitFor(async () => (await storedStatus(crew, resting.id)) === "idle", { message: "the turn ends" });
  const first = await launchOf(crew, resting);
  await closeTab(crew, resting);
  await holdsFor(500, () => alive(first.pid), "closing the tab ended the CLI");
  await fromRow(crew, resting, "Stop");
  assert.equal(await crew.window.getByRole("alertdialog").count(), 0, "a resting CLI asked before it stopped");
  await waitFor(() => !alive(first.pid), { message: "Stop ends the CLI" });
  assert.ok(await crew.request("session_get", { id: resting.id }), "Stop deleted the session");
  // Nothing left to stop: the row no longer offers it.
  await (await rowOf(crew, resting)).click({ button: "right", force: true });
  const menu = crew.window.getByRole("menu");
  await menu.waitFor();
  assert.equal(await menu.getByRole("menuitem", { name: "Stop" }).count(), 0, "Stop is offered for a CLI that is gone");
  await crew.window.keyboard.press("Escape");

  // Mid-turn with its tab open: Stop from the tab asks, then ends the CLI and closes its tab.
  const working = await newTerminal(crew, workspace.id);
  const second = await launchOf(crew, working);
  await typeInTerminal(crew, "work 30");
  await waitFor(async () => (await storedStatus(crew, working.id)) === "working", { message: "the turn starts" });
  await sessionTab(crew, working).click({ button: "right" });
  await crew.window.getByRole("menu").getByRole("menuitem", { name: "Stop" }).click();
  const confirm = crew.window.getByRole("alertdialog");
  await confirm.waitFor();
  assert.match((await confirm.textContent()) ?? "", /Stop ".*"\?/);
  assert.ok(alive(second.pid), "the CLI ended before Stop was confirmed");
  await confirm.getByRole("button", { name: "Stop" }).click();
  await waitFor(() => !alive(second.pid), { message: "Stop ends the working CLI" });
  await sessionTab(crew, working).waitFor({ state: "detached" });

  // Opened again, the session starts a new CLI on the same conversation.
  await (await rowOf(crew, working)).click({ force: true });
  await waitFor(
    async () => (await crew.claudeLaunches()).filter((run) => run.argv.includes(working.id)).length === 2,
    { message: "opening a stopped session launches its CLI again" },
  );
});
