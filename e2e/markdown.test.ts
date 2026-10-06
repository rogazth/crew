// M1 and M2: notes in the markdown editor. Every edit is judged by what
// reaches the disk (or crewd, for settings), and by what a relaunch brings
// back; the editor's own DOM only answers where the user would look at it.
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { holdsFor, launchCrew, MOD, pressChord, waitFor, type Crew } from "./harness.ts";

/** A 2×2 PNG, as a clipboard would hold a screenshot. */
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEUlEQVR4nGP4zwAEUOL/fwYAIu0E/FEgFfUAAAAASUVORK5CYII=";

const PLAN = [
  "# Plan",
  "",
  "What ships this week, and what waits for the next one.",
  "",
  "- [ ] ship",
  "",
  "Background lives in [[missing-note]], once someone writes it.",
  "",
].join("\n");

/** ⌘P, the query, and the file's row: its tab opens and its editor paints. */
async function openFile(crew: Crew, query: string, relative: string): Promise<void> {
  const page = crew.window;
  await pressChord(crew, `${MOD}+p`);
  const palette = page.getByRole("dialog", { name: "Command palette" });
  await palette.getByRole("textbox", { name: "Search" }).fill(query);
  await palette.getByRole("button", { name: relative, exact: true }).click();
  await palette.waitFor({ state: "detached" });
  await editor(crew).waitFor();
}

/** A note opens to read: its header's pencil turns it to editing. */
async function startEditing(crew: Crew): Promise<void> {
  await crew.window.getByRole("button", { name: "Edit", exact: true }).filter({ visible: true }).click();
  await editor(crew).and(crew.window.locator('[contenteditable="true"]')).waitFor();
}

/** The note editor on screen. */
function editor(crew: Crew) {
  return crew.window.locator(".cm-content").filter({ visible: true });
}

/** The file header's "Unsaved" mark. */
function unsaved(crew: Crew) {
  return crew.window.getByText("Unsaved", { exact: true }).filter({ visible: true });
}

/** The bar over a note whose disk and editor both changed. */
function changedOnDisk(crew: Crew) {
  return crew.window.getByRole("alert").filter({ hasText: "Changed on disk" }).filter({ visible: true });
}

/** Waits for the editor's text to hold `text` (or, with `present` false, to lose it). */
async function shows(crew: Crew, text: string, message: string, present = true): Promise<void> {
  let last = "";
  const ok = await waitFor(async () => (last = await editor(crew).innerText()).includes(text) === present, {
    timeout: 5000,
  }).catch(() => false);
  assert.ok(ok, `${message}: ${JSON.stringify(last.slice(-300))}`);
}

/** A file tab on the strip. */
function fileTab(crew: Crew, file: string) {
  return crew.window.locator(`[data-tab-strip] [role="tab"][data-tab-id="file:${file}"]`);
}

/** ⌘S with the note focused, and the header's word that it landed. */
async function save(crew: Crew): Promise<void> {
  await crew.window.keyboard.press(`${MOD}+s`);
  await unsaved(crew).waitFor({ state: "detached" });
}

/** Waits for the file on disk to read `expected`, and fails showing what it holds. */
async function diskReads(file: string, expected: string, message: string): Promise<void> {
  let last = "";
  const same = await waitFor(async () => (last = await readFile(file, "utf8")) === expected, { timeout: 5000 }).catch(
    () => false,
  );
  if (!same) assert.equal(last, expected, message);
}

