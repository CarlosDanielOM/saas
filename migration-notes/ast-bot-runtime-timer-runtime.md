# AST bot runtime — native timer runtime (Lane B2)

Status: **authored, not compiled.** Nothing was executed for this lane: no
`cargo`, `cargo fmt`, `rustfmt`, `clippy`, `node`/`npm`, test runner, benchmark,
Docker, network/provider call, install command or git operation. The two files
below are static source only, and verification is pending an integration
execution lease for feature `ast-bot-runtime`.

Team `team3-bot-ast` splits the runtime tree across lanes that edit different
files in one checkout. This lane owns exactly two new files and touches nothing
else:

| File | Role |
|------|------|
| `dimabot/src/utils/ast_timer_runtime.rs` | native counterpart of `dimabot/src/utils/ast_timer_runtime.ts` |
| `dimabot/tests/ast_timer_runtime.rs` | auto-discovered integration test, first line `#![cfg(feature = "ast-bot-runtime")]` |

`dimabot/Cargo.toml`, `dimabot/src/utils/mod.rs`, `dimabot/src/lib.rs`, the
`ast_runtime` tree, the evaluator, `timer.ts` and `redis.rs` were **not** edited.

## What this lane implements

The Dragonfly-backed timer job store plus its scheduler, ported from
`dimabot/src/utils/ast_timer_runtime.ts` (180 lines) and the constants and
snapshot rule from `dimabot/src/utils/ast_parser/timer.ts` (56 lines).

Ported surface:

- **Keys** (unchanged): `ast:timers:pending`, `ast:timers:job:<id>`,
  `ast:timers:channel:<channelId>`.
- **Caps**: `MAX_CHANNEL_TIMERS = 100`, `MAX_PENDING_TIMERS = 10000`,
  `MAX_JOB_BYTES = 64 * 1024`, `RECONCILE_MS = 2000`.
- **Grace**: `TIMER_GRACE_MS = 10 * 60 * 1000`, so `expiresAt = dueAt + grace`.
- **Enqueue**: prune stale scores, then reject at either cap, then write the
  payload and both index entries, then set the channel index TTL to its highest
  score. Rejections are `Pending timer limit reached` / `Timer context exceeds
  64 KiB`, with the source's message text retained in `Display`.
- **Job shape**: `version: 1`, `id`, `dueAt`, `expiresAt`, `body` (the
  unevaluated AST), `context` (the snapshot).
- **Claim**: consume the payload and both index entries, then report the outcome;
  a job past `expiresAt` is consumed and dropped.
- **Scheduler**: `arm(id, dueAt)` for local delivery, the 2000 ms reconcile
  pass, the "drop local arms that no longer exist" rule, and one page of at most
  `MAX_PENDING_TIMERS` pending entries.
- **Snapshot**: reuses `ast_evaluator::snapshot_timer_context`. No second
  snapshotter exists in this file, and the effect token never enters the payload.

Not in this lane (owned elsewhere): the `timer` function (`$(timer …)` guards,
`MAX_TIMER_SECONDS`, `MAX_TIMER_DEPTH`, the duration evaluation with
`effectContext: undefined`), `executeAstTimerJob` (special execution context,
`evaluate`, `deliverAstMessage`), and the bot wiring that starts the scheduler.

## Public API

