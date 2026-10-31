//! Source-parity checks for `DimafxQueueHandler.enqueue` in
//! `dimafx_queue.handler.ts`.
//!
//! The cases mirror the source method's order of operations, its payload
//! shape, and its status rejections. Collaborators are in-memory recordings:
//! no live Mongo, Redis, socket server, TTS provider or dispatch/scheduling is
//! used. The production Mongo receipt store is exercised through the same
//! [`DimafxEnqueueStore`] contract the handler consumes; its own filter tests
//! live beside it in `src/dimafx/queue_handler.rs`.

#![cfg(feature = "dimafx-delivery")]

use dima_rust::dimafx_delivery::queue_handler::{
    clamp_volume, normalize_duration, DimafxEnqueueError, DimafxEnqueueHandler, DimafxEnqueueIds,
    DimafxEnqueueInput, DimafxEnqueueRejection, DimafxEnqueueResult, DimafxEnqueueStore,
    DimafxOverlayPresence, DimafxQueueReceipt, DimafxTtsError, DimafxTtsVoiceSource,
    QueueStorageError, DISCONNECTED_MESSAGE, DISCONNECTED_STATUS, MAX_QUEUE_ITEMS,
    MISSING_MEDIA_MESSAGE, MISSING_MEDIA_STATUS, QUEUE_FULL_MESSAGE, QUEUE_FULL_STATUS,
    TTS_TEXT_REQUIRED_MESSAGE, TTS_TEXT_REQUIRED_STATUS,
};
use dima_rust::schemas::{
    channel_extension_item::{
        ChannelExtensionItemCategory, ChannelExtensionItemTtsConfig,
        ChannelExtensionItemTtsLanguage, ChannelExtensionItemTtsMode, IChannelExtensionItem,
    },
    dimafx_playback::{
        DimafxQueueItem, DimafxQueueLanguage, DimafxQueueRefund, DimafxQueueSource, DimafxQueueTts,
    },
    media_asset::{
        IMediaAsset, MediaAssetMarketplaceStatus, MediaAssetScope, MediaAssetThumbnailStatus,
        MediaAssetType,
    },
};
use dima_rust::utils::js_string::JsString;
use mongodb::bson::{DateTime, Document, oid::ObjectId};
use std::{
    collections::VecDeque,
    future::Future,
    sync::{
        atomic::{AtomicUsize, Ordering},
        Arc, Mutex,
    },
};

const ITEM_ID: &str = "64b000000000000000000001";
const ASSET_ID: &str = "64b000000000000000000002";
const CHANNEL: &str = "channel";
const CHANNEL_NAME: &str = "Channel";
const API_URL: &str = "https://api.test";
const NOW_MS: f64 = 1_700_000_000_123.0;

fn run<T>(future: impl Future<Output = T>) -> T {
    tokio::runtime::Builder::new_current_thread()
        .build()
        .expect("test runtime")
        .block_on(future)
}

fn object_id(value: &str) -> ObjectId {
    ObjectId::parse_str(value).expect("fixture ObjectId")
}

fn item(
    category: ChannelExtensionItemCategory,
    tts: Option<ChannelExtensionItemTtsConfig>,
) -> IChannelExtensionItem {
    IChannelExtensionItem {
        id: object_id(ITEM_ID),
        channel_id: CHANNEL.into(),
        channel_name: CHANNEL_NAME.into(),
        created_by_user_id: "owner".into(),
        asset_id: None,
        name: "Test item".into(),
        description: String::new().into(),
        category,
        media_type: MediaAssetType::Video,
        thumbnail_url: String::new().into(),
        duration_ms: 0.0,
        bits_price: 25.0,
        sku: "sku".into(),
        volume: 100.0,
        is_enabled: true,
        sort_order: 0.0,
        tts,
        deleted_at: None,
        created_at: DateTime::from_millis(0),
        updated_at: DateTime::from_millis(0),
    }
}

