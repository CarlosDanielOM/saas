//! Who receives which event, and on what terms.
//!
//! References: `domain_events/domain_event_consumers.ts` ([`CONSUMERS`]),
//! `domain_events/domain_event_delivery_policy.ts` ([`evaluate`], [`can_admin_replay`]) and the
//! delivery constants of `utils/domain_event_consumer.ts` and `workers/domain_events.worker.ts`
//! ([`delivery`]), which the consumer runtime package applies.
//!
//! Every consumer is **required** delivery in the journal's sense (a delivery document per
//! matching event, retried until it succeeds, is skipped or dies), except that a consumer with a
//! maximum event age is **ephemeral**: an event older than that is skipped, never retried, and
//! never replayed by an admin. Ordering: each consumer reads its topics in `_id` order through
//! its checkpoint, and ready retries in `updatedAt, _id` order; nothing orders deliveries across
//! consumers.
//!
//! | consumer | topic | filter | max age | admin replay |
//! |---|---|---|---|---|
//! | `raid-history-v1` | channel | Twitch raids received and sent | - | yes |
//! | `stream-timeline-v1` | channel | Twitch follows, subs, gifts, bits, raids received | - | yes |
//! | `channel-goals-v1` | channel | Twitch follows, subs, gifts, bits | - | yes |
//! | `goal-custom-contributions-v1` | domain | `goals-custom` `goal.item.added` | - | yes |
//! | `widget-actions-v1` | channel | Twitch (and test) events with a channel, except live-state types | 5 min | no |
//! | `overlay-interactions-v1` | channel | Twitch polls, predictions and live-state types | 1 day | no |
//! | `follow-defense-v1` | channel | Twitch follows and raids received, `durableDefenseHandled` | 5 min | no |
//! | `stream-analytics-v1` | channel | Twitch (and test) events except live-state types | - | yes |
//! | `stream-operations-v1` | channel | Twitch (and test) stream started and ended | - | yes |
//! | `chat-announcements-v1` | channel | Twitch (and test) announced types, `durableChatHandled` | 5 min | no |
//! | `account-health-notifications-v1` | channel | Twitch (and test) stream started, `durableChatHandled` | 5 min | no |
//! | `polar-plan-v1` | domain | Polar plan types ([`POLAR_PLAN_EVENT_TYPES`]) | - | yes |
//! | `polar-credits-v1` | domain | Polar `billing.customer.state.changed` | - | yes |
//! | `polar-rewards-v1` | domain | Polar `billing.order.paid` | - | yes |
//! | `polar-gifts-v1` | domain | Polar `billing.order.paid` of a gift pack product | - | yes |

use super::{LIVE_EVENT_DOMAIN_TYPES, Topic};
use bson::{Bson, Document, doc};

/// `DomainEventDeliveryPolicy`.
#[derive(Clone, Debug, PartialEq)]
pub struct DeliveryPolicy {
    /// The consumer name (the delivery's `consumer`).
    pub consumer: String,
    /// The schema versions it reads; `None` reads every version.
    pub schema_versions: Option<Vec<f64>>,
    /// Whether an admin may replay a dead delivery.
    pub admin_replay: bool,
    /// Events older than this are skipped (ephemeral effects).
    pub max_event_age_ms: Option<f64>,
}

/// `DomainEventPolicyDecision`.
#[derive(Clone, Debug, PartialEq)]
pub enum PolicyDecision {
    /// Deliver it.
    Eligible,
    /// Never deliverable to this consumer (`dead`, `policy_rejected`).
    Dead(String),
    /// Too old for this consumer (`skipped`).
    Skipped(String),
}

/// The fields of an event the policy reads. Times are epoch milliseconds; `NaN` for an invalid
/// date. `journaled_at` is `None` when the event has none.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct PolicyEvent {
    /// `schemaVersion`.
    pub schema_version: f64,
    /// `occurredAt`.
    pub occurred_at_ms: f64,
    /// `journaledAt`.
    pub journaled_at_ms: Option<f64>,
}

