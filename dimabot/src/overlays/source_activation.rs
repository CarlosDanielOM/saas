//! The available native part of `live.ts` source activation: clip presence.
//!
//! This is deliberately not an implementation of `OverlaySourceActivation`:
//! native clip subscription and TTS idle-resume queue owners are still needed.
//! Callers must subscribe only after both writes succeed, and must propagate a
//! failure to the live runtime so its existing retry policy can run.

use std::{future::Future, pin::Pin, time::{SystemTime, UNIX_EPOCH}};

use redis::aio::ConnectionManager;

pub type PresenceFuture<'a> = Pin<Box<dyn Future<Output = Result<(), String>> + Send + 'a>>;

/// One ordinary Redis SET, without expiration or a transaction.
pub trait ClipPresenceStore: Send + Sync {
    fn set<'a>(&'a self, key: &'a str, value: &'a str) -> PresenceFuture<'a>;
}

/// Uses the existing native Redis connection manager; construction performs no I/O.
#[derive(Clone)]
pub struct RedisClipPresence {
    connection: ConnectionManager,
}

impl RedisClipPresence {
    pub fn new(connection: ConnectionManager) -> Self {
        Self { connection }
    }
}

impl ClipPresenceStore for RedisClipPresence {
    fn set<'a>(&'a self, key: &'a str, value: &'a str) -> PresenceFuture<'a> {
        Box::pin(async move {
            let mut connection = self.connection.clone();
            redis::cmd("SET")
                .arg(key)
                .arg(value)
                .query_async::<()>(&mut connection)
                .await
                .map_err(|error| error.to_string())
        })
    }
}

/// Matches the two sequential `cache.set` calls in `activateSources`.
/// The clock is read only after the first SET succeeds, as in `Date.now()`.
/// A failed second SET leaves the first write in place, also matching the source.
pub async fn mark_clip_source_connected<S, C>(
    store: &S,
    channel: &str,
    now_ms: C,
) -> Result<(), String>
where
    S: ClipPresenceStore + ?Sized,
    C: FnOnce() -> i64,
{
    let prefix = format!("twitch:{channel}:clips");
    store.set(&format!("{prefix}:connected"), "true").await?;
    let timestamp = now_ms().to_string();
    store.set(&format!("{prefix}:last_activity"), &timestamp).await
}

/// System wall-clock milliseconds, for the `Date.now()` value used above.
pub fn current_time_ms() -> i64 {
    match SystemTime::now().duration_since(UNIX_EPOCH) {
        Ok(duration) => i64::try_from(duration.as_millis()).unwrap_or(i64::MAX),
        Err(error) => -i64::try_from(error.duration().as_millis()).unwrap_or(i64::MAX),
    }
}
