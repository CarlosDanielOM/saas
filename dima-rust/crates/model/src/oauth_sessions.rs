//! `oauth_sessions`: one signed-in desktop installation (a grant used from one device), with the
//! hash of its current refresh token and its idle and absolute expiry.
//!
//! Reference: `dimabot/src/schemas/oauth_session.schema.ts` (model `OAuthSession`). Camel-case
//! timestamps, `__v`, no hooks. Indexes `grant_id`, `user_id` and the TTL on `expires_at`;
//! required at startup with the other OAuth indexes (the API awaits `init()`).
//! `current_refresh_hash` is `select: false` and private. `revoked_at` and `revoke_reason` are
//! `null` until revoked (every read filters `revoked_at: null`; the census shows both stored).
//! `device_name` is at most 80 characters (Mongoose and the authorize route count UTF-16 units;
//! here characters, `MIGRATION.md` section 4).
//!
//! Client-fed writes (`null` from a request body): none: the OAuth service writes server values
//! only.
//!
//! Intended difference (`crate::shape`): the write helpers refuse a value of the wrong BSON type,
//! and `null` or a removal where [`READ_NEEDS`] says the read type has none; the census of the
//! production copy shows none stored there, so Mongoose's acceptance of them is not reproduced.

use crate::collection::{ClientNulls, CollectionInfo, Hooks};
use crate::decode::decode_boxed;
use crate::error::ModelError;
use crate::index::IndexSpec;
use crate::private::Private;
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
pub const COLLECTION: &str = "oauth_sessions";

/// Longest device name, in characters.
pub const DEVICE_NAME_MAX_CHARS: usize = 80;

/// The schema, field by field as `oauth_session.schema.ts` declares it.
pub static SCHEMA: Schema = Schema::new(&[
    Field::object_id("grant_id"),
    Field::object_id("user_id"),
    Field::string("client_id"),
    Field::string("channel_id"),
    Field::string("device_name"),
    Field::array("scopes", ValueType::String),
    Field::string("current_refresh_hash"),
    Field::date("last_used_at"),
    Field::date("idle_expires_at"),
    Field::date("expires_at"),
    Field::date("revoked_at").default(D::Null),
    Field::string("revoke_reason").default(D::Null),
])
.timestamps(Timestamps::CAMEL);

/// The `select: false` paths.
pub const HIDDEN: &[&str] = &["current_refresh_hash"];

/// The declared indexes (field-level `index: true` first).
pub const INDEXES: &[IndexSpec] = &[
    IndexSpec::on(&[("grant_id", 1)]),
    IndexSpec::on(&[("user_id", 1)]),
    IndexSpec::on(&[("expires_at", 1)]).expire_after_seconds(0),
];

/// The validators, in schema path order.
pub const RULES: &[Rule] = &[
    Rule::required("grant_id"),
    Rule::required("user_id"),
    Rule::required("client_id"),
    Rule::required("channel_id"),
    Rule::required("device_name"),
    Rule::max_length("device_name", DEVICE_NAME_MAX_CHARS),
    Rule::required("scopes"),
    Rule::required("current_refresh_hash"),
    Rule::required("last_used_at"),
    Rule::required("idle_expires_at"),
    Rule::required("expires_at"),
];

/// The private paths: their read type fields are [`crate::Private`].
pub const PRIVATE: &[&str] = &["current_refresh_hash"];

/// What the read type cannot decode (`crate::shape`): the write helpers refuse it.
pub const READ_NEEDS: &[ReadNeed] = &[
    ReadNeed::value("grant_id"),
    ReadNeed::value("user_id"),
    ReadNeed::value("client_id"),
    ReadNeed::value("channel_id"),
    ReadNeed::value("device_name"),
    ReadNeed::not_null("scopes"),
    ReadNeed::not_null("current_refresh_hash"),
    ReadNeed::value("last_used_at"),
    ReadNeed::value("idle_expires_at"),
    ReadNeed::value("expires_at"),
];

/// The registry entry.
pub static INFO: CollectionInfo = CollectionInfo {
    name: COLLECTION,
    model: "OAuthSession",
    source: "dimabot/src/schemas/oauth_session.schema.ts",
    schema: &SCHEMA,
    id_type: IdType::ObjectId,
    hidden: HIDDEN,
    indexes: INDEXES,
    rules: RULES,
    read_needs: READ_NEEDS,
    hooks: Hooks::None,
    client_nulls: ClientNulls::None,
    initialised_at_startup: true,
    private: PRIVATE,
    decode: decode_boxed::<OAuthSession>,
};

/// A stored desktop session. `current_refresh_hash` is `None` unless the read selected it.
#[derive(Clone, Debug, Deserialize)]
pub struct OAuthSession {
    /// `_id`.
    #[serde(rename = "_id")]
    pub id: ObjectId,
    /// The grant (`oauth_grants._id`).
    pub grant_id: ObjectId,
    /// The user (`users._id`).
    pub user_id: ObjectId,
    /// The client.
    pub client_id: String,
    /// The channel (Twitch id).
    pub channel_id: String,
    /// The device's name.
    pub device_name: String,
    /// The session's scopes.
    #[serde(default)]
    pub scopes: Vec<String>,
    /// SHA-256 of the current refresh token (`select: false`).
    #[serde(default)]
    pub current_refresh_hash: Option<Private<String>>,
    /// Last token use.
    pub last_used_at: JsDate,
    /// Idle expiry.
    pub idle_expires_at: JsDate,
    /// Absolute expiry (TTL).
    pub expires_at: JsDate,
    /// When it was revoked (`null` while active).
    #[serde(default)]
    pub revoked_at: Option<JsDate>,
    /// Why it was revoked (`null` while active).
    #[serde(default)]
    pub revoke_reason: Option<String>,
    /// Creation time.
    #[serde(default, rename = "createdAt")]
    pub created_at: Option<JsDate>,
    /// Last update time.
    #[serde(default, rename = "updatedAt")]
    pub updated_at: Option<JsDate>,
}

/// A new session (`OAuthSession.create` in `server/oauth/service.ts:128`).
#[derive(Clone, Debug, Serialize)]
pub struct NewOAuthSession {
    /// The grant.
    pub grant_id: ObjectId,
    /// The user.
    pub user_id: ObjectId,
    /// The client.
    pub client_id: String,
    /// The channel.
    pub channel_id: String,
    /// The device's name.
    pub device_name: String,
    /// The session's scopes.
    pub scopes: Vec<String>,
    /// SHA-256 of the first refresh token.
    pub current_refresh_hash: Private<String>,
    /// Issue time.
    pub last_used_at: JsDate,
    /// Idle expiry.
    pub idle_expires_at: JsDate,
    /// Absolute expiry.
    pub expires_at: JsDate,
}

impl NewOAuthSession {
    /// The values given to the constructor (before defaults).
    pub fn to_document(&self) -> Result<Document, ModelError> {
        Ok(bson::serialize_to_document(self)?)
    }

    /// The insert Mongoose sends.
    pub fn prepare(&self, ctx: &mut WriteContext) -> Result<PreparedInsert, ModelError> {
        INFO.prepare_create(&self.to_document()?, ctx)
    }
}
