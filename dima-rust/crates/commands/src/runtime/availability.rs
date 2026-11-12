//! Enabling and disabling commands and channel-point rewards, now or for a number of seconds
//! (reference: `utils/availability/service.ts`; the hook it drives is
//! [`dima_model::availability`]).
//!
//! Callers: `!enable`/`!disable` (bot), the `$(enable.command)`, `$(disable.command)`,
//! `$(enable.redemption)` and `$(disable.redemption)` functions (any process that evaluates a
//! command), and the cron's recovery every 2 s (`workers/timer.worker.ts:235`), which calls
//! [`Availability::recover`].
//!
//! # How a change is kept
//!
//! [`Availability::set`] writes the desired state and its restoration in one update, fenced by
//! the value and state token it read (five attempts against concurrent changes), then
//! synchronises. **MongoDB is written first**: the stored state is the truth and carries
//! `pending: true` until the outside effect is confirmed. [`Availability::synchronize`] takes a
//! 60 s lease on the document (`availabilityLease`, one synchroniser per target across every
//! process), renews it on each of at most four passes, applies a due restoration, performs the
//! effect, then clears `pending` (or the whole state) fenced by the state's token, so a newer
//! change is never overwritten; the lease is released at the end. The effect of a command is
//! the cache invalidation of its name (see below); of a reward, one Helix `PATCH
//! /channel_points/custom_rewards` with `{is_enabled}`.
//!
//! A failed effect stores `availability.nextAt` 30 s ahead (never past the restoration) and the
//! caller gets "State saved; synchronization will retry automatically: …". A process that dies
//! between the write and the effect leaves `pending` with `nextAt` at the write: the recovery
//! picks it up within seconds (after the dead owner's lease ran out). The stored state and
//! Twitch therefore never disagree silently: until Twitch confirmed, the document says
//! `pending` and the recovery keeps trying.
//!
//! **A toggle is sent at most once per synchronisation pass**, never retried inside one (no
//! 401 retry, no transport retry: the Helix provider has none). The request sets an absolute
//! state, so the recovery's later attempt for the same state is harmless; a pass whose request
//! timed out or lost its connection after sending reports the outcome as unknown
//! ([`ToggleError::Unknown`]) and leaves the state pending, and the recovery resends the same
//! state 30 s later.
//!
//! # Commands and the cache
//!
//! The reference changes `enabled` and only afterwards deletes the cached command, so a reader
//! in between can store the old command again for an hour. Here every write that changes a
//! command's `enabled` runs inside [`CommandCache::write`] for its name, and the effect is an
//! invalidation of the name.
//!
//! # Intended differences
//!
//! - Helix errors keep the reference's texts where Twitch answered (`message` of its error
//!   body, "Twitch rejected the reward update", "Twitch did not confirm the reward state"); a
//!   request that failed without an answer says whether it may have arrived.
//! - The recovery returns what it did ([`Recovery`]) instead of printing it.

use std::future::Future;
use std::sync::Arc;
use std::time::Duration;

use bson::oid::ObjectId;
use bson::{Bson, Document, Regex, doc};
use dima_core::{Clock, Random};
use dima_http::Path;
use dima_model::availability::{Writer, state as availability_state};
use dima_model::{commands, redemption_rewards};
use dima_store::mongo::WriteContext;
use dima_store::mongo::date::JsDate;
use dima_store::mongo::update::{PreparedFindAndModify, PreparedUpdate, Returned};
use dima_twitch::{Auth, HelixError, HelixRequest, Twitch};
use futures_util::TryStreamExt;
use serde_json::Value;

use super::lookup::{CommandCache, Names, WriteFailure};
use super::{RuntimeError, Stores, within};
use crate::value::js_truthy;

