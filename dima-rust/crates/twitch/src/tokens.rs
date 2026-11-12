//! App, bot and streamer tokens (`utils/tokens.ts` and the token half of
//! `twitch_streamers.class.ts`).
//!
//! # Where each token lives
//!
//! - **App token** (client credentials): Dragonfly `app:twitch:token`, `EX expires_in`. A miss
//!   requests a new one (`getAppToken`); no lock across processes, as in the reference.
//! - **Streamer and bot tokens**: MongoDB `users.accounts[]` (`access_token` and
//!   `refresh_token` as the `{iv, content}` envelope of `utils/crypto.ts`,
//!   `access_token_expires_at` in epoch seconds), mirrored in the directory hash
//!   `accounts:twitch:{id}:data` (`access_token`, `refresh_token` as the same envelopes, as
//!   JSON text; `expires_at`). The bot is the streamer account [`crate::TWITCH_BOT_ACCOUNT_ID`].
//!   The app token is cached as an envelope too. No token is ever in Dragonfly in plain text
//!   (the reference keeps them so: lead's decision, the family is Rust's own).
//!
//! # When a token is refreshed
//!
//! A cached token is used while it has more than 300 s left and is not the one Twitch just
//! refused (`rejected`); so is the token of a rotation this process is still writing. Otherwise
//! one refresh runs, the same way for every entry point (a token request, a 401, the bot, the
//! public [`Twitch::refresh_token`] of the sign-in routes):
//!
//! 1. **One at a time** (`lease.rs`): callers in a process join one task per streamer and
//!    rejected token (a caller that gives up does not cancel it), which takes the streamer's
//!    in-process gate, then the reference's cross-process lease `locks:refresh:twitch:{id}`
//!    (`SET NX PX 5000`, **renewed** while held). A process that does not get the lease polls
//!    the hash every 150 ms for up to 4.5 s for a token other than the rejected one with more
//!    than 60 s left, stops waiting when the lease is gone, then tries once more; failing that
//!    it gives up for this call.
//! 2. **Under the lease, MongoDB decides** (`refresh.rs`): an answer this process still holds,
//!    then the streamer's recovery record (written by any process, however old), is written to
//!    MongoDB first, or dropped when MongoDB holds something newer; while that fails, nothing is
//!    exchanged; then a usable stored access token is returned (the cache
//!    repaired from MongoDB, nothing sent); otherwise the **stored** refresh token is the one
//!    exchanged, never the cache's copy.
//! 3. **The exchange** (`refreshTwitchToken`): the exchange marker is set (`NX`; when another
//!    exchange is or may be in flight nothing is sent), then three attempts, 400 ms and 900 ms
//!    apart, retried only on a network error or a 5xx, none started once the process stops.
//! 4. **The answer is always stored** (`recovery.rs`): it enters the process's registry of
//!    unwritten answers before anything else, then its recovery record in Dragonfly
//!    (encrypted), then MongoDB with a compare-and-set on the state read in 2 (advancing the
//!    generation), then the hash under that generation; then the record is removed, the answer
//!    leaves the registry and the marker is removed. A MongoDB failure keeps the answer (never
//!    exchanged again): a background writer retries, each retry first making sure the record
//!    still holds it, and when the drain ends the last step of shutdown parks whatever the
//!    registry still holds.
//!
//! # What a refused refresh does
//!
//! Twitch's answer is classified ([`crate::oauth`]): a 400 or 401 whose message says the
//! refresh token is invalid or revoked is **permanent**; anything else is transient and changes
//! nothing. A permanent refusal that follows an **ambiguous attempt** of the same exchange (a
//! request that may have reached Twitch without a usable answer: a lost answer, a 5xx, a 2xx
//! that could not be read) is inconclusive (review F3): Twitch may have rotated the token on
//! that attempt, so nothing is wiped, permissions stay, the marker is left to expire and the
//! next refresh, which starts clean, decides ([`RefreshFailureReason::Inconclusive`]). On any
//! other permanent refusal MongoDB is read again: if the stored refresh token is no
//! longer the refused one, another refresh rotated it and its access token is used when it has
//! more than 60 s left (otherwise the call fails without touching anything). If it is the same
//! but the exchange marker is no longer this refresh's own, the refusal is inconclusive (another
//! exchange may have consumed the token) and nothing changes. Otherwise, when the cache holds a
//! different refresh token, that one is tried once; failing that the stored tokens are wiped
//! (`{iv: null, content: null}` envelopes, `access_token_expires_at: null`, `has_permissions`
//! and `up_to_date_permissions` false; the hash's credential fields emptied) and the streamer
//! must log in again at domdimabot.com.
//!
//! # What a crash can still lose
//!
//! A hard crash (no drain: `SIGKILL`, power loss) before the first write of the recovery record
//! lands (a few milliseconds after the answer) loses the new pair; if Twitch consumed the old
//! refresh token, the streamer must log in again (after the marker expires, 30 s). The same
//! happens if both Dragonfly and MongoDB refuse from the answer to the end of the last step of
//! shutdown (logged as `token_refresh_lost`), or if the container's stop timeout cuts the
//! shutdown short ([`crate::Timings::shutdown_budget`] must fit in it).
//!
//! # Intended differences (safety; `MIGRATION.md` section 3; review 2026-11-11)
//!
//! - **MongoDB decides** (see 2): the reference exchanges and compares with the *cache*.
//! - **Writes are compare-and-set** on the stored refresh envelope and the generation
//!   (`crate::credentials`); the reference's `findOneAndUpdate` is unconditional. The
//!   documents written are the reference's (same `$set`, plus Mongoose's `updated_at` and the
//!   user's `refreshed_at`, which carries the generation).
//! - **The lease is renewed and released atomically**; the exchange marker is Rust's own.
//! - **The public `refresh_token` is serialised** and sends nothing when the presented token was
//!   rotated meanwhile or the user does not exist (three recorded traces change on purpose).
//! - **A failed store read never wipes.** The reference treats an unreadable cache as "no stored
//!   token" and wipes; here the call fails as transient.
//! - **No Twitch text in logs or errors**: a refusal is a category ([`RefreshFailureReason`]);
//!   the reference logs Twitch's message and the first 500 characters of an unreadable answer.
//! - **The cache holds envelopes**, never a token in plain text.
//! - Not written: the `app:twitch:bot` copy of the bot token and the OAuth debug cache (both
//!   write-only in the reference; see [`crate::keys`]).
//!
//! Every log entry is the reference's, with `caller` given by the Rust caller (the reference
//! derives it from a stack trace).

