//! Helix and OAuth on `dima-http`: the two providers, the reference's headers (`header.ts`),
//! its 401 retry (`twitch_helix_retry.ts`), and [`HelixRequest`], the entry point the Helix
//! wrapper packages call.
//!
//! # Headers
//!
//! Every Helix call carries `Client-Id: <CLIENT_ID>`, `Authorization: Bearer <token>` and
//! `Content-Type: application/json` (GET included), whose token is the app's, the bot's or a
//! streamer's ([`Auth`]). Moderation always runs as the bot (`getTwitchModeratorHeader`
//! ignores the channel and moderator it is given). The credential errors keep the reference's
//! texts ([`CredentialError::message`]): they reach chat and API answers.
//!
//! # 401
//!
//! Most reference call sites send once, with no retry and no timeout. Those that use the
//! 401 wrapper ([`HelixRequest::retry_on_401`]) refresh the credential and send again after
//! 1 s, 3 s and 5 s (or the delays given). For a streamer the refresh passes the refused token
//! as `rejected`, so the cache cannot hand it back; when no different token comes back the call
//! stops and [`HelixResponse::refresh_unavailable`] is set (the reference answers 503). For the
//! app and the bot the reference's hook reads the token again without marking it refused, so
//! it usually sends the same token again: reproduced and marked as a quirk (the app token is
//! only replaced when its key expires; the bot's when it nears expiry).
//!
//! # Differences from `twitch_helix_retry.ts`
//!
//! - A refresh that takes longer than [`crate::Timings::helix_refresh_deadline`] (15 s) ends the
//!   call with [`HelixError::Http`] (`TimeoutKind::Refresh`); the reference waits without limit.
//!   The refresh itself goes on in the background and its result is stored.
//! - A network error is [`HelixError::Http`] for every token kind. The reference's app wrapper
//!   catches it and answers `{error: true, message: 'Failed to get Twitch app token', status:
//!   500}`, as if the token had failed; its bot and streamer wrappers let it throw.
//! - Each attempt has the provider's deadline (60 s unless the call sets one); the reference's
//!   `fetch` has none.
//! - The OAuth debug cache entry written when a 401 persists is not written (nothing reads it;
//!   it held the response body).

use crate::base::Twitch;
use crate::events::{Destination, Level};
use crate::secret::AccessToken;
use dima_http::guard::BoxFuture;
use dima_http::{
    Credential, HeaderValue, Method, Path, Provider, ProviderBuilder, Refresh, Response,
    RetryPolicy, header,
};
use serde_json::{Map, Value, json};
use std::sync::Arc;
use std::time::Duration;

/// The Helix provider's name (the rig's provider table names `api.twitch.tv` so).
pub const HELIX_PROVIDER: &str = "twitch";
/// The OAuth provider's name (`id.twitch.tv` in the rig's provider table).
pub const OAUTH_PROVIDER: &str = "twitch-id";
/// Helix's base URL.
pub const HELIX_BASE_URL: &str = "https://api.twitch.tv/helix";
/// OAuth's base URL.
pub const OAUTH_BASE_URL: &str = "https://id.twitch.tv/oauth2";
/// The reference's 401 retry delays.
pub const DEFAULT_401_DELAYS: [Duration; 3] = [
    Duration::from_secs(1),
    Duration::from_secs(3),
    Duration::from_secs(5),
];

/// The Helix provider: `Client-Id` and `Content-Type: application/json` on every request; no
/// retry unless a call asks for the 401 wrapper; the HTTP crate's default deadlines.
pub fn helix_provider(client_id: &str) -> ProviderBuilder {
    Provider::builder(HELIX_PROVIDER, HELIX_BASE_URL)
        .header("client-id", client_id)
        .header("content-type", "application/json")
        .retry(RetryPolicy::none())
}

/// The OAuth provider (`/token`; its form requests set their own content type). Each attempt
/// has [`crate::Timings::oauth_timeout`]; retries are the token pipeline's own.
pub fn oauth_provider() -> ProviderBuilder {
    Provider::builder(OAUTH_PROVIDER, OAUTH_BASE_URL)
        .retry(RetryPolicy::none())
        .secret_query_params(&["client_secret", "refresh_token", "code"])
}

