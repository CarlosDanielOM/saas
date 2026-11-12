//! `reconcileEventsubs` (`utils/eventsub_reconciliation.ts`): compares what MongoDB and the
//! table say every active channel should have with what Twitch lists, and repairs the
//! difference. Off unless configured on ([`ReconcileSettings::enabled`]; production sets
//! `EVENTSUB_RECONCILIATION_ENABLED=false` today). The worker (lease, interval, start-up run)
//! belongs to the cron package and passes its lease check as [`RunControl`].
//!
//! # What a run does, in the reference's order
//!
//! 1. Active channels: Twitch accounts with `actived` and `has_permissions`.
//! 2. The whole listing for the client id, read to its end; a listing that is not complete
//!    stops the run before anything is touched.
//! 3. The circuit breaker: too many unhealthy managed subscriptions stop the run.
//! 4. Bits: listed bits subscriptions are written to MongoDB; each channel with a legacy type
//!    is migrated (`migrateLegacyBitsEventsubs`); the listing is read again.
//! 5. Stored subscriptions Twitch no longer lists are marked (`remote_missing_since`) and
//!    removed from MongoDB after the grace period (12 h); MongoDB only, never Twitch.
//! 6. Per expected subscription (type, version and condition of the table for an active
//!    channel): every listed one but the best healthy one is **deleted at Twitch** (duplicates
//!    and unhealthy ones: failed verification, revoked, ...).
//! 7. Per active channel and table entry: a healthy listed subscription is written to MongoDB
//!    (stored settings kept, stored duplicates removed); a missing one is **created**, unless it
//!    is waiting out the grace period, its removal failed, or the raid preference says no.
//!
//! # Deletes and reports
//!
//! Deleted at Twitch: duplicates and unhealthy subscriptions of an expected subscription, and
//! legacy bits subscriptions after their channel's canonical one exists (as the reference).
//! Only reported, never deleted (the reference ignores them too): subscriptions of types the
//! table does not have (rewards, chat moderation...), of channels that are not active
//! ([`ReconcileReport::departed`]), and of active channels that the table does not expect
//! (another version or condition, [`ReconcileReport::unexpected`]). With
//! [`ReconcileSettings::remove_unexpected`] the last two are deleted as well (off by default:
//! a channel that loses its permissions for a while would lose its subscriptions).
//!
//! # Subscriptions this backend did not create
//!
//! The reference treats every subscription of the client id alike, whatever its transport, so a
//! subscription of another environment sharing the client id (another callback) can be deleted
//! as a duplicate, or be kept as "the healthy one" while production's is deleted. Here only
//! webhooks to the configured callback are this backend's ([`EventsubSettings::owns`]); anything
//! else (another callback, a WebSocket or conduit transport, whose sessions this backend never
//! holds) is listed in [`ReconcileReport::foreign`] and never deleted, never adopted and never
//! counts as the subscription a channel has. Where every subscription is this backend's (the
//! production copy), the run is the reference's.
//!
//! # Safety
//!
//! - Dry run ([`ReconcileSettings::dry_run`]): the same reads, nothing written or sent but the
//!   listing; the report holds the plan ([`ReconcileReport::actions`]) and counts what the run
//!   would create, delete and remove. The bits migration is planned, not simulated: its
//!   channels' canonical subscription is not planned again.
//! - Limits: creates and Twitch deletes per run and Twitch actions per channel
//!   ([`ReconcileSettings`]); what is over a limit is skipped, counted in
//!   [`ReconcileReport::deferred`], and done by the next run.
//! - Interruption: [`RunControl::should_continue`] (the reference's `shouldContinue`) and the
//!   process's shutdown are checked before every step; a stopped run returns what it did. A run
//!   can be repeated: every step reads the current state first.
//! - Two runs at once (two processes without the lease): a create the other run made first is
//!   refused by Twitch (409) and reported, never duplicated; a delete the other run made first
//!   is a 404, which is success.
//!
//! # Limits and pauses (reference values)
//!
//! | Setting | Value | Source |
//! |---|---|---|
//! | `request_delay` | 0 (the worker passes 250 ms) | `requestDelayMs`, after each create |
//! | `missing_grace` | 12 h, at least 60 s | `missingGraceMs` |
//! | `unhealthy_ratio`, `unhealthy_min_count` | 0.25, 5 | the circuit breaker |
//! | pending verification counts as healthy | 30 min | `PENDING_VERIFICATION_GRACE_MS` |
//! | `max_creates`, `max_deletes`, `max_actions_per_channel` | 2000, 1000, 100 | Rust only; far above a normal run (30 table entries a channel) |

use super::condition::{
    Condition, RaidDirection, raid_direction, resolve_channel_id, subscription_key,
};
use super::js;
use super::manage::{EventsubManager, ListError, RemoteEventsub, SubscribeRequest};
use super::policy::{
    DEFAULT_UNHEALTHY_MIN_COUNT, DEFAULT_UNHEALTHY_RATIO, should_trip_circuit_breaker,
};
use super::store::{Eventsubs, filter_value};
use super::types::{
    CANONICAL_BITS_EVENT_TYPE, LEGACY_BITS_EVENT_TYPES, SUBSCRIPTION_TYPES, Setting, Settings,
    SubscriptionType, is_legacy_bits_event_type, is_managed_type,
};
use crate::error::TwitchError;
use bson::{Bson, Document, doc};
use futures_util::TryStreamExt;
use futures_util::future::BoxFuture;
use serde::Serialize;
use std::cmp::Ordering;
use std::collections::{HashMap, HashSet};
use std::time::Duration;

