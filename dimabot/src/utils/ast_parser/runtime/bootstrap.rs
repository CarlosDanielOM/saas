//! Concrete assembly of the native bot/AST runtime, plus the fired-timer
//! execution half.
//!
//! Two things live here, and they are deliberately separate:
//!
//! 1. [`execute_ast_timer_job`] — the port of `executeAstTimerJob` in
//!    `src/utils/ast_timer_runtime.ts`. The cache-backed job store, the
//!    scheduler and the snapshot rebuild belong to
//!    `crate::utils::ast_timer_runtime`; this function is the *application*
//!    half: rebuild the context, evaluate the stored body, deliver the result.
//! 2. [`build_bot_runtime`] — the one explicitly **async** factory that
//!    assembles the production adapters (Dragonfly timer store, native engine,
//!    Twitch client, cache, variable store, directory, command store) and
//!    installs both the [`AstFunctionCatalog`] and the
//!    [`TimerScheduler`](super::host::TimerScheduler) into
//!    [`BotRuntime::with_functions`].
//!
//! # Construction never hides I/O
//!
//! [`build_bot_runtime_over_store`] performs **no** I/O: it only wires already
//! constructed collaborators. The asynchronous [`build_bot_runtime`] does
//! exactly one thing more, and says so: it calls
//! [`DragonflyTimerStore::connect`], which reads `DRAGONFLY_HOST` /
//! `DRAGONFLY_PORT` through the existing shared client and opens the
//! connection manager. `ApplicationHost` and `BotRuntime` keep their I/O-free
//! constructors; nothing connects at import time and there is no module
//! singleton.
//!
//! # Fired-timer execution (source: `executeAstTimerJob`)
//!
//! The order is the source's, and each step is one of its statements:
//!
//! 1. [`restore_timer_application_context`] rebuilds the `Context`: the
//!    data-only snapshot overlay ([`resume_timer_context`]) plus the source's
//!    `createSpecialExecutionContext` base for every key JSON dropped, bound to
//!    the job's broadcaster and the live directory account. Effect authority is
//!    **not** restored, because the snapshot never carried it ("Timers never
//!    carry live event-effect authority, including their duration expression").
//!    A directory lookup failure is null-on-error and logs the source's
//!    `TwitchStreamers.getTwitchAccountById` diagnostic.
//! 2. [`Engine::evaluate`] runs the stored, still-unevaluated `AstNode` body
//!    in that fresh context. The job already stores the parsed tree, so there is
//!    no re-parse and no source text to compile.
//! 3. `deliver_ast_message` sends the rendered text and then the command
//!    references the evaluation produced. Delivery is not reimplemented here:
//!    the drain-once queue, send-before-references and
//!    continue-on-reference-error rules stay in `runtime::delivery`.
//!
//! The source's `if (sent.error) throw new Error(sent.message)` becomes
//! [`AstRuntimeError::Rejected`] with the same message, and an evaluation
//! failure keeps its typed kind through
//! [`from_eval_error`](super::host::from_eval_error) instead of a panic.
//!
//! # Pacing, backlog and at most once
//!
//! - Keys: `ast:timers:pending` (score `dueAt`), `ast:timers:job:<id>`
//!   (payload, `PXAT expiresAt`), `ast:timers:channel:<channelId>` (score
//!   `expiresAt`, key TTL at its highest score).
//! - Caps: `MAX_CHANNEL_TIMERS` = 100 per channel, `MAX_PENDING_TIMERS` =
//!   10_000 globally, `MAX_JOB_BYTES` = 64 KiB per serialized job,
//!   `RECONCILE_MS` = 2000 ms.
//! - Grace and range: `TIMER_GRACE_MS` = 10 minutes, so
//!   `expiresAt = dueAt + 10 min`; `MAX_TIMER_SECONDS` = 604800 and
//!   `MAX_TIMER_DEPTH` = 5 are the `timer` function's guards.
//! - Enqueue happens inside the `timer` function's evaluation. The job is never
//!   evaluated or delivered in that tick: the source armed a `setTimeout` and
//!   this port executes only in a later [`BotTimerRuntime::tick`], which claims
//!   due jobs first and then reports the instant the owner should sleep until.
//!   A pass never sleeps while a job is due, and reconcile keeps its own
//!   cadence so jobs written by another instance or before a restart are
//!   recovered. A failed reconcile schedules its retry one cadence out and
//!   leaves existing arms untouched, and a job enqueued and armed while a
//!   reconcile read is in flight keeps its arm (it is delivered at its own
//!   `dueAt`, not at the next pass).
//! - At most once: the claim consumes the payload and both index entries
//!   *before* execution, so overlapping bot instances cannot double-fire. A
//!   crash between the claim and the delivery can lose that action, which is
//!   the accepted trade — an external side effect whose outcome cannot be
//!   determined is never replayed. A job past `expiresAt` is dropped at claim
//!   time. A claimed job that then fails is logged and dropped, never retried.
//!
//! # One schedule, two values
//!
//! `BotAstFunctions` takes ownership of the [`AstTimerScheduler`] it is built
//! with (it holds it behind an async mutex) and exposes no accessor for it, so
//! this factory cannot hand the same *value* to a caller that must drive the
//! reconcile loop. [`DragonflyTimerStore`] is a cheap clone over one shared
//! connection, and the two values are built over **one**
//! [`TimerScheduleHub`]: the catalog's value (used by
//! `HostRequest::ScheduleTimer` to write and arm the job) and the delivery value
//! this runtime returns (used to claim, execute and wait) read and write the
//! same armed set.
//!
//! That is the source's `activeScheduler` in every respect that matters to
//! timing: `scheduleAstTimer` armed the same map its `setTimeout` callbacks
//! drained. Arming through the catalog is visible to the driver immediately
//! ([`BotTimerRuntime::tick`]'s next wake is the new `dueAt`, not the reconcile
//! cadence), a driver sleeping in [`BotTimerRuntime::wait`] is woken for the new
//! deadline, and the catalog's entries are drained by the driver instead of
//! being retained forever. A 1-second timer is therefore delivered at its
//! `dueAt` rather than up to `RECONCILE_MS` later. Reconcile remains the only
//! recovery path for jobs written by another instance or before a restart.
//!
//! # Lock discipline (nested timers)
//!
//! A timer body can schedule a nested timer: the host's
//! `HostRequest::ScheduleTimer` calls back into the catalog, which locks its
//! async scheduler mutex. [`BotTimerRuntime::tick`] therefore claims due jobs
//! with [`AstTimerScheduler::claim_due`] and executes them only after every
//! scheduler lock has been released — the hub's critical sections are
//! synchronous and never span an `await`, and no catalog guard is held by the
//! driver. Holding the scheduler lock across execution would deadlock the
//! single-threaded runtime on the first nested `$(timer …)`.
//!
//! # Threading
//!
//! Nothing here is `Send`-bound on the AST context: the evaluator context is
//! `Rc`-based, the host future is not `Send`, and the executor is driven by its
//! owner inside a `tokio::task::LocalSet` (or an equivalent single-threaded
//! task). The catalog itself is `Send + Sync`, as its traits require.

