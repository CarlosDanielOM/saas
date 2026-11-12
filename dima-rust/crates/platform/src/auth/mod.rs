//! Who a request comes from: `authMiddleware`, `optionalAuthMiddleware` and
//! `workspaceOwnerMiddleware` (`dimabot/src/middleware/`), as guards for `dima-web`.
//!
//! # The guard, step by step (reference: `auth.middleware.ts`)
//!
//! 1. The token is read from **one place only**: the `Authorization` header (Node keeps the first
//!    of duplicate `Authorization` headers; [`dima_web::Req::header`] does the same). A leading
//!    `Bearer ` is removed once; any other value is used as the token as it is (the reference
//!    accepts a bare token). No cookie, no query parameter: the reference reads neither.
//!    Missing, empty or `Bearer` with nothing after it: `401 no_token`.
//! 2. The validation cache ([`cache`]) answers when it holds the token.
//! 3. Otherwise Twitch: `/oauth2/validate` (401 → `invalid_token` "Invalid token"; unreachable,
//!    timed out or not JSON → `invalid_token` "Failed to validate token"; JSON `null`/`false`/`0`
//!    → "Invalid token"; any other status with a JSON body counts as valid and the user lookup
//!    decides), then `/helix/users` with the app's `Client-Id` (not 2xx → `user_fetch_failed`
//!    "Invalid token or user not found"; empty → "User not found"; unreachable or not JSON →
//!    "Failed to fetch user data").
//! 4. The identity is cached, [`AuthenticatedUser`] is attached to the request, the telemetry
//!    channel is bound to the `channelID` path parameter or else the user's id
//!    ([`BoundChannel`]), and `users.last_app_activity_at` is touched at most once a day.
//!
//! Every answer is the reference's, byte for byte: `{"error":true,"message":…,"status":401,
//! "type":…}` (`500 internal_error` is kept for completeness; nothing here can raise it).
//!
//! # Deadlines and failures
//!
//! Every Dragonfly and MongoDB call has [`AuthConfig::store_deadline`], every Twitch call
//! [`AuthConfig::twitch_timeout`] (the reference's `fetch` has none). A cache that cannot be read
//! is a miss (Twitch decides, as in the reference) and the validation is then not cached; a cache
//! or activity write that fails is reported and ignored (as in the reference). Twitch unreachable
//! is a refusal, never access.
//!
//! # The one accepted exception to "fail closed"
//!
//! When `/validate` fails with a status other than 401 (a 5xx, a 429…) and a JSON body, the
//! Helix user lookup decides, and a successful lookup **accepts** the request (as the
//! reference does; such a validation is cached for [`AuthConfig::cache_ttl`], since no
//! `expires_in` is known). This is kept on purpose: Helix accepts a user token only together
//! with the client id it was issued to (this application's `Client-Id` is sent), so a
//! successful lookup is itself a validation of the token for this application, and refusing
//! would sign everyone out during an outage of `/validate` alone. A 401 from `/validate` is
//! never overridden: it is refused before Helix is asked.
//!
//! # Forgetting
//!
//! [`Authenticator::forget`] (sign-out) and [`Authenticator::forget_user`] (account deletion, a
//! ban) end cached validations at once, including one that an authentication already waiting for
//! Twitch would publish afterwards ([`cache`] has the fences). They return the store's failure:
//! a sign-out that could not reach Dragonfly has **not** ended the cached validation, which
//! may still be accepted for up to [`DEFAULT_CACHE_TTL`]. The sign-out route then answers an
//! error (`503`, so the client knows the session may outlive it and can retry; a retry is
//! harmless) instead of a success, and the client discards its token either way. An account
//! deletion or a ban that cannot forget retries or fails the operation, never ignores it.
//!
//! # Intended differences (all invisible to a client that sends a real token)
//!
//! - The cache is keyed by the token's SHA-256, written atomically, and lives at most
//!   [`DEFAULT_CACHE_TTL`] (3600 s instead of 14000 s) and never past the token's own
//!   `expires_in` ([`cache`] has the reasons). Worst-case staleness after a revocation on
//!   Twitch's side (the user disconnects the app, changes password, Twitch bans the account):
//!   one hour, and less when the token expires sooner; [`Authenticator::forget`] ends it at once
//!   for a sign-out, [`Authenticator::forget_user`] for an account deletion or a ban. Roles are
//!   never cached here: every access decision reads MongoDB ([`crate::access`]), so losing a
//!   role takes effect on the next request.
//! - `/validate`'s `expires_in` (the reference ignores it): a negative one is refused as
//!   "Invalid token" without the `/users` call. Zero, absent, `null` or not a number, the
//!   token's life is unknown (Twitch reports its old never-expiring tokens as zero): the request
//!   is accepted (Twitch answered 200) but the validation is not cached, so the next request
//!   asks Twitch again. Twitch documents `expires_in` as part
//!   of every successful validation and says nothing of its absence; not caching is the reading
//!   that can never keep an expired token alive. A positive one bounds the cache lifetime, less
//!   the time the user lookup took, and an entry shorter than [`MIN_CACHE_TTL`] is not written.
//! - A token that is longer than [`MAX_TOKEN_CHARS`] or holds characters no OAuth token has
//!   (outside RFC 6750's `token68` set) is refused as "Invalid token" without asking Twitch, which
//!   would have refused it the same way.
//! - A `/validate` answer of 200 for another application's `client_id` is refused as
//!   "Invalid token or user not found" without the `/users` call: the answer the reference gives
//!   when Helix refuses the foreign token, now checked here instead of trusted to Twitch.
//! - A `/users` answer whose first entry has no string `id` is "Failed to fetch user data"; the
//!   reference attached a user with an undefined id.
//! - `optionalAuthMiddleware` (used by no route) wrote the 401 and still called the handler;
//!   [`optional_user`] never answers: the handler runs with or without a user.

