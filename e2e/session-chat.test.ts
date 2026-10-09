// Sessions in Crew's chat. Settings › Appearance › "Sessions open in" is the
// view a new session is created with, for good: Chat has Crew drive the
// session's CLI over the provider's protocol (the fake claude speaks
// stream-json when launched with `--input-format stream-json`), one process
// for every turn, and draws the conversation in its own transcript with no
// terminal; Terminal runs the CLI on its own screen. Flipping the setting
// never moves a session that exists.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { after, before, test } from "node:test";
import type { Session, Workspace } from "../src/lib/types.ts";
import { launchCrew, MOD, newTerminal, pressChord, sessionTab, sessions, waitFor, type Crew } from "./harness.ts";

let crew: Crew;

before(async () => {
  crew = await launchCrew();
  // Only the fake claude is installed, but the default must not depend on it.
  await crew.request("state_set", {
    key: "providers:default",
    value: JSON.stringify({ provider: "claude", model: "", effort: "", access: "ask" }),
  });
  await crew.reload();
});

after(async () => {
  await crew?.close();
});

/** Settings › Appearance › Sessions open in, and back out of Settings. */
async function openSessionsIn(view: "Terminal" | "Chat"): Promise<void> {
  const page = crew.window;
  await pressChord(crew, `${MOD}+,`);
  await page.getByRole("button", { name: "Appearance", exact: true }).click();
  await page.getByRole("combobox", { name: "Sessions open in" }).click();
  await page.getByRole("option", { name: view, exact: true }).click();
  await waitFor(async () => (await crew.request<string | null>("state_get", { key: "sessions:view" })) === view.toLowerCase(), {
    message: `crewd keeps "${view}"`,
  });
  await pressChord(crew, `${MOD}+,`);
}

/** ⌘N with sessions opening in the chat: the session crewd made, once its chat is on screen. */
async function newChat(workspaceId: string): Promise<Session> {
  const known = new Set((await sessions(crew, workspaceId)).map((row) => row.id));
  await pressChord(crew, `${MOD}+n`);
  const session = await waitFor(
    async () => (await sessions(crew, workspaceId)).find((row) => row.kind === "terminal" && !known.has(row.id)),
    { message: "the new session reaches crewd" },
  );
  await composer(session).waitFor();
  return session;
}

/**
 * The message box of the chat on screen, or of `session`'s, which is the one
 * once its tab is. A terminal's own input is an xterm's. Tabs that are not on
 * screen stay mounted, hidden.
 */
function composer(session?: Session) {
  const named = session ? `[placeholder*="Ask ${session.name} anything"]` : "";
  return crew.window.locator(`textarea:not(.xterm-helper-textarea)${named}:visible`);
}

/** The terminals on screen. */
function terminals() {
  return crew.window.locator(".xterm:visible");
}

/** A line of the chat on screen, by the whole of its text. */
function said(text: string | RegExp) {
  return crew.window.getByText(text, typeof text === "string" ? { exact: true } : {});
}

/** Types `text` in the chat on screen and sends it. */
async function send(text: string): Promise<void> {
  const field = composer();
  await field.fill(text);
  await waitFor(() => crew.window.getByRole("button", { name: "Send" }).isEnabled(), { message: "the composer can send" });
  await field.press("Enter");
}

/** Every launch of the fake claude for `session`, oldest first. */
async function launchesOf(session: Session) {
  return (await crew.claudeLaunches()).filter((launch) => launch.argv.includes(session.id));
}

/** The control requests the fake claude took over the protocol, as `<subtype> <detail>`. */
async function controls(): Promise<string[]> {
  const log = await readFile(path.join(crew.home, "fake-claude-control.log"), "utf8").catch(() => "");
  return log.split("\n").filter(Boolean);
}

/** What the fake claude has taken in as a user's message in `session`'s conversation, from the transcript it keeps. */
async function heard(cwd: string, session: Session): Promise<string[]> {
  const file = path.join(crew.home, ".claude/projects", cwd.replace(/[^a-zA-Z0-9]/g, "-"), `${session.id}.jsonl`);
  const text = await readFile(file, "utf8").catch(() => "");
  return text
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { type?: string; message?: { content?: unknown } })
    .flatMap((record) => (record.type === "user" && typeof record.message?.content === "string" ? [record.message.content] : []));
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** The context meter under the composer: its ring's percentage and its card's text. */
function meter() {
  return crew.window.locator("span.group:visible").filter({ hasText: "Context window" });
}

