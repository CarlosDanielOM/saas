//! `ai_usage_receipts`: one line per AI credit movement of a channel's billing customer (a usage
//! charge or an adjustment), kept for the plan's retention and shown in the usage history.
//!
//! Reference: `dimabot/src/schemas/ai_usage_receipt.schema.ts` (model `ai_usage_receipts`), written
//! by `utils/ai_usage_ledger.ts` (one receipt: an upsert with `$setOnInsert` on
//! `{channelID, customerId, entryId}`; a backfill: the same in bulk with `source` and
//! `adjustmentType` in `$set`; a plan change: a pipeline `$set` of `retentionTier` and
//! `expiresAt`) and by the native receipts worker. Snake-case timestamps, `__v`, no hooks.
//!
//! Indexes: the unique `{channelID, customerId, entryId}`, eight history scans and the TTL on
//! `expiresAt`. The unique index is required before the first write
//! ([`crate::startup_policy`]): the upsert on it is what makes a receipt idempotent, and without
//! it two deliveries of one receipt would both be stored and counted twice in the daily totals.
//!
//! Money: `credits` and `quantity` keep the BSON number type they were stored with
//! ([`JsNumber`] reads int32, int64 and double; the store writes a JavaScript number as Node
//! does). The `default: null` paths are `null` on most documents (the census shows every one of
//! them stored as `null`), so they are `Option`s. `customerId` (a Polar customer id) is private.
//!
//! Intended difference (`crate::shape`): the write helpers refuse a value of the wrong BSON type,
//! and `null` or a removal where [`READ_NEEDS`] says the read type has none; the census of the
//! production copy shows none stored there, so Mongoose's acceptance of them is not reproduced.

use crate::collection::{CollectionInfo, Hooks};
use crate::decode::decode_boxed;
use crate::enums::{Open, StrEnum, str_enum};
use crate::error::ModelError;
use crate::index::IndexSpec;
use crate::private::Private;
use crate::shape::ReadNeed;
use crate::validation::Rule;
use crate::values::Nullable;
use bson::Document;
use bson::oid::ObjectId;
use dima_store::mongo::WriteContext;
use dima_store::mongo::date::JsDate;
use dima_store::mongo::id::IdType;
use dima_store::mongo::insert::PreparedInsert;
use dima_store::mongo::number::JsNumber;
use dima_store::mongo::schema::{DefaultValue as D, Field, Schema, Timestamps};
use serde::{Deserialize, Serialize};

/// The collection name.
pub const COLLECTION: &str = "ai_usage_receipts";

str_enum! {
    /// `retentionTier` (the plan whose retention applies; also `ai_usage_dailies`).
    pub enum RetentionTier {
        /// Free plan.
        Free = "free",
        /// Premium plan.
        Premium = "premium",
        /// Pro plan.
        Pro = "pro",
    }
}

str_enum! {
    /// `entryKind`.
    pub enum EntryKind {
        /// A usage charge.
        Usage = "usage",
        /// A grant, refund or manual change.
        Adjustment = "adjustment",
    }
}

/// The schema, field by field as `ai_usage_receipt.schema.ts` declares it.
pub static SCHEMA: Schema = Schema::new(&[
    Field::string("channelID"),
    Field::string("customerId"),
    Field::string("entryId"),
    Field::string("requestId").default(D::Null),
    Field::date("occurredAt"),
    Field::string("entryKind"),
    Field::string("category"),
    Field::string("operation"),
    Field::string("source").default(D::Null),
    Field::string("adjustmentType").default(D::Null),
    Field::string("provider"),
    Field::string("model").default(D::Null),
    Field::number("quantity").default(D::Null),
    Field::string("unit").default(D::Null),
    Field::number("credits"),
    Field::string("resourceType").default(D::Null),
    Field::string("resourceId").default(D::Null),
    Field::boolean("itemized"),
    Field::string("retentionTier"),
    Field::date("expiresAt"),
])
.timestamps(Timestamps::SNAKE);

const fn scan(field: &'static str) -> [(&'static str, i32); 5] {
    [
        ("channelID", 1),
        ("customerId", 1),
        (field, 1),
        ("occurredAt", -1),
        ("entryId", -1),
    ]
}