pub mod cache;
pub mod twitch;

use bson::{DateTime, doc};
use dima_core::{Clock, SecretString};
use dima_model::users;
use dima_store::dragonfly::Dragonfly;
use dima_store::mongo::update::UpdateOptions;
use dima_store::mongo::{MongoStore, WriteContext};
use dima_web::{Error as WebError, Flow, Req, Response};
use serde::Serialize;
use serde_json::{Value, json};
use std::fmt;
use std::sync::Arc;
use std::time::Duration;
use twitch::{Scheme, TwitchAnswer, TwitchUserApi};

/// The bot creator's Twitch id (`CREATOR_TWITCH_USER_ID`, and the workspace owner).
pub const CREATOR_TWITCH_USER_ID: &str = "533538623";
/// Reference cache lifetime (`CACHE_TTL`), for the record: 14000 s.
pub const REFERENCE_CACHE_TTL: Duration = Duration::from_secs(14_000);
/// Cache lifetime here: Twitch asks applications to validate user tokens every hour.
pub const DEFAULT_CACHE_TTL: Duration = Duration::from_secs(3_600);
/// `ACTIVITY_TOUCH_TTL`: one day.
pub const ACTIVITY_TOUCH_TTL: Duration = Duration::from_secs(86_400);
/// Default per-call deadline for Twitch (the reference has none; this fires only on a hang).
pub const DEFAULT_TWITCH_TIMEOUT: Duration = Duration::from_secs(10);
/// Default per-command deadline for Dragonfly and MongoDB.
pub const DEFAULT_STORE_DEADLINE: Duration = Duration::from_secs(5);
/// Shortest cache entry written: a token with less life left is validated on every request.
pub const MIN_CACHE_TTL: Duration = Duration::from_secs(5);
/// Longest token sent to Twitch.
pub const MAX_TOKEN_CHARS: usize = 2048;

/// Typed configuration, built by the binary from `CLIENT_ID` at start.
#[derive(Clone, Debug)]
pub struct AuthConfig {
    /// `CLIENT_ID`: the application Twitch tokens must belong to.
    pub client_id: String,
    /// Longest life of a cache entry.
    pub cache_ttl: Duration,
    /// Deadline of each Twitch call.
    pub twitch_timeout: Duration,
    /// Deadline of each store call.
    pub store_deadline: Duration,
    /// How long the once-a-day activity touch is skipped.
    pub activity_touch_ttl: Duration,
}

