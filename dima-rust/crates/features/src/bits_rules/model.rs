//! `bits_rules/model.ts`: a rule's shape, its validation, matching a cheer, the chat text, and
//! the conversion of the old chat-events editor's cheer tiers.
//!
//! Input arrives as JSON (a request body or a site-assistant tool call: [`parse_rule`]) or as
//! stored BSON (rules in `bits_rules.rules`, legacy tiers in `eventsubs.cheerTiers`:
//! [`BitsRule::from_bson`], [`rules_from_legacy_tiers`]). Both are read as JavaScript reads them
//! (`typeof`, `Number()`, `??`).
//!
//! Text rules (`MIGRATION.md` section 4): rule names (60) and messages (1000) are our own limits
//! on user text, counted and cut in characters (the reference counts UTF-16 units: an emoji now
//! counts 1, so nothing valid becomes invalid). `trim` is JavaScript's.

use bson::{Bson, Document};
use dima_text::{Js, js_number_with, trim, truncate_chars};
use serde_json::{Map, Value};

/// `MAX_BITS_RULES`: rules per channel (the route refuses the 51st with 409).
pub const MAX_BITS_RULES: usize = 50;
/// `MAX_BITS_AMOUNT`: the largest amount a rule names.
pub const MAX_BITS_AMOUNT: i64 = 1_000_000;
/// `MAX_RULE_NAME`, in characters.
pub const MAX_RULE_NAME: usize = 60;
/// `MAX_RULE_MESSAGE`, in characters.
pub const MAX_RULE_MESSAGE: usize = 1000;
/// `Number.MAX_SAFE_INTEGER`.
const MAX_SAFE: f64 = 9_007_199_254_740_991.0;

/// `BitsRuleError`: what a request is told, with its HTTP status (400 unless said otherwise).
#[derive(Clone, Debug, PartialEq, Eq, thiserror::Error)]
#[error("{message}")]
pub struct BitsRuleError {
    /// The reference's message, shown to the streamer.
    pub message: String,
    /// The HTTP status the route answers.
    pub status: u16,
}

impl BitsRuleError {
    /// A 400 with `message`.
    pub fn invalid(message: impl Into<String>) -> Self {
        Self::with_status(message, 400)
    }

    /// `message` with `status`.
    pub fn with_status(message: impl Into<String>, status: u16) -> Self {
        Self {
            message: message.into(),
            status,
        }
    }
}

/// `BitsChatMode`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum BitsChatMode {
    /// The cheers event's own message.
    Default,
    /// The rule's message.
    Custom,
    /// Nothing is said.
    Silent,
}

impl BitsChatMode {
    /// The stored text.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Default => "default",
            Self::Custom => "custom",
            Self::Silent => "silent",
        }
    }

    fn parse(text: &str) -> Option<Self> {
        match text {
            "default" => Some(Self::Default),
            "custom" => Some(Self::Custom),
            "silent" => Some(Self::Silent),
            _ => None,
        }
    }
}

/// What the bot says for a cheer the rule matches.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct BitsChat {
    /// The mode.
    pub mode: BitsChatMode,
    /// The text of a custom message (kept as written, not trimmed).
    pub message: String,
}

/// `BitsRule`. Amounts are whole numbers from 1 to [`MAX_BITS_AMOUNT`].
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct BitsRule {
    /// `id`, [`valid_rule_id`] (or `legacy-N`).
    pub id: String,
    /// The trimmed name.
    pub name: String,
    /// Whether the rule takes part in matching.
    pub enabled: bool,
    /// The lowest amount.
    pub min: i64,
    /// The highest amount; `None` is "or more" (stored `null`).
    pub max: Option<i64>,
    /// The chat action.
    pub chat: BitsChat,
    /// Whether overlay alerts play for cheers that match.
    pub alert: bool,
}

impl BitsRule {
    /// The rule as the reference's object is serialised to JSON (key order of `parseRule`).
    pub fn to_json(&self) -> Value {
        let mut chat = Map::new();
        chat.insert("mode".into(), Value::from(self.chat.mode.as_str()));
        chat.insert("message".into(), Value::from(self.chat.message.clone()));
        let mut rule = Map::new();
        rule.insert("id".into(), Value::from(self.id.clone()));
        rule.insert("name".into(), Value::from(self.name.clone()));
        rule.insert("enabled".into(), Value::Bool(self.enabled));
        rule.insert("min".into(), Value::from(self.min));
        rule.insert("max".into(), self.max.map_or(Value::Null, Value::from));
        rule.insert("chat".into(), Value::Object(chat));
        rule.insert("alert".into(), Value::Bool(self.alert));
        Value::Object(rule)
    }

