//! Chat moderation wrappers. No call opts into a 401 retry.
pub mod speech;
use super::{Envelope, has_error};
use crate::{Auth, HelixError, HelixRequest, TWITCH_BOT_ACCOUNT_ID, Twitch};
use dima_http::Path;
use serde_json::{Value, json};
use std::time::Duration;

fn moderation(request: HelixRequest, channel: &str) -> HelixRequest {
    request
        .query("broadcaster_id", channel)
        .query("moderator_id", TWITCH_BOT_ACCOUNT_ID)
}
fn internal<T>() -> Envelope<T> {
    Envelope::failure("Internal server error")
        .status(500)
        .kind("error")
}
fn credential<T>(error: HelixError) -> Envelope<T> {
    match error {
        HelixError::Credential { error, status } => Envelope::failure(&error.message())
            .status(status)
            .kind("error"),
        _ => internal(),
    }
}
async fn mutation(
    twitch: &Twitch,
    request: HelixRequest,
    success: &str,
    fallback: &str,
) -> Envelope<()> {
    let response = match twitch.helix(request).await {
        Ok(r) => r,
        Err(e) => return credential(e),
    };
    let status = response.status().as_u16();
    if status == 204 {
        return Envelope::success(success, None);
    }
    match response.into_response().json::<Value>().await {
        Ok(body) => {
            let mut result = Envelope::payload_error(&body).status(status);
            result.message = Some(
                body["message"]
                    .as_str()
                    .filter(|s| !s.is_empty())
                    .unwrap_or(fallback)
                    .into(),
            );
            result.kind = body["error"].as_str().map(str::to_owned);
            result
        }
        Err(_) => internal(),
    }
}
/// `sendAnnouncement`; the supplied moderator is ignored by the reference.
pub async fn send_announcement(
    twitch: &Twitch,
    channel: &str,
    _moderator: &str,
    message: &str,
    color: Option<&str>,
) -> Envelope<()> {
    mutation(
        twitch,
        moderation(
            HelixRequest::post(Path::fixed("/chat/announcements"), Auth::Moderator),
            channel,
        )
        .json(json!({"message":message,"color":color.unwrap_or("purple")})),
        "Announcement sent",
        "Failed to send announcement",
    )
    .await
}
/// `sendShoutout`; this endpoint uses the supplied moderator id.
pub async fn send_shoutout(
    twitch: &Twitch,
    channel: &str,
    target: &str,
    moderator: &str,
) -> Envelope<()> {
    mutation(
        twitch,
        HelixRequest::post(Path::fixed("/chat/shoutouts"), Auth::Bot)
            .query("from_broadcaster_id", channel)
            .query("to_broadcaster_id", target)
            .query("moderator_id", moderator),
        "Shoutout sent",
        "Failed to send shoutout",
    )
    .await
}
async fn delete(twitch: &Twitch, channel: &str, message: Option<&str>) -> Envelope<()> {
    let mut request = HelixRequest::delete(Path::fixed("/moderation/chat"), Auth::Moderator)
        .query("broadcaster_id", channel);
    if let Some(id) = message {
        request = request.query("message_id", id);
    }
    request = request.query("moderator_id", TWITCH_BOT_ACCOUNT_ID);
    let response = match twitch.helix(request).await {
        Ok(r) => r,
        Err(e) => return credential(e),
    };
    let status = response.status().as_u16();
    if status != 204 {
        let Ok(body) = response.into_response().json::<Value>().await else {
            return internal();
        };
        if has_error(&body) {
            let mut result =
                Envelope::payload_error(&body).status(if message.is_some() { status } else { 400 });
            if message.is_some() {
                result.message = body["error"].as_str().map(str::to_owned);
            }
            return result;
        }
    }
    if message.is_some() {
        Envelope::success("Message deleted", None)
    } else {
        Envelope::success("Chat cleared", None).status(200)
    }
}
/// `clearChat`.
pub async fn clear_chat(twitch: &Twitch, channel: &str, _moderator: &str) -> Envelope<()> {
    delete(twitch, channel, None).await
}
/// `deleteMessage`.
pub async fn delete_message(
    twitch: &Twitch,
    message: &str,
    channel: &str,
    _moderator: &str,
) -> Envelope<()> {
    delete(twitch, channel, Some(message)).await
}

