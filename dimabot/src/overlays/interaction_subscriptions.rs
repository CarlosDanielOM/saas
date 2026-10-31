//! Interaction subscription readiness decisions from `interaction-subscriptions.ts`.
//! Only matching webhook subscriptions for the channel count; explicit owner
//! activation and remote subscription mutation are not performed here.

use crate::domain_event_contracts::interaction::{InteractionKind, POLL_SUBSCRIPTIONS, PREDICTION_SUBSCRIPTIONS};
use crate::utils::{eventsub::{get_eventsubs, subscribe_twitch_event, unsubscribe_twitch_event, remote::{EventsubDirectory, EventsubStore}}, twitch::{TokenSource, TwitchClient}, twitch_streamers::TwitchStreamers};
use crate::schemas::eventsub::ICondition;
use mongodb::{Collection, bson::{Document, serialize_to_document}};
use super::store::OverlayError;
use serde_json::Value;

/// Native interaction subscription service using the shared EventSub adapters.
pub struct InteractionSubscriptions<'a> {
    tokens: &'a dyn TokenSource,
    client: &'a TwitchClient,
    directory: &'a dyn EventsubDirectory,
    store: &'a dyn EventsubStore,
    secret: Option<&'a str>,
}
impl<'a> InteractionSubscriptions<'a> {
    /// Construct from application-owned Twitch and Mongo handles without I/O.
    pub fn native(tokens: &'a dyn TokenSource, client: &'a TwitchClient, directory: &'a TwitchStreamers, store: &'a Collection<Document>, secret: Option<&'a str>) -> Self {
        Self::with_adapters(tokens, client, directory, store, secret)
    }
    /// Construct with explicit adapters for isolated fixtures.
    pub fn with_adapters(tokens: &'a dyn TokenSource, client: &'a TwitchClient, directory: &'a dyn EventsubDirectory, store: &'a dyn EventsubStore, secret: Option<&'a str>) -> Self {
        Self { tokens, client, directory, store, secret }
    }
    async fn inspect(&self, channel: &str) -> Result<(Vec<Value>, Vec<String>), OverlayError> {
        let (remote, scopes) = tokio::join!(get_eventsubs(self.tokens, Some(self.client)), crate::functions::users::get_scopes::get_scopes(self.tokens, self.client, channel));
        let remote = remote.map_err(|_| subscription_error("Unable to check Twitch events. Try again.", 502))?;
        if remote.get("error").is_some_and(json_truthy) || scopes.get("error").is_some_and(json_truthy) { return Err(subscription_error("Unable to check Twitch events. Try again.", 502)); }
        let subscriptions = remote.get("data").and_then(Value::as_array).ok_or_else(|| subscription_error("Unable to check Twitch events. Try again.", 502))?.clone();
        let grants = scopes.get("data").and_then(Value::as_array).ok_or_else(|| subscription_error("Unable to check Twitch events. Try again.", 502))?;
        let scopes = grants.iter().find(|item| item.get("user_id").and_then(Value::as_str) == Some(channel)).and_then(|item| item.get("scopes")).and_then(Value::as_array).map(|items| items.iter().filter_map(Value::as_str).map(str::to_owned).collect()).unwrap_or_default();
        Ok((subscriptions, scopes))
    }
    /// Inspect source-compatible readiness for a single interaction kind.
    pub async fn interaction_readiness(&self, channel: &str, kind: InteractionKind) -> Result<InteractionReadiness, OverlayError> {
        let (remote, scopes) = self.inspect(channel).await?;
        Ok(readiness(channel, kind, &remote.iter().filter_map(remote_view).collect::<Vec<_>>(), &scopes))
    }
    /// Reconcile a user's explicit activation through the shared remote adapters.
    pub async fn activate_interaction(&self, channel: &str, kind: InteractionKind) -> Result<InteractionReadiness, OverlayError> {
        let (mut remote, mut scopes) = self.inspect(channel).await?;
        if readiness(channel, kind, &remote.iter().filter_map(remote_view).collect::<Vec<_>>(), &scopes).state == ReadinessState::Permission { return Err(subscription_error("Reconnect Twitch to grant poll and prediction permissions.", 403)); }
        let name = self.directory.name(channel).await.map_err(|_| subscription_error("Twitch account unavailable", 403))?.ok_or_else(|| subscription_error("Twitch account unavailable", 403))?;
        let types: &[&str] = match kind { InteractionKind::Poll => &POLL_SUBSCRIPTIONS, InteractionKind::Prediction => &PREDICTION_SUBSCRIPTIONS };
        for event_type in types {
            let eligible = |item: &Value| remote_view(item).is_some_and(|view| matches_subscription(&view, channel, event_type));
            if let Some(existing) = remote.iter().find(|item| eligible(item) && matches!(item.get("status").and_then(Value::as_str), Some("enabled" | "webhook_callback_verification_pending"))) {
                let mut document = serialize_to_document(existing).map_err(|_| subscription_error("Unable to activate Twitch events. Try again.", 502))?;
                document.insert("channelID", channel); document.insert("channel", &name);
                self.store.upsert(document).await.map_err(|_| subscription_error("Unable to activate Twitch events. Try again.", 502))?;
                continue;
            }
            for stale in remote.iter().filter(|item| eligible(item)) {
                let Some(id) = stale.get("id").and_then(Value::as_str) else { return Err(subscription_error("Unable to repair Twitch events. Try again.", 502)) };
                let result = unsubscribe_twitch_event(self.tokens, Some(self.client), self.store, id).await.map_err(|_| subscription_error("Unable to repair Twitch events. Try again.", 502))?;
                if result.get("error").is_some() { return Err(subscription_error("Unable to repair Twitch events. Try again.", 502)); }
            }
            let requested = ICondition { broadcaster_user_id: Some(channel.into()), user_id: None, moderator_user_id: None, from_broadcaster_user_id: None, to_broadcaster_user_id: None };
            let result = subscribe_twitch_event(self.tokens, Some(self.client), self.directory, self.store, self.secret, channel, event_type, "1", &requested, None, true).await.map_err(|_| subscription_error("Unable to activate Twitch events. Try again.", 502))?;
            if result.get("error").is_some() {
                let status = result.get("status").and_then(Value::as_u64).unwrap_or(502);
                if status != 409 { return Err(if status == 403 { subscription_error("Reconnect Twitch to grant the required permissions.", 403) } else { subscription_error("Unable to activate Twitch events. Try again.", 502) }); }
                (remote, scopes) = self.inspect(channel).await?;
                if !remote.iter().any(|item| eligible(item) && matches!(item.get("status").and_then(Value::as_str), Some("enabled" | "webhook_callback_verification_pending"))) { return Err(subscription_error("Unable to activate Twitch events. Try again.", 502)); }
            } else { remote.push(result); }
        }
        Ok(readiness(channel, kind, &remote.iter().filter_map(remote_view).collect::<Vec<_>>(), &scopes))
    }
}
fn subscription_error(message: &str, status: u16) -> OverlayError { OverlayError { message: message.into(), status } }
fn json_truthy(value: &Value) -> bool {
    match value { Value::Null => false, Value::Bool(value) => *value, Value::Number(value) => value.as_f64().is_some_and(|number| number != 0.0), Value::String(value) => !value.is_empty(), Value::Array(_) | Value::Object(_) => true }
}
fn remote_view(value: &Value) -> Option<RemoteSubscription> {
    Some(RemoteSubscription { event_type: value.get("type")?.as_str()?.into(), version: value.get("version")?.as_str()?.into(), status: value.get("status")?.as_str()?.into(), broadcaster_user_id: value.pointer("/condition/broadcaster_user_id").and_then(Value::as_str).map(str::to_owned), transport_method: value.pointer("/transport/method").and_then(Value::as_str).map(str::to_owned), callback: value.pointer("/transport/callback").and_then(Value::as_str).map(str::to_owned) })
}
/// The EventSub webhook callback owned by the application.
pub const CALLBACK: &str = "https://subscriptions.domdimabot.com/eventsub";
/// Relevant public fields from a remote EventSub subscription.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RemoteSubscription {
    /// EventSub type.
    pub event_type: String,
    /// EventSub version.
    pub version: String,
    /// Remote status.
    pub status: String,
    /// Broadcaster in the subscription condition.
    pub broadcaster_user_id: Option<String>,
    /// Transport method.
    pub transport_method: Option<String>,
    /// Webhook destination.
    pub callback: Option<String>,
}
/// Result of inspecting access and the requested subscriptions.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ReadinessState { /// All subscriptions enabled.
    Ready, /// All enabled or awaiting verification.
    Pending, /// At least one subscription missing or unhealthy.
    Missing, /// Required account grant absent.
    Permission }
