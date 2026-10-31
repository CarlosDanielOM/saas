//! Source-contract checks for the overlay recovery port. These intentionally
//! inspect the source as well as the candidate so changes to the route's
//! safety-critical ordering require review. Mongo behavior needs a separate
//! isolated integration run; these checks do not establish database parity.

#![cfg(feature = "dimafx-delivery")]

const ROUTE: &str = include_str!("../src/server/routes/dimafx.route.ts");
const ITEM_SCHEMA: &str = include_str!("../src/schemas/channel_extension_item.schema.ts");
const ASSET_SCHEMA: &str = include_str!("../src/schemas/media_asset.schema.ts");
const QUEUE: &str = include_str!("../src/handlers/dimafx_queue.handler.ts");
const RECOVERY: &str = include_str!("../src/dimafx/purchase_recovery.rs");

fn between<'a>(text: &'a str, start: &str, end: &str) -> &'a str {
    let text = text.split_once(start).expect("start marker").1;
    text.split_once(end).expect("end marker").0
}

#[test]
fn durable_receipts_precede_current_item_lookup_in_both_paths() {
    let source = between(ROUTE, "async function recoverBitsPurchase(", "async function resolveDuplicateBitsPurchase(");
    let candidate = between(RECOVERY, "async fn recover_one(", "impl<S, T, I, D> OverlayPurchaseRecovery");
    for receipt in ["dimafxQueueHandler.existing", "dimafxReceipts: `save:"] {
        assert!(source.find(receipt).unwrap() < source.find("getActiveChannelItem").unwrap());
    }
    assert!(candidate.find("store.existing").unwrap() < candidate.find("channel_extension_item::collection").unwrap());
    assert!(candidate.find("let saved =").unwrap() < candidate.find("channel_extension_item::collection").unwrap());
}

#[test]
fn only_explicit_queue_rejection_refunds_while_errors_propagate() {
    let source = between(ROUTE, "async function fulfillBitsPurchase(", "async function recoverBitsPurchase(");
    assert!(source.contains("if (!(error instanceof DimafxQueueError)) throw error"));
    let candidate = between(RECOVERY, "async fn recover_one(", "impl<S, T, I, D> OverlayPurchaseRecovery");
    assert!(candidate.contains("DimafxEnqueueResult::Rejected(_)"));
    assert!(candidate.contains(".await.map_err(|e| e.to_string())?"));
    assert!(candidate.find("DimafxEnqueueResult::Rejected(_)").unwrap() < candidate.rfind("self.mark(id, \"fulfilled\")").unwrap());
}

#[test]
fn lean_lookup_and_queue_fallbacks_are_explicit_source_contracts() {
    let lookup = between(ROUTE, "async function getActiveChannelItem(", "async function getOrCreateInventory(");
    assert_eq!(lookup.matches(".lean()").count(), 2);
    assert!(lookup.contains("if (!item.assetID) return null"));
    assert!(lookup.contains("deletedAt: null"));
    for expression in ["item.volume ?? 100", "item.durationMs || 0", "asset?.mimeType || item.mediaType", "item.channelName || ''"] {
        assert!(QUEUE.contains(expression), "missing queue fallback: {expression}");
    }
    for field in ["description:", "thumbnailUrl:", "durationMs:", "volume:", "sortOrder:"] {
        assert!(ITEM_SCHEMA.contains(field));
    }
    for field in ["marketplaceStatus:", "thumbnailStatus:", "thumbnailAttempts:", "libraryCount:", "triggerReferenceCount:", "alertReferenceCount:", "extensionReferenceCount:"] {
        assert!(ASSET_SCHEMA.contains(field));
    }
}

