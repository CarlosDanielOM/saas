//! Every store call of this crate runs under a deadline ([`bounded`]), and its failure is a
//! [`StoreError`] the caller can answer `5xx` to.
//!
//! The reference has no per-operation timeout (the Node driver waits for server selection, 30 s,
//! and then forever on the socket). The default here, [`DEFAULT_STORE_DEADLINE`], fires only on
//! a real hang. A call that times out may still have been applied by the server (a write's
//! outcome is then unknown): every write of this crate is idempotent under its unique index or
//! its compare-and-set filter, so the caller's retry (Twitch's or Polar's redelivery, the next
//! sweep) completes it without a second effect.

use dima_store::dragonfly::DragonflyError;
use std::future::{Future, IntoFuture};
use std::time::Duration;

/// Default bound on one MongoDB or Dragonfly call made by this crate: 10 seconds. Twitch gives a
/// webhook a few seconds before it counts a delivery as failed and retries it, so waiting longer
/// only delays the retry; a healthy MongoDB answers these indexed single-document operations in
/// milliseconds.
pub const DEFAULT_STORE_DEADLINE: Duration = Duration::from_secs(10);

/// A store call that did not complete.
#[derive(Debug, thiserror::Error)]
pub enum StoreError {
    /// The deadline passed. A write may still be applied by the server.
    #[error("{operation} did not complete within {deadline:?}")]
    Timeout {
        /// What was running.
        operation: &'static str,
        /// The deadline.
        deadline: Duration,
    },
    /// MongoDB failed.
    #[error("{operation} failed: {source}")]
    Mongo {
        /// What was running.
        operation: &'static str,
        /// The driver's error.
        #[source]
        source: mongodb::error::Error,
    },
    /// The write helpers refused the write (a field the schema does not know).
    #[error("{operation} was refused: {source}")]
    Write {
        /// What was running.
        operation: &'static str,
        /// The helpers' error.
        #[source]
        source: dima_store::mongo::write::WriteError,
    },
    /// Dragonfly failed.
    #[error("{operation} failed: {source}")]
    Dragonfly {
        /// What was running.
        operation: &'static str,
        /// The client's error.
        #[source]
        source: DragonflyError,
    },
}

impl StoreError {
    /// `true` when the server may have applied a write although the call failed.
    pub fn outcome_unknown(&self) -> bool {
        match self {
            Self::Timeout { .. } => true,
            Self::Mongo { source, .. } => !matches!(
                source.kind.as_ref(),
                mongodb::error::ErrorKind::Write(_) | mongodb::error::ErrorKind::Command(_)
            ),
            Self::Write { .. } => false,
            Self::Dragonfly { source, .. } => source.outcome_unknown(),
        }
    }
}

/// Runs a MongoDB call under `deadline`.
pub async fn bounded<T>(
    operation: &'static str,
    deadline: Duration,
    call: impl IntoFuture<Output = Result<T, mongodb::error::Error>>,
) -> Result<T, StoreError> {
    match tokio::time::timeout(deadline, call.into_future()).await {
        Ok(Ok(value)) => Ok(value),
        Ok(Err(source)) => Err(StoreError::Mongo { operation, source }),
        Err(_) => Err(StoreError::Timeout {
            operation,
            deadline,
        }),
    }
}

/// Runs a checked write ([`dima_store::mongo::write::Writes`]) under `deadline`.
pub async fn bounded_write<T>(
    operation: &'static str,
    deadline: Duration,
    call: impl Future<Output = Result<T, dima_store::mongo::write::WriteError>>,
) -> Result<T, StoreError> {
    match tokio::time::timeout(deadline, call).await {
        Ok(Ok(value)) => Ok(value),
        Ok(Err(dima_store::mongo::write::WriteError::Driver(source))) => {
            Err(StoreError::Mongo { operation, source })
        }
        Ok(Err(source)) => Err(StoreError::Write { operation, source }),
        Err(_) => Err(StoreError::Timeout {
            operation,
            deadline,
        }),
    }
}

/// Runs a Dragonfly call under `deadline` (the client also bounds each command by its own
/// response timeout).
pub async fn bounded_dragonfly<T>(
    operation: &'static str,
    deadline: Duration,
    call: impl Future<Output = Result<T, DragonflyError>>,
) -> Result<T, StoreError> {
    match tokio::time::timeout(deadline, call).await {
        Ok(Ok(value)) => Ok(value),
        Ok(Err(source)) => Err(StoreError::Dragonfly { operation, source }),
        Err(_) => Err(StoreError::Timeout {
            operation,
            deadline,
        }),
    }
}

/// The duplicate-key error inside a store error, if that is what it is.
pub fn duplicate_key(error: &StoreError) -> Option<dima_store::mongo::error::DuplicateKey> {
    match error {
        StoreError::Mongo { source, .. } => dima_store::mongo::error::duplicate_key(source),
        _ => None,
    }
}
