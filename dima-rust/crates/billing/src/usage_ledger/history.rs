//! A channel's usage history as Polar holds it: `normalizePolarUsageEvent`,
//! `normalizePolarCreditEvent` and `fetchAiUsageTransactions` of `utils/ai_usage_receipts.ts`.
//! The backfill ([`crate::usage_backfill`]) writes what this reads into the ledger.
//!
//! Four event streams are read page by page (100 per page, at most [`MAX_POLAR_PAGES`] pages
//! each, newest first): the customer's `ai_usage` events, and the `meter.credited`,
//! `benefit.granted` and `benefit.cycled` system events (a window widened by
//! [`crate::credit_sources::CREDIT_SOURCE_MATCH_MS`] on both sides, to pair a credit with its
//! benefit). A stream longer than the bound fails the whole read ("Usage history is too large
//! for this date range") rather than return part of it. Transactions are keyed by their id (a
//! later page's copy replaces an earlier one), kept only inside the window, typed by
//! [`crate::credit_sources::classify_credit_sources`] where a credit's source is known, and
//! sorted newest first.
//!
//! Text: ids, operations, providers, models and sources are kept only when they match
//! `^[a-zA-Z0-9_.:/-]+$` (ASCII), so the cuts (`slice(0, 96)`, `slice(0, 128)`) are of ASCII.
//! Nothing of a prompt, a message or a spoken text is read.

use super::report::{RECEIPT_CATEGORIES, Transaction, UsageReadError, Window, transaction_order};
use crate::credit_sources::{
    CREDIT_SOURCE_MATCH_MS, CreditSourceError, CreditSourceEvent, CreditSourceReads,
    classify_credit_sources,
};
use crate::polar::{PolarClient, PolarError};
use crate::products::AI_CREDITS_METER_ID;
use crate::usage::{AdjustmentInput, EntryKind, ResourceType, Unit, classify_adjustment};
use futures_util::future::BoxFuture;
use serde_json::{Map, Value};

/// `AI_USAGE_PAGE_SIZE`.
pub const POLAR_PAGE_SIZE: usize = 100;
/// `AI_USAGE_MAX_POLAR_PAGES`.
pub const MAX_POLAR_PAGES: u32 = 100;

/// One `events.list` request.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct EventsRequest {
    /// `customerId`.
    pub customer_id: String,
    /// `name`.
    pub name: &'static str,
    /// `source`: `user` or `system`.
    pub source: &'static str,
    /// `startTimestamp` (ms).
    pub start_ms: i64,
    /// `endTimestamp` (ms).
    pub end_ms: i64,
    /// `page` (from 1).
    pub page: u32,
}

/// Reads one page of a customer's events (`client.events.list`). The answer is Polar's JSON
/// (`{items, pagination}`).
pub trait UsageEvents: Send + Sync {
    /// One page.
    fn page<'a>(&'a self, request: &'a EventsRequest) -> BoxFuture<'a, Result<Value, PolarError>>;
}

impl UsageEvents for PolarClient {
    fn page<'a>(&'a self, request: &'a EventsRequest) -> BoxFuture<'a, Result<Value, PolarError>> {
        Box::pin(self.list_events_page(request))
    }
}

impl super::report::CustomerStates for PolarClient {
    /// `client.customers.getState({id})` (`resolveAiUsagePeriod`): `activeSubscriptions` of
    /// Polar's answer, read loosely (a missing or malformed list is none). Errors carry no id.
    fn active_subscriptions<'a>(
        &'a self,
        customer_id: &'a str,
    ) -> BoxFuture<'a, Result<Vec<super::report::SubscriptionPeriod>, String>> {
        Box::pin(async move {
            let state = self
                .get_customer_state_sdk(customer_id)
                .await
                .map_err(|error| error.to_string())?;
            let list = state
                .get("active_subscriptions")
                .or_else(|| state.get("activeSubscriptions"))
                .and_then(Value::as_array);
            Ok(list
                .map(|items| {
                    items
                        .iter()
                        .map(super::report::SubscriptionPeriod::from_json)
                        .collect()
                })
                .unwrap_or_default())
        })
    }
}

/// Why the history could not be read.
#[derive(Debug, thiserror::Error)]
pub enum HistoryError {
    /// A stream has more pages than [`MAX_POLAR_PAGES`] (422 in the routes).
    #[error(transparent)]
    TooLarge(UsageReadError),
    /// Polar failed.
    #[error(transparent)]
    Polar(#[from] PolarError),
    /// The credit sources could not be read.
    #[error(transparent)]
    CreditSources(#[from] CreditSourceError),
}

/// `finiteNumber` of the receipts module: `null`, `undefined`, `''` and booleans are none; a
/// number is itself; anything else is `Number(value)`; kept when finite.
fn finite_number(value: Option<&Value>) -> Option<f64> {
    let number = match value? {
        Value::Null | Value::Bool(_) => return None,
        Value::String(text) if text.is_empty() => return None,
        other => crate::js::number(Some(other)),
    };
    number.is_finite().then_some(number)
}

fn safe_shape(value: &str) -> bool {
    !value.is_empty()
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'.' | b':' | b'/' | b'-'))
}