// These tests require a task-owned, disposable Mongo server. They never use an
// application database and remove only the generated test database, even on panic.
use dima_rust::dimafx_delivery::{
    overlay_service::{DimafxReadySockets, OverlayFuture, OverlayPurchaseRecovery, OverlayQueue},
    purchase_recovery::{MongoPurchaseRecovery, MongoPurchaseRecoveryStore},
    queue_handler::{DimafxComposition, DimafxEnqueueHandler, MongoDimafxTtsVoiceSource, MongoPlaybackStore},
};
use dima_rust::schemas::{channel_extension_item, dimafx_playback, extension_wallet_transaction, media_asset, user_extension_inventory};
use futures_util::FutureExt;
use mongodb::{bson::{doc, DateTime, Document, oid::ObjectId}, Client};
use std::sync::Arc;

struct IdleQueue;
impl OverlayQueue for IdleQueue {
    fn resume_if_idle<'a>(&'a self, _: &'a str) -> OverlayFuture<'a> { Box::pin(async { Ok(()) }) }
    fn handle_trigger_ended<'a>(&'a self, _: &'a str, _: &'a str) -> OverlayFuture<'a> { Box::pin(async { Ok(()) }) }
}

fn ledger(id: ObjectId, state: &str, updated: DateTime, created: DateTime) -> Document {
    doc! { "_id": id, "channelID": "c", "userID": "u", "type": "bits_purchase", "amountBits": 25,
        "metadata": { "fulfillment": state, "action": "use_now" }, "updatedAt": updated, "createdAt": created }
}

