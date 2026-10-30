use super::{Field, FieldDefault as D, FieldType as T, SchemaDefinition};
use crate::utils::js_string::JsString;
use std::sync::OnceLock;
pub const ADMIN_ROLES: &[&str] = &["creator", "super", "support", "billing", "channel"];
pub fn schema() -> &'static SchemaDefinition {
    static DEFINITION: OnceLock<SchemaDefinition> = OnceLock::new();
    DEFINITION.get_or_init(|| SchemaDefinition {
        model: "Admin",
        collection: "admins",
        string_id: false,
        version_key: true,
        write_concern_journaled: false,
        timestamps: None,
        save_clock_field: Some("updatedAt"),
        indexes: vec![],
        fields: vec![
            Field::new("adminName", T::String).default(D::String("")),
            Field::new("adminID", T::String).default(D::String("")),
            Field::new("channelName", T::String).default(D::String("")),
            Field::new("channelID", T::String).default(D::String("")),
            Field::new("role", T::String)
                .default(D::String("channel"))
                .enumeration(ADMIN_ROLES),
            Field::new("actived", T::Boolean).default(D::Boolean(true)),
            Field::new("permissions", T::Array(Box::new(T::String))).default(D::Array),
            Field::new("createdAt", T::Date).default(D::Now),
            Field::new("updatedAt", T::Date).default(D::Now),
        ],
    })
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub enum AdminRole {
    #[serde(rename = "creator")]
    Creator,
    #[serde(rename = "super")]
    Super,
    #[serde(rename = "support")]
    Support,
    #[serde(rename = "billing")]
    Billing,
    #[serde(rename = "channel")]
    Channel,
}
impl AdminRole {
    pub const ALL: [Self; 5] = [
        Self::Creator,
        Self::Super,
        Self::Support,
        Self::Billing,
        Self::Channel,
    ];
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Creator => ADMIN_ROLES[0],
            Self::Super => ADMIN_ROLES[1],
            Self::Support => ADMIN_ROLES[2],
            Self::Billing => ADMIN_ROLES[3],
            Self::Channel => ADMIN_ROLES[4],
        }
    }
}
impl std::str::FromStr for AdminRole {
    type Err = ();
    fn from_str(value: &str) -> Result<Self, Self::Err> {
        Self::ALL
            .into_iter()
            .find(|entry| entry.as_str() == value)
            .ok_or(())
    }
}

/// Declared TypeScript interface; strings retain their exact UTF-16 code units.
#[derive(Debug, Clone, PartialEq)]
pub struct IAdmin {
    pub id: mongodb::bson::oid::ObjectId,
    pub admin_name: JsString,
    pub admin_id: JsString,
    pub channel_name: JsString,
    pub channel_id: JsString,
    pub role: Option<AdminRole>,
    pub actived: bool,
    pub permissions: Vec<JsString>,
    pub created_at: mongodb::bson::DateTime,
    pub updated_at: mongodb::bson::DateTime,
}

#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct IAdminBson {
    #[serde(rename = "_id")]
    pub id: mongodb::bson::oid::ObjectId,
    pub admin_name: String,
    #[serde(rename = "adminID")]
    pub admin_id: String,
    pub channel_name: String,
    #[serde(rename = "channelID")]
    pub channel_id: String,
    #[serde(
        default,
        deserialize_with = "present_optional",
        skip_serializing_if = "Option::is_none"
    )]
    pub role: Option<AdminRole>,
    pub actived: bool,
    pub permissions: Vec<String>,
    pub created_at: mongodb::bson::DateTime,
    pub updated_at: mongodb::bson::DateTime,
}

impl From<&IAdmin> for IAdminBson {
    fn from(value: &IAdmin) -> Self {
        Self {
            id: value.id,
            admin_name: value.admin_name.to_utf8_lossy(),
            admin_id: value.admin_id.to_utf8_lossy(),
            channel_name: value.channel_name.to_utf8_lossy(),
            channel_id: value.channel_id.to_utf8_lossy(),
            role: value.role,
            actived: value.actived,
            permissions: value
                .permissions
                .iter()
                .map(JsString::to_utf8_lossy)
                .collect(),
            created_at: value.created_at,
            updated_at: value.updated_at,
        }
    }
}

impl From<IAdminBson> for IAdmin {
    fn from(value: IAdminBson) -> Self {
        Self {
            id: value.id,
            admin_name: value.admin_name.into(),
            admin_id: value.admin_id.into(),
            channel_name: value.channel_name.into(),
            channel_id: value.channel_id.into(),
            role: value.role,
            actived: value.actived,
            permissions: value.permissions.into_iter().map(JsString::from).collect(),
            created_at: value.created_at,
            updated_at: value.updated_at,
        }
    }
}

impl IAdmin {
    /// Project to the BSON wire representation, replacing unpaired UTF-16 units.
    pub fn to_bson_document(&self) -> Result<mongodb::bson::Document, mongodb::bson::error::Error> {
        mongodb::bson::serialize_to_document(&IAdminBson::from(self))
    }
    /// Read a declared typed value from its BSON projection. Optional null is rejected.
    pub fn from_bson_document(
        document: mongodb::bson::Document,
    ) -> Result<Self, mongodb::bson::error::Error> {
        mongodb::bson::deserialize_from_document::<IAdminBson>(document).map(Into::into)
    }
}

// Missing optional fields are accepted, but an explicit null is not a TypeScript value.
fn present_optional<'de, D, T>(deserializer: D) -> Result<Option<T>, D::Error>
where
    D: serde::Deserializer<'de>,
    T: serde::Deserialize<'de>,
{
    T::deserialize(deserializer).map(Some)
}
