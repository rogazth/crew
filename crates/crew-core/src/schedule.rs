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
