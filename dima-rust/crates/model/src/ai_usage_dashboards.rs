//! `ai_usage_dashboards`: the cached AI usage dashboard of one request (derived data only:
//! billing balances are always read from the billing service).
//!
//! Reference: `dimabot/src/schemas/ai_usage_dashboard.schema.ts` (model `ai_usage_dashboards`),
//! written by `utils/ai_usage_dashboard.ts` (an upsert on `key`, the refresh's `$set`) and
//! `utils/ai_usage_ledger.ts` (`dirty: true` on every receipt). No timestamps, `__v`, no hooks.
//! Unique `key` (the SHA-256 of the request; a cache, best effort), `{channelID, customerId}`,
//! `{dirty, refreshedAt}` and the TTL on `expiresAt`. `request` and `data` (`Mixed`) stay raw;
//! `customerId` and `request` (which holds the customer id) are private.
//!
//! Client-fed writes (`null` from a request body): none: its writers (`ledger/mongo.json`) store
//! values the server builds or checks, and no request body reaches them unchecked.
//!
//! Intended difference (`crate::shape`): the write helpers refuse a value of the wrong BSON type,
//! and `null` or a removal where [`READ_NEEDS`] says the read type has none; the census of the
//! production copy shows none stored there, so Mongoose's acceptance of them is not reproduced.

use crate::collection::{ClientNulls, CollectionInfo, Hooks};
use crate::decode::decode_boxed;
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
use dima_store::mongo::schema::{DefaultValue as D, Field, Schema};
use serde::{Deserialize, Serialize};

/// The collection name.
pub const COLLECTION: &str = "ai_usage_dashboards";

/// The schema, field by field as `ai_usage_dashboard.schema.ts` declares it.
pub static SCHEMA: Schema = Schema::new(&[
    Field::string("key"),
    Field::string("channelID"),
    Field::string("customerId"),
    Field::string("planTier"),
    Field::mixed("request"),
    Field::mixed("data"),
    Field::boolean("dirty").default(D::Bool(false)),
    Field::date("refreshedAt"),
    Field::date("expiresAt"),
]);

/// The declared indexes (field-level `unique` first).
pub const INDEXES: &[IndexSpec] = &[
    IndexSpec::on(&[("key", 1)]).unique(),
    IndexSpec::on(&[("channelID", 1), ("customerId", 1)]),
    IndexSpec::on(&[("dirty", 1), ("refreshedAt", 1)]),
    IndexSpec::on(&[("expiresAt", 1)]).expire_after_seconds(0),
];

/// The validators, in schema path order.
pub const RULES: &[Rule] = &[
    Rule::required("key"),
    Rule::required("channelID"),
    Rule::required("customerId"),
    Rule::required("planTier"),
    Rule::required("request"),
    Rule::required("data"),
    Rule::required("refreshedAt"),
    Rule::required("expiresAt"),
];

/// The private paths: their read type fields are [`crate::Private`].
pub const PRIVATE: &[&str] = &["customerId", "request"];

/// What the read type cannot decode (`crate::shape`): the write helpers refuse it.
pub const READ_NEEDS: &[ReadNeed] = &[
    ReadNeed::value("key"),
    ReadNeed::value("channelID"),
    ReadNeed::value("customerId"),
    ReadNeed::value("planTier"),
    ReadNeed::present("request"),
    ReadNeed::present("data"),
    ReadNeed::not_null("dirty"),
    ReadNeed::value("refreshedAt"),
    ReadNeed::value("expiresAt"),
];

/// The registry entry.
pub static INFO: CollectionInfo = CollectionInfo {
    name: COLLECTION,
    model: "ai_usage_dashboards",
    source: "dimabot/src/schemas/ai_usage_dashboard.schema.ts",
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
    decode: decode_boxed::<AiUsageDashboard>,
};

/// A cached dashboard.
#[derive(Clone, Debug, Deserialize)]
pub struct AiUsageDashboard {
    /// `_id`.
    #[serde(rename = "_id")]
    pub id: ObjectId,
    /// SHA-256 of the request.
    pub key: String,
    /// The channel.
    #[serde(rename = "channelID")]
    pub channel_id: String,
    /// The Polar customer.
    #[serde(rename = "customerId")]
    pub customer_id: Private<String>,
    /// The plan the dashboard was computed for.
    #[serde(rename = "planTier")]
    pub plan_tier: String,
    /// The request it answers, as stored.
    pub request: Private<DashboardRequest>,
    /// The computed dashboard, as stored.
    pub data: DashboardData,
    /// A receipt arrived since it was computed.
    #[serde(default)]
    pub dirty: bool,
    /// When it was computed.
    #[serde(rename = "refreshedAt")]
    pub refreshed_at: JsDate,
    /// When it expires (TTL).
    #[serde(rename = "expiresAt")]
    pub expires_at: JsDate,
}

/// The dashboard request (channel, customer, plan, window), kept as stored.
#[derive(Clone, Debug, PartialEq, Deserialize, Serialize)]
#[serde(transparent)]
pub struct DashboardRequest(pub Bson);

/// The computed dashboard, kept as stored until the AI usage package types it.
#[derive(Clone, Debug, PartialEq, Deserialize, Serialize)]
#[serde(transparent)]
pub struct DashboardData(pub Bson);

/// A new cached dashboard (the reference upserts it; kept for the tests and the rig).
#[derive(Clone, Debug, Serialize)]
pub struct NewAiUsageDashboard {
    /// SHA-256 of the request.
    pub key: String,
    /// The channel.
    #[serde(rename = "channelID")]
    pub channel_id: String,
    /// The Polar customer.
    #[serde(rename = "customerId")]
    pub customer_id: Private<String>,
    /// The plan.
    #[serde(rename = "planTier")]
    pub plan_tier: String,
    /// The request.
    pub request: Private<Document>,
    /// The computed dashboard.
    pub data: Document,
    /// Dirty (default `false`).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub dirty: Option<bool>,
    /// When it was computed.
    #[serde(rename = "refreshedAt")]
    pub refreshed_at: JsDate,
    /// When it expires.
    #[serde(rename = "expiresAt")]
    pub expires_at: JsDate,
}

impl NewAiUsageDashboard {
    /// The values given to the constructor (before defaults).
    pub fn to_document(&self) -> Result<Document, ModelError> {
        Ok(bson::serialize_to_document(self)?)
    }

    /// The insert Mongoose sends.
    pub fn prepare(&self, ctx: &mut WriteContext) -> Result<PreparedInsert, ModelError> {
        INFO.prepare_create(&self.to_document()?, ctx)
    }
}
