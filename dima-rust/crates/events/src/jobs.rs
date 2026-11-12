//! Durable cron-job intents: the MongoDB record that makes a cron job accepted exactly once, on
//! top of the store's Dragonfly cron queue that delivers it at least once
//! (`utils/durable_cron_jobs.ts`, and the durable route of `enqueueCronJob` in
//! `utils/cron_jobs_queue.ts`).
//!
//! # Exactly once accepted, at least once delivered
//!
//! [`DurableJobs::prepare`] inserts one `cron_job_intents` document per job. Three unique keys
//! decide what "the same job" is: `jobID`, the permanent `automaticKey` of an automatic session
//! job, and the `activeKey` (`<queue>\0<dedupeKey>`) while the job holds its dedupe window. A
//! duplicate key on any of them means "already accepted": the existing intent is returned, never
//! a second one. Publishing to Dragonfly comes after the record and may happen many times
//! ([`DurableJobs::publish`], and [`DurableJobs::recover`] every 30 s for a queued intent): the
//! queue can hold or deliver a job twice, so the worker's [`DurableJobs::claim`] is the fence: a
//! compare-and-set from `queued` to `processing` under a 5-minute lease with a fresh token, which
//! only one worker wins; every later transition matches that token and an unexpired lease.
//! A lease that expires is not reclaimed: the old worker may have caused an outside effect, so
//! [`DurableJobs::recover`] marks it `uncertain` and nothing replays it automatically.
//!
//! # Carried across the cutover
//!
//! The intents are MongoDB documents, so nothing about them changes at the cutover: an intent
//! still `queued` is published again by the Rust [`DurableJobs::recover`] into the Rust queue
//! within 30 s, and one `processing` under a TypeScript lease is fenced by its token (the Rust
//! worker sees `busy`, then `uncertain` once the lease expires). The Dragonfly queue items are
//! Rust's own encoding (`JSON.stringify` of the stored payload is not needed: the `LPOS` check
//! compares items Rust wrote with items Rust writes); the TypeScript queues in database 0 are
//! drained by the TypeScript workers before they stop, and whatever they leave is republished
//! from MongoDB. `cron:jobs:accepted:*` markers are only written, never read by the durable path
//! (a legacy marker without an intent is read once by `enqueue`, see
//! [`DurableJobs::enqueue`]): *rebuilt* is enough.

use crate::identity::{automatic_acceptance_key, intent_active_key};
use crate::store::{StoreError, bounded, bounded_dragonfly, bounded_write, duplicate_key};
use crate::value::Value;
use bson::{Bson, Document, doc, oid::ObjectId};
use dima_core::{Clock, Random};
use dima_model::cron_job_intents::{COLLECTION, INFO, intent_write_concern};
use dima_model::index::RequiredIndexError;
use dima_model::{IndexReport, ModelError};
use dima_store::dragonfly::cron_queue::{CronQueueJob, EnqueuePlan, publish_durable_cron_job};
use dima_store::dragonfly::{Dragonfly, QueueItem};
use dima_store::mongo::update::{Returned, UpdateOptions};
use dima_store::mongo::{MongoStore, WriteContext};
use mongodb::options::ReturnDocument;
use std::future::Future;
use std::sync::Arc;
use std::time::Duration;

/// `DURABLE_CRON_LEASE_MS`: a claim's lease.
pub const LEASE_MS: i64 = 5 * 60_000;
/// `REPUBLISH_INTERVAL_MS`: how long a published intent waits before [`DurableJobs::recover`]
/// publishes it again.
pub const REPUBLISH_INTERVAL_MS: i64 = 30_000;
/// `MAX_RECOVERY_BATCH`.
pub const MAX_RECOVERY_BATCH: i64 = 100;

/// The legacy dedupe windows (`legacyDedupeSeconds`), read once at startup from
/// `STREAM_MEMORY_SUMMARY_DEDUPE_SECONDS`, `STREAM_MEMORY_WEEKLY_DEDUPE_SECONDS`,
/// `STREAM_MEMORY_MONTHLY_DEDUPE_SECONDS` and `CLIP_RECOMMENDATIONS_DEDUPE_SECONDS` with
/// `Number(value || default)` (`NaN` when the text is not a number).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct JobsConfig {
    /// `stream-memory-summary` (default 12 h).
    pub summary_dedupe_seconds: f64,
    /// `memory-maintenance-weekly` (default 7 days).
    pub weekly_dedupe_seconds: f64,
    /// `memory-maintenance-monthly` (default 31 days).
    pub monthly_dedupe_seconds: f64,
    /// Every other job, clip analysis included (default 6 h).
    pub clip_dedupe_seconds: f64,
    /// The bound on each store call.
    pub store_deadline: Duration,
}

