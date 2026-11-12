// Plan 2026-10-12 (decisions 19-24 and 15): how a session's orchestration reads
// in its transcript. The chat's CLI is the fake claude, which makes the Crew
// tool calls itself (`crew`): the calls and the answers Crew gives, with no
// session behind them, enough to draw the rows. A message that really reached
// a child (`crew send`, as the session) is named by `crewsent`, so its row can
// open that child's thread at the letter.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { Session } from "../src/lib/types.ts";
import { installFakeOpencode, launchCrew, newSession, sessions, waitFor, type Crew, composerOf, turnOver } from "./harness.ts";

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
  chat = await newSession(crew, workspace.id);
  await composer().waitFor();
});

after(async () => {
  await crew?.close();
});

const composer = () => composerOf(crew, chat);
// innerText puts a break after an inline-flex name; the window draws "billing-ui's" as one word.
const flat = (text: string) => text.replace(/\s+/g, " ").replace(/ 's\b/g, "'s").trim();

async function send(text: string): Promise<void> {
  await turnOver(crew);
  const field = composer();
  await field.fill(text);
  await waitFor(() => crew.window.getByRole("button", { name: "Send", exact: true }).isEnabled(), { message: "the composer can send" });
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

const row = (text: string | RegExp) => crew.window.locator("[data-block]").filter({ hasText: text }).last();

test("Crew calls draw as beats that say who and to whom, never the words: subagents, a report, sessions started, a message; control calls stay rows", async () => {
  await send("crew");
  await row("Listed 7 peers").waitFor({ timeout: 30_000 });
  await idle();

  // A subagent that answered: that it started, that it reported, and not what it said.
  const beats = () => crew.window.locator("[data-beat]");
  assert.equal(await crew.window.locator("[data-agent-start]").filter({ hasText: /scout|reviewer/ }).count(), 2, "the scout and the reviewer");
  const report = crew.window.locator("[data-report]");
  assert.equal(await report.count(), 1);
  assert.match(flat(await report.innerText()), /scout reported to/);
  assert.doesNotMatch(flat(await report.innerText()), /4 callers/, "no preview of the report");

  // Sessions started: a beat each, the one that failed saying why.
  assert.equal(await crew.window.locator("[data-agent-start]").filter({ hasText: /billing-ui|refunds-api/ }).count(), 2);
  const failed = beats().filter({ hasText: /could not start.*docs-sweep.*no free worktree name/ });
  assert.equal(await failed.count(), 1);
  await failed.scrollIntoViewIfNeeded();
  await shoot("transcript-start-sessions");

  // A message out: who, to whom and how it went over, and not what it said.
  const message = beats().filter({ hasText: /wrote to.*refunds-api/ }).last();
  assert.match(flat(await message.innerText()), /wrote to refunds-api · read mid-turn/);
  // A session is never drawn with the bot's face, even when the chat does not know which CLI it runs.
  assert.equal(await message.locator('[data-face="unknown"]').count(), 0);
  assert.equal(await crew.window.locator("[data-block]").getByRole("button").locator('[data-face="unknown"]').count(), 0);
  assert.equal(await crew.window.getByText("Decision: partial refunds keep the 90-day limit.").count(), 0, "no preview of the message");
  await message.getByRole("button").click();
  await crew.window.getByText("Decision: partial refunds keep the 90-day limit.").waitFor();
  await crew.window.keyboard.press("Escape");

  // The control rows: one line each.
  const text = flat(await crew.window.locator("[data-block]").allInnerTexts().then((all) => all.join(" | ")));
  for (const sentence of [
    "Interrupted billing-ui and redirected it",
    "Read billing-ui's last 12 messages",
    "Listed 7 peers · 3 sessions, 1 subagent, 3 bots",
    "Stopped docs-sweep and its 2 subagents",
    "Deleted docs-sweep · its worktree stays",
  ]) {
    assert.ok(text.includes(sentence), `${sentence}\n${text}`);
  }
  assert.equal(await crew.window.getByText("Stop the illustration work: copy only.").count(), 0, "no preview of the redirect");
  // The checkpoint row is gone: no "wrote to" arrows.
  assert.equal(await crew.window.getByLabel("to", { exact: true }).count(), 0);

  await row("Listed 7 peers").scrollIntoViewIfNeeded();
  await shoot("transcript-orchestrator");
});

/** What the chat's CLI was launched with: the socket and token it speaks to crewd as the session. */
async function sessionEnv(): Promise<NodeJS.ProcessEnv> {
  const launch = (await crew.claudeLaunches()).find((one) => one.argv.includes(chat.id));
  assert.ok(launch, "the chat's CLI started");
  const text =
    process.platform === "linux"
      ? (await readFile(`/proc/${launch.pid}/environ`, "utf8")).split("\0").join("\n")
      : (await run("ps", ["eww", "-o", "command=", "-p", String(launch.pid)])).stdout;
  const pick = (name: string) => new RegExp(`(?:^|\\s)${name}=(.+?)(?=\\s[A-Za-z_][A-Za-z0-9_]*=|$)`).exec(text)?.[1];
  const [socket, token] = [pick("CREW_SOCKET"), pick("CREW_TOKEN")];
  assert.ok(socket && token, "the CLI's environment names crewd");
  const { CREW_DATA_DIR: _dir, ...rest } = process.env;
  return { ...rest, HOME: crew.home, CREW_SOCKET: socket, CREW_TOKEN: token };
}

test("a message to a child opens its thread in the right panel at the letter, with no highlight", async () => {
  const env = await sessionEnv();
  await run(CREW, ["sessions", "delegate", "--provider", "opencode", "--effort", "none", "--name", "Lint pass", "--", "tidy the imports"], { env });
  const child = await waitFor(async () => (await sessions(crew, chat.workspaceId)).find((one) => one.parentId === chat.id), {
    timeout: 20_000,
    message: "the child reaches crewd",
  });
  await waitFor(async () => (await crew.request<Session>("session_get", { id: child.id })).lastEvent?.kind === "report", {
    timeout: 20_000,
    message: "the child reports",
  });
  await crew.window.locator("[data-report]").filter({ hasText: "Lint pass" }).first().waitFor({ timeout: 30_000 });
  await idle();
  const sent = await run(CREW, ["--json", "send", child.id, "Use the existing component"], { env });
  const letter = /"letter_id"\s*:\s*"([^"]+)"/.exec(sent.stdout)?.[1];
  assert.ok(letter, sent.stdout);

  // The child answers the letter and its report wakes the parent: let that turn end first.
  await waitFor(async () => (await crew.window.locator("[data-report]").filter({ hasText: "Lint pass" }).count()) >= 2, { timeout: 30_000, message: "the child's second report" });
  await new Promise((resolve) => setTimeout(resolve, 3_000));
  await idle();
  await send(`crewsent ${child.id} ${letter} Lint pass`);
  const message = crew.window.locator(`[data-beat][data-letter="${letter}"]`);
  await message.waitFor({ timeout: 30_000 });
  await idle();
  assert.match(flat(await message.innerText()), /wrote to Lint pass/);
  await message.getByRole("button").click();

  const page = crew.window.locator("[data-agent-view]");
  await page.waitFor();
  const arrived = page.locator(`[data-letter="${letter}"]`);
  await arrived.waitFor();
  assert.match(flat(await arrived.innerText()), /Use the existing component/);
  assert.doesNotMatch((await arrived.getAttribute("class")) ?? "", /crew-found/, "the panel opens there without a flash");
  assert.equal(await crew.window.locator(`[data-beat][data-letter="${letter}"] button`).evaluate((el) => el.className.includes("bg-card")), true, "the beat says it is open");
  await shoot("thread-at-letter");
  await crew.window.keyboard.press("Escape");
  await page.waitFor({ state: "detached" });
});

