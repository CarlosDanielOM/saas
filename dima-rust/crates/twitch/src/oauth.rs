//! `POST id.twitch.tv/oauth2/token`: the refresh exchange with the reference's retries, the
//! client-credentials exchange, and the reference's classification of a refused refresh.
//!
//! Wire format (`ledger/outbound.md` TW-079, TW-080): `Content-Type:
//! application/x-www-form-urlencoded`, body `client_id`, `client_secret`, `grant_type` and (for
//! a refresh) `refresh_token`, in that order, encoded as `URLSearchParams` does. Credentials go
//! in the body, never in the URL.
//!
//! # Secrets in memory (review finding 7)
//!
//! The buffers this crate owns are wiped when dropped: the form body (built once, sized up
//! front, released through `Bytes::from_owner`), the answer's body (read chunk by chunk into a
//! wiping buffer), the strings parsed from it ([`AnswerBody`]: tokens and Twitch's messages),
//! the tokens themselves ([`crate::AccessToken`], [`crate::RefreshToken`]) and the directory's
//! decrypted tokens. Not wiped, because the libraries own them: hyper's and reqwest's read and
//! write buffers and the `Bytes` chunks they hand over, rustls's TLS records, serde_json's
//! scratch buffer for strings with escapes, the `Authorization` header value
//! (`http::HeaderValue`, marked sensitive but not wiped), and the drivers' buffers for MongoDB
//! and Dragonfly (which only ever see envelopes).

use crate::base::Inner;
use crate::events::{Destination, Level};
use crate::secret::RefreshToken;
use bytes::Bytes;
use dima_core::SecretString;
use dima_http::RetryPolicy;
use serde::de::{Deserialize, Deserializer, IgnoredAny, MapAccess, SeqAccess, Visitor};
use serde_json::{Value, json};
use std::borrow::Cow;
use zeroize::{Zeroize, Zeroizing};

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

/// Why a refresh gave no credentials: a category, never Twitch's own text.
///
/// Twitch's answer is classified from its private text (which can echo the refresh token, an
/// access token or an e-mail) and then dropped: logs, errors and their `Debug` carry this
/// category and the HTTP status only.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum RefreshFailureReason {
    /// Twitch says the refresh token is invalid (permanent: `invalid refresh token`, `invalid
    /// grant`, ...).
    InvalidGrant,
    /// Twitch says the authorization was revoked (permanent).
    Revoked,
    /// Twitch refused the app's credentials (`invalid client`, `invalid client secret`).
    InvalidClient,
    /// Twitch reports a missing parameter.
    MissingParameter,
    /// 429.
    RateLimited,
    /// 5xx.
    ServerError,
    /// Any other refusal (another 4xx, or a 2xx carrying an `error` field).
    Refused,
    /// The answer was not JSON.
    Unparseable,
    /// A 2xx without both tokens.
    IncompletePayload,
    /// No attempt got an answer (network error or deadline).
    Network,
    /// The Twitch account is not in MongoDB.
    UserNotFound,
    /// The refresh token asked for is no longer the stored one, whose access token is not
    /// usable: nothing was sent.
    RotatedElsewhere,
    /// A store failed.
    Store,
    /// The refresh stopped before it produced a result (the process is stopping).
    Interrupted,
    /// Another refresh of this streamer is (or may be) in flight: nothing was sent, or a refusal
    /// could not be blamed on the stored token (it may have been consumed by that refresh).
    ExchangeInFlight,
    /// MongoDB holds no refresh token for the streamer: nothing was sent.
    NoRefreshToken,
}

