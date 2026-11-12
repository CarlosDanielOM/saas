//! Polar ingest events: what the SDK puts on the wire, and the accounting metadata of an AI usage
//! event and of a credit grant (`dimabot/src/utils/polarsh.ts`).
//!
//! **Money.** The cost-to-credits math is the reference's, in doubles: `Math.ceil(cost * 1000)`
//! credits for plain and TTS events; for LLM events the cost is first moved to cents and cut
//! (`Math.round(cost * 100 * 1e8) / 1e8`, at most 12 characters of its JavaScript text), and the
//! credits are `Math.ceil(costCents * 1000)`. The cuts are of ASCII number text, so they count
//! characters and bytes alike.
//!
//! **Wire.** `events.ingest` sends `{"events":[{"name","external_id","metadata","customer_id"}]}`
//! after the SDK's input validation, which refuses a metadata value that is `null`, a nested
//! object other than its cost (`{amount, currency}`) and LLM shapes, or an LLM token count that
//! is not a safe integer; the LLM shape goes out with snake-case token names. A value that is not
//! a finite number cannot be held in JSON here and is kept as `null`, which the validation then
//! refuses, as the SDK refuses `NaN` (recorded from `@polar-sh/sdk` 0.42.5 by the corpus).

use super::PolarError;
use crate::usage::{
    AiUsageContext, AiUsageContextInput, Unit, create_ai_usage_context, enrich_polar_usage_metadata,
};
use dima_core::{Random, RandomError};
use dima_model::Private;
use serde_json::{Map, Value};

/// One event for `events.ingest`. `Debug` prints the metadata's keys, not its values (a grant
/// names the admin who made it), and no customer id.
#[derive(Clone, PartialEq)]
pub struct IngestEvent {
    /// Event name (`ai_usage` for credits).
    pub name: String,
    /// Polar customer id.
    pub customer_id: Private<String>,
    /// Polar's dedupe key.
    pub external_id: String,
    /// Metadata, keys in the reference's order.
    pub metadata: Map<String, Value>,
}

impl std::fmt::Debug for IngestEvent {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("IngestEvent")
            .field("name", &self.name)
            .field("customer_id", &self.customer_id)
            .field("external_id", &self.external_id)
            .field("metadata_keys", &self.metadata.keys().collect::<Vec<_>>())
            .finish()
    }
}

fn is_safe_int(value: &Value) -> bool {
    value
        .as_f64()
        .is_some_and(|x| x.fract() == 0.0 && x.abs() <= 9_007_199_254_740_991.0)
}

