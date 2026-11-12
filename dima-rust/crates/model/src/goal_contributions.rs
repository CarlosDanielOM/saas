//! `goal_contributions`.
//! Reference: goals/service.ts:23-26. No timestamps, __v, hooks or hidden paths.
//! Key: sha256(goal.id + ':' + event.eventKey), looked up by _id.
//! Repeat rule: updateOne $setOnInsert upsert; duplicate _id is accepted only if channel,
//! goal, occurredAt and amount match. Both applyGoalEvent and applyCustomGoalEvent share it.
//! Writers checked: goals/service.ts:41 (insertContribution),155 (deleteMany),209,246 (callers).
//! Event handlers call those functions; custom itemKey/quantity use goalItemKey/goalInteger;
//! no unchecked client-fed writes, saves or runValidators. TTL only for rolling goals.
//! Legacy: expiresAt absent for nonrolling goals; amount int32 and occurredAt double.
//! No extra unique index: MongoDB's built-in unique _id supplies the counting fence.
//! Server-only null/removal of READ_NEEDS paths is refused.

use crate::decode::decode_boxed;
use crate::{ClientNulls, CollectionInfo, Hooks, IndexSpec, ModelError, ReadNeed, Rule};
use bson::Document;
use dima_store::mongo::schema::{Field, Schema};
use dima_store::mongo::{
    WriteContext, date::JsDate, id::IdType, insert::PreparedInsert, number::JsNumber,
};
use serde::{Deserialize, Serialize};
/// Collection name.
pub const COLLECTION: &str = "goal_contributions";
/// Frozen schema.
pub static SCHEMA: Schema = Schema::new(&[
    Field::string("_id"),
    Field::string("channel"),
    Field::string("goal"),
    Field::number("occurredAt"),
    Field::number("amount"),
    Field::date("expiresAt"),
])
.declared_id()
.no_version_key();
/// Hidden paths.
pub const HIDDEN: &[&str] = &[];
/// Private paths.
pub const PRIVATE: &[&str] = &[];
/// Declared indexes; best effort (identity uses built-in `_id_`).
pub const INDEXES: &[IndexSpec] = &[
    IndexSpec::on(&[("channel", 1), ("goal", 1), ("occurredAt", 1)]),
    IndexSpec::on(&[("expiresAt", 1)]).expire_after_seconds(0),
];
/// Validators.
pub const RULES: &[Rule] = &[];
/// Read constraints.
pub const READ_NEEDS: &[ReadNeed] = &[
    ReadNeed::value("_id"),
    ReadNeed::value("channel"),
    ReadNeed::value("goal"),
    ReadNeed::value("occurredAt"),
    ReadNeed::value("amount"),
];
/// Registry entry.
pub static INFO: CollectionInfo = CollectionInfo {
    name: COLLECTION,
    model: "GoalContribution",
    source: "dimabot/src/goals/service.ts",
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
    decode: decode_boxed::<GoalContribution>,
};
/// Stored document.
#[derive(Clone, Debug, Deserialize)]
pub struct GoalContribution {
    /// `_id`.
    #[serde(rename = "_id")]
    pub id: String,
    /// `channel`.
    #[serde(rename = "channel")]
    pub channel: String,
    /// `goal`.
    #[serde(rename = "goal")]
    pub goal: String,
    /// `occurredAt`.
    #[serde(rename = "occurredAt")]
    pub occurred_at: JsNumber,
    /// `amount`.
    #[serde(rename = "amount")]
    pub amount: JsNumber,
    /// `expiresAt`.
    #[serde(rename = "expiresAt", default)]
    pub expires_at: Option<JsDate>,
}
/// Typed insert.
#[derive(Clone, Debug, Serialize)]
pub struct NewGoalContribution {
    /// `_id`.
    #[serde(rename = "_id")]
    pub id: String,
    /// `channel`.
    #[serde(rename = "channel")]
    pub channel: String,
    /// `goal`.
    #[serde(rename = "goal")]
    pub goal: String,
    /// `occurredAt`.
    #[serde(rename = "occurredAt")]
    pub occurred_at: JsNumber,
    /// `amount`.
    #[serde(rename = "amount")]
    pub amount: JsNumber,
    /// `expiresAt`.
    #[serde(rename = "expiresAt", skip_serializing_if = "Option::is_none")]
    pub expires_at: Option<JsDate>,
}
impl NewGoalContribution {
    /// Input before defaults.
    pub fn to_document(&self) -> Result<Document, ModelError> {
        Ok(bson::serialize_to_document(self)?)
    }
    /// Validated insert.
    pub fn prepare(&self, ctx: &mut WriteContext) -> Result<PreparedInsert, ModelError> {
        INFO.prepare_create(&self.to_document()?, ctx)
    }
}
