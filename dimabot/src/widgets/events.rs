//! Shared widget domain-event consumer.
//!
//! Ports `dimabot/src/widgets/events.ts`. Adapters own persistence. This
//! module owns eligibility and fan-out: one handler, no channel cache, and
//! no per-widget process. A failed adapter is collected and the others still
//! run; the aggregate error is `Widget event effects failed` so delivery
//! retries. Duplicate adapter ids are rejected at registration.
//!
//! `occurredAt` / `journaledAt` accept a JSON number, a string `Date.parse`
//! would accept, or an extended `{ "$date": ... }` value. An unparseable
//! instant is not finite and is therefore not eligible.

#![cfg(feature = "widgets-runtime")]

use crate::domain_event_contracts::{
    DomainEventEnvelope, DomainEventFuture, DomainEventHandler, DomainEventTopic,
};
use crate::utils::js_date::parse_date;
use serde_json::Value;
use std::{error::Error, fmt, sync::Arc};

/// Five minutes. Events older than this are not applied.
pub const WIDGET_EVENT_MAX_AGE_MS: i64 = 5 * 60_000;

/// One widget that may receive a domain event.
#[derive(Clone, Debug, PartialEq)]
pub struct WidgetEventTarget {
    pub id: String,
    pub enabled: bool,
    pub active: bool,
    pub active_since: Option<i64>,
    pub allow_test_events: bool,
}

/// Persistence and rules live behind this seam. The production adapter is
/// `DbdChallengeAdapter` in `service.rs`.
pub trait WidgetEventAdapter: Send + Sync {
    fn id(&self) -> &str;
    fn event_types(&self) -> &[&str];
    fn targets<'a>(&'a self, channel_id: &'a str) -> DomainEventFuture<'a, Vec<WidgetEventTarget>>;
    fn apply<'a>(
        &'a self,
        target: &'a WidgetEventTarget,
        event: &'a DomainEventEnvelope,
    ) -> DomainEventFuture<'a, ()>;
}

/// Collected adapter failures. The display text is the source aggregate message.
#[derive(Debug)]
pub struct WidgetEventEffectsError {
    pub errors: Vec<String>,
}

impl fmt::Display for WidgetEventEffectsError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("Widget event effects failed")
    }
}

impl Error for WidgetEventEffectsError {}

/// Registration failure. The source throws `Duplicate widget adapter ID`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DuplicateAdapterError;

impl fmt::Display for DuplicateAdapterError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("Duplicate widget adapter ID")
    }
}

impl Error for DuplicateAdapterError {}

fn finite_millis(value: f64) -> Option<i64> {
    if value.is_finite() && value >= i64::MIN as f64 && value <= i64::MAX as f64 {
        Some(value as i64)
    } else {
        None
    }
}

/// Milliseconds for an envelope instant, or `None` when it is not finite.
pub fn event_instant_millis(value: Option<&Value>) -> Option<i64> {
    match value? {
        Value::Number(number) => number.as_f64().and_then(finite_millis),
        Value::String(text) => parse_date(text),
        Value::Object(fields) => match fields.get("$date")? {
            Value::String(text) => parse_date(text),
            Value::Number(number) => number.as_f64().and_then(finite_millis),
            _ => None,
        },
        _ => None,
    }
}

fn non_empty_string(value: Option<&Value>) -> Option<&str> {
    value.and_then(Value::as_str).filter(|text| !text.is_empty())
}

/// `topic === 'channel' && schemaVersion === 1` and a live provider source.
pub fn event_is_routable(event: &DomainEventEnvelope) -> bool {
    let version = event
        .get("schemaVersion")
        .and_then(Value::as_f64)
        .is_some_and(|version| version == 1.0);
    let source = event.source().unwrap_or("");
    version
        && event.topic() == Some(DomainEventTopic::Channel)
        && non_empty_string(event.channel_id()).is_some()
        && (source == "twitch-eventsub" || source == "twitch-eventsub-test")
}

