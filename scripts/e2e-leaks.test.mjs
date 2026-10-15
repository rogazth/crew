import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { findLeaks, leakedProcesses, sandboxesIn } from "./e2e-leaks.mjs";

const open = (file) => new DatabaseSync(file, { readOnly: true });

function machine() {
  const top = mkdtempSync(path.join(tmpdir(), "crew-leaks-"));
  const home = path.join(top, "home");
  const appSupport = path.join(top, "Application Support");
  const sandbox = path.join(top, "ce-run1");
  const other = path.join(top, "ce-otherrun");
  for (const dir of [home, appSupport, sandbox, other]) mkdirSync(dir, { recursive: true });
  return { top, home, appSupport, sandbox, other };
}

function database(dir, folders) {
  mkdirSync(dir, { recursive: true });
  const db = new DatabaseSync(path.join(dir, "crew.sqlite3"));
  db.exec("CREATE TABLE workspaces (id TEXT, path TEXT)");
  for (const [i, folder] of folders.entries()) db.prepare("INSERT INTO workspaces VALUES (?, ?)").run(String(i), folder);
  db.close();
}

function worktree(dir, gitdir) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, ".git"), `gitdir: ${gitdir}\n`);
}

describe("what an e2e run leaves behind", () => {
  it("reads the run's sandboxes once each", () => {
    expect(sandboxesIn("/tmp/ce-a\n/tmp/ce-b\n/tmp/ce-a\n\n")).toEqual(["/tmp/ce-a", "/tmp/ce-b"]);
  });

  it("finds the processes that name this run's sandboxes and no other run's", () => {
    const ps = [
      "  101 /repo/target/debug/crewd --data-dir /tmp/ce-run1/config/Crew Dev",
      "  102 /repo/target/debug/crewd --data-dir /tmp/ce-otherrun/config/Crew Dev",
      "  103 /Applications/Crew.app/Contents/Resources/crewd --data-dir /Users/me/Library/Application Support/Crew",
      `  ${process.pid} node scripts/e2e.mjs /tmp/ce-run1`,
    ].join("\n");
    expect(leakedProcesses(ps, ["/tmp/ce-run1"]).map((leak) => leak.pid)).toEqual([101]);
  });

  it("finds a sandbox left on disk, unless the run keeps them", () => {
    const m = machine();
    const args = { roots: [m.sandbox], ps: "", home: m.home, appSupport: m.appSupport, open };
    expect(findLeaks({ ...args, keep: false }).sandboxes).toEqual([m.sandbox]);
    expect(findLeaks({ ...args, keep: true }).sandboxes).toEqual([]);
  });

  it("finds a sandbox's workspace in a real app's database", () => {
    const m = machine();
    database(path.join(m.appSupport, "Crew Dev"), [`${m.sandbox}/repos/app`, "/Users/me/Developer/crew", `${m.other}/repos/app`]);
    database(path.join(m.appSupport, "Crew"), ["/Users/me/Crew"]);
    const { elsewhere } = findLeaks({ roots: [m.sandbox], ps: "", home: m.home, appSupport: m.appSupport, keep: true, open });
    expect(elsewhere).toEqual([`${path.join(m.appSupport, "Crew Dev", "crew.sqlite3")}: workspace ${m.sandbox}/repos/app`]);
  });

  it("finds a sandbox repo's worktree in a real build's folder", () => {
    const m = machine();
    const leaked = path.join(m.home, ".crew-dev", "worktrees", "app", "feat");
    worktree(leaked, `${m.sandbox}/repos/app/.git/worktrees/feat`);
    worktree(path.join(m.home, ".crew", "worktrees", "crew", "main-2"), "/Users/me/Developer/crew/.git/worktrees/main-2");
    worktree(path.join(m.home, ".crew-dev", "checkouts", "crew-b", "worktrees", "app", "x"), `${m.sandbox}/repos/app/.git/worktrees/x`);
    const { elsewhere } = findLeaks({ roots: [m.sandbox], ps: "", home: m.home, appSupport: m.appSupport, keep: true, open });
    expect(elsewhere.sort()).toEqual(
      [`worktree ${leaked}`, `worktree ${path.join(m.home, ".crew-dev", "checkouts", "crew-b", "worktrees", "app", "x")}`].sort(),
    );
  });

  it("finds a real process that names a sandbox", () => {
    const m = machine();
    const child = execFileSync("/bin/sh", ["-c", `(exec -a "probe ${m.sandbox}" sleep 30) >/dev/null 2>&1 & echo $!`], {
      encoding: "utf8",
    }).trim();
    try {
      const ps = execFileSync("ps", ["-axo", "pid=,command="], { encoding: "utf8" });
      expect(leakedProcesses(ps, [m.sandbox]).map((leak) => leak.pid)).toContain(Number(child));
    } finally {
      process.kill(Number(child), "SIGKILL");
    }
  });
});