/// Status for one event type.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct EventReadiness { /// EventSub type.
    pub event_type: &'static str, /// Preferred observed status.
    pub status: String }
/// Readiness of one interaction kind.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct InteractionReadiness { /// Overall state.
    pub state: ReadinessState, /// Event-specific statuses.
    pub events: Vec<EventReadiness> }
/// Match type, channel, version and webhook destination exactly.
pub fn matches_subscription(remote: &RemoteSubscription, channel: &str, event_type: &str) -> bool {
    remote.event_type == event_type && remote.version == "1"
        && remote.broadcaster_user_id.as_deref() == Some(channel)
        && remote.transport_method.as_deref() == Some("webhook")
        && remote.callback.as_deref() == Some(CALLBACK)
}
/// Calculate readiness without changing remote or local subscriptions.
pub fn readiness(channel: &str, kind: InteractionKind, remote: &[RemoteSubscription], scopes: &[String]) -> InteractionReadiness {
    let (types, suffix): (&[&'static str], &str) = match kind {
        InteractionKind::Poll => (&POLL_SUBSCRIPTIONS, "polls"),
        InteractionKind::Prediction => (&PREDICTION_SUBSCRIPTIONS, "predictions"),
    };
    let permitted = scopes.iter().any(|scope| scope == &format!("channel:read:{suffix}") || scope == &format!("channel:manage:{suffix}"));
    let events: Vec<_> = types.iter().map(|event_type| {
        let matching: Vec<_> = remote.iter().filter(|item| matches_subscription(item, channel, event_type)).collect();
        let selected = matching.iter().find(|item| item.status == "enabled")
            .or_else(|| matching.iter().find(|item| item.status == "webhook_callback_verification_pending"))
            .or_else(|| matching.first());
        EventReadiness { event_type: *event_type, status: selected.map_or("missing", |item| item.status.as_str()).to_owned() }
    }).collect();
    let state = if !permitted { ReadinessState::Permission }
        else if events.iter().all(|event| event.status == "enabled") { ReadinessState::Ready }
        else if events.iter().all(|event| matches!(event.status.as_str(), "enabled" | "webhook_callback_verification_pending")) { ReadinessState::Pending }
        else { ReadinessState::Missing };
    InteractionReadiness { state, events }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn missing_grant_takes_precedence() {
        assert_eq!(readiness("1", InteractionKind::Poll, &[], &[]).state, ReadinessState::Permission);
    }
    #[test]
    fn grants_without_subscriptions_are_missing() {
        assert_eq!(readiness("1", InteractionKind::Poll, &[], &["channel:read:polls".into()]).state, ReadinessState::Missing);
    }
    #[test]
    fn all_enabled_and_pending_are_distinct() {
        let mut items: Vec<_> = POLL_SUBSCRIPTIONS.iter().map(|event_type| RemoteSubscription { event_type: (*event_type).into(), version: "1".into(), status: "enabled".into(), broadcaster_user_id: Some("1".into()), transport_method: Some("webhook".into()), callback: Some(CALLBACK.into()) }).collect();
        let scopes = ["channel:manage:polls".into()];
        assert_eq!(readiness("1", InteractionKind::Poll, &items, &scopes).state, ReadinessState::Ready);
        items[0].status = "webhook_callback_verification_pending".into();
        assert_eq!(readiness("1", InteractionKind::Poll, &items, &scopes).state, ReadinessState::Pending);
    }
    #[test]
    fn remote_view_uses_original_eventsub_condition_and_transport() {
        let raw = serde_json::json!({"type":"channel.poll.begin","version":"1","status":"enabled","condition":{"broadcaster_user_id":"123"},"transport":{"method":"webhook","callback":CALLBACK}});
        let remote = remote_view(&raw).expect("remote event");
        assert!(matches_subscription(&remote, "123", "channel.poll.begin"));
        assert!(!matches_subscription(&remote, "other", "channel.poll.begin"));
    }
}
