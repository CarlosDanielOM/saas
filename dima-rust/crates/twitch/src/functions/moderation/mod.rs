//! Bot-owned moderation calls. Never retry a mutation after any transport or HTTP failure.
pub mod moderators;
use super::polls::FunctionError;
use crate::{Auth, HelixError, HelixRequest, TWITCH_BOT_ACCOUNT_ID, Twitch};
use dima_http::{HeaderMap, Path};
pub use moderators::{
    get_channel_moderators, get_twitch_moderators_ids, is_twitch_moderator_by_id,
    is_twitch_moderator_by_login,
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tokio_util::sync::CancellationToken;
/// Reference rate-limit hints; all numbers are milliseconds except remaining.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct BanRateLimits {
    /// Remaining requests.
    #[serde(rename = "rateLimitRemaining", skip_serializing_if = "Option::is_none")]
    pub remaining: Option<f64>,
    /// Reset epoch milliseconds.
    #[serde(rename = "rateLimitResetAt", skip_serializing_if = "Option::is_none")]
    pub reset_at: Option<f64>,
    /// Delay milliseconds.
    #[serde(rename = "retryAfterMs", skip_serializing_if = "Option::is_none")]
    pub retry_after: Option<f64>,
}
/// Parse numeric and HTTP-date Retry-After forms using shared JavaScript text rules.
pub fn ban_rate_limit_headers(headers: &HeaderMap, now_ms: i64) -> BanRateLimits {
    let number = |name: &str| {
        headers
            .get(name)
            .and_then(|v| v.to_str().ok())
            .filter(|s| !s.trim().is_empty())
            .map(dima_text::parse_number)
            .filter(|n| n.is_finite() && *n >= 0.0)
    };
    BanRateLimits {
        remaining: number("ratelimit-remaining"),
        reset_at: number("ratelimit-reset").map(|n| n * 1000.0),
        retry_after: number("retry-after").map(|n| n * 1000.0).or_else(|| {
            headers
                .get("retry-after")
                .and_then(|h| h.to_str().ok())
                .and_then(dima_text::parse_date)
                .map(|date| date.saturating_sub(now_ms).max(0) as f64)
        }),
    }
}
/// Successful moderation response (ban data is optional, warnings omit it).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ModerationSuccess {
    /// Always false.
    pub error: bool,
    /// User-visible message.
    pub message: String,
    /// HTTP status.
    pub status: u16,
    /// First ban result; absent for a warning or empty result.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<Value>,
    /// Ban rate-limit hints.
    #[serde(flatten)]
    pub limits: BanRateLimits,
}
/// Ban failures retain rate limits even for malformed response bodies.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ModerationFailure {
    /// Standard reference error fields.
    #[serde(flatten)]
    pub failure: FunctionError,
    /// Rate-limit hints returned by Twitch.
    #[serde(flatten)]
    pub limits: BanRateLimits,
}
impl std::fmt::Display for ModerationFailure {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        self.failure.fmt(f)
    }
}
impl std::error::Error for ModerationFailure {}
async fn execute(
    twitch: &Twitch,
    request: HelixRequest,
    warning: bool,
) -> Result<ModerationSuccess, ModerationFailure> {
    let response = twitch.helix(request).await.map_err(|e| ModerationFailure {
        failure: match e {
            HelixError::Credential { error, .. } => {
                FunctionError::new(error.message(), Some(403), Some("permission_error"))
            }
            HelixError::Http(_) => FunctionError::new(
                "Internal server error",
                warning.then_some(500),
                Some("error"),
            ),
        },
        limits: BanRateLimits::default(),
    })?;
    let code = response.status();
    let status = code.as_u16();
    let limits = if warning {
        BanRateLimits::default()
    } else {
        ban_rate_limit_headers(response.headers(), twitch.inner.clock.now_ms())
    };
    let body: Value = response
        .into_response()
        .json()
        .await
        .unwrap_or_else(|_| json!({}));
    if !code.is_success()
        || body
            .get("error")
            .is_some_and(|e| e == true || e.as_str().is_some_and(|s| !s.is_empty()))
    {
        return Err(ModerationFailure {
            failure: FunctionError::new(
                body["message"]
                    .as_str()
                    .filter(|s| !s.is_empty())
                    .or(code.canonical_reason())
                    .unwrap_or(if warning {
                        "Twitch warn request failed"
                    } else {
                        "Twitch ban request failed"
                    }),
                Some(status),
                body["error"].as_str(),
            ),
            limits,
        });
    }
    Ok(ModerationSuccess {
        error: false,
        message: if warning { "Warning issued" } else { "Success" }.into(),
        status,
        data: if warning {
            None
        } else {
            body["data"].as_array().and_then(|a| a.first()).cloned()
        },
        limits,
    })
}
/// Ban/timeout with the bot token and the caller's moderator ID (the frozen reference contract).
/// Cancellation drops and joins the request future so no late action starts after cancellation.
pub async fn ban(
    twitch: &Twitch,
    channel: &str,
    user: &str,
    moderator: &str,
    duration: Option<f64>,
    reason: Option<&str>,
    cancel: &CancellationToken,
) -> Result<ModerationSuccess, ModerationFailure> {
    let mut data = json!({"user_id":user});
    if let Some(duration) = duration.filter(|n| *n != 0.0 && !n.is_nan()) {
        data["duration"] = json!(duration);
    }
    if let Some(reason) = reason.filter(|s| !s.is_empty()) {
        data["reason"] = json!(reason);
    }
    let request = HelixRequest::post(Path::fixed("/moderation/bans"), Auth::Bot)
        .query("broadcaster_id", channel)
        .query("moderator_id", moderator)
        .json(json!({"data":data}));
    tokio::select! {biased; ()=cancel.cancelled()=>Err(ModerationFailure {failure:FunctionError::internal(true),limits:BanRateLimits::default()}), result=execute(twitch,request,false)=>result}
}
/// Issue an official warning; Twitch's 500 UTF-16-unit reason budget never cuts a scalar.
pub async fn warn_user(
    twitch: &Twitch,
    channel: &str,
    user: &str,
    reason: &str,
) -> Result<ModerationSuccess, ModerationFailure> {
    execute(twitch,HelixRequest::post(Path::fixed("/moderation/warnings"),Auth::Bot).query("broadcaster_id",channel).query("moderator_id",TWITCH_BOT_ACCOUNT_ID).json(json!({"data":{"user_id":user,"reason":dima_text::truncate_utf16_budget(reason,500)}})),true).await
}