/// The longest timed change, in seconds (7 days).
pub const MAX_AVAILABILITY_SECONDS: u32 = 604_800;
/// A synchroniser's lease, in milliseconds.
pub const LEASE_MS: i64 = 60_000;
/// Delay before a failed effect is tried again, in milliseconds.
pub const RETRY_MS: i64 = 30_000;
/// Attempts of [`Availability::set`] against concurrent changes.
pub const SET_ATTEMPTS: usize = 5;
/// Passes of one [`Availability::synchronize`].
pub const SYNC_PASSES: usize = 4;
/// Documents one [`Availability::recover`] takes per target.
pub const RECOVERY_BATCH: i64 = 100;
/// Synchronisations [`Availability::recover`] runs at once.
pub const RECOVERY_CONCURRENCY: usize = 5;
/// The reference's deadline of the reward `PATCH`.
pub const REWARD_TOGGLE_TIMEOUT: Duration = Duration::from_secs(15);

/// What can be enabled or disabled (the reference's adapter registry, in its order).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Target {
    /// A chat command (`commands.enabled`).
    Command,
    /// A channel-point reward (`redemptionrewards.isEnabled`).
    Redemption,
}

impl Target {
    /// Every target, in the registry's order.
    pub const ALL: [Self; 2] = [Self::Command, Self::Redemption];

    /// The adapter's name (`command`, `redemption`), used in the function names.
    pub fn name(self) -> &'static str {
        match self {
            Self::Command => "command",
            Self::Redemption => "redemption",
        }
    }

    /// `getAvailabilityAdapter(kind)`.
    pub fn from_name(kind: &str) -> Result<Self, AvailabilityError> {
        Self::ALL
            .into_iter()
            .find(|target| target.name() == kind)
            .ok_or_else(|| AvailabilityError::Refused(format!("Unsupported availability target: {kind}")))
    }

    fn collection(self) -> &'static str {
        match self {
            Self::Command => commands::COLLECTION,
            Self::Redemption => redemption_rewards::COLLECTION,
        }
    }

    fn enabled_field(self) -> &'static str {
        match self {
            Self::Command => "enabled",
            Self::Redemption => "isEnabled",
        }
    }
}

/// Why a change was not made or not confirmed. The text is what the reference's caller shows.
#[derive(Debug, thiserror::Error)]
pub enum AvailabilityError {
    /// Refused before anything was written (bad input, unknown or ambiguous target, a
    /// non-Twitch reward, too many concurrent changes).
    #[error("{0}")]
    Refused(String),
    /// The state was saved but its effect failed; the recovery retries it.
    #[error("State saved; synchronization will retry automatically: {0}")]
    Pending(String),
    /// A store failed.
    #[error(transparent)]
    Store(#[from] RuntimeError),
}

impl AvailabilityError {
    /// The `!enable`/`!disable` status: 404 when the text says "not found", else 500.
    pub fn status(&self) -> u16 {
        if dima_text::to_lower(&self.to_string()).contains("not found") {
            404
        } else {
            500
        }
    }
}

/// Why the reward toggle failed.
#[derive(Clone, Debug, PartialEq, Eq, thiserror::Error)]
pub enum ToggleError {
    /// Twitch answered and did not apply it, or the request was never sent.
    #[error("{0}")]
    Refused(String),
    /// The request may have reached Twitch (a timeout, a lost connection).
    #[error("{0}")]
    Unknown(String),
}

/// The reward toggle on Twitch.
pub trait RewardToggle: Send + Sync {
    /// Sets the reward's `is_enabled` and checks that Twitch confirms it. Sends at most one
    /// request.
    fn set_enabled<'a>(
        &'a self,
        channel_id: &'a str,
        reward_id: &'a str,
        enabled: bool,
    ) -> impl Future<Output = Result<(), ToggleError>> + Send + 'a;
}

/// [`RewardToggle`] through the Twitch crate's Helix wrapper, as the streamer
/// (`getTwitchStreamerHeaderById`, no 401 retry), within [`REWARD_TOGGLE_TIMEOUT`].
#[derive(Clone, Debug)]
pub struct TwitchRewardToggle {
    twitch: Twitch,
    timeout: Duration,
}

impl TwitchRewardToggle {
    /// A toggle over `twitch` with the reference's deadline.
    pub fn new(twitch: Twitch) -> Self {
        Self {
            twitch,
            timeout: REWARD_TOGGLE_TIMEOUT,
        }
    }

    /// Another deadline (tests).
    pub fn with_timeout(mut self, timeout: Duration) -> Self {
        self.timeout = timeout;
        self
    }
}

