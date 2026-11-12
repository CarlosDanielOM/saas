//! `moderation_decisions`: reference `dimabot/src/schemas/moderation_decision.schema.ts`.
//! No hooks; hidden paths: none. Options and indexes are declared below.
//! utils/moderation/decisions.ts:14 builds a deterministic string _id and upserts an input
//! constructed by handlers/moderation.handler.ts; semantic_worker.ts writes typed outcomes.
//! server/routes/moderation.route.ts:169 only reads decisions; no dashboard/assistant writes,
//! no unchecked client-fed paths (0), no saves or runValidators. Legacy scores/feedback null,
//! optional review metadata missing, mixed cost int32/double preserved. Rule, matches, context,
//! charge and consequence belong to moderation/billing and remain raw. _id uniqueness already
//! exists on MongoDB's primary index and prevents duplicate application; no extra unique index.
//! Strict server-only nulls/removals in READ_NEEDS are refused; no stored nulls there.
//! BSON numbers preserve int32/int64/double on writes; reads use JsNumber without rounding.

use crate::Private;
use crate::decode::decode_boxed;
use crate::enums::Open;
use crate::{ClientNulls, CollectionInfo, Hooks, IndexSpec, ModelError, ReadNeed, Rule};
use bson::{Bson, Document};
use dima_store::mongo::schema::{DefaultValue as D, Field, Schema};
use dima_store::mongo::{
    WriteContext, date::JsDate, id::IdType, insert::PreparedInsert, number::JsNumber,
};
use serde::{Deserialize, Serialize};
/// Collection name.
pub const COLLECTION: &str = "moderation_decisions";
/// Raw `rule` content owned by its feature domain.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(transparent)]
pub struct ModerationDecisionRule(pub Bson);
/// Raw `matches` content owned by its feature domain.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(transparent)]
pub struct ModerationDecisionMatches(pub Vec<Bson>);
/// Raw `context` content owned by its feature domain.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(transparent)]
pub struct ModerationDecisionContext(pub Vec<Bson>);
crate::enums::str_enum! { /// Schema enumeration.
pub enum ModerationDecisionReviewSourceValue {/// rule
Rule = "rule",/// first_message
FirstMessage = "first_message",/// spam_continuous
SpamContinuous = "spam_continuous"}}
/// Raw `scores` content owned by its feature domain.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(transparent)]
pub struct ModerationDecisionScores(pub Bson);
/// Raw `charge` content owned by its feature domain.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(transparent)]
pub struct ModerationDecisionCharge(pub Bson);
/// Raw `consequence` content owned by its feature domain.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(transparent)]
pub struct ModerationDecisionConsequence(pub Bson);
/// Raw `feedback` content owned by its feature domain.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(transparent)]
pub struct ModerationDecisionFeedback(pub Bson);
fn default_bson_schema_charge(_: i64) -> Bson {
    Bson::Document(
        bson::doc! {"status":Bson::String("none".into()),"credits":Bson::Int32(0),"externalID":Bson::String("".into()),"customerID":Bson::String("".into())},
    )
}
fn default_bson_schema_consequence(_: i64) -> Bson {
    Bson::Document(bson::doc! {"status":Bson::String("none".into())})
}
fn read_default_moderation_decision_matches() -> Private<ModerationDecisionMatches> {
    Private::new(ModerationDecisionMatches(vec![]))
}
fn read_default_moderation_decision_context() -> Private<ModerationDecisionContext> {
    Private::new(ModerationDecisionContext(vec![]))
}
fn read_default_moderation_decision_review_source() -> Open<ModerationDecisionReviewSourceValue> {
    Open::from(ModerationDecisionReviewSourceValue::Rule)
}
fn read_default_moderation_decision_state() -> String {
    "pending".into()
}
fn read_default_moderation_decision_verdict() -> String {
    "uncertain".into()
}
fn read_default_moderation_decision_status() -> String {
    "pending".into()
}
fn read_default_moderation_decision_model() -> String {
    "".into()
}
fn read_default_moderation_decision_provider() -> String {
    "".into()
}
fn read_default_moderation_decision_provider_request_id() -> String {
    "".into()
}
fn read_default_moderation_decision_input_tokens() -> JsNumber {
    JsNumber(0.0)
}
fn read_default_moderation_decision_cost() -> JsNumber {
    JsNumber(0.0)
}
fn read_default_moderation_decision_latency_ms() -> JsNumber {
    JsNumber(0.0)
}
fn read_default_moderation_decision_charge() -> Private<ModerationDecisionCharge> {
    Private::new(ModerationDecisionCharge(Bson::Document(
        bson::doc! {"status":Bson::String("none".into()),"credits":Bson::Int32(0),"externalID":Bson::String("".into()),"customerID":Bson::String("".into())},
    )))
}
fn read_default_moderation_decision_consequence() -> Private<ModerationDecisionConsequence> {
    Private::new(ModerationDecisionConsequence(Bson::Document(
        bson::doc! {"status":Bson::String("none".into())},
    )))
}
/// Frozen schema.
pub static SCHEMA: Schema = Schema::new(&[
    Field::string("_id"),
    Field::string("channelID"),
    Field::string("userID"),
    Field::string("username"),
    Field::string("messageID"),
    Field::string("messageText"),
    Field::string("ruleID"),
    Field::mixed("rule"),
    Field::number("settingsVersion"),
    Field::mixed_array("matches").default(D::EmptyArray),
    Field::mixed_array("context").default(D::EmptyArray),
    Field::string("mode"),
    Field::string("reviewSource").default(D::Str("rule")),
    Field::string("state").default(D::Str("pending")),
    Field::string("verdict").default(D::Str("uncertain")),
    Field::string("status").default(D::Str("pending")),
    Field::string("model").default(D::Str("")),
    Field::string("provider").default(D::Str("")),
    Field::string("decisionPolicyVersion"),
    Field::mixed("scores").default(D::Null),
    Field::string("providerRequestID").default(D::Str("")),
    Field::number("inputTokens").default(D::Int(0)),
    Field::number("cost").default(D::Int(0)),
    Field::number("latencyMs").default(D::Int(0)),
    Field::mixed("charge").default_fn(D::With(default_bson_schema_charge)),
    Field::mixed("consequence").default_fn(D::With(default_bson_schema_consequence)),
    Field::mixed("feedback").default(D::Null),
    Field::date("deadline"),
    Field::date("createdAt").default_fn(D::Now),
    Field::date("expiresAt"),
])
.declared_id()
.no_version_key();
/// Hydrated document fields.
#[derive(Clone, Debug, Deserialize)]
pub struct ModerationDecision {
    /// `_id`.
    #[serde(rename = "_id")]
    pub id: String,
    /// `channelID`.
    #[serde(rename = "channelID")]
    pub channel_id: String,
    /// `userID`.
    #[serde(rename = "userID", default)]
    pub user_id: Option<String>,
    /// `username`.
    #[serde(rename = "username", default)]
    pub username: Option<String>,
    /// `messageID`.
    #[serde(rename = "messageID", default)]
    pub message_id: Option<String>,
    /// `messageText`.
    #[serde(rename = "messageText", default)]
    pub message_text: Option<Private<String>>,
    /// `ruleID`.
    #[serde(rename = "ruleID", default)]
    pub rule_id: Option<String>,
    /// `rule`.
    #[serde(rename = "rule", default)]
    pub rule: Option<Private<ModerationDecisionRule>>,
    /// `settingsVersion`.
    #[serde(rename = "settingsVersion", default)]
    pub settings_version: Option<JsNumber>,
    /// `matches`.
    #[serde(
        rename = "matches",
        default = "read_default_moderation_decision_matches"
    )]
    pub matches: Private<ModerationDecisionMatches>,
    /// `context`.
    #[serde(
        rename = "context",
        default = "read_default_moderation_decision_context"
    )]
    pub context: Private<ModerationDecisionContext>,
    /// `mode`.
    #[serde(rename = "mode", default)]
    pub mode: Option<String>,
    /// `reviewSource`.
    #[serde(
        rename = "reviewSource",
        default = "read_default_moderation_decision_review_source"
    )]
    pub review_source: Open<ModerationDecisionReviewSourceValue>,
    /// `state`.
    #[serde(rename = "state", default = "read_default_moderation_decision_state")]
    pub state: String,
    /// `verdict`.
    #[serde(
        rename = "verdict",
        default = "read_default_moderation_decision_verdict"
    )]
    pub verdict: String,
    /// `status`.
    #[serde(rename = "status", default = "read_default_moderation_decision_status")]
    pub status: String,
    /// `model`.
    #[serde(rename = "model", default = "read_default_moderation_decision_model")]
    pub model: String,
    /// `provider`.
    #[serde(
        rename = "provider",
        default = "read_default_moderation_decision_provider"
    )]
    pub provider: String,
    /// `decisionPolicyVersion`.
    #[serde(rename = "decisionPolicyVersion", default)]
    pub decision_policy_version: Option<String>,
    /// `scores`.
    #[serde(rename = "scores", default)]
    pub scores: Option<Private<ModerationDecisionScores>>,
    /// `providerRequestID`.
    #[serde(
        rename = "providerRequestID",
        default = "read_default_moderation_decision_provider_request_id"
    )]
    pub provider_request_id: String,
    /// `inputTokens`.
    #[serde(
        rename = "inputTokens",
        default = "read_default_moderation_decision_input_tokens"
    )]
    pub input_tokens: JsNumber,
    /// `cost`.
    #[serde(rename = "cost", default = "read_default_moderation_decision_cost")]
    pub cost: JsNumber,
    /// `latencyMs`.
    #[serde(
        rename = "latencyMs",
        default = "read_default_moderation_decision_latency_ms"
    )]
    pub latency_ms: JsNumber,
    /// `charge`.
    #[serde(rename = "charge", default = "read_default_moderation_decision_charge")]
    pub charge: Private<ModerationDecisionCharge>,
    /// `consequence`.
    #[serde(
        rename = "consequence",
        default = "read_default_moderation_decision_consequence"
    )]
    pub consequence: Private<ModerationDecisionConsequence>,
    /// `feedback`.
    #[serde(rename = "feedback", default)]
    pub feedback: Option<Private<ModerationDecisionFeedback>>,
    /// `deadline`.
    #[serde(rename = "deadline", default)]
    pub deadline: Option<JsDate>,
    /// `createdAt`.
    #[serde(rename = "createdAt", default)]
    pub created_at: Option<JsDate>,
    /// `expiresAt`.
    #[serde(rename = "expiresAt")]
    pub expires_at: JsDate,
}
/// Typed input fields.
#[derive(Clone, Debug, Serialize)]
pub struct NewModerationDecision {
    /// `_id`.
    #[serde(rename = "_id")]
    pub id: String,
    /// `channelID`.
    #[serde(rename = "channelID")]
    pub channel_id: String,
    /// `userID`.
    #[serde(rename = "userID", skip_serializing_if = "Option::is_none")]
    pub user_id: Option<String>,
    /// `username`.
    #[serde(rename = "username", skip_serializing_if = "Option::is_none")]
    pub username: Option<String>,
    /// `messageID`.
    #[serde(rename = "messageID", skip_serializing_if = "Option::is_none")]
    pub message_id: Option<String>,
    /// `messageText`.
    #[serde(rename = "messageText", skip_serializing_if = "Option::is_none")]
    pub message_text: Option<Private<String>>,
    /// `ruleID`.
    #[serde(rename = "ruleID", skip_serializing_if = "Option::is_none")]
    pub rule_id: Option<String>,
    /// `rule`.
    #[serde(rename = "rule", skip_serializing_if = "Option::is_none")]
    pub rule: Option<Private<ModerationDecisionRule>>,
    /// `settingsVersion`.
    #[serde(rename = "settingsVersion", skip_serializing_if = "Option::is_none")]
    pub settings_version: Option<JsNumber>,
    /// `matches`.
    #[serde(rename = "matches", skip_serializing_if = "Option::is_none")]
    pub matches: Option<Private<ModerationDecisionMatches>>,
    /// `context`.
    #[serde(rename = "context", skip_serializing_if = "Option::is_none")]
    pub context: Option<Private<ModerationDecisionContext>>,
    /// `mode`.
    #[serde(rename = "mode", skip_serializing_if = "Option::is_none")]
    pub mode: Option<String>,
    /// `reviewSource`.
    #[serde(rename = "reviewSource", skip_serializing_if = "Option::is_none")]
    pub review_source: Option<ModerationDecisionReviewSourceValue>,
    /// `state`.
    #[serde(rename = "state", skip_serializing_if = "Option::is_none")]
    pub state: Option<String>,
    /// `verdict`.
    #[serde(rename = "verdict", skip_serializing_if = "Option::is_none")]
    pub verdict: Option<String>,
    /// `status`.
    #[serde(rename = "status", skip_serializing_if = "Option::is_none")]
    pub status: Option<String>,
    /// `model`.
    #[serde(rename = "model", skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    /// `provider`.
    #[serde(rename = "provider", skip_serializing_if = "Option::is_none")]
    pub provider: Option<String>,
    /// `decisionPolicyVersion`.
    #[serde(
        rename = "decisionPolicyVersion",
        skip_serializing_if = "Option::is_none"
    )]
    pub decision_policy_version: Option<String>,
    /// `scores`.
    #[serde(rename = "scores", skip_serializing_if = "Option::is_none")]
    pub scores: Option<Private<ModerationDecisionScores>>,
    /// `providerRequestID`.
    #[serde(rename = "providerRequestID", skip_serializing_if = "Option::is_none")]
    pub provider_request_id: Option<String>,
    /// `inputTokens`.
    #[serde(rename = "inputTokens", skip_serializing_if = "Option::is_none")]
    pub input_tokens: Option<JsNumber>,
    /// `cost`.
    #[serde(rename = "cost", skip_serializing_if = "Option::is_none")]
    pub cost: Option<JsNumber>,
    /// `latencyMs`.
    #[serde(rename = "latencyMs", skip_serializing_if = "Option::is_none")]
    pub latency_ms: Option<JsNumber>,
    /// `charge`.
    #[serde(rename = "charge", skip_serializing_if = "Option::is_none")]
    pub charge: Option<Private<ModerationDecisionCharge>>,
    /// `consequence`.
    #[serde(rename = "consequence", skip_serializing_if = "Option::is_none")]
    pub consequence: Option<Private<ModerationDecisionConsequence>>,
    /// `feedback`.
    #[serde(rename = "feedback", skip_serializing_if = "Option::is_none")]
    pub feedback: Option<Private<ModerationDecisionFeedback>>,
    /// `deadline`.
    #[serde(rename = "deadline", skip_serializing_if = "Option::is_none")]
    pub deadline: Option<JsDate>,
    /// `createdAt`.
    #[serde(rename = "createdAt", skip_serializing_if = "Option::is_none")]
    pub created_at: Option<JsDate>,
    /// `expiresAt`.
    #[serde(rename = "expiresAt")]
    pub expires_at: JsDate,
}
/// Hidden paths.
pub const HIDDEN: &[&str] = &[];
/// Private paths.
pub const PRIVATE: &[&str] = &[
    "messageText",
    "rule",
    "matches",
    "context",
    "scores",
    "charge",
    "consequence",
    "feedback",
];
/// Declared indexes.
pub const INDEXES: &[IndexSpec] = &[
    IndexSpec::on(&[("expiresAt", 1)]).expire_after_seconds(0),
    IndexSpec::on(&[("channelID", 1), ("createdAt", -1)]),
    IndexSpec::on(&[("state", 1), ("deadline", 1), ("createdAt", 1)]),
    IndexSpec::on(&[("charge.status", 1), ("createdAt", 1)]),
];
/// Schema validators.
pub const RULES: &[Rule] = &[
    Rule::required("channelID"),
    Rule::one_of(
        "reviewSource",
        &["rule", "first_message", "spam_continuous"],
    ),
    Rule::required("expiresAt"),
];
/// Read constraints.
pub const READ_NEEDS: &[ReadNeed] = &[
    ReadNeed::value("_id"),
    ReadNeed::value("channelID"),
    ReadNeed::not_null("matches"),
    ReadNeed::not_null("context"),
    ReadNeed::not_null("reviewSource"),
    ReadNeed::not_null("state"),
    ReadNeed::not_null("verdict"),
    ReadNeed::not_null("status"),
    ReadNeed::not_null("model"),
    ReadNeed::not_null("provider"),
    ReadNeed::not_null("providerRequestID"),
    ReadNeed::not_null("inputTokens"),
    ReadNeed::not_null("cost"),
    ReadNeed::not_null("latencyMs"),
    ReadNeed::value("expiresAt"),
];
/// Registry entry.
pub static INFO: CollectionInfo = CollectionInfo {
    name: COLLECTION,
    model: "moderation_decision",
    source: "dimabot/src/schemas/moderation_decision.schema.ts",
    schema: &SCHEMA,
    id_type: IdType::String,
    hidden: HIDDEN,
    indexes: INDEXES,
    rules: RULES,
    read_needs: READ_NEEDS,
    hooks: Hooks::None,
    client_nulls: ClientNulls::None,
    initialised_at_startup: true,
    private: PRIVATE,
    decode: decode_boxed::<ModerationDecision>,
};
impl NewModerationDecision {
    /// Input before schema defaults and validation.
    pub fn to_document(&self) -> Result<Document, ModelError> {
        Ok(bson::serialize_to_document(self)?)
    }
    /// Validated insert through the collection write guard.
    pub fn prepare(&self, ctx: &mut WriteContext) -> Result<PreparedInsert, ModelError> {
        INFO.prepare_create(&self.to_document()?, ctx)
    }
}
