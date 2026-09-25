// T2: the provider names its session and Crew takes the name: the row, the
// tab and crewd's row, within seconds, on screen or in a workspace out of
// sight, and still after a restart. The names are the test's own words, fed to
// the fake claude, which writes them as Claude does (an ai-title record and a
// retitled terminal).
import assert from "node:assert/strict";
import { test } from "node:test";
import type { Session } from "../src/lib/types.ts";
import {
  launchCrew,
  MOD,
  newTerminal,
  pressChord,
  sessionRow,
  sessionTab,
  typeInTerminal,
  waitFor,
  type Crew,
} from "./harness.ts";

/** Crewd's name for a session. */
async function storedName(crew: Crew, id: string): Promise<string | null> {
  return (await crew.request<Session | null>("session_get", { id }))?.name ?? null;
}

/** Waits for crewd to store `name`, and says how long that took. */
async function named(crew: Crew, session: Session, name: string, timeout: number): Promise<number> {
  const start = Date.now();
  let last: string | null = null;
  const ok = await waitFor(
    async () => {
      last = await storedName(crew, session.id);
      return last === name;
    },
    { timeout },
  ).catch(() => false);
  assert.ok(ok, `crewd names the session "${name}" within ${timeout}ms; it holds "${last}"`);
  return Date.now() - start;
}

test("T2: the CLI's title names the row, the tab and crewd's session, on screen and off, across a restart", async (t) => {
  let crew = await launchCrew({ repos: ["app", "side"] });
  t.after(() => crew.close());
  const [main, side] = crew.workspaces;
  assert.ok(main && side);
  const stamp = Date.now().toString(36);
  const title = `Sort the invoices ${stamp}`;
  const aside = `Audit the ledger ${stamp}`;

  const s1 = await newTerminal(crew, main.id);
  await typeInTerminal(crew, `title ${title}`);
  await named(crew, s1, title, 5000);
  await sessionRow(crew, title).waitFor({ timeout: 5000 });
  await sessionTab(crew, s1).filter({ hasText: title }).waitFor({ timeout: 5000 });

  // A terminal in `side` renames after the window has moved to `app` (5e28247).
  await pressChord(crew, `${MOD}+2`);
  await waitFor(async () => (await crew.request("active_workspace_get")) === side.id, { message: "side is on screen" });
  const s2 = await newTerminal(crew, side.id);
  await typeInTerminal(crew, `after 3 title ${aside}`);
  await pressChord(crew, `${MOD}+1`);
  await waitFor(async () => (await crew.request("active_workspace_get")) === main.id, { message: "app is on screen" });
  await sessionRow(crew, title).waitFor();
  const took = await named(crew, s2, aside, 3000 + 5000);
  t.diagnostic(`the session out of sight took its name ${took}ms after the switch (3s of that is the CLI waiting)`);
  assert.equal(await crew.request("active_workspace_get"), main.id, "side stayed out of sight while it renamed");

  // A name revised in the transcript with no new terminal title: only the
  // window's sweep of every workspace's sessions (every 15s) can learn it.
  const revised = `Audit the ledger, revised ${stamp}`;
  await pressChord(crew, `${MOD}+2`);
  await waitFor(async () => (await crew.request("active_workspace_get")) === side.id, { message: "side is on screen" });
  await sessionTab(crew, s2).click();
  await typeInTerminal(crew, `after 2 rename ${revised}`);
  await pressChord(crew, `${MOD}+1`);
  await waitFor(async () => (await crew.request("active_workspace_get")) === main.id, { message: "app is on screen" });
  await named(crew, s2, revised, 2000 + 15_000 + 5000);
  assert.equal(await crew.request("active_workspace_get"), main.id, "side stayed out of sight while it was renamed");

  crew = await crew.restart();
  assert.equal(await storedName(crew, s1.id), title);
  assert.equal(await storedName(crew, s2.id), revised);
  await sessionRow(crew, title).waitFor({ timeout: 5000 });
  await sessionTab(crew, s1).filter({ hasText: title }).waitFor({ timeout: 5000 });
  await pressChord(crew, `${MOD}+2`);
  await sessionRow(crew, revised).waitFor({ timeout: 5000 });
  await sessionTab(crew, s2).filter({ hasText: revised }).waitFor({ timeout: 5000 });
});
