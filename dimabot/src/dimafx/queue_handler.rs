//! Durable queue storage and enqueue path from `dimafx_queue.handler.ts`.
//! The oldest live receipt is leased without skipping a busy head; storage
//! failures and lost ownership must never be interpreted as playback failures.
//! [`DimafxEnqueueHandler`] ports `enqueue`: duplicate receipts, overlay
//! presence, capacity, media/TTS payload preparation and the source's status
//! rejections run in the same order as the TypeScript method, except for the
//! missing-voice representation noted at `MongoDimafxTtsVoiceSource`. The
//! `processNext` uses Mongo leases. `NativeDimafxComposition` joins Piper,
//! refund, socket delivery and acknowledgements; the host must construct and
//! register that shared instance. Missing adapters return `Unavailable`.
//!
//! Source wait inventory (no scheduling policy has been frozen): the overlay
//! polls every 2 seconds for idle/reconnect and expired-lease work; lease
//! heartbeat is every 5 seconds to protect a 15-second lease; TTS synthesis
//! has a 45-second deadline; playback waits for acknowledgement or a bounded
//! duration plus 750 ms; delivery repeats every 5 seconds for lost delivery or
//! acknowledgement; generated audio is retained 120 seconds for slow fetches.
//! A busy head is never skipped; when ready work remains, the source processes
//! the next item immediately, without a per-item or batch sleep. A future
//! implementation must prove this with a normal-mode ready/backlog test and
//! separately prove idle, disconnected and lease-expiry waiting. The in-memory
//! tests below are authored examples, not executed production evidence.
//!
//! Source comparison: `processNext` checks connection, claims the oldest live
//! head, renews every five seconds, resumes refunds, marks playing, dispatches,
//! refunds playback errors only while connected, completes only while connected,
//! releases in finally and immediately loops. The Rust loop returns errors to
//! its caller for logging instead of swallowing them, and stops on lease loss or
//! heartbeat storage error rather than allowing further side effects. The
//! composition starts it on enqueue and the two-second reconnect/idle poll.
//! The socket adapter sends stable IDs and correlates acknowledgements; unlike
//! the source's early acknowledgement write, completion is persisted by the
//! lease owner after delivery returns. Cancellation can interrupt the async release if the whole future is
//! dropped; expiration is the recovery path. Refund must use the existing
//! idempotent `NativeRefundRecovery`; an in-flight credit cannot be atomically
//! fenced by the playback lease. None
//! of these seams alone establishes feature or migration completion.

/// Queue lease duration in milliseconds.
pub const LEASE_MS: u64 = 15_000;
/// Maximum accepted queued items.
pub const MAX_QUEUE_ITEMS: usize = 25;
/// Synthesis deadline in milliseconds.
pub const TTS_SYNTHESIS_TIMEOUT_MS: u64 = 45_000;
/// Minimum playback wait in milliseconds.
pub const MIN_PLAYBACK_WAIT_MS: u64 = 2_000;
/// Maximum playback wait in milliseconds.
pub const MAX_PLAYBACK_WAIT_MS: u64 = 120_000;
/// Default media playback duration in milliseconds.
pub const DEFAULT_MEDIA_WAIT_MS: u64 = 30_000;
/// Default image playback duration in milliseconds.
pub const DEFAULT_IMAGE_WAIT_MS: u64 = 5_000;
/// Default TTS playback duration in milliseconds.
pub const DEFAULT_TTS_WAIT_MS: u64 = 15_000;
/// Grace added to the playback duration in milliseconds.
pub const PLAYBACK_GRACE_MS: u64 = 750;

/// Compute the source's bounded playback wait for ordinary media.
pub fn playback_wait_ms(duration_ms: u64, is_image: bool) -> u64 {
    let base = if duration_ms > 0 { duration_ms } else if is_image { DEFAULT_IMAGE_WAIT_MS } else { DEFAULT_MEDIA_WAIT_MS };
    base.saturating_add(PLAYBACK_GRACE_MS).clamp(MIN_PLAYBACK_WAIT_MS, MAX_PLAYBACK_WAIT_MS)
}

/// TTS uses the probed audio duration, or the source's 15-second fallback.
pub fn tts_playback_wait_ms(probed_ms: u64) -> u64 {
    let base = if probed_ms > 0 { probed_ms } else { DEFAULT_TTS_WAIT_MS };
    base.saturating_add(PLAYBACK_GRACE_MS).clamp(MIN_PLAYBACK_WAIT_MS, MAX_PLAYBACK_WAIT_MS)
}

/// A synthesized file remains available to slow overlay fetches for two
/// minutes after dispatch ends. The dispatcher must schedule its deletion even
/// on cancellation or disconnect; this value is not a queue pacing delay.
pub const TTS_FILE_RETENTION_MS: u64 = 120_000;
/// Re-deliver a stable trigger ID while awaiting playback acknowledgement.
pub const REDELIVERY_INTERVAL_MS: u64 = 5_000;
/// Renew the 15-second lease while synthesis, playback, or refund is pending.
pub const LEASE_HEARTBEAT_MS: u64 = LEASE_MS / 3;

/// Output of the native Piper preparation step. The dispatcher owns cleanup.
#[cfg(feature = "tts-services")]
pub struct PreparedDimafxTts {
    pub output_path: std::path::PathBuf,
    pub public_path: String,
    pub media_type: &'static str,
    pub wait_ms: u64,
    _cleanup: TtsCleanup,
}

#[cfg(feature = "tts-services")]
struct TtsCleanup(std::path::PathBuf);
#[cfg(feature = "tts-services")]
impl Drop for TtsCleanup {
    fn drop(&mut self) {
        let path = self.0.clone();
        // Drop also runs when lease loss or cancellation drops the delivery.
        if let Ok(runtime) = tokio::runtime::Handle::try_current() {
            runtime.spawn(async move {
                tokio::time::sleep(std::time::Duration::from_millis(TTS_FILE_RETENTION_MS)).await;
                let _ = tokio::fs::remove_file(path).await;
            });
        }
    }
}

/// Synthesize through the existing Piper implementation with the source's
/// overall 45-second deadline, then probe the output without blocking Tokio.
/// This function does not classify errors as refundable; only the queue owner
/// can distinguish a provider failure from lost ownership or disconnection.
#[cfg(feature = "tts-services")]
pub async fn prepare_dimafx_tts(
    piper: &crate::tts_services::piper_tts::PiperTtsService,
    channel: &str,
    trigger: &str,
    tts: &DimafxQueueTts,
) -> Result<PreparedDimafxTts, DimafxTtsError> {
    use crate::tts_services::tts_provider::TtsSynthesisRequest;
    use crate::utils::tts::{TtsLanguage, TtsMode, TtsProvider};
    // Every attempt owns a distinct file, even when a lease expires and a
    // second process replays the same stable trigger ID.
    let speech_id = format!("dimafx-{}", uuid::Uuid::new_v4());
    let output_path = piper.config.paths.output_dir(channel).join(format!("{speech_id}.wav"));
    let request = TtsSynthesisRequest {
        channel_id: channel.to_owned(),
        speech_id,
        mode: TtsMode::Speak,
        provider: TtsProvider::Piper,
        model: None,
        text: tts.text.clone(),
        language: match tts.language {
            DimafxQueueLanguage::En => TtsLanguage::En,
            DimafxQueueLanguage::Es => TtsLanguage::Es,
        },
        voice: tts.voice.clone(),
        output_path: std::path::PathBuf::new(),
        clone_name: None,
        private_output: false,
        signal: None,
        max_audio_bytes: None,
        single_attempt: false,
    };
    let piper = piper.clone();
    // Do not abort a provider while it may be writing a partial file. The
    // detached task owns cleanup even if the caller times out or loses its
    // lease. Cleanup starts only after the provider has stopped writing.
    let task = tokio::spawn(async move {
        let cleanup = TtsCleanup(output_path.clone());
        let result = piper.synthesize(&request).await;
        if result.error || result.output_path.as_ref() != Some(&output_path) || result.public_path.is_none() {
            let message = if result.message.is_empty() { "DimaFX TTS synthesis failed".to_owned() } else { result.message };
            return Err(DimafxTtsError(message));
        }
        let probed = crate::utils::tts::playback_timeout::audio_file_duration_ms_async(&output_path).await;
        Ok(PreparedDimafxTts {
            output_path,
            public_path: result.public_path.expect("checked public path"),
            media_type: result.mime_type.unwrap_or("audio/wav"),
            wait_ms: tts_playback_wait_ms(probed),
            _cleanup: cleanup,
        })
    });
    let _ = trigger; // The stable trigger remains in the socket payload.
    tokio::time::timeout(std::time::Duration::from_millis(TTS_SYNTHESIS_TIMEOUT_MS), task)
        .await.map_err(|_| DimafxTtsError("DimaFX TTS synthesis timed out".into()))?
        .map_err(|_| DimafxTtsError("DimaFX TTS synthesis task failed".into()))?
}

#[cfg(test)]
mod dimafx_dispatch_wait_tests {
    use super::*;

    #[test]
    fn tts_duration_fallback_grace_and_limits_match_source() {
        assert_eq!(tts_playback_wait_ms(0), 15_750);
        assert_eq!(tts_playback_wait_ms(100), 2_000);
        assert_eq!(tts_playback_wait_ms(2_500), 3_250);
        assert_eq!(tts_playback_wait_ms(u64::MAX), 120_000);
    }

