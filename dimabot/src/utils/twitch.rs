//! Reusable Twitch transport/core, not a migration of the live token cache.
//!
//! References: `dimabot/src/utils/{tokens,header,links,twitch_helix_retry,
//! oauth_debug_cache}.ts`. Opt in with `twitch-client`. No constructor connects,
//! reads dotenv files, starts tasks, or installs a production token source.
//! [`TokenSource`] must supply app/bot/streamer credentials and enforce streamer
//! permission/expiry policy. Mongo encrypted-token persistence, Redis caching,
//! compare-before-invalidate rotation, permission revocation, logging and debug
//! cache writes deliberately remain the caller's responsibility. In particular,
//! an OAuth refresh success must be persisted by that future adapter before use.
//!
//! Safety differences from TypeScript: headers are owned per attempt; user-token
//! subjects must match the requested identity; redirects are disabled; URLs cannot
//! escape configured bases. Diagnostics redact more than the TS Bearer-only
//! sanitizer, and never retain non-JSON bodies. No production worker uses this API.

use std::{collections::BTreeMap, fmt, future::Future, pin::Pin, time::Duration};

use reqwest::{
    Client, Method, Response, Url,
    header::{AUTHORIZATION, CONTENT_TYPE, HeaderMap, HeaderValue},
    redirect::Policy,
};
use serde_json::{Value, json};

pub const TWITCH_BOT_ACCOUNT_ID: &str = "698614112";
pub const OAUTH_DIAGNOSTIC_TTL_SECONDS: u64 = 86_400;
pub const OAUTH_API_FAILURE_PREFIX: &str = "oauth:failures:api:";
pub const OAUTH_TOKEN_REFRESH_FAILURE_PREFIX: &str = "oauth:failures:token_refresh:";
pub const HELIX_RETRY_DELAYS_MS: [u64; 3] = [1000, 3000, 5000];
pub const REFRESH_RETRY_DELAYS_MS: [u64; 2] = [400, 900];

/// Errors intentionally omit raw URLs, credentials, HTTP bodies and source errors.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TwitchError {
    InvalidEndpoint,
    MissingClientId,
    MissingClientSecret,
    InvalidHeader,
    ClientInitialization,
    Token(TokenSourceError),
    Transport,
}
impl fmt::Display for TwitchError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            Self::InvalidEndpoint => "Invalid Twitch endpoint",
            Self::MissingClientId => "CLIENT_ID is not set",
            Self::MissingClientSecret => "CLIENT_SECRET is not set",
            Self::InvalidHeader => "Invalid Twitch authentication header",
            Self::ClientInitialization => "Could not initialize Twitch transport",
            Self::Token(_) => "Twitch authentication unavailable",
            Self::Transport => "Twitch connection interrupted",
        })
    }
}
impl std::error::Error for TwitchError {}

#[derive(Debug, Clone)]
pub struct TwitchEndpoints {
    helix: Url,
    oauth: Url,
}
impl Default for TwitchEndpoints {
    fn default() -> Self {
        Self::new(
            "https://api.twitch.tv/helix/",
            "https://id.twitch.tv/oauth2/",
        )
        .expect("fixed Twitch endpoints")
    }
}
impl TwitchEndpoints {
    /// Explicit overrides allow isolated loopback fixtures. Only HTTP(S) bases
    /// without userinfo, query or fragment are accepted. The trailing slash is
    /// normalized; endpoint paths must remain below the configured base.
    pub fn new(helix_base: &str, oauth_base: &str) -> Result<Self, TwitchError> {
        Ok(Self {
            helix: parse_base(helix_base)?,
            oauth: parse_base(oauth_base)?,
        })
    }

    /// Like `getTwitchHelixUrl`, `params` is an already encoded query string;
    /// an empty string adds no `?`. Absolute paths/URLs and path escapes fail.
    pub fn helix_url(&self, endpoint: &str, params: Option<&str>) -> Result<Url, TwitchError> {
        endpoint_url(&self.helix, endpoint, params)
    }

    /// `None`/empty endpoint selects the OAuth base, matching `links.ts`.
    pub fn oauth_url(
        &self,
        endpoint: Option<&str>,
        params: Option<&str>,
    ) -> Result<Url, TwitchError> {
        let endpoint = endpoint.unwrap_or("");
        let mut url = endpoint_url(&self.oauth, endpoint, params)?;
        if endpoint.is_empty() {
            let path = url.path().trim_end_matches('/').to_owned();
            url.set_path(&path);
        }
        Ok(url)
    }
}

fn parse_base(raw: &str) -> Result<Url, TwitchError> {
    let mut url = Url::parse(raw).map_err(|_| TwitchError::InvalidEndpoint)?;
    if !matches!(url.scheme(), "http" | "https")
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err(TwitchError::InvalidEndpoint);
    }
    if !url.path().ends_with('/') {
        url.set_path(&format!("{}/", url.path()));
    }
    Ok(url)
}

fn endpoint_url(base: &Url, endpoint: &str, params: Option<&str>) -> Result<Url, TwitchError> {
    if endpoint.starts_with('/')
        || endpoint.contains(['\\', ':', '?', '#'])
        || endpoint.chars().any(char::is_control)
    {
        return Err(TwitchError::InvalidEndpoint);
    }
    let mut url = base
        .join(endpoint)
        .map_err(|_| TwitchError::InvalidEndpoint)?;
    if url.origin() != base.origin()
        || !url.path().starts_with(base.path())
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return Err(TwitchError::InvalidEndpoint);
    }
    url.set_query(params.filter(|value| !value.is_empty()));
    Ok(url)
}

