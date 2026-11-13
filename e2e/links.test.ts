// L1: a link the CLI prints in a terminal. By default it leaves for the
// default browser (the sandbox's fake `xdg-open`, which keeps what it was
// given). With Settings › General › "Open links in Crew" on, the same click
// opens a Crew page on it, which the local server sees load, and nothing goes
// out; Ctrl+Shift+click (⌘⇧ on macOS) still sends it out.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  composerOf,
  externalOpens,
  holdsFor,
  launchCrew,
  MOD,
  openShell,
  pressChord,
  savedStrip,
  servePages,
  sessions,
  startChat,
  stripTabIds,
  terminalOnLinkIn,
  terminalScreenIn,
  turnOver,
  typeInTerminal,
  waitFor,
  type Crew,
  type Modifier,
} from "./harness.ts";

/** The terminal on screen. */
function screen(crew: Crew) {
  return terminalScreenIn(crew.window).filter({ visible: true });
}

/**
 * Has the shell print `url` alone at the top-left of a cleared screen, and
 * clicks it with `modifiers` held. The pointer rests there until xterm finds a
 * link under it and shows the hand.
 */
async function clickLink(crew: Crew, url: string, modifiers: Modifier[] = []): Promise<void> {
  const page = crew.window;
  await typeInTerminal(crew, `clear; printf '%s\\n' '${url}'`);
  const box = await screen(crew).boundingBox();
  assert.ok(box, "a terminal is on screen");
  await waitFor(
    async () => {
      // Off the link and back on: xterm looks links up as the pointer moves.
      await page.mouse.move(box.x + box.width / 2, box.y + box.height - 4);
      await page.mouse.move(box.x + 4, box.y + 4, { steps: 2 });
      return terminalOnLinkIn(page).filter({ visible: true }).count();
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

  await openShell(crew);

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

  // Settings › General › Open links in Crew.
  const page = crew.window;
  await pressChord(crew, `${MOD}+,`);
  await page.getByRole("button", { name: "General", exact: true }).click();
  const toggle = page.locator('[data-setting="links-in-crew"]').getByRole("switch");
  assert.equal(await toggle.getAttribute("aria-checked"), "false", "links start out leaving the app");
  await toggle.click();
  await waitFor(
    async () => {
      const raw = await crew.request<string | null>("settings_get", { key: "browser:prefs" });
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
  // The page takes the keyboard while it loads: the bar neither takes it nor offers suggestions.
  await holdsFor(
    1500,
    async () => {
      const focused = await page.evaluate(() => document.activeElement?.getAttribute("aria-label") ?? null);
      const offered = await page.getByRole("option").count();
      return (focused !== "Address" && offered === 0) || `focus on ${focused}, ${offered} suggestions shown`;
    },
    "a link's page put the keyboard in the address bar",
  );
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
  const terminalTab = strip?.ids.find((id) => id.startsWith("stub:terminal:"));
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

/** Settings › General › Open links in Crew, on, and back to what was on screen. */
async function linksInCrew(crew: Crew): Promise<void> {
  const page = crew.window;
  await pressChord(crew, `${MOD}+,`);
  await page.getByRole("button", { name: "General", exact: true }).click();
  await page.locator('[data-setting="links-in-crew"]').getByRole("switch").click();
  await waitFor(
    async () => {
      const raw = await crew.request<string | null>("settings_get", { key: "browser:prefs" });
      return raw !== null && (JSON.parse(raw) as { openLinksInCrew?: boolean }).openLinksInCrew === true;
    },
    { message: "crewd keeps the setting on" },
  );
  await pressChord(crew, `${MOD}+,`);
}

// L2: with links in Crew, ⌘-click (Ctrl off macOS) on a chat's link opens its
// page behind, as a browser does: the chat stays on screen with the keyboard
// where it was. A plain click still brings the page up.
test("L2: ⌘-click on a chat link opens its Crew page behind the chat", async (t) => {
  const crew = await launchCrew();
  t.after(() => crew.close());
  const server = await servePages({ "/behind": "Behind page", "/front": "Front page" });
  t.after(() => server.close());
  const [workspace] = crew.workspaces;
  assert.ok(workspace);
  const page = crew.window;

  await linksInCrew(crew);
  const behind = `${server.origin}/behind`;
  const front = `${server.origin}/front`;
  const session = await startChat(crew, `see ${behind} or ${front}`, () => sessions(crew, workspace.id));
  await turnOver(crew);
  const reply = page.locator("[data-message]:visible").filter({ hasText: "Reply 1:" });
  const link = (url: string) => reply.locator(`a[data-streamdown="link"][href="${url}"]`);
  await link(behind).waitFor();

  const chatTab = await waitFor(async () => (await savedStrip(crew, workspace.id))?.activeId, {
    message: "the chat's tab is on screen",
  });
  assert.ok(chatTab.includes(session.id), "the chat is the tab on screen");
  // The keyboard in the chat's field; the click hands it to the link, still in the transcript.
  await composerOf(crew, session).click();
  const focusMark = () =>
    page.evaluate((url) => {
      const el = document.activeElement;
      if (el?.closest("[data-message]") && el.getAttribute("href") === url) return "link";
      return el?.closest("form[data-session]")?.getAttribute("data-session") ?? el?.tagName ?? null;
    }, behind);
  assert.equal(await focusMark(), session.id);

  await link(behind).click({ modifiers: [MOD] });
  const [tab] = await waitFor(async () => {
    const tabs = await browserTabs(crew);
    return tabs.length === 1 && tabs;
  }, { message: "the strip gains one browser tab" });
  assert.ok(tab);
  await holdsFor(
    1500,
    async () => {
      const strip = await savedStrip(crew, workspace.id);
      const focus = await focusMark();
      const shown = await reply.isVisible();
      return (strip?.activeId === chatTab && focus === "link" && shown) || `on screen ${strip?.activeId}, focus on ${focus}, reply shown ${shown}`;
    },
    "the ⌘-clicked page took the screen or the keyboard from the chat",
  );
  const strip = await savedStrip(crew, workspace.id);
  assert.ok(strip);
  assert.equal(strip.ids.indexOf(tab), strip.ids.indexOf(chatTab) + 1, "the page lands beside the chat");
  assert.deepEqual(await externalOpens(crew), [], "nothing left the app");

  // A plain click brings its page up.
  await link(front).click();
  const opened = await waitFor(async () => {
    const tabs = await browserTabs(crew);
    return tabs.length === 2 && tabs.find((id) => id !== tab);
  }, { message: "the strip gains a second browser tab" });
  await waitFor(async () => (await savedStrip(crew, workspace.id))?.activeId === opened, {
    message: "a plain click puts the page on screen",
  });
});
