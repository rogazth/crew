//! One daemon per data folder.
//!
//! A second crewd on a folder already in use would take the bridge socket from
//! the first (it replaces `crew.sock`), open the same database and settle the
//! other daemon's running sessions as idle. A packaged build launched next to
//! the installed app did exactly that, so the folder is locked before anything
//! in it is touched.

use std::fs::{File, OpenOptions};
use std::os::unix::io::AsRawFd;
use std::path::Path;

/// Held for the daemon's lifetime. The kernel lets go of it when the process
/// exits, however it exits, so a crash leaves nothing stale behind.
pub struct DataLock {
    _file: File,
}

impl DataLock {
    pub fn acquire(dir: &Path) -> Result<Self, String> {
        let path = dir.join("crewd.lock");
        // std opens with O_CLOEXEC: terminals and agents never inherit the lock,
        // so one left running can't keep the next daemon out.
        let file = OpenOptions::new()
            .create(true)
            .truncate(false)
            .write(true)
            .open(&path)
            .map_err(|e| format!("{}: {e}", path.display()))?;
        if unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } != 0 {
            let error = std::io::Error::last_os_error();
            return Err(if error.raw_os_error() == Some(libc::EWOULDBLOCK) {
                format!("another crewd is already using {}", dir.display())
            } else {
                format!("{}: {error}", path.display())
            });
        }
        Ok(Self { _file: file })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_second_lock_on_the_same_folder_is_refused_until_the_first_goes() {
        let dir = std::env::temp_dir().join(format!("crewd-lock-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();

        let first = DataLock::acquire(&dir).unwrap();
        let refused = DataLock::acquire(&dir).err().unwrap();
        assert!(refused.contains("another crewd is already using"), "{refused}");

        drop(first);
        // A child another test forks meanwhile holds the descriptor until its
        // exec closes it, and the lock with it: that takes a moment, not more.
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(2);
        let mut again = DataLock::acquire(&dir);
        while again.is_err() && std::time::Instant::now() < deadline {
            std::thread::sleep(std::time::Duration::from_millis(10));
            again = DataLock::acquire(&dir);
        }
        assert!(again.is_ok(), "{:?}", again.err());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
