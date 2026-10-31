//! Public-surface parity checks for `dimafx.service.ts` and
//! `dimafx-fulfillment.service.ts`.
//!
//! The source's own `dimafx.service.test.ts` cases are ported here, together
//! with the SKU, TTS, sanitizer, permission-order and receipt-shape cases that
//! the inline module tests also cover. No live Mongo, Redis, S3, socket server
//! or ffmpeg is used; every collaborator is an in-memory recording adapter.

#![cfg(feature = "dimafx-delivery")]

use dima_rust::dimafx_delivery::{
    fulfillment::{
        DimafxFulfillment, DimafxInventoryRepository, FulfillmentError, INVENTORY_UNAVAILABLE,
        REFUND_UNAVAILABLE, refund_dimafx_once, save_dimafx_purchase_once,
    },
    service::{
        DIMAFX_TTS_FIXED_TEXT_MAX, DIMAFX_TTS_VIEWER_TEXT_MAX, DimafxAcquiredAt,
        DimafxAdminLookup, DimafxPermissionError, DimafxRedeemRow, DimafxService,
        DimafxSkuMapSource, DimafxViewerConfigUpdate, get_allowed_dimafx_bit_prices,
        get_dimafx_sku_for_bits_price, get_dimafx_sku_map, has_dimafx_permission,
        normalize_dimafx_purchase_action, normalize_dimafx_tts_config,
        normalize_dimafx_viewer_config, sanitize_dimafx_viewer_tts_text, select_redeem_candidate,
    },
};
use dima_rust::schemas::{
    channel_extension_item::{ChannelExtensionItemTtsLanguage, ChannelExtensionItemTtsMode},
    user_extension_inventory::{
        DEFAULT_EXTENSION_INVENTORY_CONFIG, IUserExtensionInventoryConfig, QuickPurchaseAction,
        QuickPurchasePriority,
    },
};
use dima_rust::utils::{
    js_string::JsString,
    lossless_json::{JsonValue, parse_json},
};
use mongodb::bson::{Document, doc, oid::ObjectId};
use std::{
    collections::VecDeque,
    future::Future,
    sync::Mutex,
};

fn json(text: &str) -> JsonValue {
    parse_json(text).expect("test JSON")
}

fn run<T>(future: impl Future<Output = T>) -> T {
    tokio::runtime::Builder::new_current_thread()
        .build()
        .expect("test runtime")
        .block_on(future)
}

#[derive(Default)]
struct RecordingSkuSource {
    raw: Mutex<Option<String>>,
    reports: Mutex<Vec<String>>,
}
impl RecordingSkuSource {
    fn with_raw(raw: Option<&str>) -> Self {
        Self {
            raw: Mutex::new(raw.map(str::to_owned)),
            reports: Mutex::new(Vec::new()),
        }
    }
}
impl DimafxSkuMapSource for RecordingSkuSource {
    fn raw_sku_map(&self) -> Option<String> {
        self.raw.lock().unwrap().clone()
    }
    fn report_invalid_sku_map(&self, error: &str, _at_millis: i64) {
        self.reports.lock().unwrap().push(error.to_owned());
    }
}

