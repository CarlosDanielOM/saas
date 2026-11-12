//! `duel_widgets`.
//! Reference: duel/service.ts:15-17; no timestamps, __v or hooks; overlayToken hidden.
//! Writers checked: duel/service.ts:27 (load/create),57 (configure),64 (token store),108
//! (challenge),119 (fight streamer),128 (accept),137 (decline); duel/completion.ts:58 (errors),
//! 66 (lease claim),70 (expiry),73 (clear deadline),79 (phrase),86,93 (effect claims),105
//! (completion/statistics),107 (lease release). No document saves or runValidators.
//! Client callers checked: server/routes/duel-widget.route.ts:17-22 configure/token bodies;
//! settings() in duel/model.ts validates switches, language/quality, numbers and rules.
//! commands/duel.command.ts:25-55 regex-checks logins before challenge/accept/decline/fight.
//! server/services/duel-overlay.service.ts readiness writes Dragonfly only; no Mongo body copy.
//! widget_feed/bot-events.ts emits events only; no site-agent writer imports this model.
//! No unchecked client-fed typed paths. Mixed settings/challenge/run and encrypted token stay
//! raw behind named newtypes and Private (logins, phrases, provider errors and secrets).
//! Schema imposes no size/depth bound; dashboard JSON parser defaults to 100 KiB, no explicit
//! depth validator; MongoDB's 16 MiB document ceiling applies. No extra raw-field limit.
//! Legacy: missing statsRevision/languageConfigured use schema defaults zero/false; encrypted
//! token absent, challenge/run/tokenHash/dueAt null; settings can lack leaderboard/rivalries,
//! rules/quality, and runs can lack tracked/maxHp/healCharges/record. Raw payloads retain all.
//! Census revision/leaseUntil/statsRevision int32, receipt and run epoch fields double.
//! Server-only null/removal of READ_NEEDS paths is refused; dueAt/challenge/run keep null.
//! Deadline index best effort; no declared unique index or init wait.

