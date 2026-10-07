// A Cursor session's CLI is started by the tab, and create-chat runs before the
// terminal exists. Leaving that tab while it is still coming up used to drop
// the spawn until the tab was shown again. It has to start in the background.
import assert from "node:assert/strict";
import { chmod, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import type { Session } from "../src/lib/types.ts";
import { launchCrew, MOD, newTerminal, pressChord, sessionTab, sessions, waitFor, type Crew } from "./harness.ts";

/** create-chat waits, so the tab can be left before the terminal is mounted. */
const CREATE_CHAT_MS = 2_000;

async function installSlowCursor(crew: Crew): Promise<void> {
  const file = path.join(crew.home, ".local/bin/cursor-agent");
  await writeFile(
    file,
    `#!${process.execPath}
"use strict";
const fs = process.getBuiltinModule("node:fs");
const path = process.getBuiltinModule("node:path");
const argv = process.argv.slice(2);
if (argv[0] === "models") process.exit(0);
if (argv[0] === "create-chat") {
  setTimeout(() => {
    process.stdout.write(process.getBuiltinModule("node:crypto").randomUUID() + "\\n");
    process.exit(0);
  }, ${CREATE_CHAT_MS});
  return;
}
fs.appendFileSync(
  path.join(process.env.HOME, "fake-cursor-agent.log"),
  JSON.stringify({ argv, at: Date.now() }) + "\\n",
);
process.stdout.write("cursor-agent ready\\r\\n");
process.stdin.resume();
process.stdin.on("end", () => process.exit(0));
`,
  );
  await chmod(file, 0o755);
}

async function launches(crew: Crew): Promise<string[][]> {
  const log = await readFile(path.join(crew.home, "fake-cursor-agent.log"), "utf8").catch(() => "");
  return log
    .split("\n")
    .filter(Boolean)
    .map((line) => (JSON.parse(line) as { argv: string[] }).argv);
}

async function selected(crew: Crew, session: Session): Promise<boolean> {
  return sessionTab(crew, session).getAttribute("aria-selected").then((value) => value === "true");
}

test("a Cursor session left while its CLI is starting still starts", async (t) => {
  const crew = await launchCrew();
  t.after(() => crew.close());
  const [workspace] = crew.workspaces;
  assert.ok(workspace);
  await installSlowCursor(crew);

  const other = await newTerminal(crew, workspace.id);
  const known = new Set((await sessions(crew, workspace.id)).map((session) => session.id));
  await pressChord(crew, `${MOD}+t`);
  await crew.window.getByRole("button", { name: /^Cursor session/ }).click();
  const cursor = await waitFor(
    async () =>
      (await sessions(crew, workspace.id)).find((session) => session.provider === "cursor" && !known.has(session.id)),
    { message: "the Cursor session reaches crewd" },
  );
  await sessionTab(crew, cursor).waitFor();
  await waitFor(async () => (await selected(crew, cursor)) || false, { message: "the Cursor tab is the one open" });
  await sessionTab(crew, other).click();
  await waitFor(async () => (await selected(crew, other)) || false, { message: "the other tab is in front" });

  const started = await waitFor(
    async () => {
      if (!(await selected(crew, other))) return false;
      const run = (await launches(crew)).at(-1);
      return run;
    },
    { timeout: 10_000, message: "cursor-agent starts while its tab is behind another" },
  );
  assert.ok(started.includes("--resume"), `cursor-agent resumed the chat it created: ${JSON.stringify(started)}`);
  assert.equal(await selected(crew, other), true, "the CLI started without coming back to its tab");
});
