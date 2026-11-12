//! The refresh of one streamer's token: the protected section (lock, MongoDB, exchange, store)
//! and the reference's `refreshTwitchToken`.
//!
//! # MongoDB decides (review finding 5)
//!
//! Under the lock, the stored state is read from MongoDB before anything is sent to Twitch:
//!
//! 1. A stored access token that is still usable (and not the rejected one) is returned, and
//!    the cache is repaired from MongoDB (fenced by the generation): nothing is exchanged.
//! 2. Otherwise the **stored** refresh token is exchanged, never the cache's copy. A cache that
//!    differs from MongoDB is not assumed to be older or newer.
//! 3. When Twitch refuses the stored token for good and the cache holds a *different* refresh
//!    token, that one is tried once before the streamer is wiped (the cache can be ahead of
//!    MongoDB, for example after a restore of MongoDB). A rotation it yields is stored over the
//!    refused state; a refusal of it too wipes as usual.
//! 4. A rotation is written with a compare-and-set on the state read in step 1; when that state
//!    changed meanwhile (a sign-in), the newer stored token is kept.

use crate::base::Inner;
use crate::credentials::{CAS_ROUNDS, StoredAccount, Written, rotation_fields, wipe_fields};
use crate::error::TwitchError;
use crate::events::{Destination, Level};
use crate::oauth::{RefreshContext, RefreshFailureKind, RefreshFailureReason, classify_refusal};
use crate::secret::{AccessToken, RefreshToken, open_cached};
use crate::streamers::decrypt_envelope;
use crate::tokens::{RefreshOutcome, TokenError, is_access_token_usable, truthy};
use dima_core::SecretString;
use dima_core::crypto::{CredentialCipher, StoredCredential};
use dima_model::users::EncryptedToken;
use dima_store::dragonfly::commands::reply;
use dima_store::dragonfly::script::Script;
use dima_store::dragonfly::{SetCondition, SetExpiry, SetOptions, SetOutcome};
use serde_json::{Value, json};
use std::sync::Arc;
use tokio::time::Instant;

/// Deletes the lock only if this process still owns it (Rust only; no loop).
static RELEASE_LOCK: Script = Script::new(
    "RELEASE_REFRESH_LOCK_SCRIPT",
    "\nif redis.call('GET', KEYS[1]) == ARGV[1] then\n    return redis.call('DEL', KEYS[1])\nend\nreturn 0\n",
);

/// The cache's credential fields of one streamer, decrypted.
#[derive(Default)]
pub(crate) struct CachedCredentials {
    pub(crate) access_token: Option<AccessToken>,
    pub(crate) expires_at: Option<String>,
    pub(crate) refresh_token: Option<RefreshToken>,
}

impl CachedCredentials {
    pub(crate) fn access(&self) -> Option<&str> {
        self.access_token.as_ref().map(AccessToken::expose)
    }
}

/// What one exchange with Twitch gave (each case already logged as the reference logs it).
enum Exchange {
    /// New tokens.
    Rotated {
        access: AccessToken,
        refresh: RefreshToken,
        expires_in: f64,
    },
    /// Twitch refused (a 4xx or 5xx answer, or a 2xx with an `error` field).
    Refused {
        kind: RefreshFailureKind,
        reason: RefreshFailureReason,
        status: u16,
    },
    /// No usable answer (network, unparseable, incomplete).
    Failed(RefreshOutcome),
}

/// What a compare-and-set write of a rotation found.
enum Persisted {
    /// Written with this generation.
    Written(i64),
    /// A different refresh token is stored: nothing written.
    Superseded(Box<StoredAccount>),
    /// No such user.
    UserNotFound,
}

