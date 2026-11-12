//! Per-event session recorders from `utils/stream_analytics.ts`.
//!
//! Callers supply a model-backed Mongo store and clock; initialize model indexes before use.
//! Bits, subscriptions and follows use the existing event-time projection, including durable
//! receipts and MissingPrerequisite outcomes. Donations, messages and commands intentionally
//! have no receipt: retries increment again. Message counters precede participant/activity
//! writes; cancellation between them can lose capture or double-count a retried message.
//! The reference suppresses errors for those three best-effort recorders; Rust exposes them
//! for caller telemetry (callers must not turn these errors into durable-event retries).
//! Every store operation has the shared five-second deadline. No timer or environment reads.
use crate::{
    Error,
    stream_activity::{
        Activities, ActivityKind, Capture, Config, Fragment, Session, extract_timeline_emotes,
    },
    stream_session_event_projection::{MetricField, MetricInput, SessionMetrics},
    stream_timeline::{Participant, Timeline},
    timeline_store::Store,
};
use bson::{DateTime, doc};
use dima_events::consumer::handler::Outcome;
use dima_model::stream_sessions::INFO;
use serde::Deserialize;
use std::sync::Arc;

/// Event-time metric input. Missing quantities use each recorder's reference default.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MetricEvent {
    #[serde(rename = "channelID")]
    pub channel_id: String,
    pub quantity: Option<f64>,
    pub occurred_at: Option<String>,
    pub event_key: Option<String>,
}
/// A live-session count (commands, or the count portion of a message).
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CountEvent {
    #[serde(rename = "channelID")]
    pub channel_id: String,
    pub quantity: Option<f64>,
}
#[derive(Clone, Debug, Deserialize)]
pub struct ChatMessage {
    pub fragments: Vec<Fragment>,
}
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MessageEvent {
    #[serde(flatten)]
    pub count: CountEvent,
    #[serde(rename = "userID")]
    pub user_id: Option<String>,
    pub received_at: Option<i64>,
    #[serde(rename = "messageID")]
    pub message_id: Option<String>,
    pub actor_label: Option<String>,
    pub message: Option<ChatMessage>,
}
#[derive(Clone)]
pub struct StreamSessions {
    store: Store,
    metrics: SessionMetrics,
    timeline: Timeline,
    activity: Activities,
}
impl StreamSessions {
    pub fn new(
        mongo: dima_store::mongo::MongoStore,
        clock: Arc<dyn dima_core::Clock>,
    ) -> Result<Self, Error> {
        Ok(Self {
            store: Store::new(mongo.clone(), clock.clone()),
            metrics: SessionMetrics::new(mongo.clone(), clock.clone()),
            timeline: Timeline::new(mongo.clone(), clock.clone())?,
            activity: Activities::new(mongo, clock, Config::default())?,
        })
    }
    #[cfg(feature = "test-util")]
    pub fn with_write_hook(
        mut self,
        hook: Arc<dyn Fn() -> futures_util::future::BoxFuture<'static, ()> + Send + Sync>,
    ) -> Self {
        self.store.hook = Some(hook.clone());
        self.metrics = self.metrics.with_write_hook(hook.clone());
        self.timeline = self.timeline.with_write_hook(hook.clone());
        self.activity = self.activity.with_write_hook(hook);
        self
    }
    async fn metric(
        &self,
        input: &MetricEvent,
        field: MetricField,
        quantity: f64,
    ) -> Result<(), Outcome> {
        let channel = dima_text::trim(&input.channel_id);
        if channel.is_empty() || quantity <= 0.0 {
            return Ok(());
        }
        self.metrics
            .increment_session_metric_at_event_time(&MetricInput {
                channel_id: channel.into(),
                occurred_at: input.occurred_at.clone(),
                event_key: input.event_key.clone(),
                field,
                quantity,
            })
            .await
            .map(|_| ())
    }
    /// `quantity` is the reference's `bits` field; missing/nonfinite bits become zero.
    pub async fn record_stream_bits_event(&self, input: &MetricEvent) -> Result<(), Outcome> {
        self.metric(
            input,
            MetricField::Bits,
            positive_integer(input.quantity, 0.0),
        )
        .await
    }
    /// Tier does not affect the stored count; callers may log unknown tiers separately.
    pub async fn record_stream_sub_event(&self, input: &MetricEvent) -> Result<(), Outcome> {
        self.metric(
            input,
            MetricField::Subs,
            positive_integer(input.quantity, 1.0).max(1.0),
        )
        .await
    }
    pub async fn record_stream_follow_event(&self, input: &MetricEvent) -> Result<(), Outcome> {
        self.metric(input, MetricField::Follows, 1.0).await
    }
    pub async fn record_stream_donation_event(
        &self,
        channel_id: &str,
        amount: Option<f64>,
    ) -> Result<(), Error> {
        let channel = dima_text::trim(channel_id);
        let amount = amount.unwrap_or(0.0);
        if channel.is_empty() || !amount.is_finite() || amount <= 0.0 {
            return Ok(());
        }
        self.store
            .update(
                &INFO,
                live(channel),
                doc! {"$inc":{"donations":amount}},
                false,
            )
            .await?;
        Ok(())
    }
    pub async fn record_stream_command_event(&self, input: &CountEvent) -> Result<(), Error> {
        let channel = dima_text::trim(&input.channel_id);
        if channel.is_empty() {
            return Ok(());
        }
        self.store
            .update(
                &INFO,
                live(channel),
                doc! {"$inc":{"commands":positive_integer(input.quantity,1.0).max(1.0)}},
                false,
            )
            .await?;
        Ok(())
    }
    pub async fn record_stream_message_event(&self, input: &MessageEvent) -> Result<(), Error> {
        let channel = dima_text::trim(&input.count.channel_id);
        if channel.is_empty() {
            return Ok(());
        }
        // No sort: the reference selects the first live session in natural order.
        let row = self
            .store
            .modify(
                &INFO,
                live(channel),
                doc! {"$inc":{"messages":positive_integer(input.count.quantity,1.0).max(1.0)}},
                doc! {},
                false,
            )
            .await?;
        let Some(row) = row else {
            return Ok(());
        };
        let session: Session =
            bson::deserialize_from_document(row).map_err(|e| Error::Invalid(e.to_string()))?;
        let at = DateTime::from_millis(
            input
                .received_at
                .filter(|v| *v != 0)
                .unwrap_or_else(|| self.store.clock.now_ms()),
        );
        let user = input.user_id.as_deref().unwrap_or_default();
        let message_id = input.message_id.as_deref().unwrap_or_default();
        if !user.is_empty() && message_id.is_empty() {
            self.timeline
                .record_timeline_participant(&Participant {
                    channel_id: channel.into(),
                    session_id: session.id,
                    started_at: session.started_at,
                    user_id: user.into(),
                    at,
                })
                .await?;
        }
        if let Some(message) = &input.message
            && !message_id.is_empty()
        {
            self.activity
                .capture_stream_activity(&Capture {
                    channel_id: channel.into(),
                    event_id: message_id.into(),
                    kind: ActivityKind::Message,
                    occurred_at: Some(at),
                    session: Some(session),
                    actor: user.into(),
                    actor_label: input.actor_label.clone().unwrap_or_default(),
                    key: String::new(),
                    label: String::new(),
                    value: None,
                    outcome: None,
                    emotes: extract_timeline_emotes(&message.fragments),
                })
                .await?;
        }
        Ok(())
    }
}
fn live(channel: &str) -> bson::Document {
    doc! {"channelID":channel,"status":"live","ended_at":bson::Bson::Null}
}
fn positive_integer(value: Option<f64>, fallback: f64) -> f64 {
    value
        .filter(|v| v.is_finite())
        .map(|v| v.round().max(0.0))
        .unwrap_or(fallback)
}