fn asset(mime_type: &str) -> IMediaAsset {
    IMediaAsset {
        id: object_id(ASSET_ID),
        legacy_trigger_file_id: None,
        owner_user_id: "owner".into(),
        owner_channel_id: CHANNEL.into(),
        owner_channel_name: CHANNEL_NAME.into(),
        uploaded_by_user_id: "owner".into(),
        original_name: "clip.mp4".into(),
        display_name: "clip".into(),
        file_name: "clip.mp4".into(),
        extension: "mp4".into(),
        mime_type: mime_type.into(),
        media_type: MediaAssetType::Video,
        bytes: 1_024.0,
        bucket: "media".into(),
        s3_key: "library/video/clip.mp4".into(),
        storage_url: "https://cdn.test/clip.mp4".into(),
        proxy_path: None,
        scope: MediaAssetScope::Public,
        marketplace_status: MediaAssetMarketplaceStatus::Published,
        checksum_sha256: None,
        thumbnail_asset_id: None,
        thumbnail_status: MediaAssetThumbnailStatus::Skipped,
        thumbnail_attempts: 0.0,
        thumbnail_last_error: None,
        library_count: 1.0,
        trigger_reference_count: 0.0,
        alert_reference_count: 0.0,
        extension_reference_count: 1.0,
        deleted_at: None,
        created_at: DateTime::from_millis(0),
        updated_at: DateTime::from_millis(0),
    }
}

fn tts_config(
    mode: ChannelExtensionItemTtsMode,
    text: &str,
    voice: &str,
    language: ChannelExtensionItemTtsLanguage,
) -> ChannelExtensionItemTtsConfig {
    ChannelExtensionItemTtsConfig {
        mode,
        text: text.into(),
        voice: voice.into(),
        language,
    }
}

fn media_input(trigger: Option<&str>) -> DimafxEnqueueInput {
    DimafxEnqueueInput {
        channel_id: CHANNEL.into(),
        trigger_id: trigger.map(Into::into),
        item: item(ChannelExtensionItemCategory::Video, None),
        asset: Some(asset("video/mp4")),
        viewer_text: None,
        refund_on_failure: Some(DimafxQueueRefund {
            user_id: "viewer".into(),
            price_bits: 25.0,
        }),
        source: DimafxQueueSource::BitsPurchase,
    }
}

#[derive(Clone, Debug)]
struct InsertedReceipt {
    channel: String,
    trigger: String,
    payload: Document,
    now: DateTime,
}

#[derive(Default)]
struct StoreState {
    receipts: Vec<(String, String)>,
    live_length: u64,
    existing_calls: usize,
    length_calls: usize,
    inserted: Vec<InsertedReceipt>,
    fail_existing: Option<String>,
    fail_length: Option<String>,
    fail_insert: Option<String>,
    race_same_channel: bool,
}

#[derive(Clone, Default)]
struct RecordingStore {
    state: Arc<Mutex<StoreState>>,
}

impl RecordingStore {
    fn seed_receipt(&self, channel: &str, trigger: &str, live_length: u64) {
        let mut state = self.state.lock().unwrap();
        state.receipts.push((channel.into(), trigger.into()));
        state.live_length = live_length;
    }

    fn set_live_length(&self, live_length: u64) {
        self.state.lock().unwrap().live_length = live_length;
    }

    fn fail_existing(&self, message: &str) {
        self.state.lock().unwrap().fail_existing = Some(message.into());
    }

    fn fail_length(&self, message: &str) {
        self.state.lock().unwrap().fail_length = Some(message.into());
    }

    fn fail_insert(&self, message: &str) {
        self.state.lock().unwrap().fail_insert = Some(message.into());
    }

    fn race_same_channel(&self) {
        self.state.lock().unwrap().race_same_channel = true;
    }

    fn existing_calls(&self) -> usize {
        self.state.lock().unwrap().existing_calls
    }

