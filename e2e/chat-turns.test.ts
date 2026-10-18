// What a chat session's row, tab and crewd's record say about it, read
// against what its CLI did: a session joins the sidebar with its first
// message and a blank one goes with its tab; a turn reads Working wherever the
// window is, Unread when it ends out of sight, and read stays read; the CLI's
// title names the session; and a `/clear` moves the session on to the CLI's
// new conversation. The fake claude's launch log and transcripts are the
// witnesses.
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
  sessions,
  storedStatus,
  waitFor,
  type Crew,
} from "./harness.ts";

const get = (crew: Crew, id: string) => crew.request<Session | null>("session_get", { id });

/** The row in the sidebar, under whatever name the session has now. */
async function rowOf(crew: Crew, session: Session) {
  return sessionRow(crew, (await get(crew, session.id))?.name ?? session.name);
}

/** A line of the chat on screen, by the whole of its text. */
function said(crew: Crew, text: string | RegExp) {
  const whole = typeof text === "string" ? new RegExp(`^${text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`) : text;
  return crew.window.locator("p:visible").filter({ hasText: whole });
}

async function idle(crew: Crew, session: Session): Promise<void> {
  await waitFor(async () => (await storedStatus(crew, session.id)) === "idle", { message: `${session.name} is idle again` });
}

/** The row's light and crewd's status agree: the light reads `label`, crewd stores `status`. */
async function reads(crew: Crew, session: Session, label: string, status: Session["status"]): Promise<true | string> {
  const [light, stored] = await Promise.all([lightIn(await rowOf(crew, session)), storedStatus(crew, session.id)]);
  return (light === label && stored === status) || `row reads ${light}, crewd stores ${stored}`;
}

async function becomes(crew: Crew, session: Session, label: string, status: Session["status"], timeout = 10_000) {
  let last: true | string = "";
  const ok = await waitFor(
    async () => {
      last = await reads(crew, session, label, status);
      return last === true;
    },
    { timeout },
  ).catch(() => false);
  assert.ok(ok, `${session.name} should read ${label} (crewd: ${status}); ${String(last)}`);
}

/** What the user said in the conversation `id` the fake claude keeps under `cwd`. */
async function heard(crew: Crew, cwd: string, id: string): Promise<string[]> {
  const file = path.join(crew.home, ".claude/projects", cwd.replace(/[^a-zA-Z0-9]/g, "-"), `${id}.jsonl`);
  const text = await readFile(file, "utf8").catch(() => "");
  return text
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { type?: string; message?: { content?: unknown } })
    .flatMap((record) => (record.type === "user" && typeof record.message?.content === "string" ? [record.message.content] : []));
}

async function closeTab(crew: Crew, session: Session, how: "button" | "chord"): Promise<void> {
  const tab = sessionTab(crew, session);
  if (how === "button") await tab.getByRole("button", { name: "Close tab" }).click();
  else {
    await tab.click();
    await pressChord(crew, `${MOD}+w`);
  }
  await tab.waitFor({ state: "detached" });
}

async function kept(crew: Crew, session: Session, why: string): Promise<void> {
  await holdsFor(2000, async () => (await get(crew, session.id)) !== null, `crewd deleted the session ${why}`);
}

type Banner = { title: string; body: string };

/** Takes over the banner channel: what the window asks to show is kept, not shown. */
async function recordBanners(crew: Crew): Promise<() => Promise<Banner[]>> {
  await crew.app.evaluate(({ ipcMain }) => {
    const shown: Banner[] = [];
    (globalThis as { banners?: Banner[] }).banners = shown;
    ipcMain.removeHandler("notify");
    ipcMain.handle("notify", (_event, banner: Banner) => {
      shown.push({ title: banner.title, body: banner.body });
      return "shown";
    });
  });
  return () => crew.app.evaluate(() => [...((globalThis as { banners?: Banner[] }).banners ?? [])]);
}