impl Default for JobsConfig {
    fn default() -> Self {
        Self {
            summary_dedupe_seconds: 12.0 * 3600.0,
            weekly_dedupe_seconds: 7.0 * 86_400.0,
            monthly_dedupe_seconds: 31.0 * 86_400.0,
            clip_dedupe_seconds: 6.0 * 3600.0,
            store_deadline: crate::store::DEFAULT_STORE_DEADLINE,
        }
    }
}

impl JobsConfig {
    /// `Number(value || default)` of one of the environment values.
    pub fn seconds_from_env(value: Option<&str>, default: f64) -> f64 {
        match value.filter(|text| !text.is_empty()) {
            Some(text) => dima_text::parse_number(text),
            None => default,
        }
    }
}

/// Publishes an intent's job to its Dragonfly queue (the `PUBLISH_DURABLE_CRON_JOB` script):
/// `true` when it was pushed, `false` when an identical item was already among the first 1,000.
pub trait JobQueue: Send + Sync {
    /// Pushes `payload` to `queue_key` unless already queued, and sets `automatic_key`.
    fn publish(
        &self,
        queue_key: &str,
        automatic_key: Option<&str>,
        payload: &QueueItem,
    ) -> impl Future<Output = Result<bool, StoreError>> + Send;

    /// Whether a legacy acceptance marker (`cron:jobs:accepted:*`) exists.
    fn marker_exists(&self, key: &str) -> impl Future<Output = Result<bool, StoreError>> + Send;
}

/// The production queue: the store's cron queue on Dragonfly.
#[derive(Clone, Debug)]
pub struct DragonflyQueue {
    /// The client.
    pub dragonfly: Dragonfly,
    /// The bound on each call.
    pub deadline: Duration,
}

impl JobQueue for DragonflyQueue {
    async fn publish(
        &self,
        queue_key: &str,
        automatic_key: Option<&str>,
        payload: &QueueItem,
    ) -> Result<bool, StoreError> {
        bounded_dragonfly(
            "publish the cron job",
            self.deadline,
            publish_durable_cron_job(&self.dragonfly, queue_key, automatic_key, payload),
        )
        .await
    }

    async fn marker_exists(&self, key: &str) -> Result<bool, StoreError> {
        bounded_dragonfly(
            "read the acceptance marker",
            self.deadline,
            self.dragonfly.exists(&[key]),
        )
        .await
        .map(|count| count > 0)
    }
}

/// A failed intent operation.
#[derive(Debug, thiserror::Error)]
pub enum JobError {
    /// The reference's own errors (`Invalid durable cron job identity`, `Invalid dedupe
    /// duration`...): the caller's input is wrong.
    #[error("{0}")]
    Invalid(String),
    /// MongoDB or Dragonfly failed or timed out (an `outcome_unknown` write may have been
    /// applied: every operation here is safe to retry).
    #[error(transparent)]
    Store(#[from] StoreError),
    /// The model refused a write.
    #[error(transparent)]
    Model(#[from] ModelError),
    /// A stored intent could not be read.
    #[error("stored intent: {0}")]
    Stored(String),
}

/// `ICronJobIntent['status']` as stored.
pub type IntentStatus = String;

/// `PrepareDurableCronJobOptions`.
#[derive(Clone, Debug, PartialEq)]
pub struct PrepareOptions {
    /// The dedupe window.
    pub dedupe_seconds: f64,
    /// The automatic acceptance key the caller computed (must equal the job's).
    pub acceptance_key: Option<String>,
    /// The legacy Dragonfly acceptance marker of this automatic job exists.
    pub legacy_accepted: bool,
}

/// `PreparedDurableCronJob`.
#[derive(Clone, Debug, PartialEq)]
pub struct Prepared {
    /// The canonical job (the stored one when it already existed).
    pub job: CronQueueJob,
    /// A new intent was created.
    pub created: bool,
    /// Always `true` (an accepted job, new or not).
    pub accepted: bool,
    /// Its status.
    pub status: IntentStatus,
}

/// `DurableCronJobClaim`: the fence of a claimed intent.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Claim {
    /// The intent's `_id` as hex.
    pub intent_id: String,
    /// The queue.
    pub queue_key: String,
    /// The claiming worker.
    pub owner: String,
    /// The lease token.
    pub token: String,
}

/// `DurableClaimResult`.
#[derive(Clone, Debug, PartialEq)]
pub enum ClaimResult {
    /// This worker holds the lease.
    Claimed {
        /// The canonical job.
        job: CronQueueJob,
        /// The fence.
        claim: Claim,
    },
    /// Queued but not due, or leased by another worker.
    Busy {
        /// The canonical job.
        job: CronQueueJob,
    },
    /// Completed, dead, uncertain or legacy-accepted: not to run.
    Terminal {
        /// The canonical job.
        job: CronQueueJob,
    },
}

/// What [`DurableJobs::recover`] did.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Recovered {
    /// Due intents published again (or found already queued).
    pub examined: u32,
    /// Of those, pushed to the queue.
    pub published: u32,
    /// Expired leases marked `uncertain`.
    pub uncertain: u32,
}