use std::sync::Arc;

use crate::{
    functions::TwitchFunctions,
    utils::{
        ast_evaluator::{
            Engine, JsString, JsValue, is_truthy, js_string, nullish_string, to_number,
        },
        ast_timer_runtime::{
            AstTimerError, AstTimerJob, AstTimerScheduler, DigestTimerIdSource, DragonflyTimerStore,
            SystemClock, TimerNamespace, TimerScheduleHub, resume_timer_context,
        },
        logger::{Destination, Level, LogOptions, Logger},
        twitch_streamers::{DirectoryError, TwitchStreamers},
    },
};

use super::{
    AstCache, AstFunctionCatalog, AstMessage, AstRuntimeError, AstVariableStore, ChatSender,
    CommandRunner, SendResult, BoxFuture, AstScope, ScopedAstHost,
    chat::TwitchChatSender,
    command::CommandStore,
    delivery::{DeliverySeams, deliver_ast_message},
    functions::BotAstFunctions,
    host::{ApplicationHost, TimerScheduler, from_eval_error},
    parser,
    wiring::BotRuntime,
};

/// The production timer store: the raw-`EVAL` Dragonfly adapter.
pub type ProductionTimerStore = DragonflyTimerStore;
/// The production timer scheduler: Dragonfly store, system clock, digest ids.
pub type ProductionTimerScheduler =
    AstTimerScheduler<DragonflyTimerStore, SystemClock, DigestTimerIdSource>;
/// The production function catalog built over [`ProductionTimerScheduler`].
pub type ProductionFunctionCatalog =
    BotAstFunctions<DragonflyTimerStore, SystemClock, DigestTimerIdSource>;

