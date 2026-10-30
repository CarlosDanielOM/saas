//! Working native port of `dimabot/src/middleware/auth.middleware.ts`.
//!
//! [`auth_middleware`] is an Axum middleware that authenticates an opaque
//! Twitch access token exactly like the TypeScript front door:
//!
//! 1. read the `Authorization` header (any header-name case) and strip only an
//!    exact `Bearer ` prefix;
//! 2. accept a Redis hash at `token:<token>` with a truthy `id` as a cache hit
//!    and skip all Twitch calls;
//! 3. otherwise validate the token at the configured validate URL, then load the
//!    first user from the configured users URL with the current `CLIENT_ID`;
//! 4. cache the identity with `HSET` + `EXPIRE 14000` (errors logged, never
//!    fatal), bind the trace channel to the route `channelID` or the user id,
//!    touch `twitch:<id>:last_app_activity_touch` (warm keys skip MongoDB,
//!    cold keys update `users.accounts` and then set `1` + `EXPIRE 86400`), and
//!    attach the identity to request extensions before the protected handler
//!    runs once.
//!
//! The service holds concrete clients only: a pooled [`reqwest::Client`], a
//! Redis [`ConnectionManager`] (cheaply cloned per operation), and the native
//! MongoDB `users` [`Collection`]. Construction performs no I/O beyond the
//! caller-provided handles; [`AuthService::from_runtime`] is the explicit
//! convenience constructor that uses the existing native connection helpers,
//! and [`AuthService::production_logger`] builds the shared native logger with
//! the existing console and Redis cache sinks.
//!
//! Deliberate boundaries: a JavaScript `Error.stack` string has no native
//! equivalent and is not part of the log payload; a validation or user response
//! that does not match the declared JSON shape is rejected as a failed upstream
//! call instead of being used with absent fields; an unset `CLIENT_ID` omits the
//! `Client-Id` header instead of sending the string `"undefined"`.

#[path = "types.rs"]
pub mod types;

use axum::{
    Json, Router,
    extract::{FromRequestParts, RawPathParams, Request, State},
    http::{
        Extensions, HeaderMap, StatusCode, header::AUTHORIZATION, request::Parts as RequestParts,
    },
    middleware::{self, Next},
    response::{IntoResponse, Response},
};
use futures_util::FutureExt;
use mongodb::{
    Collection,
    bson::{DateTime, Document, doc},
};
use redis::{AsyncCommands, aio::ConnectionManager};
use serde_json::{Value, json};
use std::{
    any::Any, collections::HashMap, env, future::Future, panic::AssertUnwindSafe, sync::Arc,
    time::Duration,
};
pub use types::{
    AuthRequest, AuthenticatedUser, CachedTokenData, ERROR_TYPE_INTERNAL_ERROR,
    ERROR_TYPE_INVALID_TOKEN, ERROR_TYPE_NO_TOKEN, ERROR_TYPE_USER_FETCH_FAILED, ErrorResponse,
    TwitchTokenValidation, TwitchUser, TwitchUsersResponse,
};

/// Redis key prefix for cached identities (`token:<token>`).
pub const CACHE_KEY_PREFIX: &str = "token:";
/// Cache lifetime in seconds (`14000` in the source helper).
pub const CACHE_TTL_SECONDS: i64 = 14_000;
/// Production token validation endpoint.
pub const DEFAULT_TWITCH_VALIDATE_URL: &str = "https://id.twitch.tv/oauth2/validate";
/// Production Helix users endpoint.
pub const DEFAULT_TWITCH_USERS_URL: &str = "https://api.twitch.tv/helix/users";
/// Activity-touch throttle lifetime in seconds (`60 * 60 * 24`).
pub const ACTIVITY_TOUCH_TTL_SECONDS: i64 = 86_400;
/// Suffix used to throttle application-activity touches per Twitch user.
pub const ACTIVITY_TOUCH_KEY_SUFFIX: &str = ":last_app_activity_touch";
/// Route parameter preferred over the identity for the trace channel.
pub const ROUTE_CHANNEL_PARAM: &str = "channelID";

