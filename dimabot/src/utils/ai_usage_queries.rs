//! Request-time ledger status and transaction page from
//! `dimabot/src/utils/ai_usage_queries.ts`.
//!
//! Preserves filter checks, the default sort and page size, the version-2
//! base64url cursor, and the sha256 scope hash over
//! `JSON.stringify([channelID, customerId, start, end, filters])`. A pending,
//! unsynced, or 60-second-stale ledger calls the injected enqueuer once.
//!
//! The queue key, job JSON, dedupe script, and coverage-start helper belong to
//! `ai_usage_backfill_queue` and are not defined here. Constructors clone the
//! caller's MongoDB handle and do no I/O. This module does not open Redis,
//! parse Polar events, or apply the billing route's Pro-plan gate.
//! `decode_ledger_transaction` normalizes an unknown category to
//! `uncategorized`; the TypeScript mapper returned the stored category unchanged.

use std::future::Future;

use futures_util::TryStreamExt;
use mongodb::{
    Collection, Database,
    bson::{Bson, DateTime, Document, doc},
};
use sha2::{Digest, Sha256};

use super::{
    ai_usage::ADJUSTMENT_TYPES,
    ai_usage_ledger_queries::{
        AiUsageTransaction, AiUsageWindow, current_js_date, decode_ledger_transaction,
    },
    ai_usage_ledger_reads::{
        AiUsageLedgerReadError, AiUsageLedgerReadiness, AiUsageLedgerStatus,
        AiUsageLedgerStatusInput, MongoAiUsageLedgerReads,
    },
    ai_usage_period::{AiUsageReceiptError, base64url_decode, base64url_encode},
    credit_policy::JsDate,
    js_string::JsString,
    lossless_json::{JsonValue, parse_json, truthy},
};

const QUERY_CATEGORIES: [&str; 8] = [
    "tts",
    "ai_chat",
    "ai_agent",
    "memory",
    "clip_recommendation",
    "credit_adjustment",
    "other",
    "uncategorized",
];
const FILTER_FIELDS: [&str; 6] = [
    "category",
    "source",
    "resourceId",
    "requestId",
    "entryKind",
    "adjustmentType",
];
const STALE_SYNC_MS: f64 = 60_000.0;

#[derive(Debug)]
pub enum AiUsageQueryError {
    Receipt(AiUsageReceiptError),
    Ledger(AiUsageLedgerReadError),
}

impl std::fmt::Display for AiUsageQueryError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Receipt(error) => write!(formatter, "{error}"),
            Self::Ledger(error) => write!(formatter, "{error}"),
        }
    }
}

impl std::error::Error for AiUsageQueryError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Receipt(error) => Some(error),
            Self::Ledger(error) => Some(error),
        }
    }
}

/// Ledger-status failure. The enqueue error stays generic so this module does
/// not own the backfill queue's error type.
#[derive(Debug)]
pub enum UsageLedgerStatusError<E> {
    Query(AiUsageQueryError),
    Enqueue(E),
}

impl<E: std::fmt::Display> std::fmt::Display for UsageLedgerStatusError<E> {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Query(error) => write!(formatter, "{error}"),
            Self::Enqueue(error) => write!(formatter, "{error}"),
        }
    }
}

impl<E: std::error::Error + 'static> std::error::Error for UsageLedgerStatusError<E> {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Query(error) => Some(error),
            Self::Enqueue(error) => Some(error),
        }
    }
}

impl From<AiUsageLedgerReadError> for AiUsageQueryError {
    fn from(error: AiUsageLedgerReadError) -> Self {
        Self::Ledger(error)
    }
}

#[derive(Clone, Debug)]
pub struct UsageLedgerStatusInput {
    pub channel_id: JsString,
    pub customer_id: JsString,
    pub plan_tier: JsonValue,
    /// Present on the billing route's shared object. The status read ignores it.
    pub account_created_at: Option<JsDate>,
    pub window: AiUsageWindow,
}

#[derive(Clone, Debug, Default)]
pub struct TransactionFilters {
    pub category: Option<JsString>,
    pub source: Option<JsString>,
    pub resource_id: Option<JsString>,
    pub request_id: Option<JsString>,
    pub entry_kind: Option<JsString>,
    pub adjustment_type: Option<JsString>,
    pub cursor: Option<JsString>,
    pub limit: Option<f64>,
}

#[derive(Clone, Debug)]
pub struct TransactionQueryInput {
    pub channel_id: JsString,
    pub customer_id: JsString,
    pub window: AiUsageWindow,
    pub filters: TransactionFilters,
}

