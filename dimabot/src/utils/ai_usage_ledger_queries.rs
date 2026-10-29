//! Opt-in request-time ledger history and transaction reads. No constructor I/O,
//! writes, index installation, locks, polling, retries, or private worker reuse.
//!
//! Input String/Date declarations are represented by JsString/JsDate. Lean
//! output remains BSON, including missing versus null and malformed legacy
//! fields; the source's TypeScript annotations do not cast lean replies. BSON
//! Number and comparison-only String coercion reuse the state reader's shared
//! compatibility helpers, rather than introducing another JS interpreter.

use super::{
    ai_usage::{classify_adjustment, normalize_receipt_category},
    ai_usage_ledger_reads::{
        AiUsageLedgerReadError, AiUsageLedgerState, AiUsageLedgerStateInput, LedgerField,
        MongoAiUsageLedgerReads, array_coercion_value, date_method, ordinary_json, version_number,
    },
    ai_usage_receipt_parser::RetentionTier,
    credit_policy::JsDate,
    js_string::JsString,
    lossless_json::JsonValue,
    tts::settings,
};
use crate::schemas::{ai_usage_daily, ai_usage_receipt};
use futures_util::TryStreamExt;
use mongodb::{
    Collection, Database,
    bson::{Bson, DateTime, Document, doc},
};
use std::time::{SystemTime, UNIX_EPOCH};

const DAY: i64 = 86_400_000;

