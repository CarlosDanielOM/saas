//! Speech session reset: filesystem cleanup, queue reset and session-ended
//! publication.
//!
//! Ported from `dimabot/src/utils/speech.ts` (`clearSpeechFiles`) together with
//! the `TTS_SESSION_ENDED` constant.
//!
//! Operational rules preserved:
//!
//! * The public speech directory is an injected path. Rust has no `__dirname`,
//!   so nothing is resolved from the module location.
//! * The order is: snapshot the channel directory, list
//!   `twitch:<channelID>:tts:queue:data:*`, reset the Redis session through the
//!   shared [`crate::utils::tts::session::TtsSession`], remove only the files
//!   observed before the boundary, remove the directory only when it is empty,
//!   then publish `tts:session-ended:v1`.
//! * Publishing last means the API cannot advance an old queued item while this
//!   consumer is still clearing the stream's backlog. A new-session enqueue
//!   therefore survives even if the filesystem work finishes later.
//! * Failures are logged through the shared logger and then returned to the
//!   caller, matching the source's log-then-rethrow.
//!
//! Construction performs no I/O. The Redis manager, publisher and base
//! directory are injected; `SpeechFiles::native` wires the concrete Redis
//! publisher over the caller's connection manager.

use crate::utils::{
    logger::{Destination, Level, LogOptions, Logger},
    lossless_json::JsonValue,
    tts::session::TtsSession,
};
use redis::aio::ConnectionManager;
use std::{
    ffi::OsString,
    fmt,
    future::Future,
    path::{Path, PathBuf},
    pin::Pin,
    sync::Arc,
};

/// Publish channel of a completed session boundary.
pub const TTS_SESSION_ENDED: &str = "tts:session-ended:v1";

pub type SessionFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

/// The exact `KEYS` pattern of the source.
pub fn queue_data_pattern(channel_id: &str) -> String {
    format!("twitch:{channel_id}:tts:queue:data:*")
}

/// `{channelID, session}` in the source's key order.
pub fn session_ended_payload(channel_id: &str, session: &str) -> String {
    JsonValue::Object(vec![
        ("channelID".into(), JsonValue::String(channel_id.into())),
        ("session".into(), JsonValue::String(session.into())),
    ])
    .to_json_string()
}

/// Removal targets for a directory snapshot. Only names observed before the
/// boundary are removed, so a file written afterwards is never touched.
pub fn removal_targets(channel_dir: &Path, observed: &[OsString]) -> Vec<PathBuf> {
    observed
        .iter()
        .map(|name| channel_dir.join(name))
        .collect()
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SessionResetError {
    pub operation: &'static str,
    pub message: String,
}

impl SessionResetError {
    fn new(operation: &'static str, message: impl Into<String>) -> Self {
        Self {
            operation,
            message: message.into(),
        }
    }

    pub fn cache() -> Self {
        Self::new("cache", "session queue keys are unavailable")
    }

    pub fn session() -> Self {
        Self::new("resetTtsSession", "session queue reset failed")
    }

    pub fn filesystem(message: impl Into<String>) -> Self {
        Self::new("filesystem", message)
    }

    pub fn publish() -> Self {
        Self::new("publish", "session-ended publication failed")
    }
}

impl fmt::Display for SessionResetError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            formatter,
            "clearSpeechFiles failed during {}: {}",
            self.operation, self.message
        )
    }
}

impl std::error::Error for SessionResetError {}

/// Publication seam for `tts:session-ended:v1`.
///
/// Cross-team contract: the canonical TypeScript publisher is
/// `dimabot/src/classes/pubsub_manager.class.ts` (team2-api-data), which has no
/// Rust port. This port is the narrow replacement for `publish` only; when
/// team2 lands the canonical manager, this trait should delegate to it.
pub trait SessionPublisher: Send + Sync {
    fn publish<'a>(
        &'a self,
        event: &'a str,
        payload: &'a str,
    ) -> SessionFuture<'a, Result<(), SessionResetError>>;
}

/// Concrete Dragonfly/Redis `PUBLISH` adapter over an injected connection
/// manager. `PUBLISH` is an ordinary command, so the multiplexed socket is
/// safe; only `SUBSCRIBE` would need a dedicated connection.
#[derive(Clone)]
pub struct RedisSessionPublisher {
    cache: ConnectionManager,
}

impl RedisSessionPublisher {
    pub fn new(cache: ConnectionManager) -> Self {
        Self { cache }
    }
}

impl SessionPublisher for RedisSessionPublisher {
    fn publish<'a>(
        &'a self,
        event: &'a str,
        payload: &'a str,
    ) -> SessionFuture<'a, Result<(), SessionResetError>> {
        Box::pin(async move {
            let mut connection = self.cache.clone();
            // The subscriber count is not part of the source contract.
            let _: i64 = redis::cmd("PUBLISH")
                .arg(event)
                .arg(payload)
                .query_async(&mut connection)
                .await
                .map_err(|_| SessionResetError::publish())?;
            Ok(())
        })
    }
}

/// `clearSpeechFiles` with injected collaborators.
#[derive(Clone)]
pub struct SpeechFiles {
    cache: ConnectionManager,
    publisher: Arc<dyn SessionPublisher>,
    speech_public_dir: PathBuf,
    logger: Option<Arc<Logger>>,
}