    /// The rule as the Node driver stores the object: amounts are int32 (they are at most
    /// 1,000,000), the key order is `parseRule`'s.
    pub fn to_bson(&self) -> Bson {
        let amount = |n: i64| i32::try_from(n).map_or(Bson::Int64(n), Bson::Int32);
        let mut chat = Document::new();
        chat.insert("mode", self.chat.mode.as_str());
        chat.insert("message", self.chat.message.clone());
        let mut rule = Document::new();
        rule.insert("id", self.id.clone());
        rule.insert("name", self.name.clone());
        rule.insert("enabled", self.enabled);
        rule.insert("min", amount(self.min));
        rule.insert("max", self.max.map_or(Bson::Null, amount));
        rule.insert("chat", chat);
        rule.insert("alert", self.alert);
        Bson::Document(rule)
    }

    /// A stored rule. Every writer of the reference stores the output of `parseRule` or
    /// `rulesFromLegacyTiers` (the assistant's undo restores such a rule as it was), so a stored
    /// rule has exactly this shape; anything else is `None`, and the caller decides (matching
    /// skips it, a change refuses to rewrite the list).
    pub fn from_bson(value: &Bson) -> Option<Self> {
        let rule = value.as_document()?;
        let chat = rule.get_document("chat").ok()?;
        let amount = |value: &Bson| {
            dima_store::mongo::number::read_number(value)
                .filter(|n| n.fract() == 0.0 && n.abs() <= MAX_SAFE)
                .map(|n| n as i64)
        };
        Some(Self {
            id: rule.get_str("id").ok()?.to_owned(),
            name: rule.get_str("name").ok()?.to_owned(),
            enabled: rule.get_bool("enabled").ok()?,
            min: amount(rule.get("min")?)?,
            max: match rule.get("max")? {
                Bson::Null => None,
                value => Some(amount(value)?),
            },
            chat: BitsChat {
                mode: BitsChatMode::parse(chat.get_str("mode").ok()?)?,
                message: chat.get_str("message").ok()?.to_owned(),
            },
            alert: rule.get_bool("alert").ok()?,
        })
    }

    /// `width`: `Infinity` for "or more".
    fn width(&self) -> f64 {
        self.max
            .map_or(f64::INFINITY, |max| (max - self.min) as f64)
    }
}

