// The background panel of a chat session: what the session started and left
// behind, as one line under the composer and a sheet over it. The chat's CLI is
// the fake claude, which starts no background work of its own, so the session
// acts through `crew` with the token it was launched with, the way an agent
// does: it starts a Crew subagent (a fake opencode, which reports at once) and
// a command of the workspace. The user opens the sheet, opens an entry, stops
// one, and clears what ended.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { Process } from "../src/lib/protocol.ts";
import type { Session } from "../src/lib/types.ts";
import { MOD, installFakeOpencode, launchCrew, pressChord, sessions, waitFor, type Crew } from "./harness.ts";

const run = promisify(execFile);
const CREW = path.join(fileURLToPath(new URL("..", import.meta.url)), "target/debug/crew");

let crew: Crew;
let chat: Session;
let cwd: string;

before(async () => {
  crew = await launchCrew();
  const [workspace] = crew.workspaces;
  assert.ok(workspace);
  cwd = workspace.path;
  await crew.request("state_set", {
    key: "providers:default",
    value: JSON.stringify({ provider: "claude", model: "", effort: "", access: "ask" }),
  });
  await crew.request("state_set", { key: "sessions:view", value: "chat" });
  await crew.reload();
  await installFakeOpencode(crew);
  await crew.request("process_create", { workspaceId: workspace.id, name: "web", command: "echo up; sleep 300" });

  const known = new Set((await sessions(crew, workspace.id)).map((row) => row.id));
  await pressChord(crew, `${MOD}+n`);
  chat = await waitFor(async () => (await sessions(crew, workspace.id)).find((row) => row.kind === "terminal" && !known.has(row.id)), {
    message: "the new chat reaches crewd",
  });
  await composer().waitFor();
  await send("hello");
  await said("Reply 1: hello").waitFor();
  await waitFor(async () => (await crew.request<Session>("session_get", { id: chat.id })).status === "idle", { message: "the turn is over" });
});

after(async () => {
  await crew?.close();
});

const composer = () => crew.window.locator("textarea:not(.xterm-helper-textarea):visible").first();
const said = (text: string | RegExp) => crew.window.getByText(text, typeof text === "string" ? { exact: true } : {});
const sheet = () => crew.window.locator("[data-work-sheet]");
const rows = () => sheet().getByRole("option");

async function send(text: string): Promise<void> {
  const field = composer();
  await field.fill(text);
  await waitFor(() => crew.window.getByRole("button", { name: "Send" }).isEnabled(), { message: "the composer can send" });
  await field.press("Enter");
}

/** What the chat's CLI was launched with: the socket and token it speaks to crewd as the session. */
async function sessionEnv(): Promise<NodeJS.ProcessEnv> {
  const launch = (await crew.claudeLaunches()).find((one) => one.argv.includes(chat.id));
  assert.ok(launch, "the chat's CLI started");
  const text =
    process.platform === "linux"
      ? (await readFile(`/proc/${launch.pid}/environ`, "utf8")).split("\0").join("\n")
      : (await run("ps", ["eww", "-o", "command=", "-p", String(launch.pid)])).stdout;
  // The socket sits in a folder named "Crew Dev": a value runs up to the next `NAME=`.
  const pick = (name: string) => new RegExp(`(?:^|\\s)${name}=(.+?)(?=\\s[A-Za-z_][A-Za-z0-9_]*=|$)`).exec(text)?.[1];
  const [socket, token] = [pick("CREW_SOCKET"), pick("CREW_TOKEN")];
  assert.ok(socket && token, "the CLI's environment names crewd");
  const { CREW_DATA_DIR: _dir, ...rest } = process.env;
  return { ...rest, HOME: crew.home, CREW_SOCKET: socket, CREW_TOKEN: token };
}

const processes = (workspaceId: string) => crew.request<Process[]>("process_list", { workspaceId });