    fn length_calls(&self) -> usize {
        self.state.lock().unwrap().length_calls
    }

    fn inserted(&self) -> Vec<InsertedReceipt> {
        self.state.lock().unwrap().inserted.clone()
    }
}

impl DimafxEnqueueStore for RecordingStore {
    fn receipt_exists<'a>(
        &'a self,
        channel: &'a str,
        trigger: &'a str,
    ) -> impl Future<Output = Result<bool, QueueStorageError>> + Send + 'a {
        async move {
            let mut state = self.state.lock().unwrap();
            state.existing_calls += 1;
            if let Some(error) = &state.fail_existing {
                return Err(QueueStorageError(error.clone()));
            }
            Ok(state
                .receipts
                .iter()
                .any(|(receipt_channel, receipt_trigger)| {
                    receipt_channel.as_str() == channel && receipt_trigger.as_str() == trigger
                }))
        }
    }

    fn live_queue_length<'a>(
        &'a self,
        _channel: &'a str,
    ) -> impl Future<Output = Result<u64, QueueStorageError>> + Send + 'a {
        async move {
            let mut state = self.state.lock().unwrap();
            state.length_calls += 1;
            if let Some(error) = &state.fail_length {
                return Err(QueueStorageError(error.clone()));
            }
            Ok(state.live_length)
        }
    }

    fn insert_receipt<'a>(
        &'a self,
        channel: &'a str,
        trigger: &'a str,
        payload: &'a DimafxQueueItem,
        now: DateTime,
    ) -> impl Future<Output = Result<(), QueueStorageError>> + Send + 'a {
        async move {
            let document = payload.to_document();
            let mut state = self.state.lock().unwrap();
            if let Some(error) = &state.fail_insert {
                return Err(QueueStorageError(error.clone()));
            }
            // Mongo's upsert filter is global by `_id`; a successful no-op can
            // belong to another channel, so the production adapter re-reads.
            if let Some((existing_channel, _)) = state
                .receipts
                .iter()
                .find(|(_, receipt_trigger)| receipt_trigger.as_str() == trigger)
            {
                if existing_channel.as_str() != channel {
                    return Err(QueueStorageError(
                        "DimaFX trigger ID belongs to another channel or receipt is unavailable"
                            .into(),
                    ));
                }
                return Ok(());
            }
            if state.race_same_channel {
                state.receipts.push((channel.into(), trigger.into()));
                state.live_length += 1;
                return Ok(());
            }
            state.inserted.push(InsertedReceipt {
                channel: channel.into(),
                trigger: trigger.into(),
                payload: document,
                now,
            });
            state.receipts.push((channel.into(), trigger.into()));
            state.live_length += 1;
            Ok(())
        }
    }
}

#[derive(Clone)]
struct Presence {
    ready: usize,
    calls: Arc<AtomicUsize>,
}

impl Presence {
    fn new(ready: usize) -> Self {
        Self {
            ready,
            calls: Arc::new(AtomicUsize::new(0)),
        }
    }

    fn calls(&self) -> usize {
        self.calls.load(Ordering::SeqCst)
    }
}

impl DimafxOverlayPresence for Presence {
    fn ready_connections(&self, _channel: &str) -> usize {
        self.calls.fetch_add(1, Ordering::SeqCst);
        self.ready
    }
}

struct FixedIds {
    now: f64,
    next: Mutex<VecDeque<String>>,
}

impl FixedIds {
    fn new(now: f64, triggers: &[&str]) -> Self {
        Self {
            now,
            next: Mutex::new(triggers.iter().map(|trigger| (*trigger).to_owned()).collect()),
        }
    }
}

impl DimafxEnqueueIds for FixedIds {
    fn now_millis(&self) -> f64 {
        self.now
    }

    fn trigger_id(&self) -> String {
        self.next
            .lock()
            .unwrap()
            .pop_front()
            .expect("test trigger id")
    }
}