/// `getChatters`: only the first page is requested. The result's `data` is the reference's `chatters`.
async fn chatters(twitch: &Twitch, channel: &str, _moderator: &str) -> Envelope<Vec<Chatter>> {
    let response = match twitch
        .helix(moderation(
            HelixRequest::get(Path::fixed("/chat/chatters"), Auth::Moderator),
            channel,
        ))
        .await
    {
        Ok(r) => r,
        Err(e) => return credential(e),
    };
    let Ok(body) = response.into_response().json::<Value>().await else {
        return internal();
    };
    if has_error(&body) {
        let mut result = Envelope::payload_error(&body);
        result.kind = body["error"].as_str().map(str::to_owned);
        return result;
    }
    match body
        .get("data")
        .cloned()
        .map(serde_json::from_value)
        .transpose()
    {
        Ok(data) => Envelope::success("Success", data),
        Err(_) => internal(),
    }
}
/// `getChatters` response retains the reference's `chatters` field.
#[derive(Debug, serde::Serialize)]
pub struct ChattersResponse {
    /// Common envelope, without data.
    #[serde(flatten)]
    pub response: Envelope<()>,
    /// First page of chatters.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub chatters: Option<Vec<Chatter>>,
}
/// `getChatters`, without pagination.
pub async fn get_chatters(twitch: &Twitch, channel: &str, moderator: &str) -> ChattersResponse {
    let r = chatters(twitch, channel, moderator).await;
    ChattersResponse {
        response: Envelope {
            error: r.error,
            message: r.message,
            status: r.status,
            kind: r.kind,
            data: None,
        },
        chatters: r.data,
    }
}
/// A Helix chatter.
#[derive(Clone, Debug, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct Chatter {
    /// User id.
    pub user_id: String,
    /// Login.
    pub user_login: String,
    /// Display name.
    pub user_name: String,
}
/// `getChatSettings`. Settings are passed through to callers without field filtering.
pub async fn get_chat_settings(
    twitch: &Twitch,
    channel: &str,
    _moderator: &str,
) -> Envelope<Value> {
    let response = match twitch
        .helix(moderation(
            HelixRequest::get(Path::fixed("/chat/settings"), Auth::Moderator),
            channel,
        ))
        .await
    {
        Ok(r) => r,
        Err(HelixError::Credential { error, status }) => {
            return Envelope::failure(&error.message()).status(status);
        }
        Err(_) => return Envelope::failure("Internal server error"),
    };
    let Ok(body) = response.into_response().json::<Value>().await else {
        return Envelope::failure("Internal server error");
    };
    if has_error(&body) {
        let mut result = Envelope::failure("Error getting chat settings").status(400);
        result.data = Some(body);
        return result;
    }
    let Some(data) = body.get("data").and_then(Value::as_array) else {
        return Envelope::failure("Internal server error");
    };
    Envelope::success("success", data.first().cloned()).status(200)
}
/// `getOnlyEmotes`. Keeps the reference's accidental question mark in the first query key.
pub async fn get_only_emotes(twitch: &Twitch, channel: &str, _moderator: &str) -> Envelope<bool> {
    let response = match twitch
        .helix(
            HelixRequest::get(Path::fixed("/chat/settings"), Auth::Moderator)
                .query("?broadcaster_id", channel)
                .query("moderator_id", TWITCH_BOT_ACCOUNT_ID),
        )
        .await
    {
        Ok(r) => r,
        Err(HelixError::Credential { error, status }) => {
            return Envelope::failure(&error.message()).status(status);
        }
        Err(_) => return internal(),
    };
    let Ok(body) = response.into_response().json::<Value>().await else {
        return internal();
    };
    let Some(first) = body
        .get("data")
        .and_then(Value::as_array)
        .and_then(|a| a.first())
    else {
        return internal();
    };
    Envelope::success("Success", first.get("emote_mode").and_then(Value::as_bool)).status(200)
}
/// `setOnlyEmotes`; the query always names the bot moderator.
pub async fn set_only_emotes(
    twitch: &Twitch,
    channel: &str,
    emotes: bool,
    _moderator: &str,
) -> Envelope<Value> {
    let response = match twitch
        .helix(
            moderation(
                HelixRequest::patch(Path::fixed("/chat/settings"), Auth::Moderator),
                channel,
            )
            .json(json!({"emote_mode":emotes})),
        )
        .await
    {
        Ok(r) => r,
        Err(e) => return credential(e),
    };
    let Ok(body) = response.into_response().json::<Value>().await else {
        return internal();
    };
    if has_error(&body) {
        let mut result = Envelope::payload_error(&body);
        result.kind = body["error"].as_str().map(str::to_owned);
        return result;
    }
    let Some(data) = body.get("data").and_then(Value::as_array) else {
        return internal();
    };
    Envelope::success("Success", data.first().cloned()).status(200)
}

