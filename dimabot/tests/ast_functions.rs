#![cfg(feature = "ast-bot-runtime")]
//! Behavioural checks for the native AST function families that have a real
//! adapter (`dima_rust::utils::ast_runtime::functions`).
//!
//! Sources under test:
//!
//! - `src/utils/ast_parser/timer.ts` (`evaluateTimer`, `MAX_TIMER_SECONDS`,
//!   `MAX_TIMER_DEPTH`)
//! - `src/utils/ast_parser/functions/delay.functions.ts` (`delayHandler`)
//! - `src/utils/ast_parser/functions/chat.functions.ts` (`chatSendHandler`,
//!   `announceHandler`, the `registerFunction` metadata)
//!
//! Every collaborator is an in-memory fake: no Dragonfly, MongoDB, Twitch
//! client, network, Docker or wall-clock sleep. The timer assertions read back
//! the payload that crossed the cache boundary, so they prove the body stayed
//! unevaluated and that the depth was incremented.

use std::{
    collections::BTreeMap,
    sync::{Arc, Mutex as StdMutex},
};

use dima_rust::utils::{
    ast_evaluator::{Context, ExecutionContext, FunctionRegistry, JsValue},
    ast_runtime::{
        AstFunctionCatalog, AstRuntimeError, AstScope, BoxFuture, SendResult,
        functions::{
            AstAnnounceSend, AstChatSend, AstDelayClock, BotAstFunctions, MAX_ANNOUNCEMENT_LENGTH,
            MAX_DELAY_SECONDS, MAX_TIMER_DEPTH, MAX_TIMER_SECONDS,
        },
    },
    ast_syntax::AstNode,
    ast_timer_runtime::{
        AstTimerClock, AstTimerError, AstTimerIdSource, AstTimerScheduler, AstTimerStore,
        PendingTimer, TimerEnqueue, TimerNamespace,
    },
};

/// Fixed wall clock: 2026-10-31T00:00:00.000Z.
const NOW: i64 = 1_793_462_400_000;

