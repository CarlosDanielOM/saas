//! Small Twitch functions, preserving the reference's per-call response envelopes.
pub mod chats;
pub mod clips;
pub mod search;
pub mod triggers;
pub mod users;

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// The reference's optional fields remain absent rather than becoming JSON null.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Envelope<T> {
    /// Whether the operation failed.
    pub error: bool,
    /// Human-facing message, when supplied by Twitch or the wrapper.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
    /// Status reported by the wrapper (not necessarily the HTTP status).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status: Option<u16>,
    /// Reference `type` field.
    #[serde(rename = "type", skip_serializing_if = "Option::is_none")]
    pub kind: Option<String>,
    /// Operation-specific data.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<T>,
}
impl<T> Envelope<T> {
    pub(crate) fn success(message: &str, data: Option<T>) -> Self {
        Self {
            error: false,
            message: Some(message.into()),
            status: None,
            kind: None,
            data,
        }
    }
    pub(crate) fn failure(message: &str) -> Self {
        Self {
            error: true,
            ..Self::success(message, None)
        }
    }
    pub(crate) fn status(mut self, status: u16) -> Self {
        self.status = Some(status);
        self
    }
    pub(crate) fn kind(mut self, kind: &str) -> Self {
        self.kind = Some(kind.into());
        self
    }
    pub(crate) fn payload_error(payload: &Value) -> Self {
        Self {
            error: true,
            message: payload
                .get("message")
                .and_then(Value::as_str)
                .map(str::to_owned),
            status: payload
                .get("status")
                .and_then(Value::as_u64)
                .and_then(|n| u16::try_from(n).ok()),
            kind: None,
            data: None,
        }
    }
}

pub(crate) fn has_error(payload: &Value) -> bool {
    payload.get("error").is_some_and(dima_text::js_truthy)
}
pub(crate) async fn payload(twitch: &crate::Twitch, request: crate::HelixRequest) -> Option<Value> {
    twitch
        .helix(request)
        .await
        .ok()?
        .into_response()
        .json::<Value>()
        .await
        .ok()
}
