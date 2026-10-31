//! Receipt-guarded Mongo inventory operations from
//! `dimafx-fulfillment.service.ts`.
//!
//! Both operations are one-shot by receipt and keep the receipt and its
//! monetary/inventory effect in ONE document update:
//!
//! * `refundDimafxOnce` credits `balance` and records the receipt together.
//! * `saveDimafxPurchaseOnce` records the receipt and pushes the purchased
//!   item together, then returns the receipt-bearing inventory.
//!
//! The repository is a trait with the concrete [`MongoDimafxInventory`]
//! production adapter, matching the house seam pattern. Constructors perform
//! no I/O; callers supply an existing [`Database`].

use crate::schemas::user_extension_inventory;
use mongodb::{
    Collection, Database,
    bson::{DateTime, Document, doc, oid::ObjectId},
};
use std::{fmt, future::Future};

/// Source error when the identity exists but the refund receipt does not.
pub const REFUND_UNAVAILABLE: &str = "DimaFX refund inventory is unavailable";
/// Source error when the saved purchase cannot be read back.
pub const INVENTORY_UNAVAILABLE: &str = "DimaFX inventory is unavailable";
/// Native equivalent of the `Types.ObjectId` cast failure.
pub const INVALID_ITEM_ID: &str = "Invalid channel extension item ID";

/// Fulfillment failure, including the source's unavailable-inventory errors.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FulfillmentError(pub String);
impl fmt::Display for FulfillmentError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}
impl std::error::Error for FulfillmentError {}

/// The two Mongo operations used by the source service.
pub trait DimafxInventoryRepository: Send + Sync {
    /// `updateOne`; return the matched document count.
    fn update_one(
        &self,
        filter: Document,
        update: Document,
    ) -> impl Future<Output = Result<u64, FulfillmentError>> + Send;

    /// `findOne`/`exists`; return the matching inventory document.
    fn find_one(
        &self,
        filter: Document,
    ) -> impl Future<Output = Result<Option<Document>, FulfillmentError>> + Send;
}

/// Production adapter backed by the existing inventory schema collection.
#[derive(Clone)]
pub struct MongoDimafxInventory {
    database: Database,
}
impl MongoDimafxInventory {
    /// Construct without network I/O.
    pub fn new(database: Database) -> Self {
        Self { database }
    }

    fn collection(&self) -> Collection<Document> {
        user_extension_inventory::collection(&self.database)
    }
}
impl DimafxInventoryRepository for MongoDimafxInventory {
    async fn update_one(
        &self,
        filter: Document,
        update: Document,
    ) -> Result<u64, FulfillmentError> {
        let collection = self.collection();
        collection
            .update_one(filter, update)
            .await
            .map(|result| result.matched_count)
            .map_err(|error| FulfillmentError(error.to_string()))
    }

    async fn find_one(&self, filter: Document) -> Result<Option<Document>, FulfillmentError> {
        let collection = self.collection();
        collection
            .find_one(filter)
            .await
            .map_err(|error| FulfillmentError(error.to_string()))
    }
}

/// Fulfillment service parameterized by a concrete repository.
pub struct DimafxFulfillment<R> {
    repository: R,
}
impl DimafxFulfillment<MongoDimafxInventory> {
    /// Full native wiring with a caller-owned database; no connection is made here.
    pub fn native(database: Database) -> Self {
        Self::with_adapters(MongoDimafxInventory::new(database))
    }
}
impl<R: DimafxInventoryRepository> DimafxFulfillment<R> {
    /// Supply an isolated or alternate repository.
    pub fn with_adapters(repository: R) -> Self {
        Self { repository }
    }

    /// Apply a refund once.
    pub async fn refund_dimafx_once(
        &self,
        channel: &str,
        user: &str,
        amount: f64,
        receipt: &str,
    ) -> Result<(), FulfillmentError> {
        refund_dimafx_once(&self.repository, channel, user, amount, receipt).await
    }