/// The refresh token in a stored envelope (wiped when dropped); `Err` when the envelope
/// cannot be decrypted.
pub(crate) fn stored_refresh(
    cipher: &CredentialCipher,
    envelope: &EncryptedToken,
) -> Result<Option<RefreshToken>, dima_core::crypto::CipherError> {
    Ok(decrypt_envelope(cipher, envelope)?
        .filter(|token| !token.is_empty())
        .map(|token| RefreshToken::from_secret(SecretString::new(token))))
}

/// The access token in a stored envelope (wiped when dropped); `None` when there is none or it
/// cannot be decrypted.
fn stored_access(cipher: &CredentialCipher, envelope: &EncryptedToken) -> Option<AccessToken> {
    decrypt_envelope(cipher, envelope)
        .ok()
        .flatten()
        .filter(|token| !token.is_empty())
        .map(|token| AccessToken::from_secret(SecretString::new(token)))
}

fn failure(
    kind: RefreshFailureKind,
    status: Option<u16>,
    reason: RefreshFailureReason,
) -> RefreshOutcome {
    RefreshOutcome::Failure {
        kind,
        status,
        reason,
    }
}

impl Inner {
    /// `HMGET accounts:twitch:{id}:data access_token expires_at refresh_token`, decrypted.
    pub(crate) async fn cached_credentials(
        &self,
        id: &str,
    ) -> Result<CachedCredentials, TwitchError> {
        let reply = self
            .dragonfly
            .query_value(
                redis::cmd("HMGET")
                    .arg(self.config.keys.account(id))
                    .arg("access_token")
                    .arg("expires_at")
                    .arg("refresh_token"),
            )
            .await
            .map_err(|error| TwitchError::cache("hmget", error))?;
        let mut values = reply::array(reply)
            .map_err(|_| TwitchError::Protocol { op: "hmget" })?
            .into_iter()
            .map(|value| {
                reply::bytes_or_nil(value)
                    .map_err(|_| TwitchError::Protocol { op: "hmget" })?
                    .map(|bytes| {
                        String::from_utf8(bytes).map_err(|_| TwitchError::Protocol { op: "hmget" })
                    })
                    .transpose()
            });
        let mut next = || values.next().transpose().map(Option::flatten);
        let (access, expires_at, refresh) = (next()?, next()?, next()?);
        let open = |text: Option<String>| text.and_then(|text| open_cached(&self.cipher, &text));
        Ok(CachedCredentials {
            access_token: open(access).map(AccessToken::from_secret),
            expires_at,
            refresh_token: open(refresh).map(RefreshToken::from_secret),
        })
    }

    /// The cache's credentials replaced by MongoDB's (fenced by the generation).
    async fn sync_cache_from(
        &self,
        id: &str,
        stored: &StoredAccount,
    ) -> Result<CachedCredentials, TwitchError> {
        self.publish_stored(id, stored).await?;
        Ok(CachedCredentials {
            access_token: stored_access(&self.cipher, &stored.access),
            expires_at: Some(stored.expires_at.clone().unwrap_or_default()),
            refresh_token: stored_refresh(&self.cipher, &stored.refresh)?,
        })
    }

    pub(crate) fn refresh_log(
        &self,
        level: Level,
        destination: Destination,
        user_id: &str,
        context: &RefreshContext,
        mut data: Value,
    ) {
        if let Value::Object(map) = &mut data {
            map.insert("endpoint".to_owned(), context.endpoint_json());
            map.insert("caller".to_owned(), context.caller_json());
        }
        self.log(level, destination, Some(user_id), data);
    }