/// Whose token a Helix call carries.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Auth {
    /// The app token (`getTwitchAppHeader`).
    App,
    /// The bot account's token (`getTwitchBotHeader`).
    Bot,
    /// A moderation call (`getTwitchModeratorHeader`): always the bot.
    Moderator,
    /// The streamer's own token (`getTwitchStreamerHeaderById`): needs `has_permissions`.
    Streamer(String),
}

/// Why no credential could be put in the header (`header.ts`).
#[derive(Clone, Debug, PartialEq, Eq, thiserror::Error)]
pub enum CredentialError {
    /// `getTwitchAppHeader` throws.
    #[error("Failed to get Twitch app token")]
    NoAppToken,
    /// `getTwitchBotHeader` without a token.
    #[error("Bot's account does not have the permissions required")]
    BotUnauthorized,
    /// No directory entry for the streamer.
    #[error("[⚠️] Streamer not found for ID: {0} [/⚠️]")]
    StreamerNotFound(String),
    /// `has_permissions !== 'true'`.
    #[error(
        "[⚠️] Streamer does not have valid permissions to access this feature, please reauthorize streamer again in https://domdimabot.com [/⚠️]"
    )]
    StreamerNoPermissions,
    /// No token (the refresh failed).
    #[error(
        "[⚠️] Streamer does not have valid permissions token to access this feature, please reauthorize streamer again in https://domdimabot.com [/⚠️]"
    )]
    StreamerNoToken,
}

impl CredentialError {
    /// The reference's `message`.
    pub fn message(&self) -> String {
        self.to_string()
    }
}

impl Twitch {
    /// `getTwitchAppHeader`'s token.
    pub async fn app_credential(&self) -> Result<AccessToken, CredentialError> {
        self.app_token().await.ok_or(CredentialError::NoAppToken)
    }

    /// `getTwitchBotHeader`'s token (a failure is also reported as a developer notification).
    pub async fn bot_credential(&self) -> Result<AccessToken, CredentialError> {
        match self.bot_token().await {
            Ok(token) => Ok(token),
            Err(_) => {
                self.inner.log(
                    Level::Error,
                    Destination::Console,
                    None,
                    json!({ "message": "[DEV NOTIFICATION - ERROR]: Bot does not have valid authentication. Please authorize the bot account." }),
                );
                Err(CredentialError::BotUnauthorized)
            }
        }
    }

    /// `getTwitchStreamerHeaderById(id, rejected)`'s token.
    pub async fn streamer_credential(
        &self,
        id: &str,
        rejected: Option<&AccessToken>,
    ) -> Result<AccessToken, CredentialError> {
        let debug = |data: Value| {
            self.inner.log(Level::Debug, Destination::Cache, None, data);
        };
        let Some(streamer) = self.streamer(id).await else {
            debug(
                json!({ "function": "getTwitchStreamerHeaderById", "streamerId": id, "error": "Streamer not found" }),
            );
            return Err(CredentialError::StreamerNotFound(id.to_owned()));
        };
        if !streamer.has_permissions() {
            debug(json!({
                "function": "getTwitchStreamerHeaderById",
                "streamerId": id,
                "error": "No permissions",
                "has_permissions": streamer.field("has_permissions"),
            }));
            return Err(CredentialError::StreamerNoPermissions);
        }
        let Ok(token) = self
            .streamer_token(id, rejected, "getTwitchStreamerHeaderById")
            .await
        else {
            debug(
                json!({ "function": "getTwitchStreamerHeaderById", "streamerId": id, "error": "Failed to get access token (refresh may have failed)" }),
            );
            return Err(CredentialError::StreamerNoToken);
        };
        debug(json!({
            "function": "getTwitchStreamerHeaderById",
            "streamerId": id,
            "success": true,
            "tokenLength": dima_text::utf16_len(token.expose()),
        }));
        Ok(token)
    }

    /// The token for `auth`.
    pub async fn credential(&self, auth: &Auth) -> Result<AccessToken, CredentialError> {
        match auth {
            Auth::App => self.app_credential().await,
            Auth::Bot | Auth::Moderator => self.bot_credential().await,
            Auth::Streamer(id) => self.streamer_credential(id, None).await,
        }
    }
}

