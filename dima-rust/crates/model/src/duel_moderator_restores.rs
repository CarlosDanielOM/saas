//! `duel_moderator_restores`.
//! Reference: duel/completion.ts:19-21; no timestamps, __v, hooks, hidden fields or TTL.
//! Key: duel run.id as string _id (not channel+user); each row restores one moderator role.
//! Repeat rule: timeoutLoser (:40) creates before demotion; duplicate _id throws E11000,
//! not swallowed there. settleDuels (:93-94) has already persisted timeoutAttempted and
//! reports timeoutError; it does not repeat demotion or timeout. The original row survives.
//! An unfinished restore never expires: due rows are claimed with a 30-second lease (:111).
//! A crash leaves the row reclaimable after lease expiry; provider failures reschedule dueAt
//! 30 seconds later and reset leaseUntil (:121). Retries have no cap. If already moderator,
//! or after successful addModerator, delete the row (:116,119); response loss is recovered
//! by checking current moderator membership on the next attempt. Different runs have distinct
//! keys even for the same channel/user. Built-in unique _id is the duplicate fence; dueAt index
//! is nonunique/best effort. No extra unique index or model.init wait.
//! Writers checked: completion.ts:40 (create),42,46,51 (expedite),54 (post-timeout deadline),
//! 111 (lease),116,119 (delete),121 (retry). All values come from run/server/provider data.
//! Chat command validates participant logins; userId is resolved by getTwitchUserByLogin.
//! Dashboard/overlay handlers never create or mutate restores; no site-agent writer.
//! No unchecked client-fed values, saves or runValidators. User identity is Private.
//! Census empty: no legacy documents to sample. Epoch dueAt and active leaseUntil use Node
//! doubles; idle leaseUntil defaults to int32 zero. Server-only null/removal of READ_NEEDS
//! paths is refused. Durable retries and duplicate-create errors are preserved quirks.

use crate::decode::decode_boxed;
use crate::{ClientNulls, CollectionInfo, Hooks, IndexSpec, ModelError, Private, ReadNeed, Rule};
use bson::Document;
use dima_store::mongo::schema::{DefaultValue as D, Field, Schema};
use dima_store::mongo::{WriteContext, id::IdType, insert::PreparedInsert, number::JsNumber};
use serde::{Deserialize, Serialize};
fn default_duel_moderator_restore_lease_until() -> JsNumber {
    JsNumber(0.0)
}
/// Collection name.
pub const COLLECTION: &str = "duel_moderator_restores";
/// Frozen schema.
pub static SCHEMA: Schema = Schema::new(&[
    Field::string("_id"),
    Field::string("channel"),
    Field::string("userId"),
    Field::number("dueAt"),
    Field::number("leaseUntil").default(D::Int(0)),
])
.declared_id()
.no_version_key();
/// Hidden paths.
pub const HIDDEN: &[&str] = &[];
/// Private paths.
pub const PRIVATE: &[&str] = &["userId"];
/// Declared indexes.
pub const INDEXES: &[IndexSpec] = &[IndexSpec::on(&[("dueAt", 1)])];
/// Validators.
pub const RULES: &[Rule] = &[];
/// Read constraints.
pub const READ_NEEDS: &[ReadNeed] = &[
    ReadNeed::value("_id"),
    ReadNeed::value("channel"),
    ReadNeed::value("userId"),
    ReadNeed::value("dueAt"),
    ReadNeed::not_null("leaseUntil"),
];
/// Registry entry.
pub static INFO: CollectionInfo = CollectionInfo {
    name: COLLECTION,
    model: "DuelModeratorRestore",
    source: "dimabot/src/duel/completion.ts",
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
    decode: decode_boxed::<DuelModeratorRestore>,
};
/// Stored document.
#[derive(Clone, Debug, Deserialize)]
pub struct DuelModeratorRestore {
    /// `_id`.
    #[serde(rename = "_id")]
    pub id: String,
    /// `channel`.
    #[serde(rename = "channel")]
    pub channel: String,
    /// `userId`.
    #[serde(rename = "userId")]
    pub user_id: Private<String>,
    /// `dueAt`.
    #[serde(rename = "dueAt")]
    pub due_at: JsNumber,
    /// `leaseUntil`.
    #[serde(
        rename = "leaseUntil",
        default = "default_duel_moderator_restore_lease_until"
    )]
    pub lease_until: JsNumber,
}
/// Typed insert.
#[derive(Clone, Debug, Serialize)]
pub struct NewDuelModeratorRestore {
    /// `_id`.
    #[serde(rename = "_id")]
    pub id: String,
    /// `channel`.
    #[serde(rename = "channel")]
    pub channel: String,
    /// `userId`.
    #[serde(rename = "userId")]
    pub user_id: Private<String>,
    /// `dueAt`.
    #[serde(rename = "dueAt")]
    pub due_at: JsNumber,
    /// `leaseUntil`.
    #[serde(rename = "leaseUntil", skip_serializing_if = "Option::is_none")]
    pub lease_until: Option<JsNumber>,
}
impl NewDuelModeratorRestore {
    /// Input before defaults.
    pub fn to_document(&self) -> Result<Document, ModelError> {
        Ok(bson::serialize_to_document(self)?)
    }
    /// Validated insert.
    pub fn prepare(&self, ctx: &mut WriteContext) -> Result<PreparedInsert, ModelError> {
        INFO.prepare_create(&self.to_document()?, ctx)
    }
}