/// `createDurableCronJobs(dependencies)`.
#[derive(Clone, Debug)]
pub struct DurableJobs<Q> {
    store: MongoStore,
    queue: Q,
    clock: Arc<dyn Clock>,
    random: Arc<dyn Random>,
    config: JobsConfig,
}

/// The job as stored: the object `JSON.stringify` would see (properties in `CronQueueJob`
/// order, `undefined` ones left out), as BSON.
pub fn job_document(job: &CronQueueJob) -> Result<Document, JobError> {
    let json = serde_json::to_value(job).map_err(|e| JobError::Invalid(e.to_string()))?;
    match Value::from_json(&json) {
        Value::Object(object) => object
            .to_bson()
            .map_err(|e| JobError::Invalid(e.to_string())),
        _ => Err(JobError::Invalid("a job is an object".into())),
    }
}

/// A stored payload as a job (what the reference hands back: `intent.payload`).
pub fn stored_job(payload: Option<&Bson>) -> Result<CronQueueJob, JobError> {
    let Some(Bson::Document(payload)) = payload else {
        return Err(JobError::Stored("payload is not a document".into()));
    };
    let json = match Value::from_bson(&Bson::Document(payload.clone())).to_json() {
        Some(json) => json,
        None => return Err(JobError::Stored("payload is not JSON".into())),
    };
    let text = |key: &str| {
        json.get(key)
            .and_then(serde_json::Value::as_str)
            .map(str::to_owned)
    };
    Ok(CronQueueJob {
        id: text("id").unwrap_or_default(),
        job: text("job").unwrap_or_default(),
        requested_at: text("requestedAt").unwrap_or_default(),
        requested_by: text("requestedBy"),
        user_id: text("userID"),
        account_id: text("accountID"),
        channel_id: text("channelID"),
        data: json.get("data").cloned(),
        dedupe_key: text("dedupeKey"),
    })
}

/// `Number(value)` of a JSON value.
fn js_number(value: &serde_json::Value) -> f64 {
    match value {
        serde_json::Value::Null => 0.0,
        serde_json::Value::Bool(flag) => f64::from(u8::from(*flag)),
        serde_json::Value::Number(number) => number.as_f64().unwrap_or(f64::NAN),
        serde_json::Value::String(text) => dima_text::parse_number(text),
        serde_json::Value::Array(_) => dima_text::parse_number(&dima_text::string_of(value)),
        serde_json::Value::Object(_) => f64::NAN,
    }
}

fn truthy(value: &serde_json::Value) -> bool {
    Value::from_json(value).truthy()
}

/// `job.data?.<key>`.
fn data_field<'a>(job: &'a CronQueueJob, key: &str) -> Option<&'a serde_json::Value> {
    job.data.as_ref().and_then(|data| data.get(key))
}

/// `durableAutomaticAcceptanceKey(job)`.
pub fn job_automatic_key(job: &CronQueueJob) -> Option<String> {
    automatic_acceptance_key(
        &job.job,
        job.channel_id.as_deref(),
        data_field(job, "source"),
        data_field(job, "sessionID"),
    )
}

/// `activeKey(job, queueKey)`.
pub fn job_active_key(job: &CronQueueJob, queue_key: &str) -> String {
    intent_active_key(queue_key, job.dedupe_key.as_deref(), &job.id)
}

