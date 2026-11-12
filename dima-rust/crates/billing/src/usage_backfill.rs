//! The backfill: a channel's ledger completed from Polar's own history of its usage.
//!
//! References: `utils/ai_usage_backfill_queue.ts` (the deduplicated queue),
//! `utils/ai_usage_backfill.ts` (one job's sync) and `workers/ai_usage_backfill.worker.ts` (the
//! claim, settle and sweep around it; its loop and its pauses stay with the cron worker that
//! calls [`Backfill::run_one`]).
//!
//! **Why it exists.** It is the reconciliation of the receipt chain: a receipt that never
//! reached the ledger (its process stopped between queueing the usage and queueing the
//! receipt, or the receipt failed its last attempt) is restored from Polar's copy of the usage
//! event, under the same entry id, so the upsert on the receipt's key adds it once. The usage
//! page asks for a backfill whenever the ledger is pending or older than a minute, and a sweep
//! asks for every channel with a customer once a day.
//!
//! **Queue.** `cron:ai-usage-backfills:queue` with its processing and dead-letter lists
//! ([`crate::usage_queue`]); a job enters only if its dedupe key
//! `cron:ai-usage-backfills:dedupe:v3:{channel}:{customer}` was free (`SET NX EX`, the job's id
//! as owner, 48 h): one job per channel and customer at a time. Settling a job, or its last
//! failure, frees the key (owner-checked). Jobs are the reference's JSON
//! (`{id, channelID, customerId, planTier, coverageStart, requestedAt, reason, attempts,
//! dedupeKey}`). Three attempts, then the dead-letter list.
//!
//! **One job** ([`Backfill::sync_job`]): the coverage asked for is clipped to the plan's
//! retention; a ledger that is complete, current and fresh (one minute for a page view, a day
//! for a sweep) is left alone; otherwise Polar's history is read from the earlier of the
//! missing coverage and two days before the last sync, and written with
//! [`crate::usage_ledger::Ledger::backfill`]. Intended difference: the reference then
//! incremented `twitch:{channel}:ai:usage-receipts:generation`, which only the read cache that
//! production no longer calls used; Rust does not write it.

use crate::Observer;
use crate::credit_sources::{CreditSourceReads, PolarCreditSourceReads};
use crate::polar::PolarClient;
use crate::usage_ledger::history::{HistoryError, UsageEvents, fetch_transactions};
use crate::usage_ledger::record::BackfillWrite;
use crate::usage_ledger::report::{DAY_MS, Window, iso, iso_day};
use crate::usage_ledger::zones::Zone;
use crate::usage_ledger::{Ledger, LedgerError, REPORT_VERSION, retention_days, valid_tier};
use crate::usage_queue::{self, Failed, QueueKeys};
use bson::doc;
use dima_core::Random;
use dima_model::StrEnum;
use dima_model::ai_usage_receipts::RetentionTier;
use dima_store::dragonfly::commands::reply;
use dima_store::dragonfly::{
    Dragonfly, DragonflyError, Script, SetCondition, SetExpiry, SetOptions, SetOutcome,
};
use serde_json::{Map, Value};
use std::time::Duration;

static ENQUEUE: Script = Script::new("ENQUEUE_SCRIPT", include_str!("usage_backfill/enqueue.lua"));
static RELEASE: Script = Script::new(
    "RELEASE_LOCK_SCRIPT",
    include_str!("usage_backfill/release.lua"),
);

/// The scripts, for the tests that check them.
pub fn scripts() -> [&'static Script; 2] {
    [&ENQUEUE, &RELEASE]
}

/// The backfill's keys.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct BackfillKeys {
    /// The job queue.
    pub jobs: QueueKeys,
    /// `cron:ai-usage-backfills:dedupe`.
    pub dedupe_prefix: String,
    /// `worker:ai-usage-backfill:daily-sweep`.
    pub sweep_lock: String,
}

impl BackfillKeys {
    /// Production's.
    pub fn production() -> Self {
        Self::prefixed("")
    }

    /// Every key under `prefix` (the tests' isolation).
    pub fn prefixed(prefix: &str) -> Self {
        Self {
            jobs: QueueKeys {
                name: "backfills",
                queue: format!("{prefix}cron:ai-usage-backfills:queue"),
                processing: format!("{prefix}cron:ai-usage-backfills:processing"),
                dead: format!("{prefix}cron:ai-usage-backfills:dead"),
                lease: format!("{prefix}worker:ai-usage-backfill:consumer"),
                health: format!("{prefix}ai-usage:queue-health:backfills"),
            },
            dedupe_prefix: format!("{prefix}cron:ai-usage-backfills:dedupe"),
            sweep_lock: format!("{prefix}worker:ai-usage-backfill:daily-sweep"),
        }
    }

