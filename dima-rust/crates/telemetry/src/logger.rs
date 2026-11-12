//! The application logger (`utils/logger.ts`, `ledger/runtime.md` 6.6).
//!
//! The call site is [`crate::Telemetry::log`] and the six level methods. A call whose level is
//! below the configured minimum returns after one comparison: no allocation, no serialisation.
//! Otherwise the data is serialised once into JSON, redacted ([`crate::redact`]), and handed to
//! each selected destination through its own bounded queue; the caller never waits for a socket
//! or a pipe. A full queue, or the shared byte budget being spent, drops the entry for that
//! destination and counts it.
//!
//! - **console**: one JSON object per line on stdout, written by a dedicated thread (a slow
//!   reader of the pipe cannot stall the runtime). The reference prints Node's `util.inspect`
//!   format, which nothing parses.
//! - **cache**: `SET logger:<platform>:<channelId|global>:<level>:<epochMs>-<8 hex> <json> EX 604800`
//!   in one command (the reference sets the expiry in a second command). The value keeps the
//!   reference's fields in its order: `{data, timestamp, level, platform, channelId}` with the
//!   `en-US` UTC timestamp, plus `traceId` when the call ran inside a trace.
//! - **telemetry**: warn and above also become metadata-only rows in the telemetry pipeline
//!   (`recordLog`), whatever the destination.
//! - **PostHog**: every entry, whatever the destination (`openLog.emit` in the reference), when the
//!   process exports logs there (API and bot); see [`crate::otlp`].

use crate::trace::SpanIds;
use serde::Serialize;
use serde_json::Value;
use std::io::Write;
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, PoisonError};

/// The cache expiry: 7 days.
pub const CACHE_TTL_SECONDS: u64 = 604_800;
/// The default platform.
pub const DEFAULT_PLATFORM: &str = "twitch";

/// A log level, in increasing severity.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Level {
    /// `trace`.
    Trace,
    /// `debug`.
    Debug,
    /// `info`.
    Info,
    /// `warn`.
    Warn,
    /// `error`.
    Error,
    /// `fatal`.
    Fatal,
}

impl Level {
    /// The reference's name.
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Trace => "trace",
            Self::Debug => "debug",
            Self::Info => "info",
            Self::Warn => "warn",
            Self::Error => "error",
            Self::Fatal => "fatal",
        }
    }

    /// Parses a level name.
    pub fn parse(name: &str) -> Option<Self> {
        Some(match name {
            "trace" => Self::Trace,
            "debug" => Self::Debug,
            "info" => Self::Info,
            "warn" => Self::Warn,
            "error" => Self::Error,
            "fatal" => Self::Fatal,
            _ => return None,
        })
    }
}

/// Where an entry goes (the reference's `destination`, default `both`).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum Destination {
    /// stdout only.
    Console,
    /// The Dragonfly debug log only.
    Cache,
    /// Both.
    #[default]
    Both,
}

impl Destination {
    fn console(self) -> bool {
        matches!(self, Self::Console | Self::Both)
    }

    fn cache(self) -> bool {
        matches!(self, Self::Cache | Self::Both)
    }

    /// The reference's name.
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Console => "console",
            Self::Cache => "cache",
            Self::Both => "both",
        }
    }
}

/// The reference's `{destination, platform, channelId}`.
#[derive(Clone, Copy, Debug)]
pub struct LogOptions<'a> {
    /// Where the entry goes.
    pub destination: Destination,
    /// The platform (`twitch`).
    pub platform: &'a str,
    /// The channel, if the entry is about one.
    pub channel_id: Option<&'a str>,
}

impl Default for LogOptions<'_> {
    fn default() -> Self {
        Self {
            destination: Destination::Both,
            platform: DEFAULT_PLATFORM,
            channel_id: None,
        }
    }
}

impl<'a> LogOptions<'a> {
    /// Both destinations, platform `twitch`, no channel.
    pub fn new() -> Self {
        Self::default()
    }

    /// stdout only.
    pub fn console() -> Self {
        Self {
            destination: Destination::Console,
            ..Self::default()
        }
    }

    /// The Dragonfly debug log only.
    pub fn cache() -> Self {
        Self {
            destination: Destination::Cache,
            ..Self::default()
        }
    }

    /// For a channel.
    pub fn channel(mut self, channel_id: &'a str) -> Self {
        self.channel_id = Some(channel_id);
        self
    }

    /// For a platform.
    pub fn platform(mut self, platform: &'a str) -> Self {
        self.platform = platform;
        self
    }
}

