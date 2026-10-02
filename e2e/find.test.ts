// F1: find reaches every match. In the code editor ↵ in its search field and
// ⌘D bring each next match on screen; a PDF and an HTML file in their page
// tabs answer ⌘F with the find bar, which counts and steps through their matches.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { launchCrew, MOD, pressChord, waitFor, type Crew } from "./harness.ts";

let crew: Crew;

/** "needle" on the first line and on two lines far below it, filler between. */
const CODE = Array.from({ length: 300 }, (_, i) =>
  i === 0 || i === 149 || i === 289 ? `needle = ${i + 1};` : `const filler_${i + 1} = ${i + 1};`,
).join("\n");

const PAGE = `<!doctype html><title>Page</title><body>${Array.from({ length: 200 }, (_, i) =>
  i % 50 === 0 ? `<p>needle ${i}</p>` : `<p>line ${i}</p>`,
).join("")}</body>`;

/** A one-page PDF that says "needle" twice. */
function pdf(): string {
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    "<< /Length 68 >>\nstream\nBT /F1 18 Tf 20 100 Td (needle and needle) Tj ET\nendstream",
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
    repos: [{ name: "app", files: { "src/long.ts": CODE, "docs/page.html": PAGE, "docs/manual.pdf": pdf() } }],
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

const editor = () => crew.window.getByRole("textbox", { name: "long.ts", exact: true }).filter({ visible: true });

/** Whether the line reading `text` is painted inside the code editor's scrolled box. */
function lineOnScreen(text: string): Promise<boolean> {
  return crew.window.evaluate((text) => {
    const scroller = [...document.querySelectorAll<HTMLElement>("[data-selectable] .overflow-auto")].find(
      (el) => el.offsetParent !== null,
    );
    if (!scroller) return false;
    const box = scroller.getBoundingClientRect();
    const roots: ParentNode[] = [scroller];
    while (roots.length) {
      const root = roots.pop()!;
      for (const el of root.querySelectorAll<HTMLElement>("*")) {
        if (el.shadowRoot) roots.push(el.shadowRoot);
        if (el.dataset.line === undefined || el.textContent?.trim() !== text) continue;
        const r = el.getBoundingClientRect();
        if (r.height > 0 && r.top >= box.top && r.bottom <= box.bottom) return true;
      }
    }
    return false;
  }, text);
}

async function shows(text: string, message: string): Promise<void> {
  const ok = await waitFor(() => lineOnScreen(text), { timeout: 3000 }).catch(() => false);
  assert.ok(ok, message);
}

test("↵ in the code editor's search brings each next match on screen", async () => {
  await openFile("long", "src/long.ts");
  await editor().waitFor();
  await editor().click();
  await crew.window.keyboard.press(`${MOD}+ArrowUp`);
  await crew.window.keyboard.press(`${MOD}+f`);
  const field = crew.window.getByPlaceholder("Search").filter({ visible: true });
  await field.waitFor();
  await field.fill("needle");
  await shows("needle = 1;", "the first match is on screen");
  await field.press("Enter");
  await shows("needle = 150;", "↵ scrolls to the second match");
  await field.press("Enter");
  await shows("needle = 290;", "↵ scrolls to the third match");
  await field.press("Enter");
  await shows("needle = 1;", "↵ wraps to the first match");
  await field.press("Escape");
});

test("⌘D brings the match it adds on screen", async () => {
  await editor().click();
  await crew.window.keyboard.press(`${MOD}+ArrowUp`);
  await shows("needle = 1;", "the caret starts at the top");
  await crew.window.keyboard.press(`${MOD}+d`);
  await crew.window.keyboard.press(`${MOD}+d`);
  await shows("needle = 150;", "the second ⌘D scrolls to the match it adds");
  await crew.window.keyboard.press(`${MOD}+d`);
  await shows("needle = 290;", "the third ⌘D scrolls to the match it adds");
});

/** Opens the find bar over a file's page, types, and steps once. An HTML file gets there from its editor. */
async function findsIn(relative: string, query: string, first: string, second: string): Promise<void> {
  // The last page kept the keyboard; the palette's chord is the window's.
  await crew.window.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await openFile(relative.split("/").pop()!.split(".")[0]!, relative);
  if (relative.endsWith(".html")) await crew.window.getByRole("button", { name: "Open in Browser" }).click();
  await waitFor(async () => (await crew.window.locator("webview:visible").count()) > 0, {
    message: `${relative} opens in its page`,
  });
  await new Promise((resolve) => setTimeout(resolve, 1500));
  await crew.window.locator("webview:visible").focus();
  await pressChord(crew, `${MOD}+f`);
  const field = crew.window.getByRole("textbox", { name: "Find in page" }).filter({ visible: true });
  await field.waitFor({ timeout: 3000 });
  await field.fill(query);
  const bar = field.locator("..");
  await bar.getByText(first, { exact: true }).waitFor({ timeout: 5000 });
  await field.press("Enter");
  await bar.getByText(second, { exact: true }).waitFor({ timeout: 5000 });
  await field.press("Escape");
  await field.waitFor({ state: "detached" });
}

test("⌘F finds in an HTML file's page", async () => {
  await findsIn("docs/page.html", "needle", "1 of 4", "2 of 4");
});

test("⌘F finds in a PDF", async () => {
  await findsIn("docs/manual.pdf", "needle", "1 of 2", "2 of 2");
});
