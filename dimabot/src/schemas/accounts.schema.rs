use super::{Field, FieldDefault as D, FieldType as T, SchemaDefinition};
use crate::utils::js_string::JsString;
use std::sync::OnceLock;
pub fn schema() -> &'static SchemaDefinition {
    static DEFINITION: OnceLock<SchemaDefinition> = OnceLock::new();
    DEFINITION.get_or_init(|| SchemaDefinition {
        model: "Account",
        collection: "accounts",
        string_id: false,
        version_key: true,
        write_concern_journaled: false,
        timestamps: None,
        save_clock_field: None,
        indexes: vec![],
        fields: vec![
            Field::new("user_id", T::String).default(D::Null),
            Field::new("user_login", T::String).default(D::Null),
            Field::new("user_email", T::String).default(D::Null),
            Field::new("channelID", T::String).default(D::Null),
            Field::new("channelName", T::String).default(D::Null),
            Field::new("user_type", T::String).default(D::String("")),
            Field::new(
                "user_token",
                T::Object(vec![
                    Field::new("iv", T::String),
                    Field::new("content", T::String),
                ]),
            ),
            Field::new(
                "user_refresh_token",
                T::Object(vec![
                    Field::new("iv", T::String),
                    Field::new("content", T::String),
                ]),
            ),
            Field::new("createdAt", T::Date).default(D::Now),
        ],
    })
}

/// Declared TypeScript interface; strings retain their exact UTF-16 code units.
#[derive(Debug, Clone, PartialEq)]
pub struct AccountToken {
    pub iv: JsString,
    pub content: JsString,
}

#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct AccountTokenBson {
    pub iv: String,
    pub content: String,
}

impl From<&AccountToken> for AccountTokenBson {
    fn from(value: &AccountToken) -> Self {
        Self {
            iv: value.iv.to_utf8_lossy(),
            content: value.content.to_utf8_lossy(),
        }
    }
}

impl From<AccountTokenBson> for AccountToken {
    fn from(value: AccountTokenBson) -> Self {
        Self {
            iv: value.iv.into(),
            content: value.content.into(),
        }
    }
}

impl AccountToken {
    /// Project to the BSON wire representation, replacing unpaired UTF-16 units.
    pub fn to_bson_document(&self) -> Result<mongodb::bson::Document, mongodb::bson::error::Error> {
        mongodb::bson::serialize_to_document(&AccountTokenBson::from(self))
    }
    /// Read a declared typed value from its BSON projection. Optional null is rejected.
    pub fn from_bson_document(
        document: mongodb::bson::Document,
    ) -> Result<Self, mongodb::bson::error::Error> {
        mongodb::bson::deserialize_from_document::<AccountTokenBson>(document).map(Into::into)
    }
}

/// The source interface requires strings even though the schema defaults five fields to null.
/// Declared TypeScript interface; strings retain their exact UTF-16 code units.
#[derive(Debug, Clone, PartialEq)]
pub struct IAccounts {
    pub id: mongodb::bson::oid::ObjectId,
    pub user_id: JsString,
    pub user_login: JsString,
    pub user_email: JsString,
    pub channel_id: JsString,
    pub channel_name: JsString,
    pub user_type: JsString,
    pub user_token: AccountToken,
    pub user_refresh_token: AccountToken,
    pub created_at: mongodb::bson::DateTime,
}

#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct IAccountsBson {
    #[serde(rename = "_id")]
    pub id: mongodb::bson::oid::ObjectId,
    #[serde(rename = "user_id")]
    pub user_id: String,
    #[serde(rename = "user_login")]
    pub user_login: String,
    #[serde(rename = "user_email")]
    pub user_email: String,
    #[serde(rename = "channelID")]
    pub channel_id: String,
    #[serde(rename = "channelName")]
    pub channel_name: String,
    #[serde(rename = "user_type")]
    pub user_type: String,
    #[serde(rename = "user_token")]
    pub user_token: AccountTokenBson,
    #[serde(rename = "user_refresh_token")]
    pub user_refresh_token: AccountTokenBson,
    pub created_at: mongodb::bson::DateTime,
}

impl From<&IAccounts> for IAccountsBson {
    fn from(value: &IAccounts) -> Self {
        Self {
            id: value.id,
            user_id: value.user_id.to_utf8_lossy(),
            user_login: value.user_login.to_utf8_lossy(),
            user_email: value.user_email.to_utf8_lossy(),
            channel_id: value.channel_id.to_utf8_lossy(),
            channel_name: value.channel_name.to_utf8_lossy(),
            user_type: value.user_type.to_utf8_lossy(),
            user_token: (&value.user_token).into(),
            user_refresh_token: (&value.user_refresh_token).into(),
            created_at: value.created_at,
        }
    }
}

impl From<IAccountsBson> for IAccounts {
    fn from(value: IAccountsBson) -> Self {
        Self {
            id: value.id,
            user_id: value.user_id.into(),
            user_login: value.user_login.into(),
            user_email: value.user_email.into(),
            channel_id: value.channel_id.into(),
            channel_name: value.channel_name.into(),
            user_type: value.user_type.into(),
            user_token: value.user_token.into(),
            user_refresh_token: value.user_refresh_token.into(),
            created_at: value.created_at,
        }
    }
}

impl IAccounts {
    /// Project to the BSON wire representation, replacing unpaired UTF-16 units.
    pub fn to_bson_document(&self) -> Result<mongodb::bson::Document, mongodb::bson::error::Error> {
        mongodb::bson::serialize_to_document(&IAccountsBson::from(self))
    }
    /// Read a declared typed value from its BSON projection. Optional null is rejected.
    pub fn from_bson_document(
        document: mongodb::bson::Document,
    ) -> Result<Self, mongodb::bson::error::Error> {
        mongodb::bson::deserialize_from_document::<IAccountsBson>(document).map(Into::into)
    }
}

/// MongoDB may contain an absent or partial token object even though the interface requires both fields.
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct StoredAccountToken {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub iv: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub content: Option<String>,
}

/// Stored projection of the schema defaults and potentially incomplete token objects.
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredAccounts {
    #[serde(rename = "_id")]
    pub id: mongodb::bson::oid::ObjectId,
    #[serde(rename = "user_id")]
    #[serde(default)]
    pub user_id: Option<String>,
    #[serde(rename = "user_login")]
    #[serde(default)]
    pub user_login: Option<String>,
    #[serde(rename = "user_email")]
    #[serde(default)]
    pub user_email: Option<String>,
    #[serde(rename = "channelID")]
    #[serde(default)]
    pub channel_id: Option<String>,
    #[serde(rename = "channelName")]
    #[serde(default)]
    pub channel_name: Option<String>,
    #[serde(rename = "user_type")]
    pub user_type: String,
    #[serde(rename = "user_token")]
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub user_token: Option<StoredAccountToken>,
    #[serde(rename = "user_refresh_token")]
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub user_refresh_token: Option<StoredAccountToken>,
    pub created_at: mongodb::bson::DateTime,
}
