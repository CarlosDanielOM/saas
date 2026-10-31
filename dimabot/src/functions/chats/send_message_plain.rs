//! Context-free, plain-text Twitch chat sender.
//!
//! This is the reusable concrete half of `src/functions/chats/send_message.chat.ts`:
//! a call with **no** `SendMessageContext`, a non-blank `message`, and no reply
//! target. It uses the existing native app-token acquisition, pooled Helix
//! client, single-attempt request policy, and shared logger. Construction stays
//! in `TwitchFunctions`; this module performs no I/O outside a request.
//!
//! Source behavior preserved:
//! - `TwitchAuth::App` (the app token, never a streamer token).
//! - `sender_id` is always [`TWITCH_BOT_ACCOUNT_ID`] (`698614112`).
//! - `POST chat/messages` with `broadcaster_id`, `sender_id`, `message`, and
//!   `for_source_only: true`.
//! - A blank message is delivered to `deliverAstMessage` by the source. With no
//!   command references and an empty `parsedText`, that call has no effects and
//!   resolves `{ error: false, message: 'AST message delivered', status: 200 }`.
//!   This port returns that same result without any request.
//! - A rejected HTTP status logs `sendTwitchChatMessage.twitchRejected` and
//!   returns the remote `message`/`error` fields with the real status.
//! - `is_sent === false` logs `sendTwitchChatMessage.heldForModeration` and
//!   returns the held-for-moderation error with `data[0]`.
//! - A successful send returns `{ error: false, message: 'Message sent', ... }`;
//!   the source's post-send `deliverAstMessage('', undefined)` has no effects and
//!   is intentionally not re-issued.
//!
//! Explicit migration boundaries (not silently claimed):
//! - `context` handling, AST command references, the special-command parser,
//!   `literalArguments`/variables/plan context, and `replyToMessageId` remain
//!   separate work. No generic trait-only chat mock is introduced here.
//! - Source log payloads include an ISO `timestamp` and (for the catch branch) a
//!   `stack`. The native logger records its own `timestamp` on the entry and has
//!   no JavaScript stack; those two fields are not duplicated in the payload.
//! - Native logger reports are best-effort: a failing log sink never changes the
//!   send result. The source awaits its logger, whose sink failures could reject.
//! - JSON object key order is not preserved by the existing native request body
//!   (`serde_json::Value` maps are sorted); fields and values are identical.
//! - Redirects are not followed, matching the existing native `TwitchClient`
//!   policy (credentials are never forwarded); the source `fetch` would follow
//!   them by default. The native client has no default timeout, as in the source.
//! - JSON syntax-error and transport-error `reason` strings use the native
//!   diagnostic text, not V8/undici wording. Status/held/token reasons match.
//! - Ordinary declared Twitch response shapes are handled. A non-array
//!   `data.data` (undefined by the Helix contract) is rejected as a failed send
//!   instead of emulating JavaScript primitive indexing.
//! - Cancellation is a native addition; the source has no cancellation token.

use crate::{
    functions::{DetailedRequestFailure, RequestCancellation, TwitchFunctions},
    utils::{
        logger::{Level, LogOptions},
        twitch::{TWITCH_BOT_ACCOUNT_ID, TwitchAuth},
    },
};
use reqwest::Method;
use serde::Serialize;
use serde_json::{Map, Value};

pub const SENT_MESSAGE: &str = "Message sent";
pub const AST_MESSAGE_DELIVERED: &str = "AST message delivered";
pub const TOKEN_FAILURE: &str = "Failed to get Twitch app token";
pub const HELD_MESSAGE: &str = "Message held for moderation review by Twitch";
pub const HELD_REASON: &str = "Twitch held the message for moderator review (is_sent=false). Bot account may be unverified, new, or triggering AutoMod holds in this channel.";
pub const SEND_FAILURE: &str = "Error sending Twitch chat message";
pub const CANCELLED_REASON: &str = "Twitch request cancelled";

/// Source field order is retained by struct serialization even though the
/// shared `serde_json::Value` map sorts keys.
#[derive(Serialize)]
struct PlainChatBody<'a> {
    broadcaster_id: &'a str,
    sender_id: &'static str,
    message: &'a str,
    for_source_only: bool,
}

/// Source-shaped result of a context-free chat send. `None` means the source
/// property was `undefined` and `to_json` omits it.
#[derive(Clone, Debug, PartialEq)]
pub struct PlainMessageResponse {
    pub error: bool,
    pub message: Option<Value>,
    pub status: u16,
    pub kind: Option<Value>,
    pub reason: Option<String>,
    pub data: Option<Value>,
}

impl PlainMessageResponse {
    /// `JSON.stringify`-compatible object: `undefined` fields are omitted.
    pub fn to_json(&self) -> Value {
        let mut object = Map::new();
        object.insert("error".into(), Value::Bool(self.error));
        if let Some(message) = &self.message {
            object.insert("message".into(), message.clone());
        }
        object.insert("status".into(), Value::from(self.status));
        if let Some(kind) = &self.kind {
            object.insert("type".into(), kind.clone());
        }
        if let Some(reason) = &self.reason {
            object.insert("reason".into(), Value::String(reason.clone()));
        }
        if let Some(data) = &self.data {
            object.insert("data".into(), data.clone());
        }
        Value::Object(object)
    }

