//! The streamer directory (`classes/twitch_streamers.class.ts`).
//!
//! **What it holds.** One Dragonfly hash per streamer, `accounts:twitch:{id}:data`, with the
//! account as strings: `id`, `name`, `email`, `plan_tier`, `plan_tier_until`
//! (`Date.toDateString()` in UTC), `polar_sh_customer_id`, the decrypted `refresh_token` and
//! `access_token`, `expires_at` (epoch seconds), the four flags as `"true"`/`"false"`, and the
//! plan fence version `__polar_plan_version`; the set `streamers:by:id`; and the aggregate
//! `twitch:accounts` (`EX 3600`) for the list read. MongoDB (`users`) is the source of truth.
//!
//! **How it is loaded.** [`Twitch::load_streamers`] at start-up (the API, the bot and several
//! cron workers call `getTwitchAccountsFromDB` when they start): every user with a Twitch
//! account, in natural order, written through `WRITE_PLAN_ACCOUNT_SCRIPT` (refused when billing's
//! plan fence is newer), then added to `streamers:by:id`.
//!
//! **How one streamer is refreshed.** [`Twitch::streamer`] reads the hash and its fence in one
//! atomic script; a missing, incomplete or fenced-out hash is hydrated from MongoDB again (one
//! hydration per streamer at a time in a process; the others wait for it).
//!
//! **How the processes hear about a change.** They share the hash: a refresh, a sign-in, a
//! revocation or a plan change in one process is what the next read in every other process
//! sees. The reference has no pub/sub for it and none is added: an in-memory copy would need
//! every writer of the hash, in several later packages, to announce its changes. A read is one
//! Dragonfly round trip (the reference makes two).
//!
//! **What expires.** Only the aggregate (`EX 3600`). The hashes and the set never expire;
//! billing's plan invalidation deletes a hash, and the next read hydrates it.
//!
//! **Quirk kept** (`MIGRATION.md` section 3, behaviour-preserving port): a stored envelope whose
//! IV is malformed makes the reference's `decrypt` throw, which stops the whole start-up load at
//! that user (the ones before it are loaded). [`Twitch::load_streamers`] does the same and
//! returns the error; the real-data test counts such envelopes in the production copy (none).
//!
//! **Intended difference**: the list read finds account hashes with `SCAN`, not `KEYS` (same
//! result, without blocking the server).

use crate::base::{Inner, Twitch};
use crate::error::TwitchError;
use crate::events::{Destination, Level};
use crate::secret::{AccessToken, RefreshToken};
use bson::{Document, RawDocumentBuf, doc};
use dima_core::crypto::{CipherError, CredentialCipher};
use dima_model::users::{Account, AccountType, EncryptedToken, User};
use dima_store::dragonfly::commands::reply;
use dima_store::dragonfly::plan_cache_fence::{
    CHECK_PLAN_ACCOUNTS, PLAN_CACHE_VERSION_FIELD, READ_PLAN_ACCOUNT, WRITE_PLAN_ACCOUNT,
    plan_cache_version,
};
use dima_store::mongo::WriteContext;
use dima_store::mongo::filter::prepare_filter;
use futures_util::TryStreamExt;
use redis::Value as Reply;
use serde_json::{Map, Value, json};
use std::fmt;
use std::sync::Arc;

/// `PLAN_ACCOUNT_FIELDS`: what the directory reads of a user.
const PLAN_ACCOUNT_FIELDS: [&str; 6] = [
    "accounts",
    "plan_tier",
    "plan_tier_until",
    "polar_sh_customer_id",
    "polar_plan_event_at",
    "polar_plan_event_key",
];
/// Most account hashes the list read collects (a runaway bound; production has a few hundred).
const MAX_LISTED_ACCOUNTS: usize = 20_000;
/// Fields and bytes a single hash may hold for [`Twitch::streamer`] (the store script's bounds).
const READ_MAX_FIELDS: usize = 256;
const READ_MAX_BYTES: usize = 64 * 1024;

