//! The usage page's itemized reads: `usageLedgerStatus` and `queryAiUsageTransactions` of
//! `utils/ai_usage_queries.ts`.
//!
//! A page is one indexed `find` (`{channelID, customerId, …filters, occurredAt}` sorted by
//! `occurredAt` then `entryId`, both descending) of at most `limit + 1` receipts, with a server
//! time limit. The cursor is `base64url(JSON.stringify({v: 2, id, at, scope}))`, where `scope`
//! is the SHA-256 of `JSON.stringify([channelID, customerId, startTimestamp,
//! endTimestampExclusive, filters])` (dates as ISO text, as `JSON.stringify` writes a `Date`): a
//! cursor of another query is refused. Items are read from the stored document as the reference
//! reads a lean document: a field the document lacks is left out of the item, a `null` is kept.
//!
//! Intended difference: a cursor holding characters outside both base64 alphabets is refused
//! (Node's decoder skips them); every cursor this server writes decodes the same.

use super::receipt::safe_category;
use super::report::{Window, decode_base64url, iso, num};
use super::state::LedgerStatus;
use super::{Ledger, LedgerError, ops};
use crate::usage::{ADJUSTMENT_TYPES, AdjustmentInput, classify_adjustment};
use crate::usage_backfill::{BackfillQueue, EnqueueInput};
use bson::{Bson, DateTime, Document, doc};
use serde_json::{Map, Value};
use sha2::{Digest, Sha256};

/// A ledger status younger than this is fresh: older (or pending) asks for a backfill.
pub const STATUS_FRESH_MS: i64 = 60_000;

/// What the usage page reads with.
#[derive(Clone, Copy, Debug)]
pub struct ReadInput<'a> {
    /// `channelID`.
    pub channel_id: &'a str,
    /// `customerId`.
    pub customer_id: &'a str,
    /// `planTier` (the user's stored text).
    pub plan_tier: Option<&'a str>,
    /// The window.
    pub window: &'a Window,
}

/// Why a usage read failed.
#[derive(Debug, thiserror::Error)]
pub enum QueryError {
    /// The request is refused (400).
    #[error(transparent)]
    Read(#[from] super::report::UsageReadError),
    /// The ledger could not be read (the routes answer 502).
    #[error(transparent)]
    Ledger(#[from] LedgerError),
}

/// The filters of `queryAiUsageTransactions`.
#[derive(Clone, Copy, Debug, Default)]
pub struct TransactionFilters<'a> {
    /// `category`.
    pub category: Option<&'a str>,
    /// `source`.
    pub source: Option<&'a str>,
    /// `resourceId`.
    pub resource_id: Option<&'a str>,
    /// `requestId`.
    pub request_id: Option<&'a str>,
    /// `entryKind`.
    pub entry_kind: Option<&'a str>,
    /// `adjustmentType`.
    pub adjustment_type: Option<&'a str>,
    /// `cursor`.
    pub cursor: Option<&'a str>,
    /// `limit` (`Number(query.limit)`; unset is 25).
    pub limit: Option<f64>,
}

/// One page of itemized usage.
#[derive(Clone, Debug, PartialEq)]
pub struct ItemPage {
    /// The items as the API sends them.
    pub items: Vec<Value>,
    /// The next page's cursor.
    pub next_cursor: Option<String>,
}

const CATEGORIES: [&str; 8] = [
    "tts",
    "ai_chat",
    "ai_agent",
    "memory",
    "clip_recommendation",
    "credit_adjustment",
    "other",
    "uncategorized",
];

/// `/^[a-zA-Z0-9_.:/-]+$/` at most 128 long.
fn safe_filter(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'.' | b':' | b'/' | b'-'))
}

fn present(value: Option<&str>) -> Option<&str> {
    value.filter(|v| !v.is_empty())
}

/// A stored field as JavaScript reads it from a lean document (`None` when absent).
fn lean(document: &Document, key: &str) -> Option<Value> {
    document.get(key).map(|value| match value {
        Bson::Null | Bson::Undefined => Value::Null,
        Bson::DateTime(at) => Value::from(iso(at.timestamp_millis())),
        other => super::dashboard::bson_to_json(other),
    })
}