/// `optionalSafeText(value, maxLength)`.
fn optional_safe_text(value: Option<&Value>, max: usize) -> Option<String> {
    let text = dima_text::trim(value?.as_str()?);
    // The shape is ASCII, so a byte cut is a character cut.
    safe_shape(text).then(|| text.get(..text.len().min(max)).unwrap_or(text).to_owned())
}

/// `safeText(value, fallback, maxLength)`.
fn safe_text(value: Option<&Value>, fallback: &str, max: usize) -> String {
    optional_safe_text(value, max).unwrap_or_else(|| fallback.to_owned())
}

/// `event.timestamp` as a date (`new Date(String(timestamp || ''))`).
fn timestamp(event: &Value) -> Option<i64> {
    let value = event.get("timestamp");
    if !crate::js::truthy(value) {
        return None;
    }
    dima_text::parse_date(&dima_text::string_of(value?))
}

fn metadata(event: &Value) -> Map<String, Value> {
    event
        .get("metadata")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default()
}

/// `normalizePolarUsageEvent(event)`: an `ai_usage` event of the customer as a transaction;
/// `None` for anything else, an invalid time or credits that are not a finite number.
pub fn normalize_usage_event(event: &Value) -> Option<Transaction> {
    if event.get("name").and_then(Value::as_str) != Some("ai_usage")
        || event.get("source").and_then(Value::as_str) != Some("user")
    {
        return None;
    }
    let at = timestamp(event)?;
    let metadata = metadata(event);
    let meta = |key: &str| metadata.get(key);
    let credits = finite_number(meta("credits"))?;
    let entry_kind =
        if meta("entry_kind").and_then(Value::as_str) == Some("adjustment") || credits < 0.0 {
            EntryKind::Adjustment
        } else {
            EntryKind::Usage
        };
    let raw_text = |key: &str| {
        crate::js::truthy(meta(key))
            .then(|| meta(key).map(dima_text::string_of))
            .flatten()
    };
    let (operation_raw, source_raw) = (raw_text("operation"), raw_text("usage_source"));
    let category = meta("category")
        .and_then(Value::as_str)
        .filter(|c| RECEIPT_CATEGORIES.contains(c))
        .unwrap_or("uncategorized");
    Some(Transaction {
        id: optional_safe_text(meta("entry_id"), 128)
            .or_else(|| optional_safe_text(event.get("id"), 128))
            .unwrap_or_else(|| format!("usage-{at}")),
        request_id: optional_safe_text(meta("request_id"), 128),
        occurred_at_ms: at,
        entry_kind,
        category: category.to_owned(),
        operation: safe_text(meta("operation"), "usage", 96),
        source: optional_safe_text(meta("usage_source"), 128),
        adjustment_type: classify_adjustment(AdjustmentInput {
            entry_kind: Some(entry_kind.as_str()),
            operation: operation_raw.as_deref(),
            source: source_raw.as_deref(),
            reason: meta("reason").and_then(Value::as_str),
            adjustment_type: None,
        })
        .map(str::to_owned),
        provider: safe_text(meta("provider"), "unknown", 96),
        model: optional_safe_text(meta("model"), 128),
        quantity: finite_number(meta("quantity")),
        unit: meta("unit").and_then(Value::as_str).and_then(Unit::parse),
        credits,
        resource_type: meta("resource_type")
            .and_then(Value::as_str)
            .and_then(ResourceType::parse),
        resource_id: optional_safe_text(meta("resource_id"), 128),
        itemized: finite_number(meta("schema_version")) == Some(1.0),
    })
}

/// `normalizePolarCreditEvent(event)`: a `meter.credited` system event of the AI credits meter
/// as an adjustment (reporting only: Polar already applied it).
pub fn normalize_credit_event(event: &Value) -> Option<Transaction> {
    if event.get("name").and_then(Value::as_str) != Some("meter.credited")
        || event.get("source").and_then(Value::as_str) != Some("system")
    {
        return None;
    }
    let id = optional_safe_text(event.get("id"), 128)?;
    let at = timestamp(event)?;
    let metadata = metadata(event);
    let meter = match metadata.get("meterId") {
        Some(Value::Null) | None => metadata.get("meter_id"),
        some => some,
    };
    if meter.and_then(Value::as_str) != Some(AI_CREDITS_METER_ID) {
        return None;
    }
    let units = metadata
        .get("units")
        .and_then(Value::as_f64)
        .filter(|u| u.is_finite() && *u > 0.0)?;
    let rollover = metadata.get("rollover").and_then(Value::as_bool)?;
    Some(Transaction {
        id: format!("polar-credit:{id}"),
        request_id: None,
        occurred_at_ms: at,
        entry_kind: EntryKind::Adjustment,
        category: "credit_adjustment".into(),
        operation: if rollover {
            "permanent_credit_grant"
        } else {
            "period_credit_grant"
        }
        .into(),
        source: Some("polar_meter_credit".into()),
        adjustment_type: Some("native_grant".into()),
        provider: "polar".into(),
        model: None,
        quantity: None,
        unit: None,
        credits: -units,
        resource_type: None,
        resource_id: None,
        itemized: true,
    })
}

