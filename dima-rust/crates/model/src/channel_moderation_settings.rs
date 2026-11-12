//! `channel_moderation_settings`: reference `dimabot/src/schemas/channel_moderation_settings.schema.ts`.
//! No hooks; hidden paths: none. Options and indexes are declared below.
//! Dashboard and assistant writes share server/services/moderation_settings.service.ts:283,297,311.
//! sanitizeRule (:87-148) rebuilds rules (typed bools, clamped numbers, normalized lists),
//! parseAdvancedRule rebuilds patterns/semantic, and inspectExpression validates exemptions.
//! prepareModerationSettings validates spam options and defaults enabled. No unchecked client-fed
//! paths (0); the raw exemption can be null. utils/moderation/defaults.ts:44,55 builds seeds.
//! No runValidators or document saves. Old documents lack spamProtection and advanced rule fields;
//! read defaults reproduce those defaults. Unique channelID is best effort: no awaited init.
//! Strict server-only nulls/removals in READ_NEEDS are refused; no stored nulls there.
//! BSON numbers preserve int32/int64/double on writes; reads use JsNumber without rounding.

use crate::Private;
use crate::decode::decode_boxed;
use crate::enums::Open;
use crate::{ClientNulls, CollectionInfo, Hooks, IndexSpec, ModelError, ReadNeed, Rule};
use bson::{Bson, Document};
use dima_store::mongo::schema::{DefaultValue as D, Field, Schema, ValueType};
use dima_store::mongo::{
    WriteContext, date::JsDate, id::IdType, insert::PreparedInsert, number::JsNumber,
};
use serde::{Deserialize, Serialize};
/// Collection name.
pub const COLLECTION: &str = "channel_moderation_settings";
crate::enums::str_enum! { /// Schema enumeration.
pub enum ChannelModerationSettingsRulesTypeValue {/// caps
Caps = "caps",/// links
Links = "links",/// emote_spam
EmoteSpam = "emote_spam",/// blacklist
Blacklist = "blacklist"}}
crate::enums::str_enum! { /// Schema enumeration.
pub enum ChannelModerationSettingsRulesFirstOffenseActionValue {/// off
Off = "off",/// warn
Warn = "warn",/// delete
Delete = "delete",/// timeout
Timeout = "timeout",/// ban
Ban = "ban"}}
crate::enums::str_enum! { /// Schema enumeration.
pub enum ChannelModerationSettingsRulesSecondOffenseActionValue {/// off
Off = "off",/// warn
Warn = "warn",/// delete
Delete = "delete",/// timeout
Timeout = "timeout",/// ban
Ban = "ban"}}
crate::enums::str_enum! { /// Schema enumeration.
pub enum ChannelModerationSettingsRulesThirdOffenseActionValue {/// off
Off = "off",/// warn
Warn = "warn",/// delete
Delete = "delete",/// timeout
Timeout = "timeout",/// ban
Ban = "ban"}}
/// Raw `rules.$.exemptExpression` content owned by its feature domain.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(transparent)]
pub struct ChannelModerationSettingsRulesExemptExpression(pub Bson);
crate::enums::str_enum! { /// Schema enumeration.
pub enum ChannelModerationSettingsRulesCapsThresholdModeValue {/// count
Count = "count",/// percentage
Percentage = "percentage"}}
/// Raw `rules.$.variations` content owned by its feature domain.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(transparent)]
pub struct ChannelModerationSettingsRulesVariations(pub Bson);
crate::enums::str_enum! { /// Schema enumeration.
pub enum ChannelModerationSettingsRulesSemanticOnUncertainValue {/// allow_and_log
AllowAndLog = "allow_and_log"}}
fn default_bson_schema_spam_protection(_: i64) -> Bson {
    Bson::Document(
        bson::doc! {"enabled":Bson::Boolean(true),"reviewAllMessages":Bson::Boolean(false),"categories":Bson::Array(vec![Bson::String("spam".into()),Bson::String("ads".into()),Bson::String("self_promotion".into())]),"exemptTags":Bson::Array(vec![Bson::String("mod".into()),Bson::String("editor".into()),Bson::String("admin".into())]),"thresholdPercent":Bson::Int32(85)},
    )
}
fn default_bson_schema_rules_first_offense(_: i64) -> Bson {
    Bson::Document(
        bson::doc! {"action":Bson::String("warn".into()),"timeoutSeconds":Bson::Int32(60)},
    )
}
fn default_bson_schema_rules_second_offense(_: i64) -> Bson {
    Bson::Document(
        bson::doc! {"action":Bson::String("delete".into()),"timeoutSeconds":Bson::Int32(60)},
    )
}
fn default_bson_schema_rules_third_offense(_: i64) -> Bson {
    Bson::Document(
        bson::doc! {"action":Bson::String("timeout".into()),"timeoutSeconds":Bson::Int32(60)},
    )
}
fn default_bson_schema_rules_variations(_: i64) -> Bson {
    Bson::Document(bson::doc! {"mode":Bson::String("off".into()),"entries":Bson::Array(vec![])})
}
fn default_bson_schema_rules_semantic(_: i64) -> Bson {
    Bson::Document(
        bson::doc! {"enabled":Bson::Boolean(false),"policy":Bson::String("".into()),"examples":Bson::Array(vec![]),"onUncertain":Bson::String("allow_and_log".into()),"thresholdPercent":Bson::Int32(85)},
    )
}
fn read_default_channel_moderation_settings_channel() -> String {
    "".into()
}
fn read_default_channel_moderation_settings_enabled() -> bool {
    false
}
fn read_default_channel_moderation_settings_spam_protection_enabled() -> bool {
    true
}
fn read_default_channel_moderation_settings_spam_protection_review_all_messages() -> bool {
    false
}
fn read_default_channel_moderation_settings_spam_protection_categories() -> Vec<Option<String>> {
    vec![
        Some("spam".into()),
        Some("ads".into()),
        Some("self_promotion".into()),
    ]
}
fn read_default_channel_moderation_settings_spam_protection_exempt_tags() -> Vec<Option<String>> {
    vec![
        Some("mod".into()),
        Some("editor".into()),
        Some("admin".into()),
    ]
}
fn read_default_channel_moderation_settings_spam_protection_threshold_percent() -> JsNumber {
    JsNumber(85.0)
}
fn read_default_channel_moderation_settings_spam_protection()
-> ChannelModerationSettingsSpamProtection {
    ChannelModerationSettingsSpamProtection {
        enabled: true,
        review_all_messages: false,
        categories: vec![
            Some("spam".into()),
            Some("ads".into()),
            Some("self_promotion".into()),
        ],
        exempt_tags: vec![
            Some("mod".into()),
            Some("editor".into()),
            Some("admin".into()),
        ],
        threshold_percent: JsNumber(85.0),
    }
}
fn read_default_channel_moderation_settings_offense_window_seconds() -> JsNumber {
    JsNumber(3600.0)
}
fn read_default_channel_moderation_settings_rules_enabled() -> bool {
    true
}
fn read_default_channel_moderation_settings_rules_first_offense_action()
-> Open<ChannelModerationSettingsRulesFirstOffenseActionValue> {
    Open::from(ChannelModerationSettingsRulesFirstOffenseActionValue::Warn)
}
fn read_default_channel_moderation_settings_rules_first_offense_timeout_seconds() -> JsNumber {
    JsNumber(60.0)
}
fn read_default_channel_moderation_settings_rules_first_offense()
-> ChannelModerationSettingsRulesFirstOffense {
    ChannelModerationSettingsRulesFirstOffense {
        action: Open::from(ChannelModerationSettingsRulesFirstOffenseActionValue::Warn),
        timeout_seconds: JsNumber(60.0),
    }
}
fn read_default_channel_moderation_settings_rules_second_offense_action()
-> Open<ChannelModerationSettingsRulesSecondOffenseActionValue> {
    Open::from(ChannelModerationSettingsRulesSecondOffenseActionValue::Warn)
}
fn read_default_channel_moderation_settings_rules_second_offense_timeout_seconds() -> JsNumber {
    JsNumber(60.0)
}
fn read_default_channel_moderation_settings_rules_second_offense()
-> ChannelModerationSettingsRulesSecondOffense {
    ChannelModerationSettingsRulesSecondOffense {
        action: Open::from(ChannelModerationSettingsRulesSecondOffenseActionValue::Delete),
        timeout_seconds: JsNumber(60.0),
    }
}
fn read_default_channel_moderation_settings_rules_third_offense_action()
-> Open<ChannelModerationSettingsRulesThirdOffenseActionValue> {
    Open::from(ChannelModerationSettingsRulesThirdOffenseActionValue::Warn)
}
fn read_default_channel_moderation_settings_rules_third_offense_timeout_seconds() -> JsNumber {
    JsNumber(60.0)
}
fn read_default_channel_moderation_settings_rules_third_offense()
-> ChannelModerationSettingsRulesThirdOffense {
    ChannelModerationSettingsRulesThirdOffense {
        action: Open::from(ChannelModerationSettingsRulesThirdOffenseActionValue::Timeout),
        timeout_seconds: JsNumber(60.0),
    }
}
fn read_default_channel_moderation_settings_rules_reason() -> Private<String> {
    Private::new("Message blocked by channel moderation".into())
}
fn read_default_channel_moderation_settings_rules_exempt_user_level() -> JsNumber {
    JsNumber(7.0)
}
fn read_default_channel_moderation_settings_rules_caps_threshold_mode()
-> Open<ChannelModerationSettingsRulesCapsThresholdModeValue> {
    Open::from(ChannelModerationSettingsRulesCapsThresholdModeValue::Count)
}
fn read_default_channel_moderation_settings_rules_min_caps_count() -> JsNumber {
    JsNumber(8.0)
}
fn read_default_channel_moderation_settings_rules_max_caps_percentage() -> JsNumber {
    JsNumber(70.0)
}
fn read_default_channel_moderation_settings_rules_min_message_length() -> JsNumber {
    JsNumber(10.0)
}
fn read_default_channel_moderation_settings_rules_allowlist_domains() -> Vec<Option<String>> {
    vec![]
}
fn read_default_channel_moderation_settings_rules_max_emote_count() -> JsNumber {
    JsNumber(10.0)
}
fn read_default_channel_moderation_settings_rules_terms() -> Private<Vec<Option<String>>> {
    Private::new(vec![])
}
fn read_default_channel_moderation_settings_rules_variations()
-> Private<ChannelModerationSettingsRulesVariations> {
    Private::new(ChannelModerationSettingsRulesVariations(Bson::Document(
        bson::doc! {"mode":Bson::String("off".into()),"entries":Bson::Array(vec![])},
    )))
}
fn read_default_channel_moderation_settings_rules_patterns()
-> Vec<ChannelModerationSettingsRulesPatterns> {
    vec![]
}
fn read_default_channel_moderation_settings_rules_semantic_enabled() -> bool {
    false
}
fn read_default_channel_moderation_settings_rules_semantic_threshold_percent() -> JsNumber {
    JsNumber(85.0)
}
fn read_default_channel_moderation_settings_rules_semantic_policy() -> Private<String> {
    Private::new("".into())
}
fn read_default_channel_moderation_settings_rules_semantic_examples()
-> Vec<ChannelModerationSettingsRulesSemanticExamples> {
    vec![]
}
fn read_default_channel_moderation_settings_rules_semantic_on_uncertain()
-> Open<ChannelModerationSettingsRulesSemanticOnUncertainValue> {
    Open::from(ChannelModerationSettingsRulesSemanticOnUncertainValue::AllowAndLog)
}
fn read_default_channel_moderation_settings_rules_semantic()
-> ChannelModerationSettingsRulesSemantic {
    ChannelModerationSettingsRulesSemantic {
        enabled: false,
        threshold_percent: JsNumber(85.0),
        policy: "".into(),
        examples: vec![],
        on_uncertain: Open::from(
            ChannelModerationSettingsRulesSemanticOnUncertainValue::AllowAndLog,
        ),
    }
}
fn read_default_channel_moderation_settings_rules() -> Vec<ChannelModerationSettingsRules> {
    vec![]
}
fn read_default_channel_moderation_settings_settings_version() -> JsNumber {
    JsNumber(1.0)
}
static SCHEMA_SPAM_PROTECTION: Schema = Schema::subdocument(&[
    Field::boolean("enabled").default(D::Bool(true)),
    Field::boolean("reviewAllMessages").default(D::Bool(false)),
    Field::array("categories", ValueType::String).default_fn(D::Strings(&[
        "spam",
        "ads",
        "self_promotion",
    ])),
    Field::array("exemptTags", ValueType::String)
        .default_fn(D::Strings(&["mod", "editor", "admin"])),
    Field::number("thresholdPercent").default(D::Int(85)),
])
.no_id();
static SCHEMA_RULES_FIRST_OFFENSE: Schema = Schema::subdocument(&[
    Field::string("action").default(D::Str("warn")),
    Field::number("timeoutSeconds").default(D::Int(60)),
])
.no_id();
static SCHEMA_RULES_SECOND_OFFENSE: Schema = Schema::subdocument(&[
    Field::string("action").default(D::Str("warn")),
    Field::number("timeoutSeconds").default(D::Int(60)),
])
.no_id();
static SCHEMA_RULES_THIRD_OFFENSE: Schema = Schema::subdocument(&[
    Field::string("action").default(D::Str("warn")),
    Field::number("timeoutSeconds").default(D::Int(60)),
])
.no_id();
static SCHEMA_RULES_PATTERNS: Schema = Schema::subdocument(&[
    Field::string("id"),
    Field::string("source"),
    Field::string("boundary"),
    Field::boolean("ignoreCase"),
])
.no_id();
static SCHEMA_RULES_SEMANTIC_EXAMPLES: Schema =
    Schema::subdocument(&[Field::string("message"), Field::string("label")]).no_id();