/** A subagent that stops to ask, started from the chat's session. */
async function askingChild(name: string, prompt: string) {
  const env = await sessionEnv();
  const known = new Set((await sessions(crew, chat.workspaceId)).map((one) => one.id));
  await run(CREW, ["sessions", "delegate", "--provider", "opencode", "--effort", "none", "--name", name, "--", prompt], { env });
  return waitFor(async () => (await sessions(crew, chat.workspaceId)).find((one) => one.parentId === chat.id && one.name === name && !known.has(one.id)), {
    timeout: 20_000,
    message: "the child reaches crewd",
  });
}

test("a child's question waits as a beat in the parent's chat and is answered in the child's thread", async () => {
  const child = await askingChild("refunds-api", "Check the refund limits ASKQUESTION");
  const letter = crew.window.locator("[data-beat]").filter({ hasText: /refunds-api.*asked/ }).last();
  await letter.waitFor({ timeout: 30_000 });
  await waitFor(async () => /waiting for an answer/.test(flat(await letter.innerText())), { message: "the beat says it waits" });
  assert.doesNotMatch(flat(await letter.innerText()), /Partial refunds over 90 days/, "no preview of the question");
  assert.equal((await crew.request<Session>("session_get", { id: child.id })).status, "needs-input");
  await letter.scrollIntoViewIfNeeded();
  await shoot("answer-from-parent");

  // Over the prompt, only now that it wants something; waved away, it stays gone until the next time.
  const notice = crew.window.locator("[data-notice]");
  await notice.waitFor();
  assert.match(flat(await notice.innerText()), /refunds-api.*Answer/);
  await notice.getByRole("button", { name: "Dismiss" }).click();
  await notice.waitFor({ state: "detached" });
  assert.match(flat(await letter.innerText()), /waiting for an answer/, "the beat still says so");

  await letter.getByRole("button").click();
  const thread = crew.window.locator("[data-agent-view]");
  await thread.waitFor();
  await thread.getByText("Keep the 90-day limit", { exact: true }).click();
  await thread.getByRole("button", { name: /^Send/ }).click();
  await crew.window.getByText(/Done: Check the refund limits ASKQUESTION \[answers: .*keep/).first().waitFor({ timeout: 30_000 });
  await waitFor(async () => (await crew.request<Session>("session_get", { id: child.id })).status !== "needs-input", { message: "the child's turn goes on" });
  await shoot("answer-from-parent-answered");
  await crew.window.keyboard.press("Escape");
  await thread.waitFor({ state: "detached" });
  await waitFor(async () => !/waiting for an answer/.test(flat(await letter.innerText())), { message: "the beat stops waiting" });
  await idle();
});

test("a child's approval waits as a beat in the parent's chat and is decided in the child's thread", async () => {
  // Only a parent that runs with full autonomy gets the approval as a letter.
  const now = await crew.request<Session>("session_get", { id: chat.id });
  await crew.request("session_update", {
    id: chat.id,
    name: now.name,
    provider: now.provider,
    model: now.model ?? "",
    description: now.description ?? "",
    notifications: now.notifications,
    autonomy: "full",
  });
  await idle();
  const child = await askingChild("billing-ui", "Run the billing fixtures ASKAPPROVAL");
  const letter = crew.window.locator("[data-beat]").filter({ hasText: /billing-ui.*asked/ }).last();
  await letter.waitFor({ timeout: 30_000 });
  await waitFor(async () => /waiting for an answer/.test(flat(await letter.innerText())), { message: "the beat says it waits" });
  assert.equal((await crew.request<Session>("session_get", { id: child.id })).status, "needs-input");
  await letter.scrollIntoViewIfNeeded();
  await shoot("answer-from-parent-approval");

  // The notice opens the agent that wants something, and goes while it is open.
  const notice = crew.window.locator("[data-notice]");
  await notice.waitFor();
  assert.match(flat(await notice.innerText()), /billing-ui.*Review/);
  await notice.locator("[data-agent-notice]").click();
  const thread = crew.window.locator("[data-agent-view]");
  await thread.waitFor();
  await notice.waitFor({ state: "detached" });
  const allow = thread.getByRole("button", { name: /^Allow/ }).first();
  await allow.waitFor();
  await allow.click();
  await crew.window.getByText(/Done: Run the billing fixtures ASKAPPROVAL \[decision: once\]/).first().waitFor({ timeout: 30_000 });
  await shoot("answer-from-parent-approval-decided");
  await crew.window.keyboard.press("Escape");
  await thread.waitFor({ state: "detached" });
  await idle();
});

test("A background subagent that finishes is said once, by its call's beat: what it woke takes no line of its own, and ends the turn that sent it", async () => {
  const footers = () => crew.window.locator("[data-turn-footer]").count();
  const before = await footers();
  await send("agentdone");
  await crew.window.getByText("Report read.", { exact: true }).waitFor({ timeout: 30_000 });
  await idle();
  assert.equal(await footers(), before + 1, "one line (copy, the time) for the turn and the one its report woke");
  assert.equal(await crew.window.getByText(/Reply \d+: agentdone/).count(), 1, "the reply between stays in sight");
  const beat = crew.window.locator("[data-beat]").filter({ hasText: /Explore the repo.*finished/ });
  assert.equal(await beat.count(), 1, "the call's beat says it finished");
  assert.equal(await crew.window.getByText(/Agent "Explore the repo" finished/).count(), 0, "no line beside the beat");
  await beat.scrollIntoViewIfNeeded();
  await shoot("transcript-subagent-finished");
});
