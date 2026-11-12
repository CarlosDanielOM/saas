//! `cliprecommendationconfigs`: reference `dimabot/src/schemas/clip_recommendation_config.schema.ts`.
//! Snake timestamps, __v, no hooks or runValidators. Client-fed null paths: none.
//! Audited server/routes/clip-recommendations.route.ts:88-107: typeof autoAnalyzeEnabled must
//! be boolean, channelID is String-normalized; no body spread or unchecked copied field.
//! utils/ai/clip_recommendations/vod_clip_recommendation_runner.ts:314-318 builds date/upsert
//! values; utils/stream_analytics.ts:224 and scripts/reconcile_stream_offline.script.ts:91 only read.
//! No legacy type variance in the two census rows; lastAnalyzedAt accepts missing/null by schema.
//! Unique channelID is declared but best effort: the reference never awaits its index,
//! and config rows do not count or charge anything.
//! Server-only READ_NEEDS nulls/removals are refused.
use crate::decode::decode_boxed;
use crate::values::Nullable;
use crate::{ClientNulls, CollectionInfo, Hooks, IndexSpec, ModelError, ReadNeed, Rule};
use bson::{Document, oid::ObjectId};
use dima_store::mongo::schema::Timestamps;
use dima_store::mongo::schema::{DefaultValue as D, Field, Schema};
use dima_store::mongo::{WriteContext, date::JsDate, id::IdType, insert::PreparedInsert};
use serde::{Deserialize, Serialize};
fn default_auto_analyze_enabled() -> bool {
    false
}
/// Collection name.
pub const COLLECTION: &str = "cliprecommendationconfigs";
/// Frozen schema.
pub static SCHEMA: Schema = Schema::new(&[
    Field::string("channelID"),
    Field::boolean("autoAnalyzeEnabled").default(D::Bool(false)),
    Field::date("lastAnalyzedAt").default(D::Null),
])
.timestamps(Timestamps::SNAKE);
/// Hidden fields.
pub const HIDDEN: &[&str] = &[];
/// Private fields.
pub const PRIVATE: &[&str] = &[];
/// Declared indexes.
pub const INDEXES: &[IndexSpec] = &[
    IndexSpec::on(&[("channelID", 1)]).unique(),
    IndexSpec::on(&[("autoAnalyzeEnabled", 1)]),
];
/// Validators.
pub const RULES: &[Rule] = &[Rule::required("channelID")];
/// Read constraints.
pub const READ_NEEDS: &[ReadNeed] = &[
    ReadNeed::value("channelID"),
    ReadNeed::not_null("autoAnalyzeEnabled"),
];
/// Registry entry.
pub static INFO: CollectionInfo = CollectionInfo {
    name: COLLECTION,
    model: "ClipRecommendationConfig",
    source: "dimabot/src/schemas/clip_recommendation_config.schema.ts",
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
    decode: decode_boxed::<ClipRecommendationConfig>,
};
/// Hydrated fields.
#[derive(Clone, Debug, Deserialize)]
pub struct ClipRecommendationConfig {
    /// `_id`.
    #[serde(rename = "_id")]
    pub id: ObjectId,
    /// `channelID`.
    #[serde(rename = "channelID")]
    pub channel_id: String,
    /// `autoAnalyzeEnabled`.
    #[serde(
        rename = "autoAnalyzeEnabled",
        default = "default_auto_analyze_enabled"
    )]
    pub auto_analyze_enabled: bool,
    /// `lastAnalyzedAt`.
    #[serde(rename = "lastAnalyzedAt", default)]
    pub last_analyzed_at: Option<JsDate>,
    /// `created_at`.
    pub created_at: Option<JsDate>,
    /// `updated_at`.
    pub updated_at: Option<JsDate>,
}
/// Typed insert fields.
#[derive(Clone, Debug, Serialize)]
pub struct NewClipRecommendationConfig {
    /// `channelID`.
    #[serde(rename = "channelID")]
    pub channel_id: String,
    /// `autoAnalyzeEnabled`.
    #[serde(rename = "autoAnalyzeEnabled", skip_serializing_if = "Option::is_none")]
    pub auto_analyze_enabled: Option<bool>,
    /// `lastAnalyzedAt`.
    #[serde(rename = "lastAnalyzedAt", skip_serializing_if = "Nullable::is_unset")]
    pub last_analyzed_at: Nullable<JsDate>,
}
impl NewClipRecommendationConfig {
    /// Input before defaults.
    pub fn to_document(&self) -> Result<Document, ModelError> {
        Ok(bson::serialize_to_document(self)?)
    }
    /// Validated insert.
    pub fn prepare(&self, ctx: &mut WriteContext) -> Result<PreparedInsert, ModelError> {
        INFO.prepare_create(&self.to_document()?, ctx)
    }
}