    /// `{dedupe}:v3:{channel}:{customer}`.
    pub fn dedupe(&self, channel: &str, customer: &str) -> String {
        format!(
            "{}:v{REPORT_VERSION}:{channel}:{customer}",
            self.dedupe_prefix
        )
    }
}

/// The backfill's settings (the reference's environment variables, read by the binary).
#[derive(Clone, Debug)]
pub struct BackfillConfig {
    /// `AI_USAGE_BACKFILL_DEDUPE_SECONDS` (172,800; at least 300).
    pub dedupe_seconds: u64,
    /// `AI_USAGE_BACKFILL_OVERLAP_DAYS` (2; at least 1).
    pub overlap_days: f64,
    /// `AI_USAGE_BACKFILL_FRESHNESS_MS` (a day; at least 60,000).
    pub freshness_ms: f64,
    /// `AI_USAGE_BACKFILL_MAX_ATTEMPTS` (3; at least 1).
    pub max_attempts: u32,
    /// `AI_USAGE_BACKFILL_SWEEP_LOCK_SECONDS` (86,400; at least 300).
    pub sweep_lock_seconds: u64,
    /// How long one job may run (Polar's history and the ledger write): 4 minutes.
    pub job_deadline: Duration,
    /// The consumer lease: the job deadline and a margin (5 minutes).
    pub lease_ms: u64,
    /// Users read per page by the sweep (500).
    pub sweep_page: i64,
    /// Pages the sweep reads at most (200: 100,000 users).
    pub sweep_pages: u32,
}

impl Default for BackfillConfig {
    fn default() -> Self {
        Self {
            dedupe_seconds: 172_800,
            overlap_days: 2.0,
            freshness_ms: 86_400_000.0,
            max_attempts: 3,
            sweep_lock_seconds: 86_400,
            job_deadline: Duration::from_secs(240),
            lease_ms: 300_000,
            sweep_page: 500,
            sweep_pages: 200,
        }
    }
}

/// Why a backfill was asked for.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Reason {
    /// A usage page found the ledger pending or stale.
    ApiRequest,
    /// The daily sweep.
    DailySweep,
    /// The sweep at start-up.
    StartupSweep,
}

impl Reason {
    /// The reference's text.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::ApiRequest => "api_request",
            Self::DailySweep => "daily_sweep",
            Self::StartupSweep => "startup_sweep",
        }
    }
}

/// `AiUsageBackfillJob`.
#[derive(Clone, Debug, PartialEq)]
pub struct Job {
    /// `id` (the dedupe key's owner).
    pub id: String,
    /// `channelID`.
    pub channel_id: String,
    /// `customerId`.
    pub customer_id: dima_model::Private<String>,
    /// `planTier` (the user's current plan replaces it when the job runs).
    pub plan_tier: String,
    /// `coverageStart` (ms).
    pub coverage_start_ms: i64,
    /// `requestedAt` (ms).
    pub requested_at_ms: i64,
    /// `reason`.
    pub reason: Reason,
    /// `attempts`.
    pub attempts: f64,
    /// `dedupeKey`.
    pub dedupe_key: String,
}

impl Job {
    /// `JSON.stringify(job)`.
    pub fn to_json(&self) -> String {
        let mut map = Map::new();
        map.insert("id".into(), Value::from(self.id.as_str()));
        map.insert("channelID".into(), Value::from(self.channel_id.as_str()));
        map.insert(
            "customerId".into(),
            Value::from(self.customer_id.expose().as_str()),
        );
        map.insert("planTier".into(), Value::from(self.plan_tier.as_str()));
        map.insert(
            "coverageStart".into(),
            Value::from(iso(self.coverage_start_ms)),
        );
        map.insert("requestedAt".into(), Value::from(iso(self.requested_at_ms)));
        map.insert("reason".into(), Value::from(self.reason.as_str()));
        map.insert(
            "attempts".into(),
            crate::usage_ledger::report::num(self.attempts),
        );
        map.insert("dedupeKey".into(), Value::from(self.dedupe_key.as_str()));
        dima_text::to_js_json(&Value::Object(map))
    }
}

