//! Native port of `dimabot/src/utils/ast_timer_runtime.ts` (180 lines).
//!
//! The timer runtime is the cache-backed job store that makes
//! `$(timer seconds message_and_actions)` survive a bot restart. Only *data*
//! crosses the cache boundary: the unevaluated AST body plus the timer context
//! snapshot produced by the existing
//! [`crate::utils::ast_evaluator::snapshot_timer_context`]. Callbacks are
//! rebuilt on recovery, and **no effect authority crosses the boundary** — the
//! snapshot has no `effectContext`, and the source states the same rule for the
//! duration expression ("Timers never carry live event-effect authority,
//! including their duration expression"). The `timer` function itself (usage,
//! depth, channel and seconds guards) is another lane; this module owns the
//! store and the scheduler only.
//!
//! Keys (exact source layout, [`TimerNamespace::source`]):
//!
//! - `ast:timers:pending` — global pending index, score = `dueAt` (ms)
//! - `ast:timers:job:<id>` — the serialized job payload
//! - `ast:timers:channel:<channelId>` — per-channel index, score = `expiresAt`
//!
//! Caps: [`MAX_CHANNEL_TIMERS`] per channel, [`MAX_PENDING_TIMERS`] globally,
//! [`MAX_JOB_BYTES`] per serialized job, and a [`RECONCILE_MS`] reconcile
//! cadence. [`TIMER_GRACE_MS`] is the 10-minute overdue grace period:
//! `expiresAt = dueAt + TIMER_GRACE_MS` and an overdue job still runs as long as
//! it is claimed before that instant.
//!
//! # Wait inventory (preserved from the source)
//!
//! | Source | Native | Why it stays |
//! |--------|--------|--------------|
//! | `setInterval(reconcile, 2000)` | [`RECONCILE_MS`], the hub's `reconcile_at_ms`, [`AstTimerScheduler::step`] / [`AstTimerScheduler::claim_due`] + [`AstTimerScheduler::next_wake_ms`] | Recovers jobs written by another instance or before a restart. Nothing ready is left sleeping: due jobs are claimed *before* the pass computes a wake instant, and the wake is clamped to `now`, so a pass never sleeps while a job is due. A failed pass schedules its retry one cadence after the failure, so the next wake is never overdue. |
//! | `setTimeout(fire, dueAt - now)` per job (`arm`) | one shared `(id -> dueAt)` set in [`TimerScheduleHub`] plus one sleep until the earliest deadline | Same delivery instant with one timer instead of N. A job is armed once, so repeated reconcile passes are idempotent, and the same hub is read by the scheduling side and by the driver, so a 1-second timer is visible immediately instead of at the next reconcile (the first factory's two maps made sub-2-second jobs up to `RECONCILE_MS` late and retained the catalog's entries). |
//! | `activeScheduler?.arm(...)` from `scheduleAstTimer` | [`AstTimerScheduler::arm`] on the shared hub, plus [`TimerScheduleHub`]'s wake notification | The source armed the one `activeScheduler` that also owned the `setTimeout` callbacks. Sharing the hub keeps that single set; the notification wakes [`AstTimerScheduler::wait`] so a nearer deadline is not stuck behind the previous wake. |
//! | `interval.unref()` / `timeout.unref()` | no detached task is spawned; the sleep is owned by the caller's loop and [`AstTimerScheduler::wait`] returns as soon as it is dropped | An idle bot must not hold a thread or keep the process alive. |
//! | `console.error('AST timer recovery failed; will retry')` | one `eprintln!` line per failed pass, with the next attempt scheduled at `RECONCILE_MS` after the failure | A cache hiccup must not kill scheduling and must not be retried in a tight loop. |
//! | no retry after a claim | same; see [`AstTimerScheduler::fire`] | A crash after claiming can lose an action; the source never blindly retries an external side effect whose outcome cannot be determined. |
//!
//! Every wait is a wait for genuinely future-due work, the reconcile cadence, or
//! a stop. No sleep is inserted while ready work remains: `claim_due` claims all
//! due jobs before computing the wake instant, and `next_wake_ms` clamps to
//! `now`.
//!
//! # Reconcile snapshot versus a concurrent arm
//!
//! Reconcile reads the pending index in one cache round trip and only then
//! rebuilds the local set. A `$(timer …)` that is enqueued *and* armed while
//! that read is in flight is absent from the returned snapshot but very much
//! live locally; rebuilding by "keep only the ids the snapshot listed" would
//! delete that arm and delay the delivery until the next pass. The hub therefore
//! tags every arm with the snapshot epoch it was created under, and a pass
//! removes only entries that predate its own snapshot
//! (`arm_epoch < snapshot_epoch`) **and** are no longer in the index. Entries
//! that are genuinely stale (claimed by another instance, reclaimed by the
//! cache) still go, the set stays bounded by the pending caps, and a stop still
//! clears every arm.
//!
//! # Reconcile retry cadence
//!
//! A failed pass (a cache read error) schedules its retry one [`RECONCILE_MS`]
//! after the failure, measured on the clock *after* the attempt. The source
//! retried on its 2-second interval; leaving `reconcile_at_ms` in the past
//! instead would make every following `claim_due`/`next_wake_ms`/`wait` observe
//! an overdue pass, return `now`, and hammer the cache with back-to-back
//! reconciles. A failed pass also leaves every existing arm untouched: it has
//! not proven anything stale.
//!
//! # At most once
//!
//! The claim **consumes** the job (payload key plus both index entries) before
//! the job is returned for execution, inside one Lua `EVAL`. Overlapping bot
//! instances therefore cannot double-fire: whoever runs `EVAL` first removes the
//! payload, and the loser observes `nil`. A crash between the claim and the
//! delivery can lose that action, which is the accepted trade: an external side
//! effect whose outcome cannot be determined is never replayed.
//!
//! # Fired-timer execution
//!
//! [`resume_timer_context`] is the inverse of
//! [`snapshot_timer_context`]: it rebuilds the [`Context`] that a claimed job
//! resumes with, from the data-only snapshot the job carried. It restores
//! exactly the fields the snapshot stores — `broadcasterId`, `userId`,
//! `userLogin`, `userDisplayName`, `userPlan`, `userLevel`,
//! `enforceFunctionPermissions`, `authorization`, `argument`, `count`,
//! `eventData`, `eventsubData`, `extraContext`, `platform`, `scopeType`,
//! `scopeName`, `scopeAliases`, `commandName`, `commandId`,
//! `commandRefBudget`, `commandRefDepth`, `visitedCommands`,
//! `commandResponses`, `variables`, `arrays`, `loopVars` and `timerDepth` — and
//! **invents nothing**: a field the snapshot does not carry keeps its
//! `ExecutionContext::default()` value. The snapshot never carries effect
//! authority, so the resumed context has none; `timerDepth` was already
//! incremented by one when the snapshot was taken, so resuming does not
//! increment it again.
//!
//! The execution order is the source's `executeAstTimerJob`:
//!
//! 1. rebuild the context from the snapshot, bound to the job's broadcaster;
//! 2. evaluate the stored, still-unevaluated [`AstNode`] body in that fresh
//!    context (no re-parse: the job stores the parsed tree);
//! 3. deliver the rendered text plus the command references the evaluation
//!    produced, through `deliver_ast_message` in
//!    `crate::utils::ast_runtime::delivery`, so the drain-once,
//!    send-before-references and continue-on-reference-error rules stay in one
//!    place.
//!
//! The execution half itself lives in
//! `crate::utils::ast_runtime::bootstrap::execute_ast_timer_job`, because it
//! needs the engine, the application host and the delivery seams; this module
//! only owns the cache-backed store, the scheduler and the context rebuild.
//!
//! # Pacing and backlog (preserved from the source)
//!
//! - `ast:timers:pending` (score `dueAt`), `ast:timers:job:<id>` (payload,
//!   `PXAT expiresAt`) and `ast:timers:channel:<channelId>` (score
//!   `expiresAt`, key TTL at its highest score) are the only keys.
//! - [`MAX_CHANNEL_TIMERS`] = 100 per channel, [`MAX_PENDING_TIMERS`] =
//!   10_000 globally, [`MAX_JOB_BYTES`] = 64 KiB per serialized job and
//!   [`RECONCILE_MS`] = 2000 ms reconcile cadence.
//! - [`TIMER_GRACE_MS`] = 10 minutes, so `expiresAt = dueAt + 10 min`; a job
//!   claimed at or after `expiresAt` is consumed and dropped instead of run.
//!   `MAX_TIMER_SECONDS` = 604800 and `MAX_TIMER_DEPTH` = 5 are the `timer`
//!   function's guards and live in `crate::utils::ast_runtime::functions` and
//!   `crate::utils::ast_runtime::host`; this module only persists what they
//!   accepted.
//! - Enqueue happens inside the `timer` function's evaluation and the job is
//!   **never** evaluated or delivered in that tick. Execution happens only in a
//!   later scheduler pass ([`AstTimerScheduler::step`] or
//!   [`AstTimerScheduler::fire`]), which is the source's `setTimeout` callback.
//! - [`AstTimerScheduler::schedule`] writes the job and arms it in the shared
//!   [`TimerScheduleHub`] — the same set [`AstTimerScheduler::claim_due`] drains
//!   and [`AstTimerScheduler::next_wake_ms`] measures. A driver sleeping in
//!   [`AstTimerScheduler::wait`] wakes for that new deadline, so a short timer is
//!   not delayed to the next reconcile pass.
//! - Due work is claimed before the pass computes a wake instant, and the wake
//!   is clamped to `now`, so a pass never sleeps while a job is due.
//!   Reconcile runs on its own cadence and is the only path that recovers jobs
//!   written by another instance or before a restart.
//! - A claimed job that then fails to evaluate or deliver is logged and dropped;
//!   it is never retried, because the claim already consumed it.
//!
//! # Lua atomicity
//!
//! The source uses `EVAL` with two Lua bodies. Both bodies are kept verbatim in
//! [`ENQUEUE_TIMER_JOB_SCRIPT`] and [`CLAIM_TIMER_JOB_SCRIPT`] and executed with
//! a raw `EVAL` through the native `redis` client, so the store keeps the same
//! single-round-trip atomicity: the prune-before-cap check, the payload and both
//! index writes, and the consume-before-execute claim all happen server side.
//! `EVALSHA` caching is not used; the body is sent per call, which changes
//! payload bytes on the wire only, not semantics.
//!
//! # Boundaries
//!
//! Construction performs no I/O and no module-level singleton exists: the
//! Dragonfly connection is injected. [`DragonflyTimerStore::connect`] is the
//! only place that reads the process environment (through the existing
//! `get_redis_client` utility) and every caller must opt into it explicitly.
//! The scheduler itself holds no AST context and is `Send` when its store,
//! clock and id source are; the jobs it returns carry `Rc`-based context
//! snapshots and are not, so the scheduler is still driven by its owner (a
//! `step`/`wait` loop) rather than a spawned task.
//!
//! [`TimerScheduleHub`] is the only shared mutable state: plain deadlines behind
//! an `Arc<Mutex<…>>`, never locked across an `await`, so a scheduling call from
//! the function catalog and the single driver can both use it without blocking
//! each other and without a nested-timer deadlock.
//!
//! Module registration, the feature gate and the `Cargo.toml` feature are the
//! integration team's patch; this file declares no dependencies of its own and
//! adds none.

