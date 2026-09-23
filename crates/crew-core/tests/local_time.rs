//! What a model reads as "when": stamps in the user's local time. The zone is
//! the process's, so this binary sets its own before anything reads it.

use std::sync::Once;

use crew_core::blocks::new_block;
use crew_core::mailbox::envelope;
use crew_core::store::stamp;
use crew_core::working_set::{render, TAIL_BUDGET};
use crew_protocol::{AgentRef, BlockRole};

extern "C" {
    fn tzset();
}

/// Half an hour off the hour and no daylight saving, so a stamp read in UTC or
/// a clock that drops the minutes of the offset cannot pass.
fn in_kolkata_time() {
    static ZONE: Once = Once::new();
    ZONE.call_once(|| {
        std::env::set_var("TZ", "IST-5:30");
        unsafe { tzset() };
    });
}

#[test]
fn a_stamp_is_the_local_date_and_clock_to_the_minute() {
    in_kolkata_time();
    assert_eq!(stamp(0), "1970-01-01 05:30");
    // 2026-09-23 10:07:00 UTC.
    assert_eq!(stamp(1_790_158_020_000), "2026-09-23 15:37");
    assert_eq!(stamp(1_790_158_020_000 + 59_999), "2026-09-23 15:37");
    // 2026-11-05 03:29:00 UTC: two-digit month, single-digit day.
    assert_eq!(stamp(1_793_849_340_000), "2026-11-05 08:59");
}

#[test]
fn a_stamp_turns_the_month_and_the_year_where_the_local_clock_does() {
    in_kolkata_time();
    // 2026-03-31 20:00 UTC is already April there.
    assert_eq!(stamp(1_774_987_200_000), "2026-04-01 01:30");
    // 2025-12-31 19:00 UTC is already the new year.
    assert_eq!(stamp(1_767_207_600_000), "2026-01-01 00:30");
}

/// The time it was written, not the time it was handed over: a letter that
/// waited an hour in a busy agent's box still says when it was written.
#[test]
fn the_envelope_says_when_it_was_written() {
    in_kolkata_time();
    let from = AgentRef { id: "s1".into(), name: "Coder".into() };
    assert_eq!(
        envelope(&from, "hi", 1_790_158_020_000, false),
        "## Message\nFrom: Coder (agent s1)\nAt: 2026-09-23 15:37\n\nhi"
    );
}

/// Every line says when, with the date and not only the clock: a turn is a
/// fresh session, so "yesterday" has nothing to count back from otherwise.
#[test]
fn every_line_says_when_it_happened() {
    in_kolkata_time();
    let mut block = new_block(BlockRole::User, "arregla el parser");
    block.at = Some(1_774_987_200_000);
    let out = render(&[block], TAIL_BUDGET).expect("history");
    assert!(out.ends_with("\n\n[2026-04-01 01:30 · user] arregla el parser"), "{out}");
}