/// `dueAt(job, now)`: `data.notBeforeUnix` seconds when positive and later than now.
fn due_at(job: &CronQueueJob, now_ms: i64) -> i64 {
    let unix = data_field(job, "notBeforeUnix")
        .filter(|value| truthy(value))
        .map_or(0.0, js_number);
    if unix.is_finite() && unix > 0.0 {
        let at = (unix * 1000.0).trunc();
        if at > now_ms as f64 {
            at as i64
        } else {
            now_ms
        }
    } else {
        now_ms
    }
}

fn assert_job(job: &CronQueueJob, queue_key: &str) -> Result<(), JobError> {
    if job.id.is_empty()
        || job.job.is_empty()
        || queue_key.is_empty()
        || job.requested_at.is_empty()
    {
        return Err(JobError::Invalid(
            "Invalid durable cron job identity".into(),
        ));
    }
    Ok(())
}

fn date_ms(document: &Document, field: &str) -> Option<i64> {
    match document.get(field) {
        Some(Bson::DateTime(date)) => Some(date.timestamp_millis()),
        _ => None,
    }
}

fn status_of(document: &Document) -> &str {
    document.get_str("status").unwrap_or_default()
}

fn date(ms: i64) -> bson::DateTime {
    bson::DateTime::from_millis(ms)
}

impl<Q: JobQueue> DurableJobs<Q> {
    /// The intents on `store`, publishing to `queue`, writable once the unique indexes of
    /// `cron_job_intents` exist (`indexes` is its startup report; the reference awaits
    /// `model.init()` before every acceptance and claim).
    pub fn new(
        store: MongoStore,
        queue: Q,
        clock: Arc<dyn Clock>,
        random: Arc<dyn Random>,
        config: JobsConfig,
        indexes: &IndexReport,
    ) -> Result<Self, RequiredIndexError> {
        if indexes.collection != COLLECTION {
            return Err(RequiredIndexError {
                collection: COLLECTION,
                missing: vec![format!("no index report (got {})", indexes.collection)],
            });
        }
        indexes.require()?;
        Ok(Self {
            store,
            queue,
            clock,
            random,
            config,
        })
    }

    fn now(&self) -> i64 {
        self.clock.now_ms()
    }

    fn deadline(&self) -> Duration {
        self.config.store_deadline
    }

    /// `legacyDedupeSeconds(job)`.
    fn legacy_dedupe_seconds(&self, job: &CronQueueJob) -> f64 {
        let configured = match job.job.as_str() {
            "stream-memory-summary" => self.config.summary_dedupe_seconds,
            "memory-maintenance-weekly" => self.config.weekly_dedupe_seconds,
            "memory-maintenance-monthly" => self.config.monthly_dedupe_seconds,
            "clip-recommendation-analysis"
                if data_field(job, "source").and_then(serde_json::Value::as_str)
                    == Some("recovery") =>
            {
                3600.0
            }
            _ => self.config.clip_dedupe_seconds,
        };
        if configured.is_finite() {
            configured.max(60.0)
        } else {
            60.0
        }
    }

    /// `identity(job, queueKey)`: the intent of this job (by id, automatic key or active key).
    async fn identity(
        &self,
        job: &CronQueueJob,
        queue_key: &str,
    ) -> Result<Option<Document>, JobError> {
        let mut predicates = vec![doc! { "jobID": job.id.as_str() }];
        if let Some(key) = job_automatic_key(job) {
            predicates.push(doc! { "automaticKey": key });
        }
        predicates.push(doc! { "activeKey": job_active_key(job, queue_key) });
        Ok(bounded(
            "read the cron job intent",
            self.deadline(),
            self.store
                .documents(COLLECTION)
                .find_one(doc! { "queueKey": queue_key, "$or": predicates }),
        )
        .await?)
    }

    async fn by_id(&self, id: &Bson) -> Result<Option<Document>, JobError> {
        Ok(bounded(
            "read the cron job intent",
            self.deadline(),
            self.store
                .documents(COLLECTION)
                .find_one(doc! { "_id": id.clone() }),
        )
        .await?)
    }

    async fn update_one(
        &self,
        filter: Document,
        update: Document,
    ) -> Result<dima_store::mongo::write::UpdateOutcome, JobError> {
        let mut ctx = WriteContext::new(self.now());
        let prepared = INFO.prepare_update(&filter, update, UpdateOptions::default(), &mut ctx)?;
        let mut writes = self
            .store
            .writes(COLLECTION)
            .write_concern(intent_write_concern());
        Ok(bounded_write(
            "update the cron job intent",
            self.deadline(),
            writes.update_one(&prepared),
        )
        .await?)
    }