fn lock<T>(mutex: &StdMutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn as_text(value: &JsValue) -> String {
    match value {
        JsValue::String(text) => text.to_utf8().expect("AST function text is valid UTF-8"),
        other => panic!("expected a string result, got {other:?}"),
    }
}

fn number(value: f64) -> JsValue {
    JsValue::Number(value)
}

fn text(value: &str) -> JsValue {
    JsValue::string(value)
}

fn literal(value: &str) -> AstNode {
    AstNode::Literal { value: value.to_owned() }
}

fn nested_action(name: &str) -> AstNode {
    AstNode::Function { name: name.to_owned(), args: Vec::new() }
}

fn scope() -> AstScope {
    AstScope::new("test")
}

fn context(depth: Option<f64>, platform: &str) -> Context {
    let mut execution = ExecutionContext::default();
    execution.broadcaster_id = "test".to_owned();
    execution.user_id = "viewer".to_owned();
    execution.user_login = "viewer_login".to_owned();
    execution.user_display_name = "Viewer".to_owned();
    execution.platform = platform.to_owned();
    execution.timer_depth = depth;
    execution.into_context()
}

#[derive(Default)]
struct FakeStoreState {
    jobs: BTreeMap<String, String>,
    pending: Vec<(i64, String)>,
    enqueues: usize,
    reject: bool,
}

/// In-memory Dragonfly substitute: keeps the payload exactly as it was written,
/// so tests can decode what crossed the cache boundary.
#[derive(Clone, Default)]
struct FakeStore {
    namespace: TimerNamespace,
    state: Arc<StdMutex<FakeStoreState>>,
}

impl FakeStore {
    fn new() -> Self {
        Self {
            namespace: TimerNamespace::source(),
            state: Arc::default(),
        }
    }

    fn payloads(&self) -> Vec<String> {
        lock(&self.state).jobs.values().cloned().collect()
    }

    fn enqueue_count(&self) -> usize {
        lock(&self.state).enqueues
    }

    fn reject_writes(&self) {
        lock(&self.state).reject = true;
    }
}

impl AstTimerStore for FakeStore {
    async fn enqueue(&mut self, request: &TimerEnqueue<'_>) -> Result<bool, AstTimerError> {
        let mut state = lock(&self.state);
        state.enqueues += 1;
        if state.reject {
            // The store's `return 0`: a pending cap refused the write.
            return Ok(false);
        }
        state
            .jobs
            .insert(self.namespace.job_key(request.id), request.payload.to_owned());
        state
            .pending
            .push((request.due_at_ms, request.id.to_owned()));
        Ok(true)
    }

    async fn load_payload(&mut self, id: &str) -> Result<Option<String>, AstTimerError> {
        let key = self.namespace.job_key(id);
        Ok(lock(&self.state).jobs.get(&key).cloned())
    }

    async fn claim(
        &mut self,
        id: &str,
        _channel_id: &str,
        now_ms: i64,
    ) -> Result<Option<String>, AstTimerError> {
        let key = self.namespace.job_key(id);
        let mut state = lock(&self.state);
        let Some(raw) = state.jobs.get(&key).cloned() else {
            return Ok(None);
        };
        let wire: serde_json::Value =
            serde_json::from_str(&raw).map_err(|error| AstTimerError::JobDecoding {
                message: error.to_string(),
            })?;
        if wire
            .get("dueAt")
            .and_then(serde_json::Value::as_i64)
            .unwrap_or(i64::MAX)
            > now_ms
        {
            return Ok(None);
        }
        state.jobs.remove(&key);
        state.pending.retain(|(_, member)| member != id);
        Ok(Some(raw))
    }

    async fn prune_pending(&mut self, _max_score_ms: i64) -> Result<usize, AstTimerError> {
        Ok(0)
    }

    async fn pending(&mut self, limit: usize) -> Result<Vec<PendingTimer>, AstTimerError> {
        Ok(lock(&self.state)
            .pending
            .iter()
            .take(limit)
            .map(|(score, id)| PendingTimer {
                id: id.clone(),
                due_at_ms: *score,
            })
            .collect())
    }

    async fn drop_pending(&mut self, id: &str) -> Result<bool, AstTimerError> {
        let mut state = lock(&self.state);
        let before = state.pending.len();
        state.pending.retain(|(_, member)| member != id);
        Ok(before != state.pending.len())
    }
}

/// Fixed clock: the scheduler never moves time in these checks.
#[derive(Clone, Copy)]
struct FixedClock {
    now: i64,
}

impl AstTimerClock for FixedClock {
    fn now_ms(&self) -> i64 {
        self.now
    }
}

#[derive(Default)]
struct CountingIds {
    issued: u32,
}

impl AstTimerIdSource for CountingIds {
    fn next_id(&mut self) -> String {
        self.issued += 1;
        format!("timer-{:04}", self.issued)
    }
}

#[derive(Clone)]
struct FakeChat {
    sent: Arc<StdMutex<Vec<(String, String)>>>,
    result: SendResult,
}

impl FakeChat {
    fn ok() -> Self {
        Self {
            sent: Arc::default(),
            result: SendResult::ok("sent"),
        }
    }

    fn failing(message: &str) -> Self {
        Self {
            sent: Arc::default(),
            result: SendResult::failure(message, 400),
        }
    }

    fn sent(&self) -> Vec<(String, String)> {
        lock(&self.sent).clone()
    }
}

impl AstChatSend for FakeChat {
    fn send<'a>(
        &'a self,
        channel_id: &'a str,
        message: &'a str,
    ) -> BoxFuture<'a, Result<SendResult, AstRuntimeError>> {
        let sent = Arc::clone(&self.sent);
        let result = self.result.clone();
        let call = (channel_id.to_owned(), message.to_owned());
        Box::pin(async move {
            lock(&sent).push(call);
            Ok(result)
        })
    }
}

#[derive(Clone)]
struct FakeAnnounce {
    calls: Arc<StdMutex<Vec<(String, String, String)>>>,
    result: SendResult,
}

impl FakeAnnounce {
    fn ok() -> Self {
        Self {
            calls: Arc::default(),
            result: SendResult::ok("Announcement sent"),
        }
    }

    fn failing(message: &str) -> Self {
        Self {
            calls: Arc::default(),
            result: SendResult::failure(message, 403),
        }
    }

    fn calls(&self) -> Vec<(String, String, String)> {
        lock(&self.calls).clone()
    }
}