/// `isDomainEventSchemaCompatible(policy, event)`.
pub fn is_schema_compatible(policy: &DeliveryPolicy, schema_version: f64) -> bool {
    policy
        .schema_versions
        .as_ref()
        .is_none_or(|versions| versions.contains(&schema_version))
}

/// `evaluateDomainEventDeliveryPolicy(policy, event, now)`.
pub fn evaluate(policy: &DeliveryPolicy, event: PolicyEvent, now_ms: f64) -> PolicyDecision {
    if !is_schema_compatible(policy, event.schema_version) {
        return PolicyDecision::Dead(format!(
            "Unsupported schema version {} for {}",
            dima_text::number_to_string(event.schema_version),
            policy.consumer
        ));
    }
    if let Some(max_age) = policy.max_event_age_ms {
        // Provider clock skew must not keep ephemeral effects alive beyond journal age.
        let origin = match event.journaled_at_ms {
            None => event.occurred_at_ms,
            Some(journaled) => js_min(event.occurred_at_ms, journaled),
        };
        if !origin.is_finite() {
            return PolicyDecision::Dead(format!(
                "Invalid occurrence or journal time for age-limited consumer {}",
                policy.consumer
            ));
        }
        if now_ms - origin >= max_age {
            return PolicyDecision::Skipped(format!(
                "Event exceeds maxEventAgeMs {} for {}",
                dima_text::number_to_string(max_age),
                policy.consumer
            ));
        }
    }
    PolicyDecision::Eligible
}

/// `Math.min(a, b)`: `NaN` when either is.
fn js_min(a: f64, b: f64) -> f64 {
    if a.is_nan() || b.is_nan() { f64::NAN } else { a.min(b) }
}

/// `canAdminReplayDomainEvent(policy, event, now)`. `expires_at_ms` is the event's `expiresAt`.
pub fn can_admin_replay(
    policy: Option<&DeliveryPolicy>,
    event: Option<(PolicyEvent, f64)>,
    now_ms: f64,
) -> bool {
    match (policy, event) {
        (Some(policy), Some((event, expires_at_ms))) => {
            policy.admin_replay
                && expires_at_ms > now_ms
                && evaluate(policy, event, now_ms) == PolicyDecision::Eligible
        }
        _ => false,
    }
}

/// `WIDGET_EVENT_MAX_AGE_MS` (`widgets/events.ts`).
pub const WIDGET_EVENT_MAX_AGE_MS: f64 = 5.0 * 60_000.0;

/// `POLAR_PLAN_EVENT_TYPES` (`domain_events/polar_entitlements.ts`).
pub const POLAR_PLAN_EVENT_TYPES: [&str; 13] = [
    "billing.order.paid",
    "billing.subscription.updated",
    "billing.customer.state.changed",
    "provider.polar.subscription.created",
    "provider.polar.subscription.active",
    "provider.polar.subscription.canceled",
    "provider.polar.subscription.uncanceled",
    "provider.polar.subscription.past_due",
    "provider.polar.subscription.revoked",
    "provider.polar.benefit_grant.created",
    "provider.polar.benefit_grant.updated",
    "provider.polar.benefit_grant.cycled",
    "provider.polar.benefit_grant.revoked",
];

/// The paid products of `GIFT_PACK_PAIRS` (`utils/credit_gift_provider.ts`), in order.
pub const GIFT_PACK_PRODUCT_IDS: [&str; 3] = [
    "6e0c530d-affc-44be-a51b-e11453ef1fa7",
    "815d0efe-1d23-4fca-8762-ae3a9253b0bc",
    "7d0d5f0e-102a-4255-abf3-6f379e2da4ce",
];