/// `validRuleId`: `^[a-zA-Z0-9_-]{1,64}$`.
pub fn valid_rule_id(value: &str) -> bool {
    (1..=64).contains(&value.len())
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

/// `amount(value, field)`.
fn amount(value: Option<&Value>, field: &str) -> Result<i64, BitsRuleError> {
    match value.and_then(Value::as_f64) {
        Some(n) if n.fract() == 0.0 && (1.0..=MAX_BITS_AMOUNT as f64).contains(&n) => Ok(n as i64),
        _ => Err(BitsRuleError::invalid(format!(
            "{field} must be a whole number of Bits from 1 to 1,000,000"
        ))),
    }
}

/// `pick(key)`: the body's value when the body names the key, else the previous rule's.
/// `undefined` is `None`; a JSON `null` is `Some(Null)`.
fn pick(body: &Map<String, Value>, previous: Option<&Value>, key: &str) -> Option<Value> {
    if let Some(value) = body.get(key) {
        return Some(value.clone());
    }
    previous.and_then(|p| p.get(key)).cloned()
}

/// `x ?? fallback` for a picked value.
fn or(value: Option<Value>, fallback: Value) -> Value {
    match value {
        None | Some(Value::Null) => fallback,
        Some(value) => value,
    }
}

/// `parseRule(raw, id, previous)`: validates a full rule body (create) or a partial one merged
/// onto `previous` (update), with the reference's messages and checks in its order.
pub fn parse_rule(
    raw: &Value,
    id: &str,
    previous: Option<&BitsRule>,
) -> Result<BitsRule, BitsRuleError> {
    let Value::Object(body) = raw else {
        return Err(BitsRuleError::invalid("Expected a rule"));
    };
    const ALLOWED: [&str; 6] = ["name", "enabled", "min", "max", "chat", "alert"];
    if body.keys().any(|key| !ALLOWED.contains(&key.as_str())) {
        return Err(BitsRuleError::invalid("Unknown rule field"));
    }
    let previous = previous.map(BitsRule::to_json);
    let previous = previous.as_ref();

    let name = or(pick(body, previous, "name"), Value::from(""));
    let Value::String(name) = name else {
        return Err(name_error());
    };
    if dima_text::char_len(&name) > MAX_RULE_NAME {
        return Err(name_error());
    }
    let Value::Bool(enabled) = or(pick(body, previous, "enabled"), Value::Bool(true)) else {
        return Err(BitsRuleError::invalid("Expected on or off"));
    };
    let Value::Bool(alert) = or(pick(body, previous, "alert"), Value::Bool(true)) else {
        return Err(BitsRuleError::invalid("Expected alert on or off"));
    };
    let min = amount(pick(body, previous, "min").as_ref(), "The amount")?;
    let max = match pick(body, previous, "max") {
        None | Some(Value::Null) => None,
        Some(value) => Some(amount(Some(&value), "The highest amount")?),
    };
    if max.is_some_and(|max| max < min) {
        return Err(BitsRuleError::invalid(
            "The highest amount must be at least the lowest amount",
        ));
    }

    let default_chat = || {
        let mut chat = Map::new();
        chat.insert("mode".into(), Value::from("default"));
        chat.insert("message".into(), Value::from(""));
        Value::Object(chat)
    };
    let invalid_chat = || BitsRuleError::invalid("Invalid chat action");
    let Value::Object(chat) = or(pick(body, previous, "chat"), default_chat()) else {
        return Err(invalid_chat());
    };
    let mode = chat
        .get("mode")
        .and_then(Value::as_str)
        .and_then(BitsChatMode::parse)
        .ok_or_else(invalid_chat)?;
    let message = match chat.get("message") {
        None | Some(Value::Null) => String::new(),
        Some(Value::String(text)) if dima_text::char_len(text) <= MAX_RULE_MESSAGE => text.clone(),
        Some(_) => {
            return Err(BitsRuleError::invalid(
                "Messages can be up to 1000 characters",
            ));
        }
    };
    if mode == BitsChatMode::Custom && trim(&message).is_empty() {
        return Err(BitsRuleError::invalid(
            "Write the chat message, or choose the default message",
        ));
    }
    Ok(BitsRule {
        id: id.to_owned(),
        name: trim(&name).to_owned(),
        enabled,
        min,
        max,
        chat: BitsChat { mode, message },
        alert,
    })
}

fn name_error() -> BitsRuleError {
    BitsRuleError::invalid("Names can be up to 60 characters")
}

/// `compareSpecificity(a, b) < 0`: `a` is more specific (narrower range, then a higher start).
fn more_specific(a: &BitsRule, b: &BitsRule) -> bool {
    // `width(a) - width(b) || b.min - a.min`: Infinity - Infinity is NaN, which `||` skips.
    let by_width = a.width() - b.width();
    let order = if by_width != 0.0 && !by_width.is_nan() {
        by_width
    } else {
        (b.min - a.min) as f64
    };
    order < 0.0
}

/// `matchBitsRule(rules, bits)` for a cheer of `bits`: the most specific enabled rule whose
/// range holds it (list order breaks a tie). `None` for anything but a whole number of at least
/// 1 up to `Number.MAX_SAFE_INTEGER`.
pub fn match_bits_rule(rules: &[BitsRule], bits: f64) -> Option<&BitsRule> {
    if bits.fract() != 0.0 || !(1.0..=MAX_SAFE).contains(&bits) {
        return None;
    }
    let mut best: Option<&BitsRule> = None;
    for rule in rules {
        if !rule.enabled || bits < rule.min as f64 || rule.max.is_some_and(|max| bits > max as f64)
        {
            continue;
        }
        if best.is_none_or(|best| more_specific(rule, best)) {
            best = Some(rule);
        }
    }
    best
}

/// [`match_bits_rule`] for an untyped amount (`raw.bits` of an event): a JSON number, anything
/// else (text, `null`) matches nothing, as `typeof bits !== 'number'` does.
pub fn match_bits_value<'a>(rules: &'a [BitsRule], bits: &Value) -> Option<&'a BitsRule> {
    bits.as_f64().and_then(|bits| match_bits_rule(rules, bits))
}

