//! `streamviewersnapshots`: reference `dimabot/src/schemas/stream_viewer_snapshot.schema.ts`.
//! No hooks or hidden paths. Snake-case timestamps and __v. Indexes declared below.
//! No reference update passes runValidators.
//! Writers checked: utils/stream_analytics.ts:1360 (new document save); viewers and counters
//! are normalized and title/game defaulted; no unchecked client-fed writes or runValidators.
//! No Rust writer (dashboard_insights reads only). No legacy null fields; timestamps and __v retained.
//! Server-only nulls/removals in READ_NEEDS are refused; census shows none there.

use crate::decode::decode_boxed;
use crate::{ClientNulls, CollectionInfo, Hooks, IndexSpec, ModelError, ReadNeed, Rule};
use bson::{Document, oid::ObjectId};
use dima_store::mongo::schema::{DefaultValue as D, Field, Schema, Timestamps};
use dima_store::mongo::{
    WriteContext, date::JsDate, id::IdType, insert::PreparedInsert, number::JsNumber,
};
use serde::{Deserialize, Serialize};
/// Collection name.
pub const COLLECTION: &str = "streamviewersnapshots";
/// Frozen schema.
pub static SCHEMA: Schema = Schema::new(&[
    Field::string("channelID"),
    Field::object_id("session_id"),
    Field::string("stream_id"),
    Field::date("captured_at"),
    Field::number("viewers"),
    Field::string("title").default(D::Str("")),
    Field::string("game_name").default(D::Str("")),
    Field::number("messages").default(D::Int(0)),
    Field::number("commands").default(D::Int(0)),
])
.timestamps(Timestamps::SNAKE);
fn default_stream_viewer_snapshot_title() -> crate::Private<String> {
    "".into()
}
fn default_stream_viewer_snapshot_game_name() -> String {
    "".into()
}
fn default_stream_viewer_snapshot_messages() -> JsNumber {
    JsNumber(0.0)
}
fn default_stream_viewer_snapshot_commands() -> JsNumber {
    JsNumber(0.0)
}
/// Hydrated fields.
#[derive(Clone, Debug, Deserialize)]
pub struct StreamViewerSnapshot {
    /// `_id`.
    #[serde(rename = "_id")]
    pub id: ObjectId,
    /// `channelID`.
    #[serde(rename = "channelID")]
    pub channel_id: String,
    /// `session_id`.
    #[serde(rename = "session_id")]
    pub session_id: ObjectId,
    /// `stream_id`.
    #[serde(rename = "stream_id")]
    pub stream_id: String,
    /// `captured_at`.
    #[serde(rename = "captured_at")]
    pub captured_at: JsDate,
    /// `viewers`.
    #[serde(rename = "viewers")]
    pub viewers: JsNumber,
    /// `title`.
    #[serde(rename = "title", default = "default_stream_viewer_snapshot_title")]
    pub title: crate::Private<String>,
    /// `game_name`.
    #[serde(
        rename = "game_name",
        default = "default_stream_viewer_snapshot_game_name"
    )]
    pub game_name: String,
    /// `messages`.
    #[serde(
        rename = "messages",
        default = "default_stream_viewer_snapshot_messages"
    )]
    pub messages: JsNumber,
    /// `commands`.
    #[serde(
        rename = "commands",
        default = "default_stream_viewer_snapshot_commands"
    )]
    pub commands: JsNumber,
    /// Timestamp.
    #[serde(default)]
    pub created_at: Option<JsDate>,
    /// Timestamp.
    #[serde(default)]
    pub updated_at: Option<JsDate>,
}
/// Typed insert fields.
#[derive(Clone, Debug, Serialize)]
pub struct NewStreamViewerSnapshot {
    /// `channelID`.
    #[serde(rename = "channelID")]
    pub channel_id: String,
    /// `session_id`.
    #[serde(rename = "session_id")]
    pub session_id: ObjectId,
    /// `stream_id`.
    #[serde(rename = "stream_id")]
    pub stream_id: String,
    /// `captured_at`.
    #[serde(rename = "captured_at")]
    pub captured_at: JsDate,
    /// `viewers`.
    #[serde(rename = "viewers")]
    pub viewers: JsNumber,
    /// `title`.
    #[serde(rename = "title", skip_serializing_if = "Option::is_none")]
    pub title: Option<crate::Private<String>>,
    /// `game_name`.
    #[serde(rename = "game_name", skip_serializing_if = "Option::is_none")]
    pub game_name: Option<String>,
    /// `messages`.
    #[serde(rename = "messages", skip_serializing_if = "Option::is_none")]
    pub messages: Option<JsNumber>,
    /// `commands`.
    #[serde(rename = "commands", skip_serializing_if = "Option::is_none")]
    pub commands: Option<JsNumber>,
}
/// Hidden paths.
pub const HIDDEN: &[&str] = &[];
/// Private paths.
pub const PRIVATE: &[&str] = &["title"];
/// Declared indexes.
pub const INDEXES: &[IndexSpec] = &[
    IndexSpec::on(&[("channelID", 1)]),
    IndexSpec::on(&[("session_id", 1)]),
    IndexSpec::on(&[("stream_id", 1)]),
    IndexSpec::on(&[("captured_at", 1)]),
    IndexSpec::on(&[("channelID", 1), ("captured_at", -1)]),
    IndexSpec::on(&[("session_id", 1), ("captured_at", 1)]),
];
/// Validators.
pub const RULES: &[Rule] = &[
    Rule::required("channelID"),
    Rule::required("session_id"),
    Rule::required("stream_id"),
    Rule::required("captured_at"),
    Rule::required("viewers"),
    Rule::min("viewers", 0.0),
    Rule::min("messages", 0.0),
    Rule::min("commands", 0.0),
];
/// Read constraints.
pub const READ_NEEDS: &[ReadNeed] = &[
    ReadNeed::value("channelID"),
    ReadNeed::value("session_id"),
    ReadNeed::value("stream_id"),
    ReadNeed::value("captured_at"),
    ReadNeed::value("viewers"),
    ReadNeed::not_null("title"),
    ReadNeed::not_null("game_name"),
    ReadNeed::not_null("messages"),
    ReadNeed::not_null("commands"),
];
/// Registry entry.
pub static INFO: CollectionInfo = CollectionInfo {
    name: COLLECTION,
    model: "StreamViewerSnapshot",
    source: "dimabot/src/schemas/stream_viewer_snapshot.schema.ts",
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
    decode: decode_boxed::<StreamViewerSnapshot>,
};
impl NewStreamViewerSnapshot {
    /// Input before defaults.
    pub fn to_document(&self) -> Result<Document, ModelError> {
        Ok(bson::serialize_to_document(self)?)
    }
    /// Validated insert.
    pub fn prepare(&self, ctx: &mut WriteContext) -> Result<PreparedInsert, ModelError> {
        INFO.prepare_create(&self.to_document()?, ctx)
    }
}