/// A requested token identity. Moderation always uses `Bot`, irrespective of
/// the requesting moderator/streamer, as in `getTwitchModeratorHeader`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TwitchAuth {
    App,
    Bot,
    Streamer(String),
}
impl TwitchAuth {
    pub fn moderator() -> Self {
        Self::Bot
    }
    pub fn user_id(&self) -> Option<&str> {
        match self {
            Self::App => None,
            Self::Bot => Some(TWITCH_BOT_ACCOUNT_ID),
            Self::Streamer(id) => Some(id),
        }
    }
}

/// Credential material has redacted Debug and no Serialize implementation.
#[derive(Clone)]
pub struct AccessToken {
    secret: String,
    subject: Option<String>,
}
impl fmt::Debug for AccessToken {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("AccessToken(<redacted>)")
    }
}
impl AccessToken {
    pub fn app(secret: impl Into<String>) -> Self {
        Self {
            secret: secret.into(),
            subject: None,
        }
    }
    /// `subject` is the validated user behind the token, not the request actor.
    pub fn user(secret: impl Into<String>, subject: impl Into<String>) -> Self {
        Self {
            secret: secret.into(),
            subject: Some(subject.into()),
        }
    }
    /// Explicit access for a persistence adapter; never log this value.
    pub fn expose_secret(&self) -> &str {
        &self.secret
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TokenSourceError {
    Missing,
    PermissionsDenied,
    Unavailable,
    IdentityMismatch,
}
pub type TokenFuture<'a> =
    Pin<Box<dyn Future<Output = Result<AccessToken, TokenSourceError>> + Send + 'a>>;

/// Caller-owned token store interface. A call means the same acquisition as TS
/// getAppToken/getBotToken/getTwitchStreamerHeaderById, including refresh when
/// the adapter determines it is needed. A 401 reacquires; it does not forcibly
/// invalidate a token. Failed reacquisition retains the prior credential, just
/// like TS's caught refresh hook. Initial acquisition failures stop the request.
///
/// Implementations must check streamer existence/permissions and token expiry,
/// and resolve bot auth to [`TWITCH_BOT_ACCOUNT_ID`]. There is intentionally no
/// default/static production implementation or implicit Redis/Mongo adapter.
pub trait TokenSource: Send + Sync {
    fn token<'a>(&'a self, auth: &'a TwitchAuth) -> TokenFuture<'a>;
}

/// Returns fresh owned headers. Authorization is marked sensitive for Debug.
pub fn build_headers(
    client_id: &str,
    token: &AccessToken,
    auth: &TwitchAuth,
) -> Result<HeaderMap, TwitchError> {
    if client_id.is_empty() {
        return Err(TwitchError::MissingClientId);
    }
    if token.secret.is_empty() {
        return Err(TwitchError::Token(TokenSourceError::Missing));
    }
    if token.subject.as_deref() != auth.user_id() {
        return Err(TwitchError::Token(TokenSourceError::IdentityMismatch));
    }
    let mut headers = HeaderMap::new();
    headers.insert(
        "client-id",
        HeaderValue::from_str(client_id).map_err(|_| TwitchError::InvalidHeader)?,
    );
    let mut authorization = HeaderValue::from_str(&format!("Bearer {}", token.secret))
        .map_err(|_| TwitchError::InvalidHeader)?;
    authorization.set_sensitive(true);
    headers.insert(AUTHORIZATION, authorization);
    headers.insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));
    Ok(headers)
}

#[derive(Debug, Clone)]
pub struct HelixRetryPolicy {
    delays: Vec<Duration>,
}
impl Default for HelixRetryPolicy {
    fn default() -> Self {
        Self::from_millis(&HELIX_RETRY_DELAYS_MS)
    }
}
impl HelixRetryPolicy {
    /// Preserve raw-fetch callers that must not replay a side-effecting request.
    pub fn single_attempt() -> Self {
        Self { delays: Vec::new() }
    }

    /// Empty input uses TS defaults. `[0]` requests one immediate retry.
    pub fn from_millis(delays: &[u64]) -> Self {
        let delays = if delays.is_empty() {
            &HELIX_RETRY_DELAYS_MS[..]
        } else {
            delays
        };
        Self {
            delays: delays
                .iter()
                .map(|delay| Duration::from_millis(*delay))
                .collect(),
        }
    }
}

/// Borrowed JSON request description; paths/queries are validated before tokens
/// are acquired. Supply an already encoded query without a leading `?`.
pub struct HelixRequest<'a> {
    pub method: Method,
    pub endpoint: &'a str,
    pub params: Option<&'a str>,
    pub body: Option<&'a Value>,
}

pub struct HelixResult {
    /// Exhausted 401s and all other HTTP failures remain responses, as in TS.
    pub response: Response,
    pub attempts: usize,
    pub token_reload_failures: usize,
}

#[derive(Clone)]
pub struct TwitchClient {
    http: Client,
    client_id: String,
    endpoints: TwitchEndpoints,
}
impl TwitchClient {
    /// No network IO. No default timeout (TS fetch has none); callers may choose
    /// a deadline. Redirects never forward credentials or replay mutations.
    pub fn new(
        client_id: impl Into<String>,
        endpoints: TwitchEndpoints,
        timeout: Option<Duration>,
    ) -> Result<Self, TwitchError> {
        let client_id = client_id.into();
        if client_id.is_empty() {
            return Err(TwitchError::MissingClientId);
        }
        HeaderValue::from_str(&client_id).map_err(|_| TwitchError::InvalidHeader)?;
        let mut builder = Client::builder().redirect(Policy::none());
        if let Some(timeout) = timeout {
            builder = builder.timeout(timeout);
        }
        Ok(Self {
            http: builder
                .build()
                .map_err(|_| TwitchError::ClientInitialization)?,
            client_id,
            endpoints,
        })
    }

