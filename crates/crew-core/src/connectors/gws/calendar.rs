//! Calendar's tools.

use serde_json::{json, Map, Value};

use super::{flag, need, number, object, params, strings, text, tool, Args, GwsError, Run, Tool};

/// A time in RFC 3339 (`2026-10-28T15:00:00-03:00`), or a date for an all-day event.
fn when() -> Value {
    json!({ "type": "string", "description": "RFC 3339 date-time, like 2026-10-28T15:00:00-03:00; a date (2026-10-28) for an all-day event." })
}

pub(super) const TOOLS: &[Tool] = &[
    tool(
        "list_events",
        "List events",
        "List a calendar's events in a range, soonest first; from now on when no range is given.",
        true,
        false,
        || {
            object(
                json!({
                    "calendar_id": { "type": "string", "default": "primary" },
                    "time_min": { "type": "string", "description": "RFC 3339; now by default." },
                    "time_max": { "type": "string", "description": "RFC 3339." },
                    "query": { "type": "string", "description": "Words to find in the events." },
                    "max_results": { "type": "integer", "minimum": 1, "maximum": 250, "default": 25 }
                }),
                &[],
            )
        },
    ),
    tool(
        "find_free_time",
        "Find free time",
        "Answer the busy blocks of one or more calendars in a range; the time between them is free.",
        true,
        false,
        || {
            object(
                json!({
                    "time_min": { "type": "string", "description": "RFC 3339." },
                    "time_max": { "type": "string", "description": "RFC 3339." },
                    "calendars": { "type": "array", "items": { "type": "string" }, "description": "Calendar ids or people's addresses; primary by default." },
                    "time_zone": { "type": "string", "description": "IANA zone for the answer, like America/Santiago." }
                }),
                &["time_min", "time_max"],
            )
        },
    ),
    tool("create_event", "Create event", "Add an event. Attendees are emailed only when notify is on.", false, false, || {
        object(
            json!({
                "summary": { "type": "string" },
                "start": when(),
                "end": when(),
                "time_zone": { "type": "string", "description": "IANA zone, like America/Santiago." },
                "description": { "type": "string" },
                "location": { "type": "string" },
                "attendees": { "type": "array", "items": { "type": "string" } },
                "calendar_id": { "type": "string", "default": "primary" },
                "notify": { "type": "boolean", "default": false }
            }),
            &["summary", "start", "end"],
        )
    }),
    tool("update_event", "Update event", "Change an event: only the fields given change.", false, false, || {
        object(
            json!({
                "event_id": { "type": "string" },
                "calendar_id": { "type": "string", "default": "primary" },
                "summary": { "type": "string" },
                "start": when(),
                "end": when(),
                "time_zone": { "type": "string" },
                "description": { "type": "string" },
                "location": { "type": "string" },
                "attendees": { "type": "array", "items": { "type": "string" }, "description": "The whole new list." },
                "notify": { "type": "boolean", "default": false }
            }),
            &["event_id"],
        )
    }),
    tool("delete_event", "Delete event", "Delete an event.", false, true, || {
        object(
            json!({
                "event_id": { "type": "string" },
                "calendar_id": { "type": "string", "default": "primary" },
                "notify": { "type": "boolean", "default": false }
            }),
            &["event_id"],
        )
    }),
];

/// An event's start or end: a date for an all-day one.
fn time_of(at: &str, zone: Option<&str>) -> Value {
    if at.len() == 10 && !at.contains('T') {
        json!({ "date": at })
    } else {
        let mut v = json!({ "dateTime": at });
        if let Some(zone) = zone {
            v["timeZone"] = json!(zone);
        }
        v
    }
}

fn updates(args: &Args) -> &'static str {
    if flag(args, "notify", false) {
        "all"
    } else {
        "none"
    }
}

