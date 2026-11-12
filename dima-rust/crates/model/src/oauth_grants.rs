//! `oauth_grants`: what a user allowed an OAuth client to do for one of their channels.
//!
//! Reference: `dimabot/src/schemas/oauth_grant.schema.ts` (model `OAuthGrant`). Camel-case
//! timestamps, `__v`, no hooks. Indexes `user_id` and the unique `{user_id, client_id,
//! channel_id}` (one grant per user, client and channel: the code exchange upserts on exactly
//! that triple, `server/oauth/service.ts:123`, so without the index two concurrent exchanges
//! would create two grants). Required at startup with the other OAuth indexes (the API awaits
//! `init()`). `revoked_at` is `null` until revoked: the exchange sets it back to `null`, and
//! every read filters `revoked_at: null`, so the null is kept.
//!
//! Client-fed writes (`null` from a request body): none: the OAuth service writes server values
//! only (scopes it checked).
//!
//! Intended difference (`crate::shape`): the write helpers refuse a value of the wrong BSON type,
//! and `null` or a removal where [`READ_NEEDS`] says the read type has none; the census of the
//! production copy shows none stored there, so Mongoose's acceptance of them is not reproduced.

use crate::collection::{ClientNulls, CollectionInfo, Hooks};
use crate::decode::decode_boxed;
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
pub const COLLECTION: &str = "oauth_grants";

/// The schema, field by field as `oauth_grant.schema.ts` declares it.
pub static SCHEMA: Schema = Schema::new(&[
    Field::object_id("user_id"),
    Field::string("client_id"),
    Field::string("channel_id"),
    Field::array("scopes", ValueType::String),
    Field::date("revoked_at").default(D::Null),
])
.timestamps(Timestamps::CAMEL);

/// The declared indexes (field-level `index: true` first).
pub const INDEXES: &[IndexSpec] = &[
    IndexSpec::on(&[("user_id", 1)]),
    IndexSpec::on(&[("user_id", 1), ("client_id", 1), ("channel_id", 1)]).unique(),
];

/// The validators, in schema path order.
pub const RULES: &[Rule] = &[
    Rule::required("user_id"),
    Rule::required("client_id"),
    Rule::required("channel_id"),
    Rule::required("scopes"),
];

/// What the read type cannot decode (`crate::shape`): the write helpers refuse it.
pub const READ_NEEDS: &[ReadNeed] = &[
    ReadNeed::value("user_id"),
    ReadNeed::value("client_id"),
    ReadNeed::value("channel_id"),
    ReadNeed::not_null("scopes"),
];

/// The registry entry.
pub static INFO: CollectionInfo = CollectionInfo {
    name: COLLECTION,
    model: "OAuthGrant",
    source: "dimabot/src/schemas/oauth_grant.schema.ts",
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
    decode: decode_boxed::<OAuthGrant>,
};

/// A stored grant.
#[derive(Clone, Debug, Deserialize)]
pub struct OAuthGrant {
    /// `_id`.
    #[serde(rename = "_id")]
    pub id: ObjectId,
    /// The user (`users._id`).
    pub user_id: ObjectId,
    /// The client.
    pub client_id: String,
    /// The channel (Twitch id).
    pub channel_id: String,
    /// The granted scopes.
    #[serde(default)]
    pub scopes: Vec<String>,
    /// When it was revoked (`null` while active).
    #[serde(default)]
    pub revoked_at: Option<JsDate>,
    /// Creation time.
    #[serde(default, rename = "createdAt")]
    pub created_at: Option<JsDate>,
    /// Last update time.
    #[serde(default, rename = "updatedAt")]
    pub updated_at: Option<JsDate>,
}

/// A new grant (the reference upserts them; kept for the tests and the rig).
#[derive(Clone, Debug, Serialize)]
pub struct NewOAuthGrant {
    /// The user.
    pub user_id: ObjectId,
    /// The client.
    pub client_id: String,
    /// The channel.
    pub channel_id: String,
    /// The granted scopes.
    pub scopes: Vec<String>,
}

impl NewOAuthGrant {
    /// The values given to the constructor (before defaults).
    pub fn to_document(&self) -> Result<Document, ModelError> {
        Ok(bson::serialize_to_document(self)?)
    }

    /// The insert Mongoose sends.
    pub fn prepare(&self, ctx: &mut WriteContext) -> Result<PreparedInsert, ModelError> {
        INFO.prepare_create(&self.to_document()?, ctx)
    }
}
