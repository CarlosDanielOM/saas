# AST bot runtime — fired-timer execution, shared scheduler and async factory (Lane E)

Status: **authored, not compiled.** Nothing was executed for this lane: no
`cargo`, `cargo fmt`, `rustfmt`, `clippy`, `node`/`npm`/`npx`/`tsc`, test
runner, benchmark, Docker, network/provider call, install command, commit, push
or deployment. There is no execution lease for wave 1, so every statement below
describes static source only. Verification (compile, `rustfmt`, `clippy`, the
in-memory suite and the ignored Dragonfly fixture) is **pending an integration
execution lease** for feature `ast-bot-runtime`.

This revision is a follow-up to a lead static review of the first draft. Two
timing defects were fixed in the same owned files, plus one further race
found while reviewing the claim/stop path:

1. **Reconcile could delete a concurrent arm.** The first draft read the pending
   page and then kept only the ids that page listed. A `$(timer …)` enqueued and
   armed between the read and the rebuild was absent from the page but live
   locally, so the rebuild deleted its arm and delivery slipped to the next
   reconcile pass (up to `RECONCILE_MS` late). Fixed with a reconcile-snapshot
   epoch on every arm; see [Reconcile vs concurrent arm](#reconcile-vs-concurrent-arm).
2. **A failed reconcile left the cadence in the past.** `reconcile_at_ms` was
   only updated on success, so after a cache error every following
   `claim_due`/`next_wake_ms`/`wait` saw an overdue pass, returned `now`, and
   hammered the cache — unlike the source's 2-second `setInterval`. The retry is
   now scheduled one `RECONCILE_MS` after the failure; see
   [Failed reconcile](#failed-reconcile).
3. **A stop arriving after a claim discarded claimed jobs.** `claim_due`
   returned `Ok(None)` for a stop observed after the claim loop, dropping jobs
   whose payload had already been consumed. It now returns those jobs with
   `now` as the wake; see [Stop after claim](#stop-after-claim).

A separate context-adapter follow-up (same owned files) closes two gaps the
earlier draft recorded in [Remaining gaps](#remaining-gaps): the
`createSpecialExecutionContext` **base defaults** for keys a JSON payload
drops, and the source directory's `TwitchStreamers.getTwitchAccountById`
diagnostic. It also replaces the two-case oracle with a set of discriminating
actual-source cases and a native field-for-field comparison; see
[Context adapter: partial snapshots and the directory diagnostic](#context-adapter-partial-snapshots-and-the-directory-diagnostic).
Nothing in that follow-up changes the scheduler, the cache scripts or the
factory assembly.

Team `team3-bot-ast` splits the runtime tree across lanes that edit different
files in one checkout. This lane owns exactly five files:

| File | Role |
|------|------|
| `dimabot/src/utils/ast_timer_runtime.rs` | extended: snapshot → context rebuild **and** the shared `TimerScheduleHub` / driver split |
| `dimabot/src/utils/ast_parser/runtime/bootstrap.rs` | the `executeAstTimerJob` port, the base-context adapter, the concrete async factory, and the shared-hub wiring |
| `dimabot/tests/ast_timer_execution.rs` | integration tests (first line `#![cfg(feature = "ast-bot-runtime")]`) |
| `dimabot/tests/fixtures/ast_timer_context_reference.cjs` | actual-source oracle for the context rebuild (extracts the real TypeScript declarations) |
| `migration-notes/ast-bot-runtime-timer-execution.md` | this record |

`dimabot/Cargo.toml`, `dimabot/src/utils/mod.rs`, `dimabot/src/lib.rs`,
`dimabot/src/utils/ast_parser/runtime.rs`, every other `runtime/*.rs`, the
evaluator, `runtime.rs`'s contract and `src/functions/**` were **not** edited.
The module-registration and feature-gate contract this lane needs from the
integration team is recorded under
[Central patch](#central-patch-the-integration-team-must-apply-not-applied-here).

## TypeScript sources ported

- `dimabot/src/utils/ast_timer_runtime.ts` lines 151-173 — `executeAstTimerJob`.
- `dimabot/src/utils/ast_timer_runtime.ts` lines 175-180 —
  `startAstTimerScheduler`, minus its module-global guard (see below).
- `dimabot/src/utils/ast_timer_runtime.ts` lines 52-69 — the enqueue entry point
  that `BotAstFunctions` already calls, including its `activeScheduler?.arm(...)`
  line, which is the reason the scheduler is now shared (see
  [Shared schedule](#shared-schedule-one-hub-two-values)).
- `dimabot/src/utils/ast_parser/timer.ts` lines 8-25 — `snapshotTimerContext`,
  whose inverse this lane writes, plus `TIMER_GRACE_MS`.
- `dimabot/src/handlers/special_parser.handler.ts` lines 343-410 —
  `createSpecialExecutionContext`, read only, to decide which base fields the
  snapshot does **not** carry and therefore must not be invented.
- `dimabot/src/handlers/special_parser.userlevel.ts` —
  `resolveAuthoredAstUserLevel` and its badge helpers, reused by both the parser
  port and the timer base context.
- `dimabot/src/utils/ast_command_delivery.ts` — `deliverAstMessage`, called
  through the already-ported `runtime::delivery` (not reimplemented).

## What this lane implements

### 1. `resume_timer_context` (in `ast_timer_runtime.rs`)

`pub fn resume_timer_context(snapshot: &JsValue) -> Result<Context, AstTimerError>`

The inverse of `snapshot_timer_context`. It rebuilds an `ExecutionContext` from
the data-only snapshot a claimed job carries, bound to the job's broadcaster.

Restored, because the snapshot carries them:

| Snapshot field | Native field |
|----------------|--------------|
| `broadcasterId`, `userId`, `userLogin`, `userPlan`, `platform`, `scopeType`, `scopeName`, `commandName`, `commandId` | the matching `String` fields |
| `userDisplayName`, `argument` | the typed field when the stored value is a string, otherwise the raw `*_override` field, so the *effective* value is identical |
| `userLevel`, `count`, `timerDepth`, `commandRefDepth` | `f64` / `Option<f64>` |
| `enforceFunctionPermissions` | `bool` |
| `authorization`, `eventData`, `eventsubData`, `extraContext` | cloned `JsValue`s |
| `scopeAliases`, `commandResponses` | the same shared `Rc` handles (the source spreads the same references) |
| `variables`, `arrays` | rebuilt into fresh ordered maps (`new Map(saved.variables)`) |
| `loopVars` | rebuilt into a fresh `LoopVars` |
| `visitedCommands` | rebuilt into a fresh list with duplicates removed (`new Set(saved.visitedCommands)`) |
| `commandRefBudget.remaining` | a fresh budget cell |

Not restored by this function, because the snapshot does not carry them:

- the directory-derived `streamer` and every
  `createSpecialExecutionContext` **base** value for a key the JSON payload
  dropped. `restore_timer_application_context` supplies those (see
  [Context adapter](#context-adapter-partial-snapshots-and-the-directory-diagnostic));
  `resume_timer_context` itself never invents them.
- `command_variables`, `user_command_variables`, `count_modified`, `loop_depth`
  and `loop_exit` retain the base defaults.

The effect authority is deliberately **not** restored. The snapshot has no
`effectContext` key, and `timer.ts` line 42 states the rule: "Timers never carry
live event-effect authority, including their duration expression". The resumed
context therefore has `effect_context: None`, so a command reference executed
from a timer can never inherit a live token (`evaluator/vm.rs` only forks the
effect when `enforce_function_permissions == false`, `authorization.origin ==
"authored"` **and** the context still holds one).

`timerDepth` is not incremented here: `snapshot_timer_context` already wrote
`(timerDepth ?? 0) + 1`, so resuming the same snapshot twice yields the same
depth. Only a missing/empty `broadcasterId` (or an unreadable UTF-8 string) is
fatal, as `AstTimerError::JobDecoding`; the broadcaster is the delivery channel
and the variable scope.

### 2. `execute_ast_timer_job` (in `runtime/bootstrap.rs`)

```rust
pub async fn execute_ast_timer_job(
    engine: &Engine,
    host: &mut ApplicationHost,
    sender: &mut dyn ChatSender,
    runner: &mut dyn CommandRunner,
    logger: Option<&Arc<Logger>>,
    directory: &dyn TimerStreamerDirectory,
    job: &AstTimerJob,
) -> Result<SendResult, AstRuntimeError>
```

The three source steps, in the source's order:

1. `job.channel_id()` + `restore_timer_application_context(&job.context,
   directory, logger)` — the broadcaster bound to the job, the application base
   half of `createSpecialExecutionContext`, effect authority absent.
2. `Engine::evaluate(&job.body, context, host)` — the job already stores the
   parsed `AstNode`, so there is no re-parse and no source text to compile.
3. `deliver_ast_message(&channel_id, &mut message, true, seams)` with
   `parsed_text = nullish_string(result.value)` (`String(value ?? '')`) and
   `command_references = result.context.command_references`. `chatEnabled` is
   the source's default `true`; `executeAstTimerJob` does not override it.

Failures are typed, never panics:

- decode failure → `AstRuntimeError::Host` with the `AstTimerError` message;
- evaluation failure → `from_eval_error(&EvalError)`, so a host failure stays
  `Host` and a program failure stays `Evaluation`;
- a rendered value with an unpaired surrogate → the same evaluation mapping;
- `sent.error` → `AstRuntimeError::Rejected(sent.message)`, exactly the
  source's `throw new Error(sent.message)`.

Delivery is not reimplemented: the drain-once queue, send-before-references,
continue-on-reference-error and failing-recursive-send rules stay in
`runtime::delivery`.

### 3. The concrete async factory (in `runtime/bootstrap.rs`)

```rust
pub struct BotRuntimeParts<S: CommandStore> {
    pub engine: Engine,
    pub cache: Arc<dyn AstCache>,
    pub variables: Arc<dyn AstVariableStore>,
    pub directory: Arc<TwitchStreamers>,
    pub store: S,
    pub twitch: TwitchFunctions,
    pub logger: Option<Arc<Logger>>,
}

pub type ProductionTimerScheduler =
    AstTimerScheduler<DragonflyTimerStore, SystemClock, DigestTimerIdSource>;
pub type ProductionFunctionCatalog =
    BotAstFunctions<DragonflyTimerStore, SystemClock, DigestTimerIdSource>;

pub struct BotTimerRuntime<S: CommandStore> { /* scheduler, catalog, runtime, engine, host, sender, logger */ }

pub async fn build_bot_runtime<S: CommandStore>(
    parts: BotRuntimeParts<S>,
) -> Result<BotTimerRuntime<S>, AstRuntimeError>;

pub async fn build_bot_runtime_with_namespace<S: CommandStore>(
    parts: BotRuntimeParts<S>,
    namespace: TimerNamespace,
) -> Result<BotTimerRuntime<S>, AstRuntimeError>;

pub fn build_bot_runtime_over_store<S: CommandStore>(
    parts: BotRuntimeParts<S>,
    store: DragonflyTimerStore,
) -> BotTimerRuntime<S>;

pub struct TimerTick { pub delivered: usize, pub failed: usize, pub wake_ms: i64 }

impl<S: CommandStore> BotTimerRuntime<S> {
    pub fn scheduler(&self) -> &ProductionTimerScheduler;
    pub fn scheduler_mut(&mut self) -> &mut ProductionTimerScheduler;
    pub fn hub(&self) -> TimerScheduleHub;
    pub fn catalog(&self) -> &Arc<ProductionFunctionCatalog>;
    pub fn runtime(&self) -> &BotRuntime<S>;
    pub fn runtime_mut(&mut self) -> &mut BotRuntime<S>;
    pub fn logger(&self) -> Option<&Arc<Logger>>;
    pub async fn start(&mut self) -> Result<(), AstRuntimeError>;
    pub async fn execute(&mut self, job: &AstTimerJob) -> Result<SendResult, AstRuntimeError>;
    pub async fn tick(&mut self) -> Result<Option<TimerTick>, AstRuntimeError>;
    pub async fn wait(&mut self, wake_ms: i64) -> i64;
}
```

I/O boundary: `build_bot_runtime` is explicitly `async` and its **only** I/O is
`DragonflyTimerStore::connect()` (which reads `DRAGONFLY_HOST`/`DRAGONFLY_PORT`
through `utils::redis::get_redis_client` and verifies with `PING`).
`build_bot_runtime_with_namespace` does the same connect but with a
caller-supplied `TimerNamespace`. `build_bot_runtime_over_store` performs **no**
I/O and no environment read — that is the testable core. `ApplicationHost::new`
and `BotRuntime::new` keep their I/O-free constructors, there is no module
singleton, and no task is spawned.

Assembly: one `TimerScheduleHub` is created, then **two scheduler values are
built over it** (the catalog's and the delivery one). The catalog is built with
`BotAstFunctions::with_twitch_and_logger` (real Twitch chat adapter + Tokio delay
clock + the catalog's scheduler), then `BotRuntime::new(engine, cache,
variables, directory, store, twitch)` + `with_logger` + `with_functions(catalog,
catalog)` — the same `Arc` serves both `Arc<dyn AstFunctionCatalog>` and
`Arc<dyn TimerScheduler>`, so there is exactly one AST function path and one
timer path. A third `ApplicationHost` (the timer host) gets the same catalog and
timer, and is the host a fired job evaluates with.

Threading: nothing is `Send`-bound on the AST context. The evaluator context is
`Rc`-based, the host future is not `Send`, and the runtime must be driven inside
a `tokio::task::LocalSet` (or an equivalent single-threaded task). The catalog
itself is `Send + Sync`, as `AstFunctionCatalog` and `host::TimerScheduler`
require; the scheduler is `Send` when its store, clock and id source are, and
`TimerScheduleHub` is `Send + Sync`.

### Context adapter: partial snapshots and the directory diagnostic

`restore_timer_application_context` now ports both halves of
`{ ...await createSpecialExecutionContext(…), ...saved, … }`. The overlay half
is `resume_timer_context`; the base half applies exactly where the JSON payload
has no key to overlay (the cache stores JSON, so every `undefined` property is
absent). It also carries the values that can never come from a snapshot.

| Field | Base value the source uses | Native follow-up |
|-------|----------------------------|------------------|
| `userId`, `userLogin`, `userDisplayName` | `extractUserInfo` of `{ ...saved.eventData, chatter_user_*: saved.* }`, else `''` | derived from the same merged event; only when the snapshot key is absent |
| `userPlan` | `saved.userPlan \|\| streamer?.plan_tier \|\| 'free'` | live account `plan_tier`, else `'free'`; a present snapshot value still wins |
| `eventData` | the merged event object above | assigned only when the snapshot key is absent |
| `eventsubData` | `(context.eventsubData \|\| {})` | `{}` when the snapshot key is absent |
| `scopeName` | `normalizeScopeName(saved.scopeName \|\| eventsubData.name \|\| eventData.reward.title \|\| '')` | derived name when the key is absent; a present value stays raw (`''` included) |
| `commandName` | the same resolved scope name | derived when the key is absent, including when a present raw `scopeName` is normalized for it |
| `extraContext` | `{ ...extracted, ...saved.extraContext }` | derived extraction object when absent; a present `null`/object replaces it wholesale |
| `authorization`, `userLevel`, `enforceFunctionPermissions` | authored identity for `resolveAuthoredAstUserLevel(eventData, saved.userLevel)`, `false` | same, reusing `runtime::parser::{resolve_authored_user_level, authored_authorization}` |

`scopeType` needs no branch: `createExecutionContext`'s default is already
`'command'`, which is the source's `context.scopeType || 'command'` base when the
key is absent. `count` (0), `argument` (absent), `platform` (`'twitch'`) and
`commandId` (`''`) likewise already match their `createExecutionContext`
defaults.

Lookup failure now matches the source's two effects: `streamer` is `null` and
the diagnostic is emitted. `TimerStreamerDirectory` returns a
`TimerStreamer { id, name, plan_tier }` (the plan tier is what the `userPlan`
fallback needs) and `restore_timer_application_context` takes the factory's
`Option<&Arc<Logger>>` so a failure logs
`{ function: 'TwitchStreamers.getTwitchAccountById', id, error }` at error level
with `Destination::Both`, exactly the source's
`error(..., { destination: 'both' })`, and **no** `channelId` (the source passes
none). This reuses the native logger rather than adding a second logging policy.

The oracle fixture now extracts the *real* `resolveAuthoredAstUserLevel`,
`normalizeScopeName` and `normalizeScopeNames` instead of stubbing them, keeps
only application boundaries stubbed (directory, function registration,
evaluator, delivery), and emits 16 cases. It covers lookup failure, a live
plan-tier fallback, all three scope fallbacks, a raw-vs-normalized scope
precedence, missing identity fallback, saved-identity precedence over the saved
event, missing `eventData`, missing `eventsubData`, a present `null`
`extraContext`, the broadcaster-level-10 default, a moderator badge, saved
authorization/permission overlays, a full real `snapshotTimerContext` round
trip, and a real snapshot whose optional keys JSON drops. The Rust test replays
each case's `saved` object through the native rebuild and compares all 19
captured fields, using `<undefined>` to keep the distinction from an absent
JSON key.

## Shared schedule: one hub, two values

### Defect this round fixes

The first native factory built **two independent scheduler values**:
`BotAstFunctions` owns one (it holds it behind an async mutex and exposes no
accessor) and `BotTimerRuntime` keeps the other for delivery. Each had its own
`armed` map and stopped flag. Consequences:

- `scheduleAstTimer`'s `activeScheduler?.arm(job.id, job.dueAt)` fixed the job
  in the **catalog's** map. The driver only learned about it at its next
  reconcile pass, so a 1-second timer (the shortest legal `$(timer …)`) could be
  delivered up to `RECONCILE_MS` (2 s) after `dueAt`.
- Nothing ever drained the catalog's armed entries. Its map (when it was
  running) retained every scheduled id; the catalog value is never `start`ed in
  production, so `arm` was silently a no-op there and the “immediately armed”
  source semantics were lost entirely.

The TypeScript source had neither problem: `scheduleAstTimer` called
`activeScheduler?.arm(...)` on the very scheduler whose `setTimeout` callbacks
drained `this.timers`.

### Native design

`ast_timer_runtime.rs` now owns `TimerScheduleHub`:

```rust
pub struct TimerScheduleHub { /* Arc<StdMutex<TimerScheduleState>> + Arc<Notify> */ }

struct TimerScheduleState {
    armed: BTreeMap<String, ArmedTimer>,
    stopped: bool,        // source `stopped = true` at construction
    reconcile_at_ms: i64,
    arm_epoch: u64,       // reconcile-snapshot epoch (see below)
}

struct ArmedTimer {
    due_at_ms: i64,
    arm_epoch: u64,       // epoch current when this arm was created
}

impl TimerScheduleHub {
    pub fn new() -> Self;
    pub fn armed_len(&self) -> usize;
    pub fn is_armed(&self, id: &str) -> bool;
    pub fn is_stopped(&self) -> bool;
    pub fn next_deadline_ms(&self) -> Option<i64>;
    pub fn reconcile_deadline_ms(&self) -> i64;
    // private: begin_snapshot / schedule_reconcile / begin / abort_start /
    //          notify / stop / arm / disarm / take_due / rebuild /
    //          wait_for_wake
}
```

`TimerScheduleHub` is `Clone` (another handle on the same set), `Send + Sync`,
and constructed through `TimerScheduleHub::new()`. `AstTimerScheduler` lost its
own `armed`/`stopped`/`reconcile_at_ms` fields and gained `hub`. New
constructors:

```rust
pub fn new(store: S, clock: C, ids: I) -> Self;          // private hub
pub fn with_hub(hub: TimerScheduleHub, store: S, clock: C, ids: I) -> Self;
pub fn hub(&self) -> TimerScheduleHub;                    // cheap clone
```

`new` keeps every existing single-scheduler test and independent runtime
unchanged. `bootstrap.rs` now does:

```rust
let hub = TimerScheduleHub::new();
let catalog_scheduler = AstTimerScheduler::with_hub(
    hub.clone(), store.clone(), SystemClock, DigestTimerIdSource::new());
let delivery_scheduler = AstTimerScheduler::with_hub(
    hub, store, SystemClock, DigestTimerIdSource::new());
```

Both values therefore read and write the same armed set, the same stopped flag
and the same reconcile cadence. Arming through the catalog is visible to the
driver immediately: `BotTimerRuntime::tick`'s `wake_ms` is the new `dueAt`, not
the reconcile cadence, and a driver sleeping in the new `wait` primitive is
woken for the nearer deadline. The catalog's arm is no longer a leaked map
entry: the driver's `take_due`/`fire` drains the shared set.

The source's `arm` guard is preserved: `hub.arm` refuses while stopped and is
idempotent per id (`if (this.stopped || this.timers.has(id)) return`). A timer
scheduled before `start` (or after `stop`) is still written to the cache but not
armed, exactly like `activeScheduler` not existing yet / being stopped.

### Wake primitive

`AstTimerScheduler::wait(&mut self, wake_ms: i64) -> i64` sleeps until the
earlier of the next shared deadline and `wake_ms`, or returns immediately when
ready work exists. `arm`/`reconcile` call `TimerScheduleHub::notify`, which uses
`tokio::sync::Notify::notify_one` — a notification with no waiter is kept as a
permit, so a deadline armed between the driver's state read and its `select!` is
not lost. `BotTimerRuntime::wait` exposes it to the owner; the loop contract is
`tick` → `wait(wake_ms)` → `tick`. This closes the remaining window where a
sub-2-second timer scheduled during an earlier, later sleep would still wait for
the old wake instant.

`wait` also reads the hub's reconcile cadence directly and sleeps until the
earlier of it, the earliest armed deadline and the caller's `wake_ms`. A caller
that passes a `wake_ms` computed before a cadence change therefore cannot sleep
past a due reconciliation; a cadence of `0` (never reconciled) is ignored.

### Reconcile vs concurrent arm

**Defect (lead review).** `reconcile` awaited `store.pending(...)` and then
rebuilt the shared set with `retain(|id| page.contains(id))`. The window between
the cache read and the rebuild is an await point: a `$(timer …)` that enqueued
*and* armed in that window was missing from the page but present in the local
set, so the rebuild deleted its live arm. The job then waited for the next
reconcile pass — up to `RECONCILE_MS` (2 s) late — even though `schedule` had
already armed it at its real `dueAt`.

**Fix.** The hub keeps a monotonic `arm_epoch` counter. `reconcile` opens a
snapshot with `begin_snapshot()` *before* its first cache read and passes the
returned epoch to `rebuild`; every arm records the epoch that was current when
it was created. A rebuild now removes an entry only when both hold:

- the id is absent from the page it read, **and**
- `entry.arm_epoch < snapshot_epoch` — the arm predates the read, so a complete
  page must have listed it if the job were still pending.

An arm created while the read was in flight has `arm_epoch >= snapshot_epoch`
and survives. Removal of genuinely stale entries, bounded state and stop
semantics are unchanged: a job claimed by another instance or reclaimed by the
cache was armed before the snapshot, so it is still dropped by the next pass
that sees it missing; claims, stale removal and `stop` (which clears the whole
set) keep the map at one entry per pending timer; `rebuild` still refuses to arm
anything while stopped.

The deterministic test is
[`reconcile_keeps_an_arm_created_while_its_snapshot_was_in_flight`](#test-strategy):
a decorator store hands back a page captured *before* it lets a catalog-side
scheduler enqueue and arm the job, which is exactly the reviewed interleaving.

### Failed reconcile

**Defect (lead review).** `reconcile_at_ms` was written only on success. After a
cache error it stayed in the past, so `claim_due` reconciled again on every
pass, `next_wake_ms` clamped to `now`, and `wait` returned immediately: the loop
hammered the cache with back-to-back reconciles instead of retrying on the
source's 2-second interval.

**Fix.** `reconcile` delegates the read/rebuild to `reconcile_snapshot` and, on
failure, stores `reconcile_at_ms = clock.now_ms() + RECONCILE_MS` (measured after
the failed attempt, so a slow, timing-out cache cannot immediately make the next
attempt overdue) before returning the error. A successful pass also measures the
cadence after its reads, for the same reason. A failed pass leaves every
existing arm untouched — it proved nothing stale — and `claim_due` still logs and
continues, so the loop neither stops nor spins: `next_wake_ms` returns due armed
work (if any, which the next claim runs) or the retry instant, never an immediate
re-reconcile.

`start` is unchanged in shape: the first recovery's error is returned and the
hub rolls back to stopped (`abort_start`). The retry cadence written by the
failed pass is harmless there because a stopped hub is never woken by it, and the
next `start` reconciles immediately.

The deterministic test is
[`a_failed_reconcile_retries_at_the_source_cadence_and_then_recovers`](#test-strategy):
it injects two consecutive read failures, asserts one read per cadence (no
immediate re-attempt), a future `wake_ms`, untouched arms, and recovery of a
cache-only job on the third attempt.

### Stop after claim

Found while reviewing the claim/stop path. `claim_due` claims (consumes) due
jobs and then reconciles; if a `stop` landed in between, the first draft
returned `Ok(None)` and the already-claimed jobs were dropped — an at-most-once
delivery became a zero-times loss without a crash. A stop that arrives after the
claim loop now returns the claimed jobs with `now` as the wake, so the owner
executes exactly what was consumed and the next pass observes the stop and ends
the loop (its `claim_due` entry check returns `None`). Stop still prevents new
claims and still clears every arm; nothing is armed or claimed after it.

### Other timing races reviewed

Three more interleavings were checked; none needed a code change beyond the ones
above.

- **`take_due` vs `fire`.** `claim_due` removes an id from the armed set and then
  claims it with the same `now`. `fire` disarms again (idempotent) and, if the
  payload is still in the future (`NotYetDue`), leaves the job pending but
  unarmed; the next reconcile re-arms it one cadence later. That path is not
  reachable through `claim_due` — the arm and the payload carry the same `dueAt`
  and share one `now` — and it cannot spin: nothing re-attempts it before the
  cadence.
- **A cache error inside `fire`.** The arm is already gone and is not
  re-created; the job stays pending and the next reconcile re-arms it. It is not
  retried locally, matching the source's rule that a claim whose outcome is
  unknown is never replayed.
- **`arm` vs `stop`.** Both take the same short mutex; `arm` refuses while
  stopped, and `stop` clears the set, so a schedule racing a stop either lands
  before the clear (and is dropped) or after it (and is refused). The job stays
  in the cache either way and is recovered by the next `start`.

### Lock discipline and nested timers

A timer body can schedule a nested timer: the host's
`HostRequest::ScheduleTimer` calls back into `BotAstFunctions::schedule_timer`,
which locks the catalog's `tokio::sync::Mutex<AstTimerScheduler<…>>`.

- Every `TimerScheduleHub` method takes a short, synchronous critical section and
  drops the guard before returning. **No hub guard is held across an `await`**,
  so cache I/O and execution never run under the lock.
- `AstTimerScheduler::claim_due` claims all due jobs and returns them only after
  every scheduler critical section has ended.
- `BotTimerRuntime::tick` executes the returned jobs *after* that point and
  holds no scheduler lock. A driver that kept the catalog's mutex across
  execution would deadlock the single-threaded runtime on the first nested
  `$(timer …)`; the test below exercises that path under a timeout.

The nested job is written and armed through the shared hub, so it becomes the
driver's next deadline immediately.

### Id uniqueness

`DigestTimerIdSource::new` now mixes a process-wide `AtomicU64` sequence into its
seed. Two id sources built in one process and one clock tick (the catalog's and
the driver's) otherwise shared a seed and would mint the same id for different
jobs in the same namespace. The id shape (32 hex characters) is unchanged; ids
stay opaque key segments and are never parsed.

### Semantics explicitly unchanged

- `ENQUEUE_TIMER_JOB_SCRIPT` and `CLAIM_TIMER_JOB_SCRIPT` are byte-identical,
  still executed with raw `EVAL`; prune-before-cap, payload plus both index
  writes, and consume-before-execute remain server-side and atomic.
- Key layout is unchanged: `ast:timers:pending` (score `dueAt`),
  `ast:timers:job:<id>` (payload, `PXAT expiresAt`), and
  `ast:timers:channel:<channelId>` (score `expiresAt`, key TTL at its highest
  score).
- `MAX_CHANNEL_TIMERS = 100`, `MAX_PENDING_TIMERS = 10_000`,
  `MAX_JOB_BYTES = 64 KiB`, `RECONCILE_MS = 2000`, `TIMER_GRACE_MS = 10 min`
  (`expiresAt = dueAt + 10 min`) are unchanged.
- At most once, drop-at-claim-time expiry, no retry after a claim, and the
  `MAX_TIMER_SECONDS = 604800` / `MAX_TIMER_DEPTH = 5` function guards are
  unchanged.
- Firing is not the enqueue tick: `$(timer …)` only writes and arms the job
  (`HostRequest::ScheduleTimer` → `BotAstFunctions::schedule_timer`). The stored
  body is evaluated only in a later `claim_due`/`tick`, which is the source's
  `setTimeout` callback; a claimed job that then fails is logged
  (`AST timer execution failed`) and counted, never retried.
- Reconcile keeps its cadence and remains the only recovery path for jobs
  written by another instance or before a restart. `claim_due` claims due work
  before it computes a wake instant, and `next_wake_ms` clamps to `now`, so a
  pass never sleeps while a job is due. A failed pass retries one cadence later
  (never in a tight loop) and a job armed while a pass was reading keeps its arm
  (see [Reconcile vs concurrent arm](#reconcile-vs-concurrent-arm)).

## Wait inventory (source → native, with reasons)

| Source wait | Native wait | Protects / whether work is ready | Decision |
|-------------|-------------|----------------------------------|----------|
| `setInterval(reconcile, 2000)` | `RECONCILE_MS` + hub `reconcile_at_ms`, driven by `claim_due`/`step` + `next_wake_ms` + `wait` | Recovery of jobs written by another instance or before a restart; future-due polling only. Due work is claimed **before** the wake is computed and the wake is clamped to `now`. A failed pass schedules its retry one cadence out, and the snapshot epoch keeps an arm created during the read. | **Kept.** Still the only cross-instance/restart recovery path. |
| `setTimeout(fire, dueAt - now)` per job | one shared `armed: BTreeMap<String, i64>` in `TimerScheduleHub` plus a single sleep until the earliest deadline | Real delivery instant for future-due work; no artificial cadence. Idempotent per id, so reconcile cannot double-arm. | **Kept**, with one timer instead of N and one shared map instead of two. |
| `activeScheduler?.arm(...)` in `scheduleAstTimer` | `AstTimerScheduler::arm` → `TimerScheduleHub::arm` + `notify` | Makes a job that is already ready visible to the driver immediately. | **Kept and fixed**: same set, plus a wake-up for a sleeping driver. |
| `interval.unref()` / `timeout.unref()` | no detached task; `wait` is owned by the caller's loop and dropped with it | An idle bot must not hold a thread or keep the process alive. | **Kept.** |
| `console.error('AST timer recovery failed; will retry', …)` | one `eprintln!` per failed pass, with the retry scheduled at `RECONCILE_MS` after the failure | A cache hiccup must not kill scheduling and must not tight-loop. | **Kept.** No backoff added; the retry instant is now explicit instead of an overdue cadence. |
| no retry after a claim | `fire` consumes before returning; failures are logged/counted | A claimed external side effect whose outcome is unknown is never replayed. | **Kept.** |

No sleep exists merely to create a cadence: `claim_due` claims every due job
before computing `wake_ms`, `next_wake_ms` clamps to `now`, and `wait` returns at
once when a deadline is at or before `now`. The new tests assert idle,
future-due, ready-work and backlog behaviour (see
[Test strategy](#test-strategy)); they are authored, not executed.

The source has no equivalent of the claim/stop interleaving above because
`executeAstTimerJob` ran in the same tick as `claim`: a job that was claimed was
executed. Returning claimed jobs after a late stop preserves that, and is the
only deliberate deviation from "`Ok(None)` means stopped" — documented on
`claim_due`.

## Public API exposed (summary)

- `ast_timer_runtime::resume_timer_context(&JsValue) -> Result<Context, AstTimerError>`
- `ast_timer_runtime::{TimerScheduleHub, TimerScheduleState (private), ArmedTimer (private)}`
- `AstTimerScheduler::{new, with_hub, hub, claim_due, wait}` (+ the existing
  `start`, `stop`, `arm`, `take_due`, `schedule`, `peek`, `reconcile`, `fire`,
  `step`, accessors)
- `ast_runtime::bootstrap::execute_ast_timer_job(..) -> Result<SendResult, AstRuntimeError>`
- `ast_runtime::bootstrap::{TimerStreamer, TimerStreamerDirectory, restore_timer_application_context}`
  (`restore_timer_application_context(&JsValue, &dyn TimerStreamerDirectory,
  Option<&Arc<Logger>>)`)
- `ast_runtime::bootstrap::{BotRuntimeParts, BotTimerRuntime, TimerTick}`
- `ast_runtime::bootstrap::{ProductionTimerScheduler, ProductionFunctionCatalog, ProductionTimerStore}`
- `ast_runtime::bootstrap::{build_bot_runtime, build_bot_runtime_with_namespace, build_bot_runtime_over_store}`
- `BotTimerRuntime::{scheduler, scheduler_mut, hub, catalog, runtime, runtime_mut, logger, start, execute, tick, wait}`

## Central patch the integration team must apply (not applied here)

This checkout currently has **no** `ast-bot-runtime` feature in
`dimabot/Cargo.toml` and **no** `ast_runtime` / `ast_timer_runtime` registration
in `dimabot/src/utils/mod.rs`. Until both land, this lane's sources and test
target cannot be compiled or named by any `cargo` command. The exact contract:

`dimabot/src/utils/mod.rs`:

```rust
#[cfg(feature = "ast-bot-runtime")]
#[path = "ast_parser/runtime.rs"]
pub mod ast_runtime;

#[cfg(feature = "ast-bot-runtime")]
#[path = "ast_timer_runtime.rs"]
pub mod ast_timer_runtime;
```

`dimabot/Cargo.toml` `[features]` — every listed feature exists today; this is
the cumulative list recorded by the other lanes:

```toml
ast-bot-runtime = [
    "ast-evaluator",
    "ast-pure-functions",
    "ast-blocks",
    "ast-syntax",
    "twitch-functions",
    "twitch-streamers",
    "logger",
    "permissions",
    "mongo",
    "redis",
    "dep:tokio",
    "dep:serde",
    "dep:serde_json",
    "dep:sha2",
    "dep:uuid",
]
```

Why each is needed here: `redis` → `ConnectionManager`, `EVAL`,
`get_redis_client`; `mongo` → `runtime::variables::MongoAstVariableStore` (taken
as `Arc<dyn AstVariableStore>`); `twitch-functions` + `twitch-streamers` →
`TwitchFunctions`, `TwitchStreamers`, `TwitchChatSender`; `logger` → `Logger`,
`LogOptions`, `Level`; `ast-evaluator` → `Engine`, `Context`, `Host`,
`nullish_string`, `EvalError`; `dep:sha2` → `DigestTimerIdSource`; `dep:tokio` →
`time`/`sync`/`macros` used by the scheduler's `wait`. The test target is
auto-discovered; no `[[test]]` entry is needed.

**No longer required for pacing correctness.** The earlier suggestion to add an
`accessor` on `BotAstFunctions` for its internal scheduler would collapse the two
values into one, but it is not needed: the hub already gives both values one
armed set, one stopped flag and one wake channel. Add it only as a cleanup if
the catalog later needs to own the only scheduler value.

## Remaining gaps

- **Not compiled or tested.** `cargo check`/`test`, `rustfmt` and `clippy` are
  pending an execution lease. No compiler has seen these files; type errors are
  still open. The feature/registration contract above is also unapplied, which
  alone blocks compilation. This explicitly includes the follow-up work: the
  `ArmedTimer` epoch plumbing, `begin_snapshot`/`schedule_reconcile`, the
  post-claim stop branch, `wait`'s cadence clamp, the `FakeStore` additions and
  both new tests are **unverified**. The context-adapter follow-up is likewise
  unverified: the base/overlay branches in `restore_timer_application_context`,
  the richer `TimerStreamerDirectory`, the directory diagnostic, the rewritten
  oracle fixture and the native comparison test have not been compiled or run,
  and the source oracle (`node`) was not executed either. Formatting was written
  by hand to the repository's style (100 columns) but `rustfmt` was not run, so
  `cargo fmt -- --check` may still report wrapping differences in the new test
  fixtures and import list.
- **The interleaving test emulates ordering, not concurrency.** It drives the
  exact reviewed window deterministically (page captured, then a real
  enqueue+arm, then the rebuild) through a decorator store. It does not run two
  real scheduler tasks; genuine overlap still relies on the documented
  single-threaded driver and the short, await-free hub critical sections.
- **`claim_due`'s `Ok(None)` contract narrowed.** A stop observed after the
  claim loop now returns the claimed jobs instead of `None`. This is deliberate
  (a consumed job must not be lost) and documented on the method, but a future
  caller that treats `Ok(None)` as the only stop signal must also stop when a
  stop is followed by a final `Some` pass. No caller exists yet.
- **A permanently broken cache retries forever at the source cadence.** The
  retry is `RECONCILE_MS` after the failure with no backoff or give-up, matching
  the source's `setInterval` behaviour; each failed pass logs one line. Bounded
  state is unaffected (failures read and write nothing locally except the
  cadence).
- **Caller adoption is absent.** Nothing in `src/bot`, `src/server` or the cron
  workers constructs `BotTimerRuntime` yet; production still runs the TypeScript
  timer scheduler until the integration team wires this factory into the bot
  entrypoint and verifies it under the ops workflow. Deployment is explicitly
  out of scope. The owner loop contract is `start` → `tick` → `wait(wake_ms)` →
  `tick`, but no caller implements it in this checkout.
- **The directory diagnostic is emitted by the timer adapter, not the
  directory.** The source logs `TwitchStreamers.getTwitchAccountById` failures
  inside the class, so every caller gets the line. The native directory's
  `account_by_id` has no logging hook, so this lane logs at
  `restore_timer_application_context` where it applies null-on-error, with the
  same fields and `Destination::Both`. A shared directory adapter should own
  that diagnostic so non-timer callers match too; no policy was changed here.
- **Typed fields cannot hold every malformed snapshot value.** A *present*
  `null` (or a number where the source's field is a string) is spread by the
  source and survives as that raw value; the corresponding Rust fields are
  `String`/`bool`/`f64`, so `resume_timer_context` leaves the default and the
  base half is not applied (it only fills keys JSON omitted). The same applies
  to a non-array `scopeAliases`, a non-object `eventData` (JavaScript spreads
  a string into index properties) and a non-object `extraContext` spread.
  Normal JSON snapshots produced by `snapshotTimerContext` and cache-only
  partial payloads do not hit these cases; do not claim parity for arbitrary
  foreign jobs.
- **Shared extraction needs consolidation.** The special parser's extraction is
  private and this adapter mirrors its small extraction sequence; it now reuses
  the parser's `normalize_scope_name`, `resolve_authored_user_level` and
  `authored_authorization` rather than duplicating those policies. Integration
  should still expose one shared constructor/extractor used by both paths; do
  not independently revise policy in either copy.
- **The factory has no fake seam for `TwitchFunctions`.** `BotRuntimeParts`
  takes the concrete client, so `build_bot_runtime_over_store` is not exercised
  by an in-memory test. The shared-hub and nested-timer tests cover the
  scheduler and the catalog directly (fake store/clock/ids; real `Engine`,
  `ApplicationHost` and delivery loop), but not the facade assembly. The
  connection step remains covered only by the ignored Dragonfly fixture at the
  store/scheduler level.
- **`BotRuntime` cannot be passed twice** to `deliver_ast_message`, so
  `execute_ast_timer_job` takes `sender` and `runner` separately. The factory
  therefore keeps a dedicated `TwitchChatSender` next to the facade; that is a
  second sender value, not a second delivery path.
- **`wait` is not exercised under paused time.** Its interruptible path is
  authored as a real 50 ms wait under a 5 s timeout; there is no
  `tokio/test-util` dependency in this profile, so the test does not assert a
  virtual clock. The ready/deadline-immediate branches are asserted directly.
- **Cancellation is not modeled** for timer execution: the source has none, and
  a `Cancelled` error from a reference stops delivery with a typed error (the
  delivery lane's existing rule).
- **The private Dragonfly fixture is unchanged** and still requires a lease and
  `DIMA_TEST_REDIS_URL`; it was not extended for the shared hub because the hub
  is process-local and needs no cache.

## Test strategy

`dimabot/tests/ast_timer_execution.rs` (first line
`#![cfg(feature = "ast-bot-runtime")]`) uses a real `Engine`, a real
`ApplicationHost` and the real `deliver_ast_message` loop; only the cache, the
variable store, the chat sender, the command runner, the timer store, the clock
and the id source are in-memory fakes.

Two fixtures were added for the follow-up races and stay in memory:

- `FakeStore` gained a `pending_reads` counter, a `fail_next_pending_reads(n)`
  injection (a typed `AstTimerError::Redis` built from
  `std::io::Error::other`), and `snapshot_ids()` recording the page it last
  returned. It stays `Send`, so the catalog-facing tests still compile against
  `S: AstTimerStore + Send`.
- `InterleavingStore` is a `!Send` decorator over `FakeStore` used only by the
  interleaving test: its `pending` captures the page first and then runs one
  prepared catalog-side `schedule` (real payload write plus real arm on the
  shared hub), which is the reviewed window without threads or sleeps.

The context follow-up adds three in-memory fakes and one process fixture:

- `TestDirectory` implements `TimerStreamerDirectory` and returns either a
  `TimerStreamer { id, name, plan_tier }` or a typed directory error.
- `RecordingSink`/`NullSink` implement `CacheSink` so the logger diagnostic can
  be asserted without Dragonfly; `logger_over`/`null_logger` build the real
  `Logger` over them.
- `tests/fixtures/ast_timer_context_reference.cjs` is the actual-source oracle.
  It extracts `resolveAuthoredAstUserLevel` (with `MODERATOR_BADGE_IDS` and its
  two helpers), `extractUserInfo`/`extractBroadcasterInfo`/
  `extractNumericFields`, `normalizeScopeName`/`normalizeScopeNames`,
  `createSpecialExecutionContext`, `createExecutionContext`,
  `snapshotTimerContext` and `executeAstTimerJob` from the TypeScript sources,
  stubs only the directory/registration/evaluator/delivery boundaries, and
  prints 16 named cases. It requires `node` and the project's installed
  `typescript` at test runtime (not at build time).

Lean, in-memory (no I/O, run by default once the feature exists):

| Test | What it proves |
|------|----------------|
| `typescript_context_oracle_exercises_actual_source` | the fixture really runs the extracted TypeScript declarations and keeps the discriminating expectations: live plan-tier fallback, normalized eventsub scope, event identity fallback, and the level-10 broadcaster default |
| `native_context_rebuild_matches_the_actual_source_oracle` | every one of the 16 actual-source cases replays through the native rebuild and matches all 19 captured fields, including lookup failure, missing identity/scope/plan/event/eventsub keys, present `null` `extraContext`, raw-vs-normalized scope precedence, and two real `snapshotTimerContext` round trips |
| `fired_context_uses_live_streamer_and_saved_extra_wins_wholesale` | a live account supplies the streamer, a present `userPlan` still wins over the directory tier, and a present `extraContext` replaces the derived object wholesale |
| `missing_extra_is_derived_and_directory_failure_returns_null` | a failing lookup is null-on-error, the derived extraction is used, and missing scope keys produce the source defaults (`command` / `default`) |
| `a_directory_failure_logs_the_source_diagnostic_and_returns_null` | a typed lookup failure still yields a null streamer and exactly one `TwitchStreamers.getTwitchAccountById` error record with `{ function, id, error }`, `Destination::Both`, and no `channelId` |
| `resume_restores_every_carried_field_and_invents_nothing` | every snapshot field is restored; `streamer`, the command-variable caches, `loop_depth` and `count_modified` keep their defaults; `visitedCommands` dedupes |
| `timer_depth_is_incremented_once_across_the_cache_boundary` | the snapshot writes `depth + 1` and resuming does not increment again |
| `resumed_context_has_no_effect_authority` | the snapshot has no `effectContext` and the resumed context has none |
| `a_snapshot_without_a_broadcaster_is_a_typed_failure` | a missing broadcaster is `AstTimerError::JobDecoding`, not a panic |
| `a_failing_evaluation_returns_a_typed_error_instead_of_panicking` | a host failure surfaces as `AstRuntimeError::Host` and nothing is delivered |
| `a_delivery_failure_is_propagated_with_the_source_message` | `sent.error` becomes `AstRuntimeError::Rejected` with the source's message, after the outer send and before any reference |
| `execution_delivers_the_rendered_text_then_the_command_references` | the rendered text is sent once (trimmed) and the queued reference is executed |
| `a_timer_body_is_evaluated_in_the_resumed_context_not_the_live_one` | the body reads the snapshot, not the live context mutated afterwards |
| `scheduling_through_the_shared_hub_arms_the_one_driver_immediately` | a 1-second timer scheduled by the catalog-side value is armed on the driver, `next_wake_ms` is its `dueAt` rather than `RECONCILE_MS`, one pass claims it, nothing stays armed, nothing replays; a stopped schedule writes but does not arm |
| `idle_and_future_due_work_wait_for_real_deadlines_without_spinning` | an idle pass wakes at the cadence, future-due work is not claimed early and does not set the wake to its far deadline, a later nearer deadline moves the wake, ready work returns `wait` immediately, and the far job is delivered only at its own deadline |
| `a_normal_mode_backlog_is_claimed_in_one_pass_and_retains_nothing` | 64 ready timers are all claimed by one pass with distinct ids, no armed entries remain, the wake is the cadence rather than a sleep, and a second pass neither replays nor re-arms |
| `reconcile_keeps_an_arm_created_while_its_snapshot_was_in_flight` | a `$(timer …)` enqueued and armed *inside* the reconcile read (after the page was captured, before the rebuild) keeps its arm, drives the wake to its own `dueAt`, and is claimed by the very next pass instead of at the next reconcile; the captured page is asserted to be empty, so the interleaving is real and not a timing guess |
| `a_failed_reconcile_retries_at_the_source_cadence_and_then_recovers` | two injected read failures produce one cache read per cadence (an immediate second pass does not retry), a future `wake_ms`, untouched existing arms, and — on the third attempt — recovery of a cache-only job, which is then claimed by the next pass with ready work never slept on |
| `a_claimed_job_can_schedule_a_nested_timer_without_deadlocking` | executing a claimed `$(timer 1 …) outer body` schedules and arms a nested timer through the real catalog under a 5 s timeout (a held scheduler lock deadlocks), the nested deadline drives the next wake, and the nested body delivers at its own deadline |
| `a_new_deadline_wakes_a_waiting_driver_instead_of_the_old_target` | a driver sleeping on a far `wake_ms` is woken by a newly armed 50 ms deadline and returns at that deadline instead of the old target |

`#[ignore]`d, needs a lease and a **private** Dragonfly/Redis instance:

- `private_dragonfly_lua_path_end_to_end` — the only real-adapter test. It
  requires `DIMA_TEST_REDIS_URL` to point at a disposable instance, builds a
  uniquely named namespace (`dima:test:ast-timer:<pid>:<nanos>:`), owns every
  key it creates and deletes exactly those keys on drop (claim-keyed cleanup in
  the style of `tests/moderation_permit_redis.rs`). It exercises the real
  `EVAL` path end to end: enqueue writes the payload plus both index entries
  with the source scores; the claim removes the payload and both index entries;
  a second claim finds nothing (at most once); a job claimed at `expiresAt` is
  consumed and dropped; and the per-channel cap (100) rejects the next enqueue
  without writing anything. The global cap is structurally identical and is
  covered by the in-memory scripted fake in `tests/ast_timer_runtime.rs`, so the
  fixture does not need 10 000 round trips.

Run shape once a lease exists (with the feature/registration patch applied):

```bash
cargo test --features ast-bot-runtime --test ast_timer_execution
DIMA_TEST_REDIS_URL=redis://127.0.0.1:<private-port> \
  cargo test --features ast-bot-runtime --test ast_timer_execution -- --ignored
```

Both commands are recorded for the integration run only; **neither was
executed here.**

## Context adapter handoff (static authoring, 2026-10-31)

`BotTimerRuntime` reuses its existing `Arc<TwitchStreamers>` at fire time. A
missing account or native directory failure continues with `streamer: null`;
no retry is introduced. The captured variable scope is derived from the
synthetic event before saved data overlays the base. The saved original event
is retained. `extraContext`, when present, wins as an entire object, not a
per-field merge; when omitted the derived base survives. Source-created event
effect authority never crosses the snapshot.

The fixture extracts actual TypeScript declarations from the userlevel,
handler, evaluator, timer and runtime sources and stubs only application
boundaries. It now also extracts the real `resolveAuthoredAstUserLevel`,
`normalizeScopeName` and `normalizeScopeNames`, so those precedence rules are
the source's own. The Rust tests replay every oracle case through the native
rebuild, compare all 19 captured fields, and separately assert the native
directory diagnostic. None of it has been executed.

The directory's own TypeScript error path is still represented by a
null-returning fixture boundary: the oracle can prove the null-streamer result
but not the source logger call. The native diagnostic is asserted directly
through the real `Logger`/`CacheSink` in
`a_directory_failure_logs_the_source_diagnostic_and_returns_null`; the source
line itself remains a stubbed boundary.

Central wiring remains the feature/module patch above and a bot owner that
constructs the parts, starts, ticks and waits. The application directory should
eventually log `TwitchStreamers.getTwitchAccountById` failures with id/error to
both destinations and return null for every caller, matching the source; until
then this lane emits the same line at the timer boundary only, and its global
error policy is unchanged. Reuse the existing directory from the bot facade:

```rust
let directory = Arc::clone(runtime.directory());
// After claim, pass directory.as_ref() to execute_ast_timer_job.
```

No cargo, rustfmt, Node, tests, Docker, network or deployment was run. The
changes are uncompiled and local coverage and total migration completion are
unverified. Shared scheduler behavior was not edited.
