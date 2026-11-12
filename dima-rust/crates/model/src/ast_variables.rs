//! `astvariables`: variables the command language keeps per channel, scope and user
//! (`$(var ...)` in command text).
//!
//! Reference: `dimabot/src/schemas/ast_variables.schema.ts`. Camel-case timestamps, `__v`, no
//! hooks. Two unique indexes (by user id and by user login within a scope). The reference writes
//! it with upserts only; note that `userId` and `userLogin` default to `''` and are required, so
//! `create` without them fails validation, as it does in Mongoose.
//!
//! Intended difference (`crate::shape`): the write helpers refuse a value of the wrong BSON type,
//! and `null` or a removal where [`READ_NEEDS`] says the read type has none; the census of the
//! production copy shows none stored there, so Mongoose's acceptance of them is not reproduced.

use crate::collection::{CollectionInfo, Hooks};
use crate::decode::decode_boxed;
use crate::error::ModelError;
use crate::index::IndexSpec;
use crate::shape::ReadNeed;
use crate::validation::Rule;
use crate::values::StringMap;
use bson::Document;
use bson::oid::ObjectId;
use dima_store::mongo::WriteContext;
use dima_store::mongo::date::JsDate;
use dima_store::mongo::id::IdType;
use dima_store::mongo::insert::PreparedInsert;
use dima_store::mongo::schema::{DefaultValue as D, Field, MapOf, Schema, Timestamps, ValueType};
use serde::{Deserialize, Serialize};

/// The collection name.
pub const COLLECTION: &str = "astvariables";

/// The schema, field by field as `ast_variables.schema.ts` declares it.
pub static SCHEMA: Schema = Schema::new(&[
    Field::string("channelID"),
    Field::string("scopeType").default(D::Str("command")),
    Field::string("scopeName").default(D::Str("default")),
    Field::string("userId").default(D::Str("")),
    Field::string("userLogin").default(D::Str("")),
    Field::map("variables", MapOf::Values(ValueType::String)).default(D::EmptyDocument),
])
.timestamps(Timestamps::CAMEL);

/// The `select: false` paths (none).
pub const HIDDEN: &[&str] = &[];

/// The declared indexes.
pub const INDEXES: &[IndexSpec] = &[
    IndexSpec::on(&[("channelID", 1)]),
    IndexSpec::on(&[
        ("channelID", 1),
        ("scopeType", 1),
        ("scopeName", 1),
        ("userId", 1),
    ])
    .unique(),
    IndexSpec::on(&[
        ("channelID", 1),
        ("scopeType", 1),
        ("scopeName", 1),
        ("userLogin", 1),
    ])
    .unique(),
];

/// The validators, in schema path order.
pub const RULES: &[Rule] = &[
    Rule::required("channelID"),
    Rule::required("scopeType"),
    Rule::required("scopeName"),
    Rule::required("userId"),
    Rule::required("userLogin"),
];

/// What the read type cannot decode (`crate::shape`): the write helpers refuse it.
pub const READ_NEEDS: &[ReadNeed] = &[
    ReadNeed::value("channelID"),
    ReadNeed::not_null("scopeType"),
    ReadNeed::not_null("scopeName"),
    ReadNeed::not_null("userId"),
    ReadNeed::not_null("userLogin"),
];

/// The registry entry.
pub static INFO: CollectionInfo = CollectionInfo {
    name: COLLECTION,
    model: "AstVariables",
    source: "dimabot/src/schemas/ast_variables.schema.ts",
    schema: &SCHEMA,
    id_type: IdType::ObjectId,
    hidden: HIDDEN,
    indexes: INDEXES,
    rules: RULES,
    read_needs: READ_NEEDS,
    hooks: Hooks::None,
    initialised_at_startup: true,
    private: &[],
    decode: decode_boxed::<AstVariables>,
};

/// One stored variable scope.
#[derive(Clone, Debug, Deserialize)]
pub struct AstVariables {
    /// `_id`.
    #[serde(rename = "_id")]
    pub id: ObjectId,
    /// The channel id.
    #[serde(rename = "channelID")]
    pub channel_id: String,
    /// The scope kind (`command`, `global`...).
    #[serde(default = "command", rename = "scopeType")]
    pub scope_type: String,
    /// The scope name.
    #[serde(default = "default_scope", rename = "scopeName")]
    pub scope_name: String,
    /// The user id (`''` for channel-wide variables).
    #[serde(default, rename = "userId")]
    pub user_id: String,
    /// The user login (`''` for channel-wide variables).
    #[serde(default, rename = "userLogin")]
    pub user_login: String,
    /// The variables.
    #[serde(default)]
    pub variables: StringMap,
    /// Creation time (absent on documents older than the timestamps).
    #[serde(default, rename = "createdAt")]
    pub created_at: Option<JsDate>,
    /// Last update time.
    #[serde(default, rename = "updatedAt")]
    pub updated_at: Option<JsDate>,
}

fn command() -> String {
    "command".to_owned()
}

fn default_scope() -> String {
    "default".to_owned()
}

/// A new variable scope (`AstVariables.create`).
#[derive(Clone, Debug, Serialize)]
pub struct NewAstVariables {
    /// The channel id.
    #[serde(rename = "channelID")]
    pub channel_id: String,
    /// The scope kind (default `command`).
    #[serde(rename = "scopeType", skip_serializing_if = "Option::is_none")]
    pub scope_type: Option<String>,
    /// The scope name (default `default`).
    #[serde(rename = "scopeName", skip_serializing_if = "Option::is_none")]
    pub scope_name: Option<String>,
    /// The user id (required non-empty by the schema).
    #[serde(rename = "userId", skip_serializing_if = "Option::is_none")]
    pub user_id: Option<String>,
    /// The user login (required non-empty by the schema).
    #[serde(rename = "userLogin", skip_serializing_if = "Option::is_none")]
    pub user_login: Option<String>,
    /// The variables.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub variables: Option<Document>,
}

impl NewAstVariables {
    /// A scope of `channel_id` with every other field defaulted.
    pub fn new(channel_id: impl Into<String>) -> Self {
        Self {
            channel_id: channel_id.into(),
            scope_type: None,
            scope_name: None,
            user_id: None,
            user_login: None,
            variables: None,
        }
    }

    /// The values given to the constructor (before defaults).
    pub fn to_document(&self) -> Result<Document, ModelError> {
        Ok(bson::serialize_to_document(self)?)
    }

    /// The insert Mongoose sends, refused like Mongoose's validation would refuse it.
    pub fn prepare(&self, ctx: &mut WriteContext) -> Result<PreparedInsert, ModelError> {
        INFO.prepare_create(&self.to_document()?, ctx)
    }
}