/// The SDK's `EventMetadataInput` union for one value: text, a finite number, a boolean, the cost
/// shape or the LLM shape (unknown keys of a shape dropped, as zod objects strip them).
fn wire_metadata_value(value: &Value) -> Result<Value, PolarError> {
    let refused = PolarError::InvalidInput("event metadata value is not accepted by Polar");
    match value {
        Value::String(_) | Value::Bool(_) | Value::Number(_) => Ok(value.clone()),
        Value::Null | Value::Array(_) => Err(refused),
        Value::Object(object) => {
            let text = |key: &str| object.get(key).filter(|v| v.is_string()).cloned();
            // LLMMetadata: vendor, model, prompt?, response?, inputTokens, cachedInputTokens?,
            // outputTokens, totalTokens (integers), renamed to snake case.
            if let (Some(vendor), Some(model)) = (text("vendor"), text("model")) {
                let int = |key: &str| object.get(key).filter(|v| is_safe_int(v)).cloned();
                let optional_text = |key: &str| match object.get(key) {
                    None => Ok(None),
                    Some(Value::Null) => Ok(Some(Value::Null)),
                    Some(Value::String(text)) => Ok(Some(Value::String(text.clone()))),
                    Some(_) => Err(()),
                };
                if let (Some(input), Some(output), Some(total), Ok(prompt), Ok(response)) = (
                    int("inputTokens"),
                    int("outputTokens"),
                    int("totalTokens"),
                    optional_text("prompt"),
                    optional_text("response"),
                ) {
                    let cached = match object.get("cachedInputTokens") {
                        None => None,
                        Some(value) if is_safe_int(value) => Some(value.clone()),
                        Some(_) => return Err(refused),
                    };
                    let mut out = Map::new();
                    out.insert("vendor".into(), vendor);
                    out.insert("model".into(), model);
                    if let Some(prompt) = prompt {
                        out.insert("prompt".into(), prompt);
                    }
                    if let Some(response) = response {
                        out.insert("response".into(), response);
                    }
                    out.insert("input_tokens".into(), input);
                    if let Some(cached) = cached {
                        out.insert("cached_input_tokens".into(), cached);
                    }
                    out.insert("output_tokens".into(), output);
                    out.insert("total_tokens".into(), total);
                    return Ok(Value::Object(out));
                }
            }
            // CostMetadataInput: amount (number or text), currency (text).
            match (object.get("amount"), text("currency")) {
                (Some(amount @ (Value::Number(_) | Value::String(_))), Some(currency)) => {
                    let mut out = Map::new();
                    out.insert("amount".into(), amount.clone());
                    out.insert("currency".into(), currency);
                    Ok(Value::Object(out))
                }
                _ => Err(refused),
            }
        }
    }
}

impl IngestEvent {
    /// The event as the SDK sends it, or the SDK's input-validation refusal.
    pub fn wire(&self) -> Result<Value, PolarError> {
        let mut metadata = Map::new();
        for (key, value) in &self.metadata {
            metadata.insert(key.clone(), wire_metadata_value(value)?);
        }
        let mut event = Map::new();
        event.insert("name".into(), Value::from(self.name.as_str()));
        event.insert("external_id".into(), Value::from(self.external_id.as_str()));
        event.insert("metadata".into(), Value::Object(metadata));
        event.insert(
            "customer_id".into(),
            Value::from(self.customer_id.expose().as_str()),
        );
        Ok(Value::Object(event))
    }
}

/// A JavaScript number as JSON; not finite becomes `null` (see the module docs).
pub(crate) fn js_number(value: f64) -> Value {
    // `-0` is written `0` by `JSON.stringify`.
    let value = if value == 0.0 { 0.0 } else { value };
    serde_json::Number::from_f64(value).map_or(Value::Null, Value::Number)
}

/// `LLMMetadata` of an ingest call: the model and OpenRouter's token usage.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct LlmUsage {
    /// The model (`vendor/name:variant`).
    pub model: String,
    /// `usage.prompt_tokens`.
    pub prompt_tokens: Option<f64>,
    /// `usage.completion_tokens`.
    pub completion_tokens: Option<f64>,
    /// `usage.total_tokens`.
    pub total_tokens: Option<f64>,
}

/// The options of `ingestPolarSHEvent` that shape the event.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct UsageEventInput {
    /// Polar customer id.
    pub customer_id: Private<String>,
    /// Twitch channel id.
    pub channel_id: Option<String>,
    /// Stable id for Polar's dedupe.
    pub external_id: Option<String>,
    /// Cost in dollars.
    pub cost: f64,
    /// The legacy reason.
    pub reason: String,
    /// LLM usage.
    pub llm: Option<LlmUsage>,
    /// TTS cost (`_cost`, 1 = 1 cent).
    pub tts_cost: Option<f64>,
    /// TTS characters.
    pub characters: Option<f64>,
    /// Receipt context.
    pub usage: Option<AiUsageContextInput>,
}

/// `|| 0` on an optional number.
fn or_zero(value: Option<f64>) -> f64 {
    value.filter(|x| *x != 0.0 && !x.is_nan()).unwrap_or(0.0)
}