/// One streamer as the directory holds it (`IUsersCache`): the hash's string fields in the
/// order the server returns them, without the internal plan version. `Debug` shows the id and
/// the name only: the fields include both tokens and the e-mail.
#[derive(Clone, PartialEq, Eq)]
pub struct StreamerAccount {
    fields: Vec<(String, String)>,
}

impl fmt::Debug for StreamerAccount {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("StreamerAccount")
            .field("id", &self.id())
            .field("name", &self.name())
            .finish_non_exhaustive()
    }
}

impl StreamerAccount {
    /// From a hash's fields (the internal plan version is dropped: `publicAccount`).
    pub fn from_fields(fields: Vec<(String, String)>) -> Self {
        Self {
            fields: fields
                .into_iter()
                .filter(|(name, _)| name != PLAN_CACHE_VERSION_FIELD)
                .collect(),
        }
    }

    /// Every field (tokens and e-mail included: never log them).
    pub fn fields(&self) -> &[(String, String)] {
        &self.fields
    }

    /// One field, as stored.
    pub fn field(&self, name: &str) -> Option<&str> {
        self.fields
            .iter()
            .find(|(key, _)| key == name)
            .map(|(_, value)| value.as_str())
    }

    /// `id` (`""` when absent).
    pub fn id(&self) -> &str {
        self.field("id").unwrap_or_default()
    }

    /// `name`, the Twitch login (`""` when absent).
    pub fn name(&self) -> &str {
        self.field("name").unwrap_or_default()
    }

    /// `email` (private).
    pub fn email(&self) -> Option<&str> {
        self.field("email")
    }

    /// `plan_tier` as stored (`free`, `premium`, `pro`).
    pub fn plan_tier(&self) -> Option<&str> {
        self.field("plan_tier")
    }

    /// `plan_tier_until` (`Wed Nov 11 2026` or `""`).
    pub fn plan_tier_until(&self) -> Option<&str> {
        self.field("plan_tier_until")
    }

    /// `polar_sh_customer_id` (private).
    pub fn polar_sh_customer_id(&self) -> Option<&str> {
        self.field("polar_sh_customer_id")
    }

    /// `expires_at`: epoch seconds as text, when present.
    pub fn expires_at(&self) -> Option<&str> {
        self.field("expires_at")
    }

    /// The access token, when not empty.
    pub fn access_token(&self) -> Option<AccessToken> {
        self.field("access_token")
            .filter(|token| !token.is_empty())
            .map(AccessToken::new)
    }

    /// The refresh token, when not empty.
    pub fn refresh_token(&self) -> Option<RefreshToken> {
        self.field("refresh_token")
            .filter(|token| !token.is_empty())
            .map(RefreshToken::new)
    }

    /// `actived === 'true'`.
    pub fn actived(&self) -> bool {
        self.field("actived") == Some("true")
    }

    /// `chat_enabled === 'true'`.
    pub fn chat_enabled(&self) -> bool {
        self.field("chat_enabled") == Some("true")
    }

    /// `has_permissions === 'true'` (the streamer header's gate).
    pub fn has_permissions(&self) -> bool {
        self.field("has_permissions") == Some("true")
    }

    /// `up_to_date_permissions === 'true'`.
    pub fn up_to_date_permissions(&self) -> bool {
        self.field("up_to_date_permissions") == Some("true")
    }
}

/// `decrypt(hash)` of a stored envelope: `None` when it is missing or either part is empty.
pub(crate) fn decrypt_envelope(
    cipher: &CredentialCipher,
    envelope: &EncryptedToken,
) -> Result<Option<String>, CipherError> {
    cipher.decrypt_fields(envelope.iv.as_deref(), envelope.content.as_deref())
}

/// `String(access_token_expires_at)` when the value is truthy (a stored `0` counts as unset).
pub(crate) fn persisted_expires_at(account: &Account) -> Option<String> {
    account
        .access_token_expires_at
        .map(|number| number.0)
        .filter(|value| *value != 0.0 && !value.is_nan())
        .map(dima_text::number_to_string)
}

