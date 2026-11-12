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
    /// A value Rust built could not be written as JSON.
    #[error("JSON: {0}")]
    Json(#[from] serde_json::Error),
    /// A received payload (pub/sub message, queue item) is not the expected JSON. Carries a
    /// fixed category and a position only: serde's own message quotes the offending input.
    #[error(transparent)]
    Decode(#[from] DecodeError),
    /// A Lua script was refused before it was sent: it has a loop without an iteration bound,
    /// or a fenced transition does not read its fence (`MIGRATION.md` data rule 7).
    #[error("Lua script {name} refused: {reason}")]
    ScriptRefused {
        /// The script's name.
        name: &'static str,
        /// Which rule it breaks.
        reason: &'static str,
    },
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

/// What kind of decode failure ([`serde_json::error::Category`] without the input text).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DecodeCategory {
    /// Not syntactically valid JSON.
    Syntax,
    /// Valid JSON of the wrong shape (missing field, wrong type, ...).
    Data,
    /// The input ended inside a value.
    Eof,
    /// Reading failed (does not happen for in-memory input).
    Io,
}

impl DecodeCategory {
    /// A fixed lowercase name.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Syntax => "syntax",
            Self::Data => "data",
            Self::Eof => "eof",
            Self::Io => "io",
        }
    }
}

/// A received payload did not decode. Only the category and the position (1-based line and
/// column, 0 when unknown) are kept, never serde's message, which can quote payload text such
/// as a token (`invalid type: string "..."`).
#[derive(Clone, Copy, Debug, PartialEq, Eq, thiserror::Error)]
#[error("payload is not the expected JSON ({} error at line {line}, column {column})", .category.as_str())]
pub struct DecodeError {
    /// What went wrong.
    pub category: DecodeCategory,
    /// Line of the failure.
    pub line: usize,
    /// Column of the failure.
    pub column: usize,
}

impl From<&serde_json::Error> for DecodeError {
    fn from(error: &serde_json::Error) -> Self {
        use serde_json::error::Category;
        Self {
            category: match error.classify() {
                Category::Syntax => DecodeCategory::Syntax,
                Category::Data => DecodeCategory::Data,
                Category::Eof => DecodeCategory::Eof,
                Category::Io => DecodeCategory::Io,
            },
            line: error.line(),
            column: error.column(),
        }
    }
}

/// Decodes received JSON, keeping only a [`DecodeError`] on failure.
pub(crate) fn decode<'a, T: serde::Deserialize<'a>>(bytes: &'a [u8]) -> Result<T> {
    serde_json::from_slice(bytes).map_err(|error| DragonflyError::Decode((&error).into()))
}

/// Result alias for this module.
pub type Result<T, E = DragonflyError> = std::result::Result<T, E>;

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(Debug, serde::Deserialize)]
    #[allow(dead_code)]
    struct Shape {
        n: u64,
    }

    #[test]
    fn decode_errors_never_quote_the_payload() {
        for (payload, category) in [
            (&br#"{"n":"top-secret-token"}"#[..], DecodeCategory::Data),
            (&br#"{"n":1,"top-secret-token"#[..], DecodeCategory::Eof),
            (&br#"{"n":top-secret-token}"#[..], DecodeCategory::Syntax),
        ] {
            let error = decode::<Shape>(payload).unwrap_err();
            let text = error.to_string();
            assert!(!text.contains("top-secret"), "{text}");
            assert!(!format!("{error:?}").contains("top-secret"), "{error:?}");
            let DragonflyError::Decode(decode) = error else {
                panic!("expected a decode error, got {error:?}")
            };
            assert_eq!(decode.category, category);
            assert_eq!(decode.line, 1);
            assert!(decode.column > 0);
            assert!(text.contains(category.as_str()), "{text}");
        }
    }
}