    async fn find_and_update(
        &self,
        filter: Document,
        update: Document,
        sort: Option<Document>,
    ) -> Result<Option<Document>, JobError> {
        let mut ctx = WriteContext::new(self.now());
        let prepared = INFO.prepare_find_one_and_update(
            &filter,
            update,
            UpdateOptions::default(),
            Returned::After,
            &mut ctx,
        )?;
        let writes = self
            .store
            .writes(COLLECTION)
            .write_concern(intent_write_concern());
        let Some(sort) = sort else {
            let mut writes = writes;
            return Ok(bounded_write(
                "update the cron job intent",
                self.deadline(),
                writes.find_one_and_update(&prepared),
            )
            .await?);
        };
        // `Writes::find_one_and_update` has no `sort`: the same prepared update, checked the
        // same way, sent with it.
        writes
            .check("findOneAndUpdate", &prepared.dropped_paths)
            .map_err(|source| StoreError::Write {
                operation: "update the cron job intent",
                source,
            })?;
        let Some(update) = prepared.update.clone() else {
            return Err(JobError::Invalid("empty intent update".into()));
        };
        let update: mongodb::options::UpdateModifications = update.into();
        Ok(bounded(
            "update the cron job intent",
            self.deadline(),
            self.store
                .documents(COLLECTION)
                .find_one_and_update(prepared.filter.clone(), update)
                .sort(sort)
                .return_document(ReturnDocument::After)
                .write_concern(intent_write_concern()),
        )
        .await?)
    }

    /// `prepare(job, queueKey, options)`: accepts the job once (see the module documentation).
    pub async fn prepare(
        &self,
        job: &CronQueueJob,
        queue_key: &str,
        options: &PrepareOptions,
    ) -> Result<Prepared, JobError> {
        assert_job(job, queue_key)?;
        let automatic = job_automatic_key(job);
        if let Some(given) = options.acceptance_key.as_deref().filter(|k| !k.is_empty())
            && Some(given) != automatic.as_deref()
        {
            return Err(JobError::Invalid("Invalid automatic acceptance key".into()));
        }
        if !options.dedupe_seconds.is_finite() || options.dedupe_seconds <= 0.0 {
            return Err(JobError::Invalid("Invalid dedupe duration".into()));
        }
        let key = job_active_key(job, queue_key);
        for _ in 0..5 {
            let existing = self.identity(job, queue_key).await?;
            let at = self.now();
            if let Some(existing) = existing {
                let status = status_of(&existing).to_owned();
                let terminal = matches!(status.as_str(), "completed" | "dead" | "legacy_accepted");
                // Automatic acceptance stays authoritative for good. Active or uncertain work
                // never expires; an ordinary terminal dedupe can, without deleting history.
                if automatic.is_none()
                    && existing.get_str("activeKey").ok() == Some(key.as_str())
                    && terminal
                    && date_ms(&existing, "dedupeUntil").is_some_and(|until| until <= at)
                    && existing.get_str("jobID").ok() != Some(job.id.as_str())
                {
                    let id = existing.get("_id").cloned().unwrap_or(Bson::Null);
                    self.update_one(
                        doc! { "_id": id, "activeKey": key.as_str(), "status": status.as_str(), "dedupeUntil": { "$lte": date(at) } },
                        doc! { "$unset": { "activeKey": 1 } },
                    )
                    .await?;
                    continue;
                }
                return Ok(Prepared {
                    job: stored_job(existing.get("payload"))?,
                    created: false,
                    accepted: true,
                    status,
                });
            }
            let eligible = due_at(job, at);
            let status = if automatic.is_some() && options.legacy_accepted {
                "legacy_accepted"
            } else {
                "queued"
            };
            let mut given = doc! {
                "jobID": job.id.as_str(),
                "queueKey": queue_key,
                "payload": job_document(job)?,
                "status": status,
            };
            if let Some(automatic) = &automatic {
                given.insert("automaticKey", automatic.as_str());
            }
            given.insert("activeKey", key.as_str());
            given.insert(
                "dedupeUntil",
                date((at as f64 + options.dedupe_seconds * 1000.0).trunc() as i64),
            );
            given.insert("dueAt", date(eligible));
            given.insert("nextPublishAt", date(eligible));
            let mut ctx = WriteContext::new(at);
            let prepared = INFO.prepare_create(&given, &mut ctx)?;
            let mut writes = self
                .store
                .writes(COLLECTION)
                .write_concern(intent_write_concern());
            match bounded_write(
                "accept the cron job",
                self.deadline(),
                writes.insert_one(&prepared),
            )
            .await
            {
                Ok(()) => {
                    return Ok(Prepared {
                        job: job.clone(),
                        created: true,
                        accepted: true,
                        status: status.to_owned(),
                    });
                }
                Err(error) if duplicate_key(&error).is_some() => continue,
                Err(error) => return Err(error.into()),
            }
        }
        Err(JobError::Invalid(
            "Unable to resolve concurrent durable cron job acceptance".into(),
        ))
    }