    /// Only 401 triggers retries, with fresh immutable headers each attempt.
    /// Transport errors/429/5xx are returned without replay. JSON bodies are
    /// cloned for an intentional 401 replay; callers choose whether their
    /// operation is appropriate for this TS-compatible retry contract.
    pub async fn request(
        &self,
        source: &dyn TokenSource,
        auth: &TwitchAuth,
        request: HelixRequest<'_>,
        policy: &HelixRetryPolicy,
    ) -> Result<HelixResult, TwitchError> {
        let HelixRequest {
            method,
            endpoint,
            params,
            body,
        } = request;
        let url = self.endpoints.helix_url(endpoint, params)?;
        let mut token = source.token(auth).await.map_err(TwitchError::Token)?;
        // Reject initial malformed/mismatched tokens before any request.
        build_headers(&self.client_id, &token, auth)?;
        let mut failures = 0;
        let mut attempts = 0;
        loop {
            attempts += 1;
            let headers = build_headers(&self.client_id, &token, auth)?;
            let mut request = self
                .http
                .request(method.clone(), url.clone())
                .headers(headers);
            if let Some(body) = body {
                request = request.json(body);
            }
            let response = request.send().await.map_err(|_| TwitchError::Transport)?;
            if response.status().as_u16() != 401 || attempts > policy.delays.len() {
                return Ok(HelixResult {
                    response,
                    attempts,
                    token_reload_failures: failures,
                });
            }
            drop(response);
            match source.token(auth).await {
                Ok(next) if build_headers(&self.client_id, &next, auth).is_ok() => token = next,
                _ => failures += 1,
            }
            tokio::time::sleep(policy.delays[attempts - 1]).await;
        }
    }
}

/// Client credentials use exactly CLIENT_ID / CLIENT_SECRET. Explicit lookup
/// avoids tests mutating process environment. Values are never included in errors.
#[derive(Clone)]
pub struct TwitchCredentials {
    client_id: String,
    client_secret: String,
}
impl fmt::Debug for TwitchCredentials {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("TwitchCredentials(<redacted>)")
    }
}
impl TwitchCredentials {
    pub fn new(
        client_id: impl Into<String>,
        client_secret: impl Into<String>,
    ) -> Result<Self, TwitchError> {
        let client_id = client_id.into();
        let client_secret = client_secret.into();
        if client_id.is_empty() {
            return Err(TwitchError::MissingClientId);
        }
        if client_secret.is_empty() {
            return Err(TwitchError::MissingClientSecret);
        }
        Ok(Self {
            client_id,
            client_secret,
        })
    }
    pub fn from_lookup(
        mut lookup: impl FnMut(&str) -> Option<String>,
    ) -> Result<Self, TwitchError> {
        Self::new(
            lookup("CLIENT_ID").unwrap_or_default(),
            lookup("CLIENT_SECRET").unwrap_or_default(),
        )
    }
    pub fn from_env() -> Result<Self, TwitchError> {
        Self::from_lookup(|name| std::env::var(name).ok())
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RefreshFailureKind {
    Transient,
    Permanent,
}
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OAuthFailure {
    pub kind: RefreshFailureKind,
    pub status: Option<u16>,
    /// Provider message with known request credentials redacted.
    pub message: String,
    pub attempts: usize,
}
impl fmt::Display for OAuthFailure {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            f,
            "Twitch OAuth {:?} failure (status {:?})",
            self.kind, self.status
        )
    }
}
impl std::error::Error for OAuthFailure {}

#[derive(Clone)]
pub struct OAuthTokens {
    pub access_token: AccessToken,
    pub refresh_token: Option<String>,
    /// JS's numeric expires_in, including zero/negative/fractional values; a
    /// non-number defaults to 7200 for refresh. JSON numbers must fit finite
    /// f64 (serde_json); persistence must validate TTLs before caching.
    pub expires_in: f64,
}
impl fmt::Debug for OAuthTokens {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("OAuthTokens(<redacted>)")
    }
}

#[derive(Debug, Clone)]
pub struct RefreshPolicy {
    delays: Vec<Duration>,
}
impl Default for RefreshPolicy {
    fn default() -> Self {
        Self::from_millis(&REFRESH_RETRY_DELAYS_MS)
    }
}
impl RefreshPolicy {
    /// Empty input selects the two default delays (three total attempts).
    pub fn from_millis(delays: &[u64]) -> Self {
        let delays = if delays.is_empty() {
            &REFRESH_RETRY_DELAYS_MS[..]
        } else {
            delays
        };
        Self {
            delays: delays
                .iter()
                .map(|delay| Duration::from_millis(*delay))
                .collect(),
        }
    }
}

#[derive(Clone)]
pub struct TwitchOAuthClient {
    http: Client,
    credentials: TwitchCredentials,
    token_url: Url,
}
impl TwitchOAuthClient {
    pub fn new(
        credentials: TwitchCredentials,
        endpoints: TwitchEndpoints,
        timeout: Option<Duration>,
    ) -> Result<Self, TwitchError> {
        let mut builder = Client::builder().redirect(Policy::none());
        if let Some(timeout) = timeout {
            builder = builder.timeout(timeout);
        }
        Ok(Self {
            http: builder
                .build()
                .map_err(|_| TwitchError::ClientInitialization)?,
            credentials,
            token_url: endpoints.oauth_url(Some("token"), None)?,
        })
    }

    /// Performs only the endpoint exchange: no storage, invalidation, cache,
    /// permission updates or implicit follow-up refresh. Credentials are form
    /// POST fields, never query params. Network/read errors and 5xx retry;
    /// malformed 2xx/4xx and 429 do not retry, matching tokens.ts.
    pub async fn refresh(
        &self,
        refresh_token: &str,
        user_id: &str,
        policy: &RefreshPolicy,
    ) -> Result<OAuthTokens, OAuthFailure> {
        self.exchange(Some((refresh_token, user_id)), &policy.delays)
            .await
    }

