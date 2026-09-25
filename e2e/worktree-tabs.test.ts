// W4 and W5: the tab strips that go with worktrees, per worktree and all
// together, across a restart. What crewd saved before quitting is the yardstick
// for what comes back.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { Locator } from "playwright-core";
import type { Session, Workspace } from "../src/lib/types.ts";
import {
  currentWorktree,
  gitWorktrees,
  launchCrew,
  MOD,
  newTerminal,
  newWorktree,
  pressChord,
  savedStrip,
  storedStatus,
  stripTabIds,
  typeInTerminal,
  waitFor,
  worktreeHeader,
  type Crew,
} from "./harness.ts";

/** Whether a list of tab ids has the tab of `session`. */
const holds = (ids: string[], session: Session) => ids.some((id) => id.includes(session.id));

/** The strip on screen comes to read exactly `expected`. */
async function stripIs(crew: Crew, expected: string[], message: string): Promise<void> {
  let last: string[] = [];
  const same = await waitFor(
    async () => {
      last = await stripTabIds(crew);
      return JSON.stringify(last) === JSON.stringify(expected);
    },
    { timeout: 5000 },
  ).catch(() => false);
  if (!same) assert.deepEqual(last, expected, message);
}

function tabOf(crew: Crew, session: Session): Locator {
  return crew.window.locator(`[data-tab-strip] [role="tab"][data-tab-id*="${session.id}"]`);
}

/** Settings › General › Worktrees › Tabs, through the page and its select; crewd has it once it lands. */
async function setTabScope(crew: Crew, label: string, value: string): Promise<void> {
  const page = crew.window;
  await pressChord(crew, `${MOD}+,`);
  await page.getByRole("combobox", { name: "Tabs" }).click();
  await page.getByRole("option", { name: label }).click();
  await waitFor(async () => (await crew.request("state_get", { key: "tabs:scope" })) === value, {
    message: `crewd stores the tab scope as ${value}`,
  });
  await pressChord(crew, `${MOD}+,`);
  await page.locator("[data-tab-strip]").waitFor({ state: "visible" });
}

/** A session tab's branch chip reads the branch git has checked out where the session runs. */
async function assertChip(crew: Crew, workspace: Workspace, session: Session): Promise<void> {
  const branch = await crew.git(session.worktree ?? workspace.path, "rev-parse", "--abbrev-ref", "HEAD");
  // The pill's title, then the chip; the chip is short, so it carries the last segment.
  const texts = (await tabOf(crew, session).locator(".truncate").allInnerTexts()).map((text) => text.trim());
  assert.equal(texts.length, 2, `${session.name}'s tab has a chip: ${JSON.stringify(texts)}`);
  assert.equal(texts[1], branch.split("/").pop(), `${session.name} runs on ${branch}`);
}

test("W4: per worktree, each strip and the worktree on screen come back after a restart", async (t) => {
  let crew = await launchCrew();
  t.after(() => crew.close());
  const [workspace] = crew.workspaces;
  assert.ok(workspace);
  // Per worktree is what a fresh install runs: nothing stored says otherwise.
  assert.notEqual(await crew.request("state_get", { key: "tabs:scope" }), "all");

  const m1 = await newTerminal(crew, workspace.id);
  const m2 = await newTerminal(crew, workspace.id);
  await newWorktree(crew, "feat/a");
  await worktreeHeader(crew, "feat/a").and(currentWorktree(crew)).waitFor();
  const a1 = await newTerminal(crew, workspace.id);
  const tree = a1.worktree;
  assert.ok(tree, "the session runs in the new worktree");
  assert.ok((await gitWorktrees(crew, workspace.path)).some((e) => e.path === tree && e.branch === "refs/heads/feat/a"));
  // A conversation in the worktree, which its relaunch has to pick up again.
  await typeInTerminal(crew, "hello");
  await waitFor(async () => (await storedStatus(crew, a1.id)) === "working", { message: "a1's turn starts" });
  await waitFor(async () => (await storedStatus(crew, a1.id)) === "idle", { message: "a1's turn ends" });

  // What crewd holds when the user quits: each strip its own sessions, feat/a on screen.
  const mainStrip = await waitFor(
    async () => {
      const strip = await savedStrip(crew, workspace.id);
      return strip && holds(strip.ids, m1) && holds(strip.ids, m2) && strip;
    },
    { message: "crewd saves main's strip" },
  );
  assert.ok(!holds(mainStrip.ids, a1), "feat/a's session stays out of main's strip");
  const featStrip = await waitFor(
    async () => {
      const strip = await savedStrip(crew, `${workspace.id}@${tree}`);
      return strip && holds(strip.ids, a1) && strip;
    },
    { message: "crewd saves feat/a's strip" },
  );
  assert.ok(!holds(featStrip.ids, m1) && !holds(featStrip.ids, m2), "main's sessions stay out of feat/a's strip");
  assert.equal(await crew.request("state_get", { key: `worktree:${workspace.id}` }), tree);
  await stripIs(crew, featStrip.ids, "the strip on screen is feat/a's");

  // Counted before quitting: the relaunched window may start the terminal before restart() returns.
  const launchesBefore = (await crew.claudeLaunches()).length;
  crew = await crew.restart();
  await worktreeHeader(crew, "feat/a").and(currentWorktree(crew)).waitFor();
  await stripIs(crew, featStrip.ids, "feat/a comes back with its own strip");
  // Its terminal is back at work where it was.
  const resumed = await waitFor(
    async () => (await crew.claudeLaunches()).slice(launchesBefore).find((run) => run.argv.includes(a1.id)),
    { message: "feat/a's session starts again" },
  );
  assert.equal(resumed.cwd, tree);
  // On its own conversation: Claude keeps it under the worktree's path, and a
  // fresh --session-id on an id that has a transcript is refused.
  assert.equal(resumed.argv[resumed.argv.indexOf("--resume") + 1], a1.id, `a1 resumes: ${JSON.stringify(resumed.argv)}`);

  await worktreeHeader(crew, "main").click();
  await worktreeHeader(crew, "main").and(currentWorktree(crew)).waitFor();
  await stripIs(crew, mainStrip.ids, "main keeps its strip");
});

