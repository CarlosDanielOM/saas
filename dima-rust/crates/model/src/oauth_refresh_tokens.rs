//! `oauth_refresh_tokens`: every refresh token issued to a desktop session, by its hash, kept
//! (marked used) until the session expires so that a replayed token is detected.
//!
//! Reference: `dimabot/src/schemas/oauth_refresh_token.schema.ts` (model `OAuthRefreshToken`).
//! Camel-case timestamps, `__v`, no hooks. Unique `token_hash` (field level: a hash names exactly
//! one token), `session_id`, TTL on `expires_at`; required at startup with the other OAuth
//! indexes (the API awaits `init()`). `token_hash` (SHA-256 of the token, base64url) is private.
//! `used_at` is `null` until the token is rotated (the census shows it stored).
//!
//! Intended difference (`crate::shape`): the write helpers refuse a value of the wrong BSON type,
//! and `null` or a removal where [`READ_NEEDS`] says the read type has none; the census of the
//! production copy shows none stored there, so Mongoose's acceptance of them is not reproduced.

use crate::collection::{CollectionInfo, Hooks};
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
use dima_store::mongo::schema::{DefaultValue as D, Field, Schema, Timestamps};
use serde::{Deserialize, Serialize};

/// The collection name.
pub const COLLECTION: &str = "oauth_refresh_tokens";

/// The schema, field by field as `oauth_refresh_token.schema.ts` declares it.
pub static SCHEMA: Schema = Schema::new(&[
    Field::string("token_hash"),
    Field::object_id("session_id"),
    Field::date("used_at").default(D::Null),
    Field::date("expires_at"),
])
.timestamps(Timestamps::CAMEL);

/// The declared indexes (field-level `unique` and `index` first).
pub const INDEXES: &[IndexSpec] = &[
    IndexSpec::on(&[("token_hash", 1)]).unique(),
    IndexSpec::on(&[("session_id", 1)]),
    IndexSpec::on(&[("expires_at", 1)]).expire_after_seconds(0),
];

/// The validators, in schema path order.
pub const RULES: &[Rule] = &[
    Rule::required("token_hash"),
    Rule::required("session_id"),
    Rule::required("expires_at"),
];

/// The private paths: their read type fields are [`crate::Private`].
pub const PRIVATE: &[&str] = &["token_hash"];

/// What the read type cannot decode (`crate::shape`): the write helpers refuse it.
pub const READ_NEEDS: &[ReadNeed] = &[
    ReadNeed::value("token_hash"),
    ReadNeed::value("session_id"),
    ReadNeed::value("expires_at"),
];

/// The registry entry.
pub static INFO: CollectionInfo = CollectionInfo {
    name: COLLECTION,
    model: "OAuthRefreshToken",
    source: "dimabot/src/schemas/oauth_refresh_token.schema.ts",
    schema: &SCHEMA,
    id_type: IdType::ObjectId,
    hidden: &[],
    indexes: INDEXES,
    rules: RULES,
    read_needs: READ_NEEDS,
    hooks: Hooks::None,
    initialised_at_startup: true,
    private: PRIVATE,
    decode: decode_boxed::<OAuthRefreshToken>,
};

/// A stored refresh token record.
#[derive(Clone, Debug, Deserialize)]
pub struct OAuthRefreshToken {
    /// `_id`.
    #[serde(rename = "_id")]
    pub id: ObjectId,
    /// SHA-256 of the token (base64url).
    pub token_hash: Private<String>,
    /// The session (`oauth_sessions._id`).
    pub session_id: ObjectId,
    /// When it was rotated (`null` while unused).
    #[serde(default)]
    pub used_at: Option<JsDate>,
    /// The session's absolute expiry (TTL).
    pub expires_at: JsDate,
    /// Creation time.
    #[serde(default, rename = "createdAt")]
    pub created_at: Option<JsDate>,
    /// Last update time.
    #[serde(default, rename = "updatedAt")]
    pub updated_at: Option<JsDate>,
}

/// A new refresh token record (`OAuthRefreshToken.create` in `server/oauth/service.ts`).
#[derive(Clone, Debug, Serialize)]
pub struct NewOAuthRefreshToken {
    /// SHA-256 of the token (base64url).
    pub token_hash: Private<String>,
    /// The session.
    pub session_id: ObjectId,
    /// The session's absolute expiry.
    pub expires_at: JsDate,
}

impl NewOAuthRefreshToken {
    /// The values given to the constructor (before defaults).
    pub fn to_document(&self) -> Result<Document, ModelError> {
        Ok(bson::serialize_to_document(self)?)
    }

    /// The insert Mongoose sends.
    pub fn prepare(&self, ctx: &mut WriteContext) -> Result<PreparedInsert, ModelError> {
        INFO.prepare_create(&self.to_document()?, ctx)
    }
}
