//! `stream_markers`: reference `dimabot/src/schemas/stream_timeline.schema.ts`.
//! No hooks or hidden paths. No timestamps or __v. Indexes declared below.
//! No reference update passes runValidators.
//! Writers checked: utils/stream_timeline.ts:35,52; server/routes/stream_timeline.route.ts:134.
//! Client label and offsetSeconds are checked (typeof, trim, bounds) before the route write,
//! so no unchecked client-fed paths. No saves or runValidators. Optional value, rewardID, cost,
//! status may be missing. Unique channel/session/key is required to avoid duplicate moments.
//! Server-only nulls/removals in READ_NEEDS are refused; census shows none there.

use crate::decode::decode_boxed;
use crate::{ClientNulls, CollectionInfo, Hooks, IndexSpec, ModelError, ReadNeed, Rule};
use bson::{Document, oid::ObjectId};
use dima_store::mongo::schema::{Field, Schema};
use dima_store::mongo::{
    WriteContext, date::JsDate, id::IdType, insert::PreparedInsert, number::JsNumber,
};
use serde::{Deserialize, Serialize};
/// Collection name.
pub const COLLECTION: &str = "stream_markers";
crate::enums::str_enum! { /// Schema vocabulary.
pub enum StreamMarkerKindValue {/// Schema value.
Note = "note",/// Schema value.
Redemption = "redemption",/// Schema value.
Follow = "follow",/// Schema value.
Sub = "sub",/// Schema value.
Gift = "gift",/// Schema value.
Bits = "bits",/// Schema value.
Raid = "raid"}}
/// Frozen schema.
pub static SCHEMA: Schema = Schema::new(&[
    Field::string("channelID"),
    Field::object_id("session_id"),
    Field::string("key"),
    Field::string("kind"),
    Field::string("label"),
    Field::number("value"),
    Field::string("rewardID"),
    Field::number("cost"),
    Field::string("status"),
    Field::date("occurredAt"),
    Field::date("expiresAt"),
])
.no_version_key();
/// Hydrated fields.
#[derive(Clone, Debug, Deserialize)]
pub struct StreamMarker {
    /// `_id`.
    #[serde(rename = "_id")]
    pub id: ObjectId,
    /// `channelID`.
    #[serde(rename = "channelID")]
    pub channel_id: String,
    /// `session_id`.
    #[serde(rename = "session_id")]
    pub session_id: ObjectId,
    /// `key`.
    #[serde(rename = "key")]
    pub key: String,
    /// `kind`.
    #[serde(rename = "kind")]
    pub kind: crate::Open<StreamMarkerKindValue>,
    /// `label`.
    #[serde(rename = "label")]
    pub label: crate::Private<String>,
    /// `value`.
    #[serde(rename = "value", default)]
    pub value: Option<JsNumber>,
    /// `rewardID`.
    #[serde(rename = "rewardID", default)]
    pub reward_id: Option<String>,
    /// `cost`.
    #[serde(rename = "cost", default)]
    pub cost: Option<JsNumber>,
    /// `status`.
    #[serde(rename = "status", default)]
    pub status: Option<String>,
    /// `occurredAt`.
    #[serde(rename = "occurredAt")]
    pub occurred_at: JsDate,
    /// `expiresAt`.
    #[serde(rename = "expiresAt")]
    pub expires_at: JsDate,
}
/// Typed insert fields.
#[derive(Clone, Debug, Serialize)]
pub struct NewStreamMarker {
    /// `channelID`.
    #[serde(rename = "channelID")]
    pub channel_id: String,
    /// `session_id`.
    #[serde(rename = "session_id")]
    pub session_id: ObjectId,
    /// `key`.
    #[serde(rename = "key")]
    pub key: String,
    /// `kind`.
    #[serde(rename = "kind")]
    pub kind: StreamMarkerKindValue,
    /// `label`.
    #[serde(rename = "label")]
    pub label: crate::Private<String>,
    /// `value`.
    #[serde(rename = "value", skip_serializing_if = "Option::is_none")]
    pub value: Option<JsNumber>,
    /// `rewardID`.
    #[serde(rename = "rewardID", skip_serializing_if = "Option::is_none")]
    pub reward_id: Option<String>,
    /// `cost`.
    #[serde(rename = "cost", skip_serializing_if = "Option::is_none")]
    pub cost: Option<JsNumber>,
    /// `status`.
    #[serde(rename = "status", skip_serializing_if = "Option::is_none")]
    pub status: Option<String>,
    /// `occurredAt`.
    #[serde(rename = "occurredAt")]
    pub occurred_at: JsDate,
    /// `expiresAt`.
    #[serde(rename = "expiresAt")]
    pub expires_at: JsDate,
}
/// Hidden paths.
pub const HIDDEN: &[&str] = &[];
/// Private paths.
pub const PRIVATE: &[&str] = &["label"];
/// Declared indexes.
pub const INDEXES: &[IndexSpec] = &[
    IndexSpec::on(&[("channelID", 1), ("session_id", 1), ("key", 1)]).unique(),
    IndexSpec::on(&[
        ("channelID", 1),
        ("session_id", 1),
        ("occurredAt", 1),
        ("_id", 1),
    ]),
    IndexSpec::on(&[
        ("channelID", 1),
        ("session_id", 1),
        ("kind", 1),
        ("occurredAt", 1),
        ("_id", 1),
    ]),
    IndexSpec::on(&[("expiresAt", 1)]).expire_after_seconds(0),
];
/// Validators.
pub const RULES: &[Rule] = &[
    Rule::required("channelID"),
    Rule::required("session_id"),
    Rule::required("key"),
    Rule::required("kind"),
    Rule::one_of(
        "kind",
        &[
            "note",
            "redemption",
            "follow",
            "sub",
            "gift",
            "bits",
            "raid",
        ],
    ),
    Rule::required("label"),
    Rule::max_length("label", 120),
    Rule::required("occurredAt"),
    Rule::required("expiresAt"),
];
/// Read constraints.
pub const READ_NEEDS: &[ReadNeed] = &[
    ReadNeed::value("channelID"),
    ReadNeed::value("session_id"),
    ReadNeed::value("key"),
    ReadNeed::value("kind"),
    ReadNeed::value("label"),
    ReadNeed::value("occurredAt"),
    ReadNeed::value("expiresAt"),
];
/// Registry entry.
pub static INFO: CollectionInfo = CollectionInfo {
    name: COLLECTION,
    model: "stream_marker",
    source: "dimabot/src/schemas/stream_timeline.schema.ts",
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
    decode: decode_boxed::<StreamMarker>,
};
impl NewStreamMarker {
    /// Input before defaults.
    pub fn to_document(&self) -> Result<Document, ModelError> {
        Ok(bson::serialize_to_document(self)?)
    }
    /// Validated insert.
    pub fn prepare(&self, ctx: &mut WriteContext) -> Result<PreparedInsert, ModelError> {
        INFO.prepare_create(&self.to_document()?, ctx)
    }
}