/// `token:<token>`, byte-for-byte with the source cache helper.
pub fn token_cache_key(token: &str) -> String {
    format!("{CACHE_KEY_PREFIX}{token}")
}

/// `twitch:<twitchUserId>:last_app_activity_touch`.
pub fn activity_touch_key(twitch_user_id: &str) -> String {
    format!("twitch:{twitch_user_id}{ACTIVITY_TOUCH_KEY_SUFFIX}")
}

/// Endpoints and optional client-id override for [`AuthService`].
///
/// Both URLs are full absolute `http`/`https` URLs; tests point them at a
/// loopback provider and production keeps the public Twitch defaults. When
/// `client_id` is absent the service reads `CLIENT_ID` from the environment on
/// every user lookup, matching the source's per-call `process.env.CLIENT_ID`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AuthConfig {
    validate_url: String,
    users_url: String,
    client_id: Option<String>,
}

impl Default for AuthConfig {
    fn default() -> Self {
        Self {
            validate_url: DEFAULT_TWITCH_VALIDATE_URL.into(),
            users_url: DEFAULT_TWITCH_USERS_URL.into(),
            client_id: None,
        }
    }
}

impl AuthConfig {
    /// Production URLs with `CLIENT_ID` resolved per request.
    pub fn production() -> Self {
        Self::default()
    }

    /// Explicit endpoints, for example a loopback test provider.
    pub fn new(validate_url: impl Into<String>, users_url: impl Into<String>) -> Self {
        Self {
            validate_url: validate_url.into(),
            users_url: users_url.into(),
            client_id: None,
        }
    }

    /// Uses a fixed client id instead of the per-request environment lookup.
    pub fn with_client_id(mut self, client_id: impl Into<String>) -> Self {
        self.client_id = Some(client_id.into());
        self
    }

    pub fn validate_url(&self) -> &str {
        &self.validate_url
    }

    pub fn users_url(&self) -> &str {
        &self.users_url
    }

    pub fn client_id_override(&self) -> Option<&str> {
        self.client_id.as_deref()
    }

    fn client_id(&self) -> Option<String> {
        self.client_id
            .clone()
            .or_else(|| env::var("CLIENT_ID").ok())
    }

    fn validate(&self) -> Result<(), AuthConfigError> {
        absolute_url(&self.validate_url, "validate URL")?;
        absolute_url(&self.users_url, "users URL")
    }
}

fn absolute_url(value: &str, label: &'static str) -> Result<(), AuthConfigError> {
    let parsed = reqwest::Url::parse(value).map_err(|_| AuthConfigError {
        message: match label {
            "users URL" => "users URL must be an absolute http(s) URL",
            _ => "validate URL must be an absolute http(s) URL",
        },
    })?;
    if !matches!(parsed.scheme(), "http" | "https") || parsed.host().is_none() {
        return Err(AuthConfigError {
            message: match label {
                "users URL" => "users URL must be an absolute http(s) URL",
                _ => "validate URL must be an absolute http(s) URL",
            },
        });
    }
    Ok(())
}

/// Invalid [`AuthConfig`] values. Messages never include the raw input.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct AuthConfigError {
    message: &'static str,
}

impl AuthConfigError {
    pub fn message(&self) -> &'static str {
        self.message
    }
}

impl std::fmt::Display for AuthConfigError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(self.message)
    }
}

impl std::error::Error for AuthConfigError {}

/// Explicit-constructor failures for the native runtime connection helpers.
#[derive(Debug)]
pub enum AuthInitError {
    Mongo(mongodb::error::Error),
    Redis(redis::RedisError),
    MissingDatabase,
    Config(AuthConfigError),
}