/// Where console lines go.
#[derive(Clone, Debug, Default)]
pub enum ConsoleTarget {
    /// The process's stdout.
    #[default]
    Stdout,
    /// A buffer (tests).
    Memory(Arc<Mutex<Vec<u8>>>),
    /// Nowhere.
    Off,
}

/// One queued entry, shared by the destinations it goes to. Its size is charged to the shared
/// byte budget until the last destination is done with it.
pub(crate) struct LogRecord {
    pub(crate) level: Level,
    pub(crate) at_ms: i64,
    pub(crate) data: Value,
    pub(crate) platform: String,
    pub(crate) channel_id: Option<String>,
    pub(crate) destination: Destination,
    pub(crate) trace: Option<SpanIds>,
    charge: usize,
    budget: Arc<AtomicUsize>,
}

impl Drop for LogRecord {
    fn drop(&mut self) {
        self.budget.fetch_sub(self.charge, Ordering::Relaxed);
    }
}

/// Counters of entries lost per destination.
#[derive(Debug, Default)]
pub(crate) struct LogDrops {
    pub(crate) console: AtomicU64,
    pub(crate) cache: AtomicU64,
    pub(crate) posthog: AtomicU64,
}

pub(crate) enum ConsoleMessage {
    Record(Arc<LogRecord>),
    Line(String),
    Flush(tokio::sync::oneshot::Sender<()>),
    Stop,
}

/// The queues an entry is offered to.
pub(crate) struct Sinks {
    pub(crate) console: Option<std::sync::mpsc::SyncSender<ConsoleMessage>>,
    pub(crate) cache: Option<tokio::sync::mpsc::Sender<Arc<LogRecord>>>,
    pub(crate) posthog: Option<tokio::sync::mpsc::Sender<Arc<LogRecord>>>,
    pub(crate) budget: Arc<AtomicUsize>,
    pub(crate) budget_max: usize,
    pub(crate) drops: LogDrops,
}

/// The receiving ends, taken by [`crate::Telemetry::start`].
pub(crate) struct Receivers {
    pub(crate) console: Option<(std::sync::mpsc::Receiver<ConsoleMessage>, ConsoleTarget)>,
    pub(crate) cache: Option<tokio::sync::mpsc::Receiver<Arc<LogRecord>>>,
    pub(crate) posthog: Option<tokio::sync::mpsc::Receiver<Arc<LogRecord>>>,
}

impl Sinks {
    pub(crate) fn new(
        console: ConsoleTarget,
        cache: bool,
        posthog: bool,
        queue: usize,
        budget_max: usize,
    ) -> (Self, Receivers) {
        let queue = queue.max(1);
        let (console_tx, console_rx) = if matches!(console, ConsoleTarget::Off) {
            (None, None)
        } else {
            let (tx, rx) = std::sync::mpsc::sync_channel(queue);
            (Some(tx), Some((rx, console)))
        };
        let (cache_tx, cache_rx) = if cache {
            let (tx, rx) = tokio::sync::mpsc::channel(queue);
            (Some(tx), Some(rx))
        } else {
            (None, None)
        };
        let (posthog_tx, posthog_rx) = if posthog {
            let (tx, rx) = tokio::sync::mpsc::channel(queue.saturating_mul(2));
            (Some(tx), Some(rx))
        } else {
            (None, None)
        };
        (
            Self {
                console: console_tx,
                cache: cache_tx,
                posthog: posthog_tx,
                budget: Arc::new(AtomicUsize::new(0)),
                budget_max,
                drops: LogDrops::default(),
            },
            Receivers {
                console: console_rx,
                cache: cache_rx,
                posthog: posthog_rx,
            },
        )
    }

    /// Builds the shared record, charging the budget; `None` when the budget is spent.
    #[allow(clippy::too_many_arguments)]
    pub(crate) fn record(
        &self,
        level: Level,
        at_ms: i64,
        data: Value,
        size: usize,
        options: &LogOptions<'_>,
        trace: Option<SpanIds>,
    ) -> Option<Arc<LogRecord>> {
        let charge = size.saturating_add(128);
        let admitted = self
            .budget
            .try_update(Ordering::Relaxed, Ordering::Relaxed, |used| {
                (used.saturating_add(charge) <= self.budget_max).then_some(used + charge)
            });
        if admitted.is_err() {
            return None;
        }
        Some(Arc::new(LogRecord {
            level,
            at_ms,
            data,
            platform: options.platform.to_owned(),
            channel_id: options.channel_id.map(str::to_owned),
            destination: options.destination,
            trace,
            charge,
            budget: self.budget.clone(),
        }))
    }