/// Channel identity the source's `TwitchStreamers.getTwitchAccountById` yields.
///
/// `plan_tier` is not a snapshot field; it is only used for the source's
/// `userPlan` base default (`saved.userPlan || streamer?.plan_tier || 'free'`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TimerStreamer {
    pub id: String,
    pub name: String,
    pub plan_tier: String,
}

/// Channel lookup at fire time. A failed native lookup is returned to the
/// caller, which applies the source directory's null-on-error behavior and
/// emits its `TwitchStreamers.getTwitchAccountById` diagnostic.
pub trait TimerStreamerDirectory {
    fn lookup<'a>(
        &'a self,
        channel: &'a str,
    ) -> BoxFuture<'a, Result<Option<TimerStreamer>, String>>;
}

impl TimerStreamerDirectory for TwitchStreamers {
    fn lookup<'a>(
        &'a self,
        channel: &'a str,
    ) -> BoxFuture<'a, Result<Option<TimerStreamer>, String>> {
        Box::pin(async move {
            match self.account_by_id(channel).await {
                Ok(account) => Ok(Some(TimerStreamer {
                    id: account.metadata.id,
                    name: account.metadata.name,
                    plan_tier: account.metadata.plan_tier,
                })),
                Err(DirectoryError::Missing) => Ok(None),
                Err(error) => Err(error.to_string()),
            }
        })
    }
}

/// Source `TwitchStreamers.getTwitchAccountById` catch block:
/// `error({ function: 'TwitchStreamers.getTwitchAccountById', id, error }, { destination: 'both' })`
/// followed by `return null`.
///
/// The native directory exposes no logging hook on `account_by_id`, so the
/// timer adapter emits that diagnostic where it applies null-on-error. Every
/// other directory caller keeps its own policy until a shared adapter provides
/// it (recorded as a contract gap in the migration note).
async fn log_streamer_lookup_failure(logger: Option<&Arc<Logger>>, channel: &str, error: &str) {
    match logger {
        Some(logger) => {
            let _ = logger
                .log(
                    Level::Error,
                    serde_json::json!({
                        "function": "TwitchStreamers.getTwitchAccountById",
                        "id": channel,
                        "error": error,
                    }),
                    LogOptions {
                        destination: Destination::Both,
                        ..Default::default()
                    },
                )
                .await;
        }
        None => eprintln!(
            "TwitchStreamers.getTwitchAccountById failed (id {channel}): {error}"
        ),
    }
}

fn event_first(event: &JsValue, keys: &[&str]) -> JsValue {
    let value = keys.iter().map(|key| event.get(key)).find(is_truthy)
        .unwrap_or_else(|| JsValue::string(""));
    let text = js_string(&value);
    if text.is_empty() { JsValue::Undefined } else { JsValue::String(text) }
}

