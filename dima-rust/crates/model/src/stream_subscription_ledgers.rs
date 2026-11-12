//! `stream_subscription_ledgers`: reference `dimabot/src/schemas/stream_subscription_ledger.schema.ts`.
//! Key: ObjectId _id; lookup by platform/streamer_id/user_id, latest last_event_at,
//! and status=active. Unlike receipts, _id is not deterministic.
//! Repeat rule: applied_event_keys membership suppresses repeats; updates additionally match
//! last_event_at <= event time and applied_event_keys != eventKey. Ended equal/newer events
//! suppress stale starts/ends. Unique event_key and active identity prevent duplicate counting;
//! both unique indexes are required. History is bounded by the writer's $push/$slice.
//! Writers checked: utils/stream_analytics.ts:1048-1279 (recordSubscriptionLedgerStart/End,
//! including new-document save at 1127/1246); domain_events/stream_analytics_events.ts:115,150
//! constructs their inputs from journal envelopes. Dashboard/goals/widgets only count/read.
//! Client-fed writes: none; ids/names/tier are String-normalized, gift Boolean-normalized,
//! dates parsed, and event keys come from server journal envelopes.
//! No hooks or runValidators. Snake timestamps and __v. applied_event_keys is hidden/private.
//! Legacy: ended_at is null on active rows; event_key and hidden history can be missing.
//! Server-only READ_NEEDS nulls/removals are refused; date-now defaults never invent read time.

