// W4 and W5: the tab strips that go with worktrees, per worktree and all
// together, across a restart. What crewd saved before quitting is the yardstick
// for what comes back. Going to a worktree or a workspace brings back the tab
// last used there (B5), never simply its rightmost.
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

/** The tab on screen comes to be `session`'s. */
async function showing(crew: Crew, session: Session, message: string): Promise<void> {
  const selected = () =>
    crew.window
      .locator('[data-tab-strip] [role="tab"][aria-selected="true"]')
      .evaluateAll((tabs) => tabs.map((tab) => tab.getAttribute("data-tab-id") ?? ""));
  let last: string[] = [];
  const ok = await waitFor(async () => (last = await selected()).some((id) => id.includes(session.id)), {
    timeout: 5000,
  }).catch(() => false);
  assert.ok(ok, `${message}: ${JSON.stringify(last)} is on screen, not ${session.name} (${session.id})`);
}

/**
 * ⇧⌘O, and the row whose name reads exactly `label`: a workspace, or with
 * `repo` a worktree of it (another repo's worktrees list a line of the same name).
 */
async function switchTo(crew: Crew, label: string, repo?: string): Promise<void> {
  const page = crew.window;
  await pressChord(crew, `${MOD}+Shift+o`);
  const palette = page.getByRole("dialog", { name: "Command palette" });
  let row = palette.locator("button[data-index]").filter({ has: page.getByText(label, { exact: true }) });
  if (repo) row = row.filter({ has: page.getByText(`${repo} ›`, { exact: true }) });
  await row.click();
  await palette.waitFor({ state: "detached" });
}

