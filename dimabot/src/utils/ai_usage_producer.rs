//! Request-time exports from ai_usage_ledger.ts, without billing or persistence.
//! Reuses the native adjustment policy, TimeClip/ISO and lossless JSON writer.
//! The lossless path preserves UTF-16, missing fields, NaN quantities and source
//! property order. The deployed consumer's serde_json::Value parser currently
//! rejects escaped lone surrogates; that separate downstream gap is not repaired
//! here. No application caller or worker is switched by this module.
use std::{
    borrow::Cow,
    sync::Arc,
    time::{SystemTime, UNIX_EPOCH},
};

use super::{
    ai_usage::{AiUsageContext, classify_adjustment},
    credit_policy::{InvalidDate, JsDate},
    js_string::{JsString, write_json_utf8},
    lossless_json::JsonValue,
};
use redis::aio::ConnectionManager;

pub const AI_USAGE_RECEIPT_QUEUE_KEY: &str = "cron:ai-usage-receipts:queue";
pub const AI_USAGE_RECEIPT_PROCESSING_KEY: &str = "cron:ai-usage-receipts:processing";

pub fn get_ai_usage_retention_days(tier: &JsonValue) -> u32 {
    match tier {
        JsonValue::String(s) if s.as_str() == Some("premium") => 60,
        JsonValue::String(s) if s.as_str() == Some("pro") => 90,
        _ => 30,
    }
}

/// Explicit concrete clocks; constructing a producer never samples its clock.
pub trait ReceiptClock: Send + Sync {
    fn now(&self) -> JsDate;
}
#[derive(Debug, Clone, Copy, Default)]
pub struct SystemReceiptClock;
impl ReceiptClock for SystemReceiptClock {
    fn now(&self) -> JsDate {
        let ms = match SystemTime::now().duration_since(UNIX_EPOCH) {
            Ok(d) => d.as_millis() as f64,
            Err(e) => -(e.duration().as_millis() as f64),
        };
        JsDate::from_millis(ms)
    }
}
#[derive(Debug, Clone, Copy)]
pub struct FixedReceiptClock(pub JsDate);
impl ReceiptClock for FixedReceiptClock {
    fn now(&self) -> JsDate {
        self.0
    }
}

fn s(value: &str) -> JsonValue {
    JsonValue::String(value.into())
}
fn truthy(value: &JsonValue) -> bool {
    match value {
        JsonValue::Null => false,
        JsonValue::Bool(b) => *b,
        JsonValue::Number(n) => *n != 0.0 && !n.is_nan(),
        JsonValue::String(s) => !s.is_empty(),
        _ => true,
    }
}

/// Owned structured value with a borrowed read API for future persist adapters.
/// Undefined source fields are absent; null is retained. All keys are fixed,
/// non-index strings, serialized in the exact object literal's insertion order.
#[derive(Debug, Clone, PartialEq)]
pub struct QueuedAiUsageReceipt {
    value: JsonValue,
}
impl QueuedAiUsageReceipt {
    pub fn as_value(&self) -> &JsonValue {
        &self.value
    }
    pub fn into_value(self) -> JsonValue {
        self.value
    }
    pub fn get(&self, key: &str) -> Option<&JsonValue> {
        self.value.get(key)
    }
    pub fn json(&self) -> String {
        let JsonValue::Object(fields) = &self.value else {
            unreachable!("builder creates object")
        };
        let mut out = String::new();
        out.push('{');
        for (index, (key, value)) in fields.iter().enumerate() {
            if index != 0 {
                out.push(',');
            }
            key.write_json_string(&mut out);
            out.push(':');
            value.write_json_string(&mut out);
        }
        out.push('}');
        out
    }
    /// Append to the existing object wire, borrowing every receipt field. No
    /// clone of the object, fields or string payloads is needed for serialization.
    pub fn json_enqueued_at(&self, date: JsDate) -> Result<String, InvalidDate> {
        let iso = date.to_iso_string()?;
        let mut out = self.json();
        out.pop();
        out.push_str(",\"enqueuedAt\":");
        write_json_utf8(&iso, &mut out);
        out.push('}');
        Ok(out)
    }
}

