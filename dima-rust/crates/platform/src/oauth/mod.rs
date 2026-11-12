//! The OAuth 2 server the desktop app signs in through (reference:
//! `dimabot/src/server/oauth/service.ts`, `catalog.ts`, and `browserUser` in `routes.ts`).
//!
//! # Protocol
//!
//! Authorization code with PKCE (S256 only) for public clients, refresh-token rotation, RFC 7009
//! revocation. Every secret is 32 random bytes in base64url (43 characters): request ids and
//! codes bare, access tokens `dima_at_…`, refresh tokens `dima_rt_…`. At rest only their SHA-256
//! (base64url) exists, exactly as the reference stores it, so sessions and refresh tokens issued
//! by either implementation work with the other (`tests/oauth.rs` proves both directions).
//!
//! | step | stored | lifetime |
//! |---|---|---|
//! | [`OAuthService::start_authorization`] | `oauth:request:{hash(id)}` JSON [`AuthorizationRequest`] | 600 s |
//! | [`OAuthService::approve_authorization`] | `oauth:code:{hash(code)}` JSON [`AuthorizationCode`]; the request is consumed (`GETDEL`) | 60 s |
//! | [`OAuthService::exchange_code`] | the code is consumed (`GETDEL`); grant upserted, session and first refresh token created in MongoDB; `oauth:access:{hash(token)}` JSON [`AccessIdentity`] | access 600 s; refresh idle 30 days, absolute 90 days |
//! | [`OAuthService::refresh_access`] | a new refresh token; the session's current hash moved by compare-and-set; the old token marked used | idle extended, never past the absolute expiry |
//!
//! # Decisions kept from the reference
//!
//! - The checks run in the reference's order, so every refusal has its error code and status.
//! - A refresh token presented after it was rotated, or by a request that loses the
//!   compare-and-set, **revokes the whole session** (`refresh_reuse`): two refreshes of one token
//!   at the same moment give one token response, an `invalid_grant` for the other, and a revoked
//!   session, whose new tokens then stop working. That is reuse detection working as designed
//!   (a stolen token and a double submit look the same).
//! - A code is consumed only once all its checks passed (`GETDEL` decides between two exchanges
//!   at the same moment: one session); a wrong verifier does not burn it.
//! - A revocation always wins: the rotation's compare-and-set requires `revoked_at: null`, and
//!   every access check reads the session.
//! - Access tokens are checked against the session on every use, so a revoked or expired
//!   session, a revoked grant, a removed account, a disabled client or a scope no longer allowed
//!   ends access at once (a disabled client answers `invalid_client` 400 there, as in the
//!   reference).
//!
//! # Intended differences
//!
//! - A store that fails or misses its deadline is [`OAuthError::UNAVAILABLE`] (503
//!   `temporarily_unavailable`, the reference's answer for any unexpected error) everywhere,
//!   including inside a refresh, where the reference turned it into `invalid_grant`, telling the
//!   desktop app to drop a refresh token that was still good.
//! - Two exchanges that upsert the same grant at the same moment: the loser of the unique index
//!   retries once instead of failing with 503.
//! - `device_name` counts characters, not UTF-16 units (80 at most, `MIGRATION.md` section 4).
//! - Comparisons of the PKCE challenge and of refresh-token hashes are constant-time.
//!
//! # Dragonfly at the cutover
//!
//! The four key families are Rust's own (*rebuilt*): requests and codes live 10 minutes and one
//! minute; access tokens live 10 minutes, and the desktop app refreshes on `invalid_token`.
//! Sessions, grants and refresh tokens are in MongoDB and are carried as they are.

pub mod catalog;

use crate::auth::truthy;
use crate::auth::twitch::{Scheme, TwitchUserApi};
use bson::oid::ObjectId;
use bson::{Bson, DateTime, Document, RawDocumentBuf, doc};
use catalog::{
    ACCESS_TTL_SECONDS, CODE_TTL_SECONDS, DESKTOP_CLIENT_ID, DESKTOP_REDIRECT_URIS,
    REFRESH_IDLE_MS, REQUEST_TTL_SECONDS, SESSION_ABSOLUTE_MS, active_scopes, is_active,
    parse_scopes, validate_redirect, validate_redirect_str,
};
use dima_core::crypto::digest::constant_time_eq;
use dima_core::crypto::keys::{oauth_secret, sha256_base64url};
use dima_core::{Clock, SecretString, SecureRandom};
use dima_model::oauth_clients::{self, OAuthClient};
use dima_model::oauth_grants::{self, OAuthGrant};
use dima_model::oauth_refresh_tokens::{self, NewOAuthRefreshToken, OAuthRefreshToken};
use dima_model::oauth_sessions::{self, NewOAuthSession, OAuthSession};
use dima_model::private::Private;
use dima_model::users::{self, AccountType, User};
use dima_store::dragonfly::{Dragonfly, Script, SetOptions};
use dima_store::mongo::date::JsDate;
use dima_store::mongo::update::{Returned, UpdateOptions};
use dima_store::mongo::{MongoStore, WriteContext};
use dima_web::Response;
use futures_util::TryStreamExt;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};
use std::fmt;
use std::sync::Arc;
use std::time::Duration;

/// An OAuth error: the code the client sees (`{"error": code}`) and the HTTP status.
#[derive(Clone, Copy, Debug, PartialEq, Eq, thiserror::Error)]
#[error("{code}")]
pub struct OAuthError {
    code: &'static str,
    status: u16,
}

