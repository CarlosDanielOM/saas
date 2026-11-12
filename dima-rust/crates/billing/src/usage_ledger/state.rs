//! How far back a channel's ledger is complete (`ai_usage_ledger_states`):
//! `getAiUsageLedgerState` and `getAiUsageLedgerStatus` of `utils/ai_usage_ledger.ts`.

use super::report::iso;
use super::{Ledger, LedgerError, REPORT_VERSION, ops};
use bson::{Bson, Document, doc};
use dima_model::ai_usage_ledger_states;
use serde_json::{Map, Value};

/// A channel's ledger state.
#[derive(Clone, Debug, PartialEq)]
pub struct LedgerState {
    /// `coverageStart` (ms): receipts are complete from here.
    pub coverage_start_ms: i64,
    /// `backfilledAt` (ms; `None` when the stored document lacks it).
    pub backfilled_at_ms: Option<i64>,
    /// `reportVersion || 0`.
    pub report_version: f64,
}

/// `AiUsageLedgerStatus`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LedgerStatus {
    /// `status === 'ready'`.
    pub ready: bool,
    /// `coverageStart` (ISO).
    pub coverage_start: Option<String>,
    /// `lastSyncedAt` (ISO).
    pub last_synced_at: Option<String>,
    /// `requestedCoverageStart` (ISO).
    pub requested_coverage_start: String,
}

impl LedgerStatus {
    /// `{status, coverageStart, lastSyncedAt, requestedCoverageStart}`.
    pub fn to_json(&self) -> Value {
        let mut map = Map::new();
        map.insert(
            "status".into(),
            Value::from(if self.ready { "ready" } else { "pending" }),
        );
        let text = |value: &Option<String>| value.as_deref().map_or(Value::Null, Value::from);
        map.insert("coverageStart".into(), text(&self.coverage_start));
        map.insert("lastSyncedAt".into(), text(&self.last_synced_at));
        map.insert(
            "requestedCoverageStart".into(),
            Value::from(self.requested_coverage_start.as_str()),
        );
        Value::Object(map)
    }
}

fn number(document: &Document, key: &str) -> f64 {
    match document.get(key) {
        Some(Bson::Int32(n)) => f64::from(*n),
        #[allow(clippy::cast_precision_loss)]
        Some(Bson::Int64(n)) => *n as f64,
        Some(Bson::Double(n)) => *n,
        _ => 0.0,
    }
}

impl Ledger<'_> {
    /// `getAiUsageLedgerState({channelID, customerId})`. A stored state without a
    /// `coverageStart` date is [`LedgerError::Malformed`] (the reference throws reading it).
    pub async fn ledger_state(
        &self,
        channel_id: &str,
        customer_id: &str,
    ) -> Result<Option<LedgerState>, LedgerError> {
        let found = ops::find_one(
            self,
            ai_usage_ledger_states::COLLECTION,
            doc! { "channelID": channel_id, "customerId": customer_id },
            Some(doc! { "coverageStart": 1, "backfilledAt": 1, "reportVersion": 1 }),
        )
        .await?;
        let Some(found) = found else {
            return Ok(None);
        };
        let coverage = found
            .get_datetime("coverageStart")
            .map_err(|_| LedgerError::Malformed("ledger state coverageStart"))?
            .timestamp_millis();
        let report = number(&found, "reportVersion");
        Ok(Some(LedgerState {
            coverage_start_ms: coverage,
            backfilled_at_ms: found
                .get_datetime("backfilledAt")
                .ok()
                .map(|d| d.timestamp_millis()),
            report_version: if report.is_nan() { 0.0 } else { report },
        }))
    }

    /// `getAiUsageLedgerStatus({channelID, customerId, startsAt})`: ready when the coverage
    /// starts at or before `starts_at` and the report version is current.
    pub async fn ledger_status(
        &self,
        channel_id: &str,
        customer_id: &str,
        starts_at_ms: i64,
    ) -> Result<LedgerStatus, LedgerError> {
        let state = self.ledger_state(channel_id, customer_id).await?;
        #[allow(clippy::cast_precision_loss)]
        let ready = state.as_ref().is_some_and(|s| {
            s.coverage_start_ms <= starts_at_ms && s.report_version >= REPORT_VERSION as f64
        });
        Ok(LedgerStatus {
            ready,
            coverage_start: state.as_ref().map(|s| iso(s.coverage_start_ms)),
            last_synced_at: state.and_then(|s| s.backfilled_at_ms).map(iso),
            requested_coverage_start: iso(starts_at_ms),
        })
    }
}
