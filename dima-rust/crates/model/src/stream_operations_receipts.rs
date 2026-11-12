//! `stream_operations_receipts`: reference `dimabot/src/schemas/stream_operations_receipt.schema.ts`.
//! Key: _id = event.eventKey (or reauth:<channelID>:<revision>).
//! Repeat rule: completed/skipped steps are skipped; failed steps retry. Accepted external
//! effects can repeat after a lost receipt acknowledgement; this is not exactly-once delivery.
//! Writers checked: domain_events/stream_operations_events.ts:79-87,124-175,207-248.
//! Client-fed writes: none; event identities and StepOutcome values are server-built.
//! No saves, hooks or runValidators. No timestamps or __v. channelID/expiresAt immutable.
//! Legacy: dynamic step keys, optional reason, steps absent defaults to an empty map.
//! Error reasons are private. Server-only nulls/removals in READ_NEEDS are refused.

use crate::Private;
use crate::decode::decode_boxed;
use crate::enums::str_enum;
use crate::{ClientNulls, CollectionInfo, Hooks, IndexSpec, ModelError, ReadNeed, Rule};
use bson::Document;
use dima_store::mongo::schema::MapOf;
use dima_store::mongo::schema::{DefaultValue as D, Field, Schema};
use dima_store::mongo::{WriteContext, date::JsDate, id::IdType, insert::PreparedInsert};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
str_enum! { /// Step outcome.
pub enum StepStatus { /// Completed.
Completed = "completed", /// Skipped.
Skipped = "skipped", /// Failed.
Failed = "failed" } }
/// Stored step outcome.
#[derive(Clone, Debug, Deserialize)]
pub struct StepOutcome {
    /// Status.
    pub status: crate::Open<StepStatus>,
    /// Error or skip reason.
    pub reason: Option<Private<String>>,
    /// Acknowledgement time.
    pub at: JsDate,
}
/// New step outcome.
#[derive(Clone, Debug, Serialize)]
pub struct NewStepOutcome {
    /// Status.
    pub status: StepStatus,
    /// Error or skip reason.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<Private<String>>,
    /// Acknowledgement time.
    pub at: JsDate,
}
static STEP: Schema = Schema::new(&[
    Field::string("status"),
    Field::string("reason"),
    Field::date("at"),
])
.no_id()
.no_version_key();
/// Collection name.
pub const COLLECTION: &str = "stream_operations_receipts";
/// Frozen schema.
pub static SCHEMA: Schema = Schema::new(&[
    Field::string("_id"),
    Field::string("channelID").immutable(),
    Field::date("expiresAt").immutable(),
    Field::map("steps", MapOf::Subdocuments(&STEP)).default(D::EmptyDocument),
])
.declared_id()
.no_version_key();
/// Hidden fields.
pub const HIDDEN: &[&str] = &[];
/// Private fields.
pub const PRIVATE: &[&str] = &["steps"];
/// Declared indexes.
pub const INDEXES: &[IndexSpec] = &[IndexSpec::on(&[("expiresAt", 1)]).expire_after_seconds(0)];
/// Validators.
pub const RULES: &[Rule] = &[
    Rule::required("_id"),
    Rule::required("channelID"),
    Rule::required("expiresAt"),
];
fn default_steps() -> Private<BTreeMap<String, Option<StepOutcome>>> {
    Private::new(BTreeMap::new())
}
/// Read constraints.
pub const READ_NEEDS: &[ReadNeed] = &[
    ReadNeed::value("_id"),
    ReadNeed::value("channelID"),
    ReadNeed::value("expiresAt"),
    ReadNeed::not_null("steps"),
    ReadNeed::value("steps.$*.status"),
    ReadNeed::value("steps.$*.at"),
];
/// Registry entry.
pub static INFO: CollectionInfo = CollectionInfo {
    name: COLLECTION,
    model: "stream_operations_receipt",
    source: "dimabot/src/schemas/stream_operations_receipt.schema.ts",
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
    decode: decode_boxed::<StreamOperationsReceipt>,
};
/// Hydrated document.
#[derive(Clone, Debug, Deserialize)]
pub struct StreamOperationsReceipt {
    /// `_id`.
    #[serde(rename = "_id")]
    pub id: String,
    /// `channelID`.
    #[serde(rename = "channelID")]
    pub channel_id: String,
    /// `expiresAt`.
    #[serde(rename = "expiresAt")]
    pub expires_at: JsDate,
    /// `steps`.
    #[serde(rename = "steps", default = "default_steps")]
    pub steps: Private<BTreeMap<String, Option<StepOutcome>>>,
}
/// Typed insert.
#[derive(Clone, Debug, Serialize)]
pub struct NewStreamOperationsReceipt {
    /// `_id`.
    #[serde(rename = "_id")]
    pub id: String,
    /// `channelID`.
    #[serde(rename = "channelID")]
    pub channel_id: String,
    /// `expiresAt`.
    #[serde(rename = "expiresAt")]
    pub expires_at: JsDate,
    /// `steps`.
    #[serde(rename = "steps", skip_serializing_if = "Option::is_none")]
    pub steps: Option<Private<BTreeMap<String, Option<NewStepOutcome>>>>,
}
impl NewStreamOperationsReceipt {
    /// Input before defaults.
    pub fn to_document(&self) -> Result<Document, ModelError> {
        Ok(bson::serialize_to_document(self)?)
    }
    /// Validated insert.
    pub fn prepare(&self, ctx: &mut WriteContext) -> Result<PreparedInsert, ModelError> {
        INFO.prepare_create(&self.to_document()?, ctx)
    }
}
