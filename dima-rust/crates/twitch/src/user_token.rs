//! A user's own token, as a browser presents it: Twitch's token validation and the Helix user
//! lookup made with that token (the authentication layer's two calls, which `dima-platform`
//! made through a marked seam before these entry points existed).
//!
//! Both are sent once (no retry), with [`crate::Timings::user_token_timeout`] (10 s) as the
//! deadline of the whole call, a body limit of 64 KiB, and the token in a sensitive
//! `Authorization: Bearer` header only. No result, error, log line or `Debug` output holds the
//! token.

use crate::base::Twitch;
use crate::functions::users::TwitchUser;
use dima_core::SecretString;
use dima_http::{FailureClass, Path, Provider, RetryPolicy};
use serde_json::Value;

/// Largest body read from either endpoint (both answer a few hundred bytes).
const MAX_ANSWER_BYTES: u64 = 64 * 1024;

/// What Twitch's token validation says about a user token issued to this application.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ValidatedToken {
    /// The application the token was issued to (always this one's: another is refused).
    pub client_id: String,
    /// The user's Twitch id.
    pub user_id: String,
    /// The user's login.
    pub login: String,
    /// The scopes granted, as Twitch lists them.
    pub scopes: Vec<String>,
    /// Seconds the token has left (0 for a token that does not expire).
    pub expires_in: u64,
}

/// Why a user token gave no answer.
#[derive(Clone, Debug, PartialEq, Eq, thiserror::Error)]
#[non_exhaustive]
pub enum UserTokenError {
    /// Twitch refused the token (401: expired, revoked or malformed), or it cannot even be
    /// sent (characters a header cannot carry).
    #[error("Twitch refused the token")]
    Invalid,
    /// The token is valid but was issued to another application.
    #[error("the token was issued to another application")]
    OtherClient,
    /// The token belongs to no user (an app access token).
    #[error("the token belongs to no user")]
    NotAUserToken,
    /// The lookup found no user for the token.
    #[error("Twitch returned no user for the token")]
    NotFound,
    /// Twitch could not be reached, did not answer within the deadline, or the process is
    /// stopping. Nothing is known about the token.
    #[error("Twitch did not answer{}", if *timed_out { " within the deadline" } else { "" })]
    Unreachable {
        /// The deadline fired.
        timed_out: bool,
    },
    /// Twitch answered another status, or a body that cannot be read.
    #[error("Twitch answered unexpectedly (status {status})")]
    Unexpected {
        /// The HTTP status.
        status: u16,
    },
}

/// A failure of the HTTP stack: a request that could not be built carries an invalid token;
/// anything else means Twitch's answer is unknown.
fn unreachable(error: &dima_http::Error) -> UserTokenError {
    match error.class() {
        FailureClass::Invalid => UserTokenError::Invalid,
        FailureClass::Timeout(_) => UserTokenError::Unreachable { timed_out: true },
        _ => UserTokenError::Unreachable { timed_out: false },
    }
}

/// `response.json()` decodes UTF-8 and drops a leading byte order mark.
fn strip_bom(bytes: &[u8]) -> &[u8] {
    bytes.strip_prefix(b"\xEF\xBB\xBF").unwrap_or(bytes)
}

impl Twitch {
    /// `GET` with the user's token; the status and the body as JSON (`None` when it is not).
    async fn user_get(
        &self,
        provider: &Provider,
        path: &'static str,
        token: &SecretString,
    ) -> Result<(u16, Option<Value>), UserTokenError> {
        let inner = &self.inner;
        let response = inner
            .http
            .get(provider, Path::fixed(path))
            .bearer(token)
            .timeout(inner.config.timings.user_token_timeout)
            .max_bytes(MAX_ANSWER_BYTES)
            .retry(RetryPolicy::none())
            .send()
            .await
            .map_err(|error| unreachable(&error))?;
        let status = response.status().as_u16();
        if status == 401 {
            return Err(UserTokenError::Invalid);
        }
        let bytes = response
            .bytes()
            .await
            .map_err(|error| unreachable(&error))?;
        Ok((status, serde_json::from_slice(strip_bom(&bytes)).ok()))
    }

    /// Twitch's token validation (`GET id.twitch.tv/oauth2/validate`) of a user's own token:
    /// the client id, the user, the scopes and the lifetime left. A token issued to another
    /// application is refused ([`UserTokenError::OtherClient`]), as is an app token
    /// ([`UserTokenError::NotAUserToken`]); a 401 ([`UserTokenError::Invalid`]) is distinct from
    /// a failure to reach Twitch ([`UserTokenError::Unreachable`]).
    pub async fn validate_user_token(
        &self,
        token: &SecretString,
    ) -> Result<ValidatedToken, UserTokenError> {
        let (status, body) = self.user_get(&self.inner.oauth, "/validate", token).await?;
        if status != 200 {
            return Err(UserTokenError::Unexpected { status });
        }
        let body = body.ok_or(UserTokenError::Unexpected { status })?;
        let text = |name: &str| body.get(name).and_then(Value::as_str).map(str::to_owned);
        let client_id = text("client_id").ok_or(UserTokenError::Unexpected { status })?;
        if client_id != self.inner.config.client_id {
            return Err(UserTokenError::OtherClient);
        }
        let (user_id, login) = match (text("user_id"), text("login")) {
            (Some(user_id), Some(login)) => (user_id, login),
            (None, None) => return Err(UserTokenError::NotAUserToken),
            _ => return Err(UserTokenError::Unexpected { status }),
        };
        let scopes = match body.get("scopes") {
            Some(Value::Array(scopes)) => scopes
                .iter()
                .map(|scope| scope.as_str().map(str::to_owned))
                .collect::<Option<Vec<_>>>()
                .ok_or(UserTokenError::Unexpected { status })?,
            Some(Value::Null) | None => Vec::new(),
            Some(_) => return Err(UserTokenError::Unexpected { status }),
        };
        let expires_in = body
            .get("expires_in")
            .and_then(|value| {
                value
                    .as_u64()
                    .or_else(|| value.as_f64().filter(|n| *n >= 0.0).map(|n| n as u64))
            })
            .ok_or(UserTokenError::Unexpected { status })?;
        Ok(ValidatedToken {
            client_id,
            user_id,
            login,
            scopes,
            expires_in,
        })
    }

    /// The Helix user lookup (`GET api.twitch.tv/helix/users`, no query) with the user's own
    /// token and this application's `Client-Id`: the token's user, with every field Twitch
    /// returns (`email` among [`TwitchUser::extra`] when the token has `user:read:email`).
    pub async fn user_by_token(&self, token: &SecretString) -> Result<TwitchUser, UserTokenError> {
        let (status, body) = self.user_get(&self.inner.helix, "/users", token).await?;
        if !(200..300).contains(&status) {
            return Err(UserTokenError::Unexpected { status });
        }
        let body = body.ok_or(UserTokenError::Unexpected { status })?;
        let Some(data) = body.get("data").and_then(Value::as_array) else {
            return Err(UserTokenError::Unexpected { status });
        };
        let Some(first) = data.first() else {
            return Err(UserTokenError::NotFound);
        };
        serde_json::from_value(first.clone()).map_err(|_| UserTokenError::Unexpected { status })
    }
}
