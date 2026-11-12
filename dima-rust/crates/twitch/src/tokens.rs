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
//! refused (`rejected`). Otherwise one refresh runs:
//!
//! 1. **In this process**, one refresh per streamer and rejected token: concurrent callers join
//!    it ([`crate::flight`]). It runs as a task, so a caller that gives up does not cancel it.
//! 2. **Across processes**, the reference's lock: `SET locks:refresh:twitch:{id} <uuid> NX PX
//!    5000`. A process that does not get it polls the hash every 150 ms for up to 4.5 s for a
//!    token other than the rejected one with more than 60 s left, stops waiting when the lock is
//!    gone, then tries the lock once more; failing that it gives up for this call. The holder
//!    looks at the cache again before it refreshes (another holder may just have finished).
//! 3. The refresh itself (`refreshTwitchToken`): three attempts, 400 ms and 900 ms apart,
//!    retried only on a network error or a 5xx.
//! 4. The new tokens are written to MongoDB, then to the hash.
//!
//! # What a refused refresh does
//!
//! Twitch's answer is classified as the reference does ([`crate::oauth`]): a 400 or 401 whose
//! message says the refresh token is invalid or revoked is **permanent**; anything else is
//! transient and changes nothing. On a permanent failure the stored refresh token is compared
//! with the one that failed: if it is different, another refresh already rotated it, and its
//! access token is used when it has more than 60 s left (otherwise the call fails without
//! touching anything); if it is the same, the stored tokens are wiped (`{iv: null, content:
//! null}` envelopes, `access_token_expires_at: null`, `has_permissions` and
//! `up_to_date_permissions` false; the hash's credential fields emptied) and the streamer must
//! log in again at domdimabot.com.
//!
//! # Intended differences (safety; `MIGRATION.md` section 3)
//!
//! - **MongoDB decides.** The reference compares the failed refresh token with the *cache*
//!   (which it reads first, then MongoDB when the cache has none). Here the comparison reads
//!   MongoDB, so a stale cache, or a TypeScript process still refreshing in database 0 during
//!   the cutover, can never get a valid token wiped. When MongoDB holds a newer token than the
//!   cache, the cache's credential fields are brought up to date from it.
//! - **Writes are compare-and-set on the stored envelope.** The reference's
//!   `findOneAndUpdate({'accounts.id': id}, …)` is unconditional. Here the update matches the
//!   Twitch account whose `refresh_token` envelope is exactly the one read just before: a
//!   successful refresh is written only if the stored refresh token is still the one it used (or
//!   was wiped meanwhile), and a wipe happens only if it is still the one that failed. A refresh
//!   that finds a newer token stored (a sign-in, or a refresh that overlapped after the 5 s lease
//!   expired) does not write and returns the stored token when it is still good. Neither write
//!   can put an older token over a newer one, and the documents written are the reference's
//!   (same `$set`, plus Mongoose's `updated_at`).
//! - **The lock is released atomically** (a compare-and-delete script instead of `GET` then
//!   `DEL`, which could delete another process's lock).
//! - **A failed store read never wipes.** The reference treats an unreadable cache as "no stored
//!   token" and wipes; here the call fails as transient.
//! - **The refresh outlives its caller** (see 1. above).
//! - **No body preview in logs**: the reference logs the first 500 characters of an answer it
//!   cannot parse, which for a truncated 200 answer is part of the new access token.
//! - Not written: the `app:twitch:bot` copy of the bot token and the OAuth debug cache (both
//!   write-only in the reference; see [`crate::keys`]).
//!
//! Every log entry is the reference's, with `caller` given by the Rust caller (the reference
//! derives it from a stack trace).

use crate::base::{Inner, Twitch};
use crate::error::TwitchError;
use crate::events::{Destination, Level};
use crate::oauth::{RefreshContext, RefreshFailureKind, RefreshFailureReason, classify_refusal};
use crate::secret::{AccessToken, RefreshToken, cache_text, cache_text_of, open_cached, seal};
use crate::streamers::{decrypt_envelope, persisted_expires_at};
use bson::oid::ObjectId;
use bson::{Bson, Document, RawDocumentBuf, doc};
use dima_core::SecretString;
use dima_core::crypto::StoredCredential;
use dima_model::users::{AccountType, EncryptedToken, User};
use dima_store::dragonfly::commands::reply;
use dima_store::dragonfly::script::Script;
use dima_store::dragonfly::{SetCondition, SetExpiry, SetOptions, SetOutcome};
use dima_store::mongo::WriteContext;
use dima_store::mongo::number::js_number;
use dima_store::mongo::update::UpdateOptions;
use serde_json::{Value, json};
use std::sync::Arc;
use tokio::time::Instant;

