// C1: a code file in the code editor. Its unsaved edits live through a trip to
// another tab, as a note's do (M1), and meet the disk the same way when the tab
// comes back. Every edit is judged by what reaches the disk; the editor's text
// is read from the page only where the user would look at it.
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { holdsFor, launchCrew, MOD, pressChord, waitFor, type Crew } from "./harness.ts";

const APP = ["export function answer(): number {", "  return 42;", "}", ""].join("\n");
const UTIL = ["export const twice = (n: number) => n * 2;", ""].join("\n");

/** ⌘P, the query, and the file's row: its tab opens and its editor (a code one unless said) paints. */
async function openFile(crew: Crew, query: string, relative: string, shown = editor(crew, path.basename(relative))): Promise<void> {
  const page = crew.window;
  await pressChord(crew, `${MOD}+p`);
  const palette = page.getByRole("dialog", { name: "Command palette" });
  await palette.getByRole("textbox", { name: "Search" }).fill(query);
  await palette.getByRole("button", { name: relative, exact: true }).click();
  await palette.waitFor({ state: "detached" });
  await shown.waitFor();
}

/** The code editor on screen, by the file name it is labelled with. */
function editor(crew: Crew, name: string) {
  return crew.window.getByRole("textbox", { name, exact: true }).filter({ visible: true });
}

/** The note editor on screen, for a markdown file. */
function note(crew: Crew) {
  return crew.window.locator(".cm-content").filter({ visible: true });
}

/** The prompt a close asks before it loses something. */
function closePrompt(crew: Crew) {
  return crew.window.getByRole("alertdialog");
}

/** A file tab on the strip. */
function fileTab(crew: Crew, file: string) {
  return crew.window.locator(`[data-tab-strip] [role="tab"][data-tab-id="file:${file}"]`);
}

/** The file header's "Unsaved" mark. */
function unsaved(crew: Crew) {
  return crew.window.getByText("Unsaved", { exact: true }).filter({ visible: true });
}

/** The bar over a file whose disk and editor both changed. */
function changedOnDisk(crew: Crew) {
  return crew.window.getByRole("alert").filter({ hasText: "Changed on disk" }).filter({ visible: true });
}

/** Waits for the editor's text to hold `text`, and fails showing what it holds. */
async function shows(crew: Crew, name: string, text: string, message: string): Promise<void> {
  let last = "";
  const ok = await waitFor(async () => (last = await editor(crew, name).innerText()).includes(text), {
    timeout: 5000,
  }).catch(() => false);
  assert.ok(ok, `${message}: ${JSON.stringify(last.slice(-300))}`);
}

/** Waits for the file on disk to read `expected`, and fails showing what it holds. */
async function diskReads(file: string, expected: string, message: string): Promise<void> {
  let last = "";
  const same = await waitFor(async () => (last = await readFile(file, "utf8")) === expected, { timeout: 5000 }).catch(
    () => false,
  );
  if (!same) assert.equal(last, expected, message);
}

/** Types at the end of the file on screen. */
async function typeAtEnd(crew: Crew, name: string, text: string): Promise<void> {
  await editor(crew, name).click();
  await crew.window.keyboard.press(`${MOD}+End`);
  await crew.window.keyboard.type(text);
}