/// `normalizeTier(value)`.
fn normalize_tier(value: Option<&str>) -> RetentionTier {
    valid_tier(value)
}

/// `safePart(value)`.
fn safe_part(value: Option<&Value>) -> String {
    value
        .and_then(Value::as_str)
        .map(|text| dima_text::trim(text).to_owned())
        .unwrap_or_default()
}

/// `new Date(String(value || ''))`.
fn date_of(value: Option<&Value>) -> Option<i64> {
    if !crate::js::truthy(value) {
        return None;
    }
    dima_text::parse_date(&dima_text::string_of(value?))
}

/// `parseAiUsageBackfillJob(raw)`.
pub fn parse_job(raw: &[u8]) -> Option<Job> {
    let parsed: Value = serde_json::from_slice(&dima_text::sanitize_lone_surrogates(raw)).ok()?;
    let get = |key: &str| parsed.get(key);
    let (id, channel, customer, dedupe) = (
        safe_part(get("id")),
        safe_part(get("channelID")),
        safe_part(get("customerId")),
        safe_part(get("dedupeKey")),
    );
    if id.is_empty() || channel.is_empty() || customer.is_empty() || dedupe.is_empty() {
        return None;
    }
    let coverage = date_of(get("coverageStart"))?;
    let requested = date_of(get("requestedAt"))?;
    let reason = match get("reason").and_then(Value::as_str) {
        Some("daily_sweep") => Reason::DailySweep,
        Some("startup_sweep") => Reason::StartupSweep,
        _ => Reason::ApiRequest,
    };
    let attempts = get("attempts")
        .and_then(Value::as_f64)
        .filter(|a| a.fract() == 0.0)
        .unwrap_or(0.0);
    Some(Job {
        id,
        channel_id: channel,
        customer_id: dima_model::Private::new(customer),
        plan_tier: normalize_tier(get("planTier").and_then(Value::as_str))
            .as_str()
            .to_owned(),
        coverage_start_ms: coverage,
        requested_at_ms: requested,
        reason,
        attempts: crate::js::max(0.0, attempts),
        dedupe_key: dedupe,
    })
}

/// `getAiUsageDesiredCoverageStart(planTier, now)`: midnight UTC of the first day the plan
/// keeps.
pub fn desired_coverage_start(plan_tier: Option<&str>, now_ms: i64) -> i64 {
    let days = retention_days(valid_tier(plan_tier));
    (now_ms.div_euclid(DAY_MS) - (days - 1)) * DAY_MS
}

/// What `enqueueAiUsageBackfill` is called with.
#[derive(Clone, Copy, Debug)]
pub struct EnqueueInput<'a> {
    /// `channelID`.
    pub channel_id: &'a str,
    /// `customerId`.
    pub customer_id: &'a str,
    /// `planTier`.
    pub plan_tier: Option<&'a str>,
    /// `coverageStart` (default: [`desired_coverage_start`]).
    pub coverage_start_ms: Option<i64>,
    /// `reason` (default `api_request`).
    pub reason: Option<Reason>,
    /// `now`.
    pub now_ms: i64,
}

/// Why a backfill failed.
#[derive(Debug, thiserror::Error)]
pub enum BackfillError {
    /// `AI usage backfill requires channel and customer IDs`.
    #[error("AI usage backfill requires channel and customer IDs")]
    MissingIds,
    /// Dragonfly failed.
    #[error(transparent)]
    Dragonfly(#[from] DragonflyError),
    /// The ledger failed.
    #[error(transparent)]
    Ledger(#[from] LedgerError),
    /// Polar's history could not be read.
    #[error(transparent)]
    History(#[from] HistoryError),
    /// A job passed [`BackfillConfig::job_deadline`]; it stays claimed until the lease expires.
    #[error("AI usage backfill job timed out")]
    Timeout,
}

impl From<BackfillError> for LedgerError {
    fn from(error: BackfillError) -> Self {
        match error {
            BackfillError::Ledger(error) => error,
            BackfillError::Dragonfly(error) => Self::Dragonfly(error),
            other => Self::Mongo(other.to_string()),
        }
    }
}

/// The queue's producer side.
#[derive(Clone, Copy)]
pub struct BackfillQueue<'a> {
    /// Dragonfly.
    pub dragonfly: &'a Dragonfly,
    /// Keys.
    pub keys: &'a BackfillKeys,
    /// Settings.
    pub config: &'a BackfillConfig,
    /// Job ids.
    pub random: &'a dyn Random,
}

impl std::fmt::Debug for BackfillQueue<'_> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("BackfillQueue")
    }
}