/// User color keeps Twitch's string-valued `error` on API failure.
#[derive(Debug, serde::Serialize)]
pub struct UserColor {
    /// Either false, true, or Twitch's error name (a reference quirk).
    pub error: Value,
    /// Error message.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
    /// Reported status.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status: Option<u16>,
    /// Color string.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub color: Option<String>,
}
/// `getUserColor`.
pub async fn get_user_color(twitch: &Twitch, user: &str) -> UserColor {
    let fail = || UserColor {
        error: json!(true),
        message: Some("Internal server error".into()),
        status: Some(500),
        color: None,
    };
    let Some(body) = super::payload(
        twitch,
        HelixRequest::get(Path::fixed("/chat/color"), Auth::App).query("user_id", user),
    )
    .await
    else {
        return fail();
    };
    if has_error(&body) {
        let result: Envelope<()> = Envelope::payload_error(&body);
        return UserColor {
            error: body["error"].clone(),
            message: result.message,
            status: result.status,
            color: None,
        };
    }
    let Some(first) = body
        .get("data")
        .and_then(Value::as_array)
        .and_then(|a| a.first())
    else {
        return fail();
    };
    UserColor {
        error: json!(false),
        message: None,
        status: None,
        color: first["color"].as_str().map(str::to_owned),
    }
}

#[allow(clippy::too_many_arguments)] // One internal descriptor for the four identical pin transports.
async fn pins(
    twitch: &Twitch,
    method: dima_http::Method,
    channel: &str,
    moderator: &str,
    message: Option<&str>,
    duration: Option<f64>,
    success: &str,
    fallback: &str,
) -> Envelope<Value> {
    if let Some(n) = duration
        && (!n.is_finite() || n.fract() != 0.0 || !(30.0..=1800.0).contains(&n))
    {
        return Envelope::failure("durationSeconds must be an integer between 30 and 1800")
            .status(400)
            .kind("validation_error");
    }
    if message.is_some_and(|m| dima_text::trim(m).is_empty()) {
        return Envelope::failure("messageID is required and must be a non-empty string")
            .status(400)
            .kind("validation_error");
    }
    let read = method == dima_http::Method::GET;
    let mut request = HelixRequest::new(method, Path::fixed("/chat/pins"), Auth::Bot)
        .query("broadcaster_id", channel)
        .query("moderator_id", moderator)
        .timeout(Duration::from_secs(10));
    if let Some(m) = message {
        request = request.query("message_id", m);
    }
    if let Some(n) = duration {
        request = request.query("duration_seconds", dima_text::number_to_string(n));
    }
    let response = match twitch.helix(request).await {
        Ok(r) => r,
        Err(e) => return credential(e),
    };
    let status = response.status().as_u16();
    if !read && status == 204 {
        return Envelope::success(success, None).status(204).kind("success");
    }
    let Ok(text) = response.into_response().text().await else {
        return internal();
    };
    let body = if text.is_empty() {
        json!({"error":"empty_response","message":"Twitch API returned an empty response"})
    } else {
        serde_json::from_str::<Value>(&text).unwrap_or_else(
            |_| json!({"error":"parse_error","message":"Failed to parse Twitch response"}),
        )
    };
    if !read || !(200..300).contains(&status) || has_error(&body) {
        let mut result = Envelope::payload_error(&body).status(status);
        result.message = Some(
            body["message"]
                .as_str()
                .filter(|m| !m.is_empty())
                .unwrap_or(fallback)
                .into(),
        );
        result.kind = body["error"].as_str().map(str::to_owned);
        return result;
    }
    Envelope::success(
        success,
        Some(
            body.get("data")
                .filter(|v| dima_text::js_truthy(*v))
                .cloned()
                .unwrap_or_else(|| json!([])),
        ),
    )
    .status(status)
}
/// `getPinnedChatMessage` (default moderator: `TWITCH_BOT_ACCOUNT_ID`).
pub async fn get_pinned_chat_message(
    twitch: &Twitch,
    channel: &str,
    moderator: &str,
) -> Envelope<Value> {
    pins(
        twitch,
        dima_http::Method::GET,
        channel,
        moderator,
        None,
        None,
        "Pinned chat message retrieved",
        "Failed to get pinned chat message",
    )
    .await
}
/// `pinChatMessage`.
pub async fn pin_chat_message(
    twitch: &Twitch,
    channel: &str,
    message: &str,
    duration: Option<f64>,
    moderator: &str,
) -> Envelope<Value> {
    pins(
        twitch,
        dima_http::Method::PUT,
        channel,
        moderator,
        Some(message),
        duration,
        "Chat message pinned",
        "Failed to pin chat message",
    )
    .await
}
/// `updatePinnedChatMessage`.
pub async fn update_pinned_chat_message(
    twitch: &Twitch,
    channel: &str,
    message: &str,
    duration: Option<f64>,
    moderator: &str,
) -> Envelope<Value> {
    pins(
        twitch,
        dima_http::Method::PATCH,
        channel,
        moderator,
        Some(message),
        duration,
        "Pinned chat message updated",
        "Failed to update pinned chat message",
    )
    .await
}
/// `unpinChatMessage`.
pub async fn unpin_chat_message(
    twitch: &Twitch,
    channel: &str,
    message: &str,
    moderator: &str,
) -> Envelope<Value> {
    pins(
        twitch,
        dima_http::Method::DELETE,
        channel,
        moderator,
        Some(message),
        None,
        "Chat message unpinned",
        "Failed to unpin chat message",
    )
    .await
}
