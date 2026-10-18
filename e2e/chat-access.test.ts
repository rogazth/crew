// What a chat session may do without asking reaches its CLI: a fresh install
// runs with full access, a session that asks raises a card for each tool
// call, and Settings › General › Bypass permissions or the Access chip's Full
// access start the next turn's CLI with `--dangerously-skip-permissions`, a
// flag only a launch can set. The fake claude's launch log and the questions
// it put to Crew ($HOME/fake-claude-asks.log) are the witnesses.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import type { Session } from "../src/lib/types.ts";
import {
  composerOf,
  holdsFor,
  launchCrew,
  lightIn,
  MOD,
  newSession,
  pressChord,
  sendInChat,
  sessionRow,
  sessionTab,
  storedStatus,
  waitFor,
  type ClaudeLaunch,
  type Crew,
} from "./harness.ts";

const SKIP = "--dangerously-skip-permissions";

/** Every launch of the fake claude for `session`, oldest first. */
async function launchesOf(crew: Crew, session: Session): Promise<ClaudeLaunch[]> {
  return (await crew.claudeLaunches()).filter((launch) => launch.argv.includes(session.id));
}

/** The `n`th launch (from 1) of `session`'s CLI, once there is one. */
function launchNo(crew: Crew, session: Session, n: number): Promise<ClaudeLaunch> {
  return waitFor(async () => (await launchesOf(crew, session))[n - 1], { message: `${session.name}'s CLI starts (launch ${n})` });
}

const after = (argv: string[], flag: string) => (argv.includes(flag) ? argv[argv.indexOf(flag) + 1] : undefined);

/** The questions the fake claude put to Crew, as `<tool> <permission mode>`. */
async function asks(crew: Crew): Promise<string[]> {
  const log = await readFile(path.join(crew.home, "fake-claude-asks.log"), "utf8").catch(() => "");
  return log.split("\n").filter(Boolean);
}

/** A line of the chat on screen, by the whole of its text. */
function said(crew: Crew, text: string) {
  return crew.window.locator("p:visible").filter({ hasText: new RegExp(`^${text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`) });
}

/** The approval card the chat on screen raised for the fake's `ask`. */
function card(crew: Crew) {
  return crew.window.locator(".crew-card:visible").filter({ hasText: "Run this command?" });
}

async function idle(crew: Crew, session: Session): Promise<void> {
  await waitFor(async () => (await storedStatus(crew, session.id)) === "idle", { message: `${session.name} is idle again` });
}

/** Settings › General › Bypass permissions, through its confirmation when it turns on. */
async function setBypass(crew: Crew, on: boolean): Promise<void> {
  const page = crew.window;
  await pressChord(crew, `${MOD}+,`);
  await page.getByRole("button", { name: "General", exact: true }).click();
  const toggle = page.getByRole("switch", { name: /Bypass permissions/ });
  assert.equal(await toggle.getAttribute("aria-checked"), String(!on));
  await toggle.click();
  if (on) {
    const confirm = page.getByRole("alertdialog", { name: "Bypass permissions for every session?" });
    await confirm.getByRole("button", { name: /^Bypass/ }).click();
    await confirm.waitFor({ state: "detached" });
  }
  await waitFor(
    async () => ((await crew.request<string | null>("state_get", { key: "sessions:bypass-permissions" })) === "on") === on,
    { message: `crewd keeps the setting ${on ? "on" : "off"}` },
  );
  await pressChord(crew, `${MOD}+,`);
}

test("a fresh install's chat runs its CLI with full access and Crew's tools, the user's own servers kept", async (t) => {
  const crew = await launchCrew();
  t.after(() => crew.close());
  const [workspace] = crew.workspaces;
  assert.ok(workspace);

  const session = await newSession(crew, workspace.id);
  await sendInChat(crew, "ask");
  await said(crew, "Reply 1: ask allowed").waitFor();
  const { argv } = await launchNo(crew, session, 1);
  assert.ok(argv.includes(SKIP), `a fresh install asks: ${argv.join(" ")}`);
  assert.equal(after(argv, "--permission-mode"), undefined, argv.join(" "));
  assert.deepEqual(await asks(crew), [], "the CLI asked before running a tool");

  // Crew's server is added to the user's own, never in place of them.
  const config = JSON.parse(after(argv, "--mcp-config") ?? "{}") as { mcpServers?: { crew?: { args?: string[] } } };
  assert.deepEqual(config.mcpServers?.crew?.args, ["--mcp"], argv.join(" "));
  assert.ok(!argv.includes("--strict-mcp-config"), "the user's own MCP servers would be dropped");
  await idle(crew, session);
});