impl OAuthError {
    /// `invalid_request` 400.
    pub const INVALID_REQUEST: Self = Self::new("invalid_request", 400);
    /// `invalid_client` 400.
    pub const INVALID_CLIENT: Self = Self::new("invalid_client", 400);
    /// `invalid_scope` 400.
    pub const INVALID_SCOPE: Self = Self::new("invalid_scope", 400);
    /// `invalid_grant` 400.
    pub const INVALID_GRANT: Self = Self::new("invalid_grant", 400);
    /// `unsupported_grant_type` 400.
    pub const UNSUPPORTED_GRANT_TYPE: Self = Self::new("unsupported_grant_type", 400);
    /// `invalid_token` 401.
    pub const INVALID_TOKEN: Self = Self::new("invalid_token", 401);
    /// `login_required` 401.
    pub const LOGIN_REQUIRED: Self = Self::new("login_required", 401);
    /// `account_required` 403.
    pub const ACCOUNT_REQUIRED: Self = Self::new("account_required", 403);
    /// `insufficient_scope` 403.
    pub const INSUFFICIENT_SCOPE: Self = Self::new("insufficient_scope", 403);
    /// `access_denied` 403.
    pub const ACCESS_DENIED: Self = Self::new("access_denied", 403);
    /// `not_found` 404.
    pub const NOT_FOUND: Self = Self::new("not_found", 404);
    /// `slow_down` 429.
    pub const SLOW_DOWN: Self = Self::new("slow_down", 429);
    /// A store or Twitch failed: the reference's answer for an unexpected error,
    /// `temporarily_unavailable` 503.
    pub const UNAVAILABLE: Self = Self::new("temporarily_unavailable", 503);

    /// An error with `code` and `status`.
    pub const fn new(code: &'static str, status: u16) -> Self {
        Self { code, status }
    }

    /// The code.
    pub fn code(self) -> &'static str {
        self.code
    }

    /// The HTTP status.
    pub fn status(self) -> u16 {
        self.status
    }

    /// The OAuth routers' error handler: `{"error": code}`, `WWW-Authenticate: Bearer
    /// error="invalid_token"` on 401, `Retry-After: 60` on 429.
    pub fn response(self) -> Response {
        let mut response = Response::status(self.status).json(&json!({ "error": self.code }));
        if self.status == 401 {
            response = response.header("WWW-Authenticate", "Bearer error=\"invalid_token\"");
        }
        if self.status == 429 {
            response = response.header("Retry-After", "60");
        }
        response
    }
}

fn unavailable<E>(_: E) -> OAuthError {
    OAuthError::UNAVAILABLE
}

/// A request body or query: what the reference received as `Record<string, unknown>`.
pub type Input = Map<String, Value>;

/// `AuthorizationRequest` (stored under `oauth:request:…`).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct AuthorizationRequest {
    /// The client.
    pub client_id: String,
    /// The validated loopback callback.
    pub redirect_uri: String,
    /// The requested scopes.
    pub scopes: Vec<String>,
    /// The client's `state`.
    pub state: String,
    /// The PKCE challenge (SHA-256 of the verifier, base64url).
    pub code_challenge: String,
    /// The device's name.
    pub device_name: String,
}

/// `AuthorizationCode` (stored under `oauth:code:…`).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct AuthorizationCode {
    /// The approved request.
    #[serde(flatten)]
    pub request: AuthorizationRequest,
    /// `users._id` as hex.
    pub user_id: String,
    /// The Twitch channel id.
    pub channel_id: String,
}

/// `AccessIdentity` (stored under `oauth:access:…`; what a route gets for a valid access token).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct AccessIdentity {
    /// `oauth_sessions._id` as hex.
    pub session_id: String,
    /// `users._id` as hex.
    pub user_id: String,
    /// The client.
    pub client_id: String,
    /// The Twitch channel id.
    pub channel_id: String,
    /// The granted scopes.
    pub scopes: Vec<String>,
}

/// The token endpoint's answer. `Debug` never shows the tokens.
pub struct TokenResponse {
    access_token: SecretString,
    refresh_token: SecretString,
    scope: String,
    session_id: String,
    refresh_expires_in: i64,
}

impl fmt::Debug for TokenResponse {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("TokenResponse")
            .field("scope", &self.scope)
            .field("session_id", &self.session_id)
            .field("refresh_expires_in", &self.refresh_expires_in)
            .finish_non_exhaustive()
    }
}

impl TokenResponse {
    /// The access token.
    pub fn access_token(&self) -> &SecretString {
        &self.access_token
    }

    /// The refresh token.
    pub fn refresh_token(&self) -> &SecretString {
        &self.refresh_token
    }

    /// The session id.
    pub fn session_id(&self) -> &str {
        &self.session_id
    }

    /// Seconds until the refresh token stops working (idle or absolute expiry, whichever first).
    pub fn refresh_expires_in(&self) -> i64 {
        self.refresh_expires_in
    }

    /// The JSON body, in the reference's key order.
    pub fn body(&self) -> Value {
        json!({
            "access_token": self.access_token.expose(),
            "token_type": "Bearer",
            "expires_in": ACCESS_TTL_SECONDS,
            "refresh_token": self.refresh_token.expose(),
            "scope": self.scope,
            "session_id": self.session_id,
            "refresh_expires_in": self.refresh_expires_in,
        })
    }
}

/// `browserUser`: the site account behind a fresh Twitch proof.
#[derive(Clone, Debug)]
pub struct BrowserUser {
    /// The site account.
    pub user: User,
    /// The Twitch id the proof named.
    pub twitch_id: String,
}

/// Typed configuration, validated at start.
#[derive(Clone, Debug)]
pub struct OAuthConfig {
    issuer: String,
    website: String,
    twitch_client_id: String,
    /// Deadline of each store call.
    pub store_deadline: Duration,
    /// Deadline of the fresh Twitch proof (the reference's `AbortSignal.timeout(5000)`).
    pub browser_proof_timeout: Duration,
}

/// The configuration cannot be used.
#[derive(Clone, Debug, PartialEq, Eq, thiserror::Error)]
pub enum OAuthConfigError {
    /// A URL does not parse or is not `http:`/`https:`.
    #[error("{0} must be an http or https URL")]
    Url(&'static str),
    /// `CLIENT_ID` is empty.
    #[error("CLIENT_ID must be set")]
    MissingClientId,
}

fn origin(
    value: Option<&str>,
    default: &str,
    name: &'static str,
) -> Result<String, OAuthConfigError> {
    let text = value.filter(|v| !v.is_empty()).unwrap_or(default);
    let url = url::Url::parse(text).map_err(|_| OAuthConfigError::Url(name))?;
    if !matches!(url.scheme(), "http" | "https") {
        return Err(OAuthConfigError::Url(name));
    }
    Ok(url.origin().ascii_serialization())
}

impl OAuthConfig {
    /// `oauthIssuer()` from `PUBLIC_API_URL` and `oauthWebsite()` from `DASHBOARD_URL` (unset or
    /// empty: the production defaults), `CLIENT_ID` for the browser proof.
    pub fn new(
        public_api_url: Option<&str>,
        dashboard_url: Option<&str>,
        twitch_client_id: &str,
    ) -> Result<Self, OAuthConfigError> {
        if twitch_client_id.is_empty() || twitch_client_id == "undefined" {
            return Err(OAuthConfigError::MissingClientId);
        }
        Ok(Self {
            issuer: origin(
                public_api_url,
                "https://api.domdimabot.com",
                "PUBLIC_API_URL",
            )?,
            website: origin(dashboard_url, "https://domdimabot.com", "DASHBOARD_URL")?,
            twitch_client_id: twitch_client_id.to_owned(),
            store_deadline: Duration::from_secs(5),
            browser_proof_timeout: Duration::from_secs(5),
        })
    }

