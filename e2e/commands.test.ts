// C1: a service defined once for the workspace, started by a session in a
// worktree on a port of its own. The user sees it from the sidebar, finds it
// on the Services page once the session is gone, stops it, and removing the
// worktree says what it stops. crewd, the sidebar and the page are the witnesses.
// C2: every service started and stopped at once, from the page and the palette.
// C3: a service added from the page: Save goes back to the list and says so.
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import type { Process } from "../src/lib/protocol.ts";
import { launchCrew, MOD, newSession, newWorktree, openServices, pressChord, refreshSidebar, sendInChat, waitFor, worktreeHeader } from "./harness.ts";

const CREW = path.join(fileURLToPath(new URL("..", import.meta.url)), "target/debug/crew");

test("C1: a session's dev server in its worktree is in plain sight, and the user stops it", async (t) => {
  const crew = await launchCrew();
  t.after(() => crew.close());
  const page = crew.window;
  const [workspace] = crew.workspaces;
  assert.ok(workspace);
  const list = () => crew.request<Process[]>("process_list", { workspaceId: workspace.id });
  const tree = path.join(crew.worktrees, "app/feat-web");

  await crew.request("process_create", {
    workspaceId: workspace.id,
    name: "web",
    command: "echo port=$PORT; sleep 120",
    env: { PORT: "3000" },
  });

  // A session in a worktree starts it, on a port of its own, as an agent would.
  await newWorktree(crew, "feat/web");
  await worktreeHeader(crew, "feat/web").waitFor();
  const shell = await newSession(crew, workspace.id, tree);
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
  await sendInChat(crew, `!sh '${script}'`);
  const said = await waitFor(() => readFile(out, "utf8").catch(() => null), { timeout: 60_000, message: "the start script ends" });
  assert.match(said, /port=4011/, said);

  const [web] = await list();
  assert.ok(web);
  const run = web.runs.find((row) => row.worktree === tree);
  assert.equal(run?.state, "running", JSON.stringify(web.runs));
  assert.deepEqual([run?.startedBy, run?.env], [shell.id, { PORT: "4011" }]);

  // The sidebar counts it on the workspace's Services row.
  const places = page.getByRole("navigation", { name: "Workspace", exact: true });
  await places.getByRole("button", { name: "Services (1)", exact: true }).waitFor();

  // The session goes; its server does not, and the page says who left it.
  // Deleted outside the window, which re-reads its sessions to see it.
  await crew.request("session_delete", { id: shell.id });
  await refreshSidebar(crew);
  await openServices(crew);
  const block = page.getByRole("region", { name: "web" });
  await block.getByText("Left running").waitFor();
  // The run's own env is in its pill's title.
  await block.locator('[data-run] [title*="PORT=4011"]').waitFor();

  // Its output opens, from its pill's menu, a level under the command in the same tab.
  await block.locator("[data-run]").click({ button: "right" });
  await page.getByRole("menuitem", { name: "View output" }).click();
  await page.locator("[data-process-header] [data-place]", { hasText: "feat/web" }).waitFor();
  await page.locator("[data-process-header]").getByRole("button", { name: "Stop", exact: true }).waitFor();

  // Stopped from the tab, it is stopped in crewd.
  await page.getByRole("button", { name: "Stop", exact: true }).click();
  await waitFor(async () => (await list())[0]?.runs.find((row) => row.worktree === tree)?.state === "stopped", {
    message: "crewd stops the run",
  });
  await places.getByRole("button", { name: "Services", exact: true }).waitFor();

  // Back to the list, started again with Start, which asks where, then the worktree goes: the prompt says what stops.
  await page.getByRole("button", { name: "Go back" }).click();
  await page.getByRole("region", { name: "web" }).getByRole("button", { name: "Start web in…" }).click();
  await page.getByRole("listbox", { name: "Worktrees" }).getByRole("option", { name: "feat/web" }).click();
  await waitFor(async () => (await list())[0]?.runs.find((row) => row.worktree === tree)?.state === "running", {
    message: "crewd starts it again",
  });
  await worktreeHeader(crew, "feat/web").click({ button: "right" });
  await page.getByRole("menu").getByRole("menuitem", { name: "Remove worktree" }).click();
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

test("C2: every service starts from the palette and stops from the Services page", async (t) => {
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

  // The palette opens the Services page, and the sidebar marks its row.
  await pressChord(crew, `${MOD}+Shift+p`);
  const palette = page.getByRole("dialog", { name: "Command palette" });
  await palette.getByRole("textbox", { name: "Search" }).fill("Services");
  await palette.getByRole("button", { name: /^Services/ }).first().click();
  await palette.waitFor({ state: "detached" });
  await page.getByRole("heading", { name: "Services", level: 1 }).waitFor();
  await page.locator('nav[aria-label="Workspace"] button[aria-current="page"]', { hasText: "Services" }).waitFor();

  // One worktree: Start starts there at once and turns into Stop while it runs.
  const web = page.getByRole("region", { name: "web" });
  await web.getByRole("button", { name: "Start web", exact: true }).click();
  await waitFor(async () => (await states())[0] === "running", { message: "crewd starts web" });
  // No pill for its one run: the service's own ⋯ holds the run's actions.
  await web.getByRole("button", { name: /^More for web in / }).waitFor({ state: "detached" });
  await web.getByRole("button", { name: "More for web", exact: true }).click();
  await page.getByRole("menuitem", { name: "View output" }).waitFor();
  await page.keyboard.press("Escape");
  await web.getByRole("button", { name: "Stop web", exact: true }).click();
  await waitFor(async () => (await states())[0] === "stopped" || (await states())[0] === "exited", { message: "crewd stops web" });
  await web.getByRole("button", { name: "Start web", exact: true }).waitFor();

  await pressChord(crew, `${MOD}+Shift+p`);
  await palette.getByRole("textbox", { name: "Search" }).fill("Start all");
  await palette.getByRole("button", { name: /^Start all services/ }).click();
  await waitFor(async () => (await states()).every((state) => state === "running"), { message: "crewd starts both" });
  await page.getByRole("navigation", { name: "Workspace", exact: true }).getByRole("button", { name: "Services (2)", exact: true }).waitFor();

  // Two runs up: Stop all shows on the Services page, and goes once they stop.
  await page.getByRole("button", { name: "Stop all", exact: true }).click();
  await waitFor(async () => (await states()).every((state) => state === "stopped"), { message: "crewd stops both" });
  await page.getByRole("button", { name: "Stop all", exact: true }).waitFor({ state: "detached" });
});

test("C3: saving a new service goes back to the list and says it was created", async (t) => {
  const crew = await launchCrew();
  t.after(() => crew.close());
  const page = crew.window;
  const [workspace] = crew.workspaces;
  assert.ok(workspace);

  await pressChord(crew, `${MOD}+Shift+p`);
  const palette = page.getByRole("dialog", { name: "Command palette" });
  await palette.getByRole("textbox", { name: "Search" }).fill("Services");
  await palette.getByRole("button", { name: /^Services/ }).first().click();
  await palette.waitFor({ state: "detached" });

  // None yet: the empty state's button is the only way in.
  await page.getByRole("button", { name: "New service" }).click();
  await page.getByLabel("Name").fill("web");
  await page.getByLabel("Command", { exact: true }).fill("sleep 120");
  await page.getByRole("button", { name: "Save" }).click();

  await page.locator("[data-sonner-toast]").filter({ hasText: "Service created" }).waitFor();
  await page.getByRole("region", { name: "web" }).waitFor();
  const [created] = await crew.request<Process[]>("process_list", { workspaceId: workspace.id });
  assert.equal(created?.name, "web");
});
