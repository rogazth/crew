// Plan 2026-10-07 decisions 33-36 for opencode: a native subagent (a `subagent`
// call that runs a child session on the same server) is shown as Claude's and
// Codex's are. The chat's CLI is the fake opencode 2.x, which on SUBAGENT runs
// the real shape (the call, the child's `session.created` with its `parentID`,
// the call naming the child, the child's own execution): the card opens the
// thread with the child's steps, the child is in the work sheet, and Stop ends
// the child only.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { after, before, test } from "node:test";
import type { Session } from "../src/lib/types.ts";
import { installFakeOpencode, launchCrew, MOD, newSession, waitFor, type Crew, composerOf } from "./harness.ts";

let crew: Crew;
let chat: Session;

before(async () => {
  crew = await launchCrew();
  const [workspace] = crew.workspaces;
  assert.ok(workspace);
  await crew.request("settings_set", {
    key: "providers:default", scope: "global",
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
const sheet = () => crew.window.locator("[data-work-sheet]");
const page = () => crew.window.locator("[data-agent-view]");
const card = () => crew.window.locator("[data-agent-start]").last();

async function send(text: string): Promise<void> {
  const field = composer();
  await field.fill(text);
  await waitFor(() => crew.window.getByRole("button", { name: "Send" }).isEnabled(), { message: "the composer can send" });
  await field.press("Enter");
}

const idle = () =>
  waitFor(async () => (await crew.request<Session>("session_get", { id: chat.id })).status === "idle", { timeout: 30_000, message: "the turn is over" });

/** With E2E_SHOTS set, the window as it is, light and dark. */
async function shoot(name: string): Promise<void> {
  const dir = process.env.E2E_SHOTS;
  if (!dir) return;
  await crew.window.emulateMedia({ colorScheme: "light" });
  await crew.window.screenshot({ path: path.join(dir, `${name}.png`) });
  await crew.window.emulateMedia({ colorScheme: "dark" });
  await crew.window.screenshot({ path: path.join(dir, `${name}-dark.png`) });
  await crew.window.emulateMedia({ colorScheme: null });
}

const interrupts = async () =>
  (await readFile(path.join(crew.home, "fake-opencode.log"), "utf8").catch(() => ""))
    .split("\n")
    .filter((line) => line.includes("/interrupt"))
    .map((line) => JSON.parse(line) as { path: string });

test("a subagent that ran opens as a thread with the child's steps, and is in the work sheet", async () => {
  await send("look into it SUBAGENT");
  await idle();
  await card().waitFor({ timeout: 20_000 });
  // The parent's answer is its own; the child's words are the call's.
  await crew.window.getByText("Done: look into it SUBAGENT", { exact: true }).waitFor();

  await card().click();
  await page().waitFor();
  // What it said is the thread's spine; what it did is one line that opens.
  await page().getByText("pong").first().waitFor();
  assert.equal(await page().getByText("echo child").count(), 0, "the work is folded");
  await page().getByRole("button", { name: /^Worked/ }).first().click();
  await page().getByText("echo child").first().waitFor();
  // It is the chat's own transcript: its words select as the chat's do, and ⌘A keeps to the thread.
  const thread = page().locator('[data-selectable="blocks"]');
  assert.equal(await thread.count(), 1, "the thread is one transcript");
  await thread.getByText("pong", { exact: true }).dblclick();
  assert.equal(await crew.window.evaluate(() => window.getSelection()?.toString().trim()), "pong", "a double click selects the answer's word");
  await crew.window.keyboard.press(`${MOD}+a`);
  const all = (await crew.window.evaluate(() => window.getSelection()?.toString())) ?? "";
  assert.match(all, /Reply with the single word pong\./, all);
  assert.doesNotMatch(all, /Done: look into it/, "the parent's chat is not in the selection");
  await shoot("thread");
  await crew.window.keyboard.press("Escape");
  await page().waitFor({ state: "detached" });

  await crew.window.locator("[data-agents-segment]").first().click();
  const list = crew.window.locator("[data-agent-list]");
  const rows = list.locator("[data-entry]");
  await rows.first().waitFor();
  assert.equal(await rows.count(), 1, (await rows.allTextContents()).join("\n"));
  assert.match((await rows.first().innerText()).replace(/\s+/g, " "), /Reply with pong/);
  await list.locator('[data-list-section="done"]').waitFor();
  await shoot("work");
  await crew.window.keyboard.press("Escape");
  await list.waitFor({ state: "hidden" });
});

test("Stop on a running subagent ends the child and not the parent's turn", async () => {
  const before = (await interrupts()).length;
  // The card of the test before is there already: wait for this call's own.
  const cards = await crew.window.locator("[data-agent-start]").count();
  await send("hold on SUBAGENT SLOW");
  await waitFor(async () => (await crew.window.locator("[data-agent-start]").count()) > cards, { timeout: 20_000, message: "the call's card shows" });
  await card().click();
  await page().waitFor();
  await page().getByText("echo child").first().waitFor();
  const stopButton = page().locator("[data-thread-header]").getByRole("button", { name: /Stop/ });
  await stopButton.waitFor();
  // The working line counts from when the call started, as the chat's does.
  await page().getByText(/^Working for \d+s$/).waitFor();
  await shoot("running");
  // The parent's turn is still going: its Stop button is there.
  assert.equal((await crew.request<Session>("session_get", { id: chat.id })).status, "working");

  await crew.window.keyboard.press("x");
  await stopButton.waitFor({ state: "detached", timeout: 20_000 });
  await idle();
  await shoot("stopped");
  await crew.window.keyboard.press("Escape");
  await page().waitFor({ state: "detached" });
  await crew.window.getByText("Done: hold on SUBAGENT SLOW", { exact: true }).waitFor();
  const calls = (await interrupts()).slice(before);
  assert.equal(calls.length, 1, "only the child was interrupted");
});

test("a second call that continues the same subagent is its own card and opens the same thread with both turns", async () => {
  await send("again SUBAGENT RESUME");
  await idle();
  await crew.window.getByText("Done: again SUBAGENT RESUME", { exact: true }).waitFor();
  const cards = crew.window.locator("[data-agent-start]");
  await waitFor(async () => (await cards.count()) >= 2, { message: "one card per call" });
  const resumed = crew.window.locator("[data-agent-start]").filter({ hasText: "resumed" });
  await resumed.last().waitFor();
  assert.equal(await resumed.count(), 1);
  // Each call brought its own report back, in order.
  assert.equal((await crew.window.locator("[data-report]").count()) >= 2, true);
  await shoot("transcript");

  await cards.last().click();
  await page().waitFor();
  const thread = page();
  await thread.getByText("Reply with the single word pong.", { exact: true }).waitFor();
  await thread.getByText("Again, reply with the single word pong.", { exact: true }).waitFor();
  await thread.getByText("pong again", { exact: true }).waitFor();
  const text = await thread.innerText();
  assert.ok(text.indexOf("Reply with the single word pong.") < text.indexOf("Again, reply"), text);
  assert.ok(text.indexOf("Again, reply") < text.indexOf("pong again"), text);
  // No wrapper card around the answers: they are chat messages.
  assert.equal(await thread.locator("[data-prose]").count(), 0);
  assert.equal(await thread.locator("[data-hang]").count(), 0);
  await shoot("thread");
  await crew.window.keyboard.press("Escape");
  await page().waitFor({ state: "detached" });
});
