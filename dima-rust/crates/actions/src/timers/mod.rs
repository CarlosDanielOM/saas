//! AST timers (`$(timer seconds …)`): scheduling into the carried `ast:timers:*` family, the
//! at-most-once claim, and the scheduler the bot runs (`ledger/upper-layers.md` section 5.3).
//! Package P4-ACT-CORE.
//!
//! TypeScript it ports (baseline `0c71108e`): `utils/ast_timer_runtime.ts` (165 lines):
//! `scheduleAstTimer` ([`schedule`]), `AstTimerScheduler` ([`TimerScheduler`]),
//! `executeAstTimerJob` ([`TimerScheduler::execute`]), `startAstTimerScheduler` (the bot calls
//! [`TimerScheduler::run`], or its own loop around [`TimerScheduler::tick`]).
//!
//! # The life of a timer
//!
//! 1. **Scheduled** by any process that evaluates command language (the bot, the API, the cron):
//!    the engine's `$(timer)` hands the host a snapshot of the run's data and the unevaluated
//!    body ([`dima_engine::host::Host::schedule_timer`]). [`schedule`] writes, in one script
//!    (`lua/enqueue.lua`, the reference's `ENQUEUE` verbatim): the job
//!    `ast:timers:job:{id}` (string, the JSON envelope, `PXAT expiresAt`), its entry in
//!    `ast:timers:pending` (sorted set, score `dueAt`) and in `ast:timers:channel:{channel}`
//!    (sorted set, score `expiresAt`, `PEXPIREAT` its latest score). The script first prunes
//!    both indexes and refuses the job when the channel has 100 pending timers or the process
//!    10,000. A job is refused before that when its JSON is over 64 KiB. `dueAt` is now plus
//!    `round(seconds × 1000)` (1 s to 7 days, checked by the engine), `expiresAt` ten minutes
//!    later. A process that schedules a timer wakes its own scheduler, if it runs one.
//! 2. **Found** by the bot's scheduler: every tick (at most 2 s apart, sooner when the next due
//!    time or a local schedule calls for it) prunes index entries whose job expired more than
//!    ten minutes ago, reads up to 10,000 entries, and starts every due one that is not already
//!    running in this process (at most [`SchedulerConfig::max_in_flight`] at once).
//! 3. **Claimed**: the job's envelope is read for its channel (Dragonfly needs every key of a
//!    script declared), then `lua/claim.lua` (the reference's `CLAIM` verbatim) atomically checks
//!    that it is due, deletes the job and both index entries, and hands back the payload unless
//!    it had expired. Exactly one claimer gets it, across processes and restarts.
//! 4. **Run** as a message of its own ([`dima_engine::eval::Engine::evaluate_message`]: a fresh
//!    budget), with the channel's current plan, then delivered (the outer text, then the
//!    command references it produced) through [`crate::delivery::ChatDelivery::deliver_message`].
//!
//! **At most once.** The claim deletes before anything runs: a process killed after claiming
//! loses that timer (its effects may or may not have happened); nothing ever retries a timer
//! whose outcome is unknown. A process killed before claiming leaves the job for the next tick
//! of any scheduler (after a restart, the first tick): a timer is late, never doubled. A job
//! whose bot was down past `expiresAt` is claimed and dropped without running (the reference's
//! ten-minute grace). Its key expires on its own at `expiresAt`; the indexes are pruned.
//!
//! **Bounds.** 100 pending timers per channel, 10,000 per process database, 7 days ahead, 64 KiB
//! a job (the reference's), timers nested at most 5 deep (the engine).
//!
//! # The stored format is the reference's
//!
//! `ast:timers:*` is a *carried* family (charter section 3): the jobs the TypeScript bot left
//! pending at the cutover must run. The envelope is `{version: 1, id, dueAt, expiresAt, body,
//! context}` with the body in the reference's AST shape and the context as
//! `snapshotTimerContext` writes it, serialised with [`dima_text::to_js_json_from`]: a job Rust
//! writes is what the TypeScript writes (tests run a fixture recorded from the TypeScript, and
//! check a Rust job against the TypeScript's own reader). [`carry`] moves the jobs pending in the
//! TypeScript's database into the Rust database once, at the cutover.
//!
//! # Intended differences
//!
//! - The run's plan is the channel's plan at the time the timer fires (the streamer directory),
//!   not the plan stored in the job: a job's data never decides its budget or whether it may
//!   write variables. They differ only when the channel's plan changed in between.
//! - A job whose envelope cannot be read is deleted with its index entries; the reference left
//!   it to fail again every 2 s until its index entry was pruned.
//! - Each job runs under [`SchedulerConfig::job_deadline`] (the reference had none beyond the
//!   message's).