/// One receipt as an item of the page (the reference's `docs.map`).
fn item(document: &Document) -> Value {
    let mut map = Map::new();
    let mut put = |key: &str, value: Option<Value>| {
        if let Some(value) = value {
            map.insert(key.into(), value);
        }
    };
    put("id", lean(document, "entryId"));
    put("requestId", lean(document, "requestId"));
    put(
        "occurredAt",
        Some(
            document
                .get_datetime("occurredAt")
                .map_or(Value::Null, |at| Value::from(iso(at.timestamp_millis()))),
        ),
    );
    put("entryKind", lean(document, "entryKind"));
    put("category", lean(document, "category"));
    put("operation", lean(document, "operation"));
    let truthy = |value: Option<Value>| value.filter(|v| crate::js::truthy(Some(v)));
    put(
        "source",
        Some(truthy(lean(document, "source")).unwrap_or(Value::Null)),
    );
    let adjustment = truthy(lean(document, "adjustmentType")).unwrap_or_else(|| {
        let text = |key: &str| document.get_str(key).ok();
        classify_adjustment(AdjustmentInput {
            entry_kind: text("entryKind"),
            operation: text("operation"),
            source: text("source"),
            reason: text("reason"),
            adjustment_type: text("adjustmentType"),
        })
        .map_or(Value::Null, Value::from)
    });
    put("adjustmentType", Some(adjustment));
    put("provider", lean(document, "provider"));
    put("model", lean(document, "model"));
    put("quantity", lean(document, "quantity"));
    put("unit", lean(document, "unit"));
    put("credits", lean(document, "credits"));
    put("resourceType", lean(document, "resourceType"));
    put("resourceId", lean(document, "resourceId"));
    put("itemized", lean(document, "itemized"));
    Value::Object(map)
}