static SCHEMA_RULES_SEMANTIC: Schema = Schema::subdocument(&[
    Field::boolean("enabled").default(D::Bool(false)),
    Field::number("thresholdPercent").default(D::Int(85)),
    Field::string("policy").default(D::Str("")),
    Field::document_array("examples", &SCHEMA_RULES_SEMANTIC_EXAMPLES).default(D::EmptyArray),
    Field::string("onUncertain").default(D::Str("allow_and_log")),
])
.no_id();
static SCHEMA_RULES: Schema = Schema::subdocument(&[
    Field::string("id"),
    Field::string("type"),
    Field::boolean("enabled").default(D::Bool(true)),
    Field::subdocument("firstOffense", &SCHEMA_RULES_FIRST_OFFENSE)
        .default_fn(D::With(default_bson_schema_rules_first_offense)),
    Field::subdocument("secondOffense", &SCHEMA_RULES_SECOND_OFFENSE)
        .default_fn(D::With(default_bson_schema_rules_second_offense)),
    Field::subdocument("thirdOffense", &SCHEMA_RULES_THIRD_OFFENSE)
        .default_fn(D::With(default_bson_schema_rules_third_offense)),
    Field::string("reason").default(D::Str("Message blocked by channel moderation")),
    Field::number("exemptUserLevel").default(D::Int(7)),
    Field::mixed("exemptExpression").default(D::Null),
    Field::string("capsThresholdMode").default(D::Str("count")),
    Field::number("minCapsCount").default(D::Int(8)),
    Field::number("maxCapsPercentage").default(D::Int(70)),
    Field::number("minMessageLength").default(D::Int(10)),
    Field::array("allowlistDomains", ValueType::String).default(D::EmptyArray),
    Field::number("maxEmoteCount").default(D::Int(10)),
    Field::array("terms", ValueType::String).default(D::EmptyArray),
    Field::mixed("variations").default_fn(D::With(default_bson_schema_rules_variations)),
    Field::document_array("patterns", &SCHEMA_RULES_PATTERNS).default(D::EmptyArray),
    Field::subdocument("semantic", &SCHEMA_RULES_SEMANTIC)
        .default_fn(D::With(default_bson_schema_rules_semantic)),
])
.no_id();
/// Frozen schema.
pub static SCHEMA: Schema = Schema::new(&[
    Field::string("channelID"),
    Field::string("channel").default(D::Str("")),
    Field::boolean("enabled").default(D::Bool(false)),
    Field::subdocument("spamProtection", &SCHEMA_SPAM_PROTECTION)
        .default_fn(D::With(default_bson_schema_spam_protection)),
    Field::number("offenseWindowSeconds").default(D::Int(3600)),
    Field::document_array("rules", &SCHEMA_RULES).default(D::EmptyArray),
    Field::number("settingsVersion").default(D::Int(1)),
])
.timestamps(dima_store::mongo::schema::Timestamps::CAMEL);
/// Hydrated document fields.
#[derive(Clone, Debug, Deserialize)]
pub struct ChannelModerationSettingsSpamProtection {
    /// `spamProtection.enabled`.
    #[serde(
        rename = "enabled",
        default = "read_default_channel_moderation_settings_spam_protection_enabled"
    )]
    pub enabled: bool,
    /// `spamProtection.reviewAllMessages`.
    #[serde(
        rename = "reviewAllMessages",
        default = "read_default_channel_moderation_settings_spam_protection_review_all_messages"
    )]
    pub review_all_messages: bool,
    /// `spamProtection.categories`.
    #[serde(
        rename = "categories",
        default = "read_default_channel_moderation_settings_spam_protection_categories"
    )]
    pub categories: Vec<Option<String>>,
    /// `spamProtection.exemptTags`.
    #[serde(
        rename = "exemptTags",
        default = "read_default_channel_moderation_settings_spam_protection_exempt_tags"
    )]
    pub exempt_tags: Vec<Option<String>>,
    /// `spamProtection.thresholdPercent`.
    #[serde(
        rename = "thresholdPercent",
        default = "read_default_channel_moderation_settings_spam_protection_threshold_percent"
    )]
    pub threshold_percent: JsNumber,
}
/// Typed input fields.
#[derive(Clone, Debug, Serialize)]
pub struct NewChannelModerationSettingsSpamProtection {
    /// `spamProtection.enabled`.
    #[serde(rename = "enabled", skip_serializing_if = "Option::is_none")]
    pub enabled: Option<bool>,
    /// `spamProtection.reviewAllMessages`.
    #[serde(rename = "reviewAllMessages", skip_serializing_if = "Option::is_none")]
    pub review_all_messages: Option<bool>,
    /// `spamProtection.categories`.
    #[serde(rename = "categories", skip_serializing_if = "Option::is_none")]
    pub categories: Option<Vec<Option<String>>>,
    /// `spamProtection.exemptTags`.
    #[serde(rename = "exemptTags", skip_serializing_if = "Option::is_none")]
    pub exempt_tags: Option<Vec<Option<String>>>,
    /// `spamProtection.thresholdPercent`.
    #[serde(rename = "thresholdPercent", skip_serializing_if = "Option::is_none")]
    pub threshold_percent: Option<JsNumber>,
}
/// Hydrated document fields.
#[derive(Clone, Debug, Deserialize)]
pub struct ChannelModerationSettingsRulesFirstOffense {
    /// `rules.$.firstOffense.action`.
    #[serde(
        rename = "action",
        default = "read_default_channel_moderation_settings_rules_first_offense_action"
    )]
    pub action: Open<ChannelModerationSettingsRulesFirstOffenseActionValue>,
    /// `rules.$.firstOffense.timeoutSeconds`.
    #[serde(
        rename = "timeoutSeconds",
        default = "read_default_channel_moderation_settings_rules_first_offense_timeout_seconds"
    )]
    pub timeout_seconds: JsNumber,
}
/// Typed input fields.
#[derive(Clone, Debug, Serialize)]
pub struct NewChannelModerationSettingsRulesFirstOffense {
    /// `rules.$.firstOffense.action`.
    #[serde(rename = "action", skip_serializing_if = "Option::is_none")]
    pub action: Option<ChannelModerationSettingsRulesFirstOffenseActionValue>,
    /// `rules.$.firstOffense.timeoutSeconds`.
    #[serde(rename = "timeoutSeconds", skip_serializing_if = "Option::is_none")]
    pub timeout_seconds: Option<JsNumber>,
}
/// Hydrated document fields.
#[derive(Clone, Debug, Deserialize)]
pub struct ChannelModerationSettingsRulesSecondOffense {
    /// `rules.$.secondOffense.action`.
    #[serde(
        rename = "action",
        default = "read_default_channel_moderation_settings_rules_second_offense_action"
    )]
    pub action: Open<ChannelModerationSettingsRulesSecondOffenseActionValue>,
    /// `rules.$.secondOffense.timeoutSeconds`.
    #[serde(
        rename = "timeoutSeconds",
        default = "read_default_channel_moderation_settings_rules_second_offense_timeout_seconds"
    )]
    pub timeout_seconds: JsNumber,
}
/// Typed input fields.
#[derive(Clone, Debug, Serialize)]
pub struct NewChannelModerationSettingsRulesSecondOffense {
    /// `rules.$.secondOffense.action`.
    #[serde(rename = "action", skip_serializing_if = "Option::is_none")]
    pub action: Option<ChannelModerationSettingsRulesSecondOffenseActionValue>,
    /// `rules.$.secondOffense.timeoutSeconds`.
    #[serde(rename = "timeoutSeconds", skip_serializing_if = "Option::is_none")]
    pub timeout_seconds: Option<JsNumber>,
}
/// Hydrated document fields.
#[derive(Clone, Debug, Deserialize)]
pub struct ChannelModerationSettingsRulesThirdOffense {
    /// `rules.$.thirdOffense.action`.
    #[serde(
        rename = "action",
        default = "read_default_channel_moderation_settings_rules_third_offense_action"
    )]
    pub action: Open<ChannelModerationSettingsRulesThirdOffenseActionValue>,
    /// `rules.$.thirdOffense.timeoutSeconds`.
    #[serde(
        rename = "timeoutSeconds",
        default = "read_default_channel_moderation_settings_rules_third_offense_timeout_seconds"
    )]
    pub timeout_seconds: JsNumber,
}
/// Typed input fields.
#[derive(Clone, Debug, Serialize)]
pub struct NewChannelModerationSettingsRulesThirdOffense {
    /// `rules.$.thirdOffense.action`.
    #[serde(rename = "action", skip_serializing_if = "Option::is_none")]
    pub action: Option<ChannelModerationSettingsRulesThirdOffenseActionValue>,
    /// `rules.$.thirdOffense.timeoutSeconds`.
    #[serde(rename = "timeoutSeconds", skip_serializing_if = "Option::is_none")]
    pub timeout_seconds: Option<JsNumber>,
}
/// Hydrated document fields.
#[derive(Clone, Debug, Deserialize)]
pub struct ChannelModerationSettingsRulesPatterns {
    /// `rules.$.patterns.$.id`.
    #[serde(rename = "id", default)]
    pub id: Option<String>,
    /// `rules.$.patterns.$.source`.
    #[serde(rename = "source", default)]
    pub source: Option<Private<String>>,
    /// `rules.$.patterns.$.boundary`.
    #[serde(rename = "boundary", default)]
    pub boundary: Option<String>,
    /// `rules.$.patterns.$.ignoreCase`.
    #[serde(rename = "ignoreCase", default)]
    pub ignore_case: Option<bool>,
}
/// Typed input fields.
#[derive(Clone, Debug, Serialize)]
pub struct NewChannelModerationSettingsRulesPatterns {
    /// `rules.$.patterns.$.id`.
    #[serde(rename = "id", skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
    /// `rules.$.patterns.$.source`.
    #[serde(rename = "source", skip_serializing_if = "Option::is_none")]
    pub source: Option<Private<String>>,
    /// `rules.$.patterns.$.boundary`.
    #[serde(rename = "boundary", skip_serializing_if = "Option::is_none")]
    pub boundary: Option<String>,
    /// `rules.$.patterns.$.ignoreCase`.
    #[serde(rename = "ignoreCase", skip_serializing_if = "Option::is_none")]
    pub ignore_case: Option<bool>,
}
/// Hydrated document fields.
#[derive(Clone, Debug, Deserialize)]
pub struct ChannelModerationSettingsRulesSemanticExamples {
    /// `rules.$.semantic.examples.$.message`.
    #[serde(rename = "message", default)]
    pub message: Option<Private<String>>,
    /// `rules.$.semantic.examples.$.label`.
    #[serde(rename = "label", default)]
    pub label: Option<String>,
}
/// Typed input fields.
#[derive(Clone, Debug, Serialize)]
pub struct NewChannelModerationSettingsRulesSemanticExamples {
    /// `rules.$.semantic.examples.$.message`.
    #[serde(rename = "message", skip_serializing_if = "Option::is_none")]
    pub message: Option<Private<String>>,
    /// `rules.$.semantic.examples.$.label`.
    #[serde(rename = "label", skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
}
/// Hydrated document fields.
#[derive(Clone, Debug, Deserialize)]
pub struct ChannelModerationSettingsRulesSemantic {
    /// `rules.$.semantic.enabled`.
    #[serde(
        rename = "enabled",
        default = "read_default_channel_moderation_settings_rules_semantic_enabled"
    )]
    pub enabled: bool,
    /// `rules.$.semantic.thresholdPercent`.
    #[serde(
        rename = "thresholdPercent",
        default = "read_default_channel_moderation_settings_rules_semantic_threshold_percent"
    )]
    pub threshold_percent: JsNumber,
    /// `rules.$.semantic.policy`.
    #[serde(
        rename = "policy",
        default = "read_default_channel_moderation_settings_rules_semantic_policy"
    )]
    pub policy: Private<String>,
    /// `rules.$.semantic.examples`.
    #[serde(
        rename = "examples",
        default = "read_default_channel_moderation_settings_rules_semantic_examples"
    )]
    pub examples: Vec<ChannelModerationSettingsRulesSemanticExamples>,
    /// `rules.$.semantic.onUncertain`.
    #[serde(
        rename = "onUncertain",
        default = "read_default_channel_moderation_settings_rules_semantic_on_uncertain"
    )]
    pub on_uncertain: Open<ChannelModerationSettingsRulesSemanticOnUncertainValue>,
}
/// Typed input fields.
#[derive(Clone, Debug, Serialize)]
pub struct NewChannelModerationSettingsRulesSemantic {
    /// `rules.$.semantic.enabled`.
    #[serde(rename = "enabled", skip_serializing_if = "Option::is_none")]
    pub enabled: Option<bool>,
    /// `rules.$.semantic.thresholdPercent`.
    #[serde(rename = "thresholdPercent", skip_serializing_if = "Option::is_none")]
    pub threshold_percent: Option<JsNumber>,
    /// `rules.$.semantic.policy`.
    #[serde(rename = "policy", skip_serializing_if = "Option::is_none")]
    pub policy: Option<Private<String>>,
    /// `rules.$.semantic.examples`.
    #[serde(rename = "examples", skip_serializing_if = "Option::is_none")]
    pub examples: Option<Vec<NewChannelModerationSettingsRulesSemanticExamples>>,
    /// `rules.$.semantic.onUncertain`.
    #[serde(rename = "onUncertain", skip_serializing_if = "Option::is_none")]
    pub on_uncertain: Option<ChannelModerationSettingsRulesSemanticOnUncertainValue>,
}
/// Hydrated document fields.
#[derive(Clone, Debug, Deserialize)]
pub struct ChannelModerationSettingsRules {
    /// `rules.$.id`.
    #[serde(rename = "id")]
    pub id: String,
    /// `rules.$.type`.
    #[serde(rename = "type")]
    pub r#type: Open<ChannelModerationSettingsRulesTypeValue>,
    /// `rules.$.enabled`.
    #[serde(
        rename = "enabled",
        default = "read_default_channel_moderation_settings_rules_enabled"
    )]
    pub enabled: bool,
    /// `rules.$.firstOffense`.
    #[serde(
        rename = "firstOffense",
        default = "read_default_channel_moderation_settings_rules_first_offense"
    )]
    pub first_offense: ChannelModerationSettingsRulesFirstOffense,
    /// `rules.$.secondOffense`.
    #[serde(
        rename = "secondOffense",
        default = "read_default_channel_moderation_settings_rules_second_offense"
    )]
    pub second_offense: ChannelModerationSettingsRulesSecondOffense,
    /// `rules.$.thirdOffense`.
    #[serde(
        rename = "thirdOffense",
        default = "read_default_channel_moderation_settings_rules_third_offense"
    )]
    pub third_offense: ChannelModerationSettingsRulesThirdOffense,
    /// `rules.$.reason`.
    #[serde(
        rename = "reason",
        default = "read_default_channel_moderation_settings_rules_reason"
    )]
    pub reason: Private<String>,
    /// `rules.$.exemptUserLevel`.
    #[serde(
        rename = "exemptUserLevel",
        default = "read_default_channel_moderation_settings_rules_exempt_user_level"
    )]
    pub exempt_user_level: JsNumber,
    /// `rules.$.exemptExpression`.
    #[serde(rename = "exemptExpression", default)]
    pub exempt_expression: Option<ChannelModerationSettingsRulesExemptExpression>,
    /// `rules.$.capsThresholdMode`.
    #[serde(
        rename = "capsThresholdMode",
        default = "read_default_channel_moderation_settings_rules_caps_threshold_mode"
    )]
    pub caps_threshold_mode: Open<ChannelModerationSettingsRulesCapsThresholdModeValue>,
    /// `rules.$.minCapsCount`.
    #[serde(
        rename = "minCapsCount",
        default = "read_default_channel_moderation_settings_rules_min_caps_count"
    )]
    pub min_caps_count: JsNumber,
    /// `rules.$.maxCapsPercentage`.
    #[serde(
        rename = "maxCapsPercentage",
        default = "read_default_channel_moderation_settings_rules_max_caps_percentage"
    )]
    pub max_caps_percentage: JsNumber,
    /// `rules.$.minMessageLength`.
    #[serde(
        rename = "minMessageLength",
        default = "read_default_channel_moderation_settings_rules_min_message_length"
    )]
    pub min_message_length: JsNumber,
    /// `rules.$.allowlistDomains`.
    #[serde(
        rename = "allowlistDomains",
        default = "read_default_channel_moderation_settings_rules_allowlist_domains"
    )]
    pub allowlist_domains: Vec<Option<String>>,
    /// `rules.$.maxEmoteCount`.
    #[serde(
        rename = "maxEmoteCount",
        default = "read_default_channel_moderation_settings_rules_max_emote_count"
    )]
    pub max_emote_count: JsNumber,
    /// `rules.$.terms`.
    #[serde(
        rename = "terms",
        default = "read_default_channel_moderation_settings_rules_terms"
    )]
    pub terms: Private<Vec<Option<String>>>,
    /// `rules.$.variations`.
    #[serde(
        rename = "variations",
        default = "read_default_channel_moderation_settings_rules_variations"
    )]
    pub variations: Private<ChannelModerationSettingsRulesVariations>,
    /// `rules.$.patterns`.
    #[serde(
        rename = "patterns",
        default = "read_default_channel_moderation_settings_rules_patterns"
    )]
    pub patterns: Vec<ChannelModerationSettingsRulesPatterns>,
    /// `rules.$.semantic`.
    #[serde(
        rename = "semantic",
        default = "read_default_channel_moderation_settings_rules_semantic"
    )]
    pub semantic: ChannelModerationSettingsRulesSemantic,
}
/// Typed input fields.
#[derive(Clone, Debug, Serialize)]
pub struct NewChannelModerationSettingsRules {
    /// `rules.$.id`.
    #[serde(rename = "id")]
    pub id: String,
    /// `rules.$.type`.
    #[serde(rename = "type")]
    pub r#type: ChannelModerationSettingsRulesTypeValue,
    /// `rules.$.enabled`.
    #[serde(rename = "enabled", skip_serializing_if = "Option::is_none")]
    pub enabled: Option<bool>,
    /// `rules.$.firstOffense`.
    #[serde(rename = "firstOffense", skip_serializing_if = "Option::is_none")]
    pub first_offense: Option<NewChannelModerationSettingsRulesFirstOffense>,
    /// `rules.$.secondOffense`.
    #[serde(rename = "secondOffense", skip_serializing_if = "Option::is_none")]
    pub second_offense: Option<NewChannelModerationSettingsRulesSecondOffense>,
    /// `rules.$.thirdOffense`.
    #[serde(rename = "thirdOffense", skip_serializing_if = "Option::is_none")]
    pub third_offense: Option<NewChannelModerationSettingsRulesThirdOffense>,
    /// `rules.$.reason`.
    #[serde(rename = "reason", skip_serializing_if = "Option::is_none")]
    pub reason: Option<Private<String>>,
    /// `rules.$.exemptUserLevel`.
    #[serde(rename = "exemptUserLevel", skip_serializing_if = "Option::is_none")]
    pub exempt_user_level: Option<JsNumber>,
    /// `rules.$.exemptExpression`.
    #[serde(rename = "exemptExpression", skip_serializing_if = "Option::is_none")]
    pub exempt_expression: Option<ChannelModerationSettingsRulesExemptExpression>,
    /// `rules.$.capsThresholdMode`.
    #[serde(rename = "capsThresholdMode", skip_serializing_if = "Option::is_none")]
    pub caps_threshold_mode: Option<ChannelModerationSettingsRulesCapsThresholdModeValue>,
    /// `rules.$.minCapsCount`.
    #[serde(rename = "minCapsCount", skip_serializing_if = "Option::is_none")]
    pub min_caps_count: Option<JsNumber>,
    /// `rules.$.maxCapsPercentage`.
    #[serde(rename = "maxCapsPercentage", skip_serializing_if = "Option::is_none")]
    pub max_caps_percentage: Option<JsNumber>,
    /// `rules.$.minMessageLength`.
    #[serde(rename = "minMessageLength", skip_serializing_if = "Option::is_none")]
    pub min_message_length: Option<JsNumber>,
    /// `rules.$.allowlistDomains`.
    #[serde(rename = "allowlistDomains", skip_serializing_if = "Option::is_none")]
    pub allowlist_domains: Option<Vec<Option<String>>>,
    /// `rules.$.maxEmoteCount`.
    #[serde(rename = "maxEmoteCount", skip_serializing_if = "Option::is_none")]
    pub max_emote_count: Option<JsNumber>,
    /// `rules.$.terms`.
    #[serde(rename = "terms", skip_serializing_if = "Option::is_none")]
    pub terms: Option<Private<Vec<Option<String>>>>,
    /// `rules.$.variations`.
    #[serde(rename = "variations", skip_serializing_if = "Option::is_none")]
    pub variations: Option<Private<ChannelModerationSettingsRulesVariations>>,
    /// `rules.$.patterns`.
    #[serde(rename = "patterns", skip_serializing_if = "Option::is_none")]
    pub patterns: Option<Vec<NewChannelModerationSettingsRulesPatterns>>,
    /// `rules.$.semantic`.
    #[serde(rename = "semantic", skip_serializing_if = "Option::is_none")]
    pub semantic: Option<NewChannelModerationSettingsRulesSemantic>,
}
/// Hydrated document fields.
#[derive(Clone, Debug, Deserialize)]
pub struct ChannelModerationSettings {
    /// `_id`.
    #[serde(rename = "_id")]
    pub id: bson::oid::ObjectId,
    /// `channelID`.
    #[serde(rename = "channelID")]
    pub channel_id: String,
    /// `channel`.
    #[serde(
        rename = "channel",
        default = "read_default_channel_moderation_settings_channel"
    )]
    pub channel: String,
    /// `enabled`.
    #[serde(
        rename = "enabled",
        default = "read_default_channel_moderation_settings_enabled"
    )]
    pub enabled: bool,
    /// `spamProtection`.
    #[serde(
        rename = "spamProtection",
        default = "read_default_channel_moderation_settings_spam_protection"
    )]
    pub spam_protection: ChannelModerationSettingsSpamProtection,
    /// `offenseWindowSeconds`.
    #[serde(
        rename = "offenseWindowSeconds",
        default = "read_default_channel_moderation_settings_offense_window_seconds"
    )]
    pub offense_window_seconds: JsNumber,
    /// `rules`.
    #[serde(
        rename = "rules",
        default = "read_default_channel_moderation_settings_rules"
    )]
    pub rules: Vec<ChannelModerationSettingsRules>,
    /// `settingsVersion`.
    #[serde(
        rename = "settingsVersion",
        default = "read_default_channel_moderation_settings_settings_version"
    )]
    pub settings_version: JsNumber,
    /// `createdAt`.
    #[serde(rename = "createdAt", default)]
    pub created_at: Option<JsDate>,
    /// `updatedAt`.
    #[serde(rename = "updatedAt", default)]
    pub updated_at: Option<JsDate>,
}
/// Typed input fields.
#[derive(Clone, Debug, Serialize)]
pub struct NewChannelModerationSettings {
    /// `channelID`.
    #[serde(rename = "channelID")]
    pub channel_id: String,
    /// `channel`.
    #[serde(rename = "channel", skip_serializing_if = "Option::is_none")]
    pub channel: Option<String>,
    /// `enabled`.
    #[serde(rename = "enabled", skip_serializing_if = "Option::is_none")]
    pub enabled: Option<bool>,
    /// `spamProtection`.
    #[serde(rename = "spamProtection", skip_serializing_if = "Option::is_none")]
    pub spam_protection: Option<NewChannelModerationSettingsSpamProtection>,
    /// `offenseWindowSeconds`.
    #[serde(
        rename = "offenseWindowSeconds",
        skip_serializing_if = "Option::is_none"
    )]
    pub offense_window_seconds: Option<JsNumber>,
    /// `rules`.
    #[serde(rename = "rules", skip_serializing_if = "Option::is_none")]
    pub rules: Option<Vec<NewChannelModerationSettingsRules>>,
    /// `settingsVersion`.
    #[serde(rename = "settingsVersion", skip_serializing_if = "Option::is_none")]
    pub settings_version: Option<JsNumber>,
}
/// Hidden paths.
pub const HIDDEN: &[&str] = &[];
/// Private paths.
pub const PRIVATE: &[&str] = &[
    "rules.$.reason",
    "rules.$.terms",
    "rules.$.patterns.$.source",
    "rules.$.semantic.policy",
    "rules.$.semantic.examples.$.message",
    "rules.$.variations",
];
/// Declared indexes.
pub const INDEXES: &[IndexSpec] = &[IndexSpec::on(&[("channelID", 1)]).unique()];
/// Schema validators.
pub const RULES: &[Rule] = &[
    Rule::required("channelID"),
    Rule::min("spamProtection.thresholdPercent", 80.0),
    Rule::max("spamProtection.thresholdPercent", 100.0),
    Rule::min("offenseWindowSeconds", 60.0),
    Rule::max("offenseWindowSeconds", 86400.0),
    Rule::required("rules.$.id"),
    Rule::required("rules.$.type"),
    Rule::one_of(
        "rules.$.type",
        &["caps", "links", "emote_spam", "blacklist"],
    ),
    Rule::one_of(
        "rules.$.firstOffense.action",
        &["off", "warn", "delete", "timeout", "ban"],
    ),
    Rule::min("rules.$.firstOffense.timeoutSeconds", 1.0),
    Rule::max("rules.$.firstOffense.timeoutSeconds", 1209600.0),
    Rule::one_of(
        "rules.$.secondOffense.action",
        &["off", "warn", "delete", "timeout", "ban"],
    ),
    Rule::min("rules.$.secondOffense.timeoutSeconds", 1.0),
    Rule::max("rules.$.secondOffense.timeoutSeconds", 1209600.0),
    Rule::one_of(
        "rules.$.thirdOffense.action",
        &["off", "warn", "delete", "timeout", "ban"],
    ),
    Rule::min("rules.$.thirdOffense.timeoutSeconds", 1.0),
    Rule::max("rules.$.thirdOffense.timeoutSeconds", 1209600.0),
    Rule::max_length("rules.$.reason", 500),
    Rule::min("rules.$.exemptUserLevel", 1.0),
    Rule::max("rules.$.exemptUserLevel", 10.0),
    Rule::one_of("rules.$.capsThresholdMode", &["count", "percentage"]),
    Rule::min("rules.$.minCapsCount", 1.0),
    Rule::max("rules.$.minCapsCount", 500.0),
    Rule::min("rules.$.maxCapsPercentage", 1.0),
    Rule::max("rules.$.maxCapsPercentage", 100.0),
    Rule::min("rules.$.minMessageLength", 1.0),
    Rule::max("rules.$.minMessageLength", 500.0),
    Rule::min("rules.$.maxEmoteCount", 1.0),
    Rule::max("rules.$.maxEmoteCount", 100.0),
    Rule::min("rules.$.semantic.thresholdPercent", 0.0),
    Rule::max("rules.$.semantic.thresholdPercent", 100.0),
    Rule::max_length("rules.$.semantic.policy", 2000),
    Rule::one_of("rules.$.semantic.onUncertain", &["allow_and_log"]),
];
/// Read constraints.
pub const READ_NEEDS: &[ReadNeed] = &[
    ReadNeed::value("channelID"),
    ReadNeed::not_null("channel"),
    ReadNeed::not_null("enabled"),
    ReadNeed::not_null("spamProtection.enabled"),
    ReadNeed::not_null("spamProtection.reviewAllMessages"),
    ReadNeed::not_null("spamProtection.categories"),
    ReadNeed::not_null("spamProtection.exemptTags"),
    ReadNeed::not_null("spamProtection.thresholdPercent"),
    ReadNeed::not_null("spamProtection"),
    ReadNeed::not_null("offenseWindowSeconds"),
    ReadNeed::value("rules.$.id"),
    ReadNeed::value("rules.$.type"),
    ReadNeed::not_null("rules.$.enabled"),
    ReadNeed::not_null("rules.$.firstOffense.action"),
    ReadNeed::not_null("rules.$.firstOffense.timeoutSeconds"),
    ReadNeed::not_null("rules.$.firstOffense"),
    ReadNeed::not_null("rules.$.secondOffense.action"),
    ReadNeed::not_null("rules.$.secondOffense.timeoutSeconds"),
    ReadNeed::not_null("rules.$.secondOffense"),
    ReadNeed::not_null("rules.$.thirdOffense.action"),
    ReadNeed::not_null("rules.$.thirdOffense.timeoutSeconds"),
    ReadNeed::not_null("rules.$.thirdOffense"),
    ReadNeed::not_null("rules.$.reason"),
    ReadNeed::not_null("rules.$.exemptUserLevel"),
    ReadNeed::not_null("rules.$.capsThresholdMode"),
    ReadNeed::not_null("rules.$.minCapsCount"),
    ReadNeed::not_null("rules.$.maxCapsPercentage"),
    ReadNeed::not_null("rules.$.minMessageLength"),
    ReadNeed::not_null("rules.$.allowlistDomains"),
    ReadNeed::not_null("rules.$.maxEmoteCount"),
    ReadNeed::not_null("rules.$.terms"),
    ReadNeed::not_null("rules.$.patterns"),
    ReadNeed::not_null("rules.$.semantic.enabled"),
    ReadNeed::not_null("rules.$.semantic.thresholdPercent"),
    ReadNeed::not_null("rules.$.semantic.policy"),
    ReadNeed::not_null("rules.$.semantic.examples"),
    ReadNeed::not_null("rules.$.semantic.onUncertain"),
    ReadNeed::not_null("rules.$.semantic"),
    ReadNeed::not_null("rules"),
    ReadNeed::not_null("settingsVersion"),
];
/// Registry entry.
pub static INFO: CollectionInfo = CollectionInfo {
    name: COLLECTION,
    model: "channel_moderation_settings",
    source: "dimabot/src/schemas/channel_moderation_settings.schema.ts",
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
    decode: decode_boxed::<ChannelModerationSettings>,
};
impl NewChannelModerationSettings {
    /// Input before schema defaults and validation.
    pub fn to_document(&self) -> Result<Document, ModelError> {
        Ok(bson::serialize_to_document(self)?)
    }
    /// Validated insert through the collection write guard.
    pub fn prepare(&self, ctx: &mut WriteContext) -> Result<PreparedInsert, ModelError> {
        INFO.prepare_create(&self.to_document()?, ctx)
    }
}