test("what the session started is one line under the composer, and its sheet lists running work before what ended", async () => {
  const env = await sessionEnv();
  await run(CREW, ["sessions", "delegate", "--provider", "opencode", "--name", "Lint pass", "--", "tidy the imports"], { env });
  const child = await waitFor(async () => (await sessions(crew, chat.workspaceId)).find((row) => row.parentId === chat.id), {
    timeout: 20_000,
    message: "the child reaches crewd",
  });
  await waitFor(async () => (await crew.request<Session>("session_get", { id: child.id })).lastEvent?.kind === "report", {
    timeout: 20_000,
    message: "the child reports",
  });
  await run(CREW, ["processes", "start", "web"], { env });

  // A child that reported counts as finished; the command is still up.
  const work = crew.window.getByRole("button", { name: "1 process", exact: true });
  await work.waitFor();
  await work.click();
  await sheet().waitFor();
  const texts = await rows().allTextContents();
  assert.equal(texts.length, 2, texts.join("\n"));
  assert.match(texts[0]!, /web.*Process · \d+s/, "running work comes first");
  assert.match(texts[1]!, /Lint pass.*Crew subagent · done after/, "then what ended");
  assert.equal(await sheet().getByRole("button", { name: "Clear finished" }).count(), 1);
  await rows().nth(0).waitFor();
  assert.equal(await rows().nth(0).getAttribute("aria-selected"), "true");
  await work.click();
  await sheet().waitFor({ state: "detached" });
});

test("Esc closes the sheet and does not also stop the turn", async () => {
  await send("work 20");
  const stop = crew.window.getByRole("button", { name: "Stop" });
  await stop.waitFor();
  const interrupts = async () => (await readFile(path.join(crew.home, "fake-claude-control.log"), "utf8").catch(() => "")).split("\n").filter((line) => line.startsWith("interrupt")).length;
  const before = await interrupts();

  await crew.window.getByRole("button", { name: "1 process", exact: true }).click();
  await sheet().waitFor();
  await crew.window.keyboard.press("Escape");
  await sheet().waitFor({ state: "detached" });
  assert.equal(await stop.isVisible(), true, "the turn was stopped by the Esc that closed the sheet");
  assert.equal(await interrupts(), before, "the CLI was told to interrupt");

  // With the sheet closed, Esc is the turn's again.
  await composer().press("Escape");
  await stop.waitFor({ state: "detached" });
  await waitFor(async () => (await interrupts()) > before, { message: "the CLI was told to interrupt" });
});

test("↵ opens a Crew subagent over the chat with its own composer, and Esc goes back", async () => {
  const { 0: child } = (await sessions(crew, chat.workspaceId)).filter((row) => row.parentId === chat.id);
  assert.ok(child);
  await crew.window.getByRole("button", { name: "1 process", exact: true }).click();
  await sheet().waitFor();
  await crew.window.keyboard.press("ArrowDown");
  await waitFor(async () => (await rows().nth(1).getAttribute("aria-selected")) === "true", { message: "↓ selects the second row" });
  await crew.window.keyboard.press("Enter");
  await sheet().waitFor({ state: "detached" });

  const page = crew.window.locator("[data-entry-view]");
  await page.waitFor();
  await page.getByText("Lint pass", { exact: true }).first().waitFor();
  await page.getByText("Done: tidy the imports").waitFor();
  await page.locator(`textarea[placeholder*="Ask Lint pass anything"]`).waitFor();

  await crew.window.keyboard.press("Escape");
  await page.waitFor({ state: "detached" });
  await composer().waitFor();
});

test("x stops a command, and opening a command opens its tab", async () => {
  const [workspace] = crew.workspaces;
  assert.ok(workspace);
  await crew.window.getByRole("button", { name: "1 process", exact: true }).click();
  await sheet().waitFor();
  // The first row is the running command; x stops it.
  await crew.window.keyboard.press("x");
  await waitFor(async () => (await processes(workspace.id))[0]?.runs.find((one) => one.worktree === null)?.state === "stopped", {
    message: "crewd stops the run",
  });
  const finished = crew.window.getByRole("button", { name: "2 finished", exact: true });
  await rows().filter({ hasText: "Process · stopped" }).waitFor();

  // Enter on it leaves the chat for the command's own tab and closes the sheet.
  await crew.window.keyboard.press("Enter");
  await sheet().waitFor({ state: "detached" });
  await crew.window.locator('[data-tab-strip] [role="tab"]').filter({ hasText: "web" }).waitFor();
  await crew.window.locator('[data-tab-strip] [role="tab"]').filter({ hasText: chat.name }).click();
  await finished.waitFor();
});