const BY_SOURCE: [(&str, i32); 5] = scan("source");
const BY_RESOURCE: [(&str, i32); 5] = scan("resourceId");
const BY_REQUEST: [(&str, i32); 5] = scan("requestId");
const BY_KIND: [(&str, i32); 5] = scan("entryKind");
const BY_ADJUSTMENT: [(&str, i32); 5] = scan("adjustmentType");

/// The declared indexes, in `schema.index` order.
pub const INDEXES: &[IndexSpec] = &[
    IndexSpec::on(&[("channelID", 1), ("customerId", 1), ("entryId", 1)]).unique(),
    IndexSpec::on(&[
        ("channelID", 1),
        ("customerId", 1),
        ("occurredAt", -1),
        ("entryId", -1),
    ]),
    IndexSpec::on(&[
        ("channelID", 1),
        ("customerId", 1),
        ("category", 1),
        ("occurredAt", -1),
        ("entryId", -1),
    ]),
    IndexSpec::on(&BY_SOURCE),
    IndexSpec::on(&BY_RESOURCE),
    IndexSpec::on(&BY_REQUEST),
    IndexSpec::on(&BY_KIND),
    IndexSpec::on(&BY_ADJUSTMENT),
    IndexSpec::on(&[("expiresAt", 1)]).expire_after_seconds(0),
];

/// The validators, in schema path order.
pub const RULES: &[Rule] = &[
    Rule::required("channelID"),
    Rule::required("customerId"),
    Rule::required("entryId"),
    Rule::required("occurredAt"),
    Rule::required("entryKind"),
    Rule::one_of("entryKind", EntryKind::STRINGS),
    Rule::required("category"),
    Rule::required("operation"),
    Rule::required("provider"),
    Rule::required("credits"),
    Rule::required("itemized"),
    Rule::required("retentionTier"),
    Rule::one_of("retentionTier", RetentionTier::STRINGS),
    Rule::required("expiresAt"),
];

/// The private paths: their read type fields are [`crate::Private`].
pub const PRIVATE: &[&str] = &["customerId"];

/// What the read type cannot decode (`crate::shape`): the write helpers refuse it.
pub const READ_NEEDS: &[ReadNeed] = &[
    ReadNeed::value("channelID"),
    ReadNeed::value("customerId"),
    ReadNeed::value("entryId"),
    ReadNeed::value("occurredAt"),
    ReadNeed::value("entryKind"),
    ReadNeed::value("category"),
    ReadNeed::value("operation"),
    ReadNeed::value("provider"),
    ReadNeed::value("credits"),
    ReadNeed::value("itemized"),
    ReadNeed::value("retentionTier"),
    ReadNeed::value("expiresAt"),
];

/// The registry entry.
pub static INFO: CollectionInfo = CollectionInfo {
    name: COLLECTION,
    model: "ai_usage_receipts",
    source: "dimabot/src/schemas/ai_usage_receipt.schema.ts",
    schema: &SCHEMA,
    id_type: IdType::ObjectId,
    hidden: &[],
    indexes: INDEXES,
    rules: RULES,
    read_needs: READ_NEEDS,
    hooks: Hooks::None,
    private: PRIVATE,
    decode: decode_boxed::<AiUsageReceipt>,
};

