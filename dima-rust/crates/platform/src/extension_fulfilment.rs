//! DimaFX refund/save effects from `server/services/dimafx-fulfillment.service.ts`.
//! Refunds deduplicate by the exact receipt; saves by `save:{ledgerID}`. The receipt
//! and balance increment/item append are one conditional Mongo update (no upsert).
//! Cancellation or timeout can leave a committed effect: retry with the SAME identity
//! and receipt, never a newly generated one. A receipt's amount/item is not revalidated
//! on replay, matching the reference. Receipts are never pruned: that would spend twice.
//! Callers create the wallet and ensure the model's required identity index first;
//! supply a store, injected clock and nonzero deadline. No environment or hidden tasks.
//! Caller sources: `dimafx.route.ts:500,520` uses persisted Bits ledger/playback ids;
//! `dimafx_queue.handler.ts:333` uses `refund:{job._id}`. IDs/receipts are not trimmed.
use bson::{DateTime, Document, doc, oid::ObjectId};
use dima_core::Clock;
use dima_model::user_extension_inventories::{INFO, UserExtensionInventory};
use dima_store::mongo::{MongoStore, WriteContext, update::UpdateOptions};
#[cfg(feature = "test-util")]
use futures_util::future::BoxFuture;
use std::{sync::Arc, time::Duration};

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("invalid fulfilment input or deadline")]
    Invalid,
    #[error("fulfilment deadline exceeded; retry with the same receipt")]
    Deadline,
    #[error("DimaFX refund inventory is unavailable")]
    RefundUnavailable,
    #[error("DimaFX inventory is unavailable")]
    InventoryUnavailable,
    #[error(transparent)]
    Model(#[from] dima_model::ModelError),
    #[error(transparent)]
    Decode(#[from] dima_model::DecodeError),
    #[error(transparent)]
    Write(#[from] dima_store::mongo::write::WriteError),
    #[error(transparent)]
    Mongo(#[from] mongodb::error::Error),
}
#[derive(Clone, Debug)]
pub struct Config {
    /// Total deadline, including confirmation read; the reference has none.
    pub store_deadline: Duration,
}
impl Default for Config {
    fn default() -> Self {
        Self {
            store_deadline: Duration::from_secs(5),
        }
    }
}
#[derive(Clone)]
pub struct Fulfilment {
    store: MongoStore,
    clock: Arc<dyn Clock>,
    config: Config,
    #[cfg(feature = "test-util")]
    after_write: Option<Arc<dyn Fn() -> BoxFuture<'static, ()> + Send + Sync>>,
}
fn bounded_text(value: &str) -> bool {
    !value.is_empty() && value.len() <= 256
}
impl Fulfilment {
    pub fn new(store: MongoStore, clock: Arc<dyn Clock>, config: Config) -> Result<Self, Error> {
        if config.store_deadline.is_zero() {
            return Err(Error::Invalid);
        }
        Ok(Self {
            store,
            clock,
            config,
            #[cfg(feature = "test-util")]
            after_write: None,
        })
    }
    /// Deterministic cancellation point after Mongo acknowledged the atomic write.
    #[cfg(feature = "test-util")]
    pub fn with_after_write_hook(
        mut self,
        hook: Arc<dyn Fn() -> BoxFuture<'static, ()> + Send + Sync>,
    ) -> Self {
        self.after_write = Some(hook);
        self
    }
    async fn written(&self) {
        #[cfg(feature = "test-util")]
        if let Some(hook) = &self.after_write {
            hook().await;
        }
    }
    async fn apply(
        &self,
        identity: Document,
        receipt: &str,
        mut effect: Document,
    ) -> Result<u64, Error> {
        let mut filter = identity;
        filter.insert("dimafxReceipts", doc! {"$ne":receipt});
        effect.insert("$addToSet", doc! {"dimafxReceipts":receipt});
        let prepared = INFO.prepare_update(
            &filter,
            effect,
            UpdateOptions::default(),
            &mut WriteContext::new(self.clock.now_ms()),
        )?;
        let result = self.store.writes(INFO.name).update_one(&prepared).await?;
        self.written().await;
        Ok(result.matched)
    }
    pub async fn refund_dimafx_once(
        &self,
        channel: &str,
        user: &str,
        amount: f64,
        receipt: &str,
    ) -> Result<(), Error> {
        if amount <= 0.0 {
            return Ok(());
        }
        if !amount.is_finite() || ![channel, user, receipt].into_iter().all(bounded_text) {
            return Err(Error::Invalid);
        }
        tokio::time::timeout(self.config.store_deadline, async {
            let identity = doc! {"platform":"twitch","channelID":channel,"userID":user};
            if self
                .apply(identity.clone(), receipt, doc! {"$inc":{"balance":amount}})
                .await?
                == 0
            {
                let mut filter = identity;
                filter.insert("dimafxReceipts", receipt);
                if self
                    .store
                    .documents(INFO.name)
                    .find_one(filter)
                    .projection(doc! {"_id":1})
                    .await?
                    .is_none()
                {
                    return Err(Error::RefundUnavailable);
                }
            }
            Ok(())
        })
        .await
        .map_err(|_| Error::Deadline)?
    }
    pub async fn save_dimafx_purchase_once(
        &self,
        channel: &str,
        user: &str,
        item: ObjectId,
        price: f64,
        ledger_id: &str,
    ) -> Result<UserExtensionInventory, Error> {
        if !price.is_finite()
            || price < 0.0
            || ![channel, user, ledger_id].into_iter().all(bounded_text)
        {
            return Err(Error::Invalid);
        }
        tokio::time::timeout(self.config.store_deadline, async {
            let identity = doc! {"platform":"twitch","channelID":channel,"userID":user};
            let receipt = format!("save:{ledger_id}");
            self.apply(identity.clone(), &receipt, doc! {"$push":{"items":{"channelExtensionItemID":item,"quantity":1,"purchasePriceBits":price,"acquiredAt":DateTime::from_millis(self.clock.now_ms()),"source":"bits_purchase"}}}).await?;
            let mut filter=identity; filter.insert("dimafxReceipts",receipt);
            let inventory=self.store.documents(INFO.name).find_one(filter).await?.ok_or(Error::InventoryUnavailable)?;
            Ok(dima_model::decode_document(&inventory)?)
        }).await.map_err(|_| Error::Deadline)?
    }
}