    /// One exchange: the reference's attempts, parse and classification, with its logs.
    async fn exchange(
        &self,
        refresh_token: &RefreshToken,
        user_id: &str,
        context: &RefreshContext,
    ) -> Exchange {
        let Some(answer) = self.post_refresh(refresh_token, user_id, context).await else {
            self.refresh_log(
                Level::Error,
                Destination::Both,
                user_id,
                context,
                json!({
                    "function": "refreshTwitchToken",
                    "userId": user_id,
                    "action": "token_refresh_failed",
                    "reason": "network_error_after_retries",
                    "attempts": self.config.timings.refresh_attempts,
                }),
            );
            return Exchange::Failed(failure(
                RefreshFailureKind::Transient,
                None,
                RefreshFailureReason::Network,
            ));
        };
        let status = answer.status;
        let data: Value = if answer.text.is_empty() {
            json!({})
        } else {
            let sanitized = dima_text::sanitize_lone_surrogates(answer.text.as_bytes());
            match serde_json::from_slice(&sanitized) {
                Ok(data) => data,
                Err(error) => {
                    self.refresh_log(
                        Level::Error,
                        Destination::Both,
                        user_id,
                        context,
                        json!({
                            "function": "refreshTwitchToken",
                            "userId": user_id,
                            "action": "token_refresh_failed",
                            "reason": "unparseable_refresh_response",
                            "parseError": format!("{:?} at line {} column {}", error.classify(), error.line(), error.column()),
                            "status": status,
                            "bodyLength": dima_text::utf16_len(&answer.text),
                        }),
                    );
                    return Exchange::Failed(failure(
                        RefreshFailureKind::Transient,
                        Some(status),
                        RefreshFailureReason::Unparseable,
                    ));
                }
            }
        };

        if !answer.ok() || truthy(data.get("error")) {
            // Twitch's text is classified and dropped here: it can echo the refresh token.
            let (kind, reason) = classify_refusal(status, &data);
            self.refresh_log(
                if kind == RefreshFailureKind::Permanent {
                    Level::Error
                } else {
                    Level::Warn
                },
                Destination::Both,
                user_id,
                context,
                json!({
                    "function": "refreshTwitchToken",
                    "userId": user_id,
                    "action": "token_refresh_rejected",
                    "status": status,
                    "failureKind": kind.as_str(),
                    "reason": reason.as_str(),
                }),
            );
            return Exchange::Refused {
                kind,
                reason,
                status,
            };
        }

        let text_of = |name: &str| {
            data.get(name)
                .and_then(Value::as_str)
                .filter(|text| !text.is_empty())
        };
        let access = text_of("access_token");
        let refresh = text_of("refresh_token");
        let expires_in = data
            .get("expires_in")
            .and_then(Value::as_f64)
            .unwrap_or(7200.0);
        let (Some(access), Some(refresh)) = (access, refresh) else {
            self.refresh_log(
                Level::Error,
                Destination::Both,
                user_id,
                context,
                json!({
                    "function": "refreshTwitchToken",
                    "userId": user_id,
                    "action": "token_refresh_failed",
                    "reason": "incomplete_payload",
                    "status": status,
                    "hasAccessToken": access.is_some(),
                    "hasRefreshToken": refresh.is_some(),
                }),
            );
            return Exchange::Failed(failure(
                RefreshFailureKind::Transient,
                Some(status),
                RefreshFailureReason::IncompletePayload,
            ));
        };
        let access = AccessToken::new(access);
        let refresh = RefreshToken::new(refresh);

        #[cfg(any(test, feature = "test-util"))]
        self.fault(crate::base::FaultPoint::AfterTwitchAnswer, user_id)
            .await;

        Exchange::Rotated {
            access,
            refresh,
            expires_in,
        }
    }

    /// `refreshTwitchToken` for a refresh token the caller holds (no lock).
    pub(crate) async fn refresh_twitch_token(
        &self,
        refresh_token: &RefreshToken,
        user_id: &str,
        context: &RefreshContext,
    ) -> RefreshOutcome {
        let result = self
            .exchange_and_store(refresh_token, user_id, context, None, None)
            .await;
        self.outcome_or_exception(result, user_id, context)
    }