/// Rebuild the source's base context before its `...saved` overlay.
///
/// The source is `executeAstTimerJob`'s
/// `{ ...await createSpecialExecutionContext(…), ...saved, … }`. The overlay
/// itself is [`resume_timer_context`]; this function supplies the **base** half
/// for every key the JSON payload dropped (`undefined` is not serialized) and
/// the directory-derived values that can never come from the snapshot
/// (`streamer`, and the `userPlan` fallback).
///
/// Base precedence is the source's, per field:
///
/// - identity (`userId`, `userLogin`, `userDisplayName`) falls back to the
///   extraction from `{ ...saved.eventData, chatter_user_*: saved.* }`;
/// - `userPlan` falls back to the live account's `plan_tier`, then `'free'`;
/// - `eventData` falls back to that same merged object, and `eventsubData` to
///   `{}` (`(context.eventsubData || {})`);
/// - `scopeName` is `normalizeScopeName(saved.scopeName || eventsubData.name ||
///   eventData.reward.title || '')`, and `commandName` shares that resolved
///   name. A **present** `scopeName` still overlays it raw, so only the derived
///   `commandName` is normalized in that case;
/// - `extraContext` falls back to the merged extraction object, and a present
///   `null`/object replaces it wholesale (never per-field merged);
/// - `authorization` falls back to the parser's authored identity for the
///   resolved level, `userLevel` to `resolveAuthoredAstUserLevel`, and
///   `enforceFunctionPermissions` to `false`.
///
/// A key that is present but not of its snapshot's type (`null`, a number
/// where a string belongs, a non-array alias list) is left at the resumed
/// value: the typed Rust fields cannot represent the source's raw spread.
/// Those cases are documented as unsupported in the migration note.
///
/// The returned scope is captured by the source's variable callbacks before
/// that overlay; the saved `eventData` itself is not modified.
pub async fn restore_timer_application_context(
    snapshot: &JsValue,
    directory: &dyn TimerStreamerDirectory,
    logger: Option<&Arc<Logger>>,
) -> Result<(crate::utils::ast_evaluator::Context, AstScope), AstTimerError> {
    let context = resume_timer_context(snapshot)?;
    let channel = context.borrow().broadcaster_id.clone();
    // Source: the directory logs inside `getTwitchAccountById` and returns null.
    let account = match directory.lookup(&channel).await {
        Ok(account) => account,
        Err(error) => {
            log_streamer_lookup_failure(logger, &channel, &error).await;
            None
        }
    };

    // `eventData: { ...saved.eventData, chatter_user_id: saved.userId, … }`
    let event = JsValue::object(vec![]);
    if let JsValue::Object(fields) = snapshot.get("eventData") {
        for (key, value) in fields.borrow().iter() {
            event.set(key.clone(), value.clone());
        }
    }
    for (key, saved) in [
        ("chatter_user_id", "userId"),
        ("chatter_user_login", "userLogin"),
        ("chatter_user_name", "userDisplayName"),
    ] {
        event.set(key, snapshot.get(saved));
    }
    let user_id = event_first(
        &event,
        &["chatter_user_id", "user_id", "from_broadcaster_user_id", "moderator_user_id"],
    );
    let user_login = event_first(
        &event,
        &["chatter_user_login", "user_login", "from_broadcaster_user_login", "moderator_user_login"],
    );
    let user_name = event_first(
        &event,
        &["chatter_user_name", "user_name", "from_broadcaster_user_name", "moderator_user_name"],
    );

    // `mergedExtraContext = { ...extracted, ...context.extraContext }`. The
    // extraction stores absent values as `undefined`, exactly like the source's
    // `extract*` helpers, so a JSON round trip drops the same keys.
    let extra = JsValue::object(vec![]);
    for (key, value) in [
        ("userID", user_id.clone()),
        ("userLogin", user_login.clone()),
        ("userName", user_name.clone()),
        (
            "broadcasterName",
            event_first(&event, &["broadcaster_user_name", "to_broadcaster_user_name"]),
        ),
        (
            "broadcasterLogin",
            event_first(&event, &["broadcaster_user_login", "to_broadcaster_user_login"]),
        ),
        (
            "broadcasterID",
            event_first(&event, &["broadcaster_user_id", "to_broadcaster_user_id"]),
        ),
    ] {
        extra.set(key, value);
    }
    let bits = event.get("bits");
    let bits = if is_truthy(&bits) { bits } else { event.get("cheer").get("bits") };
    for (key, value) in [("bits", bits), ("viewers", event.get("viewers"))] {
        extra.set(
            key,
            if matches!(value, JsValue::Undefined) {
                value
            } else {
                JsValue::Number(to_number(&value))
            },
        );
    }

    // `(context.eventsubData || {})` — absence yields the empty object that the
    // base half carries when the snapshot has no key to overlay.
    let eventsub_data = if matches!(snapshot.get("eventsubData"), JsValue::Undefined) {
        JsValue::object(vec![])
    } else {
        snapshot.get("eventsubData")
    };

    // `context.scopeName || String(eventsubData.name || '') ||
    //  String(eventData.reward?.title || '') || ''`, then `normalizeScopeName`.
    let saved_scope_name = snapshot.get("scopeName");
    let scope_source = if is_truthy(&saved_scope_name) {
        js_string(&saved_scope_name)
    } else {
        let eventsub_name = eventsub_data.get("name");
        if is_truthy(&eventsub_name) {
            js_string(&eventsub_name)
        } else {
            let reward_title = event.get("reward").get("title");
            if is_truthy(&reward_title) {
                js_string(&reward_title)
            } else {
                JsString::default()
            }
        }
    };
    let resolved_scope = parser::normalize_scope_name(&js_text(&scope_source));

    // createSpecialExecutionContext supplies authored defaults, then `...saved`
    // overwrites them. `resume_timer_context` already applied every saved value;
    // these branches fill only the keys JSON omitted.
    let supplied_level = match snapshot.get("userLevel") {
        JsValue::Number(value) => Some(value),
        _ => None,
    };
    let level = parser::resolve_authored_user_level(&event, supplied_level);
    {
        let mut execution = context.borrow_mut();
        if matches!(snapshot.get("userId"), JsValue::Undefined) {
            execution.user_id = plain_text(&user_id);
        }
        if matches!(snapshot.get("userLogin"), JsValue::Undefined) {
            execution.user_login = plain_text(&user_login);
        }
        if matches!(snapshot.get("userDisplayName"), JsValue::Undefined) {
            execution.user_display_name = plain_text(&user_name);
        }
        if matches!(snapshot.get("userPlan"), JsValue::Undefined) {
            execution.user_plan = account
                .as_ref()
                .map(|streamer| streamer.plan_tier.clone())
                .filter(|plan| !plan.is_empty())
                .unwrap_or_else(|| "free".to_owned());
        }
        if matches!(snapshot.get("userLevel"), JsValue::Undefined) {
            execution.user_level = level;
        }
        if matches!(snapshot.get("authorization"), JsValue::Undefined) {
            execution.authorization = parser::authored_authorization(level);
        }
        if matches!(snapshot.get("enforceFunctionPermissions"), JsValue::Undefined) {
            execution.enforce_function_permissions = false;
        }
        if matches!(snapshot.get("eventData"), JsValue::Undefined) {
            execution.event_data = event.clone();
        }
        if matches!(snapshot.get("eventsubData"), JsValue::Undefined) {
            execution.eventsub_data = eventsub_data.clone();
        }
        // JSON omits undefined snapshot properties. An explicitly present null
        // or object is spread over the derived base unchanged, not merged again.
        if matches!(snapshot.get("extraContext"), JsValue::Undefined) {
            execution.extra_context = extra;
        }
        if matches!(snapshot.get("scopeName"), JsValue::Undefined) {
            execution.scope_name = resolved_scope.clone();
        }
        if matches!(snapshot.get("commandName"), JsValue::Undefined) {
            execution.command_name = resolved_scope;
        }
        execution.streamer = account
            .map(|streamer| {
                JsValue::object(vec![
                    ("id".into(), JsValue::string(streamer.id)),
                    ("name".into(), JsValue::string(streamer.name)),
                ])
            })
            .unwrap_or(JsValue::Null);
    }

    let scope = AstScope {
        channel_id: channel,
        user_id: plain_text(&user_id),
        user_login: plain_text(&user_login),
    };
    Ok((context, scope))
}

