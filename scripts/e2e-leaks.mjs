// What an e2e run left outside its sandboxes (docs/plans/2026-10-15-environments.md).
// The harness writes every sandbox it makes to $CREW_E2E_RUN_LOG; once the
// specs are done, anything that still names one of them is a leak:
//
//   - a live process whose command line names a sandbox
//   - a sandbox still on disk (a spec that never cleaned up), unless E2E_KEEP
//   - a workspace for a sandbox's repo in a real app's database
//   - a worktree of a sandbox's repo in a real build's work dir
//
// Only this run's sandboxes count, so other runs on the machine, and the
// user's own apps, are never mistaken for one.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";

/** The sandboxes the run log names, once each. */
export function sandboxesIn(log) {
  return [...new Set(log.split("\n").map((line) => line.trim()).filter(Boolean))];
}

/** `ps -axo pid=,command=` lines whose command names a sandbox. */
export function leakedProcesses(ps, roots, self = process.pid) {
  return ps
    .split("\n")
    .map((line) => line.trim().match(/^(\d+)\s+(.*)$/))
    .filter((match) => match && Number(match[1]) !== self && roots.some((root) => match[2].includes(root)))
    .map((match) => ({ pid: Number(match[1]), command: match[2] }));
}

/** The real apps' data dirs: every build's, whichever ran. */
export function appDataDirs(appSupport) {
  return ["Crew", "Crew Dev", "Crew Local"].map((name) => path.join(appSupport, name));
}

/** Workspaces in a real database whose folder is inside a sandbox. */
export function leakedWorkspaces(dataDirs, roots, open) {
  const found = [];
  for (const dir of dataDirs) {
    const file = path.join(dir, "crew.sqlite3");
    if (!existsSync(file)) continue;
    let db;
    try {
      db = open(file);
      for (const { path: folder } of db.prepare("SELECT path FROM workspaces").all()) {
        if (roots.some((root) => folder.startsWith(root))) found.push(`${file}: workspace ${folder}`);
      }
    } catch (error) {
      found.push(`${file}: could not be read (${error.message})`);
    } finally {
      db?.close();
    }
  }
  return found;
}

/** The real builds' worktree folders: `<work>/worktrees/<repo>/<branch>`. */
export function worktreeRoots(home) {
  const roots = [".crew", ".crew-dev", ".crew-local"].map((dir) => path.join(home, dir, "worktrees"));
  const checkouts = path.join(home, ".crew-dev", "checkouts");
  if (existsSync(checkouts)) {
    for (const name of readdirSync(checkouts)) roots.push(path.join(checkouts, name, "worktrees"));
  }
  return roots;
}

/** Worktrees in a real build's folder whose repo is inside a sandbox, as their `.git` file says. */
export function leakedWorktrees(worktreeDirs, roots) {
  const found = [];
  for (const dir of worktreeDirs.filter((entry) => existsSync(entry))) {
    for (const repo of readdirSync(dir)) {
      const repoDir = path.join(dir, repo);
      let branches;
      try {
        branches = readdirSync(repoDir);
      } catch {
        continue;
      }
      for (const branch of branches) {
        const tree = path.join(repoDir, branch);
        let gitdir;
        try {
          gitdir = readFileSync(path.join(tree, ".git"), "utf8");
        } catch {
          continue;
        }
        if (roots.some((root) => gitdir.includes(root))) found.push(`worktree ${tree}`);
      }
    }
  }
  return found;
}

/**
 * Everything the run left behind. `processes` are to be killed; the rest is
 * named for the report.
 */
export function findLeaks({ roots, ps, home, appSupport, keep, open }) {
  const processes = leakedProcesses(ps, roots);
  const sandboxes = keep ? [] : roots.filter((root) => existsSync(root));
  const elsewhere = [
    ...leakedWorkspaces(appDataDirs(appSupport), roots, open),
    ...leakedWorktrees(worktreeRoots(home), roots),
  ];
  return { processes, sandboxes, elsewhere };
}