    fn outcome_or_exception(
        &self,
        result: Result<RefreshOutcome, TwitchError>,
        user_id: &str,
        context: &RefreshContext,
    ) -> RefreshOutcome {
        match result {
            Ok(outcome) => outcome,
            Err(error) => {
                self.refresh_log(
                    Level::Error,
                    Destination::Both,
                    user_id,
                    context,
                    json!({
                        "function": "refreshTwitchToken",
                        "userId": user_id,
                        "action": "token_refresh_exception",
                        "reason": error.to_string(),
                    }),
                );
                failure(
                    RefreshFailureKind::Transient,
                    None,
                    RefreshFailureReason::Store,
                )
            }
        }
    }

    /// Exchanges `refresh_token` and stores the outcome. `base` is the stored state the token
    /// was read from (the rotation is written over it with a compare-and-set); `rescue` is a
    /// different refresh token to try before a permanent refusal wipes the streamer.
    async fn exchange_and_store(
        &self,
        refresh_token: &RefreshToken,
        user_id: &str,
        context: &RefreshContext,
        base: Option<StoredAccount>,
        rescue: Option<RefreshToken>,
    ) -> Result<RefreshOutcome, TwitchError> {
        match self.exchange(refresh_token, user_id, context).await {
            Exchange::Rotated {
                access,
                refresh,
                expires_in,
            } => {
                self.store_rotation(
                    user_id,
                    refresh_token,
                    base,
                    access,
                    refresh,
                    expires_in,
                    context,
                )
                .await
            }
            Exchange::Refused {
                kind: RefreshFailureKind::Permanent,
                reason,
                status,
            } => {
                self.refused_for_good(refresh_token, user_id, status, reason, context, rescue)
                    .await
            }
            Exchange::Refused {
                kind,
                reason,
                status,
            } => Ok(failure(kind, Some(status), reason)),
            Exchange::Failed(outcome) => Ok(outcome),
        }
    }

    /// Writes a rotation Twitch answered (MongoDB, then the cache).
    #[allow(clippy::too_many_arguments)]
    async fn store_rotation(
        &self,
        user_id: &str,
        used: &RefreshToken,
        base: Option<StoredAccount>,
        access: AccessToken,
        refresh: RefreshToken,
        expires_in: f64,
        context: &RefreshContext,
    ) -> Result<RefreshOutcome, TwitchError> {
        let random: &dyn dima_core::SecureRandom = &*self.random;
        let access_envelope = self.cipher.encrypt(access.expose(), random)?;
        let refresh_envelope = self.cipher.encrypt(refresh.expose(), random)?;
        let expires_at = self.now_secs() as f64 + expires_in;

        match self
            .persist_rotation(
                user_id,
                used,
                base,
                &access_envelope,
                &refresh_envelope,
                expires_at,
            )
            .await?
        {
            Persisted::UserNotFound => {
                self.refresh_log(
                    Level::Error,
                    Destination::Both,
                    user_id,
                    context,
                    json!({
                        "function": "refreshTwitchToken",
                        "userId": user_id,
                        "action": "token_refresh_store_failed",
                        "reason": "user_not_found",
                        "consequence": "Twitch rotated the refresh token but it could not be stored; the rotated token is LOST and the next refresh will fail with invalid grant",
                    }),
                );
                Ok(failure(
                    RefreshFailureKind::Transient,
                    None,
                    RefreshFailureReason::UserNotFound,
                ))
            }
            Persisted::Superseded(stored) => {
                let cached = self.sync_cache_from(user_id, &stored).await?;
                let now = self.now_secs();
                let skew = self.config.timings.waiter_expiry_skew_secs;
                self.refresh_log(
                    Level::Info,
                    Destination::Both,
                    user_id,
                    context,
                    json!({
                        "function": "refreshTwitchToken",
                        "userId": user_id,
                        "action": "token_refresh_superseded",
                        "reason": "a newer refresh token was stored meanwhile; this refresh was not written",
                    }),
                );
                if is_access_token_usable(cached.access(), cached.expires_at.as_deref(), now, skew)
                    && let (Some(access_token), Some(refresh_token)) =
                        (cached.access_token, cached.refresh_token)
                {
                    let expiry = cached.expires_at.as_deref().map_or(f64::NAN, |raw| {
                        dima_text::parse_int(raw, dima_text::Radix::Decimal)
                    });
                    return Ok(RefreshOutcome::Success {
                        access_token,
                        refresh_token,
                        expires_in: expiry - now as f64,
                    });
                }
                Ok(RefreshOutcome::Success {
                    access_token: access,
                    refresh_token: refresh,
                    expires_in,
                })
            }
            Persisted::Written(generation) => {
                self.publish(
                    user_id,
                    generation,
                    &rotation_fields(&access_envelope, &refresh_envelope, expires_at),
                )
                .await?;
                self.refresh_log(
                    Level::Info,
                    Destination::Cache,
                    user_id,
                    context,
                    json!({
                        "function": "refreshTwitchToken",
                        "userId": user_id,
                        "action": "token_refresh_succeeded",
                        "expiresIn": expires_in,
                        "expiresAt": expires_at,
                    }),
                );
                Ok(RefreshOutcome::Success {
                    access_token: access,
                    refresh_token: refresh,
                    expires_in,
                })
            }
        }
    }