/// `String(value || '')` for a derived base field. The source's `extract*`
/// helpers already turned an absent event field into `undefined`, whose base
/// default is the empty string. A lone surrogate cannot become UTF-8 and is
/// also empty, which only a foreign snapshot can produce.
fn plain_text(value: &JsValue) -> String {
    match value {
        JsValue::Undefined | JsValue::Null => String::new(),
        JsValue::String(text) => js_text(text),
        other => js_text(&js_string(other)),
    }
}

fn js_text(value: &JsString) -> String {
    value.to_utf8().unwrap_or_default()
}

/// Port of `executeAstTimerJob`: rebuild, evaluate, deliver.
///
/// `host` is the application host that owns the installed
/// [`AstFunctionCatalog`] and [`TimerScheduler`](super::host::TimerScheduler);
/// `sender` and `runner` are the delivery seams. They are separate values
/// because [`deliver_ast_message`] holds both at once, which is also why
/// [`BotRuntime`] (which implements both seams) cannot be passed twice.
///
/// Failures are typed and never panic:
///
/// - a snapshot without a usable `broadcasterId` or with an unreadable string
///   field is [`AstRuntimeError::Host`] carrying the decode message;
/// - an evaluation failure keeps the kind
///   [`from_eval_error`](super::host::from_eval_error) derives, so a host
///   failure stays `Host` and a rejected program stays `Evaluation`;
/// - a rendered value that is not valid UTF-8 is an evaluation failure at the
///   text boundary;
/// - a delivery failure is [`AstRuntimeError::Rejected`] with the source's
///   thrown message.
///
/// The job is **already claimed** when this runs. Nothing here retries it, and
/// nothing here touches the cache: a failure is the caller's to log.
pub async fn execute_ast_timer_job(
    engine: &Engine,
    host: &mut ApplicationHost,
    sender: &mut dyn ChatSender,
    runner: &mut dyn CommandRunner,
    logger: Option<&Arc<Logger>>,
    directory: &dyn TimerStreamerDirectory,
    job: &AstTimerJob,
) -> Result<SendResult, AstRuntimeError> {
    // `const { saved } = job.context;` — the broadcaster is the delivery
    // channel and the scope of everything the body touches.
    let channel_id = job.channel_id().map_err(timer_failure)?;
    let (context, scope) = restore_timer_application_context(&job.context, directory, logger)
        .await
        .map_err(timer_failure)?;
    host.set_scope(scope);

    // `const result = await evaluate(job.body, context)` — the stored body is
    // already an `AstNode`, so this is a run, not a parse.
    let evaluated = engine
        .evaluate(&job.body, context, host)
        .await
        .map_err(|error| from_eval_error(&error))?;

    // `String(result.value ?? '')` and `result.context.commandReferences`.
    let mut message = AstMessage {
        parsed_text: rendered_text(&evaluated.value)?,
        command_references: evaluated.context.borrow().command_references.borrow().clone(),
    };

    // `deliverAstMessage(saved.broadcasterId, {…})`; the source's `chatEnabled`
    // default is `true` and `executeAstTimerJob` does not override it.
    let sent = deliver_ast_message(
        &channel_id,
        &mut message,
        true,
        DeliverySeams {
            sender: &mut *sender,
            runner: &mut *runner,
            logger,
        },
    )
    .await?;

    // `if (sent.error) throw new Error(sent.message)`.
    if sent.error {
        return Err(AstRuntimeError::Rejected(sent.message));
    }
    Ok(sent)
}