    #[test]
    fn lease_and_redelivery_are_distinct_from_cleanup_retention() {
        assert_eq!(LEASE_HEARTBEAT_MS * 3, LEASE_MS);
        assert_eq!(REDELIVERY_INTERVAL_MS, 5_000);
        assert_eq!(TTS_FILE_RETENTION_MS, 120_000);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test] fn default_image() { assert_eq!(playback_wait_ms(0, true), 5_750); }
    #[test] fn default_media() { assert_eq!(playback_wait_ms(0, false), 30_750); }
    #[test] fn clamp_duration() { assert_eq!(playback_wait_ms(u64::MAX, false), MAX_PLAYBACK_WAIT_MS); }
}

use crate::media::library_service::build_media_playback_url;
use crate::schemas::channel_extension_item::{
    ChannelExtensionItemCategory, ChannelExtensionItemTtsLanguage, ChannelExtensionItemTtsMode,
    IChannelExtensionItem,
};
use crate::schemas::dimafx_playback;
use crate::schemas::dimafx_playback::{
    DimafxQueueItem, DimafxQueueLanguage, DimafxQueueRefund, DimafxQueueSource, DimafxQueueTts,
};
use crate::schemas::media_asset::IMediaAsset;
use crate::utils::js_string::JsString;
use crate::utils::lossless_json::JsonValue;
use mongodb::{
    bson::{DateTime, Document, doc},
    options::ReturnDocument,
    Collection, Database,
};
use std::fmt;
use std::future::Future;
use super::fulfillment::DimafxFulfillment;
use mongodb::error::{ErrorKind, WriteFailure};

/// Storage failures leave the job recoverable and must not cause a refund.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct QueueStorageError(pub String);
impl fmt::Display for QueueStorageError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result { f.write_str(&self.0) }
}
impl std::error::Error for QueueStorageError {}

fn duplicate_key(error: &mongodb::error::Error) -> bool {
    match error.kind.as_ref() {
        ErrorKind::Write(WriteFailure::WriteError(error)) => error.code == 11000,
        ErrorKind::Command(error) => error.code == 11000,
        _ => false,
    }
}

fn live_filter(channel: &str) -> Document {
    doc! { "channelID": channel, "state": { "$nin": ["completed", "refunded"] } }
}
fn claim_filter(id: &str, owner: &str, now: DateTime) -> Document {
    doc! { "_id": id, "state": { "$nin": ["completed", "refunded"] },
        "$or": [{ "leaseUntil": { "$lte": now } }, { "leaseOwner": owner }] }
}
fn valid_transition(from: &str, to: &str) -> bool {
    matches!((from, to), ("queued", "playing") | ("playing", "playing") | ("playing", "completed") | ("playing", "refunding") | ("refunding", "refunded"))
}
fn owned_filter(channel: &str, id: &str, owner: &str, state: Option<&str>) -> Document {
    let mut filter = doc! { "_id": id, "channelID": channel, "leaseOwner": owner };
    if let Some(state) = state { filter.insert("state", state); }
    filter
}

/// Mongo implementation of the durable playback receipt and lease operations.
/// Construction does not connect; the caller supplies the existing database.
#[derive(Clone)]
pub struct MongoPlaybackStore { database: Database }
impl MongoPlaybackStore {
    /// Bind the existing application database without performing I/O.
    pub fn new(database: Database) -> Self { Self { database } }
    fn collection(&self) -> Collection<Document> { dimafx_playback::collection(&self.database) }

    /// Find a receipt even when it has already reached a terminal state.
    pub async fn existing(&self, channel: &str, id: &str) -> Result<Option<Document>, QueueStorageError> {
        self.collection().find_one(doc! { "_id": id, "channelID": channel }).await
            .map_err(|error| QueueStorageError(error.to_string()))
    }

    /// Count jobs that still block the queue, including pending refunds.
    pub async fn queue_length(&self, channel: &str) -> Result<u64, QueueStorageError> {
        self.collection().count_documents(live_filter(channel)).await
            .map_err(|error| QueueStorageError(error.to_string()))
    }

    /// Insert a stable receipt only if absent. The source upserts by global ID
    /// and treats duplicate-key races as success, including another channel's ID.
    pub async fn insert_if_absent(&self, channel: &str, id: &str, payload: Document, now: DateTime) -> Result<(), QueueStorageError> {
        let result = self.collection().update_one(doc! { "_id": id }, doc! { "$setOnInsert": {
            "channelID": channel, "payload": payload, "state": "queued", "leaseOwner": "",
            "leaseUntil": DateTime::from_millis(0), "createdAt": now, "updatedAt": now
        }}).upsert(true).await;
        if let Err(error) = result {
            if !duplicate_key(&error) { return Err(QueueStorageError(error.to_string())); }
        }
        Ok(())
    }

    /// Claim the oldest nonterminal receipt, without skipping a leased head job.
    /// Returns `None` when the head is owned by another live producer.
    pub async fn claim_head(&self, channel: &str, owner: &str, now: DateTime) -> Result<Option<Document>, QueueStorageError> {
        let collection = self.collection();
        let first = collection.find_one(live_filter(channel)).sort(doc! { "createdAt": 1, "_id": 1 }).await
            .map_err(|error| QueueStorageError(error.to_string()))?;
        let Some(first) = first else { return Ok(None) };
        let id = first.get_str("_id").map_err(|error| QueueStorageError(error.to_string()))?;
        let until = DateTime::from_millis(now.timestamp_millis().saturating_add(LEASE_MS as i64));
        collection.find_one_and_update(claim_filter(id, owner, now), doc! { "$set": {
            "leaseOwner": owner, "leaseUntil": until, "updatedAt": now
        }}).return_document(ReturnDocument::After).await
            .map_err(|error| QueueStorageError(error.to_string()))
    }

    /// Renew a lease only while still owned; `false` means the caller lost it.
    pub async fn renew(&self, channel: &str, id: &str, owner: &str, now: DateTime) -> Result<bool, QueueStorageError> {
        let until = DateTime::from_millis(now.timestamp_millis().saturating_add(LEASE_MS as i64));
        let mut filter = owned_filter(channel, id, owner, None);
        filter.insert("leaseUntil", doc! { "$gt": now });
        self.update_owned(filter, doc! { "$set": { "leaseUntil": until, "updatedAt": now } }).await
    }

    /// Change state only from the supplied state while holding the lease.
    /// In particular, persist `refunding` before invoking the idempotent refund,
    /// and transition to `refunded` only after that operation succeeds.
    pub async fn transition(&self, channel: &str, id: &str, owner: &str, from: &str, to: &str, failure: Option<&str>, now: DateTime) -> Result<bool, QueueStorageError> {
        if !valid_transition(from, to) { return Err(QueueStorageError("Invalid DimaFX playback transition".into())); }
        let mut fields = doc! { "state": to, "updatedAt": now };
        if let Some(failure) = failure { fields.insert("failure", failure); }
        let mut filter = owned_filter(channel, id, owner, Some(from));
        filter.insert("leaseUntil", doc! { "$gt": now });
        self.update_owned(filter, doc! { "$set": fields }).await
    }

    /// Release only the caller's lease; a stale producer cannot release a new owner.
    pub async fn release(&self, channel: &str, id: &str, owner: &str, now: DateTime) -> Result<bool, QueueStorageError> {
        self.update_owned(owned_filter(channel, id, owner, None), doc! { "$set": {
            "leaseOwner": "", "leaseUntil": DateTime::from_millis(0), "updatedAt": now
        }}).await
    }

    async fn update_owned(&self, filter: Document, update: Document) -> Result<bool, QueueStorageError> {
        self.collection().update_one(filter, update).await.map(|result| result.matched_count != 0)
            .map_err(|error| QueueStorageError(error.to_string()))
    }
}

/// Status for a non-TTS item without an asset. Source `enqueue`.
pub const MISSING_MEDIA_STATUS: u16 = 500;
/// Source message for a non-TTS item without an asset.
pub const MISSING_MEDIA_MESSAGE: &str = "DimaFX item has no playable media";
/// Status for a channel with no ready overlay socket.
pub const DISCONNECTED_STATUS: u16 = 409;
/// Source message for a channel with no ready overlay socket.
pub const DISCONNECTED_MESSAGE: &str = "DimaFX overlay is disconnected";
/// Status for a channel whose live queue reached [`MAX_QUEUE_ITEMS`].
pub const QUEUE_FULL_STATUS: u16 = 429;
/// Source message for a full queue.
pub const QUEUE_FULL_MESSAGE: &str = "DimaFX queue is full for this channel";
/// Status for a TTS trigger without non-whitespace text.
pub const TTS_TEXT_REQUIRED_STATUS: u16 = 400;
/// Source message for a TTS trigger without non-whitespace text.
pub const TTS_TEXT_REQUIRED_MESSAGE: &str = "TTS text is required for this item";
/// Playback MIME type stored for synthesized TTS.
pub const DIMAFX_TTS_MEDIA_TYPE: &str = "audio/wav";