    /// Save a purchase once and return its inventory.
    pub async fn save_dimafx_purchase_once(
        &self,
        channel: &str,
        user: &str,
        item: &str,
        price: f64,
        ledger: &str,
    ) -> Result<Document, FulfillmentError> {
        save_dimafx_purchase_once(&self.repository, channel, user, item, price, ledger).await
    }
}

/// Atomically credit a refund and its receipt; duplicates succeed without
/// another credit.
///
/// `amount <= 0` returns before any repository call, exactly like the source.
pub async fn refund_dimafx_once<R: DimafxInventoryRepository>(
    repository: &R,
    channel: &str,
    user: &str,
    amount: f64,
    receipt: &str,
) -> Result<(), FulfillmentError> {
    if amount <= 0.0 {
        return Ok(());
    }
    let filter = doc! {
        "platform": "twitch",
        "channelID": channel,
        "userID": user,
        "dimafxReceipts": { "$ne": receipt },
    };
    let update = doc! {
        "$inc": { "balance": amount },
        "$addToSet": { "dimafxReceipts": receipt },
    };
    if repository.update_one(filter, update).await? == 0
        && repository
            .find_one(doc! {
                "platform": "twitch",
                "channelID": channel,
                "userID": user,
                "dimafxReceipts": receipt,
            })
            .await?
            .is_none()
    {
        return Err(FulfillmentError(REFUND_UNAVAILABLE.to_owned()));
    }
    Ok(())
}

