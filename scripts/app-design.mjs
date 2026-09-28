// The app on the seeded design profile, on a port of its own, so it runs next
// to a regular `npm run app` without sharing its data.
//
//   npm run app:design              → seeds on first run, then opens the app
//   npm run app:design -- --reseed  → wipes the profile and seeds it again
import { execFileSync, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const root = new URL("..", import.meta.url).pathname;
const data = process.env.CREW_USER_DATA || join(homedir(), "Library/Application Support/Crew Design");
const env = { ...process.env, CREW_USER_DATA: data, CREW_PORT: process.env.CREW_PORT || "1421", CREW_KEEP_STATUS: "1" };

execFileSync("cargo", ["build", "-p", "crewd"], { cwd: root, stdio: "inherit" });
if (process.argv.includes("--reseed") || !existsSync(join(data, "crew.sqlite3"))) {
  execFileSync(process.execPath, [join(root, "scripts/seed.mjs")], { cwd: root, env, stdio: "inherit" });
}

const app = spawn(process.execPath, [join(root, "scripts/app.mjs")], { cwd: root, env, stdio: "inherit" });
app.on("exit", (code) => process.exit(code ?? 0));
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => app.kill(signal));