```rust
// Constants
pub const AST_TIMER_INDEX: &str;               // "ast:timers:pending"
pub const AST_TIMER_JOB_PREFIX: &str;          // "ast:timers:job:"
pub const AST_TIMER_CHANNEL_PREFIX: &str;      // "ast:timers:channel:"
pub const MAX_CHANNEL_TIMERS: usize;           // 100
pub const MAX_PENDING_TIMERS: usize;           // 10_000
pub const MAX_JOB_BYTES: usize;                // 64 * 1024
pub const RECONCILE_MS: i64;                   // 2_000
pub const TIMER_GRACE_MS: i64;                 // 600_000
pub const AST_TIMER_JOB_VERSION: i64;          // 1
pub const ENQUEUE_TIMER_JOB_SCRIPT: &str;      // verbatim source Lua
pub const CLAIM_TIMER_JOB_SCRIPT: &str;        // verbatim source Lua

// Errors, claim and pass outcomes
pub enum AstTimerError {
    PayloadTooLarge { bytes: usize },
    PendingLimitReached { channel_id: String },
    JobNotFound { id: String },
    Expired { id: String },
    UnsupportedVersion { version: i64 },
    InvalidDuration { seconds: f64 },
    ContextEncoding { message: String },
    JobEncoding(serde_json::Error),
    JobDecoding { message: String },
    InvalidScore { value: String },
    Redis(redis::RedisError),
}
impl std::fmt::Display for AstTimerError;
impl std::error::Error for AstTimerError;      // source(): JobEncoding, Redis
impl From<redis::RedisError> for AstTimerError;

pub struct AstTimerJob {
    pub version: i64, pub id: String, pub due_at: i64, pub expires_at: i64,
    pub body: AstNode, pub context: JsValue,
}
impl AstTimerJob { pub fn channel_id(&self) -> Result<String, AstTimerError>; }

pub enum ClaimOutcome {
    Claimed(Box<AstTimerJob>), NotYetDue, Expired, Missing, Stopped,
}
pub struct StepOutcome { pub jobs: Vec<AstTimerJob>, pub wake_ms: i64 }

// Key layout (native client has no collection namespace; this is the seam)
pub struct TimerNamespace { pub job_prefix: String, pub index: String, pub channel_prefix: String }
impl TimerNamespace {
    pub fn source() -> Self;
    pub fn with_prefix(prefix: &str) -> Self;   // opt-in isolation only
    pub fn job_key(&self, id: &str) -> String;
    pub fn channel_key(&self, channel_id: &str) -> String;
}
impl Default for TimerNamespace;                // == source()

// Storage seam (only serialized data crosses it, so no `Send` anywhere)
pub struct TimerEnqueue<'a> {
    pub id: &'a str, pub channel_id: &'a str, pub payload: &'a str,
    pub due_at_ms: i64, pub expires_at_ms: i64, pub now_ms: i64,
}
pub struct PendingTimer { pub id: String, pub due_at_ms: i64 }

#[allow(async_fn_in_trait)]
pub trait AstTimerStore {
    async fn enqueue(&mut self, request: &TimerEnqueue<'_>) -> Result<bool, AstTimerError>;
    async fn load_payload(&mut self, id: &str) -> Result<Option<String>, AstTimerError>;
    async fn claim(&mut self, id: &str, channel_id: &str, now_ms: i64)
        -> Result<Option<String>, AstTimerError>;
    async fn prune_pending(&mut self, max_score_ms: i64) -> Result<usize, AstTimerError>;
    async fn pending(&mut self, limit: usize) -> Result<Vec<PendingTimer>, AstTimerError>;
    async fn drop_pending(&mut self, id: &str) -> Result<bool, AstTimerError>;
}

// Production adapter: injected connection, no I/O at construction
pub struct DragonflyTimerStore;
impl DragonflyTimerStore {
    pub fn new(connection: ConnectionManager) -> Self;
    pub fn with_namespace(connection: ConnectionManager, namespace: TimerNamespace) -> Self;
    pub async fn connect() -> Result<Self, AstTimerError>;   // explicit I/O entry
    pub fn connection(&self) -> &ConnectionManager;
    pub fn namespace(&self) -> &TimerNamespace;
}
impl AstTimerStore for DragonflyTimerStore;

// Clock and ids (injected)
#[allow(async_fn_in_trait)]
pub trait AstTimerClock {
    fn now_ms(&self) -> i64;
    async fn sleep_until(&mut self, at_ms: i64);   // default: Tokio timer
}
pub struct SystemClock;
pub trait AstTimerIdSource { fn next_id(&mut self) -> String; }
pub struct DigestTimerIdSource;
impl DigestTimerIdSource { pub fn new() -> Self; }
impl AstTimerIdSource for DigestTimerIdSource;

// Scheduler
pub struct AstTimerScheduler<S, C, I>;
impl<S: AstTimerStore, C: AstTimerClock, I: AstTimerIdSource> AstTimerScheduler<S, C, I> {
    pub fn new(store: S, clock: C, ids: I) -> Self;      // no I/O
    pub fn store(&self) -> &S;
    pub fn store_mut(&mut self) -> &mut S;
    pub fn clock(&self) -> &C;
    pub fn ids_mut(&mut self) -> &mut I;
    pub fn into_parts(self) -> (S, C, I);
    pub fn is_stopped(&self) -> bool;
    pub fn armed_len(&self) -> usize;
    pub fn is_armed(&self, id: &str) -> bool;
    pub fn next_deadline_ms(&self) -> Option<i64>;
    pub fn next_wake_ms(&self, now_ms: i64) -> i64;
    pub async fn start(&mut self) -> Result<(), AstTimerError>;
    pub fn stop(&mut self);
    pub fn arm(&mut self, id: &str, due_at_ms: i64);
    pub fn take_due(&mut self, now_ms: i64) -> Vec<String>;
    pub async fn schedule(&mut self, seconds: f64, body: &AstNode, context: &Context)
        -> Result<AstTimerJob, AstTimerError>;
    pub async fn peek(&mut self, id: &str) -> Result<AstTimerJob, AstTimerError>;
    pub async fn reconcile(&mut self) -> Result<(), AstTimerError>;
    pub async fn fire(&mut self, id: &str, now_ms: i64) -> Result<ClaimOutcome, AstTimerError>;
    pub async fn step(&mut self) -> Result<Option<StepOutcome>, AstTimerError>;
}

// Parser-consumer entry point ("other parser consumers only enqueue")
pub async fn enqueue_ast_timer<S, C, I>(
    store: &mut S, clock: &C, ids: &mut I,
    seconds: f64, body: &AstNode, context: &Context,
) -> Result<AstTimerJob, AstTimerError>
where S: AstTimerStore + ?Sized, C: AstTimerClock + ?Sized, I: AstTimerIdSource + ?Sized;
```

