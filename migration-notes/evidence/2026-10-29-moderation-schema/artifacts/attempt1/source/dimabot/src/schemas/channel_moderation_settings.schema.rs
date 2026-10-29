//! Channel moderation settings types and source-default rule builder.
//!
//! Explicit caller-owned Mongo persistence. Construction does not connect.
use super::{
    Field, FieldDefault as D, FieldType as T, SchemaDefinition, SchemaIndex, SchemaRepository,
};
pub use crate::utils::moderation::caps::CapsThresholdMode;
use crate::utils::{
    js_string::JsString,
    moderation::spam_categories::{
        DEFAULT_SPAM_CATEGORIES, DEFAULT_SPAM_EXEMPT_TAGS, DEFAULT_SPAM_THRESHOLD, SPAM_CATEGORIES,
        SPAM_EXEMPT_TAGS, SpamCategory, SpamProtection,
    },
};
use mongodb::{
    Database,
    bson::{Bson, DateTime, doc},
};
use std::sync::{Arc, Mutex, OnceLock};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ModerationRuleType {
    Caps,
    Links,
    EmoteSpam,
    Blacklist,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ModerationAction {
    Off,
    Warn,
    Delete,
    Timeout,
    Ban,
}
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct IModerationOffenseStep {
    pub action: ModerationAction,
    pub timeout_seconds: f64,
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum PatternBoundary {
    WholeWord,
    Anywhere,
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ModerationPattern {
    pub id: JsString,
    pub source: JsString,
    pub boundary: PatternBoundary,
    pub ignore_case: bool,
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum SemanticLabel {
    Allow,
    Violation,
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SemanticExample {
    pub message: JsString,
    pub label: SemanticLabel,
}
#[derive(Clone, Debug, PartialEq)]
pub struct SemanticPolicy {
    pub categories: Option<Vec<SpamCategory>>,
    pub broadcaster_invitation: Option<bool>,
    pub enabled: bool,
    pub threshold_percent: Option<f64>,
    pub policy: JsString,
    pub examples: Vec<SemanticExample>,
    // The TypeScript union has exactly one member: 'allow_and_log'.
    pub on_uncertain: OnUncertain,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum OnUncertain {
    AllowAndLog,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum VariationMode {
    Off,
    Common,
    Broad,
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct GeneratedVariation {
    pub term: JsString,
    pub spellings: Vec<JsString>,
    pub pattern: ModerationPattern,
    pub version: JsString,
    pub allow_spaces: Option<bool>,
    pub symbol_version: Option<JsString>,
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct VariationOverride {
    pub term: JsString,
    pub source: JsString,
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ModerationVariations {
    pub mode: VariationMode,
    pub entries: Vec<GeneratedVariation>,
    pub overrides: Option<Vec<VariationOverride>>,
    pub allow_spaces: Option<bool>,
}

/// A BSON Mixed value intentionally retains malformed permission expressions;
/// the source does not validate it in the schema. `None` is an absent field.
pub type PermissionExpressionMixed = Bson;
#[derive(Clone, Debug)]
pub struct IModerationRule {
    pub id: JsString,
    pub rule_type: ModerationRuleType,
    pub enabled: bool,
    // Source's builder uses a shallow spread: these objects and arrays are
    // shared among its four rules, but fresh across builder invocations.
    pub first_offense: Arc<Mutex<IModerationOffenseStep>>,
    pub second_offense: Arc<Mutex<IModerationOffenseStep>>,
    pub third_offense: Arc<Mutex<IModerationOffenseStep>>,
    pub reason: JsString,
    pub exempt_user_level: f64,
    pub exempt_expression: Option<PermissionExpressionMixed>,
    pub caps_threshold_mode: CapsThresholdMode,
    pub min_caps_count: f64,
    pub max_caps_percentage: f64,
    pub min_message_length: f64,
    pub allowlist_domains: Arc<Mutex<Vec<JsString>>>,
    pub max_emote_count: f64,
    pub terms: Arc<Mutex<Vec<JsString>>>,
    pub patterns: Option<Vec<ModerationPattern>>,
    pub semantic: Option<SemanticPolicy>,
    pub variations: Option<ModerationVariations>,
}
#[derive(Clone, Debug)]
pub struct IChannelModerationSettings {
    pub channel_id: JsString,
    pub channel: JsString,
    pub enabled: bool,
    pub spam_protection: Option<SpamProtection>,
    pub offense_window_seconds: f64,
    pub rules: Vec<IModerationRule>,
    pub settings_version: f64,
    pub created_at: DateTime,
    pub updated_at: DateTime,
}
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct ModerationOffenseDefaults {
    pub first: IModerationOffenseStep,
    pub second: IModerationOffenseStep,
    pub third: IModerationOffenseStep,
}
pub const MODERATION_OFFENSE_DEFAULTS: ModerationOffenseDefaults = ModerationOffenseDefaults {
    first: IModerationOffenseStep {
        action: ModerationAction::Warn,
        timeout_seconds: 60.0,
    },
    second: IModerationOffenseStep {
        action: ModerationAction::Delete,
        timeout_seconds: 60.0,
    },
    third: IModerationOffenseStep {
        action: ModerationAction::Timeout,
        timeout_seconds: 60.0,
    },
};
#[derive(Clone, Copy, Debug)]
pub struct ModerationRuleDefaults {
    pub reason: &'static str,
    pub exempt_user_level: f64,
    pub caps_threshold_mode: CapsThresholdMode,
    pub min_caps_count: f64,
    pub max_caps_percentage: f64,
    pub min_message_length: f64,
    pub max_emote_count: f64,
}
pub const MODERATION_RULE_DEFAULTS: ModerationRuleDefaults = ModerationRuleDefaults {
    reason: "Message blocked by channel moderation",
    exempt_user_level: 7.0,
    caps_threshold_mode: CapsThresholdMode::Count,
    min_caps_count: 8.0,
    max_caps_percentage: 70.0,
    min_message_length: 10.0,
    max_emote_count: 10.0,
};
#[derive(Clone, Copy, Debug)]
pub struct ModerationSettingsDefaults {
    pub enabled: bool,
    pub offense_window_seconds: f64,
    pub settings_version: f64,
}
pub const MODERATION_SETTINGS_DEFAULTS: ModerationSettingsDefaults = ModerationSettingsDefaults {
    enabled: false,
    offense_window_seconds: 3600.0,
    settings_version: 1.0,
};
pub const MAX_TIMEOUT_SECONDS: u32 = 1_209_600;
pub const MIN_OFFENSE_WINDOW_SECONDS: u32 = 60;
pub const MAX_OFFENSE_WINDOW_SECONDS: u32 = 86_400;
pub const MAX_RULES_PER_CHANNEL: usize = 20;
pub const MAX_BLACKLIST_TERMS: usize = 200;
pub const MAX_ALLOWLIST_DOMAINS: usize = 50;

pub fn build_default_moderation_rules() -> Vec<IModerationRule> {
    let first = Arc::new(Mutex::new(MODERATION_OFFENSE_DEFAULTS.first));
    let second = Arc::new(Mutex::new(MODERATION_OFFENSE_DEFAULTS.second));
    let third = Arc::new(Mutex::new(MODERATION_OFFENSE_DEFAULTS.third));
    let allowlist = Arc::new(Mutex::new(Vec::new()));
    let terms = Arc::new(Mutex::new(Vec::new()));
    [
        (
            ModerationRuleType::Caps,
            true,
            "Please do not use so many caps",
        ),
        (ModerationRuleType::Links, true, "Please do not post links"),
        (
            ModerationRuleType::EmoteSpam,
            true,
            "Please do not spam emotes",
        ),
        (
            ModerationRuleType::Blacklist,
            false,
            "You used a blocked word or phrase",
        ),
    ]
    .into_iter()
    .map(|(rule_type, enabled, reason)| IModerationRule {
        id: JsString::from(uuid::Uuid::new_v4().to_string()),
        rule_type,
        enabled,
        first_offense: first.clone(),
        second_offense: second.clone(),
        third_offense: third.clone(),
        reason: JsString::from_static(reason),
        exempt_user_level: MODERATION_RULE_DEFAULTS.exempt_user_level,
        exempt_expression: None,
        caps_threshold_mode: MODERATION_RULE_DEFAULTS.caps_threshold_mode,
        min_caps_count: MODERATION_RULE_DEFAULTS.min_caps_count,
        max_caps_percentage: MODERATION_RULE_DEFAULTS.max_caps_percentage,
        min_message_length: MODERATION_RULE_DEFAULTS.min_message_length,
        allowlist_domains: allowlist.clone(),
        max_emote_count: MODERATION_RULE_DEFAULTS.max_emote_count,
        terms: terms.clone(),
        patterns: None,
        semantic: None,
        variations: None,
    })
    .collect()
}

const CATEGORY_VALUES: &[&str] = &[
    SPAM_CATEGORIES[0].as_str(),
    SPAM_CATEGORIES[1].as_str(),
    SPAM_CATEGORIES[2].as_str(),
    SPAM_CATEGORIES[3].as_str(),
    SPAM_CATEGORIES[4].as_str(),
];
const EXEMPT_VALUES: &[&str] = &[
    SPAM_EXEMPT_TAGS[0].as_str(),
    SPAM_EXEMPT_TAGS[1].as_str(),
    SPAM_EXEMPT_TAGS[2].as_str(),
    SPAM_EXEMPT_TAGS[3].as_str(),
    SPAM_EXEMPT_TAGS[4].as_str(),
    SPAM_EXEMPT_TAGS[5].as_str(),
];
fn subdocument(fields: Vec<Field>) -> T {
    T::Subdocument {
        fields,
        generate_id: false,
    }
}
fn offense() -> T {
    subdocument(vec![
        Field::new("action", T::String)
            .enumeration(&["off", "warn", "delete", "timeout", "ban"])
            .default(D::String("warn")),
        Field::new("timeoutSeconds", T::Number)
            .default(D::Number(60.0))
            .min(1.0)
            .max(MAX_TIMEOUT_SECONDS as f64),
    ])
}
fn array(kind: T) -> T {
    T::Array(Box::new(kind))
}
fn rule_fields() -> Vec<Field> {
    let pattern = subdocument(vec![
        Field::new("id", T::String),
        Field::new("source", T::String),
        Field::new("boundary", T::String),
        Field::new("ignoreCase", T::Boolean),
    ]);
    let example = subdocument(vec![
        Field::new("message", T::String),
        Field::new("label", T::String),
    ]);
    let semantic = subdocument(vec![
        Field::new("enabled", T::Boolean).default(D::Boolean(false)),
        Field::new("thresholdPercent", T::Number)
            .default(D::Number(85.0))
            .min(0.0)
            .max(100.0),
        Field::new("policy", T::String)
            .default(D::String(""))
            .max_utf16(2000),
        Field::new("examples", array(example)).default(D::Array),
        Field::new("onUncertain", T::String)
            .enumeration(&["allow_and_log"])
            .default(D::String("allow_and_log")),
    ]);
    vec![
        Field::new("id", T::String).required(),
        Field::new("type", T::String)
            .enumeration(&["caps", "links", "emote_spam", "blacklist"])
            .required(),
        Field::new("enabled", T::Boolean).default(D::Boolean(true)),
        Field::new("firstOffense", offense()).default(D::Value(Bson::Document(
            doc! {"action":"warn","timeoutSeconds":60},
        ))),
        Field::new("secondOffense", offense()).default(D::Value(Bson::Document(
            doc! {"action":"delete","timeoutSeconds":60},
        ))),
        Field::new("thirdOffense", offense()).default(D::Value(Bson::Document(
            doc! {"action":"timeout","timeoutSeconds":60},
        ))),
        Field::new("reason", T::String)
            .default(D::String(MODERATION_RULE_DEFAULTS.reason))
            .max_utf16(500),
        Field::new("exemptUserLevel", T::Number)
            .default(D::Number(7.0))
            .min(1.0)
            .max(10.0),
        Field::new("exemptExpression", T::Mixed).default(D::Null),
        Field::new("capsThresholdMode", T::String)
            .enumeration(&["count", "percentage"])
            .default(D::String("count")),
        Field::new("minCapsCount", T::Number)
            .default(D::Number(8.0))
            .min(1.0)
            .max(500.0),
        Field::new("maxCapsPercentage", T::Number)
            .default(D::Number(70.0))
            .min(1.0)
            .max(100.0),
        Field::new("minMessageLength", T::Number)
            .default(D::Number(10.0))
            .min(1.0)
            .max(500.0),
        Field::new("allowlistDomains", array(T::String)).default(D::Array),
        Field::new("maxEmoteCount", T::Number)
            .default(D::Number(10.0))
            .min(1.0)
            .max(100.0),
        Field::new("terms", array(T::String)).default(D::Array),
        Field::new("variations", T::Mixed)
            .default(D::Value(Bson::Document(doc! {"mode":"off","entries":[]}))),
        Field::new("patterns", array(pattern)).default(D::Array),
        Field::new("semantic", semantic).default(D::Object),
    ]
}
fn strings<I: Iterator<Item = &'static str>>(iter: I) -> Bson {
    Bson::Array(iter.map(|s| Bson::String(s.into())).collect())
}
fn spam_protection() -> T {
    subdocument(vec![
        Field::new("enabled", T::Boolean).default(D::Boolean(true)),
        Field::new("reviewAllMessages", T::Boolean).default(D::Boolean(false)),
        Field::new(
            "categories",
            T::ArrayElement(Box::new(
                Field::new("", T::String).enumeration(CATEGORY_VALUES),
            )),
        )
        .default(D::Value(strings(
            DEFAULT_SPAM_CATEGORIES.iter().map(|x| x.as_str()),
        ))),
        Field::new(
            "exemptTags",
            T::ArrayElement(Box::new(
                Field::new("", T::String).enumeration(EXEMPT_VALUES),
            )),
        )
        .default(D::Value(strings(
            DEFAULT_SPAM_EXEMPT_TAGS.iter().map(|x| x.as_str()),
        ))),
        Field::new("thresholdPercent", T::Number)
            .default(D::Number(DEFAULT_SPAM_THRESHOLD))
            .min(80.0)
            .max(100.0),
    ])
}

pub fn schema() -> &'static SchemaDefinition {
    static VALUE: OnceLock<SchemaDefinition> = OnceLock::new();
    VALUE.get_or_init(|| SchemaDefinition {
        model: "channel_moderation_settings",
        collection: "channel_moderation_settings",
        string_id: false,
        version_key: true,
        write_concern_journaled: false,
        timestamps: Some(("createdAt", "updatedAt")),
        save_clock_field: None,
        indexes: vec![SchemaIndex::new(doc! {"channelID":1}).unique()],
        fields: vec![
            Field::new("channelID", T::String).required(),
            Field::new("channel", T::String).default(D::String("")),
            Field::new("enabled", T::Boolean)
                .default(D::Boolean(MODERATION_SETTINGS_DEFAULTS.enabled)),
            Field::new("spamProtection", spam_protection()).default(D::Value(Bson::Document(
                doc! {"enabled":true,"reviewAllMessages":false},
            ))),
            Field::new("offenseWindowSeconds", T::Number)
                .default(D::Number(
                    MODERATION_SETTINGS_DEFAULTS.offense_window_seconds,
                ))
                .min(MIN_OFFENSE_WINDOW_SECONDS as f64)
                .max(MAX_OFFENSE_WINDOW_SECONDS as f64),
            Field::new("rules", array(subdocument(rule_fields()))).default(D::Array),
            Field::new("settingsVersion", T::Number)
                .default(D::Number(MODERATION_SETTINGS_DEFAULTS.settings_version)),
        ],
    })
}
/// Construct the concrete driver-backed model against the caller's database.
pub fn get_channel_moderation_settings_model(database: &Database) -> SchemaRepository {
    schema().repository(database)
}
