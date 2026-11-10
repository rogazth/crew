// New Bot makes a bot, in the same dialog a bot's settings open in. v0.1.16
// read a saved `agents:mode` and, when it said "terminal", made a terminal
// session out of the sheet instead. The value may still be saved on machines
// that ran that version: it must be ignored. A bot that exists opens in the
// dialog too, from its card's menu, and each change there is written as it
// is made.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { Rule } from "../src/lib/protocol.ts";
import { launchCrew, MOD, pressChord, sessions, waitFor, type Crew } from "./harness.ts";

let crew: Crew;

before(async () => {
  crew = await launchCrew();
});

after(async () => {
  await crew?.close();
});

/** ⇧⌘A, a name and its instructions, Create: resolves to the session crewd made for it. */
async function newBot(name: string, instructions = "") {
  const [workspace] = crew.workspaces;
  assert.ok(workspace);
  await pressChord(crew, `${MOD}+Shift+a`);
  const dialog = crew.window.getByRole("dialog", { name: "New bot" });
  await dialog.waitFor();
  await dialog.getByLabel("Name", { exact: true }).fill(name);
  if (instructions) await dialog.getByLabel("Instructions", { exact: true }).fill(instructions);
  await dialog.getByRole("button", { name: "Create bot" }).click();
  await dialog.waitFor({ state: "detached" });
  return waitFor(async () => (await sessions(crew, workspace.id)).find((row) => row.name === name), {
    message: `crewd has "${name}"`,
  });
}

test("New Bot makes a bot even with v0.1.16's terminal mode saved", async () => {
  await crew.request("state_set", { key: "agents:mode", value: "terminal" });
  await crew.reload();
  const made = await newBot("Scout");
  assert.equal(made.kind, "bot");
});

test("New Bot keeps what the dialog was given, and Create with no name goes back to the name", async () => {
  await pressChord(crew, `${MOD}+Shift+a`);
  const dialog = crew.window.getByRole("dialog", { name: "New bot" });
  await dialog.waitFor();
  await dialog.getByRole("button", { name: "Create bot" }).click();
  await waitFor(() => dialog.getByLabel("Name", { exact: true }).evaluate((field) => field === document.activeElement), {
    message: "the name has the focus",
  });
  await crew.window.keyboard.press("Escape");
  await dialog.waitFor({ state: "detached" });

  const made = await newBot("Reviewer", "Reviews every pull request.");
  assert.equal(made.description, "Reviews every pull request.");
});

test("A bot's settings open in the dialog, and a rename, its instructions and a rule are kept as they are made", async () => {
  const [workspace] = crew.workspaces;
  assert.ok(workspace);
  const bot = await newBot("Keeper");
  const card = crew.window.locator(`[data-sidebar-panel] button[data-session][aria-label="Keeper"]`);
  const item = crew.window.getByRole("menuitem", { name: "Bot settings" });
  await waitFor(
    async () => {
      if (await item.isVisible()) return true;
      await card.click({ button: "right", force: true });
      return item.waitFor({ timeout: 1000 }).then(
        () => true,
        () => false,
      );
    },
    { message: "the bot's menu opens" },
  );
  await item.click();
  const dialog = crew.window.getByRole("dialog", { name: "Bot settings" });
  await dialog.waitFor();
  assert.ok(await dialog.getByRole("tab", { name: "Routines" }).isVisible(), "a bot that exists has its routines beside General");

  const name = dialog.getByLabel("Name", { exact: true });
  await name.fill("Warden");
  await name.press("Enter");
  await dialog.getByLabel("Instructions", { exact: true }).fill("Guards the main branch.");
  await dialog.getByRole("button", { name: "Add a rule" }).click();
  await dialog.getByLabel("New rule", { exact: true }).fill("Never force-push");
  await dialog.getByLabel("New rule", { exact: true }).press("Enter");

  await waitFor(
    async () => {
      const row = (await sessions(crew, workspace.id)).find((s) => s.id === bot.id);
      return row?.name === "Warden" && row.description === "Guards the main branch.";
    },
    { message: "crewd keeps the new name and the instructions" },
  );
  const { rules } = await waitFor(
    async () => {
      const read = await crew.request<{ rules: Rule[] }>("bot_rules_get", { id: bot.id });
      return read.rules.length > 0 && read;
    },
    { message: "crewd keeps the rule" },
  );
  assert.deepEqual(
    rules.map((rule) => rule.body),
    ["Never force-push"],
  );

  await dialog.getByRole("button", { name: "Close" }).click();
  await dialog.waitFor({ state: "detached" });
});
