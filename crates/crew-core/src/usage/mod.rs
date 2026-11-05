//! What each provider account has spent: the latest reading of its plan per
//! provider and account, and the tokens of the last days, kept in the store.
//! Claude reports its windows with a turn, Codex can be asked at any time,
//! Cursor, Grok and opencode are read from their CLIs; each adapter lives in a
//! module of its own and hands `record` a [`PlanUsage`], and its tokens to
//! `refresh_tokens` as a [`Tally`].

mod claude;
pub(crate) mod codex;
mod cursor;
pub(crate) mod grok;
mod opencode;
mod tokens;

use std::io::Read;
use std::os::unix::process::CommandExt;
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use crew_protocol::{PlanUsage, UsageSnapshot, UsageTokens};
use rusqlite::{params, OptionalExtension};

use crate::agent::AgentHost;
use crate::store::{now_millis, Store};
use tokens::{Since, Spent, Tally};

pub const MIGRATION_V39: &str = "CREATE TABLE IF NOT EXISTS usage_readings (
   provider   TEXT NOT NULL,
   account    TEXT NOT NULL DEFAULT '',
   reading    TEXT NOT NULL,
   updated_at INTEGER NOT NULL,
   PRIMARY KEY (provider, account)
 );
 CREATE TABLE IF NOT EXISTS usage_history (
   provider TEXT NOT NULL,
   account  TEXT NOT NULL DEFAULT '',
   day      TEXT NOT NULL,
   percent  REAL NOT NULL,
   PRIMARY KEY (provider, account, day)
 );";

/// `next_day` is the first day still worth reading again: anything before it is
/// final, and is kept here after its logs are gone.
pub const MIGRATION_V49: &str = "CREATE TABLE IF NOT EXISTS usage_tokens (
   provider    TEXT NOT NULL,
   day         TEXT NOT NULL,
   model       TEXT NOT NULL,
   input       INTEGER NOT NULL,
   output      INTEGER NOT NULL,
   cache_write INTEGER NOT NULL,
   cache_read  INTEGER NOT NULL,
   PRIMARY KEY (provider, day, model)
 );
 CREATE TABLE IF NOT EXISTS usage_tokens_read (
   provider TEXT PRIMARY KEY,
   next_day TEXT NOT NULL
 );";

/// Days of history kept, today included.
const HISTORY_DAYS: i64 = 30;
/// How long `claude auth status` is trusted before it is asked again.
const AUTH_TTL: Duration = Duration::from_secs(10 * 60);

type Listener = Arc<dyn Fn(&UsageSnapshot) + Send + Sync>;

/// Who is signed in to Claude, as `claude auth status` said and when.
type Signed = Option<(Instant, Option<(String, Option<String>)>)>;

#[derive(Clone)]
pub struct UsageHost {
    store: Store,
    listener: Arc<Mutex<Option<Listener>>>,
    claude_account: Arc<Mutex<Signed>>,
}

impl UsageHost {
    pub fn new(store: Store) -> Self {
        Self { store, listener: Arc::new(Mutex::new(None)), claude_account: Arc::new(Mutex::new(None)) }
    }

    /// Told the machine's whole snapshot each time a reading changes.
    pub fn set_listener(&self, listener: Listener) {
        *self.listener.lock().unwrap_or_else(|e| e.into_inner()) = Some(listener);
    }

    /// Every reading held and the tokens of the days kept.
    pub fn snapshot(&self) -> Result<UsageSnapshot, String> {
        let oldest = local_day_of(now_millis() - (HISTORY_DAYS - 1) * DAY_MS);
        self.store.with(|conn| {
            let mut readings: Vec<PlanUsage> = conn
                .prepare_cached("SELECT reading FROM usage_readings")?
                .query_map([], |row| row.get::<_, String>(0))?
                .filter_map(|text| serde_json::from_str(&text.ok()?).ok())
                .collect();
            readings
                .sort_by(|a, b| (a.provider.as_str(), a.account.as_deref()).cmp(&(b.provider.as_str(), b.account.as_deref())));
            let tokens = conn
                .prepare_cached(
                    "SELECT provider, day, model, input, output, cache_write, cache_read FROM usage_tokens
                     WHERE day >= ?1 ORDER BY provider, day, model",
                )?
                .query_map(params![oldest], |row| {
                    Ok(UsageTokens {
                        provider: row.get(0)?,
                        day: row.get(1)?,
                        model: row.get(2)?,
                        input: row.get::<_, i64>(3)? as u64,
                        output: row.get::<_, i64>(4)? as u64,
                        cache_write: row.get::<_, i64>(5)? as u64,
                        cache_read: row.get::<_, i64>(6)? as u64,
                    })
                })?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            Ok(UsageSnapshot { readings, tokens })
        })
    }

