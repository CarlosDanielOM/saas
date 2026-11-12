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
//!
//!    **Two answers of one generation** (review G2: the lease and the marker both failed and
//!    two exchanges of the same stored state got an answer): the second goes to the side record
//!    `twitch:{id}:refresh:parked:conflict` (same shape), and its holder counts it as kept only
//!    once that side record holds it; a third answer of the same generation is refused (its
//!    holder keeps it in the registry and reports it lost if nothing else takes it). The pair is
//!    unmatched: neither answer is written by the reconciliation; a refresh tries both before it
//!    wipes, and an operator can settle them (`crate::recovery` operator functions).
//! 3. **MongoDB**: the compare-and-set of `crate::credentials` ([`Inner::write_answer`]).
//! 4. **Removal**: once MongoDB has answered, the answer leaves the registry and its record is
//!    removed by a compare-and-delete of its exact text (a newer record is never removed).
//!
//! A process killed without a drain loses what only its registry held. A drain that ends parks
//! everything the registry still holds ([`Inner::park_remaining`]); if Dragonfly refuses too,
//! that answer is lost and logged once per streamer (`token_refresh_lost`).
//!
//! # Reconciliation (review F2, F5)
//!
//! A record has **no expiry**: it is resolved, never left to time out. Three paths resolve
//! records, all through [`Inner::recover_record`] (the write a retry makes, then the removal):
//!
//! - a refresh of the streamer, in any process, resolves its record before anything else
//!   (and does not exchange while it cannot);
//! - [`crate::Twitch::start_recovery`], once when a process starts, and
//!   [`crate::Twitch::reconcile_recovery`] on a tick ([`crate::Timings::recovery_interval`]),
//!   resolve every record;
//! - the rollback procedure runs [`crate::Twitch::reconcile_recovery`] until `left` is 0
//!   before the TypeScript starts, which cannot read these records.
//!
//! **How records are found**: a `SCAN` of their key pattern
//! ([`crate::KeySpace::recovery_pattern`]), page by page. No index is kept beside them, so
//! nothing can drift out of step with the records: after a Dragonfly restart with an empty
//! database there is nothing to find (the processes still holding answers write their records
//! again at the next retry or at shutdown), and a record written during the scan is either
//! seen or found by the next run (`SCAN` returns every key present for the whole scan; one
//! written meanwhile belongs to a live process, whose registry still holds the answer). With
//! every Rust process stopped, a complete run that leaves nothing is proof that none is left.
//!
//! It is safe from several processes at once and safe to interrupt: the write is a
//! compare-and-set (a second writer finds MongoDB holding the answer) and the removal a
//! compare-and-delete of the exact text read (a record replaced meanwhile stays). Stopped
//! between the write and the removal, the next run finds MongoDB holding the answer and
//! removes the record.
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
//! # How an answer compares with MongoDB (review G1)
//!
//! At each write, MongoDB's state is compared with the answer: first by **identity** (MongoDB's
//! refresh token, decrypted, against the answer's own token and its **base**, the token the
//! answer replaces), then by **generation** (MongoDB's against the answer's):
//!
//! | MongoDB holds | Generation | Decision |
//! |---|---|---|
//! | the answer's token | any | **held**: written already; the record is removed |
//! | the base token | any | **apply**: the exchange consumed it, so it is dead whatever its generation |
//! | anything else | above the answer's | **newer**: the record is removed, MongoDB kept |
//! | anything else | below the answer's | **apply**: MongoDB went back in time (a restore) |
//! | no token (a wipe), or an unreadable envelope | equal | **apply** |
//! | another readable token | equal | **unmatched**: nothing deleted, nothing overwritten |
//!
//! To apply is the compare-and-set write of `crate::credentials`, which moves the generation
//! past the answer's. The rule holds because every credential write of this crate advances the
//! generation in the same `updateOne` (a rotation, a wipe, [`crate::Twitch::credentials_changed`],
//! [`crate::Twitch::store_sign_in`]); only a writer outside the crate that has not called
//! `credentials_changed` yet (or the TypeScript after a rollback) can leave another token at
//! the same generation, and that is the case nobody can decide alone.
//!
//! **Unmatched.** The record stays in Dragonfly and is counted on its own
//! ([`RecoveryReport::unmatched`]); the reconciliation does not try it again in a loop (it is
//! looked at on each run, and settled as soon as MongoDB's generation moves). A refresh of that
//! streamer uses what MongoDB holds and leaves the record alone; if Twitch refuses MongoDB's
//! token for good, the record's answer is the next token tried, once, before anything is wiped.
//! Its rotation, when it works, is written at a higher generation, and the next look at the
//! record removes it.