test("a new Claude session in the chat view opens the chat with no terminal, and its reply streams in", async () => {
  const [workspace] = crew.workspaces;
  assert.ok(workspace);
  await openSessionsIn("Chat");
  const session = await newChat(workspace.id);
  assert.equal(session.view, "chat");
  assert.equal(await crew.window.locator(".xterm").count(), 0, "a terminal is mounted");
  // Crew starts the CLI for the first turn, not before: nothing runs on open.
  assert.equal((await launchesOf(session)).length, 0, "the CLI started before anyone spoke");

  await send("stream one two three four five");
  await said("stream one two three four five").waitFor();
  // The reply comes a word at a time: part of it is drawn while the turn runs.
  const partial = await waitFor(
    async () => {
      const text = await crew.window.getByText(/^Reply 1: stream/).first().textContent({ timeout: 500 });
      return text && !text.includes("five") ? text : null;
    },
    { message: "part of the reply is drawn while the turn runs", interval: 25 },
  );
  assert.match(partial, /^Reply 1: stream/);
  await crew.window.getByRole("button", { name: "Stop" }).waitFor();
  await said("Reply 1: stream one two three four five").waitFor();
  await crew.window.getByRole("button", { name: "Stop" }).waitFor({ state: "detached" });

  const [launch, ...more] = await launchesOf(session);
  assert.ok(launch);
  assert.equal(more.length, 0);
  assert.ok(launch.argv.join(" ").includes("--input-format stream-json"), launch.argv.join(" "));
  assert.equal(launch.argv.includes("--"), false, "the message goes in over stdin, not on the command line");
  await waitFor(async () => (await crew.request<Session>("session_get", { id: session.id })).status !== "working", {
    message: "the turn is over",
  });
});

test("a second message runs on the same process, and the context meter follows the turns", async () => {
  const [workspace] = crew.workspaces;
  assert.ok(workspace);
  await crew.request("state_set", { key: "sessions:view", value: "chat" });
  await crew.reload();
  const session = await newChat(workspace.id);
  // No reading before the CLI has had a turn.
  assert.equal(await meter().count(), 0);

  await send("first question");
  await said("Reply 1: first question").waitFor();
  // The meter appears under the composer: 20k of the fake's 200k window.
  await waitFor(async () => /10%/.test((await meter().first().textContent({ timeout: 500 })) ?? ""), {
    message: "the meter reads 10% after the first turn",
  });
  assert.match((await meter().first().textContent()) ?? "", /20k\s*of 200k/);

  await send("second question");
  // Turn 2 of one process: a new process would say 1 again.
  await said("Reply 2: second question").waitFor();
  await waitFor(async () => /20%/.test((await meter().first().textContent({ timeout: 500 })) ?? ""), {
    message: "the meter reads 20% after the second turn",
  });

  const launches = await launchesOf(session);
  assert.equal(launches.length, 1, "each message started the CLI again");
  assert.ok(alive(launches[0]!.pid), "the CLI that started first is still the one running");
});

test("the access and effort chips reach the running CLI as control requests, with no restart", async () => {
  const [workspace] = crew.workspaces;
  assert.ok(workspace);
  await crew.request("state_set", { key: "sessions:view", value: "chat" });
  await crew.reload();
  const session = await newChat(workspace.id);
  await send("asking first");
  await said("Reply 1: asking first").waitFor();
  const before = await controls();
  assert.equal(before.some((line) => line.startsWith("set_permission_mode")), false);

  // ⇧Tab in the composer moves the chip, and the next turn tells the CLI.
  const chat = composer();
  await chat.press("Shift+Tab");
  await crew.window.getByRole("button", { name: "Access" }).getByText("Accept edits").waitFor();
  await waitFor(async () => (await crew.request<Session>("session_get", { id: session.id })).autonomy === "edits", {
    message: "the row keeps the access",
  });
  await crew.window.getByRole("button", { name: "Effort" }).click();
  await crew.window.getByRole("menuitemradio", { name: "Low", exact: true }).click();
  await send("editing now");
  await said("Reply 2: editing now").waitFor();
  const told = await controls();
  assert.ok(told.includes("set_permission_mode acceptEdits"), told.join("\n"));
  assert.ok(told.includes('apply_flag_settings {"effortLevel":"low"}'), told.join("\n"));
  assert.equal((await launchesOf(session)).length, 1, "the new settings restarted the CLI");
});

