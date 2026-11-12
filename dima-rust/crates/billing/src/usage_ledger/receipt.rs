//! One receipt of the usage ledger: what an accepted use queues (`buildQueuedAiUsageReceipt`,
//! `enqueueAiUsageReceipt`), how a queued receipt is read back (`parseQueuedAiUsageReceipt` and
//! the native worker's `parse_receipt`, which agree), and the document it becomes.
//!
//! **Identity.** A receipt is the pair (channel, customer) and its entry id: the usage event's
//! `external_id` (the caller's id, else the usage entry id, else `aiu_<uuid>` drawn once when
//! the event is built), which is also Polar's deduplication key and the `entry_id` of the
//! event's metadata. The unique index `{channelID, customerId, entryId}` of `ai_usage_receipts`
//! and the upsert with `$setOnInsert` on exactly that filter make a second delivery a no-op,
//! whichever path delivers it (the receipt queue, or the backfill from Polar's history).
//!
//! **Queued form.** `JSON.stringify({...receipt, enqueuedAt})`, the reference's: Rust keeps it
//! so that receipts the TypeScript processes left behind can be carried across at the cutover
//! (`usage_receipts` module docs) and read here unchanged.
//!
//! Text: `requestId`, `source`, `model`, `resourceId`, `operation` and `provider` are trimmed and
//! cut to 128 UTF-16 units (`slice(0, 128)`); the cut lands on a character boundary
//! (`dima_text::truncate_utf16_budget`). Intended difference: where the reference and the native
//! worker would split an astral character at unit 128 and store U+FFFD for its half, Rust drops
//! the character (none of these ids holds one: they are UUIDs and ASCII labels).

use crate::polar::AcceptedUsage;
use crate::usage::{
    AdjustmentInput, AiUsageContext, EntryKind, ResourceType, Unit, classify_adjustment,
};
use crate::usage_ledger::report::{Transaction, iso, num};
use dima_model::Private;
use serde_json::{Map, Value};

/// `safeCategory(value)`: a known category (or `uncategorized`), else `uncategorized`.
pub fn safe_category(value: Option<&str>) -> &'static str {
    match value {
        Some("tts") => "tts",
        Some("ai_chat") => "ai_chat",
        Some("ai_agent") => "ai_agent",
        Some("memory") => "memory",
        Some("clip_recommendation") => "clip_recommendation",
        Some("credit_adjustment") => "credit_adjustment",
        Some("other") => "other",
        _ => "uncategorized",
    }
}

/// `nullableString(value)`: text only, trimmed, cut to 128 UTF-16 units; empty is none.
pub(crate) fn nullable_string(value: Option<&Value>) -> Option<String> {
    let text = dima_text::trim(value?.as_str()?);
    if text.is_empty() {
        return None;
    }
    Some(dima_text::truncate_utf16_budget(text, 128).to_owned())
}

/// `finiteNumber(value)` of the ledger: `typeof value === 'number' ? value : Number(value)`,
/// kept when finite (`undefined` is `NaN`, `null` is `0`).
pub(crate) fn finite_number(value: Option<&Value>) -> Option<f64> {
    let number = crate::js::number(value);
    number.is_finite().then_some(number)
}

/// A receipt on its way to the ledger (`QueuedAiUsageReceipt`). `Debug` hides the customer.
#[derive(Clone, Debug, PartialEq)]
pub struct QueuedReceipt {
    /// `channelID`.
    pub channel_id: String,
    /// `customerId` (Polar's customer id).
    pub customer_id: Private<String>,
    /// `id`: the entry id.
    pub id: String,
    /// `requestId`.
    pub request_id: Option<String>,
    /// `occurredAt` (ms).
    pub occurred_at_ms: i64,
    /// `entryKind`.
    pub entry_kind: EntryKind,
    /// `category`.
    pub category: &'static str,
    /// `operation`.
    pub operation: String,
    /// `source`.
    pub source: Option<String>,
    /// `adjustmentType`.
    pub adjustment_type: Option<String>,
    /// `provider`.
    pub provider: String,
    /// `model`.
    pub model: Option<String>,
    /// `quantity`.
    pub quantity: Option<f64>,
    /// `unit`.
    pub unit: Option<Unit>,
    /// `credits` (negative for a grant).
    pub credits: f64,
    /// `resourceType`.
    pub resource_type: Option<ResourceType>,
    /// `resourceId`.
    pub resource_id: Option<String>,
    /// `itemized`.
    pub itemized: bool,
}

