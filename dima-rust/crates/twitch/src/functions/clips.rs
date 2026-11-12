//! Clip creation, retrieval, five-hour cache, and overlay queue producer.
use super::{Envelope, has_error, payload};
use crate::{Auth, HelixError, HelixRequest, Twitch};
use dima_http::{Path, guard::BoxFuture};
use dima_store::dragonfly::{Dragonfly, SetOptions};
use serde::{Deserialize, Serialize};
use serde_json::Value;

/// Default Twitch page size (one page only).
pub const DEFAULT_CLIP_FETCH_AMOUNT: f64 = 50.0;
/// Clip cache lifetime.
pub const CLIP_CACHE_TTL_SECONDS: u64 = 18000;
/// Existing random reroll policy for callers.
pub const MAX_RANDOM_REROLLS: usize = 1;
/// Recently shown clip retention.
pub const SHOWN_CLIPS_TTL_SECONDS: u64 = 86400;
/// Twitch clip, with exactly the reference's declared fields.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct TwitchClip {
    /// Clip id.
    pub id: String,
    /// Public URL.
    pub url: String,
    /// Embed URL.
    pub embed_url: String,
    /// Broadcaster id.
    pub broadcaster_id: String,
    /// Creator id.
    pub creator_id: String,
    /// Video id.
    pub video_id: String,
    /// Creation time.
    pub created_at: String,
    /// Thumbnail URL.
    pub thumbnail_url: String,
    /// Seconds.
    pub duration: f64,
    /// VOD offset, or null.
    pub vod_offset: Option<f64>,
    /// Whether mutable.
    pub is_mutable: bool,
    /// Additional Twitch fields consumed by downstream callers.
    #[serde(flatten)]
    pub extra: serde_json::Map<String, Value>,
}
/// Create-clip options, passed to Twitch without clamping.
#[derive(Default)]
pub struct CreateClipOptions<'a> {
    /// Optional duration; NaN is omitted.
    pub duration: Option<f64>,
    /// Optional title, trimmed with JavaScript whitespace rules.
    pub title: Option<&'a str>,
}
/// Clip mutation result uses `clipID`, as the reference does.
#[derive(Debug, Serialize)]
pub struct ClipResult {
    /// Common response fields.
    #[serde(flatten)]
    pub response: Envelope<()>,
    /// New clip id.
    #[serde(rename = "clipID", skip_serializing_if = "Option::is_none")]
    pub clip_id: Option<String>,
}
impl From<Envelope<()>> for ClipResult {
    fn from(response: Envelope<()>) -> Self {
        Self {
            response,
            clip_id: None,
        }
    }
}
/// `createClip`.
pub async fn create_clip(
    twitch: &Twitch,
    channel: &str,
    options: CreateClipOptions<'_>,
) -> ClipResult {
    let mut request =
        HelixRequest::post(Path::fixed("/clips"), Auth::Bot).query("broadcaster_id", channel);
    if let Some(n) = options.duration.filter(|n| !n.is_nan()) {
        request = request.query("duration", dima_text::number_to_string(n));
    }
    if let Some(title) = options.title.map(dima_text::trim).filter(|s| !s.is_empty()) {
        request = request.query("title", title);
    }
    let response = match twitch.helix(request).await {
        Ok(r) => r,
        Err(HelixError::Credential { error, status }) => {
            return Envelope::failure(&error.message())
                .status(status)
                .kind("permission_error")
                .into();
        }
        Err(_) => {
            return Envelope::failure("Internal server error")
                .kind("error")
                .into();
        }
    };
    let status = response.status().as_u16();
    if status == 404 {
        return Envelope::failure("Broadcaster must be live to create a clip")
            .status(404)
            .kind("broadcaster_not_live")
            .into();
    }
    let Ok(body) = response.into_response().json::<Value>().await else {
        return Envelope::failure("Internal server error")
            .kind("error")
            .into();
    };
    if status != 202 {
        let mut result = Envelope::payload_error(&body).status(status);
        result.kind = body["error"].as_str().map(str::to_owned);
        return result.into();
    }
    let Some(first) = body
        .get("data")
        .and_then(Value::as_array)
        .and_then(|a| a.first())
    else {
        return Envelope::failure("Twitch accepted clip request but did not return a clip ID.")
            .status(500)
            .kind("clip_id_missing")
            .into();
    };
    ClipResult {
        response: Envelope::success("Clip created", None)
            .status(202)
            .kind("success"),
        clip_id: first["id"].as_str().map(str::to_owned),
    }
}
/// `getClip`.
pub async fn get_clip(twitch: &Twitch, id: &str) -> Envelope<TwitchClip> {
    // The reference acquires the app credential before validating the id.
    if twitch.app_credential().await.is_err() {
        return Envelope::failure("Internal server error");
    }
    if id.is_empty() {
        return Envelope::failure("Clip ID is required")
            .status(400)
            .kind("clip_id_required");
    }
    let Some(body) = payload(
        twitch,
        HelixRequest::get(Path::fixed("/clips"), Auth::App).query("id", id),
    )
    .await
    else {
        return Envelope::failure("Internal server error");
    };
    if has_error(&body) {
        let mut r = Envelope::payload_error(&body);
        r.kind = body["error"].as_str().map(str::to_owned);
        return r;
    }
    let Some(data) = body.get("data").and_then(Value::as_array) else {
        return Envelope::failure("Internal server error");
    };
    let Some(first) = data.first() else {
        return Envelope::failure("Clip not found")
            .status(404)
            .kind("clip_not_found");
    };
    match serde_json::from_value(first.clone()) {
        Ok(data) => Envelope::success("Success", Some(data)),
        Err(_) => Envelope::failure("Internal server error"),
    }
}
/// Clip key namespace. Use the same prefix for the overlay consumer; tests use unique prefixes.
pub struct ClipStore<'a> {
    /// Shared store helper, never a raw connection.
    pub dragonfly: &'a Dragonfly,
    /// Application/test namespace prefix.
    pub prefix: &'a str,
}
impl ClipStore<'_> {
    fn key(&self, channel: &str, suffix: &str) -> String {
        format!("{}twitch:{channel}:{suffix}", self.prefix)
    }
}
/// `getChannelClips`; one page, cached regardless of the requested amount.
pub async fn get_channel_clips(
    twitch: &Twitch,
    store: &ClipStore<'_>,
    channel: &str,
    amount: Option<f64>,
    skip_cache: bool,
) -> Envelope<Vec<TwitchClip>> {
    channel_clips(twitch, store, channel, amount, skip_cache)
        .await
        .unwrap_or_else(|| Envelope::failure("Internal server error"))
}
async fn channel_clips(
    twitch: &Twitch,
    store: &ClipStore<'_>,
    channel: &str,
    amount: Option<f64>,
    skip_cache: bool,
) -> Option<Envelope<Vec<TwitchClip>>> {
    let key = store.key(channel, "clips");
    if !skip_cache
        && let Some(cached) = store.dragonfly.get(&key).await.ok()?
        && !cached.is_empty()
    {
        return Some(Envelope::success(
            "Success (from cache)",
            Some(serde_json::from_slice(&cached).ok()?),
        ));
    }
    let mut request =
        HelixRequest::get(Path::fixed("/clips"), Auth::App).query("broadcaster_id", channel);
    let amount = amount.unwrap_or(DEFAULT_CLIP_FETCH_AMOUNT);
    if amount != 0.0 && !amount.is_nan() {
        request = request.query("first", dima_text::number_to_string(amount));
    }
    let body = payload(twitch, request).await?;
    if has_error(&body) {
        let mut r = Envelope::payload_error(&body);
        r.kind = body["error"].as_str().map(str::to_owned);
        return Some(r);
    }
    let clips: Vec<TwitchClip> = serde_json::from_value(body.get("data")?.clone()).ok()?;
    store
        .dragonfly
        .set(
            &key,
            &serde_json::to_vec(&clips).ok()?,
            SetOptions::ex(CLIP_CACHE_TTL_SECONDS),
        )
        .await
        .ok()?;
    Some(Envelope::success("Success", Some(clips)))
}
/// Clip overlay payload. Extra consumer-owned fields survive enqueueing.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ClipRequestData {
    /// Optional caller-provided id.
    #[serde(rename = "clipID", skip_serializing_if = "Option::is_none")]
    pub clip_id: Option<String>,
    /// Enqueue time; always overwritten by the producer.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub timestamp: Option<i64>,
    /// Fields interpreted by the overlay consumer.
    #[serde(flatten)]
    pub fields: serde_json::Map<String, Value>,
}
/// Future overlay publisher boundary. This method must not log credentials.
pub trait ClipPublisher: Send + Sync {
    /// Publish a persisted clip request to the consumer's Rust topic.
    fn publish<'a>(
        &'a self,
        channel: &'a str,
        data: &'a ClipRequestData,
    ) -> BoxFuture<'a, Result<(), ClipPublishError>>;
}
/// Queue publication failed (without leaking service details).
#[derive(Debug, thiserror::Error)]
#[error("Clip publication failed")]
pub struct ClipPublishError;
/// `checkClipConnection` (store failures mean disconnected).
pub async fn check_clip_connection(store: &ClipStore<'_>, channel: &str) -> bool {
    store
        .dragonfly
        .exists(&[&store.key(channel, "clips:connected")])
        .await
        .is_ok_and(|n| n == 1)
}
/// `generateRandomClipID`: six independently selected uppercase hex digits.
pub fn generate_random_clip_id(
    random: &dyn dima_core::Random,
) -> Result<String, dima_core::RandomError> {
    let mut bytes = [0_u8; 6];
    random.fill(&mut bytes)?;
    Ok(bytes
        .iter()
        .map(|b| char::from(b"0123456789ABCDEF"[usize::from(*b % 16)]))
        .collect())
}
// No loops. Admission and writes share one bounded script, so concurrent producers
// cannot exceed the charter's queue cap. Existing ids may still be updated at capacity.
static ENQUEUE: dima_store::dragonfly::Script = dima_store::dragonfly::Script::new(
    "twitch_clip_enqueue",
    r"if redis.call('ZCARD', KEYS[1]) >= 10000 and not redis.call('ZSCORE', KEYS[1], ARGV[3]) then return 0 end
redis.call('SET', KEYS[2], ARGV[1])
redis.call('ZADD', KEYS[1], ARGV[2], ARGV[3])
return 1",
);
/// `requestClip`: persists before publishing, and auto-processes when idle or empty.
pub async fn request_clip(
    store: &ClipStore<'_>,
    publisher: &dyn ClipPublisher,
    clock: &dyn dima_core::Clock,
    random: &dyn dima_core::Random,
    channel: &str,
    mut data: ClipRequestData,
    auto_process: bool,
) -> ClipResult {
    if !check_clip_connection(store, channel).await {
        return Envelope::failure("OBS not connected - cannot show clips").into();
    }
    let result = async {
        let queue = store.key(channel, "clips:queue");
        let length = store.dragonfly.zcard(&queue).await.ok()?;
        let processing = store
            .dragonfly
            .exists(&[&store.key(channel, "clip:processing")])
            .await
            .ok()?;
        let id = match data.clip_id.as_ref().filter(|s| !s.is_empty()) {
            Some(id) => id.clone(),
            None => generate_random_clip_id(random).ok()?,
        };
        data.clip_id = Some(id.clone());
        let timestamp = clock.now_ms();
        data.timestamp = Some(timestamp);
        let bytes = serde_json::to_vec(&data).ok()?;
        let score = timestamp.to_string();
        let accepted: i64 = ENQUEUE
            .run(
                store.dragonfly,
                &[
                    queue.as_str(),
                    &store.key(channel, &format!("clips:queue:data:{id}")),
                ],
                &[bytes.as_slice(), score.as_bytes(), id.as_bytes()],
            )
            .await
            .ok()?;
        if accepted == 0 {
            return None;
        }
        if auto_process || length == 0 || processing == 0 {
            publisher.publish(channel, &data).await.ok()?;
        }
        Some(ClipResult {
            response: Envelope::success("Clip queued successfully", None),
            clip_id: Some(id),
        })
    }
    .await;
    result.unwrap_or_else(|| Envelope::failure("Internal server error").into())
}