#[derive(Clone)]
struct FixedTts {
    en: String,
    es: String,
    calls: Arc<Mutex<Vec<(String, String, DimafxQueueLanguage)>>>,
    failure: Option<String>,
}

impl FixedTts {
    fn new(en: &str, es: &str) -> Self {
        Self {
            en: en.into(),
            es: es.into(),
            calls: Arc::new(Mutex::new(Vec::new())),
            failure: None,
        }
    }

    fn failing(message: &str) -> Self {
        Self {
            failure: Some(message.into()),
            ..Self::new("en_US-amy", "es_ES-davefx")
        }
    }

    fn calls(&self) -> Vec<(String, String, DimafxQueueLanguage)> {
        self.calls.lock().unwrap().clone()
    }
}

impl DimafxTtsVoiceSource for FixedTts {
    fn channel_voice<'a>(
        &'a self,
        channel_id: &'a JsString,
        channel_name: &'a JsString,
        language: DimafxQueueLanguage,
    ) -> impl Future<Output = Result<JsString, DimafxTtsError>> + Send + 'a {
        async move {
            self.calls.lock().unwrap().push((
                channel_id.to_utf8_lossy(),
                channel_name.to_utf8_lossy(),
                language,
            ));
            if let Some(failure) = &self.failure {
                return Err(DimafxTtsError(failure.clone()));
            }
            Ok(match language {
                DimafxQueueLanguage::En => self.en.as_str().into(),
                DimafxQueueLanguage::Es => self.es.as_str().into(),
            })
        }
    }
}

fn handler(
    store: &RecordingStore,
    presence: &Presence,
    tts: &FixedTts,
    ids: FixedIds,
) -> DimafxEnqueueHandler<RecordingStore, Presence, FixedTts, FixedIds> {
    DimafxEnqueueHandler::with_parts(store.clone(), presence.clone(), tts.clone(), ids, API_URL)
}

#[test]
fn existing_receipt_wins_before_validation_and_reports_live_count() {
    let store = RecordingStore::default();
    // Full queue and disconnected overlay would both reject a fresh trigger.
    store.seed_receipt(CHANNEL, "trigger-1", MAX_QUEUE_ITEMS as u64);
    let presence = Presence::new(0);
    let tts = FixedTts::new("en_US-amy", "es_ES-davefx");
    let handler = handler(&store, &presence, &tts, FixedIds::new(NOW_MS, &[]));

    // A fresh trigger with no asset would be a 500, but the receipt is final.
    let mut input = media_input(Some("trigger-1"));
    input.asset = None;

    assert_eq!(
        run(handler.enqueue(input)).unwrap(),
        DimafxEnqueueResult::Queued(DimafxQueueReceipt {
            trigger_id: "trigger-1".into(),
            queue_length: MAX_QUEUE_ITEMS as u64,
            active_connections: 0,
        })
    );
    assert_eq!(store.existing_calls(), 1);
    assert_eq!(store.length_calls(), 1);
    assert_eq!(presence.calls(), 1);
    assert!(store.inserted().is_empty());
    assert!(tts.calls().is_empty());
}

#[test]
fn non_tts_item_without_media_is_rejected_before_presence_and_capacity() {
    let store = RecordingStore::default();
    store.set_live_length(MAX_QUEUE_ITEMS as u64);
    let presence = Presence::new(5);
    let tts = FixedTts::new("en_US-amy", "es_ES-davefx");
    let handler = handler(&store, &presence, &tts, FixedIds::new(NOW_MS, &["unused"]));

    let mut input = media_input(Some("trigger-2"));
    input.asset = None;

    assert_eq!(
        run(handler.enqueue(input)).unwrap(),
        DimafxEnqueueResult::Rejected(DimafxEnqueueRejection {
            status: MISSING_MEDIA_STATUS,
            message: MISSING_MEDIA_MESSAGE,
        })
    );
    assert_eq!(store.existing_calls(), 1);
    assert_eq!(store.length_calls(), 0);
    assert_eq!(presence.calls(), 0);
    assert!(store.inserted().is_empty());
}