/// The largest Helix answer read.
const MAX_ANSWER_BYTES: usize = 64 * 1024;

impl RewardToggle for TwitchRewardToggle {
    async fn set_enabled(
        &self,
        channel_id: &str,
        reward_id: &str,
        enabled: bool,
    ) -> Result<(), ToggleError> {
        let request = HelixRequest::patch(
            Path::fixed("/channel_points/custom_rewards"),
            Auth::Streamer(channel_id.to_owned()),
        )
        .query("broadcaster_id", channel_id)
        .query("id", reward_id)
        .json(serde_json::json!({ "is_enabled": enabled }))
        .timeout(self.timeout)
        .operation("availability_reward_toggle");
        let response = match self.twitch.helix(request).await {
            Ok(response) => response,
            Err(HelixError::Credential { error, .. }) => {
                return Err(ToggleError::Refused(error.message()));
            }
            Err(HelixError::Http(error)) => return Err(http_failure(&error)),
        };
        let ok = response.status().is_success();
        let body = match response.into_response().bytes().await {
            Ok(body) if body.len() <= MAX_ANSWER_BYTES => body,
            Ok(_) => return Err(answer_failure(ok, "Twitch's answer is too large")),
            Err(error) => return Err(answer_failure(ok, &http_failure(&error).to_string())),
        };
        let Ok(result) = serde_json::from_slice::<Value>(&body) else {
            return Err(answer_failure(ok, "Twitch's answer is not JSON"));
        };
        if !ok || result.get("error").is_some_and(js_truthy) {
            let message = match result.get("message") {
                Some(Value::String(text)) if !text.is_empty() => text.clone(),
                _ => "Twitch rejected the reward update".to_owned(),
            };
            return Err(ToggleError::Refused(message));
        }
        let confirmed = result
            .get("data")
            .and_then(|data| data.get(0))
            .and_then(|first| first.get("is_enabled"));
        if confirmed != Some(&Value::Bool(enabled)) {
            return Err(ToggleError::Refused(
                "Twitch did not confirm the reward state".to_owned(),
            ));
        }
        Ok(())
    }
}

/// A 2xx whose body cannot be read leaves the outcome unknown; anything else was refused.
fn answer_failure(ok: bool, message: &str) -> ToggleError {
    if ok {
        ToggleError::Unknown(format!("{message}; the reward may have been updated"))
    } else {
        ToggleError::Refused(message.to_owned())
    }
}

fn http_failure(error: &dima_http::Error) -> ToggleError {
    use dima_http::FailureClass;
    match error.class() {
        FailureClass::Connect
        | FailureClass::Blocked
        | FailureClass::Invalid
        | FailureClass::RequestTooLarge => {
            ToggleError::Refused("The reward update could not be sent to Twitch".to_owned())
        }
        _ => ToggleError::Unknown(
            "Twitch did not answer the reward update; it may have been applied".to_owned(),
        ),
    }
}

/// Deadlines of the availability service.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AvailabilityConfig {
    /// One MongoDB call.
    pub store_deadline: Duration,
}

impl Default for AvailabilityConfig {
    fn default() -> Self {
        Self {
            store_deadline: Duration::from_secs(10),
        }
    }
}

/// What one [`Availability::recover`] did.
#[derive(Debug, Default)]
pub struct Recovery {
    /// Targets synchronised without error.
    pub synchronized: usize,
    /// Targets whose effect failed again: target, channel, message.
    pub retrying: Vec<(Target, String, String)>,
    /// Targets whose synchronisation failed on a store: target, channel, error.
    pub failed: Vec<(Target, String, RuntimeError)>,
}

/// The availability service.
#[derive(Clone, Debug)]
pub struct Availability<R> {
    stores: Stores,
    commands: CommandCache,
    rewards: Arc<R>,
    clock: Arc<dyn Clock>,
    random: Arc<dyn Random>,
    config: AvailabilityConfig,
}

