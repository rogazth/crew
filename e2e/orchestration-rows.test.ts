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
import { installFakeOpencode, launchCrew, newSession, sessions, waitFor, type Crew } from "./harness.ts";

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
  chat = await newSession(crew, workspace.id);
  await composer().waitFor();
});

after(async () => {
  await crew?.close();
});

const composer = () => crew.window.locator("textarea:not(.xterm-helper-textarea):visible").first();
// innerText puts a break after an inline-flex name; the window draws "billing-ui's" as one word.
const flat = (text: string) => text.replace(/\s+/g, " ").replace(/ 's\b/g, "'s").trim();

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

const row = (text: string | RegExp) => crew.window.locator("[data-block]").filter({ hasText: text }).last();

test("Crew calls draw as rows and cards: subagents, a report, sessions started, a message and the control rows", async () => {
  await send("crew");
  await row("Listed 7 peers").waitFor({ timeout: 30_000 });
  await idle();

  // A subagent that answered: its row, its card, and its report under it.
  const calls = crew.window.getByText(/^Started a subagent/);
  assert.equal(await calls.count(), 2, "the scout and the reviewer");
  const report = crew.window.locator("[data-report]");
  assert.equal(await report.count(), 1);
  assert.match(flat(await report.innerText()), /Report from scout.*4 callers/);

  // Sessions started: one card, a line each, the one that failed in danger ink.
  const started = crew.window.getByText("Started 2 sessions, 1 failed");
  await started.waitFor();
  const lines = crew.window.locator("[data-agent-card]").filter({ hasText: /billing-ui|refunds-api/ });
  assert.equal(await lines.count(), 2);
  const failed = crew.window.getByText(/docs-sweep · no free worktree name/);
  assert.equal(await failed.count(), 1);
  await started.scrollIntoViewIfNeeded();
  await shoot("transcript-start-sessions");

  // A message out: the text in a card, how it was delivered on the row.
  const message = row(/Message to refunds-api/);
  assert.match(flat(await message.innerText()), /Message to refunds-api · read mid-turn/);
  // A session is never drawn with the bot's face, even when the chat does not know which CLI it runs.
  assert.equal(await message.locator("svg.lucide-bot").count(), 0);
  assert.equal(await crew.window.locator("[data-block] button svg.lucide-bot").count(), 0);
  assert.match(flat(await crew.window.getByText("Decision: partial refunds keep the 90-day limit.").innerText()), /90-day limit/);

  // The control rows: one line each, a card only for the redirect.
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
  assert.ok(flat(await crew.window.locator("main, body").first().innerText()).includes("Stop the illustration work: copy only."), "the redirect is in a card");
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

test("a message to a child opens its thread at the letter, lit", async () => {
  const env = await sessionEnv();
  await run(CREW, ["sessions", "delegate", "--provider", "opencode", "--name", "Lint pass", "--", "tidy the imports"], { env });
  const child = await waitFor(async () => (await sessions(crew, chat.workspaceId)).find((one) => one.parentId === chat.id), {
    timeout: 20_000,
    message: "the child reaches crewd",
  });
  await waitFor(async () => (await crew.request<Session>("session_get", { id: child.id })).lastEvent?.kind === "report", {
    timeout: 20_000,
    message: "the child reports",
  });
  await crew.window.getByText("Done: tidy the imports", { exact: true }).waitFor({ timeout: 30_000 });
  await idle();
  const sent = await run(CREW, ["--json", "send", child.id, "Use the existing component"], { env });
  const letter = /"letter_id"\s*:\s*"([^"]+)"/.exec(sent.stdout)?.[1];
  assert.ok(letter, sent.stdout);

  // The child answers the letter and its report wakes the parent: let that turn end first.
  await crew.window.getByText("Done: Use the existing component", { exact: true }).first().waitFor({ timeout: 30_000 });
  await new Promise((resolve) => setTimeout(resolve, 3_000));
  await idle();
  await send(`crewsent ${child.id} ${letter} Lint pass`);
  const message = crew.window.locator(`[data-letter="${letter}"]`).filter({ hasText: /Message to/ });
  await message.waitFor({ timeout: 30_000 });
  await idle();
  await message.getByRole("button", { name: "Lint pass" }).click();

  const page = crew.window.locator("[data-agent-view]");
  await page.waitFor();
  const arrived = page.locator(`[data-letter="${letter}"]`);
  await arrived.waitFor();
  assert.match(flat(await arrived.innerText()), /Use the existing component/);
  await waitFor(async () => ((await arrived.getAttribute("class")) ?? "").includes("crew-found"), { timeout: 3_000, message: "the letter is lit" });
  await shoot("thread-at-letter");
  await crew.window.keyboard.press("Escape");
  await page.waitFor({ state: "detached" });
});

/** A subagent that stops to ask, started from the chat's session. */
async function askingChild(name: string, prompt: string) {
  const env = await sessionEnv();
  const known = new Set((await sessions(crew, chat.workspaceId)).map((one) => one.id));
  await run(CREW, ["sessions", "delegate", "--provider", "opencode", "--name", name, "--", prompt], { env });
  return waitFor(async () => (await sessions(crew, chat.workspaceId)).find((one) => one.parentId === chat.id && one.name === name && !known.has(one.id)), {
    timeout: 20_000,
    message: "the child reaches crewd",
  });
}

test("a child's question is answered from the parent's chat: options on the letter, the first answer counts", async () => {
  const child = await askingChild("refunds-api", "Check the refund limits ASKQUESTION");
  const letter = crew.window.locator("[data-letter]").filter({ hasText: /Partial refunds over 90 days/ });
  await letter.waitFor({ timeout: 30_000 });
  assert.match(flat(await letter.innerText()), /refunds-api asks waits on an answer/);
  const keep = letter.getByRole("button", { name: "Keep the 90-day limit" });
  await keep.waitFor();
  assert.match(flat(await letter.innerText()), /You or .* can answer/);
  assert.doesNotMatch(flat(await letter.innerText()), /Options:/, "the options are said once, as buttons");
  assert.equal((await crew.request<Session>("session_get", { id: child.id })).status, "needs-input");
  await letter.scrollIntoViewIfNeeded();
  await shoot("answer-from-parent");

  await keep.click();
  await waitFor(async () => /Answered by you · the first answer counts/.test(flat(await letter.innerText())), { message: "the chips say who answered" });
  assert.equal(await keep.isDisabled(), true);
  assert.equal(await letter.getByRole("button", { name: "Allow them" }).isDisabled(), true);
  assert.equal(await letter.getByText(/waits on an answer/).count(), 0, "the tag is gone once it is answered");
  await crew.window.getByText(/Done: Check the refund limits ASKQUESTION \[answers: .*keep/).first().waitFor({ timeout: 30_000 });
  await waitFor(async () => (await crew.request<Session>("session_get", { id: child.id })).status !== "needs-input", { message: "the child's turn goes on" });
  await shoot("answer-from-parent-answered");
  await idle();
});

test("a child's approval is decided from the parent's chat when the parent could do it itself", async () => {
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
  const letter = crew.window.locator("[data-letter]").filter({ hasText: /wants to use/i });
  await letter.waitFor({ timeout: 30_000 });
  assert.match(flat(await letter.innerText()), /billing-ui asks waits on an answer/);
  const allow = letter.getByRole("button", { name: /^Allow/ });
  await allow.waitFor();
  assert.equal((await crew.request<Session>("session_get", { id: child.id })).status, "needs-input");
  await letter.scrollIntoViewIfNeeded();
  await shoot("answer-from-parent-approval");

  await allow.click();
  await waitFor(async () => /Allowed by you · the first answer counts/.test(flat(await letter.innerText())), { message: "the card says who decided" });
  await crew.window.getByText(/Done: Run the billing fixtures ASKAPPROVAL \[decision: once\]/).first().waitFor({ timeout: 30_000 });
  await shoot("answer-from-parent-approval-decided");
  await idle();
});
