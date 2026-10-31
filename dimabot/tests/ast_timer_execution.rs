#![cfg(feature = "ast-bot-runtime")]
//! Behavioural checks for the fired-timer execution half of the native AST
//! timer runtime (`executeAstTimerJob` in
//! `dimabot/src/utils/ast_timer_runtime.ts`) and for the snapshot → context
//! rebuild that precedes it.
//!
//! Sources under test:
//!
//! - `src/utils/ast_timer_runtime.ts` (`executeAstTimerJob`, the job envelope,
//!   the enqueue/claim scripts, the caps and the 10-minute grace)
//! - `src/utils/ast_parser/timer.ts` (`snapshotTimerContext`, `TIMER_GRACE_MS`)
//! - `src/utils/ast_command_delivery.ts` (`deliverAstMessage` rules reused by
//!   the execution half)
//!
//! # Test strategy
//!
//! Every test in this file except [`private_dragonfly_lua_path_end_to_end`] is
//! in memory: a real [`Engine`], a real
//! [`ApplicationHost`](dima_rust::utils::ast_runtime::host::ApplicationHost),
//! the real delivery loop, and in-memory fakes only for the cache, the variable
//! store, the chat sender and the command runner. Nothing here talks to
//! Dragonfly, MongoDB, Twitch, the network or Docker.
//!
//! The one real-adapter test is `#[ignore]`d: it needs an execution lease and a
//! **private, uniquely named** Dragonfly/Redis instance supplied through
//! `DIMA_TEST_REDIS_URL`, and it owns its whole key namespace
//! (`dima:test:ast-timer:<pid>:<nanos>:…`) so it can never read or write live
//! timer keys. It is the only place that exercises the real Lua `EVAL` path.
//!
//! The "One shared schedule" section covers the factory wiring: two scheduler
//! values over one [`TimerScheduleHub`] (the function catalog's and the driver's)
//! must arm the same set, drain a normal-mode backlog in one pass, leave nothing
//! armed after a claim, deliver a 1-second timer at its deadline instead of the
//! next reconcile, and let a claimed body schedule a nested timer without
//! deadlocking on the catalog's scheduler lock. Those tests use only an
//! in-memory store, a fake clock and an in-memory id source.

use std::{
    cell::RefCell,
    collections::{BTreeMap, BTreeSet},
    rc::Rc,
    sync::{Arc, Mutex as StdMutex},
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use dima_rust::utils::{
    ast_evaluator::{
        CommandRefBudget, CommandReference, Context, EffectToken, ExecutionContext, Engine,
        JsString, JsValue, LoopVars, VariableStorage, json_parse, json_stringify,
        snapshot_timer_context,
    },
    ast_runtime::{
        AstCache, AstRuntimeError, AstScope, AstVariableStore, BoxFuture, ChatSender,
        CommandExecutionResult, CommandRunner, SendResult,
        bootstrap::{
            TimerStreamer, TimerStreamerDirectory, execute_ast_timer_job,
            restore_timer_application_context,
        },
        functions::{AstChatSend, AstDelayClock, BotAstFunctions},
        host::ApplicationHost,
    },
    ast_syntax::AstNode,
    ast_timer_runtime::{
        AST_TIMER_JOB_VERSION, AstTimerClock, AstTimerError, AstTimerIdSource, AstTimerJob,
        AstTimerScheduler, AstTimerStore, ClaimOutcome, DragonflyTimerStore, MAX_CHANNEL_TIMERS,
        MAX_PENDING_TIMERS, PendingTimer, RECONCILE_MS, TIMER_GRACE_MS, TimerEnqueue,
        TimerNamespace, TimerScheduleHub, enqueue_ast_timer, resume_timer_context,
    },
    logger::{
        CacheRecord, CacheSink, Logger, LoggerConfig, SinkFuture, SinkHandles, SystemClock,
        UuidSource,
    },
};

/// Fixed wall clock: 2026-10-31T00:00:00.000Z.
const NOW: i64 = 1_793_462_400_000;
const CHANNEL: &str = "chan-1";

fn lock<T>(mutex: &StdMutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn text(value: &JsValue) -> Option<String> {
    match value {
        JsValue::String(text) => text.to_utf8().ok(),
        _ => None,
    }
}

fn object(entries: Vec<(&str, JsValue)>) -> JsValue {
    JsValue::object(
        entries
            .into_iter()
            .map(|(key, value)| (JsString::from(key), value))
            .collect(),
    )
}

// ---------------------------------------------------------------------------
// In-memory seams
// ---------------------------------------------------------------------------

#[derive(Default)]
struct TestDirectory {
    fail: bool,
    account: Option<TimerStreamer>,
}

impl TimerStreamerDirectory for TestDirectory {
    fn lookup<'a>(
        &'a self,
        _channel: &'a str,
    ) -> BoxFuture<'a, Result<Option<TimerStreamer>, String>> {
        Box::pin(async move {
            if self.fail {
                Err("cache unavailable".into())
            } else {
                Ok(self.account.clone())
            }
        })
    }
}

/// Captures every logger cache record, so a diagnostic can be asserted without
/// a Dragonfly instance.
#[derive(Default)]
struct RecordingSink {
    records: StdMutex<Vec<CacheRecord>>,
}

impl CacheSink for RecordingSink {
    fn store(&self, record: CacheRecord) -> SinkFuture<'_> {
        lock(&self.records).push(record);
        Box::pin(async { Ok(()) })
    }
}

/// Accepts every record. Used when a test only needs the production logging
/// path to exist, not its output.
struct NullSink;

impl CacheSink for NullSink {
    fn store(&self, _record: CacheRecord) -> SinkFuture<'_> {
        Box::pin(async { Ok(()) })
    }
}

fn logger_over(sink: Arc<dyn CacheSink>) -> Arc<Logger> {
    Arc::new(
        Logger::new(
            LoggerConfig::default(),
            SinkHandles {
                cache: Some(sink),
                ..Default::default()
            },
            Arc::new(SystemClock),
            Arc::new(UuidSource),
        )
        .expect("logger config"),
    )
}

fn null_logger() -> Arc<Logger> {
    logger_over(Arc::new(NullSink))
}

/// Runs the actual-source oracle once and returns its cases.
fn oracle_cases() -> Vec<serde_json::Value> {
    let output = std::process::Command::new("node")
        .arg(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/tests/fixtures/ast_timer_context_reference.cjs"
        ))
        .output()
        .expect("node and the project TypeScript dependency are required");
    assert!(
        output.status.success(),
        "source oracle failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    let result: serde_json::Value =
        serde_json::from_slice(&output.stdout).expect("oracle JSON");
    result["cases"]
        .as_array()
        .expect("oracle cases")
        .clone()
}

fn oracle_case<'a>(
    cases: &'a [serde_json::Value],
    name: &str,
) -> &'a serde_json::Value {
    cases
        .iter()
        .find(|case| case["name"] == name)
        .unwrap_or_else(|| panic!("oracle case {name} is missing"))
}

/// The source-side expectations, read from the actual TypeScript. The native
/// comparison is the next test; these assertions fail if the fixture drifts
/// from the cases the native port is supposed to satisfy.
#[test]
fn typescript_context_oracle_exercises_actual_source() {
    let cases = oracle_cases();
    let plan = oracle_case(&cases, "live_streamer_and_saved_extra_wins_wholesale");
    assert_eq!(plan["expected"]["userPlan"], "pro");
    assert_eq!(plan["expected"]["streamer"]["name"], "live-name");
    assert_eq!(plan["expected"]["extraContext"]["userName"], "explicit");

    let scope = oracle_case(&cases, "missing_scope_fields_use_eventsub_name");
    assert_eq!(scope["expected"]["scopeName"], "Channel_Points");
    assert_eq!(scope["expected"]["scopeType"], "command");

    let identity = oracle_case(&cases, "missing_identity_fields_fall_back_to_saved_event");
    assert_eq!(identity["expected"]["userId"], "evt-id");
    assert_eq!(identity["expected"]["extraContext"]["userName"], "Evt Name");

    let broadcaster = oracle_case(&cases, "absent_identity_authorization_is_the_broadcaster_default");
    assert_eq!(broadcaster["expected"]["userLevel"], 10);
    assert_eq!(
        broadcaster["expected"]["authorization"]["identity"]["tags"][0],
        "broadcaster"
    );
}

/// Builds the native context summary in the same shape as the oracle's
/// `summarize`, using the evaluator's own effective-value accessors.
fn context_summary(context: &Context) -> JsValue {
    let context = context.borrow();
    JsValue::object(vec![
        ("streamer".into(), context.streamer.clone()),
        ("userId".into(), JsValue::string(&context.user_id)),
        ("userLogin".into(), JsValue::string(&context.user_login)),
        (
            "userDisplayName".into(),
            context.effective_user_display_name(),
        ),
        ("userPlan".into(), JsValue::string(&context.user_plan)),
        ("userLevel".into(), JsValue::Number(context.user_level)),
        (
            "enforceFunctionPermissions".into(),
            JsValue::Boolean(context.enforce_function_permissions),
        ),
        ("authorization".into(), context.authorization.clone()),
        ("argument".into(), context.effective_argument()),
        ("count".into(), JsValue::Number(context.count)),
        ("eventData".into(), context.event_data.clone()),
        ("eventsubData".into(), context.eventsub_data.clone()),
        ("extraContext".into(), context.extra_context.clone()),
        ("platform".into(), JsValue::string(&context.platform)),
        ("scopeType".into(), JsValue::string(&context.scope_type)),
        ("scopeName".into(), JsValue::string(&context.scope_name)),
        (
            "scopeAliases".into(),
            JsValue::Array(context.scope_aliases.clone()),
        ),
        ("commandName".into(), JsValue::string(&context.command_name)),
        ("commandId".into(), JsValue::string(&context.command_id)),
    ])
}

