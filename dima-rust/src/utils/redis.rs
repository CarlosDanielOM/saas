//! Lazy, process-wide access to a native Redis/Dragonfly connection manager.
//!
//! [`get_redis_client`] reads `DRAGONFLY_HOST` and `DRAGONFLY_PORT` from the
//! process environment during initialization attempts. It does not load `.env`
//! files, and it does not read a URI, password, TLS, or database override.
//! Connections use plain TCP to database 0, matching the TypeScript
//! `getDragonflyClient` behavior that builds `redis://HOST:PORT`.
//!
//! The manager is stored in a static [`OnceCell`]. Use it within the
//! application's long-lived Tokio runtime and share it across tasks and
//! threads. Static storage does not keep the originating runtime alive; do not
//! reuse the manager after that runtime or its connection has been shut down.
//! Each call returns a cheap clone of [`ConnectionManager`], and every clone
//! shares the same multiplexed socket.
//!
//! Initialization is bounded to five seconds for the whole connect and `PING`
//! sequence. The driver's response timeout is unset because redis-rs 1.7.1
//! otherwise defaults to 500 ms per command, which would break the blocking
//! command semantics of the TypeScript client. The driver reconnects on its own
//! after a later socket loss, but a command that fails during the disconnect is
//! not replayed. Because the manager is multiplexed, blocking commands and
//! Pub/Sub must use separate dedicated connections when they are added.
//!
//! This utility adds no telemetry wrapper and performs no cache operation
//! beyond the readiness `PING`.

use redis::{
    Client, ConnectionAddr, ErrorKind, RedisError, RedisResult,
    aio::{ConnectionManager, ConnectionManagerConfig},
};
use std::{
    env, io,
    net::{Ipv4Addr, Ipv6Addr},
    time::Duration,
};
use tokio::sync::OnceCell;

const HOST_ENV: &str = "DRAGONFLY_HOST";
const PORT_ENV: &str = "DRAGONFLY_PORT";

const INIT_TIMEOUT: Duration = Duration::from_secs(5);
const MAX_HOST_LEN: usize = 253;

const MISSING_HOST_MESSAGE: &str = concat!(
    "DRAGONFLY_HOST is not set; set it to the Dragonfly hostname or IP address ",
    "before calling get_redis_client"
);
const NON_UNICODE_HOST_MESSAGE: &str =
    "DRAGONFLY_HOST is not valid UTF-8; set it to a UTF-8 hostname or IP address";
const BLANK_HOST_MESSAGE: &str =
    "DRAGONFLY_HOST is blank; set it to a non-empty hostname or IP address";
const INVALID_HOST_MESSAGE: &str = concat!(
    "DRAGONFLY_HOST is not a usable host; set it to a bare hostname, IPv4, or IPv6 ",
    "address without a scheme, credentials, port, path, or query. ",
    "The raw value is omitted from this error"
);
const MISSING_PORT_MESSAGE: &str = concat!(
    "DRAGONFLY_PORT is not set; set it to the Dragonfly TCP port before calling ",
    "get_redis_client"
);
const NON_UNICODE_PORT_MESSAGE: &str =
    "DRAGONFLY_PORT is not valid UTF-8; set it to a decimal TCP port";
const BLANK_PORT_MESSAGE: &str = "DRAGONFLY_PORT is blank; set it to a decimal TCP port";
const INVALID_PORT_MESSAGE: &str = concat!(
    "DRAGONFLY_PORT is not a usable TCP port; set it to an integer from 1 to 65535. ",
    "The raw value is omitted from this error"
);
const INIT_TIMEOUT_MESSAGE: &str = concat!(
    "Dragonfly connection initialization did not finish within 5 seconds; ",
    "check that DRAGONFLY_HOST and DRAGONFLY_PORT point to a reachable ",
    "Dragonfly or Redis server"
);

static CLIENT: OnceCell<ConnectionManager> = OnceCell::const_new();

