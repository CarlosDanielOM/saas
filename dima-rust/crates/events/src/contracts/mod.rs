//! Every event type the journal accepts, its envelope, and the delivery policy of every consumer.
//!
//! Reference: `dimabot/src/domain_events/domain_event.types.ts` (topics, retention, the
//! envelope), `domain_event_contracts.ts` (the type tables and [`validate_contract`]),
//! `domain_event_delivery_policy.ts` and `domain_event_consumers.ts` ([`policy`]).
//!
//! # Event types
//!
//! | source | types | topic | retention |
//! |---|---|---|---|
//! | `twitch-eventsub`, `twitch-eventsub-test` | [`TWITCH_TYPES`]: 26 subscription types mapped to 23 event types, plus `channel.raid.sent` for an outgoing raid | `channel` | 90 days; 1 day for polls, predictions, hype trains, ad breaks and goals |
//! | `polar-webhook` | [`POLAR_TYPES`]: 3 mapped billing types, every other Polar type as `provider.polar.<type>` | `domain` | 90 days |
//! | `goals-custom` | `goal.item.added` | `domain` | 90 days |
//!
//! Every type is schema version 1. The payload of a Twitch event is the notification's
//! `{subscription, event}` as Twitch sent it, and the payload of an unmapped Polar event is
//! `{providerData}`: both stay raw ([`Object`]) because the features that consume them own their
//! shape; [`validate_contract`] checks what the reference checks and nothing more.

pub mod live;
pub mod policy;
mod validate;

pub use dima_model::domain_events::{SubjectKind, Topic};
pub use validate::{
    Check, ContractError, MAX_JSON_BYTES, Mode, check_json, serialize_provider_data,
    validate_contract,
};
pub(crate) use validate::{
    is_goal_item_key as validate_goal_item_key,
    is_outgoing_raid_condition as validate_outgoing_raid,
    is_safe_integer as validate_is_safe_integer,
};

use crate::value::{Object, Value};
use dima_model::StrEnum;

/// `DOMAIN_EVENT_RETENTION_SECONDS[topic]`: how long an event is kept (the TTL of `expiresAt`),
/// and the most a producer may ask for.
pub const fn retention_seconds(topic: Topic) -> f64 {
    match topic {
        Topic::Channel => 90.0 * 24.0 * 60.0 * 60.0,
        Topic::Activity => 3.0 * 24.0 * 60.0 * 60.0,
        Topic::Telemetry => 7.0 * 24.0 * 60.0 * 60.0,
        Topic::Domain => 90.0 * 24.0 * 60.0 * 60.0,
    }
}

/// The retention a Twitch producer asks for polls, predictions, hype trains, ad breaks and goals
/// (`twitch_eventsub_events.ts`: `retentionSeconds: 86400`).
pub const SHORT_TWITCH_RETENTION_SECONDS: f64 = 86_400.0;

/// The subscription type prefixes journaled with [`SHORT_TWITCH_RETENTION_SECONDS`].
pub const SHORT_RETENTION_PREFIXES: [&str; 5] = [
    "channel.poll.",
    "channel.prediction.",
    "channel.hype_train.",
    "channel.ad_break.",
    "channel.goal.",
];

/// `INTERACTION_EVENT_TYPES` (`overlays/interaction-model.ts`).
pub const INTERACTION_TYPES: [(&str, &str); 7] = [
    ("channel.poll.begin", "channel.poll.began"),
    ("channel.poll.progress", "channel.poll.updated"),
    ("channel.poll.end", "channel.poll.ended"),
    ("channel.prediction.begin", "channel.prediction.began"),
    ("channel.prediction.progress", "channel.prediction.updated"),
    ("channel.prediction.lock", "channel.prediction.locked"),
    ("channel.prediction.end", "channel.prediction.ended"),
];

/// `HYPE_TRAIN_EVENT_TYPES` (`overlays/live-events-model.ts`).
pub const HYPE_TRAIN_TYPES: [(&str, &str); 3] = [
    ("channel.hype_train.begin", "channel.hype_train.began"),
    ("channel.hype_train.progress", "channel.hype_train.updated"),
    ("channel.hype_train.end", "channel.hype_train.ended"),
];

/// `AD_BREAK_EVENT_TYPES` (`overlays/live-events-model.ts`).
pub const AD_BREAK_TYPES: [(&str, &str); 1] =
    [("channel.ad_break.begin", "channel.ad_break.began")];