test("M1: a note is edited, ticked, linked, pasted into and saved to disk, and never loses a change made on disk", async (t) => {
  const crew = await launchCrew({ repos: [{ name: "app", files: { "README.md": "# app\n", "notes/plan.md": PLAN } }] });
  t.after(() => crew.close());
  const [workspace] = crew.workspaces;
  assert.ok(workspace);
  const page = crew.window;
  const plan = path.join(workspace.path, "notes/plan.md");
  const stamp = Date.now().toString(36);

  await openFile(crew, "plan", "notes/plan.md");
  await fileTab(crew, plan).waitFor();
  await startEditing(crew);

  // Typing marks the note unsaved; ⌘S writes exactly what was typed.
  const typed = `Typed by the test ${stamp}`;
  await editor(crew).click();
  await page.keyboard.press(`${MOD}+End`);
  await page.keyboard.type(typed);
  await unsaved(crew).waitFor();
  assert.equal(await readFile(plan, "utf8"), PLAN, "nothing reaches the disk before a save");
  await save(crew);
  let expected = `${PLAN}${typed}`;
  await diskReads(plan, expected, "the save writes the note as typed");

  // The task's box flips the source; the save writes it.
  const box = editor(crew).locator('.cm-md-task[role="checkbox"]');
  assert.equal(await box.getAttribute("aria-checked"), "false");
  await box.click();
  await unsaved(crew).waitFor();
  await save(crew);
  expected = expected.replace("- [ ] ship", "- [x] ship");
  await diskReads(plan, expected, "the ticked task is saved as [x]");

  // A link to a note nobody wrote makes it, next to this one, and opens it.
  const missing = path.join(workspace.path, "notes/missing-note.md");
  assert.ok(!existsSync(missing));
  await editor(crew).locator('[data-wikilink="missing-note"]').click();
  await waitFor(() => existsSync(missing), { message: "the linked note is created on disk" });
  assert.equal(await readFile(missing, "utf8"), "", "the new note starts empty");
  await fileTab(crew, missing).and(page.locator('[aria-selected="true"]')).waitFor();
  await page.getByText("notes/missing-note.md", { exact: true }).filter({ visible: true }).waitFor();

  // A pasted image lands in attachments/ beside the note, byte for byte, and the note links it.
  await fileTab(crew, plan).click();
  await editor(crew).waitFor();
  await editor(crew).evaluate((element, base64) => {
    const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
    const clipboard = new DataTransfer();
    clipboard.items.add(new File([bytes], "image.png", { type: "image/png" }));
    element.dispatchEvent(new ClipboardEvent("paste", { clipboardData: clipboard, bubbles: true, cancelable: true }));
  }, PNG);
  const attachments = path.join(workspace.path, "notes/attachments");
  const [image] = await waitFor(async () => {
    const names = existsSync(attachments) ? await readdir(attachments) : [];
    return names.length > 0 && names;
  }, { message: "the pasted image is written under notes/attachments" });
  assert.ok(image);
  assert.deepEqual(await readFile(path.join(attachments, image)), Buffer.from(PNG, "base64"), "the file holds the pasted bytes");
  await unsaved(crew).waitFor();
  await save(crew);
  const linked = await readFile(plan, "utf8");
  assert.ok(linked.includes(`![](attachments/${image})`), `the saved note links the image: ${JSON.stringify(linked)}`);
  expected = linked;

  // An unsaved edit survives a trip to another tab and back, still unsaved.
  const pending = ` and more ${stamp}`;
  await editor(crew).click();
  await page.keyboard.press(`${MOD}+End`);
  await page.keyboard.type(pending);
  await unsaved(crew).waitFor();
  await fileTab(crew, missing).click();
  await page.getByText("notes/missing-note.md", { exact: true }).filter({ visible: true }).waitFor();
  await fileTab(crew, plan).click();
  await editor(crew).filter({ hasText: pending.trim() }).waitFor({ timeout: 5000 });
  await unsaved(crew).waitFor();
  assert.equal(await readFile(plan, "utf8"), expected, "the trip did not save the edit");

  // Someone else writes the note while an edit is unsaved (Q3). ⌘S writes
  // nothing over it: the edit stays, and a bar asks which one wins.
  const mine = `${expected}${pending}`;
  let outside = `${expected}Written outside Crew ${stamp}\n`;
  await writeFile(plan, outside);
  await editor(crew).click();
  await page.keyboard.press(`${MOD}+s`);
  await changedOnDisk(crew).waitFor({ timeout: 5000 });
  await holdsFor(1000, async () => (await readFile(plan, "utf8")) === outside, "the save wrote over the change made on disk");
  await shows(crew, pending.trim(), "the edit stays in the editor");
  await unsaved(crew).waitFor();
  // A second ⌘S while it asks writes nothing either.
  await page.keyboard.press(`${MOD}+s`);
  await holdsFor(1000, async () => (await readFile(plan, "utf8")) === outside, "⌘S wrote while the bar was up");
  // Overwrite: the edit wins, and is saved.
  await changedOnDisk(crew).getByRole("button", { name: "Overwrite", exact: true }).click();
  await diskReads(plan, mine, "Overwrite writes the edit over the change made on disk");
  await changedOnDisk(crew).waitFor({ state: "detached" });
  await unsaved(crew).waitFor({ state: "detached" });
  expected = mine;

  // Again, and Reload: the disk wins, and nothing is left unsaved.
  const dropped = ` dropped ${stamp}`;
  await editor(crew).click();
  await page.keyboard.press(`${MOD}+End`);
  await page.keyboard.type(dropped);
  await unsaved(crew).waitFor();
  outside = `${expected}Reloaded from disk ${stamp}\n`;
  await writeFile(plan, outside);
  await page.keyboard.press(`${MOD}+s`);
  await changedOnDisk(crew).getByRole("button", { name: "Reload", exact: true }).click();
  await changedOnDisk(crew).waitFor({ state: "detached" });
  await shows(crew, `Reloaded from disk ${stamp}`, "Reload shows the disk's text");
  await shows(crew, dropped.trim(), "Reload drops the edit", false);
  await unsaved(crew).waitFor({ state: "detached" });
  assert.equal(await readFile(plan, "utf8"), outside, "Reload writes nothing");
  expected = outside;

  // An unsaved edit, and the disk changes while its tab is away: back on the
  // tab, the edit is still there, the bar asks, and the disk is untouched.
  const away = ` edited while away ${stamp}`;
  await editor(crew).click();
  await page.keyboard.press(`${MOD}+End`);
  await page.keyboard.type(away);
  await unsaved(crew).waitFor();
  await fileTab(crew, missing).click();
  await page.getByText("notes/missing-note.md", { exact: true }).filter({ visible: true }).waitFor();
  outside = `${expected}Written outside Crew again ${stamp}\n`;
  await writeFile(plan, outside);
  await fileTab(crew, plan).click();
  await editor(crew).waitFor();
  await changedOnDisk(crew).waitFor({ timeout: 5000 });
  await shows(crew, away.trim(), "the edit made before the tab went away is still in the editor");
  await unsaved(crew).waitFor();
  assert.equal(await readFile(plan, "utf8"), outside, "coming back wrote nothing");
  await changedOnDisk(crew).getByRole("button", { name: "Reload", exact: true }).click();
  await changedOnDisk(crew).waitFor({ state: "detached" });
  expected = outside;

  // Nothing unsaved: a change on disk shows up by itself, when the tab comes
  // back and when the window does.
  outside = `${expected}Taken while away ${stamp}\n`;
  await fileTab(crew, missing).click();
  await page.getByText("notes/missing-note.md", { exact: true }).filter({ visible: true }).waitFor();
  await writeFile(plan, outside);
  await fileTab(crew, plan).click();
  await shows(crew, `Taken while away ${stamp}`, "coming back shows the disk's new text");
  outside = `${outside}Taken on focus ${stamp}\n`;
  await writeFile(plan, outside);
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await shows(crew, `Taken on focus ${stamp}`, "the window coming back shows the disk's new text");
  assert.equal(await changedOnDisk(crew).count(), 0, "nothing was unsaved, so nothing asks");
  assert.equal(await unsaved(crew).count(), 0);
  assert.equal(await readFile(plan, "utf8"), outside);
});

