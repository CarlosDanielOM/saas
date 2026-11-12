//! Answers from Twitch that MongoDB has not taken yet (review F1 and F4): the registry in
//! memory, the recovery records in Dragonfly, the compare-and-set write they share, and the
//! last step of shutdown.
//!
//! Twitch may rotate the refresh token on every exchange: once it has answered, the old token
//! can be dead and the new pair exists only in that answer until MongoDB holds it.
//!
//! # The life of an answer
//!
//! 1. **Registry** ([`Registry`]). The answer is encrypted and enters this process's registry
//!    before anything else is attempted with it. It leaves only when MongoDB holds it, holds
//!    something newer, or the account is gone ([`Settlement`]).
//! 2. **Recovery record** `twitch:{id}:refresh:parked`, a hash of `generation` and `rotation`
//!    (the answer as JSON, encrypted envelopes only). The foreground write, every background
//!    retry and the last step of shutdown make sure it exists and holds the answer
//!    ([`Inner::ensure_parked`]): written when absent, never replacing a record of the same or a
//!    newer generation. Nothing remembers "parked once": a record can disappear (a Dragonfly
//!    restart or flush, an operator) and is written again by the next of those steps.
//! 3. **MongoDB**: the compare-and-set of `crate::credentials` ([`Inner::write_answer`]).
//! 4. **Removal**: once MongoDB has answered, the answer leaves the registry and its record is
//!    removed by a compare-and-delete of its exact text (a newer record is never removed).
//!
//! A process killed without a drain loses what only its registry held. A drain that ends parks
//! everything the registry still holds ([`Inner::park_remaining`]); if Dragonfly refuses too,
//! that answer is lost and logged once per streamer (`token_refresh_lost`).
//!
//! # Generations
//!
//! An answer's **generation** is MongoDB's generation (the user's `refreshed_at`, see
//! `crate::credentials`) of the state its exchange started from. Every credential write advances
//! it, so along a chain of exchanges (R0 → R1 written, then R1 → R2) the generations strictly
//! grow, and two exchanges of the same stored state share one. A record therefore never gives
//! way to an answer of the same or an older generation: that answer's base has already been
//! replaced, or the record answers the same base.
//!
//! # "MongoDB holds it, or something newer"
//!
//! At each write, MongoDB's refresh token is read and compared (decrypted) with the answer's own
//! token and with its **base**, the token the answer replaces:
//!
//! - the answer's token: MongoDB **holds it** (written by a retry, another process or the
//!   reconciliation);
//! - any other readable token: MongoDB holds something **newer**. It was written after the base
//!   was read, so at a higher generation than the answer's: every writer of this crate advances
//!   the generation in the same write, a sign-in does through `credentials_changed`. A token the
//!   answer was not exchanged from is never overwritten, also in the moment before its writer
//!   advanced the generation (and after a rollback, when the TypeScript writes tokens without
//!   advancing it);
//! - the base token, no token (a wipe) or an envelope that cannot be decrypted: the answer is
//!   written over that state by compare-and-set, whatever its generation (a higher one there
//!   only means the generation was advanced without a new token, or the account was wiped).

use crate::base::Inner;
use crate::credentials::{CAS_ROUNDS, StoredAccount, Written, rotation_fields};
use crate::error::TwitchError;
use crate::events::{Destination, Level};
use crate::oauth::RefreshContext;
use crate::refresh::stored_refresh;
use crate::secret::{AccessToken, RefreshToken};
use crate::tokens::{RefreshOutcome, is_access_token_usable};
use dima_core::SecretString;
use dima_core::crypto::StoredCredential;
use dima_store::dragonfly::commands::reply;
use dima_store::dragonfly::script::Script;
use futures_util::StreamExt;
use futures_util::stream::FuturesUnordered;
use serde_json::json;
use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::time::Duration;
use tokio::time::Instant;