/// Source `DimafxEnqueueInput`. `triggerID` is stable for purchase retries.
/// The payload keeps `mediaUrl`/`mediaType` optional and only includes
/// `tts`/refund fields when supplied.
#[derive(Clone, Debug, PartialEq)]
pub struct DimafxEnqueueInput {
    pub channel_id: JsString,
    pub trigger_id: Option<JsString>,
    pub item: IChannelExtensionItem,
    pub asset: Option<IMediaAsset>,
    /// Sanitized viewer text for custom TTS items.
    pub viewer_text: Option<JsString>,
    /// Credits the viewer if the queued trigger fails before or during dispatch.
    pub refund_on_failure: Option<DimafxQueueRefund>,
    pub source: DimafxQueueSource,
}

/// Successful source `{ ok: true, triggerID, queueLength, activeConnections }`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DimafxQueueReceipt {
    pub trigger_id: String,
    pub queue_length: u64,
    pub active_connections: usize,
}

/// Source `{ ok: false, status, message }`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct DimafxEnqueueRejection {
    pub status: u16,
    pub message: &'static str,
}

/// Source `DimafxEnqueueResult`; rejections are values, storage failures throw.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum DimafxEnqueueResult {
    Queued(DimafxQueueReceipt),
    Rejected(DimafxEnqueueRejection),
}

/// Failure reading a channel's default TTS voice.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DimafxTtsError(pub String);
impl fmt::Display for DimafxTtsError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result { f.write_str(&self.0) }
}
impl std::error::Error for DimafxTtsError {}

/// A storage or settings failure throws in the source instead of returning a
/// business rejection. A thrown failure never queues and never refunds.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum DimafxEnqueueError {
    Storage(QueueStorageError),
    TtsVoice(DimafxTtsError),
}
impl fmt::Display for DimafxEnqueueError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Storage(error) => error.fmt(f),
            Self::TtsVoice(error) => error.fmt(f),
        }
    }
}
impl std::error::Error for DimafxEnqueueError {}
impl From<QueueStorageError> for DimafxEnqueueError {
    fn from(error: QueueStorageError) -> Self { Self::Storage(error) }
}
impl From<DimafxTtsError> for DimafxEnqueueError {
    fn from(error: DimafxTtsError) -> Self { Self::TtsVoice(error) }
}

/// Receipt storage needed by enqueue. The production adapter is
/// [`MongoPlaybackStore`]; failures surface as [`QueueStorageError`] and are
/// never converted into a rejection.
pub trait DimafxEnqueueStore: Send + Sync {
    /// `DimafxPlaybackSchema.findOne({ _id, channelID }).lean()`.
    fn receipt_exists<'a>(&'a self, channel: &'a str, trigger: &'a str)
        -> impl Future<Output = Result<bool, QueueStorageError>> + Send + 'a;

    /// `countDocuments({ channelID, state: { $nin: [completed, refunded] } })`.
    fn live_queue_length<'a>(&'a self, channel: &'a str)
        -> impl Future<Output = Result<u64, QueueStorageError>> + Send + 'a;

    /// `updateOne({ _id }, { $setOnInsert }, { upsert: true })`, tolerant of a
    /// concurrent duplicate even if another channel holds the global `_id`.
    fn insert_receipt<'a>(
        &'a self,
        channel: &'a str,
        trigger: &'a str,
        payload: &'a DimafxQueueItem,
        now: DateTime,
    ) -> impl Future<Output = Result<(), QueueStorageError>> + Send + 'a;
}

impl DimafxEnqueueStore for MongoPlaybackStore {
    fn receipt_exists<'a>(&'a self, channel: &'a str, trigger: &'a str) -> impl Future<Output = Result<bool, QueueStorageError>> + Send + 'a {
        async move { Ok(MongoPlaybackStore::existing(self, channel, trigger).await?.is_some()) }
    }

    fn live_queue_length<'a>(&'a self, channel: &'a str) -> impl Future<Output = Result<u64, QueueStorageError>> + Send + 'a {
        async move { MongoPlaybackStore::queue_length(self, channel).await }
    }

    fn insert_receipt<'a>(&'a self, channel: &'a str, trigger: &'a str, payload: &'a DimafxQueueItem, now: DateTime) -> impl Future<Output = Result<(), QueueStorageError>> + Send + 'a {
        async move { MongoPlaybackStore::insert_if_absent(self, channel, trigger, payload.to_document(), now).await }
    }
}

/// Ready-socket count for the overlay namespace. The production adapter is the
/// socket owner's `DimafxReadySockets::for_channel(...).len()`; enqueue does not
/// open or observe sockets itself.
pub trait DimafxOverlayPresence: Send + Sync {
    fn ready_connections(&self, channel: &str) -> usize;
}

#[cfg(feature = "socketio")]
impl DimafxOverlayPresence for super::overlay_service::DimafxReadySockets {
    fn ready_connections(&self, channel: &str) -> usize {
        self.for_channel(channel).len()
    }
}

/// Composition placeholder for callers without the socket adapter. It reports
/// no ready overlay, so enqueue always returns [`DISCONNECTED_STATUS`]; it is
/// not a production adapter.
#[derive(Clone, Copy, Debug, Default)]
pub struct NoOverlayPresence;
impl DimafxOverlayPresence for NoOverlayPresence {
    fn ready_connections(&self, _channel: &str) -> usize { 0 }
}

/// Default TTS voice lookup used when an item's own voice is empty.
pub trait DimafxTtsVoiceSource: Send + Sync {
    /// `getChannelTtsSettings(channelID, channelName).voices[language]`.
    fn channel_voice<'a>(
        &'a self,
        channel_id: &'a JsString,
        channel_name: &'a JsString,
        language: DimafxQueueLanguage,
    ) -> impl Future<Output = Result<JsString, DimafxTtsError>> + Send + 'a;
}

/// Production adapter over the existing channel TTS settings schema. Its
/// normalizer currently supplies nonempty language voices. If that contract
/// changes, source parity for a missing voice needs an optional payload voice:
/// the source does not explicitly reject an undefined `voices[language]`.
#[derive(Clone)]
pub struct MongoDimafxTtsVoiceSource {
    database: Database,
}
impl MongoDimafxTtsVoiceSource {
    /// Bind the existing application database without performing I/O.
    pub fn new(database: Database) -> Self { Self { database } }
}
impl DimafxTtsVoiceSource for MongoDimafxTtsVoiceSource {
    fn channel_voice<'a>(&'a self, channel_id: &'a JsString, channel_name: &'a JsString, language: DimafxQueueLanguage) -> impl Future<Output = Result<JsString, DimafxTtsError>> + Send + 'a {
        async move {
            let settings = crate::schemas::channel_tts_settings::get_channel_tts_settings(
                &self.database,
                channel_id,
                channel_name,
            ).await.map_err(|error| DimafxTtsError(error.to_string()))?;
            match settings.get("voices").and_then(|voices| voices.get(language.as_str())) {
                Some(JsonValue::String(voice)) if !voice.is_empty() => Ok(voice.clone()),
                _ => Err(DimafxTtsError(format!(
                    "DimaFX channel TTS voice is unavailable for language {}",
                    language.as_str()
                ))),
            }
        }
    }
}

/// Source `randomUUID()` and `Date.now()` seams.
pub trait DimafxEnqueueIds: Send + Sync {
    fn now_millis(&self) -> f64;
    fn trigger_id(&self) -> String;
}

/// Production identity source: UUID v4 and wall-clock milliseconds.
#[derive(Clone, Copy, Debug, Default)]
pub struct SystemEnqueueIds;
impl DimafxEnqueueIds for SystemEnqueueIds {
    fn now_millis(&self) -> f64 {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|duration| duration.as_millis() as f64)
            .unwrap_or(0.0)
    }
    fn trigger_id(&self) -> String { uuid::Uuid::new_v4().to_string() }
}

/// Enqueue composition. Persisting the receipt is the last step; dispatch and
/// scheduling are intentionally not started here.
pub struct DimafxEnqueueHandler<S, P, T, I = SystemEnqueueIds> {
    store: S,
    presence: P,
    tts: T,
    ids: I,
    api_url: String,
}

impl<S, P, T, I> DimafxEnqueueHandler<S, P, T, I> {
    /// Bind every collaborator explicitly, including the deterministic seams.
    pub fn with_parts(store: S, presence: P, tts: T, ids: I, api_url: impl Into<String>) -> Self {
        Self { store, presence, tts, ids, api_url: api_url.into() }
    }
}
impl<S, P, T> DimafxEnqueueHandler<S, P, T, SystemEnqueueIds> {
    /// Bind the real clock and UUID generator.
    pub fn new(store: S, presence: P, tts: T, api_url: impl Into<String>) -> Self {
        Self::with_parts(store, presence, tts, SystemEnqueueIds, api_url)
    }
}
/// Production enqueue composition: Mongo receipts and Mongo TTS voices.
pub type NativeDimafxEnqueueHandler<P> =
    DimafxEnqueueHandler<MongoPlaybackStore, P, MongoDimafxTtsVoiceSource, SystemEnqueueIds>;
impl<P> DimafxEnqueueHandler<MongoPlaybackStore, P, MongoDimafxTtsVoiceSource, SystemEnqueueIds> {
    /// Bind the existing database plus the caller's socket-presence adapter.
    pub fn native(database: Database, presence: P, api_url: impl Into<String>) -> Self {
        Self::new(
            MongoPlaybackStore::new(database.clone()),
            presence,
            MongoDimafxTtsVoiceSource::new(database),
            api_url,
        )
    }
}