/// `PENDING_VERIFICATION_GRACE_MS`.
const PENDING_VERIFICATION_GRACE_MS: i64 = 30 * 60_000;

/// How a run is configured. The worker reads `EVENTSUB_RECONCILIATION_*` into it.
#[derive(Clone, Debug, PartialEq)]
pub struct ReconcileSettings {
    /// Whether runs happen at all (`EVENTSUB_RECONCILIATION_ENABLED`). Off by default; a dry run
    /// is allowed while it is off.
    pub enabled: bool,
    /// Plan only.
    pub dry_run: bool,
    /// The pause after each create.
    pub request_delay: Duration,
    /// How long a stored subscription Twitch no longer lists is kept (at least 60 s).
    pub missing_grace: Duration,
    /// The circuit breaker's share (clamped to `[0, 1]`).
    pub unhealthy_ratio: f64,
    /// The circuit breaker's least count (at least 1).
    pub unhealthy_min_count: u64,
    /// The most creates of one run.
    pub max_creates: usize,
    /// The most Twitch deletes of one run.
    pub max_deletes: usize,
    /// The most Twitch actions (creates and deletes) for one channel in one run.
    pub max_actions_per_channel: usize,
    /// Also delete this backend's subscriptions of channels that are not active and those the
    /// table does not expect for an active channel.
    pub remove_unexpected: bool,
}

impl Default for ReconcileSettings {
    fn default() -> Self {
        Self {
            enabled: false,
            dry_run: false,
            request_delay: Duration::ZERO,
            missing_grace: Duration::from_secs(12 * 60 * 60),
            unhealthy_ratio: DEFAULT_UNHEALTHY_RATIO,
            unhealthy_min_count: DEFAULT_UNHEALTHY_MIN_COUNT,
            max_creates: 2000,
            max_deletes: 1000,
            max_actions_per_channel: 100,
            remove_unexpected: false,
        }
    }
}

impl ReconcileSettings {
    fn missing_grace_ms(&self) -> i64 {
        i64::try_from(self.missing_grace.as_millis())
            .unwrap_or(i64::MAX)
            .max(60_000)
    }
}

/// `isRaidDeleted` and `shouldRepairRaid` (`utils/raid_subscriptions.ts`), supplied by the
/// owner of the raid preferences (`dima_stream::raid_subscriptions::RaidSubscriptions`, which
/// depends on this crate).
pub trait RaidPreferences: Send + Sync {
    /// The channel deleted this direction (`deleted: true`).
    fn is_raid_deleted<'a>(
        &'a self,
        channel: &'a str,
        direction: RaidDirection,
    ) -> BoxFuture<'a, Result<bool, TwitchError>>;
    /// The direction should exist (its preference is not deleted; without a preference, only
    /// incoming raids).
    fn should_repair_raid<'a>(
        &'a self,
        channel: &'a str,
        direction: RaidDirection,
    ) -> BoxFuture<'a, Result<bool, TwitchError>>;
}

/// `shouldContinue`: the worker's lease check (and its shutdown).
pub trait RunControl: Send + Sync {
    /// `false` stops the run before its next step.
    fn should_continue(&self) -> BoxFuture<'_, bool>;
}

/// A run that always continues (one-off runs and tests).
#[derive(Clone, Copy, Debug, Default)]
pub struct AlwaysContinue;

impl RunControl for AlwaysContinue {
    fn should_continue(&self) -> BoxFuture<'_, bool> {
        Box::pin(async { true })
    }
}

/// One Twitch action of a run, done or (in a dry run, or over a limit) planned.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct Action {
    /// `create`, `delete` or `migrate-bits`.
    pub action: &'static str,
    /// Why (`missing`, `duplicate`, `unhealthy`, `legacy-bits`, `departed`, `unexpected`).
    pub reason: &'static str,
    /// The channel.
    pub channel: String,
    /// The type.
    pub kind: String,
    /// The subscription's id (deletes).
    pub id: Option<String>,
    /// `done`, `failed`, `planned` or `deferred`.
    pub outcome: &'static str,
}

/// What a run did: the reference's counts and errors, then what Rust adds.
#[derive(Clone, Debug, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReconcileReport {
    /// `activeChannels`.
    pub active_channels: u64,
    /// `remoteSubscriptions`.
    pub remote_subscriptions: u64,
    /// `staleLocalRemoved`.
    pub stale_local_removed: u64,
    /// `remoteSubscriptionsRemoved`.
    pub remote_subscriptions_removed: u64,
    /// `localSubscriptionsSynced`.
    pub local_subscriptions_synced: u64,
    /// `subscriptionsCreated`.
    pub subscriptions_created: u64,
    /// `errors`, as the reference words them.
    pub errors: Vec<String>,
    /// A dry run.
    pub dry_run: bool,
    /// Every Twitch action, with ids.
    pub actions: Vec<Action>,
    /// Ids of subscriptions this backend did not create (never deleted).
    pub foreign: Vec<String>,
    /// Ids of this backend's subscriptions of channels that are not active.
    pub departed: Vec<String>,
    /// Ids of this backend's subscriptions of active channels the table does not expect.
    pub unexpected: Vec<String>,
    /// Listed subscriptions of types the table does not manage (left alone).
    pub unmanaged: u64,
    /// Actions skipped because a limit was reached.
    pub deferred: u64,
}

