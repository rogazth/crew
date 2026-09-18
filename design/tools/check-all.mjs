/**
 * One command that says whether the whole exploration is healthy.
 *
 *   node tools/check-all.mjs          # everything
 *   node tools/check-all.mjs --fast   # skip the browser walk
 */
import { spawn } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const designRoot = resolve(here, "..");
const fast = process.argv.includes("--fast");

function run(label, cmd, args, cwd) {
  return new Promise((done) => {
    const started = Date.now();
    const child = spawn(cmd, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (c) => (out += c));
    child.stderr.on("data", (c) => (out += c));
    child.on("exit", (code) => {
      const secs = ((Date.now() - started) / 1000).toFixed(1);
      console.log(`  ${code === 0 ? "✓" : "✕"} ${label.padEnd(34)} ${secs}s`);
      if (code !== 0) {
        console.log(
          out
            .split("\n")
            .filter(Boolean)
            .slice(-14)
            .map((l) => `      ${l}`)
            .join("\n"),
        );
      }
      done(code === 0);
    });
  });
}

const results = [];

console.log("\n— shared —");
results.push(await run("typecheck", "npx", ["tsc", "--noEmit"], join(designRoot, "shared")));
results.push(await run("tests", "npx", ["vitest", "run"], join(designRoot, "shared")));

for (const proto of ["proto-ink", "proto-console", "proto-canvas"]) {
  console.log(`\n— ${proto} —`);
  const cwd = join(designRoot, proto);
  results.push(await run("typecheck", "npx", ["tsc", "--noEmit"], cwd));
  results.push(await run("build", "npx", ["vite", "build"], cwd));
}

if (!fast) {
  console.log("\n— browser walk —");
  results.push(await run("smoke (all routes, both themes)", "node", [join(here, "smoke.mjs")], designRoot));
}

const failed = results.filter((ok) => !ok).length;
console.log(failed === 0 ? "\nall clean\n" : `\n${failed} check(s) failed\n`);
process.exit(failed === 0 ? 0 : 1);