impl std::fmt::Display for AuthInitError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Mongo(error) => write!(formatter, "{error}"),
            Self::Redis(error) => write!(formatter, "{error}"),
            Self::MissingDatabase => {
                formatter.write_str("MONGO_URI must select a database for the users collection")
            }
            Self::Config(error) => error.fmt(formatter),
        }
    }
}

impl std::error::Error for AuthInitError {}

impl From<AuthConfigError> for AuthInitError {
    fn from(error: AuthConfigError) -> Self {
        Self::Config(error)
    }
}

struct Inner {
    config: AuthConfig,
    http: reqwest::Client,
    redis: ConnectionManager,
    users: Collection<Document>,
    logger: Option<crate::utils::logger::Logger>,
}

/// Reusable authentication service for the API front door.
///
/// Cloning is cheap and clones share the HTTP pool, the multiplexed Redis
/// connection and the MongoDB collection handle.
#[derive(Clone)]
pub struct AuthService {
    inner: Arc<Inner>,
}

impl AuthService {
    /// Builds the service from already-created concrete handles.
    ///
    /// No connection, environment read (besides the allowed per-request
    /// `CLIENT_ID` lookup) or index creation happens here.
    pub fn new(
        config: AuthConfig,
        http: reqwest::Client,
        redis: ConnectionManager,
        users: Collection<Document>,
        logger: Option<crate::utils::logger::Logger>,
    ) -> Result<Self, AuthConfigError> {
        config.validate()?;
        Ok(Self {
            inner: Arc::new(Inner {
                config,
                http,
                redis,
                users,
                logger,
            }),
        })
    }

    /// Connects with the existing native MongoDB/Redis helpers and uses the
    /// `MONGO_URI` database for the native `users` collection.
    pub async fn from_runtime(
        config: AuthConfig,
        logger: Option<crate::utils::logger::Logger>,
    ) -> Result<Self, AuthInitError> {
        let database = {
            let client = crate::utils::mongo::get_mongo_client()
                .await
                .map_err(AuthInitError::Mongo)?;
            client
                .default_database()
                .ok_or(AuthInitError::MissingDatabase)?
        };
        let redis = crate::utils::redis::get_redis_client()
            .await
            .map_err(AuthInitError::Redis)?;
        let users = crate::schemas::users::schema().native_collection(&database);
        Self::new(config, reqwest::Client::new(), redis, users, logger)
            .map_err(AuthInitError::Config)
    }

    /// Builds the shared native logger with the concrete console and Redis cache
    /// sinks. A caller may instead pass any explicitly constructed logger.
    pub fn production_logger(
        redis: ConnectionManager,
    ) -> Result<crate::utils::logger::Logger, crate::utils::logger::ConfigError> {
        use crate::utils::logger::{
            Logger, LoggerConfig, SinkHandles, StdConsole, SystemClock, UuidSource,
        };
        let cache =
            crate::utils::logger::redis::RedisCacheSink::new(redis, Duration::from_secs(2))?;
        Logger::new(
            LoggerConfig::default(),
            SinkHandles {
                cache: Some(Arc::new(cache)),
                console: Some(Arc::new(StdConsole)),
                ..Default::default()
            },
            Arc::new(SystemClock),
            Arc::new(UuidSource),
        )
    }

    /// Applies authentication to every route in `router`, including route
    /// parameters such as `{channelID}` matched before the middleware runs.
    pub fn protect<S>(&self, router: Router<S>) -> Router<S>
    where
        S: Clone + Send + Sync + 'static,
    {
        router.layer(middleware::from_fn_with_state(
            self.clone(),
            auth_middleware,
        ))
    }

    pub fn config(&self) -> &AuthConfig {
        &self.inner.config
    }

    pub fn logger(&self) -> Option<&crate::utils::logger::Logger> {
        self.inner.logger.as_ref()
    }

    pub fn users_collection(&self) -> &Collection<Document> {
        &self.inner.users
    }

    pub fn redis_connection(&self) -> &ConnectionManager {
        &self.inner.redis
    }

