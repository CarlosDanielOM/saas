//! `stream_activities`: reference `dimabot/src/schemas/stream_activity.schema.ts`.
//! No hooks or hidden paths. No timestamps or __v. Indexes declared below.
//! No reference update passes runValidators.
//! Writers checked: utils/stream_activity.ts:35,133 and utils/dashboard_activity.ts:72.
//! No unchecked client-fed writes: capture bounds text and normalizes numbers; projectors set flags.
//! Legacy dashboardProcessed is missing, null or bool; offset is int32/double.
//! Receipt _id is SHA256(JSON array [channelID, kind, eventID]); no worker inserts receipts.
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
pub const COLLECTION: &str = "stream_activities";
crate::enums::str_enum! { /// Schema vocabulary.
pub enum StreamActivityKindValue {/// Schema value.
Message = "message",/// Schema value.
Command = "command",/// Schema value.
Redemption = "redemption",/// Schema value.
Follow = "follow",/// Schema value.
Sub = "sub",/// Schema value.
Gift = "gift",/// Schema value.
Bits = "bits",/// Schema value.
Raid = "raid"}}
/// Frozen schema.
pub static SCHEMA: Schema = Schema::new(&[
    Field::string("_id"),
    Field::string("channelID"),
    Field::object_id("session_id"),
    Field::date("occurredAt"),
    Field::number("offset"),
    Field::string("kind"),
    Field::string("key").default(D::Str("")),
    Field::string("label").default(D::Str("")),
    Field::string("actor").default(D::Str("")),
    Field::string("actorLabel").default(D::Str("")),
    Field::number("value").default(D::Int(1)),
    Field::string("outcome").default(D::Str("")),
    Field::document_array(
        "emotes",
        &Schema::subdocument(&[
            Field::string("key"),
            Field::string("label"),
            Field::number("count"),
        ])
        .no_id(),
    )
    .default(D::EmptyArray),
    Field::boolean("processed").default(D::Bool(false)),
    Field::boolean("dashboardProcessed").default(D::Null),
    Field::date("expiresAt"),
])
.declared_id()
.no_version_key();
fn default_stream_activity_key() -> String {
    "".into()
}
fn default_stream_activity_label() -> String {
    "".into()
}
fn default_stream_activity_actor() -> String {
    "".into()
}
fn default_stream_activity_actor_label() -> String {
    "".into()
}
fn default_stream_activity_value() -> JsNumber {
    JsNumber(1.0)
}
fn default_stream_activity_outcome() -> String {
    "".into()
}
fn default_stream_activity_emotes() -> Vec<Option<StreamActivityEmotes>> {
    vec![]
}
fn default_stream_activity_processed() -> bool {
    false
}
/// Hydrated fields.
#[derive(Clone, Debug, Deserialize)]
pub struct StreamActivityEmotes {
    /// `emotes.$.key`.
    #[serde(rename = "key", default)]
    pub key: Option<String>,
    /// `emotes.$.label`.
    #[serde(rename = "label", default)]
    pub label: Option<String>,
    /// `emotes.$.count`.
    #[serde(rename = "count", default)]
    pub count: Option<JsNumber>,
}
/// Typed insert fields.
#[derive(Clone, Debug, Serialize)]
pub struct NewStreamActivityEmotes {
    /// `emotes.$.key`.
    #[serde(rename = "key", skip_serializing_if = "Option::is_none")]
    pub key: Option<String>,
    /// `emotes.$.label`.
    #[serde(rename = "label", skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    /// `emotes.$.count`.
    #[serde(rename = "count", skip_serializing_if = "Option::is_none")]
    pub count: Option<JsNumber>,
}
/// Hydrated fields.
#[derive(Clone, Debug, Deserialize)]
pub struct StreamActivity {
    /// `_id`.
    #[serde(rename = "_id")]
    pub id: String,
    /// `channelID`.
    #[serde(rename = "channelID")]
    pub channel_id: String,
    /// `session_id`.
    #[serde(rename = "session_id")]
    pub session_id: ObjectId,
    /// `occurredAt`.
    #[serde(rename = "occurredAt")]
    pub occurred_at: JsDate,
    /// `offset`.
    #[serde(rename = "offset", default)]
    pub offset: Option<JsNumber>,
    /// `kind`.
    #[serde(rename = "kind")]
    pub kind: crate::Open<StreamActivityKindValue>,
    /// `key`.
    #[serde(rename = "key", default = "default_stream_activity_key")]
    pub key: String,
    /// `label`.
    #[serde(rename = "label", default = "default_stream_activity_label")]
    pub label: String,
    /// `actor`.
    #[serde(rename = "actor", default = "default_stream_activity_actor")]
    pub actor: String,
    /// `actorLabel`.
    #[serde(rename = "actorLabel", default = "default_stream_activity_actor_label")]
    pub actor_label: String,
    /// `value`.
    #[serde(rename = "value", default = "default_stream_activity_value")]
    pub value: JsNumber,
    /// `outcome`.
    #[serde(rename = "outcome", default = "default_stream_activity_outcome")]
    pub outcome: String,
    /// `emotes`.
    #[serde(rename = "emotes", default = "default_stream_activity_emotes")]
    pub emotes: Vec<Option<StreamActivityEmotes>>,
    /// `processed`.
    #[serde(rename = "processed", default = "default_stream_activity_processed")]
    pub processed: bool,
    /// `dashboardProcessed`.
    #[serde(rename = "dashboardProcessed", default)]
    pub dashboard_processed: Option<bool>,
    /// `expiresAt`.
    #[serde(rename = "expiresAt")]
    pub expires_at: JsDate,
}
/// Typed insert fields.
#[derive(Clone, Debug, Serialize)]
pub struct NewStreamActivity {
    /// `_id`.
    #[serde(rename = "_id")]
    pub id: String,
    /// `channelID`.
    #[serde(rename = "channelID")]
    pub channel_id: String,
    /// `session_id`.
    #[serde(rename = "session_id")]
    pub session_id: ObjectId,
    /// `occurredAt`.
    #[serde(rename = "occurredAt")]
    pub occurred_at: JsDate,
    /// `offset`.
    #[serde(rename = "offset", skip_serializing_if = "Option::is_none")]
    pub offset: Option<JsNumber>,
    /// `kind`.
    #[serde(rename = "kind")]
    pub kind: StreamActivityKindValue,
    /// `key`.
    #[serde(rename = "key", skip_serializing_if = "Option::is_none")]
    pub key: Option<String>,
    /// `label`.
    #[serde(rename = "label", skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    /// `actor`.
    #[serde(rename = "actor", skip_serializing_if = "Option::is_none")]
    pub actor: Option<String>,
    /// `actorLabel`.
    #[serde(rename = "actorLabel", skip_serializing_if = "Option::is_none")]
    pub actor_label: Option<String>,
    /// `value`.
    #[serde(rename = "value", skip_serializing_if = "Option::is_none")]
    pub value: Option<JsNumber>,
    /// `outcome`.
    #[serde(rename = "outcome", skip_serializing_if = "Option::is_none")]
    pub outcome: Option<String>,
    /// `emotes`.
    #[serde(rename = "emotes", skip_serializing_if = "Option::is_none")]
    pub emotes: Option<Vec<Option<NewStreamActivityEmotes>>>,
    /// `processed`.
    #[serde(rename = "processed", skip_serializing_if = "Option::is_none")]
    pub processed: Option<bool>,
    /// `dashboardProcessed`.
    #[serde(rename = "dashboardProcessed", skip_serializing_if = "Option::is_none")]
    pub dashboard_processed: Option<bool>,
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
    IndexSpec::on(&[("processed", 1), ("occurredAt", 1), ("_id", 1)]),
    IndexSpec::on(&[
        ("channelID", 1),
        ("session_id", 1),
        ("processed", 1),
        ("expiresAt", 1),
    ]),
    IndexSpec::on(&[
        ("channelID", 1),
        ("session_id", 1),
        ("kind", 1),
        ("occurredAt", 1),
        ("_id", 1),
    ]),
    IndexSpec::on(&[("expiresAt", 1)]).expire_after_seconds(0),
    IndexSpec::on(&[
        ("dashboardProcessed", 1),
        ("kind", 1),
        ("occurredAt", 1),
        ("_id", 1),
    ]),
    IndexSpec::on(&[
        ("channelID", 1),
        ("dashboardProcessed", 1),
        ("kind", 1),
        ("occurredAt", 1),
    ]),
];
/// Validators.
pub const RULES: &[Rule] = &[
    Rule::required("channelID"),
    Rule::required("session_id"),
    Rule::required("occurredAt"),
    Rule::required("kind"),
    Rule::one_of(
        "kind",
        &[
            "message",
            "command",
            "redemption",
            "follow",
            "sub",
            "gift",
            "bits",
            "raid",
        ],
    ),
    Rule::required("expiresAt"),
];
/// Read constraints.
pub const READ_NEEDS: &[ReadNeed] = &[
    ReadNeed::value("_id"),
    ReadNeed::value("channelID"),
    ReadNeed::value("session_id"),
    ReadNeed::value("occurredAt"),
    ReadNeed::value("kind"),
    ReadNeed::not_null("key"),
    ReadNeed::not_null("label"),
    ReadNeed::not_null("actor"),
    ReadNeed::not_null("actorLabel"),
    ReadNeed::not_null("value"),
    ReadNeed::not_null("outcome"),
    ReadNeed::not_null("emotes"),
    ReadNeed::not_null("processed"),
    ReadNeed::value("expiresAt"),
];
/// Registry entry.
pub static INFO: CollectionInfo = CollectionInfo {
    name: COLLECTION,
    model: "stream_activity",
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
    decode: decode_boxed::<StreamActivity>,
};
impl NewStreamActivity {
    /// Input before defaults.
    pub fn to_document(&self) -> Result<Document, ModelError> {
        Ok(bson::serialize_to_document(self)?)
    }
    /// Validated insert.
    pub fn prepare(&self, ctx: &mut WriteContext) -> Result<PreparedInsert, ModelError> {
        INFO.prepare_create(&self.to_document()?, ctx)
    }
}