fn summary_field(summary: &JsValue, key: &str) -> serde_json::Value {
    match json_stringify(&summary.get(key)).expect("summary field stringifies") {
        Some(text) => serde_json::from_str(&text.to_utf8().expect("summary field is UTF-8"))
            .expect("summary field is JSON"),
        None => serde_json::Value::String("<undefined>".into()),
    }
}

/// Replays every actual-source case through the native rebuild and compares
/// the captured context field by field, including lookup failures, missing
/// keys, malformed values and the base/overlay precedence.
#[tokio::test]
async fn native_context_rebuild_matches_the_actual_source_oracle() {
    let cases = oracle_cases();
    assert!(cases.len() >= 16, "the oracle must keep its discriminating cases");
    let logger = null_logger();
    for case in &cases {
        let name = case["name"].as_str().expect("case name");
        let account = case["account"].as_object().map(|_| TimerStreamer {
            id: case["account"]["id"].as_str().unwrap_or_default().to_owned(),
            name: case["account"]["name"].as_str().unwrap_or_default().to_owned(),
            plan_tier: case["account"]["plan_tier"]
                .as_str()
                .unwrap_or_default()
                .to_owned(),
        });
        let directory = TestDirectory {
            fail: case["lookupFails"].as_bool().unwrap_or(false),
            account,
        };
        let saved = serde_json::to_string(&case["saved"]).expect("saved JSON");
        let snapshot = json_parse(&JsString::from(saved)).expect("snapshot parses");
        let (context, _scope) =
            restore_timer_application_context(&snapshot, &directory, Some(&logger))
                .await
                .unwrap_or_else(|error| panic!("{name}: rebuild failed: {error:?}"));
        let summary = context_summary(&context);
        let expected = case["expected"].as_object().expect("expected fields");
        for (key, value) in expected {
            assert_eq!(
                summary_field(&summary, key),
                *value,
                "{name}: field {key} diverges from the actual source"
            );
        }
    }
}

/// The source directory logs `{ function, id, error }` to both destinations and
/// returns null. The native adapter must leave the streamer null and still
/// emit exactly that diagnostic.
#[tokio::test]
async fn a_directory_failure_logs_the_source_diagnostic_and_returns_null() {
    let sink = Arc::new(RecordingSink::default());
    let logger = logger_over(sink.clone());
    let snapshot = object(vec![("broadcasterId", JsValue::string(CHANNEL))]);
    let (context, _scope) = restore_timer_application_context(
        &snapshot,
        &TestDirectory {
            fail: true,
            account: None,
        },
        Some(&logger),
    )
    .await
    .expect("a directory failure is null-on-error, not a job failure");

    assert!(matches!(context.borrow().streamer, JsValue::Null));
    let records = lock(&sink.records);
    assert_eq!(records.len(), 1, "one source-style error line");
    let entry: serde_json::Value =
        serde_json::from_str(&records[0].json).expect("log entry JSON");
    assert_eq!(entry["level"], "error");
    assert_eq!(entry["data"]["function"], "TwitchStreamers.getTwitchAccountById");
    assert_eq!(entry["data"]["id"], CHANNEL);
    assert_eq!(entry["data"]["error"], "cache unavailable");
    assert!(
        entry["channelId"].is_null(),
        "the source logs this failure without a channelId"
    );
}

#[tokio::test]
async fn fired_context_uses_live_streamer_and_saved_extra_wins_wholesale() {
    let snapshot = snapshot_timer_context(&context_for(CHANNEL));
    snapshot.set("userId", JsValue::string("saved-id"));
    snapshot.set("userLogin", JsValue::string("saved-login"));
    snapshot.set("userDisplayName", JsValue::string("saved-name"));
    snapshot.set(
        "eventData",
        object(vec![
            ("user_name", JsValue::string("event-name")),
            ("viewers", JsValue::Number(12.0)),
        ]),
    );
    snapshot.set(
        "extraContext",
        object(vec![("userName", JsValue::string("explicit"))]),
    );
    let directory = TestDirectory {
        account: Some(TimerStreamer {
            id: "live-id".into(),
            name: "live-name".into(),
            plan_tier: "pro".into(),
        }),
        fail: false,
    };
    let (context, scope) =
        restore_timer_application_context(&snapshot, &directory, None)
            .await
            .unwrap();
    let context = context.borrow();
    assert_eq!(
        text(&context.streamer.get("name")).as_deref(),
        Some("live-name")
    );
    assert_eq!(
        text(&context.extra_context.get("userName")).as_deref(),
        Some("explicit")
    );
    assert!(matches!(
        context.extra_context.get("viewers"),
        JsValue::Undefined
    ));
    // The snapshot always carries `userPlan` from the live context, so the
    // directory fallback only applies to a payload that omits it (covered by
    // the oracle cases); a present value must still win here.
    assert_eq!(context.user_plan, "free");
    assert_eq!(scope.user_id, "saved-id");
    assert_eq!(scope.user_login, "saved-login");
    assert_eq!(
        text(&context.event_data.get("user_name")).as_deref(),
        Some("event-name")
    );
}

#[tokio::test]
async fn missing_extra_is_derived_and_directory_failure_returns_null() {
    let snapshot = object(vec![
        ("broadcasterId", JsValue::string(CHANNEL)),
        ("userLogin", JsValue::string("")),
        (
            "eventData",
            object(vec![
                ("user_login", JsValue::string("fallback")),
                ("viewers", JsValue::string("12")),
                ("bits", JsValue::Number(0.0)),
                ("cheer", object(vec![("bits", JsValue::Number(7.0))])),
            ]),
        ),
    ]);
    let (context, scope) = restore_timer_application_context(
        &snapshot,
        &TestDirectory {
            fail: true,
            account: None,
        },
        None,
    )
    .await
    .unwrap();
    let context = context.borrow();
    assert!(matches!(context.streamer, JsValue::Null));
    assert_eq!(context.user_plan, "free");
    assert_eq!(scope.user_login, "fallback");
    assert_eq!(
        text(&context.extra_context.get("userLogin")).as_deref(),
        Some("fallback")
    );
    assert!(matches!(
        context.extra_context.get("viewers"),
        JsValue::Number(n) if n == 12.0
    ));
    assert!(matches!(
        context.extra_context.get("bits"),
        JsValue::Number(n) if n == 7.0
    ));
    // Missing scope keys are the source's base defaults, not invented values.
    assert_eq!(context.scope_type, "command");
    assert_eq!(context.scope_name, "default");
    assert_eq!(context.command_name, "default");
}

/// In-memory `AstCache`. No Dragonfly, no TTL bookkeeping beyond the map.
#[derive(Default)]
struct MemoryCache {
    values: StdMutex<BTreeMap<String, String>>,
}

impl AstCache for MemoryCache {
    fn get<'a>(&'a self, key: &'a str) -> BoxFuture<'a, Result<Option<String>, AstRuntimeError>> {
        Box::pin(async move { Ok(lock(&self.values).get(key).cloned()) })
    }

    fn exists<'a>(&'a self, key: &'a str) -> BoxFuture<'a, Result<bool, AstRuntimeError>> {
        Box::pin(async move { Ok(lock(&self.values).contains_key(key)) })
    }

    fn set<'a>(
        &'a self,
        key: &'a str,
        value: &'a str,
    ) -> BoxFuture<'a, Result<(), AstRuntimeError>> {
        Box::pin(async move {
            lock(&self.values).insert(key.to_owned(), value.to_owned());
            Ok(())
        })
    }

    fn expire<'a>(
        &'a self,
        _key: &'a str,
        _seconds: u64,
    ) -> BoxFuture<'a, Result<(), AstRuntimeError>> {
        Box::pin(async move { Ok(()) })
    }

    fn delete<'a>(&'a self, key: &'a str) -> BoxFuture<'a, Result<(), AstRuntimeError>> {
        Box::pin(async move {
            lock(&self.values).remove(key);
            Ok(())
        })
    }
}

/// In-memory `AstVariableStore`. `failing` makes every load report a host
/// failure, which is how the typed evaluation-error case is produced without a
/// network.
struct MemoryVariables {
    failing: bool,
}

impl MemoryVariables {
    fn working() -> Self {
        Self { failing: false }
    }

    fn failing() -> Self {
        Self { failing: true }
    }
}