impl SpeechFiles {
    /// Complete application wiring: the shared session queue and the concrete
    /// Redis publisher over the same manage connection.
    pub fn native(
        cache: ConnectionManager,
        speech_public_dir: impl Into<PathBuf>,
        logger: Option<Arc<Logger>>,
    ) -> Self {
        let publisher = Arc::new(RedisSessionPublisher::new(cache.clone()));
        Self::with_adapters(cache, publisher, speech_public_dir, logger)
    }

    /// Isolated construction for fixtures and alternate publishers.
    pub fn with_adapters(
        cache: ConnectionManager,
        publisher: Arc<dyn SessionPublisher>,
        speech_public_dir: impl Into<PathBuf>,
        logger: Option<Arc<Logger>>,
    ) -> Self {
        Self {
            cache,
            publisher,
            speech_public_dir: speech_public_dir.into(),
            logger,
        }
    }

    pub fn speech_public_dir(&self) -> &Path {
        &self.speech_public_dir
    }

    /// Port of `clearSpeechFiles`. A failure is logged and returned.
    pub async fn clear_speech_files(&self, channel_id: &str) -> Result<(), SessionResetError> {
        match self.clear(channel_id).await {
            Ok(()) => Ok(()),
            Err(error) => {
                self.diagnose(channel_id, &error).await;
                Err(error)
            }
        }
    }

    async fn clear(&self, channel_id: &str) -> Result<(), SessionResetError> {
        let session = uuid::Uuid::new_v4().to_string();
        let channel_dir = self.speech_public_dir.join(channel_id);
        // `readdir(...).catch(() => [])`: an unavailable or partially listable
        // directory yields no removal targets rather than failing the reset.
        let mut observed: Vec<OsString> = Vec::new();
        if let Ok(mut entries) = tokio::fs::read_dir(&channel_dir).await {
            while let Ok(Some(entry)) = entries.next_entry().await {
                let is_file = entry
                    .file_type()
                    .await
                    .map(|kind| kind.is_file())
                    .unwrap_or(false);
                if is_file {
                    observed.push(entry.file_name());
                }
            }
        }
        let queue_keys = self.queue_keys(channel_id).await?;
        TtsSession::new(self.cache.clone())
            .reset(channel_id, &session, &queue_keys)
            .await
            .map_err(|_| SessionResetError::session())?;
        // Remove only the files observed before the boundary. `fs.rm(force)`
        // ignores a missing file and propagates every other failure.
        for path in removal_targets(&channel_dir, &observed) {
            if let Err(error) = tokio::fs::remove_file(&path).await
                && error.kind() != std::io::ErrorKind::NotFound
            {
                return Err(SessionResetError::filesystem(error.to_string()));
            }
        }
        // `rmdir(...).catch(() => {})`: a directory containing new files stays.
        let _ = tokio::fs::remove_dir(&channel_dir).await;
        // Publish after removal so the API cannot advance an old queued item.
        let payload = session_ended_payload(channel_id, &session);
        self.publisher.publish(TTS_SESSION_ENDED, &payload).await
    }

    async fn queue_keys(&self, channel_id: &str) -> Result<Vec<String>, SessionResetError> {
        let mut connection = self.cache.clone();
        redis::cmd("KEYS")
            .arg(queue_data_pattern(channel_id))
            .query_async(&mut connection)
            .await
            .map_err(|_| SessionResetError::cache())
    }

    async fn diagnose(&self, channel_id: &str, error: &SessionResetError) {
        let Some(logger) = &self.logger else {
            eprintln!("[DEV NOTIFICATION - ERROR]: clearSpeechFiles failed for {channel_id}");
            return;
        };
        let _ = logger
            .log(
                Level::Error,
                serde_json::json!({
                    "function": "clearSpeechFiles",
                    "channelID": channel_id,
                    "error": error.to_string(),
                }),
                LogOptions {
                    destination: Destination::Both,
                    channel_id: Some(channel_id.to_owned()),
                    ..Default::default()
                },
            )
            .await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn session_ended_channel_name_matches_the_source() {
        assert_eq!(TTS_SESSION_ENDED, "tts:session-ended:v1");
    }

    #[test]
    fn queue_pattern_matches_the_source_key_layout() {
        assert_eq!(
            queue_data_pattern("123"),
            "twitch:123:tts:queue:data:*"
        );
    }

    #[test]
    fn payload_keeps_the_source_key_order() {
        assert_eq!(
            session_ended_payload("123", "fixture-session"),
            r#"{"channelID":"123","session":"fixture-session"}"#
        );
    }

    #[test]
    fn removal_targets_only_include_the_observed_boundary() {
        let directory = Path::new("/srv/speech");
        let observed = vec![OsString::from("a.mp3"), OsString::from("b.mp3")];
        assert_eq!(
            removal_targets(directory, &observed),
            vec![
                PathBuf::from("/srv/speech/a.mp3"),
                PathBuf::from("/srv/speech/b.mp3"),
            ]
        );
        assert!(removal_targets(directory, &[]).is_empty());
    }

    #[test]
    fn errors_name_the_source_function_for_logging() {
        let error = SessionResetError::session();
        assert_eq!(
            error.to_string(),
            "clearSpeechFiles failed during resetTtsSession: session queue reset failed"
        );
    }
}