use crate::utils::ast_evaluator::{
    CommandRefBudget, Context, ExecutionContext, JsString, JsValue, LoopVars, SharedMap, json_parse,
    json_stringify, snapshot_timer_context,
};
use crate::utils::ast_syntax::AstNode;
use redis::aio::ConnectionManager;
use serde::{Deserialize, Serialize};
use serde_json::value::RawValue;
use sha2::{Digest, Sha256};
use std::{
    cell::RefCell,
    collections::{BTreeMap, BTreeSet},
    fmt,
    rc::Rc,
    sync::{
        Arc, Mutex as StdMutex,
        atomic::{AtomicU64, Ordering},
    },
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tokio::sync::Notify;

/// Global pending index, scored by `dueAt` milliseconds.
pub const AST_TIMER_INDEX: &str = "ast:timers:pending";
/// Job payload key prefix; the job id is appended verbatim.
pub const AST_TIMER_JOB_PREFIX: &str = "ast:timers:job:";
/// Per-channel index key prefix, scored by `expiresAt` milliseconds.
pub const AST_TIMER_CHANNEL_PREFIX: &str = "ast:timers:channel:";
/// Maximum timers waiting in one channel index.
pub const MAX_CHANNEL_TIMERS: usize = 100;
/// Maximum timers waiting in the global index.
pub const MAX_PENDING_TIMERS: usize = 10_000;
/// Maximum serialized job size, measured in UTF-8 bytes like `Buffer.byteLength`.
pub const MAX_JOB_BYTES: usize = 64 * 1024;
/// Reconcile cadence, matching the source `setInterval` delay.
pub const RECONCILE_MS: i64 = 2_000;
/// Overdue grace period: `expiresAt = dueAt + TIMER_GRACE_MS`.
pub const TIMER_GRACE_MS: i64 = 10 * 60 * 1000;
/// Persisted job envelope version.
pub const AST_TIMER_JOB_VERSION: i64 = 1;

/// Enqueue script, kept verbatim from `ast_timer_runtime.ts` lines 26-34.
///
/// `KEYS` = job key, global index, channel index. `ARGV` = payload, id, dueAt,
/// expiresAt, now, grace, global cap, channel cap. Stale scores are pruned
/// before the caps are read, so a bot that was offline while the payload expired
/// cannot be locked out by its own dead entries.
pub const ENQUEUE_TIMER_JOB_SCRIPT: &str = r#"
redis.call('ZREMRANGEBYSCORE', KEYS[2], '-inf', ARGV[5] - ARGV[6])
redis.call('ZREMRANGEBYSCORE', KEYS[3], '-inf', ARGV[5])
if redis.call('ZCARD', KEYS[2]) >= tonumber(ARGV[7]) or redis.call('ZCARD', KEYS[3]) >= tonumber(ARGV[8]) then return 0 end
redis.call('SET', KEYS[1], ARGV[1], 'PXAT', ARGV[4])
redis.call('ZADD', KEYS[2], ARGV[3], ARGV[2])
redis.call('ZADD', KEYS[3], ARGV[4], ARGV[2])
redis.call('PEXPIREAT', KEYS[3], redis.call('ZRANGE', KEYS[3], -1, -1, 'WITHSCORES')[2])
return 1"#;

/// Claim script, kept verbatim from `ast_timer_runtime.ts` lines 39-48.
///
/// `KEYS` = job key, global index, channel index. `ARGV` = id, now. The payload
/// is deleted (and both index entries cleared) *before* the expiry decision is
/// reported, which is what makes delivery at most once.
pub const CLAIM_TIMER_JOB_SCRIPT: &str = r#"
local raw = redis.call('GET', KEYS[1])
if not raw then redis.call('ZREM', KEYS[2], ARGV[1]); return nil end
local job = cjson.decode(raw)
if job.dueAt > tonumber(ARGV[2]) then return nil end
redis.call('DEL', KEYS[1])
redis.call('ZREM', KEYS[2], ARGV[1])
redis.call('ZREM', KEYS[3], ARGV[1])
if job.expiresAt <= tonumber(ARGV[2]) then return nil end
return raw"#;

/// Typed failures of the timer store and scheduler.
#[derive(Debug)]
pub enum AstTimerError {
    /// The serialized job exceeded [`MAX_JOB_BYTES`]; nothing was written.
    PayloadTooLarge { bytes: usize },
    /// The per-channel or global pending cap was reached; nothing was written.
    PendingLimitReached { channel_id: String },
    /// No payload exists for this id. Reported by [`AstTimerScheduler::peek`];
    /// [`AstTimerScheduler::fire`] reports the same case as
    /// [`ClaimOutcome::Missing`] because the source returns `nil` rather than
    /// throwing.
    JobNotFound { id: String },
    /// The stored job is past `expiresAt`. Reported by
    /// [`AstTimerScheduler::peek`]; `fire` reports
    /// [`ClaimOutcome::Expired`] after consuming it.
    Expired { id: String },
    /// The payload declares a version this runtime cannot execute.
    UnsupportedVersion { version: i64 },
    /// `seconds` was not a finite number, so no meaningful due instant exists.
    InvalidDuration { seconds: f64 },
    /// The context snapshot could not be serialized to JSON text.
    ContextEncoding { message: String },
    /// The envelope could not be serialized.
    JobEncoding(serde_json::Error),
    /// A stored payload is not a timer job this runtime understands.
    JobDecoding { message: String },
    /// A stored index score was not a number.
    InvalidScore { value: String },
    /// Dragonfly/Redis transport or command failure.
    Redis(redis::RedisError),
}

impl fmt::Display for AstTimerError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::PayloadTooLarge { bytes } => write!(
                formatter,
                "Timer context exceeds 64 KiB (serialized job is {bytes} bytes, limit {MAX_JOB_BYTES})"
            ),
            Self::PendingLimitReached { channel_id } => write!(
                formatter,
                "Pending timer limit reached for channel {channel_id} (limits {MAX_CHANNEL_TIMERS} per channel, {MAX_PENDING_TIMERS} global)"
            ),
            Self::JobNotFound { id } => write!(formatter, "AST timer job not found: {id}"),
            Self::Expired { id } => write!(formatter, "AST timer job expired: {id}"),
            Self::UnsupportedVersion { version } => {
                write!(formatter, "Unsupported AST timer job version {version}")
            }
            Self::InvalidDuration { seconds } => write!(
                formatter,
                "timer seconds must be a finite number, received {seconds}"
            ),
            Self::ContextEncoding { message } => {
                write!(formatter, "AST timer context is not serializable: {message}")
            }
            Self::JobEncoding(error) => {
                write!(formatter, "AST timer job is not serializable: {error}")
            }
            Self::JobDecoding { message } => {
                write!(formatter, "AST timer job is not decodable: {message}")
            }
            Self::InvalidScore { value } => {
                write!(formatter, "AST timer index score is not a number: {value}")
            }
            Self::Redis(error) => fmt::Display::fmt(error, formatter),
        }
    }
}