/// `Math.round(x * scale) / scale`, then the JavaScript text cut to `max` characters and parsed
/// again (`parseFloat`), as the LLM branch does.
fn rounded_and_cut(x: f64, scale: f64, max: usize) -> f64 {
    let value = crate::js::round(x * scale) / scale;
    let text = dima_text::number_to_string(value);
    if text.chars().count() > max {
        dima_text::parse_float(dima_text::truncate_chars(&text, max))
    } else {
        value
    }
}

/// `{...a, ...b}` builder in insertion order.
fn object(entries: Vec<(&str, Value)>) -> Map<String, Value> {
    entries
        .into_iter()
        .map(|(k, v)| (k.to_owned(), v))
        .collect()
}

/// The accounting metadata of `ingestPolarSHEvent` before the usage context is added.
pub fn accounting_metadata(input: &UsageEventInput) -> Map<String, Value> {
    let usd = || Value::from("usd");
    let reason = || Value::from(input.reason.as_str());
    if let Some(llm) = &input.llm {
        let amount = rounded_and_cut(input.cost * 100.0, 1e10, 17);
        let cost = rounded_and_cut(input.cost * 100.0, 1e8, 12);
        let (vendor, model) = if llm.model.is_empty() {
            ("unknown".to_owned(), "unknown".to_owned())
        } else {
            let mut parts = llm.model.split('/');
            let first = parts.next().unwrap_or("");
            let second = parts.next().filter(|s| !s.is_empty());
            let vendor = if first.is_empty() { "unknown" } else { first };
            let actual = second.unwrap_or(&llm.model);
            (
                vendor.to_owned(),
                actual.split(':').next().unwrap_or("").to_owned(),
            )
        };
        let llm_meta = object(vec![
            ("vendor", Value::from(vendor)),
            ("model", Value::from(model)),
            ("inputTokens", js_number(or_zero(llm.prompt_tokens))),
            ("outputTokens", js_number(or_zero(llm.completion_tokens))),
            ("totalTokens", js_number(or_zero(llm.total_tokens))),
        ]);
        object(vec![
            (
                "_cost",
                Value::Object(object(vec![
                    ("amount", js_number(amount)),
                    ("currency", usd()),
                ])),
            ),
            ("_llm", Value::Object(llm_meta)),
            ("cost", js_number(cost)),
            ("credits", js_number((cost * 1000.0).ceil())),
            ("currency", usd()),
            ("reason", reason()),
        ])
    } else if let Some(tts_cost) = input.tts_cost {
        let mut map = object(vec![
            (
                "_cost",
                Value::Object(object(vec![
                    ("amount", js_number(tts_cost)),
                    ("currency", usd()),
                ])),
            ),
            ("cost", js_number(input.cost)),
            ("credits", js_number((tts_cost * 1000.0).ceil())),
            ("currency", usd()),
            ("reason", reason()),
        ]);
        // `characters: characters`. Intended difference: an unset value is left out. The
        // reference sends `undefined`, which the SDK refuses in immediate mode (no immediate
        // caller passes `_cost`) and which its queued copy loses in `JSON.stringify` (batch and
        // cache modes, the TTS path), so leaving it out is what production sends.
        if let Some(characters) = input.characters {
            map.insert("characters".into(), js_number(characters));
        }
        map
    } else {
        object(vec![
            ("cost", js_number(input.cost)),
            ("currency", usd()),
            ("credits", js_number((input.cost * 1000.0).ceil())),
            ("reason", reason()),
        ])
    }
}

