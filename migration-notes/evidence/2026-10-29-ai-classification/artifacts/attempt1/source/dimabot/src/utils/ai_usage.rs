//! Versioned AI usage context and metadata, consolidated from
//! `ai_usage_event.ts` and `ai_usage_classification.ts`. No billing, persistence,
//! reporting, receipt production, or network calls occur here.
//!
//! The context API models the TypeScript declared input types: enum members and
//! optional strings, rather than accepting invalid runtime casts. Finite zero
//! and negative quantities are preserved; NaN/infinities are omitted. Text uses
//! ECMAScript trim, not Rust's broader whitespace set. Adjustment classification
//! accepts JSON because its TypeScript input explicitly contains unknown fields.

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use super::js_compat::trim as js_trim;

pub const AI_USAGE_SCHEMA_VERSION: u8 = 1;
pub const AI_USAGE_PRICING_VERSION: &str = "legacy-polar-math-v1";
pub const ADJUSTMENT_TYPES: [&str; 10] = [
    "manual_grant",
    "monthly_reset",
    "subscription_credits",
    "purchased_pack",
    "gifted_credits",
    "native_grant",
    "refund",
    "correction",
    "activation",
    "other",
];

macro_rules! string_enum {
    ($name:ident { $($variant:ident => $text:literal),+ $(,)? }) => {
        #[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
        pub enum $name { $(#[serde(rename = $text)] $variant),+ }
        impl $name {
            pub const fn as_str(self) -> &'static str { match self { $(Self::$variant => $text),+ } }
            pub fn parse_token(value: &str) -> Option<Self> {
                match value { $($text => Some(Self::$variant),)+ _ => None }
            }
        }
    };
}
string_enum!(EntryKind { Usage => "usage", Adjustment => "adjustment" });
string_enum!(Category {
    Tts => "tts", AiChat => "ai_chat", AiAgent => "ai_agent", Memory => "memory",
    ClipRecommendation => "clip_recommendation", CreditAdjustment => "credit_adjustment", Other => "other",
});
string_enum!(UsageUnit { Characters => "characters", Tokens => "tokens", Minutes => "minutes" });
string_enum!(ResourceType { Speech => "speech", VoicePreview => "voice_preview", LlmGeneration => "llm_generation", VodAnalysis => "vod_analysis" });

/// Strict receipt category selection; invalid or absent values use the fallback.
pub fn normalize_receipt_category(value: Option<&str>) -> &'static str {
    value
        .and_then(Category::parse_token)
        .map(Category::as_str)
        .unwrap_or("uncategorized")
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiUsageContextInput {
    pub entry_id: Option<String>,
    pub request_id: Option<String>,
    pub parent_request_id: Option<String>,
    pub entry_kind: Option<EntryKind>,
    pub category: Option<Category>,
    pub operation: Option<String>,
    pub source: Option<String>,
    pub provider: Option<String>,
    pub model: Option<String>,
    #[serde(rename = "channelID")]
    pub channel_id: Option<String>,
    pub quantity: Option<f64>,
    pub unit: Option<UsageUnit>,
    pub resource_type: Option<ResourceType>,
    pub resource_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiUsageContext {
    pub schema_version: u8,
    pub pricing_version: String,
    pub entry_id: String,
    pub request_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub parent_request_id: Option<String>,
    pub entry_kind: EntryKind,
    pub category: Category,
    pub operation: String,
    pub source: String,
    pub provider: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(rename = "channelID", skip_serializing_if = "Option::is_none")]
    pub channel_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub quantity: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub unit: Option<UsageUnit>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub resource_type: Option<ResourceType>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub resource_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Classification {
    pub entry_kind: EntryKind,
    pub category: Category,
    pub operation: String,
    pub source: &'static str,
    pub provider: &'static str,
}

pub fn classify_legacy_reason(reason: &str) -> Classification {
    use Category::*;
    let (entry_kind, category, operation, source, provider) = match reason {
        "tts_fish" => (EntryKind::Usage, Tts, "synthesize", "tts_queue", "fish"),
        "tts_kokoro" => (EntryKind::Usage, Tts, "synthesize", "tts_queue", "kokoro"),
        "tts_piper" => (EntryKind::Usage, Tts, "synthesize", "tts_queue", "piper"),
        "messages" => (EntryKind::Usage, AiChat, "message", "chat", "openrouter"),
        "harness_tools" => (
            EntryKind::Usage,
            AiChat,
            "tool_reasoning",
            "chat",
            "openrouter",
        ),
        "harness_end" => (
            EntryKind::Usage,
            AiChat,
            "final_response",
            "chat",
            "openrouter",
        ),
        "planner" => (
            EntryKind::Usage,
            AiAgent,
            "plan",
            "code_execution",
            "openrouter",
        ),
        "coding_agent" => (
            EntryKind::Usage,
            AiAgent,
            "generate_code",
            "code_execution",
            "openrouter",
        ),
        "stream_summary" => (
            EntryKind::Usage,
            Memory,
            "stream_summary",
            "stream_offline",
            "openrouter",
        ),
        "weekly_summary" => (
            EntryKind::Usage,
            Memory,
            "weekly_summary",
            "weekly_maintenance",
            "openrouter",
        ),
        "monthly_summary" => (
            EntryKind::Usage,
            Memory,
            "monthly_summary",
            "monthly_maintenance",
            "openrouter",
        ),
        "vod_clip_recommendation" => (
            EntryKind::Usage,
            ClipRecommendation,
            "analyze_vod",
            "clip_recommendation",
            "openrouter",
        ),
        "Free benefits" => (
            EntryKind::Adjustment,
            CreditAdjustment,
            "grant",
            "activation",
            "polar",
        ),
        _ => (
            EntryKind::Usage,
            Other,
            if reason.is_empty() { "usage" } else { reason },
            "backend",
            "unknown",
        ),
    };
    Classification {
        entry_kind,
        category,
        operation: operation.into(),
        source,
        provider,
    }
}

fn optional_text(text: Option<String>) -> Option<String> {
    text.map(|text| js_trim(&text).to_owned())
        .filter(|text| !text.is_empty())
}

pub fn create_ai_usage_context(reason: &str, input: AiUsageContextInput) -> AiUsageContext {
    create_ai_usage_context_with_id(reason, input, || format!("aiu_{}", uuid::Uuid::new_v4()))
}

/// Injectable ID source for deterministic tests or an application's UUID
/// provider. It is called only when the input entry ID is absent/blank.
/// The callback must return a nonempty globally unique `aiu_<UUID>` identifier.
pub fn create_ai_usage_context_with_id(
    reason: &str,
    input: AiUsageContextInput,
    generate_id: impl FnOnce() -> String,
) -> AiUsageContext {
    let classified = classify_legacy_reason(reason);
    let entry_id = optional_text(input.entry_id).unwrap_or_else(generate_id);
    AiUsageContext {
        schema_version: AI_USAGE_SCHEMA_VERSION,
        pricing_version: AI_USAGE_PRICING_VERSION.into(),
        request_id: optional_text(input.request_id).unwrap_or_else(|| entry_id.clone()),
        entry_id,
        parent_request_id: optional_text(input.parent_request_id),
        entry_kind: input.entry_kind.unwrap_or(classified.entry_kind),
        category: input.category.unwrap_or(classified.category),
        operation: optional_text(input.operation).unwrap_or(classified.operation),
        source: optional_text(input.source).unwrap_or_else(|| classified.source.into()),
        provider: optional_text(input.provider).unwrap_or_else(|| classified.provider.into()),
        model: optional_text(input.model),
        channel_id: optional_text(input.channel_id),
        quantity: input.quantity.filter(|n| n.is_finite()),
        unit: input.unit,
        resource_type: input.resource_type,
        resource_id: optional_text(input.resource_id),
    }
}

/// Polar's canonical snake_case metadata. Optional fields are absent, not null.
/// Publicly constructed contexts should retain finite quantities; nonfinite
/// values are omitted rather than silently serialized as JSON null.
pub fn to_polar_usage_metadata(context: &AiUsageContext) -> Map<String, Value> {
    let mut result = Map::new();
    result.insert("schema_version".into(), context.schema_version.into());
    for (key, value) in [
        ("pricing_version", context.pricing_version.as_str()),
        ("entry_id", &context.entry_id),
        ("request_id", &context.request_id),
        ("entry_kind", context.entry_kind.as_str()),
        ("category", context.category.as_str()),
        ("operation", &context.operation),
        ("usage_source", &context.source),
        ("provider", &context.provider),
    ] {
        result.insert(key.into(), value.into());
    }
    for (key, value) in [
        ("parent_request_id", context.parent_request_id.as_deref()),
        ("model", context.model.as_deref()),
        ("channel_id", context.channel_id.as_deref()),
        ("unit", context.unit.map(UsageUnit::as_str)),
        (
            "resource_type",
            context.resource_type.map(ResourceType::as_str),
        ),
        ("resource_id", context.resource_id.as_deref()),
    ] {
        if let Some(value) = value.filter(|s| !s.is_empty()) {
            result.insert(key.into(), value.into());
        }
    }
    if let Some(quantity) = context.quantity.and_then(serde_json::Number::from_f64) {
        result.insert("quantity".into(), Value::Number(quantity));
    }
    result
}

/// Canonical metadata wins on collisions, exactly as JS object spread does.
/// Unrelated accounting fields are preserved without interpreting amounts.
pub fn enrich_polar_usage_metadata(
    accounting: &Map<String, Value>,
    context: &AiUsageContext,
) -> Map<String, Value> {
    let mut result = accounting.clone();
    result.extend(to_polar_usage_metadata(context));
    result
}

// Only classification needs JavaScript String(value || '') for unknown input.
// Array conversion is included: String(['activation']) === 'activation'.
fn js_string(value: &Value) -> String {
    match value {
        Value::Null => "null".into(),
        Value::String(s) => s.clone(),
        Value::Bool(b) => b.to_string(),
        Value::Number(n) => n.to_string(),
        Value::Object(_) => "[object Object]".into(),
        Value::Array(values) => values
            .iter()
            .map(|v| {
                if v.is_null() {
                    String::new()
                } else {
                    js_string(v)
                }
            })
            .collect::<Vec<_>>()
            .join(","),
    }
}
fn coerced_field(input: &Value, key: &str) -> String {
    match input.get(key) {
        None | Some(Value::Null) | Some(Value::Bool(false)) => String::new(),
        Some(value) => js_string(value),
    }
}

/// Legacy serde boundary used by existing callers. Its historical coercion of
/// objects and numbers is retained, including treating own `toString` fields
/// as ordinary objects rather than reporting JavaScript coercion errors. Use
/// `classify_adjustment_json` for the full ordinary JSON-data contract.
pub fn classify_adjustment(input: &Value) -> Option<&'static str> {
    if input.get("entryKind").and_then(Value::as_str) != Some("adjustment") {
        return None;
    }
    if let Some(found) = explicit_adjustment(input.get("adjustmentType").and_then(Value::as_str)) {
        return Some(found);
    }
    let source = coerced_field(input, "source");
    let operation = coerced_field(input, "operation");
    Some(adjustment_policy(
        Some(&source),
        Some(&operation),
        input.get("reason").and_then(Value::as_str) == Some("Free benefits"),
    ))
}

fn explicit_adjustment(value: Option<&str>) -> Option<&'static str> {
    value.and_then(|explicit| ADJUSTMENT_TYPES.into_iter().find(|&kind| kind == explicit))
}

// Both strings are already coerced before this policy is entered, even when
// an earlier policy branch would otherwise make the operation unnecessary.
fn adjustment_policy(
    source: Option<&str>,
    operation: Option<&str>,
    free_benefits: bool,
) -> &'static str {
    if source == Some("polar_meter_credit") {
        "native_grant"
    } else if matches!(
        source,
        Some("free_credit_reset" | "free_credit_reset_worker")
    ) || operation == Some("monthly_reset")
    {
        "monthly_reset"
    } else if source == Some("admin_credit_grant") {
        "manual_grant"
    } else if source == Some("credit_pack_purchase") || operation == Some("purchase_pack") {
        "purchased_pack"
    } else if operation == Some("refund") {
        "refund"
    } else if operation == Some("correction") {
        "correction"
    } else if source == Some("activation") || free_benefits {
        "activation"
    } else {
        "other"
    }
}