impl BackfillQueue<'_> {
    /// `enqueueAiUsageBackfill(cache, input)`: `(enqueued, job)`; `false` when a job of this
    /// channel and customer is already waiting or running.
    pub async fn enqueue(&self, input: &EnqueueInput<'_>) -> Result<(bool, Job), BackfillError> {
        let channel = dima_text::trim(input.channel_id);
        let customer = dima_text::trim(input.customer_id);
        if channel.is_empty() || customer.is_empty() {
            return Err(BackfillError::MissingIds);
        }
        let tier = normalize_tier(input.plan_tier);
        let coverage = input
            .coverage_start_ms
            .unwrap_or_else(|| desired_coverage_start(Some(tier.as_str()), input.now_ms));
        let dedupe_key = self.keys.dedupe(channel, customer);
        let job = Job {
            id: self
                .random
                .uuid_v4()
                .map_err(|_| DragonflyError::Reply("job id unavailable"))?,
            channel_id: channel.to_owned(),
            customer_id: dima_model::Private::new(customer.to_owned()),
            plan_tier: tier.as_str().to_owned(),
            coverage_start_ms: coverage,
            requested_at_ms: input.now_ms,
            reason: input.reason.unwrap_or(Reason::ApiRequest),
            attempts: 0.0,
            dedupe_key: dedupe_key.clone(),
        };
        let seconds = self.config.dedupe_seconds.max(300).to_string();
        let text = job.to_json();
        let enqueued = ENQUEUE
            .run_value(
                self.dragonfly,
                &[dedupe_key.as_str(), self.keys.jobs.queue.as_str()],
                &[job.id.as_str(), seconds.as_str(), text.as_str()],
            )
            .await?;
        Ok((reply::int(enqueued)? == 1, job))
    }

    /// Frees a job's dedupe key if the job still owns it.
    async fn release_dedupe(&self, job: &Job) -> Result<(), DragonflyError> {
        RELEASE
            .run_value(
                self.dragonfly,
                &[job.dedupe_key.as_str()],
                &[job.id.as_str()],
            )
            .await
            .map(|_| ())
    }
}

/// `AiUsageBackfillResult`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SyncResult {
    /// `synced` or, when nothing needed reading, `fresh`.
    pub synced: bool,
    /// `channelID`.
    pub channel_id: String,
    /// `coverageStart` (ISO).
    pub coverage_start: String,
    /// `fetchedFrom` (ISO).
    pub fetched_from: Option<String>,
    /// `transactionCount`.
    pub transaction_count: usize,
}

/// What one [`Backfill::run_one`] did.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum BackfillTick {
    /// No job waits.
    Idle,
    /// Another consumer holds the lease.
    Busy,
    /// The lease passed to another consumer during the call.
    LeaseLost,
    /// A job that cannot be read went to the dead-letter list.
    Invalid,
    /// The channel no longer belongs to the job's customer: settled without reading Polar.
    Skipped,
    /// Synced (or found fresh).
    Synced(SyncResult),
    /// Failed; requeued for another attempt, or dead-lettered after the last.
    Failed {
        /// Dead-lettered.
        dead: bool,
        /// Why.
        message: String,
    },
}

/// Gives the credit-source reads of one customer (Polar's grants and orders).
pub trait CreditReads: Send + Sync {
    /// The reads for `customer_id`.
    fn for_customer<'a>(&'a self, customer_id: &str) -> Box<dyn CreditSourceReads + 'a>;
}

impl CreditReads for PolarClient {
    fn for_customer<'a>(&'a self, customer_id: &str) -> Box<dyn CreditSourceReads + 'a> {
        Box::new(PolarCreditSourceReads::new(self, customer_id))
    }
}

/// The backfill's consumer side.
#[derive(Clone, Copy)]
pub struct Backfill<'a> {
    /// The queue.
    pub queue: BackfillQueue<'a>,
    /// The ledger.
    pub ledger: Ledger<'a>,
    /// Polar's events.
    pub events: &'a dyn UsageEvents,
    /// Polar's grants and orders.
    pub credit_reads: &'a dyn CreditReads,
    /// What the reference logged.
    pub observer: &'a dyn Observer,
}

