//! Where Dragonfly is and how long to wait for it.
//!
//! The reference (`dimabot/src/utils/databases/dragonfly.database.ts`) builds its address as the
//! template string `redis://${DRAGONFLY_HOST}:${DRAGONFLY_PORT}` and lets the client parse it.
//! [`DragonflyConfig::url`] keeps that exact property: the two values are concatenated, then
//! parsed, so a port value carrying a path such as `6379/1` selects logical database 1 (the test
//! rig relies on that), and a missing value becomes the text `undefined`, as in JavaScript.
//!
//! The reference uses no username, password or TLS and speaks RESP2. A parsed address that would
//! add any of those (for example `?protocol=resp3` smuggled into the port) is refused, so the
//! reply types stay the ones the ledger documents.

use super::error::{DragonflyError, Result};
use redis::{ConnectionAddr, ProtocolVersion};
use std::time::Duration;

/// Default bound on one ordinary command: 5 seconds.
///
/// The reference has no command timeout (node-redis 5 waits forever), so by charter rule 6 this is
/// a generous bound that only fires on a real hang: Dragonfly answers ordinary commands in well
/// under a millisecond, and the slowest legitimate calls in the reference (`KEYS` over the whole
/// key space, the larger Lua scripts) stay in the low hundreds of milliseconds. Five seconds is an
/// order of magnitude above that, equals node-redis's own connect timeout, and is far below every
/// worker lock in the reference (the shortest, `worker:follow-defense:lock`, is at least 30 s), so
/// in a single-process cron one hung call fails its worker instead of stalling the others until a
/// lease runs out. It never applies to blocking commands or subscriptions, which have their own
/// connections without a response timeout.
pub const DEFAULT_RESPONSE_TIMEOUT: Duration = Duration::from_secs(5);

/// Default bound on opening a connection: 5 seconds, node-redis 5's `socket.connectTimeout` default.
pub const DEFAULT_CONNECT_TIMEOUT: Duration = Duration::from_secs(5);

/// Default number of reconnection attempts per outage before the pending commands fail (the
/// next command starts a new round). Delays grow from 100 ms, doubling, with jitter.
pub const DEFAULT_RECONNECT_RETRIES: usize = 6;

/// Default bound on undelivered messages per subscription (see [`super::pubsub`]).
pub const DEFAULT_SUBSCRIPTION_BUFFER: usize = 1024;

/// Connection settings, read once at startup by the binary from `DRAGONFLY_HOST` and
/// `DRAGONFLY_PORT` and passed in (this crate never reads the environment).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DragonflyConfig {
    /// `DRAGONFLY_HOST` exactly as set (`undefined` when unset, as the template string writes it).
    pub host: String,
    /// `DRAGONFLY_PORT` exactly as set; may carry a database path such as `6379/1`.
    pub port: String,
    /// Label for connection-error reports: the reference's `caller` argument of
    /// `getDragonflyClient`.
    pub caller: String,
    /// Bound on one ordinary command; see [`DEFAULT_RESPONSE_TIMEOUT`].
    pub response_timeout: Duration,
    /// Bound on opening one connection; see [`DEFAULT_CONNECT_TIMEOUT`].
    pub connect_timeout: Duration,
    /// Reconnection attempts per outage; see [`DEFAULT_RECONNECT_RETRIES`].
    pub reconnect_retries: usize,
    /// Messages buffered per subscription before new ones are dropped and counted.
    pub subscription_buffer: usize,
}

impl DragonflyConfig {
    /// Settings from the two environment values as the reference reads them: an unset value is
    /// the text `undefined`, everything else is kept verbatim (no trimming, no validation here).
    pub fn from_env_values(host: Option<&str>, port: Option<&str>, caller: &str) -> Self {
        Self {
            host: host.unwrap_or("undefined").to_owned(),
            port: port.unwrap_or("undefined").to_owned(),
            caller: caller.to_owned(),
            response_timeout: DEFAULT_RESPONSE_TIMEOUT,
            connect_timeout: DEFAULT_CONNECT_TIMEOUT,
            reconnect_retries: DEFAULT_RECONNECT_RETRIES,
            subscription_buffer: DEFAULT_SUBSCRIPTION_BUFFER,
        }
    }

    /// `redis://` + host + `:` + port, the reference's address string, before parsing.
    pub fn url(&self) -> String {
        format!("redis://{}:{}", self.host, self.port)
    }

    /// The parsed address. Fails when the string does not parse, or when parsing produced
    /// something the reference never uses: credentials, TLS, a Unix socket or RESP3.
    pub fn client(&self) -> Result<redis::Client> {
        let client = redis::Client::open(self.url().as_str())
            .map_err(|_| DragonflyError::Config("the address redis://HOST:PORT does not parse"))?;
        let info = client.get_connection_info();
        if !matches!(info.addr(), ConnectionAddr::Tcp(_, _)) {
            return Err(DragonflyError::Config(
                "only plain TCP addresses are supported",
            ));
        }
        let settings = info.redis_settings();
        if settings.username().is_some() || settings.password().is_some() {
            return Err(DragonflyError::Config("credentials are not supported"));
        }
        if settings.protocol() != ProtocolVersion::RESP2 {
            return Err(DragonflyError::Config("only RESP2 is supported"));
        }
        Ok(client)
    }

    /// The logical database the address selects (0 unless the port carries a path).
    pub fn database(&self) -> Result<i64> {
        Ok(self.client()?.get_connection_info().redis_settings().db())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn address_is_the_template_string_then_parsed() {
        let config = DragonflyConfig::from_env_values(Some("127.0.0.1"), Some("6379"), "test");
        assert_eq!(config.url(), "redis://127.0.0.1:6379");
        assert_eq!(config.database().unwrap(), 0);
        let rig = DragonflyConfig::from_env_values(Some("dragonfly"), Some("6379/1"), "test");
        assert_eq!(rig.url(), "redis://dragonfly:6379/1");
        assert_eq!(rig.database().unwrap(), 1);
        match rig.client().unwrap().get_connection_info().addr() {
            ConnectionAddr::Tcp(host, port) => {
                assert_eq!((host.as_str(), *port), ("dragonfly", 6379))
            }
            other => panic!("unexpected address {other:?}"),
        }
    }

    #[test]
    fn unset_values_are_the_text_undefined() {
        let config = DragonflyConfig::from_env_values(None, None, "test");
        assert_eq!(config.url(), "redis://undefined:undefined");
        assert!(config.client().is_err());
        let host_only = DragonflyConfig::from_env_values(None, Some("6379"), "test");
        assert_eq!(host_only.url(), "redis://undefined:6379");
    }

    #[test]
    fn options_the_reference_never_uses_are_refused() {
        for (host, port) in [
            ("user:secret@dragonfly", "6379"),
            ("dragonfly", "6379?protocol=resp3"),
            ("dragonfly", "6379/0?protocol=3"),
        ] {
            let config = DragonflyConfig::from_env_values(Some(host), Some(port), "test");
            let error = config.client().map(|_| ()).unwrap_err();
            assert!(!error.to_string().contains("secret"), "{error}");
        }
    }
}