impl ReconcileReport {
    /// The reference's `EventsubReconciliationResult`.
    pub fn reference_json(&self) -> serde_json::Value {
        serde_json::json!({
            "activeChannels": self.active_channels,
            "remoteSubscriptions": self.remote_subscriptions,
            "staleLocalRemoved": self.stale_local_removed,
            "remoteSubscriptionsRemoved": self.remote_subscriptions_removed,
            "localSubscriptionsSynced": self.local_subscriptions_synced,
            "subscriptionsCreated": self.subscriptions_created,
            "errors": self.errors,
        })
    }
}

/// Why a run stopped. Every variant but [`ReconcileError::Disabled`] and
/// [`ReconcileError::CircuitBreaker`] carries what the run did before it stopped.
#[derive(Debug, thiserror::Error)]
pub enum ReconcileError {
    /// The reconciliation is not enabled.
    #[error("EventSub reconciliation is disabled")]
    Disabled,
    /// `shouldContinue` said no, or the process is shutting down.
    #[error("EventSub reconciliation cancelled because worker ownership was lost")]
    Cancelled(Box<ReconcileReport>),
    /// The listing could not be read to its end: nothing was deleted on it.
    #[error("{message}")]
    List {
        /// The reference's message.
        message: String,
        /// Why.
        error: ListError,
        /// What was done before.
        report: Box<ReconcileReport>,
    },
    /// Too many managed subscriptions are unhealthy.
    #[error(
        "EventSub reconciliation circuit breaker tripped: {unhealthy}/{total} managed subscriptions are unhealthy"
    )]
    CircuitBreaker {
        /// Unhealthy managed subscriptions.
        unhealthy: u64,
        /// Managed subscriptions.
        total: u64,
    },
    /// A MongoDB read or write failed (or a raid preference could not be read).
    #[error("{error}")]
    Store {
        /// The failure.
        error: TwitchError,
        /// What was done before.
        report: Box<ReconcileReport>,
    },
}

/// An active channel: id and name (`account.name || account.id`).
struct Channels {
    order: Vec<(String, String)>,
    index: HashMap<String, usize>,
}

impl Channels {
    fn set(&mut self, id: String, name: String) {
        match self.index.get(&id) {
            Some(&at) => {
                if let Some(entry) = self.order.get_mut(at) {
                    entry.1 = name;
                }
            }
            None => {
                self.index.insert(id.clone(), self.order.len());
                self.order.push((id, name));
            }
        }
    }

    fn name(&self, id: &str) -> Option<&str> {
        self.index
            .get(id)
            .and_then(|at| self.order.get(*at))
            .map(|(_, name)| name.as_str())
    }

    fn has(&self, id: &str) -> bool {
        self.index.contains_key(id)
    }
}

/// Why a step stopped.
enum Stop {
    Cancelled,
    Store(TwitchError),
    List(String, ListError),
    Breaker(u64, u64),
}

impl From<TwitchError> for Stop {
    fn from(error: TwitchError) -> Self {
        Self::Store(error)
    }
}

/// `remote_missing_since`: falsy, a date, or an invalid date (`None`).
fn missing_since(document: &Document) -> Option<Option<i64>> {
    let value = document.get("remote_missing_since")?;
    if !js::truthy(Some(value)) {
        return None;
    }
    Some(match value {
        Bson::DateTime(date) => Some(date.timestamp_millis()),
        Bson::String(text) => dima_text::parse_date(text),
        Bson::Int32(n) => Some(i64::from(*n)),
        Bson::Int64(n) => Some(*n),
        #[allow(clippy::cast_possible_truncation)]
        Bson::Double(n) if n.is_finite() => Some(*n as i64),
        _ => None,
    })
}

/// `eventsubConfig(local)`: the ten settings as stored (missing ones explicitly undefined).
fn stored_settings(local: Option<&Document>) -> Settings {
    let mut settings = Settings::new();
    let Some(local) = local else {
        return settings;
    };
    for key in [
        Setting::Enabled,
        Setting::Message,
        Setting::EndMessage,
        Setting::EndEnabled,
        Setting::MinViewers,
        Setting::TemporalBanMessage,
        Setting::ClipEnabled,
        Setting::Delay,
        Setting::CheerTiers,
        Setting::TodayFollows,
    ] {
        match local.get(key.path()) {
            Some(Bson::Undefined) | None => settings.set_undefined(key),
            Some(value) => settings.set(key, value.clone()),
        }
    }
    settings
}

/// `configurationScore`: how customised a stored subscription is (the one kept of duplicates).
fn configuration_score(local: &Document) -> u32 {
    let get = |key: &str| local.get(key);
    let flag = |condition: bool, weight: u32| if condition { weight } else { 0 };
    let tiers = match get("cheerTiers") {
        Some(Bson::Array(items)) => !items.is_empty(),
        Some(Bson::String(text)) => !text.is_empty(),
        _ => false,
    };
    let min_viewers_custom = match get("minViewers") {
        Some(value) if js::truthy(Some(value)) => js::number(Some(value)) != Some(2.0),
        _ => false,
    };
    flag(matches!(get("enabled"), Some(Bson::Boolean(false))), 10)
        + flag(js::truthy(get("message")), 4)
        + flag(js::truthy(get("endMessage")), 2)
        + flag(matches!(get("endEnabled"), Some(Bson::Boolean(true))), 2)
        + flag(matches!(get("clipEnabled"), Some(Bson::Boolean(true))), 2)
        + flag(js::truthy(get("temporalBanMessage")), 1)
        + flag(tiers, 3)
        + flag(js::truthy(get("delay")), 1)
        + flag(min_viewers_custom, 1)
        + flag(matches!(get("todayFollows"), Some(Bson::Boolean(true))), 1)
}