/// `bitsChatMessage(rules, defaultMessage, bits)`: the text the bot sends for a cheer; empty
/// means silence.
pub fn bits_chat_message(rules: &[BitsRule], default_message: &str, bits: &Value) -> String {
    match match_bits_value(rules, bits) {
        None => default_message.to_owned(),
        Some(rule) => match rule.chat.mode {
            BitsChatMode::Default => default_message.to_owned(),
            BitsChatMode::Custom => rule.chat.message.clone(),
            BitsChatMode::Silent => String::new(),
        },
    }
}

/// How JavaScript sees a stored BSON value (for `Number()` of a legacy amount).
fn bson_js(value: &Bson) -> Js<'_, Bson> {
    match value {
        Bson::Null => Js::Null,
        Bson::Undefined => Js::Undefined,
        Bson::Boolean(flag) => Js::Bool(*flag),
        Bson::Int32(n) => Js::Number(f64::from(*n)),
        Bson::Int64(n) => Js::Number(*n as f64),
        Bson::Double(n) => Js::Number(*n),
        Bson::String(text) => Js::String(text),
        Bson::Array(items) => Js::Array(items),
        Bson::Document(_) => Js::Object,
        _ => Js::Other,
    }
}

/// `t.min_amount ?? t.minAmount`.
fn legacy_amount<'a>(tier: &'a Document, snake: &str, camel: &str) -> Option<&'a Bson> {
    match tier.get(snake) {
        None | Some(Bson::Null | Bson::Undefined) => tier.get(camel),
        value => value,
    }
}