    /// Writes a rotation over the stored state while its refresh token is still `used`, empty
    /// or unreadable (an envelope that cannot be decrypted holds no usable token).
    async fn persist_rotation(
        &self,
        id: &str,
        used: &RefreshToken,
        base: Option<StoredAccount>,
        access: &StoredCredential,
        refresh: &StoredCredential,
        expires_at: f64,
    ) -> Result<Persisted, TwitchError> {
        let mut next = base;
        for _round in 0..CAS_ROUNDS {
            let stored = match next.take() {
                Some(stored) => stored,
                None => match self.load_stored(id).await? {
                    Some(stored) => stored,
                    None => return Ok(Persisted::UserNotFound),
                },
            };
            if let Ok(Some(current)) = stored_refresh(&self.cipher, &stored.refresh)
                && current != *used
            {
                return Ok(Persisted::Superseded(Box::new(stored)));
            }
            if let Written::Done(generation) = self
                .write_rotation(id, &stored, access, refresh, expires_at)
                .await?
            {
                return Ok(Persisted::Written(generation));
            }
        }
        Err(TwitchError::Write(
            "the stored refresh token kept changing".to_owned(),
        ))
    }

    /// A permanent refusal of `failed`: compared with the stored refresh token, then a
    /// concurrent rotation is reused, the `rescue` token tried, or the stored tokens wiped.
    async fn refused_for_good(
        &self,
        failed: &RefreshToken,
        user_id: &str,
        status: u16,
        reason: RefreshFailureReason,
        context: &RefreshContext,
        rescue: Option<RefreshToken>,
    ) -> Result<RefreshOutcome, TwitchError> {
        let mut rescue = rescue;
        for _round in 0..CAS_ROUNDS {
            let stored = self.load_stored(user_id).await?;
            let current = match &stored {
                Some(stored) => stored_refresh(&self.cipher, &stored.refresh)?,
                None => None,
            };
            if let (Some(stored), Some(current)) = (&stored, current)
                && current != *failed
            {
                return self
                    .rotated_elsewhere(user_id, stored, &current, status, context)
                    .await;
            }
            // The stored token is the refused one. A different token in the cache is tried once
            // before the streamer is wiped: the cache may be ahead of MongoDB.
            if let (Some(base), Some(candidate)) = (&stored, rescue.take()) {
                self.refresh_log(
                    Level::Warn,
                    Destination::Both,
                    user_id,
                    context,
                    json!({
                        "function": "refreshTwitchToken",
                        "userId": user_id,
                        "action": "token_refresh_rescue_attempt",
                        "reason": "the stored refresh token was refused; the cache holds a different one",
                    }),
                );
                match self.exchange(&candidate, user_id, context).await {
                    Exchange::Rotated {
                        access,
                        refresh,
                        expires_in,
                    } => {
                        return self
                            .store_rotation(
                                user_id,
                                failed,
                                Some(base.clone()),
                                access,
                                refresh,
                                expires_in,
                                context,
                            )
                            .await;
                    }
                    Exchange::Refused {
                        kind: RefreshFailureKind::Permanent,
                        ..
                    } => {}
                    Exchange::Refused {
                        kind,
                        reason,
                        status,
                    } => return Ok(failure(kind, Some(status), reason)),
                    Exchange::Failed(outcome) => return Ok(outcome),
                }
            }
            let generation = match &stored {
                Some(stored) => match self.write_wipe(user_id, stored).await? {
                    Written::Done(generation) => generation,
                    Written::Changed => continue,
                },
                // The reference's update matches nothing; its cache write still happens (with
                // no generation to carry, it does not replace a fenced entry).
                None => 0,
            };
            self.publish(user_id, generation, &wipe_fields()).await?;
            self.log(
                Level::Error,
                Destination::Both,
                Some(user_id),
                json!({
                    "function": "invalidateStoredTwitchTokens",
                    "userId": user_id,
                    "action": "tokens_invalidated",
                    "status": status,
                    "reason": reason.as_str(),
                    "endpoint": context.endpoint_json(),
                    "caller": context.caller_json(),
                    "consequence": "tokens wiped and has_permissions=false; user must reauthorize at domdimabot.com",
                }),
            );
            return Ok(failure(RefreshFailureKind::Permanent, Some(status), reason));
        }
        Err(TwitchError::Write(
            "the stored refresh token kept changing".to_owned(),
        ))
    }

