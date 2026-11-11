//! Hooks for telemetry and error logging, so this crate depends on neither.
//!
//! - [`CommandHook`]: spans for exactly the commands the reference instruments. Its
//!   `getDragonflyClient` returns a `Proxy` that wraps `get, set, hGet, hGetAll, hSet, exists,
//!   del, zAdd, zPopMin, zCard, lPush, rPush, lPop, rPop, eval` with `beginSpan("cache", method)`,
//!   and for `get` and `hGet` also records `observe("cache_lookup", method, 0, hit|miss)`. Every
//!   other command (pipelines, `MULTI`, blocking commands, `hIncrBy`, ...) is not measured.
//! - [`ErrorHook`]: connection-level errors (the reference's `client.on('error')`), with
//!   [`ErrorLogLimiter`] reproducing its 30-second suppression window as a pure function of the
//!   time the caller passes in, and [`SuppressedErrorLog`] wiring the two together.

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::Duration;
use tokio::time::Instant;

/// The node-redis method name the reference instruments for a Redis command name, if any.
///
/// `EVALSHA` maps to `eval` because a [`super::Script`] stands in for node-redis `eval`.
pub fn instrumented_method(command: &[u8]) -> Option<&'static str> {
    const TABLE: [(&str, &str); 16] = [
        ("GET", "get"),
        ("SET", "set"),
        ("HGET", "hGet"),
        ("HGETALL", "hGetAll"),
        ("HSET", "hSet"),
        ("EXISTS", "exists"),
        ("DEL", "del"),
        ("ZADD", "zAdd"),
        ("ZPOPMIN", "zPopMin"),
        ("ZCARD", "zCard"),
        ("LPUSH", "lPush"),
        ("RPUSH", "rPush"),
        ("LPOP", "lPop"),
        ("RPOP", "rPop"),
        ("EVAL", "eval"),
        ("EVALSHA", "eval"),
    ];
    TABLE
        .iter()
        .find(|(name, _)| name.as_bytes().eq_ignore_ascii_case(command))
        .map(|(_, method)| *method)
}

/// Hit or miss of a `get` / `hGet` (`result === null ? 'miss' : 'hit'`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CacheLookup {
    /// The reply was a value.
    Hit,
    /// The reply was nil.
    Miss,
}

/// How an instrumented command ended.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CommandOutcome {
    /// A reply arrived. `lookup` is set for `get` and `hGet` only.
    Ok {
        /// Hit or miss, for the two lookup methods.
        lookup: Option<CacheLookup>,
    },
    /// The command failed (`span.end('error')` in the reference); no lookup is recorded.
    Error,
}

/// Receives one call per instrumented command. Called inline: keep it cheap and non-blocking.
pub trait CommandHook: Send + Sync + 'static {
    /// `method` is the node-redis method name (see [`instrumented_method`]), `elapsed` the time
    /// from sending to the reply (or error).
    fn finished(&self, method: &'static str, elapsed: Duration, outcome: CommandOutcome);
}

/// A connection-level error: the connection could not be opened, was dropped, or timed out.
/// Server error replies (`WRONGTYPE`, `NOSCRIPT`, ...) go to the caller only, as in the reference.
#[derive(Debug)]
pub struct ConnectionError<'a> {
    /// [`super::DragonflyConfig::caller`].
    pub caller: &'a str,
    /// A short code standing in for Node's `error.code` (`ECONNREFUSED` and friends): the I/O
    /// error kind or the driver error kind.
    pub code: String,
    /// The error itself.
    pub error: &'a redis::RedisError,
}

/// Receives connection-level errors. Called inline: keep it cheap and non-blocking.
pub trait ErrorHook: Send + Sync + 'static {
    /// One connection error.
    fn connection_error(&self, error: &ConnectionError<'_>);
}

/// The reference's suppression window: 30 seconds.
pub const ERROR_LOG_WINDOW: Duration = Duration::from_secs(30);

/// Most distinct (caller, code, message) keys remembered; beyond it the stalest is forgotten
/// (the reference's `Map` is unbounded).
pub const ERROR_LOG_MAX_KEYS: usize = 256;