#[test]
fn disconnected_overlay_is_rejected_before_capacity_and_tts_validation() {
    let store = RecordingStore::default();
    store.set_live_length(MAX_QUEUE_ITEMS as u64);
    let presence = Presence::new(0);
    let tts = FixedTts::new("en_US-amy", "es_ES-davefx");
    let handler = handler(&store, &presence, &tts, FixedIds::new(NOW_MS, &["unused"]));

    assert_eq!(
        run(handler.enqueue(media_input(Some("trigger-3")))).unwrap(),
        DimafxEnqueueResult::Rejected(DimafxEnqueueRejection {
            status: DISCONNECTED_STATUS,
            message: DISCONNECTED_MESSAGE,
        })
    );
    assert_eq!(store.length_calls(), 0);
    assert_eq!(presence.calls(), 1);
    assert!(store.inserted().is_empty());
}

#[test]
fn full_queue_is_rejected_before_tts_text_and_voice_resolution() {
    let store = RecordingStore::default();
    store.set_live_length(MAX_QUEUE_ITEMS as u64);
    let presence = Presence::new(1);
    let tts = FixedTts::new("en_US-amy", "es_ES-davefx");
    let handler = handler(&store, &presence, &tts, FixedIds::new(NOW_MS, &["unused"]));

    let mut input = media_input(Some("trigger-4"));
    input.item = item(
        ChannelExtensionItemCategory::Tts,
        Some(tts_config(
            ChannelExtensionItemTtsMode::Custom,
            "",
            "",
            ChannelExtensionItemTtsLanguage::En,
        )),
    );
    input.asset = None;
    input.viewer_text = None;

    assert_eq!(
        run(handler.enqueue(input)).unwrap(),
        DimafxEnqueueResult::Rejected(DimafxEnqueueRejection {
            status: QUEUE_FULL_STATUS,
            message: QUEUE_FULL_MESSAGE,
        })
    );
    assert_eq!(store.length_calls(), 1);
    assert_eq!(presence.calls(), 1);
    assert!(tts.calls().is_empty());
    assert!(store.inserted().is_empty());
}

#[test]
fn tts_without_non_whitespace_text_is_rejected() {
    let cases = [
        (
            ChannelExtensionItemTtsMode::Custom,
            "",
            None,
            "custom without viewer text",
        ),
        (
            ChannelExtensionItemTtsMode::Custom,
            "fixed text is ignored",
            Some("  \n\t "),
            "custom with whitespace viewer text",
        ),
        (
            ChannelExtensionItemTtsMode::Fixed,
            " \t ",
            Some("viewer text is ignored"),
            "fixed with whitespace text",
        ),
    ];

    for (mode, text, viewer_text, label) in cases {
        let store = RecordingStore::default();
        let presence = Presence::new(1);
        let tts = FixedTts::new("en_US-amy", "es_ES-davefx");
        let handler = handler(&store, &presence, &tts, FixedIds::new(NOW_MS, &["unused"]));

        let mut input = media_input(Some("trigger-tts-empty"));
        input.item = item(
            ChannelExtensionItemCategory::Tts,
            Some(tts_config(
                mode,
                text,
                "",
                ChannelExtensionItemTtsLanguage::En,
            )),
        );
        input.asset = None;
        input.viewer_text = viewer_text.map(Into::into);

        assert_eq!(
            run(handler.enqueue(input)).unwrap(),
            DimafxEnqueueResult::Rejected(DimafxEnqueueRejection {
                status: TTS_TEXT_REQUIRED_STATUS,
                message: TTS_TEXT_REQUIRED_MESSAGE,
            }),
            "{label}"
        );
        assert_eq!(store.length_calls(), 1, "{label}");
        assert!(tts.calls().is_empty(), "{label}");
        assert!(store.inserted().is_empty(), "{label}");
    }
}