use crate::delivery::{AstMessage, ChatDelivery};
use crate::host::HostDeps;
use dima_engine::context::TimerSnapshot;
use dima_engine::syntax::AstNode;
use dima_store::dragonfly::{DragonflyError, Script};
use dima_telemetry::LogOptions;
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::collections::HashSet;
use std::sync::{Arc, Mutex, PoisonError};
use std::time::Duration;
use tokio::sync::Notify;
use tokio::task::JoinSet;

/// `AST_TIMER_INDEX`: the pending jobs by due time.
pub const AST_TIMER_INDEX: &str = "ast:timers:pending";
/// `JOB_PREFIX`.
pub const JOB_PREFIX: &str = "ast:timers:job:";
/// `CHANNEL_PREFIX`.
pub const CHANNEL_PREFIX: &str = "ast:timers:channel:";
/// `MAX_CHANNEL_TIMERS`.
pub const MAX_CHANNEL_TIMERS: u32 = 100;
/// `MAX_PENDING_TIMERS`.
pub const MAX_PENDING_TIMERS: u32 = 10_000;
/// `MAX_JOB_BYTES`: 64 KiB of JSON (bytes, as `Buffer.byteLength`).
pub const MAX_JOB_BYTES: usize = 64 * 1024;
/// `RECONCILE_MS`.
pub const RECONCILE_MS: u64 = 2_000;
/// `TIMER_GRACE_MS`: ten minutes.
pub const TIMER_GRACE_MS: i64 = 10 * 60 * 1000;

static ENQUEUE: Script = Script::new("ENQUEUE", include_str!("lua/enqueue.lua"));
static CLAIM: Script = Script::new("CLAIM", include_str!("lua/claim.lua"));
static MOVE_OUT: Script = Script::new("ast_timer_move_out", include_str!("lua/move_out.lua"));

/// The process's side of the timer queue, held by [`HostDeps::timers`]: wakes the scheduler of
/// this process when a run here schedules a timer.
#[derive(Clone, Debug, Default)]
pub struct TimerQueue {
    wakeup: Arc<Notify>,
}

impl TimerQueue {
    /// A queue with its own wake-up.
    pub fn new() -> Self {
        Self::default()
    }

    fn notify(&self) {
        self.wakeup.notify_one();
    }
}

/// Why a timer could not be scheduled or run.
#[derive(Debug, thiserror::Error)]
pub enum TimerError {
    /// The job is larger than [`MAX_JOB_BYTES`].
    #[error("Timer context exceeds 64 KiB")]
    TooLarge,
    /// The channel or the database already holds the most pending timers.
    #[error("Pending timer limit reached")]
    Limit,
    /// Dragonfly failed.
    #[error("Dragonfly: {0}")]
    Store(#[from] DragonflyError),
    /// No random id could be drawn.
    #[error("random number generator unavailable")]
    Random,
    /// A job could not be written or read as JSON.
    #[error("timer job JSON: {0}")]
    Json(String),
    /// The job's version is not 1.
    #[error("Unsupported AST timer job version")]
    Version,
    /// Its evaluation stopped.
    #[error("{0}")]
    Eval(String),
    /// Its delivery failed (`sent.message`).
    #[error("{0}")]
    Delivery(String),
    /// It ran past [`SchedulerConfig::job_deadline`].
    #[error("the timer did not finish within {0} ms")]
    Deadline(u128),
}

/// `AstTimerJob`, in the reference's field order and names.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TimerJob {
    /// Always 1.
    pub version: u32,
    /// `randomUUID()`.
    pub id: String,
    /// When it runs, epoch milliseconds.
    pub due_at: i64,
    /// When it is dropped unrun, epoch milliseconds (`dueAt` plus the grace).
    pub expires_at: i64,
    /// `{type: 'root', children}`: the timer's message and actions, unevaluated.
    pub body: AstNode,
    /// `snapshotTimerContext` of the run that scheduled it.
    pub context: TimerSnapshot,
}