/// What to do with one error report.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LogDecision {
    /// Log it. `suppressed` similar errors were skipped since the last logged one; the reference
    /// then logs `(suppressed N similar errors in last 30s)`.
    Log {
        /// Errors skipped in the window that just ended.
        suppressed: u64,
    },
    /// Skip it: the same error was logged less than the window ago.
    Suppress,
}

#[derive(Debug)]
struct Tracked {
    last_logged: Instant,
    suppressed: u64,
}

/// `logDragonflyError`'s bookkeeping: one log line per (caller, code, message) per window.
#[derive(Debug)]
pub struct ErrorLogLimiter {
    window: Duration,
    tracked: HashMap<String, Tracked>,
}

impl Default for ErrorLogLimiter {
    fn default() -> Self {
        Self::new(ERROR_LOG_WINDOW)
    }
}

impl ErrorLogLimiter {
    /// A limiter with this window.
    pub fn new(window: Duration) -> Self {
        Self {
            window,
            tracked: HashMap::new(),
        }
    }

    /// Decide for one error at `now`. Same arithmetic as the reference: within the window of the
    /// last logged occurrence the error is counted and skipped; afterwards it is logged with the
    /// count, which restarts at zero.
    pub fn decide(&mut self, caller: &str, code: &str, message: &str, now: Instant) -> LogDecision {
        let key = format!("{caller}:{code}:{message}");
        if let Some(tracked) = self.tracked.get_mut(&key) {
            if now.saturating_duration_since(tracked.last_logged) < self.window {
                tracked.suppressed = tracked.suppressed.saturating_add(1);
                return LogDecision::Suppress;
            }
            let suppressed = tracked.suppressed;
            *tracked = Tracked {
                last_logged: now,
                suppressed: 0,
            };
            return LogDecision::Log { suppressed };
        }
        if self.tracked.len() >= ERROR_LOG_MAX_KEYS {
            let window = self.window;
            self.tracked
                .retain(|_, tracked| now.saturating_duration_since(tracked.last_logged) < window);
            if self.tracked.len() >= ERROR_LOG_MAX_KEYS
                && let Some(stalest) = self
                    .tracked
                    .iter()
                    .min_by_key(|(_, tracked)| tracked.last_logged)
                    .map(|(key, _)| key.clone())
            {
                self.tracked.remove(&stalest);
            }
        }
        self.tracked.insert(
            key,
            Tracked {
                last_logged: now,
                suppressed: 0,
            },
        );
        LogDecision::Log { suppressed: 0 }
    }
}

/// One line the reference would print.
#[derive(Debug)]
pub struct ErrorLogLine<'a> {
    /// The error report.
    pub error: &'a ConnectionError<'a>,
    /// Similar errors skipped in the last window (0: the plain message).
    pub suppressed: u64,
}

/// An [`ErrorHook`] that applies the 30-second window and hands each admitted line to `sink`.
/// The time is tokio's clock, so tests with a paused clock stay deterministic.
pub struct SuppressedErrorLog<F> {
    limiter: Mutex<ErrorLogLimiter>,
    sink: F,
}