/** A section: its heading, then enough short lines that it outgrows the pane. */
const section = (heading: string, lines = 60) =>
  [heading, "", ...Array.from({ length: lines }, (_, n) => `${heading.replace(/^#+ /, "")} note ${n + 1}.`), ""].join("\n");

const GUIDE = [section("# Guide", 4), section("## Setup"), section("## Usage"), section("## Troubleshooting")].join("\n");

/** The outline's entry marked as the current section, or null when none is. */
async function currentSection(crew: Crew): Promise<string | null> {
  const marked = crew.window.locator('nav[aria-label="Outline"] [aria-current="location"]');
  return (await marked.count()) === 0 ? null : (await marked.first().innerText()).trim();
}

async function sectionIs(crew: Crew, heading: string, message: string): Promise<void> {
  let last: string | null = null;
  const ok = await waitFor(async () => (last = await currentSection(crew)) === heading, { timeout: 5000 }).catch(() => false);
  if (!ok) assert.equal(last, heading, message);
}

/** ⌘P for `query`: the rows it lists (after `settle` shows up, when given). */
async function paletteRows(crew: Crew, query: string, settle?: string): Promise<string[]> {
  const page = crew.window;
  await pressChord(crew, `${MOD}+p`);
  const palette = page.getByRole("dialog", { name: "Command palette" });
  await palette.getByRole("textbox", { name: "Search" }).fill(query);
  if (settle) await palette.getByRole("button", { name: settle, exact: true }).waitFor({ timeout: 5000 }).catch(() => {});
  const rows = (await palette.locator("button[data-index]").allInnerTexts()).map((row) => row.trim());
  await page.keyboard.press("Escape");
  await palette.waitFor({ state: "detached" });
  return rows;
}

