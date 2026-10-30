//! Decision persistence. Typed values describe the TypeScript interface; the
//! repository deliberately preserves the looser Mongoose Mixed/String contract.
use super::{
    Field, FieldDefault as D, FieldType as T, SchemaDefinition, SchemaIndex, SchemaRepository,
};
use crate::{schemas::channel_moderation_settings::IModerationRule, utils::js_string::JsString};
use mongodb::{
    Database,
    bson::{Bson, DateTime, Document, doc},
};
use std::sync::OnceLock;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DecisionMode {
    Literal,
    Regex,
    Semantic,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ReviewSource {
    Rule,
    FirstMessage,
    SpamContinuous,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DecisionState {
    Pending,
    Processing,
    Completed,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DecisionVerdict {
    Allow,
    Violation,
    Uncertain,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ChargeStatus {
    None,
    Pending,
    Recorded,
}
#[derive(Clone, Debug, PartialEq)]
pub struct ModerationContextMessage {
    pub message_id: JsString,
    pub username: JsString,
    pub message: JsString,
    pub timestamp: f64,
    pub is_broadcaster: Option<bool>,
}
#[derive(Clone, Debug, PartialEq)]
pub struct ModerationMatch {
    pub matcher_id: JsString,
    pub text: JsString,
    pub start: f64,
    pub end: f64,
}
#[derive(Clone, Debug, PartialEq)]
pub struct DecisionCharge {
    pub status: ChargeStatus,
    pub credits: f64,
    pub billable_cost_usd: Option<f64>,
    pub pricing_version: Option<JsString>,
    pub usd_per_million_input_tokens: Option<f64>,
    pub external_id: JsString,
    pub customer_id: JsString,
}
#[derive(Clone, Debug, PartialEq)]
pub struct DecisionConsequence {
    pub status: JsString,
    pub action: Option<JsString>,
    pub offense_number: Option<f64>,
    pub success: Option<bool>,
    pub error_message: Option<Option<JsString>>,
}
#[derive(Clone, Debug, PartialEq)]
pub struct DecisionFeedback {
    pub label: DecisionVerdict,
    pub reviewer_id: JsString,
    pub reviewed_at: DateTime,
}
#[derive(Clone, Debug)]
pub struct IModerationDecision {
    pub id: JsString,
    pub channel_id: JsString,
    pub user_id: JsString,
    pub username: JsString,
    pub message_id: JsString,
    pub message_text: JsString,
    pub rule_id: JsString,
    pub rule: IModerationRule,
    pub settings_version: f64,
    pub matches: Vec<ModerationMatch>,
    pub context: Vec<ModerationContextMessage>,
    pub mode: DecisionMode,
    pub review_source: Option<ReviewSource>,
    pub state: DecisionState,
    pub verdict: DecisionVerdict,
    pub status: JsString,
    pub model: JsString,
    pub provider: JsString,
    pub decision_policy_version: JsString,
    pub scores: Option<Document>,
    pub provider_request_id: JsString,
    pub input_tokens: f64,
    pub cost: f64,
    pub latency_ms: f64,
    pub charge: DecisionCharge,
    pub consequence: DecisionConsequence,
    pub feedback: Option<DecisionFeedback>,
    pub deadline: DateTime,
    pub created_at: DateTime,
    pub expires_at: DateTime,
}

pub fn schema() -> &'static SchemaDefinition {
    static VALUE: OnceLock<SchemaDefinition> = OnceLock::new();
    VALUE.get_or_init(|| SchemaDefinition {
        model: "moderation_decision",
        collection: "moderation_decisions",
        string_id: true,
        version_key: false,
        write_concern_journaled: false,
        timestamps: None,
        save_clock_field: None,
        fields: vec![
            Field::new("_id", T::String),
            Field::new("channelID", T::String).required(),
            Field::new("userID", T::String),
            Field::new("username", T::String),
            Field::new("messageID", T::String),
            Field::new("messageText", T::String),
            Field::new("ruleID", T::String),
            Field::new("rule", T::Mixed).minimize(),
            Field::new("settingsVersion", T::Number),
            Field::new("matches", T::Array(Box::new(T::Mixed)))
                .default(D::Array)
                .minimize(),
            Field::new("context", T::Array(Box::new(T::Mixed)))
                .default(D::Array)
                .minimize(),
            Field::new("mode", T::String),
            Field::new("reviewSource", T::String)
                .enumeration(&["rule", "first_message", "spam_continuous"])
                .default(D::String("rule")),
            Field::new("state", T::String).default(D::String("pending")),
            Field::new("verdict", T::String).default(D::String("uncertain")),
            Field::new("status", T::String).default(D::String("pending")),
            Field::new("model", T::String).default(D::String("")),
            Field::new("provider", T::String).default(D::String("")),
            Field::new("decisionPolicyVersion", T::String),
            Field::new("scores", T::Mixed).default(D::Null).minimize(),
            Field::new("providerRequestID", T::String).default(D::String("")),
            Field::new("inputTokens", T::Number).default(D::Number(0.0)),
            Field::new("cost", T::Number).default(D::Number(0.0)),
            Field::new("latencyMs", T::Number).default(D::Number(0.0)),
            Field::new("charge", T::Mixed)
                .default(D::Value(Bson::Document(
                    doc! {"status":"none","credits":0,"externalID":"","customerID":""},
                )))
                .minimize(),
            Field::new("consequence", T::Mixed)
                .default(D::Value(Bson::Document(doc! {"status":"none"})))
                .minimize(),
            Field::new("feedback", T::Mixed).default(D::Null).minimize(),
            Field::new("deadline", T::Date),
            Field::new("createdAt", T::Date).default(D::Now),
            Field::new("expiresAt", T::Date).required(),
        ],
        indexes: vec![
            SchemaIndex::new(doc! {"expiresAt":1}).ttl(0),
            SchemaIndex::new(doc! {"channelID":1,"createdAt":-1}),
            SchemaIndex::new(doc! {"state":1,"deadline":1,"createdAt":1}),
            SchemaIndex::new(doc! {"charge.status":1,"createdAt":1}),
        ],
    })
}
pub fn get_moderation_decision_model(database: &Database) -> SchemaRepository {
    schema().repository(database)
}