/// One Helix call: method, path (relative to `/helix`), query, JSON body, whose token, and
/// whether the 401 wrapper applies.
///
/// ```no_run
/// # async fn demo(twitch: &dima_twitch::Twitch) -> Result<(), dima_twitch::HelixError> {
/// use dima_twitch::{Auth, HelixRequest};
/// use dima_http::Path;
/// let answer = twitch
///     .helix(
///         HelixRequest::post(Path::fixed("/chat/announcements"), Auth::Moderator)
///             .query("broadcaster_id", "123")
///             .query("moderator_id", dima_twitch::TWITCH_BOT_ACCOUNT_ID)
///             .json(serde_json::json!({ "message": "hola 👋", "color": "purple" }))
///             .operation("send_announcement"),
///     )
///     .await?;
/// let status = answer.status();
/// # let _ = status;
/// # Ok(())
/// # }
/// ```
#[derive(Clone, Debug)]
pub struct HelixRequest {
    method: Method,
    path: Path,
    query: Vec<(String, String)>,
    body: Option<Value>,
    auth: Auth,
    retry_on_401: Option<Vec<Duration>>,
    timeout: Option<Duration>,
    operation: Option<&'static str>,
    worker: Option<&'static str>,
    context: Map<String, Value>,
    failure_status: Option<u16>,
}

impl HelixRequest {
    /// A request.
    pub fn new(method: Method, path: Path, auth: Auth) -> Self {
        Self {
            method,
            path,
            query: Vec::new(),
            body: None,
            auth,
            retry_on_401: None,
            timeout: None,
            operation: None,
            worker: None,
            context: Map::new(),
            failure_status: None,
        }
    }

    /// GET.
    pub fn get(path: Path, auth: Auth) -> Self {
        Self::new(Method::GET, path, auth)
    }

    /// POST.
    pub fn post(path: Path, auth: Auth) -> Self {
        Self::new(Method::POST, path, auth)
    }

    /// PATCH.
    pub fn patch(path: Path, auth: Auth) -> Self {
        Self::new(Method::PATCH, path, auth)
    }

    /// PUT.
    pub fn put(path: Path, auth: Auth) -> Self {
        Self::new(Method::PUT, path, auth)
    }

    /// DELETE.
    pub fn delete(path: Path, auth: Auth) -> Self {
        Self::new(Method::DELETE, path, auth)
    }

    /// Appends a query parameter (`URLSearchParams.append`: repeats are kept, in order).
    pub fn query(mut self, name: impl Into<String>, value: impl Into<String>) -> Self {
        self.query.push((name.into(), value.into()));
        self
    }

    /// A JSON body, written as `JSON.stringify` writes it.
    pub fn json(mut self, body: Value) -> Self {
        self.body = Some(body);
        self
    }

    /// The reference's 401 wrapper with its default delays (1 s, 3 s, 5 s).
    pub fn retry_on_401(self) -> Self {
        self.retry_on_401_with(&DEFAULT_401_DELAYS)
    }

    /// The 401 wrapper with the call's `retryDelaysMs` (an empty list means the defaults).
    pub fn retry_on_401_with(mut self, delays: &[Duration]) -> Self {
        self.retry_on_401 = Some(if delays.is_empty() {
            DEFAULT_401_DELAYS.to_vec()
        } else {
            delays.to_vec()
        });
        self
    }

    /// The deadline of each attempt (the call's `AbortSignal.timeout`).
    pub fn timeout(mut self, timeout: Duration) -> Self {
        self.timeout = Some(timeout);
        self
    }

    /// The operation name for the logs.
    pub fn operation(mut self, operation: &'static str) -> Self {
        self.operation = Some(operation);
        self
    }

    /// The worker name for the logs.
    pub fn worker(mut self, worker: &'static str) -> Self {
        self.worker = Some(worker);
        self
    }

    /// Extra fields for the 401 logs (the wrapper's `context`); never put a token here.
    pub fn context(mut self, name: impl Into<String>, value: Value) -> Self {
        self.context.insert(name.into(), value);
        self
    }

