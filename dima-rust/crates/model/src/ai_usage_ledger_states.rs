//! `ai_usage_ledger_states`: how far back a channel's AI usage ledger was backfilled from the
//! billing service.
//!
//! Reference: `dimabot/src/schemas/ai_usage_ledger_state.schema.ts` (model
//! `ai_usage_ledger_states`), written by `utils/ai_usage_ledger.ts` (the backfill's upsert with
//! `$min`, `$set` and `$setOnInsert`; a plan change's `$max` of `coverageStart`). Snake-case
//! timestamps, `__v`, no hooks. Unique `{channelID, customerId}`, best effort (an upsert on it;
//! nothing awaits it). `customerId` is private.
//!
//! Intended difference (`crate::shape`): the write helpers refuse a value of the wrong BSON type,
//! and `null` or a removal where [`READ_NEEDS`] says the read type has none; the census of the
//! production copy shows none stored there, so Mongoose's acceptance of them is not reproduced.

use crate::collection::{CollectionInfo, Hooks};
use crate::decode::decode_boxed;
use crate::defaults::zero;
use crate::error::ModelError;
use crate::index::IndexSpec;
use crate::private::Private;
use crate::shape::ReadNeed;
use crate::validation::Rule;
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
pub const COLLECTION: &str = "ai_usage_ledger_states";

/// The schema, field by field as `ai_usage_ledger_state.schema.ts` declares it.
pub static SCHEMA: Schema = Schema::new(&[
    Field::string("channelID"),
    Field::string("customerId"),
    Field::date("coverageStart"),
    Field::date("backfilledAt"),
    Field::number("reportVersion").default(D::Int(0)),
])
.timestamps(Timestamps::SNAKE);

/// The declared indexes.
pub const INDEXES: &[IndexSpec] = &[IndexSpec::on(&[("channelID", 1), ("customerId", 1)]).unique()];

/// The validators, in schema path order.
pub const RULES: &[Rule] = &[
    Rule::required("channelID"),
    Rule::required("customerId"),
    Rule::required("coverageStart"),
    Rule::required("backfilledAt"),
];

/// The private paths: their read type fields are [`crate::Private`].
pub const PRIVATE: &[&str] = &["customerId"];

/// What the read type cannot decode (`crate::shape`): the write helpers refuse it.
pub const READ_NEEDS: &[ReadNeed] = &[
    ReadNeed::value("channelID"),
    ReadNeed::value("customerId"),
    ReadNeed::value("coverageStart"),
    ReadNeed::value("backfilledAt"),
    ReadNeed::not_null("reportVersion"),
];

/// The registry entry.
pub static INFO: CollectionInfo = CollectionInfo {
    name: COLLECTION,
    model: "ai_usage_ledger_states",
    source: "dimabot/src/schemas/ai_usage_ledger_state.schema.ts",
    schema: &SCHEMA,
    id_type: IdType::ObjectId,
    hidden: &[],
    indexes: INDEXES,
    rules: RULES,
    read_needs: READ_NEEDS,
    hooks: Hooks::None,
    private: PRIVATE,
    decode: decode_boxed::<AiUsageLedgerState>,
};

/// A stored ledger state.
#[derive(Clone, Debug, Deserialize)]
pub struct AiUsageLedgerState {
    /// `_id`.
    #[serde(rename = "_id")]
    pub id: ObjectId,
    /// The channel.
    #[serde(rename = "channelID")]
    pub channel_id: String,
    /// The Polar customer.
    #[serde(rename = "customerId")]
    pub customer_id: Private<String>,
    /// The oldest instant the ledger covers.
    #[serde(rename = "coverageStart")]
    pub coverage_start: JsDate,
    /// Last backfill.
    #[serde(rename = "backfilledAt")]
    pub backfilled_at: JsDate,
    /// The report version of the last backfill.
    #[serde(default = "zero", rename = "reportVersion")]
    pub report_version: JsNumber,
    /// Creation time.
    #[serde(default)]
    pub created_at: Option<JsDate>,
    /// Last update time.
    #[serde(default)]
    pub updated_at: Option<JsDate>,
}

/// A new ledger state (the reference upserts it; kept for the tests and the rig).
#[derive(Clone, Debug, Serialize)]
pub struct NewAiUsageLedgerState {
    /// The channel.
    #[serde(rename = "channelID")]
    pub channel_id: String,
    /// The Polar customer.
    #[serde(rename = "customerId")]
    pub customer_id: Private<String>,
    /// The oldest instant covered.
    #[serde(rename = "coverageStart")]
    pub coverage_start: JsDate,
    /// The backfill time.
    #[serde(rename = "backfilledAt")]
    pub backfilled_at: JsDate,
    /// The report version (default 0).
    #[serde(rename = "reportVersion", skip_serializing_if = "Option::is_none")]
    pub report_version: Option<JsNumber>,
}

impl NewAiUsageLedgerState {
    /// The values given to the constructor (before defaults).
    pub fn to_document(&self) -> Result<Document, ModelError> {
        Ok(bson::serialize_to_document(self)?)
    }

    /// The insert Mongoose sends.
    pub fn prepare(&self, ctx: &mut WriteContext) -> Result<PreparedInsert, ModelError> {
        INFO.prepare_create(&self.to_document()?, ctx)
    }
}
