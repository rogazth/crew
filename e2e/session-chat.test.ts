// Sessions in Crew's chat: Crew drives the session's CLI over the provider's
// protocol (the fake claude speaks stream-json when launched with
// `--input-format stream-json`), one process for every turn, and draws the
// conversation in its own transcript with no terminal.
import assert from "node:assert/strict";
import { readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { after, before, test } from "node:test";
import type { Session, Workspace } from "../src/lib/types.ts";
import { holdsFor, launchCrew, MOD, pressChord, sessions, waitFor, type Crew } from "./harness.ts";

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

/** ⌘N: the session crewd made, once its chat is on screen. */
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

test("a new Claude session opens the chat with no terminal, and its reply streams in", async () => {
  const [workspace] = crew.workspaces;
  assert.ok(workspace);
  const session = await newChat(workspace.id);
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
    assert.equal(await field.inputValue(), "", `/${name} stayed in the draft`);
    await crew.window.keyboard.press("Escape");
    await opened.waitFor({ state: "detached" });
  }

  // Typing narrows it; a skill is picked with the keyboard and stays in the draft.
  await field.fill("/writ");
  await entry("writing-for-agents").waitFor();
  assert.equal(await entry("cold-run").count(), 0);
  await field.press("Enter");
  await menu.waitFor({ state: "detached" });
  assert.equal(await field.inputValue(), "/writing-for-agents ");
  // ...painted over the text like a mention.
  await crew.window.locator(".crew-composer-overlay:visible mark", { hasText: "/writing-for-agents" }).waitFor();

  // One Backspace takes the space, the next the whole token.
  await field.press("Backspace");
  assert.equal(await field.inputValue(), "/writing-for-agents");
  await field.press("Backspace");
  assert.equal(await field.inputValue(), "");
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
  await waitFor(() => crew.window.getByRole("button", { name: "Send" }).isEnabled(), { message: "the composer can send" });
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
  assert.equal(await field.inputValue(), "", "/restart stayed in the draft");
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

test("a server that needs a sign-in or failed shows a chip, and its sheet lists the servers and opens the sign-in in a terminal", async () => {
  const [workspace] = crew.workspaces;
  assert.ok(workspace);
  const servers = path.join(crew.home, "fake-claude-mcp.json");
  await writeFile(
    servers,
    JSON.stringify([
      { name: "docs", status: "connected" },
      { name: "sentry", status: "needs-auth" },
      { name: "broken", status: "failed", error: "ENOENT: no such file or directory" },
    ]),
  );
  try {
    const session = await newChat(workspace.id);
    const chip = crew.window.getByRole("button", { name: "1 needs sign-in · 1 failed" });
    // The CLI is not up before the first message: nothing to say yet.
    assert.equal(await chip.count(), 0);
    await send("which servers");
    await said("Reply 1: which servers").waitFor();
    await chip.waitFor();

    await chip.click();
    const sheet = crew.window.locator("[data-mcp-sheet]:visible");
    const row = (name: string) => sheet.locator(`[data-server="${name}"]`);
    await row("sentry").getByText("Needs sign-in", { exact: true }).waitFor();
    await row("broken").getByText("Failed: ENOENT: no such file or directory", { exact: true }).waitFor();
    await row("docs").getByText("Connected", { exact: true }).waitFor();
    assert.equal(await row("docs").getByRole("button").count(), 0, "a server that works offers nothing");
    await row("broken").getByRole("button", { name: "Reconnect" }).waitFor();

    // Claude's login is its own command, in a terminal tab of Crew's.
    await row("sentry").getByRole("button", { name: "Sign in" }).click();
    await crew.window.locator('[data-tab-strip] [role="tab"]').filter({ hasText: "Sign in to sentry" }).waitFor();
    await waitFor(async () => (await crew.claudeLaunches()).some((launch) => launch.argv.join(" ") === "mcp login sentry"), {
      message: "the login runs as `claude mcp login sentry`",
    });
    assert.equal(await sheet.count(), 0, "the sheet stayed over the chat");
    await idle(session);
  } finally {
    await rm(servers, { force: true });
  }
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
  // The send button is labelled for what ↵ does, which is to steer where the CLI takes a steer.
  await waitFor(() => crew.window.getByRole("button", { name: "Add to the running turn" }).isEnabled(), {
    message: `the composer can ${how}`,
  });
  await field.press(how === "steer" ? "Enter" : `${MOD}+Enter`);
}

/** A user's bubble in the transcript (not the chips above the message box). */
function bubble(text: string) {
  return crew.window.locator(".crew-bubble:visible", { hasText: text });
}

/** The chips above the message box. */
function chips() {
  return crew.window.locator("form.crew-composer:visible span.rounded-full").filter({ hasText: /this turn|next turn/ });
}

/** The chat on screen's reply paragraphs that start with `prefix` (earlier chats stay mounted, hidden). */
function replies(prefix: RegExp) {
  return crew.window.locator("p:visible").filter({ hasText: prefix });
}

/** The status line's "N waiting", which opens the queue's sheet. */
function waiting(count: number) {
  return crew.window.getByRole("button", { name: `${count} waiting`, exact: true });
}

/** The queue's sheet, opened from the status line. */
async function openQueue(count: number) {
  await waiting(count).click();
  const sheet = crew.window.locator("div.absolute.shadow-float:has(div.group)");
  await sheet.waitFor();
  return sheet;
}

/** The sheet's rows, first to go first, by their message. */
async function queued(sheet: Rows): Promise<string[]> {
  return (await sheet.locator("div.group span.truncate").allInnerTexts()).map((text) => text.trim());
}

/** The row of the sheet with this message, whose buttons show on hover. */
function row(sheet: Rows, text: string) {
  return sheet.locator("div.group").filter({ hasText: text }).first();
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
  await waitFor(async () => (await chips().count()) === 0, { message: "the steer's chip is gone once it is in the transcript" });
  assert.equal(await waiting(1).count(), 0);

  // The turn that was running is the one that answers it.
  await said("Also: also mind the tests").waitFor();
  await said("Reply 1: work 4").waitFor();
  await crew.window.getByRole("button", { name: "Stop" }).waitFor({ state: "detached" });
  assert.deepEqual(await replies(/^Reply \d/).allInnerTexts(), ["Reply 1: work 4"], "the steer got a turn of its own");
  assert.equal((await launchesOf(session)).length, 1, "the steer launched the CLI again");
  await idle(session);
});

test("a steer the turn has not read yet waits as a chip, and the bubble takes its place once it is read", async () => {
  const { session, cwd } = await workingChat(8);
  // The fake reads a message that starts with "late " three seconds after it came.
  await sendWhileWorking("late check the logs", "steer");
  await chips().filter({ hasText: "this turn" }).filter({ hasText: "late check the logs" }).waitFor();
  // Taken into the turn: not a message that waits, so the status line counts none.
  assert.equal(await waiting(1).count(), 0);
  assert.deepEqual(await heard(cwd, session), ["work 8"]);
  await bubble("late check the logs").waitFor();
  await waitFor(async () => (await chips().count()) === 0, { message: "the chip is gone once the turn read it" });
  assert.deepEqual(await heard(cwd, session), ["work 8", "late check the logs"]);
  await said("Also: late check the logs").waitFor();
  await idle(session);
});

test("⌘↵ while a turn works queues the message: a chip and a count wait, and it goes as the next turn", async () => {
  const { session, cwd } = await workingChat(4);
  await sendWhileWorking("for the next turn", "queue");
  await chips().filter({ hasText: "next turn" }).filter({ hasText: "for the next turn" }).waitFor();
  await waiting(1).waitFor();
  // Not in the turn running: the CLI has not heard it.
  assert.deepEqual(await heard(cwd, session), ["work 4"]);

  await said("Reply 2: for the next turn").waitFor();
  assert.deepEqual(await heard(cwd, session), ["work 4", "for the next turn"]);
  assert.equal(await chips().count(), 0, "the chip stayed after its message went");
  assert.equal(await waiting(1).count(), 0);
  assert.equal((await launchesOf(session)).length, 1);
  await idle(session);
});

test("what waits can be moved in the sheet, and goes as one turn in the new order", async () => {
  const { session, cwd } = await workingChat(5);
  await sendWhileWorking("alpha note", "queue");
  await sendWhileWorking("bravo note", "queue");
  await waiting(2).waitFor();
  const sheet = await openQueue(2);
  assert.deepEqual(await queued(sheet), ["alpha note", "bravo note"]);

  await row(sheet, "bravo note").getByRole("button", { name: "Move up" }).click();
  await waitFor(async () => (await queued(sheet)).join("|") === "bravo note|alpha note", { message: "the sheet lists bravo first" });
  await composer().click();
  await sheet.waitFor({ state: "detached" });

  // One turn for both: the reply says them in the order they went.
  const reply = replies(/^Reply 2:/);
  await reply.filter({ hasText: "alpha note" }).waitFor();
  const text = (await reply.textContent()) ?? "";
  assert.ok(text.indexOf("bravo note") >= 0 && text.indexOf("bravo note") < text.indexOf("alpha note"), `bravo goes before alpha: ${text}`);
  const turns = await heard(cwd, session);
  assert.equal(turns.length, 2, `the queue went as more than one turn: ${JSON.stringify(turns)}`);
  assert.ok(turns[1]!.indexOf("bravo note") < turns[1]!.indexOf("alpha note"), turns[1]);
  assert.equal(await chips().count(), 0);
  await idle(session);
});

test("a queued message can be edited before it goes, and another dropped", async () => {
  const { session, cwd } = await workingChat(5);
  await sendWhileWorking("fix the typpo", "queue");
  await sendWhileWorking("never mind this", "queue");
  await waiting(2).waitFor();
  const sheet = await openQueue(2);

  await row(sheet, "fix the typpo").getByRole("button", { name: "Edit" }).click();
  const field = sheet.getByRole("textbox", { name: "Queued message" });
  await field.fill("fix the typo");
  await field.press("Enter");
  await waitFor(async () => (await queued(sheet)).includes("fix the typo"), { message: "the sheet shows the edit" });
  await chips().filter({ hasText: "fix the typo" }).waitFor();

  await row(sheet, "never mind this").getByRole("button", { name: "Delete" }).click();
  await waitFor(async () => (await queued(sheet)).join("|") === "fix the typo", { message: "the sheet drops the message" });
  await waiting(1).waitFor();
  assert.equal(await chips().count(), 1);
  await composer().click();

  await said("Reply 2: fix the typo").waitFor();
  const all = (await heard(cwd, session)).join("\n");
  assert.ok(!all.includes("typpo") && !all.includes("never mind this"), `what was edited or dropped went anyway: ${all}`);
  assert.equal((await heard(cwd, session)).length, 2);
  await idle(session);
});

test("Send now stops the turn running and the next turn starts with that message", async () => {
  const { session, cwd } = await workingChat(30);
  await sendWhileWorking("do this first", "queue");
  await sendWhileWorking("and this later", "queue");
  const sheet = await openQueue(2);
  await row(sheet, "and this later").getByRole("button", { name: "Send now" }).click();

  // The turn running was interrupted, and the queue went over as one turn headed by the one sent now,
  // on the same process: its second turn.
  await waitFor(async () => (await controls()).includes("interrupt cancel_queued"), {
    message: "the CLI was told to interrupt",
  });
  const reply = replies(/^Reply 2:/).filter({ hasText: "do this first" });
  await reply.waitFor();
  const text = (await reply.textContent()) ?? "";
  assert.ok(text.indexOf("and this later") >= 0 && text.indexOf("and this later") < text.indexOf("do this first"), text);
  assert.equal(await replies(/^Reply \d+: work 30$/).count(), 0, "the stopped turn answered anyway");
  const turns = await heard(cwd, session);
  assert.equal(turns.length, 2, JSON.stringify(turns));
  assert.ok(turns[1]!.indexOf("and this later") < turns[1]!.indexOf("do this first"), turns[1]);
  assert.equal(await chips().count(), 0);
  assert.equal((await launchesOf(session)).length, 1, "the stop let the CLI go");
  await idle(session);
});

test("Esc holds what waits: its chip stays, and the next message sends both", async () => {
  const { session, cwd } = await workingChat(30);
  await sendWhileWorking("held for later", "queue");
  await chips().filter({ hasText: "held for later" }).waitFor();
  await composer().press("Escape");
  await crew.window.getByRole("button", { name: "Stop" }).waitFor({ state: "detached" });
  await idle(session);
  // Stopping leaves the queue to the user: nothing goes by itself.
  await holdsFor(
    1500,
    async () => (await chips().count()) === 1 && (await waiting(1).count()) === 1 && (await heard(cwd, session)).length === 1,
    "the held message went or its chip left",
  );

  await send("go on then");
  // On the process the stopped turn had: its second turn.
  await replies(/^Reply 2: held for later/).waitFor();
  assert.equal((await launchesOf(session)).length, 1, "the stop let the CLI go");
  const turns = await heard(cwd, session);
  assert.equal(turns.length, 2, JSON.stringify(turns));
  assert.ok(turns[1]!.indexOf("held for later") >= 0 && turns[1]!.indexOf("held for later") < turns[1]!.indexOf("go on then"), turns[1]);
  await waitFor(async () => (await chips().count()) === 0, { message: "the chip is gone once it went" });
  await idle(session);
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
  assert.equal(await terminals().count(), 0, "a terminal is on screen");
  const [launch] = await launchesOf(session);
  assert.ok(launch);
  assert.equal(launch.cwd, home.path);
  assert.ok(launch.argv.join(" ").includes("--input-format stream-json"), launch.argv.join(" "));
  assert.equal(launch.argv.includes("--"), false, "the prompt is a turn over stdin, not the command line's");
});
