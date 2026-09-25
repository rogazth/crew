// W2 and W3: a worktree that changes behind the window's back. Removing one
// that got dirty after the window last listed it, and one removed outside crew
// altogether, with git, the disk, crewd and the fake claude's log as witnesses.
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { test, type TestContext } from "node:test";
import type { Session } from "../src/lib/types.ts";
import {
  currentWorktree,
  gitWorktrees,
  launchCrew,
  newTerminal,
  newWorktree,
  returnToWindow,
  waitFor,
  worktreeHeader,
  type Crew,
} from "./harness.ts";

/** The id of the tab that shows `session`, read off the strip. */
async function tabOf(crew: Crew, session: Session): Promise<string> {
  const tab = crew.window.locator('[data-tab-strip] [role="tab"][data-tab-id]').filter({ hasText: session.name });
  const id = await tab.getAttribute("data-tab-id");
  assert.ok(id, `${session.name} has a tab`);
  return id;
}

test("W2: removing a worktree dirtied after the last listing loses nothing in silence", async (t) => {
  const crew = await launchCrew();
  t.after(() => crew.close());
  const page = crew.window;
  const [workspace] = crew.workspaces;
  assert.ok(workspace);
  const tree = path.join(crew.home, ".crew/worktrees/app/feat-late");

  await newWorktree(crew, "feat/late");
  await waitFor(async () => (await gitWorktrees(crew, workspace.path)).some((entry) => entry.path === tree), {
    message: "git lists the new worktree",
  });
  const header = worktreeHeader(crew, "feat/late");
  await header.and(page.locator('[aria-current="true"]')).waitFor();
  const session = await newTerminal(crew, workspace.id);
  assert.equal(session.worktree, tree);
  const tabId = await tabOf(crew, session);

  // Dirtied from outside, and the window is not told: no focus comes back.
  await writeFile(path.join(tree, "late.txt"), "written after the listing\n");
  assert.notEqual(await crew.git(tree, "status", "--porcelain"), "");

  await header.click({ button: "right" });
  await page.getByRole("menu").getByRole("menuitem", { name: "Remove Worktree…" }).click();
  const alert = page.getByRole("alertdialog");
  await alert.waitFor();
  // The prompt comes from the stale listing: it warns about no changes. That is
  // the premise, not the bug: git is the one who knows.
  assert.doesNotMatch(await alert.innerText(), /uncommitted/);
  await alert.getByRole("button", { name: "Remove" }).click();

  // crewd refuses the removal without force. The same prompt says so with git's
  // own count, and nothing was closed or dropped while it asks again.
  const dirty = (await crew.git(tree, "status", "--porcelain")).split("\n").filter(Boolean).length;
  await alert.getByText(new RegExp(`\\b${dirty} uncommitted changes? (is|are) lost`)).waitFor();
  const tab = page.locator(`[data-tab-strip] [data-tab-id="${tabId}"]`);
  assert.equal(await tab.count(), 1, "the session's tab stays open while the prompt asks again");
  assert.ok(await crew.request<Session | null>("session_get", { id: session.id }), "crewd keeps the session");
  assert.ok(existsSync(path.join(tree, "late.txt")), "the late change stays");
  assert.ok((await gitWorktrees(crew, workspace.path)).some((entry) => entry.path === tree));

  // Confirmed with the real count, it goes: folder, session and tab.
  await alert.getByRole("button", { name: "Remove" }).click();
  await alert.waitFor({ state: "detached" });
  await waitFor(() => !existsSync(tree), { message: "the worktree's folder is deleted once confirmed" });
  assert.equal((await gitWorktrees(crew, workspace.path)).some((entry) => entry.path === tree), false);
  await waitFor(async () => (await crew.request<Session | null>("session_get", { id: session.id })) === null, {
    message: "crewd deletes the worktree's session",
  });
});

/**
 * W3's story up to the restart: a worktree made in crew, a session working in
 * it, the worktree removed from the system's terminal, the window told by
 * focus. The app is then restarted, with tabs kept per worktree or all together.
 */
async function strand(t: TestContext, scope: "worktree" | "all") {
  let crew = await launchCrew();
  t.after(() => crew.close());
  const [workspace] = crew.workspaces;
  assert.ok(workspace);
  const tree = path.join(crew.home, ".crew/worktrees/app/feat-gone");

  await newWorktree(crew, "feat/gone");
  await worktreeHeader(crew, "feat/gone").and(currentWorktree(crew)).waitFor();
  const session = await newTerminal(crew, workspace.id);
  assert.equal(session.worktree, tree);
  const first = await waitFor(async () => (await crew.claudeLaunches()).find((run) => run.argv.includes(session.id)), {
    message: "the session's CLI is launched",
  });
  assert.equal(first.cwd, tree);
  const tabId = await tabOf(crew, session);

  // From the system's terminal, not from crew.
  await crew.git(workspace.path, "worktree", "remove", "--force", tree);
  assert.ok(!existsSync(tree));

  // Back to the window: the worktree's line goes and the main checkout takes over.
  await returnToWindow(crew);
  await worktreeHeader(crew, "feat/gone").waitFor({ state: "detached" });
  await worktreeHeader(crew, "main").and(currentWorktree(crew)).waitFor();

  // The setting's own path through Settings is W5's; here it only has to hold at launch.
  if (scope === "all") await crew.request("state_set", { key: "tabs:scope", value: "all" });
  // The session's process ended with the app; its next start is what matters.
  crew = await crew.restart();
  await worktreeHeader(crew, "main").and(currentWorktree(crew)).waitFor();
  return { crew, workspace, session, tabId };
}

/** Opening the stranded session from the sidebar shows it, and starts its CLI in a folder that exists. */
async function reopen({ crew, workspace, session, tabId }: Awaited<ReturnType<typeof strand>>) {
  const page = crew.window;
  const listed = page.locator("[data-sidebar-panel] button[data-session]").filter({ hasText: session.name });
  const row = await crew.request<Session | null>("session_get", { id: session.id });
  if (row === null) {
    // It went with its folder: nothing is left to start anywhere.
    await listed.waitFor({ state: "detached" });
    return;
  }

  // Still listed, under the main checkout, so it can be opened.
  const before = (await crew.claudeLaunches()).length;
  // Forced: the row sits in a sortable wrapper that dnd-kit marks aria-disabled
  // while sorting is off, which Playwright reads as a disabled button.
  await listed.click({ force: true });
  await page
    .locator(`[data-tab-strip] [data-tab-id="${tabId}"][aria-selected="true"]`)
    .waitFor({ timeout: 5000 })
    .catch(() => assert.fail("opening the session from the sidebar puts no tab of it on screen"));
  const launched = await waitFor(
    async () => (await crew.claudeLaunches()).slice(before).find((run) => run.argv.includes(session.id)),
    { message: "the tab on screen starts the session's CLI" },
  );
  assert.equal(
    launched.cwd,
    workspace.path,
    `the CLI started in ${launched.cwd}, not in the checkout the session shows under (crewd still says ${row.worktree})`,
  );
}

test("W3: a worktree removed outside crew leaves the window; its session opens in a folder that exists", async (t) => {
  await reopen(await strand(t, "worktree"));
});

test("W3b: the same, with tabs all together", async (t) => {
  await reopen(await strand(t, "all"));
});