/// Deletes the lock only if this process still owns it (Rust only; no loop).
static RELEASE_LOCK: Script = Script::new(
    "RELEASE_REFRESH_LOCK_SCRIPT",
    "\nif redis.call('GET', KEYS[1]) == ARGV[1] then\n    return redis.call('DEL', KEYS[1])\nend\nreturn 0\n",
);

/// How many times a compare-and-set write reads and tries again when the stored envelope
/// changed between its read and its write.
const CAS_ROUNDS: usize = 3;

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

/// JavaScript truthiness of a JSON value (`Boolean(x)`).
fn truthy(value: Option<&Value>) -> bool {
    match value {
        None | Some(Value::Null) => false,
        Some(Value::Bool(flag)) => *flag,
        Some(Value::Number(number)) => number.as_f64().is_some_and(|n| n != 0.0 && !n.is_nan()),
        Some(Value::String(text)) => !text.is_empty(),
        Some(Value::Array(_) | Value::Object(_)) => true,
    }
}

/// The stored state of one Twitch account, read for a compare-and-set.
#[derive(Clone)]
pub(crate) struct StoredAccount {
    user: ObjectId,
    refresh: EncryptedToken,
    access: EncryptedToken,
    expires_at: Option<String>,
}

/// The cache's credential fields of one streamer, decrypted.
#[derive(Default)]
struct CachedCredentials {
    access_token: Option<AccessToken>,
    expires_at: Option<String>,
    refresh_token: Option<RefreshToken>,
}

impl CachedCredentials {
    fn access(&self) -> Option<&str> {
        self.access_token.as_ref().map(AccessToken::expose)
    }
}

/// What a compare-and-set write found.
enum Persisted {
    /// Written.
    Written,
    /// A different refresh token is stored: nothing written.
    Superseded(StoredAccount),
    /// No such user.
    UserNotFound,
}

fn envelope_bson(envelope: &StoredCredential) -> Bson {
    Bson::Document(doc! { "iv": envelope.iv.as_str(), "content": envelope.content.as_str() })
}

fn null_envelope() -> Bson {
    Bson::Document(doc! { "iv": Bson::Null, "content": Bson::Null })
}

impl StoredAccount {
    /// The filter that matches this account only while its refresh envelope is unchanged.
    fn compare_filter(&self, user_id: &str) -> Document {
        let part = |value: &Option<String>| value.clone().map_or(Bson::Null, Bson::String);
        doc! {
            "_id": self.user,
            "accounts": {
                "$elemMatch": {
                    "type": "twitch",
                    "id": user_id,
                    "refresh_token.iv": part(&self.refresh.iv),
                    "refresh_token.content": part(&self.refresh.content),
                }
            }
        }
    }
}