test("Esc stops a running turn in the chat, and the next message gets its answer", async () => {
  const [workspace] = crew.workspaces;
  assert.ok(workspace);
  await crew.request("state_set", { key: "sessions:view", value: "chat" });
  await crew.reload();
  const session = await newChat(workspace.id);

  await send("work 30");
  const stop = crew.window.getByRole("button", { name: "Stop" });
  await stop.waitFor();
  // Esc before the CLI has the message would cancel the launch instead of interrupting a turn.
  await waitFor(async () => (await heard(workspace.path, session)).includes("work 30"), {
    message: "the CLI took the message in",
  });
  await composer().press("Escape");
  await stop.waitFor({ state: "detached" });
  await waitFor(async () => (await controls()).includes("interrupt "), { message: "the CLI was told to interrupt" });
  await waitFor(async () => (await crew.request<Session>("session_get", { id: session.id })).status === "idle", {
    message: "the session is idle again",
  });
  assert.equal(await said(/^Reply \d+: work 30$/).count(), 0, "the stopped turn answered anyway");

  // The conversation goes on from where it stopped.
  await send("after the stop");
  await said(/^Reply \d+: after the stop$/).waitFor();
});

test("a new session in the terminal view opens the terminal, and the chat is not there", async () => {
  const [workspace] = crew.workspaces;
  assert.ok(workspace);
  await openSessionsIn("Terminal");
  const session = await newTerminal(crew, workspace.id);
  assert.equal(session.view, "terminal");
  await terminals().first().waitFor();
  assert.equal(await composer().count(), 0, "the chat's composer is on screen");
  assert.equal(await crew.window.getByRole("button", { name: "Stop" }).count(), 0);
  // The CLI is the PTY's: the fake claude's terminal UI, not the protocol.
  const launch = (await launchesOf(session)).at(-1);
  assert.ok(launch);
  assert.equal(launch.argv.includes("--input-format"), false, launch.argv.join(" "));
});

test("a session keeps the view it was created with when the setting changes", async () => {
  const [workspace] = crew.workspaces;
  assert.ok(workspace);
  await openSessionsIn("Chat");
  const chat = await newChat(workspace.id);
  await send("which view am I");
  await said("Reply 1: which view am I").waitFor();
  const started = (await launchesOf(chat))[0];
  assert.ok(started);

  await openSessionsIn("Terminal");
  const terminal = await newTerminal(crew, workspace.id);
  await terminals().first().waitFor();
  assert.equal(terminal.view, "terminal");

  await openSessionsIn("Chat");
  // Back on the terminal's tab: it is still the CLI's screen.
  await sessionTab(crew, terminal).click();
  await terminals().first().waitFor();
  assert.equal(await composer().count(), 0, "the terminal session grew a chat");
  // And on the chat's: still the conversation, on the process it started with.
  await sessionTab(crew, chat).click();
  await said("Reply 1: which view am I").waitFor();
  assert.equal(await terminals().count(), 0, "the chat session grew a terminal");

  // The rows say so after a reload too, and no flip launched anything again.
  await crew.reload();
  assert.equal((await crew.request<Session>("session_get", { id: chat.id })).view, "chat");
  assert.equal((await crew.request<Session>("session_get", { id: terminal.id })).view, "terminal");
  await sessionTab(crew, chat).click();
  await said("Reply 1: which view am I").waitFor();
  assert.equal((await launchesOf(chat)).length, 1);
  assert.ok(alive(started.pid), "the chat's CLI is still the one that started first");
});

test("the first prompt from home is the chat session's first turn", async () => {
  await crew.request("state_set", { key: "sessions:view", value: "chat" });
  await crew.reload();
  await crew.window.keyboard.press(`${MOD}+Shift+H`);
  const home = await waitFor(async () => (await crew.request<Workspace[]>("workspace_list")).find((row) => row.home), {
    message: "home exists",
  });
  const field = crew.window.getByRole("textbox", { name: "Ask anything" });
  await field.fill("say hi from home");
  await field.press("Enter");

  const session = await waitFor(async () => (await sessions(crew, home.id)).find((row) => row.kind === "terminal"), {
    message: "home's session reaches crewd",
  });
  assert.equal(session.view, "chat");
  await said("say hi from home").waitFor();
  await said("Reply 1: say hi from home").waitFor();
  assert.equal(await terminals().count(), 0, "a terminal is on screen");
  const [launch] = await launchesOf(session);
  assert.ok(launch);
  assert.equal(launch.cwd, home.path);
  assert.ok(launch.argv.join(" ").includes("--input-format stream-json"), launch.argv.join(" "));
  assert.equal(launch.argv.includes("--"), false, "the prompt is a turn over stdin, not the command line's");
});