/// The configuration cannot be used.
#[derive(Clone, Debug, PartialEq, Eq, thiserror::Error)]
pub enum AuthConfigError {
    /// `CLIENT_ID` is empty.
    #[error("CLIENT_ID must be set")]
    MissingClientId,
    /// A lifetime or deadline is zero.
    #[error("{0} must be greater than zero")]
    Zero(&'static str),
}

impl AuthConfig {
    /// The defaults for `client_id`.
    pub fn new(client_id: impl Into<String>) -> Result<Self, AuthConfigError> {
        Self {
            client_id: client_id.into(),
            cache_ttl: DEFAULT_CACHE_TTL,
            twitch_timeout: DEFAULT_TWITCH_TIMEOUT,
            store_deadline: DEFAULT_STORE_DEADLINE,
            activity_touch_ttl: ACTIVITY_TOUCH_TTL,
        }
        .validated()
    }

    /// The longest an authentication may take between its cache lookup and its publication:
    /// the lookup, the two Twitch calls and the publication under their deadlines, plus 5 s.
    /// A publication later than that is refused ([`cache`]).
    pub fn publish_window(&self) -> Duration {
        self.store_deadline
            .saturating_mul(2)
            .saturating_add(self.twitch_timeout.saturating_mul(2))
            .saturating_add(Duration::from_secs(5))
    }

    /// Lifetime of a token's fence: twice the window, plus the clock allowance.
    pub fn token_fence_ttl(&self) -> Duration {
        self.publish_window()
            .saturating_mul(2)
            .saturating_add(cache::CLOCK_ALLOWANCE)
    }

    /// Lifetime of a user's fence: it must outlive every entry it covers.
    pub fn user_fence_ttl(&self) -> Duration {
        self.cache_ttl.saturating_add(self.token_fence_ttl())
    }

    /// Checks a configuration built by hand.
    pub fn validated(self) -> Result<Self, AuthConfigError> {
        if self.client_id.is_empty() || self.client_id == "undefined" {
            return Err(AuthConfigError::MissingClientId);
        }
        for (name, value) in [
            ("cache_ttl", self.cache_ttl),
            ("twitch_timeout", self.twitch_timeout),
            ("store_deadline", self.store_deadline),
            ("activity_touch_ttl", self.activity_touch_ttl),
        ] {
            if value.is_zero() {
                return Err(AuthConfigError::Zero(name));
            }
        }
        Ok(self)
    }
}

/// `req.user`: the Twitch identity the token was proven to belong to.
///
/// Only the guards make one (the fields are private and it cannot be decoded); a test in
/// another crate uses `for_tests` (feature `test-util`, enabled from `[dev-dependencies]` only).
///
/// ```compile_fail,E0451
/// let user = dima_platform::auth::AuthenticatedUser {
///     id: "1".into(),
///     login: "a".into(),
///     display_name: "A".into(),
///     profile_image_url: None,
/// };
/// ```
///
/// ```compile_fail,E0277
/// let user: Result<dima_platform::auth::AuthenticatedUser, _> = serde_json::from_str("{}");
/// ```
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct AuthenticatedUser {
    id: String,
    login: String,
    display_name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    profile_image_url: Option<String>,
}

impl AuthenticatedUser {
    pub(crate) fn new(
        id: String,
        login: String,
        display_name: String,
        profile_image_url: Option<String>,
    ) -> Self {
        Self {
            id,
            login,
            display_name,
            profile_image_url,
        }
    }

    /// An identity for tests in other crates (feature `test-util`).
    #[cfg(feature = "test-util")]
    pub fn for_tests(
        id: impl Into<String>,
        login: impl Into<String>,
        display_name: impl Into<String>,
        profile_image_url: Option<String>,
    ) -> Self {
        Self::new(
            id.into(),
            login.into(),
            display_name.into(),
            profile_image_url,
        )
    }

    /// Twitch user id.
    pub fn id(&self) -> &str {
        &self.id
    }

    /// Twitch login.
    pub fn login(&self) -> &str {
        &self.login
    }

    /// Twitch display name.
    pub fn display_name(&self) -> &str {
        &self.display_name
    }