    /// The stored refresh token differs from the refused one: another refresh rotated it.
    async fn rotated_elsewhere(
        &self,
        user_id: &str,
        stored: &StoredAccount,
        current: &RefreshToken,
        status: u16,
        context: &RefreshContext,
    ) -> Result<RefreshOutcome, TwitchError> {
        let mut cached = self.cached_credentials(user_id).await?;
        if cached.refresh_token.as_ref() != Some(current) {
            cached = self.sync_cache_from(user_id, stored).await?;
        }
        let now = self.now_secs();
        let skew = self.config.timings.waiter_expiry_skew_secs;
        if is_access_token_usable(cached.access(), cached.expires_at.as_deref(), now, skew)
            && let Some(access_token) = cached.access_token
        {
            let expiry = cached.expires_at.as_deref().map_or(f64::NAN, |raw| {
                dima_text::parse_int(raw, dima_text::Radix::Decimal)
            });
            self.refresh_log(
                Level::Info,
                Destination::Both,
                user_id,
                context,
                json!({
                    "function": "refreshTwitchToken",
                    "userId": user_id,
                    "action": "token_refresh_rotation_detected",
                    "reason": "refresh token already rotated by a concurrent refresh; returning stored access token",
                    "storedSecondsUntilExpiry": expiry - now as f64,
                }),
            );
            return Ok(RefreshOutcome::Success {
                access_token,
                refresh_token: current.clone(),
                expires_in: expiry - now as f64,
            });
        }
        self.refresh_log(
            Level::Warn,
            Destination::Both,
            user_id,
            context,
            json!({
                "function": "refreshTwitchToken",
                "userId": user_id,
                "action": "token_refresh_rotation_detected",
                "reason": "refresh token already rotated but stored access token is not usable; skipping invalidation",
            }),
        );
        Ok(failure(
            RefreshFailureKind::Transient,
            Some(status),
            RefreshFailureReason::RotatedElsewhere,
        ))
    }