test("a session that asks raises a card for its CLI's tool call, its row reads Needs input out of sight, and Allow runs it", async (t) => {
  const crew = await launchCrew();
  t.after(() => crew.close());
  const [workspace] = crew.workspaces;
  assert.ok(workspace);
  await crew.request("state_set", {
    key: "providers:default",
    value: JSON.stringify({ provider: "claude", model: "", effort: "", access: "ask" }),
  });
  await crew.reload();

  const other = await newSession(crew, workspace.id);
  await sendInChat(crew, "hello");
  await said(crew, "Reply 1: hello").waitFor();
  const session = await newSession(crew, workspace.id);
  await sendInChat(crew, "ask");
  await card(crew).waitFor();
  const { argv } = await launchNo(crew, session, 1);
  assert.equal(after(argv, "--permission-mode"), "default", argv.join(" "));
  assert.ok(!argv.includes(SKIP), argv.join(" "));
  assert.deepEqual(await asks(crew), ["Bash default"]);
  await waitFor(async () => (await storedStatus(crew, session.id)) === "needs-input", { message: "crewd holds the session as needing input" });

  // Out of sight it says so on its row, and keeps saying it: nothing answers for the user.
  await sessionTab(crew, other).click();
  const row = sessionRow(crew, session.name);
  await waitFor(async () => (await lightIn(row)) === "Needs input", { message: "the row reads Needs input" });
  await holdsFor(
    2000,
    async () => {
      const [light, stored] = await Promise.all([lightIn(row), storedStatus(crew, session.id)]);
      return (light === "Needs input" && stored === "needs-input") || `row reads ${light}, crewd stores ${stored}`;
    },
    "the question went away on its own",
  );

  // Back to it: Allow lets the CLI run the tool, and the turn ends.
  await sessionTab(crew, session).click();
  await card(crew).getByRole("button", { name: /^Allow/ }).click();
  await said(crew, "Reply 1: ask allowed").waitFor();
  await idle(crew, session);
  assert.equal(await lightIn(row), "Idle");

  // Deny says no to the CLI.
  await sendInChat(crew, "ask");
  await card(crew).getByRole("button", { name: "Deny" }).click();
  await said(crew, "Reply 2: ask denied").waitFor();
  await idle(crew, session);
  assert.equal((await launchesOf(crew, session)).length, 1, "answering a card launched the CLI again");
});

test("Bypass permissions relaunches the next turn's CLI without asking, in every session, and turning it off asks again", async (t) => {
  const crew = await launchCrew();
  t.after(() => crew.close());
  const [workspace] = crew.workspaces;
  assert.ok(workspace);
  await crew.request("state_set", {
    key: "providers:default",
    value: JSON.stringify({ provider: "claude", model: "", effort: "", access: "ask" }),
  });
  await crew.reload();

  const session = await newSession(crew, workspace.id);
  await sendInChat(crew, "remember 4817");
  await said(crew, "Reply 1: remember 4817").waitFor();
  await idle(crew, session);
  const first = await launchNo(crew, session, 1);
  assert.ok(!first.argv.includes(SKIP), first.argv.join(" "));

  await setBypass(crew, true);
  await composerOf(crew, session).waitFor();
  // The session's own access is untouched: the setting overrides it.
  assert.equal((await crew.request<Session>("session_get", { id: session.id })).autonomy, "ask");

  // The kept CLI cannot take the flag: the next turn launches another, on the same conversation.
  await sendInChat(crew, "ask");
  await said(crew, "Reply 1: ask allowed").waitFor();
  const second = await launchNo(crew, session, 2);
  assert.ok(second.argv.includes(SKIP), `the CLI asks under Bypass permissions: ${second.argv.join(" ")}`);
  assert.equal(after(second.argv, "--resume"), session.id, second.argv.join(" "));
  assert.equal(await card(crew).count(), 0, "a card was raised under Bypass permissions");
  assert.deepEqual(await asks(crew), [], "the CLI asked under Bypass permissions");
  await idle(crew, session);

  // A new session starts that way.
  const fresh = await newSession(crew, workspace.id);
  await sendInChat(crew, "hello");
  await said(crew, "Reply 1: hello").waitFor();
  assert.ok((await launchNo(crew, fresh, 1)).argv.includes(SKIP), "a new session asks under Bypass permissions");
  await idle(crew, fresh);

  // Off again: the session goes back to asking, on a CLI launched without the flag.
  await setBypass(crew, false);
  await sessionTab(crew, session).click();
  await composerOf(crew, session).waitFor();
  await sendInChat(crew, "ask");
  await card(crew).waitFor();
  const third = await launchNo(crew, session, 3);
  assert.ok(!third.argv.includes(SKIP), `the CLI still skips permissions: ${third.argv.join(" ")}`);
  assert.equal(after(third.argv, "--permission-mode"), "default", third.argv.join(" "));
  await card(crew).getByRole("button", { name: "Deny" }).click();
  await said(crew, "Reply 1: ask denied").waitFor();
  await idle(crew, session);
});

test("Full access from the Access chip relaunches the CLI without asking, and Ask permission brings the questions back", async (t) => {
  const crew = await launchCrew();
  t.after(() => crew.close());
  const [workspace] = crew.workspaces;
  assert.ok(workspace);
  await crew.request("state_set", {
    key: "providers:default",
    value: JSON.stringify({ provider: "claude", model: "", effort: "", access: "ask" }),
  });
  await crew.reload();

  const session = await newSession(crew, workspace.id);
  await sendInChat(crew, "hello");
  await said(crew, "Reply 1: hello").waitFor();
  await idle(crew, session);

  const pickAccess = async (label: string, autonomy: string) => {
    await crew.window.getByRole("button", { name: "Access" }).click();
    await crew.window.getByRole("menuitemradio", { name: label }).click();
    await waitFor(async () => (await crew.request<Session>("session_get", { id: session.id })).autonomy === autonomy, {
      message: `the row keeps ${autonomy}`,
    });
  };

  await pickAccess("Full access", "full");
  await sendInChat(crew, "ask");
  await said(crew, "Reply 1: ask allowed").waitFor();
  const full = await launchNo(crew, session, 2);
  assert.ok(full.argv.includes(SKIP), full.argv.join(" "));
  assert.equal(after(full.argv, "--resume"), session.id, full.argv.join(" "));
  assert.deepEqual(await asks(crew), []);
  await idle(crew, session);

  await pickAccess("Ask permission", "ask");
  await sendInChat(crew, "ask");
  await card(crew).waitFor();
  const asking = await launchNo(crew, session, 3);
  assert.ok(!asking.argv.includes(SKIP), `leaving Full access kept the flag: ${asking.argv.join(" ")}`);
  await card(crew).getByRole("button", { name: /^Allow/ }).click();
  await said(crew, "Reply 1: ask allowed").waitFor();
  await idle(crew, session);
});