#[tokio::test]
#[ignore = "requires an explicitly provided isolated MongoDB fixture; set MONGO_TEST_EXPECT and MONGO_DIMAFX_RECOVERY_TEST_URI"]
async fn mongo_recovery_claims_receipts_and_failures() {
    assert_eq!(std::env::var("MONGO_TEST_EXPECT").as_deref(), Ok("success"));
    let uri = std::env::var("MONGO_DIMAFX_RECOVERY_TEST_URI").expect("explicit task-owned isolated MongoDB URI required");
    assert!(!uri.trim().is_empty());
    let client = Client::with_uri_str(uri).await.unwrap();
    let db = client.database(&format!("dima_dimafx_recovery_{}", ObjectId::new().to_hex()));
    let result = std::panic::AssertUnwindSafe(async {
        let tx = extension_wallet_transaction::collection(&db);
        let store = MongoPurchaseRecoveryStore::new(db.clone());
        let now = DateTime::from_millis(100_000);
        let old = DateTime::from_millis(69_999);
        let exact = DateTime::from_millis(70_000);
        let first = ObjectId::new(); let second = ObjectId::new(); let fresh = ObjectId::new();
        tx.insert_many(vec![ledger(second, "processing", old, DateTime::from_millis(2)),
            ledger(first, "pending", old, DateTime::from_millis(1)), ledger(fresh, "processing", exact, DateTime::from_millis(0))]).await.unwrap();
        let selected = store.pending("c", now).await.unwrap();
        assert_eq!(selected.iter().map(|d| d.get_object_id("_id").unwrap()).collect::<Vec<_>>(), vec![first, second]);
        assert!(!store.claim(fresh, now).await.unwrap());
        let (a, b) = tokio::join!(store.claim(first, now), store.claim(first, now));
        assert_ne!(a.unwrap(), b.unwrap(), "only one concurrent claimant may proceed");
        assert!(store.claim(second, now).await.unwrap());
        assert!(!store.claim(second, now).await.unwrap());
        tx.delete_many(doc! {}).await.unwrap();

        let queue = Arc::new(DimafxComposition::with_parts(
            DimafxEnqueueHandler::new(MongoPlaybackStore::new(db.clone()), DimafxReadySockets::default(), MongoDimafxTtsVoiceSource::new(db.clone()), "http://fixture.invalid"), Arc::new(IdleQueue)));
        let recovery = MongoPurchaseRecovery::new(db.clone(), queue);
        let past = DateTime::from_millis(DateTime::now().timestamp_millis() - 60_000);
        let receipt = ObjectId::new();
        tx.insert_one(ledger(receipt, "pending", past, past)).await.unwrap();
        dimafx_playback::collection(&db).insert_one(doc! { "_id": format!("bits-{receipt}"), "channelID": "c", "state": "completed" }).await.unwrap();
        recovery.recover("c").await.unwrap();
        let processed = tx.find_one(doc! { "_id": receipt }).await.unwrap().unwrap();
        assert_eq!(processed.get_document("metadata").unwrap().get_str("fulfillment").unwrap(), "fulfilled", "receipt wins over missing item and disconnected overlay");
        assert!(user_extension_inventory::collection(&db).find_one(doc! { "userID": "u" }).await.unwrap().is_none());

        let saved = ObjectId::new();
        let mut save_ledger = ledger(saved, "pending", past, past);
        save_ledger.insert("metadata", doc! { "fulfillment": "pending", "action": "save" });
        tx.insert_one(save_ledger).await.unwrap();
        user_extension_inventory::collection(&db).insert_one(doc! { "platform": "twitch", "channelID": "c", "userID": "u", "balance": 0.0,
            "dimafxReceipts": [format!("save:{saved}")], "items": [] }).await.unwrap();
        recovery.recover("c").await.unwrap();
        let row = tx.find_one(doc! { "_id": saved }).await.unwrap().unwrap();
        assert_eq!(row.get_document("metadata").unwrap().get_str("fulfillment").unwrap(), "fulfilled", "save receipt survives item deletion");
        user_extension_inventory::collection(&db).delete_many(doc! {}).await.unwrap();

        let refund = ObjectId::new();
        tx.insert_one(ledger(refund, "refund_pending", past, past)).await.unwrap();
        recovery.recover("c").await.unwrap();
        tx.update_one(doc! { "_id": refund }, doc! { "$set": { "metadata.fulfillment": "refund_pending", "updatedAt": past } }).await.unwrap();
        recovery.recover("c").await.unwrap();
        let inventory = user_extension_inventory::collection(&db).find_one(doc! { "userID": "u" }).await.unwrap().unwrap();
        assert_eq!(inventory.get_f64("balance").unwrap(), 25.0);
        assert_eq!(inventory.get_array("dimafxReceipts").unwrap().len(), 1, "refund is idempotent");

        let rejected = ObjectId::new(); let item = ObjectId::new();
        let mut purchase = ledger(rejected, "pending", past, past); purchase.insert("channelExtensionItemID", item);
        tx.insert_one(purchase).await.unwrap();
        channel_extension_item::collection(&db).insert_one(doc! { "_id": item, "channelID": "c", "createdByUserID": "owner",
            "name": "voice", "category": "tts", "mediaType": "audio",
            "bitsPrice": 25, "sku": "fixture", "isEnabled": true, "tts": {},
            "createdAt": past, "updatedAt": past }).await.unwrap();
        recovery.recover("c").await.unwrap();
        let row = tx.find_one(doc! { "_id": rejected }).await.unwrap().unwrap();
        assert_eq!(row.get_document("metadata").unwrap().get_str("fulfillment").unwrap(), "refunded");
        let inventory = user_extension_inventory::collection(&db).find_one(doc! { "userID": "u" }).await.unwrap().unwrap();
        assert_eq!(inventory.get_f64("balance").unwrap(), 50.0, "definite disconnected rejection refunds");

        // Lean legacy rows can lack later schema defaults. A disconnected
        // overlay is a definite rejection only after both rows decode.
        let legacy_item = ObjectId::new(); let legacy_asset = ObjectId::new(); let legacy_purchase = ObjectId::new();
        let mut purchase = ledger(legacy_purchase, "pending", past, past);
        purchase.insert("channelExtensionItemID", legacy_item);
        tx.insert_one(purchase).await.unwrap();
        channel_extension_item::collection(&db).insert_one(doc! { "_id": legacy_item, "channelID": "c", "createdByUserID": "owner",
            "assetID": legacy_asset, "name": "legacy", "category": "video", "mediaType": "video", "bitsPrice": 25,
            "sku": "legacy", "isEnabled": true, "createdAt": past, "updatedAt": past }).await.unwrap();
        media_asset::collection(&db).insert_one(doc! { "_id": legacy_asset, "ownerUserID": "owner", "ownerChannelID": "c",
            "ownerChannelName": "c", "uploadedByUserID": "owner", "originalName": "x", "displayName": "x", "fileName": "x",
            "extension": "mp4", "mediaType": "video", "bytes": 10, "bucket": "fixture", "s3Key": "legacy",
            "storageUrl": "fixture", "scope": "private", "createdAt": past, "updatedAt": past }).await.unwrap();
        recovery.recover("c").await.unwrap();
        let row = tx.find_one(doc! { "_id": legacy_purchase }).await.unwrap().unwrap();
        assert_eq!(row.get_document("metadata").unwrap().get_str("fulfillment").unwrap(), "refunded");
        let inventory = user_extension_inventory::collection(&db).find_one(doc! { "userID": "u" }).await.unwrap().unwrap();
        assert_eq!(inventory.get_f64("balance").unwrap(), 75.0);

        // Present but malformed defaults are errors, not a reason to refund.
        let bad_asset = ObjectId::new(); let bad_item = ObjectId::new(); let bad_purchase = ObjectId::new();
        let mut purchase = ledger(bad_purchase, "pending", past, past);
        purchase.insert("channelExtensionItemID", bad_item);
        tx.insert_one(purchase).await.unwrap();
        let mut item_doc = channel_extension_item::collection(&db).find_one(doc! { "_id": legacy_item }).await.unwrap().unwrap();
        item_doc.insert("_id", bad_item); item_doc.insert("assetID", bad_asset);
        channel_extension_item::collection(&db).insert_one(item_doc).await.unwrap();
        let mut asset_doc = media_asset::collection(&db).find_one(doc! { "_id": legacy_asset }).await.unwrap().unwrap();
        asset_doc.insert("_id", bad_asset); asset_doc.insert("thumbnailAttempts", "invalid");
        media_asset::collection(&db).insert_one(asset_doc).await.unwrap();
        assert!(recovery.recover("c").await.is_err());
        let row = tx.find_one(doc! { "_id": bad_purchase }).await.unwrap().unwrap();
        assert_eq!(row.get_document("metadata").unwrap().get_str("fulfillment").unwrap(), "processing");
        let inventory = user_extension_inventory::collection(&db).find_one(doc! { "userID": "u" }).await.unwrap().unwrap();
        assert_eq!(inventory.get_f64("balance").unwrap(), 75.0);

        let ambiguous = ObjectId::new(); let malformed_item = ObjectId::new(); let later = ObjectId::new();
        let mut purchase = ledger(ambiguous, "pending", past, past); purchase.insert("channelExtensionItemID", malformed_item);
        tx.insert_one(purchase).await.unwrap();
        channel_extension_item::collection(&db).insert_one(doc! { "_id": malformed_item, "channelID": "c", "isEnabled": true, "deletedAt": null }).await.unwrap();
        tx.insert_one(ledger(later, "pending", past, DateTime::from_millis(past.timestamp_millis() + 1))).await.unwrap();
        assert!(recovery.recover("c").await.is_err());
        let untouched = tx.find_one(doc! { "_id": later }).await.unwrap().unwrap();
        assert_eq!(untouched.get_document("metadata").unwrap().get_str("fulfillment").unwrap(), "pending", "failure stops the ordered batch");
        let row = tx.find_one(doc! { "_id": ambiguous }).await.unwrap().unwrap();
        assert_eq!(row.get_document("metadata").unwrap().get_str("fulfillment").unwrap(), "processing");
        let inventory = user_extension_inventory::collection(&db).find_one(doc! { "userID": "u" }).await.unwrap().unwrap();
        assert_eq!(inventory.get_f64("balance").unwrap(), 75.0, "ambiguous failures must not refund");
    }).catch_unwind().await;
    let cleanup = db.drop().await;
    if let Err(error) = result { if let Err(cleanup_error) = cleanup { eprintln!("fixture cleanup failed: {cleanup_error}"); } std::panic::resume_unwind(error); }
    cleanup.expect("drop task-owned fixture database");
}