    /// Source `response.message || default`, then `new Error(value)` coercion.
    pub fn message_text_or(&self, default: &str) -> String {
        match &self.message {
            Some(value) if crate::functions::truthy(value) => js_value_string(value),
            _ => default.to_owned(),
        }
    }
}

/// `String(value)` for a JSON value, used for source `new Error(value)`.
pub(crate) fn js_value_string(value: &Value) -> String {
    match value {
        Value::Null => "null".into(),
        Value::Bool(value) => value.to_string(),
        Value::Number(value) => value
            .as_f64()
            .map(crate::utils::json_number::number_string)
            .unwrap_or_else(|| value.to_string()),
        Value::String(value) => value.clone(),
        Value::Array(items) => items
            .iter()
            .map(js_array_element)
            .collect::<Vec<_>>()
            .join(","),
        Value::Object(_) => "[object Object]".into(),
    }
}

/// `Array.prototype.join` element semantics (`undefined` becomes empty).
fn js_array_element(value: &Value) -> String {
    match value {
        Value::Null => String::new(),
        Value::Array(items) => items
            .iter()
            .map(js_array_element)
            .collect::<Vec<_>>()
            .join(","),
        other => js_value_string(other),
    }
}

fn token_failure() -> PlainMessageResponse {
    PlainMessageResponse {
        error: true,
        message: Some(Value::String(TOKEN_FAILURE.into())),
        status: 500,
        kind: Some(Value::String("error".into())),
        reason: Some(TOKEN_FAILURE.into()),
        data: None,
    }
}

fn caught(reason: String) -> PlainMessageResponse {
    PlainMessageResponse {
        error: true,
        message: Some(Value::String(SEND_FAILURE.into())),
        status: 500,
        kind: Some(Value::String("error".into())),
        reason: Some(reason),
        data: None,
    }
}

fn delivered() -> PlainMessageResponse {
    PlainMessageResponse {
        error: false,
        message: Some(Value::String(AST_MESSAGE_DELIVERED.into())),
        status: 200,
        kind: Some(Value::String("success".into())),
        reason: None,
        data: None,
    }
}

fn held(status: u16, data: Value) -> PlainMessageResponse {
    PlainMessageResponse {
        error: true,
        message: Some(Value::String(HELD_MESSAGE.into())),
        status,
        kind: Some(Value::String("held_for_moderation".into())),
        reason: Some(HELD_REASON.into()),
        data: Some(data),
    }
}

impl TwitchFunctions {
    /// Send one non-blank plain chat message as the bot application.
    pub async fn send_message_plain(
        &self,
        channel_id: &str,
        message: &str,
    ) -> PlainMessageResponse {
        self.send_message_plain_with_cancellation(channel_id, message, None)
            .await
    }

