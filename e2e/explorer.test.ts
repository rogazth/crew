// X1: the explorer beside the tabs. ⌘⇧E shows the worktree's folders as they
// are on disk, what git ignores dimmed but there; ⌘⇧F finds text in the files
// ⌘P lists, a small ignored folder like `.ai/` included and node_modules not,
// and a result opens its file at the match.
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { after, before, test } from "node:test";
import { launchCrew, MOD, pressChord, waitFor, type Crew } from "./harness.ts";

let crew: Crew;
let repo = "";

const filler = (lines: number) => Array.from({ length: lines }, (_, index) => `const line${index} = ${index};`).join("\n");

before(async () => {
  crew = await launchCrew({
    repos: [
      {
        name: "app",
        files: {
          ".gitignore": ".ai/\nnode_modules/\n",
          "src/main.ts": `${filler(150)}\nexport const needle = "found";\n${filler(50)}\n`,
          "src/util/format.ts": "export const format = (text: string) => text;\n",
          ".ai/plan.md": "# Plan\n\nFind the needle before lunch.\n",
          "node_modules/pkg/index.js": "module.exports = 'needle';\n",
          "README.md": "# app\n",
        },
      },
    ],
  });
  repo = crew.workspaces[0]!.path;
});

after(async () => {
  await crew?.close();
});

/** With E2E_SHOTS set, a look at the window for whoever is changing it. */
async function shot(name: string): Promise<void> {
  const dir = process.env.E2E_SHOTS;
  if (dir) await crew.window.screenshot({ path: path.join(dir, `${name}.png`) });
}

const explorer = () => crew.window.getByRole("complementary", { name: "Explorer" });
const treeRow = (name: string) => explorer().getByRole("tree", { name: "Files" }).getByRole("treeitem", { name, exact: true });

test("X1: ⌘⇧E shows the folders on disk, ignored ones dimmed, and opens a file", async () => {
  const page = crew.window;
  await pressChord(crew, `${MOD}+Shift+e`);
  await treeRow("src").waitFor();
  // Folders first, then files, and what git ignores is there too.
  await waitFor(async () => (await explorer().getByRole("tree", { name: "Files" }).getByRole("treeitem").allInnerTexts()).length === 5, {
    message: "the root's five entries are listed",
  });
  const names = (await explorer().getByRole("tree", { name: "Files" }).getByRole("treeitem").allInnerTexts()).map((row) => row.trim());
  assert.deepEqual(names, [".ai", "node_modules", "src", ".gitignore", "README.md"]);
  assert.match((await treeRow("node_modules").getAttribute("class")) ?? "", /text-text-muted/, "an ignored folder is dimmed");

  await treeRow("src").click();
  await treeRow("util").waitFor();
  await treeRow("main.ts").click();
  await page.getByRole("tab", { name: /main\.ts/ }).waitFor();
  assert.equal(await treeRow("main.ts").getAttribute("aria-selected"), "true", "the open file is marked in the tree");

  // A file an agent writes shows up without a refresh.
  await writeFile(path.join(repo, "src/new.ts"), "export {};\n");
  await treeRow("new.ts").waitFor({ timeout: 8000 });

  // Keyboard: up to the folder, left closes it.
  await treeRow("main.ts").click();
  await page.keyboard.press("ArrowLeft");
  await page.keyboard.press("ArrowLeft");
  await waitFor(async () => (await treeRow("src").getAttribute("aria-expanded")) === "false", {
    message: "← on a file goes to its folder, and again closes it",
  });

  await shot("explorer-files");
});

test("X2: ⌘P finds a file in a small folder git ignores", async () => {
  const page = crew.window;
  await pressChord(crew, `${MOD}+p`);
  const palette = page.getByRole("dialog", { name: "Command palette" });
  await palette.getByRole("textbox", { name: "Search" }).fill("plan");
  await palette.getByRole("button", { name: ".ai/plan.md", exact: true }).waitFor({ timeout: 5000 });
  await page.keyboard.press("Escape");
  await palette.waitFor({ state: "detached" });
});

test("X3: ⌘⇧F finds text in the files, .ai included and node_modules not, and opens the match", async () => {
  const page = crew.window;
  await pressChord(crew, `${MOD}+Shift+f`);
  const box = explorer().getByRole("textbox", { name: "Search in files" });
  await waitFor(async () => (await box.evaluate((el) => el === document.activeElement)) === true, {
    message: "⌘⇧F puts the keyboard in the search box",
  });
  await box.fill("needle");
  const results = explorer().getByRole("tree", { name: "Search results" });
  await results.getByText("2 results in 2 files").or(explorer().getByText("2 results in 2 files")).waitFor({ timeout: 5000 });
  const files = (await results.locator('[aria-level="1"]').allInnerTexts()).map((row) => row.replace(/\s+/g, " ").trim());
  assert.equal(files.length, 2);
  assert.ok(files[0]!.startsWith("plan.md .ai"), files[0]);
  assert.ok(files[1]!.startsWith("main.ts src"), files[1]);

  await results.getByText('export const needle = "found";').click();
  await page.getByRole("tab", { name: /main\.ts/ }).waitFor();
  // Line 151 is on screen with the match selected: typing replaces it.
  const code = page.locator("[data-selectable]");
  await code.getByText('export const needle = "found";').waitFor({ timeout: 5000 });
  await waitFor(
    async () => {
      await page.keyboard.type("pin");
      if (await code.getByText('export const pin = "found";').isVisible()) return true;
      await page.keyboard.press(`${MOD}+z`);
      return false;
    },
    { timeout: 5000, interval: 250, message: "the match on line 151 is selected in the editor" },
  );
  await page.keyboard.press(`${MOD}+z`);

  // Case and whole word narrow it; a broken regex says why.
  await explorer().getByRole("button", { name: "Match case" }).click();
  await box.fill("Needle");
  await explorer().getByText("No results.").waitFor({ timeout: 5000 });
  await explorer().getByRole("button", { name: "Use regular expression" }).click();
  await box.fill("needle(");
  await explorer().getByText("Unclosed group").waitFor({ timeout: 5000 });

  await shot("explorer-search");
});

test("X4: ⌘⇧E and ⌘⇧F close their half when it shows, wherever the keyboard is", async () => {
  const page = crew.window;
  // Search shows from X3 with the keyboard in the editor: ⌘⇧F closes it.
  await page.locator("[data-selectable]").click();
  await pressChord(crew, `${MOD}+Shift+f`);
  await explorer().waitFor({ state: "detached" });

  await pressChord(crew, `${MOD}+Shift+e`);
  await treeRow("src").waitFor();
  await page.locator("[data-selectable]").click();
  await pressChord(crew, `${MOD}+Shift+e`);
  await explorer().waitFor({ state: "detached" });

  // From the other half it switches rather than closes.
  await pressChord(crew, `${MOD}+Shift+f`);
  await explorer().getByRole("textbox", { name: "Search in files" }).waitFor();
  await pressChord(crew, `${MOD}+Shift+e`);
  await treeRow("src").waitFor();
  await pressChord(crew, `${MOD}+Shift+e`);
  await explorer().waitFor({ state: "detached" });
});
