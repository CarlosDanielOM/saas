//! `accounts`: the first sign-in records (a Twitch login with its encrypted tokens), from before
//! accounts moved into `users.accounts`.
//!
//! Reference: `dimabot/src/schemas/accounts.schema.ts` (model `Account`). No timestamps option (a
//! hand-written `createdAt` with a `Date.now` default), `__v`, no hooks, no index. No code of the
//! reference reads or writes the model any more; the two documents of the production copy stay
//! readable. `user_email` and both tokens are private.
//!
//! Intended difference (`crate::shape`): the write helpers refuse a value of the wrong BSON type,
//! and `null` or a removal where [`READ_NEEDS`] says the read type has none; the census of the
//! production copy shows none stored there (`user_type`, the two token objects), so Mongoose's
//! acceptance of them is not reproduced. The `default: null` strings keep their null.

use crate::collection::{CollectionInfo, Hooks};
use crate::decode::decode_boxed;
use crate::defaults::empty;
use crate::error::ModelError;
use crate::private::Private;
use crate::shape::ReadNeed;
use crate::users::EncryptedToken;
use bson::Document;
use bson::oid::ObjectId;
use dima_store::mongo::WriteContext;
use dima_store::mongo::date::JsDate;
use dima_store::mongo::id::IdType;
use dima_store::mongo::insert::PreparedInsert;
use dima_store::mongo::schema::{DefaultValue as D, Field, Schema};
use serde::{Deserialize, Serialize};

/// The collection name.
pub const COLLECTION: &str = "accounts";

const TOKEN: &[Field] = &[Field::string("iv"), Field::string("content")];

/// The schema, field by field as `accounts.schema.ts` declares it.
pub static SCHEMA: Schema = Schema::new(&[
    Field::string("user_id").default(D::Null),
    Field::string("user_login").default(D::Null),
    Field::string("user_email").default(D::Null),
    Field::string("channelID").default(D::Null),
    Field::string("channelName").default(D::Null),
    Field::string("user_type").default(D::Str("")),
    Field::nested("user_token", TOKEN),
    Field::nested("user_refresh_token", TOKEN),
    Field::date("createdAt").default_fn(D::Now),
]);

/// The private paths: their read type fields are [`crate::Private`].
pub const PRIVATE: &[&str] = &["user_email", "user_token", "user_refresh_token"];

/// What the read type cannot decode (`crate::shape`): the write helpers refuse it.
pub const READ_NEEDS: &[ReadNeed] = &[
    ReadNeed::not_null("user_type"),
    ReadNeed::not_null("user_token"),
    ReadNeed::not_null("user_refresh_token"),
];

/// The registry entry.
pub static INFO: CollectionInfo = CollectionInfo {
    name: COLLECTION,
    model: "Account",
    source: "dimabot/src/schemas/accounts.schema.ts",
    schema: &SCHEMA,
    id_type: IdType::ObjectId,
    hidden: &[],
    indexes: &[],
    rules: &[],
    read_needs: READ_NEEDS,
    hooks: Hooks::None,
    private: PRIVATE,
    decode: decode_boxed::<Account>,
};

/// A stored sign-in record.
#[derive(Clone, Debug, Deserialize)]
pub struct Account {
    /// `_id`.
    #[serde(rename = "_id")]
    pub id: ObjectId,
    /// The Twitch user id.
    #[serde(default)]
    pub user_id: Option<String>,
    /// The Twitch login.
    #[serde(default)]
    pub user_login: Option<String>,
    /// The e-mail address.
    #[serde(default)]
    pub user_email: Option<Private<String>>,
    /// The channel id.
    #[serde(default, rename = "channelID")]
    pub channel_id: Option<String>,
    /// The channel login.
    #[serde(default, rename = "channelName")]
    pub channel_name: Option<String>,
    /// The Twitch user type.
    #[serde(default = "empty")]
    pub user_type: String,
    /// The encrypted access token (`{}` when missing, as a nested path hydrates).
    #[serde(default)]
    pub user_token: Private<EncryptedToken>,
    /// The encrypted refresh token.
    #[serde(default)]
    pub user_refresh_token: Private<EncryptedToken>,
    /// Creation time (`default: Date.now`, not applied on read).
    #[serde(default, rename = "createdAt")]
    pub created_at: Option<JsDate>,
}

/// A new sign-in record (no create path is left in the reference; kept for the tests and the
/// rig). Unset fields take the schema defaults.
#[derive(Clone, Debug, Default, Serialize)]
pub struct NewAccount {
    /// The Twitch user id.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub user_id: Option<String>,
    /// The Twitch login.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub user_login: Option<String>,
    /// The e-mail address.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub user_email: Option<Private<String>>,
    /// The channel id.
    #[serde(rename = "channelID", skip_serializing_if = "Option::is_none")]
    pub channel_id: Option<String>,
    /// The channel login.
    #[serde(rename = "channelName", skip_serializing_if = "Option::is_none")]
    pub channel_name: Option<String>,
    /// The Twitch user type.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub user_type: Option<String>,
    /// The encrypted access token.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub user_token: Option<Private<EncryptedToken>>,
    /// The encrypted refresh token.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub user_refresh_token: Option<Private<EncryptedToken>>,
}

impl NewAccount {
    /// The values given to the constructor (before defaults).
    pub fn to_document(&self) -> Result<Document, ModelError> {
        Ok(bson::serialize_to_document(self)?)
    }

    /// The insert Mongoose sends.
    pub fn prepare(&self, ctx: &mut WriteContext) -> Result<PreparedInsert, ModelError> {
        INFO.prepare_create(&self.to_document()?, ctx)
    }
}
