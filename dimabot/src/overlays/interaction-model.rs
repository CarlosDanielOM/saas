//! Aggregate poll and prediction parsing/reduction. Predictor identities never
//! appear in this model, matching interaction-model.ts.

use super::{DomainEventContractError, time::parse_interaction_time};
use crate::utils::{js_compat, js_date};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::collections::HashSet;

pub const RESULT_DURATION_MS: u64 = 15_000;
pub const INTERACTION_EVENT_TYPES: [(&str, &str); 7] = [
    ("channel.poll.begin", "channel.poll.began"),
    ("channel.poll.progress", "channel.poll.updated"),
    ("channel.poll.end", "channel.poll.ended"),
    ("channel.prediction.begin", "channel.prediction.began"),
    ("channel.prediction.progress", "channel.prediction.updated"),
    ("channel.prediction.lock", "channel.prediction.locked"),
    ("channel.prediction.end", "channel.prediction.ended"),
];
pub const POLL_SUBSCRIPTIONS: [&str; 3] = [
    "channel.poll.begin",
    "channel.poll.progress",
    "channel.poll.end",
];
pub const PREDICTION_SUBSCRIPTIONS: [&str; 4] = [
    "channel.prediction.begin",
    "channel.prediction.progress",
    "channel.prediction.lock",
    "channel.prediction.end",
];

