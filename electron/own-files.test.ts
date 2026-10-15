// Crew writes its own files only where its environment's layout says
// (docs/plans/2026-10-15-environments.md). Reading the home or the temp dir
// anywhere else in the main process is how a build ends up writing into
// another build's folders, so it is allowed only in these files, each for a
// reason that is not Crew's own state.
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const PATTERN = /\b(homedir|tmpdir)\(\)|getPath\("(home|temp)"\)/;

const ALLOWED: Record<string, string> = {
  "external.ts": "an e2e run's link log, in the sandbox's HOME",
  "install-cli.ts": "~/.local/bin, where the user's shell finds commands",
  "main.ts": "the layout's folders beside the home, and the home the window shows",
  "ssh-config.ts": "the user's ~/.ssh/config",
  "update.ts": "the downloaded update, before it replaces the app",
};

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) return sources(full);
    return name.endsWith(".ts") && !name.endsWith(".test.ts") ? [full] : [];
  });
}

const root = path.dirname(new URL(import.meta.url).pathname);
const using = sources(root)
  .filter((file) => PATTERN.test(readFileSync(file, "utf8")))
  .map((file) => path.relative(root, file))
  .sort();

describe("where the main process reads the home or the temp dir", () => {
  it("is only in the listed files", () => {
    expect(using.filter((file) => !(file in ALLOWED))).toEqual([]);
  });

  it("is still in every listed file", () => {
    expect(Object.keys(ALLOWED).filter((file) => !using.includes(file))).toEqual([]);
  });
});