No `Send`/`Sync` bound appears on any type that holds the AST context, the
scheduler or the store seam. The scheduler is driven by its owner:

```text
scheduler.start().await?;
loop {
    match scheduler.step().await? {
        None => break,                                   // stopped
        Some(outcome) => {
            for job in outcome.jobs { execute(job).await?; }   // at most once
            clock.sleep_until(outcome.wake_ms).await;
        }
    }
}
```

`stop()` is only reachable between passes because `step` borrows the scheduler;
a bot that must cancel mid-sleep should drive `step` inside a `tokio::select!`
with its shutdown signal rather than call `run`. That replaces the source's
`activeScheduler.stop()` from the shutdown handler; no guarantee is lost.

## Lua atomicity: how it was reproduced

Both Lua bodies are copied **verbatim** from `ast_timer_runtime.ts` lines 26-34
and 39-48 into `ENQUEUE_TIMER_JOB_SCRIPT` / `CLAIM_TIMER_JOB_SCRIPT` and are
executed with a raw `EVAL` through the native `redis` client
(`redis::cmd("EVAL").arg(script).arg(keys.len()).arg(&keys).arg(&arguments)`),
the same call shape already used by `utils/cron_jobs_queue.rs`. Therefore:

- the prune-before-cap check, the payload write and both index writes are one
  server-side step, exactly as before;
- the claim's "read, compare `dueAt`, delete payload, `ZREM` both indexes, compare
  `expiresAt`" sequence is one server-side step, so two overlapping instances
  cannot both observe a payload;
- `PEXPIREAT` of the channel index still uses the highest score `ZRANGE -1 -1`.

Two honest limitations, both named again under gaps:

1. `EVALSHA`/`Script` caching is not used; `EVAL` sends the body per call. That
   changes bytes on the wire, not semantics, and needs no extra Cargo feature.
2. The Lua was verified by reading only. `scripts_keep_the_source_atomicity_and_ordering`
   guards the load-bearing statements (prune before cap, payload before indexes,
   due-check before delete, expiry check after consume) and the tests run the same
   sequence through an in-memory fake, but no test executes the Lua on a real
   Dragonfly. That requires a disposable Dragonfly fixture under the ops
   workflow and is **not** claimed.

## Wait inventory and pacing decisions