    /// One client-credentials exchange, without the TS cache-writing side effect.
    /// Unlike the permissive TS app-token coercion, requires a 2xx response,
    /// nonempty string access token and numeric expiry. Callers must still
    /// validate cache TTLs.
    pub async fn app_token(&self) -> Result<OAuthTokens, OAuthFailure> {
        self.exchange(None, &[]).await
    }

    async fn exchange(
        &self,
        refresh: Option<(&str, &str)>,
        delays: &[Duration],
    ) -> Result<OAuthTokens, OAuthFailure> {
        let mut form = vec![
            ("client_id", self.credentials.client_id.as_str()),
            ("client_secret", self.credentials.client_secret.as_str()),
            (
                "grant_type",
                if refresh.is_some() {
                    "refresh_token"
                } else {
                    "client_credentials"
                },
            ),
        ];
        if let Some((token, _)) = refresh {
            form.push(("refresh_token", token));
        }
        let mut attempts = 0;
        let (status, text) = loop {
            attempts += 1;
            let result = async {
                let response = self
                    .http
                    .post(self.token_url.clone())
                    .form(&form)
                    .send()
                    .await?;
                let status = response.status().as_u16();
                Ok::<_, reqwest::Error>((status, response.text().await?))
            }
            .await;
            let retryable = match &result {
                Ok((status, _)) => *status >= 500,
                Err(_) => true,
            };
            if retryable && attempts <= delays.len() {
                tokio::time::sleep(delays[attempts - 1]).await;
                continue;
            }
            break result.map_err(|_| OAuthFailure {
                kind: RefreshFailureKind::Transient,
                status: None,
                message: "Network error while refreshing Twitch token".to_owned(),
                attempts,
            })?;
        };
        // Empty response is {} in TS, while nonempty malformed JSON fails parse.
        let payload: Value = if text.is_empty() {
            json!({})
        } else {
            serde_json::from_str(&text).map_err(|_| OAuthFailure {
                kind: RefreshFailureKind::Transient,
                status: Some(status),
                message: "Failed to parse Twitch token refresh response".to_owned(),
                attempts,
            })?
        };
        if !(200..300).contains(&status) || payload.get("error").is_some_and(js_truthy) {
            let message = refresh_failure_message(&payload);
            let kind = classify_refresh_failure(status, &payload);
            let secrets = [
                self.credentials.client_secret.as_str(),
                refresh.map(|(token, _)| token).unwrap_or(""),
            ];
            return Err(OAuthFailure {
                kind,
                status: Some(status),
                message: redact_known(
                    if message.is_empty() {
                        format!("HTTP {status}")
                    } else {
                        message
                    },
                    &secrets,
                ),
                attempts,
            });
        }
        let access = payload
            .get("access_token")
            .and_then(Value::as_str)
            .filter(|token| !token.is_empty());
        let rotated = payload
            .get("refresh_token")
            .and_then(Value::as_str)
            .filter(|token| !token.is_empty());
        let expiry = payload.get("expires_in").and_then(Value::as_f64);
        if access.is_none()
            || (refresh.is_some() && rotated.is_none())
            || (refresh.is_none() && expiry.is_none())
        {
            return Err(OAuthFailure {
                kind: RefreshFailureKind::Transient,
                status: Some(status),
                message: "Twitch token refresh returned incomplete payload".to_owned(),
                attempts,
            });
        }
        let secret = access.expect("validated access token").to_owned();
        Ok(OAuthTokens {
            access_token: match refresh {
                Some((_, id)) => AccessToken::user(secret, id),
                None => AccessToken::app(secret),
            },
            refresh_token: rotated.map(str::to_owned),
            expires_in: expiry.unwrap_or(7200.0),
        })
    }
}

fn js_truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(value) => *value,
        Value::Number(value) => value.as_f64().is_some_and(|n| n != 0.0),
        Value::String(value) => !value.is_empty(),
        _ => true,
    }
}

/// Message order and trimming predicate mirror tokens.ts; retained strings are
/// not trimmed. Only status 400/401 with one of the source phrases is permanent.
pub fn refresh_failure_message(payload: &Value) -> String {
    ["message", "error_description", "error"]
        .iter()
        .filter_map(|key| payload.get(key).and_then(Value::as_str))
        .filter(|value| !super::js_compat::trim(value).is_empty())
        .collect::<Vec<_>>()
        .join(" | ")
}
pub fn classify_refresh_failure(status: u16, payload: &Value) -> RefreshFailureKind {
    let message = refresh_failure_message(payload).to_lowercase();
    if matches!(status, 400 | 401)
        && [
            "invalid refresh token",
            "invalid refresh",
            "invalid grant",
            "authorization grant is invalid",
            "revoked",
            "authorization has been revoked",
        ]
        .iter()
        .any(|fragment| message.contains(fragment))
    {
        RefreshFailureKind::Permanent
    } else {
        RefreshFailureKind::Transient
    }
}