    /// `publishIntent(intent)`.
    async fn publish_intent(&self, intent: &Document) -> Result<bool, JobError> {
        let queue_key = intent.get_str("queueKey").unwrap_or_default();
        let automatic = intent.get_str("automaticKey").ok();
        let json = intent
            .get("payload")
            .map(Value::from_bson)
            .and_then(|payload| payload.to_json())
            .ok_or_else(|| JobError::Stored("payload is not JSON".into()))?;
        Ok(self
            .queue
            .publish(queue_key, automatic, &QueueItem::encode_value(&json))
            .await?)
    }

    /// `publish(job, queueKey)`: pushes a queued, due intent to its queue.
    pub async fn publish(&self, job: &CronQueueJob, queue_key: &str) -> Result<bool, JobError> {
        let Some(intent) = self.identity(job, queue_key).await? else {
            return Ok(false);
        };
        if status_of(&intent) != "queued"
            || date_ms(&intent, "dueAt").is_none_or(|due| due > self.now())
        {
            return Ok(false);
        }
        self.publish_intent(&intent).await
    }

    /// `enqueueCronJob` for the durable routes (stream memory summaries and maintenance, clip
    /// analysis): `plan` is [`EnqueuePlan::Durable`] from the store's `prepare_enqueue_cron_job`.
    /// A legacy `cron:jobs:accepted:*` marker of an automatic job (a pre-upgrade marker without a
    /// recoverable payload) is kept as a `legacy_accepted` intent. Returns `(enqueued, message,
    /// job)`.
    pub async fn enqueue(
        &self,
        plan: EnqueuePlan,
    ) -> Result<(bool, &'static str, CronQueueJob), JobError> {
        let EnqueuePlan::Durable {
            job,
            queue_key,
            dedupe_seconds,
        } = plan
        else {
            return Err(JobError::Invalid("not a durable cron job".into()));
        };
        let acceptance_key = job_automatic_key(&job);
        let legacy_accepted = match &acceptance_key {
            Some(key) => self.queue.marker_exists(key).await?,
            None => false,
        };
        let prepared = self
            .prepare(
                &job,
                &queue_key,
                &PrepareOptions {
                    dedupe_seconds,
                    acceptance_key,
                    legacy_accepted,
                },
            )
            .await?;
        if prepared.status == "queued" {
            self.publish(&prepared.job, &queue_key).await?;
        }
        let fresh = prepared.created && prepared.status == "queued";
        Ok((
            fresh,
            if fresh {
                "Cron job durably accepted"
            } else {
                "Cron job already accepted"
            },
            prepared.job,
        ))
    }

