//! The end of a stream's speech session (reference: `utils/speech.ts`, `clearSpeechFiles`,
//! called by `domain_events/stream_operations_events.ts` when the stream goes offline; the API
//! subscribes to the announcement).
//!
//! Order, as in the reference: a new session id; the channel's speech files and queued TTS
//! payload keys observed before the boundary; the TTS session reset (atomic, owned by the TTS
//! queue package: [`SpeechSession::reset`]); the observed files removed (files a new session
//! wrote afterwards survive, and so does the directory then); and only then the announcement,
//! so the API cannot advance an old queued item while the backlog is being cleared.
//!
//! The reset and the announcement belong to the TTS queue package (P4-RT-TTS-A), which
//! implements [`SpeechSession`]; its pub/sub channel is the Rust name of [`TTS_SESSION_ENDED`].
//!
//! Intended differences: the channel id must be a plain path segment and contain no glob
//! character (the reference joins it into a path and a `KEYS` pattern unchecked); the queue keys
//! are found with `SCAN`, at most [`super::channel_cache::MAX_MATCHED_KEYS`]; at most
//! [`MAX_SPEECH_FILES`] files are looked at.

use std::future::Future;
use std::path::Path;

use dima_core::Random;

use super::{RuntimeError, Stores};

/// The reference's pub/sub channel announcing a finished session.
pub const TTS_SESSION_ENDED: &str = "tts:session-ended:v1";
/// The most directory entries looked at.
pub const MAX_SPEECH_FILES: usize = 100_000;

/// The TTS side of a session's end.
pub trait SpeechSession: Send + Sync {
    /// A failure.
    type Error: Send;

    /// `resetTtsSession(cache, channel, session, orphanKeys)`.
    fn reset<'a>(
        &'a self,
        channel_id: &'a str,
        session: &'a str,
        orphan_keys: &'a [String],
    ) -> impl Future<Output = Result<(), Self::Error>> + Send + 'a;

    /// Publishes `{channelID, session}` on the session-ended channel.
    fn publish_ended<'a>(
        &'a self,
        channel_id: &'a str,
        session: &'a str,
    ) -> impl Future<Output = Result<(), Self::Error>> + Send + 'a;
}

/// Why the session end failed.
#[derive(Debug, thiserror::Error)]
pub enum SpeechError<E> {
    /// The channel id cannot be used in a path or a pattern.
    #[error("invalid channel id for the speech directory")]
    InvalidChannel,
    /// Dragonfly or randomness failed.
    #[error(transparent)]
    Runtime(#[from] RuntimeError),
    /// The file system failed.
    #[error("speech files: {0}")]
    Files(#[from] std::io::Error),
    /// The TTS side failed.
    #[error("TTS session")]
    Session(E),
}

fn safe_segment(channel_id: &str) -> bool {
    !channel_id.is_empty()
        && channel_id != "."
        && channel_id != ".."
        && !channel_id.contains(['/', '\\', '\0', '*', '?', '[', ']'])
}

/// `clearSpeechFiles(channelID)`: `speech_dir` is the API's public speech directory
/// (`server/routes/public/speech`). Returns the new session id.
pub async fn clear_speech_files<S: SpeechSession>(
    stores: &Stores,
    speech_dir: &Path,
    channel_id: &str,
    session: &S,
    random: &dyn Random,
) -> Result<String, SpeechError<S::Error>> {
    if !safe_segment(channel_id) {
        return Err(SpeechError::InvalidChannel);
    }
    let id = random.uuid_v4().map_err(RuntimeError::from)?;
    let channel_dir = speech_dir.join(channel_id);
    let mut old_files = Vec::new();
    if let Ok(mut entries) = tokio::fs::read_dir(&channel_dir).await {
        while let Some(entry) = entries.next_entry().await? {
            if old_files.len() >= MAX_SPEECH_FILES {
                break;
            }
            if entry.file_type().await.is_ok_and(|kind| kind.is_file()) {
                old_files.push(entry.path());
            }
        }
    }
    let pattern = stores
        .keys
        .key(format_args!("twitch:{channel_id}:tts:queue:data:*"));
    let mut scan = stores.dragonfly.scan(&pattern, Some(500));
    let mut queue_keys = Vec::new();
    while let Some(page) = scan.next_page().await.map_err(RuntimeError::from)? {
        for key in page {
            let key = String::from_utf8(key).map_err(|_| RuntimeError::Reply("SCAN"))?;
            queue_keys.push(
                key.strip_prefix(stores.keys.as_str())
                    .unwrap_or(&key)
                    .to_owned(),
            );
        }
        if queue_keys.len() > super::channel_cache::MAX_MATCHED_KEYS {
            return Err(RuntimeError::Reply("SCAN matched too many keys").into());
        }
    }
    session
        .reset(channel_id, &id, &queue_keys)
        .await
        .map_err(SpeechError::Session)?;
    for file in old_files {
        match tokio::fs::remove_file(&file).await {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error.into()),
        }
    }
    // A directory holding a new session's files stays.
    let _ = tokio::fs::remove_dir(&channel_dir).await;
    session
        .publish_ended(channel_id, &id)
        .await
        .map_err(SpeechError::Session)?;
    Ok(id)
}
