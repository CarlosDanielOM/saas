//! `widget_channels`.
//! Reference: widgets/service.ts:16-18. No timestamps, __v or hooks; overlayToken hidden.
//! Writers checked: widgets/service.ts:30 (load/create),81 (execute),116 (event effects),
//! 125 (savePoll),155,171 (advance),189 (overlayTokenStore.save).
//! Routes widgets.route.ts pass bodies to execute/updateOverlayToken; execute uses domain
//! object/config/layout/sequence/integer/text and eventSettings validators; token helper checks
//! rotate/version and generates encrypted tokens. Events validate through event-model.ts.
//! No unchecked client-fed paths, document saves or runValidators. Poll patches are server-built.
//! Mixed state/eventSettings/overlayToken stay raw, private (poll errors and encrypted secrets).
//! No schema size/depth validator; routes use Express default 100 KiB JSON limit, no explicit
//! depth limit; MongoDB has a 16 MiB document ceiling. No additional raw-field limits.
//! Legacy: missing eventReceipts/eventSettings/overlayToken; null tokenHash/dueAt; revision int32,
//! receipt times double. Server-only null/removal of READ_NEEDS paths is refused.

use crate::decode::decode_boxed;
use crate::{ClientNulls, CollectionInfo, Hooks, IndexSpec, ModelError, Private, ReadNeed, Rule};
use bson::{Bson, Document};
use dima_store::mongo::schema::{DefaultValue as D, Field, Schema};
use dima_store::mongo::{WriteContext, id::IdType, insert::PreparedInsert, number::JsNumber};
use serde::{Deserialize, Serialize};
/// Raw `state`; reference has no size/depth validator.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(transparent)]
pub struct WidgetChannelStateContent(pub Bson);
/// Raw `overlayToken`; reference has no size/depth validator.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(transparent)]
pub struct WidgetChannelOverlayTokenContent(pub Bson);
static SCHEMA_RECEIPTS: Schema = Schema::subdocument(&[
    Field::string("key"),
    Field::string("fingerprint"),
    Field::number("at"),
])
.no_id();
/// Stored and input `receipts` entry.
#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct WidgetChannelReceiptsEntry {
    /// `key`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub key: Option<String>,
    /// `fingerprint`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fingerprint: Option<String>,
    /// `at`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub at: Option<JsNumber>,
}
/// Raw `eventSettings`; reference has no size/depth validator.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(transparent)]
pub struct WidgetChannelEventSettingsContent(pub Bson);
static SCHEMA_EVENTRECEIPTS: Schema =
    Schema::subdocument(&[Field::string("key"), Field::number("at")]).no_id();
