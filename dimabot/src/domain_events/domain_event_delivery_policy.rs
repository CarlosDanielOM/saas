//! Delivery policy is a pure comparison against an explicit clock. Native
//! event times use milliseconds; `None` represents an invalid Date, so invalid
//! timestamps remain fail-closed without inventing a time.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DomainEventDeliveryPolicy {
    pub consumer: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub schema_versions: Option<Vec<f64>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub admin_replay: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_event_age_ms: Option<f64>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "status", rename_all = "lowercase")]
pub enum DomainEventPolicyDecision {
    Eligible,
    Dead { reason: String },
    Skipped { reason: String },
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct DomainEventPolicyEvent {
    pub schema_version: f64,
    pub occurred_at_millis: Option<i64>,
    /// Outer None means the journal time was absent, inner None an invalid Date.
    pub journaled_at_millis: Option<Option<i64>>,
    pub expires_at_millis: Option<i64>,
}

pub fn is_domain_event_schema_compatible(
    policy: &DomainEventDeliveryPolicy,
    schema_version: f64,
) -> bool {
    policy
        .schema_versions
        .as_ref()
        .is_none_or(|versions| versions.contains(&schema_version))
}

pub fn evaluate_domain_event_delivery_policy(
    policy: &DomainEventDeliveryPolicy,
    event: &DomainEventPolicyEvent,
    now_millis: i64,
) -> DomainEventPolicyDecision {
    if !is_domain_event_schema_compatible(policy, event.schema_version) {
        return DomainEventPolicyDecision::Dead {
            reason: format!(
                "Unsupported schema version {} for {}",
                crate::utils::json_number::number_string(event.schema_version),
                policy.consumer
            ),
        };
    }
    if let Some(max_age) = policy.max_event_age_ms {
        let origin = match (event.occurred_at_millis, event.journaled_at_millis) {
            (Some(occurred), None) => Some(occurred),
            (Some(occurred), Some(Some(journaled))) => Some(occurred.min(journaled)),
            _ => None,
        };
        let Some(origin) = origin else {
            return DomainEventPolicyDecision::Dead {
                reason: format!(
                    "Invalid occurrence or journal time for age-limited consumer {}",
                    policy.consumer
                ),
            };
        };
        if (now_millis as f64) - (origin as f64) >= max_age {
            return DomainEventPolicyDecision::Skipped {
                reason: format!(
                    "Event exceeds maxEventAgeMs {} for {}",
                    crate::utils::json_number::number_string(max_age),
                    policy.consumer
                ),
            };
        }
    }
    DomainEventPolicyDecision::Eligible
}

pub fn can_admin_replay_domain_event(
    policy: Option<&DomainEventDeliveryPolicy>,
    event: Option<&DomainEventPolicyEvent>,
    now_millis: i64,
) -> bool {
    let (Some(policy), Some(event)) = (policy, event) else {
        return false;
    };
    policy.admin_replay == Some(true)
        && event
            .expires_at_millis
            .is_some_and(|expires| expires > now_millis)
        && evaluate_domain_event_delivery_policy(policy, event, now_millis)
            == DomainEventPolicyDecision::Eligible
}
