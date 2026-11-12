//! Channel stream and audience records. No environment reads or runtime owner: callers supply
//! stores, clock, credentials and request pacing. The cron worker is a separate package.
#![forbid(unsafe_code)]
mod activity_projection;
pub mod clip_recommendations_queue;
pub mod defense_baseline;
pub mod follow_ledger;
pub mod follow_ledger_queue;
mod seen;
pub mod site_analytics;
pub mod stream_activity;
pub mod stream_memory_queue;

use std::{future::IntoFuture, time::Duration};

/// A failed operation. A timed-out write may have committed; rerun reconciliation to repair it.
#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("{0}")]
    Invalid(String),
    #[error("store or network deadline exceeded")]
    Deadline,
    #[error(transparent)]
    Prepare(#[from] dima_store::mongo::PrepareError),
    #[error(transparent)]
    Model(#[from] dima_model::ModelError),
    #[error(transparent)]
    Mongo(#[from] mongodb::error::Error),
    #[error(transparent)]
    Write(#[from] dima_store::mongo::write::WriteError),
    /// A channel follows, or is followed by, more accounts than one scan may hold; nothing
    /// was ended.
    #[error("more than {limit} follows in one scan")]
    ScanTooLarge { limit: usize },
    #[error(transparent)]
    Json(#[from] serde_json::Error),
    #[error(transparent)]
    Cache(#[from] dima_store::dragonfly::DragonflyError),
}

pub(crate) async fn bounded<F, T, E>(duration: Duration, future: F) -> Result<T, Error>
where
    F: IntoFuture<Output = Result<T, E>>,
    Error: From<E>,
{
    tokio::time::timeout(duration, future.into_future())
        .await
        .map_err(|_| Error::Deadline)?
        .map_err(Error::from)
}

pub mod subscription_ledger;