impl AstVariableStore for MemoryVariables {
    fn load_channel_variable<'a>(
        &'a self,
        _scope: &'a AstScope,
        _name: &'a str,
    ) -> BoxFuture<'a, Result<String, AstRuntimeError>> {
        Box::pin(async move {
            if self.failing {
                return Err(AstRuntimeError::Host(
                    "variable store unavailable".to_owned(),
                ));
            }
            Ok(String::new())
        })
    }

    fn save_channel_variable<'a>(
        &'a self,
        _scope: &'a AstScope,
        _name: &'a str,
        _value: &'a str,
    ) -> BoxFuture<'a, Result<(), AstRuntimeError>> {
        Box::pin(async move { Ok(()) })
    }

    fn delete_channel_variable<'a>(
        &'a self,
        _scope: &'a AstScope,
        _name: &'a str,
    ) -> BoxFuture<'a, Result<(), AstRuntimeError>> {
        Box::pin(async move { Ok(()) })
    }

    fn load_user_variable<'a>(
        &'a self,
        _scope: &'a AstScope,
        _name: &'a str,
        _target_user_login: Option<&'a str>,
    ) -> BoxFuture<'a, Result<String, AstRuntimeError>> {
        Box::pin(async move {
            if self.failing {
                return Err(AstRuntimeError::Host(
                    "variable store unavailable".to_owned(),
                ));
            }
            Ok(String::new())
        })
    }

    fn save_user_variable<'a>(
        &'a self,
        _scope: &'a AstScope,
        _name: &'a str,
        _value: &'a str,
        _target_user_login: Option<&'a str>,
    ) -> BoxFuture<'a, Result<(), AstRuntimeError>> {
        Box::pin(async move { Ok(()) })
    }

    fn delete_user_variable<'a>(
        &'a self,
        _scope: &'a AstScope,
        _name: &'a str,
        _target_user_login: Option<&'a str>,
    ) -> BoxFuture<'a, Result<(), AstRuntimeError>> {
        Box::pin(async move { Ok(()) })
    }
}

/// Records every send; optionally fails like a rejected Twitch message.
#[derive(Default)]
struct RecordingSender {
    sends: StdMutex<Vec<(String, String)>>,
    fail_with: Option<String>,
}

impl RecordingSender {
    fn failing(message: &str) -> Self {
        Self {
            sends: StdMutex::default(),
            fail_with: Some(message.to_owned()),
        }
    }

    fn sends(&self) -> Vec<(String, String)> {
        lock(&self.sends).clone()
    }
}

impl ChatSender for RecordingSender {
    fn send<'a>(
        &'a mut self,
        channel_id: &'a str,
        text: &'a str,
    ) -> BoxFuture<'a, Result<SendResult, AstRuntimeError>> {
        Box::pin(async move {
            lock(&self.sends).push((channel_id.to_owned(), text.to_owned()));
            match &self.fail_with {
                Some(message) => Ok(SendResult::failure(message.clone(), 500)),
                None => Ok(SendResult::ok("sent")),
            }
        })
    }
}

/// Records every executed command reference and reports success with no reply,
/// so delivery neither sends nor recurses.
#[derive(Default)]
struct RecordingRunner {
    executed: StdMutex<Vec<String>>,
}

impl RecordingRunner {
    fn executed(&self) -> Vec<String> {
        lock(&self.executed).clone()
    }
}

impl CommandRunner for RecordingRunner {
    fn execute<'a>(
        &'a mut self,
        request: &'a CommandReference,
    ) -> BoxFuture<'a, Result<CommandExecutionResult, AstRuntimeError>> {
        Box::pin(async move {
            lock(&self.executed).push(request.command_name.clone());
            Ok(CommandExecutionResult::default())
        })
    }
}

fn app_host(variables: MemoryVariables) -> ApplicationHost {
    ApplicationHost::new(
        Arc::new(MemoryCache::default()) as Arc<dyn AstCache>,
        Arc::new(variables) as Arc<dyn AstVariableStore>,
    )
}

/// In-memory `AstTimerStore` that reproduces the accepted script semantics:
/// prune before the caps, payload plus both index entries, consume before the
/// claim returns, and the claim's due/expiry decisions.
#[derive(Clone, Default)]
struct FakeStore {
    inner: Arc<StdMutex<FakeStoreState>>,
}

#[derive(Default)]
struct FakeStoreState {
    payloads: BTreeMap<String, String>,
    pending: BTreeMap<String, i64>,
    channels: BTreeMap<String, BTreeMap<String, i64>>,
    enqueues: usize,
    claims: usize,
    /// `pending` calls, so a test can prove a failed pass is not retried early.
    pending_reads: usize,
    /// Injected `pending` failures, consumed one per call.
    fail_pending_reads: usize,
    /// The ids the last `pending` page actually contained.
    last_snapshot: Vec<String>,
}

impl FakeStore {
    fn new() -> Self {
        Self::default()
    }

    /// Same shared state, no extra seam: the catalog-side scheduler value in a
    /// test must not re-enter the interleaving decorator.
    fn sharing(&self) -> Self {
        Self {
            inner: Arc::clone(&self.inner),
        }
    }

    fn pending_ids(&self) -> Vec<String> {
        lock(&self.inner).pending.keys().cloned().collect()
    }

    fn payload(&self, id: &str) -> Option<String> {
        lock(&self.inner).payloads.get(id).cloned()
    }

    fn claims(&self) -> usize {
        lock(&self.inner).claims
    }

    fn enqueues(&self) -> usize {
        lock(&self.inner).enqueues
    }

    /// Number of `pending` reads, successful or not.
    fn pending_reads(&self) -> usize {
        lock(&self.inner).pending_reads
    }

    /// The ids of the last page this store returned, in score order.
    fn snapshot_ids(&self) -> Vec<String> {
        lock(&self.inner).last_snapshot.clone()
    }

    /// Fails the next `times` pending reads with a typed cache error.
    fn fail_next_pending_reads(&self, times: usize) {
        lock(&self.inner).fail_pending_reads = times;
    }
}

impl AstTimerStore for FakeStore {
    async fn enqueue(&mut self, request: &TimerEnqueue<'_>) -> Result<bool, AstTimerError> {
        let mut state = lock(&self.inner);
        // `ENQUEUE`: prune global scores at or before `now - grace`, then the
        // channel's scores at or before `now`.
        let stale_before = request.now_ms - TIMER_GRACE_MS;
        state.pending.retain(|_, due_at| *due_at > stale_before);
        for index in state.channels.values_mut() {
            index.retain(|_, expires_at| *expires_at > request.now_ms);
        }
        let pending_len = state.pending.len();
        let channel_len = state
            .channels
            .get(request.channel_id)
            .map_or(0, |index| index.len());
        if pending_len >= MAX_PENDING_TIMERS || channel_len >= MAX_CHANNEL_TIMERS {
            return Ok(false);
        }
        state
            .payloads
            .insert(request.id.to_owned(), request.payload.to_owned());
        state.pending.insert(request.id.to_owned(), request.due_at_ms);
        state
            .channels
            .entry(request.channel_id.to_owned())
            .or_default()
            .insert(request.id.to_owned(), request.expires_at_ms);
        state.enqueues += 1;
        Ok(true)
    }

    async fn load_payload(&mut self, id: &str) -> Result<Option<String>, AstTimerError> {
        Ok(lock(&self.inner).payloads.get(id).cloned())
    }

    async fn claim(
        &mut self,
        id: &str,
        channel_id: &str,
        now_ms: i64,
    ) -> Result<Option<String>, AstTimerError> {
        let mut state = lock(&self.inner);
        state.claims += 1;
        let Some(payload) = state.payloads.get(id).cloned() else {
            state.pending.remove(id);
            return Ok(None);
        };
        let due_at = state.pending.get(id).copied().unwrap_or_default();
        if due_at > now_ms {
            return Ok(None);
        }
        let expires_at = state
            .channels
            .get(channel_id)
            .and_then(|index| index.get(id).copied())
            .unwrap_or(i64::MIN);
        state.payloads.remove(id);
        state.pending.remove(id);
        if let Some(index) = state.channels.get_mut(channel_id) {
            index.remove(id);
        }
        if expires_at <= now_ms {
            return Ok(None);
        }
        Ok(Some(payload))
    }

    async fn prune_pending(&mut self, max_score_ms: i64) -> Result<usize, AstTimerError> {
        let mut state = lock(&self.inner);
        let before = state.pending.len();
        state.pending.retain(|_, due_at| *due_at > max_score_ms);
        Ok(before - state.pending.len())
    }

    async fn pending(&mut self, limit: usize) -> Result<Vec<PendingTimer>, AstTimerError> {
        let mut entries: Vec<PendingTimer> = {
            let state = lock(&self.inner);
            state
                .pending
                .iter()
                .map(|(id, due_at)| PendingTimer {
                    id: id.clone(),
                    due_at_ms: *due_at,
                })
                .collect()
        };
        entries.sort_by(|left, right| {
            left.due_at_ms
                .cmp(&right.due_at_ms)
                .then_with(|| left.id.cmp(&right.id))
        });
        entries.truncate(limit);
        {
            let mut state = lock(&self.inner);
            state.pending_reads += 1;
            if state.fail_pending_reads > 0 {
                state.fail_pending_reads -= 1;
                return Err(AstTimerError::Redis(redis::RedisError::from(
                    std::io::Error::other("simulated reconcile read failure"),
                )));
            }
            state.last_snapshot = entries.iter().map(|entry| entry.id.clone()).collect();
        }
        Ok(entries)
    }