    async fn log_failure(&self, payload: Value) {
        let Some(logger) = self.inner.logger.as_ref() else {
            return;
        };
        let _ = logger
            .log(
                crate::utils::logger::Level::Error,
                payload,
                crate::utils::logger::LogOptions {
                    destination: crate::utils::logger::Destination::Both,
                    ..Default::default()
                },
            )
            .await;
    }

    /// Reads `token:<token>`; a hash without a non-empty `id` is a miss.
    /// Redis failures are logged and treated as a miss, exactly as the source
    /// helper returns `null` after catching.
    async fn cached_user(&self, token: &str) -> Option<AuthenticatedUser> {
        let key = token_cache_key(token);
        let mut connection = self.inner.redis.clone();
        let data: Result<HashMap<String, String>, redis::RedisError> =
            connection.hgetall(&key).await;
        match data {
            Ok(data) => data
                .get("id")
                .filter(|id| !id.is_empty())
                .map(|id| AuthenticatedUser {
                    id: id.clone(),
                    login: data.get("login").cloned().unwrap_or_default(),
                    display_name: data.get("display_name").cloned().unwrap_or_default(),
                    profile_image_url: data.get("profile_image_url").cloned(),
                }),
            Err(error) => {
                self.log_failure(json!({
                    "function": "getCachedToken",
                    "error": error.to_string(),
                }))
                .await;
                None
            }
        }
    }