impl TimerJob {
    /// The reference's JSON text of the job.
    pub fn to_json(&self) -> Result<String, TimerError> {
        let bytes = dima_text::to_js_json_from(self)
            .map_err(|error| TimerError::Json(error.to_string()))?;
        String::from_utf8(bytes).map_err(|error| TimerError::Json(error.to_string()))
    }

    /// A job read back from its JSON text.
    pub fn from_json(text: &str) -> Result<Self, TimerError> {
        serde_json::from_str(text).map_err(|error| TimerError::Json(error.to_string()))
    }
}

/// The three keys of a job, with the process's prefix.
fn keys(deps: &HostDeps, id: &str, channel_id: &str) -> [String; 3] {
    [
        deps.keys.key(format_args!("{JOB_PREFIX}{id}")),
        deps.keys.key(AST_TIMER_INDEX),
        deps.keys.key(format_args!("{CHANNEL_PREFIX}{channel_id}")),
    ]
}

/// `scheduleAstTimer(seconds, body, context)`: writes the job and its index entries (see the
/// module documentation) and answers its id. `body` is the timer's nodes after the duration.
pub async fn schedule(
    deps: &HostDeps,
    seconds: f64,
    body: &[AstNode],
    snapshot: TimerSnapshot,
) -> Result<String, TimerError> {
    let now = deps.clock.now_ms();
    let delay = dima_text::math_round(seconds * 1000.0);
    // The engine allows 1 to 604,800 seconds, so the delay is a small whole number.
    let delay = if delay.is_finite() { delay as i64 } else { 0 };
    let id = deps.random.uuid_v4().map_err(|_| TimerError::Random)?;
    let job = TimerJob {
        version: 1,
        id,
        due_at: now.saturating_add(delay),
        expires_at: now.saturating_add(delay).saturating_add(TIMER_GRACE_MS),
        body: AstNode::Root {
            children: body.to_vec(),
        },
        context: snapshot,
    };
    let payload = job.to_json()?;
    if payload.len() > MAX_JOB_BYTES {
        return Err(TimerError::TooLarge);
    }
    let [job_key, index_key, channel_key] = keys(deps, &job.id, &job.context.broadcaster_id);
    let accepted = enqueue(
        deps,
        [&job_key, &index_key, &channel_key],
        &job,
        &payload,
        now,
    )
    .await?;
    if !accepted {
        return Err(TimerError::Limit);
    }
    deps.timers.notify();
    Ok(job.id)
}

async fn enqueue(
    deps: &HostDeps,
    keys: [&str; 3],
    job: &TimerJob,
    payload: &str,
    now: i64,
) -> Result<bool, TimerError> {
    let args = [
        payload.to_owned(),
        job.id.clone(),
        job.due_at.to_string(),
        job.expires_at.to_string(),
        now.to_string(),
        TIMER_GRACE_MS.to_string(),
        MAX_PENDING_TIMERS.to_string(),
        MAX_CHANNEL_TIMERS.to_string(),
    ];
    let reply = ENQUEUE.run_value(&deps.dragonfly, &keys, &args).await?;
    Ok(matches!(reply, redis::Value::Int(1)))
}

/// Limits of the scheduler. [`Default`] holds the production values.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct SchedulerConfig {
    /// The longest wait between two ticks (the reference's 2 s reconcile).
    pub reconcile: Duration,
    /// Jobs running at once in this process; more due jobs wait for the next tick.
    pub max_in_flight: usize,
    /// The longest one job may take, its delivery included (the message deadline bounds the
    /// evaluation; each post has the chat send's own deadline).
    pub job_deadline: Duration,
}

