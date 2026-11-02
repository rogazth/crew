//! A watchdog for the daemon's async runtime: a task that wakes once a second and
//! says so when it was woken late. The recent bugs were workers parked on a slow
//! client, and a stalled runtime is silent: nothing is logged by what cannot run.
//!
//! What a late tick means: every worker was busy or blocked for that long (the
//! tick would have been picked up by any free one). It is written as `runtime.stall`
//! at WARN with the delay. Cost: one wakeup a second and two clock reads.
//!
//! A machine that sleeps must not read as a stall. `Instant` is `CLOCK_MONOTONIC` on
//! Linux and the mach uptime clock on macOS, and neither counts suspended time, so a
//! sleep does not make a tick late by itself. The wall clock does count it, so the
//! two are compared as well: a tick whose wall time ran well past its monotonic time
//! spans a sleep (or a clock set forward) and is skipped. A wall clock that went
//! backwards says nothing, and the monotonic reading stands.

use std::time::{Duration, Instant, SystemTime};

/// How often the watchdog wakes.
pub const TICK: Duration = Duration::from_secs(1);
/// How late a tick has to be to be written.
pub const STALL_AT: Duration = Duration::from_secs(2);

/// How late a tick was, when that is a stall: `None` for a tick on time and for one that spans a sleep.
pub fn stall(tick: Duration, threshold: Duration, mono: Duration, wall: Option<Duration>) -> Option<Duration> {
    let late = mono.saturating_sub(tick);
    if late < threshold {
        return None;
    }
    // The wall clock saw time pass that the monotonic one did not.
    if wall.is_some_and(|wall| wall.saturating_sub(mono) >= threshold) {
        return None;
    }
    Some(late)
}

/// Runs for as long as the runtime does. `who` names the runtime in the line.
pub async fn watch(who: &'static str, tick: Duration, threshold: Duration) {
    let mut mono = Instant::now();
    let mut wall = SystemTime::now();
    loop {
        tokio::time::sleep(tick).await;
        let (mono_elapsed, wall_elapsed) = (mono.elapsed(), wall.elapsed().ok());
        mono = Instant::now();
        wall = SystemTime::now();
        if let Some(late) = stall(tick, threshold, mono_elapsed, wall_elapsed) {
            tracing::warn!(runtime = who, late_ms = crew_core::trace::ms(late), "runtime.stall");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const S: fn(u64) -> Duration = Duration::from_millis;

    fn unique() -> u128 {
        std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0)
            ^ u128::from(std::process::id())
    }

    #[test]
    fn a_tick_on_time_or_a_little_late_is_not_a_stall() {
        assert_eq!(stall(S(1000), S(2000), S(1000), Some(S(1000))), None);
        assert_eq!(stall(S(1000), S(2000), S(2900), Some(S(2900))), None, "1.9 s late is under the line");
    }

    #[test]
    fn a_tick_two_seconds_late_is_a_stall_by_how_late_it_was() {
        assert_eq!(stall(S(1000), S(2000), S(3000), Some(S(3000))), Some(S(2000)));
        assert_eq!(stall(S(1000), S(2000), S(9500), Some(S(9520))), Some(S(8500)));
        // No wall reading (the clock went backwards): the monotonic one stands.
        assert_eq!(stall(S(1000), S(2000), S(5000), None), Some(S(4000)));
    }

    #[test]
    fn a_tick_that_spans_a_sleep_is_skipped() {
        // The monotonic clock stood still for the hour the lid was down; the wall clock did not.
        assert_eq!(stall(S(1000), S(2000), S(1100), Some(Duration::from_secs(3600))), None);
        // Even when it also came back late: the sleep explains what the wall clock shows.
        assert_eq!(stall(S(1000), S(2000), S(4000), Some(Duration::from_secs(3600))), None);
    }

    /// A worker blocked for longer than the line is written once it is free again. The only
    /// worker, so nothing else can pick the tick up.
    #[test]
    fn a_runtime_whose_only_worker_is_blocked_writes_runtime_stall() {
        use crew_core::trace::capture;
        crate::tests::traced();
        let who = Box::leak(format!("test-{}", unique()).into_boxed_str());
        let runtime = tokio::runtime::Builder::new_current_thread().enable_time().build().expect("runtime");
        runtime.block_on(async {
            let watching = tokio::spawn(watch(who, S(20), S(100)));
            tokio::time::sleep(S(60)).await;
            // What a worker parked on a slow client looks like from here.
            std::thread::sleep(S(400));
            tokio::time::sleep(S(60)).await;
            watching.abort();
        });
        let line = capture::expect("runtime.stall", "runtime", who);
        assert_eq!(line.level, tracing::Level::WARN);
        let late: u64 = line.get("late_ms").expect("late_ms").parse().expect("a number");
        assert!(late >= 300, "a 400 ms block read as {late} ms late");
    }

    #[test]
    fn a_runtime_that_is_free_writes_nothing() {
        use crew_core::trace::capture;
        crate::tests::traced();
        let who = Box::leak(format!("calm-{}", unique()).into_boxed_str());
        let runtime = tokio::runtime::Builder::new_current_thread().enable_time().build().expect("runtime");
        // Ticks of 10 ms against a line of 10 s: nothing can be that late in a test.
        runtime.block_on(async {
            let watching = tokio::spawn(watch(who, S(10), Duration::from_secs(10)));
            tokio::time::sleep(S(100)).await;
            watching.abort();
        });
        assert!(capture::find("runtime.stall", "runtime", who).is_empty());
    }
}