    /// `oauthIssuer()`.
    pub fn issuer(&self) -> &str {
        &self.issuer
    }

    /// `oauthWebsite()`.
    pub fn website(&self) -> &str {
        &self.website
    }
}

/// What the service needs.
pub struct OAuthDeps {
    /// The four OAuth collections and `users`.
    pub mongo: MongoStore,
    /// Requests, codes, access tokens, rate buckets.
    pub cache: Dragonfly,
    /// The clock.
    pub clock: Arc<dyn Clock>,
    /// Secrets come from here.
    pub random: Arc<dyn SecureRandom>,
    /// The fresh browser proof.
    pub twitch: Arc<dyn TwitchUserApi>,
}

/// Where a test may stop a flow (feature `test-util`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum HookPoint {
    /// A refresh passed its checks and is about to rotate.
    BeforeRotation,
    /// An exchange passed its checks and is about to consume the code.
    BeforeCodeConsumed,
}

/// A test hook.
#[cfg(feature = "test-util")]
pub type Hook =
    Arc<dyn Fn(HookPoint) -> futures_util::future::BoxFuture<'static, ()> + Send + Sync>;

/// The OAuth service: one per process.
pub struct OAuthService {
    config: OAuthConfig,
    deps: OAuthDeps,
    #[cfg(feature = "test-util")]
    hook: Option<Hook>,
}

impl fmt::Debug for OAuthService {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("OAuthService")
            .field("config", &self.config)
            .finish_non_exhaustive()
    }
}

/// `oauthRoute`'s rate-limit script, verbatim (`service.ts:47`).
pub static RATE_LIMIT: Script =
    Script::new("OAUTH_RATE_LIMIT_SCRIPT", include_str!("rate_limit.lua"));

fn is_b64url(value: &str) -> bool {
    value
        .bytes()
        .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

/// `validSecret`: `^[A-Za-z0-9_-]{43}$`.
fn valid_secret(value: &str) -> bool {
    value.len() == 43 && is_b64url(value)
}

/// `^<prefix>[A-Za-z0-9_-]{43}$`.
fn prefixed_secret(value: &str, prefix: &str) -> bool {
    value.strip_prefix(prefix).is_some_and(valid_secret)
}

/// The PKCE verifier: `^[A-Za-z0-9._~-]{43,128}$`.
fn valid_verifier(value: &str) -> bool {
    (43..=128).contains(&value.len())
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'~' | b'-'))
}

fn text<'a>(input: &'a Input, key: &str) -> Option<&'a str> {
    input.get(key).and_then(Value::as_str)
}

fn request_key(id: &str) -> String {
    format!("oauth:request:{}", sha256_base64url(id))
}

fn code_key(code: &str) -> String {
    format!("oauth:code:{}", sha256_base64url(code))
}

fn access_key(token: &str) -> String {
    format!("oauth:access:{}", sha256_base64url(token))
}

/// `[\u0000-\u001f\u007f]`.
fn has_control(text: &str) -> bool {
    text.chars().any(|c| c <= '\u{1f}' || c == '\u{7f}')
}

fn date(ms: i64) -> Bson {
    Bson::DateTime(DateTime::from_millis(ms))
}

impl OAuthService {
    /// A new service.
    pub fn new(config: OAuthConfig, deps: OAuthDeps) -> Self {
        Self {
            config,
            deps,
            #[cfg(feature = "test-util")]
            hook: None,
        }
    }

    /// Stops flows at [`HookPoint`]s (tests only).
    #[cfg(feature = "test-util")]
    #[must_use]
    pub fn with_hook(mut self, hook: Hook) -> Self {
        self.hook = Some(hook);
        self
    }

    #[allow(clippy::unused_async)]
    async fn hook(&self, point: HookPoint) {
        #[cfg(feature = "test-util")]
        if let Some(hook) = &self.hook {
            hook(point).await;
        }
        let _ = point;
    }

    /// The configuration.
    pub fn config(&self) -> &OAuthConfig {
        &self.config
    }

    fn now(&self) -> i64 {
        self.deps.clock.now_ms()
    }

    async fn bounded<T, E>(
        &self,
        future: impl Future<Output = Result<T, E>>,
    ) -> Result<T, OAuthError> {
        match tokio::time::timeout(self.config.store_deadline, future).await {
            Ok(Ok(value)) => Ok(value),
            _ => Err(OAuthError::UNAVAILABLE),
        }
    }

    fn secret(&self, prefix: &str) -> Result<String, OAuthError> {
        oauth_secret(self.deps.random.as_ref(), prefix).map_err(unavailable)
    }

    async fn find_one(
        &self,
        collection: &str,
        filter: Document,
        projection: Option<Document>,
    ) -> Result<Option<RawDocumentBuf>, OAuthError> {
        let collection = self.deps.mongo.collection::<RawDocumentBuf>(collection);
        self.bounded(async {
            let mut action = collection.find_one(filter);
            if let Some(projection) = projection {
                action = action.projection(projection);
            }
            action.await
        })
        .await
    }

    async fn find_decoded<T: serde::de::DeserializeOwned>(
        &self,
        collection: &str,
        filter: Document,
    ) -> Result<Option<T>, OAuthError> {
        match self.find_one(collection, filter, None).await? {
            Some(raw) => dima_model::decode(&raw).map(Some).map_err(unavailable),
            None => Ok(None),
        }
    }