/// `new RegExp('^' + escaped + '$', 'i')`, sent to MongoDB as a regular expression. `None` for
/// a name holding a NUL, which no BSON regular expression can (the reference's driver throws;
/// here the name is simply not found).
fn exact(value: &str) -> Option<Regex> {
    let mut pattern = String::with_capacity(value.len() + 2);
    pattern.push('^');
    for character in value.chars() {
        if ".*+?^${}()|[]\\".contains(character) {
            pattern.push('\\');
        }
        pattern.push(character);
    }
    pattern.push('$');
    Some(Regex {
        pattern: bson::raw::CString::try_from(pattern).ok()?,
        options: bson::raw::CString::try_from("i").ok()?,
    })
}

/// The fields every step reads (`select('+availability +availabilityLease')`, narrowed to what
/// the service looks at).
fn selection(target: Target) -> Document {
    let mut projection = doc! {
        "_id": 1, "channelID": 1, "availability": 1, "availabilityLease": 1,
        target.enabled_field(): 1,
    };
    match target {
        Target::Command => {
            projection.insert("cmd", 1);
        }
        Target::Redemption => {
            projection.insert("rewardID", 1);
            projection.insert("createdFor", 1);
        }
    }
    projection
}

fn truthy(document: &Document, field: &str) -> bool {
    document.get(field).is_some_and(js_truthy)
}

fn date_ms(value: Option<&Bson>) -> Option<i64> {
    match value {
        Some(Bson::DateTime(date)) => Some(date.timestamp_millis()),
        _ => None,
    }
}

impl<R: RewardToggle> Availability<R> {
    /// The service. `commands` is the process's command cache (its writes invalidate names).
    pub fn new(
        stores: Stores,
        commands: CommandCache,
        rewards: Arc<R>,
        clock: Arc<dyn Clock>,
        random: Arc<dyn Random>,
        config: AvailabilityConfig,
    ) -> Self {
        Self {
            stores,
            commands,
            rewards,
            clock,
            random,
            config,
        }
    }

    fn deadline(&self) -> Duration {
        self.config.store_deadline
    }

    /// `adapter.resolve(channelID, name)`.
    async fn resolve(
        &self,
        target: Target,
        channel_id: &str,
        name: &str,
    ) -> Result<Document, AvailabilityError> {
        let collection = self.stores.mongo.documents(target.collection());
        let (filter, ambiguous, missing) = match target {
            Target::Command => {
                let bare = name.strip_prefix('!').unwrap_or(name);
                let Some(pattern) = exact(bare) else {
                    return Err(AvailabilityError::Refused("Command not found".to_owned()));
                };
                (
                    doc! {
                        "channelID": channel_id,
                        "activation": { "$ne": "keyword" },
                        "cmd": pattern,
                    },
                    "Command name is ambiguous",
                    "Command not found",
                )
            }
            Target::Redemption => {
                let by_id = within(
                    "redemptionrewards.findOne",
                    self.deadline(),
                    collection
                        .find_one(doc! { "channelID": channel_id, "rewardID": name })
                        .projection(selection(target)),
                )
                .await?;
                if let Some(found) = by_id {
                    return Ok(found);
                }
                let Some(pattern) = exact(name) else {
                    return Err(AvailabilityError::Refused("Redemption not found".to_owned()));
                };
                (
                    doc! { "channelID": channel_id, "title": pattern },
                    "Redemption name is ambiguous; use its reward ID",
                    "Redemption not found",
                )
            }
        };
        let matches: Vec<Document> = within("availability.resolve", self.deadline(), async {
            collection
                .find(filter)
                .projection(selection(target))
                .limit(2)
                .await?
                .try_collect()
                .await
        })
        .await?;
        match <[Document; 1]>::try_from(matches) {
            Ok([found]) => Ok(found),
            Err(matches) if matches.is_empty() => {
                Err(AvailabilityError::Refused(missing.to_owned()))
            }
            Err(_) => Err(AvailabilityError::Refused(ambiguous.to_owned())),
        }
    }

