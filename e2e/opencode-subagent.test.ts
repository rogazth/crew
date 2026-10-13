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
import { MOD, installFakeOpencode, launchCrew, pressChord, sessions, waitFor, type Crew } from "./harness.ts";

let crew: Crew;
let chat: Session;

before(async () => {
  crew = await launchCrew();
  const [workspace] = crew.workspaces;
  assert.ok(workspace);
  await crew.request("state_set", {
    key: "providers:default",
    value: JSON.stringify({ provider: "opencode", model: "opencode/nemotron-3.5-lightning-free", effort: "", access: "full" }),
  });
  await installFakeOpencode(crew);
  await crew.reload();
  const known = new Set((await sessions(crew, workspace.id)).map((row) => row.id));
  await pressChord(crew, `${MOD}+n`);
  chat = await waitFor(async () => (await sessions(crew, workspace.id)).find((row) => row.kind === "terminal" && !known.has(row.id)), {
    message: "the new chat reaches crewd",
  });
  await composer().waitFor();
});

after(async () => {
  await crew?.close();
});

const composer = () => crew.window.locator("textarea:not(.xterm-helper-textarea):visible").first();
const sheet = () => crew.window.locator("[data-work-sheet]");
const page = () => crew.window.locator("[data-agent-view]");
const card = () => crew.window.locator("[data-agent-card]").last();

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
  await page().getByText("echo child").first().waitFor();
  await page().getByText("pong").first().waitFor();
  assert.match(await page().locator("[data-thread-header]").innerText(), /Done/);
  await shoot("thread");
  await crew.window.keyboard.press("Escape");
  await page().waitFor({ state: "detached" });

  const work = crew.window.getByRole("button", { name: /1 agent/ });
  await work.click();
  await sheet().waitFor();
  const rows = await sheet().getByRole("option").allTextContents();
  assert.equal(rows.length, 1, rows.join("\n"));
  assert.match(rows[0]!, /Reply with pong.*Subagent · done/s, rows[0]);
  await shoot("work");
  await crew.window.keyboard.press("Escape");
  await sheet().waitFor({ state: "detached" });
});

test("Stop on a running subagent ends the child and not the parent's turn", async () => {
  const before = (await interrupts()).length;
  await send("hold on SUBAGENT SLOW");
  await card().waitFor({ timeout: 20_000 });
  await card().click();
  await page().waitFor();
  await page().getByText("echo child").first().waitFor();
  await page().locator("[data-thread-header]").getByText("Running").waitFor();
  await shoot("running");
  // The parent's turn is still going: its Stop button is there.
  assert.equal((await crew.request<Session>("session_get", { id: chat.id })).status, "working");

  await crew.window.keyboard.press("x");
  await page().locator("[data-thread-header]").getByText("Stopped").waitFor({ timeout: 20_000 });
  await idle();
  await shoot("stopped");
  await crew.window.keyboard.press("Escape");
  await page().waitFor({ state: "detached" });
  await crew.window.getByText("Done: hold on SUBAGENT SLOW", { exact: true }).waitFor();
  const calls = (await interrupts()).slice(before);
  assert.equal(calls.length, 1, "only the child was interrupted");
});