use crate::base::{Inner, Twitch};
use crate::error::TwitchError;
use crate::events::{Destination, Level};
use crate::oauth::{Field, RefreshContext, RefreshFailureKind, RefreshFailureReason, parse_answer};
use crate::secret::{AccessToken, RefreshToken, open_cached, seal};
use dima_store::dragonfly::script::Script;

/// Stores a new app token only while the cache holds the expected value (Rust only).
static REPLACE_APP_TOKEN: Script = Script::new(
    "RUST_REPLACE_APP_TOKEN_SCRIPT",
    include_str!("lua/replace_app_token.lua"),
);
use serde_json::json;
use std::sync::Arc;

/// The key of one refresh in a process: the streamer and a digest of the rejected token.
pub(crate) type FlightKey = (String, Option<[u8; 32]>);

/// Why no token could be given.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum TokenError {
    /// The streamer has no refresh token (unknown, or wiped after a revocation).
    #[error("the streamer has no refresh token")]
    NoRefreshToken,
    /// Twitch refused or failed the refresh.
    #[error("the token refresh failed ({kind}, {reason})")]
    Refresh {
        /// Transient or permanent.
        kind: RefreshFailureKind,
        /// Twitch's status, when it answered.
        status: Option<u16>,
        /// The category (never Twitch's text, which can echo a credential).
        reason: RefreshFailureReason,
    },
    /// The refresh produced the very token Twitch had refused.
    #[error("the refreshed token is the one Twitch rejected")]
    SameAsRejected,
    /// Another process held the refresh lock for the whole wait and still holds it.
    #[error("another process holds the refresh lock")]
    LockUnavailable,
    /// A store failed.
    #[error(transparent)]
    Store(#[from] TwitchError),
}

/// The result of `refreshTwitchToken`.
#[derive(Clone, Debug, PartialEq)]
pub enum RefreshOutcome {
    /// New (or already rotated) credentials.
    Success {
        /// The access token.
        access_token: AccessToken,
        /// The refresh token.
        refresh_token: RefreshToken,
        /// Seconds the access token is valid for (`expiresIn`; a JSON number, 7200 when
        /// Twitch's answer has none).
        expires_in: f64,
    },
    /// No credentials.
    Failure {
        /// Transient or permanent.
        kind: RefreshFailureKind,
        /// Twitch's status, when it answered.
        status: Option<u16>,
        /// The category (the reference returned Twitch's text here; see [`RefreshFailureReason`]).
        reason: RefreshFailureReason,
    },
}

