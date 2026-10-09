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

use std::collections::HashMap;
use std::hash::{DefaultHasher, Hash, Hasher};
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

/// The scripts written so far, by their text, and where.
static MASTERS: Mutex<Option<HashMap<String, PathBuf>>> = Mutex::new(None);

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
    std::fs::write(&path, script).expect("write fake");
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
}
