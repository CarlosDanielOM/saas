//! Errors. None of them carries a token, a refresh token, the client secret or an e-mail: store
//! failures keep the driver's message (no document values), refresh failures carry a category
//! ([`crate::RefreshFailureReason`]) and the HTTP status, never Twitch's text.

use dima_core::crypto::CipherError;

/// A store failure of the directory or the token pipeline.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum TwitchError {
    /// A MongoDB operation failed.
    #[error("MongoDB {op} failed: {message}")]
    Mongo {
        /// The operation (`find users`, `update users`...).
        op: &'static str,
        /// The driver's message.
        message: String,
    },
    /// A MongoDB operation did not finish within [`crate::Timings::store_deadline`].
    #[error("MongoDB {op} did not finish within its deadline")]
    MongoTimeout {
        /// The operation.
        op: &'static str,
    },
    /// A Dragonfly command failed (its response timeout included).
    #[error("Dragonfly {op} failed: {message}")]
    Cache {
        /// The operation.
        op: &'static str,
        /// The client's message.
        message: String,
    },
    /// A Dragonfly reply had an unexpected shape.
    #[error("Dragonfly {op} returned an unexpected reply")]
    Protocol {
        /// The operation.
        op: &'static str,
    },
    /// A stored credential could not be decrypted (`crypto.ts` throws for a malformed IV).
    #[error("a stored credential could not be decrypted: {0}")]
    Cipher(CipherError),
    /// A stored document could not be read (the path of the field, never its value).
    #[error("a stored user could not be read: {0}")]
    Decode(String),
    /// A prepared write was refused before it was sent.
    #[error("a write was refused: {0}")]
    Write(String),
    /// The process is shutting down.
    #[error("shutting down")]
    Shutdown,
    /// Too many refreshes or loads are running in this process.
    #[error("too many Twitch operations in flight")]
    Busy,
    /// The work stopped before it produced a result (aborted at shutdown).
    #[error("the operation was interrupted")]
    Interrupted,
    /// The caller's deadline passed first (the store is slow or unreachable; work already
    /// started, such as a hydration, goes on in the background).
    #[error("{op} did not finish within the caller's deadline")]
    Deadline {
        /// The operation.
        op: &'static str,
    },
}

impl TwitchError {
    pub(crate) fn mongo(op: &'static str, error: impl std::fmt::Display) -> Self {
        Self::Mongo {
            op,
            message: error.to_string(),
        }
    }

    pub(crate) fn cache(op: &'static str, error: impl std::fmt::Display) -> Self {
        Self::Cache {
            op,
            message: error.to_string(),
        }
    }
}

impl From<CipherError> for TwitchError {
    fn from(error: CipherError) -> Self {
        Self::Cipher(error)
    }
}