impl RefreshFailureReason {
    /// A stable name for logs.
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::InvalidGrant => "invalid_grant",
            Self::Revoked => "revoked",
            Self::InvalidClient => "invalid_client",
            Self::MissingParameter => "missing_parameter",
            Self::RateLimited => "rate_limited",
            Self::ServerError => "server_error",
            Self::Refused => "refused",
            Self::Unparseable => "unparseable_refresh_response",
            Self::IncompletePayload => "incomplete_payload",
            Self::Network => "network_error_after_retries",
            Self::UserNotFound => "user_not_found",
            Self::RotatedElsewhere => "rotated_elsewhere",
            Self::Store => "store_failed",
            Self::Interrupted => "interrupted",
            Self::ExchangeInFlight => "exchange_in_flight",
            Self::NoRefreshToken => "no_refresh_token",
        }
    }

    /// A fixed English sentence (the reference's own text where it wrote one).
    pub const fn message(self) -> &'static str {
        match self {
            Self::InvalidGrant => "Twitch refused the refresh token",
            Self::Revoked => "Twitch reports that the authorization was revoked",
            Self::InvalidClient => "Twitch refused the app credentials",
            Self::MissingParameter => "Twitch reports a missing parameter",
            Self::RateLimited => "Twitch rate-limited the token refresh",
            Self::ServerError => "Twitch failed to answer the token refresh",
            Self::Refused => "Twitch refused the token refresh",
            Self::Unparseable => "Failed to parse Twitch token refresh response",
            Self::IncompletePayload => "Twitch token refresh returned incomplete payload",
            Self::Network => "Network error while refreshing Twitch token",
            Self::UserNotFound => "User not found while storing refreshed token",
            Self::RotatedElsewhere => {
                "The stored token was already rotated by a concurrent refresh"
            }
            Self::Store => "The token store failed",
            Self::Interrupted => "The refresh was interrupted",
            Self::ExchangeInFlight => "Another refresh of this streamer is in flight",
            Self::NoRefreshToken => "The streamer has no stored refresh token",
        }
    }
}

impl std::fmt::Display for RefreshFailureReason {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.as_str())
    }
}

/// Classifies a refused answer (`!response.ok || data.error`): the reference's permanent test
/// first ([`is_permanent_refresh_failure`]), then a category from the status and the private
/// message. Nothing of the text leaves this function.
pub fn classify_refusal(
    status: u16,
    payload: &Value,
) -> (RefreshFailureKind, RefreshFailureReason) {
    let message = Zeroizing::new(dima_text::to_lower(&refresh_failure_message(payload)));
    classify_message(status, &message)
}

fn classify_message(status: u16, message: &str) -> (RefreshFailureKind, RefreshFailureReason) {
    if is_permanent_message(status, message) {
        let reason = if message.contains("revoked") {
            RefreshFailureReason::Revoked
        } else {
            RefreshFailureReason::InvalidGrant
        };
        return (RefreshFailureKind::Permanent, reason);
    }
    let reason = match status {
        429 => RefreshFailureReason::RateLimited,
        500.. => RefreshFailureReason::ServerError,
        _ if message.contains("client") => RefreshFailureReason::InvalidClient,
        _ if message.contains("missing") => RefreshFailureReason::MissingParameter,
        _ => RefreshFailureReason::Refused,
    };
    (RefreshFailureKind::Transient, reason)
}

/// `getRefreshFailureMessage`: the non-blank string values of `message`, `error_description`
/// and `error`, in that order, joined with ` | `; empty for anything but an object. The text is
/// Twitch's and may echo a credential: it is only classified, never logged or returned.
pub fn refresh_failure_message(payload: &Value) -> String {
    let Some(object) = payload.as_object() else {
        return String::new();
    };
    ["message", "error_description", "error"]
        .iter()
        .filter_map(|key| object.get(*key).and_then(Value::as_str))
        .filter(|text| !dima_text::trim(text).is_empty())
        .collect::<Vec<_>>()
        .join(SEPARATOR)
}

/// `isPermanentRefreshFailure`: status 400 or 401 and the message (lower case) contains one of
/// the fragments of a dead refresh token.
pub fn is_permanent_refresh_failure(status: u16, payload: &Value) -> bool {
    is_permanent_message(
        status,
        &dima_text::to_lower(&refresh_failure_message(payload)),
    )
}

