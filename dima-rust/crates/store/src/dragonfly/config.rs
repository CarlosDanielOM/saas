//! Where Dragonfly is and how long to wait for it.
//!
//! The reference (`dimabot/src/utils/databases/dragonfly.database.ts`) builds its address as the
//! template string `redis://${DRAGONFLY_HOST}:${DRAGONFLY_PORT}` and lets the client parse it.
//! [`DragonflyConfig::url`] keeps that exact property: the two values are concatenated, then
//! parsed, so a port value carrying a path such as `6379/1` selects logical database 1 (the test
//! rig relies on that), and a missing value becomes the text `undefined`, as in JavaScript.
//!
//! # Credentials
//!
//! The reference's client library accepts a user name and password inside that address
//! (`DRAGONFLY_HOST=user:pass@dragonfly`, or `:pass@dragonfly` for a password alone), so this one
//! does too, on every connection: the command handle and the blocking connections authenticate
//! through the driver, and the subscriber sends `AUTH` itself before anything else, inside its
//! connect deadline. A refused `AUTH` is a configuration error: the connection attempt fails (the
//! subscriber reports it once and keeps retrying with its back-off, so rotated credentials are
//! picked up without a restart). Credentials never appear in `Debug`, errors or reports:
//! [`DragonflyConfig`]'s `Debug` prints [`DragonflyConfig::redacted_url`]. [`DragonflyConfig::url`]
//! returns them, so never log it.
//!
//! Pub/sub ignores the logical database (channels are server-wide), so the subscriber sends no
//! `SELECT`; the command handle and the blocking connections select the database the port's path
//! names.
//!
//! TLS, Unix sockets and RESP3 are not used by the reference: a parsed address that would add any
//! of those (for example `?protocol=resp3` smuggled into the port) is refused, so the reply types
//! stay the ones the ledger documents.

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

/// Default cap on the topics (channels and patterns) of one subscriber: 10 000.
///
/// The reference has no cap. The bot subscribes once per joined channel (clip requests,
/// `twitch:{id}:clip:request`) plus a few global channels, so the cap sits far above any
/// channel count one process serves while still bounding a subscriber's memory to
/// `max_subscriptions × (subscription_buffer + 1)` events.
pub const DEFAULT_MAX_SUBSCRIPTIONS: usize = 10_000;

/// Default limit on one received pub/sub message (payload, channel or pattern): 1 MiB.
///
/// The reference has none (node-redis buffers whatever arrives). The largest payloads it
/// publishes are a few kilobytes (a chat message with its emotes on `widget-feed`, a clip
/// request); a message over the limit discards the connection (see [`super::pubsub`]).
pub const DEFAULT_SUBSCRIPTION_MAX_MESSAGE_BYTES: usize = 1024 * 1024;

/// Default interval of silence after which a subscriber connection is sent `PING`: 30 seconds.
///
/// The reference sets no `pingInterval` (node-redis 5 then never pings), so a subscriber whose
/// peer stopped answering without closing would wait for ever. By charter rule 6 this is a
/// generous bound that only fires on a real hang: the reply must come within
/// [`DragonflyConfig::response_timeout`], else the connection is replaced.
pub const DEFAULT_SUBSCRIBER_PING_INTERVAL: Duration = Duration::from_secs(30);

