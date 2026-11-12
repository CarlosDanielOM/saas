//! `POST id.twitch.tv/oauth2/token`: the refresh exchange with the reference's retries, the
//! client-credentials exchange, and the reference's classification of a refused refresh.
//!
//! Wire format (`ledger/outbound.md` TW-079, TW-080): `Content-Type:
//! application/x-www-form-urlencoded`, body `client_id`, `client_secret`, `grant_type` and (for
//! a refresh) `refresh_token`, in that order, encoded as `URLSearchParams` does. Credentials go
//! in the body, never in the URL.

use crate::base::Inner;
use crate::events::{Destination, Level};
use crate::secret::RefreshToken;
use dima_http::RetryPolicy;
use serde_json::{Value, json};

/// The token endpoint, relative to the OAuth provider's base (`https://id.twitch.tv/oauth2`).
pub(crate) const TOKEN_PATH: &str = "/token";

/// Twitch's error texts (lower case) that mean the refresh token is dead and the streamer must
/// log in again (`isPermanentRefreshFailure`).
const PERMANENT_FRAGMENTS: [&str; 6] = [
    "invalid refresh token",
    "invalid refresh",
    "invalid grant",
    "authorization grant is invalid",
    "revoked",
    "authorization has been revoked",
];

/// How a refused refresh is classified.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum RefreshFailureKind {
    /// Try again later; nothing is invalidated (`transient_failure`).
    Transient,
    /// The refresh token is dead: the stored tokens are wiped and the streamer must log in
    /// again (`permanent_failure`).
    Permanent,
}

impl RefreshFailureKind {
    /// The reference's name.
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Transient => "transient_failure",
            Self::Permanent => "permanent_failure",
        }
    }
}

impl std::fmt::Display for RefreshFailureKind {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.as_str())
    }
}

/// `getRefreshFailureMessage`: the non-blank string values of `message`, `error_description`
/// and `error`, in that order, joined with ` | `; empty for anything but an object.
pub fn refresh_failure_message(payload: &Value) -> String {
    let Some(object) = payload.as_object() else {
        return String::new();
    };
    ["message", "error_description", "error"]
        .iter()
        .filter_map(|key| object.get(*key).and_then(Value::as_str))
        .filter(|text| !dima_text::trim(text).is_empty())
        .collect::<Vec<_>>()
        .join(" | ")
}

/// `isPermanentRefreshFailure`: status 400 or 401 and the message (lower case) contains one of
/// the fragments of a dead refresh token.
pub fn is_permanent_refresh_failure(status: u16, payload: &Value) -> bool {
    if !(status == 400 || status == 401) {
        return false;
    }
    let message = dima_text::to_lower(&refresh_failure_message(payload));
    PERMANENT_FRAGMENTS
        .iter()
        .any(|fragment| message.contains(fragment))
}

/// Who asked for a refresh (`RefreshContext`), for the log entries.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct RefreshContext {
    /// The endpoint or flow (`token_refresh`, `POST /auth/mock-login`).
    pub endpoint: Option<String>,
    /// The origin of the request (command, handler, route, worker).
    pub caller: Option<String>,
}

impl RefreshContext {
    /// A context naming the flow and the caller.
    pub fn new(endpoint: impl Into<String>, caller: impl Into<String>) -> Self {
        Self {
            endpoint: Some(endpoint.into()),
            caller: Some(caller.into()),
        }
    }

    pub(crate) fn endpoint_json(&self) -> Value {
        self.endpoint.as_deref().map_or(Value::Null, Value::from)
    }

    pub(crate) fn caller_json(&self) -> Value {
        self.caller.as_deref().map_or(Value::Null, Value::from)
    }
}

/// One answer of the token endpoint.
#[derive(Clone)]
pub(crate) struct TokenAnswer {
    pub(crate) status: u16,
    /// The body text (it can hold new tokens: never logged).
    pub(crate) text: String,
}

impl TokenAnswer {
    /// `response.ok`.
    pub(crate) fn ok(&self) -> bool {
        (200..300).contains(&self.status)
    }
}