fn is_permanent_message(status: u16, lower: &str) -> bool {
    (status == 400 || status == 401)
        && PERMANENT_FRAGMENTS
            .iter()
            .any(|fragment| lower.contains(fragment))
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

/// Whether a request that failed this way may have been processed by Twitch: anything but a
/// failure to connect, a request that was never built or sent, or a wait for a slot.
fn may_have_reached_twitch(class: dima_http::FailureClass) -> bool {
    use dima_http::{FailureClass as F, TimeoutKind as T};
    !matches!(
        class,
        F::Connect
            | F::Timeout(T::Queue | T::Connect)
            | F::Blocked
            | F::Invalid
            | F::RequestTooLarge
    )
}

/// One value of Twitch's answer, kept only as far as the pipeline reads it.
#[derive(Default)]
pub(crate) enum Field {
    /// Not in the answer.
    #[default]
    Absent,
    /// A JSON string (wiped when dropped: it can be a token, or echo one).
    Text(SecretString),
    /// A JSON number.
    Number(f64),
    /// Anything else, with its JavaScript truthiness.
    Other(bool),
}

impl Field {
    /// `Boolean(value)`.
    pub(crate) fn truthy(&self) -> bool {
        match self {
            Self::Absent => false,
            Self::Text(text) => !text.is_empty(),
            Self::Number(number) => *number != 0.0 && !number.is_nan(),
            Self::Other(truthy) => *truthy,
        }
    }

    /// The string, when the value is one.
    pub(crate) fn text(&self) -> Option<&str> {
        match self {
            Self::Text(text) => Some(text.expose()),
            _ => None,
        }
    }

    /// Moves a non-empty string out (no copy).
    pub(crate) fn take_text(&mut self) -> Option<SecretString> {
        match std::mem::take(self) {
            Self::Text(text) if !text.is_empty() => Some(text),
            _ => None,
        }
    }
}

impl<'de> Deserialize<'de> for Field {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        struct Visit;
        impl<'de> Visitor<'de> for Visit {
            type Value = Field;
            fn expecting(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                f.write_str("a JSON value")
            }
            fn visit_bool<E>(self, value: bool) -> Result<Field, E> {
                Ok(Field::Other(value))
            }
            fn visit_i64<E>(self, value: i64) -> Result<Field, E> {
                Ok(Field::Number(value as f64))
            }
            fn visit_u64<E>(self, value: u64) -> Result<Field, E> {
                Ok(Field::Number(value as f64))
            }
            fn visit_f64<E>(self, value: f64) -> Result<Field, E> {
                Ok(Field::Number(value))
            }
            fn visit_str<E>(self, value: &str) -> Result<Field, E> {
                Ok(Field::Text(SecretString::new(value.to_owned())))
            }
            fn visit_string<E>(self, value: String) -> Result<Field, E> {
                Ok(Field::Text(SecretString::new(value)))
            }
            fn visit_unit<E>(self) -> Result<Field, E> {
                Ok(Field::Other(false))
            }
            fn visit_none<E>(self) -> Result<Field, E> {
                Ok(Field::Other(false))
            }
            fn visit_some<D: Deserializer<'de>>(self, inner: D) -> Result<Field, D::Error> {
                Field::deserialize(inner)
            }
            fn visit_seq<A: SeqAccess<'de>>(self, mut seq: A) -> Result<Field, A::Error> {
                while seq.next_element::<IgnoredAny>()?.is_some() {}
                Ok(Field::Other(true))
            }
            fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<Field, A::Error> {
                while map.next_entry::<IgnoredAny, IgnoredAny>()?.is_some() {}
                Ok(Field::Other(true))
            }
        }
        deserializer.deserialize_any(Visit)
    }
}

/// Twitch's answer to a token request: the fields the pipeline reads, each string in a wiping
/// buffer; everything else is skipped without being kept. An answer that is not a JSON object
/// has none of them (the reference reads properties of whatever `JSON.parse` gave).
#[derive(Default)]
pub(crate) struct AnswerBody {
    pub(crate) access_token: Field,
    pub(crate) refresh_token: Field,
    pub(crate) expires_in: Field,
    pub(crate) message: Field,
    pub(crate) error_description: Field,
    pub(crate) error: Field,
}