pub(super) async fn run(run: &Run<'_>, name: &str, args: &Args) -> Result<Value, GwsError> {
    match name {
        "list_events" => {
            let now = crate::store::now_millis();
            let p = params(json!({
                "calendarId": text(args, "calendar_id").unwrap_or("primary"),
                "timeMin": text(args, "time_min").map(str::to_string).unwrap_or_else(|| rfc3339(now)),
                "timeMax": text(args, "time_max"),
                "q": text(args, "query"),
                "maxResults": number(args, "max_results", 25, 250),
                "singleEvents": true,
                "orderBy": "startTime",
            }));
            let events = run.json(&["calendar", "events", "list", "--params", &p]).await?;
            Ok(json!({
                "timeZone": events["timeZone"],
                "events": events["items"].as_array().into_iter().flatten().map(|e| json!({
                    "id": e["id"], "summary": e["summary"], "start": e["start"], "end": e["end"], "location": e["location"],
                    "attendees": e["attendees"].as_array().map(|a| a.iter().map(|p| p["email"].clone()).collect::<Vec<_>>()),
                    "link": e["htmlLink"], "status": e["status"],
                })).collect::<Vec<_>>(),
                "nextPageToken": events["nextPageToken"],
            }))
        }
        "find_free_time" => {
            let mut calendars = strings(args, "calendars");
            if calendars.is_empty() {
                calendars.push("primary".into());
            }
            let mut body = json!({
                "timeMin": need(args, "time_min")?, "timeMax": need(args, "time_max")?,
                "items": calendars.iter().map(|id| json!({ "id": id })).collect::<Vec<_>>(),
            });
            if let Some(zone) = text(args, "time_zone") {
                body["timeZone"] = json!(zone);
            }
            let busy = run.json(&["calendar", "freebusy", "query", "--json", &body.to_string()]).await?;
            Ok(busy["calendars"].clone())
        }
        "create_event" | "update_event" => {
            let zone = text(args, "time_zone");
            let mut event = Map::new();
            for (key, field) in [("summary", "summary"), ("description", "description"), ("location", "location")] {
                if let Some(v) = text(args, key) {
                    event.insert(field.into(), json!(v));
                }
            }
            for key in ["start", "end"] {
                if let Some(at) = text(args, key) {
                    event.insert(key.into(), time_of(at, zone));
                }
            }
            if args.contains_key("attendees") {
                event.insert(
                    "attendees".into(),
                    json!(strings(args, "attendees").iter().map(|e| json!({ "email": e })).collect::<Vec<_>>()),
                );
            }
            let calendar = text(args, "calendar_id").unwrap_or("primary");
            let body = Value::Object(event).to_string();
            let made = if name == "create_event" {
                need(args, "summary")?;
                need(args, "start")?;
                need(args, "end")?;
                let p = params(json!({ "calendarId": calendar, "sendUpdates": updates(args) }));
                run.json(&["calendar", "events", "insert", "--params", &p, "--json", &body]).await?
            } else {
                let p =
                    params(json!({ "calendarId": calendar, "eventId": need(args, "event_id")?, "sendUpdates": updates(args) }));
                run.json(&["calendar", "events", "patch", "--params", &p, "--json", &body]).await?
            };
            Ok(
                json!({ "id": made["id"], "summary": made["summary"], "start": made["start"], "end": made["end"], "link": made["htmlLink"] }),
            )
        }
        "delete_event" => {
            let p = params(json!({
                "calendarId": text(args, "calendar_id").unwrap_or("primary"), "eventId": need(args, "event_id")?, "sendUpdates": updates(args),
            }));
            run.json(&["calendar", "events", "delete", "--params", &p]).await?;
            Ok(json!({ "deleted": true }))
        }
        other => Err(GwsError::Call(format!("{other} is not a tool"))),
    }
}

/// Unix milliseconds as RFC 3339 in UTC.
fn rfc3339(ms: i64) -> String {
    let secs = ms.div_euclid(1000);
    let (days, rem) = (secs.div_euclid(86_400), secs.rem_euclid(86_400));
    // Days to a civil date (Howard Hinnant's algorithm).
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    format!("{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}Z", rem / 3600, rem % 3600 / 60, rem % 60)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn utc_times_read_plainly() {
        assert_eq!(rfc3339(0), "1970-01-01T00:00:00Z");
        assert_eq!(rfc3339(1_792_457_829_939), "2026-10-20T00:57:09Z");
    }
}