/// JavaScript `Math.min`/`Math.max` keep NaN rather than selecting an operand,
/// and signed zero follows the same rules.
fn js_number_min(left: f64, right: f64) -> f64 {
    if left.is_nan() || right.is_nan() { return f64::NAN; }
    if left == 0.0 && right == 0.0 {
        return if left.is_sign_negative() || right.is_sign_negative() { -0.0 } else { 0.0 };
    }
    if left < right { left } else { right }
}
fn js_number_max(left: f64, right: f64) -> f64 {
    if left.is_nan() || right.is_nan() { return f64::NAN; }
    if left == 0.0 && right == 0.0 {
        return if left.is_sign_negative() && right.is_sign_negative() { -0.0 } else { 0.0 };
    }
    if left > right { left } else { right }
}
/// `Math.max(0, Math.min(100, Number(item.volume ?? 100)))`.
pub fn clamp_volume(volume: f64) -> f64 { js_number_max(0.0, js_number_min(100.0, volume)) }
/// `Math.max(0, Number(item.durationMs || 0))`.
pub fn normalize_duration(duration_ms: f64) -> f64 {
    if duration_ms.is_nan() || duration_ms == 0.0 { 0.0 } else { js_number_max(0.0, duration_ms) }
}

fn rejected(status: u16, message: &'static str) -> DimafxEnqueueResult {
    DimafxEnqueueResult::Rejected(DimafxEnqueueRejection { status, message })
}

impl<S, P, T, I> DimafxEnqueueHandler<S, P, T, I>
where
    S: DimafxEnqueueStore,
    P: DimafxOverlayPresence,
    T: DimafxTtsVoiceSource,
    I: DimafxEnqueueIds,
{
    /// Persist before dispatch; a receipt is returned even after completion.
    /// Check order matches the source: receipt, media, connection, capacity,
    /// TTS text/voice, then the durable upsert.
    pub async fn enqueue(&self, input: DimafxEnqueueInput) -> Result<DimafxEnqueueResult, DimafxEnqueueError> {
        self.enqueue_with_wake(input, |_| {}).await
    }

    async fn enqueue_with_wake(&self, input: DimafxEnqueueInput, wake: impl FnOnce(String)) -> Result<DimafxEnqueueResult, DimafxEnqueueError> {
        let channel = input.channel_id.to_utf8_lossy();
        let trigger = input.trigger_id.as_ref()
            .filter(|value| !value.is_empty())
            .map(JsString::to_utf8_lossy)
            .unwrap_or_else(|| self.ids.trigger_id());

        if self.store.receipt_exists(&channel, &trigger).await? {
            // Even refunded/completed jobs are receipts: never buy again.
            return Ok(DimafxEnqueueResult::Queued(DimafxQueueReceipt {
                trigger_id: trigger,
                queue_length: self.store.live_queue_length(&channel).await?,
                active_connections: self.presence.ready_connections(&channel),
            }));
        }

        let is_tts = input.item.category == ChannelExtensionItemCategory::Tts;
        if !is_tts && input.asset.is_none() {
            return Ok(rejected(MISSING_MEDIA_STATUS, MISSING_MEDIA_MESSAGE));
        }
        if self.presence.ready_connections(&channel) == 0 {
            return Ok(rejected(DISCONNECTED_STATUS, DISCONNECTED_MESSAGE));
        }
        if self.store.live_queue_length(&channel).await? >= MAX_QUEUE_ITEMS as u64 {
            return Ok(rejected(QUEUE_FULL_STATUS, QUEUE_FULL_MESSAGE));
        }

        let tts = if is_tts {
            let config = input.item.tts.as_ref();
            let raw_text = match config {
                Some(config) if config.mode == ChannelExtensionItemTtsMode::Fixed => config.text.clone(),
                _ => input.viewer_text.clone().unwrap_or_default(),
            };
            let text = raw_text.trim();
            if text.is_empty() {
                return Ok(rejected(TTS_TEXT_REQUIRED_STATUS, TTS_TEXT_REQUIRED_MESSAGE));
            }
            let language = match config.map(|config| config.language) {
                Some(ChannelExtensionItemTtsLanguage::Es) => DimafxQueueLanguage::Es,
                _ => DimafxQueueLanguage::En,
            };
            let voice = match config {
                Some(config) if !config.voice.is_empty() => config.voice.clone(),
                _ => self.tts.channel_voice(&input.channel_id, &input.item.channel_name, language).await?,
            };
            Some(DimafxQueueTts { text, voice, language })
        } else {
            None
        };

        let media_url = input.asset.as_ref()
            .map(|asset| build_media_playback_url(&self.api_url, &asset.id.to_hex()));
        let media_type = if is_tts {
            JsString::from(DIMAFX_TTS_MEDIA_TYPE)
        } else if let Some(asset) = input.asset.as_ref().filter(|asset| !asset.mime_type.is_empty()) {
            asset.mime_type.clone()
        } else {
            JsString::from(input.item.media_type.as_str())
        };

        let enqueued_at = self.ids.now_millis();
        let payload = DimafxQueueItem {
            trigger_id: JsString::from(trigger.clone()),
            channel_id: input.channel_id.clone(),
            item_id: JsString::from(input.item.id.to_hex()),
            name: input.item.name.clone(),
            category: JsString::from(input.item.category.as_str()),
            media_url: media_url.map(JsString::from),
            media_type: Some(media_type),
            volume: clamp_volume(input.item.volume),
            duration_ms: normalize_duration(input.item.duration_ms),
            tts,
            refund_on_failure: input.refund_on_failure.clone(),
            source: input.source,
            enqueued_at,
        };

        self.store.insert_receipt(
            &channel,
            &trigger,
            &payload,
            DateTime::from_millis(enqueued_at as i64),
        ).await?;

        // Start before the final queue-length read, matching the source even
        // if that read fails after the durable insert.
        wake(channel.clone());
        let queue_length = self.store.live_queue_length(&channel).await?;
        Ok(DimafxEnqueueResult::Queued(DimafxQueueReceipt {
            trigger_id: trigger,
            queue_length,
            active_connections: self.presence.ready_connections(&channel),
        }))
    }
}

/// Native durable refund recovery. This is a building block, not a complete
/// queue handler: the caller must own and renew the job lease while it runs.
pub struct NativeRefundRecovery {
    store: MongoPlaybackStore,
    fulfillment: DimafxFulfillment<super::fulfillment::MongoDimafxInventory>,
}

impl NativeRefundRecovery {
    /// Bind existing clients without performing I/O.
    pub fn new(database: Database) -> Self {
        Self {
            store: MongoPlaybackStore::new(database.clone()),
            fulfillment: DimafxFulfillment::native(database),
        }
    }

    /// Persist the playback failure before attempting the one-shot refund.
    /// Storage and ownership failures are returned without crediting anyone.
    pub async fn fail_playback(&self, channel: &str, id: &str, owner: &str, failure: &str) -> Result<(), QueueStorageError> {
        if !self.store.transition(channel, id, owner, "playing", "refunding", Some(failure), DateTime::now()).await? {
            return Err(QueueStorageError("DimaFX playback lease or state lost".into()));
        }
        self.recover(channel, id, owner).await
    }

    /// Resume an already persisted `refunding` job. A failed inventory update
    /// or lost lease leaves the job recoverable. Repeated credits are prevented
    /// by the inventory service's atomic receipt guard.
    pub async fn recover(&self, channel: &str, id: &str, owner: &str) -> Result<(), QueueStorageError> {
        let job = self.store.existing(channel, id).await?.ok_or_else(|| QueueStorageError("DimaFX refund receipt unavailable".into()))?;
        if job.get_str("leaseOwner").ok() != Some(owner) || job.get_str("state").ok() != Some("refunding")
            || job.get_datetime("leaseUntil").map_or(true, |until| until.timestamp_millis() <= DateTime::now().timestamp_millis()) {
            return Err(QueueStorageError("DimaFX refund lease or state lost".into()));
        }
        let payload = job.get_document("payload").map_err(|_| QueueStorageError("Invalid DimaFX playback payload".into()))?;
        if let Some(refund) = refund_from_payload(payload)? {
            self.fulfillment.refund_dimafx_once(channel, refund.0, refund.1, &format!("refund:{id}"))
                .await.map_err(|error| QueueStorageError(error.to_string()))?;
        }
        if !self.store.transition(channel, id, owner, "refunding", "refunded", None, DateTime::now()).await? {
            return Err(QueueStorageError("DimaFX refund lease or state lost".into()));
        }
        Ok(())
    }
}

fn refund_from_payload(payload: &Document) -> Result<Option<(&str, f64)>, QueueStorageError> {
    use mongodb::bson::Bson;
    let Some(value) = payload.get("refundOnFailure") else { return Ok(None) };
    let refund = value.as_document().ok_or_else(|| QueueStorageError("Invalid DimaFX refund payload".into()))?;
    let user = refund.get_str("userID").map_err(|_| QueueStorageError("Invalid DimaFX refund user".into()))?;
    let amount = match refund.get("priceBits") {
        Some(Bson::Double(value)) => *value,
        Some(Bson::Int32(value)) => f64::from(*value),
        Some(Bson::Int64(value)) => *value as f64,
        _ => return Err(QueueStorageError("Invalid DimaFX refund amount".into())),
    };
    if !amount.is_finite() { return Err(QueueStorageError("Invalid DimaFX refund amount".into())); }
    Ok(Some((user, amount)))
}