impl<'de> Deserialize<'de> for AnswerBody {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        struct Visit;
        impl<'de> Visitor<'de> for Visit {
            type Value = AnswerBody;
            fn expecting(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                f.write_str("a JSON value")
            }
            fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<AnswerBody, A::Error> {
                let mut body = AnswerBody::default();
                // A repeated key keeps its last value, as `JSON.parse` does.
                while let Some(key) = map.next_key::<String>()? {
                    let slot = match key.as_str() {
                        "access_token" => &mut body.access_token,
                        "refresh_token" => &mut body.refresh_token,
                        "expires_in" => &mut body.expires_in,
                        "message" => &mut body.message,
                        "error_description" => &mut body.error_description,
                        "error" => &mut body.error,
                        _ => {
                            map.next_value::<IgnoredAny>()?;
                            continue;
                        }
                    };
                    *slot = map.next_value()?;
                }
                Ok(body)
            }
            fn visit_seq<A: SeqAccess<'de>>(self, mut seq: A) -> Result<AnswerBody, A::Error> {
                while seq.next_element::<IgnoredAny>()?.is_some() {}
                Ok(AnswerBody::default())
            }
            fn visit_bool<E>(self, _: bool) -> Result<AnswerBody, E> {
                Ok(AnswerBody::default())
            }
            fn visit_i64<E>(self, _: i64) -> Result<AnswerBody, E> {
                Ok(AnswerBody::default())
            }
            fn visit_u64<E>(self, _: u64) -> Result<AnswerBody, E> {
                Ok(AnswerBody::default())
            }
            fn visit_f64<E>(self, _: f64) -> Result<AnswerBody, E> {
                Ok(AnswerBody::default())
            }
            fn visit_str<E>(self, _: &str) -> Result<AnswerBody, E> {
                Ok(AnswerBody::default())
            }
            fn visit_unit<E>(self) -> Result<AnswerBody, E> {
                Ok(AnswerBody::default())
            }
        }
        deserializer.deserialize_any(Visit)
    }
}

/// What [`refresh_failure_message`] puts between two texts.
const SEPARATOR: &str = " | ";

/// The most a lower-case mapping multiplies a text's UTF-8 length by (the largest growth is a
/// two-byte letter becoming three bytes, such as `İ` → `i̇`; three leaves room to spare).
const LOWER_CASE_GROWTH: usize = 3;

/// `text` in lower case, in a wiping buffer sized once for the longest possible result (review
/// F6: a buffer that grows leaves its earlier allocation unwiped). Character by character, so
/// a final capital sigma becomes `σ` where `toLowerCase` gives `ς`: no fragment the
/// classification looks for contains either.
fn lower_case_wiped(text: &str) -> Zeroizing<String> {
    let mut lower = Zeroizing::new(String::with_capacity(
        text.len().saturating_mul(LOWER_CASE_GROWTH),
    ));
    for character in text.chars() {
        lower.extend(character.to_lowercase());
    }
    lower
}

impl AnswerBody {
    /// [`refresh_failure_message`] of this answer, in a wiping buffer reserved at its full
    /// length before it is filled, so it never grows (review F6).
    fn failure_message(&self) -> Zeroizing<String> {
        let parts: Vec<&str> = [&self.message, &self.error_description, &self.error]
            .into_iter()
            .filter_map(Field::text)
            .filter(|text| !dima_text::trim(text).is_empty())
            .collect();
        let length = parts.iter().map(|part| part.len()).sum::<usize>()
            + SEPARATOR.len() * parts.len().saturating_sub(1);
        let mut joined = Zeroizing::new(String::with_capacity(length));
        for (index, part) in parts.into_iter().enumerate() {
            if index > 0 {
                joined.push_str(SEPARATOR);
            }
            joined.push_str(part);
        }
        joined
    }

    /// [`classify_refusal`] of this answer; the text never leaves a wiping buffer.
    pub(crate) fn classify(&self, status: u16) -> (RefreshFailureKind, RefreshFailureReason) {
        let lower = lower_case_wiped(&self.failure_message());
        classify_message(status, &lower)
    }
}

