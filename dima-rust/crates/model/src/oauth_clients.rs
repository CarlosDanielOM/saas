//! `oauth_clients`: the OAuth applications allowed to ask for desktop tokens (today only the
//! desktop beta client, upserted at startup).
//!
//! Reference: `dimabot/src/schemas/oauth_client.schema.ts` (model `OAuthClient`). Camel-case
//! timestamps, `__v`, no hooks. Unique `client_id` (field level). The API awaits
//! `OAuthClient.init()` with the three other OAuth models before it starts
//! (`server/oauth/service.ts:27`, `server/index.ts:39`), so every index of the four OAuth
//! collections is required ([`crate::startup_policy`]). Writes: the startup upsert with
//! `$setOnInsert` and the `$addToSet` of new scopes (`service.ts:28-35`).
//!
//! Client-fed writes (`null` from a request body): none: the OAuth service writes server values
//! only.
//!
//! Intended difference (`crate::shape`): the write helpers refuse a value of the wrong BSON type,
//! and `null` or a removal where [`READ_NEEDS`] says the read type has none; the census of the
//! production copy shows none stored there, so Mongoose's acceptance of them is not reproduced.

use crate::collection::{ClientNulls, CollectionInfo, Hooks};
use crate::decode::decode_boxed;
use crate::defaults::yes;
use crate::enums::{Open, StrEnum, str_enum};
use crate::error::ModelError;
use crate::index::IndexSpec;
use crate::shape::ReadNeed;
use crate::validation::Rule;
use bson::Document;
use bson::oid::ObjectId;
use dima_store::mongo::WriteContext;
use dima_store::mongo::date::JsDate;
use dima_store::mongo::id::IdType;
use dima_store::mongo::insert::PreparedInsert;
use dima_store::mongo::schema::{DefaultValue as D, Field, Schema, Timestamps, ValueType};
use serde::{Deserialize, Serialize};

/// The collection name.
pub const COLLECTION: &str = "oauth_clients";

str_enum! {
    /// `type`.
    pub enum ClientType {
        /// A public client (PKCE, no secret).
        Public = "public",
    }
}

/// The schema, field by field as `oauth_client.schema.ts` declares it.
pub static SCHEMA: Schema = Schema::new(&[
    Field::string("client_id"),
    Field::string("name"),
    Field::string("type"),
    Field::array("redirect_uris", ValueType::String),
    Field::array("allowed_scopes", ValueType::String),
    Field::boolean("enabled").default(D::Bool(true)),
])
.timestamps(Timestamps::CAMEL);

/// The declared indexes.
pub const INDEXES: &[IndexSpec] = &[IndexSpec::on(&[("client_id", 1)]).unique()];

/// The validators, in schema path order.
pub const RULES: &[Rule] = &[
    Rule::required("client_id"),
    Rule::required("name"),
    Rule::required("type"),
    Rule::one_of("type", ClientType::STRINGS),
    Rule::required("redirect_uris"),
    Rule::required("allowed_scopes"),
];

/// What the read type cannot decode (`crate::shape`): the write helpers refuse it.
pub const READ_NEEDS: &[ReadNeed] = &[
    ReadNeed::value("client_id"),
    ReadNeed::value("name"),
    ReadNeed::value("type"),
    ReadNeed::not_null("redirect_uris"),
    ReadNeed::not_null("allowed_scopes"),
    ReadNeed::not_null("enabled"),
];

/// The registry entry.
pub static INFO: CollectionInfo = CollectionInfo {
    name: COLLECTION,
    model: "OAuthClient",
    source: "dimabot/src/schemas/oauth_client.schema.ts",
    schema: &SCHEMA,
    id_type: IdType::ObjectId,
    hidden: &[],
    indexes: INDEXES,
    rules: RULES,
    read_needs: READ_NEEDS,
    hooks: Hooks::None,
    client_nulls: ClientNulls::None,
    initialised_at_startup: true,
    private: &[],
    decode: decode_boxed::<OAuthClient>,
};

/// A stored OAuth client.
#[derive(Clone, Debug, Deserialize)]
pub struct OAuthClient {
    /// `_id`.
    #[serde(rename = "_id")]
    pub id: ObjectId,
    /// The public client id.
    pub client_id: String,
    /// Display name.
    pub name: String,
    /// The client type.
    #[serde(rename = "type")]
    pub kind: Open<ClientType>,
    /// The redirect URIs it may use.
    #[serde(default)]
    pub redirect_uris: Vec<String>,
    /// The scopes it may ask for.
    #[serde(default)]
    pub allowed_scopes: Vec<String>,
    /// Enabled.
    #[serde(default = "yes")]
    pub enabled: bool,
    /// Creation time.
    #[serde(default, rename = "createdAt")]
    pub created_at: Option<JsDate>,
    /// Last update time.
    #[serde(default, rename = "updatedAt")]
    pub updated_at: Option<JsDate>,
}

/// A new OAuth client (the reference only upserts one; kept for the tests and the rig).
#[derive(Clone, Debug, Serialize)]
pub struct NewOAuthClient {
    /// The public client id.
    pub client_id: String,
    /// Display name.
    pub name: String,
    /// The client type.
    #[serde(rename = "type")]
    pub kind: ClientType,
    /// The redirect URIs.
    pub redirect_uris: Vec<String>,
    /// The scopes it may ask for.
    pub allowed_scopes: Vec<String>,
    /// Enabled (default `true`).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub enabled: Option<bool>,
}

impl NewOAuthClient {
    /// The values given to the constructor (before defaults).
    pub fn to_document(&self) -> Result<Document, ModelError> {
        Ok(bson::serialize_to_document(self)?)
    }

    /// The insert Mongoose sends.
    pub fn prepare(&self, ctx: &mut WriteContext) -> Result<PreparedInsert, ModelError> {
        INFO.prepare_create(&self.to_document()?, ctx)
    }
}