#[derive(Default)]
struct RecordingAdminLookup {
    global: bool,
    channel: bool,
    calls: Mutex<Vec<(&'static str, Vec<String>)>>,
}
impl DimafxAdminLookup for RecordingAdminLookup {
    async fn has_global_channel_owner_access(
        &self,
        _requester: &str,
        _channel: &str,
    ) -> Result<bool, DimafxPermissionError> {
        self.calls.lock().unwrap().push(("global", Vec::new()));
        Ok(self.global)
    }
    async fn has_channel_permission(
        &self,
        _channel: &str,
        _requester: &str,
        permissions: &[String],
    ) -> Result<bool, DimafxPermissionError> {
        self.calls
            .lock()
            .unwrap()
            .push(("channel", permissions.to_vec()));
        Ok(self.channel)
    }
}

#[derive(Default)]
struct RecordingRepository {
    updates: Mutex<Vec<(Document, Document)>>,
    finds: Mutex<Vec<Document>>,
    update_results: Mutex<VecDeque<u64>>,
    find_results: Mutex<VecDeque<Option<Document>>>,
}
impl RecordingRepository {
    fn with_results(update: u64, find: Option<Document>) -> Self {
        let repository = Self::default();
        repository.update_results.lock().unwrap().push_back(update);
        repository.find_results.lock().unwrap().push_back(find);
        repository
    }
    fn updates(&self) -> Vec<(Document, Document)> {
        self.updates.lock().unwrap().clone()
    }
    fn finds(&self) -> Vec<Document> {
        self.finds.lock().unwrap().clone()
    }
}
impl DimafxInventoryRepository for RecordingRepository {
    async fn update_one(
        &self,
        filter: Document,
        update: Document,
    ) -> Result<u64, FulfillmentError> {
        self.updates.lock().unwrap().push((filter, update));
        Ok(self
            .update_results
            .lock()
            .unwrap()
            .pop_front()
            .unwrap_or(0))
    }
    async fn find_one(&self, filter: Document) -> Result<Option<Document>, FulfillmentError> {
        self.finds.lock().unwrap().push(filter);
        Ok(self.find_results.lock().unwrap().pop_front().unwrap_or(None))
    }
}

fn config(
    priority: QuickPurchasePriority,
    action: QuickPurchaseAction,
) -> IUserExtensionInventoryConfig {
    IUserExtensionInventoryConfig {
        quick_purchase_priority: priority,
        quick_purchase_action: action,
    }
}

#[test]
fn source_viewer_config_cases() {
    let current = config(QuickPurchasePriority::BitsFirst, QuickPurchaseAction::Save);
    assert_eq!(
        normalize_dimafx_viewer_config(
            DimafxViewerConfigUpdate {
                quick_purchase_priority: Some("credits_first"),
                quick_purchase_action: Some("use_now"),
            },
            current,
        ),
        config(QuickPurchasePriority::CreditsFirst, QuickPurchaseAction::UseNow)
    );
    assert_eq!(
        normalize_dimafx_viewer_config(DimafxViewerConfigUpdate::default(), current),
        current
    );
    assert_eq!(
        normalize_dimafx_viewer_config(
            DimafxViewerConfigUpdate {
                quick_purchase_priority: Some("cash"),
                quick_purchase_action: Some("gift"),
            },
            current,
        ),
        current
    );
    assert_eq!(
        normalize_dimafx_viewer_config(
            DimafxViewerConfigUpdate {
                quick_purchase_priority: Some("bits_first"),
                quick_purchase_action: None,
            },
            DEFAULT_EXTENSION_INVENTORY_CONFIG,
        ),
        config(QuickPurchasePriority::BitsFirst, QuickPurchaseAction::UseNow)
    );
}

#[test]
fn source_redeem_candidate_case() {
    let item_id = "507f1f77bcf86cd799439011";
    let other_id = "507f1f77bcf86cd799439012";
    let row = |id: &str, quantity: f64, millis: i64| DimafxRedeemRow {
        channel_extension_item_id: JsString::from(id),
        quantity,
        acquired_at: DimafxAcquiredAt::Date(mongodb::bson::DateTime::from_millis(millis)),
    };
    let newest = row(item_id, 1.0, 1_788_868_800_000);
    let older = row(item_id, 2.0, 1_788_264_000_000);
    let empty = row(item_id, 0.0, 1_788_955_200_000);
    let other = row(other_id, 9.0, 1_789_041_600_000);
    let items = vec![empty, older, other, newest];
    assert_eq!(
        select_redeem_candidate(&items, item_id),
        Some(&items[3])
    );
    assert_eq!(
        select_redeem_candidate(&items[..2], item_id),
        Some(&items[1])
    );
    assert_eq!(select_redeem_candidate(&items[..1], item_id), None);
}

#[test]
fn sku_defaults_fallbacks_and_number_keys() {
    let defaults = get_dimafx_sku_map(&RecordingSkuSource::with_raw(None));
    assert_eq!(
        defaults.bit_prices(),
        vec![0.0, 5.0, 10.0, 25.0, 50.0, 100.0]
    );
    assert_eq!(
        get_dimafx_sku_for_bits_price(&RecordingSkuSource::with_raw(None), 5.0)
            .unwrap()
            .as_str(),
        Some("dimafx_bits_5")
    );

    let invalid = RecordingSkuSource::with_raw(Some("{"));
    assert_eq!(get_dimafx_sku_map(&invalid).len(), 6);
    assert_eq!(invalid.reports.lock().unwrap().len(), 1);

    let custom = RecordingSkuSource::with_raw(Some(
        r#"{"5.5":" half ","0x10":"hex","-0":"zero","1e3":"kilo","-1":"neg","abc":"bad"}"#,
    ));
    assert_eq!(
        get_allowed_dimafx_bit_prices(&custom),
        vec![0.0, 5.5, 16.0, 1000.0]
    );
    assert_eq!(
        get_dimafx_sku_for_bits_price(&custom, 16.0)
            .unwrap()
            .as_str(),
        Some("hex")
    );
    assert_eq!(get_dimafx_sku_for_bits_price(&custom, -1.0), None);
}

#[test]
fn tts_normalization_and_utf16_sanitizer() {
    let fixed = normalize_dimafx_tts_config(Some(&json(
        r#"{"mode":"fixed","language":"es","text":"  hola \u00a0 mundo  ","voice":" en_US-ryan-medium "}"#,
    )))
    .unwrap()
    .unwrap();
    assert_eq!(fixed.mode, ChannelExtensionItemTtsMode::Fixed);
    assert_eq!(fixed.language, ChannelExtensionItemTtsLanguage::Es);
    assert_eq!(fixed.text.as_str(), Some("hola mundo"));
    assert_eq!(fixed.voice.as_str(), Some("en_US-ryan-medium"));

    assert_eq!(
        normalize_dimafx_tts_config(Some(&json(r#"{"mode":"fixed","text":"   "}"#))),
        Err(dima_rust::dimafx_delivery::service::TtsConfigError(
            "Fixed TTS items require text"
        ))
    );
    let too_long = "a".repeat(DIMAFX_TTS_FIXED_TEXT_MAX + 1);
    assert!(normalize_dimafx_tts_config(Some(&json(&format!(
        r#"{{"text":"{too_long}"}}"#
    ))))
    .is_err());

    assert_eq!(
        sanitize_dimafx_viewer_tts_text(Some(&json(
            "\"  Check https://example.com/a now  \""
        )))
        .as_str(),
        Some("Check now")
    );
    let mut boundary = "a".repeat(DIMAFX_TTS_VIEWER_TEXT_MAX - 1);
    boundary.push('\u{1f600}');
    let sliced = sanitize_dimafx_viewer_tts_text(Some(&JsonValue::String(JsString::from(
        boundary.as_str(),
    ))));
    assert_eq!(sliced.len(), DIMAFX_TTS_VIEWER_TEXT_MAX);
    assert_eq!(
        sliced.units()[DIMAFX_TTS_VIEWER_TEXT_MAX - 1],
        0xd83d
    );
}

#[test]
fn purchase_action_and_permission_order() {
    assert_eq!(
        normalize_dimafx_purchase_action("save"),
        QuickPurchaseAction::Save
    );
    assert_eq!(
        normalize_dimafx_purchase_action("anything"),
        QuickPurchaseAction::UseNow
    );

    let self_lookup = RecordingAdminLookup::default();
    assert!(run(has_dimafx_permission(&self_lookup, "same", "same", &[])).unwrap());
    assert!(self_lookup.calls.lock().unwrap().is_empty());

    let granted = RecordingAdminLookup {
        channel: true,
        ..RecordingAdminLookup::default()
    };
    assert!(
        run(has_dimafx_permission(
            &granted,
            "user",
            "channel",
            &["dimafx:items:write".to_owned()],
        ))
        .unwrap()
    );
    let calls = granted.calls.lock().unwrap();
    assert_eq!(calls[0].0, "global");
    assert_eq!(calls[1].0, "channel");
    assert_eq!(
        calls[1].1,
        vec![
            "*".to_owned(),
            "dimafx:all".to_owned(),
            "dimafx:items:write".to_owned(),
        ]
    );
}

#[test]
fn service_composes_injected_adapters() {
    let service = DimafxService::with_adapters(
        RecordingAdminLookup {
            channel: true,
            ..RecordingAdminLookup::default()
        },
        RecordingSkuSource::with_raw(Some(r#"{"5":"custom"}"#)),
    );
    assert_eq!(
        service.sku_for_bits_price(5.0).unwrap().as_str(),
        Some("custom")
    );
    assert_eq!(service.allowed_bit_prices(), vec![5.0]);
    assert!(run(service.has_permission("user", "channel", &[])).unwrap());
}

#[test]
fn refund_is_one_shot_and_atomic() {
    let repository = RecordingRepository::with_results(1, None);
    run(refund_dimafx_once(
        &repository,
        "channel",
        "user",
        5.5,
        "refund:bits-1",
    ))
    .unwrap();
    let updates = repository.updates();
    assert_eq!(
        updates[0].0,
        doc! {
            "platform": "twitch",
            "channelID": "channel",
            "userID": "user",
            "dimafxReceipts": { "$ne": "refund:bits-1" },
        }
    );
    assert_eq!(
        updates[0].1,
        doc! {
            "$inc": { "balance": 5.5 },
            "$addToSet": { "dimafxReceipts": "refund:bits-1" },
        }
    );
    assert!(repository.finds().is_empty());

    let duplicate = RecordingRepository::with_results(0, Some(doc! { "_id": "existing" }));
    run(refund_dimafx_once(
        &duplicate,
        "channel",
        "user",
        5.5,
        "refund:bits-1",
    ))
    .unwrap();

    let missing = RecordingRepository::with_results(0, None);
    assert_eq!(
        run(refund_dimafx_once(&missing, "channel", "user", 5.5, "refund:bits-1")),
        Err(FulfillmentError(REFUND_UNAVAILABLE.to_owned()))
    );

    let zero = RecordingRepository::default();
    run(refund_dimafx_once(&zero, "channel", "user", 0.0, "r")).unwrap();
    assert!(zero.updates().is_empty());
}

#[test]
fn save_is_one_shot_and_returns_inventory() {
    let item_id = "507f1f77bcf86cd799439011";
    let inventory = doc! { "_id": ObjectId::new() };
    let repository = RecordingRepository::with_results(0, Some(inventory.clone()));
    let saved = run(save_dimafx_purchase_once(
        &repository,
        "channel",
        "user",
        item_id,
        5.0,
        "ledger-1",
    ))
    .unwrap();
    assert_eq!(saved, inventory);

    let updates = repository.updates();
    assert_eq!(
        updates[0].0,
        doc! {
            "platform": "twitch",
            "channelID": "channel",
            "userID": "user",
            "dimafxReceipts": { "$ne": "save:ledger-1" },
        }
    );
    let update = &updates[0].1;
    assert_eq!(
        update
            .get_document("$addToSet")
            .unwrap()
            .get_str("dimafxReceipts")
            .unwrap(),
        "save:ledger-1"
    );
    let item = update
        .get_document("$push")
        .unwrap()
        .get_array("items")
        .unwrap()
        .first()
        .unwrap()
        .as_document()
        .unwrap();
    assert_eq!(
        item.get_object_id("channelExtensionItemID").unwrap(),
        ObjectId::parse_str(item_id).unwrap()
    );
    assert_eq!(
        item.get("quantity")
            .and_then(|value| value.as_i32().map(i64::from).or_else(|| value.as_i64())),
        Some(1)
    );
    assert_eq!(item.get_f64("purchasePriceBits").unwrap(), 5.0);
    assert_eq!(item.get_str("source").unwrap(), "bits_purchase");
    assert!(item.get_datetime("acquiredAt").is_ok());

    let missing = RecordingRepository::with_results(0, None);
    assert_eq!(
        run(save_dimafx_purchase_once(
            &missing,
            "channel",
            "user",
            item_id,
            5.0,
            "ledger-1",
        )),
        Err(FulfillmentError(INVENTORY_UNAVAILABLE.to_owned()))
    );

    let invalid = RecordingRepository::default();
    assert_eq!(
        run(save_dimafx_purchase_once(
            &invalid,
            "channel",
            "user",
            "not-an-id",
            5.0,
            "ledger-1",
        )),
        Err(FulfillmentError(
            "Invalid channel extension item ID".to_owned()
        ))
    );
}

#[test]
fn fulfillment_service_wraps_repository() {
    let service = DimafxFulfillment::with_adapters(RecordingRepository::with_results(1, None));
    run(service.refund_dimafx_once("c", "u", 1.0, "r")).unwrap();
}