use crate::base::{Inner, Twitch};
use crate::credentials::{CAS_ROUNDS, StoredAccount, Written, rotation_fields};
use crate::error::TwitchError;
use crate::events::{Destination, Level};
use crate::oauth::RefreshContext;
use crate::refresh::stored_refresh;
use crate::secret::{AccessToken, RefreshToken};
use crate::tokens::{RefreshOutcome, is_access_token_usable};
use dima_core::SecretString;
use dima_core::crypto::{CredentialCipher, StoredCredential};
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

/// Writes a recovery record (`KEYS[1]`) unless it already holds the answer or one of a newer
/// generation; a different answer of the **same** generation goes to the side record
/// (`KEYS[2]`, review G2) when that is free, holds an older generation or holds this answer
/// (Rust only; no loop). Returns 0 written, 1 already this answer, 2 a newer one kept, 3 in the
/// side record, 4 refused (the side record holds a third answer of this generation).
static PARK: Script = Script::new(
    "RUST_PARK_TWITCH_ANSWER_SCRIPT",
    include_str!("lua/park_answer.lua"),
);

/// Removes the recovery record, or else its side record, only while it holds the given answer
/// (Rust only; no loop).
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

impl Rotation {
    /// The answer's refresh token, decrypted (wiped when dropped); `None` when it cannot be.
    pub(crate) fn refresh_token(&self, cipher: &CredentialCipher) -> Option<RefreshToken> {
        cipher
            .decrypt(&self.refresh)
            .ok()
            .flatten()
            .filter(|token| !token.is_empty())
            .map(|token| RefreshToken::from_secret(SecretString::new(token)))
    }
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
    /// An answer of a newer generation, kept.
    Kept,
    /// The record holds another answer of the same generation; this one is in the side record
    /// (review G2): both are unmatched until MongoDB's generation moves or an operator decides.
    Conflict,
}

/// How MongoDB's state compares with an answer (the table in the module docs).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Verdict {
    Held,
    Newer,
    Apply,
    Unmatched,
}

/// What MongoDB holds after the write of an answer.
pub(crate) enum Settlement {
    /// This call wrote the answer, with this generation.
    Written(i64),
    /// The answer was already there.
    Held(Box<StoredAccount>),
    /// A newer token (see the module docs).
    Newer(Box<StoredAccount>),
    /// Another token at the answer's generation: nothing written (see the module docs).
    Unmatched,
    /// No such account.
    AccountGone,
}

/// What became of an answer for the refresh that got it.
pub(crate) enum Settled {
    /// MongoDB holds it.
    Written,
    /// A newer token was stored: its pair, when its access token is usable.
    Superseded(Option<RefreshOutcome>),
    /// MongoDB holds another token at the answer's generation: the answer is kept in Dragonfly.
    Unmatched,
    /// No such account.
    UserNotFound,
}