/// The cache payload the reference builds for a user (`IUsersCache`), in its key order;
/// `expires_at` is left out when neither the cache nor the document has one
/// (`sanitizeCachePayload` drops `undefined`).
pub(crate) fn cache_fields(
    user: &User,
    account: &Account,
    existing_expires_at: Option<String>,
    cipher: &CredentialCipher,
) -> Result<Vec<(&'static str, String)>, CipherError> {
    let flag = |value: bool| if value { "true" } else { "false" }.to_owned();
    let plan_tier_until = user.plan_tier_until.map_or_else(String::new, |date| {
        dima_text::to_date_string_utc(date.0).unwrap_or_else(|| "Invalid Date".to_owned())
    });
    let mut fields = vec![
        ("id", account.id.clone().unwrap_or_default()),
        ("name", account.name.clone().unwrap_or_default()),
        (
            "email",
            account
                .email
                .as_ref()
                .map(|email| email.expose().clone())
                .unwrap_or_default(),
        ),
        ("plan_tier", user.plan_tier.as_str().to_owned()),
        ("plan_tier_until", plan_tier_until),
        (
            "polar_sh_customer_id",
            user.polar_sh_customer_id
                .as_ref()
                .map(|id| id.expose().clone())
                .unwrap_or_default(),
        ),
        (
            "refresh_token",
            decrypt_envelope(cipher, account.refresh_token.expose())?.unwrap_or_default(),
        ),
        (
            "access_token",
            decrypt_envelope(cipher, account.access_token.expose())?.unwrap_or_default(),
        ),
    ];
    if let Some(expires_at) = existing_expires_at
        .filter(|value| !value.is_empty())
        .or_else(|| persisted_expires_at(account))
    {
        fields.push(("expires_at", expires_at));
    }
    fields.push(("actived", flag(account.actived)));
    fields.push(("chat_enabled", flag(account.chat_enabled)));
    fields.push(("has_permissions", flag(account.has_permissions)));
    fields.push((
        "up_to_date_permissions",
        flag(account.up_to_date_permissions),
    ));
    Ok(fields)
}

/// The atomic read of one hash and its fence.
enum HashRead {
    Accepted(Vec<(String, String)>),
    Stale,
    Missing,
    TooLarge,
}

fn text(value: Reply) -> Result<String, TwitchError> {
    let bytes = reply::bytes(value).map_err(|_| TwitchError::Protocol { op: "read account" })?;
    String::from_utf8(bytes).map_err(|_| TwitchError::Protocol { op: "read account" })
}

fn decode_read(value: Reply) -> Result<HashRead, TwitchError> {
    let protocol = || TwitchError::Protocol { op: "read account" };
    let mut parts = reply::array(value).map_err(|_| protocol())?.into_iter();
    let status = parts
        .next()
        .map(reply::int)
        .transpose()
        .map_err(|_| protocol())?
        .ok_or_else(protocol)?;
    let fields = parts
        .next()
        .map(reply::array)
        .transpose()
        .map_err(|_| protocol())?
        .unwrap_or_default();
    Ok(match status {
        1 => {
            let mut pairs = Vec::with_capacity(fields.len() / 2);
            let mut values = fields.into_iter();
            while let (Some(name), Some(value)) = (values.next(), values.next()) {
                pairs.push((text(name)?, text(value)?));
            }
            HashRead::Accepted(pairs)
        }
        0 => HashRead::Missing,
        -1 => HashRead::Stale,
        -2 => HashRead::TooLarge,
        _ => return Err(protocol()),
    })
}

/// The filter and projection of the directory's user reads.
fn plan_projection() -> Document {
    let mut projection = Document::new();
    for field in PLAN_ACCOUNT_FIELDS {
        projection.insert(field, 1);
    }
    projection
}

