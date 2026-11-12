//! **Seam** (marked): the two Twitch calls the authentication layer makes with a *user's* own
//! token, `GET id.twitch.tv/oauth2/validate` and `GET api.twitch.tv/helix/users`.
//!
//! `dima-twitch` has typed entry points for the app, bot and streamer tokens it stores
//! (`dima_twitch::Auth` has no variant for a token a browser presents), so these two calls are
//! made here on `dima-http` with the twitch crate's own providers (`dima_twitch::oauth_provider`
//! for `/validate`, `dima_twitch::helix_provider` for `/users`, which adds `Client-Id`). The
//! change wanted in `dima-twitch`: `Twitch::validate_user_token(&AccessToken, Scheme)` and
//! `Twitch::user_by_token(&AccessToken)` returning the raw status and JSON, at which point
//! [`HttpTwitchUserApi`] becomes a thin adapter over them.
//!
//! The seam returns what Twitch answered (status and body, parsed as JSON when it is JSON); the
//! decisions (what is a refusal, which message the client sees) are the authenticator's.
//!
//! The token travels in a sensitive header only; no error, log line or `Debug` output of this
//! module contains it.

use dima_core::SecretString;
use dima_http::{HttpClient, Path, Provider};
use futures_util::future::BoxFuture;
use serde_json::Value;
use std::fmt;
use std::time::Duration;

/// The authorization scheme sent with a user token. `authMiddleware` sends `Bearer`, the OAuth
/// server's fresh browser proof (`browserUser`) sends `OAuth`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Scheme {
    /// `Authorization: Bearer <token>`.
    Bearer,
    /// `Authorization: OAuth <token>`.
    OAuth,
}

/// What Twitch answered.
#[derive(Clone, Debug, PartialEq)]
pub struct TwitchAnswer {
    /// The HTTP status.
    pub status: u16,
    /// The body parsed as JSON; `None` when it is not JSON (`response.json()` would throw).
    pub body: Option<Value>,
}

impl TwitchAnswer {
    /// `response.ok`.
    pub fn ok(&self) -> bool {
        (200..300).contains(&self.status)
    }
}

/// Twitch could not be reached, did not answer within the deadline, or the body could not be
/// read (the reference's `fetch` rejected).
#[derive(Clone, Debug, PartialEq, Eq, thiserror::Error)]
#[error("Twitch did not answer: {0}")]
pub struct Unreachable(pub &'static str);

/// The two calls. Implementations never put the token in an error or a log line.
pub trait TwitchUserApi: Send + Sync + fmt::Debug {
    /// `GET /oauth2/validate` with the user's token.
    fn validate<'a>(
        &'a self,
        token: &'a SecretString,
        scheme: Scheme,
        timeout: Duration,
    ) -> BoxFuture<'a, Result<TwitchAnswer, Unreachable>>;

    /// `GET /helix/users` with the user's token (and the app's `Client-Id`).
    fn users<'a>(
        &'a self,
        token: &'a SecretString,
        timeout: Duration,
    ) -> BoxFuture<'a, Result<TwitchAnswer, Unreachable>>;
}

/// Largest body read from either endpoint (both answer a few hundred bytes).
pub const MAX_ANSWER_BYTES: u64 = 64 * 1024;

/// [`TwitchUserApi`] over `dima-http`.
#[derive(Clone)]
pub struct HttpTwitchUserApi {
    http: HttpClient,
    oauth: Provider,
    helix: Provider,
}

impl fmt::Debug for HttpTwitchUserApi {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("HttpTwitchUserApi")
            .field("oauth", &self.oauth.name())
            .field("helix", &self.helix.name())
            .finish()
    }
}

impl HttpTwitchUserApi {
    /// `oauth` is the registry's `dima_twitch::OAUTH_PROVIDER` (base `.../oauth2`), `helix` its
    /// `dima_twitch::HELIX_PROVIDER` (base `.../helix`, sends `Client-Id`).
    pub fn new(http: HttpClient, oauth: Provider, helix: Provider) -> Self {
        Self { http, oauth, helix }
    }

    async fn get(
        &self,
        provider: &Provider,
        path: &'static str,
        authorization: SecretString,
        timeout: Duration,
    ) -> Result<TwitchAnswer, Unreachable> {
        let response = self
            .http
            .get(provider, Path::fixed(path))
            .secret_header("authorization", &authorization)
            .timeout(timeout)
            .max_bytes(MAX_ANSWER_BYTES)
            .send()
            .await
            .map_err(|_| Unreachable("request failed"))?;
        let status = response.status().as_u16();
        if status == 401 && path == "/validate" {
            // The reference does not read the body of a refused validation.
            return Ok(TwitchAnswer { status, body: None });
        }
        let bytes = response
            .bytes()
            .await
            .map_err(|_| Unreachable("body could not be read"))?;
        let body = serde_json::from_slice(strip_bom(&bytes)).ok();
        Ok(TwitchAnswer { status, body })
    }
}

/// `response.json()` decodes UTF-8 and drops a leading byte order mark.
fn strip_bom(bytes: &[u8]) -> &[u8] {
    bytes.strip_prefix(b"\xEF\xBB\xBF").unwrap_or(bytes)
}

impl TwitchUserApi for HttpTwitchUserApi {
    fn validate<'a>(
        &'a self,
        token: &'a SecretString,
        scheme: Scheme,
        timeout: Duration,
    ) -> BoxFuture<'a, Result<TwitchAnswer, Unreachable>> {
        let prefix = match scheme {
            Scheme::Bearer => "Bearer",
            Scheme::OAuth => "OAuth",
        };
        let header = SecretString::new(format!("{prefix} {}", token.expose()));
        Box::pin(self.get(&self.oauth, "/validate", header, timeout))
    }

    fn users<'a>(
        &'a self,
        token: &'a SecretString,
        timeout: Duration,
    ) -> BoxFuture<'a, Result<TwitchAnswer, Unreachable>> {
        let header = SecretString::new(format!("Bearer {}", token.expose()));
        Box::pin(self.get(&self.helix, "/users", header, timeout))
    }
}