    async fn drop_pending(&mut self, id: &str) -> Result<bool, AstTimerError> {
        Ok(lock(&self.inner).pending.remove(id).is_some())
    }
}

/// The "a concurrent `schedule` landed while reconcile was reading" seam.
///
/// [`InterleavingStore`] delegates every call to a [`FakeStore`], but its
/// `pending` runs one prepared schedule *after* the page has been read. That is
/// exactly the window between `reconcile`'s cache read and its local rebuild,
/// reproduced deterministically — no threads, no sleeps, no timing assumption.
struct InterleavingStore {
    inner: FakeStore,
    /// Shared with the test, so the seam can be installed after `start` and the
    /// interleaved job observed. One shot: `pending` takes it.
    pending_schedule: Rc<RefCell<Option<PendingSchedule>>>,
}

/// Work that a "concurrent" `$(timer …)` would do while reconcile reads.
struct PendingSchedule {
    scheduler: AstTimerScheduler<FakeStore, TestClock, CountingIds>,
    body: AstNode,
    context: Context,
    recorded: Rc<RefCell<Vec<AstTimerJob>>>,
}

impl InterleavingStore {
    fn new(inner: FakeStore, pending_schedule: Rc<RefCell<Option<PendingSchedule>>>) -> Self {
        Self {
            inner,
            pending_schedule,
        }
    }
}

impl AstTimerStore for InterleavingStore {
    async fn enqueue(&mut self, request: &TimerEnqueue<'_>) -> Result<bool, AstTimerError> {
        self.inner.enqueue(request).await
    }

    async fn load_payload(&mut self, id: &str) -> Result<Option<String>, AstTimerError> {
        self.inner.load_payload(id).await
    }

    async fn claim(
        &mut self,
        id: &str,
        channel_id: &str,
        now_ms: i64,
    ) -> Result<Option<String>, AstTimerError> {
        self.inner.claim(id, channel_id, now_ms).await
    }

    async fn prune_pending(&mut self, max_score_ms: i64) -> Result<usize, AstTimerError> {
        self.inner.prune_pending(max_score_ms).await
    }

    async fn pending(&mut self, limit: usize) -> Result<Vec<PendingTimer>, AstTimerError> {
        // The page is captured first: this is the stale snapshot.
        let page = self.inner.pending(limit).await?;
        let scheduled = self.pending_schedule.borrow_mut().take();
        if let Some(mut scheduled) = scheduled {
            let PendingSchedule {
                scheduler,
                body,
                context,
                recorded,
            } = &mut scheduled;
            // The catalog-side value writes the payload and arms the shared hub,
            // exactly as `HostRequest::ScheduleTimer` does mid-read.
            let job = scheduler.schedule(0.0, body, context).await?;
            recorded.borrow_mut().push(job);
        }
        Ok(page)
    }

    async fn drop_pending(&mut self, id: &str) -> Result<bool, AstTimerError> {
        self.inner.drop_pending(id).await
    }
}

/// Accepts every chat send, like a healthy Twitch adapter.
struct NullChat;
impl AstChatSend for NullChat {
    fn send<'a>(
        &'a self,
        _channel_id: &'a str,
        _message: &'a str,
    ) -> BoxFuture<'a, Result<SendResult, AstRuntimeError>> {
        Box::pin(async { Ok(SendResult::ok("sent")) })
    }
}

/// A `delay` that costs no wall-clock time.
struct NoDelay;

impl AstDelayClock for NoDelay {
    fn sleep_millis<'a>(&'a self, _millis: u64) -> BoxFuture<'a, ()> {
        Box::pin(async {})
    }
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

fn context_for(channel: &str) -> Context {
    let mut execution = ExecutionContext::default();
    execution.broadcaster_id = channel.to_owned();
    execution.user_id = "user-1".to_owned();
    execution.user_login = "viewer".to_owned();
    execution.user_display_name = "Viewer".to_owned();
    // A timer body may only schedule another timer on a Twitch channel; the
    // snapshot carries this value, so the nested-timer test needs it set.
    execution.platform = "twitch".to_owned();
    execution.into_context()
}

fn literal(value: &str) -> AstNode {
    AstNode::Literal {
        value: value.to_owned(),
    }
}

fn root(children: Vec<AstNode>) -> AstNode {
    AstNode::Root { children }
}

fn timer_job(body: AstNode, context: &Context) -> AstTimerJob {
    AstTimerJob {
        version: AST_TIMER_JOB_VERSION,
        id: "timer-1".to_owned(),
        due_at: NOW,
        expires_at: NOW + TIMER_GRACE_MS,
        body,
        context: snapshot_timer_context(context),
    }
}

// ---------------------------------------------------------------------------
// Snapshot → context rebuild
// ---------------------------------------------------------------------------

#[test]
fn resume_restores_every_carried_field_and_invents_nothing() {
    let mut execution = ExecutionContext::default();
    execution.broadcaster_id = CHANNEL.to_owned();
    execution.user_id = "user-1".to_owned();
    execution.user_login = "viewer".to_owned();
    execution.user_display_name = "Viewer".to_owned();
    execution.user_plan = "premium".to_owned();
    execution.user_level = 7.0;
    execution.enforce_function_permissions = false;
    execution.authorization = object(vec![("origin", JsValue::string("authored"))]);
    execution.argument = Some(JsString::from("hello"));
    execution.count = 3.0;
    execution.event_data = object(vec![("chatter_user_login", JsValue::string("viewer"))]);
    execution.eventsub_data = object(vec![("name", JsValue::string("reward"))]);
    execution.extra_context = object(vec![("reward", JsValue::string("title"))]);
    execution.platform = "twitch".to_owned();
    execution.scope_type = "command".to_owned();
    execution.scope_name = "hello".to_owned();
    execution.scope_aliases = Rc::new(RefCell::new(vec![JsValue::string("alias")]));
    execution.command_name = "cmd".to_owned();
    execution.command_id = "id-1".to_owned();
    execution.command_ref_budget = Rc::new(RefCell::new(CommandRefBudget { remaining: 12.0 }));
    execution.command_ref_depth = Some(2.0);
    execution.visited_commands = Some(Rc::new(RefCell::new(vec![
        "chan-1:ping".to_owned(),
        "chan-1:ping".to_owned(),
    ])));
    execution.command_responses.borrow_mut().push(JsValue::string("line"));
    execution
        .variables
        .borrow_mut()
        .insert("name".to_owned(), JsValue::string("Original"));
    execution.arrays.borrow_mut().insert(
        "list".to_owned(),
        JsValue::array(vec![JsValue::Number(1.0)]),
    );
    let loop_vars = LoopVars::default();
    loop_vars.insert("i".to_owned(), JsString::from("3"));
    execution.loop_vars = Some(loop_vars);
    execution.timer_depth = Some(1.0);
    let context = execution.into_context();

    let snapshot = snapshot_timer_context(&context);
    let resumed = resume_timer_context(&snapshot).expect("a complete snapshot resumes");
    let resumed = resumed.borrow();

    assert_eq!(resumed.broadcaster_id, CHANNEL);
    assert_eq!(resumed.user_id, "user-1");
    assert_eq!(resumed.user_login, "viewer");
    assert_eq!(resumed.user_display_name, "Viewer");
    assert_eq!(resumed.user_plan, "premium");
    assert_eq!(resumed.user_level, 7.0);
    assert!(!resumed.enforce_function_permissions);
    assert_eq!(resumed.count, 3.0);
    assert_eq!(resumed.platform, "twitch");
    assert_eq!(resumed.scope_type, "command");
    assert_eq!(resumed.scope_name, "hello");
    assert_eq!(resumed.command_name, "cmd");
    assert_eq!(resumed.command_id, "id-1");
    assert_eq!(resumed.command_ref_depth, Some(2.0));
    assert_eq!(resumed.command_ref_budget.borrow().remaining, 12.0);

    assert_eq!(
        text(&resumed.authorization.get("origin")).as_deref(),
        Some("authored")
    );
    assert_eq!(
        text(&resumed.effective_argument()).as_deref(),
        // `argument` round-trips through its effective value.
        Some("hello")
    );
    assert_eq!(
        text(&resumed.event_data.get("chatter_user_login")).as_deref(),
        Some("viewer")
    );
    assert_eq!(
        text(&resumed.eventsub_data.get("name")).as_deref(),
        Some("reward")
    );
    assert_eq!(
        text(&resumed.extra_context.get("reward")).as_deref(),
        Some("title")
    );
    assert_eq!(resumed.scope_aliases.borrow().len(), 1);
    assert_eq!(resumed.command_responses.borrow().len(), 1);

    // `new Set(saved.visitedCommands)`: duplicates collapse, order is kept.
    let visited = resumed
        .visited_commands
        .as_ref()
        .expect("visited commands are restored");
    assert_eq!(*visited.borrow(), vec!["chan-1:ping".to_owned()]);

    // `new Map(saved.variables)` / `new Map(saved.arrays)` / loop vars.
    let variables = resumed.variables.borrow();
    assert_eq!(
        variables.get("name").and_then(text).as_deref(),
        Some("Original")
    );
    let arrays = resumed.arrays.borrow();
    assert!(matches!(
        arrays.get("list"),
        Some(JsValue::Array(values)) if values.borrow().len() == 1
    ));
    assert_eq!(
        resumed.loop_vars.as_ref().and_then(|vars| vars.get("i")),
        Some(JsString::from("3"))
    );

    // Nothing invented: the snapshot does not carry these, so the defaults stay.
    assert!(matches!(resumed.streamer, JsValue::Null));
    assert!(resumed.command_variables.borrow().is_empty());
    assert!(resumed.user_command_variables.borrow().is_empty());
    assert_eq!(resumed.loop_depth, Some(0.0));
    assert_eq!(resumed.count_modified, Some(false));
    assert!(resumed.user_display_name_override.is_none());
    assert!(resumed.argument_override.is_none());
}

