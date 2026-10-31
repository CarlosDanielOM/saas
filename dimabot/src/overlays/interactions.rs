//! Interaction recovery decisions from `interactions.ts`.
//! The shared domain interaction parser and reducer own aggregate semantics;
//! recovery never enables subscriptions and ignores unsupported Helix phases.

use crate::domain_event_contracts::interaction::{InteractionKind, InteractionState, InteractionSnapshot, parse_interaction, reduce_interaction};
use mongodb::{Database, bson::{doc, Bson, Document, deserialize_from_document, serialize_to_document}};
use std::{collections::BTreeMap, fmt, sync::{Arc, Mutex}, time::Duration};
use tokio::sync::OnceCell;
use crate::utils::{credit_policy::JsDate, js_date, links::get_twitch_helix_url, twitch_headers::TwitchHeaders};
/// MongoDB collection containing sanitized interaction aggregates.
pub const INTERACTION_COLLECTION: &str = "overlay_interactions";
/// Interaction persistence failure.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct InteractionError { /// Public diagnostic.
    pub message: String }
impl fmt::Display for InteractionError { fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result { f.write_str(&self.message) } }
impl std::error::Error for InteractionError {}
fn error(value: impl fmt::Display) -> InteractionError { InteractionError { message: value.to_string() } }
fn key(channel: &str, kind: InteractionKind) -> String {
    format!("{channel}:{}", match kind { InteractionKind::Poll => "poll", InteractionKind::Prediction => "prediction" })
}
/// Concrete Mongo adapter, constructed without connecting.
#[derive(Clone)]
pub struct MongoInteractions { database: Database }
impl MongoInteractions {
    /// Construct with the application-owned database.
    pub fn new(database: Database) -> Self { Self { database } }
    /// Save an aggregate using the source's bounded optimistic-retry protocol.
    pub async fn save_interaction(&self, channel: &str, incoming: InteractionState) -> Result<(), InteractionError> {
        let collection = self.database.collection::<Document>(INTERACTION_COLLECTION);
        let id = key(channel, incoming.kind);
        for _ in 0..12 {
            let old = collection.find_one(doc! { "_id": &id }).await.map_err(error)?;
            let current = match &old {
                Some(document) => Some(deserialize_from_document::<InteractionState>(document.get_document("state").map_err(error)?.clone()).map_err(error)?),
                None => None,
            };
            let Some(state) = reduce_interaction(current.as_ref(), incoming.clone()) else { return Ok(()) };
            let serialized = serialize_to_document(&state).map_err(error)?;
            match old {
                None => match collection.insert_one(doc! { "_id": &id, "revision": state.revision, "state": serialized }).await {
                    Ok(_) => return Ok(()),
                    Err(error_value) if matches!(error_value.kind.as_ref(), mongodb::error::ErrorKind::Write(mongodb::error::WriteFailure::WriteError(write)) if write.code == 11000) => continue,
                    Err(error_value) => return Err(error(error_value)),
                },
                Some(document) => {
                    let old_revision = document.get("revision").cloned().unwrap_or(Bson::Null);
                    let updated = collection.update_one(doc! { "_id": &id, "revision": old_revision }, doc! { "$set": { "state": serialized, "revision": state.revision } }).await.map_err(error)?;
                    if updated.modified_count > 0 { return Ok(()); }
                }
            }
        }
        Err(error("Concurrent interaction update; retry delivery"))
    }
    /// Read the two public aggregate documents at one supplied server time.
    pub async fn interaction_snapshot(&self, channel: &str, now_ms: f64) -> Result<InteractionSnapshot, InteractionError> {
        let collection = self.database.collection::<Document>(INTERACTION_COLLECTION);
        let mut result = InteractionSnapshot { poll: None, prediction: None, server_time: now_ms };
        for kind in [InteractionKind::Poll, InteractionKind::Prediction] {
            if let Some(document) = collection.find_one(doc! { "_id": key(channel, kind) }).await.map_err(error)? {
                let state = deserialize_from_document::<InteractionState>(document.get_document("state").map_err(error)?.clone()).map_err(error)?;
                match state.kind { InteractionKind::Poll => result.poll = Some(state), InteractionKind::Prediction => result.prediction = Some(state) }
            }
        }
        Ok(result)
    }
    /// Apply a journaled Twitch interaction using the shared parser and reducer.
    pub async fn apply_interaction_event(&self, event: &crate::domain_event_contracts::types::DomainEventEnvelope) -> Result<(), InteractionError> {
        if event.get("source").and_then(serde_json::Value::as_str) != Some("twitch-eventsub") { return Ok(()); }
        let Some(channel) = event.get("channelID").and_then(serde_json::Value::as_str).filter(|value| !value.is_empty()) else { return Ok(()) };
        let payload = event.get("payload").and_then(serde_json::Value::as_object).ok_or_else(|| error("Invalid interaction payload"))?;
        let event_type = payload.get("subscription").and_then(serde_json::Value::as_object).and_then(|value| value.get("type")).and_then(serde_json::Value::as_str).ok_or_else(|| error("Invalid interaction subscription"))?;
        let raw = payload.get("event").and_then(serde_json::Value::as_object).ok_or_else(|| error("Invalid interaction event"))?;
        let timestamp = event.get("metadata").and_then(serde_json::Value::as_object).and_then(|value| value.get("messageTimestamp")).and_then(serde_json::Value::as_str).filter(|value| !value.is_empty())
            .or_else(|| event.get("occurredAt").and_then(serde_json::Value::as_str)).ok_or_else(|| error("Invalid interaction timestamp"))?;
        let receipt = event.get("sourceEventId").and_then(serde_json::Value::as_str).ok_or_else(|| error("Invalid interaction receipt"))?;
        let state = parse_interaction(event_type, raw, timestamp, receipt).map_err(error)?;
        self.save_interaction(channel, state).await
    }
}
type ResyncEntry = (i64, Arc<OnceCell<Result<(), InteractionError>>>);
/// Native Helix recovery using injected HTTP, Twitch headers and Mongo clients.
pub struct InteractionResync {
    http: reqwest::Client,
    headers: Arc<TwitchHeaders>,
    repository: MongoInteractions,
    pending: Mutex<BTreeMap<String, ResyncEntry>>,
}
impl InteractionResync {
    /// Construct a resync service without network or database I/O.
    pub fn new(http: reqwest::Client, headers: Arc<TwitchHeaders>, repository: MongoInteractions) -> Self {
        Self { http, headers, repository, pending: Mutex::new(BTreeMap::new()) }
    }
    /// Coalesce per-channel and per-kind recovery for sixty seconds.
    pub async fn resync_interaction(&self, channel: &str, kind: InteractionKind, now_ms: i64) -> Result<(), InteractionError> {
        let identity = key(channel, kind);
        let promise = {
            let mut pending = self.pending.lock().map_err(|_| error("Interaction recovery unavailable"))?;
            if pending.len() > 2000 { pending.retain(|_, (until, _)| *until >= now_ms); }
            if let Some((until, promise)) = pending.get(&identity).filter(|(until, _)| *until > now_ms) { let _ = until; promise.clone() }
            else {
                let promise = Arc::new(OnceCell::new());
                pending.insert(identity.clone(), (now_ms.saturating_add(RESYNC_INTERVAL_MS), promise.clone()));
                promise
            }
        };
        promise.get_or_init(|| self.fetch_and_save(channel, kind, now_ms, &identity)).await.clone()
    }
    async fn fetch_and_save(&self, channel: &str, kind: InteractionKind, now_ms: i64, identity: &str) -> Result<(), InteractionError> {
        let header = self.headers.get_twitch_streamer_header_by_id(channel).await;
        if header.error { return Ok(()); }
        let Some(header) = header.header else { return Ok(()) };
        let occurred_at = JsDate::from_millis(now_ms as f64).to_iso_string().map_err(error)?;
        let endpoint = match kind { InteractionKind::Poll => "polls", InteractionKind::Prediction => "predictions" };
        let response = self.http.get(get_twitch_helix_url(endpoint, None)).headers(header.to_header_map())
            .query(&[("broadcaster_id", channel), ("first", "1")]).timeout(Duration::from_millis(RESYNC_TIMEOUT_MS))
            .send().await.map_err(|_| error("Interaction recovery request failed"))?;
        if !response.status().is_success() { return Err(error(format!("Interaction recovery failed: {}", response.status().as_u16()))); }
        let result: serde_json::Value = response.json().await.map_err(|_| error("Invalid interaction recovery response"))?;
        let Some(mut raw) = result.get("data").and_then(serde_json::Value::as_array).and_then(|items| items.first()).and_then(serde_json::Value::as_object).cloned() else { return Ok(()) };
        let phase = raw.get("status").and_then(serde_json::Value::as_str).unwrap_or("").to_lowercase();
        let Some(event_type) = recovery_event_type(kind, &phase) else { return Ok(()) };
        raw.insert("status".into(), serde_json::Value::String(phase));
        if raw.get("locks_at").is_none_or(serde_json::Value::is_null) {
            if let (Some(start), Some(window)) = (raw.get("started_at").and_then(serde_json::Value::as_str).and_then(js_date::parse_date), raw.get("prediction_window").and_then(serde_json::Value::as_f64)) {
                let date = JsDate::from_millis(start as f64 + window * 1000.0).to_iso_string().map_err(error)?;
                raw.insert("locks_at".into(), serde_json::Value::String(date));
            }
        }
        if raw.get("locked_at").is_none_or(serde_json::Value::is_null) { raw.insert("locked_at".into(), serde_json::Value::String(occurred_at.clone())); }
        let state = parse_interaction(event_type, &raw, &occurred_at, &format!("helix:{identity}:{occurred_at}")).map_err(error)?;
        self.repository.save_interaction(channel, state).await
    }
}
/// Coalescing interval for an interaction resync, in milliseconds.
pub const RESYNC_INTERVAL_MS: i64 = 60_000;
/// Helix request timeout in milliseconds.
pub const RESYNC_TIMEOUT_MS: u64 = 8_000;
/// Map a Helix status to the EventSub type parsed by the existing interaction model.
pub fn recovery_event_type(kind: InteractionKind, phase: &str) -> Option<&'static str> {
    match (kind, phase) {
        (InteractionKind::Poll, "active") => Some("channel.poll.progress"),
        (InteractionKind::Poll, "locked" | "unfulfilled" | "cancel_pending") => Some("channel.poll.lock"),
        (InteractionKind::Poll, "completed" | "terminated" | "archived") => Some("channel.poll.end"),
        (InteractionKind::Prediction, "active") => Some("channel.prediction.progress"),
        (InteractionKind::Prediction, "locked" | "unfulfilled" | "cancel_pending") => Some("channel.prediction.lock"),
        (InteractionKind::Prediction, "resolved" | "canceled") => Some("channel.prediction.end"),
        _ => None,
    }
}
/// Determine if a previously scheduled recovery remains coalesced.
pub fn resync_is_coalesced(until_ms: i64, now_ms: i64) -> bool { until_ms > now_ms }
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn prediction_transitional_phases_are_locked() {
        assert_eq!(recovery_event_type(InteractionKind::Prediction, "unfulfilled"), Some("channel.prediction.lock"));
        assert_eq!(recovery_event_type(InteractionKind::Prediction, "cancel_pending"), Some("channel.prediction.lock"));
    }
    #[test]
    fn terminal_phases_and_unknown_values() {
        assert_eq!(recovery_event_type(InteractionKind::Poll, "completed"), Some("channel.poll.end"));
        assert_eq!(recovery_event_type(InteractionKind::Prediction, "resolved"), Some("channel.prediction.end"));
        assert_eq!(recovery_event_type(InteractionKind::Poll, "unknown"), None);
    }
    #[test]
    fn coalescing_expires_at_the_boundary() {
        assert!(resync_is_coalesced(100, 99)); assert!(!resync_is_coalesced(100, 100));
    }
}