    /// Keeps a reading and tells the listener when it differs from what was held. With `merge`, windows the reading does
    /// not name stay as they were (Claude reports one window at a time).
    pub fn record(&self, mut reading: PlanUsage, merge: bool) {
        match self.write(&mut reading, merge) {
            Ok(true) => self.tell(),
            Ok(false) => {}
            Err(error) => {
                tracing::warn!(provider = %reading.provider, error = %crate::trace::error_text(&error.to_string()), "usage.reading_unkept")
            }
        }
    }

    fn tell(&self) {
        let listener = self.listener.lock().unwrap_or_else(|e| e.into_inner()).clone();
        if let (Some(listener), Ok(snapshot)) = (listener, self.snapshot()) {
            listener(&snapshot);
        }
    }

    /// Reads a provider's tokens from the first day not yet final and keeps
    /// them. One that cannot be read leaves what is held as it was.
    pub(crate) fn refresh_tokens(&self, provider: &str, read: impl FnOnce(&Since) -> Option<Tally>) {
        let now = now_millis();
        let next = self.store.with(|conn| {
            conn.prepare_cached("SELECT next_day FROM usage_tokens_read WHERE provider = ?1")?
                .query_row(params![provider], |row| row.get::<_, String>(0))
                .optional()
        });
        let since = since_day(next.ok().flatten(), now);
        let Some(tally) = read(&since) else {
            return;
        };
        match self.write_tokens(provider, &since, &tally, now) {
            Ok(true) => self.tell(),
            Ok(false) => {}
            Err(error) => {
                tracing::warn!(provider, error = %crate::trace::error_text(&error.to_string()), "usage.tokens_unkept")
            }
        }
    }