use crate::Private;
use crate::decode::decode_boxed;
use crate::enums::{Open, StrEnum, str_enum};
use crate::values::Nullable;
use crate::{ClientNulls, CollectionInfo, Hooks, IndexSpec, ModelError, ReadNeed, Rule};
use bson::Document;
use bson::oid::ObjectId;
use dima_store::mongo::schema::{DefaultValue as D, Field, Schema};
use dima_store::mongo::schema::{Timestamps, ValueType};
use dima_store::mongo::{WriteContext, date::JsDate, id::IdType, insert::PreparedInsert};
use serde::{Deserialize, Serialize};
str_enum! { /// `platform`.
pub enum PlatformKind {/// `twitch`.
Twitch = "twitch"} }
str_enum! { /// `sub_tier_normalized`.
pub enum SubTierNormalizedKind {/// `tier1`.
Tier1 = "tier1",/// `tier2`.
Tier2 = "tier2",/// `tier3`.
Tier3 = "tier3",/// `unknown`.
Unknown = "unknown"} }
str_enum! { /// `status`.
pub enum StatusKind {/// `active`.
Active = "active",/// `ended`.
Ended = "ended"} }
/// Collection name.
pub const COLLECTION: &str = "stream_subscription_ledgers";
/// Frozen schema.
pub static SCHEMA: Schema = Schema::new(&[
    Field::string("platform").default(D::Str("twitch")),
    Field::string("streamer_id"),
    Field::string("streamer_login").default(D::Str("")),
    Field::string("streamer_name").default(D::Str("")),
    Field::string("user_id"),
    Field::string("user_login").default(D::Str("")),
    Field::string("user_name").default(D::Str("")),
    Field::string("sub_tier_raw").default(D::Str("")),
    Field::string("sub_tier_normalized").default(D::Str("unknown")),
    Field::boolean("is_gift").default(D::Bool(false)),
    Field::string("status").default(D::Str("active")),
    Field::date("subbed_at").default_fn(D::Now),
    Field::date("ended_at").default(D::Null),
    Field::date("last_event_at").default_fn(D::Now),
    Field::string("event_key"),
    Field::array("applied_event_keys", ValueType::String).default(D::EmptyArray),
])
.timestamps(Timestamps::SNAKE);
fn active_only() -> Document {
    bson::doc! {"status":"active"}
}
/// Hidden fields.
pub const HIDDEN: &[&str] = &["applied_event_keys"];
/// Private fields.
pub const PRIVATE: &[&str] = &["applied_event_keys"];
/// Declared indexes.
pub const INDEXES: &[IndexSpec] = &[
    IndexSpec::on(&[("platform", 1)]),
    IndexSpec::on(&[("streamer_id", 1)]),
    IndexSpec::on(&[("user_id", 1)]),
    IndexSpec::on(&[("sub_tier_normalized", 1)]),
    IndexSpec::on(&[("status", 1)]),
    IndexSpec::on(&[("last_event_at", 1)]),
    IndexSpec::on(&[("streamer_id", 1), ("status", 1)]),
    IndexSpec::on(&[
        ("platform", 1),
        ("streamer_id", 1),
        ("user_id", 1),
        ("last_event_at", -1),
    ]),
    IndexSpec::on(&[("event_key", 1)]).unique().sparse(),
    IndexSpec::on(&[
        ("platform", 1),
        ("streamer_id", 1),
        ("user_id", 1),
        ("status", 1),
    ])
    .unique()
    .partial(active_only),
];
/// Validators.
pub const RULES: &[Rule] = &[
    Rule::required("platform"),
    Rule::one_of("platform", PlatformKind::STRINGS),
    Rule::required("streamer_id"),
    Rule::required("user_id"),
    Rule::one_of("sub_tier_normalized", SubTierNormalizedKind::STRINGS),
    Rule::one_of("status", StatusKind::STRINGS),
    Rule::required("subbed_at"),
    Rule::required("last_event_at"),
];
fn default_platform() -> Open<PlatformKind> {
    PlatformKind::Twitch.into()
}
fn default_streamer_login() -> String {
    String::new()
}
fn default_streamer_name() -> String {
    String::new()
}
fn default_user_login() -> String {
    String::new()
}
fn default_user_name() -> String {
    String::new()
}
fn default_sub_tier_raw() -> String {
    String::new()
}
fn default_sub_tier_normalized() -> Open<SubTierNormalizedKind> {
    SubTierNormalizedKind::Unknown.into()
}
fn default_is_gift() -> bool {
    false
}
fn default_status() -> Open<StatusKind> {
    StatusKind::Active.into()
}
/// Read constraints.
pub const READ_NEEDS: &[ReadNeed] = &[
    ReadNeed::not_null("platform"),
    ReadNeed::value("streamer_id"),
    ReadNeed::not_null("streamer_login"),
    ReadNeed::not_null("streamer_name"),
    ReadNeed::value("user_id"),
    ReadNeed::not_null("user_login"),
    ReadNeed::not_null("user_name"),
    ReadNeed::not_null("sub_tier_raw"),
    ReadNeed::not_null("sub_tier_normalized"),
    ReadNeed::not_null("is_gift"),
    ReadNeed::not_null("status"),
];
/// Registry entry.
pub static INFO: CollectionInfo = CollectionInfo {
    name: COLLECTION,
    model: "stream_subscription_ledger",
    source: "dimabot/src/schemas/stream_subscription_ledger.schema.ts",
    schema: &SCHEMA,
    id_type: IdType::ObjectId,
    hidden: HIDDEN,
    indexes: INDEXES,
    rules: RULES,
    read_needs: READ_NEEDS,
    hooks: Hooks::None,
    client_nulls: ClientNulls::None,
    initialised_at_startup: true,
    private: PRIVATE,
    decode: decode_boxed::<StreamSubscriptionLedger>,
};
/// Hydrated document.
#[derive(Clone, Debug, Deserialize)]
pub struct StreamSubscriptionLedger {
    /// `_id`.
    #[serde(rename = "_id")]
    pub id: ObjectId,
    /// `platform`.
    #[serde(rename = "platform", default = "default_platform")]
    pub platform: Open<PlatformKind>,
    /// `streamer_id`.
    #[serde(rename = "streamer_id")]
    pub streamer_id: String,
    /// `streamer_login`.
    #[serde(rename = "streamer_login", default = "default_streamer_login")]
    pub streamer_login: String,
    /// `streamer_name`.
    #[serde(rename = "streamer_name", default = "default_streamer_name")]
    pub streamer_name: String,
    /// `user_id`.
    #[serde(rename = "user_id")]
    pub user_id: String,
    /// `user_login`.
    #[serde(rename = "user_login", default = "default_user_login")]
    pub user_login: String,
    /// `user_name`.
    #[serde(rename = "user_name", default = "default_user_name")]
    pub user_name: String,
    /// `sub_tier_raw`.
    #[serde(rename = "sub_tier_raw", default = "default_sub_tier_raw")]
    pub sub_tier_raw: String,
    /// `sub_tier_normalized`.
    #[serde(
        rename = "sub_tier_normalized",
        default = "default_sub_tier_normalized"
    )]
    pub sub_tier_normalized: Open<SubTierNormalizedKind>,
    /// `is_gift`.
    #[serde(rename = "is_gift", default = "default_is_gift")]
    pub is_gift: bool,
    /// `status`.
    #[serde(rename = "status", default = "default_status")]
    pub status: Open<StatusKind>,
    /// `subbed_at`.
    #[serde(rename = "subbed_at", default)]
    pub subbed_at: Option<JsDate>,
    /// `ended_at`.
    #[serde(rename = "ended_at", default)]
    pub ended_at: Option<JsDate>,
    /// `last_event_at`.
    #[serde(rename = "last_event_at", default)]
    pub last_event_at: Option<JsDate>,
    /// `event_key`.
    #[serde(rename = "event_key", default)]
    pub event_key: Option<String>,
    /// `applied_event_keys`.
    #[serde(rename = "applied_event_keys", default)]
    pub applied_event_keys: Option<Private<Vec<Option<String>>>>,
    /// `created_at`.
    pub created_at: Option<JsDate>,
    /// `updated_at`.
    pub updated_at: Option<JsDate>,
}
/// Typed insert.
#[derive(Clone, Debug, Serialize)]
pub struct NewStreamSubscriptionLedger {
    /// `platform`.
    #[serde(rename = "platform")]
    pub platform: PlatformKind,
    /// `streamer_id`.
    #[serde(rename = "streamer_id")]
    pub streamer_id: String,
    /// `streamer_login`.
    #[serde(rename = "streamer_login", skip_serializing_if = "Option::is_none")]
    pub streamer_login: Option<String>,
    /// `streamer_name`.
    #[serde(rename = "streamer_name", skip_serializing_if = "Option::is_none")]
    pub streamer_name: Option<String>,
    /// `user_id`.
    #[serde(rename = "user_id")]
    pub user_id: String,
    /// `user_login`.
    #[serde(rename = "user_login", skip_serializing_if = "Option::is_none")]
    pub user_login: Option<String>,
    /// `user_name`.
    #[serde(rename = "user_name", skip_serializing_if = "Option::is_none")]
    pub user_name: Option<String>,
    /// `sub_tier_raw`.
    #[serde(rename = "sub_tier_raw", skip_serializing_if = "Option::is_none")]
    pub sub_tier_raw: Option<String>,
    /// `sub_tier_normalized`.
    #[serde(
        rename = "sub_tier_normalized",
        skip_serializing_if = "Option::is_none"
    )]
    pub sub_tier_normalized: Option<SubTierNormalizedKind>,
    /// `is_gift`.
    #[serde(rename = "is_gift", skip_serializing_if = "Option::is_none")]
    pub is_gift: Option<bool>,
    /// `status`.
    #[serde(rename = "status", skip_serializing_if = "Option::is_none")]
    pub status: Option<StatusKind>,
    /// `subbed_at`.
    #[serde(rename = "subbed_at")]
    pub subbed_at: JsDate,
    /// `ended_at`.
    #[serde(rename = "ended_at", skip_serializing_if = "Nullable::is_unset")]
    pub ended_at: Nullable<JsDate>,
    /// `last_event_at`.
    #[serde(rename = "last_event_at")]
    pub last_event_at: JsDate,
    /// `event_key`.
    #[serde(rename = "event_key", skip_serializing_if = "Option::is_none")]
    pub event_key: Option<String>,
    /// `applied_event_keys`.
    #[serde(rename = "applied_event_keys", skip_serializing_if = "Option::is_none")]
    pub applied_event_keys: Option<Private<Vec<Option<String>>>>,
}
impl NewStreamSubscriptionLedger {
    /// Input before defaults.
    pub fn to_document(&self) -> Result<Document, ModelError> {
        Ok(bson::serialize_to_document(self)?)
    }
    /// Validated insert.
    pub fn prepare(&self, ctx: &mut WriteContext) -> Result<PreparedInsert, ModelError> {
        INFO.prepare_create(&self.to_document()?, ctx)
    }
}