impl RefreshOutcome {
    fn failure(
        kind: RefreshFailureKind,
        status: Option<u16>,
        reason: RefreshFailureReason,
    ) -> Self {
        Self::Failure {
            kind,
            status,
            reason,
        }
    }
}

/// `isAccessTokenUsable`: a non-empty token whose `expires_at` (read with `parseInt(_, 10)`) is
/// more than `skew` seconds after `now`.
pub fn is_access_token_usable(
    token: Option<&str>,
    expires_at: Option<&str>,
    now_secs: i64,
    skew_secs: i64,
) -> bool {
    if token.is_none_or(str::is_empty) {
        return false;
    }
    let expiration = expires_at.map_or(f64::NAN, |raw| {
        dima_text::parse_int(raw, dima_text::Radix::Decimal)
    });
    expiration.is_finite() && (now_secs as f64) < expiration - skew_secs as f64
}

impl Inner {
    /// `getAccountTokenById(id, 'twitch', rejected)`.
    pub(crate) async fn streamer_token(
        self: &Arc<Self>,
        id: &str,
        rejected: Option<&AccessToken>,
        caller: &str,
    ) -> Result<AccessToken, TokenError> {
        let result = self.streamer_token_inner(id, rejected, caller).await;
        if let Err(TokenError::Store(error)) = &result {
            self.token_log(
                Level::Error,
                id,
                caller,
                json!({ "action": "exception", "error": error.to_string() }),
            );
        }
        result
    }

    async fn streamer_token_inner(
        self: &Arc<Self>,
        id: &str,
        rejected: Option<&AccessToken>,
        caller: &str,
    ) -> Result<AccessToken, TokenError> {
        let timings = &self.config.timings;
        let cached = self.cached_credentials(id).await?;
        let now = self.now_secs();
        let parsed = cached.expires_at.as_deref().map_or(f64::NAN, |raw| {
            dima_text::parse_int(raw, dima_text::Radix::Decimal)
        });
        let seconds_until = parsed.is_finite().then_some(parsed - now as f64);
        let token = cached.access();
        self.token_log(
            Level::Debug,
            id,
            caller,
            json!({
                "hasToken": token.is_some(),
                "hasExpiresAt": cached.expires_at.as_deref().is_some_and(|e| !e.is_empty()),
                "expiresAt": cached.expires_at.as_deref().filter(|e| !e.is_empty()).unwrap_or("not set"),
                "secondsUntilExpiry": seconds_until,
            }),
        );
        let is_rejected = |token: &str| rejected.is_some_and(|rejected| rejected.expose() == token);
        if let Some(token) = token
            && !is_rejected(token)
            && is_access_token_usable(
                Some(token),
                cached.expires_at.as_deref(),
                now,
                timings.token_expiry_skew_secs,
            )
            && let Some(token) = cached.access_token.clone()
        {
            self.token_log(
                Level::Debug,
                id,
                caller,
                json!({ "action": "returning_cached_token", "secondsUntilExpiry": seconds_until }),
            );
            return Ok(token);
        }
        let reason = match token {
            None => "no_cached_token",
            Some(token) if is_rejected(token) => "rejected_by_twitch",
            Some(_) if parsed.is_finite() => "near_or_expired",
            Some(_) => "missing_or_invalid_expires_at",
        };
        self.token_log(
            Level::Info,
            id,
            caller,
            json!({
                "action": "token_needs_refresh",
                "reason": reason,
                "secondsUntilExpiry": seconds_until,
                "skewSeconds": timings.token_expiry_skew_secs,
            }),
        );
        // A rotation this process holds while MongoDB refuses to take it.
        if let Some(token) = self.pending_token(id, rejected) {
            return Ok(token);
        }
        if self.shutdown.is_triggered() {
            return Err(TwitchError::Shutdown.into());
        }
        let digest = rejected.map(|token| dima_core::crypto::sha256(token.expose().as_bytes()).0);
        let key: FlightKey = (id.to_owned(), digest);
        let inner = Arc::clone(self);
        let kill = self.kill.clone();
        let owned_id = id.to_owned();
        let owned_rejected = rejected.cloned();
        let owned_caller = caller.to_owned();
        let waiter = self
            .token_flights
            .join(
                key,
                &self.tracker,
                Err(TokenError::Store(TwitchError::Interrupted)),
                move || async move {
                    tokio::select! {
                        biased;
                        () = kill.cancelled() => Err(TokenError::Store(TwitchError::Interrupted)),
                        result = inner.locked_refresh(&owned_id, owned_rejected.as_ref(), &owned_caller) => result,
                    }
                },
            )
            .ok_or(TokenError::Store(TwitchError::Busy))?;
        waiter.await
    }

