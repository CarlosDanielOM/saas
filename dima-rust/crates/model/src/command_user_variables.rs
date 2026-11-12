//! `commanduservariables`: per-user variables of one command.
//!
//! Reference: `dimabot/src/schemas/command_user_variables.schema.ts`. Camel-case timestamps,
//! `__v`, no hooks. Unique `{commandId, userId}`. Empty in the production copy.

use crate::collection::{CollectionInfo, Hooks};
use crate::decode::decode;
use crate::error::ModelError;
use crate::index::IndexSpec;
use crate::validation::Rule;
use crate::values::StringMap;
use bson::oid::ObjectId;
use bson::{Document, RawDocument};
use dima_store::mongo::WriteContext;
use dima_store::mongo::date::JsDate;
use dima_store::mongo::id::IdType;
use dima_store::mongo::insert::PreparedInsert;
use dima_store::mongo::schema::{DefaultValue as D, Field, MapOf, Schema, Timestamps, ValueType};
use serde::{Deserialize, Serialize};

/// The collection name.
pub const COLLECTION: &str = "commanduservariables";

/// The schema, field by field as `command_user_variables.schema.ts` declares it.
pub static SCHEMA: Schema = Schema::new(&[
    Field::object_id("commandId"),
    Field::string("channelID"),
    Field::string("userId"),
    Field::map("variables", MapOf::Values(ValueType::String)).default(D::EmptyDocument),
])
.timestamps(Timestamps::CAMEL);

/// The `select: false` paths (none).
pub const HIDDEN: &[&str] = &[];

/// The declared indexes.
pub const INDEXES: &[IndexSpec] = &[
    IndexSpec::on(&[("channelID", 1)]),
    IndexSpec::on(&[("userId", 1)]),
    IndexSpec::on(&[("commandId", 1), ("userId", 1)]).unique(),
];

/// The validators, in schema path order.
pub const RULES: &[Rule] = &[
    Rule::required("commandId"),
    Rule::required("channelID"),
    Rule::required("userId"),
];

/// The registry entry.
pub static INFO: CollectionInfo = CollectionInfo {
    name: COLLECTION,
    model: "CommandUserVariables",
    source: "dimabot/src/schemas/command_user_variables.schema.ts",
    schema: &SCHEMA,
    id_type: IdType::ObjectId,
    hidden: HIDDEN,
    indexes: INDEXES,
    rules: RULES,
    hooks: Hooks::None,
    decode: |raw: &RawDocument| decode::<CommandUserVariables>(raw).map(drop),
};

/// One user's variables of one command.
#[derive(Clone, Debug, Deserialize)]
pub struct CommandUserVariables {
    /// `_id`.
    #[serde(rename = "_id")]
    pub id: ObjectId,
    /// The command (`commands._id`).
    #[serde(rename = "commandId")]
    pub command_id: ObjectId,
    /// The channel id.
    #[serde(rename = "channelID")]
    pub channel_id: String,
    /// The user id.
    #[serde(rename = "userId")]
    pub user_id: String,
    /// The variables.
    #[serde(default)]
    pub variables: StringMap,
    /// Creation time.
    #[serde(default, rename = "createdAt")]
    pub created_at: Option<JsDate>,
    /// Last update time.
    #[serde(default, rename = "updatedAt")]
    pub updated_at: Option<JsDate>,
}

/// New per-user variables of a command.
#[derive(Clone, Debug, Serialize)]
pub struct NewCommandUserVariables {
    /// The command.
    #[serde(rename = "commandId")]
    pub command_id: ObjectId,
    /// The channel id.
    #[serde(rename = "channelID")]
    pub channel_id: String,
    /// The user id.
    #[serde(rename = "userId")]
    pub user_id: String,
    /// The variables.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub variables: Option<Document>,
}

impl NewCommandUserVariables {
    /// The values given to the constructor (before defaults).
    pub fn to_document(&self) -> Result<Document, ModelError> {
        Ok(bson::serialize_to_document(self)?)
    }

    /// The insert Mongoose sends, refused like Mongoose's validation would refuse it.
    pub fn prepare(&self, ctx: &mut WriteContext) -> Result<PreparedInsert, ModelError> {
        INFO.prepare_create(&self.to_document()?, ctx)
    }
}
