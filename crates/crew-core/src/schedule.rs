use serde_json::Value;

use crate::cron::{is_valid_cron, next_cron, parse_cron};

const SCHEDULE_HELP: &str = "schedule is {\"kind\":\"interval\",\"minutes\":N}, {\"kind\":\"daily\",\"hour\":0-23,\"minute\":0-59,\"days\":[0-6]} (days empty = every day, 0 = Sunday), {\"kind\":\"cron\",\"expression\":\"m h dom mon dow\"} or {\"kind\":\"once\",\"at\":\"2026-10-05T15:30\"} (ISO-8601, local unless it has Z or an offset, or epoch milliseconds)";

const AT_HELP: &str = "at must be an ISO-8601 time like \"2026-10-05T15:30\" (local time unless it ends in Z or an offset like +02:00) or epoch milliseconds";

/// Epoch milliseconds before this are taken for a mistake (seconds, most likely).
const AT_FLOOR_MS: i64 = 1_000_000_000_000;

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Schedule {
    Interval { minutes: u32 },
    Daily { hour: u32, minute: u32, days: Vec<u32> },
    Cron { expression: String },
    /// One time, in epoch milliseconds. It fires once and is then switched off.
    Once { at: i64 },
}

impl Schedule {
    pub fn to_json(&self) -> String {
        match self {
            Schedule::Interval { minutes } => format!(r#"{{"kind":"interval","minutes":{minutes}}}"#),
            Schedule::Daily { hour, minute, days } => {
                format!(
                    r#"{{"kind":"daily","hour":{hour},"minute":{minute},"days":{}}}"#,
                    serde_json::to_string(days).unwrap_or_else(|_| "[]".into())
                )
            }
            Schedule::Cron { expression } => {
                serde_json::json!({ "kind": "cron", "expression": expression }).to_string()
            }
            Schedule::Once { at } => format!(r#"{{"kind":"once","at":{at}}}"#),
        }
    }
}

pub fn validate_schedule(input: &Value) -> Result<Schedule, String> {
    let Some(obj) = input.as_object() else {
        return Err(SCHEDULE_HELP.into());
    };
    match obj.get("kind").and_then(Value::as_str) {
        Some("interval") => {
            let minutes = integer(obj.get("minutes")).ok_or_else(|| {
                format!("minutes must be a whole number of at least 1. {SCHEDULE_HELP}")
            })?;
            if minutes < 1 {
                return Err(format!("minutes must be a whole number of at least 1. {SCHEDULE_HELP}"));
            }
            Ok(Schedule::Interval { minutes })
        }
        Some("daily") => {
            let hour = integer(obj.get("hour"))
                .ok_or_else(|| format!("hour must be 0-23. {SCHEDULE_HELP}"))?;
            if hour > 23 {
                return Err(format!("hour must be 0-23. {SCHEDULE_HELP}"));
            }
            let minute = match obj.get("minute") {
                None => 0,
                Some(value) => integer(Some(value))
                    .ok_or_else(|| format!("minute must be 0-59. {SCHEDULE_HELP}"))?,
            };
            if minute > 59 {
                return Err(format!("minute must be 0-59. {SCHEDULE_HELP}"));
            }
            let days = match obj.get("days") {
                None => Vec::new(),
                Some(Value::Array(items)) => {
                    let mut days = Vec::new();
                    for item in items {
                        let day = integer(Some(item)).ok_or_else(|| {
                            format!("days must be a list of 0-6 (Sunday to Saturday). {SCHEDULE_HELP}")
                        })?;
                        if day > 6 {
                            return Err(format!(
                                "days must be a list of 0-6 (Sunday to Saturday). {SCHEDULE_HELP}"
                            ));
                        }
                        days.push(day);
                    }
                    days.sort_unstable();
                    days.dedup();
                    days
                }
                Some(_) => {
                    return Err(format!(
                        "days must be a list of 0-6 (Sunday to Saturday). {SCHEDULE_HELP}"
                    ));
                }
            };
            Ok(Schedule::Daily { hour, minute, days })
        }
        Some("cron") => {
            let expression = obj
                .get("expression")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .ok_or_else(|| {
                    "expression must be five cron fields: minute hour day-of-month month day-of-week"
                        .to_string()
                })?;
            if !is_valid_cron(expression) {
                return Err(
                    "expression must be five cron fields: minute hour day-of-month month day-of-week"
                        .into(),
                );
            }
            Ok(Schedule::Cron {
                expression: expression.to_string(),
            })
        }
        Some("once") => {
            let at = match obj.get("at") {
                Some(Value::String(text)) => parse_time(text.trim()),
                Some(Value::Number(n)) => n.as_i64().or_else(|| n.as_f64().map(|f| f as i64)),
                _ => None,
            }
            .filter(|at| *at >= AT_FLOOR_MS)
            .ok_or_else(|| format!("{AT_HELP}. {SCHEDULE_HELP}"))?;
            Ok(Schedule::Once { at })
        }
        _ => Err(SCHEDULE_HELP.into()),
    }
}

/// An ISO-8601 date and time, `YYYY-MM-DDTHH:MM[:SS[.fff]]` with a `T` or a
/// space, then `Z`, `±HH:MM`, `±HHMM` or nothing. Nothing is the user's local
/// time, like every other time a routine is given in.
pub fn parse_time(text: &str) -> Option<i64> {
    let (date, time) = text.split_once(['T', 't', ' '])?;
    let mut ymd = date.splitn(3, '-');
    let year: i32 = ymd.next()?.parse().ok()?;
    let month: i32 = ymd.next()?.parse().ok()?;
    let day: i32 = ymd.next()?.parse().ok()?;
    // The zone, if any, is whatever follows the clock.
    let zone_at = time.find(['Z', 'z', '+', '-']).unwrap_or(time.len());
    let (clock, zone) = time.split_at(zone_at);
    let mut hms = clock.splitn(3, ':');
    let hour: i32 = hms.next()?.parse().ok()?;
    let minute: i32 = hms.next()?.parse().ok()?;
    let (second, millis) = match hms.next() {
        None => (0, 0),
        Some(sec) => {
            let (whole, frac) = sec.split_once('.').unwrap_or((sec, ""));
            let frac: String = frac.chars().chain("000".chars()).take(3).collect();
            (whole.parse::<i32>().ok()?, frac.parse::<i64>().ok()?)
        }
    };
    if !(1..=12).contains(&month) || !(1..=31).contains(&day) || !(0..=23).contains(&hour) || !(0..=59).contains(&minute) || !(0..=60).contains(&second) {
        return None;
    }
    let mut tm: libc::tm = unsafe { std::mem::zeroed() };
    tm.tm_year = year - 1900;
    tm.tm_mon = month - 1;
    tm.tm_mday = day;
    tm.tm_hour = hour;
    tm.tm_min = minute;
    tm.tm_sec = second;
    let secs = if zone.is_empty() {
        tm.tm_isdst = -1;
        unsafe { libc::mktime(&mut tm) as i64 }
    } else {
        let offset = if zone.eq_ignore_ascii_case("z") {
            0
        } else {
            let sign = if zone.starts_with('-') { -1 } else { 1 };
            let digits: String = zone[1..].chars().filter(|c| *c != ':').collect();
            if digits.len() != 4 && digits.len() != 2 {
                return None;
            }
            let hours: i64 = digits[..2].parse().ok()?;
            let minutes: i64 = if digits.len() == 4 { digits[2..].parse().ok()? } else { 0 };
            sign * (hours * 3600 + minutes * 60)
        };
        (unsafe { libc::timegm(&mut tm) as i64 }) - offset
    };
    Some(secs * 1000 + millis)
}

/// A time as the user reads it: `Oct 5, 2026, 3:30 PM`, local.
pub fn local_time(ms: i64) -> String {
    let tm = local_tm(ms);
    let months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    let month = months.get(tm.tm_mon as usize).copied().unwrap_or("");
    let mut hour = tm.tm_hour;
    let suffix = if hour >= 12 { "PM" } else { "AM" };
    hour %= 12;
    if hour == 0 {
        hour = 12;
    }
    format!("{month} {}, {}, {hour}:{:02} {suffix}", tm.tm_mday, tm.tm_year + 1900, tm.tm_min)
}

pub fn parse_schedule(raw: &str) -> Option<Schedule> {
    validate_schedule(&serde_json::from_str(raw).ok()?).ok()
}

pub fn next_run(schedule: &Schedule, from_ms: i64) -> Option<i64> {
    match schedule {
        Schedule::Interval { minutes } => Some(from_ms + i64::from(*minutes) * 60_000),
        // Once is once: a time already gone has no next run.
        Schedule::Once { at } => (*at > from_ms).then_some(*at),
        Schedule::Cron { expression } => next_cron(&parse_cron(expression)?, from_ms),
        Schedule::Daily { hour, minute, days } => {
            let mut at = set_clock(from_ms, *hour, *minute);
            if at <= from_ms {
                at = add_days(at, 1);
            }
            for _ in 0..8 {
                if days.is_empty() || days.contains(&weekday(at)) {
                    return Some(at);
                }
                at = add_days(at, 1);
            }
            Some(at)
        }
    }
}

pub fn describe_schedule(schedule: &Schedule) -> String {
    match schedule {
        Schedule::Cron { expression } => format!("Cron {expression}"),
        Schedule::Once { at } => format!("Once · {}", local_time(*at)),
        Schedule::Interval { minutes } if minutes % 60 == 0 => {
            let hours = minutes / 60;
            if hours == 1 {
                "Every hour".into()
            } else {
                format!("Every {hours} hours")
            }
        }
        Schedule::Interval { minutes } => format!("Every {minutes} minutes"),
        Schedule::Daily { hour, minute, days } => {
            format!("{} at {:02}:{:02}", describe_days(days), hour, minute)
        }
    }
}

pub fn schedule_help() -> &'static str {
    SCHEDULE_HELP
}

fn describe_days(days: &[u32]) -> String {
    if days.is_empty() || days.len() == 7 {
        return "Every day".into();
    }
    let joined = days
        .iter()
        .map(|d| d.to_string())
        .collect::<Vec<_>>()
        .join(",");
    match joined.as_str() {
        "1,2,3,4,5" => "Weekdays".into(),
        "0,6" => "Weekends".into(),
        _ => {
            const WEEKDAYS: [&str; 7] = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
            days.iter()
                .map(|day| WEEKDAYS.get(*day as usize).copied().unwrap_or(""))
                .collect::<Vec<_>>()
                .join(", ")
        }
    }
}

fn integer(value: Option<&Value>) -> Option<u32> {
    let value = value?;
    if let Some(n) = value.as_u64() {
        return u32::try_from(n).ok();
    }
    if let Some(n) = value.as_i64() {
        return u32::try_from(n).ok();
    }
    None
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

fn set_clock(ms: i64, hour: u32, minute: u32) -> i64 {
    let mut tm = local_tm(ms);
    tm.tm_hour = hour as i32;
    tm.tm_min = minute as i32;
    tm.tm_sec = 0;
    from_tm(tm)
}

fn add_days(ms: i64, days: i32) -> i64 {
    let mut tm = local_tm(ms);
    tm.tm_mday += days;
    from_tm(tm)
}

fn weekday(ms: i64) -> u32 {
    local_tm(ms).tm_wday as u32
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// Local wall clock, because a routine is set in the user's own day.
    fn at(year: i32, month: i32, day: i32, hour: i32, minute: i32) -> i64 {
        let mut tm: libc::tm = unsafe { std::mem::zeroed() };
        tm.tm_year = year - 1900;
        tm.tm_mon = month - 1;
        tm.tm_mday = day;
        tm.tm_hour = hour;
        tm.tm_min = minute;
        from_tm(tm)
    }

    /// The same table `src/lib/routines.test.ts` holds. The schedule math lives
    /// in both languages — the screen computes the next run when it saves and
    /// the daemon computes it when it fires — so these are the rows that make
    /// the duplication safe. They move together or not at all.
    #[test]
    fn next_run_answers_what_the_screen_answers() {
        let cases: Vec<(&str, Schedule, i64, Option<i64>)> = vec![
            (
                "an interval counts from now, not from the hour",
                Schedule::Interval { minutes: 30 },
                at(2026, 9, 17, 8, 13),
                Some(at(2026, 9, 17, 8, 43)),
            ),
            (
                "a daily time later today is today",
                Schedule::Daily { hour: 9, minute: 0, days: vec![] },
                at(2026, 9, 17, 8, 0),
                Some(at(2026, 9, 17, 9, 0)),
            ),
            (
                "a daily time already past is tomorrow",
                Schedule::Daily { hour: 9, minute: 0, days: vec![] },
                at(2026, 9, 17, 10, 0),
                Some(at(2026, 9, 18, 9, 0)),
            ),
            (
                "exactly on the hour is the next one, never this one",
                Schedule::Daily { hour: 9, minute: 0, days: vec![] },
                at(2026, 9, 17, 9, 0),
                Some(at(2026, 9, 18, 9, 0)),
            ),
            (
                "weekdays from a Friday afternoon is Monday",
                Schedule::Daily { hour: 9, minute: 0, days: vec![1, 2, 3, 4, 5] },
                at(2026, 9, 18, 15, 0),
                Some(at(2026, 9, 21, 9, 0)),
            ),
            (
                "a single weekday from the day after it is a week out",
                Schedule::Daily { hour: 9, minute: 0, days: vec![1] },
                at(2026, 9, 22, 12, 0),
                Some(at(2026, 9, 28, 9, 0)),
            ),
            (
                "a cron expression lands on its next minute",
                Schedule::Cron { expression: "30 6 * * *".into() },
                at(2026, 9, 17, 8, 0),
                Some(at(2026, 9, 18, 6, 30)),
            ),
        ];
        for (what, schedule, from, expected) in cases {
            assert_eq!(next_run(&schedule, from), expected, "{what}");
        }
    }

    #[test]
    fn a_cron_nothing_can_match_has_no_next_run() {
        assert_eq!(next_run(&Schedule::Cron { expression: "not a cron".into() }, 0), None);
    }

    /// Whatever the schedule, the answer is in the future. A time in the past
    /// is a routine that fires again the instant it lands.
    #[test]
    fn a_next_run_is_always_after_the_time_it_was_asked_about() {
        let from = at(2026, 9, 17, 23, 59);
        for schedule in [
            Schedule::Interval { minutes: 30 },
            Schedule::Daily { hour: 9, minute: 0, days: vec![] },
            Schedule::Daily { hour: 9, minute: 0, days: vec![1, 2, 3, 4, 5] },
            Schedule::Cron { expression: "30 6 * * *".into() },
        ] {
            assert!(next_run(&schedule, from).is_some_and(|at| at > from), "{schedule:?}");
        }
    }

    #[test]
    fn a_schedule_the_column_cannot_hold_reads_as_the_default() {
        let default = Schedule::Daily { hour: 9, minute: 0, days: vec![] };
        assert_eq!(parse_schedule("{oh no"), None);
        assert_eq!(parse_schedule(&default.to_json()), Some(default));
    }

    /// `at` comes as ISO-8601, local unless zoned, or as epoch milliseconds,
    /// and is stored as milliseconds either way.
    #[test]
    fn a_once_schedule_takes_a_time_however_it_is_written() {
        let local = at(2026, 10, 5, 15, 30);
        let once = |at: Value| validate_schedule(&json!({ "kind": "once", "at": at }));
        assert_eq!(once(json!("2026-10-05T15:30")), Ok(Schedule::Once { at: local }));
        assert_eq!(once(json!("2026-10-05 15:30:00")), Ok(Schedule::Once { at: local }));
        assert_eq!(once(json!(local)), Ok(Schedule::Once { at: local }));
        assert_eq!(once(json!("2026-10-05T13:30:00Z")), Ok(Schedule::Once { at: 1_791_207_000_000 }));
        assert_eq!(once(json!("2026-10-05T15:30:00.250+02:00")), Ok(Schedule::Once { at: 1_791_207_000_250 }));
        assert_eq!(once(json!("2026-10-05T10:00-0330")), Ok(Schedule::Once { at: 1_791_207_000_000 }));
        for bad in [json!("tomorrow"), json!("2026-10-05"), json!("2026-13-05T10:00"), json!(1_791_207_000), json!(null)] {
            assert!(once(bad.clone()).unwrap_err().contains("at must be"), "{bad}");
        }
        let stored = Schedule::Once { at: local };
        assert_eq!(parse_schedule(&stored.to_json()), Some(stored.clone()));
        assert_eq!(next_run(&stored, local - 1), Some(local));
        assert_eq!(next_run(&stored, local), None, "once is once");
        assert!(describe_schedule(&stored).starts_with("Once · Oct 5, 2026, 3:30 PM"), "{}", describe_schedule(&stored));
    }

    #[test]
    fn validate_schedule_matches_typescript() {
        assert_eq!(
            validate_schedule(&json!({ "kind": "interval", "minutes": 30 })).unwrap(),
            Schedule::Interval { minutes: 30 }
        );
        assert_eq!(
            validate_schedule(&json!({ "kind": "daily", "hour": 9, "days": [5, 1, 1] })).unwrap(),
            Schedule::Daily {
                hour: 9,
                minute: 0,
                days: vec![1, 5],
            }
        );
        assert!(validate_schedule(&json!({ "kind": "daily", "hour": 24 })).is_err());
        assert!(validate_schedule(&json!({ "kind": "interval", "minutes": 0 })).is_err());
        assert!(validate_schedule(&json!({ "kind": "weekly" })).is_err());
        assert!(validate_schedule(&json!("daily")).is_err());
    }
}