/// One entry of `DOMAIN_EVENT_CONSUMERS`. The handler is the consumer runtime's to attach.
#[derive(Clone, Copy, Debug)]
pub struct ConsumerDefinition {
    /// The consumer name.
    pub consumer: &'static str,
    /// The topics it reads.
    pub topics: &'static [Topic],
    /// The schema versions it reads.
    pub schema_versions: &'static [f64],
    /// Whether an admin may replay its dead deliveries.
    pub admin_replay: bool,
    /// Events older than this are skipped.
    pub max_event_age_ms: Option<f64>,
    /// The MongoDB filter that admits events to it (`eventFilter`), in the reference's key
    /// order.
    pub event_filter: fn() -> Document,
}

impl ConsumerDefinition {
    /// The policy part.
    pub fn policy(&self) -> DeliveryPolicy {
        DeliveryPolicy {
            consumer: self.consumer.to_owned(),
            schema_versions: Some(self.schema_versions.to_vec()),
            admin_replay: self.admin_replay,
            max_event_age_ms: self.max_event_age_ms,
        }
    }
}

fn strings(values: &[&str]) -> Bson {
    Bson::Array(values.iter().map(|v| Bson::String((*v).to_owned())).collect())
}

fn twitch_sources() -> Document {
    doc! { "$in": ["twitch-eventsub", "twitch-eventsub-test"] }
}

fn raid_history() -> Document {
    doc! { "source": "twitch-eventsub", "type": { "$in": ["channel.raid.received", "channel.raid.sent"] } }
}

fn stream_timeline() -> Document {
    doc! { "source": "twitch-eventsub", "type": { "$in": [
        "channel.follow.received", "channel.subscription.received",
        "channel.subscription.gifted", "channel.bits.received", "channel.raid.received"
    ] } }
}

fn channel_goals() -> Document {
    doc! { "source": "twitch-eventsub", "type": { "$in": [
        "channel.follow.received", "channel.subscription.received",
        "channel.subscription.gifted", "channel.bits.received"
    ] } }
}

fn goal_custom() -> Document {
    doc! { "source": "goals-custom", "type": "goal.item.added" }
}

fn widget_actions() -> Document {
    doc! {
        "source": twitch_sources(),
        "channelID": { "$exists": true },
        "type": { "$nin": strings(&LIVE_EVENT_DOMAIN_TYPES) },
    }
}

fn overlay_interactions() -> Document {
    let mut types = vec![
        "channel.poll.began",
        "channel.poll.updated",
        "channel.poll.ended",
        "channel.prediction.began",
        "channel.prediction.updated",
        "channel.prediction.locked",
        "channel.prediction.ended",
    ];
    types.extend(LIVE_EVENT_DOMAIN_TYPES);
    doc! { "source": "twitch-eventsub", "type": { "$in": strings(&types) } }
}

fn follow_defense() -> Document {
    doc! {
        "source": "twitch-eventsub",
        "metadata.durableDefenseHandled": true,
        "type": { "$in": ["channel.follow.received", "channel.raid.received"] },
    }
}

fn stream_analytics() -> Document {
    doc! { "source": twitch_sources(), "type": { "$nin": strings(&LIVE_EVENT_DOMAIN_TYPES) } }
}

fn stream_operations() -> Document {
    doc! { "source": twitch_sources(), "type": { "$in": ["stream.started", "stream.ended"] } }
}

fn chat_announcements() -> Document {
    doc! {
        "source": twitch_sources(),
        "metadata.durableChatHandled": true,
        "$or": [
            { "type": { "$in": [
                "channel.bits.received", "channel.follow.received",
                "channel.subscription.received", "channel.subscription.gifted", "channel.subscription.ended",
                "stream.started", "stream.ended"
            ] } },
            { "type": "channel.chat.notification", "payload.event.notice_type": { "$in": ["watch_streak", "modiversary"] } }
        ],
    }
}

fn account_health() -> Document {
    doc! { "source": twitch_sources(), "metadata.durableChatHandled": true, "type": "stream.started" }
}

