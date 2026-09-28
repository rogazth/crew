// New Agent makes an agent. v0.1.16 read a saved `agents:mode` and, when it
// said "terminal", made a terminal session out of the sheet instead. The value
// may still be saved on machines that ran that version: it must be ignored.
// "Sessions open in" is about sessions only: agents are made agents under it.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { launchCrew, MOD, pressChord, sessions, waitFor, type Crew } from "./harness.ts";

let crew: Crew;

before(async () => {
  crew = await launchCrew();
});

after(async () => {
  await crew?.close();
});

/** ⇧⌘A, a name, Create: resolves to the session crewd made for it. */
async function newAgent(name: string) {
  const [workspace] = crew.workspaces;
  assert.ok(workspace);
  await pressChord(crew, `${MOD}+Shift+a`);
  const sheet = crew.window.getByRole("dialog", { name: "New agent" });
  await sheet.waitFor();
  await sheet.getByPlaceholder("e.g. Research").fill(name);
  await sheet.getByRole("button", { name: "Create agent" }).click();
  await sheet.waitFor({ state: "detached" });
  return waitFor(async () => (await sessions(crew, workspace.id)).find((row) => row.name === name), {
    message: `crewd has "${name}"`,
  });
}

test("New Agent makes an agent even with v0.1.16's terminal mode saved", async () => {
  await crew.request("state_set", { key: "agents:mode", value: "terminal" });
  await crew.reload();
  const made = await newAgent("Scout");
  assert.equal(made.kind, "agent");
});

test("New Agent makes an agent with sessions opening in the chat", async () => {
  await crew.request("state_set", { key: "sessions:view", value: "chat" });
  await crew.reload();
  const made = await newAgent("Ranger");
  assert.equal(made.kind, "agent");
});