    /// The status of a credential failure (`unauthorizedStatus`; default 403, 500 for the app).
    pub fn credential_failure_status(mut self, status: u16) -> Self {
        self.failure_status = Some(status);
        self
    }

    fn log_context(&self) -> Map<String, Value> {
        let mut map = Map::new();
        map.insert(
            "worker".to_owned(),
            self.worker.map_or(Value::Null, Value::from),
        );
        map.insert(
            "operation".to_owned(),
            self.operation.map_or(Value::Null, Value::from),
        );
        if let Auth::Streamer(id) = &self.auth {
            map.insert("channelID".to_owned(), Value::from(id.as_str()));
        }
        for (key, value) in &self.context {
            map.insert(key.clone(), value.clone());
        }
        map
    }
}

/// A Helix answer.
#[derive(Debug)]
pub struct HelixResponse {
    response: Response,
}

impl HelixResponse {
    /// The status.
    pub fn status(&self) -> dima_http::StatusCode {
        self.response.status()
    }

    /// The headers (`Ratelimit-Limit`, `Ratelimit-Remaining`, `Ratelimit-Reset` included).
    pub fn headers(&self) -> &dima_http::HeaderMap {
        self.response.headers()
    }

    /// A 401 the streamer's token could not be refreshed for: the reference's wrapper answers
    /// `{error: true, response, status: 503, refreshUnavailable: true, message: 'Unable to
    /// refresh Twitch streamer token'}`.
    pub fn refresh_unavailable(&self) -> bool {
        self.response.auth_refresh_unavailable()
    }

    /// The response, to read its body.
    pub fn into_response(self) -> Response {
        self.response
    }
}

/// Why a Helix call has no answer.
#[derive(Debug, thiserror::Error)]
pub enum HelixError {
    /// No credential (`{error: true, message, status}` in the reference).
    #[error("{error}")]
    Credential {
        /// What failed.
        error: CredentialError,
        /// The status the reference's wrapper reports (`unauthorizedStatus`, default 403; 500
        /// for the app).
        status: u16,
    },
    /// The request failed (network, deadline, refresh deadline, shutdown).
    #[error(transparent)]
    Http(#[from] dima_http::Error),
}

/// The 401 hook of one Helix call.
struct HelixCredential {
    twitch: Twitch,
    auth: Auth,
    delays: Vec<Duration>,
    context: Map<String, Value>,
}

impl std::fmt::Debug for HelixCredential {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("HelixCredential")
            .field("auth", &self.auth)
            .finish_non_exhaustive()
    }
}

impl HelixCredential {
    fn log(&self, level: Level, mut data: Map<String, Value>) {
        for (key, value) in &self.context {
            data.insert(key.clone(), value.clone());
        }
        self.twitch
            .inner
            .log(level, Destination::Both, None, Value::Object(data));
    }

    fn rotated(token: &AccessToken) -> Refresh {
        token.bearer().map_or(Refresh::Retry, Refresh::Rotated)
    }

    async fn refresh_for(&self, attempt: u32, rejected: &HeaderValue) -> Refresh {
        let delay = usize::try_from(attempt.saturating_sub(1))
            .ok()
            .and_then(|index| self.delays.get(index))
            .copied()
            .unwrap_or_default();
        let mut data = Map::new();
        data.insert(
            "message".to_owned(),
            Value::from("Received Twitch 401. Refreshing token and retrying request."),
        );
        data.insert("attempt".to_owned(), Value::from(attempt));
        data.insert("maxRetries".to_owned(), Value::from(self.delays.len()));
        data.insert(
            "retryInMs".to_owned(),
            Value::from(u64::try_from(delay.as_millis()).unwrap_or(u64::MAX)),
        );
        self.log(Level::Warn, data);
        match &self.auth {
            Auth::App => match self.twitch.app_credential().await {
                Ok(token) => Self::rotated(&token),
                Err(error) => {
                    let mut data = Map::new();
                    data.insert(
                        "message".to_owned(),
                        Value::from("Token refresh hook failed during Twitch 401 retry."),
                    );
                    data.insert("attempt".to_owned(), Value::from(attempt));
                    data.insert("error".to_owned(), Value::from(error.message()));
                    self.log(Level::Error, data);
                    Refresh::Retry
                }
            },
            Auth::Bot | Auth::Moderator => match self.twitch.bot_credential().await {
                Ok(token) => Self::rotated(&token),
                Err(_) => Refresh::Retry,
            },
            Auth::Streamer(id) => {
                let refused = AccessToken::from_bearer(rejected);
                let refreshed = self.twitch.streamer_credential(id, refused.as_ref()).await;
                let message = match refreshed {
                    Ok(token) => match token.bearer() {
                        Some(header) if header != *rejected => return Refresh::Rotated(header),
                        _ => "Success".to_owned(),
                    },
                    Err(error) => error.message(),
                };
                let mut data = Map::new();
                data.insert(
                    "message".to_owned(),
                    Value::from("Unable to refresh streamer header during 401 retry."),
                );
                data.insert("channelID".to_owned(), Value::from(id.as_str()));
                data.insert("refreshMessage".to_owned(), Value::from(message));
                self.log(Level::Warn, data);
                Refresh::Stop
            }
        }
    }
}