impl AstAnnounceSend for FakeAnnounce {
    fn announce<'a>(
        &'a self,
        channel_id: &'a str,
        message: &'a str,
        color: &'a str,
    ) -> BoxFuture<'a, Result<SendResult, AstRuntimeError>> {
        let calls = Arc::clone(&self.calls);
        let result = self.result.clone();
        let call = (
            channel_id.to_owned(),
            message.to_owned(),
            color.to_owned(),
        );
        Box::pin(async move {
            lock(&calls).push(call);
            Ok(result)
        })
    }
}

#[derive(Clone, Default)]
struct FakeDelay {
    waits: Arc<StdMutex<Vec<u64>>>,
}

impl FakeDelay {
    fn waits(&self) -> Vec<u64> {
        lock(&self.waits).clone()
    }
}

impl AstDelayClock for FakeDelay {
    fn sleep_millis<'a>(&'a self, millis: u64) -> BoxFuture<'a, ()> {
        let waits = Arc::clone(&self.waits);
        Box::pin(async move {
            lock(&waits).push(millis);
        })
    }
}

struct Harness {
    functions: BotAstFunctions<FakeStore, FixedClock, CountingIds>,
    store: FakeStore,
    chat: FakeChat,
    delay: FakeDelay,
}

fn harness(chat: FakeChat) -> Harness {
    harness_with(chat, None)
}

/// `announce` is only reachable when the announcement seam is installed, so the
/// harness takes it separately: `None` is a catalog without the adapter.
fn harness_with(chat: FakeChat, announce: Option<FakeAnnounce>) -> Harness {
    let store = FakeStore::new();
    let delay = FakeDelay::default();
    let timers = AstTimerScheduler::new(
        store.clone(),
        FixedClock { now: NOW },
        CountingIds::default(),
    );
    let functions = BotAstFunctions::new(
        Arc::new(chat.clone()),
        Arc::new(delay.clone()),
        timers,
    );
    let functions = match announce {
        Some(announce) => functions.with_announce(Arc::new(announce)),
        None => functions,
    };
    Harness {
        functions,
        store,
        chat,
        delay,
    }
}

#[tokio::test]
async fn timer_without_two_arguments_reports_usage() {
    let harness = harness(FakeChat::ok());
    let context = context(None, "twitch");
    for args in [Vec::new(), vec![literal("300")]] {
        let value = harness
            .functions
            .timer(&scope(), &args, &number(300.0), &context)
            .await
            .expect("timer never throws");
        assert_eq!(
            as_text(&value),
            "timer: usage: $(timer seconds message_and_actions)"
        );
    }
    assert_eq!(harness.store.enqueue_count(), 0);
}

#[tokio::test]
async fn timer_reports_the_nesting_limit() {
    let harness = harness(FakeChat::ok());
    let args = vec![literal("300"), nested_action("timer.testaction")];
    for depth in [Some(MAX_TIMER_DEPTH), Some(MAX_TIMER_DEPTH + 1.0)] {
        let context = context(depth, "twitch");
        let value = harness
            .functions
            .timer(&scope(), &args, &number(300.0), &context)
            .await
            .expect("timer never throws");
        assert_eq!(
            as_text(&value),
            "timer: maximum nested timer depth reached",
            "depth {depth:?} must be refused"
        );
    }
    assert_eq!(harness.store.enqueue_count(), 0);
}

#[tokio::test]
async fn timer_requires_a_twitch_channel() {
    let harness = harness(FakeChat::ok());
    let args = vec![literal("300"), nested_action("timer.testaction")];

    let youtube = context(None, "youtube");
    let value = harness
        .functions
        .timer(&scope(), &args, &number(300.0), &youtube)
        .await
        .expect("timer never throws");
    assert_eq!(as_text(&value), "timer: requires a Twitch channel");

    let twitch = context(None, "twitch");
    let missing_scope = AstScope::new("");
    let value = harness
        .functions
        .timer(&missing_scope, &args, &number(300.0), &twitch)
        .await
        .expect("timer never throws");
    assert_eq!(as_text(&value), "timer: requires a Twitch channel");

    let mut execution = ExecutionContext::default();
    execution.platform = "twitch".to_owned();
    let empty_broadcaster = execution.into_context();
    let value = harness
        .functions
        .timer(&scope(), &args, &number(300.0), &empty_broadcaster)
        .await
        .expect("timer never throws");
    assert_eq!(as_text(&value), "timer: requires a Twitch channel");

    assert_eq!(harness.store.enqueue_count(), 0);
    assert!(harness.store.payloads().is_empty());
}

