//! How an AI usage event is described: its classification from the legacy `reason`, the context
//! carried with every Polar `ai_usage` event, the snake-case metadata Polar receives, and how a
//! credit adjustment is typed for receipts.
//!
//! Reference: `dimabot/src/utils/ai_usage_event.ts` and `utils/ai_usage_classification.ts`.
//!
//! Text: `optionalText` trims with JavaScript's whitespace set ([`dima_text::trim`]); no length
//! limits. The generated entry id is `aiu_` and a random UUID v4 from the injected randomness.
//! Metadata key order is the reference's spread order: Polar stores the object as sent, and the
//! receipt pipeline (second half of this crate) reads it back by key, never by position.

use dima_core::{Random, RandomError};
use serde_json::{Map, Value};

/// `AI_USAGE_SCHEMA_VERSION`.
pub const AI_USAGE_SCHEMA_VERSION: u32 = 1;
/// `AI_USAGE_PRICING_VERSION`.
pub const AI_USAGE_PRICING_VERSION: &str = "legacy-polar-math-v1";

macro_rules! text_enum {
    ($(#[$meta:meta])* $name:ident { $($(#[$vmeta:meta])* $variant:ident = $text:literal,)+ }) => {
        $(#[$meta])*
        #[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
        pub enum $name {
            $($(#[$vmeta])* $variant,)+
        }

        impl $name {
            /// Every value, in the reference's order.
            pub const ALL: &'static [Self] = &[$(Self::$variant,)+];

            /// The stored text.
            pub fn as_str(self) -> &'static str {
                match self {
                    $(Self::$variant => $text,)+
                }
            }

            /// The value for its stored text.
            pub fn parse(text: &str) -> Option<Self> {
                match text {
                    $($text => Some(Self::$variant),)+
                    _ => None,
                }
            }
        }
    };
}

text_enum! {
    /// `AiUsageEntryKind`.
    EntryKind {
        /// Credits spent.
        Usage = "usage",
        /// Credits granted or corrected.
        Adjustment = "adjustment",
    }
}

text_enum! {
    /// `AiUsageCategory`.
    Category {
        /// Text to speech.
        Tts = "tts",
        /// Chat answers.
        AiChat = "ai_chat",
        /// Agent work.
        AiAgent = "ai_agent",
        /// Stream memory summaries.
        Memory = "memory",
        /// VOD clip recommendations.
        ClipRecommendation = "clip_recommendation",
        /// Grants and corrections.
        CreditAdjustment = "credit_adjustment",
        /// Anything else.
        Other = "other",
    }
}

text_enum! {
    /// `AiUsageUnit`.
    Unit {
        /// Characters (TTS).
        Characters = "characters",
        /// Tokens (LLM).
        Tokens = "tokens",
        /// Minutes (VOD analysis).
        Minutes = "minutes",
    }
}

text_enum! {
    /// `AiUsageResourceType`.
    ResourceType {
        /// A spoken message.
        Speech = "speech",
        /// A voice preview.
        VoicePreview = "voice_preview",
        /// An LLM generation.
        LlmGeneration = "llm_generation",
        /// A VOD analysis.
        VodAnalysis = "vod_analysis",
    }
}

/// What the legacy `reason` says about an event (`classifyLegacyReason`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Classification {
    /// Usage or adjustment.
    pub entry_kind: EntryKind,
    /// Category.
    pub category: Category,
    /// Operation name.
    pub operation: String,
    /// Usage source.
    pub source: &'static str,
    /// Provider.
    pub provider: &'static str,
}

/// `classifyLegacyReason(reason)`.
pub fn classify_legacy_reason(reason: &str) -> Classification {
    use Category as C;
    use EntryKind::{Adjustment, Usage};
    let (entry_kind, category, operation, source, provider): (_, _, &str, _, _) = match reason {
        // `reason.slice(4)`: the reason is ASCII here, so the provider is the text after `tts_`.
        "tts_fish" => (Usage, C::Tts, "synthesize", "tts_queue", "fish"),
        "tts_kokoro" => (Usage, C::Tts, "synthesize", "tts_queue", "kokoro"),
        "tts_piper" => (Usage, C::Tts, "synthesize", "tts_queue", "piper"),
        "messages" => (Usage, C::AiChat, "message", "chat", "openrouter"),
        "harness_tools" => (Usage, C::AiChat, "tool_reasoning", "chat", "openrouter"),
        "harness_end" => (Usage, C::AiChat, "final_response", "chat", "openrouter"),
        "planner" => (Usage, C::AiAgent, "plan", "code_execution", "openrouter"),
        "coding_agent" => (
            Usage,
            C::AiAgent,
            "generate_code",
            "code_execution",
            "openrouter",
        ),
        "stream_summary" => (
            Usage,
            C::Memory,
            "stream_summary",
            "stream_offline",
            "openrouter",
        ),
        "weekly_summary" => (
            Usage,
            C::Memory,
            "weekly_summary",
            "weekly_maintenance",
            "openrouter",
        ),
        "monthly_summary" => (
            Usage,
            C::Memory,
            "monthly_summary",
            "monthly_maintenance",
            "openrouter",
        ),
        "vod_clip_recommendation" => (
            Usage,
            C::ClipRecommendation,
            "analyze_vod",
            "clip_recommendation",
            "openrouter",
        ),
        "Free benefits" => (
            Adjustment,
            C::CreditAdjustment,
            "grant",
            "activation",
            "polar",
        ),
        other => (
            Usage,
            C::Other,
            if other.is_empty() { "usage" } else { other },
            "backend",
            "unknown",
        ),
    };
    Classification {
        entry_kind,
        category,
        operation: operation.to_owned(),
        source,
        provider,
    }
}

/// `AiUsageContextInput`: what a caller may set. Text fields are trimmed; empty text counts as
/// unset, as `optionalText` does.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct AiUsageContextInput {
    /// Stable entry id (Polar's dedupe key).
    pub entry_id: Option<String>,
    /// Request id (defaults to the entry id).
    pub request_id: Option<String>,
    /// Parent request id.
    pub parent_request_id: Option<String>,
    /// Overrides the classified kind.
    pub entry_kind: Option<EntryKind>,
    /// Overrides the classified category.
    pub category: Option<Category>,
    /// Overrides the classified operation.
    pub operation: Option<String>,
    /// Overrides the classified source.
    pub source: Option<String>,
    /// Overrides the classified provider.
    pub provider: Option<String>,
    /// Model name.
    pub model: Option<String>,
    /// Twitch channel id.
    pub channel_id: Option<String>,
    /// Quantity (kept only when finite).
    pub quantity: Option<f64>,
    /// Unit of the quantity.
    pub unit: Option<Unit>,
    /// Resource type.
    pub resource_type: Option<ResourceType>,
    /// Resource id.
    pub resource_id: Option<String>,
}

/// `AiUsageContext`.
#[derive(Clone, Debug, PartialEq)]
pub struct AiUsageContext {
    /// Always [`AI_USAGE_SCHEMA_VERSION`].
    pub schema_version: u32,
    /// Always [`AI_USAGE_PRICING_VERSION`].
    pub pricing_version: &'static str,
    /// Entry id.
    pub entry_id: String,
    /// Request id.
    pub request_id: String,
    /// Parent request id.
    pub parent_request_id: Option<String>,
    /// Kind.
    pub entry_kind: EntryKind,
    /// Category.
    pub category: Category,
    /// Operation.
    pub operation: String,
    /// Usage source.
    pub source: String,
    /// Provider.
    pub provider: String,
    /// Model.
    pub model: Option<String>,
    /// Twitch channel id.
    pub channel_id: Option<String>,
    /// Quantity.
    pub quantity: Option<f64>,
    /// Unit.
    pub unit: Option<Unit>,
    /// Resource type.
    pub resource_type: Option<ResourceType>,
    /// Resource id.
    pub resource_id: Option<String>,
}

/// `optionalText`: `String(value || '').trim() || undefined`.
pub(crate) fn optional_text(value: Option<&str>) -> Option<String> {
    let trimmed = dima_text::trim(value.unwrap_or(""));
    (!trimmed.is_empty()).then(|| trimmed.to_owned())
}

/// `createAiUsageContext(reason, input)`. The entry id, when the input has none, is
/// `aiu_<uuid v4>` from `random`.
pub fn create_ai_usage_context(
    reason: &str,
    input: &AiUsageContextInput,
    random: &dyn Random,
) -> Result<AiUsageContext, RandomError> {
    let entry_id = match optional_text(input.entry_id.as_deref()) {
        Some(id) => id,
        None => format!("aiu_{}", random.uuid_v4()?),
    };
    Ok(create_ai_usage_context_with_entry_id(
        reason, input, entry_id,
    ))
}

fn create_ai_usage_context_with_entry_id(
    reason: &str,
    input: &AiUsageContextInput,
    entry_id: String,
) -> AiUsageContext {
    let classified = classify_legacy_reason(reason);
    AiUsageContext {
        schema_version: AI_USAGE_SCHEMA_VERSION,
        pricing_version: AI_USAGE_PRICING_VERSION,
        request_id: optional_text(input.request_id.as_deref()).unwrap_or_else(|| entry_id.clone()),
        entry_id,
        parent_request_id: optional_text(input.parent_request_id.as_deref()),
        entry_kind: input.entry_kind.unwrap_or(classified.entry_kind),
        category: input.category.unwrap_or(classified.category),
        operation: optional_text(input.operation.as_deref()).unwrap_or(classified.operation),
        source: optional_text(input.source.as_deref())
            .unwrap_or_else(|| classified.source.to_owned()),
        provider: optional_text(input.provider.as_deref())
            .unwrap_or_else(|| classified.provider.to_owned()),
        model: optional_text(input.model.as_deref()),
        channel_id: optional_text(input.channel_id.as_deref()),
        quantity: input.quantity.filter(|value| value.is_finite()),
        unit: input.unit,
        resource_type: input.resource_type,
        resource_id: optional_text(input.resource_id.as_deref()),
    }
}

fn number(value: f64) -> Value {
    serde_json::Number::from_f64(value).map_or(Value::Null, Value::Number)
}

/// `toPolarUsageMetadata(context)`, keys in the reference's order.
pub fn to_polar_usage_metadata(context: &AiUsageContext) -> Map<String, Value> {
    let mut map = Map::new();
    map.insert("schema_version".into(), Value::from(context.schema_version));
    map.insert(
        "pricing_version".into(),
        Value::from(context.pricing_version),
    );
    map.insert("entry_id".into(), Value::from(context.entry_id.as_str()));
    map.insert(
        "request_id".into(),
        Value::from(context.request_id.as_str()),
    );
    if let Some(parent) = &context.parent_request_id {
        map.insert("parent_request_id".into(), Value::from(parent.as_str()));
    }
    map.insert(
        "entry_kind".into(),
        Value::from(context.entry_kind.as_str()),
    );
    map.insert("category".into(), Value::from(context.category.as_str()));
    map.insert("operation".into(), Value::from(context.operation.as_str()));
    map.insert("usage_source".into(), Value::from(context.source.as_str()));
    map.insert("provider".into(), Value::from(context.provider.as_str()));
    if let Some(model) = &context.model {
        map.insert("model".into(), Value::from(model.as_str()));
    }
    if let Some(channel) = &context.channel_id {
        map.insert("channel_id".into(), Value::from(channel.as_str()));
    }
    if let Some(quantity) = context.quantity {
        map.insert("quantity".into(), number(quantity));
    }
    if let Some(unit) = context.unit {
        map.insert("unit".into(), Value::from(unit.as_str()));
    }
    if let Some(resource_type) = context.resource_type {
        map.insert("resource_type".into(), Value::from(resource_type.as_str()));
    }
    if let Some(resource) = &context.resource_id {
        map.insert("resource_id".into(), Value::from(resource.as_str()));
    }
    map
}

/// `enrichPolarUsageMetadata(accounting, context)`: `{...accounting, ...metadata}`. A metadata
/// key the accounting object already has keeps its position and takes the metadata value, as an
/// object spread does.
pub fn enrich_polar_usage_metadata(
    accounting: Map<String, Value>,
    context: &AiUsageContext,
) -> Map<String, Value> {
    let mut map = accounting;
    for (key, value) in to_polar_usage_metadata(context) {
        map.insert(key, value);
    }
    map
}

/// `ADJUSTMENT_TYPES`.
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

/// The fields `classifyAdjustment` reads. Every one is a string or absent where the reference
/// calls it (receipt documents and queued receipts whose schema fields are strings).
#[derive(Clone, Copy, Debug, Default)]
pub struct AdjustmentInput<'a> {
    /// `entryKind`.
    pub entry_kind: Option<&'a str>,
    /// `operation`.
    pub operation: Option<&'a str>,
    /// `source`.
    pub source: Option<&'a str>,
    /// `reason`.
    pub reason: Option<&'a str>,
    /// `adjustmentType`.
    pub adjustment_type: Option<&'a str>,
}

