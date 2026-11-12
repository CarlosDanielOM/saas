//! `ai_usage_dailies`: a channel's AI credit totals per UTC day, rebuilt from the receipts.
//!
//! Reference: `dimabot/src/schemas/ai_usage_daily.schema.ts` (model `ai_usage_daily`), written by
//! `utils/ai_usage_ledger.ts`: a rebuild deletes a range of days and `insertMany`s them again
//! (validated like a create), and a plan change rewrites `retentionTier` and `expiresAt` with a
//! pipeline update. Snake-case timestamps, `__v`, no hooks. Unique `{channelID, customerId,
//! date}` and the TTL on `expiresAt`; best effort (the rebuild replaces a range under the ledger
//! lock, so a duplicate day cannot outlive the next rebuild). `customerId` is private.
//!
//! Legacy shape: `categories` is required with a `{}` default, and Mongoose validates before it
//! minimizes, so a day without itemized usage is stored without `categories` (66 documents of
//! the copy); it reads as `{}`. Numbers keep their stored width ([`JsNumber`]).
//!
//! Client-fed writes (`null` from a request body): none: its writers (`ledger/mongo.json`) store
//! values the server builds or checks, and no request body reaches them unchecked.
//!
//! Intended difference (`crate::shape`): the write helpers refuse a value of the wrong BSON type,
//! and `null` or a removal where [`READ_NEEDS`] says the read type has none; the census of the
//! production copy shows none stored there, so Mongoose's acceptance of them is not reproduced.

use crate::ai_usage_receipts::RetentionTier;
use crate::collection::{ClientNulls, CollectionInfo, Hooks};
use crate::decode::decode_boxed;
use crate::defaults::zero;
use crate::enums::{Open, StrEnum};
use crate::error::ModelError;
use crate::index::IndexSpec;
use crate::private::Private;
use crate::shape::ReadNeed;
use crate::validation::Rule;
use bson::oid::ObjectId;
use bson::{Bson, Document};
use dima_store::mongo::WriteContext;
use dima_store::mongo::date::JsDate;
use dima_store::mongo::id::IdType;
use dima_store::mongo::insert::PreparedInsert;
use dima_store::mongo::number::JsNumber;
use dima_store::mongo::schema::{DefaultValue as D, Field, Schema, Timestamps};
use serde::{Deserialize, Serialize};

/// The collection name.
pub const COLLECTION: &str = "ai_usage_dailies";

/// The schema, field by field as `ai_usage_daily.schema.ts` declares it.
pub static SCHEMA: Schema = Schema::new(&[
    Field::string("channelID"),
    Field::string("customerId"),
    Field::string("date"),
    Field::date("dayStart"),
    Field::number("spentCredits").default(D::Int(0)),
    Field::number("grantedCredits").default(D::Int(0)),
    Field::number("netConsumedCredits").default(D::Int(0)),
    Field::number("transactionCount").default(D::Int(0)),
    // `default: {}`: Mongoose turns an object literal on a Mixed path into a function.
    Field::mixed("categories").default_fn(D::EmptyDocument),
    Field::string("retentionTier"),
    Field::date("expiresAt"),
])
.timestamps(Timestamps::SNAKE);

/// The declared indexes, in `schema.index` order.
pub const INDEXES: &[IndexSpec] = &[
    IndexSpec::on(&[("channelID", 1), ("customerId", 1), ("date", 1)]).unique(),
    IndexSpec::on(&[("expiresAt", 1)]).expire_after_seconds(0),
];

/// The validators, in schema path order.
pub const RULES: &[Rule] = &[
    Rule::required("channelID"),
    Rule::required("customerId"),
    Rule::required("date"),
    Rule::required("dayStart"),
    Rule::required("spentCredits"),
    Rule::required("grantedCredits"),
    Rule::required("netConsumedCredits"),
    Rule::required("transactionCount"),
    Rule::required("categories"),
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
    ReadNeed::value("date"),
    ReadNeed::value("dayStart"),
    ReadNeed::not_null("spentCredits"),
    ReadNeed::not_null("grantedCredits"),
    ReadNeed::not_null("netConsumedCredits"),
    ReadNeed::not_null("transactionCount"),
    ReadNeed::value("retentionTier"),
    ReadNeed::value("expiresAt"),
];

