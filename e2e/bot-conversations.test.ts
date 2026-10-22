// Plan 2026-10-12 (decisions 8, 18): the letters a chat has with bots are a
// "N conversations" segment in its status line and a second group in the Work
// sheet. Enter opens the pair as a thread in place: one header, no composer.
// The session writes through `crew` from its own shell, as an agent does.
import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import type { Session } from "../src/lib/types.ts";
import { composerOf, launchCrew, newSession, sendInChat, waitFor, type Crew } from "./harness.ts";

const CREW = path.join(fileURLToPath(new URL("..", import.meta.url)), "target/debug/crew");

/** The window as it is, light and dark. */
async function shots(crew: Crew, name: string) {
  const dir = process.env.E2E_SHOTS;
  if (!dir) return;
  await crew.window.emulateMedia({ colorScheme: "light" });
  await crew.window.screenshot({ path: path.join(dir, `${name}.png`) });
  await crew.window.emulateMedia({ colorScheme: "dark" });
  await crew.window.screenshot({ path: path.join(dir, `${name}-dark.png`) });
  await crew.window.emulateMedia({ colorScheme: null });
}

test("a bot the chat wrote to is a conversation in the status line, and opens as a thread with no composer", async (t) => {
  const crew = await launchCrew();
  t.after(() => crew.close());
  const [main] = crew.workspaces;
  assert.ok(main);
  await newSession(crew, main.id);
  await sendInChat(crew, `!'${CREW}' bots create Reviewer --effort low --description "Review the diffs you are sent"`);
  await waitFor(
    async () => (await crew.request<Session[]>("session_list", { workspaceId: main.id })).some((row) => row.kind === "bot" && row.name === "Reviewer"),
    { timeout: 20_000, message: "the bot exists" },
  );
  await sendInChat(crew, `!'${CREW}' send Reviewer "please look at the diff on main"`);

  const segment = crew.window.getByRole("button", { name: "1 conversation", exact: true });
  await segment.waitFor({ timeout: 20_000 });

  assert.equal(await crew.window.getByText("Conversations", { exact: true }).count(), 0, "not in a bar");
  await segment.click();
  const sheet = crew.window.locator("[data-work-sheet]");
  await sheet.waitFor();
  const row = sheet.locator("[data-conversation]");
  assert.match(await row.innerText(), /Reviewer[\s\S]*please look at the diff/);
  assert.equal(await sheet.getByText("Conversations", { exact: true }).count(), 1, "the group is titled");
  await shots(crew, "status-line-conversation");

  await crew.window.keyboard.press("Enter");
  const view = crew.window.locator("[data-conversation-view]");
  await view.waitFor();
  await view.getByText("please look at the diff on main").waitFor();
  assert.match(await view.locator("[data-thread-header]").innerText(), /Reviewer[\s\S]*Conversation · 1 letter/);
  assert.equal(await composerOf(crew).count(), 0, "no composer");
  await shots(crew, "bot-conversation");

  await crew.window.keyboard.press("Escape");
  await view.waitFor({ state: "detached" });
  await composerOf(crew).waitFor();
});