/// Returns a process-wide Redis/Dragonfly connection manager, creating and
/// verifying it on first success.
///
/// Initialization reads `DRAGONFLY_HOST` and `DRAGONFLY_PORT`, builds the
/// connection address directly (never by interpolating a URI), opens a native
/// [`Client`], establishes a [`ConnectionManager`] with the response timeout
/// disabled, and sends `PING` before caching the manager. The whole connect and
/// `PING` sequence is bounded to five seconds and reports
/// [`RedisError::is_timeout`] when the bound is reached. Native connection
/// errors are returned unchanged.
///
/// Use the cached manager within the application's long-lived Tokio runtime and
/// share it across tasks and threads. Static storage does not keep the
/// originating runtime alive; do not reuse the manager after that runtime or
/// its connection has been shut down. Clone the returned handle for an owned
/// value; clones share the same multiplexed socket.
///
/// The environment is read only while initializing, so changing
/// `DRAGONFLY_HOST` or `DRAGONFLY_PORT` after the first success has no effect.
/// Missing, non-UTF-8, blank, or malformed values fail with static actionable
/// errors that do not repeat the raw input. A failed or cancelled initialization
/// does not poison the cell: a later call retries with the current environment.
/// The driver reconnects after a later socket loss, but a command that fails
/// during the disconnect is not replayed.
pub async fn get_redis_client() -> RedisResult<ConnectionManager> {
    CLIENT
        .get_or_try_init(|| async {
            // Only compiled when another feature adds a second rustls provider.
            #[cfg(any(
                feature = "email",
                feature = "posthog",
                feature = "s3",
                feature = "otel"
            ))]
            crate::utils::install_default_tls_provider();

            let host = read_host()?;
            let port = read_port()?;

            // Build a structured address so host and port values cannot inject
            // credentials, a scheme, a database index, or query options.
            let client = Client::open(ConnectionAddr::Tcp(host, port))?;

            // redis-rs 1.7.1 defaults to a 500 ms response timeout, which would
            // abort blocking commands sooner than the TypeScript client did.
            let config = ConnectionManagerConfig::new().set_response_timeout(None);

            tokio::time::timeout(INIT_TIMEOUT, async {
                let mut manager = client.get_connection_manager_with_config(config).await?;

                // A connection manager does not prove the deployment is
                // reachable and responsive until a command round trip succeeds.
                let _: String = redis::cmd("PING").query_async(&mut manager).await?;

                Ok::<ConnectionManager, RedisError>(manager)
            })
            .await
            .map_err(|_| init_timeout_error())?
        })
        .await
        .cloned()
}

fn read_host() -> RedisResult<String> {
    validate_host(env::var(HOST_ENV))
}

fn read_port() -> RedisResult<u16> {
    validate_port(env::var(PORT_ENV))
}

fn validate_host(raw: std::result::Result<String, env::VarError>) -> RedisResult<String> {
    match raw {
        Ok(value) => {
            if value.trim().is_empty() {
                return Err(config_error(BLANK_HOST_MESSAGE));
            }
            normalize_host(&value).ok_or_else(|| config_error(INVALID_HOST_MESSAGE))
        }
        Err(env::VarError::NotPresent) => Err(config_error(MISSING_HOST_MESSAGE)),
        Err(env::VarError::NotUnicode(_)) => Err(config_error(NON_UNICODE_HOST_MESSAGE)),
    }
}

fn validate_port(raw: std::result::Result<String, env::VarError>) -> RedisResult<u16> {
    match raw {
        Ok(value) => {
            let trimmed = value.trim();
            if trimmed.is_empty() {
                return Err(config_error(BLANK_PORT_MESSAGE));
            }
            if !trimmed.bytes().all(|byte| byte.is_ascii_digit()) {
                return Err(config_error(INVALID_PORT_MESSAGE));
            }
            match trimmed.parse::<u16>() {
                Ok(port) if port != 0 => Ok(port),
                _ => Err(config_error(INVALID_PORT_MESSAGE)),
            }
        }
        Err(env::VarError::NotPresent) => Err(config_error(MISSING_PORT_MESSAGE)),
        Err(env::VarError::NotUnicode(_)) => Err(config_error(NON_UNICODE_PORT_MESSAGE)),
    }
}

