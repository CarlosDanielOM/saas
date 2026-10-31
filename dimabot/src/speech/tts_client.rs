//! Speech API client for server-to-server TTS requests.
//!
//! Ported from `dimabot/src/functions/chats/speech.chat.ts` and its test
//! `dimabot/src/functions/chats/speech.chat.test.ts`.
//!
//! Operational rules preserved:
//!
//! * The internal API base resolves exactly like the source: a truthy
//!   `INTERNAL_API_URL` wins, then `NODE_ENV === "production"` selects the
//!   compose-network host `http://dima-server:3000`, otherwise `getUrl()` from
//!   `utils/dev.ts` is consulted (`ENVIRONMENT === "production"` selects
//!   `https://api.domdimabot.com`, everything else `http://localhost:3000`).
//! * The request is one `POST {base}/speech/{channelID}` with a JSON body and
//!   `Content-Type: application/json`. There is no retry, matching the raw
//!   `fetch` in the source.
//! * Response mapping is field-for-field: non-2xx keeps the HTTP status, an
//!   unparsable body becomes `Invalid response from speech service`, a truthy
//!   `error` in the body mirrors the body's message/status, and success returns
//!   `Speech sent successfully` with `data.data`.
//! * Construction performs no I/O and reads no environment: the resolved
//!   environment is an explicit input.

use crate::utils::{
    js_string::JsString,
    logger::{Destination, Level, LogOptions, Logger},
    lossless_json::{JsonValue, parse_json, truthy},
    tts::{SpeechSource, TtsLanguage, TtsMode, TtsProvider},
};
use std::{
    fmt,
    future::Future,
    pin::Pin,
    sync::Arc,
};
use tokio::sync::watch;

pub type SpeechFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

/// Production public API base from `getUrl()`.
pub const PRODUCTION_API_URL: &str = "https://api.domdimabot.com";
/// Non-production base from `getUrl()`.
pub const LOCAL_API_URL: &str = "http://localhost:3000";
/// Production worker base: cron consumers share the API's Docker network.
pub const PRODUCTION_INTERNAL_API_URL: &str = "http://dima-server:3000";
/// Fallback text of the source's non-2xx branch.
pub const NON_OK_MESSAGE: &str = "Error al enviar mensaje";
/// Fallback text of the source's unparsable-body branch.
pub const INVALID_RESPONSE_MESSAGE: &str = "Invalid response from speech service";
/// Success text of the source.
pub const SUCCESS_MESSAGE: &str = "Speech sent successfully";
/// Catch-all text of the source's thrown-error branch.
pub const INTERNAL_ERROR_MESSAGE: &str = "Internal server error";

/// The process environment fields the source reads. Values are inputs, never
/// read at import time, so every resolution rule is unit-testable.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct SpeechEnvironment {
    pub internal_api_url: Option<String>,
    pub node_env: Option<String>,
    /// `ENVIRONMENT`, read by `isProduction()` in `utils/dev.ts`.
    pub environment: Option<String>,
}

/// A JavaScript environment value: unset and `""` are both falsy.
fn env_value(value: &Option<String>) -> Option<&str> {
    value.as_deref().filter(|value| !value.is_empty())
}

/// `getUrl()` from `utils/dev.ts`; `ENVIRONMENT === "production"` is the only
/// production signal it uses.
pub fn get_url(environment: Option<&str>) -> &'static str {
    if environment == Some("production") {
        PRODUCTION_API_URL
    } else {
        LOCAL_API_URL
    }
}

/// Resolve the internal API base with the source's exact precedence.
pub fn resolve_internal_api_url(environment: &SpeechEnvironment) -> String {
    if let Some(url) = env_value(&environment.internal_api_url) {
        return url.to_owned();
    }
    if env_value(&environment.node_env) == Some("production") {
        return PRODUCTION_INTERNAL_API_URL.to_owned();
    }
    get_url(env_value(&environment.environment)).to_owned()
}

/// `${base}/speech/${channelID}`. The source concatenates without normalizing
/// slashes, so a trailing slash in the base produces a double slash.
pub fn speech_url(base: &str, channel_id: &str) -> String {
    format!("{base}/speech/{channel_id}")
}

fn mode_name(mode: TtsMode) -> &'static str {
    match mode {
        TtsMode::Speak => "speak",
        TtsMode::Ai => "ai",
        TtsMode::Clone => "clone",
    }
}

