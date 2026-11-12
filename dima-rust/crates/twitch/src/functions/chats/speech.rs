//! Backend speech API boundary. The API crate supplies the transport at integration time.
use super::super::{Envelope, has_error};
use crate::{AccessToken, Twitch};
use dima_http::guard::BoxFuture;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::time::Duration;

/// The backend API request, relative to its configured trusted base URL.
pub struct BackendRequest {
    /// HTTP method.
    pub method: dima_http::Method,
    /// Relative route.
    pub path: String,
    /// Optional owner credential (never printable).
    pub owner: Option<AccessToken>,
    /// JSON body; content type is application/json when present.
    pub body: Option<Value>,
    /// Total deadline; 60s supplies the charter's hang protection for unbounded reference calls.
    pub timeout: Duration,
    /// Browser cache bypass on status reads.
    pub no_store: bool,
}
/// A buffered backend reply (malformed JSON is represented by absent body).
pub struct BackendReply {
    /// HTTP status.
    pub status: u16,
    /// Parsed JSON, or None on malformed/empty body.
    pub body: Option<Value>,
}
/// Small transport interface for the future API crate. Only trusted configured API URLs are used.
pub trait BackendApi: Send + Sync {
    /// Perform this request without logging its owner token. JSON bodies set Content-Type.
    fn request(&self, request: BackendRequest)
    -> BoxFuture<'_, Result<BackendReply, BackendError>>;
}
/// Opaque transport failure; no token or URL is exposed.
#[derive(Debug, thiserror::Error)]
#[error("Backend API unavailable")]
pub struct BackendError;
/// Speech payload. Optional provider-specific metadata is retained at the API edge.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct TtsRequestBody {
    /// speak, ai or clone.
    pub mode: TtsMode,
    /// Text sent without truncation.
    pub text: String,
    /// Optional provider, voice, language, requester and metadata fields.
    #[serde(flatten)]
    pub options: serde_json::Map<String, Value>,
}
/// Supported speech modes.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TtsMode {
    /// Speak the text.
    Speak,
    /// Generate AI speech.
    Ai,
    /// Clone speech.
    Clone,
}
/// `requestTts`, including its malformed-response and HTTP-error distinctions.
pub async fn request_tts(
    api: &dyn BackendApi,
    channel: &str,
    payload: TtsRequestBody,
) -> Envelope<Value> {
    let Ok(body) = serde_json::to_value(payload) else {
        return Envelope::failure("Internal server error");
    };
    let Ok(reply) = api
        .request(BackendRequest {
            method: dima_http::Method::POST,
            path: format!("/speech/{}", dima_text::encode_uri_component(channel)),
            owner: None,
            body: Some(body),
            timeout: Duration::from_secs(60),
            no_store: false,
        })
        .await
    else {
        return Envelope::failure("Internal server error");
    };
    if !(200..300).contains(&reply.status) {
        return Envelope::failure(
            reply
                .body
                .as_ref()
                .and_then(|b| b["message"].as_str())
                .filter(|s| !s.is_empty())
                .unwrap_or("Error al enviar mensaje"),
        )
        .status(reply.status)
        .kind("error");
    }
    let Some(body) = reply.body.filter(|b| !b.is_null()) else {
        return Envelope::failure("Invalid response from speech service")
            .status(reply.status)
            .kind("error");
    };
    if has_error(&body) {
        return Envelope::payload_error(&body).kind("error");
    }
    Envelope::success("Speech sent successfully", body.get("data").cloned())
}
/// Reference spelling `speach`; originalText is the message id, not the spoken text.
pub async fn speach(
    api: &dyn BackendApi,
    message_id: &str,
    message: &str,
    channel: &str,
) -> Envelope<Value> {
    let options = json!({"meta":{"source":"chat-command","originalText":message_id}})
        .as_object()
        .cloned()
        .unwrap_or_default();
    request_tts(
        api,
        channel,
        TtsRequestBody {
            mode: TtsMode::Speak,
            text: message.into(),
            options,
        },
    )
    .await
}
/// Owner-authenticated TTS controls.
#[derive(Clone, Copy, Debug, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum TtsControlAction {
    /// Skip the playing item.
    Skip,
    /// Empty the queue.
    Clear,
    /// Refresh the connection.
    Refresh,
}
/// Validated status data (`queueLength` is a nonnegative JavaScript safe integer).
#[derive(Debug, Serialize, Deserialize)]
pub struct TtsStatusData {
    /// Overlay connected.
    pub connected: bool,
    /// Currently playing.
    pub playing: bool,
    /// Preparing audio.
    pub preparing: bool,
    /// Waiting items.
    #[serde(rename = "queueLength")]
    pub queue_length: u64,
}
/// `controlTts`.
pub async fn control_tts(
    twitch: &Twitch,
    api: &dyn BackendApi,
    channel: &str,
    action: TtsControlAction,
) -> Envelope<()> {
    let Ok(token) = twitch.streamer_token(channel, None, "controlTts").await else {
        return Envelope::failure("Reconnect the channel owner’s account in the dashboard");
    };
    let Ok(reply) = api
        .request(BackendRequest {
            method: dima_http::Method::POST,
            path: format!(
                "/speech/{}/control",
                dima_text::encode_uri_component(channel)
            ),
            owner: Some(token),
            body: Some(json!({"action":action})),
            timeout: Duration::from_secs(10),
            no_store: false,
        })
        .await
    else {
        return Envelope::failure("TTS controls are temporarily unavailable");
    };
    let Some(body) = reply.body else {
        return Envelope::failure("TTS controls are temporarily unavailable");
    };
    let mut result = Envelope::success(
        body["message"]
            .as_str()
            .filter(|s| !s.is_empty())
            .unwrap_or("TTS control failed"),
        None,
    );
    result.error = !(200..300).contains(&reply.status) || has_error(&body);
    result
}
/// `getTtsStatus`.
pub async fn get_tts_status(
    twitch: &Twitch,
    api: &dyn BackendApi,
    channel: &str,
) -> Envelope<TtsStatusData> {
    let Ok(token) = twitch.streamer_token(channel, None, "getTtsStatus").await else {
        return Envelope::failure("Reconnect the channel owner’s account in the dashboard");
    };
    let Ok(reply) = api
        .request(BackendRequest {
            method: dima_http::Method::GET,
            path: format!(
                "/speech/{}/status",
                dima_text::encode_uri_component(channel)
            ),
            owner: Some(token),
            body: None,
            timeout: Duration::from_secs(10),
            no_store: true,
        })
        .await
    else {
        return Envelope::failure("TTS status is temporarily unavailable");
    };
    let Some(body) = reply.body else {
        return Envelope::failure("TTS status is temporarily unavailable");
    };
    let data = body
        .get("data")
        .cloned()
        .and_then(|v| serde_json::from_value::<TtsStatusData>(v).ok())
        .filter(|d| d.queue_length <= 9_007_199_254_740_991);
    if !(200..300).contains(&reply.status) || has_error(&body) || data.is_none() {
        return Envelope::failure(
            body["message"]
                .as_str()
                .filter(|s| !s.is_empty())
                .unwrap_or("Unable to read TTS status"),
        );
    }
    let mut result = Envelope::success("", data);
    result.message = None;
    result
}