/// Writes a recovery record unless it already holds the answer or one of the same or a newer
/// generation (Rust only; no loop). Returns 0 written, 1 already this answer, 2 kept.
static PARK: Script = Script::new(
    "RUST_PARK_TWITCH_ANSWER_SCRIPT",
    include_str!("lua/park_answer.lua"),
);

/// Removes a recovery record only while it holds the given answer (Rust only; no loop).
static UNPARK: Script = Script::new(
    "RUST_UNPARK_TWITCH_ANSWER_SCRIPT",
    include_str!("lua/unpark_answer.lua"),
);

/// Most answers a process holds unwritten at once. A new exchange is refused (nothing is sent)
/// while the registry is full, so an answer never finds it full.
pub(crate) const MAX_ANSWERS: usize = crate::base::MAX_FLIGHTS;

/// How long the last step of shutdown waits between two rounds for an answer Dragonfly
/// refused.
const PARK_ROUND_PAUSE: Duration = Duration::from_millis(50);

/// An answer Twitch gave, encrypted: what is written to MongoDB and kept in the recovery record
/// (`rotation`, this JSON).
#[derive(Clone, serde::Serialize, serde::Deserialize)]
pub(crate) struct Rotation {
    /// The refresh token this answer replaces (the stored one when the exchange started),
    /// encrypted; `None` when there was none.
    base: Option<StoredCredential>,
    /// MongoDB's generation of the state the exchange started from (0 when there was none).
    generation: i64,
    pub(crate) access: StoredCredential,
    pub(crate) refresh: StoredCredential,
    #[serde(rename = "expiresAt")]
    pub(crate) expires_at: f64,
    #[serde(rename = "expiresIn")]
    pub(crate) expires_in: f64,
}

/// One answer in the registry.
pub(crate) struct Answer {
    serial: u64,
    pub(crate) user_id: String,
    pub(crate) rotation: Rotation,
    /// The record's `rotation` field for this answer, compared byte for byte.
    pub(crate) text: String,
}

/// The answers this process holds that MongoDB has not taken yet, per streamer.
#[derive(Default)]
pub(crate) struct Registry {
    serials: AtomicU64,
    answers: Mutex<HashMap<String, Vec<Arc<Answer>>>>,
}

impl Registry {
    fn lock(&self) -> MutexGuard<'_, HashMap<String, Vec<Arc<Answer>>>> {
        self.answers.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// How many answers are held.
    pub(crate) fn len(&self) -> usize {
        self.lock().values().map(Vec::len).sum()
    }

    fn register(&self, user_id: &str, rotation: Rotation, text: String) -> Arc<Answer> {
        let answer = Arc::new(Answer {
            serial: self.serials.fetch_add(1, Ordering::SeqCst),
            user_id: user_id.to_owned(),
            rotation,
            text,
        });
        self.lock()
            .entry(user_id.to_owned())
            .or_default()
            .push(Arc::clone(&answer));
        answer
    }

    /// The newest answer held for `user_id` (highest generation, then the latest).
    pub(crate) fn newest(&self, user_id: &str) -> Option<Arc<Answer>> {
        self.lock()
            .get(user_id)?
            .iter()
            .max_by_key(|answer| (answer.rotation.generation, answer.serial))
            .cloned()
    }

    fn remove_where(&self, user_id: &str, gone: impl Fn(&Answer) -> bool) {
        let mut answers = self.lock();
        if let Some(held) = answers.get_mut(user_id) {
            held.retain(|answer| !gone(answer));
            if held.is_empty() {
                answers.remove(user_id);
            }
        }
    }

    /// `answer` leaves the registry.
    fn remove(&self, answer: &Answer) {
        self.remove_where(&answer.user_id, |held| held.serial == answer.serial);
    }

    /// The answer whose record text is `text` leaves the registry (it was settled from its
    /// record).
    fn remove_text(&self, user_id: &str, text: &str) {
        self.remove_where(user_id, |held| held.text == text);
    }