pub fn interaction_domain_event_type(event_type: &str) -> Option<&'static str> {
    INTERACTION_EVENT_TYPES
        .iter()
        .find_map(|(source, target)| (*source == event_type).then_some(*target))
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum InteractionKind {
    Poll,
    Prediction,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum InteractionPhase {
    Active,
    Locked,
    Completed,
    Terminated,
    Archived,
    Resolved,
    Canceled,
}
impl InteractionPhase {
    pub fn terminal(self) -> bool {
        !matches!(self, Self::Active | Self::Locked)
    }
    fn rank(self) -> u8 {
        if self.terminal() {
            2
        } else if self == Self::Locked {
            1
        } else {
            0
        }
    }
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InteractionChoice {
    pub id: String,
    pub title: String,
    pub votes: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub channel_points_votes: Option<f64>,
    pub users: f64,
    pub points: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub color: Option<String>,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InteractionState {
    pub kind: InteractionKind,
    pub id: String,
    pub title: String,
    pub phase: InteractionPhase,
    pub choices: Vec<InteractionChoice>,
    pub started_at: String,
    pub deadline: Option<String>,
    pub ended_at: Option<String>,
    pub winner_id: Option<String>,
    pub occurred_at: String,
    pub receipt: String,
    pub revision: f64,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InteractionSnapshot {
    pub poll: Option<InteractionState>,
    pub prediction: Option<InteractionState>,
    pub server_time: f64,
}

fn error(message: &str) -> DomainEventContractError {
    DomainEventContractError::new(message)
}
fn text(value: Option<&Value>, max: usize) -> Result<String, DomainEventContractError> {
    value
        .and_then(Value::as_str)
        .filter(|s| !js_compat::trim(s).is_empty() && s.encode_utf16().count() <= max)
        .map(str::to_owned)
        .ok_or_else(|| error("Invalid interaction text"))
}
fn timestamp(value: Option<&Value>) -> Result<String, DomainEventContractError> {
    let value = text(value, 40)?;
    if parse_interaction_time(&value).is_none() {
        return Err(error("Invalid interaction timestamp"));
    }
    Ok(value)
}
fn count(value: Option<&Value>, fallback: bool) -> Result<f64, DomainEventContractError> {
    let value = value.filter(|v| !v.is_null());
    let n = if value.is_none() && fallback {
        Some(0.0)
    } else {
        value.and_then(Value::as_f64)
    };
    n.filter(|n| n.is_finite() && n.fract() == 0.0 && *n >= 0.0 && *n <= 9_007_199_254_740_991.0)
        .ok_or_else(|| error("Invalid interaction count"))
}

pub fn parse_interaction(
    event_type: &str,
    event: &Map<String, Value>,
    occurred_at: &str,
    receipt: &str,
) -> Result<InteractionState, DomainEventContractError> {
    if interaction_domain_event_type(event_type).is_none() {
        return Err(error("Invalid interaction event"));
    }
    let kind = if event_type.starts_with("channel.poll.") {
        InteractionKind::Poll
    } else {
        InteractionKind::Prediction
    };
    let ending = event_type.ends_with(".end");
    let beginning = event_type.ends_with(".begin");
    let phase = if ending {
        match (kind, event.get("status").and_then(Value::as_str)) {
            (InteractionKind::Poll, Some("completed")) => InteractionPhase::Completed,
            (InteractionKind::Poll, Some("terminated")) => InteractionPhase::Terminated,
            (InteractionKind::Poll, Some("archived")) => InteractionPhase::Archived,
            (InteractionKind::Prediction, Some("resolved")) => InteractionPhase::Resolved,
            (InteractionKind::Prediction, Some("canceled")) => InteractionPhase::Canceled,
            _ => return Err(error("Invalid interaction status")),
        }
    } else if event_type.ends_with(".lock") {
        InteractionPhase::Locked
    } else {
        InteractionPhase::Active
    };
    let raw = event
        .get(if kind == InteractionKind::Poll {
            "choices"
        } else {
            "outcomes"
        })
        .and_then(Value::as_array)
        .filter(|items| {
            (2..=if kind == InteractionKind::Poll { 5 } else { 10 }).contains(&items.len())
        })
        .ok_or_else(|| error("Invalid interaction choices"))?;
    let mut choices = Vec::with_capacity(raw.len());
    let mut ids = HashSet::with_capacity(raw.len());
    for raw in raw {
        let raw = raw
            .as_object()
            .ok_or_else(|| error("Invalid interaction choice"))?;
        let votes = if kind == InteractionKind::Poll {
            count(raw.get("votes"), beginning)?
        } else {
            0.0
        };
        let channel_points_votes = if kind == InteractionKind::Poll {
            count(raw.get("channel_points_votes"), true)?
        } else {
            0.0
        };
        if channel_points_votes > votes {
            return Err(error("Channel Points votes exceed total votes"));
        }
        let id = text(raw.get("id"), 100)?;
        ids.insert(id.clone());
        choices.push(InteractionChoice {
            id,
            title: text(raw.get("title"), 200)?,
            votes,
            channel_points_votes: (kind == InteractionKind::Poll).then_some(channel_points_votes),
            users: if kind == InteractionKind::Prediction {
                count(raw.get("users"), beginning)?
            } else {
                0.0
            },
            points: if kind == InteractionKind::Prediction {
                count(raw.get("channel_points"), beginning)?
            } else {
                0.0
            },
            color: if kind == InteractionKind::Prediction {
                raw.get("color")
                    .and_then(Value::as_str)
                    .map(|s| if s == "pink" { "pink" } else { "blue" }.to_owned())
            } else {
                None
            },
        });
    }
    if ids.len() != choices.len() {
        return Err(error("Duplicate interaction choices"));
    }
    let winner_id = if kind == InteractionKind::Prediction && phase == InteractionPhase::Resolved {
        Some(text(event.get("winning_outcome_id"), 100)?)
    } else {
        None
    };
    if winner_id.as_ref().is_some_and(|id| !ids.contains(id)) {
        return Err(error("Invalid winning outcome"));
    }
    if phase == InteractionPhase::Locked {
        timestamp(event.get("locked_at"))?;
    }
    Ok(InteractionState {
        kind,
        id: text(event.get("id"), 100)?,
        title: text(event.get("title"), 200)?,
        phase,
        choices,
        started_at: timestamp(event.get("started_at"))?,
        deadline: if phase.terminal() || phase == InteractionPhase::Locked {
            None
        } else {
            Some(timestamp(event.get(if kind == InteractionKind::Poll {
                "ends_at"
            } else {
                "locks_at"
            }))?)
        },
        ended_at: if ending {
            Some(timestamp(event.get("ended_at"))?)
        } else {
            None
        },
        winner_id,
        occurred_at: timestamp(Some(&Value::String(occurred_at.to_owned())))?,
        receipt: text(Some(&Value::String(receipt.to_owned())), 200)?,
        revision: 0.0,
    })
}

/// Provider snapshots replace totals. An obsolete/duplicate snapshot returns
/// None; terminal states keep their original end time and never regress.
pub fn reduce_interaction(
    current: Option<&InteractionState>,
    mut next: InteractionState,
) -> Option<InteractionState> {
    if let Some(current) = current {
        if current.receipt == next.receipt {
            return None;
        }
        if current.id != next.id
            && js_date::parse_date(&next.started_at)
                .zip(js_date::parse_date(&current.started_at))
                .is_some_and(|(next, current)| next <= current)
        {
            return None;
        }
        if current.id == next.id {
            if next.phase.rank() < current.phase.rank() {
                return None;
            }
            if next.phase.rank() == current.phase.rank()
                && js_date::parse_date(&next.occurred_at)
                    .zip(js_date::parse_date(&current.occurred_at))
                    .is_some_and(|(next, current)| next < current)
            {
                return None;
            }
            if current.phase.terminal() && next.phase.terminal() {
                next.ended_at = current.ended_at.clone();
            }
        }
    }
    next.revision = current.map_or(0.0, |current| current.revision) + 1.0;
    Some(next)
}