/// `TWITCH_GOAL_EVENT_TYPES` (`goals/twitch.ts`).
pub const TWITCH_GOAL_TYPES: [(&str, &str); 3] = [
    ("channel.goal.begin", "channel.goal.began"),
    ("channel.goal.progress", "channel.goal.updated"),
    ("channel.goal.end", "channel.goal.ended"),
];

/// `TWITCH_DOMAIN_EVENT_TYPES`: EventSub subscription type to journal type, in the reference's
/// key order (the spreads first). An outgoing raid is journaled as `channel.raid.sent`.
pub const TWITCH_TYPES: [(&str, &str); 26] = [
    INTERACTION_TYPES[0],
    INTERACTION_TYPES[1],
    INTERACTION_TYPES[2],
    INTERACTION_TYPES[3],
    INTERACTION_TYPES[4],
    INTERACTION_TYPES[5],
    INTERACTION_TYPES[6],
    HYPE_TRAIN_TYPES[0],
    HYPE_TRAIN_TYPES[1],
    HYPE_TRAIN_TYPES[2],
    AD_BREAK_TYPES[0],
    TWITCH_GOAL_TYPES[0],
    TWITCH_GOAL_TYPES[1],
    TWITCH_GOAL_TYPES[2],
    ("channel.bits.use", "channel.bits.received"),
    ("channel.cheer", "channel.bits.received"),
    ("channel.bit.use", "channel.bits.received"),
    ("channel.follow", "channel.follow.received"),
    ("channel.raid", "channel.raid.received"),
    ("channel.chat.notification", "channel.chat.notification"),
    ("channel.subscribe", "channel.subscription.received"),
    (
        "channel.subscription.message",
        "channel.subscription.received",
    ),
    ("channel.subscription.gift", "channel.subscription.gifted"),
    ("channel.subscription.end", "channel.subscription.ended"),
    ("stream.online", "stream.started"),
    ("stream.offline", "stream.ended"),
];

/// The journal type of an EventSub subscription type (`Object.hasOwn(TWITCH_DOMAIN_EVENT_TYPES,
/// type)`), `None` for a type that is not journaled.
pub fn twitch_type(subscription_type: &str) -> Option<&'static str> {
    TWITCH_TYPES
        .iter()
        .find(|(from, _)| *from == subscription_type)
        .map(|(_, to)| *to)
}

/// The subscription types that are journaled, in the reference's order.
pub fn twitch_subscription_types() -> impl Iterator<Item = &'static str> {
    TWITCH_TYPES.iter().map(|(from, _)| *from)
}

/// `LIVE_EVENT_DOMAIN_TYPES`: journaled only for live state (hype trains, ad breaks, Twitch
/// goals).
pub const LIVE_EVENT_DOMAIN_TYPES: [&str; 7] = [
    HYPE_TRAIN_TYPES[0].1,
    HYPE_TRAIN_TYPES[1].1,
    HYPE_TRAIN_TYPES[2].1,
    AD_BREAK_TYPES[0].1,
    TWITCH_GOAL_TYPES[0].1,
    TWITCH_GOAL_TYPES[1].1,
    TWITCH_GOAL_TYPES[2].1,
];

/// `POLAR_DOMAIN_EVENT_TYPES`: the Polar webhook types that are billing events. Every other type
/// is journaled as `provider.polar.<type>` with `metadata.unmapped: true`.
pub const POLAR_TYPES: [(&str, &str); 3] = [
    ("order.paid", "billing.order.paid"),
    ("subscription.updated", "billing.subscription.updated"),
    ("customer.state_changed", "billing.customer.state.changed"),
];

/// The billing type of a mapped Polar webhook type.
pub fn polar_type(webhook_type: &str) -> Option<&'static str> {
    POLAR_TYPES
        .iter()
        .find(|(from, _)| *from == webhook_type)
        .map(|(_, to)| *to)
}

/// The journal sources.
pub mod sources {
    /// Twitch EventSub notifications.
    pub const TWITCH: &str = "twitch-eventsub";
    /// Test notifications sent from the site (`POST /eventsub/:channelID/test`).
    pub const TWITCH_TEST: &str = "twitch-eventsub-test";
    /// Polar webhooks.
    pub const POLAR: &str = "polar-webhook";
    /// Custom goal contributions (`goal.add`).
    pub const GOALS_CUSTOM: &str = "goals-custom";
}