    /// Profile image (`""` when read from the cache and Twitch had none).
    pub fn profile_image_url(&self) -> Option<&str> {
        self.profile_image_url.as_deref()
    }

    /// The user [`require_user`] attached. A handler mounted without the guard gets a 500 (the
    /// default error page), never an anonymous pass.
    pub fn of<S>(req: &Req<S>) -> Result<&AuthenticatedUser, WebError> {
        req.extensions()
            .get::<AuthenticatedUser>()
            .ok_or_else(|| WebError::new(500, "authentication guard missing"))
    }

    /// The user [`optional_user`] or [`require_user`] attached, if any.
    pub fn maybe<S>(req: &Req<S>) -> Option<&AuthenticatedUser> {
        req.extensions().get::<AuthenticatedUser>()
    }
}

/// The telemetry channel the guard bound (`bindChannel(req.params.channelID || user.id)`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct BoundChannel(pub String);

/// Why `validateTwitchToken` refused.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum InvalidReason {
    /// "Invalid token".
    Refused,
    /// "Failed to validate token".
    Unreachable,
}

/// Why `getUserFromToken` refused.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum UserFetchReason {
    /// "Invalid token or user not found".
    Refused,
    /// "User not found".
    NotFound,
    /// "Failed to fetch user data".
    Unreachable,
}

/// The guard's refusal, with the reference's answer.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AuthFailure {
    /// `401 no_token`.
    NoToken,
    /// `401 invalid_token`.
    InvalidToken(InvalidReason),
    /// `401 user_fetch_failed`.
    UserFetch(UserFetchReason),
    /// `500 internal_error`.
    Internal,
}

impl AuthFailure {
    /// The HTTP status (and body `status`).
    pub fn status(self) -> u16 {
        match self {
            Self::Internal => 500,
            _ => 401,
        }
    }

    /// The body's `message`.
    pub fn message(self) -> &'static str {
        match self {
            Self::NoToken => "No token provided",
            Self::InvalidToken(InvalidReason::Refused) => "Invalid token",
            Self::InvalidToken(InvalidReason::Unreachable) => "Failed to validate token",
            Self::UserFetch(UserFetchReason::Refused) => "Invalid token or user not found",
            Self::UserFetch(UserFetchReason::NotFound) => "User not found",
            Self::UserFetch(UserFetchReason::Unreachable) => "Failed to fetch user data",
            Self::Internal => "Internal server error",
        }
    }

    /// The body's `type`.
    pub fn kind(self) -> &'static str {
        match self {
            Self::NoToken => "no_token",
            Self::InvalidToken(_) => "invalid_token",
            Self::UserFetch(_) => "user_fetch_failed",
            Self::Internal => "internal_error",
        }
    }

    /// The JSON body, in the reference's key order.
    pub fn body(self) -> Value {
        json!({
            "error": true,
            "message": self.message(),
            "status": self.status(),
            "type": self.kind(),
        })
    }

    /// The answer the client sees.
    pub fn response(self) -> Response {
        Response::status(self.status()).json(&self.body())
    }
}

