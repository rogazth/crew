// T5: closing a claude terminal's tab. One nothing was said in, under the name
// Crew made up, goes with its tab; one the user named, or one that holds a
// conversation, stays in the sidebar. A conversation left by /clear is a
// session of its own (terminal-clear.test.ts), so a terminal whose turns all
// came before its /clear goes, and that session stays. crewd's rows are the
// witness, the transcripts the fake wrote the reason.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { Session } from "../src/lib/types.ts";
import {
  holdsFor,
  launchCrew,
  MOD,
  newTerminal,
  pressChord,
  sessionRow,
  sessions,
  sessionTab,
  storedStatus,
  typeInTerminal,
  waitFor,
  type Crew,
} from "./harness.ts";

const get = (crew: Crew, id: string) => crew.request<Session | null>("session_get", { id });

/** A turn typed into the terminal on screen, run to its end (the tab is watched, so it rests as idle). */
async function turn(crew: Crew, session: Session, line: string): Promise<void> {
  await typeInTerminal(crew, line);
  await waitFor(async () => (await storedStatus(crew, session.id)) === "working", { message: `${line}: the turn starts` });
  await waitFor(async () => (await storedStatus(crew, session.id)) === "idle", { message: `${line}: the turn ends` });
}

/** `/clear`, and crewd learns the id Claude moved to (the window asks every 3s). */
async function clear(crew: Crew, session: Session): Promise<string> {
  await typeInTerminal(crew, "/clear");
  const moved = await waitFor(
    async () => {
      const bound = (await get(crew, session.id))?.providerSessionId;
      return bound && bound !== session.id && bound;
    },
    { message: "crewd binds the session to Claude's new id" },
  );
  return moved;
}

type Close = "button" | "chord";

/** Closes the session's tab and waits for the tab to go. */
async function closeTab(crew: Crew, session: Session, how: Close): Promise<void> {
  const tab = sessionTab(crew, session);
  if (how === "button") await tab.getByRole("button", { name: "Close tab" }).click();
  else {
    await tab.click();
    await pressChord(crew, `${MOD}+w`);
  }
  await tab.waitFor({ state: "detached" });
}

/** The row outlives its closed tab. */
async function kept(crew: Crew, session: Session, why: string): Promise<void> {
  await holdsFor(2000, async () => (await get(crew, session.id)) !== null, `crewd deleted the session ${why}`);
}

test("T5: closing a tab deletes a terminal nothing was said in, and keeps one with a conversation", async (t) => {
  let crew = await launchCrew();
  t.after(() => crew.close());
  const [workspace] = crew.workspaces;
  assert.ok(workspace);

  // Nobody typed a thing: gone with its tab, by the tab's button.
  const blank = await newTerminal(crew, workspace.id);
  await closeTab(crew, blank, "button");
  await waitFor(async () => (await get(crew, blank.id)) === null, { timeout: 5000, message: "crewd deletes the blank session" });

  // Nothing said in it either, but the user named it: the name is worth keeping.
  const named = await newTerminal(crew, workspace.id);
  const label = `Scratch ${Date.now().toString(36)}`;
  // force: dnd-kit's sortable wrapper reads as a disabled button while dragging is off.
  await sessionRow(crew, named.name).click({ button: "right", force: true });
  await crew.window.getByRole("menu").getByRole("menuitem", { name: "Rename" }).click();
  // The field sits in the same aria-disabled wrapper, so it is typed into as
  // it opens: focused, its text selected.
  await waitFor(
    () => crew.window.evaluate(() => document.activeElement?.getAttribute("aria-label") === "Rename"),
    { message: "the row's name opens for editing" },
  );
  await crew.window.keyboard.type(label);
  await crew.window.keyboard.press("Enter");
  await waitFor(async () => (await get(crew, named.id))?.name === label, { message: "crewd takes the name" });
  await closeTab(crew, named, "button");
  await kept(crew, named, "that the user named");

  // A turn happened: kept, closed by ⌘W.
  const spoken = await newTerminal(crew, workspace.id);
  await turn(crew, spoken, "hello");
  await closeTab(crew, spoken, "chord");
  await kept(crew, spoken, "that held a turn");

  // The turn came before a /clear: that conversation is a session of its own
  // now, and the terminal, in Claude's new and empty one, goes with its tab.
  const before = await newTerminal(crew, workspace.id);
  await turn(crew, before, "hello");
  await clear(crew, before);
  const left = await waitFor(
    async () => (await sessions(crew, workspace.id)).find((row) => row.providerSessionId === before.id),
    { message: "the conversation before /clear becomes a session" },
  );
  await closeTab(crew, before, "chord");
  await waitFor(async () => (await get(crew, before.id)) === null, { timeout: 5000, message: "crewd deletes the emptied terminal" });
  await kept(crew, left, "that holds the conversation from before /clear");

  // The only turn came after a /clear: it lives in the transcript of Claude's new id.
  const after = await newTerminal(crew, workspace.id);
  await clear(crew, after);
  await turn(crew, after, "hello");
  await closeTab(crew, after, "button");
  await kept(crew, after, "whose only turn came after /clear");

  // crewd's startup sweep of tab-less disposable terminals agrees.
  crew = await crew.restart();
  for (const session of [named, spoken, left, after]) assert.ok(await get(crew, session.id), `${session.name} survives the restart`);
  for (const session of [blank, before]) assert.equal(await get(crew, session.id), null, `${session.name} came back`);
});

// A /clear moves Claude to a new id, which the window has crewd look for every
// 3s. A tab closed inside that window must be judged on the new id's
// transcript, so closing follows the hook's records first. Closing is
// attempted right after a post-clear turn until one close lands before crewd
// has learned the new id.
test("T5b: a tab closed right after a post-/clear turn keeps its session", async (t) => {
  const crew = await launchCrew();
  t.after(() => crew.close());
  const [workspace] = crew.workspaces;
  assert.ok(workspace);

  for (let attempt = 1; attempt <= 5; attempt++) {
    const session = await newTerminal(crew, workspace.id);
    await typeInTerminal(crew, "/clear");
    await turn(crew, session, "hello");
    const unbound = (await get(crew, session.id))?.providerSessionId === null;
    await closeTab(crew, session, "chord");
    if (!unbound) continue;
    t.diagnostic(`closed before crewd learned the new id on attempt ${attempt}`);
    await kept(crew, session, "closed before crewd learned Claude's post-/clear id, though that transcript holds a turn");
    return;
  }
  t.skip("every close came after crewd had learned the new id");
});
