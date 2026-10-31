//! Mongo-backed recovery of interrupted Bits purchases for the DimaFX overlay.
//! The overlay caller discards HTTP response bodies; durable decisions and their
//! ordering follow `recoverDimafxPurchases` / `recoverBitsPurchase` in the route.
//! A failed database operation is propagated and never treated as rejection.

use std::sync::Arc;
use mongodb::{bson::{doc, Bson, DateTime, Document, oid::ObjectId}, Database};
use super::{fulfillment::DimafxFulfillment, overlay_service::{DimafxReadySockets, OverlayFuture, OverlayPurchaseRecovery, OverlayQueue}, queue_handler::{DimafxComposition, DimafxEnqueueIds, DimafxEnqueueInput, DimafxEnqueueResult, DimafxEnqueueStore, DimafxOverlayPresence, DimafxTtsVoiceSource, MongoPlaybackStore}};
use crate::schemas::{channel_extension_item::{self, ChannelExtensionItemCategory, IChannelExtensionItem}, dimafx_playback::{DimafxQueueRefund, DimafxQueueSource}, extension_wallet_transaction, media_asset::{self, IMediaAsset}, user_extension_inventory};

const STALE_MS: i64 = 30_000;
const BATCH_LIMIT: i64 = 25;

fn pending_filter(channel: &str, now: DateTime) -> Document {
    doc! { "channelID": channel, "type": "bits_purchase", "metadata.fulfillment": { "$in": ["pending", "processing", "refund_pending"] }, "updatedAt": { "$lt": DateTime::from_millis(now.timestamp_millis() - STALE_MS) } }
}
fn claim_filter(id: ObjectId, now: DateTime) -> Document {
    doc! { "_id": id, "$or": [ { "metadata.fulfillment": "pending" }, { "metadata.fulfillment": "processing", "updatedAt": { "$lt": DateTime::from_millis(now.timestamp_millis() - STALE_MS) } } ] }
}
fn identity(channel: &str, user: &str) -> Document {
    doc! { "platform": "twitch", "userID": user, "channelID": channel }
}
fn user(ledger: &Document) -> Option<&str> { ledger.get_str("userID").ok().filter(|s| !s.is_empty()) }
fn amount(ledger: &Document) -> Result<f64, String> {
    match ledger.get("amountBits") {
        Some(Bson::Double(v)) => Ok(*v), Some(Bson::Int32(v)) => Ok(f64::from(*v)), Some(Bson::Int64(v)) => Ok(*v as f64),
        _ => Err("invalid purchase amountBits".into()),
    }
}

// Lean queries do not hydrate Mongoose defaults. Adapt only absent fields with
// schema defaults (or explicit queue fallbacks); keep malformed values visible
// to the strict decoder. The synthetic fields are never written back to Mongo.
fn fill_missing(document: &mut Document, defaults: Document) {
    for (key, value) in defaults {
        if !document.contains_key(&key) { document.insert(key, value); }
    }
}
fn decode_item(mut document: Document) -> Result<IChannelExtensionItem, String> {
    fill_missing(&mut document, doc! { "description": "", "thumbnailUrl": "", "durationMs": 0,
        "volume": 100, "sortOrder": 0, "channelName": "" });
    // The queue uses nullish volume and falsy duration fallbacks as well.
    for (key, value) in [("volume", Bson::Int32(100)), ("durationMs", Bson::Int32(0))] {
        if document.get(key) == Some(&Bson::Null) { document.insert(key, value); }
    }
    if let Some(Bson::Document(tts)) = document.get_mut("tts") {
        fill_missing(tts, doc! { "mode": "custom", "text": "", "voice": "", "language": "en" });
    }
    IChannelExtensionItem::from_document(&document).map_err(|e| format!("item decode: {e:?}"))
}
fn decode_asset(mut document: Document) -> Result<IMediaAsset, String> {
    fill_missing(&mut document, doc! { "mimeType": "", "marketplaceStatus": "not_listed",
        "thumbnailStatus": "pending", "thumbnailAttempts": 0, "libraryCount": 0,
        "triggerReferenceCount": 0, "alertReferenceCount": 0, "extensionReferenceCount": 0 });
    IMediaAsset::from_document(&document).map_err(|e| format!("asset decode: {e:?}"))
}

