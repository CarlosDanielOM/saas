//! `moderation_action_logs`: reference `dimabot/src/schemas/moderation_action_log.schema.ts`.
//! No hooks or runValidators; client-fed null paths: none. Writers build or normalize values.
//! Server-only nulls/removals named in READ_NEEDS are intentionally refused.
//! BSON numbers retain their stored width through JsNumber. Optional fields accept missing/null.
//! Writers: functions/moderation/execute_action.moderation.ts:64 constructs all fields from the decision/executor; request text is already a string, truncated upstream. messageExcerpt and errorMessage are private. Server errorMessage null is preserved explicitly on create. No timestamps option, __v, createdAt Date.now. No unique action index is declared: this is an audit trail, not action admission.
//! Reference privacy quirk: maxlength validation errors quote the supplied excerpt. Private
//! protects DTO Debug and decode errors; it does not redact Mongoose-compatible validation messages.

use crate::ValidationError;
use crate::decode::decode_boxed;
use crate::enums::{Open, StrEnum, str_enum};
use crate::values::Nullable;
use crate::{ClientNulls, CollectionInfo, Hooks, IndexSpec, ModelError, Private, ReadNeed, Rule};
use bson::{Document, oid::ObjectId};
use dima_store::mongo::schema::{DefaultValue as D, Field, Schema};
use dima_store::mongo::{
    WriteContext, date::JsDate, id::IdType, insert::PreparedInsert, number::JsNumber,
};
use serde::{Deserialize, Serialize};
fn default_username() -> String {
    "".into()
}
str_enum! { /// `action`.
pub enum ActionKind {/// `off`.
Off = "off",/// `warn`.
Warn = "warn",/// `delete`.
Delete = "delete",/// `timeout`.
Timeout = "timeout",/// `ban`.
Ban = "ban"} }
fn default_offense_number() -> JsNumber {
    JsNumber(1.0)
}
fn default_reason() -> String {
    "".into()
}
fn default_message_id() -> String {
    "".into()
}
fn default_message_excerpt() -> Private<String> {
    Private::new("".into())
}
fn default_success() -> bool {
    false
}
/// Collection name.
pub const COLLECTION: &str = "moderation_action_logs";
/// Frozen schema.
pub static SCHEMA: Schema = Schema::new(&[
    Field::string("channelID"),
    Field::string("userID"),
    Field::string("username").default(D::Str("")),
    Field::string("ruleID"),
    Field::string("ruleType"),
    Field::string("action"),
    Field::number("offenseNumber").default(D::Int(1)),
    Field::string("reason").default(D::Str("")),
    Field::string("messageID").default(D::Str("")),
    Field::string("messageExcerpt").default(D::Str("")),
    Field::boolean("success").default(D::Bool(false)),
    Field::string("errorMessage").default(D::Null),
    Field::date("createdAt").default_fn(D::Now),
]);
/// Hidden paths.
pub const HIDDEN: &[&str] = &[];
/// Private paths.
pub const PRIVATE: &[&str] = &["messageExcerpt", "errorMessage"];
/// Declared indexes.
pub const INDEXES: &[IndexSpec] = &[
    IndexSpec::on(&[("channelID", 1)]),
    IndexSpec::on(&[("createdAt", 1)]).expire_after_seconds(2592000),
];
/// Validators.
pub const RULES: &[Rule] = &[
    Rule::required("channelID"),
    Rule::required("userID"),
    Rule::required("ruleID"),
    Rule::required("ruleType"),
    Rule::required("action"),
    Rule::one_of("action", ActionKind::STRINGS),
    Rule::max_length("messageExcerpt", 200),
];
/// Read constraints.
pub const READ_NEEDS: &[ReadNeed] = &[
    ReadNeed::value("channelID"),
    ReadNeed::value("userID"),
    ReadNeed::not_null("username"),
    ReadNeed::value("ruleID"),
    ReadNeed::value("ruleType"),
    ReadNeed::value("action"),
    ReadNeed::not_null("offenseNumber"),
    ReadNeed::not_null("reason"),
    ReadNeed::not_null("messageID"),
    ReadNeed::not_null("messageExcerpt"),
    ReadNeed::not_null("success"),
];
/// Registry entry.
pub static INFO: CollectionInfo = CollectionInfo {
    name: COLLECTION,
    model: "moderation_action_log",
    source: "dimabot/src/schemas/moderation_action_log.schema.ts",
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
    decode: decode_boxed::<ModerationActionLog>,
};
/// Hydrated document.
#[derive(Clone, Debug, Deserialize)]
pub struct ModerationActionLog {
    /// `_id`.
    #[serde(rename = "_id")]
    pub id: ObjectId,
    /// `channelID`.
    #[serde(rename = "channelID")]
    pub channel_id: String,
    /// `userID`.
    #[serde(rename = "userID")]
    pub user_id: String,
    /// `username`.
    #[serde(rename = "username", default = "default_username")]
    pub username: String,
    /// `ruleID`.
    #[serde(rename = "ruleID")]
    pub rule_id: String,
    /// `ruleType`.
    #[serde(rename = "ruleType")]
    pub rule_type: String,
    /// `action`.
    #[serde(rename = "action")]
    pub action: Open<ActionKind>,
    /// `offenseNumber`.
    #[serde(rename = "offenseNumber", default = "default_offense_number")]
    pub offense_number: JsNumber,
    /// `reason`.
    #[serde(rename = "reason", default = "default_reason")]
    pub reason: String,
    /// `messageID`.
    #[serde(rename = "messageID", default = "default_message_id")]
    pub message_id: String,
    /// `messageExcerpt`.
    #[serde(rename = "messageExcerpt", default = "default_message_excerpt")]
    pub message_excerpt: Private<String>,
    /// `success`.
    #[serde(rename = "success", default = "default_success")]
    pub success: bool,
    /// `errorMessage`.
    #[serde(rename = "errorMessage", default)]
    pub error_message: Option<Private<String>>,
    /// `createdAt`.
    #[serde(rename = "createdAt", default)]
    pub created_at: Option<JsDate>,
}
/// New document.
#[derive(Clone, Debug, Serialize)]
pub struct NewModerationActionLog {
    /// `channelID`.
    #[serde(rename = "channelID")]
    pub channel_id: String,
    /// `userID`.
    #[serde(rename = "userID")]
    pub user_id: String,
    /// `username`.
    #[serde(rename = "username", skip_serializing_if = "Option::is_none")]
    pub username: Option<String>,
    /// `ruleID`.
    #[serde(rename = "ruleID")]
    pub rule_id: String,
    /// `ruleType`.
    #[serde(rename = "ruleType")]
    pub rule_type: String,
    /// `action`.
    #[serde(rename = "action")]
    pub action: ActionKind,
    /// `offenseNumber`.
    #[serde(rename = "offenseNumber", skip_serializing_if = "Option::is_none")]
    pub offense_number: Option<JsNumber>,
    /// `reason`.
    #[serde(rename = "reason", skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    /// `messageID`.
    #[serde(rename = "messageID", skip_serializing_if = "Option::is_none")]
    pub message_id: Option<String>,
    /// `messageExcerpt`.
    #[serde(rename = "messageExcerpt", skip_serializing_if = "Option::is_none")]
    pub message_excerpt: Option<Private<String>>,
    /// `success`.
    #[serde(rename = "success", skip_serializing_if = "Option::is_none")]
    pub success: Option<bool>,
    /// `errorMessage`.
    #[serde(rename = "errorMessage", skip_serializing_if = "Nullable::is_unset")]
    pub error_message: Nullable<Private<String>>,
    /// `createdAt`.
    #[serde(rename = "createdAt", skip_serializing_if = "Option::is_none")]
    pub created_at: Option<JsDate>,
}
impl NewModerationActionLog {
    /// Builds an audit record and validates the excerpt length (at most 200 characters).
    pub fn new(
        channel_id: impl Into<String>,
        user_id: impl Into<String>,
        rule_id: impl Into<String>,
        rule_type: impl Into<String>,
        action: ActionKind,
        excerpt: Private<String>,
    ) -> Result<Self, ValidationError> {
        let value = Self {
            channel_id: channel_id.into(),
            user_id: user_id.into(),
            username: None,
            rule_id: rule_id.into(),
            rule_type: rule_type.into(),
            action,
            offense_number: None,
            reason: None,
            message_id: None,
            message_excerpt: Some(excerpt),
            success: None,
            error_message: Nullable::Unset,
            created_at: None,
        };
        match value.prepare(&mut WriteContext::new(0)) {
            Err(ModelError::Validation(error)) => Err(error),
            _ => Ok(value),
        }
    }

    /// Input before defaults.
    pub fn to_document(&self) -> Result<Document, ModelError> {
        Ok(bson::serialize_to_document(self)?)
    }
    /// Validated insert.
    pub fn prepare(&self, ctx: &mut WriteContext) -> Result<PreparedInsert, ModelError> {
        INFO.prepare_create(&self.to_document()?, ctx)
    }
}