#[test]
fn media_item_persists_the_source_payload_shape() {
    let store = RecordingStore::default();
    let presence = Presence::new(2);
    let tts = FixedTts::new("en_US-amy", "es_ES-davefx");
    let handler = handler(&store, &presence, &tts, FixedIds::new(NOW_MS, &["generated-trigger"]));

    let mut input = media_input(None);
    input.item.volume = 140.0;
    input.item.duration_ms = -5.0;

    assert_eq!(
        run(handler.enqueue(input)).unwrap(),
        DimafxEnqueueResult::Queued(DimafxQueueReceipt {
            trigger_id: "generated-trigger".into(),
            queue_length: 1,
            active_connections: 2,
        })
    );
    assert_eq!(store.existing_calls(), 1);
    assert_eq!(store.length_calls(), 2);
    assert_eq!(presence.calls(), 2);
    assert!(tts.calls().is_empty());

    let inserted = store.inserted();
    assert_eq!(inserted.len(), 1);
    assert_eq!(inserted[0].channel, CHANNEL);
    assert_eq!(inserted[0].trigger, "generated-trigger");
    assert_eq!(inserted[0].now, DateTime::from_millis(NOW_MS as i64));
    assert_eq!(
        inserted[0].payload,
        DimafxQueueItem {
            trigger_id: "generated-trigger".into(),
            channel_id: CHANNEL.into(),
            item_id: ITEM_ID.into(),
            name: "Test item".into(),
            category: "video".into(),
            media_url: Some(format!("{API_URL}/media/{ASSET_ID}")),
            media_type: Some("video/mp4".into()),
            volume: 100.0,
            duration_ms: 0.0,
            tts: None,
            refund_on_failure: Some(DimafxQueueRefund {
                user_id: "viewer".into(),
                price_bits: 25.0,
            }),
            source: DimafxQueueSource::BitsPurchase,
            enqueued_at: NOW_MS,
        }
        .to_document()
    );
}

#[test]
fn empty_asset_mime_type_falls_back_to_the_item_media_type() {
    let store = RecordingStore::default();
    let presence = Presence::new(1);
    let tts = FixedTts::new("en_US-amy", "es_ES-davefx");
    let handler = handler(&store, &presence, &tts, FixedIds::new(NOW_MS, &["fallback-mime"]));

    let mut input = media_input(Some("fallback-mime"));
    input.asset = Some(asset(""));

    assert!(matches!(
        run(handler.enqueue(input)).unwrap(),
        DimafxEnqueueResult::Queued(_)
    ));
    assert_eq!(
        store.inserted()[0].payload.get_str("mediaType").unwrap(),
        "video"
    );
}

#[test]
fn queue_accepts_the_item_below_the_limit() {
    let store = RecordingStore::default();
    store.set_live_length((MAX_QUEUE_ITEMS - 1) as u64);
    let presence = Presence::new(1);
    let tts = FixedTts::new("en_US-amy", "es_ES-davefx");
    let handler = handler(&store, &presence, &tts, FixedIds::new(NOW_MS, &["below-limit"]));

    assert_eq!(
        run(handler.enqueue(media_input(Some("below-limit")))).unwrap(),
        DimafxEnqueueResult::Queued(DimafxQueueReceipt {
            trigger_id: "below-limit".into(),
            queue_length: MAX_QUEUE_ITEMS as u64,
            active_connections: 1,
        })
    );
    assert_eq!(store.inserted().len(), 1);
}