/// `buildQueuedAiUsageReceipt(input)`; `None` without a channel or a customer, or with credits
/// that are not finite.
pub fn build_queued_receipt(
    channel_id: &str,
    customer_id: &Private<String>,
    occurred_at_ms: i64,
    context: &AiUsageContext,
    credits: f64,
) -> Option<QueuedReceipt> {
    if channel_id.is_empty() || customer_id.expose().is_empty() || !credits.is_finite() {
        return None;
    }
    Some(QueuedReceipt {
        channel_id: channel_id.to_owned(),
        customer_id: customer_id.clone(),
        id: context.entry_id.clone(),
        request_id: Some(context.request_id.clone()).filter(|r| !r.is_empty()),
        occurred_at_ms,
        entry_kind: context.entry_kind,
        category: safe_category(Some(context.category.as_str())),
        operation: context.operation.clone(),
        source: Some(context.source.clone()),
        adjustment_type: classify_adjustment(AdjustmentInput {
            entry_kind: Some(context.entry_kind.as_str()),
            operation: Some(&context.operation),
            source: Some(&context.source),
            reason: None,
            adjustment_type: None,
        })
        .map(str::to_owned),
        provider: context.provider.clone(),
        model: context.model.clone(),
        quantity: context.quantity,
        unit: context.unit,
        credits,
        resource_type: context.resource_type,
        resource_id: context.resource_id.clone(),
        itemized: true,
    })
}

/// [`build_queued_receipt`] of an accepted use ([`AcceptedUsage`]).
pub fn receipt_of(usage: AcceptedUsage<'_>, occurred_at_ms: i64) -> Option<QueuedReceipt> {
    build_queued_receipt(
        usage.channel_id,
        usage.customer_id,
        occurred_at_ms,
        usage.context,
        usage.credits,
    )
}

fn text_or_null(value: Option<&str>) -> Value {
    value.map_or(Value::Null, Value::from)
}

impl QueuedReceipt {
    /// The receipt's fields in the reference's order (`QueuedAiUsageReceipt`).
    fn fields(&self) -> Map<String, Value> {
        let mut map = Map::new();
        map.insert("channelID".into(), Value::from(self.channel_id.as_str()));
        map.insert(
            "customerId".into(),
            Value::from(self.customer_id.expose().as_str()),
        );
        map.insert("id".into(), Value::from(self.id.as_str()));
        map.insert("requestId".into(), text_or_null(self.request_id.as_deref()));
        map.insert("occurredAt".into(), Value::from(iso(self.occurred_at_ms)));
        map.insert("entryKind".into(), Value::from(self.entry_kind.as_str()));
        map.insert("category".into(), Value::from(self.category));
        map.insert("operation".into(), Value::from(self.operation.as_str()));
        map.insert("source".into(), text_or_null(self.source.as_deref()));
        map.insert(
            "adjustmentType".into(),
            text_or_null(self.adjustment_type.as_deref()),
        );
        map.insert("provider".into(), Value::from(self.provider.as_str()));
        map.insert("model".into(), text_or_null(self.model.as_deref()));
        map.insert("quantity".into(), self.quantity.map_or(Value::Null, num));
        map.insert("unit".into(), text_or_null(self.unit.map(Unit::as_str)));
        map.insert("credits".into(), num(self.credits));
        map.insert(
            "resourceType".into(),
            text_or_null(self.resource_type.map(ResourceType::as_str)),
        );
        map.insert(
            "resourceId".into(),
            text_or_null(self.resource_id.as_deref()),
        );
        map.insert("itemized".into(), Value::Bool(self.itemized));
        map
    }

    /// The queued bytes: `JSON.stringify({...receipt, enqueuedAt})`.
    pub fn queued_text(&self, enqueued_at_ms: i64) -> String {
        let mut map = self.fields();
        map.insert("enqueuedAt".into(), Value::from(iso(enqueued_at_ms)));
        dima_text::to_js_json(&Value::Object(map))
    }

