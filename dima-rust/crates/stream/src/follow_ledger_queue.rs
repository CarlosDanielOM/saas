//! Follow-ledger sync jobs: the non-durable route of `follow_ledger_queue.ts`.
//!
//! Reuses the shared cron queue's payload, dedupe key and atomic enqueue script; there is no
//! MongoDB intent for this job, so dima-events is deliberately not used. LPUSH/head-pop is
//! LIFO; a busy channel is RPUSHed unchanged. Unsupported jobs go to the dead-letter tail and
//! clear dedupe; malformed jobs are discarded. Both successful and failed syncs clear dedupe
//! and consume the job (the daily scan repairs failures). A crash after pop loses this request,
//! as in the reference. The future worker owns the channel lock and its 1500-ms busy / 1000-ms
//! exception waits; this library does not start loops or timers.
//!
//! Cutover: TypeScript drains database 0 before stopping. Rust writes database 1; existing
//! database-0 entries are never decoded by this module. The queue bytes are Rust's encoding.
//! Requeue/dead-letter retain the exact popped bytes. Dedupe defaults to 900 seconds, minimum
//! 60; calls have a 5-second deadline. A new capacity guard refuses work loudly at 100,000
//! queued items by default; journaled work is never trimmed or dropped to enforce capacity.
use crate::{Error, bounded};
use dima_core::Clock;
use dima_store::dragonfly::cron_queue::{
    self as cron, CronQueueConfig, CronQueueJob, EnqueueCronJobInput, EnqueuePlan,
};
use dima_store::dragonfly::{Dragonfly, QueueItem, Script};
use serde_json::json;
use std::{sync::Arc, time::Duration};
pub const JOB_NAME: &str = "follow-ledger-sync";
pub const DEDUPE_PREFIX: &str = "follow-ledger-sync";
static ENQUEUE: Script = Script::new(
    "STREAM_BOUNDED_ENQUEUE",
    concat!(
        "if redis.call('LLEN', KEYS[2]) >= tonumber(ARGV[3]) and redis.call('EXISTS', KEYS[1]) == 0 then return redis.error_reply('follow ledger queue capacity exceeded') end\n",
        include_str!("../../store/src/dragonfly/lua/cron_enqueue_deduplicated_job.lua")
    ),
);
#[derive(Clone, Debug)]
pub struct Config {
    pub dedupe_seconds: f64,
    pub deadline: Duration,
    pub capacity: usize,
    /// Empty in production; unique prefix in logical database 2/3 in tests.
    pub key_prefix: String,
}
impl Default for Config {
    fn default() -> Self {
        Self {
            dedupe_seconds: 900.0,
            deadline: Duration::from_secs(5),
            capacity: 100_000,
            key_prefix: String::new(),
        }
    }
}
pub fn get_follow_ledger_dedupe_key(channel: &str) -> String {
    cron::get_cron_job_dedupe_key(&format!("{DEDUPE_PREFIX}:{}", dima_text::trim(channel)))
}
#[derive(Debug)]
pub struct Enqueued {
    pub enqueued: bool,
    pub message: String,
    pub dedupe_key: String,
    pub job: Option<CronQueueJob>,
}
/// Consumers carry these original bytes until finishing, requeueing or dead-lettering.
#[derive(Debug)]
pub struct Delivery {
    pub raw: QueueItem,
    pub job: CronQueueJob,
    pub channel_id: String,
}
#[derive(Clone)]
pub struct Queue {
    cache: Dragonfly,
    clock: Arc<dyn Clock>,
    random: Arc<dyn dima_core::Random>,
    config: Config,
}
impl Queue {
    pub fn new(
        cache: Dragonfly,
        clock: Arc<dyn Clock>,
        random: Arc<dyn dima_core::Random>,
        config: Config,
    ) -> Result<Self, Error> {
        if config.capacity == 0 || !config.dedupe_seconds.is_finite() {
            return Err(Error::Invalid("invalid queue configuration".into()));
        }
        Ok(Self {
            cache,
            clock,
            random,
            config,
        })
    }
    pub fn queue_key(&self) -> String {
        format!("{}{}", self.config.key_prefix, cron::CRON_JOBS_QUEUE_KEY)
    }
    fn key(&self, key: &str) -> String {
        format!("{}{key}", self.config.key_prefix)
    }
    pub async fn enqueue_follow_ledger_sync_job(
        &self,
        channel: &str,
        reason: Option<&str>,
        requested_by: Option<&str>,
        id: &str,
    ) -> Result<Enqueued, Error> {
        let channel = dima_text::trim(channel);
        if channel.is_empty() {
            return Ok(Enqueued {
                enqueued: false,
                message: "Invalid channel ID".into(),
                dedupe_key: String::new(),
                job: None,
            });
        }
        let reason = reason
            .map(dima_text::trim)
            .filter(|s| !s.is_empty())
            .unwrap_or("manual_request");
        let input = EnqueueCronJobInput {
            job: JOB_NAME.into(),
            channel_id: Some(channel.into()),
            account_id: Some(channel.into()),
            requested_by: requested_by.map(str::to_owned),
            dedupe_seconds: Some(self.config.dedupe_seconds.max(60.0)),
            dedupe_token: Some(format!("{DEDUPE_PREFIX}:{channel}")),
            data: Some(json!({"reason":reason,"type":JOB_NAME})),
            ..EnqueueCronJobInput::default()
        };
        let iso = dima_text::to_iso_string(self.clock.now_ms())
            .ok_or_else(|| Error::Invalid("invalid clock".into()))?;
        let EnqueuePlan::Deduplicated {
            mut job,
            keys,
            mut args,
        } = cron::prepare_enqueue_cron_job(&input, CronQueueConfig::default(), &iso, id)
            .map_err(|e| Error::Invalid(e.to_string()))?
        else {
            return Err(Error::Invalid(
                "unexpected durable follow ledger route".into(),
            ));
        };
        let keys: Vec<String> = keys.into_iter().map(|k| self.key(&k)).collect();
        let dedupe_key = self.key(&get_follow_ledger_dedupe_key(channel));
        job.dedupe_key = Some(dedupe_key.clone());
        args[1] = job.to_item()?.into_bytes();
        args.push(self.config.capacity.to_string().into_bytes());
        let value = bounded(
            self.config.deadline,
            ENQUEUE.run_value(&self.cache, &keys, &args),
        )
        .await?;
        let enqueued = dima_store::dragonfly::commands::reply::number(value)? != 0.0;
        Ok(Enqueued {
            enqueued,
            message: if enqueued {
                "Cron job queued"
            } else {
                "Cron job already queued recently"
            }
            .into(),
            dedupe_key,
            job: Some(job),
        })
    }
    /// Nonblocking head pop; the worker may instead use a dedicated 5-second blocking connection
    /// and feed its popped bytes to `accept`.
    pub async fn pop(&self) -> Result<Option<Delivery>, Error> {
        let Some(raw) = bounded(self.config.deadline, self.cache.lpop(&self.queue_key())).await?
        else {
            return Ok(None);
        };
        self.accept(QueueItem::from_popped(raw)).await
    }
    pub async fn accept(&self, raw: QueueItem) -> Result<Option<Delivery>, Error> {
        let now = dima_text::to_iso_string(self.clock.now_ms())
            .ok_or_else(|| Error::Invalid("invalid clock".into()))?;
        let job = cron::parse_cron_queue_job(
            &raw,
            &now,
            &self
                .random
                .uuid_v4()
                .map_err(|e| Error::Invalid(e.to_string()))?,
        )
        .map_err(|e| Error::Invalid(e.to_string()))?;
        let Some(job) = job else {
            return Ok(None);
        };
        if job.job != JOB_NAME {
            bounded(
                self.config.deadline,
                self.cache.rpush(
                    &self.key(cron::CRON_JOBS_DEAD_LETTER_KEY),
                    &[raw.as_bytes()],
                ),
            )
            .await?;
            self.clear(&job).await?;
            return Ok(None);
        }
        let channel = job
            .channel_id
            .as_deref()
            .filter(|s| !s.is_empty())
            .or(job.account_id.as_deref().filter(|s| !s.is_empty()))
            .or(job.user_id.as_deref().filter(|s| !s.is_empty()))
            .or_else(|| job.data.as_ref()?.get("channelID")?.as_str())
            .unwrap_or_default();
        let channel = dima_text::trim(channel).to_owned();
        if channel.is_empty() {
            self.clear(&job).await?;
            return Ok(None);
        }
        Ok(Some(Delivery {
            raw,
            job,
            channel_id: channel,
        }))
    }
    async fn clear(&self, job: &CronQueueJob) -> Result<(), Error> {
        if let Some(key) = job
            .dedupe_key
            .as_deref()
            .map(dima_text::trim)
            .filter(|s| !s.is_empty())
        {
            bounded(self.config.deadline, self.cache.del(&[key])).await?;
        }
        Ok(())
    }
    /// Reference behavior: called after success or sync failure; neither is requeued.
    pub async fn finish(&self, delivery: Delivery) -> Result<(), Error> {
        self.clear(&delivery.job).await
    }
    /// Channel lock busy: retain both payload bytes and dedupe marker.
    pub async fn requeue_busy(&self, delivery: Delivery) -> Result<(), Error> {
        bounded(
            self.config.deadline,
            self.cache
                .rpush(&self.queue_key(), &[delivery.raw.as_bytes()]),
        )
        .await?;
        Ok(())
    }
}