fn provider_name(provider: TtsProvider) -> &'static str {
    match provider {
        TtsProvider::Piper => "piper",
        TtsProvider::Fish => "fish",
        TtsProvider::Kokoro => "kokoro",
    }
}

fn language_name(language: TtsLanguage) -> &'static str {
    match language {
        TtsLanguage::En => "en",
        TtsLanguage::Es => "es",
    }
}

fn source_name(source: SpeechSource) -> &'static str {
    match source {
        SpeechSource::ChatCommand => "chat-command",
        SpeechSource::Ast => "ast",
        SpeechSource::Redemption => "redemption",
    }
}

/// `requestedBy` of the source contract. Every member is optional and omitted
/// when undefined; `userLevel` keeps JavaScript's binary64 value.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct RequestedBy {
    pub user_id: Option<JsString>,
    pub user_login: Option<JsString>,
    pub user_name: Option<JsString>,
    pub user_level: Option<f64>,
}

/// `meta` of the source contract.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct TtsMeta {
    pub source: Option<SpeechSource>,
    pub original_text: Option<JsString>,
    pub skip_emotes: Option<bool>,
    pub strip_links: Option<bool>,
}

/// `TtsRequestBody`. Members serialize in the source's literal order and an
/// absent member is omitted rather than written as `null`.
#[derive(Clone, Debug, PartialEq)]
pub struct TtsRequestBody {
    pub mode: TtsMode,
    pub provider: Option<TtsProvider>,
    pub text: JsString,
    pub language: Option<TtsLanguage>,
    pub voice: Option<JsString>,
    pub clone_name: Option<JsString>,
    pub requested_by: Option<RequestedBy>,
    pub meta: Option<TtsMeta>,
}

impl Default for TtsRequestBody {
    fn default() -> Self {
        Self {
            mode: TtsMode::Speak,
            provider: None,
            text: JsString::from(""),
            language: None,
            voice: None,
            clone_name: None,
            requested_by: None,
            meta: None,
        }
    }
}

impl TtsRequestBody {
    /// JSON.stringify of the source object literal.
    pub fn to_json_value(&self) -> JsonValue {
        let mut fields: Vec<(JsString, JsonValue)> =
            vec![("mode".into(), JsonValue::String(mode_name(self.mode).into()))];
        if let Some(provider) = self.provider {
            fields.push(("provider".into(), JsonValue::String(provider_name(provider).into())));
        }
        fields.push(("text".into(), JsonValue::String(self.text.clone())));
        if let Some(language) = self.language {
            fields.push((
                "language".into(),
                JsonValue::String(language_name(language).into()),
            ));
        }
        if let Some(voice) = &self.voice {
            fields.push(("voice".into(), JsonValue::String(voice.clone())));
        }
        if let Some(clone_name) = &self.clone_name {
            fields.push(("cloneName".into(), JsonValue::String(clone_name.clone())));
        }
        if let Some(requested_by) = &self.requested_by {
            let mut members: Vec<(JsString, JsonValue)> = Vec::new();
            if let Some(value) = &requested_by.user_id {
                members.push(("userID".into(), JsonValue::String(value.clone())));
            }
            if let Some(value) = &requested_by.user_login {
                members.push(("userLogin".into(), JsonValue::String(value.clone())));
            }
            if let Some(value) = &requested_by.user_name {
                members.push(("userName".into(), JsonValue::String(value.clone())));
            }
            if let Some(value) = requested_by.user_level {
                members.push(("userLevel".into(), JsonValue::Number(value)));
            }
            fields.push(("requestedBy".into(), JsonValue::Object(members)));
        }
        if let Some(meta) = &self.meta {
            let mut members: Vec<(JsString, JsonValue)> = Vec::new();
            if let Some(value) = meta.source {
                members.push(("source".into(), JsonValue::String(source_name(value).into())));
            }
            if let Some(value) = &meta.original_text {
                members.push(("originalText".into(), JsonValue::String(value.clone())));
            }
            if let Some(value) = meta.skip_emotes {
                members.push(("skipEmotes".into(), JsonValue::Bool(value)));
            }
            if let Some(value) = meta.strip_links {
                members.push(("stripLinks".into(), JsonValue::Bool(value)));
            }
            fields.push(("meta".into(), JsonValue::Object(members)));
        }
        JsonValue::Object(fields)
    }