    /// The cached app token and the cached text it was read from (`None` when there is none
    /// or it does not decrypt).
    async fn cached_app_token(&self) -> Result<Option<(AccessToken, String)>, TwitchError> {
        let text = self
            .dragonfly
            .get_text(&self.config.keys.app_token())
            .await
            .map_err(|error| TwitchError::cache("get app token", error))?;
        Ok(text.and_then(|text| {
            open_cached(&self.cipher, &text).map(|token| (AccessToken::from_secret(token), text))
        }))
    }

    /// A new app token, one request per process at a time, stored if the cache still holds
    /// `expected` (`""`: nothing).
    async fn request_app_token(self: &Arc<Self>, expected: String) -> Option<AccessToken> {
        if self.shutdown.is_triggered() {
            return None;
        }
        let worker = Arc::clone(self);
        let kill = self.kill.clone();
        let waiter = self
            .app_flight
            .join((), &self.tracker, None, move || async move {
                tokio::select! {
                    biased;
                    () = kill.cancelled() => None,
                    token = worker.new_app_token(&expected) => token,
                }
            })?;
        waiter.await
    }

    /// Whether a 401-driven refresh for `rejected` did not help within the window.
    fn refresh_did_not_help(&self, rejected: &AccessToken) -> bool {
        let key = dima_core::crypto::sha256(rejected.expose().as_bytes()).0;
        let window = self.config.timings.unhelpful_refresh_window;
        let unhelpful = self
            .unhelpful_refreshes
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .get(&key)
            .is_some_and(|at| at.elapsed() < window);
        if unhelpful {
            self.log(
                Level::Warn,
                Destination::Both,
                None,
                json!({
                    "message": "Twitch refused a token that a refresh just produced (or could not replace); not refreshing again for now.",
                }),
            );
        }
        unhelpful
    }

    /// After a 401-driven refresh for `rejected`: a new token is remembered (if Twitch refuses
    /// it too within the window, the refresh did not help); no new token marks `rejected`.
    fn remember_refresh(&self, rejected: &AccessToken, fresh: Option<&AccessToken>) {
        let token = match fresh {
            Some(fresh) if fresh != rejected => fresh,
            _ => rejected,
        };
        let key = dima_core::crypto::sha256(token.expose().as_bytes()).0;
        let mut memory = self
            .unhelpful_refreshes
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if memory.len() >= crate::base::MAX_FLIGHTS {
            memory.clear();
        }
        memory.insert(key, tokio::time::Instant::now());
    }

