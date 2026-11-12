//! `duel_results`.
//! Reference: duel/stats.ts:10-12; no timestamps, __v, hooks or hidden fields.
//! Key: run.id as string _id; results counted by channel/winner/loser for rivalries/rankings.
//! Repeat rule: recordDuelResult (stats.ts:16-17) creates once and swallows every E11000,
//! without comparing an existing result's payload. MongoDB's built-in unique _id prevents
//! counting a repeated run twice. The compound lookup index is nonunique and best effort.
//! Writer checked: stats.ts:16, called by completion.ts:99 only for tracked fights
//! (run.tracked, or legacy mode=overlay). No reference updates, saves or runValidators;
//! the recorder includes a helper update to exercise the supported write/read contract.
//! Client path checked: commands/duel.command.ts:25-55 validates participant logins;
//! duel/model.ts:createRun supplies winner/endsAt and completion builds streamer identity.
//! Routes duel-widget.route.ts and overlay handlers only read results, no site-agent writer.
//! No unchecked client-fed paths. Winner/loser/streamer logins are Private in read/input types.
//! Legacy: streamer null on non-enraged fights; all census at values double epoch milliseconds.
//! No other legacy field or numeric variance. Server-only null/removal of READ_NEEDS paths
//! is refused. Duplicate payload disagreement is intentionally not checked, as in reference.

use crate::decode::decode_boxed;
use crate::values::Nullable;
use crate::{ClientNulls, CollectionInfo, Hooks, IndexSpec, ModelError, Private, ReadNeed, Rule};
use bson::Document;
use dima_store::mongo::schema::{DefaultValue as D, Field, Schema};
use dima_store::mongo::{WriteContext, id::IdType, insert::PreparedInsert, number::JsNumber};
use serde::{Deserialize, Serialize};

/// Collection name.
pub const COLLECTION: &str = "duel_results";
/// Frozen schema.
pub static SCHEMA: Schema = Schema::new(&[
    Field::string("_id"),
    Field::string("channel"),
    Field::string("winner"),
    Field::string("loser"),
    Field::string("streamer").default(D::Null),
    Field::number("at"),
])
.declared_id()
.no_version_key();
/// Hidden paths.
pub const HIDDEN: &[&str] = &[];
/// Private paths.
pub const PRIVATE: &[&str] = &["winner", "loser", "streamer"];
/// Declared indexes.
pub const INDEXES: &[IndexSpec] = &[IndexSpec::on(&[
    ("channel", 1),
    ("winner", 1),
    ("loser", 1),
])];
/// Validators.
pub const RULES: &[Rule] = &[
    Rule::required("channel"),
    Rule::required("winner"),
    Rule::required("loser"),
    Rule::required("at"),
];
/// Read constraints.
pub const READ_NEEDS: &[ReadNeed] = &[
    ReadNeed::value("_id"),
    ReadNeed::value("channel"),
    ReadNeed::value("winner"),
    ReadNeed::value("loser"),
    ReadNeed::value("at"),
];
/// Registry entry.
pub static INFO: CollectionInfo = CollectionInfo {
    name: COLLECTION,
    model: "DuelResult",
    source: "dimabot/src/duel/stats.ts",
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
    decode: decode_boxed::<DuelResult>,
};
/// Stored document.
#[derive(Clone, Debug, Deserialize)]
pub struct DuelResult {
    /// `_id`.
    #[serde(rename = "_id")]
    pub id: String,
    /// `channel`.
    #[serde(rename = "channel")]
    pub channel: String,
    /// `winner`.
    #[serde(rename = "winner")]
    pub winner: Private<String>,
    /// `loser`.
    #[serde(rename = "loser")]
    pub loser: Private<String>,
    /// `streamer`.
    #[serde(rename = "streamer", default)]
    pub streamer: Option<Private<String>>,
    /// `at`.
    #[serde(rename = "at")]
    pub at: JsNumber,
}
/// Typed insert.
#[derive(Clone, Debug, Serialize)]
pub struct NewDuelResult {
    /// `_id`.
    #[serde(rename = "_id")]
    pub id: String,
    /// `channel`.
    #[serde(rename = "channel")]
    pub channel: String,
    /// `winner`.
    #[serde(rename = "winner")]
    pub winner: Private<String>,
    /// `loser`.
    #[serde(rename = "loser")]
    pub loser: Private<String>,
    /// `streamer`.
    #[serde(rename = "streamer", skip_serializing_if = "Nullable::is_unset")]
    pub streamer: Nullable<Private<String>>,
    /// `at`.
    #[serde(rename = "at")]
    pub at: JsNumber,
}
impl NewDuelResult {
    /// Input before defaults.
    pub fn to_document(&self) -> Result<Document, ModelError> {
        Ok(bson::serialize_to_document(self)?)
    }
    /// Validated insert.
    pub fn prepare(&self, ctx: &mut WriteContext) -> Result<PreparedInsert, ModelError> {
        INFO.prepare_create(&self.to_document()?, ctx)
    }
}
