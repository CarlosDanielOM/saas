//! `roulette_channels`.
//! Reference: roulette/service.ts:12-19; no timestamps, __v or hooks; overlayToken hidden.
//! Writers checked: roulette/service.ts:31 (load/create),119 (execute),130 (snapshot),141
//! (overlayTokenStore.save); roulette/actions.ts:14 (claim),49 (finish); and native
//! workers/roulette_completion.rs:482-543 (completion CAS and default upsert).
//! Routes roulette.route.ts:32-72 and site_agent/tools/write/settings/roulettes.ts:56 use
//! execute; AST roulette.functions.ts:39 builds actor from server context. model.ts checks
//! configuration, item/import values, colors, timings and automation settings before writes.
//! No unchecked client-fed typed paths, document saves or runValidators. Actor argument is only
//! length-checked by execute (:87); Mixed actor retains null/other legacy values without coercion.
//! The named raw state, actor and encrypted token types retain arbitrary BSON. execute limits
//! JSON.stringify(state) to 4 MiB; routes have a 4 MiB JSON parser; no explicit depth validator.
//! Schema has no additional size/depth limit (MongoDB's 16 MiB ceiling applies). Source/labels
//! and raw payloads are private. Server-only null/removal of READ_NEEDS paths is refused.
//! Native differs in scope: it only writes state/dueAt and increments revision; it never writes
//! winner actions, receipts or tokens. Missing-channel initialization uses $setOnInsert upsert,
//! where TypeScript load uses create with Mongoose defaults. Native explicitly normalizes Mixed
//! state via bson_compat::normalize_document, uses js_number for dueAt and an int32 revision inc.
//! At epoch magnitudes state.draw.completedAt, state.history[].completedAt, state.hideAt and
//! root dueAt are doubles; item multiplier remains int32. TypeScript applies Node serialization
//! to the same values. native_numbers tests preserve these exact stored widths, including nulls.
//! Legacy: absent encrypted token, nullable tokenHash/dueAt/actionDueAt; missing action actor or
//! startedAt/finishedAt on pending actions. Census revisions int32, action/receipt times doubles.
//! Both declared deadline indexes are best effort; no declared unique index or init wait.