#[test]
fn fixed_tts_uses_item_voice_without_reading_channel_settings() {
    let store = RecordingStore::default();
    let presence = Presence::new(1);
    let tts = FixedTts::new("en_US-amy", "es_ES-davefx");
    let handler = handler(&store, &presence, &tts, FixedIds::new(NOW_MS, &["tts-fixed"]));

    let mut input = media_input(Some("tts-fixed"));
    input.item = item(
        ChannelExtensionItemCategory::Tts,
        Some(tts_config(
            ChannelExtensionItemTtsMode::Fixed,
            "  hola  ",
            "es_voice",
            ChannelExtensionItemTtsLanguage::Es,
        )),
    );
    input.asset = None;
    input.viewer_text = Some("ignored".into());
    input.refund_on_failure = None;

    assert_eq!(
        run(handler.enqueue(input)).unwrap(),
        DimafxEnqueueResult::Queued(DimafxQueueReceipt {
            trigger_id: "tts-fixed".into(),
            queue_length: 1,
            active_connections: 1,
        })
    );
    assert!(tts.calls().is_empty());

    let inserted = store.inserted();
    assert_eq!(
        inserted[0].payload,
        DimafxQueueItem {
            trigger_id: "tts-fixed".into(),
            channel_id: CHANNEL.into(),
            item_id: ITEM_ID.into(),
            name: "Test item".into(),
            category: "tts".into(),
            media_url: None,
            media_type: Some("audio/wav".into()),
            volume: 100.0,
            duration_ms: 0.0,
            tts: Some(DimafxQueueTts {
                text: "hola".into(),
                voice: "es_voice".into(),
                language: DimafxQueueLanguage::Es,
            }),
            refund_on_failure: None,
            source: DimafxQueueSource::BitsPurchase,
            enqueued_at: NOW_MS,
        }
        .to_document()
    );
}

#[test]
fn custom_tts_falls_back_to_the_channel_voice_for_its_language() {
    let store = RecordingStore::default();
    let presence = Presence::new(1);
    let tts = FixedTts::new("en_US-amy", "es_ES-davefx");
    let handler = handler(&store, &presence, &tts, FixedIds::new(NOW_MS, &["tts-custom"]));

    let mut input = media_input(Some("tts-custom"));
    input.item = item(
        ChannelExtensionItemCategory::Tts,
        Some(tts_config(
            ChannelExtensionItemTtsMode::Custom,
            "ignored",
            "",
            ChannelExtensionItemTtsLanguage::En,
        )),
    );
    input.asset = None;
    input.viewer_text = Some("  hello  ".into());

    assert_eq!(
        run(handler.enqueue(input)).unwrap(),
        DimafxEnqueueResult::Queued(DimafxQueueReceipt {
            trigger_id: "tts-custom".into(),
            queue_length: 1,
            active_connections: 1,
        })
    );
    assert_eq!(
        tts.calls(),
        vec![(CHANNEL.into(), CHANNEL_NAME.into(), DimafxQueueLanguage::En)]
    );
    assert_eq!(
        store.inserted()[0].payload.get_document("tts").unwrap().clone(),
        DimafxQueueTts {
            text: "hello".into(),
            voice: "en_US-amy".into(),
            language: DimafxQueueLanguage::En,
        }
        .to_document()
    );
}

#[test]
fn empty_trigger_id_falls_back_to_a_generated_uuid() {
    let store = RecordingStore::default();
    let presence = Presence::new(1);
    let tts = FixedTts::new("en_US-amy", "es_ES-davefx");
    let handler = handler(&store, &presence, &tts, FixedIds::new(NOW_MS, &["generated-empty"]));

    assert_eq!(
        run(handler.enqueue(media_input(Some("")))).unwrap(),
        DimafxEnqueueResult::Queued(DimafxQueueReceipt {
            trigger_id: "generated-empty".into(),
            queue_length: 1,
            active_connections: 1,
        })
    );
    assert_eq!(store.inserted()[0].trigger, "generated-empty");
}