    pub fn to_json_string(&self) -> String {
        self.to_json_value().to_json_string()
    }
}

/// `SpeechResponse`. `message` and `status` stay JSON values because the source
/// copies `data.message` / `data.status` verbatim, including their absence.
#[derive(Clone, Debug, PartialEq)]
pub struct SpeechResponse {
    pub error: bool,
    pub message: Option<JsonValue>,
    pub status: Option<JsonValue>,
    /// The source's `type` member, written only when it was supplied.
    pub kind: Option<&'static str>,
    pub data: Option<JsonValue>,
}

impl SpeechResponse {
    /// `{error:true, message:"Internal server error"}` from the catch block.
    pub fn internal_error() -> Self {
        Self {
            error: true,
            message: Some(JsonValue::String(INTERNAL_ERROR_MESSAGE.into())),
            status: None,
            kind: None,
            data: None,
        }
    }

    /// The response's message as UTF-8 when it is a JSON string.
    pub fn message_text(&self) -> Option<String> {
        match &self.message {
            Some(JsonValue::String(value)) => Some(value.to_utf8_lossy()),
            Some(JsonValue::Number(value)) => {
                Some(crate::utils::json_number::number_string(*value))
            }
            _ => None,
        }
    }

    pub fn to_json_string(&self) -> String {
        let mut fields: Vec<(JsString, JsonValue)> =
            vec![("error".into(), JsonValue::Bool(self.error))];
        if let Some(message) = &self.message {
            fields.push(("message".into(), message.clone()));
        }
        if let Some(status) = &self.status {
            fields.push(("status".into(), status.clone()));
        }
        if let Some(kind) = self.kind {
            fields.push(("type".into(), JsonValue::String(kind.into())));
        }
        if let Some(data) = &self.data {
            fields.push(("data".into(), data.clone()));
        }
        JsonValue::Object(fields).to_json_string()
    }
}

/// A completed HTTP exchange: the status is always known, the body only when it
/// parsed as JSON.
#[derive(Clone, Debug, PartialEq)]
pub struct SpeechHttpOutcome {
    pub status: u16,
    pub body: Option<JsonValue>,
}

/// Typed failures. The source folds these into a response object; callers that
/// need the category can use [`SpeechClient::request_tts_detailed`] instead.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum SpeechTransportError {
    /// The caller's cancellation handle fired before the request completed.
    Cancelled,
    /// The request never produced a response. The driver's text is bounded and
    /// carries no credentials.
    Transport(String),
}

impl fmt::Display for SpeechTransportError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Cancelled => formatter.write_str("speech request cancelled"),
            Self::Transport(message) => write!(formatter, "speech transport failed: {message}"),
        }
    }
}

impl std::error::Error for SpeechTransportError {}

/// Explicit cancellation handle mirroring `RequestCancellation` in
/// `src/functions/mod.rs`. One typed reason channel serves both boundaries: an
/// in-flight HTTP future is dropped when the handle fires, and
/// [`SpeechCancellation::signal`] feeds `TtsSynthesisRequest::signal` so a
/// cancelled preview aborts synthesis instead of running to completion.
///
/// Not `Debug`: `tokio::sync::watch::Sender` has no `Debug` implementation.
#[derive(Clone)]
pub struct SpeechCancellation {
    sender: Arc<watch::Sender<Option<String>>>,
}

impl Default for SpeechCancellation {
    fn default() -> Self {
        Self::new()
    }
}

impl SpeechCancellation {
    /// Static abort text, so a cancellation never carries user data.
    pub const DEFAULT_REASON: &'static str = "Speech request cancelled";

    pub fn new() -> Self {
        let (sender, _) = watch::channel(None);
        Self {
            sender: Arc::new(sender),
        }
    }

    pub fn cancel(&self) {
        self.cancel_with(Self::DEFAULT_REASON);
    }

    pub fn cancel_with(&self, reason: impl Into<String>) {
        self.sender.send_replace(Some(reason.into()));
    }

    pub fn is_cancelled(&self) -> bool {
        self.sender.borrow().is_some()
    }

    /// A receiver for the typed cancellation channel of a synthesis request.
    /// `None` means running, `Some(reason)` means aborted.
    pub fn signal(&self) -> watch::Receiver<Option<String>> {
        self.sender.subscribe()
    }