/// `String(result.value ?? '')` at the Rust text boundary.
fn rendered_text(value: &JsValue) -> Result<String, AstRuntimeError> {
    nullish_string(value)
        .to_utf8()
        .map_err(|error| from_eval_error(&error))
}

/// Timer-store failures are host failures: the cache is an external adapter.
fn timer_failure(error: AstTimerError) -> AstRuntimeError {
    AstRuntimeError::Host(error.to_string())
}

/// One pass of the timer loop.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct TimerTick {
    /// Jobs claimed and delivered by this pass.
    pub delivered: usize,
    /// Jobs claimed by this pass whose evaluation or delivery failed. They are
    /// consumed and are never retried.
    pub failed: usize,
    /// Instant the owner should sleep until: the earlier of the next armed
    /// deadline and the next reconcile pass, clamped to the pass's `now`. Pass
    /// it to [`BotTimerRuntime::wait`] rather than sleeping directly, so a
    /// nearer deadline armed in the meantime wakes the loop.
    pub wake_ms: i64,
}

/// Collaborators the caller owns and injects.
///
/// Everything the factory needs is here, so a test can drive the same assembly
/// with fakes for the cache, the variable store and the command store. The
/// Twitch client is the concrete [`TwitchFunctions`]; this lane has no trait
/// seam for it, and the factory never constructs one.
pub struct BotRuntimeParts<S: CommandStore> {
    /// Native evaluator, already carrying the production function registry.
    pub engine: Engine,
    /// AST cache seam (`DragonflyAstCache` in production).
    pub cache: Arc<dyn AstCache>,
    /// Persistent AST variable seam (`MongoAstVariableStore` in production).
    pub variables: Arc<dyn AstVariableStore>,
    /// Channel directory used by the special parser.
    pub directory: Arc<TwitchStreamers>,
    /// Command store used by reference execution.
    pub store: S,
    /// Real Helix client behind chat sends.
    pub twitch: TwitchFunctions,
    /// Shared logger; the source's `console.error` sinks.
    pub logger: Option<Arc<Logger>>,
}

/// The assembled production runtime: timer scheduler, function catalog and the
/// [`BotRuntime`] facade.
pub struct BotTimerRuntime<S: CommandStore> {
    scheduler: ProductionTimerScheduler,
    catalog: Arc<ProductionFunctionCatalog>,
    runtime: BotRuntime<S>,
    engine: Engine,
    host: ApplicationHost,
    sender: TwitchChatSender,
    logger: Option<Arc<Logger>>,
}

/// Explicitly asynchronous production assembly.
///
/// This is the **only** function in the tree that connects: it calls
/// [`DragonflyTimerStore::connect`], which reads `DRAGONFLY_HOST` and
/// `DRAGONFLY_PORT` through [`crate::utils::redis::get_redis_client`] and
/// verifies the connection with a `PING`. Everything else is
/// [`build_bot_runtime_over_store`].
pub async fn build_bot_runtime<S: CommandStore>(
    parts: BotRuntimeParts<S>,
) -> Result<BotTimerRuntime<S>, AstRuntimeError> {
    let store = DragonflyTimerStore::connect().await.map_err(timer_failure)?;
    Ok(build_bot_runtime_over_store(parts, store))
}