    fn prepare_update(
        &self,
        target: Target,
        filter: &Document,
        update: Document,
    ) -> Result<PreparedUpdate, RuntimeError> {
        let mut ctx = WriteContext::new(self.clock.now_ms());
        let random = self.random.as_ref();
        let options = dima_model::UpdateOptions::default();
        Ok(match target {
            Target::Command => {
                commands::prepare_update(filter, update, options, Writer::Internal, &mut ctx, random)?
            }
            Target::Redemption => redemption_rewards::prepare_update(
                filter,
                update,
                options,
                Writer::Internal,
                &mut ctx,
                random,
            )?,
        })
    }

    /// `internalWrite(model.updateOne(filter, update))`: whether it matched.
    async fn update(
        &self,
        target: Target,
        filter: &Document,
        update: Document,
    ) -> Result<bool, RuntimeError> {
        let prepared = self.prepare_update(target, filter, update)?;
        let outcome = within("availability.updateOne", self.deadline(), async {
            self.stores
                .mongo
                .writes(target.collection())
                .update_one(&prepared)
                .await
        })
        .await?;
        Ok(outcome.matched > 0)
    }

    /// [`Self::update`] of a write that changes a command's `enabled`: inside the command
    /// cache's write protocol for its name.
    async fn update_enabled(
        &self,
        target: Target,
        channel_id: &str,
        name: Option<&str>,
        filter: &Document,
        update: Document,
    ) -> Result<bool, RuntimeError> {
        match (target, name) {
            (Target::Command, Some(name)) => self
                .commands
                .write(channel_id, Names::These(&[name]), || {
                    self.update(target, filter, update)
                })
                .await
                .map_err(WriteFailure::into_runtime),
            (Target::Command, None) => self
                .commands
                .write(channel_id, Names::All, || self.update(target, filter, update))
                .await
                .map_err(WriteFailure::into_runtime),
            (Target::Redemption, _) => self.update(target, filter, update).await,
        }
    }

    /// `setAvailability(kind, channelID, name, enabled, seconds)`: `seconds` restores the
    /// previous state after that many seconds (1 to [`MAX_AVAILABILITY_SECONDS`]); repeating a
    /// timed change extends it; no duration cancels a pending restoration.
    pub async fn set(
        &self,
        target: Target,
        channel_id: &str,
        name: &str,
        enabled: bool,
        seconds: Option<f64>,
    ) -> Result<(), AvailabilityError> {
        if channel_id.is_empty() || dima_text::trim(name).is_empty() {
            return Err(AvailabilityError::Refused(
                "A channel and target name are required".to_owned(),
            ));
        }
        if let Some(seconds) = seconds
            && !(seconds.fract() == 0.0
                && (1.0..=f64::from(MAX_AVAILABILITY_SECONDS)).contains(&seconds))
        {
            return Err(AvailabilityError::Refused(format!(
                "Duration must be a whole number of seconds from 1 to {MAX_AVAILABILITY_SECONDS}"
            )));
        }
        let field = target.enabled_field();
        for _ in 0..SET_ATTEMPTS {
            let document = self.resolve(target, channel_id, name).await?;
            if target == Target::Redemption && document.get_str("createdFor").ok() != Some("twitch")
            {
                return Err(AvailabilityError::Refused(
                    "Only Twitch redemptions are supported".to_owned(),
                ));
            }
            let current = truthy(&document, field);
            let prior = document.get_document("availability").ok();
            let previous_enabled = match (seconds, prior) {
                (Some(_), Some(prior))
                    if prior.get("restoreAt").is_some_and(js_truthy)
                        && current == enabled =>
                {
                    truthy(prior, "previousEnabled")
                }
                _ => current,
            };
            let now = self.clock.now_ms();
            let restore_at = seconds.map(|seconds| JsDate(now + (seconds as i64) * 1000));
            let state = availability_state(previous_enabled, restore_at, now, self.random.as_ref())
                .map_err(RuntimeError::from)?;
            let id = document.get("_id").cloned().unwrap_or(Bson::Null);
            let token = prior
                .and_then(|prior| prior.get("token").cloned())
                .filter(|token| !matches!(token, Bson::Null | Bson::Undefined))
                .unwrap_or_else(|| Bson::Document(doc! { "$exists": false }));
            let filter = doc! {
                "_id": id.clone(),
                "channelID": channel_id,
                field: document.get(field).cloned().unwrap_or(Bson::Null),
                "availability.token": token,
            };
            let update = doc! { "$set": { field: enabled, "availability": state } };
            let cmd = document.get_str("cmd").ok();
            if !self
                .update_enabled(target, channel_id, cmd, &filter, update)
                .await?
            {
                continue;
            }
            let Bson::ObjectId(id) = id else {
                return Err(RuntimeError::Decode(format!("{}._id", target.collection())).into());
            };
            if let Some(error) = self.synchronize(target, &id, channel_id).await? {
                return Err(AvailabilityError::Pending(error));
            }
            return Ok(());
        }
        Err(AvailabilityError::Refused(
            "Target changed concurrently; please try again".to_owned(),
        ))
    }

