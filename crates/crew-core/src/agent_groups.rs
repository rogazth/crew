//! The process groups `crewd` started (agents, terminals, supervised
//! processes), kept on disk so a `crewd` that crashed (or was SIGKILLed) can
//! kill what they left behind. One registry per daemon: the hosts share it,
//! since each write replaces the whole file.
//!
//! An environment marker cannot find them: `npm exec` rewrites its command
//! line and hides its environment from `ps`. A group id is the one handle that
//! survives, and it is only meaningful within the boot that issued it, and
//! while nobody else has been handed the same number: an entry outlives its
//! group whenever `crewd` exits before the reaper removed it. So each entry also
//! records when the leader started, and the sweep kills a group only when that
//! still matches.

use std::collections::BTreeMap;
use std::io::Write;
use std::os::unix::fs::OpenOptionsExt;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize)]
struct File {
    /// Unix seconds the machine booted. Pids mean nothing across a reboot.
    boot: i64,
    groups: Vec<Group>,
}

#[derive(Serialize, Deserialize)]
struct Group {
    pgid: u32,
    /// When the leader started, in unix seconds as the OS reports it; 0 when
    /// the OS would not say. The leader is the one process whose pid is the
    /// group id, so a different start time means the number was handed out again.
    started: i64,
}

/// How far two readings of the same start time may differ: the Linux one is
/// derived from ticks and a boot time that are each rounded to a second.
const START_SLACK: i64 = 1;

/// The live groups, mirrored to `path` on every change. Writes happen under
/// the mutex so two threads cannot interleave a stale list over a fresh one.
pub struct Registry {
    path: PathBuf,
    boot: i64,
    groups: Mutex<BTreeMap<u32, i64>>,
}

impl Registry {
    pub fn new(path: PathBuf) -> Self {
        let registry = Self {
            path,
            boot: boot_time().unwrap_or(0),
            groups: Mutex::new(BTreeMap::new()),
        };
        // Start from the current boot with nothing in it, whatever the file held.
        let groups = registry.groups.lock().unwrap_or_else(|e| e.into_inner());
        registry.write(&groups);
        drop(groups);
        registry
    }

    /// Call right after the leader was spawned, while its start time can
    /// still be read.
    pub(crate) fn add(&self, pgid: u32) {
        let started = process_start(pgid).unwrap_or(0);
        let mut groups = self.groups.lock().unwrap_or_else(|e| e.into_inner());
        if groups.insert(pgid, started) != Some(started) {
            self.write(&groups);
        }
    }

    pub(crate) fn remove(&self, pgid: u32) {
        let mut groups = self.groups.lock().unwrap_or_else(|e| e.into_inner());
        if groups.remove(&pgid).is_some() {
            self.write(&groups);
        }
    }

    /// Drop every group that has no member left. The reaper threads do this
    /// one by one; this is for a shutdown that may not wait for them.
    pub(crate) fn prune(&self) {
        let mut groups = self.groups.lock().unwrap_or_else(|e| e.into_inner());
        let before = groups.len();
        groups.retain(|&pgid, _| group_exists(pgid));
        if groups.len() != before {
            self.write(&groups);
        }
    }

    fn write(&self, groups: &BTreeMap<u32, i64>) {
        let groups = groups
            .iter()
            .map(|(&pgid, &started)| Group { pgid, started })
            .collect();
        write_file(&self.path, self.boot, groups);
    }
}

/// Kill what is left of the groups a previous `crewd` registered, then leave
/// the file at the current boot with no groups. A missing or unreadable file
/// (or one in an older shape) is not an error, and groups from another boot are
/// left alone: those pids belong to other processes now.
///
/// Within the boot a pid may still have been handed out again, so each group
/// has to prove it is the one registered:
/// - a process with the group's id exists: it is the leader only if it started
///   when the entry says; otherwise the number is somebody else's;
/// - no such process, but the group still has members: the leader died and its
///   helpers remain. A pid is not reused while it names a live group, so this
///   one is ours;
/// - neither: nothing to do.
pub fn sweep(path: &Path) {
    let now = boot_time();
    let previous = std::fs::read(path)
        .ok()
        .and_then(|bytes| serde_json::from_slice::<File>(&bytes).ok());
    if let (Some(previous), Some(now)) = (previous, now) {
        if previous.boot == now {
            for group in previous.groups {
                if is_ours(&group) {
                    kill_group(group.pgid);
                }
            }
        }
    }
    write_file(path, now.unwrap_or(0), Vec::new());
}