#[test]
fn timer_depth_is_incremented_once_across_the_cache_boundary() {
    let context = context_for(CHANNEL);
    context.borrow_mut().timer_depth = Some(1.0);

    let snapshot = snapshot_timer_context(&context);
    // `snapshotTimerContext`: `(ctx.timerDepth ?? 0) + 1`.
    assert_eq!(
        match snapshot.get("timerDepth") {
            JsValue::Number(value) => Some(value),
            _ => None,
        },
        Some(2.0)
    );

    let first = resume_timer_context(&snapshot).expect("resume");
    assert_eq!(first.borrow().timer_depth, Some(2.0));
    // Resuming the same snapshot twice must not increment again.
    let second = resume_timer_context(&snapshot).expect("resume");
    assert_eq!(second.borrow().timer_depth, Some(2.0));
}

#[test]
fn resumed_context_has_no_effect_authority() {
    let context = context_for(CHANNEL);
    context.borrow_mut().effect_context = Some(EffectToken::from_host(String::from("live")));

    let snapshot = snapshot_timer_context(&context);
    assert!(
        matches!(snapshot.get("effectContext"), JsValue::Undefined),
        "effect authority must never cross the cache boundary"
    );

    let resumed = resume_timer_context(&snapshot).expect("resume");
    assert!(
        resumed.borrow().effect_context.is_none(),
        "a timer never resumes with live event-effect authority"
    );
}

#[test]
fn a_snapshot_without_a_broadcaster_is_a_typed_failure() {
    let snapshot = JsValue::object(vec![(
        JsString::from("userId"),
        JsValue::string("user-1"),
    )]);
    let error = resume_timer_context(&snapshot).expect_err("no broadcaster, no context");
    assert!(
        matches!(error, AstTimerError::JobDecoding { .. }),
        "unexpected error: {error:?}"
    );
    assert!(error.to_string().contains("broadcasterId"));
}

// ---------------------------------------------------------------------------
// Fired-timer execution
// ---------------------------------------------------------------------------

#[tokio::test]
async fn a_failing_evaluation_returns_a_typed_error_instead_of_panicking() {
    let engine = Engine::default();
    let mut host = app_host(MemoryVariables::failing());
    let mut sender = RecordingSender::default();
    let mut runner = RecordingRunner::default();
    let context = context_for(CHANNEL);
    // A `db` variable read reaches the host, which reports a failure. The body
    // has no try/catch, so the evaluation fails instead of inventing a value.
    let job = timer_job(
        root(vec![AstNode::GetVar {
            name: "missing".to_owned(),
            storage: VariableStorage::Db,
            accessor: None,
            user_selector: None,
        }]),
        &context,
    );

    let error = execute_ast_timer_job(&engine, &mut host, &mut sender, &mut runner, None, &TestDirectory::default(), &job)
        .await
        .expect_err("the host failure must surface");
    match &error {
        AstRuntimeError::Host(message) => {
            assert!(message.contains("variable store unavailable"), "{message}");
        }
        other => panic!("unexpected error kind: {other:?}"),
    }
    assert!(
        sender.sends().is_empty(),
        "nothing may be delivered after a failed evaluation"
    );
    assert!(runner.executed().is_empty());
}

#[tokio::test]
async fn a_delivery_failure_is_propagated_with_the_source_message() {
    let engine = Engine::default();
    let mut host = app_host(MemoryVariables::working());
    let mut sender = RecordingSender::failing("moderation hold");
    let mut runner = RecordingRunner::default();
    let context = context_for(CHANNEL);
    let job = timer_job(root(vec![literal("hello there")]), &context);

    let error = execute_ast_timer_job(&engine, &mut host, &mut sender, &mut runner, None, &TestDirectory::default(), &job)
        .await
        .expect_err("`if (sent.error) throw new Error(sent.message)`");
    match &error {
        AstRuntimeError::Rejected(message) => assert_eq!(message, "moderation hold"),
        other => panic!("unexpected error kind: {other:?}"),
    }
    // The source sends the rendered text first; the reference queue is not
    // executed after a failed outer send.
    assert_eq!(
        sender.sends(),
        vec![(CHANNEL.to_owned(), "hello there".to_owned())]
    );
    assert!(runner.executed().is_empty());
}

#[tokio::test]
async fn execution_delivers_the_rendered_text_then_the_command_references() {
    let engine = Engine::default();
    let mut host = app_host(MemoryVariables::working());
    let mut sender = RecordingSender::default();
    let mut runner = RecordingRunner::default();
    let context = context_for(CHANNEL);
    context.borrow_mut().enforce_function_permissions = false;
    context.borrow_mut().authorization = object(vec![("origin", JsValue::string("authored"))]);
    // `result.value` is the rendered text; the `commandRef` contributes no text
    // but queues one reference for delivery.
    let job = timer_job(
        root(vec![
            literal("hello there"),
            AstNode::CommandRef {
                command_name: "ping".to_owned(),
                args: Vec::new(),
            },
        ]),
        &context,
    );

    let sent = execute_ast_timer_job(&engine, &mut host, &mut sender, &mut runner, None, &TestDirectory::default(), &job)
        .await
        .expect("delivery must succeed");
    assert!(!sent.error);
    assert_eq!(sent.message, "AST message delivered");
    assert_eq!(
        sender.sends(),
        vec![(CHANNEL.to_owned(), "hello there".to_owned())],
        "the outer text is sent once, trimmed, before any reference"
    );
    assert_eq!(runner.executed(), vec!["ping".to_owned()]);
}

#[tokio::test]
async fn a_timer_body_is_evaluated_in_the_resumed_context_not_the_live_one() {
    let engine = Engine::default();
    let mut host = app_host(MemoryVariables::working());
    let mut sender = RecordingSender::default();
    let mut runner = RecordingRunner::default();
    let context = context_for(CHANNEL);
    // The live context renders one value; the job snapshot carries it, and the
    // execution half must use the snapshot, not a later mutation.
    context
        .borrow_mut()
        .variables
        .borrow_mut()
        .insert("name".to_owned(), JsValue::string("snapshotted"));
    let job = timer_job(
        root(vec![AstNode::GetVar {
            name: "name".to_owned(),
            storage: VariableStorage::Memory,
            accessor: None,
            user_selector: None,
        }]),
        &context,
    );
    context
        .borrow_mut()
        .variables
        .borrow_mut()
        .insert("name".to_owned(), JsValue::string("mutated-later"));

    execute_ast_timer_job(&engine, &mut host, &mut sender, &mut runner, None, &TestDirectory::default(), &job)
        .await
        .expect("delivery must succeed");
    assert_eq!(
        sender.sends(),
        vec![(CHANNEL.to_owned(), "snapshotted".to_owned())]
    );
}

// ---------------------------------------------------------------------------
// One shared schedule: arming, backlog, idle/future-due and nested timers
// ---------------------------------------------------------------------------

/// The factory used to build two independent scheduler maps, so a job written by
/// the function catalog reached the driver (if at all) only at the next reconcile
/// pass: a 1-second timer could be delivered up to `RECONCILE_MS` late, and the
/// catalog's own armed entries were never drained. Both values now share one
/// [`TimerScheduleHub`], which is the source's single `activeScheduler`.
#[tokio::test]
async fn scheduling_through_the_shared_hub_arms_the_one_driver_immediately() {
    let hub = TimerScheduleHub::new();
    let store = FakeStore::new();
    let clock = TestClock::new(NOW);
    let mut driver = AstTimerScheduler::with_hub(
        hub.clone(),
        store.clone(),
        clock.clone(),
        CountingIds::default(),
    );
    driver.start().await.expect("driver start");
    // The catalog's scheduler value in `bootstrap.rs`: same hub, same store, its
    // own id source.
    let mut catalog_side = AstTimerScheduler::with_hub(
        hub.clone(),
        store.clone(),
        clock.clone(),
        CountingIds::starting(1_000),
    );
    let context = context_for(CHANNEL);

    let job = catalog_side
        .schedule(1.0, &root(vec![literal("one second")]), &context)
        .await
        .expect("a 1-second timer is accepted by the store");

    // The fixed behaviour: the job is armed in the one set and the driver's next
    // wake is its `dueAt`, not the 2-second reconcile cadence.
    assert_eq!(job.due_at, NOW + 1_000);
    assert!(hub.is_armed(&job.id));
    assert!(driver.is_armed(&job.id));
    assert_eq!(driver.next_deadline_ms(), Some(job.due_at));
    assert_eq!(driver.next_wake_ms(NOW), job.due_at);
    assert!(driver.next_wake_ms(NOW) < NOW + RECONCILE_MS);

    // A pass at `dueAt` claims it without waiting for reconcile, and the claim
    // leaves nothing armed.
    clock.set(job.due_at);
    let pass = driver.step().await.expect("step").expect("running");
    assert_eq!(pass.jobs.len(), 1);
    assert_eq!(pass.jobs[0].id, job.id);
    assert_eq!(hub.armed_len(), 0);
    assert!(!hub.is_armed(&job.id));
    assert!(store.pending_ids().is_empty());

    // Nothing is replayed: the claim consumed the job.
    let again = driver.step().await.expect("step").expect("running");
    assert!(again.jobs.is_empty());

    // Source `arm` semantics survive: a stopped schedule writes the job but does
    // not arm it (`if (this.stopped || this.timers.has(id)) return`).
    driver.stop();
    let stopped = catalog_side
        .schedule(1.0, &root(vec![literal("after stop")]), &context)
        .await
        .expect("the store still accepts a job while stopped");
    assert!(!hub.is_armed(&stopped.id));
    assert!(store.payload(&stopped.id).is_some());
}