    /// `synchronizeAvailability(adapter, id, channelID)`: brings the outside world in line
    /// with the stored state under the target's lease. `Some(message)` when the effect failed
    /// (retried later); `None` when it is done or another owner holds the lease.
    pub async fn synchronize(
        &self,
        target: Target,
        id: &ObjectId,
        channel_id: &str,
    ) -> Result<Option<String>, RuntimeError> {
        let owner = self.random.uuid_v4()?;
        let filter = doc! { "_id": id, "channelID": channel_id };
        let now = self.clock.now_ms();
        let mut lock_filter = filter.clone();
        lock_filter.insert(
            "$or",
            vec![
                Bson::Document(doc! { "availabilityLease.until": { "$exists": false } }),
                Bson::Document(
                    doc! { "availabilityLease.until": { "$lte": bson::DateTime::from_millis(now) } },
                ),
            ],
        );
        let lease = doc! { "$set": { "availabilityLease": {
            "token": owner.as_str(),
            "until": bson::DateTime::from_millis(now + LEASE_MS),
        } } };
        let prepared = self.prepare_lock(target, &lock_filter, lease)?;
        let locked = within("availability.lock", self.deadline(), async {
            self.stores
                .mongo
                .writes(target.collection())
                .find_one_and_update(&prepared)
                .await
        })
        .await?;
        if locked.is_none() {
            return Ok(None);
        }
        let outcome = self.passes(target, &filter, channel_id, &owner).await;
        let mut release = filter.clone();
        release.insert("availabilityLease.token", owner.as_str());
        let released = self
            .update(target, &release, doc! { "$unset": { "availabilityLease": 1 } })
            .await;
        let outcome = outcome?;
        released?;
        Ok(outcome)
    }

    fn prepare_lock(
        &self,
        target: Target,
        filter: &Document,
        update: Document,
    ) -> Result<PreparedFindAndModify, RuntimeError> {
        let mut ctx = WriteContext::new(self.clock.now_ms());
        let random = self.random.as_ref();
        let options = dima_model::UpdateOptions::default();
        Ok(match target {
            Target::Command => commands::prepare_find_one_and_update(
                filter,
                update,
                options,
                Returned::After,
                Writer::Internal,
                &mut ctx,
                random,
            )?,
            Target::Redemption => redemption_rewards::prepare_find_one_and_update(
                filter,
                update,
                options,
                Returned::After,
                Writer::Internal,
                &mut ctx,
                random,
            )?,
        })
    }

