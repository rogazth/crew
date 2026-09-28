// A PDF opened from the project is the same PDF after its tab is left and come
// back to: its viewer stays where it was instead of loading the file again.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { launchCrew, MOD, pressChord, waitFor, type Crew } from "./harness.ts";

let crew: Crew;

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
    repos: [{ name: "app", files: { "docs/manual.pdf": onePagePdf(), "notes.md": "# Notes\n" } }],
  });
});

after(async () => {
  await crew?.close();
});

async function openFile(query: string, relative: string): Promise<void> {
  await pressChord(crew, `${MOD}+p`);
  const palette = crew.window.getByRole("dialog", { name: "Command palette" });
  await palette.getByRole("textbox", { name: "Search" }).fill(query);
  await palette.getByRole("button", { name: relative, exact: true }).click();
  await palette.waitFor({ state: "detached" });
}

/** The preview's guest and the PDF viewer's frame in it: a reload replaces either. */
const viewer = () =>
  crew.app.evaluate(({ webContents }) => {
    const guest = webContents.getAllWebContents().find((wc) => wc.getURL().startsWith("crew-file://"));
    const frame = guest?.mainFrame.framesInSubtree.find((f) => f.url.startsWith("chrome-extension://"));
    return guest && frame ? `${guest.id}/${frame.processId}:${frame.routingId}` : null;
  });

const tab = (name: string) => crew.window.locator('[data-tab-strip] [role="tab"]').filter({ hasText: name });
const settle = () => new Promise((resolve) => setTimeout(resolve, 1000));

test("a PDF is not loaded again when its tab is shown again", async () => {
  await openFile("manual", "docs/manual.pdf");
  await waitFor(async () => (await viewer()) !== null, { message: "the PDF opens in its viewer" });
  await settle();
  const first = await viewer();

  await openFile("notes", "notes.md");
  await crew.window.getByText("# Notes").or(crew.window.getByText("Notes")).first().waitFor();
  for (let round = 0; round < 3; round++) {
    await tab("manual.pdf").click();
    await settle();
    assert.equal(await viewer(), first, "the same viewer is back");
    await tab("notes.md").click();
    await settle();
  }
  await tab("manual.pdf").click();
  await settle();
  assert.equal(await viewer(), first, "the same viewer is back");
  assert.equal(await crew.window.locator("webview:visible").count(), 1, "only the PDF's guest is on screen");
});
