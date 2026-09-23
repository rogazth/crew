//! Terminal starts when the process has run out of file descriptors. The limit
//! is process-wide, so this lives in its own binary.

use crew_core::pty::PtyHost;

/// The descriptor the next open would get.
fn lowest_free_fd() -> i32 {
    let fd = unsafe { libc::dup(2) };
    assert!(fd >= 0, "dup failed");
    unsafe { libc::close(fd) };
    fd
}

fn with_fd_limit<T>(limit: i32, run: impl FnOnce() -> T) -> T {
    let mut old = libc::rlimit { rlim_cur: 0, rlim_max: 0 };
    assert_eq!(unsafe { libc::getrlimit(libc::RLIMIT_NOFILE, &mut old) }, 0);
    let tight = libc::rlimit {
        rlim_cur: limit as libc::rlim_t,
        rlim_max: old.rlim_max,
    };
    assert_eq!(unsafe { libc::setrlimit(libc::RLIMIT_NOFILE, &tight) }, 0);
    let out = run();
    assert_eq!(unsafe { libc::setrlimit(libc::RLIMIT_NOFILE, &old) }, 0);
    out
}

#[test]
fn a_terminal_short_of_descriptors_fails_without_leaking_the_ones_it_got() {
    let host = PtyHost::new();
    let spawn = || host.spawn("t".into(), "/".into(), vec!["/bin/sh".into()], 80, 24);
    let free = lowest_free_fd();
    let cases = [
        (0, "Failed to open terminal: "),
        (1, "Failed to open terminal slave: "),
        (2, "Failed to duplicate terminal: "),
        (3, "Failed to duplicate terminal: "),
    ];
    for (spare, error) in cases {
        let err = with_fd_limit(free + spare, spawn).unwrap_err();
        assert!(err.starts_with(error), "with {spare} spare: {err}");
        assert_eq!(lowest_free_fd(), free, "with {spare} spare, descriptors leaked");
    }
    assert!(host.write("t", b"x").is_err());
}