/// Returns a bare host suitable for [`ConnectionAddr::Tcp`], or `None` for input
/// that could change connection semantics.
///
/// Accepted forms are DNS hostnames, IPv4 addresses, raw IPv6 addresses, and
/// bracketed IPv6 addresses (the brackets are removed because the driver
/// resolves the bare address). URLs, credentials, ports, paths, queries, and
/// other delimiters are rejected rather than reinterpreted.
fn normalize_host(raw: &str) -> Option<String> {
    let host = raw.trim();
    if host.is_empty() || host.len() > MAX_HOST_LEN {
        return None;
    }

    if let Some(inner) = host.strip_prefix('[') {
        let inner = inner.strip_suffix(']')?;
        if inner.parse::<Ipv6Addr>().is_err() {
            return None;
        }
        return Some(inner.to_owned());
    }

    if host.contains(':') {
        return host.parse::<Ipv6Addr>().ok().map(|_| host.to_owned());
    }

    if host.parse::<Ipv4Addr>().is_ok() {
        return Some(host.to_owned());
    }

    // Numeric dotted hosts that are not valid IPv4 must not fall through to
    // resolver-specific parsing such as octal or shorthand addresses.
    if host
        .bytes()
        .all(|byte| byte.is_ascii_digit() || byte == b'.')
    {
        return None;
    }

    validate_dns_name(host).then(|| host.to_owned())
}

fn validate_dns_name(host: &str) -> bool {
    if !host.is_ascii() {
        return false;
    }

    let name = host.strip_suffix('.').unwrap_or(host);
    if name.is_empty() {
        return false;
    }

    name.split('.').all(|label| {
        !label.is_empty()
            && label.len() <= 63
            && label
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
            && !label.starts_with('-')
            && !label.ends_with('-')
    })
}

fn config_error(message: &'static str) -> RedisError {
    RedisError::from((ErrorKind::InvalidClientConfig, message))
}

fn init_timeout_error() -> RedisError {
    // A native I/O timeout keeps `is_timeout()` meaningful for callers.
    RedisError::from(io::Error::new(
        io::ErrorKind::TimedOut,
        INIT_TIMEOUT_MESSAGE,
    ))
}

#[cfg(test)]
mod tests {
    use std::ffi::OsString;

    use super::*;

    #[test]
    fn init_timeout_is_reported_as_a_native_timeout() {
        let error = init_timeout_error();

        assert!(error.is_timeout(), "unexpected error: {error}");
        assert!(
            error.to_string().contains(INIT_TIMEOUT_MESSAGE),
            "unexpected error: {error}"
        );
    }

    #[test]
    fn missing_host_is_rejected_with_a_static_message() {
        let error = validate_host(Err(env::VarError::NotPresent))
            .expect_err("a missing DRAGONFLY_HOST must be rejected");

        assert!(error.to_string().contains(MISSING_HOST_MESSAGE));
    }

    #[test]
    fn non_unicode_host_is_rejected_with_a_static_message() {
        let error = validate_host(Err(env::VarError::NotUnicode(OsString::from(
            "dragonfly.local",
        ))))
        .expect_err("a non-UTF-8 DRAGONFLY_HOST must be rejected");

        assert!(error.to_string().contains(NON_UNICODE_HOST_MESSAGE));
    }

    #[test]
    fn blank_host_is_rejected_with_a_static_message() {
        let error = validate_host(Ok(" \t\n".to_owned()))
            .expect_err("a blank DRAGONFLY_HOST must be rejected");

        assert!(error.to_string().contains(BLANK_HOST_MESSAGE));
    }