impl Ledger<'_> {
    /// `usageLedgerStatus(input)`: the ledger status of the window, and a backfill request when
    /// it is pending or older than [`STATUS_FRESH_MS`] (deduplicated by the queue).
    pub async fn usage_ledger_status(
        &self,
        input: &ReadInput<'_>,
        backfills: &BackfillQueue<'_>,
    ) -> Result<LedgerStatus, QueryError> {
        let status = self
            .ledger_status(input.channel_id, input.customer_id, input.window.start_ms)
            .await?;
        let now = self.clock.now_ms();
        let stale = status
            .last_synced_at
            .as_deref()
            .and_then(dima_text::parse_date)
            .is_none_or(|synced| now - synced >= STATUS_FRESH_MS);
        if !status.ready || stale {
            backfills
                .enqueue(&EnqueueInput {
                    channel_id: input.channel_id,
                    customer_id: input.customer_id,
                    plan_tier: input.plan_tier,
                    coverage_start_ms: None,
                    reason: None,
                    now_ms: now,
                })
                .await
                .map_err(LedgerError::from)?;
        }
        Ok(status)
    }

    /// `queryAiUsageTransactions(input)`.
    pub async fn query_transactions(
        &self,
        channel_id: &str,
        customer_id: &str,
        window: &Window,
        filters: &TransactionFilters<'_>,
    ) -> Result<ItemPage, QueryError> {
        use super::report::UsageReadError as E;
        let limit = filters.limit.unwrap_or(25.0);
        if limit.fract() != 0.0 || !(1.0..=100.0).contains(&limit) {
            return Err(E::validation("limit must be between 1 and 100").into());
        }
        if let Some(category) = present(filters.category)
            && !CATEGORIES.contains(&category)
        {
            return Err(E::validation("Invalid usage category").into());
        }
        if let Some(kind) = present(filters.entry_kind)
            && kind != "usage"
            && kind != "adjustment"
        {
            return Err(E::validation("Invalid entry kind").into());
        }
        if let Some(kind) = present(filters.adjustment_type)
            && !ADJUSTMENT_TYPES.contains(&kind)
        {
            return Err(E::validation("Invalid adjustment type").into());
        }
        let mut chosen = Map::new();
        for (field, value) in [
            ("category", filters.category),
            ("source", filters.source),
            ("resourceId", filters.resource_id),
            ("requestId", filters.request_id),
            ("entryKind", filters.entry_kind),
            ("adjustmentType", filters.adjustment_type),
        ] {
            if let Some(value) = present(value) {
                if !safe_filter(value) {
                    return Err(E::validation(format!("Invalid {field}")).into());
                }
                chosen.insert(field.into(), Value::from(value));
            }
        }
        let scope_json = dima_text::to_js_json(&Value::Array(vec![
            Value::from(channel_id),
            Value::from(customer_id),
            Value::from(iso(window.start_ms)),
            Value::from(iso(window.end_exclusive_ms)),
            Value::Object(chosen.clone()),
        ]));
        let scope = hex::encode(Sha256::digest(scope_json.as_bytes()));
        let now = self.clock.now_ms();
        let mut query = doc! { "channelID": channel_id, "customerId": customer_id };
        for (key, value) in &chosen {
            query.insert(key.clone(), value.as_str().unwrap_or_default());
        }
        query.insert(
            "occurredAt",
            doc! {
                "$gte": DateTime::from_millis(window.start_ms),
                "$lt": DateTime::from_millis(window.end_exclusive_ms),
            },
        );
        query.insert("expiresAt", doc! { "$gt": DateTime::from_millis(now) });
        if let Some(cursor) = present(filters.cursor) {
            let invalid = || E::validation("Invalid transaction cursor for this query");
            if cursor.chars().count() > 2048 {
                return Err(invalid().into());
            }
            let bytes = decode_base64url(cursor).ok_or_else(invalid)?;
            let parsed: Value =
                serde_json::from_slice(&dima_text::sanitize_lone_surrogates(&bytes))
                    .map_err(|_| invalid())?;
            let id = parsed.get("id").and_then(Value::as_str).unwrap_or_default();
            let at = parsed
                .get("at")
                .and_then(Value::as_str)
                .and_then(dima_text::parse_date);
            let cursor_scope = parsed.get("scope");
            let scope_ok = match cursor_scope {
                Some(value) if crate::js::truthy(Some(value)) => {
                    value.as_str() == Some(scope.as_str())
                }
                _ => true,
            };
            let (Some(at), true, true) = (
                at,
                !id.is_empty() && dima_text::utf16_len(id) <= 128,
                scope_ok,
            ) else {
                return Err(invalid().into());
            };
            query.insert(
                "$or",
                vec![
                    doc! { "occurredAt": { "$lt": DateTime::from_millis(at) } },
                    doc! { "occurredAt": DateTime::from_millis(at), "entryId": { "$lt": id } },
                ],
            );
        }
        #[allow(clippy::cast_possible_truncation)]
        let limit = limit as i64;
        let documents = ops::find(
            self,
            dima_model::ai_usage_receipts::COLLECTION,
            query,
            Some(doc! { "occurredAt": -1, "entryId": -1 }),
            None,
            limit + 1,
        )
        .await?;
        let has_more = documents.len() as i64 > limit;
        let items: Vec<Value> = documents
            .iter()
            .take(usize::try_from(limit).unwrap_or(0))
            .map(item)
            .collect();
        let next_cursor = match items.last() {
            Some(last) if has_more => {
                let mut map = Map::new();
                map.insert("v".into(), Value::from(2));
                map.insert("id".into(), last.get("id").cloned().unwrap_or(Value::Null));
                map.insert(
                    "at".into(),
                    last.get("occurredAt").cloned().unwrap_or(Value::Null),
                );
                map.insert("scope".into(), Value::from(scope));
                use base64::Engine;
                Some(
                    base64::engine::general_purpose::URL_SAFE_NO_PAD
                        .encode(dima_text::to_js_json(&Value::Object(map)).as_bytes()),
                )
            }
            _ => None,
        };
        let _ = safe_category;
        let _ = num;
        Ok(ItemPage { items, next_cursor })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn filters_are_short_ascii_identifiers() {
        assert!(safe_filter("tts_queue:fish/v1.2-x"));
        assert!(!safe_filter("with space"));
        assert!(!safe_filter("émoji😀"));
        assert!(!safe_filter(&"a".repeat(129)));
    }

    #[test]
    fn missing_fields_stay_missing_and_null_stays_null() {
        let document = doc! {
            "entryId": "e", "occurredAt": DateTime::from_millis(0), "entryKind": "adjustment",
            "category": "credit_adjustment", "operation": "grant", "source": "admin_credit_grant",
            "adjustmentType": Bson::Null, "provider": "polar", "credits": -5_i32, "itemized": true,
        };
        let value = item(&document);
        assert_eq!(value.get("requestId"), None);
        assert_eq!(value["adjustmentType"], "manual_grant");
        assert_eq!(value["credits"], -5.0);
        assert_eq!(value["occurredAt"], "1970-01-01T00:00:00.000Z");
    }
}