fn polar_plan() -> Document {
    doc! { "source": "polar-webhook", "type": { "$in": strings(&POLAR_PLAN_EVENT_TYPES) } }
}

fn polar_credits() -> Document {
    doc! { "source": "polar-webhook", "type": "billing.customer.state.changed" }
}

fn polar_rewards() -> Document {
    doc! { "source": "polar-webhook", "type": "billing.order.paid" }
}

fn polar_gifts() -> Document {
    doc! {
        "source": "polar-webhook",
        "type": "billing.order.paid",
        "payload.productId": { "$in": strings(&GIFT_PACK_PRODUCT_IDS) },
    }
}

const CHANNEL: &[Topic] = &[Topic::Channel];
const DOMAIN: &[Topic] = &[Topic::Domain];
const V1: &[f64] = &[1.0];

const fn consumer(
    consumer: &'static str,
    topics: &'static [Topic],
    admin_replay: bool,
    max_event_age_ms: Option<f64>,
    event_filter: fn() -> Document,
) -> ConsumerDefinition {
    ConsumerDefinition {
        consumer,
        topics,
        schema_versions: V1,
        admin_replay,
        max_event_age_ms,
        event_filter,
    }
}

/// `DOMAIN_EVENT_CONSUMERS`, in the reference's order (the dispatcher creates deliveries in this
/// order).
pub static CONSUMERS: [ConsumerDefinition; 15] = [
    consumer("raid-history-v1", CHANNEL, true, None, raid_history),
    consumer("stream-timeline-v1", CHANNEL, true, None, stream_timeline),
    consumer("channel-goals-v1", CHANNEL, true, None, channel_goals),
    consumer("goal-custom-contributions-v1", DOMAIN, true, None, goal_custom),
    consumer("widget-actions-v1", CHANNEL, false, Some(WIDGET_EVENT_MAX_AGE_MS), widget_actions),
    consumer("overlay-interactions-v1", CHANNEL, false, Some(86_400_000.0), overlay_interactions),
    consumer("follow-defense-v1", CHANNEL, false, Some(300_000.0), follow_defense),
    consumer("stream-analytics-v1", CHANNEL, true, None, stream_analytics),
    consumer("stream-operations-v1", CHANNEL, true, None, stream_operations),
    consumer("chat-announcements-v1", CHANNEL, false, Some(300_000.0), chat_announcements),
    consumer("account-health-notifications-v1", CHANNEL, false, Some(300_000.0), account_health),
    consumer("polar-plan-v1", DOMAIN, true, None, polar_plan),
    consumer("polar-credits-v1", DOMAIN, true, None, polar_credits),
    consumer("polar-rewards-v1", DOMAIN, true, None, polar_rewards),
    consumer("polar-gifts-v1", DOMAIN, true, None, polar_gifts),
];

/// The consumer named `name`.
pub fn consumer_named(name: &str) -> Option<&'static ConsumerDefinition> {
    CONSUMERS.iter().find(|c| c.consumer == name)
}

