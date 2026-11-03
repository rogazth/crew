// What a chat session started: its agents in the right panel, what they left
// running in a sheet over the composer, one line under it for each. The chat's CLI is
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
import { installFakeOpencode, launchCrew, newSession, sessions, waitFor, type Crew, composerOf } from "./harness.ts";

const run = promisify(execFile);
const CREW = path.join(fileURLToPath(new URL("..", import.meta.url)), "target/debug/crew");

let crew: Crew;
let chat: Session;

before(async () => {
  crew = await launchCrew();
  const [workspace] = crew.workspaces;
  assert.ok(workspace);
  await crew.request("settings_set", {
    key: "providers:default", scope: "global",
    value: JSON.stringify({ provider: "claude", model: "", effort: "", access: "ask" }),
  });
  await crew.reload();
  await installFakeOpencode(crew);
  await crew.request("process_create", { workspaceId: workspace.id, name: "web", command: "echo up; sleep 300" });

  chat = await newSession(crew, workspace.id);
  await composer().waitFor();
  await send("hello");
  await said("Reply 1: hello").waitFor();
  await waitFor(async () => (await crew.request<Session>("session_get", { id: chat.id })).status === "idle", { message: "the turn is over" });
});

after(async () => {
  await crew?.close();
});

const composer = () => composerOf(crew, chat);
const said = (text: string | RegExp) => crew.window.getByText(text, typeof text === "string" ? { exact: true } : {});
/** The panes, without the sidebar: its rows carry session ids and names too. */
const inChat = () => crew.window.locator('[data-sheet="workspace"]');
const sheet = () => crew.window.locator("[data-work-sheet]");
/** The status line's way to everyone the chat has worked with. */
const agentsSegment = () => inChat().locator("[data-agents-segment]").first();
const list = () => crew.window.locator("[data-agent-list]");
const agentRow = (text: string | RegExp) => list().locator("[data-entry]").filter({ hasText: text });
/** The status line's work segment: it opens the sheet of what was left running. */
const workTrigger = () => crew.window.locator("[data-work-trigger]").first();
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
  await run(CREW, ["sessions", "delegate", "--provider", "opencode", "--effort", "none", "--name", "Lint pass", "--", "tidy the imports"], { env });
  const child = await waitFor(async () => (await sessions(crew, chat.workspaceId)).find((row) => row.parentId === chat.id), {
    timeout: 20_000,
    message: "the child reaches crewd",
  });
  await waitFor(async () => (await crew.request<Session>("session_get", { id: child.id })).lastEvent?.kind === "report", {
    timeout: 20_000,
    message: "the child reports",
  });
  await run(CREW, ["processes", "start", "web"], { env });

  // Nothing wants the user, so nothing sits over the composer.
  assert.equal(await crew.window.locator("[data-notice]").count(), 0);
  await agentsSegment().waitFor();
  assert.match(await agentsSegment().innerText(), /View sub-agents/, "a child that reported is not working");

  // The agent is in the panel, what it left running in the sheet.
  await agentsSegment().click();
  await agentRow("Lint pass").waitFor();
  assert.match((await agentRow("Lint pass").innerText()).replace(/\s+/g, " "), /Lint pass/);
  await agentsSegment().click();
  await list().waitFor({ state: "hidden" });

  const work = workTrigger();
  await work.waitFor();
  await work.click();
  await sheet().waitFor();
  const texts = await rows().allTextContents();
  assert.equal(texts.length, 1, texts.join("\n"));
  assert.match(texts[0]!, /web.*Process · \d+s/);
  await work.click();
  await sheet().waitFor({ state: "hidden" });
});

