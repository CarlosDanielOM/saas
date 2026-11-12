//! One streamer's stored credentials: MongoDB's state with its **generation**, the
//! compare-and-set writes that change it, and the fenced copy in the directory hash.
//!
//! # The generation
//!
//! Every write of credentials or of the permission flags to the directory hash carries a
//! generation, and a compare-and-set script refuses a generation lower than the one the hash
//! holds (`__credential_generation`), so a delayed writer can never put older state over newer.
//!
//! The generation is stored **with the token in MongoDB**: it is the user's `refreshed_at`
//! (a `Date` in the schema, epoch milliseconds here; a missing value is 0). The reference
//! sets it only when the document is created (`default: Date.now`) and never reads it; no
//! client reads it. This crate advances it with every credential write it makes (a persisted
//! rotation, a wipe, [`crate::Twitch::credentials_changed`]), in the same `updateOne` as the
//! tokens, whose filter requires the `refreshed_at` value read just before and whose `$set`
//! stores `max(now, read + 1 ms)`.
//!
//! **Why it only grows.** Each such write needs the exact previous value and stores a larger
//! one, so two writes can never start from the same value and every accepted write raises it,
//! whatever the clocks do. Nothing else writes it after creation (the frozen TypeScript does
//! not, so a rollback leaves it as Rust left it). A wall clock that steps back cannot lower it:
//! `read + 1 ms` wins then.
//!
//! The directory's start-up load and hydration write the generation they read with the user;
//! when the hash already holds a newer one they write the account's other fields and keep the
//! hash's credentials (`lua/write_account.lua`, which is `WRITE_PLAN_ACCOUNT_SCRIPT` plus that
//! fence). A cached `has_permissions` other than `"true"` is checked against MongoDB before a
//! caller is refused ([`Inner::recheck_permissions`]).

use crate::base::Inner;
use crate::error::TwitchError;
use crate::secret::{cache_text, cache_text_of};
use crate::streamers::persisted_expires_at;
use bson::oid::ObjectId;
use bson::{Bson, Document, RawDocumentBuf, doc};
use dima_core::crypto::StoredCredential;
use dima_model::users::{AccountType, EncryptedToken, User};
use dima_store::dragonfly::commands::reply;
use dima_store::dragonfly::script::Script;
use dima_store::mongo::WriteContext;
use dima_store::mongo::number::js_number;
use dima_store::mongo::update::UpdateOptions;
use std::collections::HashMap;
use std::time::Duration;
use tokio::time::Instant;

/// The hash field holding the generation (internal, never part of [`crate::StreamerAccount`]).
pub(crate) const GENERATION_FIELD: &str = "__credential_generation";

/// Writes credential fields when the generation is not older than the hash's (Rust only).
static WRITE_CREDENTIALS: Script = Script::new(
    "RUST_WRITE_TWITCH_CREDENTIALS_SCRIPT",
    include_str!("lua/write_credentials.lua"),
);

/// `WRITE_PLAN_ACCOUNT_SCRIPT` with the credential fence (Rust only).
pub(crate) static WRITE_ACCOUNT: Script = Script::new(
    "RUST_WRITE_TWITCH_ACCOUNT_SCRIPT",
    include_str!("lua/write_account.lua"),
);

/// How many times a compare-and-set write reads and tries again when the stored state changed
/// between its read and its write.
pub(crate) const CAS_ROUNDS: usize = 3;

/// Most streamers whose "no permissions" a process remembers having checked.
const MAX_PERMISSION_CHECKS: usize = 10_000;

/// MongoDB's `refreshed_at` as read: the exact value (for the compare-and-set filter) and its
/// milliseconds (the generation).
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct Generation {
    raw: Bson,
    millis: i64,
}

impl Generation {
    pub(crate) fn of(raw: Option<&Bson>) -> Self {
        let raw = raw.cloned().unwrap_or(Bson::Null);
        let millis = dima_store::mongo::date::read_time(&raw).unwrap_or(0).max(0);
        Self { raw, millis }
    }

    /// The generation as the directory stores it.
    pub(crate) fn millis(&self) -> i64 {
        self.millis
    }

    /// The value the next write stores: later than this one, whatever the clock says.
    fn next(&self, now_ms: i64) -> i64 {
        now_ms.max(self.millis.saturating_add(1))
    }
}

/// The stored state of one Twitch account.
#[derive(Clone)]
pub(crate) struct StoredAccount {
    pub(crate) user: ObjectId,
    pub(crate) refresh: EncryptedToken,
    pub(crate) access: EncryptedToken,
    pub(crate) expires_at: Option<String>,
    pub(crate) has_permissions: bool,
    pub(crate) up_to_date_permissions: bool,
    pub(crate) generation: Generation,
}

