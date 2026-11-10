// With one subagent at work and nothing else to list, the clip over the prompt
// opens that subagent's transcript, not a list of one; a second click closes it.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { Session } from "../src/lib/types.ts";
import { composerOf, installFakeOpencode, launchCrew, newSession, turnOver, waitFor, type Crew } from "./harness.ts";

let crew: Crew;
let chat: Session;

before(async () => {
  crew = await launchCrew();
  const [workspace] = crew.workspaces;
  assert.ok(workspace);
  await crew.request("settings_set", {
    key: "providers:default",
    scope: "global",
    value: JSON.stringify({ provider: "opencode", model: "opencode/nemotron-3.5-lightning-free", effort: "", access: "full" }),
  });
  await installFakeOpencode(crew);
  await crew.reload();
  chat = await newSession(crew, workspace.id);
  await composer().waitFor();
});

after(async () => {
  await crew?.close();
});

const composer = () => composerOf(crew, chat);
const page = () => crew.window.locator("[data-agent-view]");
const segment = () => crew.window.locator('[data-sheet="workspace"] [data-agents-working]').first();

test("the clip opens the one subagent at work straight away", async () => {
  await turnOver(crew);
  await composer().fill("hold on SUBAGENT SLOW");
  await waitFor(() => crew.window.getByRole("button", { name: "Send", exact: true }).isEnabled(), { message: "the composer can send" });
  await composer().press("Enter");

  await segment().waitFor({ timeout: 20_000 });
  await waitFor(async () => /^1 working$/.test(await segment().innerText()), { timeout: 20_000, message: "the clip says one works" });
  await segment().click();
  await page().waitFor();
  await page().getByText("echo child").first().waitFor();
  // The list stays mounted under whoever is open; the agent is what shows.
  assert.equal(await page().isVisible(), true, "the agent's transcript shows");

  await segment().click();
  await page().waitFor({ state: "detached" });

  // Stop the child so the run ends clean.
  await segment().click();
  await page().waitFor();
  const stop = page().locator("[data-thread-header]").getByRole("button", { name: /Stop/ });
  await stop.click();
  await stop.waitFor({ state: "detached", timeout: 20_000 });
});
