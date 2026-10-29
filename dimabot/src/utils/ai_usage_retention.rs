//! Explicit-database adapter for `adjustAiUsageRetention`.
//!
//! Construction performs no I/O. Dropping the returned future after a write
//! starts may leave that write's outcome unknown; callers must not retry it
//! blindly. The two final deletes are spawned independently, so an error or
//! cancellation does not cancel a sibling already launched.
use std::sync::Arc;

use mongodb::{
    Database,
    bson::{Bson, DateTime, Document, doc},
};

use crate::{
    schemas::{ai_usage_daily, ai_usage_dashboard, ai_usage_ledger_state, ai_usage_receipt},
    utils::{
        ai_usage_receipt_parser::RetentionTier, credit_policy::JsDate, js_string::JsString,
        lossless_json::JsonValue,
    },
};

const DAY: i64 = 86_400_000;

/// Each invocation models a JavaScript Date construction by application or
/// Mongoose middleware. A fixture may supply an ordered clock sequence.
pub type Clock = Arc<dyn Fn() -> i64 + Send + Sync + 'static>;

#[derive(Debug)]
pub enum RetentionError {
    Mongo(mongodb::error::Error),
    InvalidDate { path: &'static str },
    DeleteTask(tokio::task::JoinError),
}
impl std::fmt::Display for RetentionError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Mongo(e) => write!(f, "{e}"),
            Self::InvalidDate { path } => write!(f, "invalid JavaScript Date for {path}"),
            Self::DeleteTask(e) => write!(f, "retention delete task failed: {e}"),
        }
    }
}
impl std::error::Error for RetentionError {}
impl From<mongodb::error::Error> for RetentionError {
    fn from(value: mongodb::error::Error) -> Self {
        Self::Mongo(value)
    }
}

#[derive(Clone)]
pub struct AiUsageRetention {
    database: Database,
    clock: Clock,
}
impl AiUsageRetention {
    pub fn new(database: Database) -> Self {
        Self::with_clock(database, Arc::new(|| DateTime::now().timestamp_millis()))
    }
    pub fn with_clock(database: Database, clock: Clock) -> Self {
        Self { database, clock }
    }

    pub async fn adjust(
        &self,
        channel_ids: &[JsString],
        plan_tier: &JsonValue,
    ) -> Result<(), RetentionError> {
        if channel_ids.is_empty() {
            return Ok(());
        }
        let tier = RetentionTier::from_value(plan_tier);
        // BSON's UTF-8 encoder replaces unpaired JS UTF-16 surrogates.
        let ids: Vec<Bson> = channel_ids
            .iter()
            .map(|id| Bson::String(id.to_utf8_lossy()))
            .collect();
        let filter = doc! {"channelID": {"$in": ids}};
        let now = JsDate::from_millis((self.clock)() as f64).timestamp_millis();
        let dashboard = ai_usage_dashboard::schema().native_collection(&self.database);
        let state = ai_usage_ledger_state::schema().native_collection(&self.database);
        let receipt = ai_usage_receipt::schema().native_collection(&self.database);
        let daily = ai_usage_daily::schema().native_collection(&self.database);
        dashboard.delete_many(filter.clone()).await?;
        let state_time = JsDate::from_millis((self.clock)() as f64).timestamp_millis();
        // Mongoose's state update casts every Date after timestamp middleware.
        // Its reverse traversal casts $setOnInsert before $set and $max.
        let state_time = state_time.ok_or(RetentionError::InvalidDate { path: "created_at" })?;
        let coverage = now
            .and_then(|ms| ms.checked_sub(tier.days() * DAY))
            .and_then(|ms| JsDate::from_millis(ms as f64).timestamp_millis())
            .ok_or(RetentionError::InvalidDate {
                path: "coverageStart",
            })?;
        state
            .update_many(
                filter.clone(),
                doc! {
                    "$setOnInsert": {"created_at": DateTime::from_millis(state_time)},
                    "$set": {"updated_at": DateTime::from_millis(state_time)},
                    "$max": {"coverageStart": DateTime::from_millis(coverage)},
                },
            )
            .await?;
        let receipt_time = (self.clock)();
        receipt
            .update_many(
                filter.clone(),
                pipeline(tier, "$occurredAt", tier.days(), receipt_time),
            )
            .await?;
        let daily_time = (self.clock)();
        daily
            .update_many(
                filter.clone(),
                pipeline(tier, "$dayStart", tier.days() + 1, daily_time),
            )
            .await?;
        let mut expired = filter;
        // A successful state cast proves `now` is valid.
        expired.insert(
            "expiresAt",
            doc! {"$lte": DateTime::from_millis(now.expect("valid coverage requires valid now"))},
        );
        let receipt_filter = expired.clone();
        let mut a =
            tokio::spawn(async move { receipt.delete_many(receipt_filter).await.map(|_| ()) });
        let mut b = tokio::spawn(async move { daily.delete_many(expired).await.map(|_| ()) });
        // Promise.all rejects on first failure while the other promise continues.
        tokio::select! {
            result = &mut a => { flatten(result)?; flatten(b.await)?; }
            result = &mut b => { flatten(result)?; flatten(a.await)?; }
        }
        Ok(())
    }
}
fn flatten(
    result: Result<Result<(), mongodb::error::Error>, tokio::task::JoinError>,
) -> Result<(), RetentionError> {
    result
        .map_err(RetentionError::DeleteTask)?
        .map_err(RetentionError::Mongo)
}
fn pipeline(tier: RetentionTier, field: &str, days: i64, timestamp: i64) -> Vec<Document> {
    // Pipelines bypass schema Date casting. BSON's JS serializer converts an
    // invalid Date (NaN) through Long.fromNumber, producing epoch zero.
    let timestamp = JsDate::from_millis(timestamp as f64)
        .timestamp_millis()
        .unwrap_or(0);
    vec![
        doc! {"$set": {"retentionTier": tier.as_str(), "expiresAt": {"$dateAdd": {"startDate": field, "unit": "day", "amount": days as i32}}}},
        doc! {"$set": {"updated_at": DateTime::from_millis(timestamp)}},
    ]
}