    fn all(&self) -> Vec<Arc<Answer>> {
        self.lock().values().flatten().cloned().collect()
    }
}

/// What the record of an answer holds after [`Inner::ensure_parked`].
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Parked {
    /// This answer.
    Holds,
    /// An answer of the same or a newer generation, kept.
    Kept,
}

/// What MongoDB holds after the write of an answer.
pub(crate) enum Settlement {
    /// This call wrote the answer, with this generation.
    Written(i64),
    /// The answer was already there.
    Held(Box<StoredAccount>),
    /// A newer token (see the module docs).
    Newer(Box<StoredAccount>),
    /// No such account.
    AccountGone,
}

/// What became of an answer for the refresh that got it.
pub(crate) enum Settled {
    /// MongoDB holds it.
    Written,
    /// A newer token was stored: its pair, when its access token is usable.
    Superseded(Option<RefreshOutcome>),
    /// No such account.
    UserNotFound,
}

/// What a recovery record became.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Recovered {
    /// There was none.
    Absent,
    /// Its answer was written to MongoDB now.
    Applied,
    /// MongoDB already held its answer or a newer token.
    AlreadyNewer,
    /// The account no longer exists.
    AccountGone,
}

impl Inner {
    /// Encrypts Twitch's answer and puts it in the registry: the first thing done with it.
    /// `used` is the refresh token it replaces (the stored one), `base` the stored state the
    /// exchange started from.
    pub(crate) fn register_answer(
        &self,
        user_id: &str,
        used: &RefreshToken,
        base: Option<&StoredAccount>,
        access: &AccessToken,
        refresh: &RefreshToken,
        expires_in: f64,
    ) -> Result<Arc<Answer>, TwitchError> {
        let random: &dyn dima_core::SecureRandom = &*self.random;
        let rotation = Rotation {
            base: Some(self.cipher.encrypt(used.expose(), random)?),
            generation: base.map_or(0, |stored| stored.generation.millis()),
            access: self.cipher.encrypt(access.expose(), random)?,
            refresh: self.cipher.encrypt(refresh.expose(), random)?,
            expires_at: self.now_secs() as f64 + expires_in,
            expires_in,
        };
        let text = serde_json::to_string(&rotation)
            .map_err(|error| TwitchError::Write(error.to_string()))?;
        Ok(self.answers.register(user_id, rotation, text))
    }

    /// Makes sure the recovery record of `answer` exists and holds it (or an answer of the same
    /// or a newer generation), within [`crate::Timings::park_grace`].
    pub(crate) async fn ensure_parked(&self, answer: &Answer) -> Result<Parked, TwitchError> {
        let park = async {
            #[cfg(any(test, feature = "test-util"))]
            if self
                .fault(crate::base::FaultPoint::BeforePark, &answer.user_id)
                .await
                == crate::base::FaultAction::Fail
            {
                return Err(TwitchError::cache(
                    "park answer",
                    "refused by the fault hook",
                ));
            }
            let generation = answer.rotation.generation.to_string();
            let ttl = u64::try_from(self.config.timings.park_ttl.as_millis())
                .unwrap_or(u64::MAX)
                .max(1)
                .to_string();
            let reply = PARK
                .run_value(
                    &self.dragonfly,
                    &[self.config.keys.parked_rotation(&answer.user_id)],
                    &[generation.as_str(), answer.text.as_str(), ttl.as_str()],
                )
                .await
                .map_err(|error| TwitchError::cache("park answer", error))?;
            match reply::int(reply) {
                Ok(0 | 1) => Ok(Parked::Holds),
                Ok(2) => Ok(Parked::Kept),
                _ => Err(TwitchError::Protocol { op: "park answer" }),
            }
        };
        tokio::time::timeout(self.config.timings.park_grace, park)
            .await
            .unwrap_or(Err(TwitchError::Deadline { op: "park answer" }))
    }