use crate::decode::decode_boxed;
use crate::{ClientNulls, CollectionInfo, Hooks, IndexSpec, ModelError, Private, ReadNeed, Rule};
use bson::{Bson, Document};
use dima_store::mongo::schema::{DefaultValue as D, Field, Schema};
use dima_store::mongo::{WriteContext, id::IdType, insert::PreparedInsert, number::JsNumber};
use serde::{Deserialize, Serialize};
/// Raw `settings`; limits are documented in the module header.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(transparent)]
pub struct DuelWidgetSettingsContent(pub Bson);
/// Raw `challenge`; limits are documented in the module header.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(transparent)]
pub struct DuelWidgetChallengeContent(pub Bson);
/// Raw `run`; limits are documented in the module header.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(transparent)]
pub struct DuelWidgetRunContent(pub Bson);
/// Raw `overlayToken`; limits are documented in the module header.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(transparent)]
pub struct DuelWidgetOverlayTokenContent(pub Bson);
static SCHEMA_RECEIPTS: Schema = Schema::subdocument(&[
    Field::string("key"),
    Field::string("fingerprint"),
    Field::number("at"),
])
.no_id();
/// Stored `receipts` entry.
#[derive(Clone, Debug, Deserialize)]
pub struct DuelWidgetReceiptsEntry {
    /// `receipts.$.key`.
    #[serde(rename = "key")]
    pub key: String,
    /// `receipts.$.fingerprint`.
    #[serde(rename = "fingerprint")]
    pub fingerprint: String,
    /// `receipts.$.at`.
    #[serde(rename = "at")]
    pub at: JsNumber,
}
/// Input `receipts` entry.
#[derive(Clone, Debug, Serialize)]
pub struct NewDuelWidgetReceiptsEntry {
    /// `receipts.$.key`.
    #[serde(rename = "key")]
    pub key: String,
    /// `receipts.$.fingerprint`.
    #[serde(rename = "fingerprint")]
    pub fingerprint: String,
    /// `receipts.$.at`.
    #[serde(rename = "at")]
    pub at: JsNumber,
}
fn default_duel_widget_revision() -> JsNumber {
    JsNumber(0.0)
}
fn default_duel_widget_lease_until() -> JsNumber {
    JsNumber(0.0)
}
fn default_duel_widget_stats_revision() -> JsNumber {
    JsNumber(0.0)
}
/// Collection name.
pub const COLLECTION: &str = "duel_widgets";
/// Frozen schema.
pub static SCHEMA: Schema = Schema::new(&[
    Field::string("_id"),
    Field::number("revision").default(D::Int(0)),
    Field::mixed("settings"),
    Field::mixed("challenge").default(D::Null),
    Field::mixed("run").default(D::Null),
    Field::string("tokenHash").default(D::Null),
    Field::mixed("overlayToken"),
    Field::number("dueAt").default(D::Null),
    Field::number("leaseUntil").default(D::Int(0)),
    Field::number("statsRevision").default(D::Int(0)),
    Field::boolean("languageConfigured").default(D::Bool(false)),
    Field::document_array("receipts", &SCHEMA_RECEIPTS).default(D::EmptyArray),
])
.declared_id()
.no_version_key();
/// Hidden paths.
pub const HIDDEN: &[&str] = &["overlayToken"];
/// Private paths.
pub const PRIVATE: &[&str] = &["settings", "challenge", "run", "tokenHash", "overlayToken"];
/// Declared indexes.
pub const INDEXES: &[IndexSpec] = &[IndexSpec::on(&[("dueAt", 1)])];
/// Validators.
pub const RULES: &[Rule] = &[Rule::required("settings")];
/// Read constraints.
pub const READ_NEEDS: &[ReadNeed] = &[
    ReadNeed::value("_id"),
    ReadNeed::value("receipts.$.key"),
    ReadNeed::value("receipts.$.fingerprint"),
    ReadNeed::value("receipts.$.at"),
    ReadNeed::not_null("revision"),
    ReadNeed::not_null("leaseUntil"),
    ReadNeed::not_null("statsRevision"),
    ReadNeed::not_null("languageConfigured"),
    ReadNeed::not_null("receipts"),
];
/// Registry entry.
pub static INFO: CollectionInfo = CollectionInfo {
    name: COLLECTION,
    model: "DuelWidget",
    source: "dimabot/src/duel/service.ts",
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
    decode: decode_boxed::<DuelWidget>,
};
/// Stored document.
#[derive(Clone, Debug, Deserialize)]
pub struct DuelWidget {
    /// `_id`.
    #[serde(rename = "_id")]
    pub id: String,
    /// `revision`.
    #[serde(rename = "revision", default = "default_duel_widget_revision")]
    pub revision: JsNumber,
    /// `settings`.
    #[serde(rename = "settings", default)]
    pub settings: Option<Private<DuelWidgetSettingsContent>>,
    /// `challenge`.
    #[serde(rename = "challenge", default)]
    pub challenge: Option<Private<DuelWidgetChallengeContent>>,
    /// `run`.
    #[serde(rename = "run", default)]
    pub run: Option<Private<DuelWidgetRunContent>>,
    /// `tokenHash`.
    #[serde(rename = "tokenHash", default)]
    pub token_hash: Option<Private<String>>,
    /// `overlayToken`.
    #[serde(rename = "overlayToken", default)]
    pub overlay_token: Option<Private<DuelWidgetOverlayTokenContent>>,
    /// `dueAt`.
    #[serde(rename = "dueAt", default)]
    pub due_at: Option<JsNumber>,
    /// `leaseUntil`.
    #[serde(rename = "leaseUntil", default = "default_duel_widget_lease_until")]
    pub lease_until: JsNumber,
    /// `statsRevision`.
    #[serde(
        rename = "statsRevision",
        default = "default_duel_widget_stats_revision"
    )]
    pub stats_revision: JsNumber,
    /// `languageConfigured`.
    #[serde(rename = "languageConfigured", default)]
    pub language_configured: bool,
    /// `receipts`.
    #[serde(rename = "receipts", default)]
    pub receipts: Vec<Option<DuelWidgetReceiptsEntry>>,
}
/// Typed insert.
#[derive(Clone, Debug, Serialize)]
pub struct NewDuelWidget {
    /// `_id`.
    #[serde(rename = "_id")]
    pub id: String,
    /// `revision`.
    #[serde(rename = "revision", skip_serializing_if = "Option::is_none")]
    pub revision: Option<JsNumber>,
    /// `settings`.
    #[serde(rename = "settings")]
    pub settings: Private<DuelWidgetSettingsContent>,
    /// `challenge`.
    #[serde(rename = "challenge", skip_serializing_if = "Option::is_none")]
    pub challenge: Option<Private<DuelWidgetChallengeContent>>,
    /// `run`.
    #[serde(rename = "run", skip_serializing_if = "Option::is_none")]
    pub run: Option<Private<DuelWidgetRunContent>>,
    /// `tokenHash`.
    #[serde(rename = "tokenHash", skip_serializing_if = "Option::is_none")]
    pub token_hash: Option<Private<String>>,
    /// `overlayToken`.
    #[serde(rename = "overlayToken", skip_serializing_if = "Option::is_none")]
    pub overlay_token: Option<Private<DuelWidgetOverlayTokenContent>>,
    /// `dueAt`.
    #[serde(rename = "dueAt", skip_serializing_if = "Option::is_none")]
    pub due_at: Option<JsNumber>,
    /// `leaseUntil`.
    #[serde(rename = "leaseUntil", skip_serializing_if = "Option::is_none")]
    pub lease_until: Option<JsNumber>,
    /// `statsRevision`.
    #[serde(rename = "statsRevision", skip_serializing_if = "Option::is_none")]
    pub stats_revision: Option<JsNumber>,
    /// `languageConfigured`.
    #[serde(rename = "languageConfigured", skip_serializing_if = "Option::is_none")]
    pub language_configured: Option<bool>,
    /// `receipts`.
    #[serde(rename = "receipts", skip_serializing_if = "Option::is_none")]
    pub receipts: Option<Vec<Option<NewDuelWidgetReceiptsEntry>>>,
}
impl NewDuelWidget {
    /// Input before defaults.
    pub fn to_document(&self) -> Result<Document, ModelError> {
        Ok(bson::serialize_to_document(self)?)
    }
    /// Validated insert.
    pub fn prepare(&self, ctx: &mut WriteContext) -> Result<PreparedInsert, ModelError> {
        INFO.prepare_create(&self.to_document()?, ctx)
    }
}