    /// `getAccountRefreshTokenById` with errors returned.
    pub(crate) async fn stored_refresh_token(
        self: &Arc<Self>,
        id: &str,
    ) -> Result<Option<RefreshToken>, TwitchError> {
        let cached = self
            .hget_text(&self.config.keys.account(id), "refresh_token")
            .await?;
        if let Some(token) = cached.and_then(|text| open_cached(&self.cipher, &text)) {
            return Ok(Some(RefreshToken::from_secret(token)));
        }
        Ok(self
            .hydrate(id)
            .await?
            .and_then(|account| account.refresh_token()))
    }

    async fn acquire_lock(&self, key: &str) -> Result<Option<String>, TwitchError> {
        let random: &dyn dima_core::Random = &*self.random;
        let owner = random
            .uuid_v4()
            .map_err(|error| TwitchError::cache("lock", error))?;
        let ttl = u64::try_from(self.config.timings.refresh_lock_ttl.as_millis()).unwrap_or(5000);
        let outcome = self
            .dragonfly
            .set(
                key,
                owner.as_bytes(),
                SetOptions {
                    condition: SetCondition::IfMissing,
                    expiry: SetExpiry::Millis(ttl.max(1)),
                    get: false,
                },
            )
            .await
            .map_err(|error| TwitchError::cache("lock", error))?;
        Ok((outcome == SetOutcome::Written).then_some(owner))
    }

    async fn release_lock(&self, key: &str, owner: &str) {
        // The lease expires on its own; a failed release only delays the next refresh.
        let _ = RELEASE_LOCK
            .run_value(&self.dragonfly, &[key], &[owner])
            .await;
    }

    /// `waitForRefreshedToken`.
    async fn wait_for_refreshed(
        &self,
        id: &str,
        lock_key: &str,
        rejected: Option<&AccessToken>,
    ) -> Result<Option<AccessToken>, TwitchError> {
        let timings = &self.config.timings;
        let deadline = Instant::now() + timings.refresh_wait;
        while Instant::now() < deadline {
            tokio::time::sleep(timings.refresh_wait_poll).await;
            let cached = self.cached_credentials(id).await?;
            let token = cached.access();
            let not_rejected = rejected.is_none_or(|rejected| token != Some(rejected.expose()));
            if not_rejected
                && is_access_token_usable(
                    token,
                    cached.expires_at.as_deref(),
                    self.now_secs(),
                    timings.waiter_expiry_skew_secs,
                )
            {
                return Ok(cached.access_token);
            }
            let held = self
                .dragonfly
                .exists(&[lock_key])
                .await
                .map_err(|error| TwitchError::cache("exists", error))?;
            if held != 1 {
                break;
            }
        }
        Ok(None)
    }

    pub(crate) fn token_log(&self, level: Level, id: &str, caller: &str, mut data: Value) {
        if let Value::Object(map) = &mut data {
            map.insert(
                "function".to_owned(),
                Value::from("TwitchStreamers.getAccountTokenById"),
            );
            map.insert("id".to_owned(), Value::from(id));
            map.insert("account_type".to_owned(), Value::from("twitch"));
            map.insert("caller".to_owned(), Value::from(caller));
        }
        self.log(level, Destination::Cache, Some(id), data);
    }

    /// The lock, the double check and the refresh of `getAccountTokenById`.
    pub(crate) async fn locked_refresh(
        self: &Arc<Self>,
        id: &str,
        rejected: Option<&AccessToken>,
        caller: &str,
    ) -> Result<AccessToken, TokenError> {
        let lock_key = self.config.keys.refresh_lock(id);
        let mut owner = self.acquire_lock(&lock_key).await?;
        if owner.is_none() {
            if let Some(winner) = self.wait_for_refreshed(id, &lock_key, rejected).await? {
                self.token_log(
                    Level::Debug,
                    id,
                    caller,
                    json!({ "action": "returned_token_from_concurrent_refresh" }),
                );
                return Ok(winner);
            }
            owner = self.acquire_lock(&lock_key).await?;
            if owner.is_none() {
                self.token_log(
                    Level::Warn,
                    id,
                    caller,
                    json!({ "action": "refresh_lock_unavailable" }),
                );
                return Err(TokenError::LockUnavailable);
            }
            self.token_log(
                Level::Info,
                id,
                caller,
                json!({ "action": "refresh_lock_takeover" }),
            );
        }
        let result = self.refresh_under_lock(id, rejected, caller).await;
        if let Some(owner) = owner {
            self.release_lock(&lock_key, &owner).await;
        }
        result
    }