/// A forget did not reach the validation cache: the cached validation may still be accepted.
#[derive(Debug, thiserror::Error)]
#[error("the validation cache could not be updated: {0}")]
pub struct ForgetError(#[from] cache::CacheError);

/// Where failures of best-effort steps go (the reference's `error(…, {destination: 'both'})`).
/// Messages never contain a token.
pub trait AuthReport: Send + Sync + fmt::Debug {
    /// A step failed; `function` names the reference function.
    fn error(&self, function: &'static str, message: &str);
}

/// Discards reports.
#[derive(Clone, Copy, Debug, Default)]
pub struct NoReport;

impl AuthReport for NoReport {
    fn error(&self, _function: &'static str, _message: &str) {}
}

/// What the authenticator needs.
pub struct AuthDeps {
    /// The two Twitch calls.
    pub twitch: Arc<dyn TwitchUserApi>,
    /// The validation cache's store.
    pub cache: Dragonfly,
    /// `users` (activity touch).
    pub mongo: MongoStore,
    /// The clock (activity time).
    pub clock: Arc<dyn Clock>,
    /// Failure reports.
    pub report: Arc<dyn AuthReport>,
}

/// The authentication service: one per process, shared by every request.
pub struct Authenticator {
    config: AuthConfig,
    deps: AuthDeps,
}

impl fmt::Debug for Authenticator {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Authenticator")
            .field("config", &self.config)
            .finish_non_exhaustive()
    }
}

/// `Bearer ` removed once, as the reference does (`token.slice(7)`).
pub(crate) fn bearer_token(header: &str) -> &str {
    header.strip_prefix("Bearer ").unwrap_or(header)
}

/// RFC 6750 `token68`: what an OAuth token can contain.
fn plausible_token(token: &str) -> bool {
    token.chars().count() <= MAX_TOKEN_CHARS
        && token.chars().all(|c| {
            c.is_ascii_alphanumeric() || matches!(c, '-' | '.' | '_' | '~' | '+' | '/' | '=')
        })
}

/// JavaScript truthiness of a parsed JSON value.
pub(crate) fn truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(b) => *b,
        Value::Number(n) => n.as_f64().is_some_and(|f| f != 0.0 && !f.is_nan()),
        Value::String(s) => !s.is_empty(),
        Value::Array(_) | Value::Object(_) => true,
    }
}

impl Authenticator {
    /// A new authenticator.
    pub fn new(config: AuthConfig, deps: AuthDeps) -> Self {
        Self { config, deps }
    }

    /// The configuration.
    pub fn config(&self) -> &AuthConfig {
        &self.config
    }

    /// Steps 1 to 3 and the cache write: the identity behind an `Authorization` header value.
    pub async fn authenticate(
        &self,
        authorization: Option<&str>,
    ) -> Result<AuthenticatedUser, AuthFailure> {
        let Some(header) = authorization.filter(|value| !value.is_empty()) else {
            return Err(AuthFailure::NoToken);
        };
        let token = bearer_token(header);
        if token.is_empty() {
            return Err(AuthFailure::NoToken);
        }
        if !plausible_token(token) {
            return Err(AuthFailure::InvalidToken(InvalidReason::Refused));
        }
        let began = match cache::get(&self.deps.cache, token, self.config.store_deadline).await {
            Ok(cache::Lookup {
                user: Some(user), ..
            }) => return Ok(user),
            Ok(lookup) => Some(lookup.began),
            Err(error) => {
                self.deps.report.error("getCachedToken", &error.to_string());
                None
            }
        };
        let secret = SecretString::new(token.to_owned());
        let lifetime = self.validate(&secret).await?;
        let validated = tokio::time::Instant::now();
        let user = self.user(&secret).await?;
        let ttl = cache_ttl(self.config.cache_ttl, lifetime, validated.elapsed());
        // Without the server time of the lookup, a forget racing this authentication could not
        // be detected: the validation is used for this request only.
        if let (Some(began), Some(ttl_seconds)) = (began, ttl) {
            let publication = cache::Publication {
                token,
                user: &user,
                began,
                ttl_seconds,
                window: self.config.publish_window(),
            };
            if let Err(error) =
                cache::publish(&self.deps.cache, publication, self.config.store_deadline).await
            {
                self.deps.report.error("cacheToken", &error.to_string());
            }
        }
        Ok(user)
    }

    /// [`Authenticator::authenticate`] plus the activity touch: everything `authMiddleware` does
    /// but attaching and binding.
    pub async fn authenticate_request(
        &self,
        authorization: Option<&str>,
    ) -> Result<AuthenticatedUser, AuthFailure> {
        let user = self.authenticate(authorization).await?;
        self.touch_last_app_activity(&user.id).await;
        Ok(user)
    }

