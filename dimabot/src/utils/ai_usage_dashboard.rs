//! Cached AI usage dashboard from `dimabot/src/utils/ai_usage_dashboard.ts`.
//!
//! Preserves the receipt aggregate, the timezone `$dateToString` day label, ICU
//! category order, the 60-second freshness window, and the split between the
//! outer cache clock and `computeDashboard`'s own clock. History uses completed
//! UTC days only.
//!
//! This module does not install indexes, enqueue backfills, or call Polar.
//! Category order uses the root ICU collator (`unicode-collation`), the same
//! call as `dashboard_insights`. It is not codepoint order. Zone conversion
//! itself stays inside MongoDB `$dateToString`; the host TZif reader lives in
//! `ai_usage_period` and is not repeated here.

use std::collections::HashMap;

use futures_util::TryStreamExt;
use icu_collator::{Collator, CollatorBorrowed};
use mongodb::{
    Collection, Database,
    bson::{Bson, DateTime, Document, doc},
};
use redis::aio::ConnectionManager;
use sha2::{Digest, Sha256};

use super::{
    ai_usage_aggregate_policy::group_fields,
    ai_usage_ledger_queries::{AiUsagePacingHistory, AiUsageWindow, current_js_date},
    ai_usage_ledger_reads::{
        AiUsageLedgerReadError, AiUsageLedgerStateInput, MongoAiUsageLedgerReads, date_method,
    },
    ai_usage_lock::{AiUsageLock, AiUsageLockError},
    ai_usage_period::{
        AI_USAGE_ITEMIZATION_STARTED_AT, MILLISECONDS_PER_DAY, js_ceil, js_floor, js_max,
    },
    ai_usage_receipt_parser::RetentionTier,
    bson_compat::js_number,
    credit_policy::JsDate,
    js_string::JsString,
    lossless_json::JsonValue,
    tts_usage_pricing::js_round,
};

pub const DASHBOARD_FRESHNESS_MS: f64 = 60_000.0;
const DAY_MS: i64 = 86_400_000;

#[derive(Debug)]
pub enum DashboardError {
    Validation(String),
    Ledger(AiUsageLedgerReadError),
    Mongo(mongodb::error::Error),
    Lock(String),
    Collation,
}

impl std::fmt::Display for DashboardError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Validation(message) => formatter.write_str(message),
            Self::Ledger(error) => write!(formatter, "{error}"),
            Self::Mongo(error) => write!(formatter, "{error}"),
            Self::Lock(message) => formatter.write_str(message),
            Self::Collation => formatter.write_str("Cannot initialize AI usage collation"),
        }
    }
}

impl std::error::Error for DashboardError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Ledger(error) => Some(error),
            Self::Mongo(error) => Some(error),
            _ => None,
        }
    }
}

impl From<AiUsageLedgerReadError> for DashboardError {
    fn from(error: AiUsageLedgerReadError) -> Self {
        Self::Ledger(error)
    }
}

impl From<mongodb::error::Error> for DashboardError {
    fn from(error: mongodb::error::Error) -> Self {
        Self::Mongo(error)
    }
}

