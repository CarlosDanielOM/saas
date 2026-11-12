//! What the crate reports: the reference's log entries (level, destination, channel, data) and
//! the "streamer seen" signal that feeds PostHog's `identify`.
//!
//! The binary wires [`TwitchEvents`] to its telemetry handle (`dima_telemetry`), so this crate
//! does not depend on the logger's API. The data of an entry is the reference's object with the
//! same field names; it never holds a token, a refresh token, the client secret or an e-mail
//! (the tests record every entry and search it for each secret they used).

use serde_json::Value;
use std::fmt;

/// A log level (the subset the reference uses here).
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum Level {
    /// `debug`.
    Debug,
    /// `info`.
    Info,
    /// `warn`.
    Warn,
    /// `error`.
    Error,
}

impl Level {
    /// The reference's name.
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Debug => "debug",
            Self::Info => "info",
            Self::Warn => "warn",
            Self::Error => "error",
        }
    }
}

/// Where the reference sent the entry (`destination`).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Destination {
    /// stdout only (`console.*` calls, `destination: 'console'`).
    Console,
    /// The Dragonfly debug log only.
    Cache,
    /// Both.
    Both,
}

/// One log entry.
#[derive(Clone, Copy, Debug)]
pub struct LogEvent<'a> {
    /// The level.
    pub level: Level,
    /// Where it goes.
    pub destination: Destination,
    /// The channel the entry is about (`channelId`), if any.
    pub channel_id: Option<&'a str>,
    /// The reference's data object.
    pub data: &'a Value,
}

/// The sink the binary provides.
pub trait TwitchEvents: Send + Sync + fmt::Debug {
    /// A log entry.
    fn log(&self, event: &LogEvent<'_>);

    /// A streamer was loaded or hydrated under this name for the first time in this process,
    /// or under a new name (`identifyStreamer`: PostHog `identify` with `channel_name`). The
    /// directory has already removed repeats.
    fn streamer_seen(&self, _channel_id: &str, _name: &str) {}
}

/// Drops everything.
#[derive(Clone, Copy, Debug, Default)]
pub struct NoopEvents;

impl TwitchEvents for NoopEvents {
    fn log(&self, _event: &LogEvent<'_>) {}
}

/// A sink that keeps every entry (tests, feature `test-util`).
#[cfg(any(test, feature = "test-util"))]
#[derive(Debug, Default)]
pub struct RecordingEvents {
    entries: std::sync::Mutex<Vec<Recorded>>,
    seen: std::sync::Mutex<Vec<(String, String)>>,
}

/// One recorded entry.
#[cfg(any(test, feature = "test-util"))]
#[derive(Clone, Debug, PartialEq)]
pub struct Recorded {
    /// The level.
    pub level: Level,
    /// The destination.
    pub destination: Destination,
    /// The channel.
    pub channel_id: Option<String>,
    /// The data.
    pub data: Value,
}

#[cfg(any(test, feature = "test-util"))]
impl Recorded {
    /// The `action` field, if the entry has one.
    pub fn action(&self) -> Option<&str> {
        self.data.get("action").and_then(Value::as_str)
    }
}

#[cfg(any(test, feature = "test-util"))]
impl RecordingEvents {
    /// Every entry so far.
    pub fn entries(&self) -> Vec<Recorded> {
        self.entries
            .lock()
            .map(|entries| entries.clone())
            .unwrap_or_default()
    }

    /// The `action` of every entry, in order (entries without one are skipped).
    pub fn actions(&self) -> Vec<String> {
        self.entries()
            .iter()
            .filter_map(|entry| entry.action().map(str::to_owned))
            .collect()
    }

    /// Every `streamer_seen` call.
    pub fn seen(&self) -> Vec<(String, String)> {
        self.seen
            .lock()
            .map(|seen| seen.clone())
            .unwrap_or_default()
    }

    /// Whether any entry's data contains `needle` anywhere (keys or values).
    pub fn mentions(&self, needle: &str) -> bool {
        !needle.is_empty()
            && self
                .entries()
                .iter()
                .any(|entry| entry.data.to_string().contains(needle))
    }
}

#[cfg(any(test, feature = "test-util"))]
impl TwitchEvents for RecordingEvents {
    fn log(&self, event: &LogEvent<'_>) {
        if let Ok(mut entries) = self.entries.lock() {
            entries.push(Recorded {
                level: event.level,
                destination: event.destination,
                channel_id: event.channel_id.map(str::to_owned),
                data: event.data.clone(),
            });
        }
    }

    fn streamer_seen(&self, channel_id: &str, name: &str) {
        if let Ok(mut seen) = self.seen.lock() {
            seen.push((channel_id.to_owned(), name.to_owned()));
        }
    }
}