/// Parses an answer's bytes as the reference does (`text()`, lossy UTF-8, then `JSON.parse`;
/// empty text is `{}`), and the UTF-16 length of the text (for the log). Every copy made on the
/// way is wiped.
pub(crate) fn parse_answer(body: &[u8]) -> (Result<AnswerBody, serde_json::Error>, usize) {
    let text = String::from_utf8_lossy(body);
    let length = dima_text::utf16_len(&text);
    let parsed = if text.is_empty() {
        Ok(AnswerBody::default())
    } else {
        let sanitized = dima_text::sanitize_lone_surrogates(text.as_bytes());
        let parsed = serde_json::from_slice(&sanitized);
        if let Cow::Owned(mut copy) = sanitized {
            copy.zeroize();
        }
        parsed
    };
    if let Cow::Owned(mut copy) = text {
        copy.zeroize();
    }
    (parsed, length)
}

/// `URLSearchParams` encoding of `pairs`, in a buffer sized up front (no reallocation leaves a
/// copy behind) and wiped when the HTTP stack drops its last reference to it.
pub(crate) fn form_body(pairs: &[(&str, &str)]) -> Bytes {
    use url::form_urlencoded::byte_serialize;
    let encoded_len = |text: &str| byte_serialize(text.as_bytes()).map(str::len).sum::<usize>();
    let size = pairs
        .iter()
        .map(|(name, value)| encoded_len(name) + encoded_len(value) + 2)
        .sum();
    let mut out = Zeroizing::new(Vec::with_capacity(size));
    for (index, (name, value)) in pairs.iter().enumerate() {
        if index > 0 {
            out.push(b'&');
        }
        for piece in byte_serialize(name.as_bytes()) {
            out.extend_from_slice(piece.as_bytes());
        }
        out.push(b'=');
        for piece in byte_serialize(value.as_bytes()) {
            out.extend_from_slice(piece.as_bytes());
        }
    }
    Bytes::from_owner(out)
}

/// Reads a response body into a wiping buffer; when it must grow, the old buffer is wiped.
async fn read_body(
    mut response: dima_http::Response,
) -> Result<Zeroizing<Vec<u8>>, dima_http::Error> {
    let hint = usize::try_from(response.content_length().unwrap_or(0).min(64 * 1024)).unwrap_or(0);
    let mut body = Zeroizing::new(Vec::with_capacity(hint));
    while let Some(chunk) = response.chunk().await? {
        let needed = body.len() + chunk.len();
        if needed > body.capacity() {
            let mut bigger = Zeroizing::new(Vec::with_capacity(needed.max(body.capacity() * 2)));
            bigger.extend_from_slice(&body);
            body = bigger;
        }
        body.extend_from_slice(&chunk);
    }
    Ok(body)
}

/// One answer of the token endpoint.
pub(crate) struct TokenAnswer {
    pub(crate) status: u16,
    /// The body (it can hold new tokens: never logged), wiped when dropped.
    pub(crate) body: Zeroizing<Vec<u8>>,
}

impl Inner {
    /// One POST of a token form; the answer's status and body text. A refresh exchange goes
    /// through the exchange client and lives until the drain ends (see `crate::drain`); the
    /// client-credentials request stops with the process.
    async fn post_token_form(
        &self,
        pairs: &[(&str, &str)],
        exchange: bool,
    ) -> Result<TokenAnswer, dima_http::Error> {
        let request = if exchange {
            self.exchange_http
                .post(&self.oauth, TOKEN_PATH)
                .cancel_on(&self.drain_expired)
        } else {
            self.http.post(&self.oauth, TOKEN_PATH)
        };
        let response = request
            .header("content-type", "application/x-www-form-urlencoded")
            .body(form_body(pairs))
            .timeout(self.config.timings.oauth_timeout)
            .retry(RetryPolicy::none())
            .send()
            .await?;
        let status = response.status().as_u16();
        let body = read_body(response).await?;
        Ok(TokenAnswer { status, body })
    }