#[derive(Clone, Debug)]
pub struct DashboardReadInput {
    pub channel_id: JsString,
    pub customer_id: JsString,
    pub plan_tier: JsonValue,
    pub account_created_at: JsDate,
    pub window: AiUsageWindow,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DashboardWindow {
    pub from: String,
    pub to: String,
    pub time_zone: String,
    pub start_timestamp: String,
    pub end_timestamp_exclusive: String,
    pub days: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DashboardRequest {
    pub channel_id: String,
    pub customer_id: String,
    pub plan_tier: String,
    pub account_created_at: String,
    pub window: DashboardWindow,
}

#[derive(Clone, Debug, PartialEq)]
pub struct DashboardDay {
    pub date: String,
    pub credits: f64,
    pub transaction_count: f64,
}

#[derive(Clone, Debug, PartialEq)]
pub struct DashboardCategory {
    pub category: String,
    pub credits: f64,
    pub transaction_count: f64,
    pub percentage: f64,
}

#[derive(Clone, Debug, PartialEq)]
pub struct DashboardAdjustment {
    pub adjustment_type: String,
    pub granted_credits: f64,
    pub debited_credits: f64,
    pub transaction_count: f64,
}

#[derive(Clone, Debug, PartialEq)]
pub struct DashboardSummary {
    pub schema_version: i64,
    pub itemization_started_at: String,
    pub period_from: String,
    pub period_to: String,
    pub period_time_zone: String,
    pub day_count: usize,
    pub total_spent_credits: f64,
    pub average_daily_spent_credits: f64,
    pub granted_credits: f64,
    pub adjustment_debited_credits: f64,
    pub net_consumed_credits: f64,
    pub transaction_count: f64,
    pub daily: Vec<DashboardDay>,
    pub categories: Vec<DashboardCategory>,
    pub adjustments: Vec<DashboardAdjustment>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct DashboardComputed {
    pub summary: DashboardSummary,
    pub history: Option<AiUsagePacingHistory>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct AiUsageDashboard {
    pub summary: DashboardSummary,
    pub history: Option<AiUsagePacingHistory>,
    pub refreshed_at: String,
    pub cached: bool,
}

/// No ledger document. The source's `state?.coverageStart` term is undefined.
#[derive(Clone, Copy, Debug)]
pub enum CoverageInstant {
    Absent,
    /// `getTime()`, including `0` and `NaN`. Falsy values fall back to `now`.
    Millis(f64),
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct HistoryWindow {
    pub start_ms: i64,
    pub end_ms: i64,
    pub days: i64,
}

fn invalid_time() -> DashboardError {
    DashboardError::Validation("Invalid time value".to_string())
}

fn collator() -> Result<CollatorBorrowed<'static>, DashboardError> {
    Collator::try_new(Default::default(), Default::default()).map_err(|_| DashboardError::Collation)
}

fn credit_desc(left: f64, right: f64) -> std::cmp::Ordering {
    let difference = right - left;
    if difference.is_finite() && difference != 0.0 {
        if difference > 0.0 {
            std::cmp::Ordering::Greater
        } else {
            std::cmp::Ordering::Less
        }
    } else {
        std::cmp::Ordering::Equal
    }
}

fn number_truthy(value: f64) -> bool {
    value != 0.0 && !value.is_nan()
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

fn utf8_string(value: &JsString, field: &str) -> Result<String, DashboardError> {
    value
        .as_str()
        .map(str::to_string)
        .ok_or_else(|| DashboardError::Validation(format!("{field} must be valid UTF-8")))
}

/// Canonical `JSON.stringify` object for the cache key. Key order matches the
/// billing route's summary read input.
pub fn dashboard_request_json(input: &DashboardReadInput) -> Result<JsonValue, DashboardError> {
    let JsonValue::String(plan) = &input.plan_tier else {
        return Err(DashboardError::Validation("planTier must be a string".to_string()));
    };
    let account = input
        .account_created_at
        .to_iso_string()
        .map_err(|_| invalid_time())?;
    let start = input
        .window
        .start_timestamp
        .to_iso_string()
        .map_err(|_| invalid_time())?;
    let end = input
        .window
        .end_timestamp_exclusive
        .to_iso_string()
        .map_err(|_| invalid_time())?;
    let days = input
        .window
        .days
        .iter()
        .map(|day| JsonValue::String(day.clone()))
        .collect();
    Ok(JsonValue::Object(vec![
        ("channelID".into(), JsonValue::String(input.channel_id.clone())),
        ("customerId".into(), JsonValue::String(input.customer_id.clone())),
        ("planTier".into(), JsonValue::String(plan.clone())),
        ("accountCreatedAt".into(), JsonValue::String(account.into())),
        (
            "window".into(),
            JsonValue::Object(vec![
                ("from".into(), JsonValue::String(input.window.from.clone())),
                ("to".into(), JsonValue::String(input.window.to.clone())),
                ("timeZone".into(), JsonValue::String(input.window.time_zone.clone())),
                ("startTimestamp".into(), JsonValue::String(start.into())),
                ("endTimestampExclusive".into(), JsonValue::String(end.into())),
                ("days".into(), JsonValue::Array(days)),
            ]),
        ),
    ]))
}

pub fn dashboard_cache_key(request: &JsonValue) -> String {
    sha256_hex(&request.to_json_string())
}

fn json_string(value: &JsonValue, field: &str) -> Result<String, DashboardError> {
    match value {
        JsonValue::String(text) => utf8_string(text, field),
        _ => Err(DashboardError::Validation(format!("{field} must be a string"))),
    }
}

pub fn dashboard_request_from_json(value: &JsonValue) -> Result<DashboardRequest, DashboardError> {
    let JsonValue::Object(fields) = value else {
        return Err(DashboardError::Validation("dashboard request must be an object".into()));
    };
    let get = |key: &str| {
        fields
            .iter()
            .find(|(name, _)| name.as_str() == Some(key))
            .map(|(_, value)| value)
            .ok_or_else(|| DashboardError::Validation(format!("dashboard request is missing {key}")))
    };
    let window_value = get("window")?;
    let JsonValue::Object(window_fields) = window_value else {
        return Err(DashboardError::Validation("dashboard window must be an object".into()));
    };
    let window_get = |key: &str| {
        window_fields
            .iter()
            .find(|(name, _)| name.as_str() == Some(key))
            .map(|(_, value)| value)
            .ok_or_else(|| DashboardError::Validation(format!("dashboard window is missing {key}")))
    };
    let JsonValue::Array(days) = window_get("days")? else {
        return Err(DashboardError::Validation("dashboard window days must be an array".into()));
    };
    let mut labels = Vec::with_capacity(days.len());
    for day in days {
        labels.push(json_string(day, "day")?);
    }
    Ok(DashboardRequest {
        channel_id: json_string(get("channelID")?, "channelID")?,
        customer_id: json_string(get("customerId")?, "customerId")?,
        plan_tier: json_string(get("planTier")?, "planTier")?,
        account_created_at: json_string(get("accountCreatedAt")?, "accountCreatedAt")?,
        window: DashboardWindow {
            from: json_string(window_get("from")?, "from")?,
            to: json_string(window_get("to")?, "to")?,
            time_zone: json_string(window_get("timeZone")?, "timeZone")?,
            start_timestamp: json_string(window_get("startTimestamp")?, "startTimestamp")?,
            end_timestamp_exclusive: json_string(
                window_get("endTimestampExclusive")?,
                "endTimestampExclusive",
            )?,
            days: labels,
        },
    })
}

/// `now.getTime() - retention`, then `accountCreatedAt || 0`, then coverage.
/// Invalid `now` fails before the floor, matching `toISOString`.
pub fn history_window(
    now: JsDate,
    retention_days: i64,
    account_created_at_ms: f64,
    coverage: CoverageInstant,
) -> Result<Option<HistoryWindow>, DashboardError> {
    let iso = now.to_iso_string().map_err(|_| invalid_time())?;
    let prefix: String = iso.chars().take(10).collect();
    let end_ms = super::js_date::parse_date(&format!("{prefix}T00:00:00.000Z"))
        .ok_or_else(invalid_time)?;
    let now_ms = now.timestamp_millis().ok_or_else(invalid_time)? as f64;
    let coverage_ms = match coverage {
        CoverageInstant::Absent => now_ms,
        CoverageInstant::Millis(value) if value == 0.0 || value.is_nan() => now_ms,
        CoverageInstant::Millis(value) => value,
    };
    let floor = js_max(
        js_max(now_ms - retention_days as f64 * MILLISECONDS_PER_DAY, account_created_at_ms),
        coverage_ms,
    );
    let start = js_ceil(floor / MILLISECONDS_PER_DAY) * MILLISECONDS_PER_DAY;
    let days = js_max(0.0, js_floor((end_ms as f64 - start) / MILLISECONDS_PER_DAY));
    if !(days > 0.0) || !start.is_finite() || start.fract() != 0.0 {
        return Ok(None);
    }
    let start_ms = start as i64;
    if JsDate::from_millis(start).timestamp_millis().is_none() {
        return Err(invalid_time());
    }
    Ok(Some(HistoryWindow {
        start_ms,
        end_ms,
        days: days as i64,
    }))
}

pub fn account_created_millis(value: &str) -> f64 {
    super::js_date::parse_date(value).map(|millis| millis as f64).unwrap_or(0.0)
}

fn iso_day(millis: i64) -> Result<String, DashboardError> {
    let iso = JsDate::from_millis(millis as f64)
        .to_iso_string()
        .map_err(|_| invalid_time())?;
    Ok(iso.chars().take(10).collect())
}

fn bson_f64(value: Option<&Bson>, field: &str) -> Result<f64, DashboardError> {
    match value {
        Some(Bson::Double(number)) => Ok(*number),
        Some(Bson::Int32(number)) => Ok(f64::from(*number)),
        Some(Bson::Int64(number)) => Ok(*number as f64),
        _ => Err(DashboardError::Validation(format!(
            "aggregate field {field} is not a number"
        ))),
    }
}

fn row_document<'a>(row: &'a Document, field: &str) -> Result<&'a Document, DashboardError> {
    match row.get(field) {
        Some(Bson::Document(document)) => Ok(document),
        _ => Err(DashboardError::Validation(format!(
            "aggregate row is missing {field}"
        ))),
    }
}

/// Fold Mongo aggregate rows. Day buckets follow the row's `date` label, which
/// `$dateToString` already computed in the request timezone.
pub fn fold_dashboard_rows(
    window: &DashboardWindow,
    rows: &[Document],
) -> Result<DashboardSummary, DashboardError> {
    let mut daily: Vec<(String, f64, f64)> = window
        .days
        .iter()
        .map(|date| (date.clone(), 0.0, 0.0))
        .collect();
    let mut categories: Vec<(String, f64, f64)> = Vec::new();
    let mut adjustments: Vec<(String, f64, f64, f64)> = Vec::new();
    let mut spent = 0.0;
    let mut granted = 0.0;
    let mut debited = 0.0;
    let mut count = 0.0;
    for row in rows {
        let id = row_document(row, "_id")?;
        let date = match id.get("date") {
            Some(Bson::String(date)) => date.clone(),
            _ => {
                return Err(DashboardError::Validation(
                    "aggregate date is missing".to_string(),
                ))
            }
        };
        let row_spent = bson_f64(row.get("spent"), "spent")?;
        let row_granted = bson_f64(row.get("granted"), "granted")?;
        let row_debited = bson_f64(row.get("debited"), "debited")?;
        let row_count = bson_f64(row.get("count"), "count")?;
        let row_adjustments = bson_f64(row.get("adjustments"), "adjustments")?;
        spent += row_spent;
        granted += row_granted;
        debited += row_debited;
        count += row_count;
        if let Some(day) = daily.iter_mut().find(|(label, _, _)| label == &date) {
            day.1 += row_spent;
            day.2 += row_count;
        }
        if number_truthy(row_count) {
            let category = match id.get("category") {
                None | Some(Bson::Null) => "uncategorized".to_string(),
                Some(Bson::String(value)) if value.is_empty() => "uncategorized".to_string(),
                Some(Bson::String(value)) => value.clone(),
                _ => {
                    return Err(DashboardError::Validation(
                        "aggregate category must be a string".to_string(),
                    ))
                }
            };
            if let Some(entry) = categories.iter_mut().find(|(name, _, _)| name == &category) {
                entry.1 += row_spent;
                entry.2 += row_count;
            } else {
                categories.push((category, row_spent, row_count));
            }
        }
        if number_truthy(row_adjustments) {
            let adjustment_type = match id.get("adjustmentType") {
                Some(Bson::String(value)) => value.clone(),
                _ => {
                    return Err(DashboardError::Validation(
                        "aggregate adjustmentType is missing".to_string(),
                    ))
                }
            };
            if let Some(entry) = adjustments
                .iter_mut()
                .find(|(name, _, _, _)| name == &adjustment_type)
            {
                entry.1 += row_granted;
                entry.2 += row_debited;
                entry.3 += row_adjustments;
            } else {
                adjustments.push((adjustment_type, row_granted, row_debited, row_adjustments));
            }
        }
    }
    let order = collator()?;
    categories.sort_by(|left, right| {
        credit_desc(left.1, right.1).then_with(|| order.compare(&left.0, &right.0))
    });
    adjustments.sort_by(|left, right| order.compare(&left.0, &right.0));
    let day_count = daily.len();
    Ok(DashboardSummary {
        schema_version: 1,
        itemization_started_at: AI_USAGE_ITEMIZATION_STARTED_AT.to_string(),
        period_from: window.from.clone(),
        period_to: window.to.clone(),
        period_time_zone: window.time_zone.clone(),
        day_count,
        total_spent_credits: spent,
        average_daily_spent_credits: js_round(
            spent / js_max(1.0, day_count as f64) * 100.0,
        ) / 100.0,
        granted_credits: granted,
        adjustment_debited_credits: debited,
        net_consumed_credits: spent + debited - granted,
        transaction_count: count,
        daily: daily
            .into_iter()
            .map(|(date, credits, transaction_count)| DashboardDay {
                date,
                credits,
                transaction_count,
            })
            .collect(),
        categories: categories
            .into_iter()
            .map(|(category, credits, transaction_count)| DashboardCategory {
                percentage: if number_truthy(spent) {
                    js_round(credits / spent * 10_000.0) / 100.0
                } else {
                    0.0
                },
                category,
                credits,
                transaction_count,
            })
            .collect(),
        adjustments: adjustments
            .into_iter()
            .map(|(adjustment_type, granted_credits, debited_credits, transaction_count)| {
                DashboardAdjustment {
                    adjustment_type,
                    granted_credits,
                    debited_credits,
                    transaction_count,
                }
            })
            .collect(),
    })
}

pub fn pacing_history_from_rows(
    bounds: HistoryWindow,
    rows: &[Document],
) -> Result<AiUsagePacingHistory, DashboardError> {
    let mut totals: HashMap<String, f64> = HashMap::new();
    for row in rows {
        let id = row_document(row, "_id")?;
        let date = match id.get("date") {
            Some(Bson::String(date)) => date.clone(),
            _ => {
                return Err(DashboardError::Validation(
                    "aggregate date is missing".to_string(),
                ))
            }
        };
        let spent = bson_f64(row.get("spent"), "spent")?;
        *totals.entry(date).or_insert(0.0) += spent;
    }
    let mut samples = Vec::with_capacity(usize::try_from(bounds.days).unwrap_or(0));
    for index in 0..bounds.days {
        let millis = bounds
            .start_ms
            .checked_add(index.checked_mul(DAY_MS).ok_or_else(invalid_time)?)
            .ok_or_else(invalid_time)?;
        let label = iso_day(millis)?;
        samples.push(totals.get(&label).copied().unwrap_or(0.0));
    }
    let days = bounds.days as f64;
    let total: f64 = samples.iter().sum();
    let mean = total / days;
    let variance = samples
        .iter()
        .map(|sample| {
            let delta = sample - mean;
            delta * delta
        })
        .sum::<f64>()
        / days;
    let recent_len = bounds.days.min(7).max(0) as usize;
    let recent = &samples[samples.len().saturating_sub(recent_len)..];
    let recent_average = if recent.is_empty() {
        0.0
    } else {
        recent.iter().sum::<f64>() / recent.len() as f64
    };
    let active = samples.iter().filter(|sample| **sample > 0.0).count() as f64;
    Ok(AiUsagePacingHistory {
        active_day_count: Some(active),
        coefficient_of_variation: Some(if mean > 0.0 { variance.sqrt() / mean } else { 0.0 }),
        recent_average_daily_credits: Some(recent_average),
        recent_day_count: Some(recent.len() as f64),
        average_daily_credits: mean,
        total_spent_credits: total,
        day_count: days,
        from: iso_day(bounds.start_ms)?,
        to: iso_day(bounds.end_ms.checked_sub(1).ok_or_else(invalid_time)?)?,
    })
}

pub fn dashboard_aggregate_pipeline(
    channel_id: &str,
    customer_id: &str,
    start: DateTime,
    end: DateTime,
    time_zone: &str,
    now: DateTime,
) -> Vec<Document> {
    let id = doc! {
        "date": {"$dateToString": {"date": "$occurredAt", "format": "%Y-%m-%d", "timezone": time_zone}},
        "category": "$category",
        "kind": "$entryKind",
        "adjustmentType": {"$ifNull": ["$adjustmentType", "other"]},
    };
    vec![
        doc! {"$match": {
            "channelID": channel_id,
            "customerId": customer_id,
            "occurredAt": {"$gte": start, "$lt": end},
            "expiresAt": {"$gt": now},
        }},
        doc! {"$group": group_fields(id, true)},
    ]
}

pub fn bson_is_truthy(value: Option<&Bson>) -> bool {
    match value {
        None | Some(Bson::Null | Bson::Undefined) => false,
        Some(Bson::Boolean(value)) => *value,
        Some(Bson::Int32(value)) => *value != 0,
        Some(Bson::Int64(value)) => *value != 0,
        Some(Bson::Double(value)) => *value != 0.0 && !value.is_nan(),
        Some(Bson::String(value)) => !value.is_empty(),
        Some(_) => true,
    }
}

pub fn bson_date_millis(value: Option<&Bson>, field: &'static str) -> Result<f64, DashboardError> {
    match value {
        Some(Bson::DateTime(date)) => {
            let parsed = JsDate::from_millis(date.timestamp_millis() as f64);
            Ok(parsed.timestamp_millis().map(|millis| millis as f64).unwrap_or(f64::NAN))
        }
        _ => Err(DashboardError::Ledger(AiUsageLedgerReadError::TypeError {
            field,
            method: "getTime",
        })),
    }
}

/// `!dirty && now - refreshedAt < 60000`. Exactly 60000 is a miss. A future
/// `refreshedAt` is a hit. An out-of-range BSON date compares as NaN and misses.
pub fn dashboard_row_is_fresh(document: &Document, now_ms: f64) -> Result<bool, DashboardError> {
    if bson_is_truthy(document.get("dirty")) {
        return Ok(false);
    }
    let refreshed = bson_date_millis(document.get("refreshedAt"), "refreshedAt")?;
    Ok(now_ms - refreshed < DASHBOARD_FRESHNESS_MS)
}

fn require_instant(value: &str, field: &'static str) -> Result<DateTime, DashboardError> {
    let millis = super::js_date::parse_date(value).ok_or_else(|| {
        DashboardError::Ledger(AiUsageLedgerReadError::CastError { path: field })
    })?;
    Ok(DateTime::from_millis(millis))
}

fn summary_document(summary: &DashboardSummary) -> Document {
    let daily: Vec<Bson> = summary
        .daily
        .iter()
        .map(|day| {
            Bson::Document(doc! {
                "date": &day.date,
                "credits": js_number(day.credits),
                "transactionCount": js_number(day.transaction_count),
            })
        })
        .collect();
    let categories: Vec<Bson> = summary
        .categories
        .iter()
        .map(|row| {
            Bson::Document(doc! {
                "category": &row.category,
                "credits": js_number(row.credits),
                "transactionCount": js_number(row.transaction_count),
                "percentage": js_number(row.percentage),
            })
        })
        .collect();
    let adjustments: Vec<Bson> = summary
        .adjustments
        .iter()
        .map(|row| {
            Bson::Document(doc! {
                "type": &row.adjustment_type,
                "grantedCredits": js_number(row.granted_credits),
                "debitedCredits": js_number(row.debited_credits),
                "transactionCount": js_number(row.transaction_count),
            })
        })
        .collect();
    doc! {
        "schemaVersion": summary.schema_version as i32,
        "itemizationStartedAt": &summary.itemization_started_at,
        "period": {
            "from": &summary.period_from,
            "to": &summary.period_to,
            "timeZone": &summary.period_time_zone,
            "dayCount": summary.day_count as i64,
        },
        "totalSpentCredits": js_number(summary.total_spent_credits),
        "averageDailySpentCredits": js_number(summary.average_daily_spent_credits),
        "grantedCredits": js_number(summary.granted_credits),
        "adjustmentDebitedCredits": js_number(summary.adjustment_debited_credits),
        "netConsumedCredits": js_number(summary.net_consumed_credits),
        "transactionCount": js_number(summary.transaction_count),
        "daily": daily,
        "categories": categories,
        "adjustments": adjustments,
    }
}

fn history_document(history: &AiUsagePacingHistory) -> Document {
    let mut document = doc! {
        "averageDailyCredits": js_number(history.average_daily_credits),
        "totalSpentCredits": js_number(history.total_spent_credits),
        "dayCount": js_number(history.day_count),
        "from": &history.from,
        "to": &history.to,
    };
    let number = |value: Option<f64>| value.map(js_number).unwrap_or(Bson::Null);
    document.insert("activeDayCount", number(history.active_day_count));
    document.insert("coefficientOfVariation", number(history.coefficient_of_variation));
    document.insert(
        "recentAverageDailyCredits",
        number(history.recent_average_daily_credits),
    );
    document.insert("recentDayCount", number(history.recent_day_count));
    document
}

fn computed_document(data: &DashboardComputed) -> Document {
    let mut document = doc! { "summary": summary_document(&data.summary) };
    match &data.history {
        Some(history) => document.insert("history", history_document(history)),
        None => document.insert("history", Bson::Null),
    };
    document
}

fn malformed() -> DashboardError {
    DashboardError::Validation("malformed cached dashboard".to_string())
}

fn doc_f64(document: &Document, field: &str) -> Result<f64, DashboardError> {
    bson_f64(document.get(field), field).map_err(|_| malformed())
}

fn doc_string(document: &Document, field: &str) -> Result<String, DashboardError> {
    match document.get(field) {
        Some(Bson::String(value)) => Ok(value.clone()),
        _ => Err(malformed()),
    }
}

fn decode_summary(document: &Document) -> Result<DashboardSummary, DashboardError> {
    let period = row_document(document, "period").map_err(|_| malformed())?;
    let daily_values = match document.get("daily") {
        Some(Bson::Array(values)) => values,
        _ => return Err(malformed()),
    };
    let mut daily = Vec::new();
    for value in daily_values {
        let Bson::Document(row) = value else {
            return Err(malformed());
        };
        daily.push(DashboardDay {
            date: doc_string(row, "date")?,
            credits: doc_f64(row, "credits")?,
            transaction_count: doc_f64(row, "transactionCount")?,
        });
    }
    let category_values = match document.get("categories") {
        Some(Bson::Array(values)) => values,
        _ => return Err(malformed()),
    };
    let mut categories = Vec::new();
    for value in category_values {
        let Bson::Document(row) = value else {
            return Err(malformed());
        };
        categories.push(DashboardCategory {
            category: doc_string(row, "category")?,
            credits: doc_f64(row, "credits")?,
            transaction_count: doc_f64(row, "transactionCount")?,
            percentage: doc_f64(row, "percentage")?,
        });
    }
    let adjustment_values = match document.get("adjustments") {
        Some(Bson::Array(values)) => values,
        _ => return Err(malformed()),
    };
    let mut adjustments = Vec::new();
    for value in adjustment_values {
        let Bson::Document(row) = value else {
            return Err(malformed());
        };
        adjustments.push(DashboardAdjustment {
            adjustment_type: doc_string(row, "type")?,
            granted_credits: doc_f64(row, "grantedCredits")?,
            debited_credits: doc_f64(row, "debitedCredits")?,
            transaction_count: doc_f64(row, "transactionCount")?,
        });
    }
    let day_count = match period.get("dayCount") {
        Some(Bson::Int32(value)) if *value >= 0 => *value as usize,
        Some(Bson::Int64(value)) if *value >= 0 => *value as usize,
        Some(Bson::Double(value)) if value.is_finite() && value.fract() == 0.0 && *value >= 0.0 => {
            *value as usize
        }
        _ => return Err(malformed()),
    };
    Ok(DashboardSummary {
        schema_version: doc_f64(document, "schemaVersion")? as i64,
        itemization_started_at: doc_string(document, "itemizationStartedAt")?,
        period_from: doc_string(period, "from")?,
        period_to: doc_string(period, "to")?,
        period_time_zone: doc_string(period, "timeZone")?,
        day_count,
        total_spent_credits: doc_f64(document, "totalSpentCredits")?,
        average_daily_spent_credits: doc_f64(document, "averageDailySpentCredits")?,
        granted_credits: doc_f64(document, "grantedCredits")?,
        adjustment_debited_credits: doc_f64(document, "adjustmentDebitedCredits")?,
        net_consumed_credits: doc_f64(document, "netConsumedCredits")?,
        transaction_count: doc_f64(document, "transactionCount")?,
        daily,
        categories,
        adjustments,
    })
}

fn decode_history(value: Option<&Bson>) -> Result<Option<AiUsagePacingHistory>, DashboardError> {
    match value {
        None | Some(Bson::Null) => Ok(None),
        Some(Bson::Document(document)) => Ok(Some(AiUsagePacingHistory {
            average_daily_credits: doc_f64(document, "averageDailyCredits")?,
            total_spent_credits: doc_f64(document, "totalSpentCredits")?,
            day_count: doc_f64(document, "dayCount")?,
            from: doc_string(document, "from")?,
            to: doc_string(document, "to")?,
            active_day_count: Some(doc_f64(document, "activeDayCount")?),
            coefficient_of_variation: Some(doc_f64(document, "coefficientOfVariation")?),
            recent_average_daily_credits: Some(doc_f64(document, "recentAverageDailyCredits")?),
            recent_day_count: Some(doc_f64(document, "recentDayCount")?),
        })),
        _ => Err(malformed()),
    }
}

fn decode_computed(document: &Document) -> Result<DashboardComputed, DashboardError> {
    let summary = match document.get("summary") {
        Some(Bson::Document(summary)) => decode_summary(summary)?,
        _ => return Err(malformed()),
    };
    Ok(DashboardComputed {
        summary,
        history: decode_history(document.get("history"))?,
    })
}

fn json_to_bson(value: &JsonValue) -> Bson {
    match value {
        JsonValue::Null => Bson::Null,
        JsonValue::Bool(value) => Bson::Boolean(*value),
        JsonValue::Number(value) => js_number(*value),
        JsonValue::String(value) => Bson::String(value.to_utf8_lossy()),
        JsonValue::Array(items) => Bson::Array(items.iter().map(json_to_bson).collect()),
        JsonValue::Object(fields) => {
            let mut document = Document::new();
            for (key, value) in fields {
                if let Some(key) = key.as_str() {
                    document.insert(key, json_to_bson(value));
                }
            }
            Bson::Document(document)
        }
    }
}

fn bson_to_json(value: &Bson) -> Result<JsonValue, DashboardError> {
    Ok(match value {
        Bson::Null => JsonValue::Null,
        Bson::Boolean(value) => JsonValue::Bool(*value),
        Bson::Int32(value) => JsonValue::Number(f64::from(*value)),
        Bson::Int64(value) => JsonValue::Number(*value as f64),
        Bson::Double(value) => JsonValue::Number(*value),
        Bson::String(value) => JsonValue::String(value.as_str().into()),
        Bson::Array(items) => {
            JsonValue::Array(items.iter().map(bson_to_json).collect::<Result<Vec<_>, _>>()?)
        }
        Bson::Document(document) => {
            let mut fields = Vec::new();
            for (key, value) in document {
                fields.push((JsString::from(key.as_str()), bson_to_json(value)?));
            }
            JsonValue::Object(fields)
        }
        _ => return Err(malformed()),
    })
}

async fn aggregate_rows(
    receipts: &Collection<Document>,
    request: &DashboardRequest,
    start: DateTime,
    end: DateTime,
    time_zone: &str,
    now: DateTime,
) -> Result<Vec<Document>, DashboardError> {
    let pipeline = dashboard_aggregate_pipeline(
        &request.channel_id,
        &request.customer_id,
        start,
        end,
        time_zone,
        now,
    );
    Ok(receipts
        .clone()
        .aggregate(pipeline)
        .await?
        .try_collect()
        .await?)
}

/// `computeDashboard`. `now == None` samples a new clock inside this call.
pub async fn compute_dashboard(
    receipts: &Collection<Document>,
    reads: &MongoAiUsageLedgerReads,
    request: &DashboardRequest,
    now: Option<JsDate>,
) -> Result<DashboardComputed, DashboardError> {
    let now = now.unwrap_or_else(current_js_date);
    let now_ms = now.timestamp_millis().ok_or_else(invalid_time)?;
    let start = require_instant(&request.window.start_timestamp, "occurredAt")?;
    let end = require_instant(&request.window.end_timestamp_exclusive, "occurredAt")?;
    let rows = aggregate_rows(
        receipts,
        request,
        start,
        end,
        &request.window.time_zone,
        DateTime::from_millis(now_ms),
    )
    .await?;
    let summary = fold_dashboard_rows(&request.window, &rows)?;
    let state = reads
        .get_ai_usage_ledger_state(&AiUsageLedgerStateInput {
            channel_id: JsString::from(request.channel_id.as_str()),
            customer_id: JsString::from(request.customer_id.as_str()),
        })
        .await?;
    let coverage = match &state {
        None => CoverageInstant::Absent,
        Some(state) => {
            let date = date_method(&state.coverage_start, "coverageStart", "getTime")?;
            CoverageInstant::Millis(
                date.timestamp_millis().map(|millis| millis as f64).unwrap_or(f64::NAN),
            )
        }
    };
    let bounds = history_window(
        now,
        RetentionTier::from_value(&JsonValue::String(request.plan_tier.as_str().into())).days(),
        account_created_millis(&request.account_created_at),
        coverage,
    )?;
    let history = if let Some(bounds) = bounds.filter(|_| state.is_some()) {
        let history_rows = aggregate_rows(
            receipts,
            request,
            DateTime::from_millis(bounds.start_ms),
            DateTime::from_millis(bounds.end_ms),
            "UTC",
            DateTime::from_millis(now_ms),
        )
        .await?;
        Some(pacing_history_from_rows(bounds, &history_rows)?)
    } else {
        None
    };
    Ok(DashboardComputed { summary, history })
}

fn map_lock<T>(
    result: Result<T, AiUsageLockError<DashboardError>>,
) -> Result<T, DashboardError> {
    match result {
        Ok(value) => Ok(value),
        Err(AiUsageLockError::Callback(error)) => Err(error),
        Err(error) => Err(DashboardError::Lock(error.to_string())),
    }
}

#[derive(Clone)]
pub struct MongoAiUsageDashboards {
    dashboards: Collection<Document>,
    receipts: Collection<Document>,
    reads: MongoAiUsageLedgerReads,
    lock: AiUsageLock,
}

impl MongoAiUsageDashboards {
    /// Clones the caller's handles. Does not ping MongoDB, open Redis, or
    /// install indexes.
    pub fn new(database: &Database, cache: ConnectionManager) -> Self {
        Self {
            dashboards: crate::schemas::ai_usage_dashboard::schema().native_collection(database),
            receipts: crate::schemas::ai_usage_receipt::schema().native_collection(database),
            reads: MongoAiUsageLedgerReads::new(database),
            lock: AiUsageLock::new(cache),
        }
    }

    pub async fn get_ai_usage_dashboard(
        &self,
        input: &DashboardReadInput,
    ) -> Result<AiUsageDashboard, DashboardError> {
        self.get_at(input, current_js_date()).await
    }

    pub async fn get_at(
        &self,
        input: &DashboardReadInput,
        now: JsDate,
    ) -> Result<AiUsageDashboard, DashboardError> {
        let request_json = dashboard_request_json(input)?;
        let request = dashboard_request_from_json(&request_json)?;
        let key = dashboard_cache_key(&request_json);
        let now_ms = now.timestamp_millis().ok_or_else(invalid_time)?;
        let existing = self
            .dashboards
            .clone()
            .find_one(doc! {"key": &key})
            .await?;
        if let Some(existing) = existing.as_ref()
            && dashboard_row_is_fresh(existing, now_ms as f64)?
        {
            let data = match existing.get("data") {
                Some(Bson::Document(data)) => decode_computed(data)?,
                _ => return Err(malformed()),
            };
            let refreshed_at = JsDate::from_millis(
                bson_date_millis(existing.get("refreshedAt"), "refreshedAt")?,
            )
            .to_iso_string()
            .map_err(|_| invalid_time())?;
            return Ok(AiUsageDashboard {
                summary: data.summary,
                history: data.history,
                refreshed_at,
                cached: true,
            });
        }
        let dashboards = self.dashboards.clone();
        let receipts = self.receipts.clone();
        let reads = self.reads.clone();
        let channel_id = input.channel_id.clone();
        let customer_id = input.customer_id.clone();
        let plan_tier = request.plan_tier.clone();
        map_lock(
            self.lock
                .with(&channel_id, &customer_id, move || async move {
                    // The source samples a second `new Date()` inside compute.
                    let data = compute_dashboard(&receipts, &reads, &request, None).await?;
                    let refreshed_at = now
                        .to_iso_string()
                        .map_err(|_| invalid_time())?;
                    let expires_at = now_ms.checked_add(DAY_MS).ok_or_else(invalid_time)?;
                    let request_bson = match json_to_bson(&request_json) {
                        Bson::Document(document) => document,
                        _ => Document::new(),
                    };
                    dashboards
                        .update_one(
                            doc! {"key": &key},
                            doc! {
                                "$set": {
                                    "channelID": channel_id.to_utf8_lossy(),
                                    "customerId": customer_id.to_utf8_lossy(),
                                    "planTier": &plan_tier,
                                    "key": &key,
                                    "request": request_bson,
                                    "data": computed_document(&data),
                                    "dirty": false,
                                    "refreshedAt": DateTime::from_millis(now_ms),
                                    "expiresAt": DateTime::from_millis(expires_at),
                                },
                                "$setOnInsert": {"__v": 0},
                            },
                        )
                        .upsert(true)
                        .await?;
                    Ok(AiUsageDashboard {
                        summary: data.summary,
                        history: data.history,
                        refreshed_at,
                        cached: false,
                    })
                })
                .await,
        )
    }

    /// `refreshAiUsageDashboards`. `limit == None` is the source default of 20.
    /// The first lock or compute error aborts the loop.
    pub async fn refresh_ai_usage_dashboards(
        &self,
        limit: Option<i64>,
    ) -> Result<usize, DashboardError> {
        let now = current_js_date();
        let now_ms = now.timestamp_millis().ok_or_else(invalid_time)?;
        let cutoff = now_ms.checked_sub(60_000).ok_or_else(invalid_time)?;
        let mut filter = doc! { "expiresAt": {"$gt": DateTime::from_millis(now_ms)} };
        filter.insert(
            "$or",
            Bson::Array(vec![
                Bson::Document(doc! {"dirty": true}),
                Bson::Document(doc! {"refreshedAt": {"$lte": DateTime::from_millis(cutoff)}}),
            ]),
        );
        let documents: Vec<Document> = self
            .dashboards
            .clone()
            .find(filter)
            .sort(doc! {"refreshedAt": 1})
            .limit(limit.unwrap_or(20))
            .await?
            .try_collect()
            .await?;
        for document in &documents {
            let id = document.get("_id").cloned().ok_or_else(malformed)?;
            let channel = match document.get("channelID") {
                Some(Bson::String(value)) => JsString::from(value.as_str()),
                _ => return Err(malformed()),
            };
            let customer = match document.get("customerId") {
                Some(Bson::String(value)) => JsString::from(value.as_str()),
                _ => return Err(malformed()),
            };
            let request = match document.get("request") {
                Some(request) => dashboard_request_from_json(&bson_to_json(request)?)?,
                None => return Err(malformed()),
            };
            let dashboards = self.dashboards.clone();
            let receipts = self.receipts.clone();
            let reads = self.reads.clone();
            map_lock(
                self.lock
                    .with(&channel, &customer, move || async move {
                        let data = compute_dashboard(&receipts, &reads, &request, None).await?;
                        let stamped = current_js_date()
                            .timestamp_millis()
                            .ok_or_else(invalid_time)?;
                        dashboards
                            .update_one(
                                doc! {"_id": id},
                                doc! {"$set": {
                                    "data": computed_document(&data),
                                    "dirty": false,
                                    "refreshedAt": DateTime::from_millis(stamped),
                                }},
                            )
                            .await?;
                        Ok(())
                    })
                    .await,
            )?;
        }
        Ok(documents.len())
    }
}