    async fn exists(&self, collection: &str, filter: Document) -> Result<bool, OAuthError> {
        Ok(self
            .find_one(collection, filter, Some(doc! { "_id": 1 }))
            .await?
            .is_some())
    }

    async fn cache_get(&self, key: &str) -> Result<Option<Vec<u8>>, OAuthError> {
        self.bounded(self.deps.cache.get(key)).await
    }

    async fn cache_getdel(&self, key: &str) -> Result<Option<Vec<u8>>, OAuthError> {
        self.bounded(
            self.deps
                .cache
                .query::<Option<Vec<u8>>>(redis::cmd("GETDEL").arg(key)),
        )
        .await
    }

    async fn cache_set_json<T: Serialize>(
        &self,
        key: &str,
        value: &T,
        ttl: u64,
    ) -> Result<(), OAuthError> {
        let bytes = serde_json::to_vec(value).map_err(unavailable)?;
        self.bounded(self.deps.cache.set(key, &bytes, SetOptions::ex(ttl)))
            .await
            .map(|_| ())
    }

    // ------------------------------------------------------------------------------ clients

    /// `initializeOAuth`'s writes: the desktop client is created once, and newly active scopes
    /// are added to it (existing grants and sessions never grow). The binary creates the four
    /// collections' indexes first ([`dima_model::ensure_indexes`], the reference's `init()`).
    pub async fn initialize(&self) -> Result<(), OAuthError> {
        let active: Vec<&str> = active_scopes();
        let now = self.now();
        let filter = doc! { "client_id": DESKTOP_CLIENT_ID };
        let insert = doc! { "$setOnInsert": {
            "name": "Dima Desktop Beta",
            "type": "public",
            "enabled": true,
            "redirect_uris": DESKTOP_REDIRECT_URIS.to_vec(),
            "allowed_scopes": active.clone(),
        } };
        let grow = doc! { "$addToSet": { "allowed_scopes": { "$each": active } } };
        for (update, options) in [
            (insert, UpdateOptions::upsert()),
            (grow, UpdateOptions::default()),
        ] {
            let prepared = oauth_clients::INFO
                .prepare_update(&filter, update, options, &mut WriteContext::new(now))
                .map_err(unavailable)?;
            let mut writes = self.deps.mongo.writes(oauth_clients::COLLECTION);
            self.bounded(writes.update_one(&prepared)).await?;
        }
        Ok(())
    }

    /// `getClient`: an enabled client by id (a string of at most 100 UTF-16 units).
    pub async fn get_client(&self, client_id: Option<&Value>) -> Result<OAuthClient, OAuthError> {
        let Some(Value::String(id)) = client_id else {
            return Err(OAuthError::INVALID_CLIENT);
        };
        self.client(id).await
    }

    async fn client(&self, id: &str) -> Result<OAuthClient, OAuthError> {
        if dima_text::utf16_len(id) > 100 {
            return Err(OAuthError::INVALID_CLIENT);
        }
        self.find_decoded(
            oauth_clients::COLLECTION,
            doc! { "client_id": id, "enabled": true },
        )
        .await?
        .ok_or(OAuthError::INVALID_CLIENT)
    }

    /// `rateLimit`: a fixed one-minute window per bucket (`oauth:rate:{hash(bucket)}`);
    /// more than `limit` calls in it is `slow_down` 429.
    pub async fn rate_limit(&self, bucket: &str, limit: u64) -> Result<(), OAuthError> {
        let key = format!("oauth:rate:{}", sha256_base64url(bucket));
        let count: i64 = self
            .bounded(RATE_LIMIT.run::<i64, _, &str>(&self.deps.cache, &[key], &[]))
            .await?;
        if u64::try_from(count).unwrap_or(0) > limit {
            return Err(OAuthError::SLOW_DOWN);
        }
        Ok(())
    }

    // ------------------------------------------------------------------------ authorization

    /// `startAuthorization`: checks the request and stores it; returns its id.
    pub async fn start_authorization(&self, input: &Input) -> Result<String, OAuthError> {
        let challenge = text(input, "code_challenge").filter(|v| valid_secret(v));
        let state = text(input, "state").filter(|v| valid_secret(v));
        let (true, true, Some(challenge), Some(state)) = (
            text(input, "response_type") == Some("code"),
            text(input, "code_challenge_method") == Some("S256"),
            challenge,
            state,
        ) else {
            return Err(OAuthError::INVALID_REQUEST);
        };
        let client = self.get_client(input.get("client_id")).await?;
        let redirect = validate_redirect(input.get("redirect_uri"), &client.redirect_uris)?;
        let scopes = parse_scopes(input.get("scope"))?;
        if scopes.iter().any(|s| !client.allowed_scopes.contains(s)) {
            return Err(OAuthError::INVALID_SCOPE);
        }
        let device_name = match input.get("device_name") {
            None => "Desktop computer".to_owned(),
            Some(Value::String(name)) => {
                let trimmed = dima_text::trim(name);
                if trimmed.is_empty()
                    || name.chars().count() > oauth_sessions::DEVICE_NAME_MAX_CHARS
                    || has_control(name)
                {
                    return Err(OAuthError::INVALID_REQUEST);
                }
                trimmed.to_owned()
            }
            Some(_) => return Err(OAuthError::INVALID_REQUEST),
        };
        let request = AuthorizationRequest {
            client_id: client.client_id,
            redirect_uri: redirect,
            scopes,
            state: state.to_owned(),
            code_challenge: challenge.to_owned(),
            device_name,
        };
        let id = self.secret("")?;
        self.cache_set_json(&request_key(&id), &request, REQUEST_TTL_SECONDS)
            .await?;
        Ok(id)
    }

    /// `getAuthorization`: a pending request whose client, callback and scopes are still valid.
    pub async fn get_authorization(&self, id: &str) -> Result<AuthorizationRequest, OAuthError> {
        if !valid_secret(id) {
            return Err(OAuthError::INVALID_REQUEST);
        }
        let Some(bytes) = self.cache_get(&request_key(id)).await? else {
            return Err(OAuthError::INVALID_REQUEST);
        };
        let request: AuthorizationRequest = serde_json::from_slice(&bytes).map_err(unavailable)?;
        let client = self.client(&request.client_id).await?;
        validate_redirect_str(&request.redirect_uri, &client.redirect_uris)?;
        if request
            .scopes
            .iter()
            .any(|s| !client.allowed_scopes.contains(s))
        {
            return Err(OAuthError::INVALID_SCOPE);
        }
        Ok(request)
    }