    /// `validateTwitchToken`, and what the answer says about the token's remaining life.
    async fn validate(&self, token: &SecretString) -> Result<Lifetime, AuthFailure> {
        let answer = self
            .deps
            .twitch
            .validate(token, Scheme::Bearer, self.config.twitch_timeout)
            .await
            .map_err(|_| AuthFailure::InvalidToken(InvalidReason::Unreachable))?;
        if answer.status == 401 {
            return Err(AuthFailure::InvalidToken(InvalidReason::Refused));
        }
        let Some(body) = answer.body else {
            return Err(AuthFailure::InvalidToken(InvalidReason::Unreachable));
        };
        if !truthy(&body) {
            return Err(AuthFailure::InvalidToken(InvalidReason::Refused));
        }
        if answer.status != 200 {
            return Ok(Lifetime::HelixDecides);
        }
        // Defence in depth: Helix refuses another application's token too (same answer).
        if body.get("client_id").and_then(Value::as_str) != Some(self.config.client_id.as_str()) {
            return Err(AuthFailure::UserFetch(UserFetchReason::Refused));
        }
        match body.get("expires_in").and_then(Value::as_f64) {
            // Twitch never sends a negative life with a 200; one is not a token to accept.
            Some(seconds) if seconds < 0.0 => {
                Err(AuthFailure::InvalidToken(InvalidReason::Refused))
            }
            // Zero with a 200 is either the token's last second or one of Twitch's old tokens
            // that never expire (it reports those as 0). Twitch accepted it now, so the request
            // is accepted, and nothing is cached: the next request asks Twitch again.
            Some(seconds) if seconds > 0.0 => Ok(Lifetime::Seconds(seconds)),
            Some(_) | None => Ok(Lifetime::Unknown),
        }
    }

    /// `getUserFromToken`.
    async fn user(&self, token: &SecretString) -> Result<AuthenticatedUser, AuthFailure> {
        let unreachable = AuthFailure::UserFetch(UserFetchReason::Unreachable);
        let answer: TwitchAnswer = self
            .deps
            .twitch
            .users(token, self.config.twitch_timeout)
            .await
            .map_err(|_| unreachable)?;
        if !answer.ok() {
            return Err(AuthFailure::UserFetch(UserFetchReason::Refused));
        }
        let body = answer.body.ok_or(unreachable)?;
        if body.is_null() {
            // `data.data` of `null` throws.
            return Err(unreachable);
        }
        let first = match body.get("data") {
            Some(Value::Array(items)) => match items.first() {
                Some(first) => first,
                None => return Err(AuthFailure::UserFetch(UserFetchReason::NotFound)),
            },
            Some(value) if truthy(value) => return Err(unreachable),
            _ => return Err(AuthFailure::UserFetch(UserFetchReason::NotFound)),
        };
        let text = |name: &str| first.get(name).and_then(Value::as_str).map(str::to_owned);
        let Some(id) = text("id").filter(|id| !id.is_empty()) else {
            return Err(unreachable);
        };
        Ok(AuthenticatedUser::new(
            id,
            text("login").unwrap_or_default(),
            text("display_name").unwrap_or_default(),
            text("profile_image_url"),
        ))
    }

    /// `touchLastAppActivity`: once a day per user, `users.last_app_activity_at = now` for the
    /// user owning the Twitch account (the reference's filter, `accounts.id` and `accounts.type`
    /// matched separately). Failures are reported and ignored.
    pub async fn touch_last_app_activity(&self, twitch_user_id: &str) {
        if twitch_user_id.is_empty() {
            return;
        }
        let deadline = self.config.store_deadline;
        let report = |message: &str| self.deps.report.error("touchLastAppActivity", message);
        match cache::touched_recently(&self.deps.cache, twitch_user_id, deadline).await {
            Ok(true) => return,
            Ok(false) => {}
            Err(error) => return report(&error.to_string()),
        }
        let now = self.deps.clock.now_ms();
        let filter = doc! { "accounts.id": twitch_user_id, "accounts.type": "twitch" };
        let update = doc! { "$set": { "last_app_activity_at": DateTime::from_millis(now) } };
        let prepared = match users::INFO.prepare_update(
            &filter,
            update,
            UpdateOptions::default(),
            &mut WriteContext::new(now),
        ) {
            Ok(prepared) => prepared,
            Err(error) => return report(&error.to_string()),
        };
        let mut writes = self.deps.mongo.writes(users::COLLECTION);
        match tokio::time::timeout(deadline, writes.update_one(&prepared)).await {
            Ok(Ok(_)) => {}
            Ok(Err(error)) => return report(&error.to_string()),
            Err(_) => return report("MongoDB did not answer within the deadline"),
        }
        let ttl = self.config.activity_touch_ttl.as_secs();
        if let Err(error) =
            cache::mark_touched(&self.deps.cache, twitch_user_id, ttl, deadline).await
        {
            report(&error.to_string());
        }
    }