/// The usage context `ingestPolarSHEvent` builds from its options.
pub fn usage_event_context(
    input: &UsageEventInput,
    random: &dyn Random,
) -> Result<AiUsageContext, RandomError> {
    let usage = input.usage.clone().unwrap_or_default();
    let truthy = |value: &Option<String>| value.as_ref().filter(|v| !v.is_empty()).cloned();
    let context_input = AiUsageContextInput {
        entry_id: truthy(&input.external_id).or_else(|| usage.entry_id.clone()),
        channel_id: truthy(&usage.channel_id).or_else(|| input.channel_id.clone()),
        model: truthy(&usage.model).or_else(|| input.llm.as_ref().map(|llm| llm.model.clone())),
        quantity: usage
            .quantity
            .or(input.characters)
            .or_else(|| input.llm.as_ref().and_then(|llm| llm.total_tokens)),
        unit: usage.unit.or(if input.characters.is_some() {
            Some(Unit::Characters)
        } else if input.llm.is_some() {
            Some(Unit::Tokens)
        } else {
            None
        }),
        ..usage
    };
    create_ai_usage_context(&input.reason, &context_input, random)
}

/// The `ai_usage` event of `ingestPolarSHEvent` and its usage context. `credits` of the
/// metadata is what the local projection and the receipt use.
pub fn build_usage_event(
    input: &UsageEventInput,
    random: &dyn Random,
) -> Result<(IngestEvent, AiUsageContext), RandomError> {
    let context = usage_event_context(input, random)?;
    let metadata = enrich_polar_usage_metadata(accounting_metadata(input), &context);
    Ok((
        IngestEvent {
            name: "ai_usage".into(),
            customer_id: input.customer_id.clone(),
            external_id: context.entry_id.clone(),
            metadata,
        },
        context,
    ))
}

/// The identity of one grant (item 2 of P2-BILLING-01b): chosen by the caller that decides
/// to grant (a route, a worker) and **persisted before the grant is sent**, so that a retry
/// after a lost reply, or after a restart, sends the same grant again instead of a second one.
/// It is the event's `external_id`, which Polar deduplicates, and its usage entry and request
/// id; [`Self::idempotency_key`] derives the key of a Polar call that takes one.
///
/// What a caller persists first: the free-credit reset stores the period's record with status
/// `pending` and its `externalId` (`free-credit-reset-{user}-{day}`) before granting; an admin
/// grant stores the request's operation id with the pending grant (or receives it from the
/// client, which repeats it on retry); a gift stores it on the gift document. An id that was
/// never persisted cannot protect a retry.
///
/// Text rule: 1 to [`OperationId::MAX_LEN`] printable ASCII characters without spaces, so it
/// is the same text in Polar, in a receipt and in a key (`[!-~]`).
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub struct OperationId(String);

/// An operation id that is empty, too long or not printable ASCII.
#[derive(Clone, Copy, Debug, PartialEq, Eq, thiserror::Error)]
#[error("operation id must be 1 to 128 printable ASCII characters without spaces")]
pub struct InvalidOperationId;

impl OperationId {
    /// The longest id accepted.
    pub const MAX_LEN: usize = 128;

    /// Checks `text` (see the type docs).
    pub fn new(text: &str) -> Result<Self, InvalidOperationId> {
        if text.is_empty()
            || text.len() > Self::MAX_LEN
            || !text.bytes().all(|byte| byte.is_ascii_graphic())
        {
            return Err(InvalidOperationId);
        }
        Ok(Self(text.to_owned()))
    }

    /// The id.
    pub fn as_str(&self) -> &str {
        &self.0
    }

    /// `{scope}:{id}`: the `Idempotency-Key` of a Polar call made for this operation (the
    /// grant itself goes through `events.ingest`, which takes none: Polar deduplicates it by
    /// `external_id`).
    pub fn idempotency_key(&self, scope: &str) -> String {
        format!("{scope}:{}", self.0)
    }
}