impl std::error::Error for AstTimerError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::JobEncoding(error) => Some(error),
            Self::Redis(error) => Some(error),
            _ => None,
        }
    }
}

impl From<redis::RedisError> for AstTimerError {
    fn from(error: redis::RedisError) -> Self {
        Self::Redis(error)
    }
}

/// A stored timer: the unevaluated body plus the data-only context snapshot.
///
/// `context` is the `JsValue` snapshot from
/// [`crate::utils::ast_evaluator::snapshot_timer_context`]. It is an `Rc`-based
/// value, so this type is deliberately not `Send`; the scheduler is driven by its
/// owner rather than spawned.
#[derive(Clone, Debug)]
pub struct AstTimerJob {
    pub version: i64,
    pub id: String,
    pub due_at: i64,
    pub expires_at: i64,
    pub body: AstNode,
    pub context: JsValue,
}

impl AstTimerJob {
    /// Channel id carried by the context snapshot (`broadcasterId`).
    ///
    /// Scheduling reads it from the live context instead; this accessor serves
    /// the claim and peek paths, where only the stored snapshot is available.
    pub fn channel_id(&self) -> Result<String, AstTimerError> {
        match self.context.get("broadcasterId") {
            JsValue::String(value) => value
                .to_utf8()
                .map_err(|error| AstTimerError::JobDecoding {
                    message: error.to_string(),
                }),
            _ => Err(AstTimerError::JobDecoding {
                message: "timer context has no broadcasterId".to_owned(),
            }),
        }
    }
}

/// Physical key layout. The defaults are the source's literal keys, which the
/// TypeScript producer/consumer still shares during the migration.
///
/// The native client has no collection namespace of its own, so this type is the
/// only place key layout is decided. Production must use
/// [`TimerNamespace::source`]; [`TimerNamespace::with_prefix`] exists so an
/// isolated validation run can own its keys without touching live timers, and it
/// must never be used where the TypeScript runtime is also running.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TimerNamespace {
    pub job_prefix: String,
    pub index: String,
    pub channel_prefix: String,
}

impl TimerNamespace {
    /// Exact source layout: `ast:timers:job:`, `ast:timers:pending`,
    /// `ast:timers:channel:`.
    pub fn source() -> Self {
        Self {
            job_prefix: AST_TIMER_JOB_PREFIX.to_owned(),
            index: AST_TIMER_INDEX.to_owned(),
            channel_prefix: AST_TIMER_CHANNEL_PREFIX.to_owned(),
        }
    }

    /// Prepends `prefix` verbatim to all three keys (include your own
    /// separator). Opt-in isolation only; see the type docs.
    pub fn with_prefix(prefix: &str) -> Self {
        Self {
            job_prefix: format!("{prefix}{AST_TIMER_JOB_PREFIX}"),
            index: format!("{prefix}{AST_TIMER_INDEX}"),
            channel_prefix: format!("{prefix}{AST_TIMER_CHANNEL_PREFIX}"),
        }
    }

    pub fn job_key(&self, id: &str) -> String {
        format!("{}{id}", self.job_prefix)
    }

    pub fn channel_key(&self, channel_id: &str) -> String {
        format!("{}{channel_id}", self.channel_prefix)
    }
}

impl Default for TimerNamespace {
    fn default() -> Self {
        Self::source()
    }
}

/// One index entry read back during reconcile.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PendingTimer {
    pub id: String,
    pub due_at_ms: i64,
}

/// Everything the store needs to reproduce the enqueue script.
#[derive(Clone, Copy, Debug)]
pub struct TimerEnqueue<'a> {
    pub id: &'a str,
    pub channel_id: &'a str,
    pub payload: &'a str,
    pub due_at_ms: i64,
    pub expires_at_ms: i64,
    pub now_ms: i64,
}

/// Storage seam. Only serialized payloads, ids, channel ids and millisecond
/// scores cross it, so the `Rc`-based AST context never reaches the store and no
/// `Send` bound is required anywhere.
///
/// The production adapter is [`DragonflyTimerStore`]; tests use an in-memory
/// fake that reproduces the same scripted sequence. The futures are awaited in
/// place by the scheduler and are never spawned or boxed.
#[allow(async_fn_in_trait)]
pub trait AstTimerStore {
    /// Writes the payload, the global index entry and the channel index entry
    /// together. Returns `false` when a pending cap was reached (the script's
    /// `return 0`); stale scores must be pruned first, inside the same call.
    async fn enqueue(&mut self, request: &TimerEnqueue<'_>) -> Result<bool, AstTimerError>;

    /// `GET` of the payload, used to identify the channel index before claiming.
    /// The claim still decides atomically whether this instance owns execution.
    async fn load_payload(&mut self, id: &str) -> Result<Option<String>, AstTimerError>;

    /// Consumes a due, unexpired job and returns its raw payload.
    ///
    /// `Ok(None)` covers all three `nil` paths: no payload (the global index
    /// entry is cleared), not yet due (nothing is changed), and expired (the
    /// payload and both index entries are already removed).
    async fn claim(
        &mut self,
        id: &str,
        channel_id: &str,
        now_ms: i64,
    ) -> Result<Option<String>, AstTimerError>;

    /// `ZREMRANGEBYSCORE pending -inf max_score`; returns the removed count.
    async fn prune_pending(&mut self, max_score_ms: i64) -> Result<usize, AstTimerError>;

    /// Up to `limit` pending entries in score order, with scores.
    async fn pending(&mut self, limit: usize) -> Result<Vec<PendingTimer>, AstTimerError>;

    /// Clears one global index entry; returns whether it existed.
    async fn drop_pending(&mut self, id: &str) -> Result<bool, AstTimerError>;
}

/// Production adapter: raw `EVAL` over an injected Dragonfly connection manager.
///
/// Construction performs no I/O. The manager is the existing multiplexed client
/// from [`crate::utils::redis::get_redis_client`]; clone it through
/// [`DragonflyTimerStore::connect`] or inject one directly.
#[derive(Clone)]
pub struct DragonflyTimerStore {
    connection: ConnectionManager,
    namespace: TimerNamespace,
}

impl DragonflyTimerStore {
    /// No I/O, no environment read: the caller supplies the connection.
    pub fn new(connection: ConnectionManager) -> Self {
        Self {
            connection,
            namespace: TimerNamespace::source(),
        }
    }

    pub fn with_namespace(connection: ConnectionManager, namespace: TimerNamespace) -> Self {
        Self {
            connection,
            namespace,
        }
    }

    /// Explicit I/O entry point. Uses the shared native Dragonfly client; the
    /// environment is read by that utility, not by this module.
    pub async fn connect() -> Result<Self, AstTimerError> {
        Ok(Self::new(crate::utils::redis::get_redis_client().await?))
    }

    pub fn connection(&self) -> &ConnectionManager {
        &self.connection
    }

    pub fn namespace(&self) -> &TimerNamespace {
        &self.namespace
    }

    fn keys_for(&self, request: &TimerEnqueue<'_>) -> Vec<String> {
        vec![
            self.namespace.job_key(request.id),
            self.namespace.index.clone(),
            self.namespace.channel_key(request.channel_id),
        ]
    }
}

impl AstTimerStore for DragonflyTimerStore {
    async fn enqueue(&mut self, request: &TimerEnqueue<'_>) -> Result<bool, AstTimerError> {
        let keys = self.keys_for(request);
        let arguments = vec![
            request.payload.to_owned(),
            request.id.to_owned(),
            request.due_at_ms.to_string(),
            request.expires_at_ms.to_string(),
            request.now_ms.to_string(),
            TIMER_GRACE_MS.to_string(),
            MAX_PENDING_TIMERS.to_string(),
            MAX_CHANNEL_TIMERS.to_string(),
        ];
        let accepted: i64 = redis::cmd("EVAL")
            .arg(ENQUEUE_TIMER_JOB_SCRIPT)
            .arg(keys.len())
            .arg(&keys)
            .arg(&arguments)
            .query_async(&mut self.connection)
            .await?;
        Ok(accepted == 1)
    }

    async fn load_payload(&mut self, id: &str) -> Result<Option<String>, AstTimerError> {
        Ok(redis::cmd("GET")
            .arg(self.namespace.job_key(id))
            .query_async(&mut self.connection)
            .await?)
    }

    async fn claim(
        &mut self,
        id: &str,
        channel_id: &str,
        now_ms: i64,
    ) -> Result<Option<String>, AstTimerError> {
        let keys = vec![
            self.namespace.job_key(id),
            self.namespace.index.clone(),
            self.namespace.channel_key(channel_id),
        ];
        Ok(redis::cmd("EVAL")
            .arg(CLAIM_TIMER_JOB_SCRIPT)
            .arg(keys.len())
            .arg(&keys)
            .arg(id)
            .arg(now_ms)
            .query_async(&mut self.connection)
            .await?)
    }

    async fn prune_pending(&mut self, max_score_ms: i64) -> Result<usize, AstTimerError> {
        let removed: i64 = redis::cmd("ZREMRANGEBYSCORE")
            .arg(&self.namespace.index)
            .arg("-inf")
            .arg(max_score_ms)
            .query_async(&mut self.connection)
            .await?;
        Ok(usize::try_from(removed).unwrap_or(0))
    }

