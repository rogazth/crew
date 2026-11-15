// A provider's login that lapsed: every chat whose turn it stopped shows the
// card to sign in. The login runs in a terminal tab, and once it is done each
// of those chats goes on with what it was asked, without it being sent again;
// a chat the login did not stop is left alone.
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { after, before, test } from "node:test";
import type { Block } from "../src/lib/blocks.ts";
import type { Session } from "../src/lib/types.ts";
import { chatLine, launchCrew, newSession, sendInChat, sessionRow, storedStatus, turnOver, waitFor, type Crew } from "./harness.ts";

let crew: Crew;

before(async () => {
  crew = await launchCrew();
});

after(async () => {
  await crew?.close();
});

const blocks = async (session: Session) =>
  (await crew.request<{ blocks: Block[] }>("transcript_tail", { sessionId: session.id, limit: 50 })).blocks;
const says = async (session: Session, text: string) => (await blocks(session)).some((block) => block.text === text);
const card = () => crew.window.locator("[data-auth-card]:visible");
const shot = async (name: string) => {
  if (process.env.E2E_SHOTS) await crew.window.screenshot({ path: path.join(process.env.E2E_SHOTS, `${name}.png`) });
};

test("a login picks up every chat it stopped, and leaves the others alone", async () => {
  const [workspace] = crew.workspaces;
  assert.ok(workspace);
  const fine = await newSession(crew, workspace.id);
  await sendInChat(crew, "all good");
  await chatLine(crew, "Reply 1: all good").waitFor();

  await writeFile(path.join(crew.home, "fake-claude-signed-out"), "");
  const first = await newSession(crew, workspace.id);
  await sendInChat(crew, "fix the build");
  await card().waitFor();
  const second = await newSession(crew, workspace.id);
  await sendInChat(crew, "run the tests");
  await card().waitFor();
  assert.match(await card().innerText(), /Claude is signed out[\s\S]*Sign in to continue/);
  await shot("1-signed-out");

  await card().getByRole("button", { name: "Sign in" }).click();
  await crew.window.locator('[data-tab-strip] [role="tab"]').filter({ hasText: "Sign in to Claude" }).waitFor();
  await waitFor(async () => (await crew.claudeLaunches()).some((launch) => launch.argv.join(" ") === "auth login"), {
    message: "the login runs as `claude auth login`",
  });

  for (const [session, asked] of [
    [second, "run the tests"],
    [first, "fix the build"],
  ] as const) {
    await waitFor(async () => (await says(session, "Signed in. Continuing.")) && (await says(session, `Reply 1: ${asked}`)), {
      message: `${asked}: the chat goes on after the login`,
      timeout: 20_000,
    });
    await waitFor(async () => !["working", "starting"].includes((await storedStatus(crew, session.id)) ?? ""), {
      message: `${asked}: the turn ends`,
    });
    const shown = (await blocks(session)).filter((block) => block.role === "user" && !block.hidden).map((block) => block.text);
    assert.deepEqual(shown, [asked], "the message shows once");
  }
  assert.equal(await says(fine, "Signed in. Continuing."), false, "a chat the login did not stop was touched");

  await sessionRow(crew, first).first().click({ force: true });
  await chatLine(crew, "Reply 1: fix the build").waitFor();
  await turnOver(crew);
  assert.equal(await card().count(), 0, "the card stays after the login");
  assert.equal(await chatLine(crew, "fix the build").count(), 1);
  await shot("2-first-picked-up");
});
