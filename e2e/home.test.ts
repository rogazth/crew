// Home: the workspace with no project. A fresh install lands in it, made with
// its folder (~/Crew); a message from its start page starts a claude session
// there with that message; projects open under it on the rail, and it cannot
// be removed.
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { after, before, test } from "node:test";
import type { Workspace } from "../src/lib/types.ts";
import { launchCrew, MOD, sessions, waitFor, type Crew } from "./harness.ts";

let crew: Crew;

before(async () => {
  crew = await launchCrew({ repos: [] });
});

after(async () => {
  await crew?.close();
});

async function home(): Promise<Workspace> {
  let found: Workspace | undefined;
  await waitFor(async () => {
    found = (await crew.request<Workspace[]>("workspace_list")).find((workspace) => workspace.home);
    return found !== undefined;
  }, { message: "home was never made" });
  return found!;
}

const homeMark = () => crew.window.locator("[data-home-mark]");

test("a fresh install lands in home, made with its folder", async () => {
  const made = await home();
  assert.equal(made.path, path.join(crew.home, "Crew"));
  assert.ok(existsSync(made.path), "home's folder was not made");
  await homeMark().and(crew.window.locator('[aria-current="true"]')).waitFor();
  await crew.window.getByRole("heading", { name: "Welcome to Crew" }).waitFor();
  assert.equal(await crew.window.locator("[data-rail-marks] button[data-nav]").count(), 0, "home is listed among the projects");
  await assert.rejects(crew.request("workspace_delete", { id: made.id }), /Home cannot be removed/);
});

test("a message from home's start page starts claude in home's folder with it", async () => {
  const made = await home();
  const field = crew.window.getByRole("textbox", { name: "Ask anything" });
  await field.fill("say hi from home");
  await field.press("Enter");

  let launched: { argv: string[]; cwd: string } | undefined;
  const ok = await waitFor(async () => {
    launched = (await crew.claudeLaunches()).at(-1);
    return launched !== undefined;
  });
  assert.ok(ok, "claude never launched");
  assert.equal(launched!.cwd, made.path);
  assert.deepEqual(launched!.argv.slice(-2), ["--", "say hi from home"]);
  // Taken as its first turn: the CLI's transcript has it as the user's prompt.
  const projects = path.join(crew.home, ".claude/projects");
  const heard = await waitFor(async () => {
    for (const dir of await readdir(projects).catch(() => [])) {
      for (const file of await readdir(path.join(projects, dir)).catch(() => [])) {
        if ((await readFile(path.join(projects, dir, file), "utf8")).includes("say hi from home")) return true;
      }
    }
    return false;
  });
  assert.ok(heard, "the message never reached claude as a turn");
  const [session] = await sessions(crew, made.id);
  assert.equal(session?.provider, "claude");
  await crew.window.locator("[data-sidebar-panel] button[data-session]").first().waitFor();
});

test("a project opens under home, and ⇧⌘H goes back home", async () => {
  const dir = await crew.makeRepo("app");
  const project = await crew.addWorkspace(dir);
  const projectMark = crew.window.locator(`[data-rail-marks] button[data-nav][aria-label="${project.name}"]`);
  await projectMark.and(crew.window.locator('[aria-current="true"]')).waitFor();

  await crew.window.keyboard.press(`${MOD}+Shift+H`);
  await homeMark().and(crew.window.locator('[aria-current="true"]')).waitFor();
  const active = await crew.request<string | null>("active_workspace_get");
  assert.equal(active, (await home()).id);

  await crew.window.keyboard.press(`${MOD}+1`);
  await projectMark.and(crew.window.locator('[aria-current="true"]')).waitFor();
});