    /// `claim(job, queueKey, owner)`: the fence of a popped job (see the module documentation).
    pub async fn claim(
        &self,
        job: &CronQueueJob,
        queue_key: &str,
        owner: &str,
    ) -> Result<ClaimResult, JobError> {
        assert_job(job, queue_key)?;
        if owner.is_empty() {
            return Err(JobError::Invalid(
                "Durable cron job owner is required".into(),
            ));
        }
        let legacy_options = || PrepareOptions {
            dedupe_seconds: self.legacy_dedupe_seconds(job),
            acceptance_key: None,
            legacy_accepted: false,
        };
        let mut intent = self.identity(job, queue_key).await?;
        if intent.is_none() {
            self.prepare(job, queue_key, &legacy_options()).await?;
            intent = self.identity(job, queue_key).await?;
        }
        let Some(mut intent) = intent else {
            return Err(JobError::Invalid("Durable cron job adoption failed".into()));
        };
        let automatic = job_automatic_key(job);
        let requested = dima_text::parse_date(&job.requested_at);
        if automatic.is_none()
            && intent.get_str("jobID").ok() != Some(job.id.as_str())
            && matches!(status_of(&intent), "completed" | "dead")
            && date_ms(&intent, "dedupeUntil").is_some_and(|until| until <= self.now())
            && requested
                .zip(date_ms(&intent, "dedupeUntil"))
                .is_some_and(|(r, until)| r >= until)
        {
            // A new legacy producer may reuse an expired ordinary dedupe key, if its request
            // postdates that window.
            self.prepare(job, queue_key, &legacy_options()).await?;
            intent = self
                .identity(job, queue_key)
                .await?
                .ok_or_else(|| JobError::Invalid("Durable cron job readoption failed".into()))?;
        }
        let id = intent.get("_id").cloned().unwrap_or(Bson::Null);
        if status_of(&intent) == "legacy_accepted"
            && intent.get_str("automaticKey").ok() == automatic.as_deref()
        {
            // A real old transport payload proves there is work to adopt; a bare old marker
            // does not. The compare-and-set lets one payload become canonical.
            let due = due_at(job, self.now());
            let adopted = self
                .find_and_update(
                    doc! { "_id": id.clone(), "status": "legacy_accepted" },
                    doc! { "$set": { "status": "queued", "payload": job_document(job)?, "dueAt": date(due), "nextPublishAt": date(due) } },
                    None,
                )
                .await?;
            intent = match adopted {
                Some(adopted) => adopted,
                None => self.by_id(&id).await?.ok_or_else(|| {
                    JobError::Invalid("Durable cron job intent disappeared".into())
                })?,
            };
        }
        let at = self.now();
        let mut current = Some(intent);
        if let Some(intent) = &current
            && status_of(intent) == "queued"
            && date_ms(intent, "dueAt").is_some_and(|due| due <= at)
        {
            let token = self
                .random
                .uuid_v4()
                .map_err(|e| JobError::Invalid(e.to_string()))?;
            let claimed = self
                .find_and_update(
                    doc! { "_id": id.clone(), "queueKey": queue_key, "status": "queued", "dueAt": { "$lte": date(at) } },
                    doc! { "$set": { "status": "processing", "owner": owner, "token": token.as_str(), "leaseUntil": date(at + LEASE_MS) } },
                    None,
                )
                .await?;
            if let Some(claimed) = claimed {
                let intent_id = match claimed.get("_id") {
                    Some(Bson::ObjectId(oid)) => oid.to_hex(),
                    Some(other) => other.to_string(),
                    None => String::new(),
                };
                return Ok(ClaimResult::Claimed {
                    job: stored_job(claimed.get("payload"))?,
                    claim: Claim {
                        intent_id,
                        queue_key: queue_key.to_owned(),
                        owner: owner.to_owned(),
                        token,
                    },
                });
            }
            current = self.by_id(&id).await?;
        }
        let Some(intent) = current else {
            return Err(JobError::Invalid(
                "Durable cron job intent disappeared".into(),
            ));
        };
        let job = stored_job(intent.get("payload"))?;
        Ok(if matches!(status_of(&intent), "queued" | "processing") {
            ClaimResult::Busy { job }
        } else {
            ClaimResult::Terminal { job }
        })
    }

    fn claim_filter(claim: &Claim, at: i64) -> Result<Document, JobError> {
        let id = ObjectId::parse_str(&claim.intent_id).map_err(|_| {
            JobError::Invalid("Cast to ObjectId failed for value of the claim".into())
        })?;
        Ok(doc! {
            "_id": id,
            "queueKey": claim.queue_key.as_str(),
            "status": "processing",
            "owner": claim.owner.as_str(),
            "token": claim.token.as_str(),
            "leaseUntil": { "$gt": date(at) },
        })
    }

    async fn transition(
        &self,
        claim: &Claim,
        status: &str,
        reason: &str,
    ) -> Result<bool, JobError> {
        let outcome = self
            .update_one(
                Self::claim_filter(claim, self.now())?,
                doc! { "$set": { "status": status, "reason": reason }, "$unset": { "owner": 1, "token": 1, "leaseUntil": 1 } },
            )
            .await?;
        Ok(outcome.modified == 1)
    }

    /// `complete(claim)`.
    pub async fn complete(&self, claim: &Claim) -> Result<bool, JobError> {
        self.transition(claim, "completed", "").await
    }