    async fn pending(&mut self, limit: usize) -> Result<Vec<PendingTimer>, AstTimerError> {
        if limit == 0 {
            return Ok(Vec::new());
        }
        // `WITHSCORES` is a flat member/score list, so it is paired here rather
        // than relying on a tuple decoder for the whole reply.
        let flat: Vec<String> = redis::cmd("ZRANGE")
            .arg(&self.namespace.index)
            .arg(0)
            .arg(limit.saturating_sub(1))
            .arg("WITHSCORES")
            .query_async(&mut self.connection)
            .await?;
        let mut entries = Vec::with_capacity(flat.len() / 2);
        for pair in flat.chunks(2) {
            let Some(id) = pair.first() else { continue };
            let Some(score) = pair.get(1) else { continue };
            let due_at = score
                .parse::<f64>()
                .map_err(|_| AstTimerError::InvalidScore {
                    value: score.clone(),
                })?;
            entries.push(PendingTimer {
                id: id.clone(),
                due_at_ms: due_at.round() as i64,
            });
        }
        Ok(entries)
    }

    async fn drop_pending(&mut self, id: &str) -> Result<bool, AstTimerError> {
        let removed: i64 = redis::cmd("ZREM")
            .arg(&self.namespace.index)
            .arg(id)
            .query_async(&mut self.connection)
            .await?;
        Ok(removed > 0)
    }
}

/// Wall-clock source. Injected so tests can move time without sleeping.
///
/// `sleep_until` is the only waiting primitive. Its default implementation is a
/// Tokio timer that is dropped with the future, matching the source's `unref`
/// intent: nothing keeps the process alive while the queue is idle.
#[allow(async_fn_in_trait)]
pub trait AstTimerClock {
    fn now_ms(&self) -> i64;

    async fn sleep_until(&mut self, at_ms: i64) {
        let remaining = u64::try_from(at_ms.saturating_sub(self.now_ms())).unwrap_or(0);
        tokio::time::sleep(Duration::from_millis(remaining)).await;
    }
}

/// Milliseconds since the Unix epoch, `0` before it.
#[derive(Clone, Copy, Debug, Default)]
pub struct SystemClock;

impl AstTimerClock for SystemClock {
    fn now_ms(&self) -> i64 {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|elapsed| i64::try_from(elapsed.as_millis()).unwrap_or(i64::MAX))
            .unwrap_or(0)
    }
}

/// Job id source. The source used `randomUUID()`; ids are opaque, so any unique
/// string works.
pub trait AstTimerIdSource {
    fn next_id(&mut self) -> String;
}

/// Default id source: 32 hex characters derived from SHA-256 over
/// (construction-time clock, process id, per-source sequence, counter).
///
/// The source produced RFC 4122 v4 UUIDs. That is an id *shape* change only: the
/// id is an opaque key segment and a log field, never parsed. `uuid` stays out of
/// this lane's dependency set; `sha2` is already in the feature graph.
///
/// Two sources built in one process share the wall clock and the pid, so a
/// process-wide sequence is part of the seed: a catalog scheduler and a driver
/// scheduler over one shared [`TimerScheduleHub`] must never mint the same id for
/// different jobs in the same namespace.
#[derive(Debug)]
pub struct DigestTimerIdSource {
    seed: [u8; 32],
    counter: u64,
}

/// Distinguishes id sources constructed in the same process and clock tick.
static ID_SOURCE_SEQUENCE: AtomicU64 = AtomicU64::new(0);

impl DigestTimerIdSource {
    pub fn new() -> Self {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|elapsed| elapsed.as_nanos())
            .unwrap_or(0);
        let sequence = ID_SOURCE_SEQUENCE.fetch_add(1, Ordering::Relaxed);
        let mut hasher = Sha256::new();
        hasher.update(nanos.to_le_bytes());
        hasher.update(std::process::id().to_le_bytes());
        hasher.update(sequence.to_le_bytes());
        Self {
            seed: hasher.finalize().into(),
            counter: 0,
        }
    }
}

impl Default for DigestTimerIdSource {
    fn default() -> Self {
        Self::new()
    }
}

impl AstTimerIdSource for DigestTimerIdSource {
    fn next_id(&mut self) -> String {
        self.counter = self.counter.wrapping_add(1);
        let mut hasher = Sha256::new();
        hasher.update(self.seed);
        hasher.update(self.counter.to_le_bytes());
        let mut id = format!("{:x}", hasher.finalize());
        // 32 hex characters keeps the key segment close to a UUID's width.
        id.truncate(32);
        id
    }
}

/// Resolved outcome of one claim attempt.
#[derive(Debug)]
pub enum ClaimOutcome {
    /// Consumed and due: the caller owns execution exactly once.
    Claimed(Box<AstTimerJob>),
    /// The payload exists but `dueAt` is still in the future. Nothing changed.
    NotYetDue,
    /// The payload was past `expiresAt`; it has been consumed and dropped.
    Expired,
    /// No payload was found (already claimed elsewhere, or reclaimed by the
    /// cache). Any surviving global index entry is cleared.
    Missing,
    /// The scheduler was stopped, so nothing was read or consumed.
    Stopped,
}

/// One scheduler pass result: the jobs this instance now owns, and the instant
/// the owner should sleep until.
#[derive(Debug)]
pub struct StepOutcome {
    /// Jobs claimed by this pass, in due order. Execute them before sleeping;
    /// each one is already consumed and must not be retried blindly.
    pub jobs: Vec<AstTimerJob>,
    /// Earliest real deadline: an armed `dueAt` or the next reconcile pass.
    /// Never earlier than `now`, so a pass with ready work does not sleep.
    pub wake_ms: i64,
}

/// The one scheduling set a bot process owns.
///
/// Source: the module-global `activeScheduler` and its `timers` map. The
/// TypeScript runtime armed exactly one map — `scheduleAstTimer` called
/// `activeScheduler?.arm(job.id, job.dueAt)` and the `setTimeout` callbacks
/// drained that same map — so scheduling and delivery could never disagree
/// about what was armed.
///
/// The first native factory built two independent scheduler values (the function
/// catalog's and the delivery one). A job written through the catalog was
/// therefore invisible to the driver until the next reconcile pass: a 1-second
/// timer could be delivered up to [`RECONCILE_MS`] late, and the catalog's own
/// armed entries were never drained by anything.
///
/// A hub is that single set. Every [`AstTimerScheduler`] built with
/// [`AstTimerScheduler::with_hub`] reads and writes the same armed deadlines,
/// the same stopped flag and the same reconcile cadence, and arming a deadline
/// wakes a driver sleeping in [`AstTimerScheduler::wait`]. A scheduler built
/// with [`AstTimerScheduler::new`] owns a private hub, which keeps a
/// single-scheduler test or a second independent runtime unaffected.
///
/// A rebuild is the only place that can remove an arm this instance did not
/// claim, and it removes only arms that predate its own cache read (see
/// "Reconcile snapshot versus a concurrent arm"). An arm created while that
/// read was in flight survives, so a concurrent `$(timer …)` is still delivered
/// at its own `dueAt`; the set stays bounded because every entry is either an
/// indexed pending job or an arm newer than the last snapshot, and claims,
/// stop and stale removal all remove entries.
///
/// Every field is behind an `Arc`; the deadline state is guarded by a short,
/// synchronous `Mutex` and arming publishes a wake-up through `Notify`. No guard
/// is ever held across an `await`. `TimerScheduleHub` is `Send + Sync`; the
/// scheduler values built on it stay `Send` when their store, clock and id
/// source are `Send`, which is what the function catalog requires.
#[derive(Clone, Debug, Default)]
pub struct TimerScheduleHub {
    state: Arc<StdMutex<TimerScheduleState>>,
    wake: Arc<Notify>,
}

/// Mutable deadline state shared by every handle on one [`TimerScheduleHub`].
#[derive(Debug)]
struct TimerScheduleState {
    armed: BTreeMap<String, ArmedTimer>,
    stopped: bool,
    reconcile_at_ms: i64,
    /// Monotonic epoch of reconcile snapshots. An arm records the epoch that was
    /// current when it was created, so a rebuild can tell "this arm is older
    /// than my snapshot, so the index read must have listed it if it were still
    /// pending" from "this arm was created while my snapshot was in flight".
    arm_epoch: u64,
}

/// One armed deadline plus the reconcile-snapshot epoch it was armed under.
#[derive(Clone, Copy, Debug)]
struct ArmedTimer {
    due_at_ms: i64,
    arm_epoch: u64,
}

impl Default for TimerScheduleState {
    fn default() -> Self {
        Self {
            armed: BTreeMap::new(),
            // The source starts `stopped = true` and only `start` flips it.
            stopped: true,
            reconcile_at_ms: 0,
            arm_epoch: 0,
        }
    }
}

impl TimerScheduleHub {
    pub fn new() -> Self {
        Self::default()
    }

    fn state(&self) -> std::sync::MutexGuard<'_, TimerScheduleState> {
        self.state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// Number of armed ids in the shared set (one per pending timer, at most).
    pub fn armed_len(&self) -> usize {
        self.state().armed.len()
    }