#[test]
fn receipt_owned_by_another_channel_is_a_storage_failure_not_a_success() {
    let store = RecordingStore::default();
    store.seed_receipt("other-channel", "shared-trigger", 4);
    let presence = Presence::new(1);
    let tts = FixedTts::new("en_US-amy", "es_ES-davefx");
    let handler = handler(&store, &presence, &tts, FixedIds::new(NOW_MS, &["unused"]));

    let error = run(handler.enqueue(media_input(Some("shared-trigger")))).unwrap_err();
    assert_eq!(
        error,
        DimafxEnqueueError::Storage(QueueStorageError(
            "DimaFX trigger ID belongs to another channel or receipt is unavailable".into()
        ))
    );
    assert_eq!(store.existing_calls(), 1);
    assert_eq!(store.length_calls(), 1);
    assert!(store.inserted().is_empty());
}

#[test]
fn concurrent_same_channel_duplicate_is_tolerated_as_a_success() {
    let store = RecordingStore::default();
    store.race_same_channel();
    let presence = Presence::new(1);
    let tts = FixedTts::new("en_US-amy", "es_ES-davefx");
    let handler = handler(&store, &presence, &tts, FixedIds::new(NOW_MS, &["unused"]));

    assert_eq!(
        run(handler.enqueue(media_input(Some("raced-trigger")))).unwrap(),
        DimafxEnqueueResult::Queued(DimafxQueueReceipt {
            trigger_id: "raced-trigger".into(),
            queue_length: 1,
            active_connections: 1,
        })
    );
    // The racing writer owns the receipt, so this call inserted no payload.
    assert!(store.inserted().is_empty());
}

#[test]
fn storage_read_failures_propagate_without_queueing() {
    for fail in ["existing", "length", "insert"] {
        let store = RecordingStore::default();
        let presence = Presence::new(1);
        let tts = FixedTts::new("en_US-amy", "es_ES-davefx");
        let handler = handler(&store, &presence, &tts, FixedIds::new(NOW_MS, &["unused"]));
        match fail {
            "existing" => store.fail_existing("receipt read unavailable"),
            "length" => store.fail_length("queue count unavailable"),
            _ => store.fail_insert("receipt write unavailable"),
        }

        let error = run(handler.enqueue(media_input(Some("trigger-failure")))).unwrap_err();
        assert!(
            matches!(&error, DimafxEnqueueError::Storage(_)),
            "{fail}: expected a storage failure, got {error:?}"
        );
        assert!(store.inserted().is_empty(), "{fail}");
    }
}

#[test]
fn tts_settings_failure_propagates_without_queueing() {
    let store = RecordingStore::default();
    let presence = Presence::new(1);
    let tts = FixedTts::failing("channel TTS settings unavailable");
    let handler = handler(&store, &presence, &tts, FixedIds::new(NOW_MS, &["unused"]));

    let mut input = media_input(Some("tts-settings-failure"));
    input.item = item(
        ChannelExtensionItemCategory::Tts,
        Some(tts_config(
            ChannelExtensionItemTtsMode::Custom,
            "",
            "",
            ChannelExtensionItemTtsLanguage::Es,
        )),
    );
    input.asset = None;
    input.viewer_text = Some("hola".into());

    assert_eq!(
        run(handler.enqueue(input)).unwrap_err(),
        DimafxEnqueueError::TtsVoice(DimafxTtsError("channel TTS settings unavailable".into()))
    );
    assert_eq!(store.length_calls(), 1);
    assert!(store.inserted().is_empty());
}

#[test]
fn payload_numeric_normalization_matches_the_source() {
    assert_eq!(clamp_volume(100.0), 100.0);
    assert_eq!(clamp_volume(140.0), 100.0);
    assert_eq!(clamp_volume(-1.0), 0.0);
    assert!(clamp_volume(f64::NAN).is_nan());
    assert_eq!(normalize_duration(0.0), 0.0);
    assert_eq!(normalize_duration(f64::NAN), 0.0);
    assert_eq!(normalize_duration(-10.0), 0.0);
    assert_eq!(normalize_duration(2_500.0), 2_500.0);
}