impl Default for SchedulerConfig {
    fn default() -> Self {
        Self {
            reconcile: Duration::from_millis(RECONCILE_MS),
            max_in_flight: 64,
            job_deadline: Duration::from_secs(120),
        }
    }
}

/// What one [`TimerScheduler::tick`] did.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Tick {
    /// Jobs it started.
    pub started: usize,
    /// The earliest due time of a pending job it did not start (epoch milliseconds).
    pub next_due_ms: Option<i64>,
}

#[derive(Default)]
struct InFlight {
    ids: HashSet<String>,
    tasks: Option<JoinSet<()>>,
}

/// `AstTimerScheduler`: finds due jobs, claims each once and runs it. One per bot process.
pub struct TimerScheduler {
    delivery: Arc<ChatDelivery>,
    config: SchedulerConfig,
    in_flight: Arc<Mutex<InFlight>>,
}

impl TimerScheduler {
    /// A scheduler that runs jobs through `delivery`.
    pub fn new(delivery: Arc<ChatDelivery>, config: SchedulerConfig) -> Self {
        Self {
            delivery,
            config,
            in_flight: Arc::default(),
        }
    }

    fn deps(&self) -> &HostDeps {
        self.delivery.host()
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, InFlight> {
        self.in_flight
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
    }

    /// Jobs running now.
    pub fn running(&self) -> usize {
        let mut state = self.lock();
        if let Some(tasks) = state.tasks.as_mut() {
            while tasks.try_join_next().is_some() {}
        }
        state.ids.len()
    }

    /// One reconcile: prunes index entries expired past the grace, reads the pending jobs, and
    /// starts every due one not already running here (the reference's `reconcile` and the
    /// timers it arms, in one step). The jobs run in the background; [`Self::drain`] waits for
    /// them.
    pub async fn tick(&self) -> Result<Tick, TimerError> {
        let deps = self.deps();
        let now = deps.clock.now_ms();
        let index = deps.keys.key(AST_TIMER_INDEX);
        let mut prune = redis::cmd("ZREMRANGEBYSCORE");
        prune
            .arg(&index)
            .arg("-inf")
            .arg(now.saturating_sub(TIMER_GRACE_MS));
        deps.dragonfly.query_value(&prune).await?;
        let pending = deps
            .dragonfly
            .zrange_with_scores(&index, 0, i64::from(MAX_PENDING_TIMERS) - 1)
            .await?;
        let mut tick = Tick::default();
        let mut state = self.lock();
        let tasks = state.tasks.get_or_insert_with(JoinSet::new);
        while tasks.try_join_next().is_some() {}
        for (member, due) in pending {
            let Ok(id) = String::from_utf8(member) else {
                continue;
            };
            let due = due as i64;
            let busy = state.ids.contains(&id);
            if due > now || busy || state.ids.len() >= self.config.max_in_flight {
                if !busy {
                    tick.next_due_ms = Some(tick.next_due_ms.map_or(due, |next| next.min(due)));
                }
                continue;
            }
            state.ids.insert(id.clone());
            let delivery = Arc::clone(&self.delivery);
            let in_flight = Arc::clone(&self.in_flight);
            let deadline = self.config.job_deadline;
            let tasks = state.tasks.get_or_insert_with(JoinSet::new);
            tasks.spawn(async move {
                let outcome = match tokio::time::timeout(deadline, fire(&delivery, &id)).await {
                    Ok(outcome) => outcome,
                    Err(_) => Err(TimerError::Deadline(deadline.as_millis())),
                };
                if let Err(error) = outcome {
                    log_failure(delivery.host(), &id, &error);
                }
                in_flight
                    .lock()
                    .unwrap_or_else(PoisonError::into_inner)
                    .ids
                    .remove(&id);
            });
            tick.started += 1;
        }
        Ok(tick)
    }

    /// Waits until every job started so far has finished.
    pub async fn drain(&self) {
        let tasks = self.lock().tasks.take();
        if let Some(mut tasks) = tasks {
            while tasks.join_next().await.is_some() {}
        }
    }

    /// Stops every job still running (their futures are dropped).
    pub async fn abort(&self) {
        let tasks = self.lock().tasks.take();
        if let Some(mut tasks) = tasks {
            tasks.shutdown().await;
        }
        self.lock().ids.clear();
    }

    /// `startAstTimerScheduler`: ticks until `shutdown`, waiting between ticks until the next
    /// due time, [`SchedulerConfig::reconcile`] or a timer scheduled in this process, whichever
    /// comes first; a failed tick is logged and retried at the next. On shutdown it stops
    /// starting jobs and waits for the running ones for at most `grace`, then drops them.
    pub async fn run(&self, shutdown: dima_core::Shutdown, grace: Duration) {
        let wakeup = Arc::clone(&self.deps().timers.wakeup);
        while !shutdown.is_triggered() {
            let wait = match self.tick().await {
                Ok(tick) => {
                    let now = self.deps().clock.now_ms();
                    tick.next_due_ms
                        .map(|due| Duration::from_millis(u64::try_from(due - now).unwrap_or(0)))
                        .map_or(self.config.reconcile, |until| {
                            until.min(self.config.reconcile)
                        })
                }
                Err(error) => {
                    if let Some(telemetry) = &self.deps().telemetry {
                        telemetry.error(
                            &json!({
                                "message": "AST timer recovery failed; will retry",
                                "error": error.to_string(),
                            }),
                            LogOptions::console(),
                        );
                    }
                    self.config.reconcile
                }
            };
            tokio::select! {
                () = shutdown.wait() => break,
                () = wakeup.notified() => {}
                () = tokio::time::sleep(wait) => {}
            }
        }
        if tokio::time::timeout(grace, self.drain()).await.is_err() {
            self.abort().await;
        }
    }

    /// `executeAstTimerJob(job)`: runs a claimed job as a message of its own and delivers it.
    pub async fn execute(&self, job: TimerJob) -> Result<(), TimerError> {
        execute(&self.delivery, job).await
    }
}

fn log_failure(deps: &HostDeps, id: &str, error: &TimerError) {
    if let Some(telemetry) = &deps.telemetry {
        telemetry.error(
            &json!({ "message": "AST timer execution failed", "timerId": id, "error": error.to_string() }),
            LogOptions::console(),
        );
    }
}

/// `fire(id)`: reads the envelope for its channel, claims it, runs it.
async fn fire(delivery: &ChatDelivery, id: &str) -> Result<(), TimerError> {
    let deps = delivery.host();
    let job_key = deps.keys.key(format_args!("{JOB_PREFIX}{id}"));
    let index_key = deps.keys.key(AST_TIMER_INDEX);
    let Some(pending) = deps.dragonfly.get(&job_key).await? else {
        let mut remove = redis::cmd("ZREM");
        remove.arg(&index_key).arg(id);
        deps.dragonfly.query_value(&remove).await?;
        return Ok(());
    };
    let channel_id = match channel_of(&pending) {
        Some(channel) => channel,
        None => {
            // Unreadable: it can never run. Drop it with its index entry (intended difference).
            deps.dragonfly.del(&[job_key.as_str()]).await?;
            let mut remove = redis::cmd("ZREM");
            remove.arg(&index_key).arg(id);
            deps.dragonfly.query_value(&remove).await?;
            return Err(TimerError::Json("unreadable envelope dropped".into()));
        }
    };
    let keys = keys(deps, id, &channel_id);
    let now = deps.clock.now_ms().to_string();
    let reply = CLAIM
        .run_value(&deps.dragonfly, &keys, &[id, now.as_str()])
        .await?;
    let raw = match reply {
        redis::Value::BulkString(bytes) => bytes,
        _ => return Ok(()),
    };
    let text = String::from_utf8(raw).map_err(|_| TimerError::Json("not UTF-8".into()))?;
    let job = TimerJob::from_json(&text)?;
    if job.version != 1 {
        return Err(TimerError::Version);
    }
    execute(delivery, job).await
}

/// `JSON.parse(pending).context.broadcasterId`.
fn channel_of(pending: &[u8]) -> Option<String> {
    let value: serde_json::Value = serde_json::from_slice(pending).ok()?;
    Some(match value.get("context")?.get("broadcasterId")? {
        serde_json::Value::String(text) => text.clone(),
        other => dima_text::string_of(other),
    })
}

async fn execute(delivery: &ChatDelivery, job: TimerJob) -> Result<(), TimerError> {
    let channel_id = job.context.broadcaster_id.clone();
    let (text, references) = delivery
        .run_timer(&job.body, job.context)
        .await
        .map_err(|error| TimerError::Eval(error.to_string()))?;
    delivery
        .deliver_message(&channel_id, AstMessage { text, references }, true)
        .await
        .map_err(|error| {
            TimerError::Delivery(error.message().unwrap_or("delivery failed").to_owned())
        })
}

/// What [`carry`] did.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Carried {
    /// Jobs moved into the target.
    pub moved: usize,
    /// Jobs the target refused (its limits); left in the source.
    pub refused: usize,
    /// Jobs that had expired or vanished; removed from the source.
    pub dropped: usize,
}