/// Enabled, active, inside the activation window, and not older than five minutes.
pub fn widget_event_eligible(target: &WidgetEventTarget, event: &DomainEventEnvelope, now: i64) -> bool {
    let Some(active_since) = target.active_since else {
        return false;
    };
    let Some(occurred) = event_instant_millis(event.occurred_at()) else {
        return false;
    };
    let Some(journaled) = event_instant_millis(event.journaled_at()) else {
        return false;
    };
    let earliest = occurred.min(journaled);
    let source = event.source().unwrap_or("");
    target.enabled
        && target.active
        && earliest >= active_since
        && now.saturating_sub(earliest) <= WIDGET_EVENT_MAX_AGE_MS
        && (source == "twitch-eventsub" || (source == "twitch-eventsub-test" && target.allow_test_events))
}

/// Ids that `widgetEventEligible` would apply, in target order.
pub fn eligible_target_ids(
    targets: &[WidgetEventTarget],
    event: &DomainEventEnvelope,
    now: i64,
) -> Vec<String> {
    targets
        .iter()
        .filter(|target| widget_event_eligible(target, event, now))
        .map(|target| target.id.clone())
        .collect()
}

/// Copy the adapters once. Duplicate ids never reach the returned handler.
pub fn create_widget_event_handler(
    adapters: Vec<Arc<dyn WidgetEventAdapter>>,
) -> Result<Arc<DomainEventHandler>, DuplicateAdapterError> {
    let mut seen = Vec::with_capacity(adapters.len());
    for adapter in &adapters {
        if seen.iter().any(|id: &String| id == adapter.id()) {
            return Err(DuplicateAdapterError);
        }
        seen.push(adapter.id().to_owned());
    }
    let adapters = Arc::new(adapters);
    Ok(Arc::new(move |event: &DomainEventEnvelope| {
        let adapters = Arc::clone(&adapters);
        let event = event.clone();
        Box::pin(async move {
            if !event_is_routable(&event) {
                return Ok(());
            }
            let Some(channel) = non_empty_string(event.channel_id()) else {
                return Ok(());
            };
            let channel = channel.to_owned();
            let mut errors: Vec<String> = Vec::new();
            for adapter in adapters.iter() {
                let event_type = event.event_type().unwrap_or("");
                if !adapter.event_types().contains(&event_type) {
                    continue;
                }
                match adapter.targets(&channel).await {
                    Ok(targets) => {
                        for target in targets {
                            if !widget_event_eligible(&target, &event, unix_millis()) {
                                continue;
                            }
                            if let Err(error) = adapter.apply(&target, &event).await {
                                errors.push(error.to_string());
                            }
                        }
                    }
                    Err(error) => errors.push(error.to_string()),
                }
            }
            if errors.is_empty() {
                Ok(())
            } else {
                Err(Box::new(WidgetEventEffectsError { errors }))
            }
        })
    }))
}