test("Clear finished empties the panel, and the line goes with it", async () => {
  await crew.window.getByRole("button", { name: "2 finished", exact: true }).click();
  await sheet().getByRole("button", { name: "Clear finished" }).click();
  await sheet().waitFor({ state: "detached" });
  await crew.window.getByRole("button", { name: /finished$|process|agent|shell/ }).waitFor({ state: "detached" });
  // The child is still a session of the workspace: only the panel forgot it.
  assert.ok((await sessions(crew, chat.workspaceId)).some((row) => row.parentId === chat.id));
});

test("what Clear finished hid stays hidden after a reload, and a process that starts again shows", async () => {
  const [workspace] = crew.workspaces;
  assert.ok(workspace);
  const line = /finished$|process|agent|shell/;
  // The daemon keeps the keys with the session, not the window.
  const board = await crew.request<{ hidden: string[] }>("background_list", { sessionId: chat.id });
  assert.equal(board.hidden.length, 2, board.hidden.join("\n"));

  await crew.reload();
  await composer().waitFor();
  await said("Reply 1: hello").waitFor();
  // The line would be there by now were the child and the stopped run listed.
  await crew.window.waitForTimeout(500);
  assert.equal(await crew.window.getByRole("button", { name: line }).count(), 0, "the cleared entries came back");

  // The run starts again: another run, so another entry.
  await run(CREW, ["processes", "start", "web"], { env: await sessionEnv() });
  const work = crew.window.getByRole("button", { name: "1 process", exact: true });
  await work.waitFor();
  await work.click();
  await sheet().waitFor();
  const texts = await rows().allTextContents();
  assert.equal(texts.length, 1, texts.join("\n"));
  assert.match(texts[0]!, /web.*Process · \d+s/);

  // Stopped and cleared again, it goes the same way.
  await crew.window.keyboard.press("x");
  await waitFor(async () => (await processes(workspace.id))[0]?.runs.find((one) => one.worktree === null)?.state === "stopped", {
    message: "crewd stops the run",
  });
  await sheet().getByRole("button", { name: "Clear finished" }).click();
  await sheet().waitFor({ state: "detached" });
  await crew.window.getByRole("button", { name: line }).waitFor({ state: "detached" });
});

test("a subagent the chat's CLI runs shows its tokens and its step, and x stops it through the CLI", async () => {
  const controls = async () => (await readFile(path.join(crew.home, "fake-claude-control.log"), "utf8").catch(() => "")).split("\n");
  await send("agent");
  await said(/^Reply \d+: agent$/).waitFor();
  await waitFor(async () => (await crew.request<Session>("session_get", { id: chat.id })).status === "idle", { message: "the turn is over" });

  // The turn is over and the subagent is not: it is the line under the composer.
  const line = crew.window.getByRole("button", { name: "1 agent", exact: true });
  await line.waitFor();
  await line.click();
  await sheet().waitFor();
  const row = rows().nth(0);
  await row.waitFor();
  const text = await row.textContent();
  assert.match(text ?? "", /Explore the repo.*Subagent · \d+s · 41k tokens · Reading README\.md/, text ?? "");
  assert.equal(await row.getByRole("button", { name: "Stop" }).count(), 1, "a subagent can be stopped alone");

  await crew.window.keyboard.press("x");
  await rows().filter({ hasText: "Subagent · stopped" }).waitFor();
  assert.ok((await controls()).includes("stop_task ag1"), (await controls()).join("\n"));
  const board = await crew.request<{ commands: { id: string; state: string; tokens?: number }[] }>("background_list", { sessionId: chat.id });
  assert.deepEqual([board.commands[0]?.id, board.commands[0]?.state, board.commands[0]?.tokens], ["ag1", "stopped", 41_300]);
  await crew.window.keyboard.press("Escape");
  await sheet().waitFor({ state: "detached" });
});