    /// [`Inner::ensure_parked`], a failure logged (`token_refresh_park_failed`).
    pub(crate) async fn ensure_parked_logged(&self, answer: &Answer) -> Option<Parked> {
        match self.ensure_parked(answer).await {
            Ok(parked) => Some(parked),
            Err(error) => {
                self.log(
                    Level::Warn,
                    Destination::Both,
                    Some(&answer.user_id),
                    json!({
                        "function": "refreshTwitchToken",
                        "userId": answer.user_id,
                        "action": "token_refresh_park_failed",
                        "reason": error.to_string(),
                    }),
                );
                None
            }
        }
    }

    /// Removes the record of `user_id` if it still holds `text`; `true` when it was removed.
    pub(crate) async fn unpark(&self, user_id: &str, text: &str) -> Result<bool, TwitchError> {
        let reply = UNPARK
            .run_value(
                &self.dragonfly,
                &[self.config.keys.parked_rotation(user_id)],
                &[text],
            )
            .await
            .map_err(|error| TwitchError::cache("unpark answer", error))?;
        Ok(reply::int(reply).map_err(|_| TwitchError::Protocol {
            op: "unpark answer",
        })? == 1)
    }

    /// The recovery record of `user_id`: its `rotation` text.
    async fn read_record(&self, user_id: &str) -> Result<Option<String>, TwitchError> {
        let reply = self
            .dragonfly
            .query_value(
                redis::cmd("HGET")
                    .arg(self.config.keys.parked_rotation(user_id))
                    .arg("rotation"),
            )
            .await
            .map_err(|error| TwitchError::cache("read recovery record", error))?;
        reply::bytes_or_nil(reply)
            .map_err(|_| TwitchError::Protocol {
                op: "read recovery record",
            })?
            .map(|bytes| {
                String::from_utf8(bytes).map_err(|_| TwitchError::Protocol {
                    op: "read recovery record",
                })
            })
            .transpose()
    }

    /// Writes `rotation` to MongoDB unless MongoDB holds it or something newer (see the module
    /// docs): a compare-and-set on the state read, `first` for the first round when the
    /// caller has just read it.
    pub(crate) async fn write_answer(
        &self,
        user_id: &str,
        rotation: &Rotation,
        first: Option<StoredAccount>,
    ) -> Result<Settlement, TwitchError> {
        #[cfg(any(test, feature = "test-util"))]
        if self
            .fault(crate::base::FaultPoint::BeforePersist, user_id)
            .await
            == crate::base::FaultAction::Fail
        {
            return Err(TwitchError::MongoTimeout { op: "update user" });
        }
        let answered = self
            .cipher
            .decrypt(&rotation.refresh)?
            .filter(|token| !token.is_empty())
            .map(|token| RefreshToken::from_secret(SecretString::new(token)))
            .ok_or_else(|| TwitchError::Write("the answer holds no refresh token".to_owned()))?;
        let base = rotation
            .base
            .as_ref()
            .and_then(|base| self.cipher.decrypt(base).ok().flatten())
            .filter(|token| !token.is_empty())
            .map(|token| RefreshToken::from_secret(SecretString::new(token)));
        let mut next = first;
        for _round in 0..CAS_ROUNDS {
            let stored = match next.take() {
                Some(stored) => stored,
                None => match self.load_stored(user_id).await? {
                    Some(stored) => stored,
                    None => return Ok(Settlement::AccountGone),
                },
            };
            if let Ok(Some(current)) = stored_refresh(&self.cipher, &stored.refresh) {
                if current == answered {
                    return Ok(Settlement::Held(Box::new(stored)));
                }
                if base.as_ref() != Some(&current) {
                    return Ok(Settlement::Newer(Box::new(stored)));
                }
            }
            if let Written::Done(generation) = self
                .write_rotation(
                    user_id,
                    &stored,
                    &rotation.access,
                    &rotation.refresh,
                    rotation.expires_at,
                )
                .await?
            {
                return Ok(Settlement::Written(generation));
            }
        }
        Err(TwitchError::Write(
            "the stored refresh token kept changing".to_owned(),
        ))
    }