impl StoredAccount {
    /// The filter that matches this account only while its refresh envelope and the user's
    /// generation are unchanged.
    fn compare_filter(&self, id: &str) -> Document {
        let part = |value: &Option<String>| value.clone().map_or(Bson::Null, Bson::String);
        doc! {
            "_id": self.user,
            "refreshed_at": self.generation.raw.clone(),
            "accounts": {
                "$elemMatch": {
                    "type": "twitch",
                    "id": id,
                    "refresh_token.iv": part(&self.refresh.iv),
                    "refresh_token.content": part(&self.refresh.content),
                }
            }
        }
    }

    /// The credential fields of the directory hash for this state.
    fn cache_fields(&self) -> Vec<(&'static str, String)> {
        let flag = |value: bool| if value { "true" } else { "false" }.to_owned();
        vec![
            ("refresh_token", cache_text_of(&self.refresh)),
            ("access_token", cache_text_of(&self.access)),
            ("expires_at", self.expires_at.clone().unwrap_or_default()),
            ("has_permissions", flag(self.has_permissions)),
            ("up_to_date_permissions", flag(self.up_to_date_permissions)),
        ]
    }
}

/// What a compare-and-set write found.
pub(crate) enum Written {
    /// Written with this generation.
    Done(i64),
    /// The stored state changed since it was read: nothing written.
    Changed,
}

fn envelope_bson(envelope: &StoredCredential) -> Bson {
    Bson::Document(doc! { "iv": envelope.iv.as_str(), "content": envelope.content.as_str() })
}

fn null_envelope() -> Bson {
    Bson::Document(doc! { "iv": Bson::Null, "content": Bson::Null })
}

/// The directory hash fields of a persisted rotation.
pub(crate) fn rotation_fields(
    access: &StoredCredential,
    refresh: &StoredCredential,
    expires_at: f64,
) -> Vec<(&'static str, String)> {
    vec![
        ("access_token", cache_text(access)),
        ("refresh_token", cache_text(refresh)),
        ("expires_at", dima_text::number_to_string(expires_at)),
        ("has_permissions", "true".to_owned()),
        ("up_to_date_permissions", "true".to_owned()),
    ]
}

/// The directory hash fields of a wipe (the reference's `invalidateStoredTwitchTokens`).
pub(crate) fn wipe_fields() -> Vec<(&'static str, String)> {
    vec![
        ("access_token", String::new()),
        ("refresh_token", String::new()),
        ("expires_at", String::new()),
        ("has_permissions", "false".to_owned()),
        ("up_to_date_permissions", "false".to_owned()),
    ]
}