fn is_ours(group: &Group) -> bool {
    let pid = group.pgid;
    if pid <= 1 || pid > i32::MAX as u32 {
        return false;
    }
    if process_exists(pid) {
        return match (process_start(pid), group.started) {
            (Some(now), then) if then > 0 => (now - then).abs() <= START_SLACK,
            // Cannot tell: better a leftover than a stranger.
            _ => false,
        };
    }
    group_exists(pid)
}

fn process_exists(pid: u32) -> bool {
    let status = unsafe { libc::kill(pid as i32, 0) };
    status == 0 || std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
}

fn group_exists(pgid: u32) -> bool {
    pgid > 1 && pgid <= i32::MAX as u32 && unsafe { libc::kill(-(pgid as i32), 0) } == 0
}

fn kill_group(pgid: u32) {
    // 0 and 1 would be every group or init's; a corrupt file must not get there.
    if pgid <= 1 || pgid > i32::MAX as u32 {
        return;
    }
    unsafe {
        libc::kill(-(pgid as i32), libc::SIGKILL);
    }
}

/// Write a temp file next to `path` and rename it over, so a crash mid-write
/// leaves the old list, never half of one. Failing is silent: the registry is
/// a safety net, and the agents run the same without it.
fn write_file(path: &Path, boot: i64, groups: Vec<Group>) {
    let Ok(json) = serde_json::to_vec(&File { boot, groups }) else {
        return;
    };
    let mut tmp = path.as_os_str().to_owned();
    tmp.push(".tmp");
    let tmp = PathBuf::from(tmp);
    let written = std::fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .mode(0o600)
        .open(&tmp)
        .and_then(|mut file| file.write_all(&json));
    if written.is_err() || std::fs::rename(&tmp, path).is_err() {
        let _ = std::fs::remove_file(&tmp);
    }
}

/// When the machine booted, in unix seconds. `None` when the OS does not say,
/// in which case nothing is swept: better a leftover than somebody else's pid.
#[cfg(target_os = "macos")]
pub fn boot_time() -> Option<i64> {
    let mut mib = [libc::CTL_KERN, libc::KERN_BOOTTIME];
    let mut boot = libc::timeval { tv_sec: 0, tv_usec: 0 };
    let mut size = std::mem::size_of::<libc::timeval>();
    let status = unsafe {
        libc::sysctl(
            mib.as_mut_ptr(),
            mib.len() as libc::c_uint,
            &mut boot as *mut libc::timeval as *mut libc::c_void,
            &mut size,
            std::ptr::null_mut(),
            0,
        )
    };
    (status == 0 && boot.tv_sec > 0).then(|| boot.tv_sec as i64)
}

#[cfg(target_os = "linux")]
pub fn boot_time() -> Option<i64> {
    let stat = std::fs::read_to_string("/proc/stat").ok()?;
    let seconds = stat
        .lines()
        .find_map(|line| line.strip_prefix("btime "))?
        .trim()
        .parse::<i64>()
        .ok()?;
    (seconds > 0).then_some(seconds)
}

#[cfg(not(any(target_os = "macos", target_os = "linux")))]
pub fn boot_time() -> Option<i64> {
    None
}

/// When the process started, in unix seconds, as the OS keeps it (not the wall
/// clock now), so two readings of the same process agree. `None` when the
/// process is gone or the OS will not say.
#[cfg(target_os = "macos")]
pub fn process_start(pid: u32) -> Option<i64> {
    let mut info: libc::proc_bsdinfo = unsafe { std::mem::zeroed() };
    let size = std::mem::size_of::<libc::proc_bsdinfo>() as libc::c_int;
    let written = unsafe {
        libc::proc_pidinfo(
            pid as libc::c_int,
            libc::PROC_PIDTBSDINFO,
            0,
            &mut info as *mut libc::proc_bsdinfo as *mut libc::c_void,
            size,
        )
    };
    (written == size && info.pbi_start_tvsec > 0).then(|| info.pbi_start_tvsec as i64)
}

#[cfg(target_os = "linux")]
pub fn process_start(pid: u32) -> Option<i64> {
    let stat = std::fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
    // The command name is in parentheses and may hold spaces and parentheses
    // itself; the fields that matter come after the last one. Field 22 is the
    // 20th after `state` (field 3), which is the first token past it.
    let after = &stat[stat.rfind(')')? + 1..];
    let ticks: i64 = after.split_whitespace().nth(19)?.parse().ok()?;
    let per_second = unsafe { libc::sysconf(libc::_SC_CLK_TCK) };
    if per_second <= 0 {
        return None;
    }
    Some(boot_time()? + ticks / per_second as i64)
}

#[cfg(not(any(target_os = "macos", target_os = "linux")))]
pub fn process_start(_pid: u32) -> Option<i64> {
    None
}