    /// Validates the token; `401` and transport/JSON failures are reported with
    /// the source's exact messages.
    async fn validate_token(&self, token: &str) -> Result<TwitchTokenValidation, &'static str> {
        let response = self
            .inner
            .http
            .get(self.inner.config.validate_url())
            .header(AUTHORIZATION, format!("Bearer {token}"))
            .send()
            .await;
        let response = match response {
            Ok(response) => response,
            Err(error) => {
                self.log_failure(json!({
                    "function": "validateTwitchToken",
                    "error": error.to_string(),
                }))
                .await;
                return Err("Failed to validate token");
            }
        };
        if response.status() == StatusCode::UNAUTHORIZED {
            return Err("Invalid token");
        }
        match response.json::<TwitchTokenValidation>().await {
            Ok(validation) => Ok(validation),
            Err(error) => {
                self.log_failure(json!({
                    "function": "validateTwitchToken",
                    "error": error.to_string(),
                }))
                .await;
                Err("Failed to validate token")
            }
        }
    }

    /// Loads the first Helix user for the token.
    async fn user_from_token(&self, token: &str) -> Result<AuthenticatedUser, &'static str> {
        let mut request = self
            .inner
            .http
            .get(self.inner.config.users_url())
            .header(AUTHORIZATION, format!("Bearer {token}"));
        if let Some(client_id) = self.inner.config.client_id() {
            request = request.header("Client-Id", client_id);
        }
        let response = match request.send().await {
            Ok(response) => response,
            Err(error) => {
                self.log_failure(json!({
                    "function": "getUserFromToken",
                    "error": error.to_string(),
                }))
                .await;
                return Err("Failed to fetch user data");
            }
        };
        if !response.status().is_success() {
            return Err("Invalid token or user not found");
        }
        let data = match response.json::<TwitchUsersResponse>().await {
            Ok(data) => data,
            Err(error) => {
                self.log_failure(json!({
                    "function": "getUserFromToken",
                    "error": error.to_string(),
                }))
                .await;
                return Err("Failed to fetch user data");
            }
        };
        match data.data.into_iter().next() {
            Some(user) => Ok(AuthenticatedUser {
                id: user.id,
                login: user.login,
                display_name: user.display_name,
                profile_image_url: Some(user.profile_image_url),
            }),
            None => Err("User not found"),
        }
    }

    /// Writes the flat identity hash and its TTL as two separate commands.
    /// Any failure is logged and leaves the already-authenticated request valid.
    async fn cache_token(&self, token: &str, user: &AuthenticatedUser) {
        let key = token_cache_key(token);
        let mut connection = self.inner.redis.clone();
        let profile = user.profile_image_url.as_deref().unwrap_or("");
        let result: Result<(), redis::RedisError> = async {
            // ioredis `hSet(key, object)` sends a single multi-field HSET.
            let _: i64 = redis::cmd("HSET")
                .arg(&key)
                .arg("id")
                .arg(&user.id)
                .arg("login")
                .arg(&user.login)
                .arg("display_name")
                .arg(&user.display_name)
                .arg("profile_image_url")
                .arg(profile)
                .query_async(&mut connection)
                .await?;
            let _: bool = connection.expire(&key, CACHE_TTL_SECONDS).await?;
            Ok(())
        }
        .await;
        if let Err(error) = result {
            self.log_failure(json!({
                "function": "cacheToken",
                "error": error.to_string(),
            }))
            .await;
        }
    }

    /// Throttles the `users.last_app_activity_at` refresh per Twitch user.
    /// Warm keys return before MongoDB; failures are logged and never block the
    /// authenticated request.
    async fn touch_last_app_activity(&self, twitch_user_id: &str) {
        if twitch_user_id.is_empty() {
            return;
        }
        let key = activity_touch_key(twitch_user_id);
        let mut connection = self.inner.redis.clone();
        let result: Result<(), ActivityError> = async {
            let warm: bool = connection.exists(&key).await?;
            if warm {
                return Ok(());
            }
            let now = DateTime::now();
            // The users schema declares `timestamps: { created_at, updated_at }`,
            // so Mongoose also stamps the update path; preserve that on updates
            // while keeping the source's `$set.last_app_activity_at`.
            self.inner
                .users
                .update_one(
                    doc! {"accounts.id": twitch_user_id, "accounts.type": "twitch"},
                    doc! {
                        "$set": {"last_app_activity_at": now, "updated_at": now},
                        "$setOnInsert": {"created_at": now},
                    },
                )
                .await
                .map_err(ActivityError::Mongo)?;
            // Whether or not a user document matched, the throttle is set.
            let _: () = connection.set(&key, "1").await?;
            let _: bool = connection.expire(&key, ACTIVITY_TOUCH_TTL_SECONDS).await?;
            Ok(())
        }
        .await;
        if let Err(error) = result {
            self.log_failure(json!({
                "function": "touchLastAppActivity",
                "twitchUserId": twitch_user_id,
                "error": error.to_string(),
            }))
            .await;
        }
    }

    /// Cache-first authentication. Every expected failure is already converted
    /// into a JSON response; only the panic boundary can produce a 500.
    // The error is the HTTP rejection itself (a normal control-flow value).
    #[allow(clippy::result_large_err)]
    async fn authenticate(&self, token: String) -> Result<AuthenticatedUser, Response> {
        if let Some(user) = self.cached_user(&token).await {
            return Ok(user);
        }
        self.validate_token(&token)
            .await
            .map_err(|message| reject(ErrorResponse::invalid_token(message)))?;
        let user = self
            .user_from_token(&token)
            .await
            .map_err(|message| reject(ErrorResponse::user_fetch_failed(message)))?;
        self.cache_token(&token, &user).await;
        Ok(user)
    }
}

enum ActivityError {
    Redis(redis::RedisError),
    Mongo(mongodb::error::Error),
}

impl From<redis::RedisError> for ActivityError {
    fn from(error: redis::RedisError) -> Self {
        Self::Redis(error)
    }
}

impl std::fmt::Display for ActivityError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Redis(error) => error.fmt(formatter),
            Self::Mongo(error) => error.fmt(formatter),
        }
    }
}

fn reject(body: ErrorResponse) -> Response {
    (StatusCode::UNAUTHORIZED, Json(body)).into_response()
}

fn internal_error() -> Response {
    (
        StatusCode::INTERNAL_SERVER_ERROR,
        Json(ErrorResponse::internal_error()),
    )
        .into_response()
}