    async fn passes(
        &self,
        target: Target,
        filter: &Document,
        channel_id: &str,
        owner: &str,
    ) -> Result<Option<String>, RuntimeError> {
        let field = target.enabled_field();
        for _ in 0..SYNC_PASSES {
            let now = self.clock.now_ms();
            let mut renew = filter.clone();
            renew.insert("availabilityLease.token", owner);
            let renewed = self
                .update(
                    target,
                    &renew,
                    doc! { "$set": { "availabilityLease.until": bson::DateTime::from_millis(now + LEASE_MS) } },
                )
                .await?;
            if !renewed {
                return Ok(None);
            }
            let document = within(
                "availability.findOne",
                self.deadline(),
                self.stores
                    .mongo
                    .documents(target.collection())
                    .find_one(filter.clone())
                    .projection(selection(target)),
            )
            .await?;
            let Some(document) = document else {
                return Ok(None);
            };
            let Ok(state) = document.get_document("availability") else {
                return Ok(None);
            };
            let token = state.get("token").cloned().unwrap_or(Bson::Null);
            let mut fenced = filter.clone();
            fenced.insert("availability.token", token);
            let restore_at = date_ms(state.get("restoreAt"));
            if let Some(restore_at) = restore_at
                && restore_at <= now
            {
                let previous = truthy(state, "previousEnabled");
                let fresh = availability_state(previous, None, now, self.random.as_ref())?;
                let cmd = document.get_str("cmd").ok();
                self.update_enabled(
                    target,
                    channel_id,
                    cmd,
                    &fenced,
                    doc! { "$set": { field: previous, "availability": fresh } },
                )
                .await?;
                continue;
            }
            if !truthy(state, "pending") {
                return Ok(None);
            }
            if let Err(error) = self.effect(target, channel_id, &document).await {
                let retry_at = (now + RETRY_MS).min(restore_at.unwrap_or(i64::MAX));
                self.update(
                    target,
                    &fenced,
                    doc! { "$set": { "availability.nextAt": bson::DateTime::from_millis(retry_at) } },
                )
                .await?;
                return Ok(Some(error));
            }
            let done = match restore_at {
                Some(restore_at) => doc! { "$set": {
                    "availability.pending": false,
                    "availability.nextAt": bson::DateTime::from_millis(restore_at),
                } },
                None => doc! { "$unset": { "availability": 1 } },
            };
            self.update(target, &fenced, done).await?;
        }
        Ok(None)
    }

    /// `adapter.sync(document)`.
    async fn effect(
        &self,
        target: Target,
        channel_id: &str,
        document: &Document,
    ) -> Result<(), String> {
        match target {
            Target::Command => {
                let names: Vec<&str> = document.get_str("cmd").ok().into_iter().collect();
                let names = if names.is_empty() {
                    Names::All
                } else {
                    Names::These(&names)
                };
                self.commands
                    .write(channel_id, names, || async { Ok::<(), RuntimeError>(()) })
                    .await
                    .map_err(|error| error.into_runtime().to_string())
            }
            Target::Redemption => {
                if document.get_str("createdFor").ok() != Some("twitch") {
                    return Err("Only Twitch redemptions are supported".to_owned());
                }
                let enabled = truthy(document, "isEnabled");
                let reward_id = document.get_str("rewardID").unwrap_or_default();
                self.rewards
                    .set_enabled(channel_id, reward_id, enabled)
                    .await
                    .map_err(|error| error.to_string())
            }
        }
    }

    /// `recoverAvailability()`: for each target, up to [`RECOVERY_BATCH`] documents whose
    /// `availability.nextAt` is due, synchronised [`RECOVERY_CONCURRENCY`] at a time.
    pub async fn recover(&self) -> Result<Recovery, RuntimeError> {
        let mut report = Recovery::default();
        for target in Target::ALL {
            let now = bson::DateTime::from_millis(self.clock.now_ms());
            let due: Vec<Document> = within("availability.recover", self.deadline(), async {
                self.stores
                    .mongo
                    .documents(target.collection())
                    .find(doc! { "availability.nextAt": { "$lte": now } })
                    .projection(doc! { "_id": 1, "channelID": 1 })
                    .limit(RECOVERY_BATCH)
                    .await?
                    .try_collect()
                    .await
            })
            .await?;
            for batch in due.chunks(RECOVERY_CONCURRENCY) {
                let runs = batch.iter().map(|document| async move {
                    let channel = document.get_str("channelID").unwrap_or_default().to_owned();
                    let outcome = match document.get("_id") {
                        Some(Bson::ObjectId(id)) => self.synchronize(target, id, &channel).await,
                        _ => Err(RuntimeError::Decode(format!("{}._id", target.collection()))),
                    };
                    (channel, outcome)
                });
                for (channel, outcome) in futures_util::future::join_all(runs).await {
                    match outcome {
                        Ok(None) => report.synchronized += 1,
                        Ok(Some(message)) => report.retrying.push((target, channel, message)),
                        Err(error) => report.failed.push((target, channel, error)),
                    }
                }
            }
        }
        Ok(report)
    }
}
