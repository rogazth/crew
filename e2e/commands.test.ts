// C1: a command defined once for the workspace, started by a session in a
// worktree on a port of its own. The user sees it from the sidebar, finds it
// in the Commands tab once the session is gone, stops it, and removing the
// worktree says what it stops. crewd, the sidebar and the tab are the witnesses.
// C2: every command started and stopped at once, from the tab and the palette.
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import type { Process } from "../src/lib/protocol.ts";
import { currentWorktree, launchCrew, MOD, newTerminal, newWorktree, pressChord, typeInTerminal, waitFor, worktreeHeader } from "./harness.ts";

const CREW = path.join(fileURLToPath(new URL("..", import.meta.url)), "target/debug/crew");

test("C1: a session's dev server in its worktree is in plain sight, and the user stops it", async (t) => {
  const crew = await launchCrew();
  t.after(() => crew.close());
  const page = crew.window;
  const [workspace] = crew.workspaces;
  assert.ok(workspace);
  const list = () => crew.request<Process[]>("process_list", { workspaceId: workspace.id });
  const tree = path.join(crew.home, ".crew/worktrees/app/feat-web");

  await crew.request("process_create", {
    workspaceId: workspace.id,
    name: "web",
    command: "echo port=$PORT; sleep 120",
    env: { PORT: "3000" },
  });

  // A session in a worktree starts it, on a port of its own, as an agent would.
  await newWorktree(crew, "feat/web");
  await worktreeHeader(crew, "feat/web").and(currentWorktree(crew)).waitFor();
  const shell = await newTerminal(crew, workspace.id);
  assert.equal(shell.worktree, tree);
  const script = path.join(tree, ".crew-start.sh");
  const out = path.join(tree, ".crew-start.out");
  await writeFile(
    script,
    [
      `exec > '${out}.part' 2>&1`,
      `'${CREW}' processes start web --env PORT=4011`,
      `'${CREW}' processes wait web port=4011 --timeout-s 20`,
      `mv '${out}.part' '${out}'`,
    ].join("\n"),
  );
  await typeInTerminal(crew, `!sh '${script}'`);
  const said = await waitFor(() => readFile(out, "utf8").catch(() => null), { timeout: 60_000, message: "the start script ends" });
  assert.match(said, /port=4011/, said);

  const [web] = await list();
  assert.ok(web);
  const run = web.runs.find((row) => row.worktree === tree);
  assert.equal(run?.state, "running", JSON.stringify(web.runs));
  assert.deepEqual([run?.startedBy, run?.env], [shell.id, { PORT: "4011" }]);

  // The sidebar says so on the worktree's line and at its foot.
  await worktreeHeader(crew, "feat/web").getByRole("img", { name: "Running: web" }).waitFor();
  const commands = page.locator("[data-sidebar-panel]").getByRole("button", { name: /^Commands: 1 running/ });
  await commands.waitFor();

  // The session goes; its server does not, and the page says who left it.
  // Deleted outside the window, which re-reads its sessions to see it.
  await crew.request("session_delete", { id: shell.id });
  await page.locator("[data-sidebar-panel]").getByRole("button", { name: "Refresh" }).click();
  await page.locator("[data-sidebar-panel]").getByRole("button", { name: "Commands: 1 running, 1 left running" }).click();
  const block = page.getByRole("region", { name: "web" });
  await block.getByText("Left running").waitFor();
  await block.getByText("PORT=4011").waitFor();

  // Its logs open in a tab of that worktree's strip.
  await block.getByRole("button", { name: "Logs of web in feat/web" }).click();
  await page.locator('[data-tab-strip] [role="tab"]').filter({ hasText: "web" }).waitFor();
  await page.getByText("Running · feat/web").waitFor();

  // Stopped from the tab, it is stopped in crewd.
  await page.getByRole("button", { name: "Stop", exact: true }).click();
  await waitFor(async () => (await list())[0]?.runs.find((row) => row.worktree === tree)?.state === "stopped", {
    message: "crewd stops the run",
  });
  await page.locator("[data-sidebar-panel]").getByRole("button", { name: /^Commands: none running/ }).waitFor();

  // Started again from the page, then the worktree goes: the prompt says what stops.
  await page.getByRole("button", { name: /^Commands:/ }).click();
  await page.getByRole("region", { name: "web" }).getByRole("button", { name: "Start web in feat/web" }).click();
  await waitFor(async () => (await list())[0]?.runs.find((row) => row.worktree === tree)?.state === "running", {
    message: "crewd starts it again",
  });
  await worktreeHeader(crew, "feat/web").click({ button: "right" });
  await page.getByRole("menu").getByRole("menuitem", { name: "Remove Worktree…" }).click();
  const alert = page.getByRole("alertdialog");
  await alert.getByText("web stops first.").waitFor();
  await alert.getByRole("button", { name: "Remove" }).click();
  await alert.waitFor({ state: "detached" }).catch(async () => {
    // Untracked files from the start script make git ask for force.
    await alert.getByRole("button", { name: "Remove" }).click();
    await alert.waitFor({ state: "detached" });
  });
  await waitFor(async () => (await list())[0]?.runs.every((row) => row.worktree !== tree), {
    message: "the worktree's run goes with it",
  });
});

test("C2: every command starts from the Commands tab and stops from the palette", async (t) => {
  const crew = await launchCrew();
  t.after(() => crew.close());
  const page = crew.window;
  const [workspace] = crew.workspaces;
  assert.ok(workspace);
  const list = () => crew.request<Process[]>("process_list", { workspaceId: workspace.id });
  const states = async () => (await list()).map((process) => process.runs.find((run) => run.worktree === null)?.state ?? "stopped");
  for (const name of ["web", "worker"]) {
    await crew.request("process_create", { workspaceId: workspace.id, name, command: "sleep 120" });
  }

  // The palette opens Commands as a tab of the strip on screen.
  await pressChord(crew, `${MOD}+Shift+p`);
  const palette = page.getByRole("dialog", { name: "Command palette" });
  await palette.getByRole("textbox", { name: "Search" }).fill("Commands");
  await palette.getByRole("button", { name: /^Commands/ }).first().click();
  await palette.waitFor({ state: "detached" });
  await page.locator('[data-tab-strip] [role="tab"]').filter({ hasText: "Commands" }).waitFor();
  await page.locator('[data-sidebar-panel] button[aria-current="page"]').filter({ hasText: "Commands" }).waitFor();

  await page.getByRole("button", { name: "Start all", exact: true }).click();
  await waitFor(async () => (await states()).every((state) => state === "running"), { message: "crewd starts both" });
  await page.locator("[data-sidebar-panel]").getByRole("button", { name: /^Commands: 2 running/ }).waitFor();
  await page.getByRole("button", { name: "Start all", exact: true }).waitFor({ state: "detached" });

  await pressChord(crew, `${MOD}+Shift+p`);
  await palette.getByRole("textbox", { name: "Search" }).fill("Stop All");
  await palette.getByRole("button", { name: /^Stop All Commands/ }).click();
  await waitFor(async () => (await states()).every((state) => state === "stopped"), { message: "crewd stops both" });
  await page.getByRole("button", { name: "Stop all", exact: true }).waitFor({ state: "detached" });
});