/// What an event is about (`DomainEventSubject`). `kind` is text here because the validator
/// checks it ([`SubjectKind`] lists the accepted values).
#[derive(Clone, Debug, PartialEq)]
pub struct SubjectInput {
    /// The provider (`twitch`, `polar`, `goals-custom`).
    pub provider: String,
    /// `streaming-account`, `integration-account`, `customer` or `resource`.
    pub kind: String,
    /// The provider's id.
    pub id: String,
}

impl SubjectInput {
    /// A subject of a listed kind.
    pub fn new(provider: impl Into<String>, kind: SubjectKind, id: impl Into<String>) -> Self {
        Self {
            provider: provider.into(),
            kind: kind.as_str().to_owned(),
            id: id.into(),
        }
    }
}

/// `occurredAt` of an input: ISO text from a provider, or a `Date`.
#[derive(Clone, Debug, PartialEq)]
pub enum OccurredAt {
    /// Text (`2026-09-05T12:00:00.123456789Z`).
    Text(String),
    /// A `Date`, epoch milliseconds (`NaN` for an invalid date).
    Date(f64),
}

/// An event to journal (`JournalDomainEventInput`). `None` is a property left out.
#[derive(Clone, Debug, PartialEq)]
pub struct JournalInput {
    /// The producer (`twitch-eventsub`...).
    pub source: String,
    /// The producer's id for the event.
    pub source_event_id: String,
    /// The event type.
    pub kind: String,
    /// The topic.
    pub topic: Topic,
    /// The payload's schema version (default 1).
    pub schema_version: Option<f64>,
    /// The owning user (`users._id` as hex).
    pub owner_user_id: Option<String>,
    /// What the event is about.
    pub subject: Option<SubjectInput>,
    /// The channel (required for the channel topic).
    pub channel_id: Option<String>,
    /// The stream.
    pub stream_id: Option<String>,
    /// When it happened (default: when it is journaled).
    pub occurred_at: Option<OccurredAt>,
    /// The payload.
    pub payload: Object,
    /// Metadata.
    pub metadata: Option<Object>,
    /// The retention asked for (default: the topic's).
    pub retention_seconds: Option<f64>,
}

impl JournalInput {
    /// The input as the object the reference's validator receives (`ingest` mode).
    pub fn to_object(&self) -> Object {
        let mut object = Object::new();
        object.insert("source", Value::from(self.source.as_str()));
        object.insert("sourceEventId", Value::from(self.source_event_id.as_str()));
        object.insert("type", Value::from(self.kind.as_str()));
        object.insert("topic", Value::from(self.topic.as_str()));
        if let Some(version) = self.schema_version {
            object.insert("schemaVersion", Value::Number(version));
        }
        if let Some(retention) = self.retention_seconds {
            object.insert("retentionSeconds", Value::Number(retention));
        }
        if let Some(owner) = &self.owner_user_id {
            object.insert("ownerUserId", Value::from(owner.as_str()));
        }
        if let Some(subject) = &self.subject {
            object.insert("subject", Value::Object(subject_object(subject)));
        }
        if let Some(channel) = &self.channel_id {
            object.insert("channelID", Value::from(channel.as_str()));
        }
        if let Some(stream) = &self.stream_id {
            object.insert("streamID", Value::from(stream.as_str()));
        }
        match &self.occurred_at {
            Some(OccurredAt::Text(text)) => object.insert("occurredAt", Value::from(text.as_str())),
            Some(OccurredAt::Date(ms)) => object.insert("occurredAt", Value::Date(*ms)),
            None => {}
        }
        object.insert("payload", Value::Object(self.payload.clone()));
        if let Some(metadata) = &self.metadata {
            object.insert("metadata", Value::Object(metadata.clone()));
        }
        object
    }

    /// `validateDomainEventContract(input, mode)`.
    pub fn validate(&self, check: Check) -> Result<(), ContractError> {
        validate_contract(&self.to_object(), check)
    }
}

fn subject_object(subject: &SubjectInput) -> Object {
    let mut object = Object::new();
    object.insert("provider", Value::from(subject.provider.as_str()));
    object.insert("kind", Value::from(subject.kind.as_str()));
    object.insert("id", Value::from(subject.id.as_str()));
    object
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tables() {
        assert_eq!(twitch_subscription_types().count(), 26);
        assert_eq!(twitch_type("channel.cheer"), Some("channel.bits.received"));
        assert_eq!(twitch_type("channel.chat.message"), None);
        assert_eq!(twitch_type(""), None);
        assert_eq!(polar_type("order.paid"), Some("billing.order.paid"));
        assert_eq!(retention_seconds(Topic::Activity), 259_200.0);
    }
}