#[tokio::test]
async fn idle_and_future_due_work_wait_for_real_deadlines_without_spinning() {
    let hub = TimerScheduleHub::new();
    let store = FakeStore::new();
    let clock = TestClock::new(NOW);
    let mut driver = AstTimerScheduler::with_hub(
        hub.clone(),
        store.clone(),
        clock.clone(),
        CountingIds::default(),
    );
    driver.start().await.expect("driver start");
    let context = context_for(CHANNEL);

    // Idle: a pass claims nothing and its only wake target is the cadence.
    let idle = driver.step().await.expect("step").expect("running");
    assert!(idle.jobs.is_empty());
    assert_eq!(idle.wake_ms, NOW + RECONCILE_MS);
    assert!(idle.wake_ms > NOW, "an idle pass must not report a past wake");

    // Future-due work is armed but never delivered early, and the cadence — not
    // the far deadline — is the next wake target.
    let future = driver
        .schedule(60.0, &root(vec![literal("a minute")]), &context)
        .await
        .expect("far timer");
    let idle = driver.step().await.expect("step").expect("running");
    assert!(idle.jobs.is_empty(), "a job is never claimed before dueAt");
    assert_eq!(idle.wake_ms, NOW + RECONCILE_MS);
    assert_eq!(driver.next_wake_ms(NOW), NOW + RECONCILE_MS);

    // A nearer deadline armed later moves the wake target at once.
    let soon = driver
        .schedule(1.0, &root(vec![literal("one second")]), &context)
        .await
        .expect("near timer");
    assert!(soon.due_at < future.due_at);
    assert_eq!(driver.next_wake_ms(NOW), soon.due_at);

    // Ready work never sleeps: a deadline at `now` returns the wait at once,
    // even when the caller asked for a later instant.
    let ready = driver
        .schedule(0.0, &root(vec![literal("ready")]), &context)
        .await
        .expect("ready timer");
    assert_eq!(ready.due_at, NOW);
    assert_eq!(driver.wait(NOW + RECONCILE_MS).await, NOW);

    // The ready and soon jobs are both claimed in one pass; the future job is
    // not.
    clock.set(soon.due_at);
    let due = driver.step().await.expect("step").expect("running");
    assert_eq!(due.jobs.len(), 2);
    let claimed: BTreeSet<&str> = due.jobs.iter().map(|job| job.id.as_str()).collect();
    assert!(claimed.contains(ready.id.as_str()));
    assert!(claimed.contains(soon.id.as_str()));
    assert!(!claimed.contains(future.id.as_str()));

    // The far job is delivered only at its own deadline, and the backlog is
    // empty afterwards.
    clock.set(future.due_at);
    let due = driver.step().await.expect("step").expect("running");
    assert_eq!(due.jobs.len(), 1);
    assert_eq!(due.jobs[0].id, future.id);
    assert_eq!(hub.armed_len(), 0);
    assert!(store.pending_ids().is_empty());
    assert_eq!(store.claims(), 3);
}

/// A `$(timer …)` that is enqueued *and* armed while the reconcile cache read is
/// in flight is absent from the page that read returns. Rebuilding by "keep only
/// the ids the page listed" deleted that live arm, so the delivery slipped to the
/// next reconcile pass (up to `RECONCILE_MS` late). The arm must survive and be
/// claimed at its own `dueAt`.
#[tokio::test]
async fn reconcile_keeps_an_arm_created_while_its_snapshot_was_in_flight() {
    let hub = TimerScheduleHub::new();
    let store = FakeStore::new();
    let clock = TestClock::new(NOW);
    let seam: Rc<RefCell<Option<PendingSchedule>>> = Rc::new(RefCell::new(None));
    let mut driver = AstTimerScheduler::with_hub(
        hub.clone(),
        InterleavingStore::new(store.clone(), Rc::clone(&seam)),
        clock.clone(),
        CountingIds::default(),
    );
    driver.start().await.expect("driver start");
    let context = context_for(CHANNEL);

    // The catalog-side value over the same hub and the same shared store state.
    let scheduling = AstTimerScheduler::with_hub(
        hub.clone(),
        store.sharing(),
        clock.clone(),
        CountingIds::starting(1_000),
    );
    let recorded: Rc<RefCell<Vec<AstTimerJob>>> = Rc::new(RefCell::new(Vec::new()));
    *seam.borrow_mut() = Some(PendingSchedule {
        scheduler: scheduling,
        body: root(vec![literal("meanwhile")]),
        context,
        recorded: Rc::clone(&recorded),
    });

    // Reaching the cadence makes this pass reconcile; the seam runs inside the
    // cache read, i.e. after the page was captured and before the rebuild.
    clock.set(NOW + RECONCILE_MS);
    let pass = driver.step().await.expect("step").expect("running");
    assert!(
        pass.jobs.is_empty(),
        "a job armed during the read is claimed by the following pass, not this one"
    );
    let job = recorded
        .borrow()
        .first()
        .cloned()
        .expect("the interleaved schedule ran inside the read");
    assert_eq!(job.due_at, NOW + RECONCILE_MS);
    assert!(
        store.snapshot_ids().is_empty(),
        "the page really was read before the concurrent schedule: {0:?}",
        store.snapshot_ids()
    );
    assert_eq!(store.pending_ids(), vec![job.id.clone()]);
    assert!(
        driver.is_armed(&job.id),
        "reconcile must not delete an arm newer than its own snapshot"
    );
    assert_eq!(driver.next_deadline_ms(), Some(job.due_at));
    assert_eq!(pass.wake_ms, job.due_at);

    // Delivered by the very next pass at its own deadline, not at the next
    // reconciliation.
    let due = driver.step().await.expect("step").expect("running");
    assert_eq!(due.jobs.len(), 1);
    assert_eq!(due.jobs[0].id, job.id);
    assert!(store.pending_ids().is_empty());
    assert_eq!(hub.armed_len(), 0, "the claim leaves nothing armed");
    assert_eq!(store.claims(), 1);
}

/// A failed reconcile must behave like the source's 2-second interval: one
/// attempt per cadence, no spin on the cache, no loss of existing arms — and the
/// next successful pass recovers the job it missed.
#[tokio::test]
async fn a_failed_reconcile_retries_at_the_source_cadence_and_then_recovers() {
    let hub = TimerScheduleHub::new();
    let store = FakeStore::new();
    let clock = TestClock::new(NOW);
    let mut driver = AstTimerScheduler::with_hub(
        hub.clone(),
        store.clone(),
        clock.clone(),
        CountingIds::default(),
    );
    driver.start().await.expect("driver start");
    let context = context_for(CHANNEL);

    // A timer written by another producer: it has no local arm, so only a
    // successful reconcile can discover it.
    let mut producer_store = store.clone();
    let hidden = enqueue_ast_timer(
        &mut producer_store,
        &clock,
        &mut CountingIds::starting(2_000),
        0.0,
        &root(vec![literal("from the cache")]),
        &context,
    )
    .await
    .expect("producer-side enqueue");
    assert!(!hub.is_armed(&hidden.id), "an external write arms nothing");

    // A far timer keeps a live arm across the failures.
    let far = driver
        .schedule(600.0, &root(vec![literal("far")]), &context)
        .await
        .expect("far timer");
    assert!(hub.is_armed(&far.id));

    store.fail_next_pending_reads(2);
    let reads_before = store.pending_reads();

    // Cadence reached: the pass reads, fails, reports it and schedules a retry.
    clock.set(NOW + RECONCILE_MS);
    let failed = driver
        .step()
        .await
        .expect("a failed reconcile is logged, not returned")
        .expect("running");
    assert!(failed.jobs.is_empty());
    assert_eq!(
        store.pending_reads(),
        reads_before + 1,
        "one cache read per cadence, not a spin"
    );
    assert!(
        failed.wake_ms > clock.now_ms(),
        "a failed pass must not report a past wake"
    );
    assert_eq!(failed.wake_ms, clock.now_ms() + RECONCILE_MS);
    assert!(hub.is_armed(&far.id), "a failed read proves nothing stale");
    assert!(!hub.is_armed(&hidden.id), "a failed read discovers nothing");

    // An immediate second pass must not retry before the scheduled cadence.
    let idle = driver.step().await.expect("step").expect("running");
    assert_eq!(
        store.pending_reads(),
        reads_before + 1,
        "no retry before the scheduled cadence"
    );
    assert_eq!(idle.wake_ms, failed.wake_ms);

    // The scheduled retry fails too and re-arms the cadence.
    clock.set(failed.wake_ms);
    let retried = driver.step().await.expect("step").expect("running");
    assert_eq!(store.pending_reads(), reads_before + 2);
    assert_eq!(retried.wake_ms, clock.now_ms() + RECONCILE_MS);
    assert!(hub.is_armed(&far.id));
    assert!(!hub.is_armed(&hidden.id));

    // The next attempt succeeds and recovers the externally written job.
    clock.set(retried.wake_ms);
    let recovered = driver.step().await.expect("step").expect("running");
    assert!(
        recovered.jobs.is_empty(),
        "discovery happens after the claim loop; ready work is claimed by the next pass"
    );
    assert!(hub.is_armed(&hidden.id), "the recovered timer is armed");
    assert_eq!(hub.next_deadline_ms(), Some(hidden.due_at));
    assert_eq!(
        recovered.wake_ms,
        clock.now_ms(),
        "ready work is never slept on"
    );

    let delivered = driver.step().await.expect("step").expect("running");
    assert_eq!(delivered.jobs.len(), 1);
    assert_eq!(delivered.jobs[0].id, hidden.id);
    assert_eq!(store.pending_ids(), vec![far.id.clone()]);
    assert!(hub.is_armed(&far.id), "the far timer is untouched");
    assert_eq!(hub.armed_len(), 1);
}