#[derive(Clone, Debug, PartialEq)]
pub struct PreparedTransactionQuery {
    pub filter: Document,
    pub sort: Document,
    pub fetch_limit: i64,
    pub page_limit: i64,
    pub scope: String,
}

#[derive(Clone, Debug, PartialEq)]
pub struct TransactionPage {
    pub items: Vec<AiUsageTransaction>,
    pub next_cursor: Option<String>,
}

/// `pending`, a missing sync time, or a sync at least 60 seconds old.
/// An unparseable `lastSyncedAt` does not enqueue: `NaN >= 60000` is false.
fn ledger_needs_enqueue(status: &AiUsageLedgerStatus, now: JsDate) -> bool {
    if status.status == AiUsageLedgerReadiness::Pending {
        return true;
    }
    let Some(synced) = status.last_synced_at.as_deref().filter(|value| !value.is_empty()) else {
        return true;
    };
    let (Some(synced_ms), Some(now_ms)) = (
        super::js_date::parse_date(synced),
        now.timestamp_millis(),
    ) else {
        return false;
    };
    now_ms as f64 - synced_ms as f64 >= STALE_SYNC_MS
}

/// Samples the clock once and passes that instant to `enqueue`. The queue
/// implementation lives in `ai_usage_backfill_queue::enqueue_ai_usage_backfill`;
/// this function only decides whether to call the closure.
pub async fn usage_ledger_status<E, F, Fut>(
    reads: &MongoAiUsageLedgerReads,
    input: &UsageLedgerStatusInput,
    enqueue: F,
) -> Result<AiUsageLedgerStatus, UsageLedgerStatusError<E>>
where
    F: FnOnce(JsDate) -> Fut,
    Fut: Future<Output = Result<(), E>>,
{
    let sampled = current_js_date();
    usage_ledger_status_at(reads, input, sampled, enqueue).await
}

/// Same decision as [`usage_ledger_status`] with the caller's clock.
pub async fn usage_ledger_status_at<E, F, Fut>(
    reads: &MongoAiUsageLedgerReads,
    input: &UsageLedgerStatusInput,
    now: JsDate,
    enqueue: F,
) -> Result<AiUsageLedgerStatus, UsageLedgerStatusError<E>>
where
    F: FnOnce(JsDate) -> Fut,
    Fut: Future<Output = Result<(), E>>,
{
    let ledger = reads
        .get_ai_usage_ledger_status(&AiUsageLedgerStatusInput {
            channel_id: input.channel_id.clone(),
            customer_id: input.customer_id.clone(),
            starts_at: input.window.start_timestamp,
        })
        .await
        .map_err(AiUsageQueryError::from)
        .map_err(UsageLedgerStatusError::Query)?;
    if ledger_needs_enqueue(&ledger, now) {
        enqueue(now).await.map_err(UsageLedgerStatusError::Enqueue)?;
    }
    let _ = input.account_created_at;
    Ok(ledger)
}

fn validation(message: &str) -> AiUsageQueryError {
    AiUsageQueryError::Receipt(AiUsageReceiptError::Validation(message.to_string()))
}

fn is_js_integer(value: f64) -> bool {
    value.is_finite() && value.fract() == 0.0
}

fn safe_token(value: &str) -> bool {
    !value.is_empty()
        && value.bytes().all(|byte| {
            byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'.' | b':' | b'/' | b'-')
        })
}

fn field_text<'a>(value: &'a Option<JsString>) -> Option<&'a JsString> {
    value.as_ref().filter(|text| !text.is_empty())
}

fn sha256_hex(text: &str) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let digest = Sha256::digest(text.as_bytes());
    let mut out = String::with_capacity(digest.len() * 2);
    for byte in digest {
        out.push(HEX[(byte >> 4) as usize] as char);
        out.push(HEX[(byte & 0x0f) as usize] as char);
    }
    out
}

fn date_json(date: JsDate) -> JsonValue {
    match date.to_iso_string() {
        Ok(text) => JsonValue::String(text.into()),
        Err(_) => JsonValue::Null,
    }
}

fn json_field<'a>(value: &'a JsonValue, key: &str) -> Option<&'a JsonValue> {
    match value {
        JsonValue::Object(fields) => fields
            .iter()
            .find(|(name, _)| name.as_str() == Some(key))
            .map(|(_, field)| field),
        _ => None,
    }
}