test("M2: the outline follows the note and keeps its setting; ⌘P finds a small folder git ignores", async (t) => {
  let crew = await launchCrew({
    repos: [
      {
        name: "app",
        files: {
          "README.md": "# app\n",
          "notes/guide.md": GUIDE,
          ".gitignore": "vendor-docs/\n",
          "vendor-docs/vendored-api.md": "# Vendored API\n",
        },
      },
    ],
  });
  t.after(() => crew.close());
  const [workspace] = crew.workspaces;
  assert.ok(workspace);
  const page = crew.window;
  const guide = path.join(workspace.path, "notes/guide.md");
  assert.equal(await crew.git(workspace.path, "ls-files", "vendor-docs"), "", "git ignores vendor-docs");

  await openFile(crew, "guide", "notes/guide.md");
  const toggle = page.getByRole("button", { name: "Outline", exact: true });
  assert.equal(await toggle.getAttribute("aria-pressed"), "true", "notes open with their outline");
  const outline = page.locator('nav[aria-label="Outline"]');
  await outline.waitFor();
  assert.deepEqual(
    (await outline.getByRole("button").allInnerTexts()).map((text) => text.trim()),
    ["Guide", "Setup", "Usage", "Troubleshooting"],
  );

  // The outline marks the section at the top of the pane: as soon as the note
  // opens, then as the note moves (Q4).
  await sectionIs(crew, "Guide", "opened, the outline marks the section at the top of the pane");
  const scroller = page.locator(".cm-scroller").filter({ visible: true });
  const heading = editor(crew).locator(".cm-line").filter({ hasText: /^Usage$/ });
  await scroller.hover();
  await waitFor(
    async () => {
      // CodeMirror draws only the lines near the view: until the heading is
      // drawn, the wheel goes on down.
      const pane = await scroller.boundingBox();
      const line = (await heading.count()) > 0 ? await heading.boundingBox({ timeout: 1000 }) : null;
      if (!pane) return false;
      const off = line ? line.y - pane.y : 400;
      // The pane reads its section a few pixels below its top edge.
      if (off >= -20 && off <= 2) return true;
      await page.mouse.wheel(0, off + 4);
      return false;
    },
    { interval: 200, message: "the wheel brings Usage's heading to the top edge of the pane" },
  );
  await sectionIs(crew, "Usage", "scrolled to Usage, the outline marks Usage");
  await startEditing(crew);
  await editor(crew).click();
  await page.keyboard.press(`${MOD}+End`);
  await sectionIs(crew, "Troubleshooting", "at the end of the note, the outline marks the last section");
  await page.keyboard.press(`${MOD}+Home`);
  await sectionIs(crew, "Guide", "back at the top, the outline marks the first heading");

  // Git ignores vendor-docs, but a folder that small is notes, not a build: ⌘P finds it.
  assert.ok((await paletteRows(crew, "guide", "notes/guide.md")).includes("notes/guide.md"), "⌘P has indexed the workspace");
  assert.ok(
    (await paletteRows(crew, "vendored", "vendor-docs/vendored-api.md")).includes("vendor-docs/vendored-api.md"),
    "⌘P finds the file in the ignored folder",
  );

  // The outline off, then a restart: the setting comes back.
  await fileTab(crew, guide).click();
  await toggle.click();
  await outline.waitFor({ state: "detached" });
  await waitFor(async () => (await crew.request("state_get", { key: "markdown:outline" })) === "false", {
    message: "crewd keeps the outline off",
  });

  crew = await crew.restart();
  const page2 = crew.window;
  assert.equal(await crew.request("state_get", { key: "markdown:outline" }), "false");
  await fileTab(crew, guide).click();
  await editor(crew).waitFor();
  const reopened = page2.getByRole("button", { name: "Outline", exact: true });
  await waitFor(async () => (await reopened.getAttribute("aria-pressed")) === "false", {
    timeout: 5000,
    message: "the reopened note has its outline off",
  });
  assert.equal(await page2.locator('nav[aria-label="Outline"]').count(), 0, "and shows none");
  assert.ok(
    (await paletteRows(crew, "vendored", "vendor-docs/vendored-api.md")).includes("vendor-docs/vendored-api.md"),
    "after the restart ⌘P still finds it",
  );

  // A folder that is not a repo: its dotfiles are found too (35b5b96).
  const loose = path.join(crew.root, "loose");
  await mkdir(loose);
  await writeFile(path.join(loose, ".env.example"), "TOKEN=\n");
  await writeFile(path.join(loose, "notes.txt"), "loose\n");
  await crew.addWorkspace(loose);
  assert.ok(
    (await paletteRows(crew, "env", ".env.example")).includes(".env.example"),
    "⌘P finds a dotfile in a workspace git does not track",
  );
});