/// What became of the recovery records of one streamer ([`Inner::recover_record`]).
#[derive(Default)]
pub(crate) struct Recovery {
    /// Records whose answer was written to MongoDB now.
    pub(crate) applied: usize,
    /// Records whose answer MongoDB already held, or held a newer state than (removed).
    pub(crate) already_newer: usize,
    /// Records of an account that no longer exists (removed).
    pub(crate) account_gone: usize,
    /// Records left as they are: MongoDB holds another token at their generation.
    pub(crate) unmatched: usize,
    /// Records that were settled but are still in Dragonfly (their removal failed, or another
    /// answer replaced them meanwhile).
    pub(crate) left: usize,
    /// The refresh tokens of the unmatched answers, for a refresh to try once before it wipes.
    pub(crate) unmatched_tokens: Vec<RefreshToken>,
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

    /// Makes sure the recovery record of `answer` exists and holds it (or an answer of a newer
    /// generation), or its side record does when the record holds another answer of the same
    /// generation, within [`crate::Timings::park_grace`]. `Err` when neither holds it.
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
            let keys = &self.config.keys;
            let reply = PARK
                .run_value(
                    &self.dragonfly,
                    &[
                        keys.parked_rotation(&answer.user_id),
                        keys.parked_conflict(&answer.user_id),
                    ],
                    &[generation.as_str(), answer.text.as_str()],
                )
                .await
                .map_err(|error| TwitchError::cache("park answer", error))?;
            match reply::int(reply) {
                Ok(0 | 1) => Ok(Parked::Holds),
                Ok(2) => Ok(Parked::Kept),
                Ok(3) => Ok(Parked::Conflict),
                Ok(4) => Err(TwitchError::cache(
                    "park answer",
                    "two other answers of the same generation are kept",
                )),
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

    /// Removes the record (or side record) of `user_id` that still holds `text`; `true` when
    /// one was removed.
    pub(crate) async fn unpark(&self, user_id: &str, text: &str) -> Result<bool, TwitchError> {
        let keys = &self.config.keys;
        let reply = UNPARK
            .run_value(
                &self.dragonfly,
                &[keys.parked_rotation(user_id), keys.parked_conflict(user_id)],
                &[text],
            )
            .await
            .map_err(|error| TwitchError::cache("unpark answer", error))?;
        Ok(reply::int(reply).map_err(|_| TwitchError::Protocol {
            op: "unpark answer",
        })? == 1)
    }

    /// The `rotation` text of the record at `key`.
    async fn read_record(&self, key: &str) -> Result<Option<String>, TwitchError> {
        let reply = self
            .dragonfly
            .query_value(redis::cmd("HGET").arg(key).arg("rotation"))
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
        let (answered, base) = self.answer_tokens(rotation)?;
        let mut next = first;
        for _round in 0..CAS_ROUNDS {
            let stored = match next.take() {
                Some(stored) => stored,
                None => match self.load_stored(user_id).await? {
                    Some(stored) => stored,
                    None => return Ok(Settlement::AccountGone),
                },
            };
            match self.judge(&stored, rotation.generation, &answered, base.as_ref()) {
                Verdict::Held => return Ok(Settlement::Held(Box::new(stored))),
                Verdict::Newer => return Ok(Settlement::Newer(Box::new(stored))),
                Verdict::Unmatched => return Ok(Settlement::Unmatched),
                Verdict::Apply => {}
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

    /// The refresh token of `rotation` and its base, decrypted.
    fn answer_tokens(
        &self,
        rotation: &Rotation,
    ) -> Result<(RefreshToken, Option<RefreshToken>), TwitchError> {
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
        Ok((answered, base))
    }

    /// How `stored` compares with an answer of `generation` whose token is `answered` and whose
    /// base is `base` (the table in the module docs).
    fn judge(
        &self,
        stored: &StoredAccount,
        generation: i64,
        answered: &RefreshToken,
        base: Option<&RefreshToken>,
    ) -> Verdict {
        let current = stored_refresh(&self.cipher, &stored.refresh);
        if let Ok(Some(current)) = &current {
            if current == answered {
                return Verdict::Held;
            }
            if base == Some(current) {
                return Verdict::Apply;
            }
        }
        match stored.generation.millis().cmp(&generation) {
            std::cmp::Ordering::Greater => Verdict::Newer,
            std::cmp::Ordering::Less => Verdict::Apply,
            std::cmp::Ordering::Equal if matches!(current, Ok(Some(_))) => Verdict::Unmatched,
            std::cmp::Ordering::Equal => Verdict::Apply,
        }
    }

    /// Writes `answer` to MongoDB ([`Inner::write_answer`]); once MongoDB has answered, the
    /// answer leaves the registry and its record is removed. An unmatched answer keeps its
    /// record and leaves the registry once the record holds it. `Err` only when MongoDB did not
    /// answer (the answer stays in the registry).
    pub(crate) async fn release_answer(
        &self,
        answer: &Answer,
        first: Option<StoredAccount>,
    ) -> Result<Settlement, TwitchError> {
        let settlement = self
            .write_answer(&answer.user_id, &answer.rotation, first)
            .await?;
        if let Settlement::Unmatched = settlement {
            // Nothing is overwritten and nothing deleted: the record is the answer's only copy
            // outside this process. Until Dragonfly holds it, the registry keeps it (the next
            // refresh and the last step of shutdown park it again).
            if self.ensure_parked_logged(answer).await.is_some() {
                self.answers.remove(answer);
            }
            return Ok(settlement);
        }
        self.answers.remove(answer);
        // A record left behind (Dragonfly failed here) is removed by the next refresh of the
        // streamer or the reconciliation: MongoDB already holds this answer or a newer one.
        let _ = self.unpark(&answer.user_id, &answer.text).await;
        Ok(settlement)
    }

    /// [`Inner::release_answer`], then the cache and the log ([`Inner::after_settlement`]).
    async fn settle_answer(
        &self,
        answer: &Answer,
        first: Option<StoredAccount>,
        context: &RefreshContext,
    ) -> Result<Settled, TwitchError> {
        let settlement = self.release_answer(answer, first).await?;
        self.after_settlement(&answer.user_id, settlement, &answer.rotation, context)
            .await
    }

    /// After MongoDB answered a write: the cache (fenced; best effort) and the log. An error
    /// here (the cache could not be repaired from a newer state) no longer concerns the answer.
    pub(crate) async fn after_settlement(
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
            Settlement::Unmatched => {
                self.refresh_log(
                    Level::Warn,
                    Destination::Both,
                    user_id,
                    context,
                    json!({
                        "function": "refreshTwitchToken",
                        "userId": user_id,
                        "action": "token_refresh_unmatched",
                        "reason": "MongoDB holds another refresh token at the generation this exchange started from; nothing was overwritten",
                        "consequence": "the rotated tokens stay in Dragonfly for the reconciliation and the operator; a refresh tries them once if MongoDB's token is refused",
                    }),
                );
                Settled::Unmatched
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
                attempt = self.release_answer(&answer, None) => attempt,
            };
            if let Ok(settlement) = attempt {
                // The cache write is best effort here: MongoDB has answered.
                let _ = self
                    .after_settlement(&answer.user_id, settlement, &answer.rotation, &context)
                    .await;
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

    /// The recovery records of `user_id` (the record and its side record), compared with
    /// MongoDB the way a retry compares (a record may come from any process): written when it is
    /// to be applied, removed once MongoDB holds its answer or a newer state or the account is
    /// gone, left alone when unmatched. Two different answers of one generation that MongoDB
    /// settles neither way are both unmatched (review G2): neither is written. `Err` when a
    /// store failed or a record cannot be read.
    pub(crate) async fn recover_record(
        &self,
        user_id: &str,
        context: &RefreshContext,
    ) -> Result<Recovery, TwitchError> {
        let mut recovery = Recovery::default();
        let keys = &self.config.keys;
        let mut records: Vec<(String, String, Rotation)> = Vec::with_capacity(2);
        for key in [keys.parked_rotation(user_id), keys.parked_conflict(user_id)] {
            let Some(text) = self.read_record(&key).await? else {
                continue;
            };
            let rotation: Rotation = serde_json::from_str(&text).map_err(|_| {
                TwitchError::Decode("the recovery record is not an answer".to_owned())
            })?;
            records.push((key, text, rotation));
        }
        // A side record older than the record, or holding the same token (two exchanges Twitch
        // answered alike), says nothing the record does not: it goes.
        if let [(_, _, first), (key, text, second)] = records.as_slice() {
            let same = first.refresh_token(&self.cipher).is_some()
                && first.refresh_token(&self.cipher) == second.refresh_token(&self.cipher);
            if same || second.generation < first.generation {
                self.answers.remove_text(user_id, text);
                recovery.already_newer += 1;
                recovery.left += usize::from(!self.remove_record(user_id, key, text).await);
                records.truncate(1);
            }
        }
        let contested = records.len() == 2 && {
            match self.load_stored(user_id).await? {
                None => false,
                Some(stored) => {
                    let mut contested = true;
                    for (_, _, rotation) in &records {
                        let (answered, base) = self.answer_tokens(rotation)?;
                        contested &= matches!(
                            self.judge(&stored, rotation.generation, &answered, base.as_ref()),
                            Verdict::Apply | Verdict::Unmatched
                        );
                    }
                    contested
                }
            }
        };
        for (key, text, rotation) in &records {
            let settlement = if contested {
                Settlement::Unmatched
            } else {
                self.write_answer(user_id, rotation, None).await?
            };
            self.settle_record(
                user_id,
                key,
                text,
                rotation,
                settlement,
                contested,
                context,
                &mut recovery,
            )
            .await;
        }
        Ok(recovery)
    }

    /// Removes the record at `key` while it holds `text`; `true` when it is gone (removed now,
    /// or replaced or removed meanwhile by another process: `false` only if `key` still exists).
    async fn remove_record(&self, user_id: &str, key: &str, text: &str) -> bool {
        match self.unpark(user_id, text).await {
            Ok(true) => true,
            Ok(false) => self
                .dragonfly
                .exists(&[key])
                .await
                .is_ok_and(|count| count == 0),
            Err(_) => false,
        }
    }

    /// After MongoDB answered for the record at `key` holding `text`: the cache, the count, the
    /// removal (not for an unmatched record) and the log. `conflict`: unmatched because another
    /// answer of the same generation is kept beside it.
    #[allow(clippy::too_many_arguments)]
    async fn settle_record(
        &self,
        user_id: &str,
        key: &str,
        text: &str,
        rotation: &Rotation,
        settlement: Settlement,
        conflict: bool,
        context: &RefreshContext,
        recovery: &mut Recovery,
    ) {
        // If this process holds the same answer, the record speaks for it from now on.
        self.answers.remove_text(user_id, text);
        let (level, action, reason) = match &settlement {
            Settlement::Written(generation) => {
                let fields =
                    rotation_fields(&rotation.access, &rotation.refresh, rotation.expires_at);
                let _ = self.publish(user_id, *generation, &fields).await;
                recovery.applied += 1;
                (
                    Level::Info,
                    "token_refresh_recovered",
                    "a rotation kept in Dragonfly was written to MongoDB",
                )
            }
            Settlement::Held(_) => {
                recovery.already_newer += 1;
                (
                    Level::Info,
                    "token_refresh_recovery_discarded",
                    "MongoDB already held the rotation kept in Dragonfly",
                )
            }
            Settlement::Newer(_) => {
                recovery.already_newer += 1;
                (
                    Level::Info,
                    "token_refresh_recovery_discarded",
                    "MongoDB holds a newer generation than the rotation kept in Dragonfly",
                )
            }
            Settlement::AccountGone => {
                recovery.account_gone += 1;
                (
                    Level::Info,
                    "token_refresh_recovery_discarded",
                    "the account of the rotation kept in Dragonfly no longer exists",
                )
            }
            Settlement::Unmatched => {
                recovery.unmatched += 1;
                if let Some(token) = rotation.refresh_token(&self.cipher) {
                    recovery.unmatched_tokens.push(token);
                }
                (
                    Level::Warn,
                    "token_refresh_recovery_unmatched",
                    if conflict {
                        "two different rotations of one generation are kept in Dragonfly; neither is written"
                    } else {
                        "MongoDB holds another refresh token at the generation of the rotation kept in Dragonfly; both are left as they are"
                    },
                )
            }
        };
        if !matches!(settlement, Settlement::Unmatched) {
            recovery.left += usize::from(!self.remove_record(user_id, key, text).await);
        }
        self.refresh_log(
            level,
            Destination::Both,
            user_id,
            context,
            json!({
                "function": "refreshTwitchToken",
                "userId": user_id,
                "action": action,
                "reason": reason,
            }),
        );
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
                "consequence": match kept {
                    Parked::Holds => "MongoDB did not take the rotated tokens before the process stopped; they are kept in Dragonfly and written to MongoDB by the next refresh of this streamer or the reconciliation",
                    Parked::Kept => "MongoDB did not take the rotated tokens before the process stopped; Dragonfly keeps a rotation of a newer exchange instead",
                    Parked::Conflict => "MongoDB did not take the rotated tokens before the process stopped; Dragonfly keeps them beside another rotation of the same exchange, both unmatched until an operator or a refresh settles them",
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

/// How many keys one `SCAN` page asks for.
const SCAN_PAGE: u32 = 500;

/// What one reconciliation found ([`Twitch::reconcile_recovery`]). Records whose answer was
/// settled are removed; the others stay.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct RecoveryReport {
    /// Records whose answer this run wrote to MongoDB.
    pub applied: usize,
    /// Records whose answer MongoDB already held, or held a newer token than (removed).
    pub already_newer: usize,
    /// Records of accounts that no longer exist (removed).
    pub account_gone: usize,
    /// Records this run could not settle: a store failed, or the record cannot be read (with
    /// another `SECRET_KEY`, for instance). They stay.
    pub failed: usize,
    /// Records this run saw that are still in Dragonfly at its end and should not be: the
    /// failed ones, and those whose removal failed or that another answer replaced meanwhile.
    /// Unmatched records are not counted here. The rollback runs the reconciliation until this
    /// and `failed` are 0.
    pub left: usize,
    /// Records left as they are because MongoDB holds another refresh token at their generation
    /// (see `crate::recovery`): nothing proves which is newer. They stay until MongoDB's
    /// generation moves (a refresh, a sign-in) or an operator settles them.
    pub unmatched: usize,
}

impl Inner {
    /// One complete reconciliation: every record the scan finds, one at a time.
    async fn reconcile(&self) -> Result<RecoveryReport, TwitchError> {
        let context = RefreshContext::new("recovery_reconciliation", "reconcile_recovery");
        let mut report = RecoveryReport::default();
        let mut seen: HashSet<String> = HashSet::new();
        let mut scan = self
            .dragonfly
            .scan(&self.config.keys.recovery_pattern(), Some(SCAN_PAGE));
        let outcome = 'scan: loop {
            let page = match scan.next_page().await {
                Ok(Some(page)) => page,
                Ok(None) => break Ok(()),
                Err(error) => break Err(TwitchError::cache("scan recovery records", error)),
            };
            for key in page {
                if self.shutdown.is_triggered() {
                    break 'scan Err(TwitchError::Shutdown);
                }
                let Some((user_id, _)) = std::str::from_utf8(&key)
                    .ok()
                    .and_then(|key| self.config.keys.recovery_key(key))
                else {
                    continue;
                };
                // `SCAN` can return a key twice.
                if !seen.insert(user_id.to_owned()) {
                    continue;
                }
                match self.recover_record(user_id, &context).await {
                    Ok(recovery) => {
                        report.applied += recovery.applied;
                        report.already_newer += recovery.already_newer;
                        report.account_gone += recovery.account_gone;
                        report.unmatched += recovery.unmatched;
                        report.left += recovery.left;
                    }
                    Err(error) => {
                        report.failed += 1;
                        report.left += 1;
                        self.log(
                            Level::Error,
                            Destination::Both,
                            Some(user_id),
                            json!({
                                "function": "reconcileRecovery",
                                "userId": user_id,
                                "action": "token_recovery_failed",
                                "reason": error.to_string(),
                                "consequence": "the recovery record stays; the next refresh of this streamer or the next reconciliation tries again",
                            }),
                        );
                    }
                }
            }
        };
        let complete = outcome.is_ok();
        self.log(
            if report.left > 0 || report.failed > 0 || !complete {
                Level::Error
            } else if report.unmatched > 0 {
                Level::Warn
            } else {
                Level::Info
            },
            Destination::Both,
            None,
            json!({
                "function": "reconcileRecovery",
                "action": "token_recovery_reconciled",
                "complete": complete,
                "applied": report.applied,
                "alreadyNewer": report.already_newer,
                "accountGone": report.account_gone,
                "failed": report.failed,
                "left": report.left,
                "unmatched": report.unmatched,
            }),
        );
        outcome.map(|()| report)
    }
}

impl Twitch {
    /// Reconciles every recovery record into MongoDB (review F2, F5; see `crate::recovery`):
    /// each record found by a `SCAN` of [`crate::KeySpace::recovery_pattern`] is compared with
    /// MongoDB (the table in `crate::recovery`), written with the compare-and-set a retry uses
    /// when it is to be applied, and removed when MongoDB holds its answer or a newer generation,
    /// or when the account no longer exists. An unmatched record stays and is counted
    /// ([`RecoveryReport::unmatched`]). Safe from several processes at once and safe to
    /// interrupt; in one process, a call while a run is going joins it.
    ///
    /// This is also the **tick**: call it every [`crate::Timings::recovery_interval`]. The
    /// rollback procedure calls it until `left` is 0 (with every Rust process stopped) before
    /// the TypeScript starts. `Err` when the scan could not finish (Dragonfly failed, or the
    /// process is stopping): the counts are then incomplete, run it again.
    pub async fn reconcile_recovery(&self) -> Result<RecoveryReport, TwitchError> {
        let inner = Arc::clone(&self.inner);
        let kill = self.inner.kill.clone();
        let waiter = self
            .inner
            .recovery_flight
            .join(
                (),
                &self.inner.tracker,
                Err(TwitchError::Interrupted),
                move || async move {
                    tokio::select! {
                        biased;
                        () = kill.cancelled() => Err(TwitchError::Interrupted),
                        report = inner.reconcile() => report,
                    }
                },
            )
            .ok_or(TwitchError::Busy)?;
        waiter.await
    }

    /// The start-up reconciliation: call it once when the process starts, after building the
    /// handle. It runs [`Twitch::reconcile_recovery`] as a task and waits for it at most
    /// [`crate::Timings::recovery_start_wait`] (3 s), so the process's readiness is never
    /// held longer; a run not finished by then goes on in the background and logs its counts
    /// (`token_recovery_reconciled`). `Some` with the counts when it finished in time.
    pub async fn start_recovery(&self) -> Option<RecoveryReport> {
        let wait = self.inner.config.timings.recovery_start_wait;
        match tokio::time::timeout(wait, self.reconcile_recovery()).await {
            Ok(Ok(report)) => Some(report),
            Ok(Err(_)) | Err(_) => None,
        }
    }
}