    /// Native cancellation seam. Source-parity work uses the variant above with
    /// no cancellation token.
    pub async fn send_message_plain_with_cancellation(
        &self,
        channel_id: &str,
        message: &str,
        cancel: Option<&RequestCancellation>,
    ) -> PlainMessageResponse {
        // The source checks `message.trim()` but sends the original text.
        if crate::utils::js_compat::trim(message).is_empty() {
            return delivered();
        }

        let body = PlainChatBody {
            broadcaster_id: channel_id,
            sender_id: TWITCH_BOT_ACCOUNT_ID,
            message,
            for_source_only: true,
        };
        let body = serde_json::to_value(&body).expect("plain chat body serializes");
        let response = self
            .request_detailed(
                TwitchAuth::App,
                Method::POST,
                "chat/messages",
                None,
                Some(&body),
                cancel,
            )
            .await;

        let response = match response {
            Ok(response) => response,
            Err(DetailedRequestFailure::Auth(_)) => {
                self.log_chat(
                    channel_id,
                    serde_json::json!({
                        "function": "sendTwitchChatMessage.getAppToken",
                        "channelID": channel_id,
                        "sender_id": TWITCH_BOT_ACCOUNT_ID,
                        "messagePreview": crate::functions::prefix_utf16(message, 120),
                        "error": TOKEN_FAILURE,
                    }),
                )
                .await;
                return token_failure();
            }
            Err(DetailedRequestFailure::Cancelled) => {
                self.log_chat(
                    channel_id,
                    serde_json::json!({
                        "function": "sendTwitchChatMessage",
                        "channelID": channel_id,
                        "sender_id": TWITCH_BOT_ACCOUNT_ID,
                        "messagePreview": crate::functions::prefix_utf16(message, 120),
                        "error": CANCELLED_REASON,
                    }),
                )
                .await;
                return caught(CANCELLED_REASON.into());
            }
            Err(DetailedRequestFailure::Twitch(error)) => {
                let reason = error.to_string();
                self.log_chat(
                    channel_id,
                    serde_json::json!({
                        "function": "sendTwitchChatMessage",
                        "channelID": channel_id,
                        "sender_id": TWITCH_BOT_ACCOUNT_ID,
                        "messagePreview": crate::functions::prefix_utf16(message, 120),
                        "error": reason,
                    }),
                )
                .await;
                return caught(reason);
            }
        };

        let status = response.status().as_u16();
        let bytes = match response.bytes().await {
            Ok(bytes) => bytes,
            Err(error) => {
                return self
                    .caught_with_log(channel_id, message, error.to_string())
                    .await;
            }
        };
        let text = String::from_utf8_lossy(&bytes);
        let data: Value = match serde_json::from_str(&text) {
            Ok(data) => data,
            Err(error) => {
                return self
                    .caught_with_log(channel_id, message, error.to_string())
                    .await;
            }
        };

        if !(200..=299).contains(&status) {
            // Source evaluates `data.message`; only `null` throws there.
            if data.is_null() {
                return self
                    .caught_with_log(
                        channel_id,
                        message,
                        "Cannot read properties of null (reading 'message')".into(),
                    )
                    .await;
            }
            let mut payload = Map::new();
            payload.insert(
                "function".into(),
                Value::String("sendTwitchChatMessage.twitchRejected".into()),
            );
            payload.insert("channelID".into(), Value::String(channel_id.into()));
            payload.insert(
                "sender_id".into(),
                Value::String(TWITCH_BOT_ACCOUNT_ID.into()),
            );
            payload.insert(
                "messagePreview".into(),
                Value::String(crate::functions::prefix_utf16(message, 120)),
            );
            payload.insert("httpStatus".into(), Value::from(status));
            if let Some(error) = data.get("error") {
                payload.insert("twitchError".into(), error.clone());
            }
            if let Some(message) = data.get("message") {
                payload.insert("twitchMessage".into(), message.clone());
            }
            payload.insert("tokenSource".into(), Value::String("appToken".into()));
            self.log_chat(channel_id, Value::Object(payload)).await;
            return PlainMessageResponse {
                error: true,
                message: data.get("message").cloned(),
                status,
                kind: data.get("error").cloned(),
                reason: None,
                data: None,
            };
        }

        let first = data
            .get("data")
            .and_then(Value::as_array)
            .and_then(|items| items.first());
        let is_sent = first.and_then(|item| item.get("is_sent"));
        if is_sent == Some(&Value::Bool(false)) {
            let first = first.cloned().unwrap_or(Value::Null);
            let mut payload = Map::new();
            payload.insert(
                "function".into(),
                Value::String("sendTwitchChatMessage.heldForModeration".into()),
            );
            payload.insert("channelID".into(), Value::String(channel_id.into()));
            payload.insert(
                "sender_id".into(),
                Value::String(TWITCH_BOT_ACCOUNT_ID.into()),
            );
            payload.insert(
                "messagePreview".into(),
                Value::String(crate::functions::prefix_utf16(message, 120)),
            );
            payload.insert("httpStatus".into(), Value::from(status));
            if let Some(message_id) = first.get("message_id") {
                payload.insert("twitchMessageId".into(), message_id.clone());
            }
            payload.insert("twitchIsSent".into(), Value::Bool(false));
            payload.insert("reason".into(), Value::String(HELD_REASON.into()));
            payload.insert("tokenSource".into(), Value::String("appToken".into()));
            self.log_chat(channel_id, Value::Object(payload)).await;
            return held(status, first);
        }

        // The source's final `data.data[0]` is undefined for an empty array;
        // JSON.stringify omits that field but the send is still successful.
        let empty_data = data
            .get("data")
            .and_then(Value::as_array)
            .is_some_and(Vec::is_empty);
        if first.is_none() && !empty_data {
            let reason = if data.is_null() {
                "Cannot read properties of null (reading 'data')"
            } else if data
                .get("data")
                .is_some_and(|value| !value.is_array() && !value.is_null())
            {
                "Twitch response data was not an array"
            } else if data.get("data").is_some_and(Value::is_null) {
                "Cannot read properties of null (reading '0')"
            } else {
                "Cannot read properties of undefined (reading '0')"
            };
            return self
                .caught_with_log(channel_id, message, reason.into())
                .await;
        }

        PlainMessageResponse {
            error: false,
            message: Some(Value::String(SENT_MESSAGE.into())),
            status,
            kind: Some(Value::String("success".into())),
            reason: None,
            data: first.cloned(),
        }
    }

    async fn caught_with_log(
        &self,
        channel_id: &str,
        message: &str,
        reason: String,
    ) -> PlainMessageResponse {
        self.log_chat(
            channel_id,
            serde_json::json!({
                "function": "sendTwitchChatMessage",
                "channelID": channel_id,
                "sender_id": TWITCH_BOT_ACCOUNT_ID,
                "messagePreview": crate::functions::prefix_utf16(message, 120),
                "error": reason.clone(),
            }),
        )
        .await;
        caught(reason)
    }

    async fn log_chat(&self, channel_id: &str, data: Value) {
        if let Some(logger) = &self.logger {
            let _ = logger
                .log(
                    Level::Error,
                    data,
                    LogOptions {
                        channel_id: Some(channel_id.into()),
                        ..Default::default()
                    },
                )
                .await;
        }
    }
}