// Direct native field access, shared with the lossless builder. No typed-context
// JSON serialization/parsing (which would erase NaN) occurs on this path.
enum Context<'a> {
    Native(&'a AiUsageContext),
    Lossless(&'a JsonValue),
}
impl Context<'_> {
    fn get(&self, key: &str) -> Option<Cow<'_, JsonValue>> {
        match self {
            Self::Lossless(value) => value.get(key).map(Cow::Borrowed),
            Self::Native(c) => Some(Cow::Owned(match key {
                "entryId" => s(&c.entry_id),
                "requestId" => s(&c.request_id),
                "entryKind" => s(c.entry_kind.as_str()),
                "category" => s(c.category.as_str()),
                "operation" => s(&c.operation),
                "source" => s(&c.source),
                "provider" => s(&c.provider),
                "model" => s(c.model.as_deref()?),
                "quantity" => JsonValue::Number(c.quantity?),
                "unit" => s(c.unit?.as_str()),
                "resourceType" => s(c.resource_type?.as_str()),
                "resourceId" => s(c.resource_id.as_deref()?),
                _ => return None,
            })),
        }
    }
}

fn valid_context(value: &JsonValue) -> bool {
    matches!(value, JsonValue::Object(_))
        && [
            "entryId",
            "requestId",
            "entryKind",
            "operation",
            "source",
            "provider",
            "model",
            "unit",
            "resourceType",
            "resourceId",
        ]
        .iter()
        .all(|key| {
            matches!(
                value.get(key),
                None | Some(JsonValue::Null | JsonValue::String(_))
            )
        })
        && matches!(
            value.get("quantity"),
            None | Some(JsonValue::Null | JsonValue::Number(_))
        )
}

/// Plain data contract: string fields may be absent/null/string (including
/// arbitrary UTF-16); quantity may be absent/null/any binary64, including NaN.
/// Category is intentionally unknown, like safeCategory. reason/adjustmentType
/// are extra unknown classification hints: only strings can match the source's
/// strict comparisons. Wrong types in declared string/quantity fields return
/// None, rather than silently coercing invalid runtime casts. Hooks, prototypes,
/// explicit JS undefined values and non-plain objects are outside this API;
/// absent object keys represent undefined. No trimming is performed.
pub fn build_queued_ai_usage_receipt_json(
    channel_id: JsString,
    customer_id: JsString,
    occurred_at: Option<JsDate>,
    context: &JsonValue,
    credits: f64,
) -> Option<QueuedAiUsageReceipt> {
    build_queued_ai_usage_receipt_with_clock(
        channel_id,
        customer_id,
        occurred_at,
        &SystemReceiptClock,
        context,
        credits,
    )
}

/// Lossless builder with an injected clock; see the plain-data contract above.
pub fn build_queued_ai_usage_receipt_with_clock(
    channel_id: JsString,
    customer_id: JsString,
    occurred_at: Option<JsDate>,
    clock: &dyn ReceiptClock,
    context: &JsonValue,
    credits: f64,
) -> Option<QueuedAiUsageReceipt> {
    let date = occurred_at.unwrap_or_else(|| clock.now());
    if !valid_context(context) {
        return None;
    }
    build(
        channel_id,
        customer_id,
        date,
        Context::Lossless(context),
        credits,
    )
}

/// Deterministic lossless builder. Explicit invalid dates never use the clock.
pub fn build_queued_ai_usage_receipt_at(
    channel_id: JsString,
    customer_id: JsString,
    occurred_at: Option<JsDate>,
    now: JsDate,
    context: &JsonValue,
    credits: f64,
) -> Option<QueuedAiUsageReceipt> {
    build_queued_ai_usage_receipt_with_clock(
        channel_id,
        customer_id,
        occurred_at,
        &FixedReceiptClock(now),
        context,
        credits,
    )
}

/// Direct typed path for native valid UTF-8 contexts, including NaN quantity.
/// Use the lossless builder for strings containing unpaired UTF-16 code units.
pub fn build_queued_ai_usage_receipt(
    channel_id: &str,
    customer_id: &str,
    occurred_at: Option<JsDate>,
    context: &AiUsageContext,
    credits: f64,
) -> Option<QueuedAiUsageReceipt> {
    build_queued_ai_usage_receipt_native_with_clock(
        channel_id,
        customer_id,
        occurred_at,
        &SystemReceiptClock,
        context,
        credits,
    )
}

pub fn build_queued_ai_usage_receipt_native_with_clock(
    channel_id: &str,
    customer_id: &str,
    occurred_at: Option<JsDate>,
    clock: &dyn ReceiptClock,
    context: &AiUsageContext,
    credits: f64,
) -> Option<QueuedAiUsageReceipt> {
    build(
        channel_id.into(),
        customer_id.into(),
        occurred_at.unwrap_or_else(|| clock.now()),
        Context::Native(context),
        credits,
    )
}