    /// Replaces the days read, drops those past what is kept, and says whether
    /// anything changed. Yesterday stays open: a turn can run past midnight.
    fn write_tokens(&self, provider: &str, since: &Since, tally: &Tally, now: i64) -> Result<bool, String> {
        self.store.with(|conn| {
            let held = Tally(
                conn.prepare_cached(
                    "SELECT day, model, input, output, cache_write, cache_read FROM usage_tokens WHERE provider = ?1 AND day >= ?2",
                )?
                .query_map(params![provider, since.day], |row| {
                    Ok((
                        (row.get(0)?, row.get(1)?),
                        Spent {
                            input: row.get::<_, i64>(2)? as u64,
                            output: row.get::<_, i64>(3)? as u64,
                            cache_write: row.get::<_, i64>(4)? as u64,
                            cache_read: row.get::<_, i64>(5)? as u64,
                        },
                    ))
                })?
                .collect::<rusqlite::Result<_>>()?,
            );
            let tx = conn.unchecked_transaction()?;
            tx.execute("DELETE FROM usage_tokens WHERE provider = ?1 AND day >= ?2", params![provider, since.day])?;
            for ((day, model), spent) in &tally.0 {
                tx.execute(
                    "INSERT INTO usage_tokens (provider, day, model, input, output, cache_write, cache_read)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                    params![
                        provider,
                        day,
                        model,
                        spent.input as i64,
                        spent.output as i64,
                        spent.cache_write as i64,
                        spent.cache_read as i64
                    ],
                )?;
            }
            tx.execute("DELETE FROM usage_tokens WHERE day < ?1", params![local_day_of(now - (HISTORY_DAYS - 1) * DAY_MS)])?;
            tx.execute(
                "INSERT INTO usage_tokens_read (provider, next_day) VALUES (?1, ?2)
                 ON CONFLICT (provider) DO UPDATE SET next_day = ?2",
                params![provider, local_day_of(now - DAY_MS)],
            )?;
            tx.commit()?;
            Ok(held != *tally)
        })
    }

    fn write(&self, reading: &mut PlanUsage, merge: bool) -> Result<bool, String> {
        let provider = reading.provider.clone();
        self.store.with(|conn| {
            // A reading with no account (a notification that arrived before
            // anyone asked who is signed in) belongs to the account last seen.
            let known: Option<(String, String)> = conn
                .prepare_cached(
                    "SELECT account, reading FROM usage_readings WHERE provider = ?1 AND account <> ''
                     ORDER BY updated_at DESC LIMIT 1",
                )?
                .query_row(params![provider], |row| Ok((row.get(0)?, row.get(1)?)))
                .optional()?;
            if reading.account.is_none() {
                if let Some((account, held)) = &known {
                    reading.account = Some(account.clone());
                    if reading.plan.is_none() {
                        reading.plan = serde_json::from_str::<PlanUsage>(held).ok().and_then(|held| held.plan);
                    }
                }
            }
            let account = reading.account.clone().unwrap_or_default();
            let held: Option<PlanUsage> = conn
                .prepare_cached("SELECT reading FROM usage_readings WHERE provider = ?1 AND account = ?2")?
                .query_row(params![provider, account], |row| row.get::<_, String>(0))
                .optional()?
                .and_then(|text| serde_json::from_str(&text).ok());
            if let Some(held) = &held {
                if reading.plan.is_none() {
                    reading.plan = held.plan.clone();
                }
                if merge {
                    if reading.status.is_none() {
                        reading.status = held.status.clone();
                    }
                    if reading.overage_status.is_none() {
                        reading.overage_status = held.overage_status.clone();
                    }
                    if reading.windows.is_empty() {
                        // Nothing new was heard: the held windows are no fresher than they were.
                        reading.updated_at = held.updated_at;
                        reading.source = held.source.clone();
                    }
                    for window in &held.windows {
                        if !reading.windows.iter().any(|new| new.id == window.id) {
                            reading.windows.push(window.clone());
                        }
                    }
                    reading.windows.sort_by_key(|w| (w.window_minutes.unwrap_or(i64::MAX), w.id.clone()));
                }
            }
            let changed = held.as_ref().is_none_or(|held| !same_reading(held, reading));
            let text = serde_json::to_string(&reading).map_err(|e| rusqlite::Error::ToSqlConversionFailure(Box::new(e)))?;
            conn.execute(
                "INSERT INTO usage_readings (provider, account, reading, updated_at) VALUES (?1, ?2, ?3, ?4)
                 ON CONFLICT (provider, account) DO UPDATE SET reading = ?3, updated_at = ?4",
                params![provider, account, text, reading.updated_at],
            )?;
            if !account.is_empty() {
                conn.execute("DELETE FROM usage_readings WHERE provider = ?1 AND account = ''", params![provider])?;
            }
            Ok(changed)
        })
    }

    /// A `rate_limit_event` from Claude's stream-json. The windows are read at
    /// once; who is signed in is asked on a thread of its own, once in a while.
    pub fn claude_event(&self, rec: &serde_json::Map<String, serde_json::Value>) {
        let now = now_millis();
        let windows = claude::parse_rate_limit(rec, now);
        if windows.is_empty() {
            return;
        }
        let (status, overage_status) = claude::parse_status(rec);
        let host = self.clone();
        std::thread::spawn(move || {
            let (account, plan) = host.claude_signed_in().unwrap_or((String::new(), None));
            host.record(
                PlanUsage {
                    provider: "claude".into(),
                    account: Some(account).filter(|a| !a.is_empty()),
                    plan,
                    windows,
                    tokens: None,
                    cost: None,
                    updated_at: now,
                    source: "stream".into(),
                    status,
                    overage_status,
                },
                true,
            );
        });
    }

    /// Codex's `account/rateLimits/updated`, from a session's app-server.
    pub fn codex_event(&self, params: &serde_json::Value) {
        let Some(limits) = params.get("rateLimits") else {
            return;
        };
        let (windows, plan) = codex::parse_rate_limits(limits);
        self.record(
            PlanUsage {
                provider: "codex".into(),
                account: None,
                plan,
                windows,
                tokens: None,
                cost: None,
                updated_at: now_millis(),
                source: "app-server".into(),
                status: None,
                overage_status: None,
            },
            false,
        );
    }

    fn claude_signed_in(&self) -> Option<(String, Option<String>)> {
        let mut held = self.claude_account.lock().unwrap_or_else(|e| e.into_inner());
        if let Some((at, who)) = held.as_ref() {
            if at.elapsed() < AUTH_TTL {
                return who.clone();
            }
        }
        drop(held);
        let who = AgentHost::resolve("claude")
            .ok()
            .and_then(|bin| run(&bin.path, &["auth", "status"], Duration::from_secs(15)))
            .and_then(|text| claude::parse_auth_status(&text));
        held = self.claude_account.lock().unwrap_or_else(|e| e.into_inner());
        *held = Some((Instant::now(), who.clone()));
        who
    }

    /// Asks every installed CLI again, together, and records what they say.
    pub fn refresh(&self) {
        std::thread::scope(|scope| {
            scope.spawn(|| self.refresh_claude());
            scope.spawn(|| self.refresh_with("codex", codex::probe));
            scope.spawn(|| self.refresh_with("cursor-agent", cursor::read));
            scope.spawn(|| self.refresh_with("grok", grok::read));
            scope.spawn(|| self.refresh_with("opencode", opencode::read));
            scope.spawn(|| self.refresh_tokens("claude", claude::tokens));
            scope.spawn(|| self.refresh_tokens("codex", codex::tokens));
            scope.spawn(|| self.refresh_tokens("grok", grok::tokens));
            scope.spawn(|| {
                if AgentHost::resolve("cursor-agent").is_ok() {
                    self.refresh_tokens("cursor", cursor::tokens);
                }
            });
            scope.spawn(|| {
                if let Ok(bin) = AgentHost::resolve("opencode") {
                    self.refresh_tokens("opencode", |since| opencode::tokens(&bin.path, since));
                }
            });
        });
    }

    fn refresh_with(&self, binary: &str, read: fn(&str) -> Option<PlanUsage>) {
        let Ok(bin) = AgentHost::resolve(binary) else {
            return;
        };
        if let Some(reading) = read(&bin.path) {
            self.record(reading, false);
        }
    }

    /// Claude's windows only come with a turn, so asking tells who is signed
    /// in and keeps the windows last heard.
    fn refresh_claude(&self) {
        *self.claude_account.lock().unwrap_or_else(|e| e.into_inner()) = None;
        let Some((account, plan)) = self.claude_signed_in() else {
            return;
        };
        self.record(
            PlanUsage {
                provider: "claude".into(),
                account: Some(account),
                plan,
                windows: Vec::new(),
                tokens: None,
                cost: None,
                updated_at: now_millis(),
                source: "cli".into(),
                status: None,
                overage_status: None,
            },
            true,
        );
    }
}

