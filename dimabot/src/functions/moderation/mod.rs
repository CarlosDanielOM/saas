#[path = "ban.moderation.rs"]
mod ban;
#[path = "execute_action.moderation.rs"]
mod execute_action;
#[path = "get_moderators.moderation.rs"]
mod get_moderators;
#[path = "moderator_helpers.moderation.rs"]
mod helpers;
#[path = "warn.moderation.rs"]
mod warn;
pub use ban::ban_rate_limit_headers;
pub use execute_action::{ModerationExecutionInput, ModerationOffenseStep, ModerationRule};

use crate::functions::{FunctionFailure, truthy};
use serde_json::{Value, json};

pub(crate) fn moderation_failure(
    data: &Value,
    status: reqwest::StatusCode,
    fallback: &str,
) -> Option<Value> {
    if status.is_success() && !data.get("error").is_some_and(truthy) {
        return None;
    }
    let message = data
        .get("message")
        .filter(|value| truthy(value))
        .cloned()
        .or_else(|| status.canonical_reason().map(Value::from))
        .unwrap_or_else(|| fallback.into());
    let mut result = json!({"error":true,"message":message,"status":status.as_u16()});
    if let Some(kind) = data.get("error") {
        result["type"] = kind.clone();
    }
    Some(result)
}
pub(crate) fn string_array(value: &Value, key: &str) -> Result<Vec<String>, FunctionFailure> {
    value
        .get(key)
        .and_then(Value::as_array)
        .ok_or(FunctionFailure::Internal)?
        .iter()
        .map(|value| {
            value
                .as_str()
                .map(str::to_owned)
                .ok_or(FunctionFailure::Internal)
        })
        .collect()
}