/// The one-off step of the cutover: moves every job pending in `source` (the TypeScript's
/// database, keys without prefix) into the Rust database of `target`, unchanged (same id, due
/// time, expiry and payload), then removes it from `source`. Run it with the TypeScript bot
/// stopped and before the Rust bot's scheduler starts; it is safe to run again (a job moved
/// already is gone from the source).
pub async fn carry(
    source: &dima_store::dragonfly::Dragonfly,
    target: &HostDeps,
) -> Result<Carried, TimerError> {
    let now = target.clock.now_ms();
    let pending = source
        .zrange_with_scores(AST_TIMER_INDEX, 0, i64::from(MAX_PENDING_TIMERS) - 1)
        .await?;
    let mut carried = Carried::default();
    for (member, _) in pending {
        let Ok(id) = String::from_utf8(member) else {
            continue;
        };
        let job_key = format!("{JOB_PREFIX}{id}");
        let Some(raw) = source.get(&job_key).await? else {
            let mut remove = redis::cmd("ZREM");
            remove.arg(AST_TIMER_INDEX).arg(&id);
            source.query_value(&remove).await?;
            carried.dropped += 1;
            continue;
        };
        let text = String::from_utf8(raw).map_err(|_| TimerError::Json("not UTF-8".into()))?;
        let job = TimerJob::from_json(&text)?;
        let source_keys = [
            job_key.clone(),
            AST_TIMER_INDEX.to_owned(),
            format!("{CHANNEL_PREFIX}{}", job.context.broadcaster_id),
        ];
        if job.expires_at <= now {
            MOVE_OUT
                .run_value(source, &source_keys, &[id.as_str()])
                .await?;
            carried.dropped += 1;
            continue;
        }
        let [job_key, index_key, channel_key] = keys(target, &id, &job.context.broadcaster_id);
        // The payload as the TypeScript wrote it (carried bytes, charter data rule 6).
        if enqueue(
            target,
            [&job_key, &index_key, &channel_key],
            &job,
            &text,
            now,
        )
        .await?
        {
            MOVE_OUT
                .run_value(source, &source_keys, &[id.as_str()])
                .await?;
            carried.moved += 1;
        } else {
            carried.refused += 1;
        }
    }
    target.timers.notify();
    Ok(carried)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scripts_are_the_reference_text_and_pass_the_loop_check() {
        for script in [&ENQUEUE, &CLAIM, &MOVE_OUT] {
            script.check().unwrap();
        }
        assert!(
            ENQUEUE
                .source()
                .starts_with("\nredis.call('ZREMRANGEBYSCORE'")
        );
        assert!(CLAIM.source().ends_with("return raw"));
    }

    #[test]
    fn the_channel_is_read_from_the_envelope() {
        assert_eq!(
            channel_of(br#"{"context":{"broadcasterId":"1001"}}"#).as_deref(),
            Some("1001")
        );
        assert_eq!(channel_of(b"{"), None);
        assert_eq!(channel_of(br#"{"context":{}}"#), None);
    }
}
