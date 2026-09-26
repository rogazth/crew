//! A workspace's git worktrees, read from `git worktree list`. The main
//! checkout comes first, as git lists it; a folder outside git is its own
//! single, branchless worktree.
//!
//! Worktrees Crew makes live under `~/.crew/worktrees/<repo>/<branch>`, out of
//! the repo, so no tool that walks the checkout trips over a second copy of it.

use serde::Serialize;
use std::path::{Path, PathBuf};
use std::process::Command;

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Worktree {
    pub path: String,
    /// Short branch name; `None` on a detached HEAD or outside git.
    pub branch: Option<String>,
    pub main: bool,
    /// Lines added and removed since this worktree forked from the main
    /// checkout's branch, uncommitted edits included. The main checkout counts
    /// only what is uncommitted. 0 when git cannot say.
    pub add: u32,
    pub del: u32,
    /// Entries in `git status`: changed, staged and untracked files.
    pub dirty: u32,
}

pub fn list(cwd: &str) -> Vec<Worktree> {
    let mut listed = git(cwd, &["worktree", "list", "--porcelain"])
        .map(|out| parse(&out))
        .unwrap_or_default();
    if listed.is_empty() {
        return vec![Worktree { path: cwd.to_string(), branch: None, main: true, add: 0, del: 0, dirty: 0 }];
    }
    let main_head = git(&listed[0].path, &["rev-parse", "HEAD"]).map(|out| out.trim().to_string());
    // A few git calls each; side by side the list costs the slowest worktree,
    // not the sum of them.
    std::thread::scope(|scope| {
        for tree in listed.iter_mut() {
            let main_head = main_head.as_deref();
            scope.spawn(move || count(tree, main_head));
        }
    });
    listed
}

/// Porcelain output: one block per worktree, blank-line separated. A bare
/// repository has no files to work in, so it never becomes a row.
pub fn parse(porcelain: &str) -> Vec<Worktree> {
    let mut out = Vec::new();
    for block in porcelain.split("\n\n") {
        let mut path = None;
        let mut branch = None;
        let mut bare = false;
        for line in block.lines() {
            if let Some(rest) = line.strip_prefix("worktree ") {
                path = Some(rest.to_string());
            } else if let Some(rest) = line.strip_prefix("branch ") {
                branch = Some(rest.strip_prefix("refs/heads/").unwrap_or(rest).to_string());
            } else if line == "bare" {
                bare = true;
            }
        }
        if let (Some(path), false) = (path, bare) {
            let main = out.is_empty();
            out.push(Worktree { path, branch, main, add: 0, del: 0, dirty: 0 });
        }
    }
    out
}

fn count(tree: &mut Worktree, main_head: Option<&str>) {
    tree.dirty = git(&tree.path, &["status", "--porcelain"])
        .map(|out| out.lines().count() as u32)
        .unwrap_or(0);
    let base = if tree.main {
        Some("HEAD".to_string())
    } else {
        main_head
            .and_then(|head| git(&tree.path, &["merge-base", "HEAD", head]))
            .map(|out| out.trim().to_string())
    };
    if let Some(stat) = base.and_then(|base| git(&tree.path, &["diff", "--shortstat", &base])) {
        (tree.add, tree.del) = shortstat(&stat);
    }
}

/// ` 3 files changed, 10 insertions(+), 2 deletions(-)`; either count is left
/// out when it is zero, and the whole line is empty when nothing changed.
pub fn shortstat(line: &str) -> (u32, u32) {
    let mut add = 0;
    let mut del = 0;
    for part in line.trim().split(',') {
        let mut words = part.split_whitespace();
        let Some(n) = words.next().and_then(|n| n.parse().ok()) else { continue };
        match words.next() {
            Some(word) if word.starts_with("insertion") => add = n,
            Some(word) if word.starts_with("deletion") => del = n,
            _ => {}
        }
    }
    (add, del)
}

/// A new worktree of the repo whose main checkout is `path`, on `branch`: the
/// branch checked out if it exists, otherwise made from the main checkout's HEAD.
pub fn add(path: &str, branch: &str) -> Result<Worktree, String> {
    let home = std::env::var("HOME").ok().filter(|home| !home.is_empty()).ok_or("HOME is not set")?;
    add_under(&Path::new(&home).join(".crew").join("worktrees"), path, branch)
}