    pub fn is_armed(&self, id: &str) -> bool {
        self.state().armed.contains_key(id)
    }

    pub fn is_stopped(&self) -> bool {
        self.state().stopped
    }

    /// Earliest armed `dueAt` in the shared set, if any.
    pub fn next_deadline_ms(&self) -> Option<i64> {
        self.state().armed.values().map(|entry| entry.due_at_ms).min()
    }

    /// Instant of the next reconcile pass.
    pub fn reconcile_deadline_ms(&self) -> i64 {
        self.state().reconcile_at_ms
    }

    /// Opens a reconcile snapshot and returns its epoch.
    ///
    /// Called *before* the cache read, so every arm created from then on is
    /// tagged with this epoch (or a later one) and a rebuild from this snapshot
    /// knows not to treat it as stale.
    fn begin_snapshot(&self) -> u64 {
        let mut state = self.state();
        state.arm_epoch = state.arm_epoch.wrapping_add(1);
        state.arm_epoch
    }

    /// Stores the instant of the next reconcile attempt, including the retry
    /// after a failed pass.
    fn schedule_reconcile(&self, at_ms: i64) {
        self.state().reconcile_at_ms = at_ms;
    }

    /// Flips a stopped schedule to running. `false` when it was already running,
    /// matching the source's `if (!this.stopped) return`.
    fn begin(&self) -> bool {
        let mut state = self.state();
        if !state.stopped {
            return false;
        }
        state.stopped = false;
        true
    }

    /// Rolls a failed first recovery back to stopped so `start` is retryable.
    fn abort_start(&self) {
        self.state().stopped = true;
    }

    /// Wakes a driver waiting in [`AstTimerScheduler::wait`].
    ///
    /// `notify_one` keeps a permit when nobody is waiting, so a wake-up that
    /// arrives between the driver's state read and its `select!` is not lost.
    fn notify(&self) {
        self.wake.notify_one();
    }

    /// Stops delivery, forgets every armed deadline and wakes a waiting driver.
    /// Pending jobs stay in the cache, so another instance (or the next
    /// `start`) can recover them.
    fn stop(&self) {
        {
            let mut state = self.state();
            state.stopped = true;
            state.armed.clear();
        }
        self.notify();
    }

    /// Arms one deadline. Returns whether the shared set changed.
    ///
    /// Ignored while stopped and idempotent per id, exactly like the source's
    /// `arm`: `if (this.stopped || this.timers.has(id)) return;`.
    fn arm(&self, id: &str, due_at_ms: i64) -> bool {
        let mut state = self.state();
        if state.stopped || state.armed.contains_key(id) {
            return false;
        }
        let arm_epoch = state.arm_epoch;
        state.armed.insert(id.to_owned(), ArmedTimer { due_at_ms, arm_epoch });
        true
    }

    /// Forgets one armed deadline (the claim path, on every outcome).
    fn disarm(&self, id: &str) {
        self.state().armed.remove(id);
    }

    /// Removes and returns the ids whose deadline has passed, in due order.
    fn take_due(&self, now_ms: i64) -> Vec<String> {
        let mut state = self.state();
        let mut due: Vec<(i64, String)> = state
            .armed
            .iter()
            .filter(|(_, entry)| entry.due_at_ms <= now_ms)
            .map(|(id, entry)| (entry.due_at_ms, id.clone()))
            .collect();
        due.sort();
        let ids: Vec<String> = due.into_iter().map(|(_, id)| id).collect();
        for id in &ids {
            state.armed.remove(id);
        }
        ids
    }

    /// Rebuilds the shared set from a pending page and stores the next cadence.
    /// Returns whether a newly discovered deadline was armed, so the caller can
    /// wake the driver.
    ///
    /// `snapshot_epoch` is the epoch [`TimerScheduleHub::begin_snapshot`]
    /// returned *before* the cache read that produced `pending`. An arm created
    /// after that point is newer than the snapshot and must survive even though
    /// the snapshot could not list it; only arms that predate the snapshot and
    /// are absent from the page are genuinely stale.
    fn rebuild(
        &self,
        pending: &[PendingTimer],
        snapshot_epoch: u64,
        next_reconcile_ms: i64,
    ) -> bool {
        let mut state = self.state();
        let live: BTreeSet<&str> = pending.iter().map(|entry| entry.id.as_str()).collect();
        state.armed.retain(|id, entry| {
            live.contains(id.as_str()) || entry.arm_epoch >= snapshot_epoch
        });
        let mut changed = false;
        if !state.stopped {
            let arm_epoch = state.arm_epoch;
            for entry in pending {
                if !state.armed.contains_key(&entry.id) {
                    let armed = ArmedTimer {
                        due_at_ms: entry.due_at_ms,
                        arm_epoch,
                    };
                    state.armed.insert(entry.id.clone(), armed);
                    changed = true;
                }
            }
        }
        state.reconcile_at_ms = next_reconcile_ms;
        changed
    }

    /// Waits for a new arm or stop. The caller owns the clock and decides how
    /// long to wait; this future is dropped with the caller's loop, matching the
    /// source's `unref` intent.
    async fn wait_for_wake(&self) {
        self.wake.notified().await;
    }
}

/// Cache-backed timer scheduler: owns the store, the clock and the id source.
///
/// The source module had an `activeScheduler` module global plus `setTimeout`
/// handles. This port has neither: the owner constructs the scheduler, injects
/// the connection, and drives [`AstTimerScheduler::step`] / waits in
/// [`AstTimerScheduler::wait`]. No I/O happens at construction and no task is
/// spawned.
///
/// The armed deadlines, the stopped flag and the reconcile cadence live in a
/// [`TimerScheduleHub`], not in this value. [`AstTimerScheduler::new`] gives a
/// value a private hub; [`AstTimerScheduler::with_hub`] makes several values
/// share one schedule, which is how the function catalog's arm reaches the one
/// driver immediately (see the hub docs).
pub struct AstTimerScheduler<S, C, I> {
    hub: TimerScheduleHub,
    store: S,
    clock: C,
    ids: I,
}