test("C1: a code file keeps its unsaved edits across a tab switch, and never loses a change made on disk", async (t) => {
  const crew = await launchCrew({
    repos: [{ name: "app", files: { "README.md": "# app\n", "src/app.ts": APP, "src/util.ts": UTIL } }],
  });
  t.after(() => crew.close());
  const [workspace] = crew.workspaces;
  assert.ok(workspace);
  const page = crew.window;
  const app = path.join(workspace.path, "src/app.ts");
  const util = path.join(workspace.path, "src/util.ts");
  const stamp = Date.now().toString(36);

  await openFile(crew, "util.ts", "src/util.ts");
  await openFile(crew, "app.ts", "src/app.ts");
  await fileTab(crew, app).waitFor();

  // An edit, then a trip to the other code file and back: the edit is still
  // in the editor, still unsaved, and nothing reached the disk.
  const typed = `// typed by the test ${stamp}`;
  await typeAtEnd(crew, "app.ts", typed);
  await unsaved(crew).waitFor();
  await fileTab(crew, util).click();
  await editor(crew, "util.ts").waitFor();
  await fileTab(crew, app).click();
  await editor(crew, "app.ts").waitFor();
  await shows(crew, "app.ts", typed, "the edit made before the tab went away is still in the editor");
  await unsaved(crew).waitFor();
  assert.equal(await readFile(app, "utf8"), APP, "the trip did not save the edit");

  // The editor's undo history came back too: ⌘Z takes the edit out, ⇧⌘Z puts it back.
  await editor(crew, "app.ts").click();
  await page.keyboard.press(`${MOD}+z`);
  const undone = await waitFor(async () => !(await editor(crew, "app.ts").innerText()).includes(typed), {
    timeout: 5000,
  }).catch(() => false);
  assert.ok(undone, "⌘Z after the trip undoes the edit made before it");
  await page.keyboard.press(`${MOD}+Shift+z`);
  await shows(crew, "app.ts", typed, "⇧⌘Z redoes it");

  // ⌘S writes exactly the text in the editor.
  let expected = `${APP}${typed}`;
  await editor(crew, "app.ts").click();
  await page.keyboard.press(`${MOD}+s`);
  await unsaved(crew).waitFor({ state: "detached" });
  await diskReads(app, expected, "the save writes the edit kept through the trip");

  // Another edit, the tab goes away, and someone writes the file meanwhile:
  // back on the tab the edit is there, the bar asks, and the disk is untouched.
  const away = `\n// edited while away ${stamp}`;
  await typeAtEnd(crew, "app.ts", away);
  await unsaved(crew).waitFor();
  await fileTab(crew, util).click();
  await editor(crew, "util.ts").waitFor();
  const outside = `${expected}\n// written outside Crew ${stamp}\n`;
  await writeFile(app, outside);
  await fileTab(crew, app).click();
  await editor(crew, "app.ts").waitFor();
  await changedOnDisk(crew).waitFor({ timeout: 5000 });
  await shows(crew, "app.ts", away.trim(), "the edit made before the tab went away is still in the editor");
  await unsaved(crew).waitFor();
  assert.equal(await readFile(app, "utf8"), outside, "coming back wrote nothing");

  // ⌘S while it asks writes nothing over the change made on disk.
  await editor(crew, "app.ts").click();
  await page.keyboard.press(`${MOD}+s`);
  await holdsFor(1000, async () => (await readFile(app, "utf8")) === outside, "⌘S wrote while the bar was up");

  // Overwrite: the edit wins, and is saved.
  const mine = `${expected}${away}`;
  await changedOnDisk(crew).getByRole("button", { name: "Overwrite", exact: true }).click();
  await diskReads(app, mine, "Overwrite writes the edit over the change made on disk");
  await changedOnDisk(crew).waitFor({ state: "detached" });
  await unsaved(crew).waitFor({ state: "detached" });
  expected = mine;

  // Nothing unsaved: a change on disk shows up by itself, when the tab comes
  // back and when the window does.
  let taken = `${expected}\n// taken while away ${stamp}\n`;
  await fileTab(crew, util).click();
  await editor(crew, "util.ts").waitFor();
  await writeFile(app, taken);
  await fileTab(crew, app).click();
  await shows(crew, "app.ts", `taken while away ${stamp}`, "coming back shows the disk's new text");
  taken = `${taken}// taken on focus ${stamp}\n`;
  await writeFile(app, taken);
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await shows(crew, "app.ts", `taken on focus ${stamp}`, "the window coming back shows the disk's new text");
  assert.equal(await changedOnDisk(crew).count(), 0, "nothing was unsaved, so nothing asks");
  assert.equal(await unsaved(crew).count(), 0);
  assert.equal(await readFile(app, "utf8"), taken);
});

