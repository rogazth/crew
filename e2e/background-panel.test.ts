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
import { installFakeOpencode, launchCrew, newSession, sessions, waitFor, type Crew, composerOf } from "./harness.ts";

const run = promisify(execFile);
const CREW = path.join(fileURLToPath(new URL("..", import.meta.url)), "target/debug/crew");

let crew: Crew;
let chat: Session;

before(async () => {
  crew = await launchCrew();
  const [workspace] = crew.workspaces;
  assert.ok(workspace);
  await crew.request("state_set", {
    key: "providers:default",
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

const composer = () => composerOf(crew);
const said = (text: string | RegExp) => crew.window.getByText(text, typeof text === "string" ? { exact: true } : {});
/** The panes, without the sidebar: its rows carry session ids and names too. */
const inChat = () => crew.window.locator('[data-sheet="workspace"]');
const sheet = () => crew.window.locator("[data-work-sheet]");
/** The agents clip over the composer: it opens the sheet while an agent is listed. */
const clip = () => crew.window.locator("[data-agent-clip]");
/** The status line's work segment: it opens the sheet when there is no agent to put the clip up. */
const workTrigger = () => crew.window.locator("[data-work-trigger]");
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

  // A child that reported counts as finished; the command is still up.
  const work = clip();
  await work.waitFor();
  await work.click();
  await sheet().waitFor();
  const texts = await rows().allTextContents();
  assert.equal(texts.length, 2, texts.join("\n"));
  // The agents lead the sheet (the clip that opens it is about them); the rest of the work follows.
  assert.match(texts[0]!, /Lint pass.*Subagent · .+ · done after/, "agents lead");
  assert.match(texts[1]!, /web.*Process · \d+s/, "then the rest of the work");
  assert.equal(await sheet().getByRole("button", { name: "Clear finished" }).count(), 1);
  await rows().nth(0).waitFor();
  assert.equal(await rows().nth(0).getAttribute("aria-selected"), "true");
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

  await clip().click();
  await sheet().waitFor();
  await crew.window.keyboard.press("Escape");
  await sheet().waitFor({ state: "hidden" });
  assert.equal(await stop.isVisible(), true, "the turn was stopped by the Esc that closed the sheet");
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

test("↵ opens a Crew subagent as one thread over the chat, with its own composer and meter, and Esc goes back", async () => {
  const { 0: child } = (await sessions(crew, chat.workspaceId)).filter((row) => row.parentId === chat.id);
  assert.ok(child);
  // What the reader had typed in the parent comes back untouched.
  await composer().fill("half a thought");
  await clip().click();
  await sheet().waitFor();
  // The agents lead the list, so the child is the row the sheet opens on.
  await waitFor(async () => (await rows().nth(0).getAttribute("aria-selected")) === "true", { message: "the first row is selected" });
  await rows().nth(0).filter({ hasText: "Lint pass" }).waitFor();
  await crew.window.keyboard.press("Enter");
  await sheet().waitFor({ state: "hidden" });

  const page = crew.window.locator("[data-agent-view]");
  await page.waitFor();
  await page.getByText("Done: tidy the imports").waitFor();
  await composerOf(crew, child).waitFor();

  // One header, a breadcrumb: where it is, once.
  assert.equal(await visible("[data-thread-header]").count(), 1, "exactly one header is on screen");
  const header = await page.locator("[data-thread-header]").innerText();
  assert.match(header, /Lint pass/, header);
  assert.doesNotMatch(header, new RegExp(chat.name), "the pill names only this session");
  assert.equal(await page.locator("[data-thread-header]").getByRole("button", { name: "Close" }).count(), 1, "a round close button");
  assert.doesNotMatch(header, /esc/i, "no key hint in the header");
  assert.match((await page.locator("[data-thread-header] [title]").first().getAttribute("title")) ?? "", /Subagent .*reports to /s);
  assert.doesNotMatch(header + (await page.innerText()), /Back to the chat|Started by/);
  assert.equal(await visible("text=Conversations").count(), 0, "no parent bar over the thread");

  // The status line under the composer is the child's: never the parent's.
  const line = visible("[data-status-line]");
  assert.equal(await line.count(), 1, "one status line on screen");
  assert.equal(await line.getAttribute("data-session"), child.id);
  assert.equal(await visible(`[data-sheet="workspace"] [data-session="${chat.id}"]`).count(), 0, "nothing of the parent's meter or line shows");
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
  await page.waitFor({ state: "detached" });
  assert.equal(await composer().innerText(), "half a thought", "the parent's draft is intact");
  await composer().fill("");
});

test("x stops a command, and opening a command opens its tab", async () => {
  const [workspace] = crew.workspaces;
  assert.ok(workspace);
  await clip().click();
  await sheet().waitFor();
  // The agents lead, so the running command is the second row; x stops it.
  await crew.window.keyboard.press("ArrowDown");
  await waitFor(async () => (await rows().nth(1).getAttribute("aria-selected")) === "true", { message: "↓ selects the command" });
  await crew.window.keyboard.press("x");
  await waitFor(async () => (await processes(workspace.id))[0]?.runs.find((one) => one.worktree === null)?.state === "stopped", {
    message: "crewd stops the run",
  });
  const finished = clip();
  await rows().filter({ hasText: "Process · stopped" }).waitFor();

  // Enter on it leaves the chat for the command's own tab and closes the sheet.
  await crew.window.keyboard.press("Enter");
  await sheet().waitFor({ state: "hidden" });
  await crew.window.locator('[data-tab-strip] [role="tab"]').filter({ hasText: "web" }).waitFor();
  await crew.window.locator('[data-tab-strip] [role="tab"]').filter({ hasText: chat.name }).click();
  await finished.waitFor();
});

test("Clear finished empties the panel, and the line goes with it", async () => {
  await clip().click();
  await sheet().getByRole("button", { name: "Clear finished" }).click();
  await sheet().waitFor({ state: "hidden" });
  await inChat().getByRole("button", { name: /finished$|process|agent|shell/ }).waitFor({ state: "detached" });
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
  assert.equal(await inChat().getByRole("button", { name: line }).count(), 0, "the cleared entries came back");

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
  await inChat().getByRole("button", { name: line }).waitFor({ state: "detached" });
});

test("a subagent the chat's CLI runs shows its tokens and its step, and x stops it through the CLI", async () => {
  const controls = async () => (await readFile(path.join(crew.home, "fake-claude-control.log"), "utf8").catch(() => "")).split("\n");
  await send("agent");
  await said(/^Reply \d+: agent$/).waitFor();
  await waitFor(async () => (await crew.request<Session>("session_get", { id: chat.id })).status === "idle", { message: "the turn is over" });

  // The turn is over and the subagent is not: it is the line under the composer.
  const line = inChat().getByRole("button", { name: /^1 agent/ });
  await line.waitFor();
  await line.click();
  await sheet().waitFor();
  const row = rows().nth(0);
  await row.waitFor();
  const text = await row.textContent();
  assert.match(text ?? "", /Explore the repo.*Subagent · Opus 5\.5 · \d+s · 41k tokens · Reading README\.md/, text ?? "");
  assert.equal(await row.getByRole("button", { name: "Stop" }).count(), 1, "a subagent can be stopped alone");

  await crew.window.keyboard.press("x");
  await rows().filter({ hasText: "Subagent · Opus 5.5 · stopped" }).waitFor();
  assert.ok((await controls()).includes("stop_task ag1"), (await controls()).join("\n"));
  const board = await crew.request<{ commands: { id: string; state: string; tokens?: number }[] }>("background_list", { sessionId: chat.id });
  assert.deepEqual([board.commands[0]?.id, board.commands[0]?.state, board.commands[0]?.tokens], ["ag1", "stopped", 41_300]);
  await crew.window.keyboard.press("Escape");
  await sheet().waitFor({ state: "hidden" });
});

test("the sheet lists a native subagent, a Crew subagent, a session and a shell as one work list", async () => {
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

  // The agents clip opens the sheet (it names the agents, not the shell); without agents the status line's segment does.
  const work = clip();
  await work.waitFor();
  await work.click();
  await sheet().waitFor();
  await waitFor(async () => (await rows().count()) >= 3, { message: "three entries are listed" });
  const texts = (await rows().allTextContents()).join("\n");
  assert.match(texts, /Explore the repo.*Subagent · Opus 5\.5 · stopped/, texts);
  assert.match(texts, /billing-ui.*Session ·/, texts);
  assert.match(texts, /Shell.*Shell · \d+s/, texts);
  if (process.env.E2E_SHOTS) await crew.window.screenshot({ path: path.join(process.env.E2E_SHOTS, "work-sheet.png") });
});

/** The sheet is open already when the test before left it so. */
async function openWorkSheet(): Promise<void> {
  if (!(await sheet().isVisible())) await inChat().getByRole("button", { name: /finished$|agent|session|shell|process/ }).click();
  await sheet().waitFor();
}

test("a native subagent opens with no composer and a read-only footer, and x stops it", async () => {
  const controls = async () => (await readFile(path.join(crew.home, "fake-claude-control.log"), "utf8").catch(() => "")).split("\n");
  // It runs a third: the first was stopped, the second still runs, and the newest is listed first.
  await send("agent");
  await waitFor(async () => (await crew.request<Session>("session_get", { id: chat.id })).status === "idle", { message: "the turn is over" });
  await openWorkSheet();
  await rows().filter({ hasText: /Explore the repo.*Subagent · Opus 5\.5 · \d+s/ }).first().click();
  await sheet().waitFor({ state: "hidden" });

  const page = crew.window.locator("[data-agent-view]");
  await page.waitFor();
  assert.equal(await page.locator("[data-composer]").count(), 0, "a native subagent takes no message");
  assert.equal(await visible("[data-status-line]").count(), 0, "no composer, so no status line of any chat");
  const footer = page.locator("[data-thread-footer]");
  assert.match(await footer.innerText(), new RegExp(`Read only · its report goes to ${chat.name}.*esc back.*x stop`, "s"));
  assert.equal(await visible("[data-thread-header]").count(), 1);
  await shoot("thread-native");

  await crew.window.keyboard.press("x");
  await page.getByText("Stopped", { exact: true }).waitFor();
  assert.ok((await controls()).includes("stop_task ag3"), (await controls()).join("\n"));
  await crew.window.keyboard.press("Escape");
  await page.waitFor({ state: "detached" });
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

test("a native subagent's call is one row and one card with the sheet's state, and the card opens its thread in place", async () => {
  await send("agent");
  await waitFor(async () => (await crew.request<Session>("session_get", { id: chat.id })).status === "idle", { message: "the turn is over" });
  const calls = crew.window.getByText(/^Started a subagent/);
  const cards = crew.window.locator("[data-agent-card]");
  await cards.last().waitFor();
  assert.equal(await calls.count(), await cards.count(), "every call is one row and one card");
  const card = cards.last();
  const flat = (text: string) => text.replace(/\s+/g, " ");
  await shoot("transcript-subagents");

  // The sheet says the same of the same agent.
  await openWorkSheet();
  // The sheet lists the newest subagent first: the one the card is.
  const listed = flat((await rows().allInnerTexts()).find((text) => text.includes("Subagent ·")) ?? "");
  const state = /Subagent · (?:[^·]+ · )?(stopped|done|failed)/.exec(listed)?.[1] ?? "running";
  assert.match(flat(await card.innerText()), /Look around.*41k tokens/);
  assert.ok(flat(await card.innerText()).includes(state === "running" ? "Reading README.md" : state), `${await card.innerText()} vs ${listed}`);
  await crew.window.keyboard.press("Escape");
  await sheet().waitFor({ state: "hidden" });

  await card.click();
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
  if (await sheet().isVisible()) {
    await crew.window.keyboard.press("Escape");
    await sheet().waitFor({ state: "hidden" });
  }
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

  await openWorkSheet();
  const row = rows().filter({ hasText: "refunds-api" });
  await row.waitFor();
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
  await crew.window.keyboard.press("Escape");
  await sheet().waitFor({ state: "hidden" });
});