    async fn cancelled(&self) {
        let mut receiver = self.sender.subscribe();
        loop {
            if receiver.borrow().is_some() {
                return;
            }
            if receiver.changed().await.is_err() {
                return;
            }
        }
    }
}

/// Map one completed exchange to the source's response object.
pub fn map_speech_outcome(outcome: SpeechHttpOutcome) -> SpeechResponse {
    let status = f64::from(outcome.status);
    let ok = (200..=299).contains(&outcome.status);
    let body_message = outcome
        .body
        .as_ref()
        .and_then(|body| body.get("message"))
        .filter(|message| truthy(*message))
        .cloned();
    if !ok {
        return SpeechResponse {
            error: true,
            message: Some(
                body_message.unwrap_or_else(|| JsonValue::String(NON_OK_MESSAGE.into())),
            ),
            status: Some(JsonValue::Number(status)),
            kind: Some("error"),
            data: None,
        };
    }
    let Some(body) = outcome.body else {
        return SpeechResponse {
            error: true,
            message: Some(JsonValue::String(INVALID_RESPONSE_MESSAGE.into())),
            status: Some(JsonValue::Number(status)),
            kind: Some("error"),
            data: None,
        };
    };
    if body.get("error").is_some_and(truthy) {
        return SpeechResponse {
            error: true,
            message: body.get("message").cloned(),
            status: body.get("status").cloned(),
            kind: Some("error"),
            data: None,
        };
    }
    SpeechResponse {
        error: false,
        message: Some(JsonValue::String(SUCCESS_MESSAGE.into())),
        status: None,
        kind: None,
        data: body.get("data").cloned(),
    }
}

/// A lazily configured client. The `reqwest::Client`, resolved environment and
/// logger are all supplied by the caller.
#[derive(Clone)]
pub struct SpeechClient {
    client: reqwest::Client,
    environment: SpeechEnvironment,
    logger: Option<Arc<Logger>>,
}

impl SpeechClient {
    pub fn new(client: reqwest::Client, environment: SpeechEnvironment) -> Self {
        Self {
            client,
            environment,
            logger: None,
        }
    }

    pub fn environment(&self) -> &SpeechEnvironment {
        &self.environment
    }

    /// Attach the shared logger used for the source's error diagnostics.
    pub fn with_logger(mut self, logger: Arc<Logger>) -> Self {
        self.logger = Some(logger);
        self
    }

    /// The full request URL for a channel under the configured environment.
    pub fn endpoint(&self, channel_id: &str) -> String {
        speech_url(&resolve_internal_api_url(&self.environment), channel_id)
    }

    async fn diagnose(&self, channel_id: &str, payload: &TtsRequestBody, error: &str) {
        let Some(logger) = &self.logger else {
            eprintln!("[DEV NOTIFICATION - ERROR]: requestTts failed for {channel_id}: {error}");
            return;
        };
        let body = payload.to_json_value().to_json_string();
        let payload_value =
            serde_json::from_str(&body).unwrap_or(serde_json::Value::Null);
        let data = serde_json::json!({
            "function": "requestTts",
            "channelID": channel_id,
            "payload": payload_value,
            "error": error,
        });
        let _ = logger
            .log(
                Level::Error,
                data,
                LogOptions {
                    destination: Destination::Both,
                    channel_id: Some(channel_id.to_owned()),
                    ..Default::default()
                },
            )
            .await;
    }

    /// One `POST` attempt. No retry and no deadline are added here; the caller
    /// configures both on the injected `reqwest::Client`.
    pub async fn send(
        &self,
        channel_id: &str,
        payload: &TtsRequestBody,
        cancel: Option<&SpeechCancellation>,
    ) -> Result<SpeechHttpOutcome, SpeechTransportError> {
        if cancel.is_some_and(SpeechCancellation::is_cancelled) {
            return Err(SpeechTransportError::Cancelled);
        }
        let url = self.endpoint(channel_id);
        let body = payload.to_json_string();
        let request = async {
            let response = self
                .client
                .post(&url)
                .header(reqwest::header::CONTENT_TYPE, "application/json")
                .body(body)
                .send()
                .await
                .map_err(|error| SpeechTransportError::Transport(error.to_string()))?;
            let status = response.status().as_u16();
            // `response.json().catch(() => null)`: a body that is not JSON is
            // reported as absent rather than failing the exchange.
            let text = response
                .text()
                .await
                .map_err(|error| SpeechTransportError::Transport(error.to_string()))?;
            let body = parse_json(&text).ok();
            Ok(SpeechHttpOutcome { status, body })
        };
        match cancel {
            Some(cancel) => {
                tokio::select! {
                    biased;
                    _ = cancel.cancelled() => Err(SpeechTransportError::Cancelled),
                    result = request => result,
                }
            }
            None => request.await,
        }
    }