use crate::decode::decode_boxed;
use crate::values::Nullable;
use crate::{ClientNulls, CollectionInfo, Hooks, IndexSpec, ModelError, Private, ReadNeed, Rule};
use bson::{Bson, Document};
use dima_store::mongo::schema::{DefaultValue as D, Field, Schema};
use dima_store::mongo::{WriteContext, id::IdType, insert::PreparedInsert, number::JsNumber};
use serde::{Deserialize, Serialize};
/// Raw `actions.$.actor`; limits are documented in the module header.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(transparent)]
pub struct RouletteChannelActionsEntryActorContent(pub Bson);
static SCHEMA_ACTIONS: Schema = Schema::subdocument(&[
    Field::string("drawId"),
    Field::string("rouletteId"),
    Field::string("itemId"),
    Field::string("label"),
    Field::string("source"),
    Field::number("dueAt"),
    Field::string("status"),
    Field::mixed("actor"),
    Field::number("startedAt"),
    Field::number("finishedAt"),
])
.no_id();
/// Stored `actions` entry.
#[derive(Clone, Debug, Deserialize)]
pub struct RouletteChannelActionsEntry {
    /// `actions.$.drawId`.
    #[serde(rename = "drawId")]
    pub draw_id: String,
    /// `actions.$.rouletteId`.
    #[serde(rename = "rouletteId")]
    pub roulette_id: String,
    /// `actions.$.itemId`.
    #[serde(rename = "itemId")]
    pub item_id: String,
    /// `actions.$.label`.
    #[serde(rename = "label")]
    pub label: Private<String>,
    /// `actions.$.source`.
    #[serde(rename = "source")]
    pub source: Private<String>,
    /// `actions.$.dueAt`.
    #[serde(rename = "dueAt")]
    pub due_at: JsNumber,
    /// `actions.$.status`.
    #[serde(rename = "status")]
    pub status: String,
    /// `actions.$.actor`.
    #[serde(rename = "actor", default)]
    pub actor: Option<Private<RouletteChannelActionsEntryActorContent>>,
    /// `actions.$.startedAt`.
    #[serde(rename = "startedAt", default)]
    pub started_at: Option<JsNumber>,
    /// `actions.$.finishedAt`.
    #[serde(rename = "finishedAt", default)]
    pub finished_at: Option<JsNumber>,
}
/// Input `actions` entry.
#[derive(Clone, Debug, Serialize)]
pub struct NewRouletteChannelActionsEntry {
    /// `actions.$.drawId`.
    #[serde(rename = "drawId")]
    pub draw_id: String,
    /// `actions.$.rouletteId`.
    #[serde(rename = "rouletteId")]
    pub roulette_id: String,
    /// `actions.$.itemId`.
    #[serde(rename = "itemId")]
    pub item_id: String,
    /// `actions.$.label`.
    #[serde(rename = "label")]
    pub label: Private<String>,
    /// `actions.$.source`.
    #[serde(rename = "source")]
    pub source: Private<String>,
    /// `actions.$.dueAt`.
    #[serde(rename = "dueAt")]
    pub due_at: JsNumber,
    /// `actions.$.status`.
    #[serde(rename = "status")]
    pub status: String,
    /// `actions.$.actor`.
    #[serde(rename = "actor", skip_serializing_if = "Option::is_none")]
    pub actor: Option<Private<RouletteChannelActionsEntryActorContent>>,
    /// `actions.$.startedAt`.
    #[serde(rename = "startedAt", skip_serializing_if = "Option::is_none")]
    pub started_at: Option<JsNumber>,
    /// `actions.$.finishedAt`.
    #[serde(rename = "finishedAt", skip_serializing_if = "Option::is_none")]
    pub finished_at: Option<JsNumber>,
}
/// Raw `state`; limits are documented in the module header.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(transparent)]
pub struct RouletteChannelStateContent(pub Bson);
/// Raw `overlayToken`; limits are documented in the module header.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(transparent)]
pub struct RouletteChannelOverlayTokenContent(pub Bson);
static SCHEMA_RECEIPTS: Schema = Schema::subdocument(&[
    Field::string("key"),
    Field::string("fingerprint"),
    Field::string("result"),
    Field::number("at"),
])
.no_id();
/// Stored `receipts` entry.
#[derive(Clone, Debug, Deserialize)]
pub struct RouletteChannelReceiptsEntry {
    /// `receipts.$.key`.
    #[serde(rename = "key")]
    pub key: String,
    /// `receipts.$.fingerprint`.
    #[serde(rename = "fingerprint")]
    pub fingerprint: String,
    /// `receipts.$.result`.
    #[serde(rename = "result")]
    pub result: String,
    /// `receipts.$.at`.
    #[serde(rename = "at")]
    pub at: JsNumber,
}
/// Input `receipts` entry.
#[derive(Clone, Debug, Serialize)]
pub struct NewRouletteChannelReceiptsEntry {
    /// `receipts.$.key`.
    #[serde(rename = "key")]
    pub key: String,
    /// `receipts.$.fingerprint`.
    #[serde(rename = "fingerprint")]
    pub fingerprint: String,
    /// `receipts.$.result`.
    #[serde(rename = "result")]
    pub result: String,
    /// `receipts.$.at`.
    #[serde(rename = "at")]
    pub at: JsNumber,
}