/// Bearer lengths count UTF-16 code units (JS `.length`). Non-Bearer auth is
/// wholly redacted, unlike oauth_debug_cache.ts, which leaves it unchanged.
pub fn sanitize_authorization(value: &str) -> String {
    if let Some(token) = value.strip_prefix("Bearer ") {
        format!("Bearer <token_length:{}>", token.encode_utf16().count())
    } else {
        "<redacted>".to_owned()
    }
}
pub fn sanitize_headers(headers: &HeaderMap) -> BTreeMap<String, String> {
    headers
        .iter()
        .map(|(name, value)| {
            let value = value.to_str().unwrap_or("<binary>");
            let value = if name.as_str() == "authorization" {
                sanitize_authorization(value)
            } else if secret_key(name.as_str()) {
                "<redacted>".to_owned()
            } else {
                value.to_owned()
            };
            (name.as_str().to_owned(), value)
        })
        .collect()
}
fn secret_key(key: &str) -> bool {
    let key = key.to_ascii_lowercase().replace('-', "_");
    [
        "authorization",
        "proxy_authorization",
        "cookie",
        "set_cookie",
        "client_secret",
        "clientsecret",
        "access_token",
        "accesstoken",
        "refresh_token",
        "refreshtoken",
        "token",
        "x_api_key",
        "api_key",
        "password",
        "secret",
    ]
    .contains(&key.as_str())
}
fn redact_known(mut value: String, secrets: &[&str]) -> String {
    for secret in secrets.iter().filter(|secret| !secret.is_empty()) {
        value = value.replace(secret, "<redacted>");
        // Providers can echo the posted form rather than the decoded value.
        let mut encoded = Url::parse("http://fixture.invalid/").expect("fixed URL");
        encoded.query_pairs_mut().append_pair("value", secret);
        if let Some(form) = encoded
            .query()
            .and_then(|query| query.strip_prefix("value="))
        {
            value = value.replace(form, "<redacted>");
        }
    }
    value
}
/// Removes userinfo, fragments and *all* query values, retaining query names.
pub fn sanitize_url(raw: &str) -> String {
    let Ok(mut url) = Url::parse(raw) else {
        return "unknown".to_owned();
    };
    if !matches!(url.scheme(), "http" | "https") {
        return "unknown".to_owned();
    }
    let _ = url.set_username("");
    let _ = url.set_password(None);
    url.set_fragment(None);
    let names: Vec<_> = url
        .query_pairs()
        .map(|(name, _)| name.into_owned())
        .collect();
    url.set_query(None);
    if !names.is_empty() {
        let mut pairs = url.query_pairs_mut();
        for name in names {
            pairs.append_pair(&name, "<redacted>");
        }
    }
    url.to_string()
}
pub fn extract_endpoint(raw: &str) -> String {
    let Ok(url) = Url::parse(raw) else {
        return "unknown".to_owned();
    };
    let parts: Vec<_> = url
        .path()
        .split('/')
        .filter(|part| !part.is_empty())
        .collect();
    let start = parts
        .iter()
        .position(|part| *part == "helix")
        .map_or(0, |index| index + 1);
    let endpoint = parts[start..].join("/");
    if endpoint.is_empty() {
        "unknown".to_owned()
    } else {
        endpoint
    }
}
fn diagnostic_body(raw: &str, secrets: &[&str]) -> Value {
    fn scrub(value: &mut Value, secrets: &[&str]) {
        match value {
            Value::Object(map) => {
                for (key, value) in map {
                    if secret_key(key) {
                        *value = Value::String("<redacted>".to_owned());
                    } else {
                        scrub(value, secrets);
                    }
                }
            }
            Value::Array(values) => {
                for value in values {
                    scrub(value, secrets);
                }
            }
            Value::String(value) => *value = redact_known(value.clone(), secrets),
            _ => {}
        }
    }
    let Ok(mut value) = serde_json::from_str(raw) else {
        return Value::String("<non-JSON response omitted>".to_owned());
    };
    scrub(&mut value, secrets);
    value
}

fn redact_diagnostic_strings(mut value: Value, secrets: &[&str]) -> Value {
    fn visit(value: &mut Value, secrets: &[&str]) {
        match value {
            Value::String(text) => *text = redact_known(text.clone(), secrets),
            Value::Object(map) => {
                for value in map.values_mut() {
                    visit(value, secrets);
                }
            }
            Value::Array(values) => {
                for value in values {
                    visit(value, secrets);
                }
            }
            _ => {}
        }
    }
    visit(&mut value, secrets);
    value
}

/// Pure debug-cache payload builder; no timestamp/key generation or Redis IO.
/// Caller supplies timestamp and any known credential strings for free-text
/// redaction. Avoid putting secrets into path segments or arbitrary context.
pub fn api_failure_diagnostic(
    timestamp: &str,
    url: &str,
    method: &str,
    headers: &HeaderMap,
    status: u16,
    body: &str,
    secrets: &[&str],
) -> Value {
    redact_diagnostic_strings(
        json!({ "timestamp": timestamp, "endpoint": extract_endpoint(url), "url": redact_known(sanitize_url(url), secrets), "method": method, "headers": sanitize_headers(headers), "clientId": headers.get("client-id").and_then(|value| value.to_str().ok()).unwrap_or("unknown"), "responseStatus": status, "responseBody": diagnostic_body(body, secrets) }),
        secrets,
    )
}

