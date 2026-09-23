//! Helpers the crate's tests share. Each test owns what these return: the
//! directory is removed when its `TempDir` drops.

use std::future::Future;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::time::Duration;

use crate::store::Store;

/// Long enough for a spawned process on a loaded machine, short enough that a
/// hang fails the run in seconds.
pub const WITHIN: Duration = Duration::from_secs(10);

/// A fresh directory under /tmp. Short on purpose: a bridge socket inside it
/// has to fit in `sun_path`.
pub fn temp_dir() -> tempfile::TempDir {
    tempfile::Builder::new()
        .prefix("c")
        .tempdir_in("/tmp")
        .expect("temp dir")
}

/// A store on a real file in its own directory, migrated like the daemon's.
pub fn temp_store() -> (tempfile::TempDir, Store) {
    let dir = temp_dir();
    let store = Store::open(dir.path().join("crew.sqlite3")).expect("store");
    (dir, store)
}

/// Writes an executable `#!/bin/sh` script named `name` into `dir`, for
/// standing in for a provider CLI. The file is closed before this returns.
pub fn fake_cli(dir: &Path, name: &str, body: &str) -> PathBuf {
    let path = dir.join(name);
    std::fs::write(&path, format!("#!/bin/sh\n{body}\n")).expect("write fake cli");
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).expect("chmod fake cli");
    path
}

/// Awaits `future`, failing the test if it takes longer than [`WITHIN`].
pub async fn within<T>(what: &str, future: impl Future<Output = T>) -> T {
    tokio::time::timeout(WITHIN, future)
        .await
        .unwrap_or_else(|_| panic!("{what} did not finish within {WITHIN:?}"))
}

/// Polls `check` until it holds, failing the test after [`WITHIN`]. For state
/// a background thread settles, where there is nothing to await.
pub fn eventually(what: &str, mut check: impl FnMut() -> bool) {
    let start = std::time::Instant::now();
    while !check() {
        assert!(start.elapsed() < WITHIN, "{what} did not happen within {WITHIN:?}");
        std::thread::sleep(Duration::from_millis(5));
    }
}