/// `rulesFromLegacyTiers(tiers)` (`None`: not an array, so no rules): cheer tiers saved by the old chat-events editor (snake_case
/// or camelCase amounts), at most [`MAX_BITS_RULES`]. A tier whose amounts are not numbers
/// after `Number()` is skipped; amounts are rounded and clamped; an empty message is silence.
pub fn rules_from_legacy_tiers(tiers: Option<&[Bson]>) -> Vec<BitsRule> {
    let Some(tiers) = tiers else {
        return Vec::new();
    };
    let number = |value: Option<&Bson>| value.map_or(f64::NAN, |v| js_number_with(v, bson_js));
    let mut rules = Vec::new();
    for (index, tier) in tiers.iter().enumerate() {
        // `!tier || typeof tier !== 'object'`: arrays are objects too, and have no amounts.
        let Bson::Document(tier) = tier else {
            continue;
        };
        let min = number(legacy_amount(tier, "min_amount", "minAmount"));
        let max = number(legacy_amount(tier, "max_amount", "maxAmount"));
        if !min.is_finite() || !max.is_finite() {
            continue;
        }
        let ceiling = MAX_BITS_AMOUNT as f64;
        let low = ceiling.min(dima_text::math_round(min).max(1.0));
        let high = ceiling.min(low.max(dima_text::math_round(max)));
        let message = match tier.get("message") {
            Some(Bson::String(text)) => truncate_chars(text, MAX_RULE_MESSAGE).to_owned(),
            _ => String::new(),
        };
        let id = match tier.get("id") {
            Some(Bson::String(id)) if valid_rule_id(id) => id.clone(),
            _ => format!("legacy-{}", index + 1),
        };
        let name = match tier.get("name") {
            Some(Bson::String(name)) => truncate_chars(trim(name), MAX_RULE_NAME).to_owned(),
            _ => String::new(),
        };
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
        rules.push(BitsRule {
            id,
            name,
            enabled: true,
            min: low as i64,
            max: Some(high as i64),
            chat,
            alert: true,
        });
        if rules.len() == MAX_BITS_RULES {
            break;
        }
    }
    rules
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn rule(id: &str, min: i64, max: Option<i64>) -> BitsRule {
        BitsRule {
            id: id.into(),
            name: id.into(),
            enabled: true,
            min,
            max,
            chat: BitsChat {
                mode: BitsChatMode::Custom,
                message: id.into(),
            },
            alert: true,
        }
    }

    // `model.test.ts`: the most specific enabled rule wins regardless of order.
    #[test]
    fn the_most_specific_enabled_rule_wins_regardless_of_order() {
        let rules = vec![
            rule("any", 1, None),
            rule("hundreds", 100, Some(999)),
            rule("thousand", 1000, None),
            rule("nice", 69, Some(69)),
            rule("wide", 50, Some(150)),
        ];
        let id = |bits: f64| match_bits_rule(&rules, bits).map(|r| r.id.as_str());
        assert_eq!(id(69.0), Some("nice"));
        assert_eq!(id(120.0), Some("wide"));
        assert_eq!(id(500.0), Some("hundreds"));
        assert_eq!(id(5000.0), Some("thousand"));
        assert_eq!(id(1.0), Some("any"));
        let mut off = rule("off", 69, Some(69));
        off.enabled = false;
        let some = [off, rules[0].clone()];
        assert_eq!(
            match_bits_rule(&some, 69.0).map(|r| r.id.as_str()),
            Some("any")
        );
        for bad in [json!(0), json!(-5), json!(1.5), json!("100"), Value::Null] {
            assert_eq!(match_bits_value(&rules, &bad), None, "{bad}");
        }
    }

    #[test]
    fn chat_message_follows_the_rule_mode() {
        let mut silent = rule("silent", 11, Some(20));
        silent.chat = BitsChat {
            mode: BitsChatMode::Silent,
            message: String::new(),
        };
        let mut default = rule("default", 21, Some(30));
        default.chat = BitsChat {
            mode: BitsChatMode::Default,
            message: String::new(),
        };
        let rules = [rule("custom", 1, Some(10)), silent, default];
        assert_eq!(bits_chat_message(&rules, "Thanks", &json!(5)), "custom");
        assert_eq!(bits_chat_message(&rules, "Thanks", &json!(15)), "");
        assert_eq!(bits_chat_message(&rules, "Thanks", &json!(25)), "Thanks");
        assert_eq!(bits_chat_message(&rules, "Thanks", &json!(99)), "Thanks");
    }

    #[test]
    fn parse_rule_validates_and_merges_partial_updates() {
        let created = parse_rule(
            &json!({"name": " Big ", "min": 100, "max": null, "chat": {"mode": "default"}}),
            "r1",
            None,
        )
        .unwrap();
        assert_eq!(
            created.to_json(),
            json!({"id": "r1", "name": "Big", "enabled": true, "min": 100, "max": null,
                   "chat": {"mode": "default", "message": ""}, "alert": true})
        );
        let mut disabled = created.clone();
        disabled.enabled = false;
        assert_eq!(
            parse_rule(&json!({"enabled": false}), "r1", Some(&created)).unwrap(),
            disabled
        );
        for body in [
            json!({"min": 0}),
            json!({"min": 10, "max": 5}),
            json!({"min": 1.5}),
            json!({"min": 10, "chat": {"mode": "custom", "message": " "}}),
            json!({"min": 10, "extra": 1}),
            json!({"min": 10, "chat": {"mode": "loud"}}),
        ] {
            assert!(parse_rule(&body, "x", None).is_err(), "{body}");
        }
    }

    #[test]
    fn names_and_messages_count_characters() {
        let emoji = "👋".repeat(60);
        let parsed = parse_rule(&json!({"name": emoji, "min": 1}), "x", None).unwrap();
        assert_eq!(parsed.name, emoji);
        let long = "é".repeat(61);
        assert_eq!(
            parse_rule(&json!({"name": long, "min": 1}), "x", None),
            Err(name_error())
        );
        let message = "ש".repeat(1000);
        let chat = json!({"mode": "custom", "message": message});
        assert!(parse_rule(&json!({"min": 1, "chat": chat}), "x", None).is_ok());
    }

    #[test]
    fn legacy_tiers_convert_including_camel_case_amounts_and_empty_messages() {
        let tiers = bson::bson!([
            {"id": "tier-1", "name": "Nice", "message": "Nice", "minAmount": 69, "maxAmount": 69},
            {"id": "tier 2", "name": "Quiet", "message": "", "min_amount": 0, "max_amount": 10},
            {"name": "broken"}
        ]);
        let Bson::Array(tiers) = tiers else {
            panic!("array")
        };
        let rules = rules_from_legacy_tiers(Some(&tiers));
        assert_eq!(rules.len(), 2);
        assert_eq!(
            rules[0].to_json(),
            json!({"id": "tier-1", "name": "Nice", "enabled": true, "min": 69, "max": 69,
                   "chat": {"mode": "custom", "message": "Nice"}, "alert": true})
        );
        assert_eq!(rules[1].id, "legacy-2");
        assert_eq!(rules[1].min, 1);
        assert_eq!(rules[1].chat.mode, BitsChatMode::Silent);
    }

    #[test]
    fn stored_rules_round_trip() {
        let rule = parse_rule(&json!({"name": "x", "min": 5, "max": 9}), "r", None).unwrap();
        assert_eq!(BitsRule::from_bson(&rule.to_bson()), Some(rule));
        assert_eq!(BitsRule::from_bson(&Bson::String("x".into())), None);
    }
}
