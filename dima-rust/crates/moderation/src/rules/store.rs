//! The store handles the rules' state uses (offenses, permits, first-message markers, the spam
//! review budget), with the clock injected and a deadline on every call.
//!
//! Dragonfly calls are bounded by the client's own response timeout
//! (`DragonflyConfig::response_timeout`); MongoDB calls by [`RulesConfig::mongo_deadline`]. The
//! reference sets neither (node-redis and Mongoose wait), so a failed call here is a moderation
//! infrastructure error, which the handler treats as the reference does: logged, message let
//! through.

use std::future::IntoFuture;
use std::sync::Arc;
use std::time::Duration;

use dima_core::Clock;
use dima_store::dragonfly::{Dragonfly, DragonflyError};
use dima_store::mongo::MongoStore;

/// Typed configuration (the crate never reads the environment).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RulesConfig {
    /// The longest a MongoDB call may take. The reference has none; 10 s only fires on a hang.
    pub mongo_deadline: Duration,
}

impl Default for RulesConfig {
    fn default() -> Self {
        Self {
            mongo_deadline: Duration::from_secs(10),
        }
    }
}

/// The handles, opened once by the binary.
#[derive(Debug, Clone)]
pub struct RulesStore {
    /// Dragonfly (the Rust processes' logical database).
    pub dragonfly: Dragonfly,
    /// MongoDB.
    pub mongo: MongoStore,
    /// Put before every Dragonfly key: empty in production; tests give each run its own.
    pub key_prefix: String,
    /// `Date.now()`.
    pub clock: Arc<dyn Clock>,
    /// Deadlines.
    pub config: RulesConfig,
}

/// A store call failed.
#[derive(Debug, thiserror::Error)]
pub enum StoreError {
    /// Dragonfly refused, failed or timed out.
    #[error(transparent)]
    Dragonfly(#[from] DragonflyError),
    /// MongoDB, or the model's preparation of a write, failed.
    #[error("{operation}: {message}")]
    Mongo {
        /// The operation.
        operation: &'static str,
        /// The error text (never a document).
        message: String,
    },
    /// A MongoDB call ran past [`RulesConfig::mongo_deadline`].
    #[error("{0} ran past its deadline")]
    Deadline(&'static str),
    /// A reply had an unexpected shape.
    #[error("unexpected reply from {0}")]
    Reply(&'static str),
}

impl RulesStore {
    /// `prefix + key`.
    pub(crate) fn key(&self, key: &str) -> String {
        format!("{}{key}", self.key_prefix)
    }

    /// Runs a MongoDB call under the deadline.
    pub(crate) async fn mongo_call<T, E: std::fmt::Display>(
        &self,
        operation: &'static str,
        call: impl IntoFuture<Output = Result<T, E>>,
    ) -> Result<T, StoreError> {
        match tokio::time::timeout(self.config.mongo_deadline, call.into_future()).await {
            Ok(Ok(value)) => Ok(value),
            Ok(Err(error)) => Err(StoreError::Mongo {
                operation,
                message: error.to_string(),
            }),
            Err(_) => Err(StoreError::Deadline(operation)),
        }
    }
}