/// Connection settings, read once at startup by the binary from `DRAGONFLY_HOST` and
/// `DRAGONFLY_PORT` and passed in (this crate never reads the environment).
///
/// `Debug` shows the address without its credentials ([`Self::redacted_url`]).
#[derive(Clone, PartialEq, Eq)]
pub struct DragonflyConfig {
    /// `DRAGONFLY_HOST` exactly as set (`undefined` when unset, as the template string writes it).
    /// May carry credentials (`user:pass@host`); see the module docs.
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
    /// Messages buffered per subscription before its overflow policy applies.
    pub subscription_buffer: usize,
    /// Silence on a subscriber connection before it is sent `PING`; see
    /// [`DEFAULT_SUBSCRIBER_PING_INTERVAL`].
    pub subscriber_ping_interval: Duration,
    /// Topics one subscriber may hold; see [`DEFAULT_MAX_SUBSCRIPTIONS`].
    pub max_subscriptions: usize,
    /// Largest received message, channel or pattern; see
    /// [`DEFAULT_SUBSCRIPTION_MAX_MESSAGE_BYTES`].
    pub subscription_max_message_bytes: usize,
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
            subscriber_ping_interval: DEFAULT_SUBSCRIBER_PING_INTERVAL,
            max_subscriptions: DEFAULT_MAX_SUBSCRIPTIONS,
            subscription_max_message_bytes: DEFAULT_SUBSCRIPTION_MAX_MESSAGE_BYTES,
        }
    }

    /// `redis://` + host + `:` + port, the reference's address string, before parsing. It
    /// contains the credentials when the host carries them: never log it (use
    /// [`Self::redacted_url`]).
    pub fn url(&self) -> String {
        format!("redis://{}:{}", self.host, self.port)
    }

    /// [`Self::url`] without anything before the last `@` of its authority (the user name and
    /// password), for diagnostics.
    pub fn redacted_url(&self) -> String {
        let url = self.url();
        let rest = url.strip_prefix("redis://").unwrap_or(&url);
        let authority_end = rest.find(['/', '?', '#']).unwrap_or(rest.len());
        let (authority, tail) = rest.split_at(authority_end);
        match authority.rsplit_once('@') {
            Some((_, host)) => format!("redis://***@{host}{tail}"),
            None => url,
        }
    }

    /// The parsed address. Fails when the string does not parse, or when parsing produced
    /// something the reference never uses: TLS, a Unix socket or RESP3. Credentials are
    /// accepted (see the module docs).
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
        if settings.protocol() != ProtocolVersion::RESP2 {
            return Err(DragonflyError::Config("only RESP2 is supported"));
        }
        Ok(client)
    }

    /// `true` when the address carries a password (with or without a user name).
    pub fn has_credentials(&self) -> bool {
        self.client().is_ok_and(|client| {
            client
                .get_connection_info()
                .redis_settings()
                .password()
                .is_some()
        })
    }

    /// The logical database the address selects (0 unless the port carries a path).
    pub fn database(&self) -> Result<i64> {
        Ok(self.client()?.get_connection_info().redis_settings().db())
    }
}

impl std::fmt::Debug for DragonflyConfig {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("DragonflyConfig")
            .field("address", &self.redacted_url())
            .field("caller", &self.caller)
            .field("response_timeout", &self.response_timeout)
            .field("connect_timeout", &self.connect_timeout)
            .field("reconnect_retries", &self.reconnect_retries)
            .field("subscription_buffer", &self.subscription_buffer)
            .field("subscriber_ping_interval", &self.subscriber_ping_interval)
            .field("max_subscriptions", &self.max_subscriptions)
            .field(
                "subscription_max_message_bytes",
                &self.subscription_max_message_bytes,
            )
            .finish()
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
    fn credentials_are_accepted_and_never_shown() {
        for (host, port, user, db) in [
            ("user:secret@dragonfly", "6379", Some("user"), 0),
            (":secret@dragonfly", "6379/2", None, 2),
            ("us%40er:sec%40ret@dragonfly", "6379", Some("us@er"), 0),
        ] {
            let config = DragonflyConfig::from_env_values(Some(host), Some(port), "test");
            let client = config.client().unwrap();
            let info = client.get_connection_info();
            let settings = info.redis_settings();
            assert_eq!(settings.username(), user);
            assert!(settings.password().is_some_and(|p| p.starts_with("sec")));
            assert_eq!(settings.db(), db);
            match info.addr() {
                ConnectionAddr::Tcp(host, port) => {
                    assert_eq!((host.as_str(), *port), ("dragonfly", 6379))
                }
                other => panic!("unexpected address {other:?}"),
            }
            let shown = format!("{config:?}");
            assert!(!shown.contains("sec"), "{shown}");
            assert!(shown.contains("redis://***@dragonfly:6379"), "{shown}");
            assert!(!config.redacted_url().contains("sec"));
        }
        let plain = DragonflyConfig::from_env_values(Some("dragonfly"), Some("6379/1"), "test");
        assert_eq!(plain.redacted_url(), "redis://dragonfly:6379/1");
    }

    #[test]
    fn options_the_reference_never_uses_are_refused() {
        for (host, port) in [
            ("user:secret@dragonfly", "6379?protocol=resp3"),
            ("dragonfly", "6379?protocol=resp3"),
            ("dragonfly", "6379/0?protocol=3"),
        ] {
            let config = DragonflyConfig::from_env_values(Some(host), Some(port), "test");
            let error = config.client().map(|_| ()).unwrap_err();
            assert!(!error.to_string().contains("secret"), "{error}");
        }
    }
}
