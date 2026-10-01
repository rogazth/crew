// The machine's crewd restarts under a claude terminal that is mid-turn: the
// kernel killed it for memory, or an update replaced it. Its processes went
// with it, and no exit reached the window, which only sees the link drop and
// come back. The pane must not keep the dead CLI's last frame with the keys
// going nowhere: once the machine answers, the CLI starts again on its
// conversation, as it does when Crew opens.
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import type { Session, Workspace } from "../src/lib/types.ts";
import {
  addRemote,
  launchCrew,
  lightIn,
  MOD,
  pressChord,
  remoteRequest,
  sessionRow,
  sessionTab,
  typeInTerminal,
  waitFor,
  type Crew,
  type RemoteDaemon,
} from "./harness.ts";

/** A new terminal in the workspace on screen, made on the machine. */
async function newRemoteTerminal(crew: Crew, remote: RemoteDaemon, workspace: Workspace): Promise<Session> {
  const list = () => remoteRequest<Session[]>(remote, "session_list", { workspaceId: workspace.id });
  const known = new Set((await list()).map((row) => row.id));
  await pressChord(crew, `${MOD}+n`);
  return waitFor(async () => (await list()).find((row) => row.kind === "terminal" && !known.has(row.id)), {
    message: "the terminal is created on the machine",
  });
}

test("a terminal whose machine's crewd restarted mid-turn resumes its CLI and takes keys again", async () => {
  const crew = await launchCrew();
  let remote: RemoteDaemon | null = null;
  try {
    remote = await addRemote(crew, "devbox");
    const api = await crew.makeRepo("api");
    const window = crew.window;
    const workspace = await remoteRequest<Workspace>(remote, "workspace_create", { name: "api", path: api });
    await crew.reload();
    const mark = window.locator(`nav[aria-label="Workspaces"][data-sidebar-rail] button[data-nav][aria-label="api"]`);
    await mark.waitFor();
    await mark.click();
    await window.locator("[data-sidebar-panel]").getByText("api", { exact: true }).first().waitFor();

    // One mid-turn with its tab closed, its CLI running on with nothing drawing it.
    const away = await newRemoteTerminal(crew, remote, workspace);
    await waitFor(async () => (await crew.claudeLaunches()).some((launch) => launch.argv.includes(away.id)), {
      message: "the machine starts the first CLI",
      timeout: 15_000,
    });
    await typeInTerminal(crew, "work 60");
    await waitFor(async () => (await lightIn(sessionRow(crew, away.name))) === "Working", { message: "its turn runs" });
    const tab = sessionTab(crew, away);
    await tab.getByRole("button", { name: "Close tab" }).click();
    await tab.waitFor({ state: "detached" });

    // And one mid-turn on screen.
    const session = await newRemoteTerminal(crew, remote, workspace);
    const launches = async () => (await crew.claudeLaunches()).filter((launch) => launch.argv.includes(session.id));
    await waitFor(async () => (await launches()).length === 1, { message: "the machine starts the CLI", timeout: 15_000 });
    await typeInTerminal(crew, "work 60");
    await waitFor(async () => (await lightIn(sessionRow(crew, session.name))) === "Working", { message: "the turn runs" });
    assert.equal(await lightIn(sessionRow(crew, away.name)), "Working", "the closed tab's turn still runs");

    // crewd goes down and systemd brings it back on the same port and data.
    await remote.stop();
    await remote.start();

    const again = await waitFor(async () => (await launches())[1], {
      message: "the window starts the CLI again once the machine answers",
      timeout: 30_000,
    });
    const resume = again.argv.indexOf("--resume");
    assert.ok(resume >= 0 && again.argv[resume + 1] === session.id, `the CLI resumes its conversation: ${JSON.stringify(again.argv)}`);
    await waitFor(async () => (await lightIn(sessionRow(crew, session.name))) !== "Working", {
      message: "the row lets go of the turn that died",
      timeout: 10_000,
    });

    // The CLI behind the closed tab went too; its row lets go of the turn, flagged for a look.
    await waitFor(async () => (await lightIn(sessionRow(crew, away.name))) === "Unread", {
      message: "the closed tab's row lets go of the turn that died",
      timeout: 10_000,
    });

    // The keys reach the new CLI on the machine.
    await typeInTerminal(crew, "!touch typed-after-restart");
    await waitFor(() => existsSync(path.join(api, "typed-after-restart")), { message: "keys reach the resumed CLI", timeout: 10_000 });
  } finally {
    await remote?.stop();
    await crew.close();
  }
});