/// Mongo-backed recovery selection and atomic claim boundary. The supplied
/// clock makes stale boundaries and contention independently testable.
#[derive(Clone)]
pub struct MongoPurchaseRecoveryStore { database: Database }
impl MongoPurchaseRecoveryStore {
    pub fn new(database: Database) -> Self { Self { database } }
    pub async fn pending(&self, channel: &str, now: DateTime) -> Result<Vec<Document>, String> {
        let mut cursor = extension_wallet_transaction::collection(&self.database).find(pending_filter(channel, now)).sort(doc! { "createdAt": 1 }).limit(BATCH_LIMIT).await.map_err(|e| e.to_string())?;
        let mut pending = Vec::new();
        while cursor.advance().await.map_err(|e| e.to_string())? {
            pending.push(cursor.deserialize_current().map_err(|e| e.to_string())?);
        }
        Ok(pending)
    }
    pub async fn claim(&self, id: ObjectId, now: DateTime) -> Result<bool, String> {
        let result = extension_wallet_transaction::collection(&self.database).update_one(claim_filter(id, now), doc! { "$set": { "metadata.fulfillment": "processing", "updatedAt": now } }).await.map_err(|e| e.to_string())?;
        Ok(result.modified_count != 0)
    }
    async fn mark(&self, id: ObjectId, state: &str) -> Result<(), String> {
        extension_wallet_transaction::collection(&self.database).update_one(doc! { "_id": id }, doc! { "$set": { "metadata.fulfillment": state, "updatedAt": DateTime::now() } }).await.map_err(|e| e.to_string())?;
        Ok(())
    }
}