    /// The identity cached for a token, without asking Twitch (the read `dima-analytics` and
    /// the unmounted validation route make of `token:{token}`). `None` on a miss or a failure.
    pub async fn cached_user(&self, authorization: &str) -> Option<AuthenticatedUser> {
        let token = bearer_token(authorization);
        if token.is_empty() || !plausible_token(token) {
            return None;
        }
        cache::get(&self.deps.cache, token, self.config.store_deadline)
            .await
            .ok()
            .and_then(|lookup| lookup.user)
    }

    /// Ends a token's cached validation at once (sign-out), so it is checked with Twitch on its
    /// next use, and keeps an authentication of it already in flight from caching it again.
    /// `Err` when Dragonfly could not be reached: the validation may still be cached (see the
    /// module docs for what the route answers).
    pub async fn forget(&self, authorization: &str) -> Result<(), ForgetError> {
        let token = bearer_token(authorization);
        if token.is_empty() {
            return Ok(());
        }
        cache::forget_token(
            &self.deps.cache,
            token,
            self.config.token_fence_ttl(),
            self.config.store_deadline,
        )
        .await?;
        Ok(())
    }

    /// Ends every cached validation of a Twitch user's tokens (account deletion, a ban), and
    /// keeps authentications in flight for that user from caching. `Err` as for
    /// [`Authenticator::forget`].
    pub async fn forget_user(&self, twitch_user_id: &str) -> Result<(), ForgetError> {
        if twitch_user_id.is_empty() {
            return Ok(());
        }
        cache::forget_user(
            &self.deps.cache,
            twitch_user_id,
            self.config.user_fence_ttl(),
            self.config.store_deadline,
        )
        .await?;
        Ok(())
    }
}

/// What `/validate` said about a token's remaining life.
#[derive(Clone, Copy, Debug, PartialEq)]
enum Lifetime {
    /// A 200 with a positive `expires_in`.
    Seconds(f64),
    /// A 200 without a usable `expires_in` (zero, absent, `null`, not a number).
    Unknown,
    /// `/validate` failed with another status and the Helix lookup decides (see the module docs).
    HelixDecides,
}

/// Seconds a validated token stays cached, or `None` when it must not be cached: the configured
/// lifetime, bounded by the token's remaining life minus the time spent since `/validate`
/// answered (the user lookup), never below [`MIN_CACHE_TTL`]. An unknown remaining life is not
/// cached: every request asks Twitch again.
fn cache_ttl(configured: Duration, lifetime: Lifetime, spent: Duration) -> Option<u64> {
    let configured = configured.as_secs().max(1);
    let ttl = match lifetime {
        Lifetime::HelixDecides => configured,
        Lifetime::Unknown => return None,
        Lifetime::Seconds(seconds) => {
            // Whole seconds, rounded down, minus the time spent rounded up: never past the
            // token's expiry. `as` saturates (an enormous `expires_in` is `u64::MAX`).
            #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
            let remaining = seconds.floor() as u64;
            let spent = spent.as_secs() + u64::from(spent.subsec_nanos() > 0);
            configured.min(remaining.saturating_sub(spent))
        }
    };
    (ttl >= MIN_CACHE_TTL.as_secs()).then_some(ttl)
}

/// Application state that carries the authenticator.
pub trait HasAuthenticator: Send + Sync + 'static {
    /// The process's authenticator.
    fn authenticator(&self) -> &Authenticator;
}

fn bind_channel<S>(req: &mut Req<S>, user: &AuthenticatedUser) {
    let channel = req
        .param("channelID")
        .filter(|value| !value.is_empty())
        .unwrap_or(&user.id)
        .to_owned();
    dima_telemetry::trace::bind_channel(&channel);
    req.extensions_mut().insert(BoundChannel(channel));
}