type Normalize = fn(&Value) -> Option<Transaction>;

/// `fetchAiUsageTransactions(customerId, window, listEvents, creditSourceReads)`.
pub async fn fetch_transactions(
    customer_id: &str,
    window: &Window,
    events: &dyn UsageEvents,
    reads: &mut dyn CreditSourceReads,
) -> Result<Vec<Transaction>, HistoryError> {
    let mut transactions: Vec<Transaction> = Vec::new();
    let mut source_events: Vec<(String, Value)> = Vec::new();
    let streams: [(&'static str, &'static str, Option<Normalize>); 4] = [
        ("ai_usage", "user", Some(normalize_usage_event)),
        ("meter.credited", "system", Some(normalize_credit_event)),
        ("benefit.granted", "system", None),
        ("benefit.cycled", "system", None),
    ];
    for (name, source, normalize) in streams {
        let system = source == "system";
        let mut complete = false;
        for page in 1..=MAX_POLAR_PAGES {
            let request = EventsRequest {
                customer_id: customer_id.to_owned(),
                name,
                source,
                start_ms: if system {
                    window.start_ms - CREDIT_SOURCE_MATCH_MS
                } else {
                    window.start_ms
                },
                end_ms: if system {
                    window.end_exclusive_ms + CREDIT_SOURCE_MATCH_MS
                } else {
                    window.end_exclusive_ms
                },
                page,
            };
            let result = events.page(&request).await?;
            let items: &[Value] = result
                .get("items")
                .and_then(Value::as_array)
                .map_or(&[], Vec::as_slice);
            for item in items {
                if system && let Some(id) = item.get("id").and_then(Value::as_str) {
                    match source_events.iter_mut().find(|(known, _)| known == id) {
                        Some((_, event)) => *event = item.clone(),
                        None => source_events.push((id.to_owned(), item.clone())),
                    }
                }
                let Some(normalized) = normalize.and_then(|n| n(item)) else {
                    continue;
                };
                if normalized.occurred_at_ms >= window.start_ms
                    && normalized.occurred_at_ms < window.end_exclusive_ms
                {
                    match transactions.iter_mut().find(|t| t.id == normalized.id) {
                        Some(existing) => *existing = normalized,
                        None => transactions.push(normalized),
                    }
                }
            }
            let pagination = result.get("pagination");
            let max_page = pagination
                .and_then(|p| p.get("maxPage").or_else(|| p.get("max_page")))
                .and_then(Value::as_f64);
            let another = match max_page {
                Some(max) => f64::from(page) < max,
                None => {
                    pagination
                        .and_then(|p| p.get("hasNextPage"))
                        .and_then(Value::as_bool)
                        == Some(true)
                        || items.len() == POLAR_PAGE_SIZE
                }
            };
            if !another {
                complete = true;
                break;
            }
        }
        if !complete {
            return Err(HistoryError::TooLarge(UsageReadError::Limit(
                "Usage history is too large for this date range".into(),
            )));
        }
    }
    let events: Vec<CreditSourceEvent> = source_events
        .iter()
        .map(|(_, event)| CreditSourceEvent::from_json(event))
        .collect();
    let sources = classify_credit_sources(customer_id, &events, reads).await?;
    for (event_id, kind) in sources {
        let id = format!("polar-credit:{event_id}");
        if let Some(receipt) = transactions.iter_mut().find(|t| t.id == id) {
            receipt.adjustment_type = kind.as_str().map(str::to_owned);
        }
    }
    transactions.sort_by(transaction_order);
    Ok(transactions)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn credits_must_be_a_number_or_numeric_text() {
        let event = |credits: Value| json!({"id": "e", "name": "ai_usage", "source": "user", "timestamp": "2026-09-19T12:00:00Z", "metadata": {"credits": credits}});
        for refused in [json!(null), json!(true), json!(""), json!("x"), json!({})] {
            assert_eq!(normalize_usage_event(&event(refused)), None);
        }
        assert_eq!(
            normalize_usage_event(&event(json!(" 12 "))).map(|t| t.credits),
            Some(12.0)
        );
        assert_eq!(
            normalize_usage_event(&event(json!([7]))).map(|t| t.credits),
            Some(7.0)
        );
        let fallback = normalize_usage_event(&json!({"name": "ai_usage", "source": "user", "timestamp": "2026-09-19T12:00:00Z", "metadata": {"credits": 1, "entry_id": "with space", "model": "😀"}})).unwrap();
        assert_eq!(fallback.id, "usage-1789819200000");
        assert_eq!(fallback.model, None);
    }
}
