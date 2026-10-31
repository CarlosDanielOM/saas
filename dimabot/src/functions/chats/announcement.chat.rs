//! Native `sendAnnouncement` (`POST chat/announcements`).
//!
//! Source: `src/functions/chats/announcement.chat.ts`. The moderator argument is
//! attribution for the header lookup and the failure log. The Helix query always
//! sends [`TWITCH_BOT_ACCOUNT_ID`], paired with [`TwitchAuth::Bot`].
//!
//! Construction of the request and response values performs no I/O. The HTTP
//! call goes through [`TwitchFunctions::request_detailed`] (one attempt). The
//! canonical URL from [`get_twitch_helix_url`] is the source shape; the client
//! applies the same endpoint and query to its configured base, so a loopback
//! fixture never contacts Twitch.

use std::fmt;

use reqwest::Method;
use serde_json::{Value, json};

use crate::{
    functions::{DetailedRequestFailure, FunctionFailure, TwitchFunctions},
    utils::{
        links::get_twitch_helix_url,
        logger::{Destination, Level, LogOptions},
        twitch::{TWITCH_BOT_ACCOUNT_ID, TwitchAuth},
    },
};

pub const ANNOUNCEMENT_SENT: &str = "Announcement sent";
pub const ANNOUNCEMENT_FAILED: &str = "Failed to send announcement";
pub const ANNOUNCEMENT_INTERNAL_ERROR: &str = "Internal server error";
pub const DEFAULT_ANNOUNCEMENT_COLOR: &str = "purple";
pub const ANNOUNCEMENT_ENDPOINT: &str = "chat/announcements";

/// Source `SendAnnouncementResponse`. Absent `status` / `type` are `None`
/// (`undefined`, omitted by `JSON.stringify`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SendAnnouncementResponse {
    pub error: bool,
    pub message: String,
    pub status: Option<u16>,
    pub type_name: Option<String>,
}

impl SendAnnouncementResponse {
    /// `JSON.stringify` field order: `error`, `message`, then `status`, then `type`.
    pub fn to_json_string(&self) -> String {
        let mut out = String::from("{\"error\":");
        out.push_str(if self.error { "true" } else { "false" });
        out.push_str(",\"message\":");
        push_json_string(&mut out, &self.message);
        if let Some(status) = self.status {
            out.push_str(",\"status\":");
            out.push_str(&status.to_string());
        }
        if let Some(kind) = &self.type_name {
            out.push_str(",\"type\":");
            push_json_string(&mut out, kind);
        }
        out.push('}');
        out
    }
}

/// Typed failure for a header refusal, a transport problem, or a body that
/// `response.json()` would reject. `Display` is the log `error` string.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum AnnouncementFailure {
    Denied(String),
    InvalidJson(String),
    NullPropertyAccess,
    UnreadableBody,
    Cancelled,
    AuthUnavailable,
    Transport(String),
}

impl AnnouncementFailure {
    fn from_detailed(error: DetailedRequestFailure) -> Self {
        match error {
            DetailedRequestFailure::Auth(FunctionFailure::Denied(message)) => Self::Denied(message),
            DetailedRequestFailure::Auth(FunctionFailure::Internal) => Self::AuthUnavailable,
            DetailedRequestFailure::Cancelled => Self::Cancelled,
            DetailedRequestFailure::Twitch(error) => Self::Transport(error.to_string()),
        }
    }
}

impl fmt::Display for AnnouncementFailure {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Denied(message) | Self::Transport(message) => formatter.write_str(message),
            Self::InvalidJson(reason) => formatter.write_str(reason),
            Self::NullPropertyAccess => {
                formatter.write_str("Cannot read properties of null (reading 'message')")
            }
            Self::UnreadableBody => formatter.write_str("Twitch response body could not be read"),
            Self::Cancelled => formatter.write_str("Twitch request cancelled"),
            Self::AuthUnavailable => formatter.write_str("Twitch authentication unavailable"),
        }
    }
}

impl std::error::Error for AnnouncementFailure {}

/// Query, source-ordered JSON body, and canonical Helix URL for one send.
#[derive(Clone, Debug, PartialEq)]
pub struct AnnouncementRequest {
    pub endpoint: &'static str,
    pub params: String,
    pub url: String,
    pub body: Value,
    /// `JSON.stringify({ message, color })` key order. The pooled client
    /// re-serializes `body` with `serde_json`'s sorted map.
    pub body_json: String,
}

/// `color = 'purple'` only when the argument is omitted. `Some("")` is kept.
pub fn announcement_color(color: Option<&str>) -> &str {
    match color {
        Some(color) => color,
        None => DEFAULT_ANNOUNCEMENT_COLOR,
    }
}

/// `URLSearchParams` order: `broadcaster_id`, then the bot `moderator_id`.
pub fn announcement_request(channel_id: &str, message: &str, color: &str) -> AnnouncementRequest {
    let params = crate::functions::query([
        ("broadcaster_id".to_owned(), channel_id.to_owned()),
        (
            "moderator_id".to_owned(),
            TWITCH_BOT_ACCOUNT_ID.to_owned(),
        ),
    ]);
    let url = get_twitch_helix_url(ANNOUNCEMENT_ENDPOINT, Some(&params));
    let body = json!({
        "message": message,
        "color": color,
    });
    AnnouncementRequest {
        endpoint: ANNOUNCEMENT_ENDPOINT,
        params,
        url,
        body,
        body_json: announcement_body_json(message, color),
    }
}

