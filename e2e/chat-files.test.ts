// Files in the chat: a file a reply names is a chip only when it is there,
// looked for in the session's folder and in the folders the reply names; an
// `@` reaches folders, and into large ones git ignores.
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { after, before, test } from "node:test";
import type { Workspace } from "../src/lib/types.ts";
import { composerOf, launchCrew, newSession, sendInChat, waitFor, type Crew } from "./harness.ts";

let crew: Crew;
let workspace: Workspace;

before(async () => {
  crew = await launchCrew();
  await crew.request("state_set", {
    key: "providers:default",
    value: JSON.stringify({ provider: "claude", model: "", effort: "", access: "ask" }),
  });
  const repo = await crew.makeRepo("files", { ".gitignore": "reference/\n", "README.md": "# files\n" });
  // More than the index takes of a folder git ignores.
  for (const name of ["t3code", "zeron"]) {
    const dir = path.join(repo, "reference", name);
    await mkdir(dir, { recursive: true });
    await Promise.all(Array.from({ length: 700 }, (_, i) => writeFile(path.join(dir, `f${i}.ts`), "")));
  }
  workspace = await crew.addWorkspace(repo);
});

after(async () => {
  await crew?.close();
});

test("a bare file name is a chip when the folder the reply names holds it, and plain code when nothing does", async () => {
  const shots = path.join(crew.home, "shots");
  await mkdir(shots, { recursive: true });
  await writeFile(path.join(shots, "a.png"), "");
  await newSession(crew, workspace.id);

  await sendInChat(crew, `shots in \`${shots}/\`: \`a.png\` and \`missing.png\``);
  const reply = crew.window.locator('[data-message="assistant"]').filter({ hasText: "Reply 1:" });
  const chip = reply.locator("[data-file-ref]").filter({ hasText: "a.png" });
  await chip.waitFor();
  await reply.locator("[data-inline-code]").filter({ hasText: "missing.png" }).waitFor();
  assert.equal(await reply.locator("[data-file-ref]").count(), 1, "only the file that is there is a chip");

  // An image opens in the lightbox, from the folder the reply named.
  await chip.click();
  const lightbox = crew.window.getByRole("dialog", { name: "a.png" });
  await lightbox.waitFor();
  await crew.window.keyboard.press("Escape");
  await lightbox.waitFor({ state: "detached" });
});

test("`@` offers a folder git ignores, and the message sends it", async () => {
  const session = await newSession(crew, workspace.id);
  const field = composerOf(crew, session);
  await field.fill("look at @refer");
  const menu = crew.window.getByRole("listbox", { name: "Files" });
  const folder = menu.getByRole("option").filter({ hasText: "reference/" }).first();
  await folder.waitFor();
  // Tab goes into the folder: the mention stays `@reference/`, with no space after it.
  await field.press("Tab");
  assert.equal(await field.textContent(), "look at @reference/");
  // Into the folder: what it holds, read from disk.
  await menu.getByRole("option").filter({ hasText: "t3code/" }).first().waitFor();
  await field.press("End");
  await field.pressSequentially(" please");
  await waitFor(async () => (await menu.count()) === 0, { message: "the menu closes past the mention" });
  await sendInChat(crew, "look at @reference/ please");

  const cwd = workspace.path;
  const file = path.join(crew.home, ".claude/projects", cwd.replace(/[^a-zA-Z0-9]/g, "-"), `${session.id}.jsonl`);
  await waitFor(async () => (await readFile(file, "utf8").catch(() => "")).includes(path.join(cwd, "reference")), {
    message: "the folder goes with the message",
  });
});

test("a folder mentioned in a sent message opens in the explorer", async () => {
  const session = await newSession(crew, workspace.id);
  const field = composerOf(crew, session);
  await field.fill("look at @refer");
  await crew.window.getByRole("listbox", { name: "Files" }).getByRole("option").filter({ hasText: "reference/" }).first().click();
  await field.pressSequentially(" now");
  await sendInChat(crew, "look at @reference/ now");

  await crew.window.locator('[data-file-ref="reference/"]').filter({ visible: true }).last().click();
  const explorer = crew.window.getByRole("complementary", { name: "Explorer" });
  await explorer.getByText("t3code", { exact: true }).waitFor();
  await explorer.getByText("zeron", { exact: true }).waitFor();
});