/// `authMiddleware`: attaches [`AuthenticatedUser`] and continues, or answers the reference's
/// 401. Use it as `router.middleware(require_user::<State>)` or in a route's tuple.
pub async fn require_user<S: HasAuthenticator>(req: &mut Req<S>) -> Result<Flow, WebError> {
    let state = req.state_arc();
    let header = req.header("authorization").map(|value| value.into_owned());
    match state
        .authenticator()
        .authenticate_request(header.as_deref())
        .await
    {
        Ok(user) => {
            bind_channel(req, &user);
            req.extensions_mut().insert(user);
            Ok(Flow::Next)
        }
        Err(failure) => Ok(Flow::Respond(failure.response())),
    }
}

/// `optionalAuthMiddleware`: attaches the user when the token is good, and always continues.
pub async fn optional_user<S: HasAuthenticator>(req: &mut Req<S>) -> Result<Flow, WebError> {
    let state = req.state_arc();
    let header = req.header("authorization").map(|value| value.into_owned());
    if let Ok(user) = state
        .authenticator()
        .authenticate_request(header.as_deref())
        .await
    {
        bind_channel(req, &user);
        req.extensions_mut().insert(user);
    }
    Ok(Flow::Next)
}

/// The workspace-owner refusal (`{error, message, status}`, no `type`).
pub fn workspace_owner_refusal() -> Response {
    Response::status(403).json(&json!({
        "error": true,
        "message": "Admin workspace access required",
        "status": 403,
    }))
}

/// `workspaceOwnerMiddleware`: only the creator's account passes (by Twitch id). Mount after
/// [`require_user`]; without it every request is refused.
pub async fn require_workspace_owner<S: Send + Sync + 'static>(
    req: &mut Req<S>,
) -> Result<Flow, WebError> {
    let owner = AuthenticatedUser::maybe(req).is_some_and(|user| user.id == CREATOR_TWITCH_USER_ID);
    Ok(if owner {
        Flow::Next
    } else {
        Flow::Respond(workspace_owner_refusal())
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bearer_is_removed_once() {
        assert_eq!(bearer_token("Bearer abc"), "abc");
        assert_eq!(bearer_token("Bearer Bearer abc"), "Bearer abc");
        assert_eq!(bearer_token("bearer abc"), "bearer abc");
        assert_eq!(bearer_token("Bearer"), "Bearer");
        assert_eq!(bearer_token("Bearer "), "");
    }

    #[test]
    fn token_shape() {
        assert!(plausible_token("abc123def456ghi789jkl012mno345"));
        assert!(!plausible_token("bearer abc"));
        assert!(!plausible_token("tok\u{e9}n"));
        assert!(!plausible_token(&"a".repeat(MAX_TOKEN_CHARS + 1)));
    }

    #[test]
    fn failures_render_the_reference_body() {
        let body = serde_json::to_string(&AuthFailure::NoToken.body()).unwrap_or_default();
        assert_eq!(
            body,
            r#"{"error":true,"message":"No token provided","status":401,"type":"no_token"}"#
        );
    }

    #[test]
    fn ttl_is_bounded_by_the_token_and_the_time_spent() {
        let ttl = Duration::from_secs(3600);
        let none = Duration::ZERO;
        assert_eq!(cache_ttl(ttl, Lifetime::HelixDecides, none), Some(3600));
        assert_eq!(cache_ttl(ttl, Lifetime::Unknown, none), None);
        assert_eq!(cache_ttl(ttl, Lifetime::Seconds(120.7), none), Some(120));
        assert_eq!(
            cache_ttl(ttl, Lifetime::Seconds(120.7), Duration::from_millis(2_300)),
            Some(117)
        );
        assert_eq!(
            cache_ttl(ttl, Lifetime::Seconds(99_999.0), none),
            Some(3600)
        );
        assert_eq!(cache_ttl(ttl, Lifetime::Seconds(1e300), none), Some(3600));
        assert_eq!(cache_ttl(ttl, Lifetime::Seconds(5.0), none), Some(5));
        assert_eq!(
            cache_ttl(ttl, Lifetime::Seconds(6.0), Duration::from_secs(2)),
            None
        );
        assert_eq!(cache_ttl(ttl, Lifetime::Seconds(0.5), none), None);
    }
}