    /// `approveAuthorization`: the signed-in Twitch account approves or denies; the request is
    /// consumed and the callback URL (with `state`, `iss`, and `code` or `error`) returned.
    pub async fn approve_authorization(
        &self,
        id: &str,
        twitch_id: &str,
        approve: bool,
    ) -> Result<String, OAuthError> {
        let request = self.get_authorization(id).await?;
        let user = self
            .find_one(
                users::COLLECTION,
                users::by_account(AccountType::Twitch, twitch_id),
                Some(doc! { "_id": 1 }),
            )
            .await?;
        let Some(user) = user else {
            return Err(OAuthError::ACCOUNT_REQUIRED);
        };
        let user_id = user.get_object_id("_id").map_err(unavailable)?;
        if self.cache_getdel(&request_key(id)).await?.is_none() {
            return Err(OAuthError::INVALID_REQUEST);
        }
        let mut url = url::Url::parse(&request.redirect_uri).map_err(unavailable)?;
        let code = if approve {
            Some(self.secret("")?)
        } else {
            None
        };
        {
            let mut query = url.query_pairs_mut();
            query
                .append_pair("state", &request.state)
                .append_pair("iss", &self.config.issuer);
            match &code {
                Some(code) => query.append_pair("code", code),
                None => query.append_pair("error", "access_denied"),
            };
        }
        if let Some(code) = code {
            let record = AuthorizationCode {
                request,
                user_id: user_id.to_hex(),
                channel_id: twitch_id.to_owned(),
            };
            self.cache_set_json(&code_key(&code), &record, CODE_TTL_SECONDS)
                .await?;
        }
        Ok(url.into())
    }

    // ------------------------------------------------------------------------------- tokens

    async fn account_exists(
        &self,
        user_id: &ObjectId,
        channel_id: &str,
    ) -> Result<bool, OAuthError> {
        let mut filter = users::by_account(AccountType::Twitch, channel_id);
        filter.insert("_id", *user_id);
        self.exists(users::COLLECTION, filter).await
    }

    async fn upsert_grant(
        &self,
        user_id: ObjectId,
        client_id: &str,
        channel_id: &str,
        scopes: &[String],
    ) -> Result<OAuthGrant, OAuthError> {
        let filter = doc! { "user_id": user_id, "client_id": client_id, "channel_id": channel_id };
        for attempt in 0..2 {
            let update = doc! {
                "$addToSet": { "scopes": { "$each": scopes } },
                "$set": { "revoked_at": Bson::Null },
            };
            let prepared = oauth_grants::INFO
                .prepare_find_one_and_update(
                    &filter,
                    update,
                    UpdateOptions::upsert(),
                    Returned::After,
                    &mut WriteContext::new(self.now()),
                )
                .map_err(unavailable)?;
            let mut writes = self.deps.mongo.writes(oauth_grants::COLLECTION);
            let result = tokio::time::timeout(
                self.config.store_deadline,
                writes.find_one_and_update(&prepared),
            )
            .await;
            match result {
                Ok(Ok(Some(document))) => {
                    return dima_model::decode_document(&document).map_err(unavailable);
                }
                // Two upserts of one grant at once: the unique index refused the second insert,
                // which now finds the grant.
                Ok(Err(dima_store::mongo::write::WriteError::Driver(error)))
                    if attempt == 0 && dima_store::mongo::error::is_duplicate_key(&error) => {}
                _ => return Err(OAuthError::UNAVAILABLE),
            }
        }
        Err(OAuthError::UNAVAILABLE)
    }

    /// `exchangeCode`: a code, its verifier and callback for a session and its first tokens.
    pub async fn exchange_code(&self, input: &Input) -> Result<TokenResponse, OAuthError> {
        let client = self.get_client(input.get("client_id")).await?;
        let (Some(code), Some(verifier)) = (
            text(input, "code").filter(|v| valid_secret(v)),
            text(input, "code_verifier").filter(|v| valid_verifier(v)),
        ) else {
            return Err(OAuthError::INVALID_GRANT);
        };
        let key = code_key(code);
        let Some(bytes) = self.cache_get(&key).await? else {
            return Err(OAuthError::INVALID_GRANT);
        };
        let record: AuthorizationCode = serde_json::from_slice(&bytes).map_err(unavailable)?;
        let challenge = sha256_base64url(verifier);
        if record.request.client_id != client.client_id
            || text(input, "redirect_uri") != Some(record.request.redirect_uri.as_str())
            || !constant_time_eq(
                challenge.as_bytes(),
                record.request.code_challenge.as_bytes(),
            )
            || record
                .request
                .scopes
                .iter()
                .any(|s| !client.allowed_scopes.contains(s))
        {
            return Err(OAuthError::INVALID_GRANT);
        }
        self.hook(HookPoint::BeforeCodeConsumed).await;
        if self.cache_getdel(&key).await?.is_none() {
            return Err(OAuthError::INVALID_GRANT);
        }
        let user_id = ObjectId::parse_str(&record.user_id).map_err(unavailable)?;
        if !self.account_exists(&user_id, &record.channel_id).await? {
            return Err(OAuthError::INVALID_GRANT);
        }
        let grant = self
            .upsert_grant(
                user_id,
                &client.client_id,
                &record.channel_id,
                &record.request.scopes,
            )
            .await?;
        let now = self.now();
        let refresh = self.secret("dima_rt_")?;
        let refresh_hash = sha256_base64url(&refresh);
        let session = NewOAuthSession {
            grant_id: grant.id,
            user_id,
            client_id: record.request.client_id.clone(),
            channel_id: record.channel_id.clone(),
            device_name: record.request.device_name.clone(),
            scopes: record.request.scopes.clone(),
            current_refresh_hash: Private::new(refresh_hash.clone()),
            last_used_at: JsDate(now),
            idle_expires_at: JsDate(now + REFRESH_IDLE_MS),
            expires_at: JsDate(now + SESSION_ABSOLUTE_MS),
        };
        let prepared = session
            .prepare(&mut WriteContext::new(now))
            .map_err(unavailable)?;
        let session_id = prepared
            .document
            .get_object_id("_id")
            .map_err(unavailable)?;
        let mut writes = self.deps.mongo.writes(oauth_sessions::COLLECTION);
        self.bounded(writes.insert_one(&prepared)).await?;
        let issued = async {
            self.store_refresh(&refresh_hash, session_id, now + SESSION_ABSOLUTE_MS)
                .await?;
            self.token_response(
                &AccessIdentity {
                    session_id: session_id.to_hex(),
                    user_id: user_id.to_hex(),
                    client_id: session.client_id.clone(),
                    channel_id: session.channel_id.clone(),
                    scopes: session.scopes.clone(),
                },
                refresh,
                now + REFRESH_IDLE_MS,
                now + SESSION_ABSOLUTE_MS,
            )
            .await
        }
        .await;
        if issued.is_err() {
            let _ = self.revoke_session(&session_id, "issuance_failed").await;
        }
        issued
    }