fn local_key(local: &Document) -> String {
    let text = |key: &str| js::string_or_empty(local.get(key));
    let condition = local
        .get("condition")
        .map(|value| Condition::from_value(&js::to_json(value)))
        .unwrap_or_default();
    subscription_key(&text("type"), &text("version"), &condition)
}

fn remote_key(remote: &RemoteEventsub) -> String {
    subscription_key(remote.kind(), remote.version(), &remote.condition())
}

/// One run.
struct Run<'a> {
    manager: &'a EventsubManager,
    settings: &'a ReconcileSettings,
    raids: &'a dyn RaidPreferences,
    control: &'a dyn RunControl,
    report: ReconcileReport,
    collator: Option<dima_text::Collator>,
    creates: usize,
    deletes: usize,
    per_channel: HashMap<String, usize>,
}

impl Run<'_> {
    fn store(&self) -> Eventsubs<'_> {
        self.manager.store()
    }

    fn dry(&self) -> bool {
        self.settings.dry_run
    }

    fn now_ms(&self) -> i64 {
        self.manager.twitch.inner.now_ms()
    }

    /// `ensureActive`.
    async fn ensure_active(&self) -> Result<(), Stop> {
        if self.manager.twitch.inner.shutdown.is_triggered()
            || !self.control.should_continue().await
        {
            return Err(Stop::Cancelled);
        }
        Ok(())
    }

    fn owns(&self, remote: &RemoteEventsub) -> bool {
        self.manager.settings.owns(remote.transport())
    }

    /// `remoteIsHealthy`.
    fn healthy(&self, remote: &RemoteEventsub) -> bool {
        match remote.status() {
            "enabled" => true,
            "webhook_callback_verification_pending" => dima_text::parse_date(remote.created_at())
                .is_some_and(|created| self.now_ms() - created <= PENDING_VERIFICATION_GRACE_MS),
            _ => false,
        }
    }

    /// The order `healthy.sort(...)` gives: enabled first, then older, then by id
    /// (`localeCompare`). An invalid creation time compares by id, as `NaN || ...` does.
    fn before(&self, left: &RemoteEventsub, right: &RemoteEventsub) -> Ordering {
        let rank = |remote: &RemoteEventsub| u8::from(remote.status() != "enabled");
        let status = rank(left).cmp(&rank(right));
        if status != Ordering::Equal {
            return status;
        }
        let created = dima_text::parse_date(left.created_at())
            .zip(dima_text::parse_date(right.created_at()))
            .map_or(Ordering::Equal, |(l, r)| l.cmp(&r));
        if created != Ordering::Equal {
            return created;
        }
        match &self.collator {
            Some(collator) => collator.compare(left.id(), right.id()),
            None => dima_text::cmp_utf16(left.id(), right.id()),
        }
    }

    /// V8's binary insertion sort (what `Array.prototype.sort` does for short arrays): stable,
    /// and never fails on a comparison that is not a total order.
    fn sort_healthy<'r>(&self, items: Vec<&'r RemoteEventsub>) -> Vec<&'r RemoteEventsub> {
        let mut sorted: Vec<&RemoteEventsub> = Vec::with_capacity(items.len());
        for item in items {
            let (mut low, mut high) = (0, sorted.len());
            while low < high {
                let mid = low + (high - low) / 2;
                let Some(at) = sorted.get(mid) else { break };
                if self.before(item, at) == Ordering::Less {
                    high = mid;
                } else {
                    low = mid + 1;
                }
            }
            sorted.insert(low, item);
        }
        sorted
    }

    /// Whether `creates` creates and `deletes` Twitch deletes for `channel` fit the limits; when
    /// they do, they are taken, otherwise one deferral is counted.
    fn budget(&mut self, channel: &str, creates: usize, deletes: usize) -> bool {
        let settings = self.settings;
        let used = self.per_channel.get(channel).copied().unwrap_or(0);
        if self.creates + creates > settings.max_creates
            || self.deletes + deletes > settings.max_deletes
            || used + creates + deletes > settings.max_actions_per_channel
        {
            self.report.deferred += 1;
            return false;
        }
        self.creates += creates;
        self.deletes += deletes;
        self.per_channel
            .insert(channel.to_owned(), used + creates + deletes);
        true
    }

    fn action(
        &mut self,
        action: &'static str,
        reason: &'static str,
        channel: &str,
        kind: &str,
        id: Option<&str>,
        outcome: &'static str,
    ) {
        self.report.actions.push(Action {
            action,
            reason,
            channel: channel.to_owned(),
            kind: kind.to_owned(),
            id: id.map(str::to_owned),
            outcome,
        });
    }

    async fn active_channels(&mut self) -> Result<Channels, Stop> {
        let inner = &self.manager.twitch.inner;
        let users = inner.mongo.documents(dima_model::users::COLLECTION);
        let filter = doc! {
            "accounts": { "$elemMatch": { "type": "twitch", "actived": true, "has_permissions": true } }
        };
        let mut cursor = inner
            .mongo_op(
                "users.find active channels",
                users.find(filter).projection(doc! { "accounts": 1 }),
            )
            .await?;
        let mut channels = Channels {
            order: Vec::new(),
            index: HashMap::new(),
        };
        let mut read = 0_usize;
        while let Some(user) = inner
            .mongo_op("users.find active channels", cursor.try_next())
            .await?
        {
            read += 1;
            if read > super::store::MAX_DOCUMENTS {
                return Err(Stop::Store(TwitchError::Mongo {
                    op: "users.find active channels",
                    message: "too many users".into(),
                }));
            }
            let Ok(accounts) = user.get_array("accounts") else {
                continue;
            };
            for account in accounts {
                let Bson::Document(account) = account else {
                    continue;
                };
                let get = |key: &str| account.get(key);
                if get("type").and_then(Bson::as_str) == Some("twitch")
                    && js::truthy(get("actived"))
                    && js::truthy(get("has_permissions"))
                    && js::truthy(get("id"))
                {
                    let id = js::string_or_empty(get("id"));
                    let name = if js::truthy(get("name")) {
                        js::string_or_empty(get("name"))
                    } else {
                        id.clone()
                    };
                    channels.set(id, name);
                }
            }
        }
        Ok(channels)
    }

    async fn list(&self, message: &'static str) -> Result<Vec<RemoteEventsub>, Stop> {
        match self.manager.list(None).await {
            Ok(list) => Ok(list.data),
            Err(error) => {
                let page = error.to_json();
                let text = |key: &str| {
                    page.get(key)
                        .filter(|value| dima_text::js_truthy(*value))
                        .map(dima_text::js_string)
                };
                let message = text("message")
                    .or_else(|| text("error"))
                    .unwrap_or_else(|| message.to_owned());
                Err(Stop::List(message, error))
            }
        }
    }

    async fn run(&mut self) -> Result<(), Stop> {
        let channels = self.active_channels().await?;
        self.report.active_channels = channels.order.len() as u64;

        self.ensure_active().await?;
        let mut remotes = self
            .list("Failed to list Twitch EventSub subscriptions")
            .await?;
        // Reported, never touched: other transports or callbacks.
        for remote in &remotes {
            if !self.owns(remote) {
                self.report.foreign.push(remote.id().to_owned());
            }
        }
        let managed: Vec<&RemoteEventsub> = remotes
            .iter()
            .filter(|remote| {
                self.owns(remote)
                    && channels.has(&resolve_channel_id(&remote.condition()))
                    && (is_managed_type(remote.kind(), remote.version())
                        || is_legacy_bits_event_type(remote.kind()))
            })
            .collect();
        let unhealthy = managed
            .iter()
            .filter(|remote| !self.healthy(remote))
            .count() as u64;
        if should_trip_circuit_breaker(
            managed.len() as u64,
            unhealthy,
            self.settings.unhealthy_ratio,
            self.settings.unhealthy_min_count,
        ) {
            return Err(Stop::Breaker(unhealthy, managed.len() as u64));
        }

        // Bits: listed bits subscriptions into MongoDB, then each legacy channel migrated.
        let initial_ids: Vec<Bson> = remotes
            .iter()
            .map(|remote| Bson::String(remote.id().to_owned()))
            .collect();
        let mut legacy_channels: Vec<String> = Vec::new();
        let mut legacy_count: HashMap<String, usize> = HashMap::new();
        for remote in &remotes {
            self.ensure_active().await?;
            let legacy = is_legacy_bits_event_type(remote.kind());
            if !legacy && remote.kind() != CANONICAL_BITS_EVENT_TYPE || !self.owns(remote) {
                continue;
            }
            let channel = resolve_channel_id(&remote.condition());
            let Some(name) = channels.name(&channel) else {
                continue;
            };
            if legacy {
                if !legacy_channels.contains(&channel) {
                    legacy_channels.push(channel.clone());
                }
                *legacy_count.entry(channel.clone()).or_default() += 1;
            }
            if !self.dry() {
                let mut set = remote.schema_fields();
                set.insert("channelID", channel.as_str());
                set.insert("channel", name);
                set.insert("remote_missing_since", Bson::Null);
                self.store()
                    .set_returning(
                        "eventsubs.findOneAndUpdate listed bits",
                        doc! { "id": remote.id() },
                        set,
                        true,
                    )
                    .await?;
            }
        }
        let mut migrated: HashSet<String> = HashSet::new();
        for channel in &legacy_channels {
            self.ensure_active().await?;
            let legacy = legacy_count.get(channel).copied().unwrap_or(0);
            if !self.budget(channel, 1, legacy) {
                self.action(
                    "migrate-bits",
                    "legacy-bits",
                    channel,
                    CANONICAL_BITS_EVENT_TYPE,
                    None,
                    "deferred",
                );
                continue;
            }
            migrated.insert(channel.clone());
            if self.dry() {
                self.action(
                    "migrate-bits",
                    "legacy-bits",
                    channel,
                    CANONICAL_BITS_EVENT_TYPE,
                    None,
                    "planned",
                );
                continue;
            }
            let stale = self
                .store()
                .find_one(
                    "eventsubs.findOne stale canonical bits",
                    doc! { "channelID": channel.as_str(), "type": CANONICAL_BITS_EVENT_TYPE, "id": { "$nin": initial_ids.clone() } },
                )
                .await?;
            if let Some(stale) = stale {
                let kept = stored_settings(Some(&stale)).to_document();
                self.store()
                    .set(
                        "eventsubs.updateMany legacy bits",
                        doc! { "channelID": channel.as_str(), "type": { "$in": LEGACY_BITS_EVENT_TYPES.to_vec() } },
                        kept,
                        true,
                    )
                    .await?;
                self.store()
                    .delete_one(
                        "eventsubs.deleteOne stale canonical bits",
                        doc! { "id": filter_value(&stale, "id") },
                    )
                    .await?;
            }
            let migration = self.manager.migrate_legacy_bits(channel).await?;
            self.report.remote_subscriptions_removed += migration.removed_legacy_count;
            self.report.subscriptions_created += u64::from(migration.created_canonical);
            let outcome = if migration.errors.is_empty() {
                "done"
            } else {
                "failed"
            };
            self.action(
                "migrate-bits",
                "legacy-bits",
                channel,
                CANONICAL_BITS_EVENT_TYPE,
                None,
                outcome,
            );
            self.report.errors.extend(
                migration
                    .errors
                    .iter()
                    .map(|error| format!("{channel}:bits-migration: {error}")),
            );
        }
        if !legacy_channels.is_empty() && !self.dry() {
            remotes = self
                .list("Failed to refresh Twitch EventSub subscriptions after bits migration")
                .await?;
        }
        self.report.remote_subscriptions = remotes.len() as u64;

        // Stored subscriptions Twitch no longer lists: marked, then removed after the grace.
        let active_ids: Vec<&str> = channels.order.iter().map(|(id, _)| id.as_str()).collect();
        let locals = self
            .store()
            .find(
                "eventsubs.find active channels",
                doc! { "channelID": { "$in": active_ids.clone() } },
            )
            .await?;
        let remote_ids: HashSet<&str> = remotes
            .iter()
            .map(RemoteEventsub::id)
            .filter(|id| !id.is_empty())
            .collect();
        let mut awaiting: HashSet<String> = HashSet::new();
        let missing_now = self.now_ms();
        let grace = self.settings.missing_grace_ms();
        let mut removed_now: HashSet<Bson> = HashSet::new();
        for local in &locals {
            self.ensure_active().await?;
            let key = local_key(local);
            let id = local.get("id");
            let listed = id
                .and_then(Bson::as_str)
                .is_some_and(|id| remote_ids.contains(id));
            let since = missing_since(local);
            if listed {
                if since.is_some() && !self.dry() {
                    self.store()
                        .set(
                            "eventsubs.updateOne listed again",
                            doc! { "id": filter_value(local, "id") },
                            doc! { "remote_missing_since": Bson::Null },
                            false,
                        )
                        .await?;
                }
                continue;
            }
            let within = match since {
                None => true,
                Some(Some(since)) => missing_now - since < grace,
                Some(None) => false,
            };
            if within {
                if !self.dry() {
                    let since = since.flatten().unwrap_or(missing_now);
                    self.store()
                        .set(
                            "eventsubs.updateOne missing",
                            doc! { "id": filter_value(local, "id") },
                            doc! { "remote_missing_since": bson::DateTime::from_millis(since) },
                            false,
                        )
                        .await?;
                }
                awaiting.insert(key);
                continue;
            }
            if self.dry() {
                self.report.stale_local_removed += 1;
                removed_now.insert(filter_value(local, "_id"));
                continue;
            }
            let deleted = self
                .store()
                .delete_one(
                    "eventsubs.deleteOne missing",
                    doc! { "id": filter_value(local, "id"), "remote_missing_since": filter_value(local, "remote_missing_since") },
                )
                .await?;
            if deleted > 0 {
                self.report.stale_local_removed += 1;
            }
        }

        let current = if self.dry() {
            locals
                .iter()
                .filter(|local| !removed_now.contains(&filter_value(local, "_id")))
                .cloned()
                .collect()
        } else {
            self.store()
                .find(
                    "eventsubs.find active channels",
                    doc! { "channelID": { "$in": active_ids } },
                )
                .await?
        };
        // Groups of stored subscriptions per key (both reads, as the reference concatenates
        // them) and the most customised one of each (the first of equals).
        let mut maps = Maps {
            awaiting,
            removed: removed_now,
            ..Maps::default()
        };
        for local in locals.iter().chain(current.iter()) {
            let key = local_key(local);
            maps.local_groups
                .entry(key.clone())
                .or_default()
                .push(Stored {
                    object_id: filter_value(local, "_id"),
                    id: local.get("id").and_then(Bson::as_str).map(str::to_owned),
                });
            let better = maps
                .local_best
                .get(&key)
                .is_none_or(|best| configuration_score(local) > configuration_score(best));
            if better {
                maps.local_best.insert(key, local.clone());
            }
        }

        // Listed subscriptions per key, in listing order.
        let mut group_order: Vec<String> = Vec::new();
        let mut groups: HashMap<String, Vec<&RemoteEventsub>> = HashMap::new();
        for remote in &remotes {
            if !self.owns(remote) {
                continue;
            }
            let key = remote_key(remote);
            if !groups.contains_key(&key) {
                group_order.push(key.clone());
            }
            groups.entry(key).or_default().push(remote);
        }
        for key in &group_order {
            self.ensure_active().await?;
            let Some(group) = groups.get(key) else {
                continue;
            };
            let Some(first) = group.first() else { continue };
            let channel = resolve_channel_id(&first.condition());
            let expected = channels.has(&channel)
                && SUBSCRIPTION_TYPES.iter().any(|entry| {
                    subscription_key(entry.kind, entry.version, &entry.condition_for(&channel))
                        == *key
                });
            if !expected {
                self.report_unexpected(&channels, &channel, group);
                if self.settings.remove_unexpected {
                    self.remove_unexpected(&channels, &channel, group, &mut maps, key)
                        .await?;
                }
                continue;
            }
            let healthy: Vec<&RemoteEventsub> = group
                .iter()
                .copied()
                .filter(|remote| self.healthy(remote))
                .collect();
            let selected = self.sort_healthy(healthy).first().map(|r| (*r).clone());
            if let Some(selected) = &selected {
                maps.healthy_by_key.insert(key.clone(), selected.clone());
            }
            for remote in group {
                if selected.as_ref().is_some_and(|s| s.id() == remote.id()) {
                    continue;
                }
                self.ensure_active().await?;
                let reason = if self.healthy(remote) {
                    "duplicate"
                } else {
                    "unhealthy"
                };
                self.delete_remote(&channel, remote, reason, &mut maps, key)
                    .await?;
            }
        }

        // Each active channel and table entry: write what is listed, create what is missing.
        if self.dry() {
            for channel in &migrated {
                maps.planned_bits.insert(subscription_key(
                    CANONICAL_BITS_EVENT_TYPE,
                    "1",
                    &Condition::of(&[("broadcaster_user_id", channel)]),
                ));
            }
        }
        for (channel, name) in &channels.order {
            for entry in &SUBSCRIPTION_TYPES {
                self.ensure_active().await?;
                self.repair(channel, name, entry, &mut maps).await?;
            }
        }
        Ok(())
    }

    /// Reports a listed group no table entry expects: a table type (or a legacy bits type of a
    /// channel that is not active) is `departed` or `unexpected`; anything else is unmanaged.
    fn report_unexpected(&mut self, channels: &Channels, channel: &str, group: &[&RemoteEventsub]) {
        for remote in group {
            let table_type = SUBSCRIPTION_TYPES.iter().any(|e| e.kind == remote.kind());
            let legacy = is_legacy_bits_event_type(remote.kind());
            if !channels.has(channel) && (table_type || legacy) {
                self.report.departed.push(remote.id().to_owned());
            } else if table_type {
                self.report.unexpected.push(remote.id().to_owned());
            } else if !legacy {
                self.report.unmanaged += 1;
            }
        }
    }

    /// With `remove_unexpected`: deletes what [`Self::report_unexpected`] called departed or
    /// unexpected (never a type the table does not manage).
    async fn remove_unexpected(
        &mut self,
        channels: &Channels,
        channel: &str,
        group: &[&RemoteEventsub],
        maps: &mut Maps,
        key: &str,
    ) -> Result<(), Stop> {
        for remote in group {
            let table_type = SUBSCRIPTION_TYPES.iter().any(|e| e.kind == remote.kind());
            let active = channels.has(channel);
            let legacy_departed = is_legacy_bits_event_type(remote.kind()) && !active;
            if !table_type && !legacy_departed {
                continue;
            }
            self.ensure_active().await?;
            let reason = if active { "unexpected" } else { "departed" };
            self.delete_remote(channel, remote, reason, maps, key)
                .await?;
        }
        Ok(())
    }

    async fn delete_remote(
        &mut self,
        channel: &str,
        remote: &RemoteEventsub,
        reason: &'static str,
        maps: &mut Maps,
        key: &str,
    ) -> Result<(), Stop> {
        if !self.budget(channel, 0, 1) {
            maps.removal_failed.insert(key.to_owned());
            self.action(
                "delete",
                reason,
                channel,
                remote.kind(),
                Some(remote.id()),
                "deferred",
            );
            return Ok(());
        }
        if self.dry() {
            self.report.remote_subscriptions_removed += 1;
            self.action(
                "delete",
                reason,
                channel,
                remote.kind(),
                Some(remote.id()),
                "planned",
            );
            // `unsubscribeTwitchEvent` also deletes one stored document with that id.
            if let Some(stored) = maps
                .local_groups
                .get(key)
                .into_iter()
                .flatten()
                .find(|stored| stored.id.as_deref() == Some(remote.id()))
            {
                maps.removed.insert(stored.object_id.clone());
            }
            return Ok(());
        }
        match self.manager.unsubscribe(remote.id()).await {
            Ok(_) => {
                self.report.remote_subscriptions_removed += 1;
                self.action(
                    "delete",
                    reason,
                    channel,
                    remote.kind(),
                    Some(remote.id()),
                    "done",
                );
            }
            Err(_) => {
                maps.removal_failed.insert(key.to_owned());
                self.report.errors.push(format!(
                    "Failed to remove duplicate or unhealthy {} subscription {}",
                    remote.kind(),
                    remote.id()
                ));
                self.action(
                    "delete",
                    reason,
                    channel,
                    remote.kind(),
                    Some(remote.id()),
                    "failed",
                );
            }
        }
        Ok(())
    }

    /// One table entry of one active channel.
    async fn repair(
        &mut self,
        channel: &str,
        name: &str,
        entry: &SubscriptionType,
        maps: &mut Maps,
    ) -> Result<(), Stop> {
        let condition = entry.condition_for(channel);
        let key = subscription_key(entry.kind, entry.version, &condition);
        let remote = maps.healthy_by_key.get(&key).cloned();
        if entry.kind == "channel.raid" {
            let direction = raid_direction(&condition);
            if self.raids.is_raid_deleted(channel, direction).await? {
                return Ok(());
            }
            // Existing outbound subscriptions predate preference rows only in legacy imports.
            if !self.raids.should_repair_raid(channel, direction).await?
                && (!condition.truthy("from_broadcaster_user_id")
                    || remote.is_none()
                    || !maps.local_best.contains_key(&key))
            {
                return Ok(());
            }
        }
        let preserved = stored_settings(maps.local_best.get(&key));
        let settings = entry.default_settings().merged(&preserved);
        if let Some(remote) = remote {
            self.report.local_subscriptions_synced += 1;
            if self.dry() {
                let duplicates: Vec<Bson> = maps
                    .local_groups
                    .get(&key)
                    .into_iter()
                    .flatten()
                    .filter(|stored| stored.id.as_deref() != Some(remote.id()))
                    .map(|stored| stored.object_id.clone())
                    .collect();
                if self.plan_removal(maps, duplicates) > 0 {
                    maps.awaiting.remove(&key);
                }
                return Ok(());
            }
            let mut set = Document::new();
            for field in [
                "id",
                "status",
                "type",
                "version",
                "condition",
                "created_at",
                "transport",
                "cost",
            ] {
                if let Some(value) = remote.0.get(field) {
                    set.insert(field, js::from_json(value));
                }
            }
            set.insert("channel", name);
            set.insert("channelID", channel);
            set.extend(settings.to_document());
            self.store()
                .set_returning(
                    "eventsubs.findOneAndUpdate synced",
                    doc! { "id": remote.id() },
                    set,
                    true,
                )
                .await?;
            let duplicates: Vec<Bson> = maps
                .local_groups
                .get(&key)
                .into_iter()
                .flatten()
                .filter(|stored| stored.id.as_deref() != Some(remote.id()))
                .map(|stored| stored.object_id.clone())
                .collect();
            if !duplicates.is_empty() {
                self.report.stale_local_removed += self
                    .store()
                    .delete_ids("eventsubs.deleteMany duplicates", duplicates)
                    .await?;
                maps.awaiting.remove(&key);
            }
            return Ok(());
        }
        if maps.awaiting.contains(&key)
            || maps.removal_failed.contains(&key)
            || maps.planned_bits.contains(&key)
        {
            return Ok(());
        }
        if !self.budget(channel, 1, 0) {
            self.action("create", "missing", channel, entry.kind, None, "deferred");
            return Ok(());
        }
        if self.dry() {
            self.report.subscriptions_created += 1;
            self.action("create", "missing", channel, entry.kind, None, "planned");
            let stale: Vec<Bson> = maps
                .local_groups
                .get(&key)
                .into_iter()
                .flatten()
                .map(|stored| stored.object_id.clone())
                .collect();
            self.plan_removal(maps, stale);
            return Ok(());
        }
        let request = SubscribeRequest::new(channel, entry.kind, entry.version, &condition)
            .settings(&settings)
            .ignore_existing();
        match self.manager.subscribe(&request).await {
            Err(error) => {
                let message = if error.message.is_empty() {
                    error.error.clone()
                } else {
                    error.message.clone()
                };
                self.report
                    .errors
                    .push(format!("{channel}:{}: {message}", entry.kind));
                self.action("create", "missing", channel, entry.kind, None, "failed");
            }
            Ok(record) => {
                self.report.subscriptions_created += 1;
                self.action(
                    "create",
                    "missing",
                    channel,
                    entry.kind,
                    Some(&record.id),
                    "done",
                );
                let stale: Vec<Bson> = maps
                    .local_groups
                    .get(&key)
                    .into_iter()
                    .flatten()
                    .map(|stored| stored.object_id.clone())
                    .collect();
                if !stale.is_empty() {
                    self.report.stale_local_removed += self
                        .store()
                        .delete_ids("eventsubs.deleteMany replaced", stale)
                        .await?;
                }
            }
        }
        if !self.settings.request_delay.is_zero() {
            tokio::time::sleep(self.settings.request_delay).await;
        }
        Ok(())
    }
}