    /// `getNewTwitchAppToken` + the `SET` of `getAppToken`, as a compare-and-set: the new token
    /// replaces the cached one only if the cache still holds `expected` (`""`: nothing).
    async fn new_app_token(&self, expected: &str) -> Option<AccessToken> {
        let internal_error = |error: String| {
            self.log(
                Level::Error,
                Destination::Console,
                None,
                json!({ "message": format!("Error getting new Twitch app token internal error: {error}") }),
            );
            None
        };
        let answer = match self.post_client_credentials().await {
            Ok(answer) => answer,
            Err(error) => return internal_error(error.to_string()),
        };
        // The text never reaches a log: it may echo the app token. It is read into wiping
        // buffers (`oauth::AnswerBody`).
        if answer.body.is_empty() {
            return internal_error("the answer is not JSON".to_owned());
        }
        let status = answer.status;
        let mut data = match parse_answer(&answer.body).0 {
            Ok(data) => data,
            Err(_) => return internal_error("the answer is not JSON".to_owned()),
        };
        drop(answer);
        if !data.access_token.truthy() {
            // The reference logs Twitch's `message`; only its category is logged here.
            let (_, reason) = data.classify(status);
            self.log(
                Level::Error,
                Destination::Console,
                None,
                json!({
                    "message": format!("Error getting new Twitch app token: {}", reason.as_str()),
                    "status": status,
                }),
            );
            return None;
        }
        // A truthy access token that is not a string (the reference would use it as it is)
        // is no token here.
        let Some(token) = data.access_token.take_text() else {
            return internal_error("access_token is not a string".to_owned());
        };
        // `{EX: Number(expires_in)}`: the server refuses anything but a positive integer, and
        // the reference's `SET` then throws into the same catch.
        let seconds = match &data.expires_in {
            Field::Number(number) => *number,
            Field::Text(text) => dima_text::parse_number(text.expose()),
            _ => f64::NAN,
        };
        if !(seconds.is_finite() && seconds >= 1.0 && seconds.fract() == 0.0 && seconds < 9e15) {
            return internal_error("expires_in is not a positive integer".to_owned());
        }
        let seconds = seconds as u64;
        let sealed = match seal(&self.cipher, &*self.random, token.expose()) {
            Ok(sealed) => sealed,
            Err(error) => return internal_error(error.to_string()),
        };
        let seconds = seconds.to_string();
        if let Err(error) = REPLACE_APP_TOKEN
            .run_value(
                &self.dragonfly,
                &[self.config.keys.app_token()],
                &[expected, sealed.as_str(), seconds.as_str()],
            )
            .await
        {
            return internal_error(error.to_string());
        }
        // Not stored when another token replaced the expected one meanwhile: that one is kept,
        // and this one (also valid) is used by this caller.
        Some(AccessToken::from_secret(token))
    }
}

impl Twitch {
    /// `getAccountTokenById(id, 'twitch', rejected)`: the streamer's access token, refreshed
    /// when it has 300 s or less left or is the `rejected` one. `caller` names the origin for
    /// the logs (the reference reads it from a stack trace).
    pub async fn streamer_token(
        &self,
        id: &str,
        rejected: Option<&AccessToken>,
        caller: &str,
    ) -> Result<AccessToken, TokenError> {
        self.inner.streamer_token(id, rejected, caller).await
    }

    /// `getBotToken`: the bot account's token (no permission check, as in the reference).
    pub async fn bot_token(&self) -> Result<AccessToken, TokenError> {
        let bot = self.inner.config.bot_user_id.clone();
        let result = self.inner.streamer_token(&bot, None, "getBotToken").await;
        if result.is_err() {
            self.inner.log(
                Level::Error,
                Destination::Both,
                Some(&bot),
                json!({
                    "function": "getBotToken",
                    "userId": bot,
                    "action": "bot_token_unavailable",
                    "reason": "getAccountTokenById returned null for the bot account; bot-executed features (moderation, clips, shoutouts) will fail until the bot reauthorizes",
                }),
            );
        }
        result
    }

    /// `getAppToken('twitch')`: the cached app token, or a new one (one request per process at
    /// a time).
    pub async fn app_token(&self) -> Option<AccessToken> {
        let inner = &self.inner;
        let cached = match inner.cached_app_token().await {
            Ok(cached) => cached,
            Err(error) => {
                inner.log(
                    Level::Error,
                    Destination::Console,
                    None,
                    json!({ "message": format!("Error getting twitch app token: {error}") }),
                );
                return None;
            }
        };
        if let Some((token, _)) = cached {
            return Some(token);
        }
        inner.request_app_token(String::new()).await
    }

    /// The app token after Helix refused `rejected` (review finding 10): a different cached
    /// token (another caller's or process's new one) is used as it is; otherwise one new token
    /// is requested, and stored only if the cache still holds the refused one (or none), so a
    /// concurrent winner is kept. When a refresh for this token did not help a moment ago
    /// ([`crate::Timings::unhelpful_refresh_window`]: the refused token is one a refresh just
    /// produced, or a refresh for it just failed), nothing is requested and the token is
    /// returned as it is: a 401 that a new token does not cure (a missing scope) costs one
    /// refresh per window, not one per request.
    pub(crate) async fn app_token_after_rejection(
        &self,
        rejected: &AccessToken,
    ) -> Option<AccessToken> {
        let inner = &self.inner;
        let cached = inner.cached_app_token().await.ok()?;
        let expected = match cached {
            Some((token, _)) if token != *rejected => return Some(token),
            Some((_, text)) => text,
            None => String::new(),
        };
        if inner.refresh_did_not_help(rejected) {
            return Some(rejected.clone());
        }
        let fresh = inner.request_app_token(expected).await;
        inner.remember_refresh(rejected, fresh.as_ref());
        fresh
    }