impl Inner {
    /// One POST of a token form; the answer's status and body text.
    async fn post_token_form(
        &self,
        pairs: &[(&str, &str)],
    ) -> Result<TokenAnswer, dima_http::Error> {
        let response = self
            .http
            .post(&self.oauth, TOKEN_PATH)
            .form(pairs)
            .timeout(self.config.timings.oauth_timeout)
            .retry(RetryPolicy::none())
            .send()
            .await?;
        let status = response.status().as_u16();
        let text = response.text().await?;
        Ok(TokenAnswer { status, text })
    }

    /// The reference's refresh loop: up to [`crate::Timings::refresh_attempts`] attempts, a
    /// failed or 5xx attempt retried after 400 ms then 900 ms. `None` when no attempt got an
    /// answer (each failure is logged as `token_refresh_attempt_failed`).
    pub(crate) async fn post_refresh(
        &self,
        refresh_token: &RefreshToken,
        user_id: &str,
        context: &RefreshContext,
    ) -> Option<TokenAnswer> {
        let timings = &self.config.timings;
        let attempts = timings.refresh_attempts.max(1);
        let pairs = [
            ("client_id", self.config.client_id.as_str()),
            ("client_secret", self.config.client_secret.expose()),
            ("grant_type", "refresh_token"),
            ("refresh_token", refresh_token.expose()),
        ];
        let mut answer = None;
        for attempt in 0..attempts {
            answer = match self.post_token_form(&pairs).await {
                Ok(answer) => Some(answer),
                Err(error) => {
                    self.log(
                        Level::Warn,
                        Destination::Both,
                        Some(user_id),
                        json!({
                            "function": "refreshTwitchToken",
                            "userId": user_id,
                            "action": "token_refresh_attempt_failed",
                            "attempt": attempt + 1,
                            "maxAttempts": attempts,
                            "reason": error.to_string(),
                            "willRetry": attempt < attempts - 1,
                            "endpoint": context.endpoint_json(),
                            "caller": context.caller_json(),
                        }),
                    );
                    None
                }
            };
            let retryable = answer.as_ref().is_none_or(|answer| answer.status >= 500);
            if !retryable || attempt == attempts - 1 {
                break;
            }
            let pause = usize::try_from(attempt)
                .map_or(timings.backoff(usize::MAX), |index| timings.backoff(index));
            tokio::time::sleep(pause).await;
        }
        answer
    }

    /// `client_credentials` exchange (no retry, as in the reference).
    pub(crate) async fn post_client_credentials(&self) -> Result<TokenAnswer, dima_http::Error> {
        self.post_token_form(&[
            ("client_id", self.config.client_id.as_str()),
            ("client_secret", self.config.client_secret.expose()),
            ("grant_type", "client_credentials"),
        ])
        .await
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn failure_message_joins_the_three_fields() {
        assert_eq!(
            refresh_failure_message(
                &json!({"error": "Bad Request", "status": 400, "message": "Invalid refresh token"})
            ),
            "Invalid refresh token | Bad Request"
        );
        assert_eq!(
            refresh_failure_message(&json!({"message": "  ", "error_description": "x"})),
            "x"
        );
        assert_eq!(refresh_failure_message(&json!({"message": 5})), "");
        assert_eq!(refresh_failure_message(&json!("text")), "");
        assert_eq!(refresh_failure_message(&Value::Null), "");
        // Blank by JavaScript's `trim` (a no-break space and a BOM are whitespace there).
        assert_eq!(
            refresh_failure_message(&json!({"message": "\u{a0}\u{feff}"})),
            ""
        );
    }

    #[test]
    fn permanent_needs_400_or_401_and_a_known_fragment() {
        let dead = json!({"status": 400, "message": "Invalid refresh token"});
        assert!(is_permanent_refresh_failure(400, &dead));
        assert!(is_permanent_refresh_failure(401, &dead));
        assert!(!is_permanent_refresh_failure(403, &dead));
        assert!(!is_permanent_refresh_failure(500, &dead));
        assert!(is_permanent_refresh_failure(
            400,
            &json!({"error": "Authorization has been REVOKED"})
        ));
        assert!(is_permanent_refresh_failure(
            401,
            &json!({"error_description": "The authorization grant is invalid"})
        ));
        assert!(!is_permanent_refresh_failure(
            400,
            &json!({"message": "invalid client secret"})
        ));
        assert!(!is_permanent_refresh_failure(
            400,
            &json!({"message": "missing client secret"})
        ));
        assert_eq!(RefreshFailureKind::Permanent.as_str(), "permanent_failure");
    }
}