pub fn add_under(root: &Path, path: &str, branch: &str) -> Result<Worktree, String> {
    let branch = branch.trim();
    if branch.is_empty() {
        return Err("Branch name is required".into());
    }
    let main = main_checkout(path)?;
    run(&main, &["check-ref-format", "--branch", branch])
        .map_err(|_| format!("Not a valid branch name: {branch}"))?;
    let repo = Path::new(&main).file_name().map(|name| name.to_string_lossy().into_owned()).unwrap_or_default();
    let dir = root.join(repo).join(slug(branch));
    if dir.exists() {
        return Err(format!("{} already exists", dir.display()));
    }
    if let Some(parent) = dir.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("{}: {e}", parent.display()))?;
    }
    let target = dir.to_string_lossy().into_owned();
    let exists = run(&main, &["show-ref", "--verify", "--quiet", &format!("refs/heads/{branch}")]).is_ok();
    if exists {
        run(&main, &["worktree", "add", &target, branch])?;
    } else {
        run(&main, &["worktree", "add", "-b", branch, &target, "HEAD"])?;
    }
    // Git records the path resolved, so the row is looked up rather than built:
    // the path it carries is the one every later listing will show.
    let made = canonical(&target);
    list(&main)
        .into_iter()
        .find(|tree| canonical(&tree.path) == made)
        .ok_or_else(|| format!("git made {target} but does not list it"))
}

/// Removes a linked worktree and returns its path as git lists it. The main
/// checkout is the repo itself and is never removed; a worktree with changes
/// nobody committed is removed only when `force` says to throw them away.
pub fn remove(path: &str, force: bool) -> Result<String, String> {
    let trees = run(path, &["worktree", "list", "--porcelain"])
        .map(|out| parse(&out))
        .map_err(|_| format!("{path} is not a git worktree"))?;
    let wanted = canonical(path);
    let tree = trees
        .iter()
        .find(|tree| canonical(&tree.path) == wanted)
        .ok_or_else(|| format!("{path} is not a git worktree"))?;
    if tree.main {
        return Err("The main checkout cannot be removed".into());
    }
    let dirty = git(&tree.path, &["status", "--porcelain"]).is_some_and(|out| !out.trim().is_empty());
    if dirty && !force {
        return Err(format!("{path} has uncommitted changes"));
    }
    let mut args = vec!["worktree", "remove"];
    if force {
        args.push("--force");
    }
    args.push(&tree.path);
    run(&trees[0].path, &args)?;
    Ok(tree.path.clone())
}

/// The main checkout of the repo `path` is in, whichever worktree `path` is.
pub fn main_checkout(path: &str) -> Result<String, String> {
    let out = run(path, &["worktree", "list", "--porcelain"])
        .map_err(|_| format!("{path} is not a git repository"))?;
    parse(&out)
        .into_iter()
        .next()
        .map(|tree| tree.path)
        .ok_or_else(|| format!("{path} has no checkout to branch from"))
}

/// A branch as one folder name: `feat/avatars` is `feat-avatars`.
pub fn slug(branch: &str) -> String {
    branch
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-') { c } else { '-' })
        .collect()
}

fn canonical(path: &str) -> PathBuf {
    std::fs::canonicalize(path).unwrap_or_else(|_| PathBuf::from(path))
}

fn git(dir: &str, args: &[&str]) -> Option<String> {
    run(dir, args).ok()
}