/// Uses the queue's own ready-socket registry; callers cannot supply another.
pub struct MongoPurchaseRecovery<S, T, I, D> {
    database: Database,
    store: MongoPurchaseRecoveryStore,
    queue: Arc<DimafxComposition<S, DimafxReadySockets, T, I, D>>,
    sockets: DimafxReadySockets,
}
impl<S, T, I, D> MongoPurchaseRecovery<S, T, I, D> {
    pub fn new(database: Database, queue: Arc<DimafxComposition<S, DimafxReadySockets, T, I, D>>) -> Self {
        let sockets = queue.ready_sockets();
        Self { store: MongoPurchaseRecoveryStore::new(database.clone()), database, queue, sockets }
    }
}
impl<S, T, I, D> MongoPurchaseRecovery<S, T, I, D>
where S: DimafxEnqueueStore, T: DimafxTtsVoiceSource,
      I: DimafxEnqueueIds, D: OverlayQueue + 'static {
    async fn mark(&self, id: ObjectId, state: &str) -> Result<(), String> {
        self.store.mark(id, state).await
    }
    async fn ensure_inventory(&self, channel: &str, user: &str) -> Result<(), String> {
        let now = DateTime::now();
        user_extension_inventory::collection(&self.database).update_one(identity(channel, user), doc! { "$setOnInsert": {
            "platform": "twitch", "channelID": channel, "userID": user, "displayName": Bson::Null,
            "balance": 0, "config": { "quickPurchasePriority": "credits_first", "quickPurchaseAction": "use_now" },
            "items": [], "dimafxReceipts": [], "createdAt": now
        }, "$set": { "updatedAt": now } }).upsert(true).await.map_err(|e| e.to_string())?;
        Ok(())
    }
    async fn refund(&self, ledger: &Document, id: ObjectId, channel: &str) -> Result<(), String> {
        self.mark(id, "refund_pending").await?;
        if let Some(user) = user(ledger) {
            self.ensure_inventory(channel, user).await?;
            DimafxFulfillment::native(self.database.clone()).refund_dimafx_once(channel, user, amount(ledger)?, &format!("refund:bits-{id}")).await.map_err(|e| e.to_string())?;
        }
        self.mark(id, "refunded").await
    }
    async fn recover_one(&self, ledger: Document, channel: &str) -> Result<(), String> {
        let id = ledger.get_object_id("_id").map_err(|e| e.to_string())?;
        let state = ledger.get_document("metadata").ok().and_then(|m| m.get_str("fulfillment").ok()).unwrap_or("fulfilled");
        if state == "fulfilled" || state == "refunded" { return Ok(()); }
        if state == "refund_pending" { return self.refund(&ledger, id, channel).await; }
        let now = DateTime::now();
        let claimed = self.store.claim(id, now).await?;
        if !claimed { return Ok(()); }
        let metadata = ledger.get_document("metadata").ok();
        let save = metadata.and_then(|m| m.get_str("action").ok()) == Some("save");
        let trigger = format!("bits-{id}");
        let saved = if save { if let Some(user) = user(&ledger) {
            let mut filter = identity(channel, user); filter.insert("dimafxReceipts", format!("save:{id}"));
            user_extension_inventory::collection(&self.database).find_one(filter).await.map_err(|e| e.to_string())?.is_some()
        } else { false } } else { false };
        let queued = if !save {
            let store = MongoPlaybackStore::new(self.database.clone());
            if store.existing(channel, &trigger).await.map_err(|e| e.to_string())?.is_some() {
                // Source existing() also reads queue length; failure stays ambiguous.
                store.queue_length(channel).await.map_err(|e| e.to_string())?; true
            } else { false }
        } else { false };
        if saved || queued { return self.mark(id, "fulfilled").await; }
        let item_id = match ledger.get("channelExtensionItemID") {
            Some(Bson::ObjectId(id)) => *id,
            Some(Bson::String(value)) => match ObjectId::parse_str(value) { Ok(item_id) => item_id, Err(_) => return self.refund(&ledger, id, channel).await },
            _ => return self.refund(&ledger, id, channel).await,
        };
        let item_doc = channel_extension_item::collection(&self.database).find_one(doc! { "_id": item_id, "channelID": channel, "isEnabled": true, "deletedAt": Bson::Null }).await.map_err(|e| e.to_string())?;
        let Some(item_doc) = item_doc else { return self.refund(&ledger, id, channel).await; };
        let item = decode_item(item_doc)?;
        let asset = if item.category == ChannelExtensionItemCategory::Tts { None } else {
            let Some(asset_id) = item.asset_id else { return self.refund(&ledger, id, channel).await; };
            let asset = media_asset::collection(&self.database).find_one(doc! { "_id": asset_id, "deletedAt": Bson::Null }).await.map_err(|e| e.to_string())?;
            let Some(asset) = asset else { return self.refund(&ledger, id, channel).await; };
            Some(decode_asset(asset)?)
        };
        if let Some(user) = user(&ledger) { self.ensure_inventory(channel, user).await?; }
        if save {
            let user = user(&ledger).ok_or_else(|| "save purchase has no userID".to_owned())?;
            // Recheck receipt after inventory creation, matching fulfillBitsPurchase.
            let mut filter = identity(channel, user); filter.insert("dimafxReceipts", format!("save:{id}"));
            let already_saved = user_extension_inventory::collection(&self.database).find_one(filter).await.map_err(|e| e.to_string())?.is_some();
            if !already_saved && self.sockets.ready_connections(channel) == 0 { return self.refund(&ledger, id, channel).await; }
            DimafxFulfillment::native(self.database.clone()).save_dimafx_purchase_once(channel, user, &item_id.to_hex(), amount(&ledger)?, &id.to_hex()).await.map_err(|e| e.to_string())?;
        } else {
            let result = self.queue.enqueue(DimafxEnqueueInput { channel_id: channel.into(), trigger_id: Some(trigger.into()), item, asset,
                viewer_text: metadata.and_then(|m| m.get_str("viewerText").ok()).map(Into::into),
                refund_on_failure: user(&ledger).map(|u| Ok::<_, String>(DimafxQueueRefund { user_id: u.into(), price_bits: amount(&ledger)? })).transpose()?,
                source: DimafxQueueSource::BitsPurchase }).await.map_err(|e| e.to_string())?;
            if matches!(result, DimafxEnqueueResult::Rejected(_)) { return self.refund(&ledger, id, channel).await; }
        }
        self.mark(id, "fulfilled").await
    }
}
impl<S, T, I, D> OverlayPurchaseRecovery for MongoPurchaseRecovery<S, T, I, D>
where S: DimafxEnqueueStore, T: DimafxTtsVoiceSource,
      I: DimafxEnqueueIds, D: OverlayQueue + 'static {
    fn recover<'a>(&'a self, channel: &'a str) -> OverlayFuture<'a> {
        Box::pin(async move {
            let pending = self.store.pending(channel, DateTime::now()).await?;
            for ledger in pending { self.recover_one(ledger, channel).await?; }
            Ok(())
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn stale_cutoff_and_claim_are_strict_and_distinct() {
        let now = DateTime::from_millis(100_000);
        let pending = pending_filter("c", now);
        assert_eq!(pending.get_document("updatedAt").unwrap().get_datetime("$lt").unwrap().timestamp_millis(), 70_000);
        let claim = claim_filter(ObjectId::new(), now);
        let choices = claim.get_array("$or").unwrap();
        assert_eq!(choices[0].as_document().unwrap().get_str("metadata.fulfillment").unwrap(), "pending");
        assert_eq!(choices[1].as_document().unwrap().get_document("updatedAt").unwrap().get_datetime("$lt").unwrap().timestamp_millis(), 70_000);
        assert_eq!(BATCH_LIMIT, 25);
    }
    #[test]
    fn malformed_amount_never_becomes_a_refund_value() {
        assert!(amount(&doc! { "amountBits": "bad" }).is_err());
        assert_eq!(amount(&doc! { "amountBits": 25 }).unwrap(), 25.0);
    }
}
