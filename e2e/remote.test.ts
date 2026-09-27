// A workspace on another machine: a second crewd (`crewd serve` on loopback)
// stands in for a Linux box on the tailnet. ⌘O picks it and a folder on it,
// the rail badges the workspace, a terminal runs there, and the machine going
// away and coming back is told on the rail without touching this Mac's
// workspace. Settings › Environments lists it, and its menu closes on a click
// outside.
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import type { Locator } from "playwright-core";
import type { Session, Workspace } from "../src/lib/types.ts";
import { addRemote, launchCrew, MOD, pressChord, remoteRequest, typeInTerminal, waitFor, type Crew, type RemoteDaemon } from "./harness.ts";

function mark(crew: Crew, name: string): Locator {
  return crew.window.locator(`nav[aria-label="Workspaces"][data-sidebar-rail] button[data-nav][aria-label="${name}"]`);
}

function badge(crew: Crew, name: string): Promise<string | null> {
  return mark(crew, name)
    .locator("[data-remote-badge]")
    .getAttribute("data-remote-badge", { timeout: 1_000 })
    .catch(() => null);
}

test("a workspace on another machine opens from ⌘O, runs a terminal there, and rides out the machine going away", async () => {
  const crew = await launchCrew();
  let remote: RemoteDaemon | null = null;
  try {
    remote = await addRemote(crew, "devbox");
    const api = await crew.makeRepo("api");
    const window = crew.window;

    // ⌘O lists this Mac and the machine; ⌘2 goes to the machine's folders.
    await pressChord(crew, `${MOD}+o`);
    const machine = window.getByRole("option", { name: /devbox/ });
    await machine.waitFor();
    await waitFor(() => machine.evaluate((row) => /\d+ ms/.test(row.textContent ?? "")), {
      message: "the machine answers its heartbeat",
    });
    await window.keyboard.press(`${MOD}+2`);
    const field = window.getByLabel("Folder on devbox");
    await field.waitFor();
    await field.fill(`${api}/`);
    await window.keyboard.press(`${MOD}+Enter`);

    // The workspace lives in the remote's database, not this Mac's, and the rail badges it.
    await mark(crew, "api").waitFor();
    const remoteList = await remoteRequest<Workspace[]>(remote, "workspace_list");
    assert.deepEqual(
      remoteList.map((row) => row.path),
      [api],
    );
    const localList = await crew.request<Workspace[]>("workspace_list");
    assert.ok(!localList.some((row) => row.path === api), "the Mac's daemon does not hold the remote workspace");
    await waitFor(async () => (await badge(crew, "api")) === "online", { message: "the rail badges the workspace online" });
    const workspace = remoteList[0]!;

    // A terminal in it runs on the machine: its CLI runs in the repo, and a command lands there.
    await pressChord(crew, `${MOD}+n`);
    const session = await waitFor(
      async () => (await remoteRequest<Session[]>(remote!, "session_list", { workspaceId: workspace.id })).find((row) => row.kind === "terminal"),
      { message: "the terminal is created on the machine" },
    );
    await waitFor(async () => (await crew.claudeLaunches()).some((launch) => launch.cwd === api), {
      message: "the machine's crewd starts the CLI in the repo",
      timeout: 15_000,
    });
    await typeInTerminal(crew, "!touch made-on-devbox");
    await waitFor(() => existsSync(path.join(api, "made-on-devbox")), { message: "keys reach the remote terminal" });
    assert.equal((await crew.request<Session[]>("session_list", { workspaceId: workspace.id })).length, 0);
    assert.ok(session.id);

    // The machine goes away: its workspace reads offline, and this Mac's keeps working.
    await remote.stop();
    await waitFor(async () => (await badge(crew, "api")) === "offline", { message: "the rail marks the machine offline", timeout: 20_000 });
    await window.locator('[data-machine-banner="offline"]').waitFor();
    await mark(crew, "app").click();
    await window.locator("[data-sidebar-panel]").getByText("app", { exact: true }).first().waitFor();

    // It comes back on the same port: the badge follows without a reload.
    await remote.start();
    await waitFor(async () => (await badge(crew, "api")) === "online", { message: "the rail marks the machine online again", timeout: 20_000 });
    await mark(crew, "api").click();
    await window.locator("[data-machine-banner]").waitFor({ state: "detached" });

    // Settings › Environments lists it; its menu closes on a click outside.
    await pressChord(crew, `${MOD}+,`);
    await window.getByText("Environments", { exact: true }).first().click();
    const actions = window.getByRole("button", { name: "devbox actions" });
    await actions.click();
    const reconnect = window.getByRole("menuitem", { name: "Reconnect" });
    await reconnect.waitFor();
    await window.mouse.click(10, 700);
    await reconnect.waitFor({ state: "detached" });
  } finally {
    await remote?.stop();
    await crew.close();
  }
});

test("a machine that is off when Crew opens keeps its workspaces on the rail, and they join when it answers", async () => {
  const crew = await launchCrew();
  let remote: RemoteDaemon | null = null;
  try {
    remote = await addRemote(crew, "homepc");
    const web = await crew.makeRepo("web");
    const created = await remoteRequest<Workspace>(remote, "workspace_create", { name: "web", path: web });
    assert.ok(created.id);

    // A workspace made on the machine behind the window's back shows once the machine is reached again.
    await crew.reload();
    await mark(crew, "web").waitFor({ timeout: 15_000 });

    // Off at launch: the rail still has it, offline, from what it saw last.
    await remote.stop();
    await crew.reload();
    await mark(crew, "web").waitFor();
    await waitFor(async () => (await badge(crew, "web")) === "offline", { message: "offline from the cache", timeout: 20_000 });

    await remote.start();
    await waitFor(async () => (await badge(crew, "web")) === "online", { message: "online once it answers", timeout: 20_000 });
  } finally {
    await remote?.stop();
    await crew.close();
  }
});