impl Run<'_> {
    /// A dry run's `deleteMany({_id: {$in: ids}})`: counts the documents it would delete (each
    /// once, as `deletedCount` does).
    fn plan_removal(&mut self, maps: &mut Maps, ids: Vec<Bson>) -> u64 {
        let mut deleted = 0;
        for id in ids {
            if maps.removed.insert(id) {
                deleted += 1;
            }
        }
        self.report.stale_local_removed += deleted;
        deleted
    }
}

/// A stored subscription in a group: its `_id` and its Twitch id (when a text).
struct Stored {
    object_id: Bson,
    id: Option<String>,
}

/// What the last steps of a run share.
#[derive(Default)]
struct Maps {
    local_groups: HashMap<String, Vec<Stored>>,
    local_best: HashMap<String, Document>,
    healthy_by_key: HashMap<String, RemoteEventsub>,
    awaiting: HashSet<String>,
    removal_failed: HashSet<String>,
    planned_bits: HashSet<String>,
    /// A dry run's stored documents already counted as deleted.
    removed: HashSet<Bson>,
}

impl EventsubManager {
    /// `reconcileEventsubs(options)`: one run (see the module documentation). `raids` reads the
    /// raid preferences; `control` is checked before every step.
    pub async fn reconcile(
        &self,
        settings: &ReconcileSettings,
        raids: &dyn RaidPreferences,
        control: &dyn RunControl,
    ) -> Result<ReconcileReport, ReconcileError> {
        if !settings.enabled && !settings.dry_run {
            return Err(ReconcileError::Disabled);
        }
        let mut run = Run {
            manager: self,
            settings,
            raids,
            control,
            report: ReconcileReport {
                dry_run: settings.dry_run,
                ..ReconcileReport::default()
            },
            collator: dima_text::Collator::new().ok(),
            creates: 0,
            deletes: 0,
            per_channel: HashMap::new(),
        };
        let outcome = run.run().await;
        let report = Box::new(run.report);
        match outcome {
            Ok(()) => Ok(*report),
            Err(Stop::Cancelled) => Err(ReconcileError::Cancelled(report)),
            Err(Stop::List(message, error)) => Err(ReconcileError::List {
                message,
                error,
                report,
            }),
            Err(Stop::Breaker(unhealthy, total)) => {
                Err(ReconcileError::CircuitBreaker { unhealthy, total })
            }
            Err(Stop::Store(error)) => Err(ReconcileError::Store { error, report }),
        }
    }
}