#[tokio::test]
async fn timer_rejects_seconds_outside_the_source_range() {
    let harness = harness(FakeChat::ok());
    let args = vec![literal("300"), nested_action("timer.testaction")];
    let context = context(None, "twitch");
    let range_message = format!("timer: seconds must be between 1 and {MAX_TIMER_SECONDS}");
    assert_eq!(range_message, "timer: seconds must be between 1 and 604800");

    for duration in [
        number(0.0),
        number(-1.0),
        number(MAX_TIMER_SECONDS as f64 + 1.0),
        number(f64::INFINITY),
        number(f64::NEG_INFINITY),
        number(f64::NAN),
        text("nope"),
    ] {
        let value = harness
            .functions
            .timer(&scope(), &args, &duration, &context)
            .await
            .expect("timer never throws");
        assert_eq!(as_text(&value), range_message, "duration {duration:?}");
    }
    assert_eq!(harness.store.enqueue_count(), 0);
    assert!(harness.store.payloads().is_empty());
}

#[tokio::test]
async fn timer_schedules_the_remaining_arguments_as_an_unevaluated_body() {
    let harness = harness(FakeChat::ok());
    let args = vec![
        literal("300"),
        literal("5 minutes over! "),
        nested_action("timer.testaction"),
    ];
    let context = context(None, "twitch");
    let value = harness
        .functions
        .timer(&scope(), &args, &number(300.0), &context)
        .await
        .expect("timer never throws");

    // Source: `{ value: '' }` on success.
    assert_eq!(as_text(&value), "");
    assert_eq!(harness.store.enqueue_count(), 1);

    let payloads = harness.store.payloads();
    assert_eq!(payloads.len(), 1);
    let wire: serde_json::Value =
        serde_json::from_str(&payloads[0]).expect("stored timer payload must be JSON");

    // The duration is consumed, and everything after it is the lazy body.
    assert_eq!(wire["body"]["type"], "root");
    let children = wire["body"]["children"]
        .as_array()
        .expect("the timer body is a root node");
    assert_eq!(children.len(), 2);
    assert_eq!(children[0]["type"], "literal");
    assert_eq!(children[0]["value"], "5 minutes over! ");
    assert_eq!(children[1]["type"], "function");
    assert_eq!(children[1]["name"], "timer.testaction");

    // `snapshotTimerContext` increments the depth so a deferred body cannot
    // recurse without bound, and it stores the broadcaster that owns the job.
    assert_eq!(wire["context"]["timerDepth"].as_i64(), Some(1));
    assert_eq!(wire["context"]["broadcasterId"], "test");
    assert_eq!(wire["dueAt"].as_i64(), Some(NOW + 300_000));
    assert_eq!(wire["expiresAt"].as_i64(), Some(NOW + 300_000 + 600_000));
}

#[tokio::test]
async fn timer_coerces_a_numeric_duration_string() {
    let harness = harness(FakeChat::ok());
    let args = vec![literal("%(seconds)"), literal("Time is up!")];
    let context = context(None, "twitch");
    let value = harness
        .functions
        .timer(&scope(), &args, &text("300"), &context)
        .await
        .expect("timer never throws");
    assert_eq!(as_text(&value), "");
    let payloads = harness.store.payloads();
    let wire: serde_json::Value =
        serde_json::from_str(&payloads[0]).expect("stored timer payload must be JSON");
    assert_eq!(wire["dueAt"].as_i64(), Some(NOW + 300_000));
    assert_eq!(
        wire["body"]["children"]
            .as_array()
            .expect("the timer body is a root node")
            .len(),
        1
    );
}

#[tokio::test]
async fn timer_reports_a_store_refusal_as_a_scheduling_failure() {
    let harness = harness(FakeChat::ok());
    harness.store.reject_writes();
    let args = vec![literal("300"), nested_action("timer.testaction")];
    let context = context(None, "twitch");
    let value = harness
        .functions
        .timer(&scope(), &args, &number(300.0), &context)
        .await
        .expect("timer never throws");
    assert_eq!(as_text(&value), "timer: could not schedule timer");
}

