// Screenshots the chrome against the in-memory mock, so a change to the chat can
// be looked at without a machine with a screen.
//
//   node scripts/shot.mjs            → out/shot.png
//
// Needs a browser once: npx playwright-core install chromium
import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { chromium } from "playwright-core";

// A fixed port leaves a stuck server blocking the next run; take a free one.
const PORT = 1400 + Math.floor(Math.random() * 500);
const OUT = new URL("../out/", import.meta.url).pathname;
mkdirSync(OUT, { recursive: true });

const vite = spawn("npx", ["vite", "--port", String(PORT), "--strictPort"], {
  cwd: new URL("..", import.meta.url).pathname,
  env: { ...process.env, CREW_MOCK: "1" },
  stdio: ["ignore", "pipe", "pipe"],
});
vite.stderr.on("data", (chunk) => process.stderr.write(`[vite] ${chunk}`));
await new Promise((resolve, reject) => {
  vite.stdout.on("data", (chunk) => String(chunk).includes("ready in") && resolve());
  vite.on("exit", (code) => reject(new Error(`vite exited ${code}`)));
  setTimeout(() => reject(new Error("vite never came up")), 60_000);
});

const browser = await chromium.launch();
// The routines editor is a tall form; the rest of the app reads at 900.
const height = process.env.SHOT === "routines" ? 1250 : 900;
const page = await browser.newPage({ viewport: { width: 1280, height }, deviceScaleFactor: 2 });
page.on("console", (message) => message.type() === "error" && console.log(`[page] ${message.text()}`));
// `SHOT=history` seeds a long transcript so the window's affordance shows.
const query = process.env.SHOT === "history" ? "?history=400" : "";
await page.goto(`http://localhost:${PORT}/${query}`, { waitUntil: "networkidle" });

const shot = process.env.SHOT ?? "chat";
// The first key after load lands before the shell is listening; give it focus.
await page.mouse.click(900, 700);
await page.waitForTimeout(300);

if (shot === "routines") {
  await page.keyboard.press("Control+Shift+R");
  await page.waitForTimeout(700);
  const heading = await page.locator("h1").first().textContent();
  if (heading !== "Routines") throw new Error(`the routines page never opened (h1 was ${heading})`);
  await page.locator("text=Morning digest").first().click();
  await page.waitForTimeout(700);
  await page.locator("text=Run history").scrollIntoViewIfNeeded();
  await page.waitForTimeout(400);
  // A run that came due while the bot was busy gets its own mark, which is
  // neither a tick nor a cross.
  const marks = await page.locator("svg").count();
  if (marks === 0) throw new Error("the run history rendered no marks");
} else if (shot === "history") {
  await page.locator('[data-sidebar="sidebar"] button').filter({ hasText: "Planner" }).first().click();
  await page.waitForTimeout(1500);
  const earlier = page.locator('button', { hasText: "Earlier messages" }).first();
  if ((await earlier.count()) === 0) throw new Error("a 400-block transcript offered no earlier messages");
  await earlier.scrollIntoViewIfNeeded();
  await page.waitForTimeout(400);

  // Loading history must not move the line being read. The anchor is the
  // distance to the bottom, because everything above it is about to grow.
  const distance = () =>
    page.evaluate(() => {
      const el = document.querySelector('[data-selectable="blocks"]');
      return el ? el.scrollHeight - el.scrollTop : -1;
    });
  const before = await distance();
  await earlier.click();
  await page.waitForTimeout(900);
  const after = await distance();
  if (Math.abs(after - before) > 4) {
    throw new Error(`loading earlier moved the view by ${after - before}px`);
  }
  const grew = await page.locator('[data-selectable="blocks"] .crew-bubble').count();
  console.log(`earlier messages loaded: ${grew} bubbles in view, anchor held within ${Math.abs(after - before)}px`);
} else if (shot === "workspaces") {
  // Dragging a row in the switcher reorders it, and the order outlives the popover.
  const names = () =>
    page.locator('[aria-label="Workspaces"] button span.font-medium').allTextContents();
  await page.locator('[data-sidebar="sidebar"] button').filter({ hasText: "crew" }).first().click();
  await page.waitForTimeout(400);
  const before = await names();
  if (before.join() !== "crew,storefront-api,ledger,dotfiles") {
    throw new Error(`the switcher opened with ${before.join()}`);
  }
  const rowOf = (name) =>
    page.locator('[aria-label="Workspaces"] button').filter({ hasText: name }).first();
  const from = await rowOf("crew").boundingBox();
  const to = await rowOf("ledger").boundingBox();
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  // Step through the gap so the sensor activates and the sortable sees every row.
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2 + 10, { steps: 5 });
  await page.mouse.move(to.x + to.width / 2, to.y + to.height - 4, { steps: 20 });
  await page.waitForTimeout(200);
  await page.mouse.up();
  await page.waitForTimeout(400);
  const after = await names();
  if (after.join() !== "storefront-api,ledger,crew,dotfiles") {
    throw new Error(`the drag left the switcher at ${after.join()}`);
  }
  // Letting go must not also pick the row under the pointer.
  const open = await page.locator('[aria-label="Workspaces"]').count();
  if (open === 0) throw new Error("dropping a row closed the switcher");
  await page.keyboard.press("Escape");
  await page.waitForTimeout(300);
  await page.locator('[data-sidebar="sidebar"] button').filter({ hasText: "crew" }).first().click();
  await page.waitForTimeout(400);
  const reopened = await names();
  if (reopened.join() !== after.join()) throw new Error(`reopening showed ${reopened.join()}`);
  // A click that never travels is still a pick, not a drag.
  await rowOf("ledger").click();
  await page.waitForTimeout(400);
  if ((await page.locator('[aria-label="Workspaces"]').count()) > 0) {
    throw new Error("clicking a row did not pick it");
  }
  const trigger = page.locator('[data-sidebar="sidebar"] button').filter({ hasText: "ledger" });
  if ((await trigger.count()) === 0) throw new Error("clicking ledger did not switch to it");
  console.log(`dragged crew below ledger: ${after.join(", ")}; a click still picks`);
} else {
  // The seeded transcript belongs to the first bot in the sidebar.
  await page.locator('[data-sidebar="sidebar"] button').filter({ hasText: "Planner" }).first().click();
  await page.waitForTimeout(1500);
  await page.mouse.wheel(0, 20000);
  await page.waitForTimeout(800);
  // Open the failed command so its output is in the shot.
  const failed = page.locator('button', { hasText: "npm test -- sidebarPrefs" }).first();
  if (await failed.count()) {
    await failed.click();
    await page.waitForTimeout(600);
    await page.mouse.wheel(0, 2000);
    await page.waitForTimeout(400);
  }
}

const file = `${OUT}${shot}.png`;
await page.screenshot({ path: file });
console.log(`wrote ${file}`);
await browser.close();
vite.kill("SIGTERM");
process.exit(0);