const LONG_WORD = "Supercalifragilisticexpialidocious";

const TABLES = [
  "# Tables",
  "",
  "| Name | Notes |",
  "| --- | --- |",
  `| beta | ${LONG_WORD} and a sentence long enough that it has to wrap between its words somewhere |`,
  "| alpha | short |",
  "",
  `| ${Array.from({ length: 8 }, (_, i) => `c${i + 1}`).join(" | ")} |`,
  `| ${Array.from({ length: 8 }, () => "---").join(" | ")} |`,
  `| ${Array.from({ length: 8 }, () => "incomprehensibilities").join(" | ")} |`,
  "",
  "End of note.",
  "",
].join("\n");

/** The table's lines in the saved note, each a row of trimmed cells. */
async function savedRows(file: string, first: string): Promise<string[][]> {
  const lines = (await readFile(file, "utf8")).split("\n");
  const start = lines.findIndex((line) => line.startsWith("|") && line.includes(first));
  assert.ok(start >= 0, `the note has a table with ${first}`);
  const rows: string[][] = [];
  for (let i = start; i < lines.length && lines[i]!.startsWith("|"); i++) {
    if (i === start + 1) continue;
    rows.push(lines[i]!.slice(1, -1).split(/(?<!\\)\|/).map((cell) => cell.trim()));
  }
  return rows;
}