    /// Typed variant: transport and cancellation failures are errors, and every
    /// HTTP outcome is still mapped in [`map_speech_outcome`].
    pub async fn request_tts_detailed(
        &self,
        channel_id: &str,
        payload: &TtsRequestBody,
        cancel: Option<&SpeechCancellation>,
    ) -> Result<SpeechResponse, SpeechTransportError> {
        let outcome = self.send(channel_id, payload, cancel).await?;
        Ok(map_speech_outcome(outcome))
    }

    /// `requestTts`. A thrown request is logged and folded into the source's
    /// `Internal server error` response.
    pub async fn request_tts(
        &self,
        channel_id: &str,
        payload: &TtsRequestBody,
    ) -> SpeechResponse {
        self.request_tts_cancellable(channel_id, payload, None).await
    }

    pub async fn request_tts_cancellable(
        &self,
        channel_id: &str,
        payload: &TtsRequestBody,
        cancel: Option<&SpeechCancellation>,
    ) -> SpeechResponse {
        match self.request_tts_detailed(channel_id, payload, cancel).await {
            Ok(response) => response,
            Err(error) => {
                self.diagnose(channel_id, payload, &error.to_string()).await;
                SpeechResponse::internal_error()
            }
        }
    }
}

/// `speach(messageID, message, channelID)`: always a chat-command speak request
/// whose `originalText` is the command's message ID.
pub async fn speach(
    client: &SpeechClient,
    message_id: &str,
    message: &str,
    channel_id: &str,
) -> SpeechResponse {
    client
        .request_tts(channel_id, &speach_payload(message_id, message))
        .await
}