function railMark(crew: Crew, name: string): Locator {
  return crew.window.locator(`nav[aria-label="Workspaces"][data-sidebar-rail] button[data-nav][aria-label="${name}"]`);
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

test("W5b: all together, tabs carry their branch, survive a restart, and a worktree brings back the tab last used there", async (t) => {
  let crew = await launchCrew({ repos: ["app", "lib"] });
  t.after(() => crew.close());
  const [workspace, lib] = crew.workspaces;
  assert.ok(workspace && lib);

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
  // a2 is feat/alpha's rightmost tab: a1, the one used below, is not.
  assert.ok(saved.ids.findIndex((id) => id.includes(a1.id)) < saved.ids.findIndex((id) => id.includes(a2.id)));
  for (const session of everyone) await assertChip(crew, workspace, session);

  crew = await crew.restart();
  assert.equal(await crew.request("state_get", { key: "tabs:scope" }), "all");
  await stripIs(crew, saved.ids, "the joined strip comes back");
  for (const session of everyone) await assertChip(crew, workspace, session);

  // The tab on screen says which worktree you are in.
  await tabOf(crew, a1).click();
  await worktreeHeader(crew, "feat/alpha").and(currentWorktree(crew)).waitFor();
  // Going to main brings up main's tab; coming back, feat/alpha's last used, by every door.
  await worktreeHeader(crew, "main").click();
  await showing(crew, m1, "main brings up m1");
  await worktreeHeader(crew, "feat/alpha").click();
  await showing(crew, a1, "clicked back to feat/alpha");
  await pressChord(crew, `${MOD}+Alt+1`);
  await showing(crew, m1, "⌘⌥1 goes to main");
  await pressChord(crew, `${MOD}+Alt+]`);
  await showing(crew, a1, "⌘⌥] steps back to feat/alpha");
  await pressChord(crew, `${MOD}+Alt+[`);
  await showing(crew, m1, "⌘⌥[ steps to main");
  await switchTo(crew, "feat/alpha", "app");
  await showing(crew, a1, "⇧⌘O picks feat/alpha");
  await worktreeHeader(crew, "feat/alpha").and(currentWorktree(crew)).waitFor();

  // Another workspace and back: the tab last used here, not the strip's rightmost.
  // lib gets feat/beta's b1 used (b2 its rightmost), then main's l1 on screen.
  await pressChord(crew, `${MOD}+2`);
  await railMark(crew, "lib").and(crew.window.locator('[aria-current="true"]')).waitFor();
  await newWorktree(crew, "feat/beta");
  await worktreeHeader(crew, "feat/beta").and(currentWorktree(crew)).waitFor();
  const b1 = await newTerminal(crew, lib.id);
  const b2 = await newTerminal(crew, lib.id);
  await tabOf(crew, b1).click();
  await worktreeHeader(crew, "main").click();
  await worktreeHeader(crew, "main").and(currentWorktree(crew)).waitFor();
  const l1 = await newTerminal(crew, lib.id);
  await showing(crew, l1, "lib's main shows l1");
  const libStrip = await stripTabIds(crew);
  assert.ok(libStrip.indexOf(`session:${b2.id}`) > libStrip.indexOf(`session:${b1.id}`), "b2 is feat/beta's rightmost");
  await pressChord(crew, `${MOD}+1`);
  await showing(crew, a1, "back in app by ⌘1");
  await worktreeHeader(crew, "feat/alpha").and(currentWorktree(crew)).waitFor();

  // ⇧⌘O to a worktree of lib: its tab last used there, not lib's active l1 nor b2.
  await switchTo(crew, "feat/beta", "lib");
  await railMark(crew, "lib").and(crew.window.locator('[aria-current="true"]')).waitFor();
  await showing(crew, b1, "⇧⌘O to lib's feat/beta brings back b1");
  await worktreeHeader(crew, "feat/beta").and(currentWorktree(crew)).waitFor();
  await worktreeHeader(crew, "main").click();
  await showing(crew, l1, "lib's main brings up l1");
  await waitFor(
    async () => {
      const recent = (await savedStrip(crew, lib.id))?.recent ?? [];
      return recent[0]?.includes(l1.id) && recent[1]?.includes(b1.id);
    },
    { message: "crewd saves l1, then b1, as lib's tabs last used" },
  );
  await pressChord(crew, `${MOD}+1`);
  await showing(crew, a1, "back in app again");

  // Quit from main: crewd keeps the order, and the relaunch goes by it.
  await worktreeHeader(crew, "main").click();
  await showing(crew, m1, "main brings up m1 again");
  await waitFor(
    async () => {
      const recent = (await savedStrip(crew, workspace.id))?.recent ?? [];
      return recent[0]?.includes(m1.id) && recent[1]?.includes(a1.id);
    },
    { message: "crewd saves m1, then a1, as the tabs last used" },
  );
  crew = await crew.restart();
  await showing(crew, m1, "the relaunch shows m1");
  await pressChord(crew, `${MOD}+Alt+2`);
  await showing(crew, a1, "after a restart, feat/alpha brings back a1");
  // lib's strip is not read yet in this run: the pick waits for it.
  await switchTo(crew, "feat/beta", "lib");
  await railMark(crew, "lib").and(crew.window.locator('[aria-current="true"]')).waitFor();
  await showing(crew, b1, "after a restart, ⇧⌘O to lib's feat/beta brings back b1");
  await worktreeHeader(crew, "feat/beta").and(currentWorktree(crew)).waitFor();
});

test("W5c: per worktree and from workspace to workspace, the tab last used there comes back", async (t) => {
  const crew = await launchCrew({ repos: ["app", "lib"] });
  t.after(() => crew.close());
  const [app] = crew.workspaces;
  assert.ok(app);
  assert.notEqual(await crew.request("state_get", { key: "tabs:scope" }), "all");

  // Two tabs in each strip; the one used is the left one.
  const m1 = await newTerminal(crew, app.id);
  const m2 = await newTerminal(crew, app.id);
  await newWorktree(crew, "feat/alpha");
  await worktreeHeader(crew, "feat/alpha").and(currentWorktree(crew)).waitFor();
  const a1 = await newTerminal(crew, app.id);
  const a2 = await newTerminal(crew, app.id);
  await tabOf(crew, a1).click();
  await worktreeHeader(crew, "main").click();
  await showing(crew, m2, "main shows the tab it had");
  await tabOf(crew, m1).click();
  await showing(crew, m1, "m1 is used in main");
  assert.ok((await stripTabIds(crew)).at(-1)?.includes(m2.id), "m2 is main's rightmost");

  await pressChord(crew, `${MOD}+Alt+2`);
  await showing(crew, a1, "⌘⌥2 brings back a1, not feat/alpha's rightmost a2");
  assert.ok((await stripTabIds(crew)).at(-1)?.includes(a2.id), "a2 is feat/alpha's rightmost");
  await pressChord(crew, `${MOD}+Alt+[`);
  await showing(crew, m1, "⌘⌥[ brings back m1, not main's rightmost m2");
  await worktreeHeader(crew, "feat/alpha").click();
  await showing(crew, a1, "clicking feat/alpha brings back a1");
  await switchTo(crew, "main", "app");
  await showing(crew, m1, "⇧⌘O to main brings back m1");

  // app → lib → app, by the rail, the digits and the palette: m1 each time.
  await railMark(crew, "lib").click();
  await railMark(crew, "lib").and(crew.window.locator('[aria-current="true"]')).waitFor();
  await pressChord(crew, `${MOD}+1`);
  await showing(crew, m1, "⌘1 back to app");
  await pressChord(crew, `${MOD}+2`);
  await railMark(crew, "lib").and(crew.window.locator('[aria-current="true"]')).waitFor();
  await railMark(crew, "app").click();
  await showing(crew, m1, "the rail back to app");
  await pressChord(crew, `${MOD}+2`);
  await railMark(crew, "lib").and(crew.window.locator('[aria-current="true"]')).waitFor();
  await switchTo(crew, "app");
  await showing(crew, m1, "⇧⌘O back to app");
  await worktreeHeader(crew, "main").and(currentWorktree(crew)).waitFor();
});
