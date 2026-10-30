//! Semantic-only portion of `advanced.ts`; pattern validation and the final
//! rule-type restriction belong to the outer parser and must run around this.
pub use crate::utils::moderation::types::{
    OnUncertain, SemanticExample as PolicyExample, SemanticLabel as ExampleLabel, SemanticPolicy,
};
use crate::utils::{
    js_string::JsString,
    lossless_json::JsonValue,
    lossless_json_view::{ArrayIter, JsonView},
};

/// Read the same ordinary JS values from either a validated JSON view or an
/// owned value. In particular, the owned form never serializes binary64s.
#[derive(Clone, Copy)]
pub(crate) enum InputValue<'a> {
    View(JsonView<'a>),
    Owned(&'a JsonValue),
}

pub(crate) enum InputArray<'a> {
    View(ArrayIter<'a>),
    Owned(std::slice::Iter<'a, JsonValue>),
}

impl<'a> Iterator for InputArray<'a> {
    type Item = InputValue<'a>;
    fn next(&mut self) -> Option<Self::Item> {
        match self {
            Self::View(iter) => iter.next().map(InputValue::View),
            Self::Owned(iter) => iter.next().map(InputValue::Owned),
        }
    }
}

impl<'a> InputValue<'a> {
    pub(crate) fn get(self, key: &str) -> Option<Self> {
        match self {
            Self::View(value) => value.get(key).map(Self::View),
            Self::Owned(value) => value.get(key).map(Self::Owned),
        }
    }
    pub(crate) fn as_string(self) -> Option<JsString> {
        match self {
            Self::View(value) => value.as_string(),
            Self::Owned(JsonValue::String(value)) => Some(value.clone()),
            Self::Owned(_) => None,
        }
    }
    pub(crate) fn as_bool(self) -> Option<bool> {
        match self {
            Self::View(value) => value.as_bool(),
            Self::Owned(JsonValue::Bool(value)) => Some(*value),
            Self::Owned(_) => None,
        }
    }
    fn as_number(self) -> Option<f64> {
        match self {
            Self::View(value)
                if matches!(value.raw().as_bytes().first(), Some(b'-' | b'0'..=b'9')) =>
            {
                match value.scalar() {
                    Some(JsonValue::Number(number)) => Some(number),
                    _ => None,
                }
            }
            Self::View(_) => None,
            Self::Owned(JsonValue::Number(number)) => Some(*number),
            Self::Owned(_) => None,
        }
    }
    #[cfg(feature = "moderation-advanced")]
    pub(crate) fn is_null(self) -> bool {
        match self {
            Self::View(value) => value.is_null(),
            Self::Owned(value) => matches!(value, JsonValue::Null),
        }
    }
    pub(crate) fn is_object(self) -> bool {
        match self {
            Self::View(value) => value.raw().starts_with('{'),
            Self::Owned(value) => matches!(value, JsonValue::Object(_)),
        }
    }
    pub(crate) fn array(self) -> Option<InputArray<'a>> {
        match self {
            Self::View(value) => value.array().map(InputArray::View),
            Self::Owned(JsonValue::Array(values)) => Some(InputArray::Owned(values.iter())),
            Self::Owned(_) => None,
        }
    }
}

pub const MODERATION_RETENTION_DAYS: u32 = 180;
pub const MODERATION_VISIBLE_DAYS: u32 = 30;
pub const SEMANTIC_MODEL: &str = "respan/span-01-lite";
pub const DECISION_POLICY_VERSION: &str = "contextual-v2";
pub const SEMANTIC_DEADLINE_MS: u32 = 4_000;
pub const ALLOW_THRESHOLD: f64 = 0.1;

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
    paid_moderation_input(tier.map(InputValue::View))
}

pub fn paid_moderation_owned(tier: Option<&JsonValue>) -> bool {
    paid_moderation_input(tier.map(InputValue::Owned))
}

fn paid_moderation_input(tier: Option<InputValue<'_>>) -> bool {
    tier.and_then(InputValue::as_string)
        .and_then(|s| s.as_str().map(|v| v == "premium" || v == "pro"))
        .unwrap_or(false)
}

/// Normalize `input.semantic` after all regex patterns have been validated.
/// Missing is represented by None; present null is invalid. Category and
/// invitation input keys are ignored by the source parser.
pub fn parse_semantic_policy(raw: Option<JsonView<'_>>) -> Result<SemanticPolicy, &'static str> {
    parse_semantic_policy_input(raw.map(InputValue::View))
}

pub fn parse_semantic_policy_owned(
    raw: Option<&JsonValue>,
) -> Result<SemanticPolicy, &'static str> {
    parse_semantic_policy_input(raw.map(InputValue::Owned))
}

pub(crate) fn parse_semantic_policy_input(
    raw: Option<InputValue<'_>>,
) -> Result<SemanticPolicy, &'static str> {
    let mut policy = empty_semantic_policy();
    let Some(raw) = raw else { return Ok(policy) };
    if !raw.is_object() {
        return Err("Invalid contextual policy");
    }
    if let Some(enabled) = raw.get("enabled") {
        policy.enabled = enabled
            .as_bool()
            .ok_or("Invalid contextual review switch")?;
    }
    if let Some(threshold) = raw.get("thresholdPercent") {
        let Some(number) = threshold.as_number() else {
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
        let examples: Vec<_> = examples.take(11).collect();
        if examples.len() > 10 {
            return Err("At most 10 policy examples are allowed");
        }
        for example in examples {
            let message = example.get("message").and_then(InputValue::as_string);
            let Some(message) = message.filter(|m| !m.trim().is_empty() && m.len() <= 500) else {
                return Err(
                    "Each example needs a message of 1–500 characters and an allow/violation label",
                );
            };
            let label = example.get("label").and_then(InputValue::as_string);
            let label = match label.as_ref().and_then(JsString::as_str) {
                Some("allow") => Some(ExampleLabel::Allow),
                Some("violation") => Some(ExampleLabel::Violation),
                _ => None,
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