/// Atomically append an item and receipt, then retrieve the receipt-bearing
/// inventory. A duplicate receipt still returns the existing inventory.
pub async fn save_dimafx_purchase_once<R: DimafxInventoryRepository>(
    repository: &R,
    channel: &str,
    user: &str,
    item: &str,
    price: f64,
    ledger: &str,
) -> Result<Document, FulfillmentError> {
    let item = ObjectId::parse_str(item)
        .map_err(|_| FulfillmentError(INVALID_ITEM_ID.to_owned()))?;
    let receipt = format!("save:{ledger}");
    repository
        .update_one(
            doc! {
                "platform": "twitch",
                "channelID": channel,
                "userID": user,
                "dimafxReceipts": { "$ne": receipt.as_str() },
            },
            doc! {
                "$addToSet": { "dimafxReceipts": receipt.as_str() },
                "$push": {
                    "items": {
                        "channelExtensionItemID": item,
                        "quantity": 1,
                        "purchasePriceBits": price,
                        "acquiredAt": DateTime::now(),
                        "source": "bits_purchase",
                    },
                },
            },
        )
        .await?;
    repository
        .find_one(doc! {
            "platform": "twitch",
            "channelID": channel,
            "userID": user,
            "dimafxReceipts": receipt,
        })
        .await?
        .ok_or_else(|| FulfillmentError(INVENTORY_UNAVAILABLE.to_owned()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        collections::VecDeque,
        sync::Mutex,
    };

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

    fn run<T>(future: impl Future<Output = T>) -> T {
        tokio::runtime::Builder::new_current_thread()
            .build()
            .expect("test runtime")
            .block_on(future)
    }

    #[test]
    fn nonpositive_refund_skips_repository() {
        let repository = RecordingRepository::default();
        run(refund_dimafx_once(&repository, "c", "u", 0.0, "r")).unwrap();
        run(refund_dimafx_once(&repository, "c", "u", -1.0, "r")).unwrap();
        assert!(repository.updates().is_empty());
        assert!(repository.finds().is_empty());
    }

    #[test]
    fn refund_writes_receipt_and_balance_in_one_update() {
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
        assert_eq!(updates.len(), 1);
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
    }

    #[test]
    fn refund_duplicate_receipt_succeeds() {
        let repository = RecordingRepository::with_results(0, Some(doc! { "_id": "existing" }));
        run(refund_dimafx_once(
            &repository,
            "channel",
            "user",
            5.0,
            "refund:bits-1",
        ))
        .unwrap();
        assert_eq!(
            repository.finds(),
            vec![doc! {
                "platform": "twitch",
                "channelID": "channel",
                "userID": "user",
                "dimafxReceipts": "refund:bits-1",
            }]
        );
    }

    #[test]
    fn refund_missing_inventory_fails() {
        let repository = RecordingRepository::with_results(0, None);
        assert_eq!(
            run(refund_dimafx_once(&repository, "c", "u", 1.0, "r")),
            Err(FulfillmentError(REFUND_UNAVAILABLE.to_owned()))
        );
    }

    #[test]
    fn save_derives_receipt_and_pushes_item() {
        let item_id = ObjectId::parse_str("507f1f77bcf86cd799439011").unwrap();
        let inventory = doc! { "_id": ObjectId::new() };
        let repository = RecordingRepository::with_results(0, Some(inventory.clone()));
        let saved = run(save_dimafx_purchase_once(
            &repository,
            "channel",
            "user",
            "507f1f77bcf86cd799439011",
            5.0,
            "ledger-1",
        ))
        .unwrap();
        assert_eq!(saved, inventory);

        let updates = repository.updates();
        assert_eq!(updates.len(), 1);
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
        let items = update
            .get_document("$push")
            .unwrap()
            .get_array("items")
            .unwrap();
        assert_eq!(items.len(), 1);
        let item = items[0].as_document().unwrap();
        assert_eq!(
            item.get_object_id("channelExtensionItemID").unwrap(),
            item_id
        );
        assert_eq!(
            item.get("quantity")
                .and_then(|value| value.as_i32().map(i64::from).or_else(|| value.as_i64())),
            Some(1)
        );
        assert_eq!(item.get_f64("purchasePriceBits").unwrap(), 5.0);
        assert_eq!(item.get_str("source").unwrap(), "bits_purchase");
        assert!(item.get_datetime("acquiredAt").is_ok());
        assert_eq!(
            repository.finds(),
            vec![doc! {
                "platform": "twitch",
                "channelID": "channel",
                "userID": "user",
                "dimafxReceipts": "save:ledger-1",
            }]
        );
    }

    #[test]
    fn save_duplicate_receipt_returns_existing_inventory() {
        let inventory = doc! { "_id": ObjectId::new(), "balance": 10.0 };
        let repository = RecordingRepository::with_results(0, Some(inventory.clone()));
        let saved = run(save_dimafx_purchase_once(
            &repository,
            "channel",
            "user",
            "507f1f77bcf86cd799439011",
            5.0,
            "ledger-1",
        ))
        .unwrap();
        assert_eq!(saved, inventory);
        assert_eq!(repository.updates().len(), 1);
        assert_eq!(repository.finds().len(), 1);
    }

    #[test]
    fn save_missing_inventory_fails() {
        let repository = RecordingRepository::with_results(0, None);
        assert_eq!(
            run(save_dimafx_purchase_once(
                &repository,
                "channel",
                "user",
                "507f1f77bcf86cd799439011",
                5.0,
                "ledger-1",
            )),
            Err(FulfillmentError(INVENTORY_UNAVAILABLE.to_owned()))
        );
    }

    #[test]
    fn save_rejects_invalid_item_id_without_database_calls() {
        let repository = RecordingRepository::default();
        assert_eq!(
            run(save_dimafx_purchase_once(
                &repository,
                "channel",
                "user",
                "not-an-object-id",
                5.0,
                "ledger-1",
            )),
            Err(FulfillmentError(INVALID_ITEM_ID.to_owned()))
        );
        assert!(repository.updates().is_empty());
        assert!(repository.finds().is_empty());
    }

    #[test]
    fn service_wraps_repository() {
        let repository = RecordingRepository::with_results(1, None);
        let service = DimafxFulfillment::with_adapters(repository);
        run(service.refund_dimafx_once("c", "u", 1.0, "r")).unwrap();
        assert_eq!(service.repository.updates().len(), 1);
    }
}