fn build(
    channel_id: JsString,
    customer_id: JsString,
    date: JsDate,
    context: Context<'_>,
    credits: f64,
) -> Option<QueuedAiUsageReceipt> {
    if channel_id.is_empty() || customer_id.is_empty() || !credits.is_finite() {
        return None;
    }
    let iso = date.to_iso_string().ok()?;
    let mut fields = Vec::with_capacity(20);
    let mut put = |key: &str, value| fields.push((JsString::from(key), value));
    let nullable = |key| {
        context
            .get(key)
            .map(Cow::into_owned)
            .unwrap_or(JsonValue::Null)
    };
    let or_null = |key| {
        context
            .get(key)
            .filter(|v| truthy(v))
            .map(Cow::into_owned)
            .unwrap_or(JsonValue::Null)
    };
    put("channelID", JsonValue::String(channel_id));
    put("customerId", JsonValue::String(customer_id));
    if let Some(v) = context.get("entryId") {
        put("id", v.into_owned());
    }
    put("requestId", or_null("requestId"));
    put("occurredAt", s(&iso));
    if let Some(v) = context.get("entryKind") {
        put("entryKind", v.into_owned());
    }
    let category = context.get("category");
    let category = category.as_deref().and_then(|v| match v {
        JsonValue::String(x) => x.as_str(),
        _ => None,
    });
    put(
        "category",
        s(match category {
            Some(
                v @ ("tts"
                | "ai_chat"
                | "ai_agent"
                | "memory"
                | "clip_recommendation"
                | "credit_adjustment"
                | "other"
                | "uncategorized"),
            ) => v,
            _ => "uncategorized",
        }),
    );
    for key in ["operation", "source"] {
        if let Some(v) = context.get(key) {
            put(key, v.into_owned());
        }
    }
    // The only comparisons in shared classify_adjustment are ASCII strings.
    // For declared source/operation strings, a lone surrogate cannot match any
    // token; replacement in this policy-only projection cannot create a match.
    // Extra reason/adjustmentType values use strict equality/includes in TS, so
    // ignoring nonstrings is exact. Original output fields remain lossless.
    let mut classification = serde_json::Map::new();
    for key in [
        "entryKind",
        "source",
        "operation",
        "adjustmentType",
        "reason",
    ] {
        if let Some(JsonValue::String(value)) = context.get(key).as_deref() {
            classification.insert(key.into(), serde_json::Value::String(value.to_utf8_lossy()));
        }
    }
    put(
        "adjustmentType",
        classify_adjustment(&serde_json::Value::Object(classification))
            .map(s)
            .unwrap_or(JsonValue::Null),
    );
    if let Some(v) = context.get("provider") {
        put("provider", v.into_owned());
    }
    put("model", or_null("model"));
    for key in ["quantity", "unit"] {
        put(key, nullable(key));
    }
    put("credits", JsonValue::Number(credits));
    for key in ["resourceType", "resourceId"] {
        put(key, nullable(key));
    }
    put("itemized", JsonValue::Bool(true));
    Some(QueuedAiUsageReceipt {
        value: JsonValue::Object(fields),
    })
}

/// Cheap clones share the caller's multiplexed manager/socket and clock. No env
/// lookup, connection or IO happens at construction. Each operation clones only
/// the manager handle. No mutation retry: disconnect/cancellation after RPUSH may
/// leave a queued item even though the caller did not receive success.
#[derive(Clone)]
pub struct AiUsageProducer {
    cache: ConnectionManager,
    clock: Arc<dyn ReceiptClock>,
}
impl AiUsageProducer {
    pub fn new(cache: ConnectionManager) -> Self {
        Self::with_clock(cache, Arc::new(SystemReceiptClock))
    }
    pub fn with_clock(cache: ConnectionManager, clock: Arc<dyn ReceiptClock>) -> Self {
        Self { cache, clock }
    }
    pub async fn enqueue(&self, receipt: Option<&QueuedAiUsageReceipt>) -> redis::RedisResult<()> {
        let Some(receipt) = receipt else {
            return Ok(());
        };
        self.enqueue_at(Some(receipt), self.clock.now()).await
    }
    pub async fn enqueue_at(
        &self,
        receipt: Option<&QueuedAiUsageReceipt>,
        now: JsDate,
    ) -> redis::RedisResult<()> {
        let Some(receipt) = receipt else {
            return Ok(());
        };
        let wire = receipt.json_enqueued_at(now).map_err(|_| {
            redis::RedisError::from((redis::ErrorKind::Client, "invalid system date"))
        })?;
        let mut cache = self.cache.clone();
        redis::cmd("RPUSH")
            .arg(AI_USAGE_RECEIPT_QUEUE_KEY)
            .arg(wire)
            .query_async::<i64>(&mut cache)
            .await?;
        Ok(())
    }
}