#[tokio::test]
async fn a_normal_mode_backlog_is_claimed_in_one_pass_and_retains_nothing() {
    const BACKLOG: usize = 64;

    let hub = TimerScheduleHub::new();
    let store = FakeStore::new();
    let clock = TestClock::new(NOW);
    let mut driver = AstTimerScheduler::with_hub(
        hub.clone(),
        store.clone(),
        clock.clone(),
        CountingIds::default(),
    );
    driver.start().await.expect("driver start");
    let context = context_for(CHANNEL);

    let mut expected = BTreeSet::new();
    for slot in 0..BACKLOG {
        let job = driver
            .schedule(0.0, &root(vec![literal("now")]), &context)
            .await
            .unwrap_or_else(|error| panic!("backlog timer {slot} was rejected: {error}"));
        expected.insert(job.id);
    }
    assert_eq!(hub.armed_len(), BACKLOG);
    assert_eq!(store.enqueues(), BACKLOG);
    assert_eq!(expected.len(), BACKLOG, "every scheduled id is distinct");

    let pass = driver.step().await.expect("step").expect("running");
    assert_eq!(
        pass.jobs.len(),
        BACKLOG,
        "one pass must claim every ready job"
    );
    let claimed: BTreeSet<String> = pass.jobs.iter().map(|job| job.id.clone()).collect();
    assert_eq!(claimed, expected);
    assert_eq!(store.claims(), BACKLOG);
    assert_eq!(
        hub.armed_len(),
        0,
        "claiming must not leave armed entries behind"
    );
    assert!(store.pending_ids().is_empty());
    assert_eq!(
        pass.wake_ms,
        NOW + RECONCILE_MS,
        "the pass must not sleep while it had ready work"
    );

    // A second pass neither replays nor re-arms anything.
    let again = driver.step().await.expect("step").expect("running");
    assert!(again.jobs.is_empty());
    assert_eq!(hub.armed_len(), 0);
    assert_eq!(store.claims(), BACKLOG);
}

/// Executing a claimed timer may schedule a nested timer through the catalog,
/// which takes the catalog's async scheduler mutex. The driver must not hold a
/// scheduler lock while it executes, or the first nested `$(timer …)` deadlocks
/// the single-threaded runtime.
#[tokio::test]
async fn a_claimed_job_can_schedule_a_nested_timer_without_deadlocking() {
    let hub = TimerScheduleHub::new();
    let store = FakeStore::new();
    let clock = TestClock::new(NOW);
    let mut driver = AstTimerScheduler::with_hub(
        hub.clone(),
        store.clone(),
        clock.clone(),
        CountingIds::default(),
    );
    driver.start().await.expect("driver start");

    let chat: Arc<dyn AstChatSend> = Arc::new(NullChat);
    let delay: Arc<dyn AstDelayClock> = Arc::new(NoDelay);
    let catalog = Arc::new(BotAstFunctions::new(
        chat,
        delay,
        AstTimerScheduler::with_hub(
            hub.clone(),
            store.clone(),
            clock.clone(),
            CountingIds::starting(1_000),
        ),
    ));
    let mut host = ApplicationHost::new(
        Arc::new(MemoryCache::default()) as Arc<dyn AstCache>,
        Arc::new(MemoryVariables::working()) as Arc<dyn AstVariableStore>,
    )
    .with_functions(Arc::clone(&catalog))
    .with_timer(Arc::clone(&catalog));
    let engine = Engine::default();
    let mut sender = RecordingSender::default();
    let mut runner = RecordingRunner::default();
    let context = context_for(CHANNEL);

    // Outer body: `$(timer 1 nested body) outer body`.
    let outer = driver
        .schedule(
            1.0,
            &root(vec![
                AstNode::Function {
                    name: "timer".to_owned(),
                    args: vec![literal("1"), literal("nested body")],
                },
                literal("outer body"),
            ]),
            &context,
        )
        .await
        .expect("outer timer");
    assert_eq!(outer.due_at, NOW + 1_000);
    assert_eq!(hub.armed_len(), 1);

    // Claim later than `dueAt` so the pass reconciles first and its cadence is
    // then later than the nested deadline — proving the nested arm, not the
    // cadence, drives the next wake.
    clock.set(NOW + 10_000);
    let pass = driver.step().await.expect("step").expect("running");
    assert_eq!(pass.jobs.len(), 1);
    assert_eq!(hub.armed_len(), 0, "the outer job is claimed, not retained");

    let sent = tokio::time::timeout(
        Duration::from_secs(5),
        execute_ast_timer_job(
            &engine,
            &mut host,
            &mut sender,
            &mut runner,
            None,
            &TestDirectory::default(),
            &pass.jobs[0],
        ),
    )
    .await
    .expect("a nested timer must not deadlock the driver")
    .expect("the outer body executes");
    assert!(!sent.error);
    assert_eq!(
        sender.sends(),
        vec![(CHANNEL.to_owned(), "outer body".to_owned())]
    );

    // The nested job was written and armed in the same shared set.
    assert_eq!(store.pending_ids().len(), 1);
    let nested_due = clock.now_ms() + 1_000;
    assert_eq!(driver.next_deadline_ms(), Some(nested_due));
    assert_eq!(
        driver.next_wake_ms(clock.now_ms()),
        nested_due,
        "the nested deadline, not the later reconcile cadence"
    );
    assert_eq!(store.claims(), 1);

    // It delivers at its own deadline, recursively through the same path.
    clock.set(nested_due);
    let nested = driver.step().await.expect("step").expect("running");
    assert_eq!(nested.jobs.len(), 1);
    execute_ast_timer_job(
        &engine,
        &mut host,
        &mut sender,
        &mut runner,
        None,
        &TestDirectory::default(),
        &nested.jobs[0],
    )
    .await
    .expect("the nested body executes");
    assert_eq!(
        sender.sends(),
        vec![
            (CHANNEL.to_owned(), "outer body".to_owned()),
            (CHANNEL.to_owned(), "nested body".to_owned()),
        ]
    );
}

#[tokio::test]
async fn a_new_deadline_wakes_a_waiting_driver_instead_of_the_old_target() {
    let hub = TimerScheduleHub::new();
    let store = FakeStore::new();
    let clock = TestClock::new(NOW);
    let mut driver = AstTimerScheduler::with_hub(
        hub.clone(),
        store.clone(),
        clock.clone(),
        CountingIds::default(),
    );
    driver.start().await.expect("driver start");
    let mut scheduling = AstTimerScheduler::with_hub(
        hub.clone(),
        store.clone(),
        clock.clone(),
        CountingIds::starting(1_000),
    );
    let context = context_for(CHANNEL);

    // The driver goes to sleep on a far target; the scheduling side then arms a
    // 50 ms timer. Without the wake notification the wait would stay asleep for
    // the full old target and the timeout would fail.
    let arm = async {
        tokio::task::yield_now().await;
        scheduling
            .schedule(0.05, &root(vec![literal("woken")]), &context)
            .await
            .expect("timer scheduled while the driver waits")
    };
    let (woke_at, job) = tokio::time::timeout(
        Duration::from_secs(5),
        async { tokio::join!(driver.wait(NOW + 60_000), arm) },
    )
    .await
    .expect("a new deadline must wake the waiting driver");
    assert_eq!(job.due_at, NOW + 50);
    assert_eq!(woke_at, job.due_at);
    assert_eq!(driver.next_deadline_ms(), Some(job.due_at));
}