fn unix_millis() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| i64::try_from(duration.as_millis()).unwrap_or(i64::MAX))
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{Map, json};

    fn event(mut patch: Map<String, Value>) -> DomainEventEnvelope {
        let mut fields = Map::new();
        fields.insert("eventKey".to_owned(), json!("bits:receipt"));
        fields.insert("source".to_owned(), json!("twitch-eventsub"));
        fields.insert("type".to_owned(), json!("channel.bits.received"));
        fields.insert("topic".to_owned(), json!("channel"));
        fields.insert("schemaVersion".to_owned(), json!(1));
        fields.insert("channelID".to_owned(), json!("123"));
        fields.insert("occurredAt".to_owned(), json!(1_000_i64));
        fields.insert("journaledAt".to_owned(), json!(1_000_i64));
        for (key, value) in patch.drain() {
            fields.insert(key, value);
        }
        DomainEventEnvelope::from_document(&fields)
    }

    fn target(id: &str) -> WidgetEventTarget {
        WidgetEventTarget {
            id: id.to_owned(),
            enabled: true,
            active: true,
            active_since: Some(0),
            allow_test_events: false,
        }
    }

    #[test]
    fn only_the_active_window_is_eligible() {
        let now = 1_000;
        let envelope = event(Map::new());
        let targets = vec![
            target("widget-a"),
            WidgetEventTarget { active: false, ..target("inactive") },
            WidgetEventTarget { enabled: false, ..target("disabled") },
            WidgetEventTarget { active_since: Some(2_000), ..target("newly-active") },
            WidgetEventTarget { active_since: None, ..target("legacy") },
        ];
        assert_eq!(eligible_target_ids(&targets, &envelope, now), vec!["widget-a".to_owned()]);
    }

    #[test]
    fn unsupported_topics_and_providers_are_not_routable() {
        assert!(event_is_routable(&event(Map::new())));
        let mut wrong_type = Map::new();
        wrong_type.insert("type".to_owned(), json!("stream.started"));
        assert!(event_is_routable(&event(wrong_type)));
        let mut topic = Map::new();
        topic.insert("topic".to_owned(), json!("domain"));
        assert!(!event_is_routable(&event(topic)));
        let mut source = Map::new();
        source.insert("source".to_owned(), json!("polar-webhook"));
        assert!(!event_is_routable(&event(source)));
        let mut missing = Map::new();
        missing.insert("channelID".to_owned(), Value::Null);
        assert!(!event_is_routable(&event(missing)));
        let mut version = Map::new();
        version.insert("schemaVersion".to_owned(), json!(2));
        assert!(!event_is_routable(&event(version)));
    }

    #[test]
    fn test_events_need_opt_in_and_stale_instants_do_not_apply() {
        let mut test_source = Map::new();
        test_source.insert("source".to_owned(), json!("twitch-eventsub-test"));
        let envelope = event(test_source);
        let targets = vec![
            target("live"),
            WidgetEventTarget { allow_test_events: true, ..target("test-opt-in") },
        ];
        assert_eq!(eligible_target_ids(&targets, &envelope, 1_000), vec!["test-opt-in".to_owned()]);
        let now = 1_000_000;
        let mut historical = Map::new();
        historical.insert("occurredAt".to_owned(), json!(now - 2_000));
        let activated = WidgetEventTarget { active_since: Some(now - 1_000), ..target("widget-a") };
        assert!(eligible_target_ids(&[activated], &event(historical), now).is_empty());
        let stale_at = now - WIDGET_EVENT_MAX_AGE_MS - 1_000;
        let mut stale = Map::new();
        stale.insert("occurredAt".to_owned(), json!(stale_at));
        stale.insert("journaledAt".to_owned(), json!(stale_at));
        assert!(eligible_target_ids(&[target("widget-a")], &event(stale), now).is_empty());
    }

    #[test]
    fn duplicate_adapter_ids_are_rejected() {
        let error = create_widget_event_handler(vec![
            Arc::new(StaticAdapter("game")),
            Arc::new(StaticAdapter("game")),
        ]);
        assert!(error.is_err());
        assert_eq!(error.err().expect("duplicate").to_string(), "Duplicate widget adapter ID");
    }

    struct StaticAdapter(&'static str);
    impl WidgetEventAdapter for StaticAdapter {
        fn id(&self) -> &str { self.0 }
        fn event_types(&self) -> &[&str] { &[] }
        fn targets<'a>(&'a self, _: &'a str) -> DomainEventFuture<'a, Vec<WidgetEventTarget>> {
            Box::pin(async { Ok(Vec::new()) })
        }
        fn apply<'a>(&'a self, _: &'a WidgetEventTarget, _: &'a DomainEventEnvelope) -> DomainEventFuture<'a, ()> {
            Box::pin(async { Ok(()) })
        }
    }
}
