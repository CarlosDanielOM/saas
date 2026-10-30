//! Native implementation of deleteMessage. The requester is attribution only;
//! the bot token and bot moderator ID are always paired.
use crate::{
    functions::{DetailedRequestFailure, FunctionFailure, TwitchFunctions},
    utils::{
        logger::{Level, LogOptions},
        lossless_json::JsonValue,
        lossless_json_document::JsonDocument,
        twitch::{TWITCH_BOT_ACCOUNT_ID, TwitchAuth},
    },
};
use reqwest::Method;
use std::sync::{Arc, OnceLock};

/// The message retains JSON values and UTF-16 exactly in a flat document.
#[derive(Clone, Debug)]
pub struct DeleteMessageResponse {
    pub error: bool,
    pub message: Arc<JsonDocument<'static>>,
    pub status: Option<u16>,
    pub kind: Option<&'static str>,
}

impl DeleteMessageResponse {
    /// Source-compatible compact JSON, including field presence and order.
    pub fn to_json_string(&self) -> String {
        let mut out = format!("{{\"error\":{},\"message\":", self.error);
        self.message.root().write_json_string(&mut out);
        if let Some(status) = self.status {
            out.push_str(&format!(",\"status\":{status}"));
        }
        if let Some(kind) = self.kind {
            out.push_str(",\"type\":");
            JsonValue::String(kind.into()).write_json_string(&mut out);
        }
        out.push('}');
        out
    }
}

fn string_document(value: &str) -> Arc<JsonDocument<'static>> {
    let json = JsonValue::String(value.into()).to_json_string();
    Arc::new(
        JsonDocument::parse(&json)
            .expect("encoded JSON string")
            .into_owned(),
    )
}
fn response(
    error: bool,
    message: Arc<JsonDocument<'static>>,
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
    static MESSAGE: OnceLock<Arc<JsonDocument<'static>>> = OnceLock::new();
    response(
        false,
        MESSAGE
            .get_or_init(|| string_document("Message deleted"))
            .clone(),
        None,
        None,
    )
}
fn internal_message() -> Arc<JsonDocument<'static>> {
    static MESSAGE: OnceLock<Arc<JsonDocument<'static>>> = OnceLock::new();
    MESSAGE
        .get_or_init(|| string_document("Internal server error"))
        .clone()
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum DeleteMessageBodyError {
    InvalidJson(String),
    NullPropertyAccess,
}

/// Decode like Fetch's JSON body and preserve the selected value without recursive ownership.
pub fn delete_message_body(
    status: u16,
    bytes: &[u8],
) -> Result<DeleteMessageResponse, DeleteMessageBodyError> {
    if status == 204 {
        return Ok(success());
    }
    let text = String::from_utf8_lossy(bytes);
    let text = text.strip_prefix('\u{feff}').unwrap_or(&text);
    let data = JsonDocument::parse(text).map_err(|_| {
        // Retain only the parser category and position, never input text.
        let error = serde_json::from_str::<&serde_json::value::RawValue>(text)
            .expect_err("document parser rejected invalid JSON");
        DeleteMessageBodyError::InvalidJson(format!(
            "Invalid JSON response body ({:?} at line {}, column {})",
            error.classify(),
            error.line(),
            error.column()
        ))
    })?;
    let root = data.root();
    if root.is_null() {
        return Err(DeleteMessageBodyError::NullPropertyAccess);
    }
    if let Some(value) = root.get("error")
        && value.truthy()
    {
        return Ok(response(
            true,
            Arc::new(value.into_owned()),
            Some(status),
            None,
        ));
    }
    Ok(success())
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DeleteMessageFailure;

enum DeleteFailure {
    Request(DetailedRequestFailure),
    Body(&'static str),
    Json(DeleteMessageBodyError),
}
impl DeleteFailure {
    fn diagnostic(&self) -> String {
        match self {
            Self::Request(DetailedRequestFailure::Twitch(error)) => error.to_string(),
            Self::Request(DetailedRequestFailure::Cancelled) => "Twitch request cancelled".into(),
            Self::Request(DetailedRequestFailure::Auth(_)) => {
                "Twitch authentication unavailable".into()
            }
            Self::Body(reason) => (*reason).into(),
            Self::Json(DeleteMessageBodyError::InvalidJson(reason)) => reason.clone(),
            Self::Json(DeleteMessageBodyError::NullPropertyAccess) => {
                "Cannot read properties of null (reading 'error')".into()
            }
        }
    }
}

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
                .request_detailed(
                    TwitchAuth::Bot,
                    Method::DELETE,
                    "moderation/chat",
                    Some(&params),
                    None,
                    None,
                )
                .await
                .map_err(DeleteFailure::Request)?;
            let status = response.status().as_u16();
            if status == 204 {
                return Ok(success());
            }
            let body = response
                .bytes()
                .await
                .map_err(|_| DeleteFailure::Body("Twitch response body could not be read"))?;
            delete_message_body(status, &body).map_err(DeleteFailure::Json)
        }
        .await;
        match result {
            Ok(result) => Ok(result),
            Err(DeleteFailure::Request(DetailedRequestFailure::Auth(FunctionFailure::Denied(
                message,
            )))) => Ok(response(
                true,
                string_document(&message),
                Some(403),
                Some("error"),
            )),
            Err(error) => {
                let payload = serde_json::json!({"function":"deleteMessage","messageID":message_id,"channelID":channel_id,"modID":mod_id,"error":error.diagnostic(),"stack":std::backtrace::Backtrace::force_capture().to_string()});
                if let Some(logger) = &self.logger {
                    let _report = logger
                        .log(Level::Error, payload, LogOptions::default())
                        .await;
                } else {
                    eprintln!(
                        "deleteMessage: native Twitch operation failed (no logger configured)"
                    );
                }
                Ok(response(true, internal_message(), Some(500), Some("error")))
            }
        }
    }
}