#[tokio::test]
async fn delay_reports_missing_invalid_and_out_of_range_arguments() {
    let harness = harness(FakeChat::ok());

    let value = harness.functions.delay(&[]).await.expect("delay never throws");
    assert_eq!(as_text(&value), "delay: missing argument (seconds)");

    let value = harness
        .functions
        .delay(&[text("abc")])
        .await
        .expect("delay never throws");
    assert_eq!(as_text(&value), "delay: \"abc\" is not a valid number");

    let over_range = number(MAX_DELAY_SECONDS as f64 + 1.0);
    let value = harness
        .functions
        .delay(&[over_range])
        .await
        .expect("delay never throws");
    assert_eq!(as_text(&value), "delay: must be between 0 and 60 seconds");

    let value = harness
        .functions
        .delay(&[number(-1.0)])
        .await
        .expect("delay never throws");
    assert_eq!(as_text(&value), "delay: must be between 0 and 60 seconds");

    assert!(
        harness.delay.waits().is_empty(),
        "a rejected delay must not pause"
    );
}

#[tokio::test]
async fn delay_coerces_numeric_strings_like_javascript() {
    let harness = harness(FakeChat::ok());

    let value = harness
        .functions
        .delay(&[text("5")])
        .await
        .expect("delay never throws");
    assert_eq!(as_text(&value), "");
    assert_eq!(harness.delay.waits(), vec![5_000]);

    let value = harness
        .functions
        .delay(&[number(0.0)])
        .await
        .expect("delay never throws");
    assert_eq!(as_text(&value), "");
    assert_eq!(harness.delay.waits(), vec![5_000, 0]);
}

#[tokio::test]
async fn chat_send_returns_empty_text_on_success() {
    let harness = harness(FakeChat::ok());
    let value = harness
        .functions
        .chat_send(&scope(), &[text("Hello everyone!")])
        .await
        .expect("chat.send never throws");
    assert_eq!(as_text(&value), "");
    assert_eq!(
        harness.chat.sent(),
        vec![("test".to_owned(), "Hello everyone!".to_owned())]
    );
}

#[tokio::test]
async fn chat_send_trims_the_message_and_prefixes_failures() {
    let harness = harness(FakeChat::failing("held for moderation"));
    let value = harness
        .functions
        .chat_send(&scope(), &[text("  five minutes  ")])
        .await
        .expect("chat.send never throws");
    assert_eq!(as_text(&value), "chat.send: held for moderation");
    assert_eq!(
        harness.chat.sent(),
        vec![("test".to_owned(), "five minutes".to_owned())]
    );
}

#[tokio::test]
async fn chat_send_with_no_text_sends_nothing() {
    let harness = harness(FakeChat::ok());
    for args in [Vec::new(), vec![text("   ")], vec![JsValue::Null]] {
        let value = harness
            .functions
            .chat_send(&scope(), &args)
            .await
            .expect("chat.send never throws");
        assert_eq!(as_text(&value), "");
    }
    assert!(harness.chat.sent().is_empty());
}

#[tokio::test]
async fn announcement_families_and_unknown_names_report_unsupported() {
    // A catalog without the announcement seam still reports the gap by name.
    let harness = harness(FakeChat::ok());
    let scope = scope();

    for name in ["announce", "chat.announcement"] {
        let error = harness
            .functions
            .call(&scope, name, &[text("welcome")])
            .await
            .expect_err("no announcement adapter is installed");
        assert!(
            matches!(error, AstRuntimeError::Unsupported(_)),
            "{name} must be Unsupported"
        );
        assert!(
            error.message().contains(name),
            "the failure must name {name}: {}",
            error.message()
        );
        assert!(
            error.message().contains("announcement"),
            "the failure must name the missing adapter: {}",
            error.message()
        );
    }

    // The evaluated-argument catalog cannot rebuild an unevaluated timer body.
    let error = harness
        .functions
        .call(&scope, "timer", &[text("300"), text("hi")])
        .await
        .expect_err("timer needs the AST-aware entry point");
    assert!(
        matches!(error, AstRuntimeError::Unsupported(ref message) if message.contains("timer")),
        "timer must be Unsupported and named"
    );

    let error = harness
        .functions
        .call(&scope, "totally.unknown", &[])
        .await
        .expect_err("unknown names must be Unsupported");
    assert!(
        matches!(error, AstRuntimeError::Unsupported(ref message) if message.contains("totally.unknown")),
        "the failure must name the unknown function"
    );
}

