// L1: a link the CLI prints in a terminal. By default it leaves for the
// default browser (the sandbox's fake `xdg-open`, which keeps what it was
// given). With Settings › Browser › "Open links in Crew" on, the same click
// opens a Crew page on it, which the local server sees load, and nothing goes
// out; Ctrl+Shift+click (⌘⇧ on macOS) still sends it out.
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import {
  externalOpens,
  holdsFor,
  launchCrew,
  MOD,
  newTerminal,
  pressChord,
  savedStrip,
  servePages,
  stripTabIds,
  typeInTerminal,
  waitFor,
  type Crew,
  type Modifier,
} from "./harness.ts";

/** The terminal on screen. */
function screen(crew: Crew) {
  return crew.window.locator(".xterm-screen").filter({ visible: true });
}

/** Whether the fake claude has answered with `url` in some transcript under the sandbox's ~/.claude. */
async function answered(crew: Crew, url: string): Promise<boolean> {
  const projects = path.join(crew.home, ".claude/projects");
  for (const dir of await readdir(projects).catch(() => [])) {
    for (const file of await readdir(path.join(projects, dir))) {
      if ((await readFile(path.join(projects, dir, file), "utf8")).includes(`"text":${JSON.stringify(url)}`)) return true;
    }
  }
  return false;
}

/**
 * Asks the fake claude for `url` and clicks it where it prints it, alone at
 * the top-left of a cleared screen, with `modifiers` held. The pointer goes
 * there once the transcript has the answer (the link before it was cleared
 * from the screen 300 ms earlier), and rests until xterm finds a link under
 * it and shows the hand.
 */
async function clickLink(crew: Crew, url: string, modifiers: Modifier[] = []): Promise<void> {
  const page = crew.window;
  await typeInTerminal(crew, `url ${url}`);
  await waitFor(() => answered(crew, url), { message: `the CLI answers with ${url}` });
  const box = await screen(crew).boundingBox();
  assert.ok(box, "a terminal is on screen");
  await waitFor(
    async () => {
      // Off the link and back on: xterm looks links up as the pointer moves.
      await page.mouse.move(box.x + box.width / 2, box.y + box.height - 4);
      await page.mouse.move(box.x + 4, box.y + 4, { steps: 2 });
      return page.locator(".xterm-cursor-pointer").filter({ visible: true }).count();
    },
    { interval: 100, message: "xterm finds a link under the pointer" },
  );
  for (const key of modifiers) await page.keyboard.down(key);
  await page.mouse.down();
  await page.mouse.up();
  for (const key of [...modifiers].reverse()) await page.keyboard.up(key);
}

/** The browser tabs on the strip on screen. */
async function browserTabs(crew: Crew): Promise<string[]> {
  return (await stripTabIds(crew)).filter((id) => id.startsWith("browser:"));
}

test("L1: a terminal link goes to the default browser, or to a Crew page when links open in Crew", async (t) => {
  const crew = await launchCrew();
  t.after(() => crew.close());
  const server = await servePages({ "/first": "First page", "/second": "Second page", "/third": "Third page" });
  t.after(() => server.close());
  const [workspace] = crew.workspaces;
  assert.ok(workspace);

  await newTerminal(crew, workspace.id);

  // Off, the default: the click leaves the app.
  const first = `${server.origin}/first`;
  await clickLink(crew, first);
  await waitFor(async () => (await externalOpens(crew)).includes(first), {
    message: "the link reaches the default browser",
  });
  // Held for a while: a Crew page opened as well would land a moment after the open.
  await holdsFor(
    1500,
    async () =>
      (JSON.stringify(await externalOpens(crew)) === JSON.stringify([first]) &&
        (await browserTabs(crew)).length === 0 &&
        server.requests.length === 0) ||
      `opens ${JSON.stringify(await externalOpens(crew))}, Crew pages ${JSON.stringify(await browserTabs(crew))}, loads ${JSON.stringify(server.requests)}`,
    "with links leaving the app, the click went somewhere besides the default browser, once",
  );

  // Settings › Browser › Open links in Crew.
  const page = crew.window;
  await pressChord(crew, `${MOD}+,`);
  await page.getByRole("button", { name: "Browser", exact: true }).click();
  const toggle = page.locator("label").filter({ hasText: "Open links in Crew" }).getByRole("switch");
  assert.equal(await toggle.getAttribute("aria-checked"), "false", "links start out leaving the app");
  await toggle.click();
  await waitFor(
    async () => {
      const raw = await crew.request<string | null>("state_get", { key: "browser:prefs" });
      return raw !== null && (JSON.parse(raw) as { openLinksInCrew?: boolean }).openLinksInCrew === true;
    },
    { message: "crewd keeps the setting on" },
  );
  await pressChord(crew, `${MOD}+,`);
  await screen(crew).waitFor();

  // On: the same kind of click opens a page here, and nothing leaves.
  const second = `${server.origin}/second`;
  await clickLink(crew, second);
  await waitFor(() => server.requests.includes("/second"), { message: "a Crew page loads the link" });
  const [tab] = await waitFor(async () => {
    const tabs = await browserTabs(crew);
    return tabs.length === 1 && tabs;
  }, { message: "the strip gains one browser tab" });
  assert.ok(tab);
  await waitFor(
    async () => {
      const strip = await crew.request<string | null>("state_get", { key: `tabs:${workspace.id}` });
      const saved = strip ? (JSON.parse(strip) as { tabs: { id: string; url?: string }[] }) : null;
      return saved?.tabs.find((entry) => entry.id === tab)?.url === second;
    },
    { message: "crewd's strip holds the page on the link's address" },
  );
  await holdsFor(
    1500,
    async () => JSON.stringify(await externalOpens(crew)) === JSON.stringify([first]) || JSON.stringify(await externalOpens(crew)),
    "with links in Crew, the click also went to the default browser",
  );

  // Ctrl+Shift+click (⌘⇧ on macOS) sends it out even so. Back to the terminal first.
  const strip = await savedStrip(crew, workspace.id);
  const terminalTab = strip?.ids.find((id) => id.startsWith("session:"));
  assert.ok(terminalTab, "the terminal's tab is still on the strip");
  await page.locator(`[data-tab-strip] [role="tab"][data-tab-id="${terminalTab}"]`).click();
  await screen(crew).waitFor();
  const third = `${server.origin}/third`;
  await clickLink(crew, third, [MOD, "Shift"]);
  await waitFor(async () => (await externalOpens(crew)).includes(third), {
    message: "the chord sends the link to the default browser",
  });
  await holdsFor(
    1500,
    async () =>
      (JSON.stringify(await externalOpens(crew)) === JSON.stringify([first, third]) &&
        JSON.stringify(await browserTabs(crew)) === JSON.stringify([tab]) &&
        !server.requests.includes("/third")) ||
      `opens ${JSON.stringify(await externalOpens(crew))}, Crew pages ${JSON.stringify(await browserTabs(crew))}, loads ${JSON.stringify(server.requests)}`,
    "the chord's link also opened in Crew, or went out twice",
  );
});
