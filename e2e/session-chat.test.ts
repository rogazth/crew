// Sessions in Crew's chat. Settings › Appearance › "Sessions open in" draws a
// session's conversation as the chat over its terminal, whose CLI keeps
// running underneath: flipping the setting, or "Show terminal" on one tab,
// never restarts it. The chat reads the CLI's own history (the fake claude
// writes Claude's), types what is sent into the terminal, and answers what
// the CLI asks with the keys it expects, as its hooks report it.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { appendFile, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { after, before, test } from "node:test";
import type { Session } from "../src/lib/types.ts";
import {
  installFakeCodex,
  launchCrew,
  MOD,
  newTerminal,
  pressChord,
  sessionTab,
  typeInTerminal,
  waitFor,
  type Crew,
} from "./harness.ts";

let crew: Crew;

before(async () => {
  crew = await launchCrew();
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

function chatOf(session: Session) {
  return crew.window.locator(`[data-session-chat="${session.id}"]`);
}

/** Where the keys go: "composer" (the chat's), "terminal" (an xterm's), or what else has focus. */
function focusedIn(session: Session): Promise<string> {
  return crew.window.evaluate((id) => {
    const focused = document.activeElement;
    if (!(focused instanceof HTMLElement)) return "nothing";
    if (focused.closest(`[data-session-chat="${id}"]`) && focused.tagName === "TEXTAREA") return "composer";
    if (focused.closest(".xterm")) return "terminal";
    const label = focused.getAttribute("aria-label") ?? focused.textContent?.trim().slice(0, 40) ?? "";
    return `${focused.tagName.toLowerCase()} "${label}"`;
  }, session.id);
}

/** Waits for the keys to go to `where`; on a timeout, says where they went instead. */
async function keysGoTo(session: Session, where: "composer" | "terminal"): Promise<void> {
  await waitFor(
    async () => {
      const now = await focusedIn(session);
      if (now !== where) throw new Error(`the keys go to ${now}`);
      return true;
    },
    { message: `the ${where} takes the keys` },
  );
}

/** The records the fake claude wrote for its conversation `id`, run from `cwd`. */
async function records(cwd: string, id: string): Promise<Record<string, unknown>[]> {
  const file = path.join(crew.home, ".claude/projects", cwd.replace(/[^a-zA-Z0-9]/g, "-"), `${id}.jsonl`);
  const text = await readFile(file, "utf8").catch(() => "");
  return text
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

/** What the user typed, as the CLI recorded it. */
async function prompts(cwd: string, id: string): Promise<string[]> {
  return (await records(cwd, id)).flatMap((record) => {
    const message = record.message as { content?: unknown } | undefined;
    return record.type === "user" && typeof message?.content === "string" ? [message.content] : [];
  });
}

/** Types `text` in the chat's composer and sends it, once the CLI reads keys. */
async function sendFromChat(session: Session, text: string): Promise<void> {
  const chat = chatOf(session);
  const send = chat.getByRole("button", { name: "Send" });
  await chat.getByRole("textbox").fill(text);
  await waitFor(() => send.isEnabled(), { message: "the composer can send" });
  await chat.getByRole("textbox").press("Enter");
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

test("the chat is drawn over the running CLI, and flipping views never restarts it", async () => {
  const [workspace] = crew.workspaces;
  assert.ok(workspace);
  const session = await newTerminal(crew, workspace.id);
  await typeInTerminal(crew, "hello there");
  const launches = await crew.claudeLaunches();
  const cli = launches.at(-1);
  assert.ok(cli);

  await openSessionsIn("Chat");
  await chatOf(session).waitFor();
  await keysGoTo(session, "composer");
  // The conversation had in the terminal is the chat's.
  await chatOf(session).getByText("hello there").waitFor();
  await chatOf(session).getByText("Done.").waitFor();
  // Typed in the chat, kept in the chat: nothing reaches the CLI's own line.
  await crew.window.keyboard.type("a draft");

  // "Show terminal" turns this tab only; the setting stays.
  await chatOf(session).getByRole("button", { name: "Show terminal" }).click();
  await chatOf(session).waitFor({ state: "detached" });
  await keysGoTo(session, "terminal");
  assert.equal(await crew.request("state_get", { key: "sessions:view" }), "chat");
  await crew.window.getByRole("button", { name: "Back to chat" }).click();
  await chatOf(session).waitFor();
  assert.equal(await chatOf(session).getByRole("textbox").inputValue(), "a draft", "the draft waited in the chat");

  await openSessionsIn("Terminal");
  await chatOf(session).waitFor({ state: "detached" });
  await keysGoTo(session, "terminal");

  await openSessionsIn("Chat");
  await chatOf(session).waitFor();
  assert.equal((await crew.claudeLaunches()).length, launches.length, "no view change launched the CLI again");
  assert.ok(alive(cli.pid), "the CLI that started first is still the one running");
});

test("a CLI stopped on its trust prompt is named in the chat and answered in the terminal", async () => {
  const [workspace] = crew.workspaces;
  assert.ok(workspace);
  // The fake Claude opens on its trust prompt in a folder marked untrusted.
  await writeFile(path.join(workspace.path, ".untrusted"), "");
  const known = new Set((await crew.request<Session[]>("session_list", { workspaceId: workspace.id })).map((s) => s.id));
  await pressChord(crew, `${MOD}+n`);
  const session = await waitFor(
    async () =>
      (await crew.request<Session[]>("session_list", { workspaceId: workspace.id })).find(
        (row) => row.kind === "terminal" && !known.has(row.id),
      ),
    { message: "the new session reaches crewd" },
  );
  const chat = chatOf(session);
  await chat.getByText("Claude asks whether you trust this folder").waitFor();

  await chat.getByRole("button", { name: "Show terminal" }).click();
  await keysGoTo(session, "terminal");
  await crew.window.keyboard.press("ArrowDown");
  await crew.window.keyboard.press("Enter");
  await crew.window.getByRole("button", { name: "Back to chat" }).click();
  await chat.waitFor();
  await waitFor(async () => (await chat.getByText("Claude asks whether you trust this folder").count()) === 0, {
    message: "the notice goes once the CLI is past its prompt",
  });
});

test("a message sent from the chat lands in the CLI, and its reply comes back", async () => {
  const [workspace] = crew.workspaces;
  assert.ok(workspace);
  await crew.request("state_set", { key: "sessions:view", value: "chat" });
  await crew.reload();
  const session = await newTerminal(crew, workspace.id);
  const chat = chatOf(session);
  await chat.waitFor();

  await sendFromChat(session, "draft a plan");
  await chat.getByText("Queued").waitFor();
  await chat.getByText("Done.").waitFor();
  await waitFor(async () => (await chat.getByText("Queued").count()) === 0, { message: "the bubble is the CLI's turn now" });
  assert.deepEqual(await prompts(workspace.path, session.id), ["draft a plan"]);

  // Several lines go in as one message, not one per line.
  await sendFromChat(session, "first line\nsecond line");
  await waitFor(async () => (await prompts(workspace.path, session.id)).length === 2, { message: "the second message lands" });
  assert.equal((await prompts(workspace.path, session.id))[1], "first line\nsecond line");

  // Whatever was left typed on the CLI's own line does not go with it.
  await chat.getByRole("button", { name: "Show terminal" }).click();
  await typeInTerminalLine("stray words");
  await crew.window.getByRole("button", { name: "Back to chat" }).click();
  await sendFromChat(session, "clean line");
  await waitFor(async () => (await prompts(workspace.path, session.id)).at(-1) === "clean line", {
    message: "the CLI's line was cleared before the message",
  });
});

test("the CLI's permission prompt is answered from its card: Allow runs it, Deny stops the turn", async () => {
  const [workspace] = crew.workspaces;
  assert.ok(workspace);
  const session = await newTerminal(crew, workspace.id);
  const chat = chatOf(session);
  await chat.waitFor();

  await sendFromChat(session, "ask");
  const card = chat.getByText("Wants to run a command");
  await card.waitFor();
  await chat.getByRole("button", { name: /^Allow/ }).click();
  await card.waitFor({ state: "detached" });
  await waitFor(
    async () => (await records(workspace.path, session.id)).some((record) => JSON.stringify(record).includes('"is_error":false')),
    { message: "the CLI ran the tool" },
  );
  await chat.getByText("Done.").waitFor();

  await sendFromChat(session, "ask");
  await card.waitFor();
  await chat.getByRole("button", { name: /^Deny/ }).click();
  await chat.getByText("Interrupted").waitFor();
  await waitFor(async () => (await chat.getByRole("button", { name: "Send" }).count()) === 1, {
    message: "the turn is over: the composer sends again instead of stopping",
  });
});

test("a question from the CLI is answered from its card, in the CLI's own form", async () => {
  const [workspace] = crew.workspaces;
  assert.ok(workspace);
  const session = await newTerminal(crew, workspace.id);
  const chat = chatOf(session);
  await chat.waitFor();

  await sendFromChat(session, "question");
  await chat.getByText("Tea or coffee?").first().waitFor();
  await chat.getByRole("radio", { name: /Coffee/ }).or(chat.getByText("Coffee", { exact: true })).first().click();
  await chat.getByRole("button", { name: "Send answer" }).click();
  await chat.getByText("You picked Coffee.").waitFor();
  const answered = (await records(workspace.path, session.id)).find((record) => record.toolUseResult !== undefined);
  assert.deepEqual((answered?.toolUseResult as { answers?: unknown } | undefined)?.answers, { "Tea or coffee?": "Coffee" });
});

test("the composer's chips reach the CLI: access with ⇧Tab as it runs, effort by resuming it with the next message", async () => {
  const [workspace] = crew.workspaces;
  assert.ok(workspace);
  await crew.request("state_set", { key: "sessions:view", value: "chat" });
  await crew.request("state_set", {
    key: "providers:default",
    value: JSON.stringify({ provider: "claude", model: "", effort: "", access: "ask" }),
  });
  await crew.reload();
  const session = await newTerminal(crew, workspace.id);
  const chat = chatOf(session);
  await chat.waitFor();
  const modes = async () =>
    (await records(workspace.path, session.id)).flatMap((record) => (record.type === "user" ? [record.permissionMode] : []));

  await sendFromChat(session, "asking first");
  await chat.getByText("Done.").waitFor();
  assert.deepEqual(await modes(), ["default"]);
  const launched = (await crew.claudeLaunches()).length;

  // ⇧Tab in the composer moves the chip and Claude's own mode, with no restart.
  await chat.getByRole("textbox").press("Shift+Tab");
  await chat.getByRole("button", { name: "Access" }).getByText("Accept edits").waitFor();
  await waitFor(async () => (await crew.request<Session>("session_get", { id: session.id })).autonomy === "edits", {
    message: "the row keeps the access",
  });
  await sendFromChat(session, "editing now");
  await waitFor(async () => (await modes()).length === 2, { message: "the second message lands" });
  assert.deepEqual(await modes(), ["default", "acceptEdits"]);
  assert.equal((await crew.claudeLaunches()).length, launched, "⇧Tab restarted the CLI");

  // An effort waits for the next message, which starts the CLI again on its conversation.
  await chat.getByRole("button", { name: "Effort" }).click();
  await crew.window.getByRole("menuitemradio", { name: "High", exact: true }).click();
  await chat.getByText(/apply with your next message/).waitFor();
  await sendFromChat(session, "thinking harder");
  const relaunch = await waitFor(async () => (await crew.claudeLaunches())[launched], { message: "the CLI starts again" });
  assert.ok(relaunch.argv.join(" ").includes("--effort high"), relaunch.argv.join(" "));
  assert.ok(relaunch.argv.join(" ").includes("--permission-mode acceptEdits"), relaunch.argv.join(" "));
  assert.deepEqual(relaunch.argv.slice(relaunch.argv.indexOf("--resume"), relaunch.argv.indexOf("--resume") + 2), ["--resume", session.id]);
  assert.deepEqual(relaunch.argv.slice(-2), ["--", "thinking harder"]);
  await waitFor(async () => (await prompts(workspace.path, session.id)).at(-1) === "thinking harder", {
    message: "the message is the resumed CLI's first turn",
  });
  await waitFor(async () => (await chat.getByText(/apply with your next message/).count()) === 0, {
    message: "nothing is pending once it runs",
  });
});

test("Stop from the chat stops the CLI's turn", async () => {
  const [workspace] = crew.workspaces;
  assert.ok(workspace);
  const session = await newTerminal(crew, workspace.id);
  const chat = chatOf(session);
  await chat.waitFor();

  await sendFromChat(session, "work 20");
  const stop = chat.getByRole("button", { name: "Stop" });
  await stop.waitFor();
  await stop.click();
  await chat.getByText("Interrupted").waitFor();
  await chat.getByRole("button", { name: "Send" }).waitFor();
});

test("a /clear sent from the chat moves the chat to the CLI's new conversation", async () => {
  const [workspace] = crew.workspaces;
  assert.ok(workspace);
  const session = await newTerminal(crew, workspace.id);
  const chat = chatOf(session);
  await chat.waitFor();

  await sendFromChat(session, "before the clear");
  await chat.getByText("Done.").waitFor();
  await sendFromChat(session, "/clear");
  await waitFor(async () => (await chat.getByText("before the clear").count()) === 0, {
    message: "the chat leaves the conversation the CLI left",
  });
  await sendFromChat(session, "after the clear");
  await chat.getByText("Done.").waitFor();
  assert.equal(await chat.getByText("before the clear").count(), 0);
});

test("Claude's trust prompt is answered from the chat's card", async () => {
  const [workspace] = crew.workspaces;
  assert.ok(workspace);
  await writeFile(path.join(workspace.path, ".untrusted"), "");
  const known = new Set((await crew.request<Session[]>("session_list", { workspaceId: workspace.id })).map((s) => s.id));
  await pressChord(crew, `${MOD}+n`);
  const session = await waitFor(
    async () =>
      (await crew.request<Session[]>("session_list", { workspaceId: workspace.id })).find(
        (row) => row.kind === "terminal" && !known.has(row.id),
      ),
    { message: "the new session reaches crewd" },
  );
  const chat = chatOf(session);
  await chat.getByRole("button", { name: "Trust" }).click();
  await chat.getByRole("button", { name: "Trust" }).waitFor({ state: "detached" });
  await sendFromChat(session, "trusted now");
  await chat.getByText("Done.").waitFor();
});

/** Replies numbered `from` up to `to`, written into the CLI's conversation as though it had answered them. */
async function replies(cwd: string, id: string, from: number, to: number): Promise<void> {
  const file = path.join(crew.home, ".claude/projects", cwd.replace(/[^a-zA-Z0-9]/g, "-"), `${id}.jsonl`);
  const filler = "A line long enough to wrap, so that each reply stands several rows tall in the chat. ".repeat(3);
  let lines = "";
  for (let n = from; n < to; n += 1) {
    const text = [`Reply ${n}`, filler, filler, filler].join("\n\n");
    const message = { id: randomUUID(), role: "assistant", content: [{ type: "text", text }] };
    const entry = { type: "assistant", message, uuid: randomUUID(), sessionId: id, cwd, timestamp: new Date().toISOString() };
    lines += `${JSON.stringify(entry)}\n`;
  }
  await appendFile(file, lines);
}

/** How far below the top of `session`'s transcript the reply opening with `text` sits, or null while it is not drawn. */
function offsetOf(session: Session, text: string): Promise<number | null> {
  return crew.window.evaluate(
    ({ id, text }) => {
      const scroller = document.querySelector(`[data-session-chat="${id}"] [data-selectable="blocks"]`);
      const row = [...(scroller?.querySelectorAll("[data-block]") ?? [])].find((el) =>
        [...el.querySelectorAll("p")].some((p) => p.textContent === text),
      );
      if (!scroller || !row || scroller.clientHeight === 0) return null;
      return Math.round(row.getBoundingClientRect().top - scroller.getBoundingClientRect().top);
    },
    { id: session.id, text },
  );
}

/** Whether `session`'s transcript, shown or not, has the reply opening with `text`. */
function holds(session: Session, text: string): Promise<boolean> {
  return crew.window.evaluate(
    ({ id, text }) =>
      [...document.querySelectorAll(`[data-session-chat="${id}"] p`)].some((p) => p.textContent === text),
    { id: session.id, text },
  );
}

test("a chat tab keeps the reader's place behind another tab, and as replies arrive below it", async () => {
  const [workspace] = crew.workspaces;
  assert.ok(workspace);
  await crew.request("state_set", { key: "sessions:view", value: "chat" });
  await crew.reload();
  const session = await newTerminal(crew, workspace.id);
  const chat = chatOf(session);
  await chat.waitFor();
  await sendFromChat(session, "a long conversation");
  await chat.getByText("Done.").waitFor();
  await replies(workspace.path, session.id, 0, 30);
  await waitFor(() => holds(session, "Reply 29"), { message: "the replies reach the chat" });

  // Reading Reply 10, far above the bottom.
  await crew.window.evaluate((id) => {
    const scroller = document.querySelector(`[data-session-chat="${id}"] [data-selectable="blocks"]`);
    const row = [...(scroller?.querySelectorAll("[data-block]") ?? [])].find((el) =>
      [...el.querySelectorAll("p")].some((p) => p.textContent === "Reply 10"),
    );
    row?.scrollIntoView({ block: "start" });
  }, session.id);
  await waitFor(async () => (await offsetOf(session, "Reply 10")) === 0, { message: "Reply 10 is at the top" });

  // Replies landing below, on screen, leave it where it is.
  await replies(workspace.path, session.id, 30, 35);
  await waitFor(() => holds(session, "Reply 34"), { message: "more replies reach the chat" });
  assert.ok(Math.abs((await offsetOf(session, "Reply 10")) ?? Infinity) <= 1, "replies below moved the reader");

  // Another tab on screen, and more replies while this one is behind it.
  const other = await newTerminal(crew, workspace.id);
  await chatOf(other).waitFor();
  await replies(workspace.path, session.id, 35, 45);
  await waitFor(() => holds(session, "Reply 44"), { message: "the hidden chat keeps reading" });

  await sessionTab(crew, session).click();
  await waitFor(async () => (await offsetOf(session, "Reply 10")) !== null, { message: "the chat is back on screen" });
  assert.ok(
    Math.abs((await offsetOf(session, "Reply 10")) ?? Infinity) <= 1,
    `back on its tab, Reply 10 sits ${await offsetOf(session, "Reply 10")}px below the top`,
  );
});

/** Types a line into the terminal on screen without submitting it. */
async function typeInTerminalLine(text: string): Promise<void> {
  await waitFor(
    () =>
      crew.window.evaluate(() => {
        const shown = [...document.querySelectorAll<HTMLTextAreaElement>(".xterm-helper-textarea")].find(
          (area) => area.closest("[hidden]") === null && area.getClientRects().length > 0,
        );
        shown?.focus();
        return shown !== undefined && document.activeElement === shown;
      }),
    { message: "a terminal on screen takes the keys" },
  );
  await crew.window.keyboard.type(text);
}

/** ⌘T › "Codex session", with the fake Codex installed: the session crewd made. */
async function newCodexSession(): Promise<Session> {
  const [workspace] = crew.workspaces;
  assert.ok(workspace);
  await installFakeCodex(crew);
  const known = new Set((await crew.request<Session[]>("session_list", { workspaceId: workspace.id })).map((s) => s.id));
  await pressChord(crew, `${MOD}+t`);
  await crew.window.getByRole("button", { name: /^Codex session/ }).click();
  return waitFor(
    async () =>
      (await crew.request<Session[]>("session_list", { workspaceId: workspace.id })).find(
        (row) => row.provider === "codex" && !known.has(row.id),
      ),
    { message: "the Codex session reaches crewd" },
  );
}

test("a Codex session in the chat: trusted from the command line, its rollout read, its prompt answered", async () => {
  const [workspace] = crew.workspaces;
  assert.ok(workspace);
  await crew.request("state_set", { key: "sessions:view", value: "chat" });
  await crew.reload();
  const session = await newCodexSession();
  const chat = chatOf(session);
  await chat.waitFor();

  // No trust prompt stands in the way: the folder was trusted on the command line.
  await sendFromChat(session, "hello codex");
  await chat.getByText("Done.").waitFor();
  await waitFor(async () => (await chat.getByText("Queued").count()) === 0, { message: "the bubble is Codex's turn" });
  const launch = (await readFile(path.join(crew.home, "fake-codex.log"), "utf8")).trim().split("\n").at(-1);
  assert.ok(launch?.includes("trust_level"), "Codex was told to trust the folder");
  assert.ok(launch?.includes("hooks.state"), "Crew's hooks came trusted");

  // The permission Codex asks for reaches the chat through its hook, and y answers it.
  await sendFromChat(session, "ask");
  await chat.getByText("Wants to run a command").waitFor();
  assert.equal(await chat.getByRole("button", { name: /^Always allow/ }).count(), 0, "Codex offers no rule to keep");
  await chat.getByRole("button", { name: /^Allow/ }).click();
  await waitFor(async () => (await readFile(path.join(workspace.path, "asked.txt"), "utf8").then(() => true, () => false)), {
    message: "Codex ran the command",
  });
  await waitFor(async () => (await chat.getByText("Done.").count()) === 2, { message: "the turn after the approval ends" });

  // Esc stops a turn; the rollout's turn_aborted ends it in the chat.
  await sendFromChat(session, "ask");
  await chat.getByText("Wants to run a command").waitFor();
  await chat.getByRole("button", { name: /^Deny/ }).click();
  await chat.getByText("Interrupted").waitFor();
});

test("a new session in the chat moves to another provider before anyone talks to it, and stays on it after", async () => {
  const [workspace] = crew.workspaces;
  assert.ok(workspace);
  await installFakeCodex(crew);
  await crew.request("state_set", { key: "sessions:view", value: "chat" });
  await crew.request("state_set", {
    key: "providers:default",
    value: JSON.stringify({ provider: "claude", model: "", effort: "", access: "ask" }),
  });
  await crew.reload();
  const codexLaunches = async () =>
    (await readFile(path.join(crew.home, "fake-codex.log"), "utf8").catch(() => "")).trim().split("\n").filter(Boolean).length;
  const before = await codexLaunches();
  const session = await newTerminal(crew, workspace.id);
  const chat = chatOf(session);
  await chat.waitFor();
  const claude = (await crew.claudeLaunches()).at(-1);
  assert.ok(claude);

  await chat.locator('button[title^="Claude"]').click();
  const providers = crew.window.locator('[role="tablist"][aria-orientation="vertical"]');
  await providers.getByRole("tab", { name: /Codex/ }).click();
  await crew.window.getByRole("tabpanel").getByRole("button").first().click();

  const moved = await waitFor(
    async () => {
      const row = await crew.request<Session>("session_get", { id: session.id });
      return row.provider === "codex" ? row : undefined;
    },
    { message: "the row runs Codex" },
  );
  assert.match(moved.name, /^codex( \d+)?$/, "a placeholder name follows the provider");
  assert.equal(moved.providerSessionId ?? null, null);
  await waitFor(async () => (await codexLaunches()) > before, { message: "Codex starts in the session's terminal" });
  await waitFor(() => !alive(claude.pid), { message: "the Claude it ran is gone" });
  assert.equal(await crew.request("state_get", { key: "providers:default" }).then((raw) => JSON.parse(String(raw)).provider), "claude");

  await sendFromChat(session, "hello codex");
  await chat.getByText("Done.").waitFor();

  // It has a conversation now: the chip offers only its own provider's models.
  await chat.locator('button[title^="Codex"]').click();
  await crew.window.getByRole("tabpanel").waitFor();
  assert.equal(await providers.getByRole("tab").count(), 1);
  await crew.window.keyboard.press("Escape");
  await assert.rejects(
    crew.request("session_switch_provider", {
      id: session.id,
      cwd: workspace.path,
      provider: "claude",
      model: "",
      effort: "",
      autonomy: "ask",
    }),
    /already has a conversation/,
  );
});
