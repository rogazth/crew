// W7, repo › worktree: from one workspace, ⇧⌘O reaches a worktree of another
// and lands on both at once, and the window keeps that choice.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { Worktree } from "../src/lib/types.ts";
import { currentWorktree, launchCrew, MOD, pressChord, returnToWindow, waitFor, worktreeHeader } from "./harness.ts";

test("W7: ⇧⌘O lists another repo's worktrees; picking one switches workspace and worktree together", async (t) => {
  let crew = await launchCrew({ repos: ["app", "lib"] });
  t.after(() => crew.close());
  const [app, lib] = crew.workspaces;
  assert.ok(app && lib);
  const page = crew.window;
  const rail = () => crew.window.locator('nav[aria-label="Workspaces"][data-sidebar-rail]');

  // Each repo gets a worktree behind the window's back (W1 covers making one in it).
  await crew.request<Worktree>("worktree_add", { path: app.path, branch: "feat/app-side" });
  const theirs = await crew.request<Worktree>("worktree_add", { path: lib.path, branch: "feat/lib-side" });
  await returnToWindow(crew);
  await worktreeHeader(crew, "feat/app-side").waitFor();
  await rail().getByRole("button", { name: "app", exact: true }).and(page.locator('[aria-current="true"]')).waitFor();

  await pressChord(crew, `${MOD}+Shift+o`);
  const palette = page.getByRole("dialog", { name: "Command palette" });
  await palette.waitFor();
  // lib's worktrees are read from git as the palette opens.
  const pick = palette.getByRole("button").filter({ hasText: "feat/lib-side" });
  await pick.waitFor();
  assert.match(await pick.innerText(), /\blib\b/, "the row names the repo it belongs to");
  await pick.click();
  await palette.waitFor({ state: "detached" });

  // Both switched: the rail is on lib, lib's panel is on the picked worktree.
  await rail().getByRole("button", { name: "lib", exact: true }).and(page.locator('[aria-current="true"]')).waitFor();
  await worktreeHeader(crew, "feat/lib-side").and(currentWorktree(crew)).waitFor();
  assert.equal(await worktreeHeader(crew, "feat/app-side").count(), 0, "app's worktrees left the panel");

  // crewd keeps the choice, and a restart lands on it.
  await waitFor(async () => (await crew.request("active_workspace_get")) === lib.id, {
    message: "crewd stores lib as the active workspace",
  });
  assert.equal(await crew.request("state_get", { key: `worktree:${lib.id}` }), theirs.path);
  crew = await crew.restart();
  await rail().getByRole("button", { name: "lib", exact: true }).and(crew.window.locator('[aria-current="true"]')).waitFor();
  await worktreeHeader(crew, "feat/lib-side").and(currentWorktree(crew)).waitFor();
});