/// Stored and input `eventReceipts` entry.
#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct WidgetChannelEventReceiptsEntry {
    /// `key`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub key: Option<String>,
    /// `at`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub at: Option<JsNumber>,
}
/// Collection name.
pub const COLLECTION: &str = "widget_channels";
/// Frozen schema.
pub static SCHEMA: Schema = Schema::new(&[
    Field::string("_id"),
    Field::number("revision"),
    Field::mixed("state"),
    Field::string("tokenHash").default(D::Null),
    Field::mixed("overlayToken"),
    Field::number("dueAt").default(D::Null),
    Field::document_array("receipts", &SCHEMA_RECEIPTS).default(D::EmptyArray),
    Field::mixed("eventSettings"),
    Field::document_array("eventReceipts", &SCHEMA_EVENTRECEIPTS).default(D::EmptyArray),
])
.declared_id()
.no_version_key();
/// Hidden paths.
pub const HIDDEN: &[&str] = &["overlayToken"];
/// Private paths.
pub const PRIVATE: &[&str] = &["state", "tokenHash", "overlayToken", "eventSettings"];
/// Declared indexes; best effort (identity uses built-in `_id_`).
pub const INDEXES: &[IndexSpec] = &[IndexSpec::on(&[("dueAt", 1)])];
/// Validators.
pub const RULES: &[Rule] = &[Rule::required("revision"), Rule::required("state")];
/// Read constraints.
pub const READ_NEEDS: &[ReadNeed] = &[
    ReadNeed::value("_id"),
    ReadNeed::value("revision"),
    ReadNeed::not_null("receipts"),
    ReadNeed::not_null("eventReceipts"),
];
/// Registry entry.
pub static INFO: CollectionInfo = CollectionInfo {
    name: COLLECTION,
    model: "WidgetChannel",
    source: "dimabot/src/widgets/service.ts",
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
    decode: decode_boxed::<WidgetChannel>,
};
/// Stored document.
#[derive(Clone, Debug, Deserialize)]
pub struct WidgetChannel {
    /// `_id`.
    #[serde(rename = "_id")]
    pub id: String,
    /// `revision`.
    #[serde(rename = "revision")]
    pub revision: JsNumber,
    /// `state`.
    #[serde(rename = "state", default)]
    pub state: Option<Private<WidgetChannelStateContent>>,
    /// `tokenHash`.
    #[serde(rename = "tokenHash", default)]
    pub token_hash: Option<Private<String>>,
    /// `overlayToken`.
    #[serde(rename = "overlayToken", default)]
    pub overlay_token: Option<Private<WidgetChannelOverlayTokenContent>>,
    /// `dueAt`.
    #[serde(rename = "dueAt", default)]
    pub due_at: Option<JsNumber>,
    /// `receipts`.
    #[serde(rename = "receipts", default)]
    pub receipts: Vec<Option<WidgetChannelReceiptsEntry>>,
    /// `eventSettings`.
    #[serde(rename = "eventSettings", default)]
    pub event_settings: Option<Private<WidgetChannelEventSettingsContent>>,
    /// `eventReceipts`.
    #[serde(rename = "eventReceipts", default)]
    pub event_receipts: Vec<Option<WidgetChannelEventReceiptsEntry>>,
}
/// Typed insert.
#[derive(Clone, Debug, Serialize)]
pub struct NewWidgetChannel {
    /// `_id`.
    #[serde(rename = "_id")]
    pub id: String,
    /// `revision`.
    #[serde(rename = "revision")]
    pub revision: JsNumber,
    /// `state`.
    #[serde(rename = "state")]
    pub state: Private<WidgetChannelStateContent>,
    /// `tokenHash`.
    #[serde(rename = "tokenHash", skip_serializing_if = "Option::is_none")]
    pub token_hash: Option<Private<String>>,
    /// `overlayToken`.
    #[serde(rename = "overlayToken", skip_serializing_if = "Option::is_none")]
    pub overlay_token: Option<Private<WidgetChannelOverlayTokenContent>>,
    /// `dueAt`.
    #[serde(rename = "dueAt", skip_serializing_if = "Option::is_none")]
    pub due_at: Option<JsNumber>,
    /// `receipts`.
    #[serde(rename = "receipts", skip_serializing_if = "Option::is_none")]
    pub receipts: Option<Vec<Option<WidgetChannelReceiptsEntry>>>,
    /// `eventSettings`.
    #[serde(rename = "eventSettings", skip_serializing_if = "Option::is_none")]
    pub event_settings: Option<Private<WidgetChannelEventSettingsContent>>,
    /// `eventReceipts`.
    #[serde(rename = "eventReceipts", skip_serializing_if = "Option::is_none")]
    pub event_receipts: Option<Vec<Option<WidgetChannelEventReceiptsEntry>>>,
}
impl NewWidgetChannel {
    /// Input before defaults.
    pub fn to_document(&self) -> Result<Document, ModelError> {
        Ok(bson::serialize_to_document(self)?)
    }
    /// Validated insert.
    pub fn prepare(&self, ctx: &mut WriteContext) -> Result<PreparedInsert, ModelError> {
        INFO.prepare_create(&self.to_document()?, ctx)
    }
}