/// `classifyAdjustment(input)`: `None` for usage entries.
pub fn classify_adjustment(input: AdjustmentInput<'_>) -> Option<&'static str> {
    if input.entry_kind != Some("adjustment") {
        return None;
    }
    if let Some(known) = input.adjustment_type.and_then(|kind| {
        ADJUSTMENT_TYPES
            .iter()
            .find(|candidate| **candidate == kind)
    }) {
        return Some(known);
    }
    let source = input.source.unwrap_or("");
    let operation = input.operation.unwrap_or("");
    Some(if source == "polar_meter_credit" {
        "native_grant"
    } else if source == "free_credit_reset"
        || source == "free_credit_reset_worker"
        || operation == "monthly_reset"
    {
        "monthly_reset"
    } else if source == "admin_credit_grant" {
        "manual_grant"
    } else if source == "credit_pack_purchase" || operation == "purchase_pack" {
        "purchased_pack"
    } else if operation == "refund" {
        "refund"
    } else if operation == "correction" {
        "correction"
    } else if source == "activation" || input.reason == Some("Free benefits") {
        "activation"
    } else {
        "other"
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use dima_core::SeededRandom;

    fn context(reason: &str, input: AiUsageContextInput) -> AiUsageContext {
        create_ai_usage_context(reason, &input, &SeededRandom::new(1)).unwrap()
    }

    // ai_usage_event.test.ts: "canonical TTS metadata is additive and preserves accounting fields"
    #[test]
    fn canonical_tts_metadata_is_additive_and_preserves_accounting_fields() {
        let accounting: Map<String, Value> = serde_json::from_str(
            r#"{"_cost":{"amount":0.15,"currency":"usd"},"cost":0.0015,"credits":150,"currency":"usd","reason":"tts_fish","characters":100}"#,
        )
        .unwrap();
        let context = context(
            "tts_fish",
            AiUsageContextInput {
                entry_id: Some("entry-1".into()),
                request_id: Some("request-1".into()),
                channel_id: Some("channel-1".into()),
                resource_type: Some(ResourceType::Speech),
                resource_id: Some("speech-1".into()),
                quantity: Some(100.0),
                unit: Some(Unit::Characters),
                ..Default::default()
            },
        );
        let enriched = enrich_polar_usage_metadata(accounting.clone(), &context);
        for (key, value) in &accounting {
            assert_eq!(enriched.get(key), Some(value));
        }
        assert_eq!(enriched["schema_version"], 1);
        assert_eq!(enriched["pricing_version"], AI_USAGE_PRICING_VERSION);
        assert_eq!(enriched["entry_id"], "entry-1");
        assert_eq!(enriched["request_id"], "request-1");
        assert_eq!(enriched["category"], "tts");
        assert_eq!(enriched["operation"], "synthesize");
        assert_eq!(enriched["provider"], "fish");
        assert_eq!(enriched["resource_id"], "speech-1");
    }

    // ai_usage_event.test.ts: "legacy reasons map to receipt categories without storing prompts or text"
    #[test]
    fn legacy_reasons_map_to_receipt_categories_without_storing_prompts_or_text() {
        let context = context(
            "harness_tools",
            AiUsageContextInput {
                entry_id: Some("entry-2".into()),
                request_id: Some("request-2".into()),
                model: Some("openai/model".into()),
                quantity: Some(42.0),
                unit: Some(Unit::Tokens),
                ..Default::default()
            },
        );
        let metadata = enrich_polar_usage_metadata(
            serde_json::from_str(
                r#"{"cost":1,"credits":1000,"currency":"usd","reason":"harness_tools"}"#,
            )
            .unwrap(),
            &context,
        );
        assert_eq!(metadata["category"], "ai_chat");
        assert_eq!(metadata["operation"], "tool_reasoning");
        assert_eq!(metadata["provider"], "openrouter");
        assert_eq!(metadata["quantity"], 42.0);
        assert_eq!(metadata["unit"], "tokens");
        for absent in ["text", "prompt", "message"] {
            assert!(!metadata.contains_key(absent));
        }
    }

    #[test]
    fn generated_ids_and_trimmed_text() {
        let context = context(
            "",
            AiUsageContextInput {
                entry_id: Some(" \u{feff} ".into()),
                model: Some("\u{3000}emoji 😃 model\u{2028}".into()),
                channel_id: Some("  ".into()),
                quantity: Some(f64::NAN),
                ..Default::default()
            },
        );
        assert!(context.entry_id.starts_with("aiu_"));
        assert_eq!(context.entry_id.chars().count(), 40);
        assert_eq!(context.request_id, context.entry_id);
        assert_eq!(context.operation, "usage");
        assert_eq!(context.model.as_deref(), Some("emoji 😃 model"));
        assert_eq!(context.channel_id, None);
        assert_eq!(context.quantity, None);
    }

    #[test]
    fn adjustments_are_typed_in_the_reference_order() {
        let input =
            |source: Option<&'static str>, operation: Option<&'static str>| AdjustmentInput {
                entry_kind: Some("adjustment"),
                source,
                operation,
                ..Default::default()
            };
        assert_eq!(classify_adjustment(AdjustmentInput::default()), None);
        assert_eq!(
            classify_adjustment(input(Some("polar_meter_credit"), Some("refund"))),
            Some("native_grant")
        );
        assert_eq!(
            classify_adjustment(input(None, Some("monthly_reset"))),
            Some("monthly_reset")
        );
        assert_eq!(
            classify_adjustment(input(Some("admin_credit_grant"), None)),
            Some("manual_grant")
        );
        assert_eq!(
            classify_adjustment(input(None, Some("refund"))),
            Some("refund")
        );
        assert_eq!(classify_adjustment(input(None, None)), Some("other"));
        let typed = AdjustmentInput {
            adjustment_type: Some("gifted_credits"),
            ..input(None, None)
        };
        assert_eq!(classify_adjustment(typed), Some("gifted_credits"));
        let free = AdjustmentInput {
            reason: Some("Free benefits"),
            ..input(None, None)
        };
        assert_eq!(classify_adjustment(free), Some("activation"));
    }
}
