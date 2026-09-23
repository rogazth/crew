use serde_json::Value;

use crate::cron::{is_valid_cron, next_cron, parse_cron};

const SCHEDULE_HELP: &str = "schedule is {\"kind\":\"interval\",\"minutes\":N}, {\"kind\":\"daily\",\"hour\":0-23,\"minute\":0-59,\"days\":[0-6]} (days empty = every day, 0 = Sunday) or {\"kind\":\"cron\",\"expression\":\"m h dom mon dow\"}";

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Schedule {
    Interval { minutes: u32 },
    Daily { hour: u32, minute: u32, days: Vec<u32> },
    Cron { expression: String },
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
        _ => Err(SCHEDULE_HELP.into()),
    }
}

pub fn parse_schedule(raw: &str) -> Option<Schedule> {
    validate_schedule(&serde_json::from_str(raw).ok()?).ok()
}

pub fn next_run(schedule: &Schedule, from_ms: i64) -> Option<i64> {
    match schedule {
        Schedule::Interval { minutes } => Some(from_ms + i64::from(*minutes) * 60_000),
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

    const MINUTES: &str = "minutes must be a whole number of at least 1.";
    const HOUR: &str = "hour must be 0-23.";
    const MINUTE: &str = "minute must be 0-59.";
    const DAYS: &str = "days must be a list of 0-6 (Sunday to Saturday).";
    const CRON: &str = "expression must be five cron fields: minute hour day-of-month month day-of-week";

    /// What an agent gets back is what it has to fix, so every refusal names
    /// the field, and all but cron's carry the whole shape to copy from.
    #[test]
    fn every_schedule_that_cannot_run_is_refused_with_what_to_fix() {
        let cases: Vec<(Value, &str)> = vec![
            (json!("daily"), SCHEDULE_HELP),
            (json!(null), SCHEDULE_HELP),
            (json!([{ "kind": "daily", "hour": 9 }]), SCHEDULE_HELP),
            (json!({}), SCHEDULE_HELP),
            (json!({ "kind": "once", "at": 0 }), SCHEDULE_HELP),
            (json!({ "kind": "weekly", "hour": 9 }), SCHEDULE_HELP),
            (json!({ "kind": 5 }), SCHEDULE_HELP),
            (json!({ "kind": "Daily", "hour": 9 }), SCHEDULE_HELP),
            (json!({ "kind": "interval" }), MINUTES),
            (json!({ "kind": "interval", "minutes": 0 }), MINUTES),
            (json!({ "kind": "interval", "minutes": -5 }), MINUTES),
            (json!({ "kind": "interval", "minutes": 1.5 }), MINUTES),
            (json!({ "kind": "interval", "minutes": "30" }), MINUTES),
            (json!({ "kind": "interval", "minutes": null }), MINUTES),
            (json!({ "kind": "interval", "minutes": 4_294_967_296_u64 }), MINUTES),
            (json!({ "kind": "daily" }), HOUR),
            (json!({ "kind": "daily", "hour": 24 }), HOUR),
            (json!({ "kind": "daily", "hour": -1 }), HOUR),
            (json!({ "kind": "daily", "hour": "9" }), HOUR),
            (json!({ "kind": "daily", "hour": 9.5 }), HOUR),
            (json!({ "kind": "daily", "hour": 9, "minute": 60 }), MINUTE),
            (json!({ "kind": "daily", "hour": 9, "minute": -1 }), MINUTE),
            (json!({ "kind": "daily", "hour": 9, "minute": "0" }), MINUTE),
            (json!({ "kind": "daily", "hour": 9, "minute": null }), MINUTE),
            (json!({ "kind": "daily", "hour": 9, "days": [7] }), DAYS),
            (json!({ "kind": "daily", "hour": 9, "days": [1, -1] }), DAYS),
            (json!({ "kind": "daily", "hour": 9, "days": ["mon"] }), DAYS),
            (json!({ "kind": "daily", "hour": 9, "days": [1.5] }), DAYS),
            (json!({ "kind": "daily", "hour": 9, "days": "1,2" }), DAYS),
            (json!({ "kind": "daily", "hour": 9, "days": 1 }), DAYS),
            (json!({ "kind": "daily", "hour": 9, "days": null }), DAYS),
            (json!({ "kind": "cron" }), CRON),
            (json!({ "kind": "cron", "expression": "" }), CRON),
            (json!({ "kind": "cron", "expression": "   " }), CRON),
            (json!({ "kind": "cron", "expression": 5 }), CRON),
            (json!({ "kind": "cron", "expression": "0 9 * *" }), CRON),
            (json!({ "kind": "cron", "expression": "61 9 * * *" }), CRON),
            (json!({ "kind": "cron", "expression": "every morning" }), CRON),
        ];
        for (input, starts) in cases {
            let error = validate_schedule(&input).expect_err(&input.to_string());
            assert!(error.starts_with(starts), "{input}: {error}");
            if starts != CRON && starts != SCHEDULE_HELP {
                assert!(error.ends_with(SCHEDULE_HELP), "{input}: {error}");
            }
        }
    }

    #[test]
    fn a_schedule_that_can_run_is_read_as_it_was_meant() {
        let cases: Vec<(Value, Schedule)> = vec![
            (json!({ "kind": "interval", "minutes": 1 }), Schedule::Interval { minutes: 1 }),
            (
                json!({ "kind": "interval", "minutes": 4_294_967_295_u64 }),
                Schedule::Interval { minutes: u32::MAX },
            ),
            (
                json!({ "kind": "daily", "hour": 0, "minute": 0, "days": [] }),
                Schedule::Daily { hour: 0, minute: 0, days: vec![] },
            ),
            (
                json!({ "kind": "daily", "hour": 23, "minute": 59, "days": [6, 0, 6] }),
                Schedule::Daily { hour: 23, minute: 59, days: vec![0, 6] },
            ),
            (
                json!({ "kind": "daily", "hour": 9, "extra": true }),
                Schedule::Daily { hour: 9, minute: 0, days: vec![] },
            ),
            (
                json!({ "kind": "cron", "expression": "  0 9 * * 1-5  " }),
                Schedule::Cron { expression: "0 9 * * 1-5".into() },
            ),
        ];
        for (input, expected) in cases {
            assert_eq!(validate_schedule(&input), Ok(expected), "{input}");
        }
    }

    /// The column holds this JSON and the screen parses it back, so it has to
    /// read the same on the way out as on the way in.
    #[test]
    fn every_kind_is_stored_as_json_that_reads_back_the_same() {
        let cases = [
            (Schedule::Interval { minutes: 45 }, json!({ "kind": "interval", "minutes": 45 })),
            (
                Schedule::Daily { hour: 7, minute: 5, days: vec![1, 3] },
                json!({ "kind": "daily", "hour": 7, "minute": 5, "days": [1, 3] }),
            ),
            (
                Schedule::Cron { expression: "0 9 * * mon-fri".into() },
                json!({ "kind": "cron", "expression": "0 9 * * mon-fri" }),
            ),
        ];
        for (schedule, stored) in cases {
            let json = schedule.to_json();
            assert_eq!(serde_json::from_str::<Value>(&json).expect("json"), stored);
            assert_eq!(parse_schedule(&json), Some(schedule));
        }
    }

    /// The text an agent and the routines screen read a schedule as.
    #[test]
    fn every_schedule_describes_itself_the_way_the_screen_does() {
        let daily = |hour, minute, days: &[u32]| Schedule::Daily { hour, minute, days: days.to_vec() };
        let cases = [
            (Schedule::Interval { minutes: 45 }, "Every 45 minutes"),
            (Schedule::Interval { minutes: 90 }, "Every 90 minutes"),
            (Schedule::Interval { minutes: 60 }, "Every hour"),
            (Schedule::Interval { minutes: 120 }, "Every 2 hours"),
            (Schedule::Interval { minutes: 1440 }, "Every 24 hours"),
            (daily(9, 0, &[]), "Every day at 09:00"),
            (daily(9, 5, &[0, 1, 2, 3, 4, 5, 6]), "Every day at 09:05"),
            (daily(8, 30, &[1, 2, 3, 4, 5]), "Weekdays at 08:30"),
            (daily(10, 0, &[0, 6]), "Weekends at 10:00"),
            (daily(0, 0, &[1]), "Mon at 00:00"),
            (daily(23, 59, &[0]), "Sun at 23:59"),
            (daily(7, 0, &[1, 3, 5]), "Mon, Wed, Fri at 07:00"),
            (daily(7, 0, &[2, 4, 6]), "Tue, Thu, Sat at 07:00"),
            (Schedule::Cron { expression: "0 9 * * 1-5".into() }, "Cron 0 9 * * 1-5"),
        ];
        for (schedule, expected) in cases {
            assert_eq!(describe_schedule(&schedule), expected, "{schedule:?}");
        }
    }

    #[test]
    fn next_run_carries_across_the_end_of_a_day_a_week_a_month_and_a_year() {
        let nine = |days: &[u32]| Schedule::Daily { hour: 9, minute: 0, days: days.to_vec() };
        let cases: Vec<(&str, Schedule, i64, i64)> = vec![
            (
                "an interval runs past midnight",
                Schedule::Interval { minutes: 30 },
                at(2026, 9, 17, 23, 50),
                at(2026, 9, 18, 0, 20),
            ),
            ("the last day of a month", nine(&[]), at(2026, 1, 31, 10, 0), at(2026, 2, 1, 9, 0)),
            ("the last day of a year", nine(&[]), at(2026, 12, 31, 10, 0), at(2027, 1, 1, 9, 0)),
            ("into a leap day", nine(&[]), at(2028, 2, 28, 10, 0), at(2028, 2, 29, 9, 0)),
            ("over a leap day", nine(&[]), at(2028, 2, 29, 10, 0), at(2028, 3, 1, 9, 0)),
            // Fri Jan 30 2026: the next Monday is in February.
            ("a Monday in the next month", nine(&[1]), at(2026, 1, 30, 10, 0), at(2026, 2, 2, 9, 0)),
            // Sat Sep 19 2026.
            ("Saturday to Sunday", nine(&[0, 6]), at(2026, 9, 19, 10, 0), at(2026, 9, 20, 9, 0)),
            ("Sunday to Saturday", nine(&[0, 6]), at(2026, 9, 20, 10, 0), at(2026, 9, 26, 9, 0)),
            ("the same weekday, a week out", nine(&[4]), at(2026, 9, 17, 9, 0), at(2026, 9, 24, 9, 0)),
            ("later the same day", nine(&[4]), at(2026, 9, 17, 8, 59), at(2026, 9, 17, 9, 0)),
            (
                "a cron across the year",
                Schedule::Cron { expression: "0 0 1 1 *".into() },
                at(2026, 12, 31, 23, 59),
                at(2027, 1, 1, 0, 0),
            ),
        ];
        for (what, schedule, from, expected) in cases {
            assert_eq!(next_run(&schedule, from), Some(expected), "{what}");
        }
    }

    /// Nine every morning is nine on the clock, on the day summer time starts
    /// or ends as on any other: a day there is 23 or 25 hours long, not 24.
    /// Walks a whole year, so a zone with summer time crosses both changes.
    #[test]
    fn a_daily_time_stays_on_the_local_clock_every_day_of_a_year() {
        let schedule = Schedule::Daily { hour: 9, minute: 0, days: vec![] };
        // mktime carries January 32nd into February, and so on through the year.
        for day in 1..=366 {
            assert_eq!(
                next_run(&schedule, at(2026, 1, day, 10, 0)),
                Some(at(2026, 1, day + 1, 9, 0)),
                "day {day} of the year"
            );
        }
    }

    /// Only a schedule built by hand can name no real weekday; the one the
    /// column holds went through `validate_schedule`. It still answers with a
    /// time rather than none, the same one the screen gives.
    #[test]
    fn a_day_set_with_no_real_weekday_still_answers_with_a_time() {
        let schedule = Schedule::Daily { hour: 9, minute: 0, days: vec![7] };
        assert_eq!(next_run(&schedule, at(2026, 9, 17, 10, 0)), Some(at(2026, 9, 26, 9, 0)));
    }
}