test("M3: a note opens to read, its tables scroll instead of breaking words, and a table is edited as a table", async (t) => {
  const crew = await launchCrew({ repos: [{ name: "app", files: { "README.md": "# app\n", "notes/tables.md": TABLES } }] });
  t.after(() => crew.close());
  const [workspace] = crew.workspaces;
  assert.ok(workspace);
  const page = crew.window;
  const file = path.join(workspace.path, "notes/tables.md");

  // Opened, the note reads: nothing takes typing, and both tables are drawn.
  await openFile(crew, "tables", "notes/tables.md");
  assert.equal(await editor(crew).getAttribute("contenteditable"), "false", "a note opens to read");
  const tables = editor(crew).locator(".cm-md-table-wrap");
  await waitFor(async () => (await tables.count()) === 2, { message: "both tables render" });
  assert.equal(await editor(crew).locator(".cm-md-table-wrap[data-editable]").count(), 0, "reading, the tables take no edits");

  // A cell wraps between words, never inside one; the wide table scrolls.
  const layout = await page.evaluate((word) => {
    const cells = [...document.querySelectorAll<HTMLElement>(".cm-md-cell")];
    const overflowing = cells.filter((cell) => cell.scrollWidth > cell.clientWidth + 1).map((cell) => cell.textContent);
    const holder = cells.find((cell) => cell.textContent?.includes(word))!;
    const text = [...holder.childNodes].find((node) => node.textContent?.includes(word))!;
    const range = document.createRange();
    const at = text.textContent!.indexOf(word);
    range.setStart(text, at);
    range.setEnd(text, at + word.length);
    const scrolls = [...document.querySelectorAll<HTMLElement>(".cm-md-table-scroll")].map(
      (box) => box.scrollWidth > box.clientWidth,
    );
    return { overflowing, wordLines: range.getClientRects().length, scrolls };
  }, LONG_WORD);
  assert.deepEqual(layout.overflowing, [], "no cell's text runs out of its cell");
  assert.equal(layout.wordLines, 1, "the long word stays on one line");
  assert.deepEqual(layout.scrolls, [false, true], "only the table wider than the note scrolls");

  // ⌘E turns it to editing; the tables stay tables.
  await editor(crew).click({ position: { x: 5, y: 5 } });
  await pressChord(crew, `${MOD}+e`);
  await editor(crew).and(page.locator('[contenteditable="true"]')).waitFor();
  await waitFor(async () => (await editor(crew).locator(".cm-md-table-wrap[data-editable]").count()) === 2, {
    message: "editing, the tables take edits",
  });
  const first = tables.first();
  const cell = (text: string) => first.locator("td, th").filter({ hasText: text });
  const cellEditor = first.locator(".cm-md-cell-editing .cm-content");

  // A click opens the cell; Tab goes on to the next, a typed pipe is escaped, Escape leaves.
  await cell("alpha").click();
  await cellEditor.waitFor();
  await page.keyboard.press("End");
  await page.keyboard.type("-one");
  await page.keyboard.press("Tab");
  await page.keyboard.type(" a|b");
  await page.keyboard.press("Escape");
  await cellEditor.waitFor({ state: "detached" });
  await save(crew);
  assert.deepEqual((await savedRows(file, "Name")).at(-1), ["alpha-one", "short a\\|b"], "the cells are saved, the pipe escaped");
  const saved = await readFile(file, "utf8");
  assert.ok(saved.startsWith("# Tables\n\n| Name"), "the text around the table is untouched");
  assert.ok(saved.endsWith("End of note.\n"));

  // Undo in a cell undoes the note's last edit there, and nothing before it.
  await cell("alpha-one").click();
  await page.keyboard.press("End");
  await page.keyboard.type("zzz");
  await cellEditor.filter({ hasText: "alpha-onezzz" }).waitFor();
  await page.keyboard.press(`${MOD}+z`);
  await cellEditor.filter({ hasText: /^alpha-one$/ }).waitFor({ timeout: 5000 });
  await page.keyboard.press("Escape");

  // Visiting a cell without typing writes nothing.
  await save(crew);
  const untouched = await readFile(file, "utf8");
  await cell("beta").click();
  await cellEditor.waitFor();
  await page.keyboard.press("Tab");
  await page.keyboard.press("Escape");
  await holdsFor(300, async () => (await unsaved(crew).count()) === 0, "a visit marked the note unsaved");
  assert.equal(await readFile(file, "utf8"), untouched);

  // The column's grip sorts it.
  await cell("Name").hover();
  await first.locator(".cm-md-hot-col .cm-md-grip-col").click();
  await page.getByRole("menuitem", { name: "Sort A to Z" }).click();
  await save(crew);
  assert.deepEqual((await savedRows(file, "Name")).map((row) => row[0]), ["Name", "alpha-one", "beta"], "sorted by name");

  // A cell's menu drops its row.
  await cell("beta").click({ button: "right" });
  await page.getByRole("menuitem", { name: "Delete Row" }).click();
  await save(crew);
  assert.ok(!(await readFile(file, "utf8")).includes(LONG_WORD), "the row is gone");

  // The add button makes a row and opens its first cell.
  await first.hover();
  await first.locator(".cm-md-table-add-row").click();
  await cellEditor.waitFor();
  await page.keyboard.type("gamma");
  await page.keyboard.press("Escape");
  await save(crew);
  assert.deepEqual((await savedRows(file, "Name")).at(-1), ["gamma", ""], "the new row is saved");

  // A column dragged by its grip moves, alignment and all.
  await cell("Notes").hover();
  const grip = first.locator(".cm-md-hot-col .cm-md-grip-col");
  const from = (await grip.boundingBox())!;
  const to = (await cell("Name").boundingBox())!;
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(to.x + 4, to.y + to.height / 2, { steps: 6 });
  await page.mouse.up();
  await save(crew);
  assert.deepEqual((await savedRows(file, "Notes"))[0], ["Notes", "Name"], "the column moved first");

  // The arrow keys walk from the text into the table, and out below it.
  await editor(crew).locator(".cm-line").filter({ hasText: /^Tables$/ }).click();
  await page.keyboard.press("End");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowDown");
  await first.locator("th.cm-md-editing").filter({ hasText: "Notes" }).waitFor();
  await page.keyboard.press("Escape");

  // Edit as Markdown shows its source, pipes and all.
  await cell("gamma").click({ button: "right" });
  await page.getByRole("menuitem", { name: "Edit as Markdown" }).click();
  await editor(crew).locator(".cm-line").filter({ hasText: /^\| -+ \| -+ \|$/ }).waitFor();

  // A table from the command palette, at the end of the note.
  await editor(crew).locator(".cm-line").filter({ hasText: /^End of note\.$/ }).click();
  await pressChord(crew, `${MOD}+Shift+p`);
  const palette = page.getByRole("dialog", { name: "Command palette" });
  await palette.getByRole("textbox", { name: "Search" }).fill("Insert Table");
  await page.keyboard.press("Enter");
  await palette.waitFor({ state: "detached" });
  await editor(crew).locator(".cm-md-cell-editing .cm-content").waitFor();
  await page.keyboard.type("made");
  await page.keyboard.press("Escape");
  await save(crew);
  assert.deepEqual((await savedRows(file, "made"))[0], ["made", "", ""], "the inserted table is saved");

  // ⌘E back to reading writes nothing.
  const before = await readFile(file, "utf8");
  await pressChord(crew, `${MOD}+e`);
  await editor(crew).and(page.locator('[contenteditable="false"]')).waitFor();
  assert.equal(await unsaved(crew).count(), 0);
  assert.equal(await readFile(file, "utf8"), before);
});