impl Inner {
    /// `WRITE_PLAN_ACCOUNT_SCRIPT`: `false` when billing's fence is newer than the user's plan.
    async fn write_account(
        &self,
        user: &User,
        id: &str,
        fields: &[(&'static str, String)],
    ) -> Result<bool, TwitchError> {
        let version = plan_cache_version(
            user.polar_plan_event_at.map(|date| date.0),
            user.polar_plan_event_key.as_deref(),
        )
        .map_err(|error| TwitchError::cache("write account", error))?;
        let keys = &self.config.keys;
        let script_keys = [keys.plan_fence(id), keys.account(id), keys.aggregate()];
        let mut args: Vec<&str> = Vec::with_capacity(fields.len() * 2 + 3);
        args.push(&version);
        for (name, value) in fields {
            args.push(name);
            args.push(value);
        }
        args.push(PLAN_CACHE_VERSION_FIELD);
        args.push(&version);
        let reply = WRITE_PLAN_ACCOUNT
            .run_value(&self.dragonfly, &script_keys, &args)
            .await
            .map_err(|error| TwitchError::cache("write account", error))?;
        Ok(reply::int(reply).map_err(|_| TwitchError::Protocol {
            op: "write account",
        })? == 1)
    }

    /// `hydrateTwitchAccountById` without the single flight.
    async fn hydrate_now(&self, id: &str) -> Result<Option<StreamerAccount>, TwitchError> {
        let keys = &self.config.keys;
        for _attempt in 0..2 {
            let mut ctx = WriteContext::new(self.now_ms());
            let filter = prepare_filter(
                dima_model::users::INFO.schema,
                &dima_model::users::by_account(AccountType::Twitch, id),
                &mut ctx,
            )
            .map_err(|error| TwitchError::mongo("find user", error))?;
            let raw: Option<RawDocumentBuf> = self
                .mongo_op(
                    "find user",
                    self.mongo
                        .collection::<RawDocumentBuf>(dima_model::users::COLLECTION)
                        .find_one(filter)
                        .projection(plan_projection()),
                )
                .await?;
            let Some(raw) = raw else {
                return Ok(None);
            };
            let user: User =
                dima_model::decode(&raw).map_err(|error| TwitchError::Decode(error.to_string()))?;
            let Some(account) = user.accounts.iter().find(|account| {
                account.kind.is(AccountType::Twitch) && account.id.as_deref() == Some(id)
            }) else {
                return Ok(None);
            };
            let existing = self.hget_text(&keys.account(id), "expires_at").await?;
            let fields = cache_fields(&user, account, existing, &self.cipher)?;
            if !self.write_account(&user, id, &fields).await? {
                continue;
            }
            self.sadd(&keys.streamer_ids(), id).await?;
            self.streamer_seen(id, account.name.as_deref().unwrap_or_default());
            return Ok(Some(StreamerAccount::from_fields(
                fields
                    .into_iter()
                    .map(|(name, value)| (name.to_owned(), value))
                    .collect(),
            )));
        }
        Ok(None)
    }

    /// Hydration with one flight per streamer in this process.
    pub(crate) async fn hydrate(
        self: &Arc<Self>,
        id: &str,
    ) -> Result<Option<StreamerAccount>, TwitchError> {
        if self.shutdown.is_triggered() {
            return Err(TwitchError::Shutdown);
        }
        let inner = Arc::clone(self);
        let key = id.to_owned();
        let kill = self.kill.clone();
        let waiter = self
            .hydrate_flights
            .join(
                key.clone(),
                &self.tracker,
                Err(TwitchError::Interrupted),
                move || async move {
                    tokio::select! {
                        biased;
                        () = kill.cancelled() => Err(TwitchError::Interrupted),
                        result = inner.hydrate_now(&key) => result,
                    }
                },
            )
            .ok_or(TwitchError::Busy)?;
        let result = waiter.await;
        if let Err(error) = &result {
            self.log(
                Level::Error,
                Destination::Both,
                None,
                json!({
                    "function": "TwitchStreamers.hydrateTwitchAccountById",
                    "id": id,
                    "error": error.to_string(),
                }),
            );
        }
        result
    }

    /// `HGET` of a text field (`None` when missing; not UTF-8 is a protocol error).
    pub(crate) async fn hget_text(
        &self,
        key: &str,
        field: &str,
    ) -> Result<Option<String>, TwitchError> {
        let value = self
            .dragonfly
            .hget(key, field)
            .await
            .map_err(|error| TwitchError::cache("hget", error))?;
        value
            .map(|bytes| String::from_utf8(bytes).map_err(|_| TwitchError::Protocol { op: "hget" }))
            .transpose()
    }

    async fn sadd(&self, key: &str, member: &str) -> Result<(), TwitchError> {
        self.dragonfly
            .query_value(redis::cmd("SADD").arg(key).arg(member))
            .await
            .map(|_| ())
            .map_err(|error| TwitchError::cache("sadd", error))
    }

    /// `getTwitchAccountById` with errors returned.
    pub(crate) async fn account(
        self: &Arc<Self>,
        id: &str,
    ) -> Result<Option<StreamerAccount>, TwitchError> {
        let keys = &self.config.keys;
        let script_keys = [keys.account(id), keys.plan_fence(id)];
        let args = [READ_MAX_FIELDS.to_string(), READ_MAX_BYTES.to_string()];
        let reply = READ_PLAN_ACCOUNT
            .run_value(&self.dragonfly, &script_keys, &args)
            .await
            .map_err(|error| TwitchError::cache("read account", error))?;
        match decode_read(reply)? {
            HashRead::Accepted(fields) => Ok(Some(StreamerAccount::from_fields(fields))),
            HashRead::Missing | HashRead::Stale => self.hydrate(id).await,
            HashRead::TooLarge => Err(TwitchError::Protocol { op: "read account" }),
        }
    }

    /// `CHECK_PLAN_ACCOUNTS_SCRIPT` over `accounts`, publishing `aggregate` when given.
    async fn check_versions(
        &self,
        accounts: &[Vec<(String, String)>],
        aggregate: Option<&str>,
    ) -> Result<bool, TwitchError> {
        let keys = &self.config.keys;
        let field = |account: &[(String, String)], name: &str| {
            account
                .iter()
                .find(|(key, _)| key == name)
                .map(|(_, value)| value.clone())
                .unwrap_or_default()
        };
        let mut script_keys = Vec::with_capacity(accounts.len() + 1);
        let mut args = Vec::with_capacity(accounts.len() + 1);
        for account in accounts {
            script_keys.push(keys.plan_fence(&field(account, "id")));
            args.push(field(account, PLAN_CACHE_VERSION_FIELD));
        }
        script_keys.push(keys.aggregate());
        args.push(aggregate.unwrap_or_default().to_owned());
        let reply = CHECK_PLAN_ACCOUNTS
            .run_value(&self.dragonfly, &script_keys, &args)
            .await
            .map_err(|error| TwitchError::cache("check accounts", error))?;
        Ok(reply::int(reply).map_err(|_| TwitchError::Protocol {
            op: "check accounts",
        })? == 1)
    }

    /// `getTwitchAccountsFromCache` with errors returned.
    async fn cached_accounts(&self) -> Result<Vec<StreamerAccount>, TwitchError> {
        let keys = &self.config.keys;
        for _attempt in 0..2 {
            let cached = self
                .dragonfly
                .get_text(&keys.aggregate())
                .await
                .map_err(|error| TwitchError::cache("get accounts", error))?;
            if let Some(cached) = cached {
                let accounts = parse_aggregate(&cached)?;
                if self.check_versions(&accounts, None).await? {
                    return Ok(accounts
                        .into_iter()
                        .map(StreamerAccount::from_fields)
                        .collect());
                }
            }
            let mut accounts = Vec::new();
            let mut scan = self.dragonfly.scan(&keys.account_pattern(), Some(500));
            while let Some(page) = scan
                .next_page()
                .await
                .map_err(|error| TwitchError::cache("scan accounts", error))?
            {
                for key in page {
                    let key = String::from_utf8(key).map_err(|_| TwitchError::Protocol {
                        op: "scan accounts",
                    })?;
                    let account = self
                        .dragonfly
                        .hgetall(&key)
                        .await
                        .map_err(|error| TwitchError::cache("hgetall", error))?;
                    if account
                        .iter()
                        .any(|(name, value)| name == "id" && !value.is_empty())
                    {
                        accounts.push(account);
                    }
                    if accounts.len() >= MAX_LISTED_ACCOUNTS {
                        break;
                    }
                }
                if accounts.len() >= MAX_LISTED_ACCOUNTS {
                    break;
                }
            }
            let aggregate = aggregate_json(&accounts);
            if self.check_versions(&accounts, Some(&aggregate)).await? {
                return Ok(accounts
                    .into_iter()
                    .map(StreamerAccount::from_fields)
                    .collect());
            }
        }
        Ok(Vec::new())
    }
}

/// The aggregate as Rust writes it: a JSON array of the hashes' fields in server order.
fn aggregate_json(accounts: &[Vec<(String, String)>]) -> String {
    Value::Array(
        accounts
            .iter()
            .map(|account| {
                Value::Object(
                    account
                        .iter()
                        .map(|(name, value)| (name.clone(), Value::String(value.clone())))
                        .collect::<Map<_, _>>(),
                )
            })
            .collect(),
    )
    .to_string()
}

/// `JSON.parse(twitch:accounts)`; anything but an array of objects is an error (the reference
/// throws in `accounts.map`). Values that are not strings are skipped.
fn parse_aggregate(raw: &str) -> Result<Vec<Vec<(String, String)>>, TwitchError> {
    let protocol = || TwitchError::Protocol { op: "get accounts" };
    let value: Value = serde_json::from_str(raw).map_err(|_| protocol())?;
    let Value::Array(items) = value else {
        return Err(protocol());
    };
    items
        .into_iter()
        .map(|item| match item {
            Value::Object(map) => Ok(map
                .into_iter()
                .filter_map(|(name, value)| match value {
                    Value::String(text) => Some((name, text)),
                    _ => None,
                })
                .collect()),
            _ => Err(protocol()),
        })
        .collect()
}

impl Twitch {
    /// `getTwitchAccountsFromDB`: loads every user with a Twitch account into the directory and
    /// returns the ids written (users whose plan fence is newer are skipped, as in the
    /// reference). Called at start-up by the API, the bot and the cron workers that need it.
    pub async fn load_streamers(&self) -> Result<Vec<String>, TwitchError> {
        let result = self.load_streamers_inner().await;
        match &result {
            Ok(_) => self.inner.log(
                Level::Info,
                Destination::Console,
                None,
                json!({ "message": "Accounts added to cache" }),
            ),
            Err(error) => self.inner.log(
                Level::Error,
                Destination::Both,
                None,
                json!({
                    "function": "TwitchStreamers.getTwitchAccountsFromDB",
                    "error": error.to_string(),
                }),
            ),
        }
        result
    }

    async fn load_streamers_inner(&self) -> Result<Vec<String>, TwitchError> {
        let inner = &self.inner;
        let keys = &inner.config.keys;
        let mut ctx = WriteContext::new(inner.now_ms());
        let filter = prepare_filter(
            dima_model::users::INFO.schema,
            &doc! { "accounts.type": "twitch" },
            &mut ctx,
        )
        .map_err(|error| TwitchError::mongo("find users", error))?;
        let mut cursor = inner
            .mongo_op(
                "find users",
                inner
                    .mongo
                    .collection::<RawDocumentBuf>(dima_model::users::COLLECTION)
                    .find(filter)
                    .projection(plan_projection()),
            )
            .await?;
        inner
            .dragonfly
            .del(&[&keys.aggregate()])
            .await
            .map_err(|error| TwitchError::cache("del accounts", error))?;
        let mut accepted = Vec::new();
        while let Some(raw) = inner.mongo_op("find users", cursor.try_next()).await? {
            let user: User = match dima_model::decode(&raw) {
                Ok(user) => user,
                Err(error) => {
                    // Mongoose's lean read has no decode step; a document Rust cannot read is
                    // skipped and named (the real-data test shows none).
                    inner.log(
                        Level::Error,
                        Destination::Both,
                        None,
                        json!({
                            "function": "TwitchStreamers.getTwitchAccountsFromDB",
                            "action": "user_skipped",
                            "error": error.to_string(),
                        }),
                    );
                    continue;
                }
            };
            let Some(account) = user.twitch() else {
                continue;
            };
            let id = account.id.clone().unwrap_or_default();
            let existing = inner.hget_text(&keys.account(&id), "expires_at").await?;
            let fields = cache_fields(&user, account, existing, &inner.cipher)?;
            if !inner.write_account(&user, &id, &fields).await? {
                continue;
            }
            inner.sadd(&keys.streamer_ids(), &id).await?;
            inner.streamer_seen(&id, account.name.as_deref().unwrap_or_default());
            accepted.push(id);
        }
        Ok(accepted)
    }

    /// `getTwitchAccountById`: the streamer's directory entry, hydrated from MongoDB when the
    /// hash is missing, incomplete or older than the plan fence; `None` when there is no such
    /// Twitch account (errors are logged and also give `None`, as in the reference).
    pub async fn streamer(&self, id: &str) -> Option<StreamerAccount> {
        match self.inner.account(id).await {
            Ok(account) => account,
            Err(error) => {
                self.inner.log(
                    Level::Error,
                    Destination::Both,
                    None,
                    json!({
                        "function": "TwitchStreamers.getTwitchAccountById",
                        "id": id,
                        "error": error.to_string(),
                    }),
                );
                None
            }
        }
    }

    /// [`Twitch::streamer`] with the error returned instead of logged.
    pub async fn try_streamer(&self, id: &str) -> Result<Option<StreamerAccount>, TwitchError> {
        self.inner.account(id).await
    }

    /// `getTwitchAccountsFromCache`: every streamer in the directory (the aggregate when its
    /// versions still hold, else every hash, published as the new aggregate); empty on error.
    pub async fn cached_streamers(&self) -> Vec<StreamerAccount> {
        match self.inner.cached_accounts().await {
            Ok(accounts) => accounts,
            Err(error) => {
                self.inner.log(
                    Level::Error,
                    Destination::Both,
                    None,
                    json!({
                        "function": "TwitchStreamers.getTwitchAccountsFromCache",
                        "error": error.to_string(),
                    }),
                );
                Vec::new()
            }
        }
    }

    /// `getTwitchStreamers`: the members of `streamers:by:id` (server order); empty on error.
    pub async fn streamer_ids(&self) -> Vec<String> {
        let key = self.inner.config.keys.streamer_ids();
        let result: Result<Vec<String>, _> = self
            .inner
            .dragonfly
            .query(redis::cmd("SMEMBERS").arg(&key))
            .await;
        match result {
            Ok(ids) => ids,
            Err(error) => {
                self.inner.log(
                    Level::Error,
                    Destination::Both,
                    None,
                    json!({
                        "function": "TwitchStreamers.getTwitchStreamers",
                        "error": error.to_string(),
                    }),
                );
                Vec::new()
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_account_never_prints_tokens_and_drops_the_version() {
        let account = StreamerAccount::from_fields(vec![
            ("id".into(), "42".into()),
            ("name".into(), "chan".into()),
            ("access_token".into(), "secret-access".into()),
            ("refresh_token".into(), "".into()),
            (PLAN_CACHE_VERSION_FIELD.into(), "v".into()),
            ("has_permissions".into(), "true".into()),
        ]);
        let text = format!("{account:?}");
        assert!(!text.contains("secret-access"), "{text}");
        assert!(account.field(PLAN_CACHE_VERSION_FIELD).is_none());
        assert!(account.access_token().is_some());
        assert!(account.refresh_token().is_none());
        assert!(account.has_permissions() && !account.chat_enabled());
    }

    #[test]
    fn the_aggregate_round_trips_in_server_order() {
        let accounts = vec![vec![
            ("id".to_owned(), "1".to_owned()),
            ("name".to_owned(), "é 👋".to_owned()),
        ]];
        let raw = aggregate_json(&accounts);
        assert_eq!(raw, r#"[{"id":"1","name":"é 👋"}]"#);
        assert_eq!(parse_aggregate(&raw).unwrap(), accounts);
        assert!(parse_aggregate("{").is_err());
        assert!(parse_aggregate("{}").is_err());
        assert!(parse_aggregate("[1]").is_err());
    }
}
