//! `follow_relationship_ledgers`: reference `dimabot/src/schemas/follow_relationship_ledger.schema.ts`.
//! No hooks or runValidators; client-fed null paths: none. Writers build or normalize values.
//! Server-only nulls/removals named in READ_NEEDS are intentionally refused.
//! BSON numbers retain their stored width through JsNumber. Optional fields accept missing/null.
//! Writers: utils/follow_ledger.ts normalizes follow identities and constructs event/scan upserts and terminal transitions. No unchecked body reaches writes. Legacy ended_at and ended_reason are null on active edges. Snake-case timestamps, __v; active-only unique partial index. Full census has 153040 documents.

use crate::decode::decode_boxed;
use crate::enums::{Open, StrEnum, str_enum};
use crate::values::Nullable;
use crate::{ClientNulls, CollectionInfo, Hooks, IndexSpec, ModelError, ReadNeed, Rule};
use bson::{Document, oid::ObjectId};
use dima_store::mongo::schema::{DefaultValue as D, Field, Schema, Timestamps};
use dima_store::mongo::{WriteContext, date::JsDate, id::IdType, insert::PreparedInsert};
use serde::{Deserialize, Serialize};
str_enum! { /// `platform`.
pub enum PlatformKind {/// `twitch`.
Twitch = "twitch"} }
fn default_platform() -> Open<PlatformKind> {
    PlatformKind::Twitch.into()
}
fn default_follower_login() -> String {
    "".into()
}
fn default_follower_name() -> String {
    "".into()
}
fn default_followed_login() -> String {
    "".into()
}
fn default_followed_name() -> String {
    "".into()
}
fn default_mutual() -> bool {
    false
}
str_enum! { /// `status`.
pub enum StatusKind {/// `active`.
Active = "active",/// `ended`.
Ended = "ended"} }
fn default_status() -> Open<StatusKind> {
    StatusKind::Active.into()
}
str_enum! { /// `ended_reason`.
pub enum EndedReasonKind {/// `missing_in_followers_scan`.
MissingInFollowersScan = "missing_in_followers_scan",/// `missing_in_following_scan`.
MissingInFollowingScan = "missing_in_following_scan",/// `event_unfollow`.
EventUnfollow = "event_unfollow",/// `unknown`.
Unknown = "unknown"} }
fn partial_9() -> Document {
    bson::doc! {"status": "active"}
}
/// Collection name.
pub const COLLECTION: &str = "follow_relationship_ledgers";
/// Frozen schema.
pub static SCHEMA: Schema = Schema::new(&[
    Field::string("platform").default(D::Str("twitch")),
    Field::string("follower_id"),
    Field::string("follower_login").default(D::Str("")),
    Field::string("follower_name").default(D::Str("")),
    Field::string("followed_id"),
    Field::string("followed_login").default(D::Str("")),
    Field::string("followed_name").default(D::Str("")),
    Field::boolean("mutual").default(D::Bool(false)),
    Field::string("status").default(D::Str("active")),
    Field::date("followed_at").default_fn(D::Now),
    Field::date("ended_at").default(D::Null),
    Field::string("ended_reason").default(D::Null),
    Field::date("last_event_at").default_fn(D::Now),
])
.timestamps(Timestamps::SNAKE);
/// Hidden paths.
pub const HIDDEN: &[&str] = &[];
/// Private paths.
pub const PRIVATE: &[&str] = &[];
/// Declared indexes.
pub const INDEXES: &[IndexSpec] = &[
    IndexSpec::on(&[("platform", 1)]),
    IndexSpec::on(&[("follower_id", 1)]),
    IndexSpec::on(&[("followed_id", 1)]),
    IndexSpec::on(&[("mutual", 1)]),
    IndexSpec::on(&[("status", 1)]),
    IndexSpec::on(&[("last_event_at", 1)]),
    IndexSpec::on(&[("followed_id", 1), ("status", 1)]),
    IndexSpec::on(&[("followed_id", 1), ("mutual", 1), ("status", 1)]),
    IndexSpec::on(&[("follower_id", 1), ("status", 1)]),
    IndexSpec::on(&[
        ("platform", 1),
        ("follower_id", 1),
        ("followed_id", 1),
        ("status", 1),
    ])
    .unique()
    .partial(partial_9),
];
/// Validators.
pub const RULES: &[Rule] = &[
    Rule::required("platform"),
    Rule::one_of("platform", PlatformKind::STRINGS),
    Rule::required("follower_id"),
    Rule::required("followed_id"),
    Rule::one_of("status", StatusKind::STRINGS),
    Rule::required("followed_at"),
    Rule::one_of("ended_reason", EndedReasonKind::STRINGS),
    Rule::required("last_event_at"),
];
/// Read constraints.
pub const READ_NEEDS: &[ReadNeed] = &[
    ReadNeed::not_null("platform"),
    ReadNeed::value("follower_id"),
    ReadNeed::not_null("follower_login"),
    ReadNeed::not_null("follower_name"),
    ReadNeed::value("followed_id"),
    ReadNeed::not_null("followed_login"),
    ReadNeed::not_null("followed_name"),
    ReadNeed::not_null("mutual"),
    ReadNeed::not_null("status"),
    ReadNeed::value("followed_at"),
    ReadNeed::value("last_event_at"),
];
/// Registry entry.
pub static INFO: CollectionInfo = CollectionInfo {
    name: COLLECTION,
    model: "follow_relationship_ledger",
    source: "dimabot/src/schemas/follow_relationship_ledger.schema.ts",
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
    decode: decode_boxed::<FollowRelationshipLedger>,
};
/// Hydrated document.
#[derive(Clone, Debug, Deserialize)]
pub struct FollowRelationshipLedger {
    /// `_id`.
    #[serde(rename = "_id")]
    pub id: ObjectId,
    /// `platform`.
    #[serde(rename = "platform", default = "default_platform")]
    pub platform: Open<PlatformKind>,
    /// `follower_id`.
    #[serde(rename = "follower_id")]
    pub follower_id: String,
    /// `follower_login`.
    #[serde(rename = "follower_login", default = "default_follower_login")]
    pub follower_login: String,
    /// `follower_name`.
    #[serde(rename = "follower_name", default = "default_follower_name")]
    pub follower_name: String,
    /// `followed_id`.
    #[serde(rename = "followed_id")]
    pub followed_id: String,
    /// `followed_login`.
    #[serde(rename = "followed_login", default = "default_followed_login")]
    pub followed_login: String,
    /// `followed_name`.
    #[serde(rename = "followed_name", default = "default_followed_name")]
    pub followed_name: String,
    /// `mutual`.
    #[serde(rename = "mutual", default = "default_mutual")]
    pub mutual: bool,
    /// `status`.
    #[serde(rename = "status", default = "default_status")]
    pub status: Open<StatusKind>,
    /// `followed_at`.
    #[serde(rename = "followed_at")]
    pub followed_at: JsDate,
    /// `ended_at`.
    #[serde(rename = "ended_at", default)]
    pub ended_at: Option<JsDate>,
    /// `ended_reason`.
    #[serde(rename = "ended_reason", default)]
    pub ended_reason: Option<Open<EndedReasonKind>>,
    /// `last_event_at`.
    #[serde(rename = "last_event_at")]
    pub last_event_at: JsDate,
    /// `created_at`.
    #[serde(default, rename = "created_at")]
    pub created_at: Option<JsDate>,
    /// `updated_at`.
    #[serde(default, rename = "updated_at")]
    pub updated_at: Option<JsDate>,
}
/// New document.
#[derive(Clone, Debug, Serialize)]
pub struct NewFollowRelationshipLedger {
    /// `platform`.
    #[serde(rename = "platform")]
    pub platform: PlatformKind,
    /// `follower_id`.
    #[serde(rename = "follower_id")]
    pub follower_id: String,
    /// `follower_login`.
    #[serde(rename = "follower_login", skip_serializing_if = "Option::is_none")]
    pub follower_login: Option<String>,
    /// `follower_name`.
    #[serde(rename = "follower_name", skip_serializing_if = "Option::is_none")]
    pub follower_name: Option<String>,
    /// `followed_id`.
    #[serde(rename = "followed_id")]
    pub followed_id: String,
    /// `followed_login`.
    #[serde(rename = "followed_login", skip_serializing_if = "Option::is_none")]
    pub followed_login: Option<String>,
    /// `followed_name`.
    #[serde(rename = "followed_name", skip_serializing_if = "Option::is_none")]
    pub followed_name: Option<String>,
    /// `mutual`.
    #[serde(rename = "mutual", skip_serializing_if = "Option::is_none")]
    pub mutual: Option<bool>,
    /// `status`.
    #[serde(rename = "status", skip_serializing_if = "Option::is_none")]
    pub status: Option<StatusKind>,
    /// `followed_at`.
    #[serde(rename = "followed_at")]
    pub followed_at: JsDate,
    /// `ended_at`.
    #[serde(rename = "ended_at", skip_serializing_if = "Nullable::is_unset")]
    pub ended_at: Nullable<JsDate>,
    /// `ended_reason`.
    #[serde(rename = "ended_reason", skip_serializing_if = "Nullable::is_unset")]
    pub ended_reason: Nullable<EndedReasonKind>,
    /// `last_event_at`.
    #[serde(rename = "last_event_at")]
    pub last_event_at: JsDate,
}
impl NewFollowRelationshipLedger {
    /// Input before defaults.
    pub fn to_document(&self) -> Result<Document, ModelError> {
        Ok(bson::serialize_to_document(self)?)
    }
    /// Validated insert.
    pub fn prepare(&self, ctx: &mut WriteContext) -> Result<PreparedInsert, ModelError> {
        INFO.prepare_create(&self.to_document()?, ctx)
    }
}
