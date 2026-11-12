//! The runtime's settings (`workers/domain_events.worker.ts`), read once by the binary.

use std::time::Duration;

/// A setting the reference refuses to start with (`Invalid <NAME>`).
#[derive(Clone, Debug, PartialEq, Eq, thiserror::Error)]
#[error("Invalid {0}")]
pub struct ConfigError(pub &'static str);

/// The runtime's settings. Defaults, minimums and parsing are the reference's.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ConsumerConfig {
    /// `DOMAIN_EVENTS_POLL_INTERVAL_MS` (1,000; at least 250): the sweep when no wakeup comes.
    pub poll_interval_ms: i64,
    /// `DOMAIN_EVENTS_BATCH_SIZE` (100; 1 to 500): events per dispatch, deliveries and events per
    /// drain pass.
    pub batch_size: i64,
    /// `DOMAIN_EVENTS_MAX_ATTEMPTS` (5; at least 1).
    pub max_attempts: i64,
    /// `DOMAIN_EVENTS_LEASE_MS` (60,000; at least 5,000).
    pub lease_ms: i64,
    /// `DOMAIN_EVENTS_EXECUTION_TIMEOUT_MS` (120,000; at least 1,000): a handler is stopped this
    /// long after its claim, however often its lease was renewed.
    pub execution_timeout_ms: i64,
    /// `DOMAIN_EVENTS_OPERATION_TIMEOUT_MS` (60,000; at least the poll interval + 1,000). The
    /// reference kills a consumer process that reports nothing for this long outside a handler
    /// (a store call that hangs). Here every store call has its own deadline (10 s), so it is
    /// only validated, as the reference does.
    pub operation_timeout_ms: i64,
    /// `DOMAIN_EVENTS_SHUTDOWN_GRACE_MS` (5,000; at least 100): what a handler in flight gets at
    /// shutdown.
    pub shutdown_grace_ms: i64,
    /// `DOMAIN_EVENTS_RESTART_DELAY_MS` (1,000; at least 100): the pause before a consumer
    /// carries on after a handler was stopped (the reference restarts its process).
    pub restart_delay_ms: i64,
    /// How long an aborted handler gets to stop before the process must exit (Rust only; the
    /// reference kills a process, which cannot fail to stop).
    pub abort_grace_ms: i64,
}

impl Default for ConsumerConfig {
    fn default() -> Self {
        Self {
            poll_interval_ms: 1_000,
            batch_size: 100,
            max_attempts: 5,
            lease_ms: 60_000,
            execution_timeout_ms: 120_000,
            operation_timeout_ms: 60_000,
            shutdown_grace_ms: 5_000,
            restart_delay_ms: 1_000,
            abort_grace_ms: 2_000,
        }
    }
}

/// `setting(name, fallback, min, max)`: `Number(process.env[name] ?? fallback)`, a safe integer
/// in `[min, max]`, or `Invalid <name>`.
fn setting(
    value: Option<&str>,
    name: &'static str,
    fallback: i64,
    min: i64,
    max: i64,
) -> Result<i64, ConfigError> {
    let number = match value {
        None => fallback as f64,
        Some(text) => dima_text::parse_number(text),
    };
    const MAX_SAFE: f64 = 9_007_199_254_740_991.0;
    if !number.is_finite()
        || number.fract() != 0.0
        || number.abs() > MAX_SAFE
        || number < min as f64
        || number > max as f64
    {
        return Err(ConfigError(name));
    }
    Ok(number as i64)
}

const INT32_MAX: i64 = 2_147_483_647;