test("W5: switching to All together joins the strips the worktrees had", async (t) => {
  const crew = await launchCrew();
  t.after(() => crew.close());
  const [workspace] = crew.workspaces;
  assert.ok(workspace);

  const m1 = await newTerminal(crew, workspace.id);
  await newWorktree(crew, "feat/b");
  await worktreeHeader(crew, "feat/b").and(currentWorktree(crew)).waitFor();
  const b1 = await newTerminal(crew, workspace.id);
  assert.ok(b1.worktree);

  await setTabScope(crew, "All together", "all");
  // One strip holds every worktree's tabs: the setting's promise, for tabs opened before it too.
  const joined = await waitFor(
    async () => {
      const ids = await stripTabIds(crew);
      return holds(ids, m1) && holds(ids, b1);
    },
    { timeout: 5000 },
  ).catch(() => false);
  assert.ok(joined, `the strip holds ${JSON.stringify(await stripTabIds(crew))}: not both worktrees' tabs`);
  await assertChip(crew, workspace, m1);
  await assertChip(crew, workspace, b1);
});

test("W5b: all together, tabs carry their branch, survive a restart, and a worktree brings back one of its tabs", async (t) => {
  let crew = await launchCrew();
  t.after(() => crew.close());
  const [workspace] = crew.workspaces;
  assert.ok(workspace);

  await setTabScope(crew, "All together", "all");
  await newWorktree(crew, "feat/alpha");
  await worktreeHeader(crew, "feat/alpha").and(currentWorktree(crew)).waitFor();
  const a1 = await newTerminal(crew, workspace.id);
  const a2 = await newTerminal(crew, workspace.id);
  await worktreeHeader(crew, "main").click();
  await worktreeHeader(crew, "main").and(currentWorktree(crew)).waitFor();
  const m1 = await newTerminal(crew, workspace.id);
  assert.ok(a1.worktree && a1.worktree === a2.worktree, "a1 and a2 run in feat/alpha");
  assert.equal(m1.worktree, null, "m1 runs in the main checkout");
  const everyone = [a1, a2, m1];

  // One strip, in crewd too, with every session's tab; each chip names its branch.
  const saved = await waitFor(
    async () => {
      const strip = await savedStrip(crew, workspace.id);
      return strip && everyone.every((session) => holds(strip.ids, session)) && strip;
    },
    { message: "crewd saves one strip with every tab" },
  );
  await stripIs(crew, saved.ids, "the strip on screen is the one crewd saved");
  for (const session of everyone) await assertChip(crew, workspace, session);

  crew = await crew.restart();
  assert.equal(await crew.request("state_get", { key: "tabs:scope" }), "all");
  await stripIs(crew, saved.ids, "the joined strip comes back");
  for (const session of everyone) await assertChip(crew, workspace, session);

  // The tab on screen says which worktree you are in.
  await tabOf(crew, a1).click();
  await worktreeHeader(crew, "feat/alpha").and(currentWorktree(crew)).waitFor();
  // Going to main brings up main's tab. Coming back to feat/alpha, which of its
  // tabs? The code takes the rightmost; this asks for the one last used (B5).
  // Pending Gabriel's call, so it runs as a todo and does not fail the suite.
  await t.test("coming back to a worktree brings up the tab last used there", { todo: "B5: rightmost vs last used" }, async () => {
    await worktreeHeader(crew, "main").click();
    await tabOf(crew, m1).and(crew.window.locator('[aria-selected="true"]')).waitFor();
    await worktreeHeader(crew, "feat/alpha").click();
    const selected = await waitFor(
      async () => (await tabOf(crew, a1).getAttribute("aria-selected")) === "true",
      { timeout: 5000 },
    ).catch(() => false);
    const onScreen = await crew.window.locator('[data-tab-strip] [role="tab"][aria-selected="true"]').getAttribute("data-tab-id");
    assert.ok(selected, `back in feat/alpha, ${onScreen} is on screen, not a1 (${a1.id}), the tab last used there`);
  });
});
