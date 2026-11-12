//! Session counters at event time, including durable per-event receipts. The newest session
//! is pinned before a keyed write; a receipt remains valid after lifecycle bounds change.
//! Missing keyed sessions return the events consumer's MissingPrerequisite outcome. Unkeyed
//! callers intentionally get false for offline windows. Five-second store deadlines.
use crate::timeline_store::{Store, window};
use bson::{DateTime, doc};
use dima_events::consumer::handler::Outcome;
use dima_model::stream_sessions::INFO;
use serde::{Deserialize, Serialize};
use std::sync::Arc;
#[derive(Clone, Copy, Debug, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum MetricField {
    Bits,
    Subs,
    Follows,
}
impl MetricField {
    fn name(self) -> &'static str {
        match self {
            Self::Bits => "bits",
            Self::Subs => "subs",
            Self::Follows => "follows",
        }
    }
}
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MetricInput {
    #[serde(rename = "channelID")]
    pub channel_id: String,
    pub occurred_at: Option<String>,
    pub event_key: Option<String>,
    pub field: MetricField,
    pub quantity: f64,
}
#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(untagged)]
pub enum MetricResult {
    Receipt(&'static str),
    Legacy(bool),
}
#[derive(Clone)]
pub struct SessionMetrics {
    store: Store,
}
impl SessionMetrics {
    pub fn new(mongo: dima_store::mongo::MongoStore, clock: Arc<dyn dima_core::Clock>) -> Self {
        Self {
            store: Store::new(mongo, clock),
        }
    }
    #[cfg(feature = "test-util")]
    pub fn with_write_hook(
        mut self,
        hook: Arc<dyn Fn() -> futures_util::future::BoxFuture<'static, ()> + Send + Sync>,
    ) -> Self {
        self.store.hook = Some(hook);
        self
    }
    pub async fn increment_session_metric_at_event_time(
        &self,
        input: &MetricInput,
    ) -> Result<MetricResult, Outcome> {
        let at = self.at(input);
        self.apply(input, at)
            .await
            .map_err(|e| Outcome::Failed(e.to_string()))?
            .ok_or_else(|| {
                Outcome::MissingPrerequisite(format!(
                    "metric-session:{}:{}",
                    input.channel_id,
                    dima_text::to_iso_string(at.timestamp_millis()).unwrap_or_default()
                ))
            })
    }
    fn at(&self, input: &MetricInput) -> DateTime {
        DateTime::from_millis(
            input
                .occurred_at
                .as_deref()
                .and_then(dima_text::parse_date)
                .unwrap_or_else(|| self.store.clock.now_ms()),
        )
    }
    async fn receipt(&self, channel: &str, key: &str) -> Result<bool, crate::Error> {
        Ok(!self
            .store
            .find(
                INFO.name,
                doc! {"channelID":channel,"applied_domain_event_keys":key},
                doc! {},
                1,
                0,
                1500,
            )
            .await?
            .is_empty())
    }
    async fn apply(
        &self,
        input: &MetricInput,
        at: DateTime,
    ) -> Result<Option<MetricResult>, crate::Error> {
        let mut filter = window(&input.channel_id, at, true);
        let key = input.event_key.as_deref().filter(|s| !s.is_empty());
        let mut inc = bson::Document::new();
        inc.insert(input.field.name(), input.quantity);
        let mut update = doc! {"$inc":inc};
        if let Some(key) = key {
            if self.receipt(&input.channel_id, key).await? {
                return Ok(Some(MetricResult::Receipt("already-applied")));
            }
            let target = self
                .store
                .find(
                    INFO.name,
                    filter.clone(),
                    doc! {"started_at":-1},
                    1,
                    0,
                    1500,
                )
                .await?;
            if let Some(id) = target.first().and_then(|d| d.get("_id")) {
                filter.insert("_id", id.clone());
            } else {
                return Ok(if self.receipt(&input.channel_id, key).await? {
                    Some(MetricResult::Receipt("already-applied"))
                } else {
                    None
                });
            }
            filter.insert("applied_domain_event_keys", doc! {"$ne":key});
            update.insert("$addToSet", doc! {"applied_domain_event_keys":key});
        }
        let result = self
            .store
            .modify(&INFO, filter, update, doc! {"started_at":-1}, key.is_some())
            .await?;
        if key.is_none() {
            return Ok(Some(MetricResult::Legacy(result.is_some())));
        }
        if result.is_some() {
            return Ok(Some(MetricResult::Receipt("applied")));
        }
        if self
            .receipt(&input.channel_id, key.unwrap_or_default())
            .await?
        {
            return Ok(Some(MetricResult::Receipt("already-applied")));
        }
        Ok(None)
    }
}
