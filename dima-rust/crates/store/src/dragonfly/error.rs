//! Errors of the Dragonfly layer.

use redis::RedisError;

/// An error from [`crate::dragonfly`].
///
/// Messages never contain values, keys or payloads: a queue item or a cached account can hold
/// credentials. The underlying driver error is kept where there is one.
#[derive(Debug, thiserror::Error)]
pub enum DragonflyError {
    /// The configuration cannot be used (for example `DRAGONFLY_PORT` is not a port).
    #[error("Dragonfly configuration: {0}")]
    Config(&'static str),
    /// The driver failed: connection, timeout or a server error reply. The original error is kept.
    #[error(transparent)]
    Redis(#[from] RedisError),
    /// A blocking command passed its client-side deadline (its server timeout plus a grace period)
    /// without a reply. The connection was closed, so the server stops waiting too.
    #[error("Dragonfly blocking command got no reply within its deadline")]
    BlockingDeadline,
    /// The reply did not have the shape the command or script always returns.
    #[error("unexpected Dragonfly reply: {0}")]
    Reply(&'static str),
    /// A reply that must be text was not UTF-8.
    #[error("Dragonfly reply is not UTF-8 text")]
    NotUtf8,
    /// A value could not be written as JSON (or a received payload could not be read as JSON).
    #[error("JSON: {0}")]
    Json(#[from] serde_json::Error),
    /// The subscriber task has stopped (it was shut down or its owner dropped it).
    #[error("Dragonfly subscriber has stopped")]
    SubscriberClosed,
}

impl DragonflyError {
    /// `true` when the command may have reached the server but its reply was lost (timeout,
    /// dropped connection). A write's outcome is then unknown: reconcile, do not blindly retry.
    pub fn outcome_unknown(&self) -> bool {
        match self {
            Self::Redis(error) => {
                error.is_timeout() || error.is_connection_dropped() || error.is_io_error()
            }
            Self::BlockingDeadline => true,
            _ => false,
        }
    }

    /// `true` when the driver gave up waiting for the reply ([`super::DragonflyConfig::response_timeout`]).
    pub fn is_timeout(&self) -> bool {
        matches!(self, Self::Redis(error) if error.is_timeout())
    }

    /// `true` for a server error reply with this code (`NOSCRIPT`, `WRONGTYPE`, `ERR`, ...).
    pub fn is_server_code(&self, code: &str) -> bool {
        matches!(self, Self::Redis(error) if error.code() == Some(code))
    }
}

/// Result alias for this module.
pub type Result<T, E = DragonflyError> = std::result::Result<T, E>;