pub fn transaction_scope_hash(
    channel_id: &JsString,
    customer_id: &JsString,
    start: JsDate,
    end: JsDate,
    filters: &[(String, String)],
) -> String {
    let filter_fields = filters
        .iter()
        .map(|(key, value)| {
            (
                JsString::from(key.as_str()),
                JsonValue::String(value.as_str().into()),
            )
        })
        .collect();
    let payload = JsonValue::Array(vec![
        JsonValue::String(channel_id.clone()),
        JsonValue::String(customer_id.clone()),
        date_json(start),
        date_json(end),
        JsonValue::Object(filter_fields),
    ]);
    sha256_hex(&payload.to_json_string())
}

fn decode_query_cursor(
    cursor: &JsString,
    scope: &str,
) -> Result<(String, i64), AiUsageQueryError> {
    let invalid = || validation("Invalid transaction cursor for this query");
    if cursor.len() > 2048 {
        return Err(invalid());
    }
    let Some(text) = cursor.as_str() else {
        return Err(invalid());
    };
    let bytes = base64url_decode(text).ok_or_else(invalid)?;
    let json = std::str::from_utf8(&bytes).map_err(|_| invalid())?;
    let parsed = parse_json(json).map_err(|_| invalid())?;
    let id = match json_field(&parsed, "id") {
        Some(JsonValue::String(id)) if !id.is_empty() && id.len() <= 128 => {
            id.as_str().ok_or_else(invalid)?.to_string()
        }
        _ => return Err(invalid()),
    };
    let at = match json_field(&parsed, "at") {
        Some(JsonValue::String(at)) => at.as_str().and_then(super::js_date::parse_date),
        _ => None,
    };
    let Some(at) = at else {
        return Err(invalid());
    };
    let scope_ok = match json_field(&parsed, "scope") {
        None => true,
        Some(value) if !truthy(value) => true,
        Some(JsonValue::String(value)) => value.as_str() == Some(scope),
        Some(_) => false,
    };
    if !scope_ok {
        return Err(invalid());
    }
    Ok((id, at))
}

pub fn prepare_transaction_query(
    input: &TransactionQueryInput,
    now: JsDate,
) -> Result<PreparedTransactionQuery, AiUsageQueryError> {
    let limit = input.filters.limit.unwrap_or(25.0);
    if !is_js_integer(limit) || !(1.0..=100.0).contains(&limit) {
        return Err(validation("limit must be between 1 and 100"));
    }
    if let Some(category) = field_text(&input.filters.category) {
        let category = category
            .as_str()
            .ok_or_else(|| validation("Invalid usage category"))?;
        if !QUERY_CATEGORIES.contains(&category) {
            return Err(validation("Invalid usage category"));
        }
    }
    if let Some(kind) = field_text(&input.filters.entry_kind) {
        let kind = kind.as_str().ok_or_else(|| validation("Invalid entry kind"))?;
        if kind != "usage" && kind != "adjustment" {
            return Err(validation("Invalid entry kind"));
        }
    }
    if let Some(adjustment) = field_text(&input.filters.adjustment_type) {
        let adjustment = adjustment
            .as_str()
            .ok_or_else(|| validation("Invalid adjustment type"))?;
        if !ADJUSTMENT_TYPES.contains(&adjustment) {
            return Err(validation("Invalid adjustment type"));
        }
    }
    let mut filters = Vec::new();
    for (field, value) in [
        ("category", &input.filters.category),
        ("source", &input.filters.source),
        ("resourceId", &input.filters.resource_id),
        ("requestId", &input.filters.request_id),
        ("entryKind", &input.filters.entry_kind),
        ("adjustmentType", &input.filters.adjustment_type),
    ] {
        let Some(value) = field_text(value) else {
            continue;
        };
        if value.len() > 128 || value.as_str().is_none_or(|text| !safe_token(text)) {
            return Err(validation(&format!("Invalid {field}")));
        }
        filters.push((field.to_string(), value.to_utf8_lossy()));
    }
    let _ = FILTER_FIELDS;
    let scope = transaction_scope_hash(
        &input.channel_id,
        &input.customer_id,
        input.window.start_timestamp,
        input.window.end_timestamp_exclusive,
        &filters,
    );
    let cursor = if let Some(cursor) = field_text(&input.filters.cursor) {
        Some(decode_query_cursor(cursor, &scope)?)
    } else {
        None
    };
    let expiry = now.timestamp_millis().ok_or(AiUsageLedgerReadError::CastError {
        path: "expiresAt",
    })?;
    let start = input
        .window
        .start_timestamp
        .timestamp_millis()
        .ok_or(AiUsageLedgerReadError::CastError { path: "occurredAt" })?;
    let end = input
        .window
        .end_timestamp_exclusive
        .timestamp_millis()
        .ok_or(AiUsageLedgerReadError::CastError { path: "occurredAt" })?;
    let mut filter = doc! {
        "channelID": input.channel_id.to_utf8_lossy(),
        "customerId": input.customer_id.to_utf8_lossy(),
    };
    for (field, value) in &filters {
        filter.insert(field, value);
    }
    filter.insert(
        "occurredAt",
        doc! {"$gte": DateTime::from_millis(start), "$lt": DateTime::from_millis(end)},
    );
    filter.insert("expiresAt", doc! {"$gt": DateTime::from_millis(expiry)});
    if let Some((id, at)) = cursor {
        let at = DateTime::from_millis(at);
        filter.insert(
            "$or",
            bson_array(vec![
                doc! {"occurredAt": {"$lt": at}},
                doc! {"occurredAt": at, "entryId": {"$lt": id}},
            ]),
        );
    }
    Ok(PreparedTransactionQuery {
        filter,
        sort: doc! {"occurredAt": -1, "entryId": -1},
        fetch_limit: limit as i64 + 1,
        page_limit: limit as i64,
        scope,
    })
}