| Source wait | Decision | Reason |
|---|---|---|
| `setInterval(reconcile, 2000)` | kept as `RECONCILE_MS` plus `reconcile_at_ms` / `next_wake_ms` | Recovers jobs written before a restart or by another instance. `step` fires due jobs *before* computing the wake, and `next_wake_ms` is clamped to `now`, so ready work is never delayed to a cadence. |
| `setTimeout(fire, dueAt - now)` per job | replaced by one armed `(id -> dueAt)` map and a single sleep until the earliest deadline | Same delivery instant, one timer, and `arm` is idempotent per id so repeated reconciles cannot double-arm. |
| `interval.unref()` / `timeout.unref()` | no detached task; the sleep belongs to the caller's loop and is dropped with it | An idle bot must not hold a thread or keep the process alive. |
| `console.error('AST timer recovery failed')` + retry | one `eprintln!` line per failed pass, retried at the next cadence; no backoff, no tighter loop | A cache hiccup must not stop scheduling and must not spin. |
| no external retry after a claim | kept, documented on `fire` | A crash after the claim can lose an action; an indeterminate external side effect is never replayed. |
| `arm` ignored while stopped | kept | Prevents arming before `start` / after `stop`. |

No wait was removed and no artificial cadence was added. Evidence that both idle
waiting and progress hold is in `reconcile_recovers_cached_jobs_and_prunes_stale_scores`
(cadence wake with a far-future job, prune of a dead score, recovery of a job this
instance never saw) and `step_delivers_due_jobs_before_sleeping_and_keeps_the_cadence`
(due job returned by the pass, wake instant `dueAt + RECONCILE_MS`, an armed
due-now job wakes immediately, stopped scheduler returns `None`).

## Guarantees preserved

- Identical keys, caps, grace window, job shape and field order.
- Per-channel cap (100) and global cap (10 000) both reject with the source text.
- Stale index scores are pruned before the caps are read, so a bot that was
  offline while payloads expired cannot lock itself out.
- The 64 KiB bound is measured in UTF-8 bytes (`Buffer.byteLength` equivalent)
  and is checked before any write.
- `expiresAt = dueAt + TIMER_GRACE_MS`, and a job is undeliverable at exactly
  `expiresAt`.
- At-most-once: the claim removes the payload and both index entries before the
  job is returned for execution; a second claim finds nothing.
- Only data crosses the cache boundary; the snapshot has no `effectContext`, and
  `timerDepth` is incremented by one exactly as `timer.ts` does.
- No I/O at import or construction, no `static` singleton, connection injected,
  typed failures, no `unwrap()`/`expect()` on recoverable paths.
- **Cross-runtime read compatibility**: the envelope and snapshot shapes are the
  source's, so `decode_job` accepts a payload the still-active TypeScript
  runtime wrote (same keys, same `version`, same `body` AST JSON, same snapshot
  fields). That is what lets the migration claim timers without a data rewrite;
  it is untested here (see gap 2).

## Remaining gaps

1. **Not compiled or tested.** Everything is static source; `cargo check`,
   `cargo test`, `rustfmt --check` and `clippy -D warnings` are pending an
   integration execution lease.
2. **Lua not executed against a real cache.** Atomicity is preserved by keeping
   the source script verbatim and by a structural test, not by a Dragonfly
   fixture. A disposable-Dragonfly check should add: two-claim race (exactly one
   `Some`), cap rejection at 101st channel timer, `expiresAt` drop, and channel
   `TTL` ≥ `expiresAt`.
3. **Backlog caps are enforced by the script, verified only by structure.** No
   test drives a real `ZSET` to 10 000 members; the fake only proves the
   domain mapping from `accepted == false` to `PendingLimitReached`.
4. **Id shape changed.** `randomUUID()` v4 became 32 lowercase hex characters from
   SHA-256 over (construction nanos, pid, per-source counter). Ids are opaque key
   segments and log fields, never parsed, so this is not a contract change; two
   `DigestTimerIdSource`s constructed in the same process in the same nanosecond
   would collide, and the production runtime creates one.
5. **`start()` surfaces its first reconcile failure** instead of logging it like
   the source (which could not fail). The periodic loop keeps log-and-retry.
   A caller that wants the exact old behaviour can call `start()` and ignore the
   error, then keep stepping.
6. **Message execution is not in this lane.** `executeAstTimerJob`
   (`createSpecialExecutionContext`, `evaluate`, `deliverAstMessage`) must be
   built by the execution/delivery lanes over `AstTimerJob`; `step` returns the
   claimed jobs for exactly that. Until then, a claimed job has no delivery path.