impl ConsumerConfig {
    /// The settings from the environment's values (`lookup(name)`), with the reference's checks.
    pub fn from_env(lookup: impl Fn(&str) -> Option<String>) -> Result<Self, ConfigError> {
        let read = |name: &'static str, fallback: i64, min: i64, max: i64| {
            setting(lookup(name).as_deref(), name, fallback, min, max)
        };
        let poll_interval_ms = read("DOMAIN_EVENTS_POLL_INTERVAL_MS", 1_000, 250, INT32_MAX)?;
        Ok(Self {
            poll_interval_ms,
            batch_size: read("DOMAIN_EVENTS_BATCH_SIZE", 100, 1, 500)?,
            max_attempts: read("DOMAIN_EVENTS_MAX_ATTEMPTS", 5, 1, INT32_MAX)?,
            lease_ms: read("DOMAIN_EVENTS_LEASE_MS", 60_000, 5_000, INT32_MAX)?,
            execution_timeout_ms: read(
                "DOMAIN_EVENTS_EXECUTION_TIMEOUT_MS",
                120_000,
                1_000,
                INT32_MAX,
            )?,
            operation_timeout_ms: read(
                "DOMAIN_EVENTS_OPERATION_TIMEOUT_MS",
                60_000,
                poll_interval_ms + 1_000,
                INT32_MAX,
            )?,
            shutdown_grace_ms: read("DOMAIN_EVENTS_SHUTDOWN_GRACE_MS", 5_000, 100, INT32_MAX)?,
            restart_delay_ms: read("DOMAIN_EVENTS_RESTART_DELAY_MS", 1_000, 100, INT32_MAX)?,
            abort_grace_ms: 2_000,
        })
    }

    /// `drainDomainEvents`'s own bounds: batch 1 to 500.
    pub fn batch(&self) -> i64 {
        self.batch_size.clamp(1, 500)
    }

    /// At least one attempt.
    pub fn attempts(&self) -> i64 {
        self.max_attempts.max(1)
    }

    /// At least 5 s.
    pub fn lease(&self) -> i64 {
        self.lease_ms.max(5_000)
    }

    /// `leaseSafetyMs`: `max(500, floor(lease / 6))`. A handler whose lease was not renewed is
    /// stopped this long before the lease expires.
    pub fn lease_safety_ms(&self) -> i64 {
        (self.lease() / 6).max(500)
    }

    /// The heartbeat: `max(1000, floor(lease / 3))`.
    pub fn heartbeat(&self) -> Duration {
        millis((self.lease() / 3).max(1_000))
    }
}

/// A non-negative millisecond count as a duration.
pub(crate) fn millis(ms: i64) -> Duration {
    Duration::from_millis(u64::try_from(ms).unwrap_or(0))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn with(name: &'static str, value: &'static str) -> impl Fn(&str) -> Option<String> {
        move |key: &str| (key == name).then(|| value.to_owned())
    }

    #[test]
    fn reads_like_the_reference() {
        assert_eq!(
            ConsumerConfig::from_env(|_| None),
            Ok(ConsumerConfig::default())
        );
        let config = ConsumerConfig::from_env(with("DOMAIN_EVENTS_LEASE_MS", " 6000 "));
        assert_eq!(config.map(|c| c.lease_ms), Ok(6_000));
        for (name, value) in [
            ("DOMAIN_EVENTS_LEASE_MS", "4999"),
            ("DOMAIN_EVENTS_LEASE_MS", ""),
            ("DOMAIN_EVENTS_LEASE_MS", "6000.5"),
            ("DOMAIN_EVENTS_LEASE_MS", "2147483648"),
            ("DOMAIN_EVENTS_BATCH_SIZE", "501"),
            ("DOMAIN_EVENTS_BATCH_SIZE", "0"),
            ("DOMAIN_EVENTS_POLL_INTERVAL_MS", "249"),
            ("DOMAIN_EVENTS_MAX_ATTEMPTS", "abc"),
            ("DOMAIN_EVENTS_OPERATION_TIMEOUT_MS", "1999"),
        ] {
            assert_eq!(
                ConsumerConfig::from_env(with(name, value)),
                Err(ConfigError(name)),
                "{name}={value}"
            );
        }
        // The operation timeout's minimum follows the poll interval.
        let poll = |key: &str| match key {
            "DOMAIN_EVENTS_POLL_INTERVAL_MS" => Some("5000".to_owned()),
            "DOMAIN_EVENTS_OPERATION_TIMEOUT_MS" => Some("5999".to_owned()),
            _ => None,
        };
        assert_eq!(
            ConsumerConfig::from_env(poll),
            Err(ConfigError("DOMAIN_EVENTS_OPERATION_TIMEOUT_MS"))
        );
        let config = ConsumerConfig::default();
        assert_eq!(config.lease_safety_ms(), 10_000);
        assert_eq!(config.heartbeat(), Duration::from_secs(20));
        let short = ConsumerConfig {
            lease_ms: 5_000,
            ..config
        };
        assert_eq!(short.lease_safety_ms(), 833);
        assert_eq!(short.heartbeat(), Duration::from_millis(1_666));
    }
}