/// Whether two readings say the same, whenever they were taken.
fn same_reading(a: &PlanUsage, b: &PlanUsage) -> bool {
    let strip = |reading: &PlanUsage| PlanUsage { updated_at: 0, ..reading.clone() };
    strip(a) == strip(b)
}

/// What a window of this many minutes is called.
pub(crate) fn window_label(minutes: i64) -> String {
    match minutes {
        300 => "5 hours".into(),
        10080 => "Weekly".into(),
        43200..=44640 => "Monthly".into(),
        m if m % 1440 == 0 => format!("{} days", m / 1440),
        m if m % 60 == 0 => format!("{} hours", m / 60),
        m => format!("{m} minutes"),
    }
}

pub(crate) const DAY_MS: i64 = 86_400_000;

/// `YYYY-MM-DD` of a time in milliseconds, on this machine's calendar: the day
/// a provider's own tools would say it was spent on.
pub(crate) fn local_day_of(ms: i64) -> String {
    let secs = ms.div_euclid(1000) as libc::time_t;
    // SAFETY: both point at live locals, and `localtime_r` keeps neither.
    let tm = unsafe {
        let mut tm: libc::tm = std::mem::zeroed();
        libc::localtime_r(&secs, &mut tm);
        tm
    };
    format!("{:04}-{:02}-{:02}", i64::from(tm.tm_year) + 1900, tm.tm_mon + 1, tm.tm_mday)
}

/// The days to read: from the first not yet final, never past what is kept.
fn since_day(next: Option<String>, now: i64) -> Since {
    let oldest = local_day_of(now - (HISTORY_DAYS - 1) * DAY_MS);
    let day = next.filter(|next| *next > oldest).unwrap_or(oldest);
    let days = (day_number(&local_day_of(now)) - day_number(&day) + 1).max(1);
    // An hour over, as a day can be 25 hours long.
    Since { day, days: days as u32, from_ms: now - days * DAY_MS - 3_600_000 }
}

fn day_number(day: &str) -> i64 {
    let mut parts = day.split('-').map(|part| part.parse::<i64>().unwrap_or(0));
    let (y, m, d) = (parts.next().unwrap_or(0), parts.next().unwrap_or(0), parts.next().unwrap_or(0));
    days_from_civil(y, m, d)
}

fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = y - i64::from(m <= 2);
    let era = y.div_euclid(400);
    let yoe = y.rem_euclid(400);
    let doy = (153 * (if m > 2 { m - 3 } else { m + 9 }) + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

/// Milliseconds since the epoch of `2026-11-07T02:51:47.912Z`, or of one
/// with an offset (`2026-11-07T02:51:47.912+00:00`).
pub(crate) fn parse_iso_ms(text: &str) -> Option<i64> {
    let (date, time) = text.trim().trim_end_matches('Z').split_once('T')?;
    let mut d = date.split('-').map(|p| p.parse::<i64>().ok());
    let (y, m, day) = (d.next()??, d.next()??, d.next()??);
    let (time, offset) = match time.find(['+', '-']) {
        Some(at) => {
            let (sign, zone) = (if &time[at..at + 1] == "-" { -1 } else { 1 }, &time[at + 1..]);
            let (zh, zm) = zone.split_once(':').unwrap_or((zone, "0"));
            (&time[..at], sign * (zh.parse::<i64>().ok()? * 60 + zm.parse::<i64>().ok()?))
        }
        None => (time, 0),
    };
    let (clock, millis) = time.split_once('.').unwrap_or((time, "0"));
    let mut t = clock.split(':').map(|p| p.parse::<i64>().ok());
    let (h, mi, s) = (t.next()??, t.next()??, t.next()??);
    let millis: i64 = format!("{millis:0<3}")[..3].parse().ok()?;
    Some((days_from_civil(y, m, day) * 86_400 + h * 3600 + (mi - offset) * 60 + s) * 1000 + millis)
}

/// Runs a CLI to its end and returns what it printed, or nothing if it fails
/// or outlasts `timeout`.
pub(crate) fn run(path: &str, args: &[&str], timeout: Duration) -> Option<String> {
    let mut child = Command::new(path)
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .process_group(0)
        .spawn()
        .ok()?;
    let mut stdout = child.stdout.take()?;
    let reader = std::thread::spawn(move || {
        let mut text = String::new();
        let _ = stdout.read_to_string(&mut text);
        text
    });
    let deadline = Instant::now() + timeout;
    let ok = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status.success(),
            Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(25)),
            _ => {
                // Kill the whole group: a grandchild may hold the pipe open.
                unsafe { libc::kill(-(child.id() as i32), libc::SIGKILL) };
                let _ = child.wait();
                break false;
            }
        }
    };
    if !ok {
        return None;
    }
    reader.join().ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crew_protocol::UsageWindow;

    fn window(id: &str, used: f64, minutes: i64) -> UsageWindow {
        UsageWindow {
            id: id.into(),
            label: window_label(minutes),
            used_percent: used,
            window_minutes: Some(minutes),
            resets_at: None,
        }
    }

    fn reading(account: Option<&str>, windows: Vec<UsageWindow>, at: i64) -> PlanUsage {
        PlanUsage {
            provider: "claude".into(),
            account: account.map(str::to_string),
            plan: None,
            windows,
            tokens: None,
            cost: None,
            updated_at: at,
            source: "stream".into(),
            status: None,
            overage_status: None,
        }
    }

    fn host() -> UsageHost {
        let dir = std::env::temp_dir().join(format!("crew-usage-{}", uuid::Uuid::new_v4()));
        UsageHost::new(Store::open(dir.join("crew.sqlite3")).expect("store"))
    }

    #[test]
    fn days_and_iso_times_round_trip() {
        assert_eq!(parse_iso_ms("2026-11-07T02:51:47.912Z"), Some(1_794_019_907_912));
        assert_eq!(parse_iso_ms("2026-11-07T02:51:47.912+00:00"), Some(1_794_019_907_912));
        assert_eq!(parse_iso_ms("2026-11-06T23:51:47.912-03:00"), Some(1_794_019_907_912));
        assert_eq!(parse_iso_ms("2026-11-07T02:51:47+00:00"), Some(1_794_019_907_000));
        assert_eq!(parse_iso_ms("nonsense"), None);
    }

    #[test]
    fn windows_are_named_by_their_length() {
        assert_eq!(window_label(300), "5 hours");
        assert_eq!(window_label(10080), "Weekly");
        assert_eq!(window_label(43200), "Monthly");
        assert_eq!(window_label(2880), "2 days");
    }

    #[test]
    fn a_reading_merges_windows_and_tells_only_of_a_change() {
        let host = host();
        let told = Arc::new(Mutex::new(0));
        let count = told.clone();
        host.set_listener(Arc::new(move |_| *count.lock().unwrap() += 1));
        let day = now_millis().div_euclid(DAY_MS) * DAY_MS;
        host.record(reading(Some("a@x.dev"), vec![window("seven_day", 10.0, 10080)], day), true);
        host.record(reading(Some("a@x.dev"), vec![window("five_hour", 40.0, 300)], day + 1000), true);
        host.record(reading(Some("a@x.dev"), vec![window("seven_day", 25.0, 10080)], day + 2000), true);
        host.record(reading(Some("a@x.dev"), vec![window("seven_day", 20.0, 10080)], day + 3000), true);
        // The same reading again is not news.
        host.record(reading(Some("a@x.dev"), vec![window("seven_day", 20.0, 10080)], day + 4000), true);
        let snapshot = host.snapshot().unwrap();
        assert_eq!(snapshot.readings.len(), 1);
        let ids: Vec<_> = snapshot.readings[0].windows.iter().map(|w| (w.id.as_str(), w.used_percent)).collect();
        assert_eq!(ids, vec![("five_hour", 40.0), ("seven_day", 20.0)]);
        assert_eq!(*told.lock().unwrap(), 4);
    }

    #[test]
    fn a_reading_with_no_account_joins_the_account_last_seen() {
        let host = host();
        host.record(reading(Some("a@x.dev"), vec![window("five_hour", 10.0, 300)], 1_792_457_829_939), true);
        host.record(reading(None, vec![window("seven_day", 5.0, 10080)], 1_792_457_830_939), true);
        let snapshot = host.snapshot().unwrap();
        assert_eq!(snapshot.readings.len(), 1);
        assert_eq!(snapshot.readings[0].account.as_deref(), Some("a@x.dev"));
        assert_eq!(snapshot.readings[0].windows.len(), 2);
    }

    fn spent(input: u64) -> Spent {
        Spent { input, output: 2, cache_write: 3, cache_read: 4 }
    }

    #[test]
    fn the_days_to_read_start_at_the_first_not_final_and_never_past_what_is_kept() {
        let now = now_millis();
        assert_eq!(since_day(None, now).day, local_day_of(now - (HISTORY_DAYS - 1) * DAY_MS));
        assert_eq!(since_day(None, now).days, HISTORY_DAYS as u32);
        let yesterday = local_day_of(now - DAY_MS);
        let since = since_day(Some(yesterday.clone()), now);
        assert_eq!((since.day.as_str(), since.days), (yesterday.as_str(), 2));
        assert_eq!(since_day(Some("2000-01-01".into()), now).days, HISTORY_DAYS as u32);
    }

    #[test]
    fn tokens_are_kept_after_their_logs_are_gone_and_told_only_when_they_change() {
        let host = host();
        let told = Arc::new(Mutex::new(0));
        let count = told.clone();
        host.set_listener(Arc::new(move |_| *count.lock().unwrap() += 1));
        let now = now_millis();
        let (today, yesterday, older) = (local_day_of(now), local_day_of(now - DAY_MS), local_day_of(now - 5 * DAY_MS));
        host.refresh_tokens("claude", |since| {
            assert_eq!(since.days, HISTORY_DAYS as u32, "nothing was read yet");
            let mut tally = Tally::default();
            tally.add(since, older.clone(), "opus", spent(1));
            tally.add(since, today.clone(), "opus", spent(2));
            Some(tally)
        });
        assert_eq!(*told.lock().unwrap(), 1);
        // The next read only asks from yesterday on, and an older day stays held.
        host.refresh_tokens("claude", |since| {
            assert_eq!(since.day, yesterday);
            let mut tally = Tally::default();
            tally.add(since, today.clone(), "opus", spent(2));
            Some(tally)
        });
        assert_eq!(*told.lock().unwrap(), 1, "the same again is not news");
        let held =
            |host: &UsageHost| host.snapshot().unwrap().tokens.iter().map(|row| (row.day.clone(), row.input)).collect::<Vec<_>>();
        assert_eq!(held(&host), vec![(older.clone(), 1), (today.clone(), 2)]);
        // A read that fails leaves it all as it was.
        host.refresh_tokens("claude", |_| None);
        assert_eq!(held(&host), vec![(older.clone(), 1), (today.clone(), 2)]);
        host.refresh_tokens("claude", |since| {
            let mut tally = Tally::default();
            tally.add(since, today.clone(), "opus", spent(9));
            Some(tally)
        });
        assert_eq!(held(&host), vec![(older, 1), (today, 9)]);
        assert_eq!(*told.lock().unwrap(), 2);
    }
}
