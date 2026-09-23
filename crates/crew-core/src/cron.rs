const MONTHS: &[&str] = &[
    "jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec",
];
const DAYS: &[&str] = &["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
const SEARCH_DAYS: i32 = 1830;

#[derive(Clone, Debug)]
pub struct CronSpec {
    minute: Vec<u32>,
    hour: Vec<u32>,
    dom: Vec<u32>,
    month: Vec<u32>,
    dow: Vec<u32>,
    dom_restricted: bool,
    dow_restricted: bool,
}

pub fn parse_cron(expression: &str) -> Option<CronSpec> {
    let lowered = expression.trim().to_ascii_lowercase();
    let parts: Vec<&str> = lowered.split_whitespace().collect();
    if parts.len() != 5 {
        return None;
    }
    let minute = parse_field(parts[0], 0, 59, None, 0)?;
    let hour = parse_field(parts[1], 0, 23, None, 0)?;
    let dom = parse_field(parts[2], 1, 31, None, 0)?;
    let month = parse_field(parts[3], 1, 12, Some(MONTHS), 1)?;
    let dow = parse_field(parts[4], 0, 6, Some(DAYS), 0)?;
    Some(CronSpec {
        minute,
        hour,
        dom,
        month,
        dow,
        dom_restricted: parts[2] != "*",
        dow_restricted: parts[4] != "*",
    })
}

pub fn is_valid_cron(expression: &str) -> bool {
    parse_cron(expression).is_some()
}

pub fn next_cron(spec: &CronSpec, from_ms: i64) -> Option<i64> {
    let mut cursor = add_minute(floor_minute(from_ms));
    let start = cursor;
    for day in 0..SEARCH_DAYS {
        if matches_day(spec, cursor) {
            let (floor_hour, floor_minute) = if day == 0 {
                hour_minute(start)
            } else {
                (0, 0)
            };
            for &hour in &spec.hour {
                if hour < floor_hour {
                    continue;
                }
                for &minute in &spec.minute {
                    if hour == floor_hour && minute < floor_minute {
                        continue;
                    }
                    // In the hour a clock repeats, a local time can settle on
                    // its first occurrence, which is behind `from_ms`.
                    let at = set_clock(cursor, hour, minute);
                    if at > from_ms {
                        return Some(at);
                    }
                }
            }
        }
        cursor = next_midnight(cursor);
    }
    None
}

fn parse_field(
    field: &str,
    min: u32,
    max: u32,
    names: Option<&[&str]>,
    name_base: u32,
) -> Option<Vec<u32>> {
    let mut values = std::collections::BTreeSet::new();
    for part in field.split(',') {
        let (range, step) = match part.split_once('/') {
            Some((range, step)) => (range, Some(step)),
            None => (part, None),
        };
        if range.is_empty() || step == Some("") {
            return None;
        }
        let by: u32 = match step {
            Some(step) => step.parse().ok().filter(|n| *n >= 1)?,
            None => 1,
        };
        let (mut lo, mut hi) = if range == "*" {
            (min, max)
        } else {
            let mut bits = range.split('-');
            let from_text = bits.next()?;
            let to_text = bits.next();
            if bits.next().is_some() {
                return None;
            }
            let parsed_lo = named(from_text, names, name_base)?;
            let parsed_hi = match to_text {
                None if step.is_none() => parsed_lo,
                None => max,
                Some(to_text) => named(to_text, names, name_base)?,
            };
            (parsed_lo, parsed_hi)
        };
        if names == Some(DAYS) {
            if lo == 7 {
                lo = 0;
            }
            if hi == 7 {
                hi = 0;
            }
        }
        if lo < min || hi > max || lo > hi {
            return None;
        }
        let mut value = lo;
        while value <= hi {
            values.insert(value);
            value = value.saturating_add(by);
            if by == 0 {
                break;
            }
        }
    }
    if values.is_empty() {
        None
    } else {
        Some(values.into_iter().collect())
    }
}

fn named(text: &str, names: Option<&[&str]>, base: u32) -> Option<u32> {
    if let Some(names) = names {
        if let Some(index) = names.iter().position(|name| *name == text) {
            return Some(index as u32 + base);
        }
    }
    text.parse().ok()
}

fn matches_day(spec: &CronSpec, at: i64) -> bool {
    let (month, date, wday) = day_parts(at);
    if !spec.month.contains(&month) {
        return false;
    }
    let dom = spec.dom.contains(&date);
    let dow = spec.dow.contains(&wday);
    if spec.dom_restricted && spec.dow_restricted {
        return dom || dow;
    }
    if spec.dom_restricted {
        return dom;
    }
    if spec.dow_restricted {
        return dow;
    }
    true
}

fn local_tm(ms: i64) -> libc::tm {
    let secs = (ms / 1000) as libc::time_t;
    let mut tm = unsafe { std::mem::zeroed() };
    unsafe {
        libc::localtime_r(&secs, &mut tm);
    }
    tm
}

fn from_tm(mut tm: libc::tm) -> i64 {
    tm.tm_sec = 0;
    tm.tm_isdst = -1;
    let secs = unsafe { libc::mktime(&mut tm) };
    secs as i64 * 1000
}

fn floor_minute(ms: i64) -> i64 {
    let mut tm = local_tm(ms);
    tm.tm_sec = 0;
    from_tm(tm)
}

fn add_minute(ms: i64) -> i64 {
    let mut tm = local_tm(ms);
    tm.tm_min += 1;
    from_tm(tm)
}

fn next_midnight(ms: i64) -> i64 {
    let mut tm = local_tm(ms);
    tm.tm_mday += 1;
    tm.tm_hour = 0;
    tm.tm_min = 0;
    tm.tm_sec = 0;
    from_tm(tm)
}

fn hour_minute(ms: i64) -> (u32, u32) {
    let tm = local_tm(ms);
    (tm.tm_hour as u32, tm.tm_min as u32)
}

fn day_parts(ms: i64) -> (u32, u32, u32) {
    let tm = local_tm(ms);
    (tm.tm_mon as u32 + 1, tm.tm_mday as u32, tm.tm_wday as u32)
}

fn set_clock(ms: i64, hour: u32, minute: u32) -> i64 {
    let mut tm = local_tm(ms);
    tm.tm_hour = hour as i32;
    tm.tm_min = minute as i32;
    tm.tm_sec = 0;
    from_tm(tm)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Local wall clock: a cron line is read in the user's own day.
    fn at(year: i32, month: i32, day: i32, hour: i32, minute: i32) -> i64 {
        let mut tm: libc::tm = unsafe { std::mem::zeroed() };
        tm.tm_year = year - 1900;
        tm.tm_mon = month - 1;
        tm.tm_mday = day;
        tm.tm_hour = hour;
        tm.tm_min = minute;
        from_tm(tm)
    }

    fn next(expression: &str, from: i64) -> Option<i64> {
        next_cron(&parse_cron(expression).expect("valid cron"), from)
    }

    /// These are the cases `src/lib/cron.test.ts` asserts. Cron is written twice
    /// — the editor validates what you type, the daemon fires what it stored —
    /// so the two answer the same or the routine runs at a time nobody chose.
    #[test]
    fn parse_cron_takes_five_fields_and_nothing_else() {
        assert!(parse_cron("* * * *").is_none());
        assert!(parse_cron("0 0 * * * *").is_none());
        assert!(parse_cron("").is_none());
    }

    #[test]
    fn a_field_out_of_range_is_not_a_cron() {
        for bad in ["60 * * * *", "* 24 * * *", "* * 0 * *", "*/0 * * * *", "5-1 * * * *", "a * * * *"] {
            assert!(!is_valid_cron(bad), "{bad} passed");
        }
    }

    #[test]
    fn steps_ranges_and_lists_expand() {
        assert_eq!(parse_cron("*/15 * * * *").unwrap().minute, vec![0, 15, 30, 45]);
        assert_eq!(parse_cron("0 9-11 * * *").unwrap().hour, vec![9, 10, 11]);
        assert_eq!(parse_cron("0,30 * * * *").unwrap().minute, vec![0, 30]);
        assert_eq!(parse_cron("0 0 1 */3 *").unwrap().month, vec![1, 4, 7, 10]);
    }

    #[test]
    fn day_and_month_names_read_as_numbers() {
        assert_eq!(parse_cron("0 9 * * mon-fri").unwrap().dow, vec![1, 2, 3, 4, 5]);
        assert_eq!(parse_cron("0 0 1 jan,jul *").unwrap().month, vec![1, 7]);
        // Both spellings of Sunday.
        assert_eq!(parse_cron("0 0 * * 7").unwrap().dow, vec![0]);
    }

    #[test]
    fn next_cron_fires_strictly_after_the_moment_it_was_given() {
        // Wed Sep 3 2025, 09:00 exactly.
        assert_eq!(next("0 9 * * *", at(2025, 9, 3, 9, 0)), Some(at(2025, 9, 4, 9, 0)));
        assert_eq!(next("0 9 * * *", at(2025, 9, 3, 8, 59)), Some(at(2025, 9, 3, 9, 0)));
    }

    #[test]
    fn next_cron_walks_to_the_next_matching_weekday() {
        assert_eq!(next("30 7 * * mon", at(2025, 9, 3, 12, 0)), Some(at(2025, 9, 8, 7, 30)));
    }

    #[test]
    fn next_cron_takes_the_earliest_hour_and_minute_of_a_matching_day() {
        assert_eq!(next("*/20 9,17 * * *", at(2025, 9, 3, 9, 25)), Some(at(2025, 9, 3, 9, 40)));
        assert_eq!(next("*/20 9,17 * * *", at(2025, 9, 3, 9, 45)), Some(at(2025, 9, 3, 17, 0)));
    }

    /// The 1st of the month or any Monday, whichever comes first — cron's one
    /// genuinely surprising rule.
    #[test]
    fn next_cron_matches_either_day_field_when_both_are_restricted() {
        assert_eq!(next("0 0 1 * mon", at(2025, 9, 3, 12, 0)), Some(at(2025, 9, 8, 0, 0)));
        assert_eq!(next("0 0 1 * mon", at(2025, 9, 29, 12, 0)), Some(at(2025, 10, 1, 0, 0)));
    }

    #[test]
    fn next_cron_reaches_a_leap_day_years_out() {
        assert_eq!(next("0 0 29 2 *", at(2025, 9, 3, 0, 0)), Some(at(2028, 2, 29, 0, 0)));
    }

    #[test]
    fn next_cron_crosses_the_year_boundary() {
        assert_eq!(next("0 0 1 1 *", at(2025, 12, 31, 23, 59)), Some(at(2026, 1, 1, 0, 0)));
    }

    /// Nothing matches February 30th, and the search has to stop rather than
    /// walk forward for ever.
    #[test]
    fn a_date_that_never_comes_answers_with_nothing() {
        assert_eq!(next("0 0 30 2 *", at(2025, 9, 3, 0, 0)), None);
    }

    /// Which of the five fields a case reads back.
    type Pick = fn(CronSpec) -> Vec<u32>;

    fn field(expression: &str, pick: Pick) -> Vec<u32> {
        pick(parse_cron(expression).unwrap_or_else(|| panic!("{expression} did not parse")))
    }

    #[test]
    fn every_way_of_writing_a_field_expands_to_the_values_it_means() {
        let minute = |spec: CronSpec| spec.minute;
        let hour = |spec: CronSpec| spec.hour;
        let dom = |spec: CronSpec| spec.dom;
        let month = |spec: CronSpec| spec.month;
        let dow = |spec: CronSpec| spec.dow;
        let cases: Vec<(&str, Pick, Vec<u32>)> = vec![
            ("7 * * * *", minute, vec![7]),
            ("0 9-12 * * *", hour, vec![9, 10, 11, 12]),
            ("0-30/10 * * * *", minute, vec![0, 10, 20, 30]),
            // A start with a step and no end runs to the top of the field.
            ("5/15 * * * *", minute, vec![5, 20, 35, 50]),
            ("0 */6 * * *", hour, vec![0, 6, 12, 18]),
            ("0-5/10 * * * *", minute, vec![0]),
            ("0 0 */10 * *", dom, vec![1, 11, 21, 31]),
            // Lists are sorted and deduplicated, and may mix ranges and values.
            ("30,0,15-16,0 * * * *", minute, vec![0, 15, 16, 30]),
            ("0 0 1 jan-mar *", month, vec![1, 2, 3]),
            ("0 0 1 dec *", month, vec![12]),
            ("0 0 1 1,feb *", month, vec![1, 2]),
            ("0 0 1 7 *", month, vec![7]),
            ("0 0 * * sun,sat", dow, vec![0, 6]),
            ("0 0 * * MON-FRI", dow, vec![1, 2, 3, 4, 5]),
            ("0 0 * * 1-5/2", dow, vec![1, 3, 5]),
            ("0 0 * * sun-7", dow, vec![0]),
            ("0 0 7 * *", dom, vec![7]),
            ("  0\t9  *  *  *  ", hour, vec![9]),
        ];
        for (expression, pick, expected) in cases {
            assert_eq!(field(expression, pick), expected, "{expression}");
        }
    }

    #[test]
    fn a_field_that_is_not_well_formed_is_not_a_cron() {
        for bad in [
            // Out of range, field by field.
            "60 * * * *",
            "0 24 * * *",
            "0 0 0 * *",
            "0 0 32 * *",
            "0 0 1 0 *",
            "0 0 1 13 *",
            "0 0 * * 8",
            "0-60 * * * *",
            // Empty pieces.
            "*/ * * * *",
            "/5 * * * *",
            "1,,2 * * * *",
            "1, * * * *",
            "-5 * * * *",
            "5- * * * *",
            // Too many dashes, bad steps, words that are not numbers.
            "1-2-3 * * * *",
            "*/x * * * *",
            "*/-1 * * * *",
            "1-x * * * *",
            "x-1 * * * *",
            "*-5 * * * *",
            "1.5 * * * *",
            // Names only mean something in their own field.
            "0 0 * mon *",
            "0 0 * * jan",
            "mon 0 * * *",
        ] {
            assert!(parse_cron(bad).is_none(), "{bad} parsed");
        }
    }

    #[derive(serde::Deserialize)]
    struct Parity {
        expression: String,
        valid: bool,
    }

    /// `src/lib/cron.test.ts` reads the same table. An expression the editor
    /// takes and the daemon refuses fires once, then falls back to 09:00 every
    /// day, so the two parsers answer every row alike.
    #[test]
    fn parse_cron_answers_the_table_the_editor_shares() {
        let cases: Vec<Parity> = serde_json::from_str(include_str!("../tests/fixtures/cron-parity.json"))
            .expect("parse fixture");
        assert!(cases.len() > 100, "the table went missing");
        for case in cases {
            assert_eq!(is_valid_cron(&case.expression), case.valid, "{:?}", case.expression);
        }
    }

    #[test]
    fn seconds_are_dropped_before_the_next_minute_is_counted() {
        let from = at(2026, 3, 10, 10, 0) + 30_000;
        assert_eq!(next("* * * * *", from), Some(at(2026, 3, 10, 10, 1)));
    }

    #[test]
    fn a_day_the_month_does_not_have_is_skipped_to_a_month_that_has_it() {
        assert_eq!(next("0 0 31 * *", at(2026, 4, 1, 0, 0)), Some(at(2026, 5, 31, 0, 0)));
    }

    #[test]
    fn a_weekday_cron_on_a_friday_evening_waits_for_monday() {
        // Fri Jan 30 2026, and the week turns over into February.
        assert_eq!(next("0 9 * * 1-5", at(2026, 1, 30, 18, 0)), Some(at(2026, 2, 2, 9, 0)));
    }

    /// Every instant in the coming year where the local offset moves: summer
    /// time starting and ending. None at all in a zone without it.
    fn clock_changes(from: i64) -> Vec<i64> {
        let offset = |ms: i64| local_tm(ms).tm_gmtoff;
        let hour = 3_600_000;
        let mut changes = Vec::new();
        let mut at = from;
        while at < from + 400 * 24 * hour {
            if offset(at) != offset(at + hour) {
                let mut minute = at;
                while offset(minute) == offset(at) {
                    minute += 60_000;
                }
                changes.push(minute);
            }
            at += hour;
        }
        changes
    }

    /// The hour a clock repeats when summer time ends is where a local-time
    /// round trip lands on the first of the two, an hour early. A next run
    /// from inside it must still be after the moment it was asked about, or the
    /// routine is past due the instant it is written and fires every tick
    /// until the hour is over.
    #[test]
    fn a_next_run_across_a_change_of_the_clock_is_still_in_the_future() {
        for change in clock_changes(at(2026, 1, 1, 0, 0)) {
            let mut from = change - 3 * 3_600_000;
            while from < change + 3 * 3_600_000 {
                for expression in ["* * * * *", "*/10 * * * *", "30 23 * * *", "0 0 * * *", "30 0 * * *"] {
                    // mktime settles a repeated hour towards the offset it last
                    // used, so ask once after a call from each side of the change.
                    for side in [change - 86_400_000, change + 86_400_000] {
                        floor_minute(side);
                        let answer = next(expression, from);
                        assert!(
                            answer.is_some_and(|at| at > from),
                            "{expression} from {from} answered {answer:?}"
                        );
                    }
                }
                from += 5 * 60_000;
            }
        }
    }
}
