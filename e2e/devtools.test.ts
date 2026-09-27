// L2: a page's DevTools dock beside it, like Chromium's. By default they open
// below the page, in a view main lays over the pane's panel, and they inspect
// that page; their header drags to resize them. The ⋯ menu moves them to the
// right or left without reloading the frontend, where their inner edge drags
// too. A menu over the panel hides the view behind a still of it until the
// menu goes.
// The chord closes them from inside the page, and so does the panel's close
// button. "Separate Window" opens them the old way, docking again pulls them
// back in, and a tab closed with DevTools docked takes them along.
import assert from "node:assert/strict";
import { test } from "node:test";
import { launchCrew, MOD, servePages, stripTabIds, waitFor, type Crew } from "./harness.ts";

type Rect = { x: number; y: number; width: number; height: number };
type Frontend = { id: number; docked: boolean; inspects: string; bounds: Rect | null; visible: boolean };

/**
 * Every DevTools frontend main has: whether it is a view of the window (and
 * where), and the page it is connected to, as the frontend itself reports.
 */
function frontends(crew: Crew): Promise<Frontend[]> {
  return crew.app.evaluate(async ({ webContents, BrowserWindow }) => {
    const views = BrowserWindow.getAllWindows().flatMap((win) => win.contentView.children);
    const list = [];
    for (const contents of webContents.getAllWebContents()) {
      if (!contents.getURL().startsWith("devtools://")) continue;
      const view = views.find((child) => "webContents" in child && child.webContents === contents);
      const inspects: string = await contents
        .executeJavaScript(
          `import("devtools://devtools/bundled/core/sdk/sdk.js")
            .then((sdk) => sdk.TargetManager.TargetManager.instance().primaryPageTarget()?.inspectedURL() ?? "")`,
        )
        .catch(() => "");
      list.push({
        id: contents.id,
        docked: view !== undefined,
        inspects,
        bounds: view ? view.getBounds() : null,
        visible: view ? view.getVisible() : false,
      });
    }
    return list;
  });
}

/** The one frontend there is, once `test` holds for it. */
async function frontend(crew: Crew, test: (frontend: Frontend) => boolean, message: string): Promise<Frontend> {
  const [only] = await waitFor(
    async () => {
      const list = await frontends(crew);
      return list.length === 1 && list[0] && test(list[0]) && list;
    },
    { message },
  );
  assert.ok(only);
  return only;
}

async function box(crew: Crew, selector: string): Promise<Rect> {
  const found = await crew.window.locator(selector).boundingBox();
  assert.ok(found, `${selector} is on screen`);
  return found;
}

/** Where the view should be: the panel under its header, inside its border. */
const panel = (side: string) => `[data-devtools="${side}"] [data-devtools-view]`;

function near(actual: Rect | null, expected: Rect, what: string): void {
  assert.ok(actual, `${what}: a view is placed`);
  for (const key of ["x", "y", "width", "height"] as const) {
    assert.ok(Math.abs(actual[key] - expected[key]) <= 1, `${what}: ${key} ${actual[key]} ≈ ${expected[key]}`);
  }
}

async function dockTo(crew: Crew, label: string): Promise<void> {
  const page = crew.window;
  await page.getByRole("button", { name: "More" }).click();
  await page.getByRole("menuitem", { name: "Developer Tools Position" }).click();
  await page.getByRole("menuitemradio", { name: label }).click();
}