#[test]
fn metadata_matches_the_source_registrations() {
    let harness = harness(FakeChat::ok());

    let timer = harness.functions.metadata("timer").expect("timer metadata");
    assert_eq!(timer.category, "flow");
    assert_eq!(timer.syntax, "timer seconds message_and_actions");
    assert_eq!(timer.min_user_level, None);
    assert_eq!(
        timer.examples,
        vec!["timer 300 5 minutes over! $(trigger.send hurray)".to_owned()]
    );
    assert_eq!(timer.surfaces, Some(vec!["authoring".to_owned()]));

    let delay = harness.functions.metadata("delay").expect("delay metadata");
    assert_eq!(delay.category, "flow");
    assert_eq!(delay.syntax, "delay seconds");
    assert_eq!(delay.min_user_level, None);
    assert_eq!(delay.keywords.as_ref().map(Vec::len), Some(6));

    // `chat.functions.ts` gates the announcement family at user level 7.
    let announce = harness
        .functions
        .metadata("announce")
        .expect("announce metadata");
    assert_eq!(announce.category, "chat");
    assert_eq!(announce.syntax, "announce [color] message");
    assert_eq!(announce.min_user_level, Some(7.0));
    let alias = harness
        .functions
        .metadata("chat.announcement")
        .expect("chat.announcement metadata");
    assert_eq!(alias.alias_of.as_deref(), Some("announce"));
    assert_eq!(alias.min_user_level, Some(7.0));

    let send = harness
        .functions
        .metadata("chat.send")
        .expect("chat.send metadata");
    assert_eq!(send.category, "chat");
    assert_eq!(send.syntax, "chat.send message");
    assert_eq!(send.min_user_level, None);

    // Registering is what makes the names reachable and enforces the level gate.
    let mut registry = FunctionRegistry::default();
    harness.functions.register_into(&mut registry);
    assert_eq!(harness.functions.registrations().len(), 5);
    assert_eq!(
        registry
            .metadata("announce")
            .and_then(|metadata| metadata.min_user_level),
        Some(7.0)
    );
    assert_eq!(
        registry
            .metadata("chat.send")
            .map(|metadata| metadata.syntax.as_str()),
        Some("chat.send message")
    );
    assert!(registry.metadata("break").is_none());
}