/// A stored receipt.
#[derive(Clone, Debug, Deserialize)]
pub struct AiUsageReceipt {
    /// `_id`.
    #[serde(rename = "_id")]
    pub id: ObjectId,
    /// The channel.
    #[serde(rename = "channelID")]
    pub channel_id: String,
    /// The Polar customer.
    #[serde(rename = "customerId")]
    pub customer_id: Private<String>,
    /// The billing entry's id (unique per channel and customer).
    #[serde(rename = "entryId")]
    pub entry_id: String,
    /// The AI request it belongs to.
    #[serde(default, rename = "requestId")]
    pub request_id: Option<String>,
    /// When it happened.
    #[serde(rename = "occurredAt")]
    pub occurred_at: JsDate,
    /// Usage or adjustment.
    #[serde(rename = "entryKind")]
    pub entry_kind: Open<EntryKind>,
    /// The usage category.
    pub category: String,
    /// The operation.
    pub operation: String,
    /// Where it came from.
    #[serde(default)]
    pub source: Option<String>,
    /// The adjustment's kind.
    #[serde(default, rename = "adjustmentType")]
    pub adjustment_type: Option<String>,
    /// The AI provider.
    pub provider: String,
    /// The model.
    #[serde(default)]
    pub model: Option<String>,
    /// The quantity billed (tokens, characters, seconds...).
    #[serde(default)]
    pub quantity: Option<JsNumber>,
    /// The quantity's unit.
    #[serde(default)]
    pub unit: Option<String>,
    /// Credits charged (negative for a grant).
    pub credits: JsNumber,
    /// The kind of resource it was for.
    #[serde(default, rename = "resourceType")]
    pub resource_type: Option<String>,
    /// The resource it was for.
    #[serde(default, rename = "resourceId")]
    pub resource_id: Option<String>,
    /// Shown as its own line.
    pub itemized: bool,
    /// The plan whose retention applies.
    #[serde(rename = "retentionTier")]
    pub retention_tier: Open<RetentionTier>,
    /// End of retention (TTL).
    #[serde(rename = "expiresAt")]
    pub expires_at: JsDate,
    /// Creation time.
    #[serde(default)]
    pub created_at: Option<JsDate>,
    /// Last update time.
    #[serde(default)]
    pub updated_at: Option<JsDate>,
}

/// A receipt as `receiptDocument` builds it (`utils/ai_usage_ledger.ts:154`): the reference
/// passes every nullable path explicitly, as `null` when the queued receipt has none, so those
/// are [`Nullable`].
#[derive(Clone, Debug, Serialize)]
pub struct NewAiUsageReceipt {
    /// The channel.
    #[serde(rename = "channelID")]
    pub channel_id: String,
    /// The Polar customer.
    #[serde(rename = "customerId")]
    pub customer_id: Private<String>,
    /// The billing entry's id.
    #[serde(rename = "entryId")]
    pub entry_id: String,
    /// The AI request.
    #[serde(rename = "requestId", skip_serializing_if = "Nullable::is_unset")]
    pub request_id: Nullable<String>,
    /// When it happened.
    #[serde(rename = "occurredAt")]
    pub occurred_at: JsDate,
    /// Usage or adjustment.
    #[serde(rename = "entryKind")]
    pub entry_kind: EntryKind,
    /// The usage category.
    pub category: String,
    /// The operation.
    pub operation: String,
    /// Where it came from.
    #[serde(skip_serializing_if = "Nullable::is_unset")]
    pub source: Nullable<String>,
    /// The adjustment's kind.
    #[serde(rename = "adjustmentType", skip_serializing_if = "Nullable::is_unset")]
    pub adjustment_type: Nullable<String>,
    /// The AI provider.
    pub provider: String,
    /// The model.
    #[serde(skip_serializing_if = "Nullable::is_unset")]
    pub model: Nullable<String>,
    /// The quantity billed.
    #[serde(skip_serializing_if = "Nullable::is_unset")]
    pub quantity: Nullable<JsNumber>,
    /// The quantity's unit.
    #[serde(skip_serializing_if = "Nullable::is_unset")]
    pub unit: Nullable<String>,
    /// Credits charged.
    pub credits: JsNumber,
    /// The kind of resource.
    #[serde(rename = "resourceType", skip_serializing_if = "Nullable::is_unset")]
    pub resource_type: Nullable<String>,
    /// The resource.
    #[serde(rename = "resourceId", skip_serializing_if = "Nullable::is_unset")]
    pub resource_id: Nullable<String>,
    /// Shown as its own line.
    pub itemized: bool,
    /// The plan whose retention applies.
    #[serde(rename = "retentionTier")]
    pub retention_tier: RetentionTier,
    /// End of retention.
    #[serde(rename = "expiresAt")]
    pub expires_at: JsDate,
}

impl NewAiUsageReceipt {
    /// The values given to the constructor (before defaults).
    pub fn to_document(&self) -> Result<Document, ModelError> {
        Ok(bson::serialize_to_document(self)?)
    }

    /// The insert Mongoose sends for `Model.create` (the reference upserts instead: pass
    /// [`NewAiUsageReceipt::to_document`] as `$setOnInsert`).
    pub fn prepare(&self, ctx: &mut WriteContext) -> Result<PreparedInsert, ModelError> {
        INFO.prepare_create(&self.to_document()?, ctx)
    }
}