impl<S, C, I> AstTimerScheduler<S, C, I>
where
    S: AstTimerStore,
    C: AstTimerClock,
    I: AstTimerIdSource,
{
    /// No I/O: every collaborator is injected and the schedule is private to
    /// this value.
    pub fn new(store: S, clock: C, ids: I) -> Self {
        Self::with_hub(TimerScheduleHub::new(), store, clock, ids)
    }

    /// Builds a scheduler value over an existing [`TimerScheduleHub`].
    ///
    /// Two values made with the same hub (and the same namespace) form the
    /// source's one scheduler: the function catalog can arm a job and the
    /// driver that owns the reconcile loop sees it immediately. The values keep
    /// their own store handle, clock and id source.
    pub fn with_hub(hub: TimerScheduleHub, store: S, clock: C, ids: I) -> Self {
        Self {
            hub,
            store,
            clock,
            ids,
        }
    }

    /// The shared scheduling set. Cloning it yields another handle on the same
    /// deadlines; it performs no I/O.
    pub fn hub(&self) -> TimerScheduleHub {
        self.hub.clone()
    }

    pub fn store(&self) -> &S {
        &self.store
    }

    pub fn store_mut(&mut self) -> &mut S {
        &mut self.store
    }

    pub fn clock(&self) -> &C {
        &self.clock
    }

    pub fn ids_mut(&mut self) -> &mut I {
        &mut self.ids
    }

    pub fn into_parts(self) -> (S, C, I) {
        (self.store, self.clock, self.ids)
    }

    pub fn is_stopped(&self) -> bool {
        self.hub.is_stopped()
    }

    /// Number of locally armed ids (one per pending timer, at most).
    pub fn armed_len(&self) -> usize {
        self.hub.armed_len()
    }

    pub fn is_armed(&self, id: &str) -> bool {
        self.hub.is_armed(id)
    }

    /// Earliest armed `dueAt`, if any.
    pub fn next_deadline_ms(&self) -> Option<i64> {
        self.hub.next_deadline_ms()
    }

    /// Instant the owner should sleep until: the earlier of the next armed
    /// deadline and the next reconcile pass, clamped to `now_ms`.
    pub fn next_wake_ms(&self, now_ms: i64) -> i64 {
        let cadence = self.hub.reconcile_deadline_ms();
        let deadline = self
            .hub
            .next_deadline_ms()
            .map_or(cadence, |due| due.min(cadence));
        deadline.max(now_ms)
    }

    /// Starts recovery. The first reconcile failure is returned to the caller
    /// (a bot that cannot read the cache should surface it) and rolls the state
    /// back to stopped so the call can be retried. The periodic loop keeps the
    /// source's log-and-retry behaviour instead.
    ///
    /// Starting any value on a shared hub starts the one schedule: a second
    /// value is already running and returns `Ok(())` without a second recovery.
    pub async fn start(&mut self) -> Result<(), AstTimerError> {
        if !self.hub.begin() {
            return Ok(());
        }
        if let Err(error) = self.reconcile().await {
            self.hub.abort_start();
            return Err(error);
        }
        Ok(())
    }

    /// Stops delivery and forgets armed deadlines. Pending jobs stay in the
    /// cache, so another instance (or the next `start`) can recover them.
    pub fn stop(&mut self) {
        self.hub.stop();
    }

    /// Arms one job for local delivery, matching `activeScheduler?.arm(id,
    /// dueAt)`. Idempotent per id and ignored while stopped, so repeated
    /// reconcile passes cannot schedule the same job twice. The deadline is
    /// stored in the shared hub rather than a per-job timer; the driver sleeps
    /// until the earliest one and is woken when a nearer deadline is armed. The
    /// entry also records the current reconcile-snapshot epoch, which is what
    /// keeps a rebuild from dropping an arm that was created while its cache
    /// read was in flight.
    pub fn arm(&mut self, id: &str, due_at_ms: i64) {
        if self.hub.arm(id, due_at_ms) {
            self.hub.notify();
        }
    }

    /// Removes and returns the ids whose deadline has passed, in due order.
    pub fn take_due(&mut self, now_ms: i64) -> Vec<String> {
        self.hub.take_due(now_ms)
    }

    /// Enqueues a timer and arms it locally.
    ///
    /// Pruning, the caps, the payload write and both index writes happen inside
    /// the store's single atomic enqueue. Failures are typed: the payload was too
    /// large, a cap was reached, or the cache call failed.
    pub async fn schedule(
        &mut self,
        seconds: f64,
        body: &AstNode,
        context: &Context,
    ) -> Result<AstTimerJob, AstTimerError> {
        let job = enqueue_ast_timer(
            &mut self.store,
            &self.clock,
            &mut self.ids,
            seconds,
            body,
            context,
        )
        .await?;
        self.arm(&job.id, job.due_at);
        Ok(job)
    }

    /// Reads a stored job without consuming it. Diagnostics and recovery only:
    /// delivery must go through [`AstTimerScheduler::fire`], which consumes.
    pub async fn peek(&mut self, id: &str) -> Result<AstTimerJob, AstTimerError> {
        let payload = self
            .store
            .load_payload(id)
            .await?
            .ok_or_else(|| AstTimerError::JobNotFound { id: id.to_owned() })?;
        let job = decode_job(&payload)?;
        if job.expires_at <= self.clock.now_ms() {
            return Err(AstTimerError::Expired { id: id.to_owned() });
        }
        Ok(job)
    }

    /// Rebuilds the shared deadline set from the cache.
    ///
    /// Prunes global index entries older than the grace window, reads the pending
    /// page, drops arms that no longer exist, and arms everything still pending
    /// (including jobs this instance never saw, which is how a restart recovers
    /// queued timers). A newly discovered deadline wakes a driver waiting in
    /// [`AstTimerScheduler::wait`].
    ///
    /// Two timing rules make this safe under a concurrent `schedule`:
    ///
    /// - the snapshot epoch is opened before the first cache read, and a rebuild
    ///   only drops an arm that predates that epoch and is missing from the page.
    ///   A job enqueued *and* armed while the read was in flight therefore keeps
    ///   its arm, so it is still delivered at its own `dueAt` instead of waiting
    ///   for the next pass;
    /// - a failed pass schedules the next attempt one [`RECONCILE_MS`] after the
    ///   failure and leaves every arm untouched. The source retried on its 2-second
    ///   interval; leaving `reconcile_at_ms` overdue would make the following
    ///   claims, wakes and waits all retry immediately.
    pub async fn reconcile(&mut self) -> Result<(), AstTimerError> {
        if self.hub.is_stopped() {
            return Ok(());
        }
        let now = self.clock.now_ms();
        // Opened before the first cache read: anything armed after this point is
        // newer than the snapshot this pass gets back.
        let snapshot_epoch = self.hub.begin_snapshot();
        match self.reconcile_snapshot(now, snapshot_epoch).await {
            Ok(()) => Ok(()),
            Err(error) => {
                self.hub.schedule_reconcile(self.clock.now_ms().saturating_add(RECONCILE_MS));
                Err(error)
            }
        }
    }

    /// One snapshot pass; the caller owns the retry cadence and the error report.
    async fn reconcile_snapshot(
        &mut self,
        now_ms: i64,
        snapshot_epoch: u64,
    ) -> Result<(), AstTimerError> {
        self.store
            .prune_pending(now_ms.saturating_sub(TIMER_GRACE_MS))
            .await?;
        let pending = self.store.pending(MAX_PENDING_TIMERS).await?;
        // Both cache reads are finished before the shared set is touched: no
        // guard is held across an `await`, so an `arm` from the scheduling side
        // is never blocked behind cache I/O. The cadence is measured after the
        // reads so a slow cache cannot make the next pass immediately overdue.
        let next_reconcile_ms = self.clock.now_ms().saturating_add(RECONCILE_MS);
        if self.hub.rebuild(&pending, snapshot_epoch, next_reconcile_ms) {
            self.hub.notify();
        }
        Ok(())
    }

    /// Claims one armed job and returns what happened.
    ///
    /// The order is the source's: read the payload to learn its channel index,
    /// consume it with the claim script (which also decides due/expired
    /// atomically), decode, then hand it to the caller. The id is disarmed on
    /// every path, including errors, so a failing job cannot spin.
    ///
    /// At most once: the claim consumes the job *before* execution, so
    /// overlapping instances cannot both run it. A crash after the claim can lose
    /// this action; the runtime never blindly retries an external side effect
    /// whose outcome cannot be determined.
    pub async fn fire(&mut self, id: &str, now_ms: i64) -> Result<ClaimOutcome, AstTimerError> {
        self.hub.disarm(id);
        if self.hub.is_stopped() {
            return Ok(ClaimOutcome::Stopped);
        }
        let Some(payload) = self.store.load_payload(id).await? else {
            self.store.drop_pending(id).await?;
            return Ok(ClaimOutcome::Missing);
        };
        let probe = decode_probe(&payload)?;
        if probe.due_at_ms > now_ms {
            return Ok(ClaimOutcome::NotYetDue);
        }
        let Some(raw) = self.store.claim(id, &probe.channel_id, now_ms).await? else {
            return Ok(if probe.expires_at_ms <= now_ms {
                ClaimOutcome::Expired
            } else {
                ClaimOutcome::Missing
            });
        };
        let job = decode_job(&raw)?;
        if job.version != AST_TIMER_JOB_VERSION {
            return Err(AstTimerError::UnsupportedVersion {
                version: job.version,
            });
        }
        if job.expires_at <= now_ms {
            return Ok(ClaimOutcome::Expired);
        }
        Ok(ClaimOutcome::Claimed(Box::new(job)))
    }

    /// Claims every due job and reports the next wake instant.
    ///
    /// This is the split the owner must use when it wraps the scheduler in its
    /// own lock: due jobs are claimed first and returned *after* every shared
    /// schedule critical section has ended, so the caller can release its
    /// scheduler guard and only then execute them. Executing a timer body can
    /// schedule a nested timer (`HostRequest::ScheduleTimer`) through the
    /// catalog, which takes the catalog's scheduler lock; keeping a driver lock
    /// held across execution would deadlock the single-threaded runtime.
    ///
    /// `Ok(None)` means the shared scheduler is stopped and this pass owns
    /// nothing to deliver. A stop that arrives *after* jobs were claimed still
    /// returns those jobs (with `now` as the wake): the claim already consumed
    /// them, so dropping them would turn at-most-once into zero-times. The next
    /// pass then observes the stop and ends the loop.
    ///
    /// Reconcile and per-job failures are logged here and never stop the loop,
    /// matching the source's `console.error` behaviour. A job that failed to
    /// claim is not retried — the claim may already have consumed it — and a
    /// failed reconcile has already scheduled its own retry one cadence out, so
    /// the returned `wake_ms` is due armed work (if any) or that retry instant,
    /// never an immediate re-reconcile.
    pub async fn claim_due(&mut self) -> Result<Option<(Vec<AstTimerJob>, i64)>, AstTimerError> {
        if self.hub.is_stopped() {
            return Ok(None);
        }
        let now = self.clock.now_ms();
        let mut jobs = Vec::new();
        for id in self.take_due(now) {
            match self.fire(&id, now).await {
                Ok(ClaimOutcome::Claimed(job)) => jobs.push(*job),
                Ok(_) => {}
                Err(error) => {
                    eprintln!("AST timer execution failed (timer {id}): {error}");
                }
            }
        }
        let now = self.clock.now_ms();
        if now >= self.hub.reconcile_deadline_ms() {
            if let Err(error) = self.reconcile().await {
                // The source logged and retried at the same cadence; the retry
                // instant is stored by `reconcile` itself, so nothing is retried
                // in a tight loop and no artificial delay is added to due work.
                eprintln!("AST timer recovery failed; will retry: {error}");
            }
        }
        if self.hub.is_stopped() {
            // A stop that arrives after these jobs were claimed must not turn
            // an at-most-once delivery into a zero-times loss: the claim already
            // consumed them. Hand them to the caller and report `now` as the
            // wake, so the next pass observes the stop and ends the loop.
            if jobs.is_empty() {
                return Ok(None);
            }
            return Ok(Some((jobs, self.clock.now_ms())));
        }
        let wake_ms = self.next_wake_ms(self.clock.now_ms());
        Ok(Some((jobs, wake_ms)))
    }

    /// One scheduling pass: [`AstTimerScheduler::claim_due`] in the shape its
    /// callers already use.
    pub async fn step(&mut self) -> Result<Option<StepOutcome>, AstTimerError> {
        Ok(self
            .claim_due()
            .await?
            .map(|(jobs, wake_ms)| StepOutcome { jobs, wake_ms }))
    }

    /// Sleeps until the next real deadline, a new local arm, or `wake_ms`,
    /// whichever comes first, and returns the instant it woke.
    ///
    /// This is the owner's sleep primitive: it replaces a plain
    /// `sleep(next_wake_ms)` so arming a nearer deadline from the scheduling
    /// side wakes the driver immediately instead of waiting for the previous
    /// wake (the source's `setTimeout` was equally immediate). Ready work never
    /// sleeps: a deadline at or before `now` returns at once. It also honours
    /// the hub's reconcile cadence directly, so a caller holding an older
    /// `wake_ms` cannot sleep past a due reconciliation. The future is dropped
    /// with the caller's loop, matching `unref`.
    pub async fn wait(&mut self, wake_ms: i64) -> i64 {
        loop {
            if self.hub.is_stopped() {
                return self.clock.now_ms();
            }
            let now = self.clock.now_ms();
            let mut target = self
                .hub
                .next_deadline_ms()
                .map_or(wake_ms, |due| due.min(wake_ms));
            let cadence = self.hub.reconcile_deadline_ms();
            if cadence > 0 {
                target = target.min(cadence);
            }
            let target = target.max(now);
            if target <= now {
                return now;
            }
            let remaining = u64::try_from(target.saturating_sub(now)).unwrap_or(u64::MAX);
            let wake = self.hub.wait_for_wake();
            tokio::select! {
                _ = wake => {}
                _ = tokio::time::sleep(Duration::from_millis(remaining)) => {
                    return target.max(self.clock.now_ms());
                }
            }
        }
    }
}