impl std::fmt::Display for OperationId {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

/// The options of `grantPolarAiCredits`.
#[derive(Clone, Debug, PartialEq)]
pub struct GrantInput {
    /// Polar customer id.
    pub customer_id: Private<String>,
    /// Twitch channel id (for the receipt).
    pub channel_id: Option<String>,
    /// `Number(options.credits)`.
    pub credits: f64,
    /// The legacy reason.
    pub reason: String,
    /// The admin who granted them.
    pub admin_login: Option<Private<String>>,
    /// The grant's identity, persisted by the caller before the call ([`OperationId`]).
    /// Intended difference: the reference took an optional `externalId` and drew a new
    /// `aiu_<uuid>` per call without one, so a retry made a second grant.
    pub operation_id: OperationId,
    /// Source label.
    pub source: Option<String>,
}

/// Why a grant is refused before anything is sent (the reference's messages).
#[derive(Clone, Copy, Debug, PartialEq, Eq, thiserror::Error)]
pub enum GrantRefused {
    /// No customer.
    #[error("customerId is required")]
    MissingCustomer,
    /// Not a positive number after `Math.floor`.
    #[error("credits must be a positive number")]
    NotPositive,
}

/// The grant source: `String(source || "admin_credit_grant").trim().slice(0, 96) ||
/// "admin_credit_grant"`. `slice(0, 96)` counts UTF-16 units; the cut here never splits a
/// character (an astral character on the boundary is dropped whole, where JavaScript would keep
/// half of it as a lone surrogate).
pub fn grant_source(source: Option<&str>) -> String {
    let source = source
        .filter(|s| !s.is_empty())
        .unwrap_or("admin_credit_grant");
    let cut = dima_text::truncate_utf16_budget(dima_text::trim(source), 96);
    if cut.is_empty() {
        "admin_credit_grant".to_owned()
    } else {
        cut.to_owned()
    }
}

/// The `ai_usage` event of `grantPolarAiCredits` (credits are negative usage), its context and
/// the whole number of credits granted. The external id, entry id and request id are the
/// operation id: nothing is drawn per call.
pub fn build_grant_event(
    input: &GrantInput,
) -> Result<(IngestEvent, AiUsageContext, f64), GrantRefused> {
    let credits = input.credits.floor();
    if input.customer_id.expose().is_empty() {
        return Err(GrantRefused::MissingCustomer);
    }
    if !credits.is_finite() || credits <= 0.0 {
        return Err(GrantRefused::NotPositive);
    }
    let source = grant_source(input.source.as_deref());
    let id = input.operation_id.as_str().to_owned();
    let context = crate::usage::create_ai_usage_context_with_entry_id(
        &input.reason,
        &AiUsageContextInput {
            request_id: Some(id.clone()),
            entry_kind: Some(crate::usage::EntryKind::Adjustment),
            category: Some(crate::usage::Category::CreditAdjustment),
            operation: Some("grant".into()),
            source: Some(source.clone()),
            provider: Some("polar".into()),
            ..Default::default()
        },
        id,
    );
    let admin = input
        .admin_login
        .as_ref()
        .map(|login| login.expose().as_str())
        .filter(|login| !login.is_empty())
        .unwrap_or("unknown");
    let accounting = object(vec![
        ("credits", js_number(-credits)),
        ("cost", Value::from(0)),
        ("currency", Value::from("usd")),
        ("reason", Value::from(input.reason.as_str())),
        ("source", Value::from(source)),
        ("adminLogin", Value::from(admin)),
    ]);
    let metadata = enrich_polar_usage_metadata(accounting, &context);
    Ok((
        IngestEvent {
            name: "ai_usage".into(),
            customer_id: input.customer_id.clone(),
            external_id: context.entry_id.clone(),
            metadata,
        },
        context,
        credits,
    ))
}

/// `ingestPolarNamedEvents`' checks: never `ai_usage` or a `credits` key, and a name, customer
/// and external id on every event.
pub fn check_named_events(events: &[IngestEvent]) -> Result<(), &'static str> {
    for event in events {
        if event.name == "ai_usage" || event.metadata.contains_key("credits") {
            return Err("ingestPolarNamedEvents must not send AI credit usage");
        }
        if event.name.is_empty()
            || event.customer_id.expose().is_empty()
            || event.external_id.is_empty()
        {
            return Err("name, customerId and externalId are required");
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn llm_cost_is_moved_to_cents_and_cut() {
        let input = UsageEventInput {
            customer_id: "c".into(),
            cost: 0.000_123_456_789_123,
            reason: "messages".into(),
            llm: Some(LlmUsage {
                model: "openai/gpt-x:free".into(),
                prompt_tokens: Some(10.0),
                completion_tokens: None,
                total_tokens: Some(12.0),
            }),
            ..Default::default()
        };
        let meta = accounting_metadata(&input);
        assert_eq!(
            dima_text::to_js_json(&Value::Object(meta)),
            r#"{"_cost":{"amount":0.0123456789,"currency":"usd"},"_llm":{"vendor":"openai","model":"gpt-x","inputTokens":10,"outputTokens":0,"totalTokens":12},"cost":0.01234568,"credits":13,"currency":"usd","reason":"messages"}"#
        );
    }

    #[test]
    fn the_sdk_validation_refuses_what_it_refuses() {
        let event = |metadata: Value| IngestEvent {
            name: "ai_usage".into(),
            customer_id: "c1".into(),
            external_id: "e1".into(),
            metadata: metadata.as_object().cloned().unwrap_or_default(),
        };
        let ok = event(
            json!({"cost": 0.0015, "_llm": {"vendor": "a", "model": "m", "inputTokens": 1, "outputTokens": 2, "totalTokens": 3, "extra": 1}}),
        );
        assert_eq!(
            dima_text::to_js_json(&ok.wire().unwrap()),
            r#"{"name":"ai_usage","external_id":"e1","metadata":{"cost":0.0015,"_llm":{"vendor":"a","model":"m","input_tokens":1,"output_tokens":2,"total_tokens":3}},"customer_id":"c1"}"#
        );
        for bad in [
            json!({"x": null}),
            json!({"x": {"a": 1}}),
            json!({"_llm": {"vendor": "a", "model": "m", "inputTokens": 1.5, "outputTokens": 2, "totalTokens": 3}}),
        ] {
            assert!(matches!(
                event(bad).wire(),
                Err(PolarError::InvalidInput(_))
            ));
        }
    }

    fn grant(credits: f64) -> GrantInput {
        GrantInput {
            customer_id: "c".into(),
            channel_id: None,
            credits,
            reason: "gift".into(),
            admin_login: None,
            operation_id: OperationId::new("x1").unwrap(),
            source: None,
        }
    }

    #[test]
    fn grants_floor_credits_and_label_the_source() {
        let refused = build_grant_event(&grant(0.9));
        assert_eq!(refused.err(), Some(GrantRefused::NotPositive));
        let (event, context, credits) = build_grant_event(&GrantInput {
            source: Some("  ".into()),
            ..grant(12.7)
        })
        .unwrap();
        assert_eq!(credits, 12.0);
        assert_eq!(event.external_id, "x1");
        assert_eq!(context.request_id, "x1");
        assert_eq!(context.source, "admin_credit_grant");
        assert_eq!(event.metadata["credits"], json!(-12.0));
        assert_eq!(grant_source(Some(&"é".repeat(100))).chars().count(), 96);
    }

    #[test]
    fn operation_ids_are_printable_ascii() {
        for good in ["x", "free-credit-reset-6650a0-2026-11-01", &"a".repeat(128)] {
            assert_eq!(
                OperationId::new(good).map(|id| id.to_string()).as_deref(),
                Ok(good)
            );
        }
        for bad in ["", " x", "x y", "é", "a\n", &"a".repeat(129)] {
            assert_eq!(OperationId::new(bad), Err(InvalidOperationId));
        }
        assert_eq!(
            OperationId::new("op-1").unwrap().idempotency_key("gift"),
            "gift:op-1"
        );
    }
}
