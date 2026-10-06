// An HTML report on another machine renders as it does from this Mac: its
// bytes come through that machine's daemon, and the page runs its own scripts.
// The window's policy is the window's, not every page's.
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { addRemote, launchCrew, MOD, pressChord, waitFor, type RemoteDaemon } from "./harness.ts";

const REPORT = [
  "<!doctype html>",
  "<title>Static</title>",
  '<h1 id="out">static</h1>',
  "<script>document.title = 'Ran'; document.getElementById('out').textContent = 'ran';</script>",
  "",
].join("\n");

test("an HTML report on another machine runs its inline scripts", async () => {
  const crew = await launchCrew();
  let remote: RemoteDaemon | null = null;
  try {
    remote = await addRemote(crew, "devbox");
    const api = await crew.makeRepo("api");
    await writeFile(path.join(api, "report.html"), REPORT);
    const window = crew.window;

    await pressChord(crew, `${MOD}+o`);
    const machine = window.getByRole("option", { name: /devbox/ });
    await machine.waitFor();
    await waitFor(() => machine.evaluate((row) => /\d+ ms/.test(row.textContent ?? "")), { message: "the machine answers" });
    await window.keyboard.press(`${MOD}+2`);
    const field = window.getByLabel("Folder on devbox");
    await field.waitFor();
    await field.fill(`${api}/`);
    await window.keyboard.press(`${MOD}+Enter`);
    await window.locator(`nav[aria-label="Workspaces"][data-sidebar-rail] button[data-nav][aria-label="api"]`).waitFor();

    await pressChord(crew, `${MOD}+p`);
    const palette = window.getByRole("dialog", { name: "Command palette" });
    await palette.getByRole("textbox", { name: "Search" }).fill("report");
    await palette.getByRole("button", { name: "report.html", exact: true }).click();
    await palette.waitFor({ state: "detached" });
    await window.getByRole("button", { name: "Open in Browser" }).click();

    const preview = () =>
      crew.app.evaluate(async ({ webContents }) => {
        const guest = webContents.getAllWebContents().find((wc) => wc.getURL().startsWith("crew-file://"));
        return guest ? ((await guest.executeJavaScript("document.title")) as string) : null;
      });
    await waitFor(async () => (await preview()) !== null && (await preview()) !== "", { message: "the report loads" });
    await waitFor(async () => (await preview()) === "Ran", { message: "its inline script runs", timeout: 5_000 });
    assert.equal(await preview(), "Ran");

    // The window keeps its own policy.
    const inline = await window.evaluate(() => {
      const script = document.createElement("script");
      script.textContent = "document.body.dataset.inline = 'ran'";
      document.head.append(script);
      script.remove();
      return document.body.dataset.inline ?? null;
    });
    assert.equal(inline, null);
  } finally {
    await remote?.stop();
    await crew.close();
  }
});