/// Enqueues one timer job and returns it.
///
/// This is the parser-consumer entry point: "Other parser consumers only enqueue
/// cache jobs." It performs no local arming, so a process that is not the bot can
/// hand work to the bot through the cache. [`AstTimerScheduler::schedule`] is the
/// in-bot variant that arms as well.
///
/// The due instant is `now + round(seconds * 1000)` and the expiry is
/// `dueAt + TIMER_GRACE_MS`. `seconds` must be finite; the 1..=604800 range,
/// nesting depth and Twitch-channel guards belong to the `timer` function, which
/// rejects before calling this. Non-finite input has no meaningful instant (the
/// source's `JSON.stringify` would write `null` and the script would fail), so it
/// is rejected here as a typed error.
///
/// The payload is built with the JavaScript value serializer, so the stored
/// context text is the same JSON `JSON.stringify` produced, and the 64 KiB bound
/// is measured in UTF-8 bytes like `Buffer.byteLength`.
pub async fn enqueue_ast_timer<S, C, I>(
    store: &mut S,
    clock: &C,
    ids: &mut I,
    seconds: f64,
    body: &AstNode,
    context: &Context,
) -> Result<AstTimerJob, AstTimerError>
where
    S: AstTimerStore + ?Sized,
    C: AstTimerClock + ?Sized,
    I: AstTimerIdSource + ?Sized,
{
    if !seconds.is_finite() {
        return Err(AstTimerError::InvalidDuration { seconds });
    }
    let now = clock.now_ms();
    let due_at = now.saturating_add(round_millis(seconds));
    let expires_at = due_at.saturating_add(TIMER_GRACE_MS);
    let snapshot = snapshot_timer_context(context);
    let channel_id = context.borrow().broadcaster_id.clone();
    let job = AstTimerJob {
        version: AST_TIMER_JOB_VERSION,
        id: ids.next_id(),
        due_at,
        expires_at,
        body: body.clone(),
        context: snapshot,
    };
    let payload = encode_job(&job)?;
    let bytes = payload.len();
    if bytes > MAX_JOB_BYTES {
        return Err(AstTimerError::PayloadTooLarge { bytes });
    }
    let accepted = store
        .enqueue(&TimerEnqueue {
            id: &job.id,
            channel_id: &channel_id,
            payload: &payload,
            due_at_ms: due_at,
            expires_at_ms: expires_at,
            now_ms: now,
        })
        .await?;
    if !accepted {
        return Err(AstTimerError::PendingLimitReached { channel_id });
    }
    Ok(job)
}

/// JavaScript `Math.round` for the milliseconds part: `floor(x + 0.5)`.
///
/// Rust's `f64::round` rounds halves away from zero, which differs for negative
/// half values only. Saturation on overflow is the caller's (`saturating_add`).
fn round_millis(seconds: f64) -> i64 {
    (seconds * 1000.0 + 0.5).floor() as i64
}

#[derive(Serialize)]
struct JobEnvelope<'a> {
    version: i64,
    id: &'a str,
    #[serde(rename = "dueAt")]
    due_at: i64,
    #[serde(rename = "expiresAt")]
    expires_at: i64,
    body: &'a AstNode,
    context: &'a RawValue,
}