test("L2: DevTools dock to a side of the page, move, resize, and close with it", async (t) => {
  const crew = await launchCrew();
  t.after(() => crew.close());
  const server = await servePages({ "/inspect": "Inspected page" });
  t.after(() => server.close());
  const page = crew.window;
  const url = `${server.origin}/inspect`;
  const address = url.replace(/^http:\/\//, "");

  await page.getByRole("button", { name: /^New tab/ }).click();
  await page.getByRole("textbox", { name: "Open a tab" }).fill(address);
  await page.getByRole("button", { name: `Open ${address}`, exact: true }).click();
  await waitFor(() => server.requests.includes("/inspect"), { message: "the page loads" });

  // Docked below the page by default, over the panel, inspecting this page.
  const devtools = page.getByRole("button", { name: "Developer Tools", exact: true });
  await devtools.click();
  const docked = await frontend(
    crew,
    (it) => it.docked && it.visible && it.inspects === url,
    "docked DevTools inspect the page",
  );
  assert.equal(await devtools.getAttribute("aria-pressed"), "true", "the toolbar shows them open");
  const bottom = await box(crew, panel("bottom"));
  const pane = await box(crew, '[data-devtools="bottom"] >> xpath=..');
  assert.ok(Math.abs(bottom.y + bottom.height - (pane.y + pane.height)) <= 1, "the panel sits on the pane's bottom edge");
  assert.ok(Math.abs(bottom.width - pane.width) <= 1, "it spans the pane");
  near((await frontends(crew))[0]?.bounds ?? null, bottom, "the view covers the panel");

  // The header dragged up 80px grows the panel by as much, and the view follows.
  const header = await box(crew, '[data-devtools="bottom"] [data-devtools-header]');
  await page.mouse.move(header.x + header.width / 3, header.y + header.height / 2);
  await page.mouse.down();
  await page.mouse.move(header.x + header.width / 3, header.y + header.height / 2 - 80, { steps: 8 });
  await frontend(crew, (it) => !it.visible, "the view hides while the header is dragged");
  await page.mouse.up();
  const grown = await box(crew, panel("bottom"));
  assert.ok(Math.abs(grown.height - (bottom.height + 80)) <= 1, `grew from ${bottom.height} to ${grown.height}`);
  near((await frontend(crew, (it) => it.visible, "the view comes back after the drag")).bounds, grown, "the view covers the grown panel");

  // On the right: the same frontend, laid out again.
  await dockTo(crew, "Dock to Right");
  const right = await waitFor(() => page.locator(panel("right")).boundingBox(), {
    message: "the panel moves to the right",
  });
  assert.ok(Math.abs(right.x + right.width - (pane.x + pane.width)) <= 1, "the panel sits on the pane's right edge");
  const moved = await frontend(crew, (it) => it.visible && it.bounds?.x === Math.round(right.x), "the view follows");
  assert.equal(moved.id, docked.id, "moving keeps the frontend");

  // Its inner edge dragged 60px toward the page widens it by as much.
  const edge = await box(crew, '[data-devtools="right"] [role="separator"]');
  await page.mouse.move(edge.x + edge.width / 2, edge.y + edge.height / 2);
  await page.mouse.down();
  await page.mouse.move(edge.x + edge.width / 2 - 60, edge.y + edge.height / 2, { steps: 8 });
  await page.mouse.up();
  const wider = await box(crew, panel("right"));
  assert.ok(Math.abs(wider.width - (right.width + 60)) <= 1, `widened from ${right.width} to ${wider.width}`);
  await frontend(crew, (it) => it.visible && it.bounds?.width === Math.round(wider.width), "the view widens with it");

  // The window zoomed: the view is placed in its zoomed pixels.
  const setZoom = (factor: number) =>
    crew.app.evaluate(({ BrowserWindow }, zoom) => BrowserWindow.getAllWindows()[0]?.webContents.setZoomFactor(zoom), factor);
  await setZoom(1.25);
  await waitFor(async () => {
    const zoomed = await box(crew, panel("right"));
    const [only] = await frontends(crew);
    const scaled = { x: zoomed.x * 1.25, y: zoomed.y * 1.25, width: zoomed.width * 1.25, height: zoomed.height * 1.25 };
    near(only?.bounds ?? null, scaled, "the view covers the zoomed panel");
    return true;
  }, { message: "the view follows the window's zoom" });
  await setZoom(1);
  await frontend(crew, (it) => it.bounds?.width === Math.round(wider.width), "the view is back at actual size");

  // The ⋯ menu's submenu opens over the panel: the view steps aside for a still of it.
  await page.getByRole("button", { name: "More" }).click();
  await page.getByRole("menuitem", { name: "Developer Tools Position" }).click();
  await frontend(crew, (it) => !it.visible, "the view hides under the menu");
  await page.locator(`${panel("right")} img`).waitFor();
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
  await frontend(crew, (it) => it.visible, "the view comes back once the menu goes");
  await waitFor(async () => (await page.locator(`${panel("right")} img`).count()) === 0, {
    message: "the still goes with it",
  });

  // The left side, then the chord from inside the page closes them.
  await dockTo(crew, "Dock to Left");
  const left = await waitFor(() => page.locator(panel("left")).boundingBox(), {
    message: "the panel moves to the left",
  });
  assert.ok(Math.abs(left.x - pane.x) <= 1, "the panel sits on the pane's left edge");
  await frontend(crew, (it) => it.visible && it.bounds?.x === Math.round(left.x), "the view follows");
  await page.locator("webview").first().focus();
  await page.keyboard.press(`${MOD}+Alt+KeyI`);
  await waitFor(async () => (await page.locator("[data-devtools]").count()) === 0, { message: "the panel goes" });
  await waitFor(async () => (await frontends(crew)).length === 0, { message: "and its frontend with it" });
  assert.equal(await devtools.getAttribute("aria-pressed"), null, "the toolbar shows them closed");

  // The panel's own close button closes them too.
  await devtools.click();
  await frontend(crew, (it) => it.docked && it.visible && it.inspects === url, "they dock again, on the left");
  await page.getByRole("button", { name: "Close Developer Tools" }).click();
  await waitFor(async () => (await page.locator("[data-devtools]").count()) === 0, { message: "the button closes the panel" });
  await waitFor(async () => (await frontends(crew)).length === 0, { message: "and its frontend" });

  // A separate window, as before.
  await dockTo(crew, "Separate Window");
  await devtools.click();
  await frontend(crew, (it) => !it.docked && it.inspects === url, "DevTools open in a window of their own");
  assert.equal(await page.locator("[data-devtools]").count(), 0, "no panel in the pane");

  // Docking again pulls that window's DevTools into the pane.
  await dockTo(crew, "Dock to Bottom");
  await frontend(crew, (it) => it.docked && it.inspects === url, "the window's DevTools move into the pane");
  await page.locator('[data-devtools="bottom"]').waitFor();

  // Closing the tab takes docked DevTools along, and the app carries on.
  const [tab] = await stripTabIds(crew);
  assert.ok(tab);
  await page.locator(`[data-tab-strip] [role="tab"][data-tab-id="${tab}"]`).click();
  await page.keyboard.press(`${MOD}+KeyW`);
  await waitFor(async () => (await stripTabIds(crew)).length === 0, { message: "the tab closes" });
  await waitFor(async () => (await frontends(crew)).length === 0, { message: "its DevTools go with it" });
  assert.equal(await crew.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length), 1);
});