#[cfg(test)]
mod delivery_store_tests {
    use super::*;
    #[test]
    fn head_query_excludes_only_terminal_states() {
        assert_eq!(live_filter("channel"), doc! { "channelID": "channel", "state": { "$nin": ["completed", "refunded"] } });
    }
    #[test]
    fn claim_requires_expired_lease_or_same_owner() {
        let now = DateTime::from_millis(42);
        assert_eq!(claim_filter("trigger", "owner", now), doc! { "_id": "trigger", "state": { "$nin": ["completed", "refunded"] }, "$or": [{ "leaseUntil": { "$lte": now } }, { "leaseOwner": "owner" }] });
    }
    #[test]
    fn refund_must_pass_through_refunding_and_terminal_states_cannot_reopen() {
        assert!(valid_transition("playing", "refunding"));
        assert!(valid_transition("refunding", "refunded"));
        assert!(!valid_transition("playing", "refunded"));
        assert!(!valid_transition("completed", "refunding"));
        assert!(!valid_transition("refunded", "playing"));
    }
    #[test]
    fn completion_filter_is_channel_owner_and_state_scoped() {
        assert_eq!(owned_filter("channel", "trigger", "owner", Some("playing")), doc! { "_id": "trigger", "channelID": "channel", "leaseOwner": "owner", "state": "playing" });
    }
    #[test]
    fn refund_payload_requires_valid_user_and_numeric_amount() {
        assert_eq!(refund_from_payload(&doc! {}).unwrap(), None);
        let payload = doc! { "refundOnFailure": { "userID": "viewer", "priceBits": 25 } };
        assert_eq!(refund_from_payload(&payload).unwrap(), Some(("viewer", 25.0)));
        assert!(refund_from_payload(&doc! { "refundOnFailure": { "userID": "viewer", "priceBits": "25" } }).is_err());
        assert!(refund_from_payload(&doc! { "refundOnFailure": { "priceBits": 25 } }).is_err());
        assert!(refund_from_payload(&doc! { "refundOnFailure": { "userID": "viewer", "priceBits": f64::NAN } }).is_err());
    }

    #[test]
    fn volume_uses_js_min_max_and_keeps_nan() {
        assert_eq!(clamp_volume(100.0), 100.0);
        assert_eq!(clamp_volume(140.0), 100.0);
        assert_eq!(clamp_volume(-5.0), 0.0);
        assert!(clamp_volume(f64::NAN).is_nan());
        assert_eq!(clamp_volume(f64::INFINITY), 100.0);
        assert_eq!(clamp_volume(-0.0).to_bits(), 0.0f64.to_bits());
    }

    #[test]
    fn duration_matches_source_or_zero() {
        assert_eq!(normalize_duration(0.0), 0.0);
        assert_eq!(normalize_duration(f64::NAN), 0.0);
        assert_eq!(normalize_duration(-5.0), 0.0);
        assert_eq!(normalize_duration(1_500.0), 1_500.0);
        assert_eq!(normalize_duration(f64::INFINITY), f64::INFINITY);
    }
}

/// Operations required by `processNext`; Mongo remains the production store.
/// `None` from claim means either an empty queue or an actively leased head.
pub trait DimafxDispatchStore: Send + Sync {
    fn claim<'a>(&'a self, channel: &'a str, owner: &'a str) -> impl Future<Output = Result<Option<Document>, QueueStorageError>> + Send + 'a;
    fn heartbeat<'a>(&'a self, channel: &'a str, id: &'a str, owner: &'a str) -> impl Future<Output = Result<bool, QueueStorageError>> + Send + 'a;
    fn change<'a>(&'a self, channel: &'a str, id: &'a str, owner: &'a str, from: &'a str, to: &'a str, failure: Option<&'a str>) -> impl Future<Output = Result<bool, QueueStorageError>> + Send + 'a;
    fn unlock<'a>(&'a self, channel: &'a str, id: &'a str, owner: &'a str) -> impl Future<Output = Result<bool, QueueStorageError>> + Send + 'a;
}
impl DimafxDispatchStore for MongoPlaybackStore {
    async fn claim(&self, channel: &str, owner: &str) -> Result<Option<Document>, QueueStorageError> { self.claim_head(channel, owner, DateTime::now()).await }
    async fn heartbeat(&self, channel: &str, id: &str, owner: &str) -> Result<bool, QueueStorageError> { self.renew(channel, id, owner, DateTime::now()).await }
    async fn change(&self, channel: &str, id: &str, owner: &str, from: &str, to: &str, failure: Option<&str>) -> Result<bool, QueueStorageError> { self.transition(channel, id, owner, from, to, failure, DateTime::now()).await }
    async fn unlock(&self, channel: &str, id: &str, owner: &str) -> Result<bool, QueueStorageError> { self.release(channel, id, owner, DateTime::now()).await }
}

/// Delivery errors represent actual playback failures; unavailable integrations
/// and storage/ownership failures must never be classified as refundable.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DimafxDispatchError {
    Playback(String),
    Unavailable(&'static str),
    Storage(QueueStorageError),
    LeaseLost,
    /// The caller cancelled processing or the last ready overlay disconnected.
    Cancelled,
}
impl From<QueueStorageError> for DimafxDispatchError {
    fn from(error: QueueStorageError) -> Self { Self::Storage(error) }
}

/// Application-specific socket/acknowledgement and refund integration. A
/// successful delivery must wait for acknowledgement or the playback timeout;
/// successful refund must atomically credit at most once and mark `refunded`.
/// Native socket actions require configured Piper and refund adapters.
pub trait DimafxDispatchActions: Send + Sync {
    fn connected<'a>(&'a self, channel: &'a str) -> impl Future<Output = Result<bool, DimafxDispatchError>> + Send + 'a;
    fn deliver<'a>(&'a self, channel: &'a str, job: &'a Document) -> impl Future<Output = Result<(), DimafxDispatchError>> + Send + 'a;
    fn refund<'a>(&'a self, channel: &'a str, id: &'a str, owner: &'a str) -> impl Future<Output = Result<(), DimafxDispatchError>> + Send + 'a;
}

/// A single instance must be shared by callers: its per-channel guard mirrors
/// TypeScript's `processingChannels`. Different instances coordinate through
/// the Mongo lease, and must use distinct owner IDs.
pub struct DimafxDispatcher<S, A> {
    store: S,
    actions: A,
    owner: String,
    channels: std::sync::Mutex<std::collections::HashSet<String>>,
}
struct DispatchChannelGuard<'a> {
    channels: &'a std::sync::Mutex<std::collections::HashSet<String>>,
    channel: String,
}
impl Drop for DispatchChannelGuard<'_> {
    fn drop(&mut self) {
        self.channels.lock().unwrap_or_else(|e| e.into_inner()).remove(&self.channel);
    }
}
impl<S, A> DimafxDispatcher<S, A> {
    /// Supply a unique owner per dispatcher, as well as deterministic test seams.
    pub fn with_parts(store: S, actions: A, owner: impl Into<String>) -> Self {
        Self { store, actions, owner: owner.into(), channels: std::sync::Mutex::new(std::collections::HashSet::new()) }
    }
}
impl<A> DimafxDispatcher<MongoPlaybackStore, A> {
    /// Bind the existing application database and a fresh process owner. The
    /// supplied actions must be wired to the application's providers.
    pub fn native(database: Database, actions: A) -> Self {
        Self::with_parts(MongoPlaybackStore::new(database), actions, uuid::Uuid::new_v4().to_string())
    }
}
impl<S: DimafxDispatchStore, A: DimafxDispatchActions> DimafxDispatcher<S, A> {
    /// Drain ready work immediately until disconnected, idle, or a busy head.
    /// Errors are returned for the host to log (the source catches and logs).
    pub async fn process_next(&self, channel: &str) -> Result<(), DimafxDispatchError> {
        self.process_next_inner(channel, None).await
    }

    /// Cooperatively stop delivery and release the lease when cancellation is
    /// requested. Dropping this future outright cannot guarantee async release.
    pub async fn process_next_with_cancel(&self, channel: &str, cancel: &mut tokio::sync::watch::Receiver<bool>) -> Result<(), DimafxDispatchError> {
        self.process_next_inner(channel, Some(cancel)).await
    }

    async fn process_next_inner(&self, channel: &str, mut cancel: Option<&mut tokio::sync::watch::Receiver<bool>>) -> Result<(), DimafxDispatchError> {
        {
            let mut channels = self.channels.lock().unwrap_or_else(|e| e.into_inner());
            if !channels.insert(channel.to_owned()) { return Ok(()); }
        }
        let _guard = DispatchChannelGuard { channels: &self.channels, channel: channel.to_owned() };
        while self.actions.connected(channel).await? {
            if cancel.as_ref().is_some_and(|receiver| *receiver.borrow()) { return Err(DimafxDispatchError::Cancelled); }
            let Some(job) = self.store.claim(channel, &self.owner).await? else { return Ok(()) };
            let id = job.get_str("_id").map_err(|_| QueueStorageError("Invalid DimaFX playback ID".into()))?;
            // Both the operation and release are attempted, as in source finally.
            let result = if let Some(receiver) = cancel.as_deref_mut() {
                tokio::select! {
                    biased;
                    _ = wait_for_cancellation(receiver) => Err(DimafxDispatchError::Cancelled),
                    result = self.run_claimed(channel, id, &job) => result,
                }
            } else { self.run_claimed(channel, id, &job).await };
            let release = self.store.unlock(channel, id, &self.owner).await;
            if let Err(error) = release { return Err(error.into()); }
            result?;
        }
        Ok(())
    }

