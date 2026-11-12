//! `goal_custom_receipts`.
//! Reference: goals/service.ts:29-33. No timestamps, __v, hooks or hidden paths.
//! Key: sha256(JSON.stringify([channel,eventKey])), looked up by _id.
//! Repeat rule: findOneAndUpdate with {_id,fingerprint}, $setOnInsert, upsert/new;
//! fingerprint = sha256(JSON.stringify([itemKey,quantity])). A duplicate _id with a differing
//! fingerprint is a conflict; matching deliveries reuse the original times permanently (no TTL).
//! Writers checked: goals/service.ts:227; assertCustomGoalReceiptCompatible:51 is read-only.
//! applyCustomGoalEvent checks identity, finite times, goalItemKey and goalInteger;
//! no unchecked client-fed writes, saves or runValidators. Census is empty, no legacy rows.
//! The built-in unique _id is the required identity fence; no additional declared unique index.
//! Server-only null/removal of READ_NEEDS paths is refused.

use crate::decode::decode_boxed;
use crate::{ClientNulls, CollectionInfo, Hooks, IndexSpec, ModelError, ReadNeed, Rule};
use bson::Document;
use dima_store::mongo::schema::{Field, Schema};
use dima_store::mongo::{WriteContext, id::IdType, insert::PreparedInsert, number::JsNumber};
use serde::{Deserialize, Serialize};
/// Collection name.
pub const COLLECTION: &str = "goal_custom_receipts";
/// Frozen schema.
pub static SCHEMA: Schema = Schema::new(&[
    Field::string("_id"),
    Field::string("channel"),
    Field::string("fingerprint"),
    Field::string("itemKey"),
    Field::number("quantity"),
    Field::number("occurredAt"),
    Field::number("journaledAt"),
])
.declared_id()
.no_version_key();
/// Hidden paths.
pub const HIDDEN: &[&str] = &[];
/// Private paths.
pub const PRIVATE: &[&str] = &[];
/// Declared indexes; best effort (identity uses built-in `_id_`).
pub const INDEXES: &[IndexSpec] = &[];
/// Validators.
pub const RULES: &[Rule] = &[
    Rule::required("channel"),
    Rule::required("fingerprint"),
    Rule::required("itemKey"),
    Rule::required("quantity"),
    Rule::required("occurredAt"),
    Rule::required("journaledAt"),
];
/// Read constraints.
pub const READ_NEEDS: &[ReadNeed] = &[
    ReadNeed::value("_id"),
    ReadNeed::value("channel"),
    ReadNeed::value("fingerprint"),
    ReadNeed::value("itemKey"),
    ReadNeed::value("quantity"),
    ReadNeed::value("occurredAt"),
    ReadNeed::value("journaledAt"),
];
/// Registry entry.
pub static INFO: CollectionInfo = CollectionInfo {
    name: COLLECTION,
    model: "GoalCustomReceipt",
    source: "dimabot/src/goals/service.ts",
    schema: &SCHEMA,
    id_type: IdType::String,
    hidden: HIDDEN,
    indexes: INDEXES,
    rules: RULES,
    read_needs: READ_NEEDS,
    hooks: Hooks::None,
    client_nulls: ClientNulls::None,
    initialised_at_startup: true,
    private: PRIVATE,
    decode: decode_boxed::<GoalCustomReceipt>,
};
/// Stored document.
#[derive(Clone, Debug, Deserialize)]
pub struct GoalCustomReceipt {
    /// `_id`.
    #[serde(rename = "_id")]
    pub id: String,
    /// `channel`.
    #[serde(rename = "channel")]
    pub channel: String,
    /// `fingerprint`.
    #[serde(rename = "fingerprint")]
    pub fingerprint: String,
    /// `itemKey`.
    #[serde(rename = "itemKey")]
    pub item_key: String,
    /// `quantity`.
    #[serde(rename = "quantity")]
    pub quantity: JsNumber,
    /// `occurredAt`.
    #[serde(rename = "occurredAt")]
    pub occurred_at: JsNumber,
    /// `journaledAt`.
    #[serde(rename = "journaledAt")]
    pub journaled_at: JsNumber,
}
/// Typed insert.
#[derive(Clone, Debug, Serialize)]
pub struct NewGoalCustomReceipt {
    /// `_id`.
    #[serde(rename = "_id")]
    pub id: String,
    /// `channel`.
    #[serde(rename = "channel")]
    pub channel: String,
    /// `fingerprint`.
    #[serde(rename = "fingerprint")]
    pub fingerprint: String,
    /// `itemKey`.
    #[serde(rename = "itemKey")]
    pub item_key: String,
    /// `quantity`.
    #[serde(rename = "quantity")]
    pub quantity: JsNumber,
    /// `occurredAt`.
    #[serde(rename = "occurredAt")]
    pub occurred_at: JsNumber,
    /// `journaledAt`.
    #[serde(rename = "journaledAt")]
    pub journaled_at: JsNumber,
}
impl NewGoalCustomReceipt {
    /// Input before defaults.
    pub fn to_document(&self) -> Result<Document, ModelError> {
        Ok(bson::serialize_to_document(self)?)
    }
    /// Validated insert.
    pub fn prepare(&self, ctx: &mut WriteContext) -> Result<PreparedInsert, ModelError> {
        INFO.prepare_create(&self.to_document()?, ctx)
    }
}