    /// The receipt as a transaction of the usage history.
    pub fn transaction(&self) -> Transaction {
        Transaction {
            id: self.id.clone(),
            request_id: self.request_id.clone(),
            occurred_at_ms: self.occurred_at_ms,
            entry_kind: self.entry_kind,
            category: self.category.to_owned(),
            operation: self.operation.clone(),
            source: self.source.clone(),
            adjustment_type: self.adjustment_type.clone(),
            provider: self.provider.clone(),
            model: self.model.clone(),
            quantity: self.quantity,
            unit: self.unit,
            credits: self.credits,
            resource_type: self.resource_type,
            resource_id: self.resource_id.clone(),
            itemized: self.itemized,
        }
    }
}

/// `parseQueuedAiUsageReceipt(raw)` (the native worker's `parse_receipt` reads the same): `None`
/// for anything that is not a receipt (no channel, customer or id, an invalid `occurredAt`,
/// credits that are not finite, not JSON).
pub fn parse_queued_receipt(raw: &[u8]) -> Option<QueuedReceipt> {
    let parsed: Value = serde_json::from_slice(&dima_text::sanitize_lone_surrogates(raw)).ok()?;
    let object = parsed.as_object()?;
    let get = |key: &str| object.get(key);
    let truthy = |key: &str| crate::js::truthy(get(key));
    if !truthy("channelID") || !truthy("customerId") || !truthy("id") {
        return None;
    }
    let occurred_text = if crate::js::truthy(get("occurredAt")) {
        dima_text::string_of(get("occurredAt")?)
    } else {
        String::new()
    };
    let occurred_at_ms = dima_text::parse_date(&occurred_text)?;
    let credits = finite_number(get("credits"))?;
    let entry_kind =
        if get("entryKind").and_then(Value::as_str) == Some("adjustment") || credits < 0.0 {
            EntryKind::Adjustment
        } else {
            EntryKind::Usage
        };
    // `classifyAdjustment({...parsed, entryKind})`: `String(x || '')` of the raw fields.
    let raw_text = |key: &str| {
        if crate::js::truthy(get(key)) {
            get(key).map(dima_text::string_of)
        } else {
            None
        }
    };
    let (operation_raw, source_raw) = (raw_text("operation"), raw_text("source"));
    let adjustment_type = classify_adjustment(AdjustmentInput {
        entry_kind: Some(entry_kind.as_str()),
        operation: operation_raw.as_deref(),
        source: source_raw.as_deref(),
        reason: get("reason").and_then(Value::as_str),
        adjustment_type: get("adjustmentType").and_then(Value::as_str),
    })
    .map(str::to_owned);
    let enumerated = |key: &str| get(key).and_then(Value::as_str);
    Some(QueuedReceipt {
        channel_id: dima_text::string_of(get("channelID")?),
        customer_id: Private::new(dima_text::string_of(get("customerId")?)),
        id: dima_text::string_of(get("id")?),
        request_id: nullable_string(get("requestId")),
        occurred_at_ms,
        entry_kind,
        category: safe_category(get("category").and_then(Value::as_str)),
        operation: nullable_string(get("operation")).unwrap_or_else(|| "usage".to_owned()),
        source: nullable_string(get("source")),
        adjustment_type,
        provider: nullable_string(get("provider")).unwrap_or_else(|| "unknown".to_owned()),
        model: nullable_string(get("model")),
        quantity: finite_number(get("quantity")),
        unit: enumerated("unit").and_then(Unit::parse),
        credits,
        resource_type: enumerated("resourceType").and_then(ResourceType::parse),
        resource_id: nullable_string(get("resourceId")),
        itemized: get("itemized") == Some(&Value::Bool(true)),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::usage::{AiUsageContextInput, create_ai_usage_context};
    use dima_core::SeededRandom;

    // ai_usage_ledger.test.ts: "queued receipts contain only itemized receipt fields"
    #[test]
    fn queued_receipts_contain_only_itemized_receipt_fields() {
        let context = create_ai_usage_context(
            "tts_fish",
            &AiUsageContextInput {
                entry_id: Some("entry-1".into()),
                request_id: Some("request-1".into()),
                channel_id: Some("channel-1".into()),
                category: Some(crate::usage::Category::Tts),
                operation: Some("synthesize".into()),
                source: Some("chat-command".into()),
                provider: Some("fish".into()),
                quantity: Some(100.0),
                unit: Some(Unit::Characters),
                resource_type: Some(ResourceType::Speech),
                resource_id: Some("speech-1".into()),
                ..Default::default()
            },
            &SeededRandom::new(1),
        )
        .unwrap();
        let at = dima_text::parse_date("2026-09-19T12:00:00.000Z").unwrap();
        let receipt =
            build_queued_receipt("channel-1", &"customer-1".into(), at, &context, 150.0).unwrap();
        assert_eq!(
            dima_text::to_js_json(&Value::Object(receipt.fields())),
            r#"{"channelID":"channel-1","customerId":"customer-1","id":"entry-1","requestId":"request-1","occurredAt":"2026-09-19T12:00:00.000Z","entryKind":"usage","category":"tts","operation":"synthesize","source":"chat-command","adjustmentType":null,"provider":"fish","model":null,"quantity":100,"unit":"characters","credits":150,"resourceType":"speech","resourceId":"speech-1","itemized":true}"#
        );
        for absent in ["prompt", "message", "cost"] {
            assert!(!receipt.fields().contains_key(absent));
        }
        assert_eq!(
            parse_queued_receipt(receipt.queued_text(at).as_bytes()),
            Some(receipt)
        );
    }

    // ai_usage_ledger.test.ts: "queued receipt parsing rejects malformed payloads and normalizes adjustments"
    #[test]
    fn queued_receipt_parsing_rejects_malformed_payloads_and_normalizes_adjustments() {
        assert_eq!(parse_queued_receipt(b"{"), None);
        assert_eq!(parse_queued_receipt(br#"{"channelID":"channel"}"#), None);
        let parsed = parse_queued_receipt(
            br#"{"channelID":"channel","customerId":"customer","id":"grant","occurredAt":"2026-09-19T12:00:00.000Z","credits":-5000,"entryKind":"usage","category":"credit_adjustment","operation":"grant","provider":"polar","itemized":true}"#,
        )
        .unwrap();
        assert_eq!(parsed.entry_kind, EntryKind::Adjustment);
        assert_eq!(parsed.credits, -5000.0);
        assert_eq!(parsed.adjustment_type.as_deref(), Some("other"));
    }

    #[test]
    fn javascript_coercions_of_the_queued_fields() {
        let parsed = parse_queued_receipt(
            "{\"channelID\":7,\"customerId\":\"c\",\"id\":\"e\",\"occurredAt\":\"2026-10-21T12:00:00.000Z\",\"credits\":\" 0x10 \",\"quantity\":null,\"requestId\":\"\\ufeff r \\ufeff\",\"model\":\"😀👋 émoji שלום\",\"operation\":\"   \",\"itemized\":1}".as_bytes(),
        )
        .unwrap();
        assert_eq!(parsed.channel_id, "7");
        assert_eq!(parsed.credits, 16.0);
        assert_eq!(parsed.quantity, Some(0.0));
        assert_eq!(parsed.request_id.as_deref(), Some("r"));
        assert_eq!(parsed.model.as_deref(), Some("😀👋 émoji שלום"));
        assert_eq!(parsed.operation, "usage");
        assert_eq!(parsed.provider, "unknown");
        assert!(!parsed.itemized);
        let long = format!(
            "{{\"channelID\":\"c\",\"customerId\":\"u\",\"id\":\"e\",\"occurredAt\":\"2026-10-21T12:00:00Z\",\"credits\":1,\"model\":\"{}\"}}",
            "😀".repeat(65)
        );
        let parsed = parse_queued_receipt(long.as_bytes()).unwrap();
        assert_eq!(parsed.model.map(|m| dima_text::utf16_len(&m)), Some(128));
        assert_eq!(
            parse_queued_receipt(
                br#"{"channelID":"c","customerId":"u","id":"e","occurredAt":"x","credits":1}"#
            ),
            None
        );
        assert_eq!(parse_queued_receipt(br#"{"channelID":"c","customerId":"u","id":"e","occurredAt":"2026-10-21","credits":"x"}"#), None);
    }
}