/// Same assembly, but the caller performs the connection and owns the key
/// layout.
///
/// Use this for an isolated validation run with
/// [`TimerNamespace::with_prefix`]; production must use
/// [`build_bot_runtime`], whose namespace is [`TimerNamespace::source`].
pub async fn build_bot_runtime_with_namespace<S: CommandStore>(
    parts: BotRuntimeParts<S>,
    namespace: TimerNamespace,
) -> Result<BotTimerRuntime<S>, AstRuntimeError> {
    let connection = crate::utils::redis::get_redis_client()
        .await
        .map_err(|error| AstRuntimeError::Host(format!("dragonfly timer store: {error}")))?;
    let store = DragonflyTimerStore::with_namespace(connection, namespace);
    Ok(build_bot_runtime_over_store(parts, store))
}

/// I/O-free core of the factory: wire the collaborators, build both
/// `ApplicationHost`s and the [`BotRuntime`], and install the catalog and the
/// timer scheduler.
///
/// `store` is an already-connected [`DragonflyTimerStore`]; this function
/// neither connects nor reads the environment.
pub fn build_bot_runtime_over_store<S: CommandStore>(
    parts: BotRuntimeParts<S>,
    store: DragonflyTimerStore,
) -> BotTimerRuntime<S> {
    let BotRuntimeParts {
        engine,
        cache,
        variables,
        directory,
        store: command_store,
        twitch,
        logger,
    } = parts;

    // One shared schedule, two scheduler values over the same connection and
    // namespace; see the module docs. `BotAstFunctions` owns the catalog value;
    // `BotTimerRuntime` owns the delivery value. Both arm and drain the same
    // `TimerScheduleHub`, so scheduling is immediately visible to the driver.
    let hub = TimerScheduleHub::new();
    let catalog_scheduler = AstTimerScheduler::with_hub(
        hub.clone(),
        store.clone(),
        SystemClock,
        DigestTimerIdSource::new(),
    );
    let delivery_scheduler =
        AstTimerScheduler::with_hub(hub, store, SystemClock, DigestTimerIdSource::new());

    let catalog = Arc::new(BotAstFunctions::with_twitch_and_logger(
        twitch.clone(),
        catalog_scheduler,
        logger.clone(),
    ));
    let functions: Arc<dyn AstFunctionCatalog> = Arc::clone(&catalog);
    let timer: Arc<dyn TimerScheduler> = Arc::clone(&catalog);

    let mut runtime = BotRuntime::new(
        engine.clone(),
        Arc::clone(&cache),
        Arc::clone(&variables),
        Arc::clone(&directory),
        command_store,
        twitch.clone(),
    );
    if let Some(logger) = &logger {
        runtime = runtime.with_logger(Arc::clone(logger));
    }
    let runtime = runtime.with_functions(functions, timer);

    // The host a fired job evaluates with. It gets the same catalog and timer as
    // the facade's hosts, so `chat.send`, `delay` and `HostRequest::ScheduleTimer`
    // behave identically from a timer body.
    let host = ApplicationHost::new(cache, variables)
        .with_functions(Arc::clone(&catalog))
        .with_timer(Arc::clone(&catalog));

    let sender = TwitchChatSender::with_optional_logger(twitch, logger.clone());

    BotTimerRuntime {
        scheduler: delivery_scheduler,
        catalog,
        runtime,
        engine,
        host,
        sender,
        logger,
    }
}

impl<S: CommandStore> BotTimerRuntime<S> {
    /// The delivery scheduler: reconcile it, then call [`Self::tick`].
    ///
    /// This is the value the owner drives. The catalog's scheduler is internal
    /// and only ever writes jobs, over the same [`TimerScheduleHub`] this value
    /// claims from.
    pub fn scheduler(&self) -> &ProductionTimerScheduler {
        &self.scheduler
    }

    pub fn scheduler_mut(&mut self) -> &mut ProductionTimerScheduler {
        &mut self.scheduler
    }

    /// The shared scheduling set (armed deadlines, stopped flag, cadence).
    pub fn hub(&self) -> TimerScheduleHub {
        self.scheduler.hub()
    }

    /// The function catalog, shared with both facade hosts.
    pub fn catalog(&self) -> &Arc<ProductionFunctionCatalog> {
        &self.catalog
    }

    /// The facade, for chat messages, deliveries and reference execution.
    pub fn runtime(&self) -> &BotRuntime<S> {
        &self.runtime
    }

    pub fn runtime_mut(&mut self) -> &mut BotRuntime<S> {
        &mut self.runtime
    }

    pub fn logger(&self) -> Option<&Arc<Logger>> {
        self.logger.as_ref()
    }

