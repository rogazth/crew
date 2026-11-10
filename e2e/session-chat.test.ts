// Sessions in Crew's chat: Crew drives the session's CLI over the provider's
// protocol (the fake claude speaks stream-json when launched with
// `--input-format stream-json`), one process for every turn, and draws the
// conversation in its own transcript with no terminal.
import assert from "node:assert/strict";
import { readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, before, test } from "node:test";
import type { Session, Workspace } from "../src/lib/types.ts";
import { chatLine, composerOf, editorText, holdsFor, launchCrew, MOD, newSession, openConnectorSettings, sessions, terminalIn, waitFor, workspaceRail, type Crew, turnOver } from "./harness.ts";

let crew: Crew;

before(async () => {
  crew = await launchCrew();
  // Only the fake claude is installed, but the default must not depend on it.
  await crew.request("settings_set", {
    key: "providers:default", scope: "global",
    value: JSON.stringify({ provider: "claude", model: "", effort: "", access: "ask" }),
  });
  await crew.reload();
});

after(async () => {
  await crew?.close();
});

/** A session with no message yet, once its chat is on screen. */
async function newChat(workspaceId: string): Promise<Session> {
  return newSession(crew, workspaceId);
}

/** The message box of the chat on screen, or of `session`'s, which is the one once its tab is. */
function composer(session?: Session) {
  return composerOf(crew, session);
}

/** The terminals the window's tabs hold, on screen or not. */
function terminals() {
  return terminalIn(crew.window.locator('[data-sheet="workspace"]'));
}

/** A line of the chat on screen, by the whole of its text. */
function said(text: string | RegExp) {
  return crew.window.getByText(text, typeof text === "string" ? { exact: true } : {});
}

/** Types `text` in the chat on screen and sends it. */
async function send(text: string): Promise<void> {
  await turnOver(crew);
  const field = composer();
  await field.fill(text);
  await waitFor(() => crew.window.getByRole("button", { name: "Send", exact: true }).isEnabled(), { message: "the composer can send" });
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
  return crew.window.locator("[data-context-meter]:visible");
}