/// Collection name.
pub const COLLECTION: &str = "roulette_channels";
/// Frozen schema.
pub static SCHEMA: Schema = Schema::new(&[
    Field::document_array("actions", &SCHEMA_ACTIONS).default(D::EmptyArray),
    Field::number("actionDueAt").default(D::Null),
    Field::string("_id"),
    Field::number("revision"),
    Field::mixed("state"),
    Field::string("tokenHash").default(D::Null),
    Field::mixed("overlayToken"),
    Field::number("dueAt").default(D::Null),
    Field::document_array("receipts", &SCHEMA_RECEIPTS).default(D::EmptyArray),
])
.declared_id()
.no_version_key();
/// Hidden paths.
pub const HIDDEN: &[&str] = &["overlayToken"];
/// Private paths.
pub const PRIVATE: &[&str] = &["actions", "state", "tokenHash", "overlayToken"];
/// Declared indexes.
pub const INDEXES: &[IndexSpec] = &[
    IndexSpec::on(&[("dueAt", 1)]),
    IndexSpec::on(&[("actionDueAt", 1)]),
];
/// Validators.
pub const RULES: &[Rule] = &[Rule::required("revision"), Rule::required("state")];
/// Read constraints.
pub const READ_NEEDS: &[ReadNeed] = &[
    ReadNeed::value("_id"),
    ReadNeed::value("actions.$.drawId"),
    ReadNeed::value("actions.$.rouletteId"),
    ReadNeed::value("actions.$.itemId"),
    ReadNeed::value("actions.$.label"),
    ReadNeed::value("actions.$.source"),
    ReadNeed::value("actions.$.dueAt"),
    ReadNeed::value("actions.$.status"),
    ReadNeed::value("receipts.$.key"),
    ReadNeed::value("receipts.$.fingerprint"),
    ReadNeed::value("receipts.$.result"),
    ReadNeed::value("receipts.$.at"),
    ReadNeed::not_null("actions"),
    ReadNeed::value("revision"),
    ReadNeed::not_null("receipts"),
];
/// Registry entry.
pub static INFO: CollectionInfo = CollectionInfo {
    name: COLLECTION,
    model: "RouletteChannel",
    source: "dimabot/src/roulette/service.ts",
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
    decode: decode_boxed::<RouletteChannel>,
};
/// Stored document.
#[derive(Clone, Debug, Deserialize)]
pub struct RouletteChannel {
    /// `actions`.
    #[serde(rename = "actions", default)]
    pub actions: Private<Vec<Option<RouletteChannelActionsEntry>>>,
    /// `actionDueAt`.
    #[serde(rename = "actionDueAt", default)]
    pub action_due_at: Option<JsNumber>,
    /// `_id`.
    #[serde(rename = "_id")]
    pub id: String,
    /// `revision`.
    #[serde(rename = "revision")]
    pub revision: JsNumber,
    /// `state`.
    #[serde(rename = "state", default)]
    pub state: Option<Private<RouletteChannelStateContent>>,
    /// `tokenHash`.
    #[serde(rename = "tokenHash", default)]
    pub token_hash: Option<Private<String>>,
    /// `overlayToken`.
    #[serde(rename = "overlayToken", default)]
    pub overlay_token: Option<Private<RouletteChannelOverlayTokenContent>>,
    /// `dueAt`.
    #[serde(rename = "dueAt", default)]
    pub due_at: Option<JsNumber>,
    /// `receipts`.
    #[serde(rename = "receipts", default)]
    pub receipts: Vec<Option<RouletteChannelReceiptsEntry>>,
}
/// Typed insert.
#[derive(Clone, Debug, Serialize)]
pub struct NewRouletteChannel {
    /// `actions`.
    #[serde(rename = "actions", skip_serializing_if = "Option::is_none")]
    pub actions: Option<Private<Vec<Option<NewRouletteChannelActionsEntry>>>>,
    /// `actionDueAt`.
    #[serde(rename = "actionDueAt", skip_serializing_if = "Option::is_none")]
    pub action_due_at: Option<JsNumber>,
    /// `_id`.
    #[serde(rename = "_id")]
    pub id: String,
    /// `revision`.
    #[serde(rename = "revision")]
    pub revision: JsNumber,
    /// `state`.
    #[serde(rename = "state")]
    pub state: Private<RouletteChannelStateContent>,
    /// `tokenHash`.
    #[serde(rename = "tokenHash", skip_serializing_if = "Nullable::is_unset")]
    pub token_hash: Nullable<Private<String>>,
    /// `overlayToken`.
    #[serde(rename = "overlayToken", skip_serializing_if = "Option::is_none")]
    pub overlay_token: Option<Private<RouletteChannelOverlayTokenContent>>,
    /// `dueAt`.
    #[serde(rename = "dueAt", skip_serializing_if = "Nullable::is_unset")]
    pub due_at: Nullable<JsNumber>,
    /// `receipts`.
    #[serde(rename = "receipts", skip_serializing_if = "Option::is_none")]
    pub receipts: Option<Vec<Option<NewRouletteChannelReceiptsEntry>>>,
}
impl NewRouletteChannel {
    /// Input before defaults.
    pub fn to_document(&self) -> Result<Document, ModelError> {
        Ok(bson::serialize_to_document(self)?)
    }
    /// Validated insert.
    pub fn prepare(&self, ctx: &mut WriteContext) -> Result<PreparedInsert, ModelError> {
        INFO.prepare_create(&self.to_document()?, ctx)
    }
}