    /// The bot's token after Helix refused `rejected` (review finding 10; moderator calls run
    /// as the bot): the streamer refresh with `rejected` passed, so a concurrent winner is
    /// used and the refused token is never handed back; suppressed like
    /// [`Twitch::app_token_after_rejection`] when a refresh for it did not help a moment ago.
    pub(crate) async fn bot_token_after_rejection(
        &self,
        rejected: &AccessToken,
    ) -> Option<AccessToken> {
        let inner = &self.inner;
        if inner.refresh_did_not_help(rejected) {
            return Some(rejected.clone());
        }
        let bot = inner.config.bot_user_id.clone();
        let fresh = inner
            .streamer_token(&bot, Some(rejected), "getTwitchBotHeader")
            .await
            .ok();
        inner.remember_refresh(rejected, fresh.as_ref());
        fresh
    }

    /// `refreshTwitchToken(refreshToken, userId, context)` as the sign-in routes call it. Unlike
    /// the reference (no lock), it goes through the same gate and lease as every other refresh,
    /// and the presented token is exchanged only while it is still the stored one; when it has
    /// been rotated meanwhile, the stored pair is returned if its access token is usable, and
    /// nothing is sent. The refresh runs as a task: dropping the returned future does not lose
    /// a rotation Twitch already answered.
    pub async fn refresh_token(
        &self,
        refresh_token: &RefreshToken,
        user_id: &str,
        context: RefreshContext,
    ) -> RefreshOutcome {
        let inner = Arc::clone(&self.inner);
        let refresh_token = refresh_token.clone();
        let user_id = user_id.to_owned();
        let kill = self.inner.kill.clone();
        let task = self.inner.tracker.spawn(async move {
            tokio::select! {
                biased;
                () = kill.cancelled() => RefreshOutcome::Failure {
                    kind: RefreshFailureKind::Transient,
                    status: None,
                    reason: RefreshFailureReason::Interrupted,
                },
                outcome = inner.locked_rotation(&refresh_token, &user_id, &context) => outcome,
            }
        });
        task.await.unwrap_or_else(|_| {
            RefreshOutcome::failure(
                RefreshFailureKind::Transient,
                None,
                RefreshFailureReason::Interrupted,
            )
        })
    }

    /// Tells the crate that the streamer's credentials were written to MongoDB by another
    /// writer (a sign-in): the generation is advanced (compare-and-set on what is stored) and
    /// MongoDB's state is copied to the directory, so no cache write that started before can
    /// cover it. Every writer of the token fields outside this crate must call it after its
    /// MongoDB write.
    pub async fn credentials_changed(&self, id: &str) -> Result<(), TwitchError> {
        self.inner.credentials_changed(id).await
    }

    /// `getAccountRefreshTokenById(id, 'twitch')`: the stored refresh token (cache, else
    /// MongoDB); `None` when there is none or on error (logged).
    pub async fn stored_refresh_token(&self, id: &str) -> Option<RefreshToken> {
        match self.inner.stored_refresh_token(id).await {
            Ok(token) => token,
            Err(error) => {
                self.inner.log(
                    Level::Error,
                    Destination::Both,
                    Some(id),
                    json!({
                        "function": "TwitchStreamers.getAccountRefreshTokenById",
                        "id": id,
                        "account_type": "twitch",
                        "error": error.to_string(),
                    }),
                );
                None
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn usable_follows_parse_int_and_the_skew() {
        let usable =
            |expiry: Option<&str>, skew| is_access_token_usable(Some("t"), expiry, 1000, skew);
        assert!(usable(Some("1301"), 300));
        assert!(!usable(Some("1300"), 300));
        assert!(usable(Some("1061"), 60));
        assert!(!usable(Some("1060"), 60));
        assert!(usable(Some("2000garbage"), 300));
        assert!(usable(Some("+2000.9"), 300));
        assert!(!usable(Some("-0x10"), 300));
        assert!(usable(Some("\u{feff}2000"), 300));
        assert!(!usable(Some("Infinity"), 300));
        assert!(!usable(Some("1e9"), 300));
        assert!(!usable(Some(""), 300));
        assert!(!usable(None, 300));
        assert!(!is_access_token_usable(Some(""), Some("9999"), 1000, 300));
        assert!(!is_access_token_usable(None, Some("9999"), 1000, 300));
    }
}