test("a new Claude session opens the chat with no terminal, and its reply streams in", async () => {
  const [workspace] = crew.workspaces;
  assert.ok(workspace);
  const session = await newChat(workspace.id);
  assert.equal(await terminals().count(), 0, "a terminal is mounted");
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
  const session = await newChat(workspace.id);
  await send("asking first");
  await said("Reply 1: asking first").waitFor();
  const before = await controls();
  assert.equal(before.some((line) => line.startsWith("set_permission_mode")), false);

  // The Access chip moves the access, and the next turn tells the CLI. (⇧Tab steps the effort.)
  await crew.window.getByRole("button", { name: "Access" }).click();
  await crew.window.getByRole("menuitemradio", { name: /^Accept edits/ }).click();
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

test("Esc leaves a running turn alone: the Stop button stops it, and the next message gets its answer", async () => {
  const [workspace] = crew.workspaces;
  assert.ok(workspace);
  const session = await newChat(workspace.id);

  await send("work 30");
  const stop = crew.window.getByRole("button", { name: "Stop" });
  await stop.waitFor();
  // Stopping before the CLI has the message would cancel the launch instead of interrupting a turn.
  await waitFor(async () => (await heard(workspace.path, session)).includes("work 30"), {
    message: "the CLI took the message in",
  });
  await composer().press("Escape");
  await holdsFor(500, () => stop.isVisible(), "Esc stopped the turn");
  await stop.click();
  await stop.waitFor({ state: "detached" });
  // The turn is interrupted, sparing what runs in the background; nothing is told to stop.
  await waitFor(async () => (await controls()).includes("interrupt cancel_queued"), {
    message: "the CLI was told to interrupt",
  });
  assert.ok((await controls()).includes("initialize perTaskStopAffordance forwardSubagentText"), (await controls()).join("\n"));
  await waitFor(async () => (await crew.request<Session>("session_get", { id: session.id })).status === "idle", {
    message: "the session is idle again",
  });
  assert.equal(await said(/^Reply \d+: work 30$/).count(), 0, "the stopped turn answered anyway");

  // The conversation goes on from where it stopped, on the same process: its second turn.
  await send("after the stop");
  await said("Reply 2: after the stop").waitFor();
  const launches = await launchesOf(session);
  assert.equal(launches.length, 1, "the stop let the CLI go");
  assert.ok(alive(launches[0]!.pid), "the CLI that took the stopped turn is not the one running");
});

test("a / in the chat lists the CLI's commands and skills with Crew's actions, and a picked skill goes with the message", async () => {
  const [workspace] = crew.workspaces;
  assert.ok(workspace);
  const session = await newChat(workspace.id);
  const field = composer();
  const menu = crew.window.getByRole("listbox", { name: "Commands" });
  const entry = (name: string) => menu.getByRole("option").filter({ has: crew.window.getByText(`/${name}`, { exact: true }) });

  // The fake answers `initialize` with its commands and `reload_skills` with the skill among them.
  await field.fill("/");
  await menu.waitFor();
  for (const name of ["model", "effort", "access", "writing-for-agents", "cold-run", "compact", "context"]) {
    await entry(name).waitFor();
  }
  assert.match((await entry("writing-for-agents").textContent()) ?? "", /Write documents for agents\s*skill/);
  assert.match((await entry("cold-run").textContent()) ?? "", /<folder>/);

  // Crew's own actions open the chips' menus and leave nothing in the draft.
  for (const [name, opened] of [
    ["effort", crew.window.getByRole("menuitemradio", { name: "Low", exact: true })],
    ["access", crew.window.getByRole("menuitemradio", { name: "Accept edits" })],
    ["model", crew.window.getByPlaceholder("Search models")],
  ] as const) {
    await field.fill(`/${name}`);
    await field.press("Enter");
    await opened.waitFor();
    assert.equal(await editorText(field), "", `/${name} stayed in the draft`);
    await crew.window.keyboard.press("Escape");
    await opened.waitFor({ state: "detached" });
  }

  // Typing narrows it; a skill is picked with the keyboard and stays in the draft.
  await field.fill("/writ");
  await entry("writing-for-agents").waitFor();
  assert.equal(await entry("cold-run").count(), 0);
  await field.press("Enter");
  await menu.waitFor({ state: "detached" });
  assert.equal(await editorText(field), "/writing-for-agents ");
  // ...painted over the text like a mention.
  await field.locator('[data-chip][data-kind="skill"]', { hasText: "writing-for-agents" }).waitFor();

  // One Backspace takes the space, the next the whole token.
  await field.press("Backspace");
  assert.equal(await editorText(field), "/writing-for-agents");
  await field.press("Backspace");
  assert.equal(await editorText(field), "");
  // The caret is put back on the next frame; text typed before it would be overtaken.
  await crew.window.evaluate(() => new Promise((done) => requestAnimationFrame(done)));

  // A skill goes anywhere in a message; a provider's command only opens one.
  await field.fill("tighten the intro with /");
  await menu.waitFor();
  await entry("writing-for-agents").waitFor();
  assert.equal(await entry("compact").count(), 0, "a command was offered mid-message");
  await field.fill("tighten the intro with /writ");
  await entry("writing-for-agents").waitFor();
  await field.press("Tab");
  await waitFor(() => crew.window.getByRole("button", { name: "Send", exact: true }).isEnabled(), { message: "the composer can send" });
  await field.press("Enter");
  await waitFor(async () => (await heard(workspace.path, session)).length === 1, { message: "the CLI took the message in" });
  const [told] = await heard(workspace.path, session);
  // The skill goes last, in a block of its own: Claude expands a slash only there.
  assert.equal(told?.trim(), "tighten the intro with\n/writing-for-agents");
  await said(/^Reply 1: tighten the intro with \/ \/writing-for-agents$/).waitFor();
  await idle(session);
});

test("/restart in the chat lets go of the CLI, and the next message launches it again on the same conversation", async () => {
  const [workspace] = crew.workspaces;
  assert.ok(workspace);
  const session = await newChat(workspace.id);
  await send("remember 4817");
  await said("Reply 1: remember 4817").waitFor();
  await idle(session);
  const [first] = await launchesOf(session);
  assert.ok(first && alive(first.pid), "the CLI is up between turns");

  // Picked from the menu it runs and leaves nothing in the draft.
  const field = composer(session);
  const menu = crew.window.getByRole("listbox", { name: "Commands" });
  await field.fill("/restart");
  await menu.getByRole("option").filter({ has: crew.window.getByText("/restart", { exact: true }) }).waitFor();
  await field.press("Enter");
  await said("Restarted. The CLI starts again with the next message.").waitFor();
  assert.equal(await editorText(field), "", "/restart stayed in the draft");
  await waitFor(() => !alive(first.pid), { message: "the CLI was let go" });

  await send("what number?");
  await said("Reply 1: what number?").waitFor();
  await idle(session);
  const launches = await launchesOf(session);
  assert.equal(launches.length, 2, "the next message did not launch the CLI again");
  const resumed = launches[1]!.argv;
  assert.equal(resumed[resumed.indexOf("--resume") + 1], session.id, resumed.join(" "));
});

test("/reload in the chat asks the CLI for its plugins and then its skills, and says what it read", async () => {
  const [workspace] = crew.workspaces;
  assert.ok(workspace);
  const session = await newChat(workspace.id);
  await send("hello");
  await said("Reply 1: hello").waitFor();
  await idle(session);
  const before = (await controls()).length;

  const field = composer(session);
  await field.fill("/reload");
  await crew.window.getByRole("listbox", { name: "Commands" }).getByRole("option").filter({ has: crew.window.getByText("/reload", { exact: true }) }).waitFor();
  await field.press("Enter");
  await said(/^Reloaded plugins and skills: \d+ commands?, 1 skill\.$/).waitFor();
  assert.deepEqual((await controls()).slice(before).map((line) => line.trim()), ["reload_plugins", "reload_skills"]);
  assert.equal((await launchesOf(session)).length, 1, "a reload launched the CLI again");
});

// What the user writes while a turn runs. The fake claude takes it into the
// turn like the real one (echoed at once, named in the turn's reply), so a
// steer shows; a message held for the next turn goes in as one turn of its own.

type Rows = ReturnType<Crew["window"]["locator"]>;

/** A fresh chat of the workspace's, with a turn of `seconds` running and taken in by the CLI. */
async function workingChat(seconds: number): Promise<{ session: Session; cwd: string }> {
  const [workspace] = crew.workspaces;
  assert.ok(workspace);
  const session = await newChat(workspace.id);
  const first = `work ${seconds}`;
  await send(first);
  await crew.window.getByRole("button", { name: "Stop" }).waitFor();
  // A message sent before the CLI has the turn would start the turn, not join it.
  await waitFor(async () => (await heard(workspace.path, session)).includes(first), { message: "the CLI took the turn in" });
  return { session, cwd: workspace.path };
}

/** Writes `text` in the chat's message box while it works: ↵ steers, ⌘↵ waits for the next turn. */
async function sendWhileWorking(text: string, how: "steer" | "queue"): Promise<void> {
  const field = composer();
  // One round button: Stop while the box is empty, Send as soon as there is text.
  await crew.window.getByRole("button", { name: "Stop" }).waitFor();
  await field.fill(text);
  assert.equal(await crew.window.getByRole("button", { name: "Stop" }).count(), 0, "with text the button sends");
  await waitFor(() => crew.window.getByRole("button", { name: "Send", exact: true }).isEnabled(), {
    message: `the composer can ${how}`,
  });
  await field.press(how === "steer" ? "Enter" : `${MOD}+Enter`);
}

/** A user's bubble in the transcript. */
function bubble(text: string) {
  return crew.window.locator("[data-bubble]:visible", { hasText: text });
}

/** What waits for the next turn, at the transcript's foot. A steer is not among them: the running turn has it. */
function queuedBubbles() {
  return crew.window.locator("[data-queued-bubble]:visible");
}

/** The chat on screen's reply paragraphs that start with `prefix` (earlier chats stay mounted, hidden). */
function replies(prefix: RegExp) {
  return chatLine(crew, prefix);
}

/** What waits, first to go first, by its message. */
async function queued(): Promise<string[]> {
  return (await crew.window.locator("[data-queued-bubble]:visible [data-queued-text]").allInnerTexts()).map((text) => text.trim());
}

/** The waiting message with these words; its buttons show under the pointer. */
function row(text: string) {
  return queuedBubbles().filter({ hasText: text }).first();
}

/** There are `count` messages waiting. */
async function waiting(count: number) {
  await waitFor(async () => (await queuedBubbles().count()) === count, { message: `${count} wait` });
}

async function idle(session: Session): Promise<void> {
  await waitFor(async () => (await crew.request<Session>("session_get", { id: session.id })).status === "idle", {
    message: "the session is idle again",
  });
}

test("a message sent while a turn works is steered into it: its bubble shows at once and the turn's reply names it", async () => {
  const { session, cwd } = await workingChat(4);
  await sendWhileWorking("also mind the tests", "steer");
  // In the transcript while the turn still runs: the CLI echoed it at once.
  await bubble("also mind the tests").waitFor();
  assert.equal(await crew.window.getByRole("button", { name: "Stop" }).count(), 1, "the turn ended before the bubble showed");
  assert.deepEqual(await heard(cwd, session), ["work 4", "also mind the tests"]);
  await waiting(0);

  // The turn that was running is the one that answers it.
  await said("Also: also mind the tests").waitFor();
  await said("Reply 1: work 4").waitFor();
  await crew.window.getByRole("button", { name: "Stop" }).waitFor({ state: "detached" });
  assert.deepEqual(await replies(/^Reply \d/).allInnerTexts(), ["Reply 1: work 4"], "the steer got a turn of its own");
  assert.equal((await launchesOf(session)).length, 1, "the steer launched the CLI again");
  await idle(session);
});

test("a steer the turn has not read yet waits at the transcript's foot, and becomes its bubble once it is read", async () => {
  const { session, cwd } = await workingChat(8);
  // The fake reads a message that starts with "late " three seconds after it came.
  await sendWhileWorking("late check the logs", "steer");
  const pinned = crew.window.getByText("Queued", { exact: true }).filter({ visible: true });
  await pinned.waitFor();
  await bubble("late check the logs").waitFor();
  // Taken into the turn: it does not wait.
  assert.equal(await queuedBubbles().count(), 0);
  assert.deepEqual(await heard(cwd, session), ["work 8"]);
  await pinned.waitFor({ state: "detached" });
  await bubble("late check the logs").waitFor();
  assert.deepEqual(await heard(cwd, session), ["work 8", "late check the logs"]);
  await said("Also: late check the logs").waitFor();
  await idle(session);
});

test("⌘↵ while a turn works queues the message: its bubble waits, and it goes as the next turn", async () => {
  const { session, cwd } = await workingChat(4);
  await sendWhileWorking("for the next turn", "queue");
  await queuedBubbles().filter({ hasText: "for the next turn" }).waitFor();
  // Not in the turn running: the CLI has not heard it.
  assert.deepEqual(await heard(cwd, session), ["work 4"]);

  await said("Reply 2: for the next turn").waitFor();
  assert.deepEqual(await heard(cwd, session), ["work 4", "for the next turn"]);
  assert.equal(await queuedBubbles().count(), 0, "the bubble stayed queued after its message went");
  assert.equal((await launchesOf(session)).length, 1);
  await idle(session);
});

test("a queued message can be dropped before it goes", async () => {
  const { session, cwd } = await workingChat(5);
  await sendWhileWorking("keep this", "queue");
  await sendWhileWorking("never mind this", "queue");
  await waiting(2);

  await row("never mind this").getByRole("button", { name: "Delete" }).click();
  await waitFor(async () => (await queued()).join("|") === "keep this", { message: "the message is dropped" });
  assert.equal(await row("keep this").getByRole("button").count(), 1, "deleting is all a queued message offers");

  await said("Reply 2: keep this").waitFor();
  const all = (await heard(cwd, session)).join("\n");
  assert.ok(!all.includes("never mind this"), `what was dropped went anyway: ${all}`);
  assert.equal((await heard(cwd, session)).length, 2);
  await idle(session);
});

test("Stop holds what waits: its bubble stays, and the next message sends both", async () => {
  const { session, cwd } = await workingChat(30);
  await sendWhileWorking("held for later", "queue");
  await queuedBubbles().filter({ hasText: "held for later" }).waitFor();
  await crew.window.getByRole("button", { name: "Stop" }).click();
  await crew.window.getByRole("button", { name: "Stop" }).waitFor({ state: "detached" });
  await idle(session);
  // Stopping leaves the queue to the user: nothing goes by itself.
  await holdsFor(
    1500,
    async () => (await queuedBubbles().count()) === 1 && (await heard(cwd, session)).length === 1,
    "the held message went or its bubble left",
  );

  await send("go on then");
  // On the process the stopped turn had: its second turn.
  await replies(/^Reply 2: held for later/).waitFor();
  assert.equal((await launchesOf(session)).length, 1, "the stop let the CLI go");
  const turns = await heard(cwd, session);
  assert.equal(turns.length, 2, JSON.stringify(turns));
  assert.ok(turns[1]!.indexOf("held for later") >= 0 && turns[1]!.indexOf("held for later") < turns[1]!.indexOf("go on then"), turns[1]);
  await waitFor(async () => (await queuedBubbles().count()) === 0, { message: "it no longer waits once it went" });
  await idle(session);
});

test("Tab shows the focus on the access chip and the context ring", async () => {
  const [workspace] = crew.workspaces;
  assert.ok(workspace);
  const session = await newChat(workspace.id);
  await send("focus");
  await said("Reply 1: focus").waitFor();
  await idle(session);
  const access = crew.window.locator("[data-composer]:visible").getByRole("button", { name: "Access" });
  await crew.window.locator("[data-composer]:visible").getByRole("button", { name: "Effort" }).focus();
  await crew.window.keyboard.press("Tab");
  assert.equal(await access.evaluate((el) => el === document.activeElement), true, "Tab reaches the access chip");
  assert.equal(await access.evaluate((el) => getComputedStyle(el).outlineStyle), "solid", "the access chip shows it has the keyboard");
});

test("a session paused after 20 automatic turns says so at the transcript's foot, and Resume wakes it", async () => {
  const [workspace] = crew.workspaces;
  assert.ok(workspace);
  const session = await newChat(workspace.id);
  await send("before the pause");
  await said("Reply 1: before the pause").waitFor();
  await idle(session);
  const database = new DatabaseSync(path.join(crew.userData, "crew.sqlite3"));
  try {
    database.prepare(`INSERT OR REPLACE INTO app_state(key, value) VALUES (?, '20')`).run(`auto_turns:${session.id}`);
  } finally {
    database.close();
  }
  await crew.reload();
  const row = crew.window.locator("[data-paused-row]:visible");
  await row.waitFor();
  assert.match(await row.innerText(), /Paused after 20 turns/);
  assert.equal(await crew.window.locator("[data-status-line]:visible").getByText(/Paused/).count(), 0, "the line under the prompt does not repeat it");
  await row.getByRole("button", { name: "Resume" }).click();
  await row.waitFor({ state: "detached" });
  assert.equal((await crew.request<{ paused?: boolean }>("session_get", { id: session.id })).paused, false);
});

test("a session's connectors show under the prompt, a dot says one needs the user, and the sheet lists them over the way to the page", async () => {
  const [workspace] = crew.workspaces;
  assert.ok(workspace);
  const servers = path.join(crew.home, "fake-claude-mcp.json");
  await writeFile(
    servers,
    JSON.stringify([
      { name: "docs", status: "connected" },
      { name: "context7", status: "connected" },
      { name: "chrome-devtools", status: "connected" },
      { name: "figma", status: "connected" },
      { name: "a-server-with-a-rather-long-name", status: "connected" },
      { name: "off", status: "disabled" },
      { name: "sentry", status: "needs-auth" },
      { name: "broken", status: "failed", error: "ENOENT: no such file or directory" },
    ]),
  );
  try {
    const session = await newChat(workspace.id);
    const chip = crew.window.locator("[data-status-line]:visible [data-connectors-trigger]");
    // The CLI is not up before the first message and the machine lists none: the page, straight.
    await chip.click();
    await chip.waitFor({ state: "hidden" });
    assert.equal(await crew.window.locator("[data-connectors-sheet]").count(), 0, "no sheet with nothing in it");
    await crew.window.getByRole("heading", { name: "Connectors", level: 1 }).waitFor();
    await workspaceRail(crew).getByRole("button", { name: "Settings", exact: true }).click();
    await chip.waitFor();
    await send("which servers");
    await said("Reply 1: which servers").waitFor();
    await chip.waitFor();
    assert.equal((await chip.innerText()).trim(), "Connectors");
    await chip.locator('[data-status-dot="warning"]').waitFor({ state: "attached" });
    assert.equal(await chip.getAttribute("title"), "1 needs sign-in · 1 failed");

    await chip.click();
    const sheet = crew.window.locator("[data-connectors-sheet]:visible");
    const row = (name: string) => sheet.locator(`[data-server="${name}"]`);
    // What needs the user first, to read: no action on any, no switch, and the way to the page in the header.
    assert.deepEqual(await sheet.locator("[data-server]").evaluateAll((all) => all.map((one) => one.getAttribute("data-server"))), ["sentry", "broken", "docs", "context7", "chrome-devtools", "figma", "a-server-with-a-rather-long-name"]);
    assert.deepEqual(await sheet.getByRole("button").allInnerTexts(), ["Manage"]);
    assert.equal(await sheet.getByRole("switch").count(), 0, "switching one off is the page's");
    assert.equal(await row("off").count(), 0, "one switched off is the page's too");
    assert.equal(await row("sentry").locator("[data-server-dot]").count(), 1);
    assert.equal(await row("broken").locator("[data-server-dot]").count(), 1);
    assert.equal(await row("docs").locator("[data-server-dot]").count(), 0, "one that is simply on has no dot");
    assert.equal(await row("broken").getAttribute("title"), "broken: Failed: ENOENT: no such file or directory");
    const list = await row("sentry").boundingBox();
    const manage = await sheet.getByRole("button", { name: "Manage" }).boundingBox();
    assert.ok(list && manage && manage.y < list.y, "Manage is over the list, in the header");
    const beside = await row("broken").boundingBox();
    assert.ok(list && beside && beside.y === list.y && beside.x > list.x, "they sit side by side");
    const docs = await row("docs").boundingBox();
    const devtools = await row("chrome-devtools").boundingBox();
    assert.ok(docs && devtools && docs.width < devtools.width, "each as wide as its name");
    assert.equal(await sheet.locator("[data-connectors-list]").getAttribute("data-fade-bottom"), null, "all of them fit: no fade");
    assert.ok(((await sheet.boundingBox())?.height ?? 999) < 240, "the sheet stays small");
    if (process.env.E2E_SHOTS) await crew.window.screenshot({ path: path.join(process.env.E2E_SHOTS, "connectors-sheet.png") });

    // Esc hands the keyboard back to the segment that opened it from the keyboard.
    await crew.window.keyboard.press("Escape");
    await sheet.waitFor({ state: "detached" });
    await chip.focus();
    await crew.window.keyboard.press("Enter");
    await sheet.waitFor();
    await crew.window.keyboard.press("Escape");
    await sheet.waitFor({ state: "detached" });
    assert.equal(await chip.evaluate((el) => el === document.activeElement), true, "the keyboard is back on the segment");

    // Manage goes to the page.
    await chip.click();
    await sheet.getByRole("button", { name: "Manage" }).click();
    await chip.waitFor({ state: "hidden" });
    assert.equal(await sheet.count(), 0, "the sheet closed");
    await crew.window.getByRole("heading", { name: "Connectors", level: 1 }).waitFor();
    await workspaceRail(crew).getByRole("button", { name: "Settings", exact: true }).click();
    await chip.waitFor();
    await idle(session);
  } finally {
    await rm(servers, { force: true });
  }
});

test("more connectors than fit scroll, fading at the edge with more past it", async () => {
  const [workspace] = crew.workspaces;
  assert.ok(workspace);
  const servers = path.join(crew.home, "fake-claude-mcp.json");
  await writeFile(servers, JSON.stringify(Array.from({ length: 40 }, (_, at) => ({ name: `server-${at}`, status: "connected" }))));
  try {
    const session = await newChat(workspace.id);
    await send("so many servers");
    await said("Reply 1: so many servers").waitFor();
    await crew.window.locator("[data-status-line]:visible [data-connectors-trigger]").click();
    const sheet = crew.window.locator("[data-connectors-sheet]:visible");
    await sheet.locator('[data-server="server-39"]').waitFor({ state: "attached" });
    const list = sheet.locator("[data-connectors-list]");
    const fades = () => list.evaluate((el) => [el.hasAttribute("data-fade-top"), el.hasAttribute("data-fade-bottom")]);
    assert.deepEqual(await fades(), [false, true], "at the top: only the bottom fades");
    await list.evaluate((el) => {
      el.scrollTop = el.scrollHeight;
    });
    await waitFor(async () => (await fades())[0], { message: "the top fades once scrolled" });
    assert.deepEqual(await fades(), [true, false], "at the end: only the top fades");
    if (process.env.E2E_SHOTS) await crew.window.screenshot({ path: path.join(process.env.E2E_SHOTS, "connectors-sheet-scrolled.png") });
    await list.evaluate((el) => {
      el.scrollTop = 40;
    });
    await waitFor(async () => (await fades())[1], { message: "the bottom fades again" });
    if (process.env.E2E_SHOTS) await crew.window.screenshot({ path: path.join(process.env.E2E_SHOTS, "connectors-sheet-middle.png") });
    await crew.window.keyboard.press("Escape");
    await idle(session);
  } finally {
    await rm(servers, { force: true });
  }
});

test("a project's own server that needs the user can be signed in to from the page the session opens", async () => {
  const [workspace] = crew.workspaces;
  assert.ok(workspace);
  // Seen by a CLI working in the project, not by the one the machine's list is read with.
  const servers = path.join(crew.home, "fake-claude-mcp-project.json");
  await writeFile(servers, JSON.stringify([{ name: "sentry", status: "needs-auth" }]));
  try {
    const session = await newChat(workspace.id);
    await send("which project servers");
    await said("Reply 1: which project servers").waitFor();
    const chip = crew.window.locator("[data-status-line]:visible [data-connectors-trigger]");
    await chip.locator('[data-status-dot="warning"]').waitFor({ state: "attached" });
    await chip.click();
    await crew.window.locator("[data-connectors-sheet]:visible").getByRole("button", { name: "Manage" }).click();

    // Claude's login is its own command, in a terminal tab of Crew's, in the session's folder.
    const row = crew.window.locator('[data-project-server="sentry"]');
    await row.getByRole("button", { name: "Sign in" }).click();
    await crew.window.locator('[data-tab-strip] [role="tab"]').filter({ hasText: "Sign in to sentry" }).waitFor();
    await waitFor(async () => (await crew.claudeLaunches()).some((launch) => launch.argv.join(" ") === "mcp login sentry"), {
      message: "the login runs as `claude mcp login sentry`",
    });
    await idle(session);
  } finally {
    await rm(servers, { force: true });
  }
});

test("Settings › Connectors opened from the rail has no project to speak of", async () => {
  await openConnectorSettings(crew);
  assert.equal(await crew.window.getByText("In this project", { exact: true }).count(), 0);
  await workspaceRail(crew).getByRole("button", { name: "Settings", exact: true }).click();
});

test("the first prompt from home is the chat session's first turn", async () => {
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
  await said("say hi from home").waitFor();
  await said("Reply 1: say hi from home").waitFor();
  assert.equal(await terminals().filter({ visible: true }).count(), 0, "a terminal is on screen");
  const [launch] = await launchesOf(session);
  assert.ok(launch);
  assert.equal(launch.cwd, home.path);
  assert.ok(launch.argv.join(" ").includes("--input-format stream-json"), launch.argv.join(" "));
  assert.equal(launch.argv.includes("--"), false, "the prompt is a turn over stdin, not the command line's");
});