/// The payload [`speach`] sends.
pub fn speach_payload(message_id: &str, message: &str) -> TtsRequestBody {
    TtsRequestBody {
        mode: TtsMode::Speak,
        text: JsString::from(message),
        meta: Some(TtsMeta {
            source: Some(SpeechSource::ChatCommand),
            original_text: Some(JsString::from(message_id)),
            ..Default::default()
        }),
        ..Default::default()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn url(environment: SpeechEnvironment) -> String {
        speech_url(&resolve_internal_api_url(&environment), "fixture")
    }

    // Row 1 of speech.chat.test.ts: production workers need no legacy
    // ENVIRONMENT setting.
    #[test]
    fn production_node_env_reaches_the_compose_api() {
        let environment = SpeechEnvironment {
            node_env: Some("production".into()),
            ..Default::default()
        };
        assert_eq!(url(environment), "http://dima-server:3000/speech/fixture");
    }

    // Row 2: a legacy ENVIRONMENT does not change the production worker base.
    #[test]
    fn production_node_env_wins_over_a_legacy_environment() {
        let environment = SpeechEnvironment {
            node_env: Some("production".into()),
            environment: Some("production".into()),
            ..Default::default()
        };
        assert_eq!(url(environment), "http://dima-server:3000/speech/fixture");
    }

    // Row 3: an explicit internal URL always wins.
    #[test]
    fn explicit_internal_api_url_wins() {
        let environment = SpeechEnvironment {
            node_env: Some("production".into()),
            internal_api_url: Some("http://custom-api:3100".into()),
            ..Default::default()
        };
        assert_eq!(url(environment), "http://custom-api:3100/speech/fixture");
    }

    // Row 4: development falls back to getUrl(), which is localhost without a
    // production ENVIRONMENT.
    #[test]
    fn development_uses_the_local_api() {
        let environment = SpeechEnvironment {
            node_env: Some("development".into()),
            ..Default::default()
        };
        assert_eq!(url(environment), "http://localhost:3000/speech/fixture");
    }

    // Derived row: isProduction() reads ENVIRONMENT only, so a non-production
    // NODE_ENV still selects the public production API from getUrl().
    #[test]
    fn legacy_production_environment_selects_the_public_api() {
        let environment = SpeechEnvironment {
            environment: Some("production".into()),
            ..Default::default()
        };
        assert_eq!(url(environment), "https://api.domdimabot.com/speech/fixture");
    }

    #[test]
    fn empty_environment_values_are_falsy() {
        let environment = SpeechEnvironment {
            internal_api_url: Some(String::new()),
            node_env: Some(String::new()),
            environment: Some(String::new()),
        };
        assert_eq!(url(environment), "http://localhost:3000/speech/fixture");
    }

    #[test]
    fn body_omits_absent_members_and_keeps_source_order() {
        let payload = TtsRequestBody {
            mode: TtsMode::Clone,
            provider: Some(TtsProvider::Fish),
            text: JsString::from("hola"),
            language: Some(TtsLanguage::Es),
            clone_name: Some(JsString::from("gojo")),
            meta: Some(TtsMeta {
                source: Some(SpeechSource::Redemption),
                original_text: Some(JsString::from("raw")),
                skip_emotes: Some(true),
                strip_links: None,
            }),
            ..Default::default()
        };
        assert_eq!(
            payload.to_json_string(),
            r#"{"mode":"clone","provider":"fish","text":"hola","language":"es","cloneName":"gojo","meta":{"source":"redemption","originalText":"raw","skipEmotes":true}}"#
        );
    }

    #[test]
    fn non_ok_status_keeps_the_http_status_and_body_message() {
        let outcome = SpeechHttpOutcome {
            status: 500,
            body: Some(JsonValue::Object(vec![(
                "message".into(),
                JsonValue::String(JsString::from("boom")),
            )])),
        };
        let response = map_speech_outcome(outcome);
        assert!(response.error);
        assert_eq!(response.status, Some(JsonValue::Number(500.0)));
        assert_eq!(response.message_text().as_deref(), Some("boom"));
        assert_eq!(
            response.to_json_string(),
            r#"{"error":true,"message":"boom","status":500,"type":"error"}"#
        );
    }

    #[test]
    fn non_ok_status_without_a_body_uses_the_spanish_fallback() {
        let response = map_speech_outcome(SpeechHttpOutcome {
            status: 404,
            body: None,
        });
        assert_eq!(
            response.to_json_string(),
            r#"{"error":true,"message":"Error al enviar mensaje","status":404,"type":"error"}"#
        );
    }

    #[test]
    fn unparsable_success_body_is_reported_as_invalid() {
        let response = map_speech_outcome(SpeechHttpOutcome {
            status: 200,
            body: None,
        });
        assert_eq!(
            response.to_json_string(),
            r#"{"error":true,"message":"Invalid response from speech service","status":200,"type":"error"}"#
        );
    }

    #[test]
    fn body_error_mirrors_the_body_message_and_status() {
        let body = parse_json(r#"{"error":true,"message":"disabled","status":403}"#)
            .expect("fixture JSON");
        let response = map_speech_outcome(SpeechHttpOutcome {
            status: 200,
            body: Some(body),
        });
        assert_eq!(
            response.to_json_string(),
            r#"{"error":true,"message":"disabled","status":403,"type":"error"}"#
        );
    }

    #[test]
    fn success_returns_the_body_data() {
        let body = parse_json(r#"{"error":false,"data":{"speechID":"fixture"}}"#)
            .expect("fixture JSON");
        let response = map_speech_outcome(SpeechHttpOutcome {
            status: 200,
            body: Some(body),
        });
        assert!(!response.error);
        assert_eq!(
            response.to_json_string(),
            r#"{"error":false,"message":"Speech sent successfully","data":{"speechID":"fixture"}}"#
        );
    }

    #[test]
    fn cancellation_carries_a_typed_reason_for_synthesis() {
        let cancellation = SpeechCancellation::new();
        let signal = cancellation.signal();
        assert!(!cancellation.is_cancelled());
        assert_eq!(signal.borrow().as_deref(), None);
        cancellation.cancel_with("Preview disconnected");
        assert!(cancellation.is_cancelled());
        assert_eq!(
            signal.borrow().as_deref(),
            Some("Preview disconnected")
        );
    }

    #[test]
    fn speach_uses_the_chat_command_meta() {        assert_eq!(
            speach_payload("message-id", "hello").to_json_string(),
            r#"{"mode":"speak","text":"hello","meta":{"source":"chat-command","originalText":"message-id"}}"#
        );
    }
}