test("a chat joins the sidebar with its first message; closing a tab deletes a blank one and keeps a named or spoken one", async (t) => {
  let crew = await launchCrew();
  t.after(() => crew.close());
  const [workspace] = crew.workspaces;
  assert.ok(workspace);

  // Every row the sidebar ever draws, however briefly.
  await crew.window.evaluate(() => {
    const drawn = new Set<string>();
    (window as unknown as { drawnRows: Set<string> }).drawnRows = drawn;
    const note = () => {
      for (const row of document.querySelectorAll("[data-sidebar-panel] button[data-session]")) drawn.add(row.textContent ?? "");
    };
    new MutationObserver(note).observe(document.body, { childList: true, subtree: true, characterData: true });
  });
  const drawn = () => crew.window.evaluate(() => [...(window as unknown as { drawnRows: Set<string> }).drawnRows]);

  const spoken = await newSession(crew, workspace.id);
  await sessionTab(crew, spoken).waitFor();
  await holdsFor(1500, async () => (await sessionRow(crew, spoken.name).count()) === 0, "the blank session shows in the sidebar");
  assert.ok(!(await drawn()).some((text) => text.includes(spoken.name)), "the blank session flashed in the sidebar");
  await sendInChat(crew, "hello");
  await sessionRow(crew, spoken.name).waitFor({ timeout: 5000 });
  await said(crew, "Reply 1: hello").waitFor();
  await idle(crew, spoken);
  await holdsFor(1000, async () => (await sessionRow(crew, spoken.name).count()) === 1, "the row left once the turn ended");

  // Nothing said in it: gone with its tab, and never in the sidebar.
  const blank = await newSession(crew, workspace.id);
  await closeTab(crew, blank, "button");
  await waitFor(async () => (await get(crew, blank.id)) === null, { timeout: 5000, message: "crewd deletes the blank session" });
  assert.ok(!(await drawn()).some((text) => text.includes(blank.name)), "the blank session showed in the sidebar");

  // Nothing said in it either, but named: the name is worth keeping.
  const named = await newSession(crew, workspace.id);
  const label = `Scratch ${Date.now().toString(36)}`;
  await crew.request("session_rename", { id: named.id, name: label });
  await waitFor(async () => (await get(crew, named.id))?.name === label, { message: "crewd takes the name" });
  await closeTab(crew, named, "button");
  await kept(crew, named, "that the user named");

  // A turn happened: kept, closed by ⌘W.
  await closeTab(crew, spoken, "chord");
  await kept(crew, spoken, "that held a turn");

  crew = await crew.restart();
  for (const session of [named, spoken]) assert.ok(await get(crew, session.id), `${session.name} survives the restart`);
  assert.equal(await get(crew, blank.id), null, "the blank session came back");
  await sessionRow(crew, spoken.name).waitFor();
});

test("a turn reads Working across tab switches, Unread and rung when it ends out of sight, and Mark as Read stays read across a restart", async (t) => {
  let crew = await launchCrew();
  t.after(() => crew.close());
  const [workspace] = crew.workspaces;
  assert.ok(workspace);

  const s1 = await newSession(crew, workspace.id);
  await sendInChat(crew, "hello");
  await said(crew, "Reply 1: hello").waitFor();
  await idle(crew, s1);
  const s2 = await newSession(crew, workspace.id);
  await sendInChat(crew, "hello");
  await said(crew, "Reply 1: hello").waitFor();
  await idle(crew, s2);

  await sessionTab(crew, s1).click();
  await composerOf(crew, s1).waitFor();
  const banners = await recordBanners(crew);
  await sendInChat(crew, "work 6");
  await becomes(crew, s1, "Working", "working", 5000);

  // Away, back, away again, all mid-turn: it keeps reading Working throughout.
  for (const tab of [s2, s1, s2]) {
    await sessionTab(crew, tab).click();
    await holdsFor(1000, () => reads(crew, s1, "Working", "working"), `with ${tab.name} on screen, ${s1.name} stopped reading Working`);
  }

  // It ends while s2 is on screen: Unread, and the window rings with the reply, as a banner or, in front, a toast.
  await becomes(crew, s1, "Unread", "done", 15_000);
  const toasts = crew.window.locator(".fixed.right-4.bottom-4").filter({ hasText: "Reply 2: work 6" });
  await waitFor(async () => (await banners()).some((banner) => banner.body.includes("Reply 2: work 6")) || (await toasts.count()) > 0, {
    message: "the finished turn rings",
  });

  // The row's menu reads it, with s2 still on screen.
  await (await rowOf(crew, s1)).click({ button: "right", force: true });
  await crew.window.getByRole("menu").getByRole("menuitem", { name: "Mark as Read" }).click();
  await crew.window.getByRole("menu").waitFor({ state: "detached" });
  await becomes(crew, s1, "Idle", "idle", 5000);
  assert.equal(await sessionTab(crew, s2).getAttribute("aria-selected"), "true", "s2 stayed on screen");

  // Read stays read across a restart, with s1 out of sight so nothing reads it again.
  crew = await crew.restart();
  await (await rowOf(crew, s1)).waitFor();
  await holdsFor(3000, () => reads(crew, s1, "Idle", "idle"), `${s1.name} came back unread`);

  // Looking at an unread one reads it.
  await sessionTab(crew, s2).click();
  await composerOf(crew, s2).waitFor();
  await sessionTab(crew, s1).click();
  await composerOf(crew, s1).waitFor();
  await sendInChat(crew, "work 2");
  await becomes(crew, s1, "Working", "working", 5000);
  await sessionTab(crew, s2).click();
  await becomes(crew, s1, "Unread", "done", 15_000);
  await sessionTab(crew, s1).click();
  await becomes(crew, s1, "Idle", "idle", 5000);
});