impl Inner {
    /// The stored Twitch account `id`: the user's `_id`, both envelopes, the expiry, the flags
    /// and the generation.
    pub(crate) async fn load_stored(&self, id: &str) -> Result<Option<StoredAccount>, TwitchError> {
        let raw: Option<RawDocumentBuf> = self
            .mongo_op(
                "find user",
                self.mongo
                    .collection::<RawDocumentBuf>(dima_model::users::COLLECTION)
                    .find_one(dima_model::users::by_account(AccountType::Twitch, id))
                    .projection(doc! { "accounts": 1, "refreshed_at": 1 }),
            )
            .await?;
        let Some(raw) = raw else {
            return Ok(None);
        };
        let generation = Generation::of(
            raw.get("refreshed_at")
                .ok()
                .flatten()
                .and_then(|value| Bson::try_from(value).ok())
                .as_ref(),
        );
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
                has_permissions: account.has_permissions,
                up_to_date_permissions: account.up_to_date_permissions,
                generation: generation.clone(),
            }))
    }

    /// One compare-and-set `updateOne` on the account, advancing the generation.
    async fn compare_and_set(
        &self,
        id: &str,
        stored: &StoredAccount,
        mut set: Document,
    ) -> Result<Written, TwitchError> {
        let now = self.now_ms();
        let generation = stored.generation.next(now);
        set.insert(
            "refreshed_at",
            Bson::DateTime(bson::DateTime::from_millis(generation)),
        );
        let mut ctx = WriteContext::new(now);
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
        Ok(if outcome.matched == 1 {
            Written::Done(generation)
        } else {
            Written::Changed
        })
    }

    /// Stores a rotation over `stored` (the reference's `$set`, plus the generation).
    pub(crate) async fn write_rotation(
        &self,
        id: &str,
        stored: &StoredAccount,
        access: &StoredCredential,
        refresh: &StoredCredential,
        expires_at: f64,
    ) -> Result<Written, TwitchError> {
        let set = doc! {
            "accounts.$.refresh_token": envelope_bson(refresh),
            "accounts.$.access_token": envelope_bson(access),
            "accounts.$.access_token_expires_at": js_number(expires_at),
            "accounts.$.has_permissions": true,
            "accounts.$.up_to_date_permissions": true,
        };
        self.compare_and_set(id, stored, set).await
    }

    /// Wipes `stored` (`invalidateStoredTwitchTokens`: null envelopes and expiry, both flags
    /// false), plus the generation.
    pub(crate) async fn write_wipe(
        &self,
        id: &str,
        stored: &StoredAccount,
    ) -> Result<Written, TwitchError> {
        let set = doc! {
            "accounts.$.refresh_token": null_envelope(),
            "accounts.$.access_token": null_envelope(),
            "accounts.$.access_token_expires_at": Bson::Null,
            "accounts.$.has_permissions": false,
            "accounts.$.up_to_date_permissions": false,
        };
        self.compare_and_set(id, stored, set).await
    }

    /// Advances the generation of `stored` without touching its credentials.
    pub(crate) async fn write_bump(
        &self,
        id: &str,
        stored: &StoredAccount,
    ) -> Result<Written, TwitchError> {
        self.compare_and_set(id, stored, Document::new()).await
    }

    /// Writes credential fields to the directory hash under `generation`; `false` when the
    /// hash already holds a newer generation (nothing written).
    pub(crate) async fn publish(
        &self,
        id: &str,
        generation: i64,
        fields: &[(&'static str, String)],
    ) -> Result<bool, TwitchError> {
        #[cfg(any(test, feature = "test-util"))]
        self.fault(crate::base::FaultPoint::BeforeCacheWrite, id)
            .await;
        let mut args: Vec<&str> = Vec::with_capacity(fields.len() * 2 + 1);
        let generation = generation.to_string();
        args.push(&generation);
        for (name, value) in fields {
            args.push(name);
            args.push(value);
        }
        let reply = WRITE_CREDENTIALS
            .run_value(&self.dragonfly, &[self.config.keys.account(id)], &args)
            .await
            .map_err(|error| TwitchError::cache("write credentials", error))?;
        Ok(reply::int(reply).map_err(|_| TwitchError::Protocol {
            op: "write credentials",
        })? == 1)
    }

    /// Copies MongoDB's state to the directory hash (fenced by its generation).
    pub(crate) async fn publish_stored(
        &self,
        id: &str,
        stored: &StoredAccount,
    ) -> Result<bool, TwitchError> {
        self.publish(id, stored.generation.millis(), &stored.cache_fields())
            .await
    }

    /// [`crate::Twitch::credentials_changed`].
    pub(crate) async fn credentials_changed(&self, id: &str) -> Result<(), TwitchError> {
        for _round in 0..CAS_ROUNDS {
            let Some(stored) = self.load_stored(id).await? else {
                return Ok(());
            };
            if let Written::Done(generation) = self.write_bump(id, &stored).await? {
                self.publish(id, generation, &stored.cache_fields()).await?;
                return Ok(());
            }
        }
        Err(TwitchError::Write(
            "the stored credentials kept changing".to_owned(),
        ))
    }

    /// A cached `has_permissions` that is not `"true"` (generation `cached_generation`): checked
    /// against MongoDB, and the hash repaired when MongoDB says the streamer has permissions.
    /// `true` when it does. The answer "no" is remembered for
    /// [`crate::Timings::permission_recheck`] per streamer and cached generation, so a streamer
    /// who really has none costs one MongoDB read per process in that time.
    pub(crate) async fn recheck_permissions(
        &self,
        id: &str,
        cached_generation: i64,
    ) -> Result<bool, TwitchError> {
        let window = self.config.timings.permission_recheck;
        if self.permission_checked_recently(id, cached_generation, window) {
            return Ok(false);
        }
        let Some(stored) = self.load_stored(id).await? else {
            return Ok(false);
        };
        if stored.has_permissions {
            self.publish_stored(id, &stored).await?;
            return Ok(true);
        }
        let mut checks = self
            .permission_checks
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if checks.len() >= MAX_PERMISSION_CHECKS {
            checks.clear();
        }
        checks.insert(id.to_owned(), (cached_generation, Instant::now()));
        Ok(false)
    }

    fn permission_checked_recently(&self, id: &str, generation: i64, window: Duration) -> bool {
        let checks = self
            .permission_checks
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        checks
            .get(id)
            .is_some_and(|(seen, at)| *seen == generation && at.elapsed() < window)
    }
}

/// The per-process memory of [`Inner::recheck_permissions`].
pub(crate) type PermissionChecks = std::sync::Mutex<HashMap<String, (i64, Instant)>>;