    async fn store_refresh(
        &self,
        hash: &str,
        session_id: ObjectId,
        expires_at: i64,
    ) -> Result<(), OAuthError> {
        let token = NewOAuthRefreshToken {
            token_hash: Private::new(hash.to_owned()),
            session_id,
            expires_at: JsDate(expires_at),
        };
        let prepared = token
            .prepare(&mut WriteContext::new(self.now()))
            .map_err(unavailable)?;
        let mut writes = self.deps.mongo.writes(oauth_refresh_tokens::COLLECTION);
        self.bounded(writes.insert_one(&prepared)).await
    }

    /// `makeAccess` and the token response.
    async fn token_response(
        &self,
        identity: &AccessIdentity,
        refresh: String,
        idle_expires_at: i64,
        expires_at: i64,
    ) -> Result<TokenResponse, OAuthError> {
        let access = self.secret("dima_at_")?;
        self.cache_set_json(&access_key(&access), identity, ACCESS_TTL_SECONDS)
            .await?;
        let remaining = idle_expires_at.min(expires_at) - self.now();
        Ok(TokenResponse {
            access_token: SecretString::new(access),
            refresh_token: SecretString::new(refresh),
            scope: identity.scopes.join(" "),
            session_id: identity.session_id.clone(),
            refresh_expires_in: remaining.div_euclid(1000).max(0),
        })
    }

    /// `activeSession`: the session if it is unrevoked, unexpired, its grant unrevoked, its
    /// client enabled, its account still connected and every scope still allowed, granted and
    /// active. A missing session is `invalid_token`; a disabled client `invalid_client`.
    async fn active_session(&self, id: &ObjectId) -> Result<OAuthSession, OAuthError> {
        let now = date(self.now());
        let session: Option<OAuthSession> = self
            .find_decoded(
                oauth_sessions::COLLECTION,
                doc! { "_id": id, "revoked_at": Bson::Null,
                "expires_at": { "$gt": now.clone() }, "idle_expires_at": { "$gt": now } },
            )
            .await?;
        let Some(session) = session else {
            return Err(OAuthError::INVALID_TOKEN);
        };
        #[derive(Deserialize)]
        struct GrantScopes {
            #[serde(default)]
            scopes: Vec<String>,
        }
        let grant = match self
            .find_one(
                oauth_grants::COLLECTION,
                doc! { "_id": session.grant_id, "revoked_at": Bson::Null },
                Some(doc! { "scopes": 1 }),
            )
            .await?
        {
            Some(raw) => Some(dima_model::decode::<GrantScopes>(&raw).map_err(unavailable)?),
            None => None,
        };
        let client = self.client(&session.client_id).await?;
        let user = self
            .account_exists(&session.user_id, &session.channel_id)
            .await?;
        let Some(grant) = grant.filter(|_| user) else {
            return Err(OAuthError::INVALID_TOKEN);
        };
        if session.scopes.iter().any(|scope| {
            !client.allowed_scopes.contains(scope)
                || !grant.scopes.contains(scope)
                || !is_active(scope)
        }) {
            return Err(OAuthError::INVALID_TOKEN);
        }
        Ok(session)
    }