    /// Writes `answer` to MongoDB ([`Inner::write_answer`]); once MongoDB has answered, the
    /// answer leaves the registry, its record is removed and the cache follows.
    pub(crate) async fn settle_answer(
        &self,
        answer: &Answer,
        first: Option<StoredAccount>,
        context: &RefreshContext,
    ) -> Result<Settled, TwitchError> {
        let settlement = self
            .write_answer(&answer.user_id, &answer.rotation, first)
            .await?;
        self.answers.remove(answer);
        // A record left behind (Dragonfly failed here) is removed by the next refresh of the
        // streamer or the reconciliation: MongoDB already holds this answer or a newer one.
        let _ = self.unpark(&answer.user_id, &answer.text).await;
        self.after_settlement(&answer.user_id, settlement, &answer.rotation, context)
            .await
    }

    /// After MongoDB answered a write: the cache (fenced; best effort) and the log.
    async fn after_settlement(
        &self,
        user_id: &str,
        settlement: Settlement,
        rotation: &Rotation,
        context: &RefreshContext,
    ) -> Result<Settled, TwitchError> {
        Ok(match settlement {
            Settlement::AccountGone => {
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
                        "consequence": "Twitch rotated the refresh token but the account no longer exists; nothing was stored",
                    }),
                );
                Settled::UserNotFound
            }
            Settlement::Newer(stored) => {
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
                    Settled::Superseded(Some(RefreshOutcome::Success {
                        access_token,
                        refresh_token,
                        expires_in: expiry - now as f64,
                    }))
                } else {
                    Settled::Superseded(None)
                }
            }
            Settlement::Held(stored) => {
                // Written by another writer: its cache write may not have happened yet.
                let _ = self.publish_stored(user_id, &stored).await;
                Settled::Written
            }
            Settlement::Written(generation) => {
                let fields =
                    rotation_fields(&rotation.access, &rotation.refresh, rotation.expires_at);
                if let Err(error) = self.publish(user_id, generation, &fields).await {
                    // MongoDB has the rotation; the next refresh repairs the cache from it.
                    self.refresh_log(
                        Level::Warn,
                        Destination::Both,
                        user_id,
                        context,
                        json!({
                            "function": "refreshTwitchToken",
                            "userId": user_id,
                            "action": "token_refresh_cache_failed",
                            "reason": error.to_string(),
                        }),
                    );
                }
                self.refresh_log(
                    Level::Info,
                    Destination::Cache,
                    user_id,
                    context,
                    json!({
                        "function": "refreshTwitchToken",
                        "userId": user_id,
                        "action": "token_refresh_succeeded",
                        "expiresIn": rotation.expires_in,
                        "expiresAt": rotation.expires_at,
                    }),
                );
                Settled::Written
            }
        })
    }

    /// The background writer of an answer MongoDB refused: every retry (with backoff, holding
    /// a share of the lease, which keeps the marker) first makes sure the record holds the
    /// answer, then writes it. It stops when MongoDB has answered or the drain ends; an answer
    /// still unwritten then stays in the registry for the last step of shutdown.
    pub(crate) async fn write_in_background(
        self: Arc<Self>,
        lease: crate::lease::Lease,
        answer: Arc<Answer>,
        context: RefreshContext,
    ) {
        let timings = &self.config.timings;
        let mut pause = timings.persist_retry;
        let written = loop {
            tokio::select! {
                biased;
                () = self.drain_expired.wait() => break false,
                () = self.kill.cancelled() => break false,
                () = tokio::time::sleep(pause) => {}
            }
            pause = (pause * 2).min(timings.persist_retry_max);
            // Review F1: the record may have been lost since the last attempt.
            let _ = self.ensure_parked(&answer).await;
            let attempt = tokio::select! {
                biased;
                () = self.drain_expired.wait() => break false,
                () = self.kill.cancelled() => break false,
                attempt = self.settle_answer(&answer, None, &context) => attempt,
            };
            if attempt.is_ok() {
                break true;
            }
        };
        if self.kill.is_cancelled() {
            return;
        }
        if written {
            self.clear_marker(&lease).await;
        } else {
            self.abandon_marker(&lease);
        }
        self.release(lease).await;
    }

    /// An answer this process holds for `user_id` is written before anything else is done
    /// for the streamer (no exchange while it is unwritten); `Err` when MongoDB refuses.
    pub(crate) async fn apply_registered(
        &self,
        user_id: &str,
        context: &RefreshContext,
    ) -> Result<(), TwitchError> {
        let Some(answer) = self.answers.newest(user_id) else {
            return Ok(());
        };
        self.ensure_parked_logged(&answer).await;
        self.settle_answer(&answer, None, context).await.map(|_| ())
    }

    /// The access token of the newest answer held for `user_id`, when it is usable and not
    /// `rejected`.
    pub(crate) fn pending_token(
        &self,
        user_id: &str,
        rejected: Option<&AccessToken>,
    ) -> Option<AccessToken> {
        let answer = self.answers.newest(user_id)?;
        let token = self
            .cipher
            .decrypt(&answer.rotation.access)
            .ok()
            .flatten()?;
        let token = AccessToken::from_secret(SecretString::new(token));
        let expiry = dima_text::number_to_string(answer.rotation.expires_at);
        let usable = is_access_token_usable(
            Some(token.expose()),
            Some(&expiry),
            self.now_secs(),
            self.config.timings.token_expiry_skew_secs,
        );
        (usable && rejected != Some(&token)).then_some(token)
    }

    /// Whether a new exchange may start: the registry has room for its answer.
    pub(crate) fn has_room_for_an_answer(&self) -> bool {
        self.answers.len() < MAX_ANSWERS
    }

    /// The recovery record of `user_id`, written to MongoDB the way a retry writes it (the
    /// record may come from any process) and removed once MongoDB holds its answer or a newer
    /// token, or the account is gone. The second value says whether a record is left.
    pub(crate) async fn recover_record(
        &self,
        user_id: &str,
        context: &RefreshContext,
    ) -> Result<(Recovered, bool), TwitchError> {
        let Some(text) = self.read_record(user_id).await? else {
            return Ok((Recovered::Absent, false));
        };
        let rotation: Rotation = serde_json::from_str(&text)
            .map_err(|_| TwitchError::Decode("the recovery record is not an answer".to_owned()))?;
        let settlement = self.write_answer(user_id, &rotation, None).await?;
        // If this process holds the same answer, it is settled too.
        self.answers.remove_text(user_id, &text);
        let (recovered, reason) = match &settlement {
            Settlement::Written(generation) => {
                let fields =
                    rotation_fields(&rotation.access, &rotation.refresh, rotation.expires_at);
                let _ = self.publish(user_id, *generation, &fields).await;
                (
                    Recovered::Applied,
                    "a rotation kept in Dragonfly was written to MongoDB",
                )
            }
            Settlement::Held(_) => (
                Recovered::AlreadyNewer,
                "MongoDB already held the rotation kept in Dragonfly",
            ),
            Settlement::Newer(_) => (
                Recovered::AlreadyNewer,
                "MongoDB holds a newer refresh token than the rotation kept in Dragonfly",
            ),
            Settlement::AccountGone => (
                Recovered::AccountGone,
                "the account of the rotation kept in Dragonfly no longer exists",
            ),
        };
        let left = match self.unpark(user_id, &text).await {
            Ok(true) => false,
            // Replaced meanwhile by another answer (or removed by another process).
            Ok(false) => self
                .dragonfly
                .exists(&[&self.config.keys.parked_rotation(user_id)])
                .await
                .map_or(true, |count| count == 1),
            Err(_) => true,
        };
        self.refresh_log(
            Level::Info,
            Destination::Both,
            user_id,
            context,
            json!({
                "function": "refreshTwitchToken",
                "userId": user_id,
                "action": if recovered == Recovered::Applied { "token_refresh_recovered" } else { "token_refresh_recovery_discarded" },
                "reason": reason,
            }),
        );
        Ok((recovered, left))
    }

    /// The last step of shutdown: every answer still in the registry is parked, within
    /// [`crate::Timings::park_grace`] in total (Dragonfly refusing one is tried again until
    /// then). An answer Dragonfly did not take is lost: logged once per streamer, at error
    /// level, with the streamer id and no secret. `true` when every answer is in Dragonfly.
    pub(crate) async fn park_remaining(&self) -> bool {
        let deadline = Instant::now() + self.config.timings.park_grace;
        let mut parked: HashSet<u64> = HashSet::new();
        loop {
            let waiting: Vec<Arc<Answer>> = self
                .answers
                .all()
                .into_iter()
                .filter(|answer| !parked.contains(&answer.serial))
                .collect();
            if waiting.is_empty() {
                return true;
            }
            let mut parks: FuturesUnordered<_> = waiting
                .iter()
                .map(|answer| async move { (answer, self.ensure_parked(answer).await) })
                .collect();
            let mut refused = false;
            loop {
                match tokio::time::timeout_at(deadline, parks.next()).await {
                    Ok(Some((answer, Ok(kept)))) => {
                        parked.insert(answer.serial);
                        self.log_parked(answer, kept);
                    }
                    Ok(Some((_, Err(_)))) => refused = true,
                    Ok(None) => break,
                    Err(_) => {
                        drop(parks);
                        self.log_lost(&waiting, &parked);
                        return false;
                    }
                }
            }
            if refused
                && tokio::time::timeout_at(deadline, tokio::time::sleep(PARK_ROUND_PAUSE))
                    .await
                    .is_err()
            {
                self.log_lost(&waiting, &parked);
                return false;
            }
        }
    }

    fn log_parked(&self, answer: &Answer, kept: Parked) {
        self.log(
            Level::Error,
            Destination::Both,
            Some(&answer.user_id),
            json!({
                "function": "refreshTwitchToken",
                "userId": answer.user_id,
                "action": "token_refresh_parked",
                "consequence": if kept == Parked::Holds {
                    "MongoDB did not take the rotated tokens before the process stopped; they are kept in Dragonfly and written to MongoDB by the next refresh of this streamer or the reconciliation"
                } else {
                    "MongoDB did not take the rotated tokens before the process stopped; Dragonfly keeps a rotation of the same or a newer exchange instead"
                },
            }),
        );
    }

    /// `token_refresh_lost`, once per streamer among `waiting` not in `parked`.
    fn log_lost(&self, waiting: &[Arc<Answer>], parked: &HashSet<u64>) {
        let mut logged: HashSet<&str> = HashSet::new();
        for answer in waiting {
            if parked.contains(&answer.serial) || !logged.insert(&answer.user_id) {
                continue;
            }
            self.log(
                Level::Error,
                Destination::Both,
                Some(&answer.user_id),
                json!({
                    "function": "refreshTwitchToken",
                    "userId": answer.user_id,
                    "action": "token_refresh_lost",
                    "consequence": "MongoDB and Dragonfly both failed before the process stopped; the rotated refresh token is LOST and the streamer must reauthorize",
                }),
            );
        }
    }
}

/// Logs an answer that could not even be put in the registry (its encryption failed: the
/// system's random source refused).
pub(crate) fn log_unregistered(inner: &Inner, user_id: &str, context: &RefreshContext) {
    inner.refresh_log(
        Level::Error,
        Destination::Both,
        user_id,
        context,
        json!({
            "function": "refreshTwitchToken",
            "userId": user_id,
            "action": "token_refresh_lost",
            "consequence": "Twitch rotated the refresh token but the answer could not be encrypted; the rotated refresh token is LOST and the streamer must reauthorize",
        }),
    );
}