// ---------------------------------------------------------------------------
// Private Dragonfly fixture: the real Lua EVAL path
// ---------------------------------------------------------------------------

#[derive(Clone)]
struct TestClock {
    now: Arc<StdMutex<i64>>,
}

impl TestClock {
    fn new(now: i64) -> Self {
        Self {
            now: Arc::new(StdMutex::new(now)),
        }
    }

    fn set(&self, now: i64) {
        *lock(&self.now) = now;
    }
}

impl AstTimerClock for TestClock {
    fn now_ms(&self) -> i64 {
        *lock(&self.now)
    }
}

#[derive(Default)]
struct CountingIds {
    issued: u32,
}

impl CountingIds {
    /// Starts at a distinct value so two schedulers in one test never mint the
    /// same id for different jobs (production `DigestTimerIdSource` derives that
    /// from a process-wide sequence).
    fn starting(issued: u32) -> Self {
        Self { issued }
    }
}

impl AstTimerIdSource for CountingIds {
    fn next_id(&mut self) -> String {
        self.issued += 1;
        format!("timer-{:04}", self.issued)
    }
}

/// Owns every key this fixture creates and deletes exactly those keys on drop,
/// so a failed assertion cannot leave state behind in the private instance.
struct PrivateKeys {
    url: String,
    keys: StdMutex<Vec<String>>,
}

impl PrivateKeys {
    fn new(url: String) -> Self {
        Self {
            url,
            keys: StdMutex::new(Vec::new()),
        }
    }

    fn own(&self, key: impl Into<String>) {
        lock(&self.keys).push(key.into());
    }
}

impl Drop for PrivateKeys {
    fn drop(&mut self) {
        let keys = std::mem::take(&mut *lock(&self.keys));
        let cleanup = || -> redis::RedisResult<()> {
            let client = redis::Client::open(self.url.as_str())?;
            let mut connection = client.get_connection_with_timeout(Duration::from_secs(2))?;
            connection.set_read_timeout(Some(Duration::from_secs(2)))?;
            connection.set_write_timeout(Some(Duration::from_secs(2)))?;
            for key in &keys {
                let _: i64 = redis::cmd("DEL").arg(key).query(&mut connection)?;
            }
            Ok(())
        };
        if let Err(error) = cleanup() {
            eprintln!("owned timer fixture cleanup failed: {error}");
        }
    }
}

/// Real-adapter check: enqueue, claim, at-most-once, expiry and the caps
/// through the accepted Lua scripts.
///
/// Ignored because it needs an execution lease and a disposable Dragonfly/Redis
/// instance: set `DIMA_TEST_REDIS_URL` to a **private** endpoint and run
/// `cargo test --features ast-bot-runtime --test ast_timer_execution -- --ignored`.
/// The fixture owns the whole `dima:test:ast-timer:<pid>:<nanos>:` namespace and
/// refuses any prefix that is not task-owned.
#[tokio::test]
#[ignore = "needs an execution lease and a private Dragonfly/Redis fixture (DIMA_TEST_REDIS_URL)"]
async fn private_dragonfly_lua_path_end_to_end() {
    let url = std::env::var("DIMA_TEST_REDIS_URL")
        .expect("explicit disposable Dragonfly/Redis URL required (DIMA_TEST_REDIS_URL)");
    let token = format!(
        "{}:{}",
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system clock after the epoch")
            .as_nanos()
    );
    let prefix = format!("dima:test:ast-timer:{token}:");
    assert!(
        prefix.starts_with("dima:test:ast-timer:"),
        "the fixture must own a task-owned namespace"
    );

    let client = redis::Client::open(url.as_str()).expect("private fixture URL");
    let mut connection = client
        .get_connection_manager_with_config(
            redis::aio::ConnectionManagerConfig::new().set_response_timeout(None),
        )
        .await
        .expect("private fixture connection");
    let owned = PrivateKeys::new(url);

    let namespace = TimerNamespace::with_prefix(&prefix);
    owned.own(namespace.index.clone());
    let store = DragonflyTimerStore::with_namespace(connection.clone(), namespace.clone());
    let mut scheduler = AstTimerScheduler::new(store, TestClock::new(NOW), CountingIds::default());
    scheduler.start().await.expect("scheduler start");
    let context = context_for(CHANNEL);
    let body = root(vec![literal("5 minutes over!")]);
    let channel_key = namespace.channel_key(CHANNEL);
    owned.own(channel_key.clone());

    // --- enqueue writes the payload and both index entries -----------------
    let job = scheduler
        .schedule(60.0, &body, &context)
        .await
        .expect("enqueue");
    owned.own(namespace.job_key(&job.id));
    let exists: i64 = redis::cmd("EXISTS")
        .arg(namespace.job_key(&job.id))
        .query_async(&mut connection)
        .await
        .expect("payload exists");
    assert_eq!(exists, 1, "the payload key must be written");
    let pending_score: Option<f64> = redis::cmd("ZSCORE")
        .arg(&namespace.index)
        .arg(&job.id)
        .query_async(&mut connection)
        .await
        .expect("global index score");
    assert_eq!(
        pending_score.map(|score| score.round() as i64),
        Some(job.due_at)
    );
    let channel_score: Option<f64> = redis::cmd("ZSCORE")
        .arg(&channel_key)
        .arg(&job.id)
        .query_async(&mut connection)
        .await
        .expect("channel index score");
    assert_eq!(
        channel_score.map(|score| score.round() as i64),
        Some(job.expires_at)
    );

    // --- claim consumes the payload and both index entries -----------------
    let outcome = scheduler
        .fire(&job.id, job.due_at)
        .await
        .expect("first claim");
    let claimed = match outcome {
        ClaimOutcome::Claimed(claimed) => claimed,
        other => panic!("unexpected outcome: {other:?}"),
    };
    assert_eq!(claimed.id, job.id);
    assert_eq!(claimed.body, body);
    assert_eq!(
        claimed.channel_id().expect("broadcasterId in the snapshot"),
        CHANNEL
    );
    let exists: i64 = redis::cmd("EXISTS")
        .arg(namespace.job_key(&job.id))
        .query_async(&mut connection)
        .await
        .expect("payload removed");
    assert_eq!(exists, 0, "the claim must delete the payload");
    let pending_score: Option<f64> = redis::cmd("ZSCORE")
        .arg(&namespace.index)
        .arg(&job.id)
        .query_async(&mut connection)
        .await
        .expect("global index cleared");
    assert!(pending_score.is_none(), "the global index entry is cleared");
    let channel_score: Option<f64> = redis::cmd("ZSCORE")
        .arg(&channel_key)
        .arg(&job.id)
        .query_async(&mut connection)
        .await
        .expect("channel index cleared");
    assert!(channel_score.is_none(), "the channel index entry is cleared");

    // --- at most once: a second claim finds nothing ------------------------
    let second = scheduler
        .fire(&job.id, job.due_at)
        .await
        .expect("second claim");
    assert!(
        matches!(second, ClaimOutcome::Missing),
        "a second claim must find nothing: {second:?}"
    );

    // --- a job past expiresAt is consumed and dropped ----------------------
    let expired = scheduler
        .schedule(1.0, &body, &context)
        .await
        .expect("enqueue the expiring job");
    owned.own(namespace.job_key(&expired.id));
    let outcome = scheduler
        .fire(&expired.id, expired.expires_at)
        .await
        .expect("expired claim");
    assert!(
        matches!(outcome, ClaimOutcome::Expired),
        "a job past expiresAt must be dropped: {outcome:?}"
    );
    let exists: i64 = redis::cmd("EXISTS")
        .arg(namespace.job_key(&expired.id))
        .query_async(&mut connection)
        .await
        .expect("expired payload removed");
    assert_eq!(exists, 0, "the expired job is consumed, not retried");

    // --- the per-channel cap is enforced -----------------------------------
    // A fresh channel so earlier consumed entries cannot mask the cap.
    let capped_channel = format!("{CHANNEL}-cap");
    let capped_key = namespace.channel_key(&capped_channel);
    owned.own(capped_key.clone());
    let capped_context = context_for(&capped_channel);
    for slot in 0..MAX_CHANNEL_TIMERS {
        let job = scheduler
            .schedule(60.0, &body, &capped_context)
            .await
            .unwrap_or_else(|error| panic!("timer {slot} below the cap: {error}"));
        owned.own(namespace.job_key(&job.id));
    }
    let channel_card: i64 = redis::cmd("ZCARD")
        .arg(&capped_key)
        .query_async(&mut connection)
        .await
        .expect("channel index cardinality");
    assert_eq!(channel_card as usize, MAX_CHANNEL_TIMERS);
    let error = scheduler
        .schedule(60.0, &body, &capped_context)
        .await
        .expect_err("the per-channel cap must reject the next timer");
    assert!(
        matches!(error, AstTimerError::PendingLimitReached { .. }),
        "unexpected error: {error:?}"
    );
    let channel_card: i64 = redis::cmd("ZCARD")
        .arg(&capped_key)
        .query_async(&mut connection)
        .await
        .expect("channel index cardinality after rejection");
    assert_eq!(
        channel_card as usize, MAX_CHANNEL_TIMERS,
        "a rejected timer writes nothing"
    );
}