test("Esc closes the sheet and does not also stop the turn", async () => {
  await send("work 20");
  const stop = crew.window.getByRole("button", { name: "Stop" });
  await stop.waitFor();
  const interrupts = async () => (await readFile(path.join(crew.home, "fake-claude-control.log"), "utf8").catch(() => "")).split("\n").filter((line) => line.startsWith("interrupt")).length;
  const before = await interrupts();
  // The key hints show only while the turn runs.
  // Idle, ⇧Tab's effort stepping is always named: wait for the turn's own hint.
  const hints = visible("[data-status-line] [data-key-hints]");
  await waitFor(async () => /esc\s*stop/.test(await hints.innerText().catch(() => "")), { message: "the hints name Esc while the turn runs" });
  await shoot("composer-working");

  await workTrigger().click();
  await sheet().waitFor();
  await crew.window.keyboard.press("Escape");
  await sheet().waitFor({ state: "hidden" });
  assert.equal(await stop.isVisible(), true, "the turn was stopped by the Esc that closed the sheet");
  // Esc closes the right panel just the same, with the keyboard still in this chat's composer.
  await agentsSegment().click();
  await list().waitFor();
  await composer().focus();
  await crew.window.keyboard.press("Escape");
  await list().waitFor({ state: "hidden" });
  assert.equal(await stop.isVisible(), true, "the turn was stopped by the Esc that closed the panel");
  assert.equal(await interrupts(), before, "the CLI was told to interrupt");

  // With the sheet closed, Esc is the turn's again.
  await composer().press("Escape");
  await stop.waitFor({ state: "detached" });
  await waitFor(async () => (await interrupts()) > before, { message: "the CLI was told to interrupt" });
  await waitFor(async () => !/esc/.test(await hints.innerText().catch(() => "")), { message: "the hints drop Esc once the turn is over" });
  assert.doesNotMatch(await visible("[data-status-line]").innerText(), /send|new line/, "an idle composer shows no key hints");
  await shoot("composer-idle");
});

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

const visible = (selector: string) => crew.window.locator(`${selector} >> visible=true`);

test("a Crew subagent opens in the right panel beside the chat, with its own composer and its model locked, and Esc closes it", async () => {
  const { 0: child } = (await sessions(crew, chat.workspaceId)).filter((row) => row.parentId === chat.id);
  assert.ok(child);
  // What the reader had typed in the parent comes back untouched.
  await composer().fill("half a thought");
  await agentsSegment().click();
  await agentRow("Lint pass").click();

  const page = crew.window.locator("[data-side-panel] [data-agent-view]");
  await page.waitFor();
  await page.getByText("Done: tidy the imports").waitFor();
  await composerOf(crew, child).waitFor();

  // Its name and a way back: how it stands and what it runs say so elsewhere.
  const header = page.locator("[data-thread-header]");
  assert.match(await header.innerText(), /Lint pass/);
  assert.doesNotMatch(await header.innerText(), new RegExp(`${chat.name}|Done|esc`, "i"), "only this agent's name");
  assert.equal(await header.getByRole("button", { name: "Close" }).count(), 1);
  assert.equal(await header.getByRole("button", { name: "All sub-agents" }).count(), 1);
  assert.match((await header.getAttribute("title")) ?? "", /Subagent .*reports to /s);

  // The chips are the main prompt's, shown and not offered.
  const chips = page.locator(".ds-model-group");
  assert.equal(await chips.getAttribute("inert"), "");
  assert.equal(await page.locator(".ds-access").count(), 0);

  // The chat stays on screen beside it, its own line under its own prompt.
  await composer().waitFor();
  assert.equal(await page.locator("[data-status-line]").getAttribute("data-session"), child.id);
  await shoot("thread-crew");

  // Its composer writes to the child, which answers and reports again.
  const before = (await crew.request<Session>("session_get", { id: child.id })).lastEvent?.at ?? 0;
  const field = composerOf(crew, child);
  await field.fill("ping");
  await field.press("Enter");
  await page.getByText("ping", { exact: true }).first().waitFor();
  await waitFor(async () => ((await crew.request<Session>("session_get", { id: child.id })).lastEvent?.at ?? 0) > before, {
    timeout: 20_000,
    message: "the child answers",
  });
  await waitFor(async () => (await crew.request<Session>("session_get", { id: child.id })).status === "idle", { message: "its turn is over" });

  await crew.window.keyboard.press("Escape");
  await list().waitFor({ state: "hidden" });
  assert.equal(await composer().innerText(), "half a thought", "the parent's draft is intact");
  await composer().fill("");
});

test("x stops a command, and opening a command opens its tab", async () => {
  const [workspace] = crew.workspaces;
  assert.ok(workspace);
  await workTrigger().click();
  await sheet().waitFor();
  await waitFor(async () => (await rows().nth(0).getAttribute("aria-selected")) === "true", { message: "the command is selected" });
  await crew.window.keyboard.press("x");
  await waitFor(async () => (await processes(workspace.id))[0]?.runs.find((one) => one.worktree === null)?.state === "stopped", {
    message: "crewd stops the run",
  });
  const finished = workTrigger();
  await rows().filter({ hasText: "Process · stopped" }).waitFor();

  // Enter on it leaves the chat for the command's own tab and closes the sheet.
  await crew.window.keyboard.press("Enter");
  await sheet().waitFor({ state: "hidden" });
  await crew.window.locator('[data-tab-strip] [role="tab"]').filter({ hasText: "web" }).waitFor();
  await crew.window.locator('[data-tab-strip] [role="tab"]').filter({ hasText: chat.name }).click();
  await finished.waitFor();
});