/// Source `JSON.stringify({ message, color })`, including string escapes.
pub fn announcement_body_json(message: &str, color: &str) -> String {
    let mut out = String::from("{\"message\":");
    push_json_string(&mut out, message);
    out.push_str(",\"color\":");
    push_json_string(&mut out, color);
    out.push('}');
    out
}

pub fn announcement_success() -> SendAnnouncementResponse {
    SendAnnouncementResponse {
        error: false,
        message: ANNOUNCEMENT_SENT.to_owned(),
        status: None,
        type_name: None,
    }
}

pub fn announcement_denied(message: impl Into<String>) -> SendAnnouncementResponse {
    SendAnnouncementResponse {
        error: true,
        message: message.into(),
        status: Some(403),
        type_name: Some("error".to_owned()),
    }
}

pub fn announcement_internal_error() -> SendAnnouncementResponse {
    SendAnnouncementResponse {
        error: true,
        message: ANNOUNCEMENT_INTERNAL_ERROR.to_owned(),
        status: Some(500),
        type_name: Some("error".to_owned()),
    }
}

/// Decode one Helix response the way `sendAnnouncement` does.
///
/// 204 is success and ignores `bytes`. Any other status requires JSON.
/// A null root is the source `TypeError` from reading `.message`. A non-object
/// JSON value does not throw in JavaScript; the message falls back and `type`
/// is omitted. Non-string `message` / `error` values are not copied: a truthy
/// non-string message uses the fallback, and a non-string `error` omits `type`.
pub fn announcement_body(
    status: u16,
    bytes: &[u8],
) -> Result<SendAnnouncementResponse, AnnouncementFailure> {
    if status == 204 {
        return Ok(announcement_success());
    }
    let data: Value = serde_json::from_slice(bytes).map_err(|error| {
        AnnouncementFailure::InvalidJson(format!("Invalid JSON response body ({error})"))
    })?;
    if data.is_null() {
        return Err(AnnouncementFailure::NullPropertyAccess);
    }
    let message = match data.get("message") {
        Some(Value::String(text)) if !text.is_empty() => text.clone(),
        _ => ANNOUNCEMENT_FAILED.to_owned(),
    };
    let type_name = match data.get("error") {
        Some(Value::String(text)) => Some(text.clone()),
        _ => None,
    };
    Ok(SendAnnouncementResponse {
        error: true,
        message,
        status: Some(status),
        type_name,
    })
}

impl TwitchFunctions {
    /// Port of `sendAnnouncement(channelID, moderatorID, message, color = 'purple')`.
    ///
    /// Every source outcome is a response value. Header denial is 403 and is
    /// not logged. Anything else the source would throw is logged and returned
    /// as 500 `"Internal server error"`.
    pub async fn send_announcement(
        &self,
        channel_id: &str,
        moderator_id: &str,
        message: &str,
        color: Option<&str>,
    ) -> SendAnnouncementResponse {
        let color = announcement_color(color);
        let request = announcement_request(channel_id, message, color);
        match self.post_announcement(&request).await {
            Ok(response) => response,
            Err(AnnouncementFailure::Denied(reason)) => announcement_denied(reason),
            Err(error) => {
                self.log_send_failure(channel_id, moderator_id, message, color, &error)
                    .await;
                announcement_internal_error()
            }
        }
    }

    async fn post_announcement(
        &self,
        request: &AnnouncementRequest,
    ) -> Result<SendAnnouncementResponse, AnnouncementFailure> {
        let response = self
            .request_detailed(
                TwitchAuth::moderator(),
                Method::POST,
                request.endpoint,
                Some(&request.params),
                Some(&request.body),
                None,
            )
            .await
            .map_err(AnnouncementFailure::from_detailed)?;
        let status = response.status().as_u16();
        if status == 204 {
            return Ok(announcement_success());
        }
        let bytes = response
            .bytes()
            .await
            .map_err(|_| AnnouncementFailure::UnreadableBody)?;
        announcement_body(status, &bytes)
    }

    async fn log_send_failure(
        &self,
        channel_id: &str,
        moderator_id: &str,
        message: &str,
        color: &str,
        error: &AnnouncementFailure,
    ) {
        let payload = json!({
            "function": "sendAnnouncement",
            "channelID": channel_id,
            "moderatorID": moderator_id,
            "message": message,
            "color": color,
            "operation": "send_announcement",
            "error": error.to_string(),
            "stack": std::backtrace::Backtrace::force_capture().to_string(),
            "apiEndpoint": ANNOUNCEMENT_ENDPOINT,
            "method": "POST"
        });
        if let Some(logger) = &self.logger {
            let _report = logger
                .log(
                    Level::Error,
                    payload,
                    LogOptions {
                        destination: Destination::Both,
                        channel_id: Some(channel_id.to_owned()),
                        ..LogOptions::default()
                    },
                )
                .await;
        } else {
            eprintln!("sendAnnouncement: native Twitch operation failed (no logger configured)");
        }
    }
}

/// `JSON.stringify` string escape. Solidus stays raw. Controls and U+2028/U+2029
/// use the same short escapes as JavaScript.
fn push_json_string(out: &mut String, value: &str) {
    out.push('"');
    for character in value.chars() {
        match character {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\u{0008}' => out.push_str("\\b"),
            '\u{000c}' => out.push_str("\\f"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            control
                if (control as u32) < 0x20 || control == '\u{2028}' || control == '\u{2029}' =>
            {
                out.push_str(&format!("\\u{:04x}", control as u32));
            }
            other => out.push(other),
        }
    }
    out.push('"');
}