fn panic_message(payload: Box<dyn Any + Send>) -> String {
    if let Some(message) = payload.downcast_ref::<&str>() {
        return (*message).to_owned();
    }
    if let Some(message) = payload.downcast_ref::<String>() {
        return message.clone();
    }
    "internal error".into()
}

/// Runs the authentication future and converts an unexpected panic into the
/// source's outer `500 internal_error` response instead of aborting the
/// connection.
#[allow(clippy::result_large_err)]
async fn guard<F>(service: &AuthService, future: F) -> Result<AuthenticatedUser, Response>
where
    F: Future<Output = Result<AuthenticatedUser, Response>>,
{
    match AssertUnwindSafe(future).catch_unwind().await {
        Ok(result) => result,
        Err(payload) => {
            let message = panic_message(payload);
            service
                .log_failure(json!({
                    "function": "authMiddleware",
                    "error": message,
                }))
                .await;
            Err(internal_error())
        }
    }
}

/// Extracts the accepted token from the `Authorization` header.
///
/// Header names are case-insensitive at the HTTP layer, replacing the source's
/// `authorization`/`Authorization` fallback. Only the exact, case-sensitive
/// `Bearer ` prefix is stripped; any other value is used verbatim as the token.
/// An absent header or an empty token yields the exact `401 no_token` body.
pub fn extract_bearer_token(headers: &HeaderMap) -> Result<String, ErrorResponse> {
    let header = headers
        .get(AUTHORIZATION)
        .and_then(|value| value.to_str().ok());
    let Some(header) = header else {
        return Err(ErrorResponse::no_token());
    };
    let token = header.strip_prefix("Bearer ").unwrap_or(header);
    if token.is_empty() {
        return Err(ErrorResponse::no_token());
    }
    Ok(token.to_owned())
}

/// Native equivalent of `req.params.channelID` for the matched route.
async fn route_channel_id(parts: &mut RequestParts) -> Option<String> {
    let params = RawPathParams::from_request_parts(parts, &()).await.ok()?;
    params
        .iter()
        .find(|(key, _)| *key == ROUTE_CHANNEL_PARAM)
        .map(|(_, value)| value.to_owned())
}

fn bind_trace_channel(channel: &str) {
    if channel.is_empty() {
        return;
    }
    // No active telemetry context makes this a no-op, matching `bindChannel`.
    crate::utils::observability::bind_channel(channel);
}

/// Axum middleware for the API front door.
///
/// State is an [`AuthService`]; mount it with [`AuthService::protect`] or
/// `axum::middleware::from_fn_with_state(service, auth_middleware)`. Successful
/// requests carry [`AuthenticatedUser`] (and the [`AuthRequest`] view) in their
/// extensions and reach the handler exactly once.
pub async fn auth_middleware(
    State(service): State<AuthService>,
    request: Request,
    next: Next,
) -> Response {
    let token = match extract_bearer_token(request.headers()) {
        Ok(token) => token,
        Err(body) => return reject(body),
    };
    let outcome = guard(&service, service.authenticate(token)).await;
    match outcome {
        Ok(user) => {
            let (mut parts, body) = request.into_parts();
            let channel = route_channel_id(&mut parts)
                .await
                .filter(|value| !value.is_empty())
                .unwrap_or_else(|| user.id.clone());
            AuthRequest::from(user.clone()).insert(&mut parts.extensions);
            bind_trace_channel(&channel);
            // The source touches activity after binding the trace channel and
            // before `next()`; failures are logged and never block the request.
            service.touch_last_app_activity(&user.id).await;
            next.run(Request::from_parts(parts, body)).await
        }
        Err(response) => response,
    }
}

/// Reads the authenticated identity from request extensions.
///
/// Rejects with the same `401 no_token` body when authentication did not run.
impl<S> FromRequestParts<S> for AuthenticatedUser
where
    S: Send + Sync,
{
    type Rejection = Response;

    async fn from_request_parts(
        parts: &mut RequestParts,
        _state: &S,
    ) -> Result<Self, Self::Rejection> {
        parts
            .extensions
            .get::<AuthenticatedUser>()
            .cloned()
            .ok_or_else(|| reject(ErrorResponse::no_token()))
    }
}