/// Pure refresh diagnostic. The TS eight-character token prefix is intentionally
/// replaced with `<redacted>`; caller-controlled secret-bearing fields are scrubbed.
pub fn refresh_failure_diagnostic(
    timestamp: &str,
    user_id: &str,
    url: &str,
    failure: &OAuthFailure,
    body: &str,
    secrets: &[&str],
) -> Value {
    redact_diagnostic_strings(
        json!({ "timestamp": timestamp, "userID": user_id, "refreshTokenPrefix": "<redacted>", "failureKind": match failure.kind { RefreshFailureKind::Permanent => "permanent_failure", RefreshFailureKind::Transient => "transient_failure" }, "failureReason": redact_known(failure.message.clone(), secrets), "status": failure.status, "responseBody": diagnostic_body(body, secrets), "endpoint": extract_endpoint(url), "url": redact_known(sanitize_url(url), secrets) }),
        secrets,
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::utils::test_http::{CannedResponse, Recorder};
    use std::sync::{
        Mutex,
        atomic::{AtomicUsize, Ordering},
    };

    struct SequenceSource {
        tokens: Mutex<Vec<Result<AccessToken, TokenSourceError>>>,
    }
    impl TokenSource for SequenceSource {
        fn token<'a>(&'a self, _: &'a TwitchAuth) -> TokenFuture<'a> {
            Box::pin(async move { self.tokens.lock().expect("tokens").remove(0) })
        }
    }
    fn fixture_endpoints(recorder: &Recorder) -> TwitchEndpoints {
        TwitchEndpoints::new(
            &format!("{}/helix/", recorder.base_url),
            &format!("{}/oauth2/", recorder.base_url),
        )
        .unwrap()
    }
    fn credentials() -> TwitchCredentials {
        TwitchCredentials::new("client-fixture", "secret&+fixture").unwrap()
    }

    #[test]
    fn urls_identity_headers_and_source_configuration() {
        let endpoints = TwitchEndpoints::default();
        assert_eq!(
            endpoints
                .helix_url("users", Some("id=1&id=2"))
                .unwrap()
                .as_str(),
            "https://api.twitch.tv/helix/users?id=1&id=2"
        );
        assert_eq!(
            endpoints.oauth_url(None, Some("")).unwrap().as_str(),
            "https://id.twitch.tv/oauth2"
        );
        for path in [
            "//evil.invalid/",
            "https://evil.invalid/",
            "../token",
            "%2e%2e/token",
            "chat\\messages",
            "/users",
            "users?token=x",
        ] {
            assert!(endpoints.helix_url(path, None).is_err(), "{path}");
        }
        assert!(
            TwitchEndpoints::new(
                "https://user:secret@example.invalid/",
                "https://example.invalid/"
            )
            .is_err()
        );
        assert_eq!(
            TwitchAuth::moderator().user_id(),
            Some(TWITCH_BOT_ACCOUNT_ID)
        );
        let token = AccessToken::user("fixture", TWITCH_BOT_ACCOUNT_ID);
        let mut first = build_headers("client", &token, &TwitchAuth::moderator()).unwrap();
        first.insert("x-test", HeaderValue::from_static("changed"));
        assert!(
            !build_headers("client", &token, &TwitchAuth::Bot)
                .unwrap()
                .contains_key("x-test")
        );
        assert!(
            build_headers(
                "client",
                &AccessToken::user("fixture", "streamer"),
                &TwitchAuth::Bot
            )
            .is_err()
        );
        assert!(
            build_headers(
                "client",
                &AccessToken::app("bad\r\ntoken"),
                &TwitchAuth::App
            )
            .is_err()
        );
        assert_eq!(
            TwitchCredentials::from_lookup(|_| None).unwrap_err(),
            TwitchError::MissingClientId
        );
        assert!(!format!("{token:?} {:?}", credentials()).contains("fixture"));
    }

    #[tokio::test]
    async fn helix_reacquires_and_retains_prior_token_on_failed_reload() {
        let count = AtomicUsize::new(0);
        let recorder = Recorder::start(move |_| {
            CannedResponse::json(
                if count.fetch_add(1, Ordering::SeqCst) < 2 {
                    401
                } else {
                    200
                },
                "{}",
            )
        });
        let client = TwitchClient::new(
            "client",
            fixture_endpoints(&recorder),
            Some(Duration::from_secs(2)),
        )
        .unwrap();
        let source = SequenceSource {
            tokens: Mutex::new(vec![
                Ok(AccessToken::app("one")),
                Err(TokenSourceError::Unavailable),
                Ok(AccessToken::app("two")),
            ]),
        };
        let result = client
            .request(
                &source,
                &TwitchAuth::App,
                HelixRequest {
                    method: Method::POST,
                    endpoint: "users",
                    params: Some("id=1"),
                    body: Some(&json!({"x":1})),
                },
                &HelixRetryPolicy::from_millis(&[0, 0]),
            )
            .await
            .unwrap();
        assert_eq!(
            (
                result.response.status().as_u16(),
                result.attempts,
                result.token_reload_failures
            ),
            (200, 3, 1)
        );
        for expected in ["Bearer one", "Bearer one", "Bearer two"] {
            let request = recorder.next(Duration::from_secs(2));
            assert_eq!(request.path, "/helix/users?id=1");
            assert_eq!(request.method, "POST");
            assert_eq!(request.header("authorization"), Some(expected));
            assert_eq!(request.header("client-id"), Some("client"));
            assert_eq!(
                serde_json::from_slice::<Value>(&request.body).unwrap(),
                json!({"x":1})
            );
        }
    }

    #[tokio::test]
    async fn helix_exhaustion_and_non401_do_not_refresh_forever() {
        let recorder = Recorder::start(|_| CannedResponse::json(401, "{}"));
        let client = TwitchClient::new(
            "client",
            fixture_endpoints(&recorder),
            Some(Duration::from_secs(2)),
        )
        .unwrap();
        let source = SequenceSource {
            tokens: Mutex::new(
                (0..4)
                    .map(|_| Ok(AccessToken::user("bot", TWITCH_BOT_ACCOUNT_ID)))
                    .collect(),
            ),
        };
        let result = client
            .request(
                &source,
                &TwitchAuth::Bot,
                HelixRequest {
                    method: Method::GET,
                    endpoint: "chat/messages",
                    params: None,
                    body: None,
                },
                &HelixRetryPolicy::from_millis(&[0, 0, 0]),
            )
            .await
            .unwrap();
        assert_eq!(
            (result.attempts, result.response.status().as_u16()),
            (4, 401)
        );
        assert_eq!(
            HelixRetryPolicy::from_millis(&[]).delays,
            vec![
                Duration::from_secs(1),
                Duration::from_secs(3),
                Duration::from_secs(5)
            ]
        );
        let recorder = Recorder::start(|_| CannedResponse::json(503, "{}"));
        let client = TwitchClient::new("client", fixture_endpoints(&recorder), None).unwrap();
        let source = SequenceSource {
            tokens: Mutex::new(vec![Ok(AccessToken::app("app"))]),
        };
        assert_eq!(
            client
                .request(
                    &source,
                    &TwitchAuth::App,
                    HelixRequest {
                        method: Method::GET,
                        endpoint: "users",
                        params: None,
                        body: None
                    },
                    &HelixRetryPolicy::default()
                )
                .await
                .unwrap()
                .attempts,
            1
        );
    }

    #[test]
    fn classification_fixtures_from_tokens_ts() {
        for (status, payload, expected) in [
            (
                400,
                json!({"message":"Invalid refresh token"}),
                RefreshFailureKind::Permanent,
            ),
            (
                401,
                json!({"error_description":" Authorization has been revoked "}),
                RefreshFailureKind::Permanent,
            ),
            (
                400,
                json!({"error":"invalid grant"}),
                RefreshFailureKind::Permanent,
            ),
            (
                400,
                json!({"error":"invalid_grant"}),
                RefreshFailureKind::Transient,
            ),
            (
                403,
                json!({"message":"revoked"}),
                RefreshFailureKind::Transient,
            ),
            (
                500,
                json!({"message":"invalid refresh"}),
                RefreshFailureKind::Transient,
            ),
            (
                401,
                json!({"message":"invalid client"}),
                RefreshFailureKind::Transient,
            ),
            (
                400,
                json!({"message":42,"error":"   "}),
                RefreshFailureKind::Transient,
            ),
        ] {
            assert_eq!(classify_refresh_failure(status, &payload), expected);
        }
        assert_eq!(
            refresh_failure_message(
                &json!({"message":" m ","error_description":" d ","error":"e"})
            ),
            " m  |  d  | e"
        );
        assert_eq!(
            refresh_failure_message(&json!({"message":"\u{feff}","error":"invalid grant"})),
            "invalid grant"
        );
        assert_eq!(
            refresh_failure_message(&json!({"message":"\u{0085}","error":"invalid grant"})),
            "\u{0085} | invalid grant"
        );
        assert_eq!(
            RefreshPolicy::from_millis(&[]).delays,
            vec![Duration::from_millis(400), Duration::from_millis(900)]
        );
        assert!(js_truthy(&json!({})));
        assert!(js_truthy(&json!([])));
        assert!(!js_truthy(&json!(0)));
    }

    #[tokio::test]
    async fn refresh_form_encoding_retries_and_js_expiry_default() {
        let count = AtomicUsize::new(0);
        let recorder = Recorder::start(move |_| {
            if count.fetch_add(1, Ordering::SeqCst) == 0 {
                CannedResponse::json(503, "{}")
            } else {
                CannedResponse::json(
                    200,
                    r#"{"access_token":"access","refresh_token":"rotated","expires_in":"3600"}"#,
                )
            }
        });
        let client = TwitchOAuthClient::new(
            credentials(),
            fixture_endpoints(&recorder),
            Some(Duration::from_secs(2)),
        )
        .unwrap();
        let tokens = client
            .refresh(
                "refresh&+ /",
                "streamer",
                &RefreshPolicy::from_millis(&[0, 0]),
            )
            .await
            .unwrap();
        assert_eq!(tokens.expires_in, 7200.0);
        assert_eq!(tokens.refresh_token.as_deref(), Some("rotated"));
        assert!(
            build_headers(
                "client",
                &tokens.access_token,
                &TwitchAuth::Streamer("streamer".into())
            )
            .is_ok()
        );
        for _ in 0..2 {
            let request = recorder.next(Duration::from_secs(2));
            assert_eq!(request.path, "/oauth2/token");
            assert_eq!(request.method, "POST");
            assert_eq!(
                request.header("content-type"),
                Some("application/x-www-form-urlencoded")
            );
            let parsed = Url::parse(&format!(
                "http://fixture.invalid/?{}",
                String::from_utf8(request.body).unwrap()
            ))
            .unwrap();
            let fields: BTreeMap<_, _> = parsed.query_pairs().into_owned().collect();
            assert_eq!(
                fields.get("client_secret").map(String::as_str),
                Some("secret&+fixture")
            );
            assert_eq!(
                fields.get("refresh_token").map(String::as_str),
                Some("refresh&+ /")
            );
            assert_eq!(
                fields.get("grant_type").map(String::as_str),
                Some("refresh_token")
            );
        }
    }

    #[tokio::test]
    async fn refresh_exhaustion_parse_incomplete_and_permanent_failures() {
        for (status, body, attempts, kind) in [
            (
                503,
                r#"{"message":"busy"}"#,
                3,
                RefreshFailureKind::Transient,
            ),
            (
                400,
                r#"{"message":"Invalid refresh token refresh-fixture"}"#,
                1,
                RefreshFailureKind::Permanent,
            ),
            (200, "invalid json", 1, RefreshFailureKind::Transient),
            (
                200,
                r#"{"access_token":"access"}"#,
                1,
                RefreshFailureKind::Transient,
            ),
            (200, r#"{"error":{}}"#, 1, RefreshFailureKind::Transient),
            (429, "{}", 1, RefreshFailureKind::Transient),
        ] {
            let recorder = Recorder::start(move |_| CannedResponse::json(status, body));
            let client = TwitchOAuthClient::new(
                credentials(),
                fixture_endpoints(&recorder),
                Some(Duration::from_secs(2)),
            )
            .unwrap();
            let failure = client
                .refresh(
                    "refresh-fixture",
                    "id",
                    &RefreshPolicy::from_millis(&[0, 0]),
                )
                .await
                .unwrap_err();
            assert_eq!(
                (failure.attempts, failure.kind, failure.status),
                (attempts, kind, Some(status))
            );
            assert!(!failure.message.contains("refresh-fixture"));
        }
        let recorder = Recorder::start(|_| {
            CannedResponse::json(200, r#"{"access_token":"app","expires_in":3600}"#)
        });
        let client =
            TwitchOAuthClient::new(credentials(), fixture_endpoints(&recorder), None).unwrap();
        let tokens = client.app_token().await.unwrap();
        assert_eq!(tokens.expires_in, 3600.0);
        let request = recorder.next(Duration::from_secs(2));
        assert!(
            String::from_utf8(request.body)
                .unwrap()
                .contains("grant_type=client_credentials")
        );
    }

    #[tokio::test]
    async fn refresh_network_exhaustion_is_transient_and_redacted() {
        // Keep the refused endpoint reserved throughout every retry so another
        // concurrent loopback fixture cannot acquire and answer on this port.
        let reserved = tokio::net::TcpSocket::new_v4().unwrap();
        reserved.bind("127.0.0.1:0".parse().unwrap()).unwrap();
        let base = format!("http://{}", reserved.local_addr().unwrap());
        let endpoints =
            TwitchEndpoints::new(&format!("{base}/helix/"), &format!("{base}/oauth2/")).unwrap();
        let client =
            TwitchOAuthClient::new(credentials(), endpoints, Some(Duration::from_millis(300)))
                .unwrap();
        let failure = client
            .refresh(
                "private-refresh",
                "user",
                &RefreshPolicy::from_millis(&[0, 0]),
            )
            .await
            .unwrap_err();
        assert_eq!(
            (failure.kind, failure.status, failure.attempts),
            (RefreshFailureKind::Transient, None, 3)
        );
        assert!(!format!("{failure:?} {failure}").contains("private-refresh"));
        drop(reserved);
    }

    #[tokio::test]
    async fn oauth_and_helix_redirects_do_not_forward_credentials() {
        let count = std::sync::Arc::new(AtomicUsize::new(0));
        let observed = count.clone();
        let target = Recorder::start(move |_| {
            observed.fetch_add(1, Ordering::SeqCst);
            CannedResponse::json(200, "{}")
        });
        let location = format!("{}/must-not-receive", target.base_url);
        let recorder = Recorder::start(move |_| CannedResponse {
            status: 307,
            headers: vec![("location", location.clone())],
            body: Vec::new(),
        });
        let endpoints = fixture_endpoints(&recorder);
        let client =
            TwitchClient::new("client", endpoints.clone(), Some(Duration::from_secs(2))).unwrap();
        let source = SequenceSource {
            tokens: Mutex::new(vec![Ok(AccessToken::app("private"))]),
        };
        let result = client
            .request(
                &source,
                &TwitchAuth::App,
                HelixRequest {
                    method: Method::GET,
                    endpoint: "users",
                    params: None,
                    body: None,
                },
                &HelixRetryPolicy::default(),
            )
            .await
            .unwrap();
        assert_eq!(
            (result.response.status().as_u16(), result.attempts),
            (307, 1)
        );
        let oauth =
            TwitchOAuthClient::new(credentials(), endpoints, Some(Duration::from_secs(2))).unwrap();
        let failure = oauth
            .refresh(
                "private-refresh",
                "user",
                &RefreshPolicy::from_millis(&[0, 0]),
            )
            .await
            .unwrap_err();
        assert_eq!(
            (failure.status, failure.attempts, failure.kind),
            (Some(307), 1, RefreshFailureKind::Transient)
        );
        assert_eq!(count.load(Ordering::SeqCst), 0);
    }

    #[tokio::test]
    async fn refresh_preserves_numeric_js_expiries_and_false_error_values() {
        for expiry in [0.0, -2.0, 1.5] {
            let body = json!({"access_token":"access", "refresh_token":"refresh", "expires_in":expiry, "error":false}).to_string();
            let recorder = Recorder::start(move |_| CannedResponse::json(200, &body));
            let client = TwitchOAuthClient::new(
                credentials(),
                fixture_endpoints(&recorder),
                Some(Duration::from_secs(2)),
            )
            .unwrap();
            let tokens = client
                .refresh("old", "user", &RefreshPolicy::default())
                .await
                .unwrap();
            assert_eq!(tokens.expires_in, expiry);
        }
    }

    #[test]
    fn diagnostics_redact_nested_credentials_and_js_lengths() {
        assert_eq!(
            sanitize_authorization("Bearer 😀"),
            "Bearer <token_length:2>"
        );
        assert_eq!(sanitize_authorization("Basic credential"), "<redacted>");
        assert_eq!(
            redact_known("secret%26%2Bfixture".into(), &["secret&+fixture"]),
            "<redacted>"
        );
        let mut headers =
            build_headers("client", &AccessToken::app("private"), &TwitchAuth::App).unwrap();
        headers.insert("cookie", HeaderValue::from_static("private-cookie"));
        let diagnostic = api_failure_diagnostic(
            "now",
            "https://u:p@api.twitch.tv/helix/chat/messages?access_token=private&x=private#private",
            "GET",
            &headers,
            401,
            r#"{"access_token":"leak","nested":[{"client_secret":"leak"}],"message":"private"}"#,
            &["private"],
        );
        let text = diagnostic.to_string();
        assert!(!text.contains("private"));
        assert!(!text.contains("leak"));
        assert!(!text.contains("u:p"));
        assert_eq!(diagnostic["endpoint"], "chat/messages");
        assert_eq!(
            diagnostic["headers"]["authorization"],
            "Bearer <token_length:7>"
        );
        assert_eq!(extract_endpoint("not a url"), "unknown");
        assert_eq!(
            diagnostic_body("private raw html", &[]),
            "<non-JSON response omitted>"
        );
    }
}
