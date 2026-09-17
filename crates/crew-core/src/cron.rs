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
                    return Some(set_clock(cursor, hour, minute));
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
}
