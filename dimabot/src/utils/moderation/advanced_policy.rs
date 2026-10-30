//! Semantic-only portion of `advanced.ts`; pattern validation and the final
//! rule-type restriction belong to the outer parser and must run around this.
use crate::utils::{
    js_string::JsString, lossless_json::JsonValue, lossless_json_view::JsonView,
    moderation::spam_categories::SpamCategory,
};

pub const MODERATION_RETENTION_DAYS: u32 = 180;
pub const MODERATION_VISIBLE_DAYS: u32 = 30;
pub const SEMANTIC_MODEL: &str = "respan/span-01-lite";
pub const DECISION_POLICY_VERSION: &str = "contextual-v2";
pub const SEMANTIC_DEADLINE_MS: u32 = 4_000;
pub const ALLOW_THRESHOLD: f64 = 0.1;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ExampleLabel {
    Allow,
    Violation,
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PolicyExample {
    pub message: JsString,
    pub label: ExampleLabel,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum OnUncertain {
    AllowAndLog,
}
#[derive(Clone, Debug, PartialEq)]
pub struct SemanticPolicy {
    pub categories: Option<Vec<SpamCategory>>,
    pub broadcaster_invitation: Option<bool>,
    pub enabled: bool,
    pub threshold_percent: Option<f64>,
    pub policy: JsString,
    pub examples: Vec<PolicyExample>,
    pub on_uncertain: OnUncertain,
}

pub fn empty_semantic_policy() -> SemanticPolicy {
    SemanticPolicy {
        categories: None,
        broadcaster_invitation: None,
        enabled: false,
        threshold_percent: Some(85.0),
        policy: JsString::from_static(""),
        examples: Vec::new(),
        on_uncertain: OnUncertain::AllowAndLog,
    }
}

/// Strict equality, with `None` denoting a missing/undefined value.
pub fn paid_moderation(tier: Option<JsonView<'_>>) -> bool {
    tier.and_then(JsonView::as_string)
        .and_then(|s| s.as_str().map(|v| v == "premium" || v == "pro"))
        .unwrap_or(false)
}

/// Normalize `input.semantic` after all regex patterns have been validated.
/// Missing is represented by None; present null is invalid. Only ordinary JSON
/// values are supported. Category and invitation input keys are ignored by the
/// source parser, despite existing in the public interface.
pub fn parse_semantic_policy(raw: Option<JsonView<'_>>) -> Result<SemanticPolicy, &'static str> {
    let mut policy = empty_semantic_policy();
    let Some(raw) = raw else { return Ok(policy) };
    if !raw.raw().starts_with('{') {
        return Err("Invalid contextual policy");
    }
    if let Some(enabled) = raw.get("enabled") {
        policy.enabled = enabled
            .as_bool()
            .ok_or("Invalid contextual review switch")?;
    }
    if let Some(threshold) = raw.get("thresholdPercent") {
        let Some(JsonValue::Number(number)) = threshold.scalar() else {
            return Err("Flagging confidence must be a percentage from 0 to 100");
        };
        if !number.is_finite() || !(0.0..=100.0).contains(&number) {
            return Err("Flagging confidence must be a percentage from 0 to 100");
        }
        policy.threshold_percent = Some(number);
    }
    if let Some(text) = raw.get("policy") {
        policy.policy = text.as_string().ok_or("Policy must be text")?.trim();
    }
    if policy.policy.len() > 2_000 || (policy.enabled && policy.policy.is_empty()) {
        return Err("Enabled contextual review needs a policy of 1–2000 characters");
    }
    if let Some(uncertain) = raw.get("onUncertain")
        && uncertain.as_string().as_ref().and_then(JsString::as_str) != Some("allow_and_log")
    {
        return Err("Uncertain decisions must allow and log");
    }
    if let Some(examples) = raw.get("examples") {
        let Some(examples) = examples.array() else {
            return Err("Examples must be a list");
        };
        let examples: Vec<_> = examples.collect();
        if examples.len() > 10 {
            return Err("At most 10 policy examples are allowed");
        }
        for example in examples {
            let message = example.get("message").and_then(JsonView::as_string);
            let label = example.get("label").and_then(JsonView::as_string);
            let label = match label.as_ref().and_then(JsString::as_str) {
                Some("allow") => Some(ExampleLabel::Allow),
                Some("violation") => Some(ExampleLabel::Violation),
                _ => None,
            };
            let Some(message) = message.filter(|m| !m.trim().is_empty() && m.len() <= 500) else {
                return Err(
                    "Each example needs a message of 1–500 characters and an allow/violation label",
                );
            };
            let Some(label) = label else {
                return Err(
                    "Each example needs a message of 1–500 characters and an allow/violation label",
                );
            };
            policy.examples.push(PolicyExample { message, label });
        }
    }
    Ok(policy)
}