/// `announce` / `chat.announcement` — the source's `announceHandler`
/// (`src/utils/ast_parser/functions/chat.functions.ts`).
#[tokio::test]
async fn announcement_family_matches_the_source_semantics() {
    let scope = scope();

    // The default colour is `primary`, and the whole message is the joined args.
    let announce = FakeAnnounce::ok();
    let harness = harness_with(FakeChat::ok(), Some(announce.clone()));
    let value = harness
        .functions
        .call(&scope, "announce", &[text("welcome")])
        .await
        .expect("the announcement succeeds");
    assert_eq!(as_text(&value), "");
    assert_eq!(
        announce.calls(),
        vec![("test".to_owned(), "welcome".to_owned(), "primary".to_owned())]
    );

    // A leading colour word selects the colour and is removed from the message.
    let announce = FakeAnnounce::ok();
    let harness = harness_with(FakeChat::ok(), Some(announce.clone()));
    harness
        .functions
        .call(&scope, "announce", &[text("purple"), text("five minutes left")])
        .await
        .expect("the announcement succeeds");
    assert_eq!(
        announce.calls(),
        vec![(
            "test".to_owned(),
            "five minutes left".to_owned(),
            "purple".to_owned()
        )]
    );

    // The colour word is matched case-insensitively and lower-cased.
    let announce = FakeAnnounce::ok();
    let harness = harness_with(FakeChat::ok(), Some(announce.clone()));
    harness
        .functions
        .call(&scope, "announce", &[text("BLUE"), text("go")])
        .await
        .expect("the announcement succeeds");
    assert_eq!(
        announce.calls(),
        vec![("test".to_owned(), "go".to_owned(), "blue".to_owned())]
    );

    // An unknown first word is part of the message, not a colour.
    let announce = FakeAnnounce::ok();
    let harness = harness_with(FakeChat::ok(), Some(announce.clone()));
    harness
        .functions
        .call(&scope, "announce", &[text("red"), text("alert")])
        .await
        .expect("the announcement succeeds");
    assert_eq!(
        announce.calls(),
        vec![(
            "test".to_owned(),
            "red alert".to_owned(),
            "primary".to_owned()
        )]
    );

    // `chat.announcement` is the same handler under its alias name.
    let announce = FakeAnnounce::ok();
    let harness = harness_with(FakeChat::ok(), Some(announce.clone()));
    let value = harness
        .functions
        .call(&scope, "chat.announcement", &[text("hi")])
        .await
        .expect("the announcement succeeds");
    assert_eq!(as_text(&value), "");
    assert_eq!(
        announce.calls(),
        vec![("test".to_owned(), "hi".to_owned(), "primary".to_owned())]
    );

    // An empty message is the source's usage string, and nothing is sent.
    let announce = FakeAnnounce::ok();
    let harness = harness_with(FakeChat::ok(), Some(announce.clone()));
    let value = harness
        .functions
        .call(&scope, "announce", &[text("   ")])
        .await
        .expect("the usage string is a value, not an error");
    assert_eq!(
        as_text(&value),
        "Usage: $(announce [blue|green|orange|purple|primary] message)"
    );
    assert!(announce.calls().is_empty());

    // A message over the limit is refused before the request.
    let announce = FakeAnnounce::ok();
    let harness = harness_with(FakeChat::ok(), Some(announce.clone()));
    let too_long = "x".repeat(MAX_ANNOUNCEMENT_LENGTH + 1);
    let value = harness
        .functions
        .call(&scope, "announce", &[text(too_long.as_str())])
        .await
        .expect("the limit message is a value, not an error");
    assert_eq!(
        as_text(&value),
        "announce: message must be at most 500 characters"
    );
    assert!(announce.calls().is_empty());

    // Exactly at the limit the announcement is still sent.
    let announce = FakeAnnounce::ok();
    let harness = harness_with(FakeChat::ok(), Some(announce.clone()));
    let at_limit = "x".repeat(MAX_ANNOUNCEMENT_LENGTH);
    harness
        .functions
        .call(&scope, "announce", &[text(at_limit.as_str())])
        .await
        .expect("the announcement succeeds");
    assert_eq!(announce.calls().len(), 1);

    // A Twitch failure is projected as `announce: <message>`.
    let announce = FakeAnnounce::failing("Announcement sent");
    let harness = harness_with(FakeChat::ok(), Some(announce));
    let value = harness
        .functions
        .call(&scope, "announce", &[text("welcome")])
        .await
        .expect("the failure is a value, not an error");
    assert_eq!(as_text(&value), "announce: Announcement sent");
}

/// The source coerces each argument with `String(arg ?? '')`: the arguments are
/// joined with a single space and a nullish argument becomes empty.
#[tokio::test]
async fn announcement_arguments_use_the_source_coercion() {
    let scope = scope();
    let announce = FakeAnnounce::ok();
    let harness = harness_with(FakeChat::ok(), Some(announce.clone()));

    harness
        .functions
        .call(
            &scope,
            "announce",
            &[text("one"), JsValue::Null, text("two")],
        )
        .await
        .expect("the announcement succeeds");
    assert_eq!(
        announce.calls(),
        vec![(
            "test".to_owned(),
            "one  two".to_owned(),
            "primary".to_owned()
        )]
    );

    // A number is stringified the way JavaScript does it.
    let announce = FakeAnnounce::ok();
    let harness = harness_with(FakeChat::ok(), Some(announce.clone()));
    harness
        .functions
        .call(&scope, "announce", &[number(5.0)])
        .await
        .expect("the announcement succeeds");
    assert_eq!(
        announce.calls(),
        vec![("test".to_owned(), "5".to_owned(), "primary".to_owned())]
    );
}
