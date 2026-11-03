// A mermaid source that does not parse shows its error in the note and leaves
// nothing in <body>: mermaid's error diagram there once made the page taller
// than the window, and a scroll then took the tab strip off the top.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { launchCrew, MOD, noteEditor, pressChord, type Crew } from "./harness.ts";

let crew: Crew;

before(async () => {
  crew = await launchCrew({
    repos: [{ name: "app", files: { "broken.md": "# Broken\n\nText.\n\n```mermaid\nflowchart TD\n  A[broken -->\n```\n\nEnd.\n" } }],
  });
});

after(async () => {
  await crew?.close();
});

test("a diagram that does not parse leaves the page the height of the window and unscrollable", async () => {
  await pressChord(crew, `${MOD}+p`);
  const palette = crew.window.getByRole("dialog", { name: "Command palette" });
  await palette.getByRole("textbox", { name: "Search" }).fill("broken");
  await palette.getByRole("button", { name: "broken.md", exact: true }).click();
  await palette.waitFor({ state: "detached" });

  await noteEditor(crew).locator(".cm-md-mermaid[data-error]").waitFor();

  const page = await crew.window.evaluate(() => {
    const root = document.getElementById("root")!;
    const app = document.querySelector<HTMLElement>("[data-app]")!;
    document.documentElement.scrollTop = 34;
    document.body.scrollTop = 34;
    root.scrollTop = 34;
    return {
      leftovers: document.querySelectorAll('body > [id^="dcrew-mermaid"]').length,
      overflow: document.body.scrollHeight - document.body.clientHeight,
      appTop: app.getBoundingClientRect().top,
    };
  });
  assert.deepEqual(page, { leftovers: 0, overflow: 0, appTop: 0 });
});