test("Clear finished empties the sheet and leaves the agents in the list", async () => {
  await workTrigger().click();
  await sheet().getByRole("button", { name: "Clear finished" }).click();
  await sheet().waitFor({ state: "hidden" });
  await crew.window.locator("[data-work-trigger]").waitFor({ state: "detached" });
  await agentsSegment().click();
  await agentRow("Lint pass").waitFor();
  await agentsSegment().click();
  await list().waitFor({ state: "hidden" });
});

test("what Clear finished hid stays hidden after a reload, and a process that starts again shows", async () => {
  const [workspace] = crew.workspaces;
  assert.ok(workspace);
  // The daemon keeps the keys with the session, not the window.
  const board = await crew.request<{ hidden: string[] }>("background_list", { sessionId: chat.id });
  assert.equal(board.hidden.length, 1, "the run; the child stays listed");

  await crew.reload();
  await composer().waitFor();
  await said("Reply 1: hello").waitFor();
  // The line would be there by now were the stopped run listed.
  await crew.window.waitForTimeout(500);
  assert.equal(await crew.window.locator("[data-work-trigger]").count(), 0, "the cleared entry came back");

  // The run starts again: another run, so another entry.
  await run(CREW, ["processes", "start", "web"], { env: await sessionEnv() });
  const work = workTrigger();
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
  await sheet().waitFor({ state: "hidden" });
  await crew.window.locator("[data-work-trigger]").waitFor({ state: "detached" });
});

test("a subagent the chat's CLI runs shows its tokens and its step, and x stops it through the CLI", async () => {
  const controls = async () => (await readFile(path.join(crew.home, "fake-claude-control.log"), "utf8").catch(() => "")).split("\n");
  await send("agent");
  await said(/^Reply \d+: agent$/).waitFor();
  await waitFor(async () => (await crew.request<Session>("session_get", { id: chat.id })).status === "idle", { message: "the turn is over" });

  // The turn is over and the subagent is not: the line under the composer says so.
  await waitFor(async () => /1 sub-agent working/.test(await agentsSegment().innerText()), { message: "the line counts it" });
  await agentsSegment().click();
  const row = agentRow("Explore the repo");
  await row.waitFor();
  const text = await row.textContent();
  assert.match(text ?? "", /Opus 5\.5 · 41k tokens · Reading README\.md/, text ?? "");
  assert.equal(await row.getByRole("button", { name: "Stop" }).count(), 1, "a subagent can be stopped alone");

  await row.hover();
  await row.getByRole("button", { name: "Stop" }).click();
  await agentRow(/Stopped/).waitFor();
  assert.ok((await controls()).includes("stop_task ag1"), (await controls()).join("\n"));
  const board = await crew.request<{ commands: { id: string; state: string; tokens?: number }[] }>("background_list", { sessionId: chat.id });
  assert.deepEqual([board.commands[0]?.id, board.commands[0]?.state, board.commands[0]?.tokens], ["ag1", "stopped", 41_300]);
  await crew.window.keyboard.press("Escape");
  await list().waitFor({ state: "hidden" });
});