impl Credential for HelixCredential {
    fn refresh<'a>(&'a self, attempt: u32, rejected: &'a HeaderValue) -> BoxFuture<'a, Refresh> {
        Box::pin(self.refresh_for(attempt, rejected))
    }
}

impl Twitch {
    /// Sends one Helix call (see [`HelixRequest`]). Any status is `Ok`; the caller reads it as
    /// its reference function does.
    pub async fn helix(&self, request: HelixRequest) -> Result<HelixResponse, HelixError> {
        let failure_status = |default: u16| request.failure_status.unwrap_or(default);
        let token = match self.credential(&request.auth).await {
            Ok(token) => token,
            Err(error) => {
                let status = match error {
                    CredentialError::NoAppToken => failure_status(500),
                    _ => failure_status(403),
                };
                if error == CredentialError::NoAppToken && request.retry_on_401.is_some() {
                    let mut data = request.log_context();
                    data.insert(
                        "message".to_owned(),
                        Value::from("Failed to get Twitch app header for request."),
                    );
                    data.insert("error".to_owned(), Value::from(error.message()));
                    self.inner
                        .log(Level::Error, Destination::Both, None, Value::Object(data));
                }
                return Err(HelixError::Credential { error, status });
            }
        };
        let bearer = token.bearer().ok_or(HelixError::Credential {
            error: match &request.auth {
                Auth::App => CredentialError::NoAppToken,
                Auth::Bot | Auth::Moderator => CredentialError::BotUnauthorized,
                Auth::Streamer(_) => CredentialError::StreamerNoToken,
            },
            status: failure_status(403),
        })?;
        let delays = request.retry_on_401.clone().unwrap_or_default();
        let credential = Arc::new(HelixCredential {
            twitch: self.clone(),
            auth: request.auth.clone(),
            delays: delays.clone(),
            context: request.log_context(),
        });
        let inner = &self.inner;
        let mut builder = inner
            .http
            .request(&inner.helix, request.method.clone(), request.path.clone())
            .query(&request.query)
            .credential(header::AUTHORIZATION, bearer, credential)
            .refresh_timeout(inner.config.timings.helix_refresh_deadline);
        builder = match &request.retry_on_401 {
            Some(delays) => builder.retry(RetryPolicy::twitch_helix_with(delays)),
            None => builder.retry(RetryPolicy::none()),
        };
        if let Some(body) = &request.body {
            builder = builder.json_js(body);
        }
        if let Some(timeout) = request.timeout {
            builder = builder.timeout(timeout);
        }
        let response = builder.send().await?;
        if request.retry_on_401.is_some()
            && response.status() == dima_http::StatusCode::UNAUTHORIZED
        {
            let mut data = request.log_context();
            data.insert(
                "message".to_owned(),
                Value::from("Twitch 401 persisted after retries. Continuing workflow."),
            );
            data.insert(
                "retriesAttempted".to_owned(),
                Value::from(response.attempts().saturating_sub(1)),
            );
            self.inner
                .log(Level::Error, Destination::Both, None, Value::Object(data));
        }
        Ok(HelixResponse { response })
    }
}