// C2: closing a file tab with unsaved edits asks first. Cancel keeps the tab
// and the edit; Discard closes it and drops the edit everywhere, so the file
// opens again as the disk has it.
test("C2: closing a file with unsaved edits asks, and Discard drops the edits", async (t) => {
  const crew = await launchCrew({ repos: [{ name: "app", files: { "src/app.ts": APP, "src/util.ts": UTIL } }] });
  t.after(() => crew.close());
  const [workspace] = crew.workspaces;
  assert.ok(workspace);
  const app = path.join(workspace.path, "src/app.ts");
  const typed = `// never saved ${Date.now().toString(36)}`;

  await openFile(crew, "util.ts", "src/util.ts");
  await openFile(crew, "app.ts", "src/app.ts");
  await typeAtEnd(crew, "app.ts", typed);
  await unsaved(crew).waitFor();

  // ⌘W asks, naming the file; Cancel leaves the tab and the edit as they were.
  await pressChord(crew, `${MOD}+w`);
  const prompt = closePrompt(crew);
  await prompt.getByText('Close "app.ts"?', { exact: true }).waitFor();
  await prompt.getByText("Unsaved changes are lost.", { exact: true }).waitFor();
  await prompt.getByRole("button", { name: "Cancel" }).click();
  await prompt.waitFor({ state: "detached" });
  assert.equal(await fileTab(crew, app).count(), 1, "Cancel keeps the tab");
  await shows(crew, "app.ts", typed, "Cancel keeps the edit in the editor");
  await unsaved(crew).waitFor();

  // ⌘W again, Discard: the tab goes and nothing reached the disk.
  await pressChord(crew, `${MOD}+w`);
  await prompt.getByRole("button", { name: "Discard" }).click();
  await prompt.waitFor({ state: "detached" });
  await fileTab(crew, app).waitFor({ state: "detached" });
  assert.equal(await readFile(app, "utf8"), APP, "Discard wrote nothing");

  // Opened again, the file is the disk's, with nothing unsaved.
  await openFile(crew, "app.ts", "src/app.ts");
  await shows(crew, "app.ts", "return 42;", "the reopened file shows the disk");
  assert.ok(!(await editor(crew, "app.ts").innerText()).includes(typed), "the discarded edit is gone");
  await holdsFor(500, async () => (await unsaved(crew).count()) === 0, "the reopened file reads Unsaved");
});

// C3: "Close Other Tabs" over two files with unsaved edits, a code file and a
// note, asks once, counting both; confirming drops both edits.
test("C3: closing other tabs asks once for every unsaved file, and confirming drops their edits", async (t) => {
  const NOTES = "# Notes\n\nNothing yet.\n";
  const crew = await launchCrew({
    repos: [{ name: "app", files: { "NOTES.md": NOTES, "src/app.ts": APP, "src/util.ts": UTIL } }],
  });
  t.after(() => crew.close());
  const [workspace] = crew.workspaces;
  assert.ok(workspace);
  const page = crew.window;
  const app = path.join(workspace.path, "src/app.ts");
  const notes = path.join(workspace.path, "NOTES.md");
  const util = path.join(workspace.path, "src/util.ts");
  const stamp = Date.now().toString(36);

  await openFile(crew, "app.ts", "src/app.ts");
  await typeAtEnd(crew, "app.ts", `// app edit ${stamp}`);
  await unsaved(crew).waitFor();
  await openFile(crew, "NOTES.md", "NOTES.md", note(crew));
  await note(crew).click();
  await page.keyboard.press(`${MOD}+End`);
  await page.keyboard.type(`note edit ${stamp}`);
  await unsaved(crew).waitFor();
  await openFile(crew, "util.ts", "src/util.ts");

  await fileTab(crew, util).click({ button: "right" });
  await page.getByRole("menu").getByRole("menuitem", { name: "Close Other Tabs" }).click();
  const prompt = closePrompt(crew);
  await prompt.getByText("Close 2 tabs?", { exact: true }).waitFor();
  await prompt.getByText("2 files have unsaved changes", { exact: false }).waitFor();
  await prompt.getByRole("button", { name: "Close" }).click();
  await prompt.waitFor({ state: "detached" });
  await fileTab(crew, app).waitFor({ state: "detached" });
  await fileTab(crew, notes).waitFor({ state: "detached" });
  assert.equal(await fileTab(crew, util).count(), 1, "the tab the menu came from stays");
  assert.equal(await readFile(app, "utf8"), APP);
  assert.equal(await readFile(notes, "utf8"), NOTES);

  // Both open again as the disk has them.
  await openFile(crew, "NOTES.md", "NOTES.md", note(crew));
  await waitFor(async () => (await note(crew).innerText()).includes("Nothing yet."), { timeout: 5000 });
  assert.ok(!(await note(crew).innerText()).includes(`note edit ${stamp}`), "the note's edit is gone");
  await holdsFor(500, async () => (await unsaved(crew).count()) === 0, "the reopened note reads Unsaved");
  await openFile(crew, "app.ts", "src/app.ts");
  await shows(crew, "app.ts", "return 42;", "the reopened file shows the disk");
  assert.ok(!(await editor(crew, "app.ts").innerText()).includes(`app edit ${stamp}`), "the code edit is gone");
  await holdsFor(500, async () => (await unsaved(crew).count()) === 0, "the reopened file reads Unsaved");
});