    #[test]
    fn accepted_hosts_are_normalized_without_reinterpreting_them() {
        for host in [
            "dragonfly",
            "dragonfly.internal.example",
            "cache_1.example",
            "127.0.0.1",
            "::1",
            "2001:db8::10",
        ] {
            let accepted = validate_host(Ok(host.to_owned()))
                .unwrap_or_else(|error| panic!("{host:?} must be accepted: {error}"));
            assert_eq!(accepted, host);
        }

        for (bracketed, expected) in [("[::1]", "::1"), ("[2001:db8::10]", "2001:db8::10")] {
            assert_eq!(
                validate_host(Ok(bracketed.to_owned()))
                    .unwrap_or_else(|error| panic!("{bracketed:?} must be accepted: {error}")),
                expected
            );
        }

        assert_eq!(
            validate_host(Ok("  dragonfly.local  ".to_owned()))
                .expect("surrounding whitespace must be trimmed"),
            "dragonfly.local"
        );
    }

    #[test]
    fn malformed_hosts_are_rejected_without_echoing_their_value() {
        for host in [
            "redis://dragonfly:6379",
            "dragonfly:6379",
            "user:pass@dragonfly",
            "dragonfly/path",
            "dragonfly?db=1",
            "dragonfly#fragment",
            "[::1",
            "[]",
            "[not-an-ipv6]",
            "",
            "   ",
            ".",
            "-dragonfly",
            "dragonfly-",
            "dragonfly..local",
            "dragon fly",
            "dragonfly\\local",
            "127.0.0.01",
            "999.1.1.1",
            "dragonfly\u{0}",
            "dragonfly.example/../other",
        ] {
            let error = validate_host(Ok(host.to_owned()))
                .expect_err("malformed DRAGONFLY_HOST must be rejected");
            let rendered = error.to_string();

            assert!(rendered.contains("DRAGONFLY_HOST is"), "{rendered}");
            if host.len() >= 4 {
                assert!(!rendered.contains(host), "raw host leaked: {rendered}");
            }
        }
    }

    #[test]
    fn missing_port_is_rejected_with_a_static_message() {
        let error = validate_port(Err(env::VarError::NotPresent))
            .expect_err("a missing DRAGONFLY_PORT must be rejected");

        assert!(error.to_string().contains(MISSING_PORT_MESSAGE));
    }

    #[test]
    fn non_unicode_port_is_rejected_with_a_static_message() {
        let error = validate_port(Err(env::VarError::NotUnicode(OsString::from("6379"))))
            .expect_err("a non-UTF-8 DRAGONFLY_PORT must be rejected");

        assert!(error.to_string().contains(NON_UNICODE_PORT_MESSAGE));
    }

    #[test]
    fn blank_port_is_rejected_with_a_static_message() {
        let error = validate_port(Ok(" \t".to_owned()))
            .expect_err("a blank DRAGONFLY_PORT must be rejected");

        assert!(error.to_string().contains(BLANK_PORT_MESSAGE));
    }

    #[test]
    fn valid_ports_are_accepted() {
        assert_eq!(validate_port(Ok("6379".to_owned())).expect("6379"), 6379);
        assert_eq!(validate_port(Ok("1".to_owned())).expect("1"), 1);
        assert_eq!(validate_port(Ok("65535".to_owned())).expect("65535"), 65535);
        assert_eq!(
            validate_port(Ok(" 6379 ".to_owned())).expect("trimmed 6379"),
            6379
        );
    }

    #[test]
    fn invalid_ports_are_rejected_without_echoing_their_value() {
        for port in [
            "0", "65536", "-1", "+6379", "63_79", "6379.0", "abc", "6379abc",
        ] {
            let error = validate_port(Ok(port.to_owned()))
                .expect_err("invalid DRAGONFLY_PORT must be rejected");
            let rendered = error.to_string();

            assert!(rendered.contains(INVALID_PORT_MESSAGE), "{rendered}");
            assert!(!rendered.contains(port), "raw port leaked: {rendered}");
        }
    }
}