    /// Offers one record to its destinations. Returns how many destinations lost it.
    pub(crate) fn offer(&self, record: &Arc<LogRecord>) -> u64 {
        let mut lost = 0;
        if record.destination.console()
            && let Some(console) = &self.console
            && console
                .try_send(ConsoleMessage::Record(record.clone()))
                .is_err()
        {
            self.drops.console.fetch_add(1, Ordering::Relaxed);
            lost += 1;
        }
        if record.destination.cache() {
            let sent = self
                .cache
                .as_ref()
                .is_some_and(|cache| cache.try_send(record.clone()).is_ok());
            if !sent {
                self.drops.cache.fetch_add(1, Ordering::Relaxed);
                lost += 1;
            }
        }
        if let Some(posthog) = &self.posthog
            && posthog.try_send(record.clone()).is_err()
        {
            self.drops.posthog.fetch_add(1, Ordering::Relaxed);
            lost += 1;
        }
        lost
    }

    /// A pre-formatted line for the console only (connection-error reports).
    pub(crate) fn console_line(&self, line: String) {
        if let Some(console) = &self.console
            && console.try_send(ConsoleMessage::Line(line)).is_err()
        {
            self.drops.console.fetch_add(1, Ordering::Relaxed);
        }
    }
}

/// The console line: `{level, time, platform, channelId?, traceId?, data}`.
#[derive(Serialize)]
struct ConsoleLine<'a> {
    level: &'static str,
    time: String,
    platform: &'a str,
    #[serde(rename = "channelId", skip_serializing_if = "Option::is_none")]
    channel_id: Option<&'a str>,
    #[serde(rename = "traceId", skip_serializing_if = "Option::is_none")]
    trace_id: Option<&'a str>,
    data: &'a Value,
}

pub(crate) fn console_line(record: &LogRecord) -> String {
    let trace = record.trace.map(|ids| ids.trace_id.hex());
    let line = ConsoleLine {
        level: record.level.as_str(),
        time: iso_timestamp(record.at_ms),
        platform: &record.platform,
        channel_id: record.channel_id.as_deref(),
        trace_id: trace.as_ref().map(|hex| hex.as_str()),
        data: &record.data,
    };
    serde_json::to_string(&line).unwrap_or_default()
}

/// The console writer thread: one line per entry, until [`ConsoleMessage::Stop`] or the queue
/// closes.
pub(crate) fn run_console(rx: std::sync::mpsc::Receiver<ConsoleMessage>, target: ConsoleTarget) {
    let write = |line: &str| match &target {
        ConsoleTarget::Stdout => {
            let mut out = std::io::stdout().lock();
            let _ = out.write_all(line.as_bytes());
            let _ = out.write_all(b"\n");
        }
        ConsoleTarget::Memory(buffer) => {
            let mut buffer = buffer.lock().unwrap_or_else(PoisonError::into_inner);
            buffer.extend_from_slice(line.as_bytes());
            buffer.push(b'\n');
        }
        ConsoleTarget::Off => {}
    };
    while let Ok(message) = rx.recv() {
        match message {
            ConsoleMessage::Record(record) => write(&console_line(&record)),
            ConsoleMessage::Line(line) => write(&line),
            ConsoleMessage::Flush(done) => {
                let _ = std::io::stdout().flush();
                let _ = done.send(());
            }
            ConsoleMessage::Stop => break,
        }
    }
}

/// The cache entry (`JSON.stringify(entry)`): `{data, timestamp, level, platform, channelId?}`,
/// plus `traceId` when there is one.
#[derive(Serialize)]
struct CacheEntry<'a> {
    data: &'a Value,
    timestamp: String,
    level: &'static str,
    platform: &'a str,
    #[serde(rename = "channelId", skip_serializing_if = "Option::is_none")]
    channel_id: Option<&'a str>,
    #[serde(rename = "traceId", skip_serializing_if = "Option::is_none")]
    trace_id: Option<&'a str>,
}

fn key_part(value: &str, max: usize) -> String {
    value
        .chars()
        .take(max)
        .map(|character| {
            if character.is_ascii_alphanumeric() || matches!(character, '_' | '-' | '.') {
                character
            } else {
                '_'
            }
        })
        .collect()
}

