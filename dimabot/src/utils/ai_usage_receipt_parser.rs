//! Lossless parseQueuedAiUsageReceipt and receiptDocument, for opt-in adoption.
//!
//! No queue, clock sampling, client, lock, or persistence side effects. Local
//! dates use the existing JS date helper's fixed process timezone. The
//! deployed ai_usage_receipts worker does NOT use this component. See the handoff
//! for the opt-in module/feature wiring the parent must review. Strings stay
//! UTF-16 until the explicit BSON adapter.
use super::{
    ai_usage::{EntryKind, ResourceType, UsageUnit, classify_adjustment},
    bson_compat::js_number as bson_number,
    credit_policy::JsDate,
    js_date::{parse_date, parse_date_utf16},
    js_string::JsString,
    lossless_json::JsonValue,
    lossless_json_view::{JsonDocument, JsonView, js_number},
};
use mongodb::bson::{Bson, DateTime, Document};

/// Explicit normalized DTO. Construction is confined to the parser: finite
/// numbers, valid dates, enums and nullable strings are established together.
/// Borrowed named access and ordered wire access avoid a UTF-8 coercion boundary.
#[derive(Clone, Debug, PartialEq)]
pub struct ParsedAiUsageReceipt {
    channel_id: JsString,
    customer_id: JsString,
    id: JsString,
    request_id: Option<JsString>,
    occurred_at: JsDate,
    entry_kind: EntryKind,
    category: &'static str,
    operation: JsString,
    source: Option<JsString>,
    adjustment_type: Option<&'static str>,
    provider: JsString,
    model: Option<JsString>,
    quantity: Option<f64>,
    unit: Option<UsageUnit>,
    credits: f64,
    resource_type: Option<ResourceType>,
    resource_id: Option<JsString>,
    itemized: bool,
}

