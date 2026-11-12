// Closing the tab on screen hands focus where Chromium does: a page opened for
// a quick look and closed right away returns to where the work was; otherwise,
// and once another tab has been on screen, to its neighbour, not to the tab
// last on screen. With ⌘W and with the tab's close button.
import assert from "node:assert/strict";
import { test } from "node:test";
import { launchCrew, MOD, pressChord, servePages, stripTabIds, waitFor, type Crew } from "./harness.ts";

const tab = (crew: Crew, id: string) => crew.window.locator(`[data-tab-strip] [role="tab"][data-tab-id="${id}"]`);

/** The id of the tab on screen. */
const activeId = (crew: Crew) =>
  crew.window.locator('[data-tab-strip] [role="tab"][aria-selected="true"]').getAttribute("data-tab-id");

/** ⌘W, with the page let go: a focused page takes the keys the app's chords would. */
async function closeChord(crew: Crew): Promise<void> {
  await crew.window.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await pressChord(crew, `${MOD}+w`);
}

/** ⌘⇧T, with the page let go. */
async function reopenChord(crew: Crew): Promise<void> {
  await crew.window.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await pressChord(crew, `${MOD}+Shift+t`);
}

async function expectActive(crew: Crew, id: string, message: string): Promise<void> {
  await waitFor(async () => (await activeId(crew)) === id, { message });
}

test("closing the tab on screen returns to a quick look's tab, else to its neighbour", async (t) => {
  const crew = await launchCrew();
  t.after(() => crew.close());
  const paths = ["/one", "/two", "/three", "/four", "/five", "/peek", "/again"];
  const server = await servePages(Object.fromEntries(paths.map((at) => [at, at.slice(1)])));
  t.after(() => server.close());

  /** A page opened from the launcher by its address; its tab's id. */
  const openPage = async (at: string) => {
    const before = await stripTabIds(crew);
    await crew.window.getByRole("button", { name: /^New tab/ }).click();
    const search = crew.window.getByRole("textbox", { name: "Open a tab" });
    const typed = `${server.origin}${at}`.replace(/^http:\/\//, "");
    await search.fill(typed);
    await crew.window.getByRole("button", { name: `Open ${typed}`, exact: true }).click();
    return waitFor(async () => (await stripTabIds(crew)).find((id) => !before.includes(id)), {
      message: `a tab opens for ${at}`,
    });
  };

  const [one, two, three, four, five] = [
    await openPage("/one"),
    await openPage("/two"),
    await openPage("/three"),
    await openPage("/four"),
    await openPage("/five"),
  ];

  // On the third of five, a page opened for a look and closed with ⌘W.
  await tab(crew, three).click();
  await expectActive(crew, three, "the third tab is on screen");
  const peek = await openPage("/peek");
  await expectActive(crew, peek, "the new page is on screen");
  await closeChord(crew);
  await waitFor(async () => !(await stripTabIds(crew)).includes(peek), { message: "the page closes" });
  await expectActive(crew, three, "⌘W hands focus back to the third tab");

  // A tab reached by hand closes to its neighbour, not to the tab on screen before it.
  await tab(crew, one).click();
  await expectActive(crew, one, "the first tab is on screen");
  await tab(crew, five).click();
  await expectActive(crew, five, "the fifth tab is on screen");
  await tab(crew, five).getByRole("button", { name: "Close tab" }).click();
  await expectActive(crew, four, "the close button hands focus to the fourth tab, not back to the first");

  // A quick look left and come back to closes to its neighbour as well.
  await tab(crew, three).click();
  await expectActive(crew, three, "the third tab is on screen");
  const again = await openPage("/again");
  await tab(crew, one).click();
  await expectActive(crew, one, "the first tab is on screen");
  await tab(crew, again).click();
  await expectActive(crew, again, "the page is on screen again");
  await closeChord(crew);
  await expectActive(crew, four, "the page left once closes to its neighbour, not to the third tab");
  assert.deepEqual(await stripTabIds(crew), [one, two, three, four]);
});

test("reopening a closed tab brings it back where it stood in the strip", async (t) => {
  const crew = await launchCrew();
  t.after(() => crew.close());
  const paths = ["/one", "/two", "/three", "/four"];
  const server = await servePages(Object.fromEntries(paths.map((at) => [at, at.slice(1)])));
  t.after(() => server.close());

  const openPage = async (at: string) => {
    const before = await stripTabIds(crew);
    await crew.window.getByRole("button", { name: /^New tab/ }).click();
    const search = crew.window.getByRole("textbox", { name: "Open a tab" });
    const typed = `${server.origin}${at}`.replace(/^http:\/\//, "");
    await search.fill(typed);
    await crew.window.getByRole("button", { name: `Open ${typed}`, exact: true }).click();
    return waitFor(async () => (await stripTabIds(crew)).find((id) => !before.includes(id)), {
      message: `a tab opens for ${at}`,
    });
  };

  const [one, two, three, four] = [
    await openPage("/one"),
    await openPage("/two"),
    await openPage("/three"),
    await openPage("/four"),
  ];
  const strip = await stripTabIds(crew);

  // The second and third closed, then ⌘⇧T twice: each lands where it stood.
  await tab(crew, two).click();
  await expectActive(crew, two, "the second tab is on screen");
  await closeChord(crew);
  await tab(crew, three).click();
  await expectActive(crew, three, "the third tab is on screen");
  await closeChord(crew);
  await waitFor(async () => (await stripTabIds(crew)).length === strip.length - 2, { message: "two tabs close" });

  await reopenChord(crew);
  await expectActive(crew, three, "⌘⇧T brings the third tab back on screen");
  await reopenChord(crew);
  await expectActive(crew, two, "⌘⇧T brings the second tab back on screen");
  assert.deepEqual(await stripTabIds(crew), strip, "both are back where they stood");
  assert.deepEqual(strip.slice(-4), [one, two, three, four]);
});