    async fn run_claimed(&self, channel: &str, id: &str, job: &Document) -> Result<(), DimafxDispatchError> {
        let operation = self.process_claimed(channel, id, job);
        tokio::pin!(operation);
        let mut heartbeat = tokio::time::interval_at(
            tokio::time::Instant::now() + std::time::Duration::from_millis(LEASE_HEARTBEAT_MS),
            std::time::Duration::from_millis(LEASE_HEARTBEAT_MS),
        );
        loop {
            tokio::select! {
                biased;
                _ = heartbeat.tick() => {
                    if !self.store.heartbeat(channel, id, &self.owner).await? { return Err(DimafxDispatchError::LeaseLost); }
                }
                result = &mut operation => return result,
            }
        }
    }

    async fn process_claimed(&self, channel: &str, id: &str, job: &Document) -> Result<(), DimafxDispatchError> {
        let state = job.get_str("state").map_err(|_| QueueStorageError("Invalid DimaFX playback state".into()))?;
        if state == "refunding" { return self.actions.refund(channel, id, &self.owner).await; }
        if !self.store.change(channel, id, &self.owner, state, "playing", None).await? { return Err(DimafxDispatchError::LeaseLost); }
        match self.actions.deliver(channel, job).await {
            Ok(()) => {
                if !self.actions.connected(channel).await? { return Ok(()); }
                if !self.store.change(channel, id, &self.owner, "playing", "completed", None).await? { return Err(DimafxDispatchError::LeaseLost); }
            }
            Err(DimafxDispatchError::Playback(failure)) => {
                if !self.actions.connected(channel).await? { return Ok(()); }
                if !self.store.change(channel, id, &self.owner, "playing", "refunding", Some(&failure)).await? { return Err(DimafxDispatchError::LeaseLost); }
                self.actions.refund(channel, id, &self.owner).await?;
            }
            Err(error) => return Err(error),
        }
        Ok(())
    }
}

async fn wait_for_cancellation(receiver: &mut tokio::sync::watch::Receiver<bool>) {
    loop {
        if *receiver.borrow_and_update() { return; }
        if receiver.changed().await.is_err() { std::future::pending::<()>().await; }
    }
}

type DeliveryWaiters = std::sync::Arc<std::sync::Mutex<std::collections::HashMap<String, DeliveryWaiter>>>;
struct DeliveryWaiter {
    trigger: String,
    generation: uuid::Uuid,
    done: tokio::sync::oneshot::Sender<()>,
}
struct DeliveryWaiterGuard {
    waiters: DeliveryWaiters,
    channel: String,
    generation: uuid::Uuid,
}
impl Drop for DeliveryWaiterGuard {
    fn drop(&mut self) {
        let mut waiters = self.waiters.lock().unwrap_or_else(|e| e.into_inner());
        if waiters.get(&self.channel).is_some_and(|entry| entry.generation == self.generation) {
            waiters.remove(&self.channel);
        }
    }
}

/// Real ready-socket delivery. Construct once and share the same instance with
/// the dispatcher used by the overlay callbacks. TTS and refund return
/// unavailable until their application adapters are supplied.
#[derive(Clone, Default)]
pub struct DimafxSocketActions {
    sockets: super::overlay_service::DimafxReadySockets,
    waiters: DeliveryWaiters,
    refund: Option<std::sync::Arc<NativeRefundRecovery>>,
    #[cfg(feature = "tts-services")]
    piper: Option<crate::tts_services::piper_tts::PiperTtsService>,
}
impl DimafxSocketActions {
    pub fn new(sockets: super::overlay_service::DimafxReadySockets) -> Self {
        Self { sockets, ..Self::default() }
    }

    /// Connect the existing idempotent refund implementation to this dispatcher.
    pub fn with_refund_recovery(mut self, database: Database) -> Self {
        self.refund = Some(std::sync::Arc::new(NativeRefundRecovery::new(database)));
        self
    }

    /// Use the application's configured native Piper provider.
    #[cfg(feature = "tts-services")]
    pub fn with_piper(mut self, piper: crate::tts_services::piper_tts::PiperTtsService) -> Self {
        self.piper = Some(piper);
        self
    }

    fn subscribe(&self, channel: &str, trigger: &str) -> Result<(tokio::sync::oneshot::Receiver<()>, DeliveryWaiterGuard), DimafxDispatchError> {
        let mut waiters = self.waiters.lock().unwrap_or_else(|e| e.into_inner());
        if waiters.contains_key(channel) { return Err(DimafxDispatchError::Unavailable("delivery already active")); }
        let (done, receiver) = tokio::sync::oneshot::channel();
        let generation = uuid::Uuid::new_v4();
        waiters.insert(channel.to_owned(), DeliveryWaiter { trigger: trigger.to_owned(), generation, done });
        Ok((receiver, DeliveryWaiterGuard { waiters: self.waiters.clone(), channel: channel.to_owned(), generation }))
    }

    fn acknowledge(&self, channel: &str, trigger: &str) {
        let mut waiters = self.waiters.lock().unwrap_or_else(|e| e.into_inner());
        if waiters.get(channel).is_some_and(|entry| entry.trigger == trigger) {
            if let Some(entry) = waiters.remove(channel) { let _ = entry.done.send(()); }
        }
    }
}

fn delivery_number(value: Option<&mongodb::bson::Bson>) -> Option<f64> {
    use mongodb::bson::Bson;
    match value { Some(Bson::Double(v)) => Some(*v), Some(Bson::Int32(v)) => Some(f64::from(*v)), Some(Bson::Int64(v)) => Some(*v as f64), _ => None }
}

fn delivery_body(channel: &str, job: &Document, synthesized: Option<(&str, &str, u64, &str)>) -> Result<(String, serde_json::Value, u64), DimafxDispatchError> {
    let invalid = || DimafxDispatchError::Storage(QueueStorageError("Invalid DimaFX delivery payload".into()));
    let id = job.get_str("_id").map_err(|_| invalid())?;
    let payload = job.get_document("payload").map_err(|_| invalid())?;
    let trigger = payload.get_str("triggerID").map_err(|_| invalid())?;
    if trigger != id || payload.get_str("channelID").ok() != Some(channel) { return Err(invalid()); }
    if payload.contains_key("tts") && synthesized.is_none() { return Err(DimafxDispatchError::Unavailable("TTS delivery and cleanup")); }
    let url = synthesized.map(|value| value.0).or_else(|| payload.get_str("mediaUrl").ok()).filter(|url| !url.is_empty())
        .ok_or_else(|| DimafxDispatchError::Playback("DimaFX trigger has no media URL".into()))?;
    let media_type = synthesized.map(|value| value.1).or_else(|| payload.get_str("mediaType").ok()).filter(|value| !value.is_empty()).unwrap_or("video/mp4");
    let category = payload.get_str("category").map_err(|_| invalid())?;
    let duration = delivery_number(payload.get("durationMs")).ok_or_else(invalid)?;
    let volume = delivery_number(payload.get("volume")).ok_or_else(invalid)?;
    let mut body = serde_json::json!({
        "url": url, "mediaType": media_type, "volume": volume, "source": "dimafx",
        "itemID": payload.get_str("itemID").map_err(|_| invalid())?,
        "triggerID": trigger, "name": payload.get_str("name").map_err(|_| invalid())?,
    });
    if let Some((_, _, _, text)) = synthesized { body["text"] = serde_json::Value::String(text.to_owned()); }
    let base = if duration > 0.0 { duration } else if category == "gif" || media_type.starts_with("image") { DEFAULT_IMAGE_WAIT_MS as f64 } else { DEFAULT_MEDIA_WAIT_MS as f64 };
    let wait = synthesized.map(|value| value.2).unwrap_or_else(|| (base + PLAYBACK_GRACE_MS as f64).ceil().clamp(MIN_PLAYBACK_WAIT_MS as f64, MAX_PLAYBACK_WAIT_MS as f64) as u64);
    Ok((trigger.to_owned(), body, wait))
}