impl std::fmt::Debug for Backfill<'_> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("Backfill")
    }
}

impl Backfill<'_> {
    /// `syncAiUsageBackfillJob(job, cache, now)` (see the module docs).
    pub async fn sync_job(&self, job: &Job, now_ms: i64) -> Result<SyncResult, BackfillError> {
        let tier = valid_tier(Some(job.plan_tier.as_str()));
        let floor = now_ms - retention_days(tier) * DAY_MS;
        let coverage = job.coverage_start_ms.max(floor);
        let customer = job.customer_id.expose().as_str();
        let state = self.ledger.ledger_state(&job.channel_id, customer).await?;
        #[allow(clippy::cast_precision_loss)]
        let upgrade = state
            .as_ref()
            .is_none_or(|s| s.report_version < REPORT_VERSION as f64);
        let earlier = upgrade
            || state
                .as_ref()
                .is_none_or(|s| s.coverage_start_ms > coverage);
        let freshness = if job.reason == Reason::ApiRequest {
            60_000.0
        } else {
            self.queue.config.freshness_ms.max(60_000.0)
        };
        let backfilled = |s: &crate::usage_ledger::state::LedgerState| {
            s.backfilled_at_ms
                .ok_or(LedgerError::Malformed("ledger state backfilledAt"))
        };
        if let Some(s) = &state {
            #[allow(clippy::cast_precision_loss)]
            let fresh = ((now_ms - backfilled(s)?) as f64) < freshness;
            if !earlier && fresh {
                return Ok(SyncResult {
                    synced: false,
                    channel_id: job.channel_id.clone(),
                    coverage_start: iso(s.coverage_start_ms),
                    fetched_from: None,
                    transaction_count: 0,
                });
            }
        }
        let overlap_days = self.queue.config.overlap_days.max(1.0);
        #[allow(clippy::cast_possible_truncation)]
        let overlap = (overlap_days * 86_400_000.0) as i64;
        let overlap_start = match &state {
            Some(s) => floor.max(backfilled(s)? - overlap),
            None => coverage,
        };
        let fetch_start = if earlier && coverage < overlap_start {
            coverage
        } else {
            overlap_start
        };
        let window = Window {
            from: iso_day(fetch_start),
            to: iso_day(now_ms),
            zone: Zone::utc(),
            start_ms: fetch_start,
            end_exclusive_ms: now_ms,
            days: Vec::new(),
        };
        let mut reads = self.queue_credit_reads(customer);
        let transactions =
            fetch_transactions(customer, &window, self.events, reads.as_mut()).await?;
        self.ledger
            .backfill(&BackfillWrite {
                channel_id: &job.channel_id,
                customer_id: customer,
                plan_tier: Some(job.plan_tier.as_str()),
                coverage_start_ms: coverage,
                rebuild_start_ms: Some(fetch_start),
                transactions: &transactions,
                now_ms,
            })
            .await?;
        Ok(SyncResult {
            synced: true,
            channel_id: job.channel_id.clone(),
            coverage_start: iso(coverage),
            fetched_from: Some(iso(fetch_start)),
            transaction_count: transactions.len(),
        })
    }

    fn queue_credit_reads(&self, customer: &str) -> Box<dyn CreditSourceReads + '_> {
        self.credit_reads.for_customer(customer)
    }

    /// The owner of `channel`: `(plan_tier, polar_sh_customer_id)`, or `None`.
    async fn owner(
        &self,
        channel: &str,
    ) -> Result<Option<(Option<String>, Option<String>)>, LedgerError> {
        let user = crate::usage_ledger::ops::find_one(
            &self.ledger,
            dima_model::users::COLLECTION,
            doc! { "accounts": { "$elemMatch": { "type": "twitch", "id": channel } } },
            Some(doc! { "plan_tier": 1, "polar_sh_customer_id": 1 }),
        )
        .await?;
        Ok(user.map(|user| {
            (
                user.get_str("plan_tier").ok().map(str::to_owned),
                user.get_str("polar_sh_customer_id").ok().map(str::to_owned),
            )
        }))
    }

    /// The worker's `processOne`: claims one job, syncs it, and settles it (see the module
    /// docs). One job per call; the caller paces the calls (the reference waited
    /// `AI_USAGE_BACKFILL_REQUEST_DELAY_MS`, at least 250 ms and 1 s by default, after each job,
    /// and `AI_USAGE_BACKFILL_QUEUE_WAIT_SECONDS`, 5 s, when the queue was empty).
    pub async fn run_one(&self) -> Result<BackfillTick, BackfillError> {
        let dragonfly = self.queue.dragonfly;
        let keys = &self.queue.keys.jobs;
        let config = self.queue.config;
        let Some(lease) =
            usage_queue::acquire(dragonfly, keys, self.queue.random, config.lease_ms).await?
        else {
            return Ok(BackfillTick::Busy);
        };
        let outcome = tokio::time::timeout(config.job_deadline, self.run_one_leased(&lease)).await;
        match outcome {
            Ok(tick) => {
                usage_queue::release(dragonfly, keys, &lease).await;
                tick
            }
            // The job stays claimed; the lease (kept) expires after the abandoned work.
            Err(_) => Err(BackfillError::Timeout),
        }
    }

    async fn run_one_leased(
        &self,
        lease: &usage_queue::Lease,
    ) -> Result<BackfillTick, BackfillError> {
        let dragonfly = self.queue.dragonfly;
        let keys = &self.queue.keys.jobs;
        let now = self.ledger.clock.now_ms();
        let Some((_, items)) = usage_queue::claim(dragonfly, keys, lease, 1, now).await? else {
            return Ok(BackfillTick::LeaseLost);
        };
        let Some(raw) = items.into_iter().next() else {
            return Ok(BackfillTick::Idle);
        };
        let Some(mut job) = parse_job(raw.as_bytes()) else {
            if usage_queue::fail(dragonfly, keys, lease, &raw, 1)
                .await?
                .is_none()
            {
                return Ok(BackfillTick::LeaseLost);
            }
            self.observer.error(
                "ai_usage_backfill",
                "Invalid backfill job moved to dead-letter queue",
            );
            return Ok(BackfillTick::Invalid);
        };
        let attempt = async {
            let customer = job.customer_id.expose().clone();
            let owner = self.owner(&job.channel_id).await?;
            match owner {
                Some((tier, Some(owner_customer))) if owner_customer == customer => {
                    job.plan_tier = tier
                        .filter(|t| !t.is_empty())
                        .unwrap_or_else(|| "free".into());
                    Ok(Some(self.sync_job(&job, self.ledger.clock.now_ms()).await?))
                }
                _ => Ok::<_, BackfillError>(None),
            }
        }
        .await;
        match attempt {
            Ok(result) => {
                if !usage_queue::complete(dragonfly, keys, lease, &raw).await? {
                    return Ok(BackfillTick::LeaseLost);
                }
                self.queue.release_dedupe(&job).await?;
                Ok(match result {
                    Some(result) => BackfillTick::Synced(result),
                    None => BackfillTick::Skipped,
                })
            }
            Err(error) => {
                let message = error.to_string();
                let Some(failed) = usage_queue::fail(
                    dragonfly,
                    keys,
                    lease,
                    &raw,
                    self.queue.config.max_attempts.max(1),
                )
                .await?
                else {
                    return Ok(BackfillTick::LeaseLost);
                };
                let dead = failed == Failed::DeadLettered;
                if dead {
                    self.queue.release_dedupe(&job).await?;
                }
                self.observer.error(
                    "ai_usage_backfill",
                    if dead {
                        "AI usage backfill exhausted retries"
                    } else {
                        "AI usage backfill requeued after failure"
                    },
                );
                Ok(BackfillTick::Failed { dead, message })
            }
        }
    }

    /// The worker's `enqueueSweep(reason)`: under the sweep lock (taken for
    /// [`BackfillConfig::sweep_lock_seconds`] and released after), a job for every Twitch
    /// account of every user with a Polar customer, read in pages of
    /// [`BackfillConfig::sweep_page`] users. Returns how many jobs entered the queue; `0` when
    /// another sweep holds the lock.
    pub async fn enqueue_sweep(&self, reason: Reason) -> Result<usize, BackfillError> {
        let dragonfly = self.queue.dragonfly;
        let owner = self
            .queue
            .random
            .uuid_v4()
            .map_err(|_| DragonflyError::Reply("sweep token unavailable"))?;
        let options = SetOptions {
            condition: SetCondition::IfMissing,
            expiry: SetExpiry::Seconds(self.queue.config.sweep_lock_seconds.max(300)),
            get: false,
        };
        let key = &self.queue.keys.sweep_lock;
        if dragonfly.set(key, owner.as_bytes(), options).await? != SetOutcome::Written {
            return Ok(0);
        }
        let outcome = self.sweep(reason).await;
        let _ = RELEASE
            .run_value(dragonfly, &[key.as_str()], &[owner.as_str()])
            .await;
        outcome
    }

    async fn sweep(&self, reason: Reason) -> Result<usize, BackfillError> {
        let mut enqueued = 0;
        let mut after: Option<bson::Bson> = None;
        for _ in 0..self.queue.config.sweep_pages {
            let mut filter = doc! {
                "polar_sh_customer_id": { "$type": "string", "$ne": "" },
                "accounts": { "$elemMatch": { "type": "twitch", "id": { "$type": "string", "$ne": "" } } },
            };
            if let Some(last) = &after {
                filter.insert("_id", doc! { "$gt": last.clone() });
            }
            let users = crate::usage_ledger::ops::find(
                &self.ledger,
                dima_model::users::COLLECTION,
                filter,
                Some(doc! { "_id": 1 }),
                Some(doc! { "accounts": 1, "polar_sh_customer_id": 1, "plan_tier": 1 }),
                self.queue.config.sweep_page,
            )
            .await?;
            let Some(last) = users.last().and_then(|u| u.get("_id")).cloned() else {
                return Ok(enqueued);
            };
            for user in &users {
                let customer = user.get_str("polar_sh_customer_id").unwrap_or_default();
                let tier = user.get_str("plan_tier").ok();
                let mut channels: Vec<String> = Vec::new();
                for account in user
                    .get_array("accounts")
                    .map(Vec::as_slice)
                    .unwrap_or_default()
                {
                    let Some(account) = account.as_document() else {
                        continue;
                    };
                    if account.get_str("type").ok() != Some("twitch") {
                        continue;
                    }
                    let id = match account.get("id") {
                        Some(bson::Bson::String(id)) if !id.is_empty() => id.clone(),
                        Some(bson::Bson::Int32(id)) if *id != 0 => id.to_string(),
                        Some(bson::Bson::Int64(id)) if *id != 0 => id.to_string(),
                        _ => continue,
                    };
                    if !channels.contains(&id) {
                        channels.push(id);
                    }
                }
                for channel in channels {
                    let (added, _) = self
                        .queue
                        .enqueue(&EnqueueInput {
                            channel_id: &channel,
                            customer_id: customer,
                            plan_tier: tier,
                            coverage_start_ms: None,
                            reason: Some(reason),
                            now_ms: self.ledger.clock.now_ms(),
                        })
                        .await?;
                    if added {
                        enqueued += 1;
                    }
                }
            }
            if i64::try_from(users.len()).unwrap_or(i64::MAX) < self.queue.config.sweep_page {
                return Ok(enqueued);
            }
            after = Some(last);
        }
        self.observer.error(
            "ai_usage_backfill",
            "sweep stopped at its page bound; the next sweep starts again",
        );
        Ok(enqueued)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // ai_usage_ledger.test.ts: "background backfill jobs keep tier retention boundaries and reject malformed payloads"
    #[test]
    fn background_backfill_jobs_keep_tier_retention_boundaries_and_reject_malformed_payloads() {
        let now = dima_text::parse_date("2026-09-19T12:00:00.000Z").unwrap();
        assert_eq!(
            iso(desired_coverage_start(Some("free"), now)),
            "2026-08-21T00:00:00.000Z"
        );
        assert_eq!(
            iso(desired_coverage_start(Some("premium"), now)),
            "2026-07-22T00:00:00.000Z"
        );
        assert_eq!(
            iso(desired_coverage_start(Some("pro"), now)),
            "2026-06-22T00:00:00.000Z"
        );
        assert_eq!(parse_job(b"{"), None);
        assert_eq!(parse_job(br#"{"id":"missing-fields"}"#), None);
        let parsed = parse_job(br#"{"id":"job-1","channelID":"channel-1","customerId":"customer-1","planTier":"pro","coverageStart":"2026-06-22T00:00:00.000Z","requestedAt":"2026-09-19T12:00:00.000Z","reason":"daily_sweep","attempts":1,"dedupeKey":"dedupe-1"}"#).unwrap();
        assert_eq!(parsed.plan_tier, "pro");
        assert_eq!(parsed.reason, Reason::DailySweep);
        assert_eq!(parsed.attempts, 1.0);
        for script in scripts() {
            assert!(script.check().is_ok());
        }
    }
}