test("the list holds a native subagent, a Crew subagent and a session alike, and the sheet the shell", async () => {
  const env = await sessionEnv();
  await run(CREW, ["sessions", "start", "--provider", "opencode", "--effort", "none", "--name", "billing-ui", "--", "wire the billing page"], { env });
  await waitFor(async () => (await sessions(crew, chat.workspaceId)).some((row) => row.launchedBy === chat.id), {
    timeout: 20_000,
    message: "the launched session reaches crewd",
  });
  const idle = () => waitFor(async () => (await crew.request<Session>("session_get", { id: chat.id })).status === "idle", { message: "the turn is over" });
  await send("agent");
  await idle();
  await send("shell");
  await idle();

  await agentsSegment().click();
  await agentRow("Explore the repo").first().waitFor();
  await agentRow("billing-ui").waitFor();
  await agentRow("Lint pass").waitFor();
  await list().locator("[data-entry]").filter({ hasText: "Explore the repo" }).filter({ hasText: /Stopped · Opus 5\.5/ }).first().waitFor();
  if (process.env.E2E_SHOTS) await crew.window.screenshot({ path: path.join(process.env.E2E_SHOTS, "agent-list.png") });

  // No limit on what it lists, and it finds, sorts and filters as the sessions' list does.
  const titles = async () => (await list().locator("[data-entry] span.font-medium").allInnerTexts()).map((text) => text.trim());
  const all = await titles();
  assert.ok(all.length >= 4, all.join(", "));
  await list().getByRole("button", { name: "Find", exact: true }).click();
  await list().getByLabel("Find sub-agents").fill("billing");
  await waitFor(async () => (await titles()).join() === "billing-ui", { message: "search narrows the list" });
  await list().getByRole("button", { name: "Close search" }).click();
  const view = () => list().locator("[data-list-view]");
  // Each menu settles before its submenu is reached for.
  const pick = async (menu: RegExp, item: string) => {
    await view().click();
    await crew.window.waitForTimeout(250);
    await crew.window.getByRole("menuitem", { name: menu }).hover();
    await crew.window.getByRole("menuitemradio", { name: item }).click();
    // The submenu closes with the pick or with this Esc; a menu still up after it has settled takes one more.
    await crew.window.keyboard.press("Escape");
    await crew.window.waitForTimeout(300);
    if (await crew.window.getByRole("menuitem", { name: menu }).isVisible()) await crew.window.keyboard.press("Escape");
    await crew.window.waitForTimeout(250);
  };
  await pick(/Group by/, "None");
  await list().locator('[data-list-section="all"]').waitFor();
  await pick(/Ordering/, "Name");
  const named = await titles();
  assert.deepEqual(named, [...named].sort((a, b) => a.localeCompare(b)), "sorted by name");
  await view().click();
  await crew.window.getByRole("menuitem", { name: "Reset view" }).click();
  await list().locator('[data-list-section="all"]').waitFor({ state: "detached" });

  // The panel is as wide as it was left, after a reload too.
  const box = await crew.window.locator("[data-side-panel]").boundingBox();
  const grip = await crew.window.locator(".ds-side-resize >> visible=true").boundingBox();
  assert.ok(box && grip);
  await crew.window.mouse.move(grip.x + grip.width / 2, grip.y + 100);
  await crew.window.mouse.down();
  await crew.window.mouse.move(grip.x - 60, grip.y + 100, { steps: 4 });
  await crew.window.mouse.up();
  await waitFor(async () => ((await crew.window.locator("[data-side-panel]").boundingBox())?.width ?? 0) > box.width + 40, { message: "the panel grows" });
  await waitFor(async () => Number(await crew.request<string | null>("state_get", { key: "side-panel:width" })) > 420, { message: "the width is kept" });

  await crew.window.keyboard.press("Escape");
  await list().waitFor({ state: "hidden" });

  await workTrigger().click();
  await sheet().waitFor();
  const texts = (await rows().allTextContents()).join("\n");
  assert.match(texts, /Shell.*Shell · \d+s/, texts);
  assert.doesNotMatch(texts, /Explore the repo|billing-ui/, "agents are the list's");
  if (process.env.E2E_SHOTS) await crew.window.screenshot({ path: path.join(process.env.E2E_SHOTS, "work-sheet.png") });
});

/** The sheet is open already when the test before left it so. */
async function openWorkSheet(): Promise<void> {
  if (!(await sheet().isVisible())) await workTrigger().click();
  await sheet().waitFor();
}

test("a native subagent opens with no composer and a read-only footer, and x stops it", async () => {
  const controls = async () => (await readFile(path.join(crew.home, "fake-claude-control.log"), "utf8").catch(() => "")).split("\n");
  // It runs a third: the first was stopped, the second still runs, and the newest is listed first.
  await send("agent");
  await waitFor(async () => (await crew.request<Session>("session_get", { id: chat.id })).status === "idle", { message: "the turn is over" });
  await crew.window.keyboard.press("Escape");
  await agentsSegment().click();
  await list().locator("[data-entry]").filter({ hasText: "Explore the repo" }).filter({ hasText: "Reading README" }).first().click();

  const page = crew.window.locator("[data-side-panel] [data-agent-view]");
  await page.waitFor();
  assert.equal(await page.locator("[data-composer]").count(), 0, "a native subagent takes no message");
  assert.equal(await page.locator("[data-status-line]").count(), 0, "no composer, so no status line");
  const footer = page.locator("[data-thread-footer]");
  assert.match(await footer.innerText(), new RegExp(`Read only · its report goes to ${chat.name}.*esc back.*x stop`, "s"));
  await shoot("thread-native");

  // A click on the chat's prompt must not take x from the thread: focus is on the page here.
  await page.locator("[data-thread-header]").getByRole("button", { name: /Stop/ }).waitFor();
  await crew.window.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await crew.window.keyboard.press("x");
  await page.locator("[data-thread-header]").getByRole("button", { name: /Stop/ }).waitFor({ state: "detached" });
  assert.ok((await controls()).includes("stop_task ag3"), (await controls()).join("\n"));
  await crew.window.keyboard.press("Escape");
  await list().waitFor({ state: "hidden" });
  await composer().waitFor();
});