/// Equivalent of the source AiUsageWindow type-only import. Metadata is kept
/// losslessly, although this slice reads only the two Date boundaries.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AiUsageWindow {
    pub from: JsString,
    pub to: JsString,
    pub time_zone: JsString,
    pub start_timestamp: JsDate,
    pub end_timestamp_exclusive: JsDate,
    pub days: Vec<JsString>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct AiUsagePacingHistoryInput {
    pub channel_id: JsString,
    pub customer_id: JsString,
    pub plan_tier: JsonValue,
    /// Both absent and null source inputs are None; invalid Date is Some(invalid).
    pub account_created_at: Option<JsDate>,
    pub now: Option<JsDate>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AiUsageLedgerTransactionsInput {
    pub channel_id: JsString,
    pub customer_id: JsString,
    pub window: AiUsageWindow,
}

/// The four optional fields belong to the exported interface, but this source
/// function emits only its five mandatory fields. Avoid serde's nonfinite and
/// UTF-16 boundaries: as_value preserves binary64 and exact insertion order.
#[derive(Clone, Debug, PartialEq)]
pub struct AiUsagePacingHistory {
    pub active_day_count: Option<f64>,
    pub coefficient_of_variation: Option<f64>,
    pub recent_average_daily_credits: Option<f64>,
    pub recent_day_count: Option<f64>,
    pub average_daily_credits: f64,
    pub total_spent_credits: f64,
    pub day_count: f64,
    pub from: String,
    pub to: String,
}

impl AiUsagePacingHistory {
    pub fn as_value(&self) -> JsonValue {
        let mut fields = Vec::new();
        for (key, value) in [
            ("activeDayCount", self.active_day_count),
            ("coefficientOfVariation", self.coefficient_of_variation),
            (
                "recentAverageDailyCredits",
                self.recent_average_daily_credits,
            ),
            ("recentDayCount", self.recent_day_count),
        ] {
            if let Some(value) = value {
                fields.push((key.into(), JsonValue::Number(value)));
            }
        }
        fields.extend([
            (
                "averageDailyCredits".into(),
                JsonValue::Number(self.average_daily_credits),
            ),
            (
                "totalSpentCredits".into(),
                JsonValue::Number(self.total_spent_credits),
            ),
            ("dayCount".into(), JsonValue::Number(self.day_count)),
            ("from".into(), JsonValue::String(self.from.as_str().into())),
            ("to".into(), JsonValue::String(self.to.as_str().into())),
        ]);
        JsonValue::Object(fields)
    }
}

/// Runtime carrier for AiUsageTransaction, deliberately broader than its
/// declared TS type because lean performs no result casting. Exactly sixteen
/// own properties are present, even when a property's value is undefined.
#[derive(Clone, Debug, PartialEq)]
pub struct AiUsageTransaction {
    fields: [(&'static str, LedgerField); 16],
}

impl AiUsageTransaction {
    pub fn ordered_fields(&self) -> &[(&'static str, LedgerField); 16] {
        &self.fields
    }

    pub fn get(&self, name: &str) -> Option<&LedgerField> {
        self.fields
            .iter()
            .find(|(key, _)| *key == name)
            .map(|(_, value)| value)
    }
}

/// Explicit Date sampling also permits a fixed fixture clock. Sampling happens
/// on method execution, never in the adapter constructor.
pub fn current_js_date() -> JsDate {
    let millis = match SystemTime::now().duration_since(UNIX_EPOCH) {
        Ok(duration) => duration.as_millis() as f64,
        Err(error) => -(error.duration().as_millis() as f64),
    };
    JsDate::from_millis(millis)
}

#[derive(Clone, Debug, PartialEq)]
pub struct PacingHistoryPreparation {
    pub now: JsDate,
    pub history_start: JsDate,
    pub retention_days: i64,
    pub state_input: AiUsageLedgerStateInput,
}

/// UTC setUTCHours(0,0,0,0), followed by setUTCDate(day-(days-1)).
/// Each operation applies the existing Date TimeClip, including the minimum
/// Date boundary. An invalid retention floor cannot be rescued by an account.
pub fn prepare_pacing_history(
    input: &AiUsagePacingHistoryInput,
    sampled_now: JsDate,
) -> PacingHistoryPreparation {
    let now = input.now.unwrap_or(sampled_now);
    let retention_days = RetentionTier::from_value(&input.plan_tier).days();
    let midnight = now
        .timestamp_millis()
        .map(|value| value.div_euclid(DAY) * DAY);
    let retention_start = midnight
        .map(|value| JsDate::from_millis(value as f64))
        .and_then(JsDate::timestamp_millis)
        .map(|value| JsDate::from_millis((value - (retention_days - 1) * DAY) as f64))
        .unwrap_or(JsDate::invalid());
    let history_start = match (
        input.account_created_at.and_then(JsDate::timestamp_millis),
        retention_start.timestamp_millis(),
    ) {
        (Some(account), Some(floor)) if account > floor => JsDate::from_millis(account as f64),
        _ => retention_start,
    };
    PacingHistoryPreparation {
        now,
        history_start,
        retention_days,
        state_input: AiUsageLedgerStateInput {
            channel_id: input.channel_id.clone(),
            customer_id: input.customer_id.clone(),
        },
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct PacingHistoryQuery {
    pub pipeline: Vec<Document>,
    pub preparation: PacingHistoryPreparation,
    pub from: String,
    pub to: String,
}

/// Called only after the state read; absence short-circuits even invalid now.
/// Missing/malformed coverage throws before either ISO conversion. Invalid
/// Date coverage compares false, matching JS rather than enforcing a schema.
pub fn pacing_history_query(
    preparation: &PacingHistoryPreparation,
    state: Option<&AiUsageLedgerState>,
) -> Result<Option<PacingHistoryQuery>, AiUsageLedgerReadError> {
    let Some(state) = state else { return Ok(None) };
    let coverage = date_method(&state.coverage_start, "coverageStart", "getTime")?;
    if matches!((coverage.timestamp_millis(), preparation.history_start.timestamp_millis()),
        (Some(coverage), Some(start)) if coverage > start)
    {
        return Ok(None);
    }
    let from = preparation.history_start.to_iso_string().map_err(|_| {
        AiUsageLedgerReadError::RangeError {
            field: "historyStart",
        }
    })?;
    let to = preparation
        .now
        .to_iso_string()
        .map_err(|_| AiUsageLedgerReadError::RangeError { field: "now" })?;
    // Source slices exactly ten UTF-16 units, even for extended ISO years.
    // ISO is ASCII, so its byte slice has the same semantics.
    let from = from[..10].to_owned();
    let to = to[..10].to_owned();
    let pipeline = vec![
        doc! {"$match":{
            "channelID":preparation.state_input.channel_id.to_utf8_lossy(),
            "customerId":preparation.state_input.customer_id.to_utf8_lossy(),
            "date":{"$gte":from.clone(),"$lte":to.clone()},
            "expiresAt":{"$gt":DateTime::from_millis(preparation.now.timestamp_millis().expect("ISO checked"))}
        }},
        doc! {"$group":{"_id":Bson::Null,"totalSpentCredits":{"$sum":"$spentCredits"}}},
    ];
    Ok(Some(PacingHistoryQuery {
        pipeline,
        preparation: preparation.clone(),
        from,
        to,
    }))
}

fn truthy(value: &LedgerField) -> bool {
    value.as_bson().is_some_and(|value| {
        ordinary_json(value)
            .map(|value| settings::truthy(&value))
            .unwrap_or(true)
    })
}

pub fn decode_pacing_history(
    query: &PacingHistoryQuery,
    totals: &[Document],
) -> Result<AiUsagePacingHistory, AiUsageLedgerReadError> {
    let total = totals
        .first()
        .map(|row| LedgerField::from_document(row, "totalSpentCredits"))
        .unwrap_or(LedgerField::Undefined);
    let total = if truthy(&total) {
        version_number(total.as_bson().expect("truthy is defined"))?
    } else {
        0.0
    };
    // f64::max discards NaN; JS Math.max propagates it and chooses +0.
    let total = if total.is_nan() {
        // Match the pinned V8 Math.max result, including its NaN sign. Plain
        // Number(value) conversion retains the shared numeric helper's policy.
        f64::from_bits(0xfff8_0000_0000_0000)
    } else if total > 0.0 {
        total
    } else {
        0.0
    };
    let preparation = &query.preparation;
    let elapsed = (preparation.now.timestamp_millis().expect("ISO checked") as f64
        - preparation
            .history_start
            .timestamp_millis()
            .expect("ISO checked") as f64)
        / DAY as f64;
    let days = (preparation.retention_days as f64).min(elapsed.max(1.0));
    Ok(AiUsagePacingHistory {
        active_day_count: None,
        coefficient_of_variation: None,
        recent_average_daily_credits: None,
        recent_day_count: None,
        average_daily_credits: total / days,
        total_spent_credits: total,
        day_count: days,
        from: query.from.clone(),
        to: query.to.clone(),
    })
}

#[derive(Clone, Debug, PartialEq)]
pub struct LedgerTransactionsQuery {
    pub filter: Document,
    pub sort: Document,
}

pub fn ledger_transactions_query(
    input: &AiUsageLedgerTransactionsInput,
    now: JsDate,
) -> Result<LedgerTransactionsQuery, AiUsageLedgerReadError> {
    // Mongoose 8.24.2 cast.js visits keys and conditional keys in reverse.
    // expiresAt is checked first, then occurredAt.$lt before .$gte.
    let expiry = now
        .timestamp_millis()
        .ok_or(AiUsageLedgerReadError::CastError { path: "expiresAt" })?;
    let end = input
        .window
        .end_timestamp_exclusive
        .timestamp_millis()
        .ok_or(AiUsageLedgerReadError::CastError { path: "occurredAt" })?;
    let start = input
        .window
        .start_timestamp
        .timestamp_millis()
        .ok_or(AiUsageLedgerReadError::CastError { path: "occurredAt" })?;
    Ok(LedgerTransactionsQuery {
        filter: doc! {
            "channelID":input.channel_id.to_utf8_lossy(),"customerId":input.customer_id.to_utf8_lossy(),
            "occurredAt":{"$gte":DateTime::from_millis(start),"$lt":DateTime::from_millis(end)},
            "expiresAt":{"$gt":DateTime::from_millis(expiry)}
        },
        sort: doc! {"occurredAt":-1,"entryId":-1},
    })
}

fn primitive_string(value: &LedgerField) -> Option<&str> {
    match value.as_bson() {
        Some(Bson::String(value) | Bson::Symbol(value)) => Some(value),
        _ => None,
    }
}

fn safe_category(value: &LedgerField) -> &'static str {
    normalize_receipt_category(primitive_string(value))
}

fn adjustment(document: &Document) -> Result<LedgerField, AiUsageLedgerReadError> {
    let explicit = LedgerField::from_document(document, "adjustmentType");
    if truthy(&explicit) {
        return Ok(explicit);
    }
    let kind = LedgerField::from_document(document, "entryKind");
    if primitive_string(&kind) != Some("adjustment") {
        return Ok(LedgerField::Value(Bson::Null));
    }
    let mut projection = serde_json::json!({"entryKind":"adjustment"});
    for key in ["source", "operation"] {
        let field = LedgerField::from_document(document, key);
        let value = if truthy(&field) {
            // Shared projection supports ordinary JSON method-shadow errors
            // and BSON wrappers. Date/RegExp markers are comparison-only:
            // their true strings cannot equal any classifier's ASCII tokens.
            settings::js_string(&array_coercion_value(field.as_bson().expect("truthy"))?)
                .map_err(AiUsageLedgerReadError::CoercionTypeError)?
        } else {
            "".into()
        };
        projection[key] = value.as_str().unwrap_or("").into();
    }
    if let Some(reason) = primitive_string(&LedgerField::from_document(document, "reason")) {
        projection["reason"] = reason.into();
    }
    Ok(LedgerField::Value(
        classify_adjustment(&projection).map_or(Bson::Null, |v| v.into()),
    ))
}

pub fn decode_ledger_transaction(
    document: &Document,
) -> Result<AiUsageTransaction, AiUsageLedgerReadError> {
    let field = |name| LedgerField::from_document(document, name);
    // ISO conversion precedes category and classifier evaluation, as in the
    // source object literal. A non-Date has TypeError, invalid Date RangeError.
    let occurred = date_method(&field("occurredAt"), "occurredAt", "toISOString")?
        .to_iso_string()
        .map_err(|_| AiUsageLedgerReadError::RangeError {
            field: "occurredAt",
        })?;
    let category = safe_category(&field("category"));
    let source = field("source");
    let source = if truthy(&source) {
        source
    } else {
        LedgerField::Value(Bson::Null)
    };
    let adjustment = adjustment(document)?;
    Ok(AiUsageTransaction {
        fields: [
            ("id", field("entryId")),
            ("requestId", field("requestId")),
            ("occurredAt", LedgerField::Value(occurred.into())),
            ("entryKind", field("entryKind")),
            ("category", LedgerField::Value(category.into())),
            ("operation", field("operation")),
            ("source", source),
            ("adjustmentType", adjustment),
            ("provider", field("provider")),
            ("model", field("model")),
            ("quantity", field("quantity")),
            ("unit", field("unit")),
            ("credits", field("credits")),
            ("resourceType", field("resourceType")),
            ("resourceId", field("resourceId")),
            ("itemized", field("itemized")),
        ],
    })
}

pub fn decode_ledger_transactions(
    documents: &[Document],
) -> Result<Vec<AiUsageTransaction>, AiUsageLedgerReadError> {
    documents.iter().map(decode_ledger_transaction).collect()
}

#[derive(Clone, Debug)]
pub struct MongoAiUsageLedgerQueries {
    state: MongoAiUsageLedgerReads,
    daily: Collection<Document>,
    receipts: Collection<Document>,
}

impl MongoAiUsageLedgerQueries {
    pub fn new(database: &Database) -> Self {
        Self {
            state: MongoAiUsageLedgerReads::new(database),
            daily: ai_usage_daily::schema().native_collection(database),
            receipts: ai_usage_receipt::schema().native_collection(database),
        }
    }
    pub fn state_reads(&self) -> &MongoAiUsageLedgerReads {
        &self.state
    }
    pub fn daily_collection(&self) -> &Collection<Document> {
        &self.daily
    }
    pub fn receipt_collection(&self) -> &Collection<Document> {
        &self.receipts
    }

    pub async fn load_ai_usage_pacing_history(
        &self,
        input: &AiUsagePacingHistoryInput,
    ) -> Result<Option<AiUsagePacingHistory>, AiUsageLedgerReadError> {
        let now = input.now.unwrap_or_else(current_js_date);
        self.load_ai_usage_pacing_history_at(input, now).await
    }

    pub async fn load_ai_usage_pacing_history_at(
        &self,
        input: &AiUsagePacingHistoryInput,
        sampled_now: JsDate,
    ) -> Result<Option<AiUsagePacingHistory>, AiUsageLedgerReadError> {
        let preparation = prepare_pacing_history(input, sampled_now);
        let state = self
            .state
            .get_ai_usage_ledger_state(&preparation.state_input)
            .await?;
        let Some(query) = pacing_history_query(&preparation, state.as_ref())? else {
            return Ok(None);
        };
        let totals: Vec<Document> = self
            .daily
            .aggregate(query.pipeline.clone())
            .await?
            .try_collect()
            .await?;
        decode_pacing_history(&query, &totals).map(Some)
    }

    pub async fn load_ai_usage_ledger_transactions(
        &self,
        input: &AiUsageLedgerTransactionsInput,
    ) -> Result<Vec<AiUsageTransaction>, AiUsageLedgerReadError> {
        self.load_ai_usage_ledger_transactions_at(input, current_js_date())
            .await
    }

    pub async fn load_ai_usage_ledger_transactions_at(
        &self,
        input: &AiUsageLedgerTransactionsInput,
        now: JsDate,
    ) -> Result<Vec<AiUsageTransaction>, AiUsageLedgerReadError> {
        let query = ledger_transactions_query(input, now)?;
        // Source awaits exec() (all documents) before docs.map. Collect first
        // so a cursor/read error wins over an earlier malformed mapping row.
        let documents: Vec<Document> = self
            .receipts
            .find(query.filter)
            .sort(query.sort)
            .await?
            .try_collect()
            .await?;
        decode_ledger_transactions(&documents)
    }
}