/// Convenience for reading the identity inside a protected handler.
pub fn authenticated_user(extensions: &Extensions) -> Option<&AuthenticatedUser> {
    extensions.get::<AuthenticatedUser>()
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::HeaderValue;

    #[test]
    fn cache_and_activity_keys_match_the_source_format() {
        assert_eq!(token_cache_key("abc"), "token:abc");
        assert_eq!(
            activity_touch_key("1234"),
            "twitch:1234:last_app_activity_touch"
        );
        assert_eq!(CACHE_TTL_SECONDS, 14000);
        assert_eq!(ACTIVITY_TOUCH_TTL_SECONDS, 86400);
    }

    #[test]
    fn bearer_prefix_is_exact_and_case_sensitive() {
        let mut headers = HeaderMap::new();
        headers.insert(AUTHORIZATION, HeaderValue::from_static("Bearer tok"));
        assert_eq!(extract_bearer_token(&headers).ok().as_deref(), Some("tok"));

        headers.insert(AUTHORIZATION, HeaderValue::from_static("bearer tok"));
        assert_eq!(
            extract_bearer_token(&headers).ok().as_deref(),
            Some("bearer tok")
        );

        headers.insert(AUTHORIZATION, HeaderValue::from_static("Bearer "));
        let empty = extract_bearer_token(&headers).expect_err("an empty token is rejected");
        assert_eq!(empty.r#type, "no_token");
        assert_eq!(empty.message, "No token provided");

        headers.remove(AUTHORIZATION);
        let missing = extract_bearer_token(&headers).expect_err("a missing header is rejected");
        assert_eq!(missing.r#type, "no_token");

        headers.insert(AUTHORIZATION, HeaderValue::from_static("raw-token"));
        assert_eq!(
            extract_bearer_token(&headers).ok().as_deref(),
            Some("raw-token")
        );
    }

    #[test]
    fn error_bodies_match_the_source_json() {
        let body = serde_json::to_value(ErrorResponse::no_token()).unwrap();
        assert_eq!(
            body,
            json!({"error": true, "message": "No token provided", "status": 401, "type": "no_token"})
        );
        assert_eq!(
            serde_json::to_value(ErrorResponse::invalid_token("Invalid token")).unwrap(),
            json!({"error": true, "message": "Invalid token", "status": 401, "type": "invalid_token"})
        );
        assert_eq!(
            serde_json::to_value(ErrorResponse::user_fetch_failed("User not found")).unwrap(),
            json!({"error": true, "message": "User not found", "status": 401, "type": "user_fetch_failed"})
        );
        assert_eq!(
            serde_json::to_value(ErrorResponse::internal_error()).unwrap(),
            json!({"error": true, "message": "Internal server error", "status": 500, "type": "internal_error"})
        );
    }

    /// The outer 500 branch is a panic boundary: JavaScript can throw from any
    /// helper, while the native helpers return handled values. This exercises
    /// the same conversion [`guard`] applies to an unexpected panic.
    #[tokio::test]
    async fn unexpected_panic_becomes_internal_error() {
        let response = AssertUnwindSafe(async {
            panic!("boom");
            #[allow(unreachable_code)]
            Ok::<AuthenticatedUser, Response>(AuthenticatedUser::default())
        })
        .catch_unwind()
        .await;
        let payload = response.expect_err("panic must be captured");
        assert_eq!(panic_message(payload), "boom");
        let response = internal_error();
        assert_eq!(response.status(), StatusCode::INTERNAL_SERVER_ERROR);
        let bytes = axum::body::to_bytes(response.into_body(), 1024)
            .await
            .unwrap();
        let body: Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(body["type"], "internal_error");
        assert_eq!(body["status"], 500);
    }
}