/// Stdout on success; git's own complaint, without its `fatal: `, otherwise.
fn run(dir: &str, args: &[&str]) -> Result<String, String> {
    let output = Command::new("git")
        .arg("-C")
        .arg(dir)
        .args(args)
        // A listing refreshes on its own; it must never hold the index lock a
        // commit in the user's terminal is about to ask for.
        .env("GIT_OPTIONAL_LOCKS", "0")
        .output()
        .map_err(|e| format!("git: {e}"))?;
    if output.status.success() {
        return Ok(String::from_utf8_lossy(&output.stdout).into_owned());
    }
    let stderr = String::from_utf8_lossy(&output.stderr);
    let message = stderr
        .lines()
        .filter(|line| !line.starts_with("Preparing worktree"))
        .map(|line| line.strip_prefix("fatal: ").or(line.strip_prefix("error: ")).unwrap_or(line))
        .collect::<Vec<_>>()
        .join("\n");
    Err(if message.trim().is_empty() { format!("git {} failed", args.join(" ")) } else { message.trim().to_string() })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn row(path: &str, branch: Option<&str>, main: bool) -> Worktree {
        Worktree { path: path.into(), branch: branch.map(Into::into), main, add: 0, del: 0, dirty: 0 }
    }

    fn temp(prefix: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("{prefix}-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::canonicalize(dir).unwrap()
    }

    fn sh(dir: &Path, args: &[&str]) {
        let status = Command::new("git")
            .arg("-C")
            .arg(dir)
            .args(["-c", "user.name=crew", "-c", "user.email=crew@test", "-c", "commit.gpgsign=false"])
            .args(args)
            .output()
            .unwrap();
        assert!(status.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&status.stderr));
    }

    /// A repo named `app` on `main`, one commit of a ten-line file.
    fn repo() -> PathBuf {
        let dir = temp("crew-repo").join("app");
        std::fs::create_dir_all(&dir).unwrap();
        sh(&dir, &["init", "-q", "-b", "main"]);
        std::fs::write(dir.join("notes.txt"), (1..=10).map(|n| format!("{n}\n")).collect::<String>()).unwrap();
        sh(&dir, &["add", "."]);
        sh(&dir, &["commit", "-q", "-m", "init"]);
        dir
    }

    fn at(path: &Path) -> String {
        path.to_string_lossy().into_owned()
    }

    #[test]
    fn the_main_checkout_leads_and_branches_lose_their_ref_prefix() {
        let porcelain = "worktree /repo\nHEAD abc\nbranch refs/heads/master\n\nworktree /wt/feat\nHEAD def\nbranch refs/heads/feat/avatars\n\nworktree /wt/detached\nHEAD 123\ndetached\n";
        assert_eq!(
            parse(porcelain),
            vec![
                row("/repo", Some("master"), true),
                row("/wt/feat", Some("feat/avatars"), false),
                row("/wt/detached", None, false),
            ]
        );
    }

    #[test]
    fn a_bare_repository_is_not_a_worktree() {
        let porcelain = "worktree /repo.git\nbare\n\nworktree /wt/main\nHEAD abc\nbranch refs/heads/main\n";
        assert_eq!(parse(porcelain), vec![row("/wt/main", Some("main"), true)]);
    }

    #[test]
    fn a_folder_outside_git_is_one_branchless_worktree() {
        let path = at(&temp("crew-wt"));
        assert_eq!(list(&path), vec![row(&path, None, true)]);
    }

    #[test]
    fn shortstat_reads_whichever_counts_git_printed() {
        assert_eq!(shortstat(" 3 files changed, 10 insertions(+), 2 deletions(-)\n"), (10, 2));
        assert_eq!(shortstat(" 1 file changed, 1 insertion(+)\n"), (1, 0));
        assert_eq!(shortstat(" 1 file changed, 4 deletions(-)\n"), (0, 4));
        assert_eq!(shortstat(""), (0, 0));
    }

    #[test]
    fn a_branch_becomes_one_folder_name() {
        assert_eq!(slug("feat/avatars"), "feat-avatars");
        assert_eq!(slug("fix/socket replay:2"), "fix-socket-replay-2");
        assert_eq!(slug("v1.2_rc-3"), "v1.2_rc-3");
    }

    #[test]
    fn a_new_branch_forks_from_the_main_checkout_under_the_repo_name() {
        let repo = repo();
        let root = temp("crew-wt-root");

        let made = add_under(&root, &at(&repo), "feat/avatars").expect("add");

        assert_eq!(made.path, at(&root.join("app").join("feat-avatars")));
        assert_eq!((made.branch.as_deref(), made.main), (Some("feat/avatars"), false));
        assert!(Path::new(&made.path).join("notes.txt").is_file());
        let listed = list(&at(&repo));
        assert_eq!(listed.len(), 2);
        assert_eq!(listed[1].path, made.path, "add and list disagree on the path");
    }

    #[test]
    fn a_branch_that_exists_is_checked_out_not_recreated() {
        let repo = repo();
        let root = temp("crew-wt-root");
        sh(&repo, &["branch", "old-work"]);

        let made = add_under(&root, &at(&repo), "old-work").expect("add");

        assert_eq!(made.branch.as_deref(), Some("old-work"));
        let again = add_under(&temp("crew-wt-root"), &at(&repo), "old-work");
        // Older git says "already checked out at", newer "already used by worktree at".
        assert!(again.is_err_and(|e| e.contains("'old-work' is already")), "one branch in two worktrees");
    }

    #[test]
    fn adding_refuses_what_it_cannot_make() {
        let repo = repo();
        let root = temp("crew-wt-root");
        add_under(&root, &at(&repo), "taken").expect("first");

        let occupied = add_under(&root, &at(&repo), "taken");
        assert!(occupied.is_err_and(|e| e.contains("already exists")), "a folder was reused");
        let outside = add_under(&root, &at(&temp("crew-plain")), "feat");
        assert!(outside.is_err_and(|e| e.contains("not a git repository")));
        let invalid = add_under(&root, &at(&repo), "bad..name");
        assert!(invalid.is_err_and(|e| e.contains("Not a valid branch name")));
        assert!(add_under(&root, &at(&repo), "  ").is_err());
    }

    /// Committed work since the fork counts, and so does what is not committed
    /// yet; the main checkout counts only the latter.
    #[test]
    fn counts_run_from_the_fork_point_and_include_uncommitted_edits() {
        let repo = repo();
        let root = temp("crew-wt-root");
        let tree = PathBuf::from(add_under(&root, &at(&repo), "feat").expect("add").path);
        std::fs::write(tree.join("added.txt"), "a\nb\nc\n").unwrap();
        sh(&tree, &["add", "."]);
        sh(&tree, &["commit", "-q", "-m", "three lines"]);
        std::fs::write(tree.join("notes.txt"), (1..=9).map(|n| format!("{n}\n")).collect::<String>()).unwrap();
        std::fs::write(tree.join("scratch.txt"), "untracked\n").unwrap();
        // The main checkout moving on must not count against the worktree.
        std::fs::write(repo.join("later.txt"), "x\n").unwrap();
        sh(&repo, &["add", "."]);
        sh(&repo, &["commit", "-q", "-m", "later"]);
        std::fs::write(repo.join("notes.txt"), "rewritten\n").unwrap();

        let listed = list(&at(&repo));

        let feat = listed.iter().find(|t| t.branch.as_deref() == Some("feat")).expect("feat");
        assert_eq!((feat.add, feat.del, feat.dirty), (3, 1, 2));
        let main = &listed[0];
        assert_eq!((main.add, main.del, main.dirty), (1, 10, 1));
    }

    #[test]
    fn the_main_checkout_is_never_removed() {
        let repo = repo();
        let refused = remove(&at(&repo), true);
        assert!(refused.is_err_and(|e| e.contains("main checkout")));
        assert!(repo.join("notes.txt").is_file());
    }

    #[test]
    fn a_dirty_worktree_goes_only_when_forced() {
        let repo = repo();
        let root = temp("crew-wt-root");
        let path = add_under(&root, &at(&repo), "feat").expect("add").path;
        std::fs::write(Path::new(&path).join("notes.txt"), "changed\n").unwrap();

        let kept = remove(&path, false);
        assert!(kept.is_err_and(|e| e.contains("uncommitted")), "unsaved work was thrown away");
        assert!(Path::new(&path).is_dir());

        assert_eq!(remove(&path, true).expect("forced"), path);
        assert!(!Path::new(&path).exists());
        assert_eq!(list(&at(&repo)).len(), 1);
    }

    #[test]
    fn a_clean_worktree_is_removed_and_its_branch_kept() {
        let repo = repo();
        let root = temp("crew-wt-root");
        let path = add_under(&root, &at(&repo), "feat").expect("add").path;

        remove(&path, false).expect("remove");

        assert!(!Path::new(&path).exists());
        sh(&repo, &["show-ref", "--verify", "--quiet", "refs/heads/feat"]);
    }

    #[test]
    fn removing_what_is_not_a_worktree_says_so() {
        let plain = at(&temp("crew-plain"));
        assert!(remove(&plain, false).is_err_and(|e| e.contains("not a git worktree")));
    }
}