    /// `refreshAccess`: rotates a refresh token.
    pub async fn refresh_access(&self, input: &Input) -> Result<TokenResponse, OAuthError> {
        let client = self.get_client(input.get("client_id")).await?;
        let Some(token) = text(input, "refresh_token").filter(|v| prefixed_secret(v, "dima_rt_"))
        else {
            return Err(OAuthError::INVALID_GRANT);
        };
        let token_hash = sha256_base64url(token);
        let record: Option<OAuthRefreshToken> = self
            .find_decoded(
                oauth_refresh_tokens::COLLECTION,
                doc! { "token_hash": &token_hash, "expires_at": { "$gt": date(self.now()) } },
            )
            .await?;
        let Some(record) = record else {
            return Err(OAuthError::INVALID_GRANT);
        };
        let session = match self.active_session(&record.session_id).await {
            Ok(session) => session,
            Err(error) if error == OAuthError::UNAVAILABLE => return Err(error),
            Err(_) => return Err(OAuthError::INVALID_GRANT),
        };
        if session.client_id != client.client_id {
            return Err(OAuthError::INVALID_GRANT);
        }
        if let Some(scope) = input.get("scope")
            && scope.as_str() != Some(session.scopes.join(" ").as_str())
        {
            return Err(OAuthError::INVALID_SCOPE);
        }
        let current = session
            .current_refresh_hash
            .as_ref()
            .map(|hash| hash.expose().as_str())
            .unwrap_or_default();
        if record.used_at.is_some() || !constant_time_eq(current.as_bytes(), token_hash.as_bytes())
        {
            self.revoke_session(&session.id, "refresh_reuse").await?;
            return Err(OAuthError::INVALID_GRANT);
        }
        self.hook(HookPoint::BeforeRotation).await;
        let refresh = self.secret("dima_rt_")?;
        let next_hash = sha256_base64url(&refresh);
        self.store_refresh(&next_hash, session.id, session.expires_at.0)
            .await?;
        let now = self.now();
        let idle = (now + REFRESH_IDLE_MS).min(session.expires_at.0);
        let filter = doc! {
            "_id": session.id, "revoked_at": Bson::Null, "current_refresh_hash": &token_hash,
            "idle_expires_at": { "$gt": date(now) }, "expires_at": { "$gt": date(now) },
        };
        let update = doc! { "$set": {
            "current_refresh_hash": &next_hash, "last_used_at": date(now), "idle_expires_at": date(idle),
        } };
        let prepared = oauth_sessions::INFO
            .prepare_find_one_and_update(
                &filter,
                update,
                UpdateOptions::default(),
                Returned::After,
                &mut WriteContext::new(now),
            )
            .map_err(unavailable)?;
        let mut writes = self.deps.mongo.writes(oauth_sessions::COLLECTION);
        let rotated = self.bounded(writes.find_one_and_update(&prepared)).await?;
        let Some(rotated) = rotated else {
            self.revoke_session(&session.id, "refresh_reuse").await?;
            return Err(OAuthError::INVALID_GRANT);
        };
        let issued = async {
            let rotated: OAuthSession =
                dima_model::decode_document(&rotated).map_err(unavailable)?;
            let used = oauth_refresh_tokens::INFO
                .prepare_update(
                    &doc! { "_id": record.id },
                    doc! { "$set": { "used_at": date(now) } },
                    UpdateOptions::default(),
                    &mut WriteContext::new(now),
                )
                .map_err(unavailable)?;
            let mut writes = self.deps.mongo.writes(oauth_refresh_tokens::COLLECTION);
            self.bounded(writes.update_one(&used)).await?;
            self.token_response(
                &AccessIdentity {
                    session_id: rotated.id.to_hex(),
                    user_id: rotated.user_id.to_hex(),
                    client_id: rotated.client_id.clone(),
                    channel_id: rotated.channel_id.clone(),
                    scopes: rotated.scopes.clone(),
                },
                refresh,
                rotated.idle_expires_at.0,
                rotated.expires_at.0,
            )
            .await
        }
        .await;
        if issued.is_err() {
            let _ = self.revoke_session(&session.id, "rotation_failed").await;
        }
        issued
    }

    /// `authenticateAccess`: the identity behind an access token, checked against its session.
    pub async fn authenticate_access(
        &self,
        token: Option<&str>,
    ) -> Result<AccessIdentity, OAuthError> {
        let Some(token) = token.filter(|t| prefixed_secret(t, "dima_at_")) else {
            return Err(OAuthError::INVALID_TOKEN);
        };
        let Some(bytes) = self.cache_get(&access_key(token)).await? else {
            return Err(OAuthError::INVALID_TOKEN);
        };
        let identity: AccessIdentity = serde_json::from_slice(&bytes).map_err(unavailable)?;
        let session_id = ObjectId::parse_str(&identity.session_id).map_err(unavailable)?;
        let session = self.active_session(&session_id).await?;
        if identity.user_id != session.user_id.to_hex()
            || identity.client_id != session.client_id
            || identity.channel_id != session.channel_id
            || identity.scopes.iter().any(|s| !session.scopes.contains(s))
        {
            return Err(OAuthError::INVALID_TOKEN);
        }
        Ok(identity)
    }

    /// `revokeSession`: marks an unrevoked session revoked with `reason`.
    pub async fn revoke_session(&self, id: &ObjectId, reason: &str) -> Result<(), OAuthError> {
        let now = self.now();
        let prepared = oauth_sessions::INFO
            .prepare_update(
                &doc! { "_id": id, "revoked_at": Bson::Null },
                doc! { "$set": { "revoked_at": date(now), "revoke_reason": reason } },
                UpdateOptions::default(),
                &mut WriteContext::new(now),
            )
            .map_err(unavailable)?;
        let mut writes = self.deps.mongo.writes(oauth_sessions::COLLECTION);
        self.bounded(writes.update_one(&prepared)).await.map(|_| ())
    }

    /// `revokeToken` (RFC 7009): a refresh or access token of this client ends its session; an
    /// unknown token is a success that reveals nothing.
    pub async fn revoke_token(&self, input: &Input) -> Result<(), OAuthError> {
        let client = self.get_client(input.get("client_id")).await?;
        let Some(token) = text(input, "token").filter(|t| dima_text::utf16_len(t) <= 100) else {
            return Err(OAuthError::INVALID_REQUEST);
        };
        if prefixed_secret(token, "dima_rt_") {
            let record: Option<OAuthRefreshToken> = self
                .find_decoded(
                    oauth_refresh_tokens::COLLECTION,
                    doc! { "token_hash": sha256_base64url(token) },
                )
                .await?;
            if let Some(record) = record {
                let session = self
                    .find_one(
                        oauth_sessions::COLLECTION,
                        doc! { "_id": record.session_id, "client_id": &client.client_id },
                        Some(doc! { "_id": 1 }),
                    )
                    .await?;
                if session.is_some() {
                    self.revoke_session(&record.session_id, "user_revoked")
                        .await?;
                }
            }
        } else if prefixed_secret(token, "dima_at_") {
            let key = access_key(token);
            if let Some(bytes) = self.cache_get(&key).await? {
                let identity: AccessIdentity =
                    serde_json::from_slice(&bytes).map_err(unavailable)?;
                if identity.client_id == client.client_id {
                    let id = ObjectId::parse_str(&identity.session_id).map_err(unavailable)?;
                    self.revoke_session(&id, "user_revoked").await?;
                    self.bounded(self.deps.cache.del(&[&key])).await?;
                }
            }
        }
        Ok(())
    }

