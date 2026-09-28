// F1: a file that is not text opens as a page. An HTML report renders with
// its stylesheet beside it, reloads when it is rewritten, and shows its source
// a toggle away; its links to the web open browser tabs. It reads the worktree
// it was opened from, but never a hidden file in it. A binary file with no
// preview offers Finder and the default app instead of an error.
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { after, before, test } from "node:test";
import { launchCrew, MOD, pressChord, servePages, stripTabIds, waitFor, type Crew, type PageServer } from "./harness.ts";

let crew: Crew;
let web: PageServer;
let repo = "";

const report = (title: string, origin: string) =>
  [
    "<!doctype html>",
    '<link rel="stylesheet" href="../assets/report.css">',
    `<title>${title}</title>`,
    `<h1>${title}</h1>`,
    `<a id="web" href="${origin}/docs">docs</a>`,
    "",
  ].join("\n");

before(async () => {
  web = await servePages({ "/docs": "Docs" });
  crew = await launchCrew({
    repos: [
      {
        name: "app",
        files: {
          "out/report.html": report("First run", web.origin),
          "assets/report.css": "h1 { color: rgb(1, 2, 3); }\n",
          ".env": "SECRET=hunter2\n",
        },
      },
    ],
  });
  repo = crew.workspaces[0]!.path;
});

after(async () => {
  await crew?.close();
  await web?.close();
});

async function openFile(query: string, relative: string): Promise<void> {
  await pressChord(crew, `${MOD}+p`);
  const palette = crew.window.getByRole("dialog", { name: "Command palette" });
  await palette.getByRole("textbox", { name: "Search" }).fill(query);
  await palette.getByRole("button", { name: relative, exact: true }).click();
  await palette.waitFor({ state: "detached" });
}

/** Runs `script` in the preview on screen, once its page has a title. */
function inPreview<T>(script: string): Promise<T> {
  return crew.app.evaluate(async ({ webContents }, code) => {
    const guest = webContents.getAllWebContents().find((wc) => wc.getURL().startsWith("crew-file://"));
    if (!guest) throw new Error("no preview");
    return (await guest.executeJavaScript(code)) as T;
  }, script);
}

const title = () => inPreview<string>("document.title");

test("an HTML report renders with the stylesheet beside it", async () => {
  await openFile("report", "out/report.html");
  await waitFor(async () => (await title()) === "First run", { message: "the report renders" });
  const color = await inPreview<string>("getComputedStyle(document.querySelector('h1')).color");
  assert.equal(color, "rgb(1, 2, 3)");
});

test("the report cannot read hidden files, nor leave through file:", async () => {
  const hidden = await inPreview<number>("fetch('/.env').then((r) => r.status)");
  assert.equal(hidden, 404);
  const escaped = await inPreview<number>("fetch('/%2e%2e/%2e%2e/etc/passwd').then((r) => r.status)");
  assert.equal(escaped, 404);
  const local = await inPreview<string>("fetch('file:///etc/passwd').then(() => 'read', () => 'refused')");
  assert.equal(local, "refused");
});

test("rewriting the report reloads it", async () => {
  await writeFile(path.join(repo, "out/report.html"), report("Second run", web.origin));
  await waitFor(async () => (await title()) === "Second run", { message: "the preview reloads" });
});

test("a link to the web opens a browser tab", async () => {
  const before = (await stripTabIds(crew)).length;
  await inPreview("document.getElementById('web').click()");
  await waitFor(async () => (await stripTabIds(crew)).length > before, { message: "a browser tab opens" });
  await waitFor(() => web.requests.includes("/docs"), { message: "the page loads in the tab" });
});

test("Source shows the report's HTML in the editor", async () => {
  const tab = crew.window.locator('[data-tab-strip] [role="tab"][data-tab-id^="file:"]').filter({ hasText: "report.html" });
  await tab.click();
  await crew.window.getByRole("radio", { name: "Source" }).click();
  const editor = crew.window.getByRole("textbox", { name: "report.html", exact: true }).filter({ visible: true });
  await waitFor(async () => (await editor.innerText()).includes("<title>Second run</title>"), {
    message: "the source shows",
  });
  await crew.window.getByRole("radio", { name: "Preview" }).click();
  await waitFor(async () => (await title()) === "Second run", { message: "the preview comes back" });
});

test("an image opens in the viewer, fitted, and zooms", async () => {
  // A 2×2 PNG: fitted it stays at its own size, never enlarged.
  const png = "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFklEQVR4nGP4z8DwnwEIGBgY/jMwAAAjBQP9jGqOQwAAAABJRU5ErkJggg==";
  await writeFile(path.join(repo, "dot.png"), Buffer.from(png, "base64"));
  await crew.reload();
  await openFile("dot.png", "dot.png");
  const image = crew.window.getByRole("img", { name: "dot.png" });
  await waitFor(() => image.evaluate((img: HTMLImageElement) => img.naturalWidth === 2), { message: "the image loads" });
  await crew.window.getByText("2 × 2", { exact: true }).waitFor();
  await crew.window.getByRole("button", { name: "Show at actual size" }).filter({ hasText: "Fit · 100%" }).waitFor();
  await crew.window.getByRole("button", { name: "Zoom In" }).click();
  await crew.window.getByRole("button", { name: "Fit to window" }).filter({ hasText: "150%" }).waitFor();
  assert.equal(await image.evaluate((img: HTMLImageElement) => img.getBoundingClientRect().width), 3);
});

test("a binary file offers the default app and Finder", async () => {
  // Not UTF-8, so the editor cannot take it. The window lists files as it loads.
  await writeFile(path.join(repo, "data.bin"), Buffer.from([0xff, 0xfe, 0x00, 0x81, 0x92]));
  await crew.reload();
  await openFile("data.bin", "data.bin");
  await crew.window.getByRole("button", { name: "Open in Default App" }).waitFor();
  await crew.window.getByRole("button", { name: "Show in Finder" }).waitFor();
});