    /// Port of `startAstTimerScheduler` minus its module global.
    ///
    /// The source kept one `activeScheduler` per process and refused a second
    /// `start`. There is no global here: the caller owns exactly one
    /// [`BotTimerRuntime`] and calls this once, and `start` flips the shared
    /// [`TimerScheduleHub`] from stopped to running (so the catalog's `arm`
    /// becomes effective). Recovery happens inside `start`, so a first failure
    /// is returned and can be retried, while later reconcile failures are
    /// logged and retried one [`RECONCILE_MS`] cadence later, like the source's
    /// interval.
    pub async fn start(&mut self) -> Result<(), AstRuntimeError> {
        self.scheduler.start().await.map_err(timer_failure)
    }

    /// Execute one already-claimed job: rebuild, evaluate, deliver.
    pub async fn execute(&mut self, job: &AstTimerJob) -> Result<SendResult, AstRuntimeError> {
        let directory = Arc::clone(self.runtime.directory());
        execute_ast_timer_job(
            &self.engine,
            &mut self.host,
            &mut self.sender,
            &mut self.runtime,
            self.logger.as_ref(),
            directory.as_ref(),
            job,
        )
        .await
    }

    /// One scheduler pass: claim due jobs, execute each one, report the wake
    /// instant.
    ///
    /// `Ok(None)` means the scheduler is stopped. Otherwise the owner waits
    /// until [`TimerTick::wake_ms`] with [`Self::wait`] and calls `tick` again.
    /// Due jobs are claimed before the wake instant is computed, so a pass never
    /// sleeps while a job is due. A failed reconciliation is logged and its
    /// retry is scheduled one reconcile cadence out, so `wake_ms` stays in the
    /// future and the loop cannot spin on the cache.
    ///
    /// The claim returns owned jobs after every scheduler lock has been
    /// released, and the jobs are executed only after that: a timer body may
    /// schedule a nested timer through the catalog, and holding the scheduler
    /// lock across execution would deadlock. A job that was scheduled through
    /// the catalog after the previous pass is already armed in the shared hub,
    /// so it is claimed at its `dueAt`, not at the next reconcile pass.
    ///
    /// A failed execution is logged and counted, never retried: the claim
    /// already consumed the job.
    pub async fn tick(&mut self) -> Result<Option<TimerTick>, AstRuntimeError> {
        // Claim first; `claim_due` releases every scheduler lock before it
        // returns. Nothing below holds one while `execute` runs.
        let Some((jobs, wake_ms)) = self.scheduler.claim_due().await.map_err(timer_failure)? else {
            return Ok(None);
        };
        let mut delivered = 0usize;
        let mut failed = 0usize;
        for job in &jobs {
            match self.execute(job).await {
                Ok(_) => delivered += 1,
                Err(error) => {
                    failed += 1;
                    self.log_execution_failure(job, &error).await;
                }
            }
        }
        Ok(Some(TimerTick {
            delivered,
            failed,
            wake_ms,
        }))
    }

    /// Sleeps until the next real deadline, a new local arm, the reconcile
    /// cadence, or `wake_ms`.
    ///
    /// The owner's loop is `tick` → `wait(wake_ms)` → `tick`. Use this instead
    /// of a plain sleep on `wake_ms`: a timer scheduled through the function
    /// catalog while the driver sleeps wakes it early, so a short timer is not
    /// delivered late (the source armed a `setTimeout` immediately). The hub's
    /// reconcile cadence is honoured directly, so an older `wake_ms` cannot
    /// sleep past a due reconciliation. Ready work does not sleep at all — a
    /// deadline at or before `now` returns at once. The future is dropped with
    /// the loop, so an idle bot is not kept alive.
    pub async fn wait(&mut self, wake_ms: i64) -> i64 {
        self.scheduler.wait(wake_ms).await
    }

    /// Source `console.error('AST timer execution failed', { timerId, error })`.
    async fn log_execution_failure(&self, job: &AstTimerJob, error: &AstRuntimeError) {
        let channel_id = job.channel_id().ok();
        match &self.logger {
            Some(logger) => {
                let _ = logger
                    .log(
                        Level::Error,
                        serde_json::json!({
                            "message": "AST timer execution failed",
                            "timerId": job.id,
                            "channelID": channel_id.clone(),
                            "error": error.message(),
                        }),
                        LogOptions {
                            channel_id,
                            ..Default::default()
                        },
                    )
                    .await;
            }
            None => eprintln!(
                "AST timer execution failed (timer {}): {}",
                job.id,
                error.message()
            ),
        }
    }
}