test("the CLI's title names the row, the tab and crewd's session, on screen and off, across a restart", async (t) => {
  let crew = await launchCrew({ repos: ["app", "side"] });
  t.after(() => crew.close());
  const [main, side] = crew.workspaces;
  assert.ok(main && side);
  const stamp = Date.now().toString(36);
  const title = `Sort the invoices ${stamp}`;
  const aside = `Audit the ledger ${stamp}`;
  // The window asks crewd for each session's title every 15s.
  const named = (session: Session, name: string) =>
    waitFor(async () => (await get(crew, session.id))?.name === name, { timeout: 25_000, message: `crewd names the session "${name}"` });

  const s1 = await newSession(crew, main.id);
  await sendInChat(crew, `title ${title}`);
  await named(s1, title);
  await sessionRow(crew, title).waitFor({ timeout: 5000 });
  await sessionTab(crew, s1).filter({ hasText: title }).waitFor({ timeout: 5000 });
  await idle(crew, s1);

  // A session in `side` takes its name after the window has gone back to `app`.
  await pressChord(crew, `${MOD}+2`);
  await waitFor(async () => (await crew.request("active_workspace_get")) === side.id, { message: "side is on screen" });
  const s2 = await newSession(crew, side.id);
  await sendInChat(crew, `title ${aside}`);
  await pressChord(crew, `${MOD}+1`);
  await waitFor(async () => (await crew.request("active_workspace_get")) === main.id, { message: "app is on screen" });
  await named(s2, aside);
  assert.equal(await crew.request("active_workspace_get"), main.id, "side stayed out of sight while it was named");
  // Out of sight, its turn ends unread.
  await waitFor(async () => (await storedStatus(crew, s2.id)) === "done", { message: "the side session's turn ends" });

  crew = await crew.restart();
  assert.equal((await get(crew, s1.id))?.name, title);
  assert.equal((await get(crew, s2.id))?.name, aside);
  await sessionRow(crew, title).waitFor({ timeout: 5000 });
  await sessionTab(crew, s1).filter({ hasText: title }).waitFor({ timeout: 5000 });
  await pressChord(crew, `${MOD}+2`);
  await sessionRow(crew, aside).waitFor({ timeout: 5000 });
});

test("/clear moves the session to the CLI's new conversation: what follows goes there, a restart resumes it, and the session outlives its tab", async (t) => {
  const crew = await launchCrew();
  t.after(() => crew.close());
  const [workspace] = crew.workspaces;
  assert.ok(workspace);
  const cwd = workspace.path;

  const session = await newSession(crew, workspace.id);
  await sendInChat(crew, "remember 4817");
  await said(crew, "Reply 1: remember 4817").waitFor();
  await idle(crew, session);
  assert.equal((await get(crew, session.id))?.providerSessionId, session.id, "the session is bound to the conversation it named");

  await sendInChat(crew, "/clear");
  const moved = await waitFor(
    async () => {
      const bound = (await get(crew, session.id))?.providerSessionId;
      return bound && bound !== session.id && bound;
    },
    { message: "crewd binds the session to the CLI's new conversation" },
  );
  await idle(crew, session);

  await sendInChat(crew, "after the clear");
  await said(crew, /^Reply \d+: after the clear$/).waitFor();
  await idle(crew, session);
  assert.deepEqual(await heard(crew, cwd, moved), ["after the clear"], "the message after /clear went to the new conversation");
  assert.ok(!(await heard(crew, cwd, session.id)).includes("after the clear"), "the old conversation took the message after /clear");

  // /restart, and the next message resumes the new conversation, not the old.
  const field = composerOf(crew, session);
  await field.fill("/restart");
  await crew.window
    .getByRole("listbox", { name: "Commands" })
    .getByRole("option")
    .filter({ has: crew.window.getByText("/restart", { exact: true }) })
    .waitFor();
  await field.press("Enter");
  await said(crew, "Restarted. The CLI starts again with the next message.").waitFor();
  await sendInChat(crew, "where are we");
  await said(crew, "Reply 1: where are we").waitFor();
  await idle(crew, session);
  // Crew's own launch that asks a CLI to name a session reads none of the user's servers; it is not the session's.
  const launches = (await crew.claudeLaunches()).filter(
    (launch) => (launch.argv.includes(session.id) || launch.argv.includes(moved)) && !launch.argv.includes("--strict-mcp-config"),
  );
  const resumed = launches.at(-1)!.argv;
  assert.equal(resumed[resumed.indexOf("--resume") + 1], moved, resumed.join(" "));
  assert.deepEqual(await heard(crew, cwd, moved), ["after the clear", "where are we"]);

  // Its conversation is Crew's too: closing the tab keeps it.
  await closeTab(crew, session, "chord");
  await kept(crew, session, "that was cleared after a turn");
  assert.equal((await sessions(crew, workspace.id)).filter((row) => row.id === session.id).length, 1);
});