/// The registry entry.
pub static INFO: CollectionInfo = CollectionInfo {
    name: COLLECTION,
    model: "ai_usage_daily",
    source: "dimabot/src/schemas/ai_usage_daily.schema.ts",
    schema: &SCHEMA,
    id_type: IdType::ObjectId,
    hidden: &[],
    indexes: INDEXES,
    rules: RULES,
    read_needs: READ_NEEDS,
    hooks: Hooks::None,
    client_nulls: ClientNulls::None,
    initialised_at_startup: true,
    private: PRIVATE,
    decode: decode_boxed::<AiUsageDaily>,
};

/// A stored day.
#[derive(Clone, Debug, Deserialize)]
pub struct AiUsageDaily {
    /// `_id`.
    #[serde(rename = "_id")]
    pub id: ObjectId,
    /// The channel.
    #[serde(rename = "channelID")]
    pub channel_id: String,
    /// The Polar customer.
    #[serde(rename = "customerId")]
    pub customer_id: Private<String>,
    /// The UTC day (`YYYY-MM-DD`).
    pub date: String,
    /// Midnight UTC of the day.
    #[serde(rename = "dayStart")]
    pub day_start: JsDate,
    /// Credits spent on usage.
    #[serde(default = "zero", rename = "spentCredits")]
    pub spent_credits: JsNumber,
    /// Credits granted back.
    #[serde(default = "zero", rename = "grantedCredits")]
    pub granted_credits: JsNumber,
    /// Spent plus debited minus granted.
    #[serde(default = "zero", rename = "netConsumedCredits")]
    pub net_consumed_credits: JsNumber,
    /// Usage lines.
    #[serde(default = "zero", rename = "transactionCount")]
    pub transaction_count: JsNumber,
    /// Per category: `{credits, transactionCount}`.
    #[serde(default)]
    pub categories: DailyCategories,
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

/// The per-category totals (`{[category]: {credits, transactionCount}}`), kept as stored until
/// the AI usage package types them. The path is `Mixed`; missing reads as the default `{}`.
#[derive(Clone, Debug, PartialEq, Deserialize, Serialize)]
#[serde(transparent)]
pub struct DailyCategories(pub Bson);

impl Default for DailyCategories {
    fn default() -> Self {
        Self(Bson::Document(Document::new()))
    }
}

/// A rebuilt day (`insertMany` in `rebuildUtcDailyAggregates`, `utils/ai_usage_ledger.ts:286`).
#[derive(Clone, Debug, Serialize)]
pub struct NewAiUsageDaily {
    /// The channel.
    #[serde(rename = "channelID")]
    pub channel_id: String,
    /// The Polar customer.
    #[serde(rename = "customerId")]
    pub customer_id: Private<String>,
    /// The UTC day.
    pub date: String,
    /// Midnight UTC.
    #[serde(rename = "dayStart")]
    pub day_start: JsDate,
    /// Credits spent.
    #[serde(rename = "spentCredits")]
    pub spent_credits: JsNumber,
    /// Credits granted back.
    #[serde(rename = "grantedCredits")]
    pub granted_credits: JsNumber,
    /// Net consumed.
    #[serde(rename = "netConsumedCredits")]
    pub net_consumed_credits: JsNumber,
    /// Usage lines.
    #[serde(rename = "transactionCount")]
    pub transaction_count: JsNumber,
    /// Per category (`{}` is not stored).
    pub categories: Document,
    /// The plan.
    #[serde(rename = "retentionTier")]
    pub retention_tier: RetentionTier,
    /// End of retention.
    #[serde(rename = "expiresAt")]
    pub expires_at: JsDate,
}

impl NewAiUsageDaily {
    /// The values given to the constructor (before defaults).
    pub fn to_document(&self) -> Result<Document, ModelError> {
        Ok(bson::serialize_to_document(self)?)
    }

    /// The insert Mongoose sends (one document of the `insertMany`).
    pub fn prepare(&self, ctx: &mut WriteContext) -> Result<PreparedInsert, ModelError> {
        INFO.prepare_create(&self.to_document()?, ctx)
    }
}