impl<F> SuppressedErrorLog<F>
where
    F: Fn(&ErrorLogLine<'_>) + Send + Sync + 'static,
{
    /// Wraps `sink` with the reference's window.
    pub fn new(sink: F) -> Self {
        Self {
            limiter: Mutex::new(ErrorLogLimiter::default()),
            sink,
        }
    }
}

impl<F> ErrorHook for SuppressedErrorLog<F>
where
    F: Fn(&ErrorLogLine<'_>) + Send + Sync + 'static,
{
    fn connection_error(&self, error: &ConnectionError<'_>) {
        let message = error.error.to_string();
        let decision = match self.limiter.lock() {
            Ok(mut limiter) => limiter.decide(error.caller, &error.code, &message, Instant::now()),
            // A poisoned lock only means another report panicked mid-way: log rather than lose it.
            Err(_) => LogDecision::Log { suppressed: 0 },
        };
        if let LogDecision::Log { suppressed } = decision {
            (self.sink)(&ErrorLogLine { error, suppressed });
        }
    }
}

/// The hooks a [`super::Dragonfly`] handle reports to. Both are optional.
#[derive(Clone, Default)]
pub struct Hooks {
    /// Command spans.
    pub command: Option<std::sync::Arc<dyn CommandHook>>,
    /// Connection errors.
    pub errors: Option<std::sync::Arc<dyn ErrorHook>>,
}

impl std::fmt::Debug for Hooks {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Hooks")
            .field("command", &self.command.is_some())
            .field("errors", &self.errors.is_some())
            .finish()
    }
}

impl Hooks {
    pub(crate) fn report(&self, caller: &str, error: &redis::RedisError) {
        if !is_connection_error(error) {
            return;
        }
        if let Some(hook) = &self.errors {
            hook.connection_error(&ConnectionError {
                caller,
                code: error_code(error),
                error,
            });
        }
    }
}

/// Connection-level, as opposed to a server error reply.
pub(crate) fn is_connection_error(error: &redis::RedisError) -> bool {
    error.is_io_error()
        || error.is_timeout()
        || error.is_connection_dropped()
        || error.is_connection_refusal()
}

fn error_code(error: &redis::RedisError) -> String {
    // The driver keeps the I/O error private; its source chain still exposes it.
    let io =
        std::error::Error::source(error).and_then(|source| source.downcast_ref::<std::io::Error>());
    match io {
        Some(io) => format!("{:?}", io.kind()),
        None => format!("{:?}", error.kind()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn exactly_the_reference_methods_are_instrumented() {
        for (command, method) in [
            ("GET", "get"),
            ("get", "get"),
            ("HGETALL", "hGetAll"),
            ("ZPOPMIN", "zPopMin"),
            ("EVALSHA", "eval"),
            ("EVAL", "eval"),
            ("RPOP", "rPop"),
        ] {
            assert_eq!(instrumented_method(command.as_bytes()), Some(method));
        }
        for command in [
            "MULTI", "BLPOP", "BLMOVE", "HINCRBY", "LREM", "PUBLISH", "SCAN", "TTL",
        ] {
            assert_eq!(instrumented_method(command.as_bytes()), None, "{command}");
        }
    }

    #[test]
    fn limiter_reproduces_the_thirty_second_window() {
        let start = Instant::now();
        let mut limiter = ErrorLogLimiter::default();
        let at = |s: u64| start + Duration::from_secs(s);
        assert_eq!(
            limiter.decide("bot", "ECONNREFUSED", "m", at(0)),
            LogDecision::Log { suppressed: 0 }
        );
        assert_eq!(
            limiter.decide("bot", "ECONNREFUSED", "m", at(1)),
            LogDecision::Suppress
        );
        assert_eq!(
            limiter.decide("bot", "ECONNREFUSED", "m", at(29)),
            LogDecision::Suppress
        );
        // A different key is independent.
        assert_eq!(
            limiter.decide("api", "ECONNREFUSED", "m", at(29)),
            LogDecision::Log { suppressed: 0 }
        );
        // `now - lastLoggedAt < 30000` is false at exactly 30 s: logged with the count.
        assert_eq!(
            limiter.decide("bot", "ECONNREFUSED", "m", at(30)),
            LogDecision::Log { suppressed: 2 }
        );
        assert_eq!(
            limiter.decide("bot", "ECONNREFUSED", "m", at(61)),
            LogDecision::Log { suppressed: 0 }
        );
    }

    #[test]
    fn limiter_is_bounded() {
        let start = Instant::now();
        let mut limiter = ErrorLogLimiter::default();
        for index in 0..(ERROR_LOG_MAX_KEYS * 3) {
            let decision = limiter.decide(
                "c",
                "x",
                &index.to_string(),
                start + Duration::from_millis(index as u64),
            );
            assert_eq!(decision, LogDecision::Log { suppressed: 0 });
            assert!(limiter.tracked.len() <= ERROR_LOG_MAX_KEYS);
        }
    }
}