7. **The duration expression's `effectContext: undefined` rule** belongs to the
   `timer` function lane; this module only guarantees the snapshot has no effect
   authority.
8. **`TIMER_GRACE_MS` lives in two places during the migration** (here and
   `ast_parser/timer.ts`). The timer-function lane should import
   `ast_timer_runtime::TIMER_GRACE_MS` (or a single shared `timer` module should
   own it) so the two cannot drift. `MAX_TIMER_SECONDS` / `MAX_TIMER_DEPTH` are
   deliberately **not** duplicated here; the function guards them before calling
   `schedule`.
9. **`TimerNamespace::with_prefix`** is an isolation aid. Production must keep
   `TimerNamespace::source()` so the still-active TypeScript producer/consumer
   shares the same keys.
10. **Enqueue without the scheduler loses the immediate arm.** The source had a
    module-global `activeScheduler`, so `scheduleAstTimer` armed local delivery
    instantly from any call site in the bot process. Here a caller that only holds
    the store uses `enqueue_ast_timer` and arms nothing, so delivery waits for the
    next reconcile pass (at most `RECONCILE_MS`). In-bot callers that need the
    exact source instant must use `AstTimerScheduler::schedule`.
11. **Deliberate hardening on input the source mishandled.** Non-finite `seconds`
    becomes `InvalidDuration` (the source would write `dueAt: null` and fail
    inside Lua), and a stored payload whose `context.broadcasterId` is missing or
    not a string becomes `JobDecoding` (the source would build the key
    `ast:timers:channel:undefined` and clear the wrong channel entry). Neither is
    reachable from `schedule`, which always snapshots a string `broadcasterId`.
12. **Deployment and caller adoption are out of scope.** Production still runs
    the TypeScript timer runtime until the integration team registers the module
    and wires a `step` loop into the bot.

## Fixture / proof paths

- Source of truth: `dimabot/src/utils/ast_timer_runtime.ts` (lines 6-12 keys and
  caps, 26-34 enqueue Lua, 39-48 claim Lua, 52-69 schedule, 72-149 scheduler,
  151-173 execution).
- Constants and snapshot rule: `dimabot/src/utils/ast_parser/timer.ts` (lines
  4-6, 8-26).
- Reused native snapshotter: `dimabot/src/utils/ast_parser/evaluator/context.rs`
  (`snapshot_timer_context`, line 310).
- Reused JSON/value layer: `dimabot/src/utils/ast_parser/evaluator/value.rs`
  (`json_stringify` line 801, `json_parse` line 557).
- Reused EVAL call shape: `dimabot/src/utils/cron_jobs_queue.rs` (line 413).
- Reused native client: `dimabot/src/utils/databases/dragonfly.database.rs`
  (`get_redis_client`, line 100).
- Tests: `dimabot/tests/ast_timer_runtime.rs` — 13 tests, in-memory fake only.

## Central patch the integration team must apply (not applied here)

`dimabot/src/utils/mod.rs`, next to the other `ast-*` modules:

```rust
#[cfg(feature = "ast-bot-runtime")]
#[path = "ast_timer_runtime.rs"]
pub mod ast_timer_runtime;
```

`dimabot/Cargo.toml` — no new dependency. The cumulative `ast-bot-runtime`
feature already listed by the other lanes
(`["ast-evaluator", "ast-pure-functions", "ast-blocks", "ast-syntax", …,
"redis", "dep:tokio", "dep:serde", "dep:serde_json", "dep:sha2", "dep:uuid"]`)
already covers everything this lane uses:

- `ast-evaluator` → `Context`, `JsValue`, `JsString`, `snapshot_timer_context`,
  `json_stringify`, `json_parse`
- `ast-syntax` → `AstNode`
- `redis` → `ConnectionManager`, `redis::cmd`, `RedisError`, and
  `get_redis_client`
- `dep:serde` / `dep:serde_json` (with the crate's existing `raw_value` feature)
- `dep:sha2` → `DigestTimerIdSource`
- `dep:tokio` → the default `AstTimerClock::sleep_until`

If the cumulative feature list ever drops `dep:sha2`, either keep it or replace
`DigestTimerIdSource` with a caller-supplied `AstTimerIdSource`.

Nothing else is required: the test target is auto-discovered, so no `[[test]]`
entry is needed.