    /// The reference's refresh loop: up to [`crate::Timings::refresh_attempts`] attempts, a
    /// failed or 5xx attempt retried after 400 ms then 900 ms. `None` when no attempt got an
    /// answer (each failure is logged as `token_refresh_attempt_failed`). The flag says whether
    /// a failed attempt may have reached Twitch (its outcome is then unknown).
    pub(crate) async fn post_refresh(
        &self,
        refresh_token: &RefreshToken,
        user_id: &str,
        context: &RefreshContext,
    ) -> (Option<TokenAnswer>, bool) {
        let timings = &self.config.timings;
        let attempts = timings.refresh_attempts.max(1);
        let pairs = [
            ("client_id", self.config.client_id.as_str()),
            ("client_secret", self.config.client_secret.expose()),
            ("grant_type", "refresh_token"),
            ("refresh_token", refresh_token.expose()),
        ];
        let mut answer = None;
        let mut uncertain = false;
        for attempt in 0..attempts {
            answer = match self.post_token_form(&pairs, true).await {
                Ok(answer) => Some(answer),
                Err(error) => {
                    uncertain |= may_have_reached_twitch(error.class());
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
            // No new attempt once the process is stopping: one already sent may still answer,
            // a new one could leave a rotation nobody waits for.
            if !retryable || attempt == attempts - 1 || self.shutdown.is_triggered() {
                break;
            }
            let pause = usize::try_from(attempt)
                .map_or(timings.backoff(usize::MAX), |index| timings.backoff(index));
            tokio::select! {
                () = self.shutdown.wait() => break,
                () = tokio::time::sleep(pause) => {}
            }
        }
        (answer, uncertain)
    }

    /// `client_credentials` exchange (no retry, as in the reference).
    pub(crate) async fn post_client_credentials(&self) -> Result<TokenAnswer, dima_http::Error> {
        self.post_token_form(
            &[
                ("client_id", self.config.client_id.as_str()),
                ("client_secret", self.config.client_secret.expose()),
                ("grant_type", "client_credentials"),
            ],
            false,
        )
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
    fn field_truthiness_is_javascripts() {
        let field = |json: &str| {
            let (body, _) = parse_answer(format!(r#"{{"error":{json}}}"#).as_bytes());
            body.unwrap().error.truthy()
        };
        assert!(!AnswerBody::default().error.truthy());
        for falsy in ["null", "\"\"", "0", "false", "0.0"] {
            assert!(!field(falsy), "{falsy}");
        }
        for truthy in ["\"x\"", "1", "-1", "true", "[]", "{}"] {
            assert!(field(truthy), "{truthy}");
        }
    }

    #[test]
    fn the_form_body_is_encoded_like_url_search_params_in_a_wiping_buffer() {
        let body = form_body(&[
            ("client_id", "id"),
            ("client_secret", "s e/c+r&t=é"),
            ("grant_type", "refresh_token"),
            ("refresh_token", "r👋"),
        ]);
        assert_eq!(
            &body[..],
            b"client_id=id&client_secret=s+e%2Fc%2Br%26t%3D%C3%A9&grant_type=refresh_token&refresh_token=r%F0%9F%91%8B"
        );
        fn wiped<T: zeroize::ZeroizeOnDrop>() {}
        wiped::<Zeroizing<Vec<u8>>>();
        wiped::<SecretString>();
    }

    #[test]
    fn answers_are_parsed_into_wiping_fields_only() {
        let (body, length) = parse_answer(
            br#"{"access_token":"a-1","refresh_token":"r-1","expires_in":3600,"scope":["x"],"token_type":"bearer","error":null}"#,
        );
        let mut body = body.unwrap();
        assert_eq!(length, 111);
        assert!(!body.error.truthy());
        assert!(matches!(body.expires_in, Field::Number(n) if n == 3600.0));
        assert_eq!(
            body.access_token
                .take_text()
                .map(|t| t.expose().to_owned())
                .as_deref(),
            Some("a-1")
        );
        assert!(body.access_token.text().is_none(), "moved out");
        // Repeated keys keep the last value; a non-object is an empty answer; a string
        // `expires_in` is not a number.
        let (body, _) = parse_answer(br#"{"error":"x","error":"","expires_in":"3600"}"#);
        let body = body.unwrap();
        assert!(!body.error.truthy());
        assert!(matches!(body.expires_in, Field::Text(_)));
        let (body, _) = parse_answer(br#"["access_token"]"#);
        assert!(body.unwrap().access_token.text().is_none());
        let (body, _) = parse_answer(b"");
        assert!(body.unwrap().refresh_token.text().is_none());
        assert!(parse_answer(br#"{"access_token":"a-"#).0.is_err());
        // Invalid UTF-8 is replaced, as `Response.text()` does.
        let (body, _) = parse_answer(b"{\"message\":\"\xff invalid refresh token\"}");
        assert_eq!(body.unwrap().classify(400).0, RefreshFailureKind::Permanent);
    }

    /// Review F6: the buffers that hold Twitch's text are sized once and never grow, so no
    /// earlier allocation is left behind unwiped.
    #[test]
    fn the_classified_text_never_grows_its_wiping_buffer() {
        let (body, _) = parse_answer(
            br#"{"message":"Invalid refresh token r-secret-123","error_description":"for someone@example.invalid","error":"Bad Request"}"#,
        );
        let body = body.unwrap();
        let joined = body.failure_message();
        assert_eq!(
            joined.as_str(),
            "Invalid refresh token r-secret-123 | for someone@example.invalid | Bad Request"
        );
        assert_eq!(
            joined.capacity(),
            joined.len(),
            "reserved at its full length before it was filled"
        );
        // The lower-case copy is reserved for the longest possible result, also when letters
        // grow (`İ` is two bytes, `i̇` three).
        for text in [
            "Invalid Refresh Token",
            "İİİ REVOKED ΟΔΟΣ",
            "\u{212a}elvin",
            "",
        ] {
            let lower = lower_case_wiped(text);
            assert_eq!(lower.capacity(), text.len() * LOWER_CASE_GROWTH, "{text}");
            assert!(lower.len() <= lower.capacity());
        }
        // Lowering character by character classifies exactly as `toLowerCase` does.
        for (status, text) in [
            (400, "Invalid Refresh Token"),
            (401, "AUTHORIZATION HAS BEEN REVO\u{212a}ED"),
            (400, "İnvalid grant"),
            (400, "ΟΔΟΣ invalid client"),
            (400, "Missing ΣΑΣ"),
            (400, "x"),
        ] {
            assert_eq!(
                classify_message(status, &lower_case_wiped(text)),
                classify_message(status, &dima_text::to_lower(text)),
                "{text}"
            );
        }
    }

    #[test]
    fn refusals_are_classified_without_keeping_the_text() {
        use RefreshFailureKind::{Permanent, Transient};
        use RefreshFailureReason as R;
        let cases = [
            (
                400,
                json!({"status": 400, "message": "Invalid refresh token"}),
                Permanent,
                R::InvalidGrant,
            ),
            (
                401,
                json!({"message": "authorization has been revoked"}),
                Permanent,
                R::Revoked,
            ),
            (
                400,
                json!({"error": "Bad Request", "message": "invalid client secret"}),
                Transient,
                R::InvalidClient,
            ),
            (
                403,
                json!({"status": 403, "message": "invalid client"}),
                Transient,
                R::InvalidClient,
            ),
            (
                400,
                json!({"message": "missing refresh token"}),
                Transient,
                R::MissingParameter,
            ),
            (
                429,
                json!({"message": "Too Many Requests"}),
                Transient,
                R::RateLimited,
            ),
            (503, json!({"message": "busy"}), Transient, R::ServerError),
            (
                200,
                json!({"error": "temporarily_unavailable"}),
                Transient,
                R::Refused,
            ),
            (418, json!("text"), Transient, R::Refused),
        ];
        for (status, payload, kind, reason) in cases {
            assert_eq!(
                classify_refusal(status, &payload),
                (kind, reason),
                "{payload}"
            );
        }
        // An answer that echoes a refresh token and an e-mail: the category says nothing of it.
        let echo = json!({
            "status": 400,
            "message": "Invalid refresh token r-secret-123 for someone@example.invalid",
        });
        let (kind, reason) = classify_refusal(400, &echo);
        assert_eq!(kind, Permanent);
        for text in [
            format!("{reason:?}"),
            reason.to_string(),
            reason.message().to_owned(),
        ] {
            assert!(
                !text.contains("r-secret-123") && !text.contains("example.invalid"),
                "{text}"
            );
        }
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
