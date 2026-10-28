use crate::utils::{js_compat::trim, json_number::to_number};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::cmp::Ordering;

pub const MAX_BITS_RULES: usize = 50;
pub const MAX_BITS_AMOUNT: u32 = 1_000_000;
pub const MAX_RULE_NAME: usize = 60;
pub const MAX_RULE_MESSAGE: usize = 1000;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum BitsChatMode {
    Default,
    Custom,
    Silent,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct BitsChat {
    pub mode: BitsChatMode,
    pub message: String,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct BitsRule {
    pub id: String,
    pub name: String,
    pub enabled: bool,
    pub min: u32,
    pub max: Option<u32>,
    pub chat: BitsChat,
    pub alert: bool,
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct BitsRuleError {
    pub message: String,
    pub status: u16,
}
impl BitsRuleError {
    pub fn new(message: impl Into<String>, status: u16) -> Self {
        Self {
            message: message.into(),
            status,
        }
    }
}
impl std::fmt::Display for BitsRuleError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}
impl std::error::Error for BitsRuleError {}
fn invalid(message: &str) -> BitsRuleError {
    BitsRuleError::new(message, 400)
}
pub fn valid_rule_id(value: &Value) -> bool {
    value.as_str().is_some_and(|s| {
        !s.is_empty()
            && s.len() <= 64
            && s.bytes()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, b'_' | b'-'))
    })
}
fn amount(value: &Value, field: &str) -> Result<u32, BitsRuleError> {
    let n = value.as_f64().filter(|n| {
        n.is_finite() && n.fract() == 0.0 && *n >= 1.0 && *n <= f64::from(MAX_BITS_AMOUNT)
    });
    n.map(|n| n as u32).ok_or_else(|| {
        invalid(&format!(
            "{field} must be a whole number of Bits from 1 to 1,000,000"
        ))
    })
}
/// Validates the entire merged rule, in the same field/error order as TS.
pub fn parse_rule(
    raw: &Value,
    id: &str,
    previous: Option<&BitsRule>,
) -> Result<BitsRule, BitsRuleError> {
    let body = raw.as_object().ok_or_else(|| invalid("Expected a rule"))?;
    if body
        .keys()
        .any(|key| !["name", "enabled", "min", "max", "chat", "alert"].contains(&key.as_str()))
    {
        return Err(invalid("Unknown rule field"));
    }
    let prior = previous.map(|r| serde_json::to_value(r).expect("rule serialization"));
    let null = Value::Null;
    let pick = |key: &str| {
        body.get(key)
            .or_else(|| prior.as_ref().and_then(|v| v.get(key)))
            .unwrap_or(&null)
    };
    let name = match pick("name") {
        Value::Null => "",
        Value::String(s) if s.encode_utf16().count() <= MAX_RULE_NAME => s,
        _ => return Err(invalid("Names can be up to 60 characters")),
    };
    let enabled = match pick("enabled") {
        Value::Null => true,
        Value::Bool(b) => *b,
        _ => return Err(invalid("Expected on or off")),
    };
    let alert = match pick("alert") {
        Value::Null => true,
        Value::Bool(b) => *b,
        _ => return Err(invalid("Expected alert on or off")),
    };
    let min = amount(pick("min"), "The amount")?;
    let max = if pick("max").is_null() {
        None
    } else {
        Some(amount(pick("max"), "The highest amount")?)
    };
    if max.is_some_and(|max| max < min) {
        return Err(invalid(
            "The highest amount must be at least the lowest amount",
        ));
    }
    let default_chat = json!({"mode":"default", "message":""});
    let raw_chat = if pick("chat").is_null() {
        &default_chat
    } else {
        pick("chat")
    };
    let chat = raw_chat
        .as_object()
        .ok_or_else(|| invalid("Invalid chat action"))?;
    let mode = match chat.get("mode").and_then(Value::as_str) {
        Some("default") => BitsChatMode::Default,
        Some("custom") => BitsChatMode::Custom,
        Some("silent") => BitsChatMode::Silent,
        _ => return Err(invalid("Invalid chat action")),
    };
    let message = match chat.get("message") {
        None | Some(Value::Null) => "",
        Some(Value::String(s)) if s.encode_utf16().count() <= MAX_RULE_MESSAGE => s,
        _ => return Err(invalid("Messages can be up to 1000 characters")),
    };
    if mode == BitsChatMode::Custom && trim(message).is_empty() {
        return Err(invalid(
            "Write the chat message, or choose the default message",
        ));
    }
    Ok(BitsRule {
        id: id.to_owned(),
        name: trim(name).to_owned(),
        enabled,
        min,
        max,
        chat: BitsChat {
            mode,
            message: message.to_owned(),
        },
        alert,
    })
}
/// Finite widths sort before open-ended widths; ties favor larger minima.
pub fn compare_specificity(a: &BitsRule, b: &BitsRule) -> Ordering {
    let a_width = a.max.map(|max| i64::from(max) - i64::from(a.min));
    let b_width = b.max.map(|max| i64::from(max) - i64::from(b.min));
    let width = match (a_width, b_width) {
        (None, None) => Ordering::Equal,
        (None, Some(_)) => Ordering::Greater,
        (Some(_), None) => Ordering::Less,
        (Some(a), Some(b)) => a.cmp(&b),
    };
    width.then_with(|| b.min.cmp(&a.min))
}
pub fn match_bits_rule<'a>(rules: &'a [BitsRule], bits: &Value) -> Option<&'a BitsRule> {
    let bits = bits.as_f64().filter(|n| {
        n.is_finite() && n.fract() == 0.0 && *n >= 1.0 && *n <= 9_007_199_254_740_991.0
    })?;
    let mut best = None;
    for rule in rules {
        if !rule.enabled
            || bits < f64::from(rule.min)
            || rule.max.is_some_and(|max| bits > f64::from(max))
        {
            continue;
        }
        if best.is_none_or(|old| compare_specificity(rule, old) == Ordering::Less) {
            best = Some(rule);
        }
    }
    best
}
pub fn bits_chat_message<'a>(
    rules: &'a [BitsRule],
    default_message: &'a str,
    bits: &Value,
) -> &'a str {
    match match_bits_rule(rules, bits) {
        Some(rule) if rule.chat.mode == BitsChatMode::Custom => &rule.chat.message,
        Some(rule) if rule.chat.mode == BitsChatMode::Silent => "",
        _ => default_message,
    }
}
/// JavaScript can retain half a surrogate when slicing a legacy string.
/// Rust cannot represent this result, so report it rather than silently alter it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct SplitSurrogate;
impl std::fmt::Display for SplitSurrogate {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("legacy text truncation splits a UTF-16 surrogate pair")
    }
}
impl std::error::Error for SplitSurrogate {}
fn slice_text(text: &str, max: usize) -> Result<String, SplitSurrogate> {
    let units: Vec<u16> = text.encode_utf16().take(max).collect();
    String::from_utf16(&units).map_err(|_| SplitSurrogate)
}
pub fn rules_from_legacy_tiers(tiers: &Value) -> Result<Vec<BitsRule>, SplitSurrogate> {
    let Some(tiers) = tiers.as_array() else {
        return Ok(Vec::new());
    };
    let mut out = Vec::new();
    for (index, tier) in tiers.iter().enumerate() {
        if !tier.is_object() && !tier.is_array() {
            continue;
        }
        let find = |snake: &str, camel: &str| {
            tier.get(snake)
                .filter(|v| !v.is_null())
                .or_else(|| tier.get(camel))
                .map(to_number)
                .unwrap_or(f64::NAN)
        };
        let min = find("min_amount", "minAmount");
        let max = find("max_amount", "maxAmount");
        if !min.is_finite() || !max.is_finite() {
            continue;
        }
        // For positive values Rust and JS round identically; negative values
        // clamp to one before they can affect the result.
        let low = min.round().clamp(1.0, f64::from(MAX_BITS_AMOUNT)) as u32;
        let high = max
            .round()
            .clamp(f64::from(low), f64::from(MAX_BITS_AMOUNT)) as u32;
        let message = slice_text(
            tier.get("message").and_then(Value::as_str).unwrap_or(""),
            MAX_RULE_MESSAGE,
        )?;
        let name = slice_text(
            trim(tier.get("name").and_then(Value::as_str).unwrap_or("")),
            MAX_RULE_NAME,
        )?;
        let id = tier
            .get("id")
            .filter(|value| valid_rule_id(value))
            .and_then(Value::as_str)
            .map(str::to_owned)
            .unwrap_or_else(|| format!("legacy-{}", index + 1));
        let chat = if trim(&message).is_empty() {
            BitsChat {
                mode: BitsChatMode::Silent,
                message: String::new(),
            }
        } else {
            BitsChat {
                mode: BitsChatMode::Custom,
                message,
            }
        };
        out.push(BitsRule {
            id,
            name,
            enabled: true,
            min: low,
            max: Some(high),
            chat,
            alert: true,
        });
        if out.len() == MAX_BITS_RULES {
            break;
        }
    }
    Ok(out)
}
