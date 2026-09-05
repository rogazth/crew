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