test("a shell opens in place under the same header, with its output and no composer", async () => {
  await openWorkSheet();
  await rows().filter({ hasText: /Shell.*Shell/ }).first().click();
  await sheet().waitFor({ state: "hidden" });

  const page = crew.window.locator("[data-agent-view]");
  await page.waitFor();
  await page.locator("[data-background-output]").waitFor();
  assert.equal(await page.locator("[data-composer]").count(), 0);
  assert.match(await page.locator("[data-thread-header]").innerText(), /^Shell/);
  assert.match((await page.locator("[data-thread-header] [title]").first().getAttribute("title")) ?? "", /Shell/);
  assert.match(await page.locator("[data-background-command]").innerText(), /^\$ npm test/);
  assert.match(await page.locator("[data-thread-footer]").innerText(), /Output of a shell/);
  await shoot("thread-shell");
  await crew.window.keyboard.press("Escape");
  await page.waitFor({ state: "detached" });
});

test("a native subagent's call is one beat, and it opens its thread in place", async () => {
  await send("agent");
  await waitFor(async () => (await crew.request<Session>("session_get", { id: chat.id })).status === "idle", { message: "the turn is over" });
  const beat = crew.window.locator("[data-agent-start]").last();
  await beat.waitFor();
  const flat = (text: string) => text.replace(/\s+/g, " ");
  assert.match(flat(await beat.innerText()), /started/);
  assert.doesNotMatch(flat(await beat.innerText()), /41k tokens/, "where it stands is the work list's, not the beat's");
  await shoot("transcript-subagents");

  await beat.click();
  const page = crew.window.locator("[data-agent-view]");
  await page.waitFor();
  assert.equal(await visible("[data-thread-header]").count(), 1, "one header in the pane");
  assert.equal(await page.locator("[data-composer]").count(), 0, "a native subagent takes no message");
  await crew.window.keyboard.press("Escape");
  await page.waitFor({ state: "detached" });
});

// Plan 2026-10-12 (decision 7): a session's x interrupts its turn and never
// ends it. It is the user's session; ending its process is the sidebar's job.
test("x on a session the chat launched interrupts its turn and leaves the session running", async () => {
  const interrupts = async () => (await readFile(path.join(crew.home, "fake-claude-control.log"), "utf8").catch(() => "")).split("\n").filter((line) => line.startsWith("interrupt")).length;
  await run(CREW, ["sessions", "start", "--provider", "claude", "--effort", "low", "--name", "refunds-api", "--", "work 60"], { env: await sessionEnv() });
  const launched = await waitFor(
    async () => (await sessions(crew, chat.workspaceId)).find((row) => row.launchedBy === chat.id && row.name === "refunds-api"),
    { timeout: 20_000, message: "the launched session reaches crewd" },
  );
  await waitFor(async () => (await crew.request<Session>("session_get", { id: launched.id })).status === "working", {
    timeout: 20_000,
    message: "its turn runs",
  });
  const before = await interrupts();

  await agentsSegment().click();
  const row = agentRow("refunds-api");
  await row.waitFor();
  await row.hover();
  await row.getByRole("button", { name: "Stop" }).click();

  await waitFor(async () => (await interrupts()) > before, { message: "the CLI was told to interrupt" });
  await waitFor(async () => (await crew.request<Session>("session_get", { id: launched.id })).status === "idle", {
    timeout: 20_000,
    message: "its turn ends",
  });
  const launch = (await crew.claudeLaunches()).find((one) => one.argv.includes(launched.id));
  assert.ok(launch, "the session's CLI started");
  assert.doesNotThrow(() => process.kill(launch.pid, 0), "the session's CLI is still alive");
  assert.notEqual((await crew.request<Session>("session_get", { id: launched.id })).status, "exited");
  // A session of the user's records no events: idle, it reads as done, not as still starting.
  await list().locator('[data-list-section="done"]').locator("[data-entry]").filter({ hasText: "refunds-api" }).waitFor();
  assert.equal(await row.getByRole("button", { name: "Stop" }).count(), 0);
  await crew.window.keyboard.press("Escape");
  await list().waitFor({ state: "hidden" });
});
