//! Lossless JSON-data counterparts of `ai_usage_event.ts`.
//!
//! Objects are ordinary own-property JSON data (no accessors, prototypes or
//! executable hooks). Contexts passed to metadata functions must include the
//! required `AiUsageContext` properties. JSON cannot represent own `undefined`.
//! `JsonValue::Number` may additionally hold nonfinite binary64 values.
use super::{
    ai_usage::{AI_USAGE_PRICING_VERSION, AI_USAGE_SCHEMA_VERSION, classify_legacy_reason},
    js_string::JsString,
    lossless_json::JsonValue,
    tts::settings::{js_string, truthy},
};

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum AiUsageLosslessError {
    ExpectedObject,
    MissingContextField(&'static str),
    StringCoercion,
}

impl std::fmt::Display for AiUsageLosslessError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::ExpectedObject => f.write_str("expected a JSON object"),
            Self::MissingContextField(name) => write!(f, "missing context field {name}"),
            Self::StringCoercion => f.write_str("JavaScript string coercion failed"),
        }
    }
}
impl std::error::Error for AiUsageLosslessError {}

fn object(value: &JsonValue) -> Result<&[(JsString, JsonValue)], AiUsageLosslessError> {
    match value {
        JsonValue::Object(fields) => Ok(fields),
        _ => Err(AiUsageLosslessError::ExpectedObject),
    }
}
fn text(value: &str) -> JsonValue {
    JsonValue::String(value.into())
}
fn add(fields: &mut Vec<(JsString, JsonValue)>, key: &'static str, value: JsonValue) {
    fields.push((JsString::from_static(key), value));
}
fn optional_text(input: &JsonValue, key: &str) -> Result<Option<JsString>, AiUsageLosslessError> {
    let Some(value) = input.get(key).filter(|v| truthy(v)) else {
        return Ok(None);
    };
    let result = js_string(value)
        .map_err(|_| AiUsageLosslessError::StringCoercion)?
        .trim();
    Ok((!result.is_empty()).then_some(result))
}
fn selected(input: &JsonValue, key: &str, fallback: JsonValue) -> JsonValue {
    input
        .get(key)
        .filter(|v| truthy(v))
        .cloned()
        .unwrap_or(fallback)
}

/// Uses UUID v4 only if the supplied `entryId` is absent or trims to empty.
pub fn create_ai_usage_context_json(
    reason: &JsString,
    input: &JsonValue,
) -> Result<JsonValue, AiUsageLosslessError> {
    create_with(reason, input, || {
        JsString::from(format!("aiu_{}", uuid::Uuid::new_v4()))
    })
}

/// Deterministic fallback ID for source-parity tests. It is used verbatim.
pub fn create_ai_usage_context_json_with_id(
    reason: &JsString,
    input: &JsonValue,
    fallback_id: &JsString,
) -> Result<JsonValue, AiUsageLosslessError> {
    create_with(reason, input, || fallback_id.clone())
}

fn create_with(
    reason: &JsString,
    input: &JsonValue,
    fallback: impl FnOnce() -> JsString,
) -> Result<JsonValue, AiUsageLosslessError> {
    object(input)?;
    let classified = classify_legacy_reason(reason.as_str().unwrap_or(""));
    let operation = if reason.as_str().is_none() {
        reason.clone()
    } else {
        classified.operation.into()
    };
    let entry = optional_text(input, "entryId")?.unwrap_or_else(fallback);
    let request = optional_text(input, "requestId")?.unwrap_or_else(|| entry.clone());
    let mut out = Vec::new();
    add(
        &mut out,
        "schemaVersion",
        JsonValue::Number(f64::from(AI_USAGE_SCHEMA_VERSION)),
    );
    add(&mut out, "pricingVersion", text(AI_USAGE_PRICING_VERSION));
    add(&mut out, "entryId", JsonValue::String(entry));
    add(&mut out, "requestId", JsonValue::String(request));
    if let Some(value) = optional_text(input, "parentRequestId")? {
        add(&mut out, "parentRequestId", JsonValue::String(value));
    }
    add(
        &mut out,
        "entryKind",
        selected(input, "entryKind", text(classified.entry_kind.as_str())),
    );
    add(
        &mut out,
        "category",
        selected(input, "category", text(classified.category.as_str())),
    );
    add(
        &mut out,
        "operation",
        JsonValue::String(optional_text(input, "operation")?.unwrap_or(operation)),
    );
    add(
        &mut out,
        "source",
        JsonValue::String(
            optional_text(input, "source")?.unwrap_or_else(|| classified.source.into()),
        ),
    );
    add(
        &mut out,
        "provider",
        JsonValue::String(
            optional_text(input, "provider")?.unwrap_or_else(|| classified.provider.into()),
        ),
    );
    for key in ["model", "channelID"] {
        if let Some(value) = optional_text(input, key)? {
            add(&mut out, key, JsonValue::String(value));
        }
    }
    if let Some(JsonValue::Number(number)) = input.get("quantity")
        && number.is_finite()
    {
        add(&mut out, "quantity", JsonValue::Number(*number));
    }
    for key in ["unit", "resourceType"] {
        if let Some(value) = input.get(key).filter(|v| truthy(v)) {
            add(&mut out, key, value.clone());
        }
    }
    if let Some(value) = optional_text(input, "resourceId")? {
        add(&mut out, "resourceId", JsonValue::String(value));
    }
    Ok(JsonValue::Object(out))
}

/// Canonical metadata in source order, with `quantity` present even if null.
pub fn to_polar_usage_metadata_json(
    context: &JsonValue,
) -> Result<JsonValue, AiUsageLosslessError> {
    object(context)?;
    let mut out = Vec::new();
    for (input, output, required, truthy_only) in [
        ("schemaVersion", "schema_version", true, false),
        ("pricingVersion", "pricing_version", true, false),
        ("entryId", "entry_id", true, false),
        ("requestId", "request_id", true, false),
        ("parentRequestId", "parent_request_id", false, true),
        ("entryKind", "entry_kind", true, false),
        ("category", "category", true, false),
        ("operation", "operation", true, false),
        ("source", "usage_source", true, false),
        ("provider", "provider", true, false),
        ("model", "model", false, true),
        ("channelID", "channel_id", false, true),
        ("quantity", "quantity", false, false),
        ("unit", "unit", false, true),
        ("resourceType", "resource_type", false, true),
        ("resourceId", "resource_id", false, true),
    ] {
        match context.get(input) {
            Some(value) if !truthy_only || truthy(value) => add(&mut out, output, value.clone()),
            None if required => return Err(AiUsageLosslessError::MissingContextField(input)),
            _ => {}
        }
    }
    Ok(JsonValue::Object(out))
}

/// JavaScript object spread replaces an existing key without changing its position.
pub fn enrich_polar_usage_metadata_json(
    accounting: &JsonValue,
    context: &JsonValue,
) -> Result<JsonValue, AiUsageLosslessError> {
    let mut out: Vec<(JsString, JsonValue)> = Vec::new();
    let JsonValue::Object(canonical) = to_polar_usage_metadata_json(context)? else {
        unreachable!()
    };
    for (key, value) in object(accounting)?.iter().cloned().chain(canonical) {
        if let Some((_, old)) = out.iter_mut().find(|(existing, _)| *existing == key) {
            *old = value;
        } else {
            out.push((key, value));
        }
    }
    Ok(JsonValue::Object(out))
}
