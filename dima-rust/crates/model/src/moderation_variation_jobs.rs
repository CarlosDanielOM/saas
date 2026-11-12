//! `moderation_variation_jobs`: reference `dimabot/src/schemas/moderation_variation.schema.ts`.
//! No hooks or runValidators; client-fed null paths: none. Writers build or normalize values.
//! Server-only nulls/removals named in READ_NEEDS are intentionally refused.
//! BSON numbers retain their stored width through JsNumber. Optional fields accept missing/null.
//! Writers: utils/moderation/variation_jobs.ts:45-102 build admission, claim and completion updates from normalized terms and provider results. No unchecked client values reach it. No version key or timestamps option. TTL expiresAt. Entries and providerUsage remain raw/private; terms are private. State is deliberately a String: the schema declares no enum.

use crate::decode::decode_boxed;
use crate::{ClientNulls, CollectionInfo, Hooks, IndexSpec, ModelError, Private, ReadNeed, Rule};
use bson::{Bson, Document};
use dima_store::mongo::schema::{DefaultValue as D, Field, Schema, ValueType};
use dima_store::mongo::{
    WriteContext, date::JsDate, id::IdType, insert::PreparedInsert, number::JsNumber,
};
use serde::{Deserialize, Serialize};
fn default_terms() -> Private<Vec<String>> {
    Private::new(Vec::new())
}
/// Raw `entries`, owned by its feature.
#[derive(Clone, Debug, Deserialize)]
#[serde(transparent)]
pub struct EntriesContent(pub Vec<Bson>);
fn default_entries() -> Private<EntriesContent> {
    Private::new(EntriesContent(Vec::new()))
}
fn default_error() -> Private<String> {
    Private::new("".into())
}
fn default_attempts() -> JsNumber {
    JsNumber(1.0)
}
/// Raw `providerUsage`, owned by its feature.
#[derive(Clone, Debug, Deserialize)]
#[serde(transparent)]
pub struct ProviderUsageContent(pub Bson);
fn default_provider_usage() -> Private<ProviderUsageContent> {
    Private::new(ProviderUsageContent(Bson::Array(vec![])))
}
fn default_credits_charged() -> JsNumber {
    JsNumber(0.0)
}
/// Collection name.
pub const COLLECTION: &str = "moderation_variation_jobs";
/// Frozen schema.
pub static SCHEMA: Schema = Schema::new(&[
    Field::string("_id"),
    Field::string("channelID"),
    Field::array("terms", ValueType::String).default(D::EmptyArray),
    Field::string("state"),
    Field::mixed_array("entries").default(D::EmptyArray),
    Field::string("error").default(D::Str("")),
    Field::number("attempts").default(D::Int(1)),
    Field::date("createdAt"),
    Field::date("deadline"),
    Field::date("expiresAt"),
    Field::string("model"),
    Field::string("version"),
    Field::mixed("providerUsage").default_fn(D::EmptyArray),
    Field::number("creditsCharged").default(D::Int(0)),
])
.declared_id()
.no_version_key();
/// Hidden paths.
pub const HIDDEN: &[&str] = &[];
/// Private paths.
pub const PRIVATE: &[&str] = &["terms", "entries", "error", "providerUsage"];
/// Declared indexes.
pub const INDEXES: &[IndexSpec] = &[
    IndexSpec::on(&[("state", 1), ("createdAt", 1)]),
    IndexSpec::on(&[("expiresAt", 1)]).expire_after_seconds(0),
];
/// Validators.
pub const RULES: &[Rule] = &[];
/// Read constraints.
pub const READ_NEEDS: &[ReadNeed] = &[
    ReadNeed::value("_id"),
    ReadNeed::not_null("terms"),
    ReadNeed::not_null("entries"),
    ReadNeed::not_null("error"),
    ReadNeed::not_null("attempts"),
    ReadNeed::not_null("creditsCharged"),
];
/// Registry entry.
pub static INFO: CollectionInfo = CollectionInfo {
    name: COLLECTION,
    model: "moderation_variation_job",
    source: "dimabot/src/schemas/moderation_variation.schema.ts",
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
    decode: decode_boxed::<ModerationVariationJob>,
};
/// Hydrated document.
#[derive(Clone, Debug, Deserialize)]
pub struct ModerationVariationJob {
    /// `_id`.
    #[serde(rename = "_id")]
    pub id: String,
    /// `channelID`.
    #[serde(rename = "channelID", default)]
    pub channel_id: Option<String>,
    /// `terms`.
    #[serde(rename = "terms", default = "default_terms")]
    pub terms: Private<Vec<String>>,
    /// `state`.
    #[serde(rename = "state", default)]
    pub state: Option<String>,
    /// `entries`.
    #[serde(rename = "entries", default = "default_entries")]
    pub entries: Private<EntriesContent>,
    /// `error`.
    #[serde(rename = "error", default = "default_error")]
    pub error: Private<String>,
    /// `attempts`.
    #[serde(rename = "attempts", default = "default_attempts")]
    pub attempts: JsNumber,
    /// `createdAt`.
    #[serde(rename = "createdAt", default)]
    pub created_at: Option<JsDate>,
    /// `deadline`.
    #[serde(rename = "deadline", default)]
    pub deadline: Option<JsDate>,
    /// `expiresAt`.
    #[serde(rename = "expiresAt", default)]
    pub expires_at: Option<JsDate>,
    /// `model`.
    #[serde(rename = "model", default)]
    pub model: Option<String>,
    /// `version`.
    #[serde(rename = "version", default)]
    pub version: Option<String>,
    /// `providerUsage`.
    #[serde(rename = "providerUsage", default = "default_provider_usage")]
    pub provider_usage: Private<ProviderUsageContent>,
    /// `creditsCharged`.
    #[serde(rename = "creditsCharged", default = "default_credits_charged")]
    pub credits_charged: JsNumber,
}
/// New document.
#[derive(Clone, Debug, Serialize)]
pub struct NewModerationVariationJob {
    /// `_id`.
    #[serde(rename = "_id")]
    pub id: String,
    /// `channelID`.
    #[serde(rename = "channelID", skip_serializing_if = "Option::is_none")]
    pub channel_id: Option<String>,
    /// `terms`.
    #[serde(rename = "terms", skip_serializing_if = "Option::is_none")]
    pub terms: Option<Private<Vec<String>>>,
    /// `state`.
    #[serde(rename = "state", skip_serializing_if = "Option::is_none")]
    pub state: Option<String>,
    /// `entries`.
    #[serde(rename = "entries", skip_serializing_if = "Option::is_none")]
    pub entries: Option<Private<Vec<Bson>>>,
    /// `error`.
    #[serde(rename = "error", skip_serializing_if = "Option::is_none")]
    pub error: Option<Private<String>>,
    /// `attempts`.
    #[serde(rename = "attempts", skip_serializing_if = "Option::is_none")]
    pub attempts: Option<JsNumber>,
    /// `createdAt`.
    #[serde(rename = "createdAt", skip_serializing_if = "Option::is_none")]
    pub created_at: Option<JsDate>,
    /// `deadline`.
    #[serde(rename = "deadline", skip_serializing_if = "Option::is_none")]
    pub deadline: Option<JsDate>,
    /// `expiresAt`.
    #[serde(rename = "expiresAt", skip_serializing_if = "Option::is_none")]
    pub expires_at: Option<JsDate>,
    /// `model`.
    #[serde(rename = "model", skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    /// `version`.
    #[serde(rename = "version", skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    /// `providerUsage`.
    #[serde(rename = "providerUsage", skip_serializing_if = "Option::is_none")]
    pub provider_usage: Option<Private<Bson>>,
    /// `creditsCharged`.
    #[serde(rename = "creditsCharged", skip_serializing_if = "Option::is_none")]
    pub credits_charged: Option<JsNumber>,
}
impl NewModerationVariationJob {
    /// Input before defaults.
    pub fn to_document(&self) -> Result<Document, ModelError> {
        Ok(bson::serialize_to_document(self)?)
    }
    /// Validated insert.
    pub fn prepare(&self, ctx: &mut WriteContext) -> Result<PreparedInsert, ModelError> {
        INFO.prepare_create(&self.to_document()?, ctx)
    }
}
