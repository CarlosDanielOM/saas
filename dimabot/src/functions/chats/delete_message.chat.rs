//! Native implementation of deleteMessage. The requester is attribution only;
//! the bot token and bot moderator ID are always paired.
use crate::{
    functions::{FunctionFailure, TwitchFunctions},
    utils::{
        logger::{Level, LogOptions},
        lossless_json::{JsonValue, parse_json, truthy},
        twitch::{TWITCH_BOT_ACCOUNT_ID, TwitchAuth},
    },
};
use reqwest::Method;

/// `message` is a JSON value because Helix's `error` field is returned as-is
/// by the TypeScript function, including objects and lone UTF-16 surrogates.
#[derive(Clone, Debug, PartialEq)]
pub struct DeleteMessageResponse {
    pub error: bool,
    pub message: JsonValue,
    pub status: Option<u16>,
    pub kind: Option<&'static str>,
}

fn response(
    error: bool,
    message: JsonValue,
    status: Option<u16>,
    kind: Option<&'static str>,
) -> DeleteMessageResponse {
    DeleteMessageResponse {
        error,
        message,
        status,
        kind,
    }
}
fn success() -> DeleteMessageResponse {
    response(
        false,
        JsonValue::String("Message deleted".into()),
        None,
        None,
    )
}
/// Interpret the UTF-8 bytes as Fetch's JSON body: replacement decoding and a
/// leading UTF-8 BOM are handled before JSON.parse. `null.error` throws.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum DeleteMessageBodyError {
    InvalidJson,
    NullPropertyAccess,
}

pub fn delete_message_body(
    status: u16,
    bytes: &[u8],
) -> Result<DeleteMessageResponse, DeleteMessageBodyError> {
    if status == 204 {
        return Ok(success());
    }
    let text = String::from_utf8_lossy(bytes);
    let text = text.strip_prefix('\u{feff}').unwrap_or(&text);
    let data = parse_json(text).map_err(|_| DeleteMessageBodyError::InvalidJson)?;
    match data {
        JsonValue::Null => Err(DeleteMessageBodyError::NullPropertyAccess),
        JsonValue::Object(fields) => {
            if let Some((_, value)) = fields
                .into_iter()
                .find(|(key, _)| key.as_str() == Some("error"))
                && truthy(&value)
            {
                return Ok(response(true, value, Some(status), None));
            }
            Ok(success())
        }
        _ => Ok(success()),
    }
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DeleteMessageFailure;

impl TwitchFunctions {
    pub async fn delete_message(
        &self,
        message_id: &str,
        channel_id: &str,
        mod_id: &str,
    ) -> Result<DeleteMessageResponse, DeleteMessageFailure> {
        let params = format!(
            "broadcaster_id={channel_id}&message_id={message_id}&moderator_id={TWITCH_BOT_ACCOUNT_ID}"
        );
        let result = async {
            let response = self
                .request(
                    TwitchAuth::Bot,
                    Method::DELETE,
                    "moderation/chat",
                    Some(&params),
                    None,
                    None,
                )
                .await?;
            let status = response.status().as_u16();
            if status == 204 {
                return Ok(success());
            }
            let body = response
                .bytes()
                .await
                .map_err(|_| FunctionFailure::Internal)?;
            delete_message_body(status, &body).map_err(|_| FunctionFailure::Internal)
        }
        .await;
        match result {
            Ok(result) => Ok(result),
            Err(FunctionFailure::Denied(message)) => Ok(response(
                true,
                JsonValue::String(message.into()),
                Some(403),
                Some("error"),
            )),
            Err(FunctionFailure::Internal) => {
                let payload = serde_json::json!({"function":"deleteMessage","messageID":message_id,"channelID":channel_id,"modID":mod_id,"error":"Native Twitch operation failed","stack":std::backtrace::Backtrace::force_capture().to_string()});
                if let Some(logger) = &self.logger {
                    let _report = logger
                        .log(Level::Error, payload, LogOptions::default())
                        .await;
                } else {
                    eprintln!(
                        "deleteMessage: native Twitch operation failed (no logger configured)"
                    );
                }
                Ok(response(
                    true,
                    JsonValue::String("Internal server error".into()),
                    Some(500),
                    Some("error"),
                ))
            }
        }
    }
}