    /// Under the lock: the cache's double check, then MongoDB decides (see the module docs).
    async fn refresh_under_lock(
        self: &Arc<Self>,
        id: &str,
        rejected: Option<&AccessToken>,
        caller: &str,
    ) -> Result<AccessToken, TokenError> {
        let is_rejected = |token: &AccessToken| rejected.is_some_and(|rejected| rejected == token);
        let cached = self.cached_credentials(id).await?;
        if is_access_token_usable(
            cached.access(),
            cached.expires_at.as_deref(),
            self.now_secs(),
            self.config.timings.token_expiry_skew_secs,
        ) && let Some(token) = cached.access_token.clone()
            && !is_rejected(&token)
        {
            self.token_log(
                Level::Debug,
                id,
                caller,
                json!({ "action": "returned_token_refreshed_before_lock" }),
            );
            return Ok(token);
        }

        let not_found = || {
            self.token_log(
                Level::Error,
                id,
                caller,
                json!({ "action": "refresh_failed", "reason": "refresh_token_not_found" }),
            );
            Err(TokenError::NoRefreshToken)
        };
        let Some(stored) = self.load_stored(id).await? else {
            return not_found();
        };
        if let Some(token) = stored_access(&self.cipher, &stored.access)
            && !is_rejected(&token)
            && is_access_token_usable(
                Some(token.expose()),
                stored.expires_at.as_deref(),
                self.now_secs(),
                self.config.timings.token_expiry_skew_secs,
            )
        {
            // MongoDB is ahead of the cache: repair the cache, no exchange.
            self.publish_stored(id, &stored).await?;
            self.token_log(
                Level::Info,
                id,
                caller,
                json!({ "action": "returned_token_from_store" }),
            );
            return Ok(token);
        }
        let candidate = cached.refresh_token;
        let (token, rescue) = match stored_refresh(&self.cipher, &stored.refresh) {
            Ok(Some(token)) => {
                let rescue = candidate.filter(|other| *other != token);
                (token, rescue)
            }
            // An envelope that cannot be decrypted holds no usable token: the cache's copy is
            // the only candidate (its rotation replaces the unreadable envelope).
            Err(_) if candidate.is_some() => match candidate {
                Some(token) => (token, None),
                None => return not_found(),
            },
            Ok(None) | Err(_) => {
                // MongoDB has none (wiped, or never stored): the cache learns it.
                self.publish_stored(id, &stored).await?;
                return not_found();
            }
        };
        let context = RefreshContext::new("token_refresh", caller);
        let result = self
            .exchange_and_store(&token, id, &context, Some(stored), rescue)
            .await;
        match self.outcome_or_exception(result, id, &context) {
            RefreshOutcome::Success {
                access_token,
                expires_in,
                ..
            } => {
                self.token_log(
                    Level::Info,
                    id,
                    caller,
                    json!({ "action": "token_refreshed_successfully", "expiresIn": expires_in }),
                );
                if is_rejected(&access_token) {
                    return Err(TokenError::SameAsRejected);
                }
                Ok(access_token)
            }
            RefreshOutcome::Failure {
                kind,
                status,
                reason,
            } => {
                self.token_log(
                    Level::Error,
                    id,
                    caller,
                    json!({
                        "action": "refresh_failed",
                        "reason": kind.as_str(),
                        "status": status,
                        "message": reason.message(),
                    }),
                );
                Err(TokenError::Refresh {
                    kind,
                    status,
                    reason,
                })
            }
        }
    }
}