    /// `dead(claim, reason)`.
    pub async fn dead(&self, claim: &Claim, reason: &str) -> Result<bool, JobError> {
        self.transition(claim, "dead", reason).await
    }

    /// `uncertain(claim, reason)`.
    pub async fn uncertain(&self, claim: &Claim, reason: &str) -> Result<bool, JobError> {
        self.transition(claim, "uncertain", reason).await
    }

    /// `retry(claim, job, due)`: queues the claimed canonical job again for `due_ms`.
    pub async fn retry(
        &self,
        claim: &Claim,
        job: &CronQueueJob,
        due_ms: f64,
    ) -> Result<bool, JobError> {
        assert_job(job, &claim.queue_key)?;
        if !due_ms.is_finite() {
            return Err(JobError::Invalid("Invalid retry time".into()));
        }
        let due = date(due_ms.trunc() as i64);
        let mut filter = Self::claim_filter(claim, self.now())?;
        filter.insert("payload.id", job.id.as_str());
        filter.insert("payload.job", job.job.as_str());
        filter.insert(
            "payload.channelID",
            job.channel_id
                .as_deref()
                .filter(|c| !c.is_empty())
                .map_or(Bson::Null, |c| Bson::String(c.to_owned())),
        );
        filter.insert(
            "automaticKey",
            job_automatic_key(job).map_or(Bson::Null, Bson::String),
        );
        let outcome = self
            .update_one(
                filter,
                doc! {
                    "$set": { "status": "queued", "payload": job_document(job)?, "dueAt": due, "nextPublishAt": due },
                    "$unset": { "owner": 1, "token": 1, "leaseUntil": 1 },
                },
            )
            .await?;
        Ok(outcome.modified == 1)
    }

    /// `renew(claim)`: extends the lease by [`LEASE_MS`] while it is still held.
    pub async fn renew(&self, claim: &Claim) -> Result<bool, JobError> {
        let at = self.now();
        let outcome = self
            .update_one(
                Self::claim_filter(claim, at)?,
                doc! { "$set": { "leaseUntil": date(at + LEASE_MS) } },
            )
            .await?;
        Ok(outcome.matched == 1)
    }

    /// `assertActive(claim)`: the lease is still held.
    pub async fn assert_active(&self, claim: &Claim) -> Result<bool, JobError> {
        let found = bounded(
            "read the cron job intent",
            self.deadline(),
            self.store
                .documents(COLLECTION)
                .find_one(Self::claim_filter(claim, self.now())?)
                .projection(doc! { "_id": 1 }),
        )
        .await?;
        Ok(found.is_some())
    }

    /// `recover(queueKey, {limit})`: expired leases become `uncertain`; queued, due intents
    /// whose republish time came are published again (at most `limit`, capped at 100, of
    /// each).
    pub async fn recover(&self, queue_key: &str, limit: i64) -> Result<Recovered, JobError> {
        if queue_key.is_empty() || limit < 1 {
            return Err(JobError::Invalid("Invalid recovery scope".into()));
        }
        let limit = limit.min(MAX_RECOVERY_BATCH);
        let mut recovered = Recovered::default();
        // A stale lease is ambiguous: the old process may have caused an outside effect.
        for _ in 0..limit {
            let changed = self
                .find_and_update(
                    doc! { "queueKey": queue_key, "status": "processing", "leaseUntil": { "$lte": date(self.now()) } },
                    doc! { "$set": { "status": "uncertain", "reason": "processing lease expired" }, "$unset": { "owner": 1, "token": 1, "leaseUntil": 1 } },
                    Some(doc! { "leaseUntil": 1, "_id": 1 }),
                )
                .await?;
            if changed.is_none() {
                break;
            }
            recovered.uncertain += 1;
        }
        for _ in 0..limit {
            let at = self.now();
            let item = self
                .find_and_update(
                    doc! { "queueKey": queue_key, "status": "queued", "dueAt": { "$lte": date(at) }, "nextPublishAt": { "$lte": date(at) } },
                    doc! { "$set": { "nextPublishAt": date(at + REPUBLISH_INTERVAL_MS) } },
                    Some(doc! { "nextPublishAt": 1, "_id": 1 }),
                )
                .await?;
            let Some(item) = item else { break };
            recovered.examined += 1;
            if self.publish_intent(&item).await? {
                recovered.published += 1;
            }
        }
        Ok(recovered)
    }
}
