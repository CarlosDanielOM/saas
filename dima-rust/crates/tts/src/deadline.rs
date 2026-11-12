//! Dropping the future when the deadline wins cancels its HTTP/store work.
use std::{future::Future, time::Duration};
#[derive(Debug, thiserror::Error)]
#[error("{0}")]
pub struct TimedOut(pub &'static str);
pub async fn with_timeout<T>(
    work: impl Future<Output = T>,
    timeout: Duration,
    message: &'static str,
) -> Result<T, TimedOut> {
    tokio::time::timeout(timeout, work)
        .await
        .map_err(|_| TimedOut(message))
}