    /// `revokeUserOAuth` (account deletion): revokes, then deletes, every grant, session and
    /// refresh token of the user. A user id that is not an ObjectId does nothing.
    pub async fn revoke_user_oauth(&self, user_id: &str) -> Result<(), OAuthError> {
        let Ok(user_id) = ObjectId::parse_str(user_id) else {
            return Ok(());
        };
        let now = self.now();
        let filter = doc! { "user_id": user_id };
        let grants = oauth_grants::INFO
            .prepare_update(
                &filter,
                doc! { "$set": { "revoked_at": date(now) } },
                UpdateOptions::default(),
                &mut WriteContext::new(now),
            )
            .map_err(unavailable)?;
        let mut writes = self.deps.mongo.writes(oauth_grants::COLLECTION);
        self.bounded(writes.update_many(&grants)).await?;
        let sessions = oauth_sessions::INFO
            .prepare_update(
                &filter,
                doc! { "$set": { "revoked_at": date(now), "revoke_reason": "account_deleted" } },
                UpdateOptions::default(),
                &mut WriteContext::new(now),
            )
            .map_err(unavailable)?;
        let mut writes = self.deps.mongo.writes(oauth_sessions::COLLECTION);
        self.bounded(writes.update_many(&sessions)).await?;
        let ids: Vec<Document> = self
            .bounded(async {
                self.deps
                    .mongo
                    .documents(oauth_sessions::COLLECTION)
                    .find(filter.clone())
                    .projection(doc! { "_id": 1 })
                    .await?
                    .try_collect::<Vec<Document>>()
                    .await
            })
            .await?;
        let ids: Vec<Bson> = ids.iter().filter_map(|d| d.get("_id").cloned()).collect();
        let mongo = &self.deps.mongo;
        self.bounded(
            mongo
                .documents(oauth_refresh_tokens::COLLECTION)
                .delete_many(doc! { "session_id": { "$in": ids } })
                .into_future(),
        )
        .await?;
        self.bounded(
            mongo
                .documents(oauth_sessions::COLLECTION)
                .delete_many(filter.clone())
                .into_future(),
        )
        .await?;
        self.bounded(
            mongo
                .documents(oauth_grants::COLLECTION)
                .delete_many(filter)
                .into_future(),
        )
        .await?;
        Ok(())
    }

    // ------------------------------------------------------------------------ browser proof

    /// `browserUser`: a fresh Twitch proof (never the validation cache) for the approval and the
    /// connection-management routes. `Authorization: Bearer <10..512 base64url characters>`
    /// that is not a Dima token, which Twitch confirms belongs to this application and has not
    /// expired, and whose account has a site user. Twitch unreachable or answering something
    /// that is not JSON: 503, as in the reference.
    pub async fn browser_user(
        &self,
        authorization: Option<&str>,
    ) -> Result<BrowserUser, OAuthError> {
        let token = authorization
            .and_then(|header| header.strip_prefix("Bearer "))
            .filter(|token| (10..=512).contains(&token.len()) && is_b64url(token));
        let Some(token) = token.filter(|token| !token.starts_with("dima_")) else {
            return Err(OAuthError::LOGIN_REQUIRED);
        };
        let answer = self
            .deps
            .twitch
            .validate(
                &SecretString::new(token.to_owned()),
                Scheme::OAuth,
                self.config.browser_proof_timeout,
            )
            .await
            .map_err(unavailable)?;
        if !answer.ok() {
            return Err(OAuthError::LOGIN_REQUIRED);
        }
        let proof = answer.body.ok_or(OAuthError::UNAVAILABLE)?;
        if proof.is_null() {
            return Err(OAuthError::UNAVAILABLE);
        }
        let client_ok = proof.get("client_id").and_then(Value::as_str)
            == Some(self.config.twitch_client_id.as_str());
        let user_id = proof
            .get("user_id")
            .and_then(Value::as_str)
            .filter(|id| !id.is_empty());
        let expires_ok = proof
            .get("expires_in")
            .filter(|value| truthy(value))
            .and_then(Value::as_f64)
            .is_some_and(|seconds| seconds > 0.0);
        let (true, Some(user_id), true) = (client_ok, user_id, expires_ok) else {
            return Err(OAuthError::LOGIN_REQUIRED);
        };
        let user: Option<User> = self
            .find_decoded(
                users::COLLECTION,
                users::by_account(AccountType::Twitch, user_id),
            )
            .await?;
        let user = user.ok_or(OAuthError::ACCOUNT_REQUIRED)?;
        Ok(BrowserUser {
            user,
            twitch_id: user_id.to_owned(),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn secrets_shape() {
        assert!(valid_secret(&"a".repeat(43)));
        assert!(!valid_secret(&"a".repeat(42)));
        assert!(!valid_secret(&format!("{}=", "a".repeat(42))));
        assert!(prefixed_secret(
            &format!("dima_rt_{}", "_".repeat(43)),
            "dima_rt_"
        ));
        assert!(!prefixed_secret(
            &format!("dima_at_{}", "a".repeat(43)),
            "dima_rt_"
        ));
        assert!(valid_verifier(&"a.b_c~d-".repeat(6)));
        assert!(!valid_verifier(&"a".repeat(42)));
        assert!(!valid_verifier(&"a".repeat(129)));
    }

    #[test]
    fn config_origins() -> Result<(), OAuthConfigError> {
        let config = OAuthConfig::new(Some("http://127.0.0.1:3000/x?y"), Some(""), "client")?;
        assert_eq!(config.issuer(), "http://127.0.0.1:3000");
        assert_eq!(config.website(), "https://domdimabot.com");
        let default = OAuthConfig::new(None, None, "client")?;
        assert_eq!(default.issuer(), "https://api.domdimabot.com");
        assert!(OAuthConfig::new(Some("not a url"), None, "client").is_err());
        assert!(OAuthConfig::new(Some("ftp://host"), None, "client").is_err());
        assert!(OAuthConfig::new(None, None, "").is_err());
        Ok(())
    }

    #[test]
    fn error_answers() {
        let response = OAuthError::INVALID_TOKEN.response();
        let _ = response;
        assert_eq!(OAuthError::SLOW_DOWN.status(), 429);
        assert_eq!(OAuthError::UNAVAILABLE.code(), "temporarily_unavailable");
    }

    #[test]
    fn token_response_hides_tokens() {
        let response = TokenResponse {
            access_token: SecretString::new("dima_at_secret".to_owned()),
            refresh_token: SecretString::new("dima_rt_secret".to_owned()),
            scope: "profile:read".to_owned(),
            session_id: "s".to_owned(),
            refresh_expires_in: 1,
        };
        assert!(!format!("{response:?}").contains("secret"));
        assert_eq!(response.body()["token_type"], "Bearer");
    }
}