/// Source-equivalent classification for ordinary JSON-data objects. Strings
/// retain UTF-16, duplicate fields use their last value, and non-callable own
/// `toString` fields report TypeError. Executable hooks and custom prototypes
/// are outside this boundary. A null top-level input reports TypeError.
#[cfg(feature = "tts-utilities")]
pub fn classify_adjustment_json(
    input: &super::lossless_json::JsonValue,
) -> Result<Option<&'static str>, super::tts::settings::SettingsError> {
    use super::{js_string::JsString, lossless_json::JsonValue, tts::settings};
    if matches!(input, JsonValue::Null) {
        return Err(settings::SettingsError);
    }
    let string = |key| match input.get(key) {
        Some(JsonValue::String(value)) => value.as_str(),
        _ => None,
    };
    if string("entryKind") != Some("adjustment") {
        return Ok(None);
    }
    if let Some(found) = explicit_adjustment(string("adjustmentType")) {
        return Ok(Some(found));
    }
    let coerce = |key| match input.get(key) {
        Some(value) if settings::truthy(value) => settings::js_string(value),
        _ => Ok(JsString::from_static("")),
    };
    let source = coerce("source")?;
    let operation = coerce("operation")?;
    Ok(Some(adjustment_policy(
        source.as_str(),
        operation.as_str(),
        string("reason") == Some("Free benefits"),
    )))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn every_source_classification_and_fallback() {
        let fixtures = [
            (
                "tts_fish",
                "usage",
                "tts",
                "synthesize",
                "tts_queue",
                "fish",
            ),
            (
                "tts_kokoro",
                "usage",
                "tts",
                "synthesize",
                "tts_queue",
                "kokoro",
            ),
            (
                "tts_piper",
                "usage",
                "tts",
                "synthesize",
                "tts_queue",
                "piper",
            ),
            (
                "messages",
                "usage",
                "ai_chat",
                "message",
                "chat",
                "openrouter",
            ),
            (
                "harness_tools",
                "usage",
                "ai_chat",
                "tool_reasoning",
                "chat",
                "openrouter",
            ),
            (
                "harness_end",
                "usage",
                "ai_chat",
                "final_response",
                "chat",
                "openrouter",
            ),
            (
                "planner",
                "usage",
                "ai_agent",
                "plan",
                "code_execution",
                "openrouter",
            ),
            (
                "coding_agent",
                "usage",
                "ai_agent",
                "generate_code",
                "code_execution",
                "openrouter",
            ),
            (
                "stream_summary",
                "usage",
                "memory",
                "stream_summary",
                "stream_offline",
                "openrouter",
            ),
            (
                "weekly_summary",
                "usage",
                "memory",
                "weekly_summary",
                "weekly_maintenance",
                "openrouter",
            ),
            (
                "monthly_summary",
                "usage",
                "memory",
                "monthly_summary",
                "monthly_maintenance",
                "openrouter",
            ),
            (
                "vod_clip_recommendation",
                "usage",
                "clip_recommendation",
                "analyze_vod",
                "clip_recommendation",
                "openrouter",
            ),
            (
                "Free benefits",
                "adjustment",
                "credit_adjustment",
                "grant",
                "activation",
                "polar",
            ),
            ("", "usage", "other", "usage", "backend", "unknown"),
            (" Odd ", "usage", "other", " Odd ", "backend", "unknown"),
        ];
        for (reason, kind, category, operation, source, provider) in fixtures {
            let c = create_ai_usage_context_with_id(reason, AiUsageContextInput::default(), || {
                "aiu_fixture".into()
            });
            assert_eq!(
                (
                    c.entry_kind.as_str(),
                    c.category.as_str(),
                    c.operation.as_str(),
                    c.source.as_str(),
                    c.provider.as_str()
                ),
                (kind, category, operation, source, provider)
            );
            assert_eq!(c.request_id, c.entry_id);
            assert_eq!(c.schema_version, 1);
            assert_eq!(c.pricing_version, "legacy-polar-math-v1");
        }
    }

    #[test]
    fn context_overrides_omission_and_metadata_spread() {
        let c = create_ai_usage_context(
            "tts_fish",
            AiUsageContextInput {
                entry_id: Some("\u{feff}entry-1 \n".into()),
                request_id: Some(" request-1 ".into()),
                parent_request_id: Some(" parent ".into()),
                channel_id: Some("channel-1".into()),
                category: Some(Category::AiAgent),
                entry_kind: Some(EntryKind::Adjustment),
                operation: Some(" custom ".into()),
                source: Some(" chat-command ".into()),
                provider: Some(" override ".into()),
                model: Some(" \t".into()),
                quantity: Some(-5.0),
                unit: Some(UsageUnit::Characters),
                resource_type: Some(ResourceType::Speech),
                resource_id: Some("speech-1".into()),
            },
        );
        assert_eq!(c.entry_id, "entry-1");
        assert_eq!(c.request_id, "request-1");
        assert!(c.model.is_none());
        let accounting = json!({"credits":150,"_cost":{"amount":0.15,"currency":"usd"},"entry_id":"old","reason":"tts_fish"});
        let original = accounting.as_object().unwrap().clone();
        let enriched = enrich_polar_usage_metadata(&original, &c);
        assert_eq!(enriched["credits"], 150);
        assert_eq!(enriched["_cost"], original["_cost"]);
        assert_eq!(enriched["entry_id"], "entry-1");
        assert_eq!(enriched["usage_source"], "chat-command");
        assert_eq!(enriched["quantity"], -5.0);
        assert!(!enriched.contains_key("model"));
        assert_eq!(original["entry_id"], "old");
        for quantity in [f64::NAN, f64::INFINITY, f64::NEG_INFINITY] {
            let c = create_ai_usage_context(
                "messages",
                AiUsageContextInput {
                    quantity: Some(quantity),
                    ..Default::default()
                },
            );
            assert!(!to_polar_usage_metadata(&c).contains_key("quantity"));
        }
        let c = create_ai_usage_context(
            "",
            AiUsageContextInput {
                quantity: Some(0.0),
                ..Default::default()
            },
        );
        assert!(c.entry_id.starts_with("aiu_"));
        assert!(uuid::Uuid::parse_str(&c.entry_id[4..]).is_ok());
        assert_eq!(to_polar_usage_metadata(&c)["quantity"], 0.0);
        for field in [
            "prompt",
            "text",
            "message",
            "model",
            "parent_request_id",
            "resource_id",
        ] {
            assert!(!to_polar_usage_metadata(&c).contains_key(field));
        }
    }

    #[test]
    fn adjustment_precedence_unknown_fields_and_explicit_types() {
        for kind in ADJUSTMENT_TYPES {
            assert_eq!(
                classify_adjustment(
                    &json!({"entryKind":"adjustment","adjustmentType":kind,"source":"polar_meter_credit"})
                ),
                Some(kind)
            );
        }
        for (fields, expected) in [
            (
                json!({"source":"polar_meter_credit","operation":"monthly_reset"}),
                "native_grant",
            ),
            (json!({"source":"free_credit_reset"}), "monthly_reset"),
            (
                json!({"source":"free_credit_reset_worker"}),
                "monthly_reset",
            ),
            (
                json!({"source":"admin_credit_grant","operation":"refund"}),
                "manual_grant",
            ),
            (
                json!({"source":"credit_pack_purchase","operation":"refund"}),
                "purchased_pack",
            ),
            (json!({"operation":"purchase_pack"}), "purchased_pack"),
            (
                json!({"operation":"refund","source":"activation"}),
                "refund",
            ),
            (json!({"operation":"correction"}), "correction"),
            (json!({"reason":"Free benefits"}), "activation"),
            (json!({"source":["activation"]}), "activation"),
            (
                json!({"source":{},"operation":null,"adjustmentType":["refund"]}),
                "other",
            ),
            (json!({}), "other"),
        ] {
            let mut input = fields.as_object().unwrap().clone();
            input.insert("entryKind".into(), "adjustment".into());
            assert_eq!(classify_adjustment(&Value::Object(input)), Some(expected));
        }
        for input in [
            json!({}),
            json!({"entryKind":"usage","operation":"refund"}),
            json!({"entryKind":["adjustment"]}),
        ] {
            assert_eq!(classify_adjustment(&input), None);
        }
    }
}