impl DimafxDispatchActions for DimafxSocketActions {
    async fn connected(&self, channel: &str) -> Result<bool, DimafxDispatchError> {
        Ok(!self.sockets.for_channel(channel).is_empty())
    }
    async fn deliver(&self, channel: &str, job: &Document) -> Result<(), DimafxDispatchError> {
        #[cfg(feature = "tts-services")]
        let prepared = if let Ok(payload) = job.get_document("payload") {
            if let Some(value) = payload.get("tts") {
                let invalid = || DimafxDispatchError::Storage(QueueStorageError("Invalid DimaFX TTS payload".into()));
                let tts = value.as_document().ok_or_else(invalid)?;
                let text = tts.get_str("text").map_err(|_| invalid())?;
                let voice = tts.get_str("voice").map_err(|_| invalid())?;
                let language = match tts.get_str("language").map_err(|_| invalid())? {
                    "en" => DimafxQueueLanguage::En, "es" => DimafxQueueLanguage::Es,
                    _ => return Err(invalid()),
                };
                let trigger = job.get_str("_id").map_err(|_| invalid())?;
                if payload.get_str("triggerID").ok() != Some(trigger) || payload.get_str("channelID").ok() != Some(channel) { return Err(invalid()); }
                let piper = self.piper.as_ref().ok_or(DimafxDispatchError::Unavailable("TTS provider"))?;
                let request = DimafxQueueTts { text: JsString::from(text), voice: JsString::from(voice), language };
                Some((prepare_dimafx_tts(piper, channel, trigger, &request).await.map_err(|error| DimafxDispatchError::Playback(error.0))?, text.to_owned()))
            } else { None }
        } else { None };
        #[cfg(feature = "tts-services")]
        let synthesized = prepared.as_ref().map(|(audio, text)| (audio.public_path.as_str(), audio.media_type, audio.wait_ms, text.as_str()));
        #[cfg(not(feature = "tts-services"))]
        let synthesized = None;
        let (trigger, body, wait_ms) = delivery_body(channel, job, synthesized)?;
        let (mut done, _guard) = self.subscribe(channel, &trigger)?;
        let emit = || {
            let sockets = self.sockets.for_channel(channel);
            for socket in &sockets { let _ = socket.emit("dimafx-play", &body); }
            !sockets.is_empty()
        };
        if !emit() { return Err(DimafxDispatchError::Cancelled); }
        let deadline = tokio::time::sleep(std::time::Duration::from_millis(wait_ms));
        tokio::pin!(deadline);
        let mut retry = tokio::time::interval_at(tokio::time::Instant::now() + std::time::Duration::from_millis(REDELIVERY_INTERVAL_MS), std::time::Duration::from_millis(REDELIVERY_INTERVAL_MS));
        retry.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        loop {
            tokio::select! {
                result = &mut done => return result.map_err(|_| DimafxDispatchError::Cancelled),
                _ = &mut deadline => return if self.sockets.for_channel(channel).is_empty() { Err(DimafxDispatchError::Cancelled) } else { Ok(()) },
                _ = retry.tick() => if !emit() { return Err(DimafxDispatchError::Cancelled); },
            }
        }
    }
    async fn refund(&self, channel: &str, id: &str, owner: &str) -> Result<(), DimafxDispatchError> {
        self.refund.as_ref().ok_or(DimafxDispatchError::Unavailable("refund application adapter"))?
            .recover(channel, id, owner).await.map_err(DimafxDispatchError::Storage)
    }
}

/// Overlay callbacks and dispatch must use the same dispatcher and ready-socket
/// registry. The callback only wakes the matching delivery; the processing
/// task persists completion under its active lease before taking another job.
impl<S: DimafxDispatchStore + 'static> super::overlay_service::OverlayQueue for DimafxDispatcher<S, DimafxSocketActions> {
    fn resume_if_idle<'a>(&'a self, channel: &'a str) -> super::overlay_service::OverlayFuture<'a> {
        Box::pin(async move { self.process_next(channel).await.map_err(|error| format!("{error:?}")) })
    }
    fn handle_trigger_ended<'a>(&'a self, channel: &'a str, trigger: &'a str) -> super::overlay_service::OverlayFuture<'a> {
        Box::pin(async move { self.actions.acknowledge(channel, trigger); Ok(()) })
    }
}

/// One application-owned instance joins enqueue, overlay polling and socket
/// acknowledgements to the same dispatcher and ready-socket registry.
pub struct DimafxComposition<S, P, T, I, D> {
    enqueue: DimafxEnqueueHandler<S, P, T, I>,
    dispatcher: std::sync::Arc<D>,
}

impl<S, P, T, I, D> DimafxComposition<S, P, T, I, D> {
    pub fn with_parts(enqueue: DimafxEnqueueHandler<S, P, T, I>, dispatcher: std::sync::Arc<D>) -> Self {
        Self { enqueue, dispatcher }
    }

    pub fn dispatcher(&self) -> std::sync::Arc<D> { self.dispatcher.clone() }
}

impl<S, P, T, I, D> DimafxComposition<S, P, T, I, D>
where
    S: DimafxEnqueueStore,
    P: DimafxOverlayPresence,
    T: DimafxTtsVoiceSource,
    I: DimafxEnqueueIds,
    D: super::overlay_service::OverlayQueue + 'static,
{
    /// A successful enqueue schedules processing without waiting for playback.
    /// Existing receipts follow the source's early return without a wake.
    pub async fn enqueue(&self, input: DimafxEnqueueInput) -> Result<DimafxEnqueueResult, DimafxEnqueueError> {
        let dispatcher = self.dispatcher.clone();
        self.enqueue.enqueue_with_wake(input, move |channel| {
            tokio::spawn(async move {
                if let Err(error) = dispatcher.resume_if_idle(&channel).await {
                    eprintln!("DimaFX queue resume failed: {error}");
                }
            });
        }).await
    }
}

impl<S, T, I, D> DimafxComposition<S, super::overlay_service::DimafxReadySockets, T, I, D> {
    pub(crate) fn ready_sockets(&self) -> super::overlay_service::DimafxReadySockets {
        self.enqueue.presence.clone()
    }
}

#[cfg(feature = "tts-services")]
pub type NativeDimafxComposition = DimafxComposition<
    MongoPlaybackStore, super::overlay_service::DimafxReadySockets,
    MongoDimafxTtsVoiceSource, SystemEnqueueIds,
    DimafxDispatcher<MongoPlaybackStore, DimafxSocketActions>,
>;

#[cfg(feature = "tts-services")]
impl NativeDimafxComposition {
    /// Construct once per application process and share with every caller.
    pub fn native(database: Database, api_url: impl Into<String>, piper: crate::tts_services::piper_tts::PiperTtsService) -> Self {
        let sockets = super::overlay_service::DimafxReadySockets::default();
        let actions = DimafxSocketActions::new(sockets.clone())
            .with_refund_recovery(database.clone()).with_piper(piper);
        let dispatcher = std::sync::Arc::new(DimafxDispatcher::native(database.clone(), actions));
        Self::with_parts(DimafxEnqueueHandler::native(database, sockets, api_url), dispatcher)
    }


}

/// Application-owned queue, recovery, and overlay share one socket registry.
#[cfg(feature = "tts-services")]
pub struct NativeDimafxApplication {
    queue: std::sync::Arc<NativeDimafxComposition>,
    recovery: std::sync::Arc<super::purchase_recovery::MongoPurchaseRecovery<MongoPlaybackStore, MongoDimafxTtsVoiceSource, SystemEnqueueIds, DimafxDispatcher<MongoPlaybackStore, DimafxSocketActions>>>,
}
#[cfg(feature = "tts-services")]
impl NativeDimafxApplication {
    pub fn new(database: Database, api_url: impl Into<String>, piper: crate::tts_services::piper_tts::PiperTtsService) -> Self {
        let queue = std::sync::Arc::new(NativeDimafxComposition::native(database.clone(), api_url, piper));
        let recovery = std::sync::Arc::new(super::purchase_recovery::MongoPurchaseRecovery::new(database, queue.clone()));
        Self { queue, recovery }
    }
    pub fn queue(&self) -> std::sync::Arc<NativeDimafxComposition> { self.queue.clone() }
    pub fn register_overlay(&self, io: &socketioxide::SocketIo, secret: Option<String>) -> Result<(), socketioxide::NsInsertError> {
        super::overlay_service::register_dimafx_overlay(io, secret, self.queue.dispatcher.clone(), self.recovery.clone(), self.queue.ready_sockets())
    }
}

#[cfg(test)]
mod dimafx_delivery_completion_tests {
    use super::*;

    #[test]
    fn synthesized_delivery_replaces_media_and_includes_spoken_text() {
        let job = doc! { "_id": "t", "payload": {
            "triggerID": "t", "channelID": "c", "itemID": "i", "name": "voice",
            "category": "tts", "mediaType": "audio/wav", "volume": 42,
            "durationMs": 999, "tts": { "text": "hello", "voice": "v", "language": "en" }
        }};
        let (id, body, wait) = delivery_body("c", &job, Some(("/speech/t", "audio/wav", 3_250, "hello"))).unwrap();
        assert_eq!(id, "t");
        assert_eq!(wait, 3_250);
        assert_eq!(body, serde_json::json!({"url": "/speech/t", "mediaType": "audio/wav", "volume": 42.0,
            "source": "dimafx", "itemID": "i", "triggerID": "t", "name": "voice", "text": "hello"}));
    }

    #[test]
    fn synthesized_delivery_still_rejects_wrong_identity() {
        let job = doc! { "_id": "t", "payload": { "triggerID": "other", "channelID": "c" } };
        assert!(matches!(delivery_body("c", &job, Some(("/speech/t", "audio/wav", 2000, "hello"))), Err(DimafxDispatchError::Storage(_))));
    }
}

#[cfg(test)]
mod dimafx_dispatch_delivery_tests {
    use super::*;
    use tokio::sync::oneshot::error::TryRecvError;

    fn job() -> Document {
        doc! { "_id": "trigger", "payload": {
            "triggerID": "trigger", "channelID": "channel", "itemID": "item",
            "name": "Example", "category": "gif", "mediaUrl": "/asset",
            "mediaType": "image/gif", "volume": 35.0, "durationMs": 0.0
        }}
    }