/// Serializes the job as `{"version":1,"id":…,"dueAt":…,"expiresAt":…,
/// "body":…,"context":…}` — the source's field order, with the context text
/// spliced in verbatim so the snapshot is stored exactly as the JavaScript
/// serializer produced it.
fn encode_job(job: &AstTimerJob) -> Result<String, AstTimerError> {
    let context = json_stringify(&job.context)
        .map_err(|error| AstTimerError::ContextEncoding {
            message: error.to_string(),
        })?
        .ok_or_else(|| AstTimerError::ContextEncoding {
            message: "timer context serialized to undefined".to_owned(),
        })?;
    let context = context
        .to_utf8()
        .map_err(|error| AstTimerError::ContextEncoding {
            message: error.to_string(),
        })?;
    let context = RawValue::from_string(context).map_err(AstTimerError::JobEncoding)?;
    serde_json::to_string(&JobEnvelope {
        version: job.version,
        id: &job.id,
        due_at: job.due_at,
        expires_at: job.expires_at,
        body: &job.body,
        context: &*context,
    })
    .map_err(AstTimerError::JobEncoding)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct JobWire {
    version: i64,
    id: String,
    due_at: i64,
    expires_at: i64,
    body: AstNode,
    context: Box<RawValue>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct JobProbeWire {
    due_at: i64,
    expires_at: i64,
    context: Box<RawValue>,
}

#[derive(Deserialize)]
struct ContextWire {
    #[serde(rename = "broadcasterId")]
    broadcaster_id: String,
}

/// Pre-claim read: only the immutable envelope fields the claim needs.
struct JobProbe {
    due_at_ms: i64,
    expires_at_ms: i64,
    channel_id: String,
}

fn decode_probe(payload: &str) -> Result<JobProbe, AstTimerError> {
    let wire: JobProbeWire =
        serde_json::from_str(payload).map_err(|error| AstTimerError::JobDecoding {
            message: error.to_string(),
        })?;
    let context: ContextWire =
        serde_json::from_str(wire.context.get()).map_err(|error| AstTimerError::JobDecoding {
            message: format!("timer context has no broadcasterId: {error}"),
        })?;
    Ok(JobProbe {
        due_at_ms: wire.due_at,
        expires_at_ms: wire.expires_at,
        channel_id: context.broadcaster_id,
    })
}

fn decode_job(payload: &str) -> Result<AstTimerJob, AstTimerError> {
    let wire: JobWire =
        serde_json::from_str(payload).map_err(|error| AstTimerError::JobDecoding {
            message: error.to_string(),
        })?;
    let context = json_parse(&JsString::from(wire.context.get())).map_err(|error| {
        AstTimerError::JobDecoding {
            message: error.to_string(),
        }
    })?;
    Ok(AstTimerJob {
        version: wire.version,
        id: wire.id,
        due_at: wire.due_at,
        expires_at: wire.expires_at,
        body: wire.body,
        context,
    })
}

/// Rebuilds the execution context a fired job resumes with.
///
/// This is the inverse of [`snapshot_timer_context`] and the first step of
/// `executeAstTimerJob`: a job carries data only, so the callbacks and the
/// context object are rebuilt here, bound to the job's broadcaster.
///
/// Restored, because the snapshot carries them:
///
/// - `broadcaster_id`, `user_id`, `user_login`, `user_plan`, `platform`,
///   `scope_type`, `scope_name`, `command_name`, `command_id` (strings);
/// - `user_display_name` and `argument` (the snapshot stores their *effective*
///   value, so a non-string value is kept as the field's raw override instead
///   of being coerced);
/// - `user_level`, `count`, `timer_depth`, `command_ref_depth` (numbers) and
///   `enforce_function_permissions` (boolean);
/// - `authorization`, `event_data`, `eventsub_data`, `extra_context`
///   (JavaScript values);
/// - `scope_aliases` and `command_responses` (the snapshot stores the same
///   shared array handles, so they stay shared);
/// - `variables`, `arrays` and `loop_vars` (rebuilt into fresh maps, as the
///   source's `new Map(saved.variables)` does);
/// - `visited_commands` (rebuilt into a fresh list with duplicates removed, as
///   the source's `new Set(saved.visitedCommands)` does);
/// - `command_ref_budget` (a fresh budget cell carrying the saved `remaining`).
///
/// This function restores only snapshot data. The application executor then
/// supplies the source's `createSpecialExecutionContext` base for every key the
/// JSON payload dropped and the directory-derived `streamer`/`userPlan`
/// fallback via `restore_timer_application_context`; it also binds the variable
/// host scope. The snapshot itself does not carry streamer or live effect
/// authority.
///
/// The effect authority is **not** restored. The snapshot has no
/// `effectContext`, and the source states the rule directly: "Timers never
/// carry live event-effect authority, including their duration expression". A
/// resumed context therefore has `effect_context: None`, and a command
/// reference executed from a timer can never inherit a live token.
///
/// `timer_depth` is the value the snapshot already incremented by one
/// ([`snapshot_timer_context`] does that), so resuming the same snapshot twice
/// yields the same depth.
///
/// Only a missing or non-string `broadcasterId` is fatal
/// ([`AstTimerError::JobDecoding`]): the broadcaster is the delivery channel
/// and the variable scope, so a job without one cannot be executed.
pub fn resume_timer_context(snapshot: &JsValue) -> Result<Context, AstTimerError> {
    let mut execution = ExecutionContext::default();

    let broadcaster_id = snapshot_text(snapshot, "broadcasterId")?.ok_or_else(|| {
        AstTimerError::JobDecoding {
            message: "timer context has no broadcasterId".to_owned(),
        }
    })?;
    if broadcaster_id.is_empty() {
        return Err(AstTimerError::JobDecoding {
            message: "timer context has an empty broadcasterId".to_owned(),
        });
    }
    execution.broadcaster_id = broadcaster_id;

    if let Some(value) = snapshot_text(snapshot, "userId")? {
        execution.user_id = value;
    }
    if let Some(value) = snapshot_text(snapshot, "userLogin")? {
        execution.user_login = value;
    }
    if let Some(value) = snapshot_text(snapshot, "userPlan")? {
        execution.user_plan = value;
    }
    if let Some(value) = snapshot_text(snapshot, "platform")? {
        execution.platform = value;
    }
    if let Some(value) = snapshot_text(snapshot, "scopeType")? {
        execution.scope_type = value;
    }
    if let Some(value) = snapshot_text(snapshot, "scopeName")? {
        execution.scope_name = value;
    }
    if let Some(value) = snapshot_text(snapshot, "commandName")? {
        execution.command_name = value;
    }
    if let Some(value) = snapshot_text(snapshot, "commandId")? {
        execution.command_id = value;
    }

    restore_display_name(snapshot, &mut execution);
    restore_argument(snapshot, &mut execution);

    if let Some(value) = snapshot_number(snapshot, "userLevel") {
        execution.user_level = value;
    }
    if let Some(value) = snapshot_number(snapshot, "count") {
        execution.count = value;
    }
    if let Some(value) = snapshot_number(snapshot, "timerDepth") {
        execution.timer_depth = Some(value);
    }
    if let Some(value) = snapshot_number(snapshot, "commandRefDepth") {
        execution.command_ref_depth = Some(value);
    }
    if let Some(value) = snapshot_boolean(snapshot, "enforceFunctionPermissions") {
        execution.enforce_function_permissions = value;
    }

    execution.authorization = snapshot.get("authorization");
    execution.event_data = snapshot.get("eventData");
    execution.eventsub_data = snapshot.get("eventsubData");
    execution.extra_context = snapshot.get("extraContext");

    if let JsValue::Array(aliases) = snapshot.get("scopeAliases") {
        execution.scope_aliases = aliases;
    }
    if let JsValue::Array(responses) = snapshot.get("commandResponses") {
        execution.command_responses = responses;
    }

    let budget = snapshot.get("commandRefBudget");
    if let Some(remaining) = snapshot_number(&budget, "remaining") {
        execution.command_ref_budget = Rc::new(RefCell::new(CommandRefBudget { remaining }));
    }

    restore_entries(snapshot, "variables", &execution.variables)?;
    restore_entries(snapshot, "arrays", &execution.arrays)?;
    restore_loop_vars(snapshot, &mut execution)?;
    restore_visited_commands(snapshot, &mut execution)?;

    // `effect_context` is deliberately left at `None`: no authority crosses the
    // cache boundary, so none is restored.
    Ok(execution.into_context())
}

/// A string field, when the snapshot stores one. Absent or non-string values
/// are reported as `None` and leave the caller's default in place; the snapshot
/// only ever stores strings for these keys, so this only affects a foreign or
/// truncated payload.
fn snapshot_text(snapshot: &JsValue, key: &str) -> Result<Option<String>, AstTimerError> {
    match snapshot.get(key) {
        JsValue::String(text) => text.to_utf8().map(Some).map_err(|error| {
            AstTimerError::JobDecoding {
                message: format!("timer context field {key} is not valid UTF-8: {error}"),
            }
        }),
        _ => Ok(None),
    }
}

fn snapshot_number(snapshot: &JsValue, key: &str) -> Option<f64> {
    match snapshot.get(key) {
        JsValue::Number(value) => Some(value),
        _ => None,
    }
}

fn snapshot_boolean(snapshot: &JsValue, key: &str) -> Option<bool> {
    match snapshot.get(key) {
        JsValue::Boolean(value) => Some(value),
        _ => None,
    }
}

/// `userDisplayName` is stored as its effective value: keep a string in the
/// typed field, and keep any other value as the raw override so the effective
/// value stays identical.
fn restore_display_name(snapshot: &JsValue, execution: &mut ExecutionContext) {
    match snapshot.get("userDisplayName") {
        JsValue::String(text) => match text.to_utf8() {
            Ok(text) => execution.user_display_name = text,
            Err(_) => execution.user_display_name_override = Some(JsValue::String(text)),
        },
        JsValue::Undefined => {}
        other => execution.user_display_name_override = Some(other),
    }
}

/// `argument` follows the same effective-value rule as `userDisplayName`.
fn restore_argument(snapshot: &JsValue, execution: &mut ExecutionContext) {
    match snapshot.get("argument") {
        JsValue::String(text) => match text.to_utf8() {
            Ok(text) => execution.argument = Some(JsString::from(text)),
            Err(_) => execution.argument_override = Some(JsValue::String(text)),
        },
        JsValue::Undefined => {}
        other => execution.argument_override = Some(other),
    }
}

/// Rebuilds a `Map`-shaped snapshot entry (`[["name", value], …]`) into a fresh
/// ordered map, matching the source's `new Map(saved.variables)`.
fn restore_entries(
    snapshot: &JsValue,
    key: &str,
    target: &SharedMap<JsValue>,
) -> Result<(), AstTimerError> {
    let JsValue::Array(pairs) = snapshot.get(key) else {
        return Ok(());
    };
    let mut map = target.borrow_mut();
    for pair in pairs.borrow().iter() {
        let JsValue::Array(entry) = pair else {
            continue;
        };
        let entry = entry.borrow();
        let (Some(JsValue::String(name)), Some(value)) = (entry.first(), entry.get(1)) else {
            continue;
        };
        let name = name.to_utf8().map_err(|error| AstTimerError::JobDecoding {
            message: format!("timer context {key} entry is not valid UTF-8: {error}"),
        })?;
        map.insert(name, value.clone());
    }
    Ok(())
}

fn restore_loop_vars(
    snapshot: &JsValue,
    execution: &mut ExecutionContext,
) -> Result<(), AstTimerError> {
    let JsValue::Array(pairs) = snapshot.get("loopVars") else {
        return Ok(());
    };
    let loop_vars = LoopVars::default();
    for pair in pairs.borrow().iter() {
        let JsValue::Array(entry) = pair else {
            continue;
        };
        let entry = entry.borrow();
        let (Some(JsValue::String(name)), Some(JsValue::String(value))) =
            (entry.first(), entry.get(1))
        else {
            continue;
        };
        let name = name.to_utf8().map_err(|error| AstTimerError::JobDecoding {
            message: format!("timer context loopVars entry is not valid UTF-8: {error}"),
        })?;
        loop_vars.insert(name, value.clone());
    }
    execution.loop_vars = Some(loop_vars);
    Ok(())
}

/// The source rebuilds the visited set with `new Set(saved.visitedCommands)`, so
/// duplicates collapse while the first-seen order is kept.
fn restore_visited_commands(
    snapshot: &JsValue,
    execution: &mut ExecutionContext,
) -> Result<(), AstTimerError> {
    let JsValue::Array(visited) = snapshot.get("visitedCommands") else {
        return Ok(());
    };
    let mut commands: Vec<String> = Vec::with_capacity(visited.borrow().len());
    for entry in visited.borrow().iter() {
        let JsValue::String(text) = entry else {
            continue;
        };
        let text = text.to_utf8().map_err(|error| AstTimerError::JobDecoding {
            message: format!("timer context visitedCommands entry is not valid UTF-8: {error}"),
        })?;
        if !commands.contains(&text) {
            commands.push(text);
        }
    }
    execution.visited_commands = Some(Rc::new(RefCell::new(commands)));
    Ok(())
}