fn bson_array(documents: Vec<Document>) -> Bson {
    Bson::Array(documents.into_iter().map(Bson::Document).collect())
}

pub fn encode_transaction_cursor(id: &str, occurred_at: &str, scope: &str) -> String {
    let json = JsonValue::Object(vec![
        ("v".into(), JsonValue::Number(2.0)),
        ("id".into(), JsonValue::String(id.into())),
        ("at".into(), JsonValue::String(occurred_at.into())),
        ("scope".into(), JsonValue::String(scope.into())),
    ]);
    base64url_encode(json.to_json_string().as_bytes())
}

#[derive(Clone, Debug)]
pub struct MongoAiUsageTransactionQueries {
    receipts: Collection<Document>,
}

impl MongoAiUsageTransactionQueries {
    pub fn new(database: &Database) -> Self {
        Self {
            receipts: crate::schemas::ai_usage_receipt::schema().native_collection(database),
        }
    }

    pub fn receipt_collection(&self) -> &Collection<Document> {
        &self.receipts
    }

    pub async fn query(
        &self,
        input: &TransactionQueryInput,
    ) -> Result<TransactionPage, AiUsageQueryError> {
        self.query_at(input, current_js_date()).await
    }

    pub async fn query_at(
        &self,
        input: &TransactionQueryInput,
        now: JsDate,
    ) -> Result<TransactionPage, AiUsageQueryError> {
        let prepared = prepare_transaction_query(input, now)?;
        let documents: Vec<Document> = self
            .receipts
            .clone()
            .find(prepared.filter)
            .sort(prepared.sort)
            .limit(prepared.fetch_limit)
            .await
            .map_err(AiUsageLedgerReadError::from)?
            .try_collect()
            .await
            .map_err(AiUsageLedgerReadError::from)?;
        let page_len = usize::try_from(prepared.page_limit).unwrap_or(0);
        let mut items = Vec::new();
        for document in documents.iter().take(page_len) {
            items.push(decode_ledger_transaction(document)?);
        }
        let next_cursor = if documents.len() > page_len
            && let Some(last) = items.last()
        {
            let id = match last.get("id").and_then(|field| field.as_bson()) {
                Some(Bson::String(id)) => id.clone(),
                _ => {
                    return Err(validation("Invalid transaction cursor for this query"));
                }
            };
            let at = match last.get("occurredAt").and_then(|field| field.as_bson()) {
                Some(Bson::String(at)) => at.clone(),
                _ => {
                    return Err(validation("Invalid transaction cursor for this query"));
                }
            };
            Some(encode_transaction_cursor(&id, &at, &prepared.scope))
        } else {
            None
        };
        Ok(TransactionPage { items, next_cursor })
    }
}

/// Keeps the async status signature honest for callers that already hold the
/// ledger reader. `enqueue` is the sibling backfill queue, not this module.
pub fn status_future<'a, E, F, Fut>(
    reads: &'a MongoAiUsageLedgerReads,
    input: &'a UsageLedgerStatusInput,
    enqueue: F,
) -> impl Future<Output = Result<AiUsageLedgerStatus, UsageLedgerStatusError<E>>> + 'a
where
    E: 'a,
    F: FnOnce(JsDate) -> Fut + 'a,
    Fut: Future<Output = Result<(), E>> + 'a,
{
    usage_ledger_status(reads, input, enqueue)
}
