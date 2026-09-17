// Screenshots the chrome against the in-memory mock, so a change to the chat can
// be looked at without a machine with a screen.
//
//   node scripts/shot.mjs            → out/shot.png
//   SHOT=search node scripts/shot.mjs
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
const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 2 });
page.on("console", (message) => message.type() === "error" && console.log(`[page] ${message.text()}`));
// `SHOT=history` seeds a long transcript so the window's affordance shows.
const query = process.env.SHOT === "history" ? "?history=400" : "";
await page.goto(`http://localhost:${PORT}/${query}`, { waitUntil: "networkidle" });

const shot = process.env.SHOT ?? "chat";
// The first key after load lands before the shell is listening; give it focus.
await page.mouse.click(900, 700);
await page.waitForTimeout(300);

if (shot === "history") {
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
} else if (shot === "search") {
  await page.keyboard.press("Control+Shift+F");
  await page.waitForTimeout(600);
  await page.keyboard.type("sidebar");
  await page.waitForTimeout(900);
  const heading = await page.locator("h1").first().textContent();
  if (heading !== "Search") throw new Error(`the search page never opened (h1 was ${heading})`);
  const empty = await page.locator("text=Nothing matches").count();
  if (empty > 0) throw new Error("the search found nothing; the mock may not answer messages_search");
} else {
  // The seeded transcript belongs to the first agent in the sidebar.
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