impl Inner {
    /// `HMGET accounts:twitch:{id}:data access_token expires_at refresh_token`.
    async fn cached_credentials(&self, id: &str) -> Result<CachedCredentials, TwitchError> {
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

    /// `HSET` of the hash's credential fields.
    async fn set_cached_credentials(
        &self,
        id: &str,
        fields: &[(&str, &str)],
    ) -> Result<(), TwitchError> {
        let fields: Vec<(&str, &[u8])> = fields
            .iter()
            .map(|(name, value)| (*name, value.as_bytes()))
            .collect();
        self.dragonfly
            .hset(&self.config.keys.account(id), &fields)
            .await
            .map(|_| ())
            .map_err(|error| TwitchError::cache("hset", error))
    }

    /// The stored Twitch account `id` (the user's `_id`, both envelopes, the expiry).
    async fn load_stored(&self, id: &str) -> Result<Option<StoredAccount>, TwitchError> {
        let raw: Option<RawDocumentBuf> = self
            .mongo_op(
                "find user",
                self.mongo
                    .collection::<RawDocumentBuf>(dima_model::users::COLLECTION)
                    .find_one(dima_model::users::by_account(AccountType::Twitch, id))
                    .projection(doc! { "accounts": 1 }),
            )
            .await?;
        let Some(raw) = raw else {
            return Ok(None);
        };
        let user: User =
            dima_model::decode(&raw).map_err(|error| TwitchError::Decode(error.to_string()))?;
        Ok(user
            .accounts
            .iter()
            .find(|account| {
                account.kind.is(AccountType::Twitch) && account.id.as_deref() == Some(id)
            })
            .map(|account| StoredAccount {
                user: user.id,
                refresh: account.refresh_token.expose().clone(),
                access: account.access_token.expose().clone(),
                expires_at: persisted_expires_at(account),
            }))
    }

    /// One compare-and-set `updateOne` on the account: `true` when it matched.
    async fn compare_and_set(
        &self,
        id: &str,
        stored: &StoredAccount,
        set: Document,
    ) -> Result<bool, TwitchError> {
        let mut ctx = WriteContext::new(self.now_ms());
        let prepared = dima_model::users::INFO
            .prepare_update(
                &stored.compare_filter(id),
                doc! { "$set": set },
                UpdateOptions::default(),
                &mut ctx,
            )
            .map_err(|error| TwitchError::Write(error.to_string()))?;
        let mut writes = self.mongo.writes(dima_model::users::COLLECTION);
        let outcome = self
            .mongo_op("update user", writes.update_one(&prepared))
            .await?;
        Ok(outcome.matched == 1)
    }

    /// Writes rotated tokens if the stored refresh token is still `used` (or empty).
    async fn persist_rotation(
        &self,
        id: &str,
        used: &RefreshToken,
        access: &StoredCredential,
        refresh: &StoredCredential,
        expires_at: f64,
    ) -> Result<Persisted, TwitchError> {
        for _round in 0..CAS_ROUNDS {
            let Some(stored) = self.load_stored(id).await? else {
                return Ok(Persisted::UserNotFound);
            };
            // An envelope that cannot be decrypted holds no usable token: it is replaced, as
            // the reference's unconditional write would (still only while it is unchanged).
            match decrypt_envelope(&self.cipher, &stored.refresh) {
                Ok(Some(current))
                    if !current.is_empty() && RefreshToken::new(current.as_str()) != *used =>
                {
                    return Ok(Persisted::Superseded(stored));
                }
                _ => {}
            }
            let set = doc! {
                "accounts.$.refresh_token": envelope_bson(refresh),
                "accounts.$.access_token": envelope_bson(access),
                "accounts.$.access_token_expires_at": js_number(expires_at),
                "accounts.$.has_permissions": true,
                "accounts.$.up_to_date_permissions": true,
            };
            if self.compare_and_set(id, &stored, set).await? {
                return Ok(Persisted::Written);
            }
        }
        Err(TwitchError::Write(
            "the stored refresh token kept changing".to_owned(),
        ))
    }

    /// The expired cache entry is replaced by MongoDB's credentials (Rust only: the reference's
    /// cache cannot fall behind MongoDB, Rust's can across the cutover).
    async fn sync_cache_from(
        &self,
        id: &str,
        stored: &StoredAccount,
    ) -> Result<CachedCredentials, TwitchError> {
        let open = |envelope: &EncryptedToken| {
            decrypt_envelope(&self.cipher, envelope).map(|token| {
                token
                    .filter(|token| !token.is_empty())
                    .map(SecretString::new)
            })
        };
        let access = open(&stored.access)?;
        let refresh = open(&stored.refresh)?;
        let expires_at = stored.expires_at.clone().unwrap_or_default();
        self.set_cached_credentials(
            id,
            &[
                ("access_token", &cache_text_of(&stored.access)),
                ("refresh_token", &cache_text_of(&stored.refresh)),
                ("expires_at", &expires_at),
            ],
        )
        .await?;
        Ok(CachedCredentials {
            access_token: access.map(AccessToken::from_secret),
            expires_at: Some(expires_at),
            refresh_token: refresh.map(RefreshToken::from_secret),
        })
    }

    fn refresh_log(
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

    /// `refreshTwitchToken` (no lock: the caller holds it, or does not need it).
    pub(crate) async fn refresh_twitch_token(
        &self,
        refresh_token: &RefreshToken,
        user_id: &str,
        context: &RefreshContext,
    ) -> RefreshOutcome {
        match self.refresh_inner(refresh_token, user_id, context).await {
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
                RefreshOutcome::failure(
                    RefreshFailureKind::Transient,
                    None,
                    RefreshFailureReason::Store,
                )
            }
        }
    }

    async fn refresh_inner(
        &self,
        refresh_token: &RefreshToken,
        user_id: &str,
        context: &RefreshContext,
    ) -> Result<RefreshOutcome, TwitchError> {
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
            return Ok(RefreshOutcome::failure(
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
                    return Ok(RefreshOutcome::failure(
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
            if kind == RefreshFailureKind::Permanent {
                return self
                    .refused_for_good(refresh_token, user_id, status, reason, context)
                    .await;
            }
            return Ok(RefreshOutcome::failure(kind, Some(status), reason));
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
            return Ok(RefreshOutcome::failure(
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

        let random: &dyn dima_core::SecureRandom = &*self.random;
        let access_envelope = self.cipher.encrypt(access.expose(), random)?;
        let refresh_envelope = self.cipher.encrypt(refresh.expose(), random)?;
        let expires_at = self.now_secs() as f64 + expires_in;

        match self
            .persist_rotation(
                user_id,
                refresh_token,
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
                Ok(RefreshOutcome::failure(
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
                        "reason": "a newer refresh token is stored; this refresh was not written",
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
            Persisted::Written => {
                let expires_text = dima_text::number_to_string(expires_at);
                self.set_cached_credentials(
                    user_id,
                    &[
                        ("access_token", &cache_text(&access_envelope)),
                        ("refresh_token", &cache_text(&refresh_envelope)),
                        ("expires_at", &expires_text),
                        ("has_permissions", "true"),
                        ("up_to_date_permissions", "true"),
                    ],
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

    /// A permanent refusal: compare with the stored refresh token, then reuse a concurrent
    /// rotation or wipe the stored tokens.
    async fn refused_for_good(
        &self,
        failed: &RefreshToken,
        user_id: &str,
        status: u16,
        reason: RefreshFailureReason,
        context: &RefreshContext,
    ) -> Result<RefreshOutcome, TwitchError> {
        for _round in 0..CAS_ROUNDS {
            let stored = self.load_stored(user_id).await?;
            let current = match &stored {
                Some(stored) => decrypt_envelope(&self.cipher, &stored.refresh)?,
                None => None,
            };
            if let (Some(stored), Some(current)) = (&stored, current.filter(|t| !t.is_empty()))
                && RefreshToken::new(current.as_str()) != *failed
            {
                return self
                    .rotated_elsewhere(user_id, stored, &current, status, context)
                    .await;
            }
            let wiped = match &stored {
                Some(stored) => {
                    let set = doc! {
                        "accounts.$.refresh_token": null_envelope(),
                        "accounts.$.access_token": null_envelope(),
                        "accounts.$.access_token_expires_at": Bson::Null,
                        "accounts.$.has_permissions": false,
                        "accounts.$.up_to_date_permissions": false,
                    };
                    self.compare_and_set(user_id, stored, set).await?
                }
                // The reference's update matches nothing; its cache write still happens.
                None => true,
            };
            if !wiped {
                continue;
            }
            self.set_cached_credentials(
                user_id,
                &[
                    ("access_token", ""),
                    ("refresh_token", ""),
                    ("expires_at", ""),
                    ("has_permissions", "false"),
                    ("up_to_date_permissions", "false"),
                ],
            )
            .await?;
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
            return Ok(RefreshOutcome::failure(
                RefreshFailureKind::Permanent,
                Some(status),
                reason,
            ));
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
        current: &str,
        status: u16,
        context: &RefreshContext,
    ) -> Result<RefreshOutcome, TwitchError> {
        let mut cached = self.cached_credentials(user_id).await?;
        if cached.refresh_token.as_ref().map(RefreshToken::expose) != Some(current) {
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
                refresh_token: RefreshToken::new(current),
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
        Ok(RefreshOutcome::failure(
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

    fn token_log(&self, level: Level, id: &str, caller: &str, mut data: Value) {
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
    async fn locked_refresh(
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

    async fn refresh_under_lock(
        self: &Arc<Self>,
        id: &str,
        rejected: Option<&AccessToken>,
        caller: &str,
    ) -> Result<AccessToken, TokenError> {
        let cached = self.cached_credentials(id).await?;
        let token = cached.access();
        let not_rejected = rejected.is_none_or(|rejected| token != Some(rejected.expose()));
        if not_rejected
            && is_access_token_usable(
                token,
                cached.expires_at.as_deref(),
                self.now_secs(),
                self.config.timings.token_expiry_skew_secs,
            )
            && let Some(token) = cached.access_token
        {
            self.token_log(
                Level::Debug,
                id,
                caller,
                json!({ "action": "returned_token_refreshed_before_lock" }),
            );
            return Ok(token);
        }
        let refreshed = self.perform_refresh(id, caller).await?;
        if rejected.is_some_and(|rejected| *rejected == refreshed) {
            return Err(TokenError::SameAsRejected);
        }
        Ok(refreshed)
    }

    /// `performTwitchTokenRefresh`.
    async fn perform_refresh(
        self: &Arc<Self>,
        id: &str,
        caller: &str,
    ) -> Result<AccessToken, TokenError> {
        let Some(refresh_token) = self.stored_refresh_token(id).await? else {
            self.token_log(
                Level::Error,
                id,
                caller,
                json!({ "action": "refresh_failed", "reason": "refresh_token_not_found" }),
            );
            return Err(TokenError::NoRefreshToken);
        };
        let context = RefreshContext::new("token_refresh", caller);
        match self
            .refresh_twitch_token(&refresh_token, id, &context)
            .await
        {
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

    /// `getNewTwitchAppToken` + the `SET` of `getAppToken`.
    async fn new_app_token(&self) -> Option<AccessToken> {
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
        // The text never reaches a log: it may echo the app token.
        let sanitized = dima_text::sanitize_lone_surrogates(answer.text.as_bytes());
        let data: Value = match serde_json::from_slice(&sanitized) {
            Ok(data) => data,
            Err(_) => return internal_error("the answer is not JSON".to_owned()),
        };
        if !truthy(data.get("access_token")) {
            // The reference logs Twitch's `message`; only its category is logged here.
            let (_, reason) = classify_refusal(answer.status, &data);
            self.log(
                Level::Error,
                Destination::Console,
                None,
                json!({
                    "message": format!("Error getting new Twitch app token: {}", reason.as_str()),
                    "status": answer.status,
                }),
            );
            return None;
        }
        let token = data
            .get("access_token")
            .map(dima_text::string_of)
            .unwrap_or_default();
        // `{EX: Number(expires_in)}`: the server refuses anything but a positive integer, and
        // the reference's `SET` then throws into the same catch.
        let seconds = match data.get("expires_in") {
            Some(Value::Number(number)) => number.as_f64().unwrap_or(f64::NAN),
            Some(Value::String(text)) => dima_text::parse_number(text),
            _ => f64::NAN,
        };
        if !(seconds.is_finite() && seconds >= 1.0 && seconds.fract() == 0.0 && seconds < 9e15) {
            return internal_error("expires_in is not a positive integer".to_owned());
        }
        let seconds = seconds as u64;
        let sealed = match seal(&self.cipher, &*self.random, &token) {
            Ok(sealed) => sealed,
            Err(error) => return internal_error(error.to_string()),
        };
        if let Err(error) = self
            .dragonfly
            .set(
                &self.config.keys.app_token(),
                sealed.as_bytes(),
                SetOptions::ex(seconds),
            )
            .await
        {
            return internal_error(error.to_string());
        }
        Some(AccessToken::new(token))
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
        match inner
            .dragonfly
            .get_text(&inner.config.keys.app_token())
            .await
        {
            Ok(Some(text)) => {
                if let Some(token) = open_cached(&inner.cipher, &text) {
                    return Some(AccessToken::from_secret(token));
                }
            }
            Ok(None) => {}
            Err(error) => {
                inner.log(
                    Level::Error,
                    Destination::Console,
                    None,
                    json!({ "message": format!("Error getting twitch app token: {error}") }),
                );
                return None;
            }
        }
        if inner.shutdown.is_triggered() {
            return None;
        }
        let worker = Arc::clone(inner);
        let kill = inner.kill.clone();
        let waiter = inner
            .app_flight
            .join((), &inner.tracker, None, move || async move {
                tokio::select! {
                    biased;
                    () = kill.cancelled() => None,
                    token = worker.new_app_token() => token,
                }
            })?;
        waiter.await
    }

    /// `refreshTwitchToken(refreshToken, userId, context)` as the sign-in routes call it (no
    /// lock, as in the reference). The refresh runs as a task: dropping the returned future
    /// does not lose a rotation Twitch already answered.
    pub async fn refresh_token(
        &self,
        refresh_token: &RefreshToken,
        user_id: &str,
        context: RefreshContext,
    ) -> RefreshOutcome {
        let inner = Arc::clone(&self.inner);
        let refresh_token = refresh_token.clone();
        let user_id = user_id.to_owned();
        let task = self.inner.tracker.spawn(async move {
            inner
                .refresh_twitch_token(&refresh_token, &user_id, &context)
                .await
        });
        task.await.unwrap_or_else(|_| {
            RefreshOutcome::failure(
                RefreshFailureKind::Transient,
                None,
                RefreshFailureReason::Interrupted,
            )
        })
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

    #[test]
    fn truthiness_is_javascripts() {
        assert!(!truthy(None));
        assert!(!truthy(Some(&json!(null))));
        assert!(!truthy(Some(&json!(""))));
        assert!(!truthy(Some(&json!(0))));
        assert!(!truthy(Some(&json!(false))));
        assert!(truthy(Some(&json!("x"))));
        assert!(truthy(Some(&json!(1))));
        assert!(truthy(Some(&json!([]))));
        assert!(truthy(Some(&json!({}))));
    }
}
