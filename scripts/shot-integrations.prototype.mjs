// PROTOTYPE — throwaway. Screenshots the Integrations prototype (dev only,
// `?prototype=integrations`, on its fixtures) against the in-memory mock
// (CREW_MOCK). The shipped page is src/surfaces/settings/integrations/; this
// keeps the provider servers and remote-vault designs that later phases build.
//
//   node scripts/shot-integrations.prototype.mjs c:using c:fresh c:offline:dark
//     → out/integrations-c-using.png, out/integrations-c-fresh.png, out/integrations-c-offline-dark.png
//
// STEPS='[{"click":"text=Connect"},{"wait":900},{"shot":"after-connect"}]' runs the
// steps after each page loads; a {"shot":name} step writes out/integrations-<v>-<scenario>-<name>.png.
// Steps: click (a Playwright selector), hover, scroll (into view), press (a key), type ({"type":"text"}), wait (ms), shot.
import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { chromium } from "playwright-core";

const PORT = 1900 + Math.floor(Math.random() * 400);
const OUT = new URL("../out/", import.meta.url).pathname;
mkdirSync(OUT, { recursive: true });
const shots = process.argv.slice(2).length ? process.argv.slice(2) : ["a:using"];
const steps = process.env.STEPS ? JSON.parse(process.env.STEPS) : [];

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
try {
  for (const spec of shots) {
    const [variant = "c", scenario = "using", theme = "light"] = spec.split(":");
    const page = await browser.newPage({
      viewport: { width: 1440, height: 920 },
      deviceScaleFactor: 1.5,
      colorScheme: theme === "dark" ? "dark" : "light",
    });
    page.on("console", (m) => m.type() === "error" && console.log(`[page ${spec}] ${m.text()}`));
    page.on("pageerror", (e) => console.log(`[page ${spec}] ${e.message}`));
    await page.goto(`http://localhost:${PORT}/?prototype=integrations&scenario=${scenario}`, { waitUntil: "networkidle" });
    await page.locator('[data-nav][aria-label="Connectors"]').first().click();
    await page.waitForSelector("[data-integrations-prototype]", { timeout: 15_000 });
    await page.waitForTimeout(600);
    const base = `integrations-${variant}-${scenario}${theme === "dark" ? "-dark" : ""}`;
    await page.screenshot({ path: `${OUT}${base}.png` });
    console.log(`${OUT}${base}.png`);
    for (const step of steps) {
      if (step.click) await page.locator(step.click).first().click();
      if (step.hover) await page.locator(step.hover).first().hover();
      if (step.scroll) await page.locator(step.scroll).first().scrollIntoViewIfNeeded();
      if (step.press) await page.keyboard.press(step.press);
      if (step.type) await page.keyboard.type(step.type);
      if (step.wait) await page.waitForTimeout(step.wait);
      if (step.shot) {
        await page.screenshot({ path: `${OUT}${base}-${step.shot}.png` });
        console.log(`${OUT}${base}-${step.shot}.png`);
      }
    }
    await page.close();
  }
} finally {
  await browser.close();
  vite.kill("SIGTERM");
}
