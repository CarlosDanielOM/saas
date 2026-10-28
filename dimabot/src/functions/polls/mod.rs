//! Shared poll/prediction mapping; no provider or cache side effects here.

#[path = "create.poll.rs"]
mod create;
#[path = "end.poll.rs"]
mod end;
#[path = "get.poll.rs"]
mod get;

use super::{FunctionFailure, copy_fields, truthy};
use serde_json::{Value, json};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum InteractionKind {
    Poll,
    Prediction,
}
impl InteractionKind {
    pub(crate) fn endpoint(self) -> &'static str {
        match self {
            Self::Poll => "polls",
            Self::Prediction => "predictions",
        }
    }
    pub(crate) fn noun(self) -> &'static str {
        match self {
            Self::Poll => "Poll",
            Self::Prediction => "Prediction",
        }
    }
    pub(crate) fn active(self, status: Option<&str>) -> bool {
        match self {
            Self::Poll => status == Some("ACTIVE"),
            Self::Prediction => matches!(status, Some("ACTIVE" | "LOCKED")),
        }
    }
}

pub(crate) fn map_poll(poll: &Value, reading: bool) -> Result<Value, FunctionFailure> {
    let source = poll
        .get("choices")
        .and_then(Value::as_array)
        .ok_or(FunctionFailure::Internal)?;
    let choices = source
        .iter()
        .map(|choice| {
            let mut mapped = copy_fields(
                choice,
                &[("id", "id"), ("title", "title"), ("votes", "votes")],
            );
            if reading {
                mapped.insert(
                    "channelPointsVotes".into(),
                    choice
                        .get("channel_points_votes")
                        .filter(|v| !v.is_null())
                        .cloned()
                        .unwrap_or(json!(0)),
                );
            }
            Value::Object(mapped)
        })
        .collect();
    let mut result = copy_fields(
        poll,
        &[
            ("id", "id"),
            ("title", "title"),
            ("broadcaster_id", "channelID"),
            ("broadcaster_login", "channel"),
        ],
    );
    result.insert("choices".into(), Value::Array(choices));
    if reading && let Some(status) = poll.get("status") {
        result.insert("status".into(), status.clone());
    }
    Ok(Value::Object(result))
}
pub(crate) fn map_prediction(prediction: &Value, reading: bool) -> Result<Value, FunctionFailure> {
    let source = prediction
        .get("outcomes")
        .and_then(Value::as_array)
        .ok_or(FunctionFailure::Internal)?;
    let outcomes: Vec<_> = source
        .iter()
        .map(|outcome| {
            Value::Object(copy_fields(
                outcome,
                &[
                    ("id", "id"),
                    ("title", "title"),
                    ("users", "users"),
                    ("channel_points", "channel_points"),
                    ("top_predictors", "top_predictors"),
                    ("color", "color"),
                ],
            ))
        })
        .collect();
    let mut result = copy_fields(
        prediction,
        &[
            ("id", "id"),
            ("title", "title"),
            ("broadcaster_id", "channelID"),
            ("broadcaster_login", "channel"),
            ("status", "predictionStatus"),
        ],
    );
    if reading && let Some(status) = prediction.get("status") {
        result.insert("status".into(), status.clone());
    }
    if let Some(winner) = prediction
        .get("winning_outcome_id")
        .filter(|value| truthy(value))
    {
        result.insert("winning_outcome_id".into(), winner.clone());
        if let Some(outcome) = outcomes
            .iter()
            .find(|outcome| outcome.get("id") == Some(winner))
        {
            result.insert("winning_outcome".into(), outcome.clone());
        }
    }
    result.insert("outcomes".into(), Value::Array(outcomes));
    Ok(Value::Object(result))
}
pub(crate) fn map_interaction(
    kind: InteractionKind,
    value: &Value,
    reading: bool,
) -> Result<Value, FunctionFailure> {
    match kind {
        InteractionKind::Poll => map_poll(value, reading),
        InteractionKind::Prediction => map_prediction(value, reading),
    }
}

pub(crate) fn first_item(data: &Value) -> Result<&Value, FunctionFailure> {
    data.get("data")
        .and_then(Value::as_array)
        .and_then(|data| data.first())
        .ok_or(FunctionFailure::Internal)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn mappings_omit_missing_and_preserve_nulls() {
        assert_eq!(
            map_poll(
                &json!({"choices":[{"id":"one","channel_points_votes":null}],"status":"ACTIVE"}),
                true
            )
            .unwrap(),
            json!({"choices":[{"id":"one","channelPointsVotes":0}],"status":"ACTIVE"})
        );
        assert_eq!(map_prediction(&json!({"outcomes":[{"id":"one","users":null}],"winning_outcome_id":"one","status":"RESOLVED"}),false).unwrap(),json!({"outcomes":[{"id":"one","users":null}],"winning_outcome_id":"one","winning_outcome":{"id":"one","users":null},"predictionStatus":"RESOLVED"}));
    }
}
