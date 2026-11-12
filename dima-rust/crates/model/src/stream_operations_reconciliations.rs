//! `stream_operations_reconciliations`: reference `dimabot/src/schemas/stream_operations_receipt.schema.ts`.
//! Key: _id = channelID. Enqueue repeats increment revision, coalescing pending work.
//! Acknowledgement matches _id, revision, leaseToken and unexpired leaseUntil; a newer revision
//! cannot be acknowledged by an older attempt. Receipt identity is reauth:<channelID>:<revision>.
//! Writers checked: domain_events/stream_operations_events.ts:180-186,252-280;
//! server/routes/auth.route.ts:434-435 only passes the authenticated channel identity.
//! Client-fed writes: none; revision, flags, dates, lease and errors are server-built.
//! No saves, hooks, timestamps, __v or runValidators. Legacy: leaseToken/leaseUntil/lastError
//! are absent after completion; revision is BSON int32, handled by JsNumber without widening.
//! Lease tokens and error text are private. Server-only READ_NEEDS nulls/removals refused.

use crate::Private;
use crate::decode::decode_boxed;
use crate::{ClientNulls, CollectionInfo, Hooks, IndexSpec, ModelError, ReadNeed, Rule};
use bson::Document;
use dima_store::mongo::number::JsNumber;
use dima_store::mongo::schema::{DefaultValue as D, Field, Schema};
use dima_store::mongo::{WriteContext, date::JsDate, id::IdType, insert::PreparedInsert};
use serde::{Deserialize, Serialize};
/// Collection name.
pub const COLLECTION: &str = "stream_operations_reconciliations";
/// Frozen schema.
pub static SCHEMA: Schema = Schema::new(&[
    Field::string("_id"),
    Field::number("revision").default(D::Int(0)),
    Field::boolean("pending").default(D::Bool(true)),
    Field::date("nextAttemptAt"),
    Field::string("leaseToken"),
    Field::date("leaseUntil"),
    Field::string("lastError"),
])
.declared_id()
.no_version_key();
/// Hidden fields.
pub const HIDDEN: &[&str] = &[];
/// Private fields.
pub const PRIVATE: &[&str] = &["leaseToken", "lastError"];
/// Declared indexes.
pub const INDEXES: &[IndexSpec] = &[IndexSpec::on(&[
    ("pending", 1),
    ("nextAttemptAt", 1),
    ("leaseUntil", 1),
])];
/// Validators.
pub const RULES: &[Rule] = &[
    Rule::required("_id"),
    Rule::required("revision"),
    Rule::required("pending"),
    Rule::required("nextAttemptAt"),
];
fn default_revision() -> JsNumber {
    JsNumber(0.0)
}
fn default_pending() -> bool {
    true
}
/// Read constraints.
pub const READ_NEEDS: &[ReadNeed] = &[
    ReadNeed::value("_id"),
    ReadNeed::not_null("revision"),
    ReadNeed::not_null("pending"),
    ReadNeed::value("nextAttemptAt"),
];
/// Registry entry.
pub static INFO: CollectionInfo = CollectionInfo {
    name: COLLECTION,
    model: "stream_operations_reconciliation",
    source: "dimabot/src/schemas/stream_operations_receipt.schema.ts",
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
    decode: decode_boxed::<StreamOperationsReconciliation>,
};
/// Hydrated document.
#[derive(Clone, Debug, Deserialize)]
pub struct StreamOperationsReconciliation {
    /// `_id`.
    #[serde(rename = "_id")]
    pub id: String,
    /// `revision`.
    #[serde(rename = "revision", default = "default_revision")]
    pub revision: JsNumber,
    /// `pending`.
    #[serde(rename = "pending", default = "default_pending")]
    pub pending: bool,
    /// `nextAttemptAt`.
    #[serde(rename = "nextAttemptAt")]
    pub next_attempt_at: JsDate,
    /// `leaseToken`.
    #[serde(rename = "leaseToken", default)]
    pub lease_token: Option<Private<String>>,
    /// `leaseUntil`.
    #[serde(rename = "leaseUntil", default)]
    pub lease_until: Option<JsDate>,
    /// `lastError`.
    #[serde(rename = "lastError", default)]
    pub last_error: Option<Private<String>>,
}
/// Typed insert.
#[derive(Clone, Debug, Serialize)]
pub struct NewStreamOperationsReconciliation {
    /// `_id`.
    #[serde(rename = "_id")]
    pub id: String,
    /// `revision`.
    #[serde(rename = "revision")]
    pub revision: JsNumber,
    /// `pending`.
    #[serde(rename = "pending")]
    pub pending: bool,
    /// `nextAttemptAt`.
    #[serde(rename = "nextAttemptAt")]
    pub next_attempt_at: JsDate,
    /// `leaseToken`.
    #[serde(rename = "leaseToken", skip_serializing_if = "Option::is_none")]
    pub lease_token: Option<Private<String>>,
    /// `leaseUntil`.
    #[serde(rename = "leaseUntil", skip_serializing_if = "Option::is_none")]
    pub lease_until: Option<JsDate>,
    /// `lastError`.
    #[serde(rename = "lastError", skip_serializing_if = "Option::is_none")]
    pub last_error: Option<Private<String>>,
}
impl NewStreamOperationsReconciliation {
    /// Input before defaults.
    pub fn to_document(&self) -> Result<Document, ModelError> {
        Ok(bson::serialize_to_document(self)?)
    }
    /// Validated insert.
    pub fn prepare(&self, ctx: &mut WriteContext) -> Result<PreparedInsert, ModelError> {
        INFO.prepare_create(&self.to_document()?, ctx)
    }
}
