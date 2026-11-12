//! The command runtime: what the bot, the API and the cron call around a chat command, against
//! the stores (`dima-rust/ledger/upper-layers.md`, package P4-CMD-RUNTIME).
//!
//! - [`lookup`]: the command a chat message names, through a per-channel Dragonfly snapshot
//!   that every process shares, and the write protocol that keeps it current
//!   (`classes/command.class.ts`).
//! - [`availability`]: enabling and disabling commands and channel-point rewards now or for a
//!   while, the Twitch reward toggle, and the recovery the cron runs every 2 s
//!   (`utils/availability/service.ts`).
//! - [`chat_history`]: the recent chat list per channel (`classes/chat_history.ts`).
//! - [`channel_cache`]: the admin role cache load and the cache resets of a stream going online
//!   or offline (`utils/cache.ts`), and the Dragonfly [`crate::permissions::RoleCache`].
//! - [`speech`]: the end of a stream's speech session (`utils/speech.ts`).
//! - [`cooldown_map`]: the bot's per-process chat cooldowns (`classes/cooldown.class.ts`).
//! - [`keyword_store`]: the keyword cache's MongoDB and Dragonfly store
//!   ([`crate::keywords::KeywordStorage`]).
//! - [`user_level`], [`random_user`], [`ast_variables`], [`goal_error`]: small helpers of the
//!   command language's host.
//!
//! Everything takes its stores as [`Stores`] (handles opened once by the binary), its time from
//! a [`dima_core::Clock`] and its randomness from a [`dima_core::Random`]; nothing reads the
//! environment. Every MongoDB call runs under a deadline from the caller's configuration;
//! Dragonfly calls are bounded by the store's response timeout.
//!
//! Key families (`MIGRATION.md` section 3): everything here is *rebuilt* at the cutover. The
//! Rust processes keep these keys in their own logical database; [`KeyPrefix`] exists so tests
//! can share one.

use std::fmt;
use std::future::IntoFuture;
use std::time::Duration;

use dima_store::dragonfly::{Dragonfly, DragonflyError};
use dima_store::mongo::MongoStore;
use dima_store::mongo::write::WriteError;

pub mod ast_variables;
pub mod availability;
pub mod channel_cache;
pub mod chat_history;
pub mod cooldown_map;
pub mod goal_error;
pub mod keyword_store;
pub mod lookup;
pub mod random_user;
pub mod speech;
pub mod user_level;

/// A prefix put before every Dragonfly key this module builds. Empty in production; tests give
/// each run its own so they can share a logical database and clean up after themselves.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct KeyPrefix(String);

impl KeyPrefix {
    /// No prefix (production).
    pub fn none() -> Self {
        Self(String::new())
    }

    /// Every key starts with `prefix`.
    pub fn new(prefix: impl Into<String>) -> Self {
        Self(prefix.into())
    }

    /// The prefix.
    pub fn as_str(&self) -> &str {
        &self.0
    }

    /// `prefix + key`.
    pub fn key(&self, key: impl fmt::Display) -> String {
        format!("{}{key}", self.0)
    }
}

/// The store handles the runtime works on, opened once by the binary.
#[derive(Clone, Debug)]
pub struct Stores {
    /// MongoDB.
    pub mongo: MongoStore,
    /// Dragonfly (the Rust processes' logical database).
    pub dragonfly: Dragonfly,
    /// Key prefix ([`KeyPrefix::none`] in production).
    pub keys: KeyPrefix,
}

/// Why a runtime operation failed.
#[derive(Debug, thiserror::Error)]
pub enum RuntimeError {
    /// Dragonfly failed (see [`DragonflyError::outcome_unknown`] for writes).
    #[error("Dragonfly: {0}")]
    Dragonfly(#[from] DragonflyError),
    /// The MongoDB driver failed.
    #[error("MongoDB: {0}")]
    Mongo(#[from] mongodb::error::Error),
    /// A checked write failed.
    #[error(transparent)]
    Write(#[from] WriteError),
    /// The model refused or could not prepare a write.
    #[error(transparent)]
    Model(#[from] dima_model::ModelError),
    /// A stored document could not be read (the message names the path, never a value).
    #[error("stored document unreadable: {0}")]
    Decode(String),
    /// A store call did not finish in time: whether a write took effect is unknown.
    #[error("{operation} did not finish within {ms} ms")]
    Deadline {
        /// What was running.
        operation: &'static str,
        /// The deadline.
        ms: u64,
    },
    /// A script answered something it never answers.
    #[error("unexpected reply from {0}")]
    Reply(&'static str),
    /// The random source failed.
    #[error(transparent)]
    Random(#[from] dima_core::RandomError),
}

impl RuntimeError {
    /// `true` when a write may or may not have happened (a deadline, a reply lost in transit).
    pub fn outcome_unknown(&self) -> bool {
        match self {
            Self::Deadline { .. } => true,
            Self::Dragonfly(error) => error.outcome_unknown(),
            _ => false,
        }
    }
}

impl From<dima_model::DecodeError> for RuntimeError {
    fn from(error: dima_model::DecodeError) -> Self {
        Self::Decode(error.to_string())
    }
}

/// Runs `future` under `deadline`, naming `operation` when it expires.
pub(crate) async fn within<T, E>(
    operation: &'static str,
    deadline: Duration,
    future: impl IntoFuture<Output = Result<T, E>>,
) -> Result<T, RuntimeError>
where
    RuntimeError: From<E>,
{
    match tokio::time::timeout(deadline, future).await {
        Ok(result) => result.map_err(RuntimeError::from),
        Err(_) => Err(RuntimeError::Deadline {
            operation,
            ms: u64::try_from(deadline.as_millis()).unwrap_or(u64::MAX),
        }),
    }
}
