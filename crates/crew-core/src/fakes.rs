//! Where the tests' fake CLIs come from.
//!
//! The system vets an executable file the first time it runs, one file at a
//! time: about 150 ms for a script written a moment ago, and with the suite's
//! threads starting their fakes together, a second or two each. A fake written
//! afresh into every test's folder paid that in every test. So a script is
//! written once for the run and each folder gets a hard link to it, which is
//! the same file and has been through that already (23 ms to start, however
//! many start at once). A script therefore cannot name its folder: it finds
//! it from the path it was started by (`sys.argv[0]`).
//!
//! A Python fake also ends once the process that started it is gone. Each
//! host ends its children on the way out, but a test binary that panics or is
//! killed does not, and a fake blocked anywhere but stdin would then run
//! for days (one did: `3c7d192` fixed the reading, not the cause).

use std::collections::HashMap;
use std::hash::{DefaultHasher, Hash, Hasher};
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

/// The scripts written so far, by their text, and where.
static MASTERS: Mutex<Option<HashMap<String, PathBuf>>> = Mutex::new(None);

/// Put after a Python fake's shebang: a thread that ends the process once its
/// parent is gone, which the parent id changing says.
const PYTHON_ORPHAN_GUARD: &str = "\
import os as _crew_os, threading as _crew_threading, time as _crew_time
def _crew_end_with_parent(parent=_crew_os.getppid()):
    while _crew_os.getppid() == parent:
        _crew_time.sleep(0.5)
    _crew_os._exit(0)
_crew_threading.Thread(target=_crew_end_with_parent, daemon=True).start()
";

/// `script` as it is written: a Python one with the orphan guard after its shebang.
fn guarded(script: &str) -> String {
    match script.split_once('\n') {
        Some((shebang, rest)) if shebang.starts_with("#!") && shebang.contains("python") => {
            format!("{shebang}\n{PYTHON_ORPHAN_GUARD}{rest}")
        }
        _ => script.to_string(),
    }
}

/// Puts the executable `script` in `dir` as `name` and returns its path.
pub(crate) fn install(dir: &Path, name: &str, script: &str) -> PathBuf {
    let master = {
        let mut masters = MASTERS.lock().unwrap_or_else(|e| e.into_inner());
        masters
            .get_or_insert_with(HashMap::new)
            .entry(script.to_string())
            .or_insert_with(|| write_master(script))
            .clone()
    };
    let path = dir.join(name);
    let _ = std::fs::remove_file(&path);
    // Another volume, or a filesystem with no links: a copy is a fresh file
    // to the system, slower to start and as correct.
    if std::fs::hard_link(&master, &path).is_err() {
        std::fs::copy(&master, &path).expect("copy fake");
    }
    path
}

fn write_master(script: &str) -> PathBuf {
    let mut hasher = DefaultHasher::new();
    script.hash(&mut hasher);
    let dir = std::env::temp_dir().join(format!("crew-fakes-{}", std::process::id()));
    std::fs::create_dir_all(&dir).expect("fakes dir");
    let path = dir.join(format!("fake-{:016x}", hasher.finish()));
    std::fs::write(&path, guarded(script)).expect("write fake");
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).expect("chmod");
    path
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Two folders get the one file, and each reaches it by its own path.
    #[test]
    fn a_script_is_written_once_and_each_folder_links_to_it() {
        let root = std::env::temp_dir().join(format!("crew-fakes-test-{}", uuid::Uuid::new_v4()));
        let (one, two) = (root.join("one"), root.join("two"));
        std::fs::create_dir_all(&one).unwrap();
        std::fs::create_dir_all(&two).unwrap();
        let script = format!("#!/bin/sh\necho {}\n", uuid::Uuid::new_v4());
        let (a, b) = (install(&one, "fake", &script), install(&two, "fake", &script));
        assert_eq!((a.parent(), b.parent()), (Some(one.as_path()), Some(two.as_path())));
        assert_eq!(std::fs::read_to_string(&a).unwrap(), script);
        assert_eq!(std::fs::read_to_string(&b).unwrap(), script);
        assert_eq!(std::fs::metadata(&a).unwrap().permissions().mode() & 0o111, 0o111);
        use std::os::unix::fs::MetadataExt;
        assert_eq!(std::fs::metadata(&a).unwrap().ino(), std::fs::metadata(&b).unwrap().ino());
        // Installed again in the same folder, it replaces what was there.
        assert_eq!(install(&one, "fake", &script), a);
    }

    /// A fake whose test is gone ends too, however it was blocked.
    #[test]
    fn a_python_fake_ends_once_its_parent_is_gone() {
        use std::process::{Command, Stdio};
        let dir = std::env::temp_dir().join(format!("crew-fakes-orphan-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let pid_file = dir.join("fake.pid");
        let script = format!(
            "#!/usr/bin/env python3\nimport os, time\nopen({:?}, 'w').write(str(os.getpid()))\ntime.sleep(300)\n",
            pid_file.to_string_lossy()
        );
        assert!(guarded(&script).contains("_crew_end_with_parent"));
        let fake = install(&dir, "fake", &script);
        // A shell that starts the fake in the background and leaves: the fake's
        // parent is gone, as when a test binary dies.
        let status = Command::new("/bin/sh")
            .arg("-c")
            .arg(format!("{:?} </dev/null >/dev/null 2>&1 & sleep 1", fake.to_string_lossy()))
            .stdin(Stdio::null())
            .status()
            .unwrap();
        assert!(status.success());
        let pid: i32 = std::fs::read_to_string(&pid_file).expect("the fake never started").trim().parse().unwrap();
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
        while unsafe { libc::kill(pid, 0) } == 0 {
            assert!(std::time::Instant::now() < deadline, "the fake outlived its parent");
            std::thread::sleep(std::time::Duration::from_millis(100));
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_shell_fake_is_written_as_it_is() {
        assert_eq!(guarded("#!/bin/sh\necho hi\n"), "#!/bin/sh\necho hi\n");
    }
}