/// The key and value of one cache entry.
pub(crate) fn cache_entry(record: &LogRecord, suffix: u32) -> (String, String) {
    let platform = key_part(&record.platform, 32);
    let channel = record
        .channel_id
        .as_deref()
        .filter(|id| !id.is_empty())
        .map(|id| key_part(id, 80))
        .unwrap_or_else(|| "global".to_owned());
    let key = format!(
        "logger:{platform}:{channel}:{}:{}-{suffix:08x}",
        record.level.as_str(),
        record.at_ms
    );
    let trace = record.trace.map(|ids| ids.trace_id.hex());
    let entry = CacheEntry {
        data: &record.data,
        timestamp: format_timestamp(record.at_ms),
        level: record.level.as_str(),
        platform: &record.platform,
        channel_id: record.channel_id.as_deref(),
        trace_id: trace.as_ref().map(|hex| hex.as_str()),
    };
    (key, serde_json::to_string(&entry).unwrap_or_default())
}

fn civil(millis: i64) -> (i64, i64, i64, i64, i64, i64, i64) {
    let days = millis.div_euclid(86_400_000);
    // Howard Hinnant's civil_from_days.
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let mut year = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = mp + if mp < 10 { 3 } else { -9 };
    year += i64::from(month <= 2);
    let seconds = millis.div_euclid(1000).rem_euclid(86_400);
    (
        year,
        month,
        day,
        seconds / 3600,
        seconds / 60 % 60,
        seconds % 60,
        millis.rem_euclid(1000),
    )
}

/// `new Date(ms).toLocaleString('en-US', {timeZone: 'UTC'})`: `11/11/2026, 3:04:05 PM`.
pub fn format_timestamp(millis: i64) -> String {
    let (year, month, day, hour, minute, second, _) = civil(millis);
    let year = if year <= 0 { 1 - year } else { year };
    format!(
        "{month}/{day}/{year}, {}:{minute:02}:{second:02} {}",
        if hour % 12 == 0 { 12 } else { hour % 12 },
        if hour >= 12 { "PM" } else { "AM" }
    )
}

/// ISO 8601 UTC with milliseconds, for console lines.
pub fn iso_timestamp(millis: i64) -> String {
    let (year, month, day, hour, minute, second, ms) = civil(millis);
    format!("{year:04}-{month:02}-{day:02}T{hour:02}:{minute:02}:{second:02}.{ms:03}Z")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn timestamps() {
        assert_eq!(
            format_timestamp(1_794_409_445_000),
            "11/11/2026, 3:04:05 PM"
        );
        assert_eq!(format_timestamp(0), "1/1/1970, 12:00:00 AM");
        assert_eq!(format_timestamp(43_200_000), "1/1/1970, 12:00:00 PM");
        assert_eq!(iso_timestamp(1_794_409_445_123), "2026-11-11T15:04:05.123Z");
    }

    #[test]
    fn levels_order_and_parse() {
        assert!(Level::Debug < Level::Info && Level::Error < Level::Fatal);
        for level in [
            Level::Trace,
            Level::Debug,
            Level::Info,
            Level::Warn,
            Level::Error,
            Level::Fatal,
        ] {
            assert_eq!(Level::parse(level.as_str()), Some(level));
        }
    }

    #[test]
    fn cache_entries_keep_the_reference_shape() {
        let (sinks, _rx) = Sinks::new(ConsoleTarget::Off, true, false, 4, 1 << 20);
        let options = LogOptions::cache().channel("123:4");
        let record = sinks
            .record(
                Level::Warn,
                1_794_409_445_000,
                serde_json::json!({"a": 1}),
                10,
                &options,
                None,
            )
            .unwrap_or_else(|| panic!("budget"));
        let (key, value) = cache_entry(&record, 0xab);
        assert_eq!(key, "logger:twitch:123_4:warn:1794409445000-000000ab");
        assert_eq!(
            value,
            r#"{"data":{"a":1},"timestamp":"11/11/2026, 3:04:05 PM","level":"warn","platform":"twitch","channelId":"123:4"}"#
        );
        let global = sinks
            .record(Level::Info, 0, Value::Null, 1, &LogOptions::cache(), None)
            .unwrap_or_else(|| panic!("budget"));
        assert!(
            cache_entry(&global, 1)
                .0
                .starts_with("logger:twitch:global:info:0-")
        );
    }

    #[test]
    fn budget_is_released_when_the_last_destination_is_done() {
        let (sinks, _rx) = Sinks::new(ConsoleTarget::Off, false, false, 4, 1000);
        let first = sinks.record(Level::Info, 0, Value::Null, 700, &LogOptions::new(), None);
        assert!(first.is_some());
        assert!(
            sinks
                .record(Level::Info, 0, Value::Null, 700, &LogOptions::new(), None)
                .is_none()
        );
        drop(first);
        assert_eq!(sinks.budget.load(Ordering::Relaxed), 0);
        assert!(
            sinks
                .record(Level::Info, 0, Value::Null, 700, &LogOptions::new(), None)
                .is_some()
        );
    }
}
