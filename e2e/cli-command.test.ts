// Settings › General › Command line: Install links the checkout's `crew` (as
// `crew-dev`, since a dev build never takes the release's name) into
// the sandbox's ~/.local/bin (on its PATH, so no password), the linked command
// reaches the app's crewd, Uninstall takes the link away, and a crew that is
// not Crew's is replaced only when the user says so.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { lstat, readFile, readlink, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { launchCrew, MOD, pressChord, waitFor, type Crew } from "./harness.ts";

const run = promisify(execFile);

/** Answers the next native message box with the button at `response`, and records what it said. */
async function answerDialog(crew: Crew, response: number): Promise<void> {
  await crew.app.evaluate(({ dialog }, response) => {
    const seen = globalThis as { askedCli?: string };
    dialog.showMessageBox = (async (...args: unknown[]) => {
      const options = args.find((arg): arg is { message: string } => typeof arg === "object" && arg !== null && "message" in arg);
      seen.askedCli = options?.message ?? "";
      return { response, checkboxChecked: false };
    }) as typeof dialog.showMessageBox;
  }, response);
}

async function asked(crew: Crew): Promise<string | undefined> {
  return crew.app.evaluate(() => (globalThis as { askedCli?: string }).askedCli);
}

async function exists(file: string): Promise<boolean> {
  return lstat(file).then(
    () => true,
    () => false,
  );
}

test("C1: the crew command installs from Settings, runs, and uninstalls", async (t) => {
  const crew = await launchCrew();
  t.after(() => crew.close());
  const page = crew.window;
  const dir = path.join(crew.home, ".local/bin");
  const link = path.join(dir, "crew-dev");
  const source = path.resolve("target/debug/crew");

  await pressChord(crew, `${MOD}+,`);
  await page.getByRole("button", { name: "General", exact: true }).click();
  const section = page.locator("section", { has: page.getByRole("heading", { name: "Command line" }) });
  await section.getByText(`It links into ${dir}.`).waitFor();

  await section.getByRole("button", { name: "Install" }).click();
  await section.getByText("Linked at").waitFor();
  assert.equal(await readlink(link), source);

  // The linked command is the CLI, and it finds the app's daemon.
  const env = { ...process.env, HOME: crew.home, CREW_DATA_DIR: crew.userData, CREW_SOCKET: "", CREW_TOKEN: "" };
  const { stdout } = await run(link, ["status"], { env });
  assert.match(stdout, /daemon\s+running/);

  // Typed in a terminal of the app, it reaches this app's crewd with nothing
  // set by hand: crewd names its data dir in every terminal it starts.
  const out = path.join(crew.home, "terminal-status.txt");
  await crew.request("pty_spawn", {
    id: "cli-terminal",
    cwd: crew.home,
    command: ["/bin/sh", "-c", `'${link}' status > '${out}' 2>&1`],
    cols: 80,
    rows: 24,
  });
  await waitFor(async () => /daemon\s+running/.test(await readFile(out, "utf8").catch(() => "")), {
    message: "crew in a terminal finds the app's daemon",
  });

  await section.getByRole("button", { name: "Uninstall" }).click();
  await section.getByText(`It links into ${dir}.`).waitFor();
  assert.equal(await exists(link), false);

  // A crew of the user's own: Cancel keeps it, Replace links over it.
  await writeFile(link, "#!/bin/sh\necho mine\n", { mode: 0o755 });
  await answerDialog(crew, 1);
  await section.getByRole("button", { name: "Install" }).click();
  await waitFor(() => asked(crew), { message: "Install asks before replacing the user's crew" });
  assert.equal(await asked(crew), `${link} already exists`);
  await section.getByRole("button", { name: "Install" }).waitFor();
  assert.equal((await lstat(link)).isSymbolicLink(), false);

  await answerDialog(crew, 0);
  await section.getByRole("button", { name: "Install" }).click();
  await section.getByText("Linked at").waitFor();
  assert.equal(await readlink(link), source);

  // Uninstall never touches a crew that is not Crew's.
  await rm(link);
  await writeFile(link, "#!/bin/sh\necho mine\n", { mode: 0o755 });
  await crew.reload();
  await pressChord(crew, `${MOD}+,`);
  await page.getByRole("button", { name: "General", exact: true }).click();
  await section.getByText(`It links into ${dir}.`).waitFor();
  assert.equal(await section.getByRole("button", { name: "Uninstall" }).count(), 0);
});
