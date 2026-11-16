// A PDF opens in a page tab, straight from ⌘K's Files or dropped on the tab strip from
// anywhere on disk, and comes back after a restart. HTML's way there, through
// its editor, is in files.test.ts.
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { after, before, test } from "node:test";
import { launchCrew, openPalette, stripTabIds, waitFor, type Crew } from "./harness.ts";

let crew: Crew;
let repo: string;

/** A one-page PDF, offsets and all, so the viewer opens it without complaint. */
function onePagePdf(): string {
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    "<< /Length 44 >>\nstream\nBT /F1 24 Tf 40 100 Td (Hello PDF) Tj ET\nendstream",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let body = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((object, i) => {
    offsets.push(body.length);
    body += `${i + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = body.length;
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) body += `${String(offset).padStart(10, "0")} 00000 n \n`;
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return body;
}

before(async () => {
  crew = await launchCrew({
    repos: [
      {
        name: "app",
        files: {
          "docs/manual.pdf": onePagePdf(),
          "notes.md": "# Notes\n",
          "start.html": "<!doctype html><title>Start</title>",
        },
      },
    ],
  });
  repo = crew.workspaces[0]!.path;
});

after(async () => {
  await crew?.close();
});

async function openFile(query: string, relative: string): Promise<void> {
  await openPalette(crew, "Files");
  const palette = crew.window.getByRole("dialog", { name: "Command palette" });
  await palette.getByRole("textbox", { name: "Search" }).fill(query);
  await palette.getByRole("button", { name: relative, exact: true }).click();
  await palette.waitFor({ state: "detached" });
}

type FileGuest = { url: string; filesSession: boolean; viewer: boolean };

/** Every guest serving a file whose path ends with `suffix`, and whether it lives in the previews' session. */
const fileGuests = (suffix: string) =>
  crew.app.evaluate(
    ({ webContents, session }, suffix) =>
      webContents
        .getAllWebContents()
        .filter((wc) => wc.getURL().startsWith("crew-file://") && wc.getURL().endsWith(suffix))
        .map(
          (wc): FileGuest => ({
            url: wc.getURL(),
            filesSession: wc.session === session.fromPartition("crew-files"),
            viewer: wc.mainFrame.framesInSubtree.some((f) => f.url.startsWith("chrome-extension://")),
          }),
        ),
    suffix,
  );

const activeTabId = () =>
  crew.window.locator('[data-tab-strip] [role="tab"][aria-selected="true"]').getAttribute("data-tab-id");

/**
 * Drops files from disk on the tab strip the way Finder does: the window gets
 * a drop of real Files, which Electron maps back to their paths.
 */
async function dropOnStrip(files: string[]): Promise<void> {
  await crew.window.evaluate(() => {
    const input = document.createElement("input");
    input.type = "file";
    input.multiple = true;
    input.id = "e2e-drop-source";
    input.hidden = true;
    document.body.append(input);
  });
  await crew.window.setInputFiles("#e2e-drop-source", files);
  const box = await crew.window.locator("[data-tab-strip]").boundingBox();
  assert.ok(box, "the strip is on screen");
  await crew.window.evaluate(
    ({ x, y }) => {
      const input = document.getElementById("e2e-drop-source") as HTMLInputElement;
      const data = new DataTransfer();
      for (const file of Array.from(input.files ?? [])) data.items.add(file);
      input.remove();
      const target = document.elementFromPoint(x, y) ?? document.body;
      const fire = (type: string) =>
        target.dispatchEvent(
          new DragEvent(type, { dataTransfer: data, clientX: x, clientY: y, bubbles: true, cancelable: true }),
        );
      fire("dragenter");
      fire("dragover");
      fire("drop");
    },
    { x: box.x + box.width - 40, y: box.y + box.height / 2 },
  );
}

test("a PDF from ⌘K's Files opens in a page tab, in the previews' session", async () => {
  await openFile("manual", "docs/manual.pdf");
  await waitFor(async () => (await fileGuests("/docs/manual.pdf")).some((g) => g.viewer), {
    message: "the PDF opens in Chromium's viewer",
  });
  assert.equal(await activeTabId(), `browser:file:${repo}/docs/manual.pdf`);
  const [guest] = await fileGuests("/docs/manual.pdf");
  assert.ok(guest?.filesSession, "the page holds none of the pages' sign-ins");
  // It is a page: the browser's toolbar is over it, not the file viewer's header.
  await crew.window.getByRole("button", { name: "Back" }).first().waitFor();
  await crew.window.locator('[data-tab-strip] [role="tab"]').filter({ hasText: "manual.pdf" }).waitFor();

  // Opening it again comes back to the same tab.
  await openFile("notes", "notes.md");
  await openFile("manual", "docs/manual.pdf");
  const ids = await stripTabIds(crew);
  assert.equal(ids.filter((id) => id.endsWith("/docs/manual.pdf")).length, 1);
});

test("files dropped on the strip open, each where ⌘K's Files would open it", async () => {
  const outside = path.join(crew.home, "Downloads");
  await mkdir(outside, { recursive: true });
  const invoice = path.join(outside, "invoice.pdf");
  await writeFile(invoice, onePagePdf());
  await writeFile(path.join(repo, "todo.md"), "# Dropped todo\n");

  await dropOnStrip([invoice, path.join(repo, "todo.md")]);
  await waitFor(async () => (await stripTabIds(crew)).includes(`browser:file:${invoice}`), {
    message: "the PDF from outside the worktree opens in a page tab",
  });
  // The last one dropped is the one on screen.
  assert.equal(await activeTabId(), `file:${repo}/todo.md`);
  await crew.window.getByText("Dropped todo").first().waitFor();

  // The PDF's page loads once it is looked at, as any page opened behind does.
  await crew.window.locator('[data-tab-strip] [role="tab"]').filter({ hasText: "invoice.pdf" }).click();
  await waitFor(async () => (await fileGuests("/invoice.pdf")).some((g) => g.viewer && g.filesSession), {
    message: "it renders, served from its own folder",
  });
});

/** What a file's page says about itself, once its script has run. */
const pageTitles = (suffix: string) =>
  crew.app.evaluate(
    ({ webContents }, suffix) =>
      webContents
        .getAllWebContents()
        .filter((wc) => wc.getURL().startsWith("crew-file://") && wc.getURL().endsWith(suffix))
        .map((wc) => wc.getTitle()),
    suffix,
  );

test("a file: URL or a path pasted into the browser opens the file's page, its assets beside it", async () => {
  const report = path.join(crew.home, "scratch", "report");
  await mkdir(path.join(report, "assets"), { recursive: true });
  await writeFile(path.join(report, "index.html"), '<!doctype html><title>static</title><script src="assets/app.js"></script>');
  await writeFile(path.join(report, "assets", "app.js"), 'document.title = "Report ran";');
  await writeFile(path.join(report, "other page.html"), "<!doctype html><title>Other</title>");

  // A page tab to type into: the repo's notes, rendered.
  await openFile("start", "start.html");
  await crew.window.getByRole("button", { name: "Open in browser" }).click();
  await waitFor(async () => (await fileGuests("/start.html")).length > 0, { message: "a page tab is on screen" });
  const bar = crew.window.getByLabel("Address", { exact: true }).locator("visible=true");
  const enter = async (text: string) => {
    await bar.click();
    await bar.fill(text);
    await bar.dispatchEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
  };

  // The URL Chrome shows for a file outside any workspace.
  await enter(`file://${report}/index.html`);
  await waitFor(async () => (await pageTitles("/index.html")).includes("Report ran"), {
    message: "the page renders and its relative script loads",
  });
  assert.equal(await activeTabId(), `browser:file:${report}/index.html`);
  const [guest] = await fileGuests("/index.html");
  assert.ok(guest?.filesSession, "the page holds none of the pages' sign-ins");
  // The bar names the file on disk, not the preview's URL of the run.
  await waitFor(async () => (await bar.inputValue()) === `file://${report}/index.html`, {
    message: "the bar shows the file's own address",
  });

  // The address bar takes a bare path, spaces and all.
  await enter(`${report}/other page.html`);
  await waitFor(async () => (await pageTitles("/other%20page.html")).includes("Other"), {
    message: "the second file opens in a page of its own",
  });
  assert.equal(await activeTabId(), `browser:file:${report}/other page.html`);
  await waitFor(async () => (await bar.inputValue()) === `file://${report}/other%20page.html`, {
    message: "the bar shows the second file's address, encoded as Chrome would",
  });
});

test("a PDF's page tab comes back after a restart", async () => {
  await openFile("manual", "docs/manual.pdf");
  const before = await waitFor(async () => (await fileGuests("/docs/manual.pdf"))[0]?.url, {
    message: "the PDF is on screen before the quit",
  });
  crew = await crew.restart();
  await waitFor(async () => (await fileGuests("/docs/manual.pdf")).some((g) => g.viewer), {
    message: "the PDF renders again",
    timeout: 30_000,
  });
  assert.equal(await activeTabId(), `browser:file:${repo}/docs/manual.pdf`);
  const after = (await fileGuests("/docs/manual.pdf"))[0]?.url;
  assert.notEqual(after, before, "a new run serves the file at a URL of its own");
});