    #[test]
    fn body_and_image_timeout_match_source() {
        let (trigger, body, wait) = delivery_body("channel", &job(), None).unwrap();
        assert_eq!(trigger, "trigger");
        assert_eq!(body, serde_json::json!({ "url": "/asset", "mediaType": "image/gif", "volume": 35.0, "source": "dimafx", "itemID": "item", "triggerID": "trigger", "name": "Example" }));
        assert_eq!(wait, 5_750);
    }

    #[test]
    fn invalid_identity_and_missing_or_unimplemented_media_are_distinct() {
        assert!(matches!(delivery_body("another", &job(), None), Err(DimafxDispatchError::Storage(_))));
        let mut missing = job();
        missing.get_document_mut("payload").unwrap().remove("mediaUrl");
        assert_eq!(delivery_body("channel", &missing, None), Err(DimafxDispatchError::Playback("DimaFX trigger has no media URL".into())));
        missing.get_document_mut("payload").unwrap().insert("tts", doc! { "text": "hello" });
        assert_eq!(delivery_body("channel", &missing, None), Err(DimafxDispatchError::Unavailable("TTS delivery and cleanup")));
    }

    #[test]
    fn acknowledgement_requires_both_channel_and_trigger_and_guard_cleans_up() {
        let actions = DimafxSocketActions::default();
        let (mut done, guard) = actions.subscribe("channel", "trigger").unwrap();
        actions.acknowledge("other", "trigger");
        actions.acknowledge("channel", "other");
        assert_eq!(done.try_recv(), Err(TryRecvError::Empty));
        assert!(matches!(actions.subscribe("channel", "second"), Err(DimafxDispatchError::Unavailable(_))));
        actions.acknowledge("channel", "trigger");
        assert_eq!(done.try_recv(), Ok(()));
        let (mut next, next_guard) = actions.subscribe("channel", "second").unwrap();
        drop(guard);
        actions.acknowledge("channel", "second");
        assert_eq!(next.try_recv(), Ok(()));
        drop(next_guard);
        let (mut cancelled, guard) = actions.subscribe("channel", "third").unwrap();
        drop(guard);
        assert_eq!(cancelled.try_recv(), Err(TryRecvError::Closed));
    }

    #[tokio::test]
    async fn typed_cancellation_wakes_only_when_requested() {
        let (sender, mut receiver) = tokio::sync::watch::channel(false);
        let waiting = wait_for_cancellation(&mut receiver);
        tokio::pin!(waiting);
        tokio::select! { _ = &mut waiting => panic!("cancelled too early"), _ = tokio::task::yield_now() => {} }
        sender.send(true).unwrap();
        waiting.await;
    }
}

#[cfg(test)]
mod dimafx_dispatch_loop_tests {
    use super::*;
    use std::collections::VecDeque;
    use std::sync::{Arc, Mutex};
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};

    #[derive(Default)]
    struct State { jobs: VecDeque<Document>, owner: Option<String>, claims: usize, completed: usize }
    #[derive(Clone, Default)]
    struct Store(Arc<Mutex<State>>, Arc<AtomicBool>);
    impl DimafxDispatchStore for Store {
        async fn claim(&self, _: &str, owner: &str) -> Result<Option<Document>, QueueStorageError> {
            let mut state = self.0.lock().unwrap();
            state.claims += 1;
            if state.owner.is_some() || state.jobs.is_empty() { return Ok(None); }
            state.owner = Some(owner.to_owned());
            Ok(state.jobs.front().cloned())
        }
        async fn heartbeat(&self, _: &str, _: &str, _: &str) -> Result<bool, QueueStorageError> { Ok(!self.1.load(Ordering::SeqCst)) }
        async fn change(&self, _: &str, _: &str, owner: &str, from: &str, to: &str, _: Option<&str>) -> Result<bool, QueueStorageError> {
            let mut state = self.0.lock().unwrap();
            if state.owner.as_deref() != Some(owner) { return Ok(false); }
            let job = state.jobs.front_mut().unwrap();
            if job.get_str("state").ok() != Some(from) { return Ok(false); }
            job.insert("state", to);
            if to == "completed" { state.jobs.pop_front(); state.completed += 1; }
            Ok(true)
        }
        async fn unlock(&self, _: &str, _: &str, owner: &str) -> Result<bool, QueueStorageError> {
            let mut state = self.0.lock().unwrap();
            if state.owner.as_deref() != Some(owner) { return Ok(false); }
            state.owner = None;
            Ok(true)
        }
    }
    #[derive(Clone, Default)]
    struct Actions { deliveries: Arc<AtomicUsize>, block: Arc<AtomicBool> }
    impl DimafxDispatchActions for Actions {
        async fn connected(&self, _: &str) -> Result<bool, DimafxDispatchError> { Ok(true) }
        async fn deliver(&self, _: &str, _: &Document) -> Result<(), DimafxDispatchError> {
            self.deliveries.fetch_add(1, Ordering::SeqCst);
            if self.block.load(Ordering::SeqCst) { std::future::pending::<()>().await; }
            Ok(())
        }
        async fn refund(&self, _: &str, _: &str, _: &str) -> Result<(), DimafxDispatchError> { Err(DimafxDispatchError::Unavailable("refund")) }
    }
    fn job(id: &str) -> Document { doc! { "_id": id, "state": "queued", "payload": {} } }

    #[tokio::test]
    async fn idle_returns_after_one_claim() {
        let store = Store::default();
        let dispatcher = DimafxDispatcher::with_parts(store.clone(), Actions::default(), "owner");
        dispatcher.process_next("channel").await.unwrap();
        assert_eq!(store.0.lock().unwrap().claims, 1);
    }
    #[tokio::test]
    async fn ready_backlog_drains_without_a_per_item_wait() {
        let store = Store::default();
        store.0.lock().unwrap().jobs.extend([job("one"), job("two")]);
        let actions = Actions::default();
        let dispatcher = DimafxDispatcher::with_parts(store.clone(), actions.clone(), "owner");
        tokio::time::timeout(std::time::Duration::from_secs(1), dispatcher.process_next("channel")).await.unwrap().unwrap();
        assert_eq!(store.0.lock().unwrap().completed, 2);
        assert_eq!(actions.deliveries.load(Ordering::SeqCst), 2);
    }
    #[tokio::test]
    async fn concurrent_dispatchers_do_not_claim_same_live_head() {
        let store = Store::default();
        store.0.lock().unwrap().jobs.push_back(job("one"));
        let actions = Actions::default();
        actions.block.store(true, Ordering::SeqCst);
        let first = DimafxDispatcher::with_parts(store.clone(), actions.clone(), "first");
        let second = DimafxDispatcher::with_parts(store.clone(), actions.clone(), "second");
        let first_run = first.process_next("channel");
        tokio::pin!(first_run);
        tokio::select! { _ = &mut first_run => panic!("first delivery unexpectedly ended"), _ = tokio::task::yield_now() => {} }
        second.process_next("channel").await.unwrap();
        assert_eq!(actions.deliveries.load(Ordering::SeqCst), 1);
        assert_eq!(store.0.lock().unwrap().owner.as_deref(), Some("first"));
    }
    #[tokio::test]
    async fn heartbeat_lease_loss_stops_delivery_without_completion_or_refund() {
        let store = Store::default();
        store.0.lock().unwrap().jobs.push_back(job("one"));
        store.1.store(true, Ordering::SeqCst);
        let actions = Actions::default();
        actions.block.store(true, Ordering::SeqCst);
        let dispatcher = DimafxDispatcher::with_parts(store.clone(), actions, "owner");
        assert_eq!(dispatcher.process_next("channel").await, Err(DimafxDispatchError::LeaseLost));
        let state = store.0.lock().unwrap();
        assert_eq!(state.completed, 0);
        assert_eq!(state.jobs.front().unwrap().get_str("state").unwrap(), "playing");
    }
    #[tokio::test]
    async fn dimafx_composition_cancellation_releases_owned_job_for_retry() {
        let store = Store::default();
        store.0.lock().unwrap().jobs.push_back(job("one"));
        let actions = Actions::default();
        actions.block.store(true, Ordering::SeqCst);
        let dispatcher = DimafxDispatcher::with_parts(store.clone(), actions.clone(), "owner");
        let (send, mut cancel) = tokio::sync::watch::channel(false);
        let run = dispatcher.process_next_with_cancel("channel", &mut cancel);
        tokio::pin!(run);
        tokio::select! { _ = &mut run => panic!("delivery ended"), _ = tokio::task::yield_now() => {} }
        send.send(true).unwrap();
        assert_eq!(run.await, Err(DimafxDispatchError::Cancelled));
        assert_eq!(store.0.lock().unwrap().owner, None);
        actions.block.store(false, Ordering::SeqCst);
        dispatcher.process_next("channel").await.unwrap();
        assert_eq!(store.0.lock().unwrap().completed, 1);
    }
    #[test]
    fn dimafx_composition_shares_dispatcher_instance() {
        let dispatcher = Arc::new(DimafxDispatcher::with_parts(Store::default(), Actions::default(), "owner"));
        let composition = DimafxComposition::with_parts(
            DimafxEnqueueHandler::with_parts((), (), (), (), ""), dispatcher.clone(),
        );
        assert!(Arc::ptr_eq(&dispatcher, &composition.dispatcher()));
    }
}
