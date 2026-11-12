//! `stream_activity_aggregates`: reference `dimabot/src/schemas/stream_activity.schema.ts`.
//! No hooks or hidden paths. No timestamps or __v. Indexes declared below.
//! No reference update passes runValidators.
//! Writers checked: utils/stream_activity.ts:90,120 and workers/stream_activity/projection.rs.
//! No client-fed writes: projector builds all fields. Legacy distinct receipts lack label,
//! firstAt, messageStartedAt and updatedAt; ordinary aggregates lack firstSeq.
//! Rust stores bucket as int64, increments and sequence as double; TypeScript uses int32
//! for integral numbers. Defaults remain int32. IDs hash the same JSON key tuples.
//! Aggregate ids hash [channelID, sessionHex, scope, kind, key, actor, bucket]; distinct
//! receipts hash [channelID, sessionHex, "distinct", actor, bucket].
//! Server-only nulls/removals in READ_NEEDS are refused; census shows none there.

use crate::decode::decode_boxed;
use crate::{ClientNulls, CollectionInfo, Hooks, IndexSpec, ModelError, ReadNeed, Rule};
use bson::{Document, oid::ObjectId};
use dima_store::mongo::schema::{DefaultValue as D, Field, Schema};
use dima_store::mongo::{
    WriteContext, date::JsDate, id::IdType, insert::PreparedInsert, number::JsNumber,
};
use serde::{Deserialize, Serialize};
/// Collection name.
pub const COLLECTION: &str = "stream_activity_aggregates";
/// Frozen schema.
pub static SCHEMA: Schema = Schema::new(&[
    Field::string("_id"),
    Field::string("channelID"),
    Field::object_id("session_id"),
    Field::string("scope"),
    Field::string("kind"),
    Field::string("key").default(D::Str("")),
    Field::string("actor").default(D::Str("")),
    Field::string("label"),
    Field::number("bucket").default(D::Int(-1)),
    Field::number("count").default(D::Int(0)),
    Field::number("messages").default(D::Int(0)),
    Field::number("commands").default(D::Int(0)),
    Field::number("emotes").default(D::Int(0)),
    Field::number("emoteMessages").default(D::Int(0)),
    Field::number("chatters").default(D::Int(0)),
    Field::number("failures").default(D::Int(0)),
    Field::number("redemptions").default(D::Int(0)),
    Field::number("follows").default(D::Int(0)),
    Field::number("subs").default(D::Int(0)),
    Field::number("bits").default(D::Int(0)),
    Field::number("raids").default(D::Int(0)),
    Field::number("firstSeq"),
    Field::number("lastSeq").default(D::Int(0)),
    Field::date("firstAt"),
    Field::date("messageStartedAt"),
    Field::date("updatedAt"),
    Field::date("expiresAt"),
])
.declared_id()
.no_version_key();
fn default_stream_activity_aggregate_key() -> String {
    "".into()
}
fn default_stream_activity_aggregate_actor() -> String {
    "".into()
}
fn default_stream_activity_aggregate_bucket() -> JsNumber {
    JsNumber(-1.0)
}
fn default_stream_activity_aggregate_count() -> JsNumber {
    JsNumber(0.0)
}
fn default_stream_activity_aggregate_messages() -> JsNumber {
    JsNumber(0.0)
}
fn default_stream_activity_aggregate_commands() -> JsNumber {
    JsNumber(0.0)
}
fn default_stream_activity_aggregate_emotes() -> JsNumber {
    JsNumber(0.0)
}
fn default_stream_activity_aggregate_emote_messages() -> JsNumber {
    JsNumber(0.0)
}
fn default_stream_activity_aggregate_chatters() -> JsNumber {
    JsNumber(0.0)
}
fn default_stream_activity_aggregate_failures() -> JsNumber {
    JsNumber(0.0)
}
fn default_stream_activity_aggregate_redemptions() -> JsNumber {
    JsNumber(0.0)
}
fn default_stream_activity_aggregate_follows() -> JsNumber {
    JsNumber(0.0)
}
fn default_stream_activity_aggregate_subs() -> JsNumber {
    JsNumber(0.0)
}
fn default_stream_activity_aggregate_bits() -> JsNumber {
    JsNumber(0.0)
}
fn default_stream_activity_aggregate_raids() -> JsNumber {
    JsNumber(0.0)
}
fn default_stream_activity_aggregate_last_seq() -> JsNumber {
    JsNumber(0.0)
}
/// Hydrated fields.
#[derive(Clone, Debug, Deserialize)]
pub struct StreamActivityAggregate {
    /// `_id`.
    #[serde(rename = "_id")]
    pub id: String,
    /// `channelID`.
    #[serde(rename = "channelID", default)]
    pub channel_id: Option<String>,
    /// `session_id`.
    #[serde(rename = "session_id", default)]
    pub session_id: Option<ObjectId>,
    /// `scope`.
    #[serde(rename = "scope", default)]
    pub scope: Option<String>,
    /// `kind`.
    #[serde(rename = "kind", default)]
    pub kind: Option<String>,
    /// `key`.
    #[serde(rename = "key", default = "default_stream_activity_aggregate_key")]
    pub key: String,
    /// `actor`.
    #[serde(rename = "actor", default = "default_stream_activity_aggregate_actor")]
    pub actor: String,
    /// `label`.
    #[serde(rename = "label", default)]
    pub label: Option<String>,
    /// `bucket`.
    #[serde(
        rename = "bucket",
        default = "default_stream_activity_aggregate_bucket"
    )]
    pub bucket: JsNumber,
    /// `count`.
    #[serde(rename = "count", default = "default_stream_activity_aggregate_count")]
    pub count: JsNumber,
    /// `messages`.
    #[serde(
        rename = "messages",
        default = "default_stream_activity_aggregate_messages"
    )]
    pub messages: JsNumber,
    /// `commands`.
    #[serde(
        rename = "commands",
        default = "default_stream_activity_aggregate_commands"
    )]
    pub commands: JsNumber,
    /// `emotes`.
    #[serde(
        rename = "emotes",
        default = "default_stream_activity_aggregate_emotes"
    )]
    pub emotes: JsNumber,
    /// `emoteMessages`.
    #[serde(
        rename = "emoteMessages",
        default = "default_stream_activity_aggregate_emote_messages"
    )]
    pub emote_messages: JsNumber,
    /// `chatters`.
    #[serde(
        rename = "chatters",
        default = "default_stream_activity_aggregate_chatters"
    )]
    pub chatters: JsNumber,
    /// `failures`.
    #[serde(
        rename = "failures",
        default = "default_stream_activity_aggregate_failures"
    )]
    pub failures: JsNumber,
    /// `redemptions`.
    #[serde(
        rename = "redemptions",
        default = "default_stream_activity_aggregate_redemptions"
    )]
    pub redemptions: JsNumber,
    /// `follows`.
    #[serde(
        rename = "follows",
        default = "default_stream_activity_aggregate_follows"
    )]
    pub follows: JsNumber,
    /// `subs`.
    #[serde(rename = "subs", default = "default_stream_activity_aggregate_subs")]
    pub subs: JsNumber,
    /// `bits`.
    #[serde(rename = "bits", default = "default_stream_activity_aggregate_bits")]
    pub bits: JsNumber,
    /// `raids`.
    #[serde(rename = "raids", default = "default_stream_activity_aggregate_raids")]
    pub raids: JsNumber,
    /// `firstSeq`.
    #[serde(rename = "firstSeq", default)]
    pub first_seq: Option<JsNumber>,
    /// `lastSeq`.
    #[serde(
        rename = "lastSeq",
        default = "default_stream_activity_aggregate_last_seq"
    )]
    pub last_seq: JsNumber,
    /// `firstAt`.
    #[serde(rename = "firstAt", default)]
    pub first_at: Option<JsDate>,
    /// `messageStartedAt`.
    #[serde(rename = "messageStartedAt", default)]
    pub message_started_at: Option<JsDate>,
    /// `updatedAt`.
    #[serde(rename = "updatedAt", default)]
    pub updated_at: Option<JsDate>,
    /// `expiresAt`.
    #[serde(rename = "expiresAt")]
    pub expires_at: JsDate,
}
/// Typed insert fields.
#[derive(Clone, Debug, Serialize)]
pub struct NewStreamActivityAggregate {
    /// `_id`.
    #[serde(rename = "_id")]
    pub id: String,
    /// `channelID`.
    #[serde(rename = "channelID", skip_serializing_if = "Option::is_none")]
    pub channel_id: Option<String>,
    /// `session_id`.
    #[serde(rename = "session_id", skip_serializing_if = "Option::is_none")]
    pub session_id: Option<ObjectId>,
    /// `scope`.
    #[serde(rename = "scope", skip_serializing_if = "Option::is_none")]
    pub scope: Option<String>,
    /// `kind`.
    #[serde(rename = "kind", skip_serializing_if = "Option::is_none")]
    pub kind: Option<String>,
    /// `key`.
    #[serde(rename = "key", skip_serializing_if = "Option::is_none")]
    pub key: Option<String>,
    /// `actor`.
    #[serde(rename = "actor", skip_serializing_if = "Option::is_none")]
    pub actor: Option<String>,
    /// `label`.
    #[serde(rename = "label", skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    /// `bucket`.
    #[serde(rename = "bucket", skip_serializing_if = "Option::is_none")]
    pub bucket: Option<JsNumber>,
    /// `count`.
    #[serde(rename = "count", skip_serializing_if = "Option::is_none")]
    pub count: Option<JsNumber>,
    /// `messages`.
    #[serde(rename = "messages", skip_serializing_if = "Option::is_none")]
    pub messages: Option<JsNumber>,
    /// `commands`.
    #[serde(rename = "commands", skip_serializing_if = "Option::is_none")]
    pub commands: Option<JsNumber>,
    /// `emotes`.
    #[serde(rename = "emotes", skip_serializing_if = "Option::is_none")]
    pub emotes: Option<JsNumber>,
    /// `emoteMessages`.
    #[serde(rename = "emoteMessages", skip_serializing_if = "Option::is_none")]
    pub emote_messages: Option<JsNumber>,
    /// `chatters`.
    #[serde(rename = "chatters", skip_serializing_if = "Option::is_none")]
    pub chatters: Option<JsNumber>,
    /// `failures`.
    #[serde(rename = "failures", skip_serializing_if = "Option::is_none")]
    pub failures: Option<JsNumber>,
    /// `redemptions`.
    #[serde(rename = "redemptions", skip_serializing_if = "Option::is_none")]
    pub redemptions: Option<JsNumber>,
    /// `follows`.
    #[serde(rename = "follows", skip_serializing_if = "Option::is_none")]
    pub follows: Option<JsNumber>,
    /// `subs`.
    #[serde(rename = "subs", skip_serializing_if = "Option::is_none")]
    pub subs: Option<JsNumber>,
    /// `bits`.
    #[serde(rename = "bits", skip_serializing_if = "Option::is_none")]
    pub bits: Option<JsNumber>,
    /// `raids`.
    #[serde(rename = "raids", skip_serializing_if = "Option::is_none")]
    pub raids: Option<JsNumber>,
    /// `firstSeq`.
    #[serde(rename = "firstSeq", skip_serializing_if = "Option::is_none")]
    pub first_seq: Option<JsNumber>,
    /// `lastSeq`.
    #[serde(rename = "lastSeq", skip_serializing_if = "Option::is_none")]
    pub last_seq: Option<JsNumber>,
    /// `firstAt`.
    #[serde(rename = "firstAt", skip_serializing_if = "Option::is_none")]
    pub first_at: Option<JsDate>,
    /// `messageStartedAt`.
    #[serde(rename = "messageStartedAt", skip_serializing_if = "Option::is_none")]
    pub message_started_at: Option<JsDate>,
    /// `updatedAt`.
    #[serde(rename = "updatedAt", skip_serializing_if = "Option::is_none")]
    pub updated_at: Option<JsDate>,
    /// `expiresAt`.
    #[serde(rename = "expiresAt")]
    pub expires_at: JsDate,
}
/// Hidden paths.
pub const HIDDEN: &[&str] = &[];
/// Private paths.
pub const PRIVATE: &[&str] = &[];
/// Declared indexes.
pub const INDEXES: &[IndexSpec] = &[
    IndexSpec::on(&[
        ("channelID", 1),
        ("session_id", 1),
        ("scope", 1),
        ("kind", 1),
        ("key", 1),
        ("count", -1),
        ("_id", 1),
    ]),
    IndexSpec::on(&[
        ("channelID", 1),
        ("session_id", 1),
        ("scope", 1),
        ("kind", 1),
        ("count", -1),
        ("_id", 1),
    ]),
    IndexSpec::on(&[
        ("channelID", 1),
        ("session_id", 1),
        ("scope", 1),
        ("bucket", 1),
    ]),
    IndexSpec::on(&[("expiresAt", 1)]).expire_after_seconds(0),
];
/// Validators.
pub const RULES: &[Rule] = &[Rule::required("expiresAt")];
/// Read constraints.
pub const READ_NEEDS: &[ReadNeed] = &[
    ReadNeed::value("_id"),
    ReadNeed::not_null("key"),
    ReadNeed::not_null("actor"),
    ReadNeed::not_null("bucket"),
    ReadNeed::not_null("count"),
    ReadNeed::not_null("messages"),
    ReadNeed::not_null("commands"),
    ReadNeed::not_null("emotes"),
    ReadNeed::not_null("emoteMessages"),
    ReadNeed::not_null("chatters"),
    ReadNeed::not_null("failures"),
    ReadNeed::not_null("redemptions"),
    ReadNeed::not_null("follows"),
    ReadNeed::not_null("subs"),
    ReadNeed::not_null("bits"),
    ReadNeed::not_null("raids"),
    ReadNeed::not_null("lastSeq"),
    ReadNeed::value("expiresAt"),
];
/// Registry entry.
pub static INFO: CollectionInfo = CollectionInfo {
    name: COLLECTION,
    model: "stream_activity_aggregate",
    source: "dimabot/src/schemas/stream_activity.schema.ts",
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
    decode: decode_boxed::<StreamActivityAggregate>,
};
impl NewStreamActivityAggregate {
    /// Input before defaults.
    pub fn to_document(&self) -> Result<Document, ModelError> {
        Ok(bson::serialize_to_document(self)?)
    }
    /// Validated insert.
    pub fn prepare(&self, ctx: &mut WriteContext) -> Result<PreparedInsert, ModelError> {
        INFO.prepare_create(&self.to_document()?, ctx)
    }
}