/// The delivery constants of the reference's runtime, ported as they are (the consumer runtime
/// package applies them; listed here so the policy is in one place).
pub mod delivery {
    /// `RETRY_DELAYS_MS`: the wait after a failed attempt, by attempt (the last repeats).
    pub const RETRY_DELAYS_MS: [i64; 4] = [5_000, 30_000, 5 * 60_000, 30 * 60_000];
    /// `PREREQUISITE_HORIZON_MS`: how long a missing prerequisite is retried.
    pub const PREREQUISITE_HORIZON_MS: i64 = 24 * 60 * 60_000;
    /// `PREREQUISITE_RETRY_MS`.
    pub const PREREQUISITE_RETRY_MS: i64 = 30_000;
    /// `METRIC_RETRY_OFFSETS_MS`: retries of a missing metric session, from `journaledAt`.
    pub const METRIC_RETRY_OFFSETS_MS: [i64; 6] = [30_000, 90_000, 210_000, 450_000, 750_000, 900_000];
    /// The metric session recovery window (`journaledAt + 900_000`).
    pub const METRIC_HORIZON_MS: i64 = 900_000;
    /// Stored error texts are cut at 8,000 UTF-16 units (`slice(0, 8_000)`).
    pub const MAX_ERROR_UTF16: usize = 8_000;
    /// `DOMAIN_EVENTS_POLL_INTERVAL_MS` default (minimum 250): the dispatcher's and each
    /// consumer's sweep when no wakeup comes.
    pub const POLL_INTERVAL_MS: i64 = 1_000;
    /// `DOMAIN_EVENTS_BATCH_SIZE` default (1 to 500).
    pub const BATCH_SIZE: i64 = 100;
    /// `DOMAIN_EVENTS_MAX_ATTEMPTS` default (at least 1).
    pub const MAX_ATTEMPTS: i64 = 5;
    /// `DOMAIN_EVENTS_LEASE_MS` default (at least 5,000).
    pub const LEASE_MS: i64 = 60_000;
    /// `DOMAIN_EVENTS_EXECUTION_TIMEOUT_MS` default.
    pub const EXECUTION_TIMEOUT_MS: i64 = 120_000;
    /// `DOMAIN_EVENTS_OPERATION_TIMEOUT_MS` default.
    pub const OPERATION_TIMEOUT_MS: i64 = 60_000;
    /// `DOMAIN_EVENTS_SHUTDOWN_GRACE_MS` default.
    pub const SHUTDOWN_GRACE_MS: i64 = 5_000;
    /// `DOMAIN_EVENTS_RESTART_DELAY_MS` default.
    pub const RESTART_DELAY_MS: i64 = 1_000;
}

#[cfg(test)]
mod tests {
    use super::*;

    fn policy(max_age: Option<f64>) -> DeliveryPolicy {
        DeliveryPolicy {
            consumer: "c".into(),
            schema_versions: Some(vec![1.0]),
            admin_replay: true,
            max_event_age_ms: max_age,
        }
    }

    #[test]
    fn decisions() {
        let event = PolicyEvent {
            schema_version: 1.0,
            occurred_at_ms: 1_000.0,
            journaled_at_ms: Some(5_000.0),
        };
        assert_eq!(evaluate(&policy(None), event, 0.0), PolicyDecision::Eligible);
        assert_eq!(
            evaluate(&policy(None), PolicyEvent { schema_version: 2.0, ..event }, 0.0),
            PolicyDecision::Dead("Unsupported schema version 2 for c".into())
        );
        // Age counts from the earlier of occurrence and journal time.
        assert_eq!(
            evaluate(&policy(Some(1_000.0)), event, 2_000.0),
            PolicyDecision::Skipped("Event exceeds maxEventAgeMs 1000 for c".into())
        );
        assert_eq!(evaluate(&policy(Some(1_000.0)), event, 1_999.0), PolicyDecision::Eligible);
        assert!(matches!(
            evaluate(&policy(Some(1.0)), PolicyEvent { occurred_at_ms: f64::NAN, ..event }, 0.0),
            PolicyDecision::Dead(_)
        ));
        assert!(can_admin_replay(Some(&policy(None)), Some((event, 10.0)), 5.0));
        assert!(!can_admin_replay(Some(&policy(None)), Some((event, 10.0)), 10.0));
        assert!(!can_admin_replay(None, Some((event, 10.0)), 5.0));
    }

    #[test]
    fn registry() {
        assert_eq!(CONSUMERS.len(), 15);
        assert!(consumer_named("polar-gifts-v1").is_some_and(|c| c.admin_replay));
        let filter = (consumer_named("widget-actions-v1").map(|c| c.event_filter))
            .map(|f| f())
            .unwrap_or_default();
        let keys: Vec<&str> = filter.keys().map(String::as_str).collect();
        assert_eq!(keys, ["source", "channelID", "type"]);
    }
}