fn string(value: &str) -> JsonValue {
    JsonValue::String(value.into())
}
fn text(value: Option<JsonView<'_>>) -> Option<JsString> {
    value.and_then(JsonView::as_string)
}
fn nullable_string(value: Option<JsonView<'_>>) -> Option<JsString> {
    let value = text(value)?.trim();
    (!value.is_empty()).then(|| value.slice(0, 128))
}
fn enum_text(value: Option<JsonView<'_>>, allowed: &[&'static str]) -> Option<&'static str> {
    let value = text(value)?;
    allowed
        .iter()
        .copied()
        .find(|allowed| value.as_str() == Some(*allowed))
}
fn category(value: Option<JsonView<'_>>) -> &'static str {
    match text(value).as_ref().and_then(JsString::as_str) {
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

// Retain the existing policy's entire decision tree. Only adapt its input: the
// shared serde_json policy cannot carry UTF-16 or throw for own toString fields.
// Coercion happens on ORIGINAL source/operation, before trimming/truncating.
// A non-Unicode string cannot equal any ASCII policy token; use an empty token
// in that comparison-only projection. No replacement is made to receipt data.
fn adjustment(row: JsonView<'_>, kind: EntryKind) -> Result<Option<&'static str>, ()> {
    if kind != EntryKind::Adjustment {
        return Ok(None);
    }
    let mut input = serde_json::json!({"entryKind":"adjustment"});
    if let Some(explicit) = text(row.get("adjustmentType"))
        .as_ref()
        .and_then(JsString::as_str)
    {
        input["adjustmentType"] = explicit.into();
        let classified = classify_adjustment(&input);
        if classified == Some(explicit) {
            // Source returns before attempting source/operation coercion.
            return Ok(classified);
        }
    }
    for key in ["source", "operation"] {
        let coerced = match row.get(key).filter(|value| value.truthy()) {
            Some(value) => value.js_string().map_err(|_| ())?,
            None => JsString::from(""),
        };
        input[key] = coerced.as_str().unwrap_or("").into();
    }
    if let Some(reason) = text(row.get("reason")).as_ref().and_then(JsString::as_str) {
        input["reason"] = reason.into();
    }
    Ok(classify_adjustment(&input))
}

/// Source JSON.parse/plain-own-property contract. Unknown keys are ignored;
/// missing and null are distinct when Number() is evaluated. Any parse,
/// coercion or invalid-date failure returns None, like the source catch block.
/// No hooks, accessors or custom prototypes can be represented by JSON text.
/// Borrows a validated flat span index; ignored deep values never become an
/// owned recursive tree. Array coercion is iterative. JS engine stack/resource
/// exhaustion during extremely deep String(array) is outside parity claims.
pub fn parse_queued_ai_usage_receipt(raw: &str) -> Option<ParsedAiUsageReceipt> {
    let document = JsonDocument::parse(raw).ok()?;
    let row = document.root();
    let occurred = match row.get("occurredAt").filter(|value| value.truthy()) {
        Some(value) => value.js_string().ok()?,
        None => JsString::from(""),
    };
    let millis = match occurred.as_str() {
        Some(value) => parse_date(value),
        None => parse_date_utf16(&occurred.units()),
    }?;
    let occurred_at = JsDate::from_millis(millis as f64);
    let credits = js_number(row.get("credits")).ok()?;
    if !credits.is_finite() {
        return None;
    }
    for key in ["channelID", "customerId", "id"] {
        if !row.get(key).is_some_and(JsonView::truthy) {
            return None;
        }
    }
    let entry_kind = if enum_text(row.get("entryKind"), &["adjustment"]).is_some() || credits < 0.0
    {
        EntryKind::Adjustment
    } else {
        EntryKind::Usage
    };
    let adjustment_type = adjustment(row, entry_kind).ok()?;
    let quantity = js_number(row.get("quantity")).ok()?;
    Some(ParsedAiUsageReceipt {
        channel_id: row.get("channelID")?.js_string().ok()?,
        customer_id: row.get("customerId")?.js_string().ok()?,
        id: row.get("id")?.js_string().ok()?,
        request_id: nullable_string(row.get("requestId")),
        occurred_at,
        entry_kind,
        category: category(row.get("category")),
        operation: nullable_string(row.get("operation")).unwrap_or_else(|| "usage".into()),
        source: nullable_string(row.get("source")),
        adjustment_type,
        provider: nullable_string(row.get("provider")).unwrap_or_else(|| "unknown".into()),
        model: nullable_string(row.get("model")),
        quantity: quantity.is_finite().then_some(quantity),
        unit: match enum_text(row.get("unit"), &["characters", "tokens", "minutes"]) {
            Some("characters") => Some(UsageUnit::Characters),
            Some("tokens") => Some(UsageUnit::Tokens),
            Some("minutes") => Some(UsageUnit::Minutes),
            _ => None,
        },
        credits,
        resource_type: match enum_text(
            row.get("resourceType"),
            &["speech", "voice_preview", "llm_generation", "vod_analysis"],
        ) {
            Some("speech") => Some(ResourceType::Speech),
            Some("voice_preview") => Some(ResourceType::VoicePreview),
            Some("llm_generation") => Some(ResourceType::LlmGeneration),
            Some("vod_analysis") => Some(ResourceType::VodAnalysis),
            _ => None,
        },
        resource_id: nullable_string(row.get("resourceId")),
        itemized: row.get("itemized").and_then(JsonView::as_bool) == Some(true),
    })
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RetentionTier {
    Free,
    Premium,
    Pro,
}
impl RetentionTier {
    /// validTier's strict matching, without pulling in the Redis producer.
    pub fn from_value(value: &JsonValue) -> Self {
        let value = match value {
            JsonValue::String(value) => value.as_str(),
            _ => None,
        };
        match value {
            Some("premium") => Self::Premium,
            Some("pro") => Self::Pro,
            _ => Self::Free,
        }
    }
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Free => "free",
            Self::Premium => "premium",
            Self::Pro => "pro",
        }
    }
    pub fn days(self) -> i64 {
        match self {
            Self::Free => 30,
            Self::Premium => 60,
            Self::Pro => 90,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct InvalidReceiptExpiry;
impl std::fmt::Display for InvalidReceiptExpiry {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("receipt expiry is outside JavaScript TimeClip (Mongoose Date cast fails)")
    }
}
impl std::error::Error for InvalidReceiptExpiry {}

impl ParsedAiUsageReceipt {
    pub fn channel_id(&self) -> &JsString {
        &self.channel_id
    }
    pub fn customer_id(&self) -> &JsString {
        &self.customer_id
    }
    pub fn id(&self) -> &JsString {
        &self.id
    }
    pub fn occurred_at(&self) -> JsDate {
        self.occurred_at
    }
    pub fn credits(&self) -> f64 {
        self.credits
    }
    pub fn quantity(&self) -> Option<f64> {
        self.quantity
    }
    pub fn entry_kind(&self) -> EntryKind {
        self.entry_kind
    }

    /// Source object-literal order, with all eighteen keys and explicit nulls.
    /// Binary64 values (including negative zero) and UTF-16 units are retained.
    pub fn ordered_fields(&self) -> Vec<(&'static str, JsonValue)> {
        let optional = |value: &Option<JsString>| {
            value
                .as_ref()
                .map_or(JsonValue::Null, |value| JsonValue::String(value.clone()))
        };
        vec![
            ("channelID", JsonValue::String(self.channel_id.clone())),
            ("customerId", JsonValue::String(self.customer_id.clone())),
            ("id", JsonValue::String(self.id.clone())),
            ("requestId", optional(&self.request_id)),
            (
                "occurredAt",
                string(&self.occurred_at.to_iso_string().expect("parser date")),
            ),
            ("entryKind", string(self.entry_kind.as_str())),
            ("category", string(self.category)),
            ("operation", JsonValue::String(self.operation.clone())),
            ("source", optional(&self.source)),
            (
                "adjustmentType",
                self.adjustment_type.map_or(JsonValue::Null, string),
            ),
            ("provider", JsonValue::String(self.provider.clone())),
            ("model", optional(&self.model)),
            (
                "quantity",
                self.quantity.map_or(JsonValue::Null, JsonValue::Number),
            ),
            (
                "unit",
                self.unit
                    .map_or(JsonValue::Null, |value| string(value.as_str())),
            ),
            ("credits", JsonValue::Number(self.credits)),
            (
                "resourceType",
                self.resource_type
                    .map_or(JsonValue::Null, |value| string(value.as_str())),
            ),
            ("resourceId", optional(&self.resource_id)),
            ("itemized", JsonValue::Bool(self.itemized)),
        ]
    }
    /// Ordinary Unicode convenience path; fails instead of replacing IDs or
    /// metadata. Entries retain source order even without Serde preserve_order.
    pub fn try_utf8_fields(&self) -> Option<Vec<(&'static str, serde_json::Value)>> {
        self.ordered_fields()
            .into_iter()
            .map(|(key, value)| {
                let value = match value {
                    JsonValue::Null => serde_json::Value::Null,
                    JsonValue::Bool(value) => serde_json::Value::Bool(value),
                    JsonValue::Number(value) => {
                        serde_json::Value::Number(serde_json::Number::from_f64(value)?)
                    }
                    JsonValue::String(value) => {
                        serde_json::Value::String(value.as_str()?.to_owned())
                    }
                    _ => unreachable!("normalized receipt contains only scalar fields"),
                };
                Some((key, value))
            })
            .collect()
    }
    pub fn as_value(&self) -> JsonValue {
        JsonValue::Object(
            self.ordered_fields()
                .into_iter()
                .map(|(key, value)| (key.into(), value))
                .collect(),
        )
    }
    pub fn get(&self, key: &str) -> Option<JsonValue> {
        self.ordered_fields()
            .into_iter()
            .find(|(name, _)| *name == key)
            .map(|(_, value)| value)
    }
    /// Well-formed JSON.stringify wire: lone units escape; signed zero becomes
    /// "0" here only. The structured DTO retains its original numeric bits.
    pub fn json(&self) -> String {
        self.as_value().to_json_string()
    }
    /// Concrete receiptDocument + schema casting + Node BSON writer boundary.
    /// This projects exactly the source's fields, without _id, timestamps or
    /// __v (those are persistence/update middleware responsibilities). BSON has
    /// no lone-surrogate string representation. Node Buffer UTF-8 encoding
    /// replaces each unpaired unit here, including in IDs; the DTO is unchanged.
    /// Different UTF-16 IDs may therefore collide in storage exactly as in Node.
    /// Callers must retain the lossless ID for pre-storage protocols and review
    /// that collision behavior before adoption.
    pub fn to_bson_document(&self, tier: RetentionTier) -> Result<Document, InvalidReceiptExpiry> {
        let millis = self.occurred_at.timestamp_millis().expect("parser date");
        let expiry = JsDate::from_millis(millis as f64 + (tier.days() * 86_400_000) as f64)
            .timestamp_millis()
            .ok_or(InvalidReceiptExpiry)?;
        let mut document = Document::new();
        let optional = |value: &Option<JsString>| {
            value
                .as_ref()
                .map_or(Bson::Null, |value| Bson::String(value.to_utf8_lossy()))
        };
        document.insert("channelID", self.channel_id.to_utf8_lossy());
        document.insert("customerId", self.customer_id.to_utf8_lossy());
        document.insert("entryId", self.id.to_utf8_lossy());
        document.insert("requestId", optional(&self.request_id));
        document.insert("occurredAt", DateTime::from_millis(millis));
        document.insert("entryKind", self.entry_kind.as_str());
        document.insert("category", self.category);
        document.insert("operation", self.operation.to_utf8_lossy());
        document.insert("source", optional(&self.source));
        document.insert(
            "adjustmentType",
            self.adjustment_type
                .map_or(Bson::Null, |value| Bson::String(value.into())),
        );
        document.insert("provider", self.provider.to_utf8_lossy());
        document.insert("model", optional(&self.model));
        document.insert("quantity", self.quantity.map_or(Bson::Null, bson_number));
        document.insert(
            "unit",
            self.unit
                .map_or(Bson::Null, |value| Bson::String(value.as_str().into())),
        );
        document.insert("credits", bson_number(self.credits));
        document.insert(
            "resourceType",
            self.resource_type
                .map_or(Bson::Null, |value| Bson::String(value.as_str().into())),
        );
        document.insert("resourceId", optional(&self.resource_id));
        document.insert("itemized", self.itemized);
        document.insert("retentionTier", tier.as_str());
        document.insert("expiresAt", DateTime::from_millis(expiry));
        Ok(document)
    }
}
