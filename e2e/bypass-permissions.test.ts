// B1: Settings › General › "Bypass permissions" reaches every provider's CLI.
// A session opened from ⌘T starts its CLI with the provider's own bypass flag
// once the setting is on, and without it before. claude is the harness's fake;
// cursor-agent, codex and opencode are stand-ins that only log their argv.
import assert from "node:assert/strict";
import { chmod, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { PROVIDERS, type ProviderDef } from "../src/lib/providers.ts";
import { launchCrew, MOD, pressChord, waitFor, type Crew } from "./harness.ts";

/**
 * A provider CLI that appends its argv to $HOME/fake-<binary>.log, the way the
 * fake claude does, then holds its terminal. cursor-agent's `create-chat`
 * answers with a chat id and logs nothing: it is not the session's launch.
 */
async function installFake(crew: Crew, binary: string): Promise<void> {
  const file = path.join(crew.home, ".local/bin", binary);
  await writeFile(
    file,
    `#!${process.execPath}
"use strict";
const fs = process.getBuiltinModule("node:fs");
const path = process.getBuiltinModule("node:path");
const argv = process.argv.slice(2);
if (argv[0] === "create-chat") {
  process.stdout.write(process.getBuiltinModule("node:crypto").randomUUID() + "\\n");
  process.exit(0);
}
fs.appendFileSync(
  path.join(process.env.HOME, ${JSON.stringify(`fake-${binary}.log`)}),
  JSON.stringify({ argv, cwd: process.cwd(), pid: process.pid, at: Date.now() }) + "\\n",
);
process.stdout.write(${JSON.stringify(`${binary} ready\r\n`)});
process.stdin.resume();
process.stdin.on("end", () => process.exit(0));
`,
  );
  await chmod(file, 0o755);
}

async function launches(crew: Crew, binary: string): Promise<string[][]> {
  const log = await readFile(path.join(crew.home, `fake-${binary}.log`), "utf8").catch(() => "");
  return log
    .split("\n")
    .filter(Boolean)
    .map((line) => (JSON.parse(line) as { argv: string[] }).argv);
}

/** ⌘T › "<Provider> session": the argv its CLI started with. */
async function startSession(crew: Crew, provider: ProviderDef): Promise<string[]> {
  const before = (await launches(crew, provider.binary)).length;
  await pressChord(crew, `${MOD}+t`);
  // The ⌘N provider's row also carries its shortcut, so the name only starts with the label.
  await crew.window.getByRole("button", { name: new RegExp(`^${provider.label} session`) }).click();
  return waitFor(async () => (await launches(crew, provider.binary))[before], {
    message: `the ${provider.label} session's CLI starts`,
  });
}

test("B1: Bypass permissions starts every provider's session with its bypass flag, and only once it is on", async (t) => {
  const crew = await launchCrew();
  t.after(() => crew.close());
  for (const provider of PROVIDERS) {
    if (provider.binary !== "claude") await installFake(crew, provider.binary);
  }
  const page = crew.window;

  for (const provider of PROVIDERS) {
    const argv = await startSession(crew, provider);
    assert.ok(!argv.includes(provider.bypassFlag), `${provider.label} asks by default: ${argv.join(" ")}`);
  }

  // Settings › General › Bypass permissions, through its confirmation.
  await pressChord(crew, `${MOD}+,`);
  await page.getByRole("button", { name: "General", exact: true }).click();
  const toggle = page.getByRole("switch", { name: /Bypass permissions/ });
  assert.equal(await toggle.getAttribute("aria-checked"), "false");
  await toggle.click();
  const confirm = page.getByRole("alertdialog", { name: "Bypass permissions for every session?" });
  await confirm.getByRole("button", { name: /^Bypass/ }).click();
  await confirm.waitFor({ state: "detached" });
  await waitFor(async () => (await crew.request<string | null>("state_get", { key: "sessions:bypass-permissions" })) === "on", {
    message: "crewd keeps the setting",
  });
  await pressChord(crew, `${MOD}+,`);

  for (const provider of PROVIDERS) {
    const argv = await startSession(crew, provider);
    assert.ok(argv.includes(provider.bypassFlag), `${provider.label} bypasses: ${argv.join(" ")}`);
  }
});
