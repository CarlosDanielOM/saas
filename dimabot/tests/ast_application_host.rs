#![cfg(feature = "ast-bot-runtime")]
//! Application-host routing. Fakes only: no MongoDB, Dragonfly, Docker, or network.
//!
//! The crate path is `dima_rust::utils::ast_runtime`, which exists after the
//! integration feature patch. `Host` futures are `!Send`, so every async test
//! uses the current-thread runtime.

use std::{
    cell::RefCell,
    collections::HashMap,
    rc::Rc,
    sync::{Arc, Mutex, MutexGuard},
};

use dima_rust::utils::{
    ast_evaluator::{
        Context, EffectToken, ExecutionContext, Host, HostRequest, JsString, JsValue, LoopExit,
    },
    ast_runtime::{
        AstCache, AstRuntimeError, AstScope, AstVariableStore, BoxFuture, ScopedAstHost,
        effects::{self, EffectActor, EffectOrigin},
        host::{
            ApplicationHost, CommandResponseLog, PersistedCommandResponses, TimerScheduler,
            from_eval_error, to_eval_error, TIMER_ADAPTER_GAP,
        },
        variables::{
            plan_variable_read, plan_variable_upsert, resolve_user_delete, resolve_user_load,
            resolve_user_save, stored_variable,
        },
    },
    ast_syntax::AstNode,
};
use mongodb::bson::{Bson, DateTime, Document};

fn locked<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|error| error.into_inner())
}

fn scope() -> AstScope {
    AstScope::new("channel-9").with_user("user-9", "@User")
}

fn execution(platform: &str, broadcaster_id: &str, depth: f64) -> ExecutionContext {
    ExecutionContext {
        broadcaster_id: broadcaster_id.into(),
        platform: platform.into(),
        timer_depth: Some(depth),
        command_id: "cmd-1".into(),
        ..ExecutionContext::default()
    }
}

fn context_of(execution: ExecutionContext) -> Context {
    Rc::new(RefCell::new(execution))
}

fn twitch_context(depth: f64) -> Context {
    context_of(execution("twitch", "12345", depth))
}

fn as_text(value: &JsValue) -> String {
    match value {
        JsValue::String(text) => text.to_utf8().expect("test string is utf-8"),
        other => panic!("expected a string, got {other:?}"),
    }
}

fn timer_body() -> AstNode {
    AstNode::Root { children: vec![] }
}

#[derive(Default)]
struct MemoryCache {
    ops: Mutex<Vec<String>>,
    values: Mutex<HashMap<String, String>>,
    fail_get: Mutex<Option<String>>,
}

impl AstCache for MemoryCache {
    fn get<'a>(&'a self, key: &'a str) -> BoxFuture<'a, Result<Option<String>, AstRuntimeError>> {
        Box::pin(async move {
            locked(&self.ops).push(format!("get:{key}"));
            if let Some(message) = locked(&self.fail_get).clone() {
                return Err(AstRuntimeError::Host(message));
            }
            Ok(locked(&self.values).get(key).cloned())
        })
    }

    fn exists<'a>(&'a self, key: &'a str) -> BoxFuture<'a, Result<bool, AstRuntimeError>> {
        Box::pin(async move {
            locked(&self.ops).push(format!("exists:{key}"));
            Ok(locked(&self.values).contains_key(key))
        })
    }

    fn set<'a>(
        &'a self,
        key: &'a str,
        value: &'a str,
    ) -> BoxFuture<'a, Result<(), AstRuntimeError>> {
        Box::pin(async move {
            locked(&self.ops).push(format!("set:{key}={value}"));
            locked(&self.values).insert(key.to_owned(), value.to_owned());
            Ok(())
        })
    }

    fn expire<'a>(
        &'a self,
        key: &'a str,
        seconds: u64,
    ) -> BoxFuture<'a, Result<(), AstRuntimeError>> {
        Box::pin(async move {
            locked(&self.ops).push(format!("expire:{key}:{seconds}"));
            Ok(())
        })
    }

    fn delete<'a>(&'a self, key: &'a str) -> BoxFuture<'a, Result<(), AstRuntimeError>> {
        Box::pin(async move {
            locked(&self.ops).push(format!("delete:{key}"));
            locked(&self.values).remove(key);
            Ok(())
        })
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct VarOp {
    kind: &'static str,
    channel_id: String,
    user_id: String,
    user_login: String,
    name: String,
    value: String,
    target: Option<String>,
}

#[derive(Default)]
struct MemoryVariables {
    ops: Mutex<Vec<VarOp>>,
}

impl MemoryVariables {
    fn record(
        &self,
        kind: &'static str,
        scope: &AstScope,
        name: &str,
        value: &str,
        target: Option<&str>,
    ) {
        locked(&self.ops).push(VarOp {
            kind,
            channel_id: scope.channel_id.clone(),
            user_id: scope.user_id.clone(),
            user_login: scope.user_login.clone(),
            name: name.to_owned(),
            value: value.to_owned(),
            target: target.map(str::to_owned),
        });
    }
}

impl AstVariableStore for MemoryVariables {
    fn load_channel_variable<'a>(
        &'a self,
        scope: &'a AstScope,
        name: &'a str,
    ) -> BoxFuture<'a, Result<String, AstRuntimeError>> {
        Box::pin(async move {
            self.record("load-channel", scope, name, "", None);
            Ok("from-store".into())
        })
    }

    fn save_channel_variable<'a>(
        &'a self,
        scope: &'a AstScope,
        name: &'a str,
        value: &'a str,
    ) -> BoxFuture<'a, Result<(), AstRuntimeError>> {
        Box::pin(async move {
            self.record("save-channel", scope, name, value, None);
            Ok(())
        })
    }

    fn delete_channel_variable<'a>(
        &'a self,
        scope: &'a AstScope,
        name: &'a str,
    ) -> BoxFuture<'a, Result<(), AstRuntimeError>> {
        Box::pin(async move {
            self.record("delete-channel", scope, name, "", None);
            Ok(())
        })
    }

    fn load_user_variable<'a>(
        &'a self,
        scope: &'a AstScope,
        name: &'a str,
        target_user_login: Option<&'a str>,
    ) -> BoxFuture<'a, Result<String, AstRuntimeError>> {
        Box::pin(async move {
            self.record("load-user", scope, name, "", target_user_login);
            Ok("from-user".into())
        })
    }

    fn save_user_variable<'a>(
        &'a self,
        scope: &'a AstScope,
        name: &'a str,
        value: &'a str,
        target_user_login: Option<&'a str>,
    ) -> BoxFuture<'a, Result<(), AstRuntimeError>> {
        Box::pin(async move {
            self.record("save-user", scope, name, value, target_user_login);
            Ok(())
        })
    }

    fn delete_user_variable<'a>(
        &'a self,
        scope: &'a AstScope,
        name: &'a str,
        target_user_login: Option<&'a str>,
    ) -> BoxFuture<'a, Result<(), AstRuntimeError>> {
        Box::pin(async move {
            self.record("delete-user", scope, name, "", target_user_login);
            Ok(())
        })
    }
}

#[derive(Default)]
struct RecordingScheduler {
    seconds: Mutex<Vec<f64>>,
}

impl TimerScheduler for RecordingScheduler {
    fn schedule<'a>(
        &'a self,
        seconds: f64,
        body: &'a AstNode,
        context: &'a Context,
    ) -> BoxFuture<'a, Result<(), AstRuntimeError>> {
        let _ = (body, context);
        Box::pin(async move {
            locked(&self.seconds).push(seconds);
            Ok(())
        })
    }
}

struct FailingScheduler;

impl TimerScheduler for FailingScheduler {
    fn schedule<'a>(
        &'a self,
        _seconds: f64,
        _body: &'a AstNode,
        _context: &'a Context,
    ) -> BoxFuture<'a, Result<(), AstRuntimeError>> {
        Box::pin(async { Err(AstRuntimeError::Host("timer store down".into())) })
    }
}

struct Parts {
    cache: Arc<MemoryCache>,
    variables: Arc<MemoryVariables>,
    host: ApplicationHost,
}

fn parts() -> Parts {
    let cache = Arc::new(MemoryCache::default());
    let variables = Arc::new(MemoryVariables::default());
    let host = ApplicationHost::new(
        Arc::clone(&cache) as Arc<dyn AstCache>,
        Arc::clone(&variables) as Arc<dyn AstVariableStore>,
    );
    Parts {
        cache,
        variables,
        host,
    }
}

async fn eval(
    host: &mut ApplicationHost,
    request: HostRequest,
    context: Context,
) -> Result<JsValue, AstRuntimeError> {
    match host.execute(request, context).await {
        Ok(value) => Ok(value),
        Err(error) => Err(from_eval_error(&error)),
    }
}

#[tokio::test(flavor = "current_thread")]
async fn cache_operations_reach_the_adapter_in_order() {
    let Parts { cache, host, .. } = parts();
    let mut host = host;
    let context = twitch_context(0.0);
    let key = JsString::from("k");

    let miss = eval(
        &mut host,
        HostRequest::CacheGet { key: key.clone() },
        context.clone(),
    )
    .await
    .expect("get");
    assert!(matches!(miss, JsValue::Null));

    let exists = eval(
        &mut host,
        HostRequest::CacheExists { key: key.clone() },
        context.clone(),
    )
    .await
    .expect("exists");
    assert!(matches!(exists, JsValue::Number(found) if found == 0.0));

    eval(
        &mut host,
        HostRequest::CacheSet {
            key: key.clone(),
            value: JsString::from("v"),
        },
        context.clone(),
    )
    .await
    .expect("set");

    eval(
        &mut host,
        HostRequest::CacheExpire {
            key: key.clone(),
            seconds: 86_400,
        },
        context.clone(),
    )
    .await
    .expect("expire");

    let hit = eval(
        &mut host,
        HostRequest::CacheGet { key: key.clone() },
        context.clone(),
    )
    .await
    .expect("get hit");
    assert_eq!(as_text(&hit), "v");

    let exists = eval(
        &mut host,
        HostRequest::CacheExists { key: key.clone() },
        context.clone(),
    )
    .await
    .expect("exists hit");
    assert!(matches!(exists, JsValue::Number(found) if found == 1.0));

    eval(
        &mut host,
        HostRequest::CacheDelete { key: key.clone() },
        context.clone(),
    )
    .await
    .expect("delete");

    let gone = eval(
        &mut host,
        HostRequest::CacheGet { key },
        context,
    )
    .await
    .expect("get after delete");
    assert!(matches!(gone, JsValue::Null));

    assert_eq!(
        locked(&cache.ops).as_slice(),
        [
            "get:k",
            "exists:k",
            "set:k=v",
            "expire:k:86400",
            "get:k",
            "exists:k",
            "delete:k",
            "get:k",
        ]
    );
}

#[tokio::test(flavor = "current_thread")]
async fn channel_variables_use_the_host_scope() {
    let Parts {
        variables, mut host, ..
    } = parts();
    host.set_scope(scope());
    let context = twitch_context(0.0);

    let loaded = eval(
        &mut host,
        HostRequest::LoadChannelVariable {
            name: "score".into(),
        },
        context.clone(),
    )
    .await
    .expect("load");
    assert_eq!(as_text(&loaded), "from-store");

    eval(
        &mut host,
        HostRequest::SaveChannelVariable {
            name: "score".into(),
            value: JsString::from("9"),
        },
        context.clone(),
    )
    .await
    .expect("save");

    eval(
        &mut host,
        HostRequest::DeleteChannelVariable {
            name: "score".into(),
        },
        context,
    )
    .await
    .expect("delete");

    let ops = locked(&variables.ops);
    assert_eq!(ops.len(), 3);
    for op in ops.iter() {
        assert_eq!(op.channel_id, "channel-9");
        assert_eq!(op.user_id, "user-9");
        assert_eq!(op.user_login, "@User");
        assert_eq!(op.name, "score");
        assert!(op.target.is_none());
    }
    assert_eq!(ops[0].kind, "load-channel");
    assert_eq!(ops[1].kind, "save-channel");
    assert_eq!(ops[1].value, "9");
    assert_eq!(ops[2].kind, "delete-channel");
}

#[tokio::test(flavor = "current_thread")]
async fn user_variables_forward_the_optional_target_login() {
    let Parts {
        variables, mut host, ..
    } = parts();
    host.set_scope(scope());
    let context = twitch_context(0.0);

    let loaded = eval(
        &mut host,
        HostRequest::LoadUserVariable {
            name: "score".into(),
            target_user_login: Some(JsString::from("@Other")),
        },
        context.clone(),
    )
    .await
    .expect("load");
    assert_eq!(as_text(&loaded), "from-user");

    eval(
        &mut host,
        HostRequest::SaveUserVariable {
            name: "score".into(),
            value: JsString::from("4"),
            target_user_login: None,
        },
        context.clone(),
    )
    .await
    .expect("save");

    eval(
        &mut host,
        HostRequest::DeleteUserVariable {
            name: "score".into(),
            target_user_login: Some(JsString::default()),
        },
        context.clone(),
    )
    .await
    .expect("delete");

    let surrogate = eval(
        &mut host,
        HostRequest::LoadUserVariable {
            name: "score".into(),
            target_user_login: Some(JsString::from_units(vec![0xD800])),
        },
        context,
    )
    .await
    .expect_err("surrogate login");
    assert_eq!(
        surrogate,
        AstRuntimeError::Host("unpaired UTF-16 surrogate in user login".into())
    );

    let ops = locked(&variables.ops);
    assert_eq!(ops.len(), 3, "a bad login never reaches the store");
    assert_eq!(ops[0].kind, "load-user");
    assert_eq!(ops[0].target.as_deref(), Some("@Other"));
    assert_eq!(ops[0].channel_id, "channel-9");
    assert_eq!(ops[1].kind, "save-user");
    assert_eq!(ops[1].value, "4");
    assert_eq!(ops[1].target, None);
    assert_eq!(ops[2].kind, "delete-user");
    assert_eq!(ops[2].target, None);
}

#[tokio::test(flavor = "current_thread")]
async fn save_responses_records_the_in_process_snapshot() {
    let Parts { mut host, .. } = parts();
    host.set_scope(scope());
    let context = twitch_context(0.0);
    context
        .borrow()
        .command_responses
        .borrow_mut()
        .push(JsValue::string("hello"));

    let value = eval(&mut host, HostRequest::SaveResponses, context)
        .await
        .expect("save");
    assert_eq!(as_text(&value), "");

    let entries = host.response_log().entries();
    assert_eq!(
        entries,
        vec![PersistedCommandResponses {
            channel_id: "channel-9".into(),
            command_id: "cmd-1".into(),
            responses: vec!["hello".into()],
            json: "[\"hello\"]".into(),
        }]
    );
    let _log: Arc<CommandResponseLog> = host.response_log();
}

#[tokio::test(flavor = "current_thread")]
async fn schedule_timer_hands_off_after_the_source_guards() {
    let cache = Arc::new(MemoryCache::default());
    let variables = Arc::new(MemoryVariables::default());
    let recording = Arc::new(RecordingScheduler::default());
    let mut host = ApplicationHost::new(
        Arc::clone(&cache) as Arc<dyn AstCache>,
        Arc::clone(&variables) as Arc<dyn AstVariableStore>,
    )
    .with_timer(Arc::clone(&recording) as Arc<dyn TimerScheduler>);

    let value = eval(
        &mut host,
        HostRequest::ScheduleTimer {
            seconds: 30.0,
            body: timer_body(),
        },
        twitch_context(0.0),
    )
    .await
    .expect("schedule");
    assert_eq!(as_text(&value), "");
    assert_eq!(locked(&recording.seconds).as_slice(), [30.0]);

    for seconds in [1.0, 604_800.0] {
        eval(
            &mut host,
            HostRequest::ScheduleTimer {
                seconds,
                body: timer_body(),
            },
            twitch_context(4.0),
        )
        .await
        .expect("boundary");
    }
    assert_eq!(locked(&recording.seconds).as_slice(), [30.0, 1.0, 604_800.0]);

    let rejected = [
        (0.0, twitch_context(0.0), "timer: seconds must be between 1 and 604800"),
        (
            f64::NAN,
            twitch_context(0.0),
            "timer: seconds must be between 1 and 604800",
        ),
        (
            30.0,
            twitch_context(5.0),
            "timer: maximum nested timer depth reached",
        ),
        (
            30.0,
            context_of(execution("kick", "12345", 0.0)),
            "timer: requires a Twitch channel",
        ),
        (
            30.0,
            context_of(execution("twitch", "", 0.0)),
            "timer: requires a Twitch channel",
        ),
    ];
    for (seconds, context, message) in rejected {
        let error = eval(
            &mut host,
            HostRequest::ScheduleTimer {
                seconds,
                body: timer_body(),
            },
            context,
        )
        .await
        .expect_err("guard");
        assert_eq!(error, AstRuntimeError::Rejected(message.into()));
    }
    assert_eq!(
        locked(&recording.seconds).as_slice(),
        [30.0, 1.0, 604_800.0],
        "rejected timers never reach the seam"
    );

    let error = eval(
        &mut host,
        HostRequest::Function {
            name: "timer".into(),
            args: vec![JsValue::Number(30.0)],
        },
        twitch_context(0.0),
    )
    .await
    .expect_err("timer function");
    assert!(matches!(error, AstRuntimeError::Unsupported(message) if message.contains("ScheduleTimer")));
    assert_eq!(locked(&recording.seconds).len(), 3);
}

#[tokio::test(flavor = "current_thread")]
async fn schedule_timer_without_an_adapter_is_unsupported() {
    let Parts { mut host, .. } = parts();
    let error = eval(
        &mut host,
        HostRequest::ScheduleTimer {
            seconds: 30.0,
            body: timer_body(),
        },
        twitch_context(0.0),
    )
    .await
    .expect_err("unwired");
    assert_eq!(
        error,
        AstRuntimeError::Unsupported(TIMER_ADAPTER_GAP.into())
    );
    assert_eq!(TIMER_ADAPTER_GAP, "AST timer scheduling adapter is not wired yet");
}

#[tokio::test(flavor = "current_thread")]
async fn a_failing_scheduler_is_a_typed_error() {
    let Parts { cache, variables, .. } = parts();
    let mut host = ApplicationHost::new(
        Arc::clone(&cache) as Arc<dyn AstCache>,
        Arc::clone(&variables) as Arc<dyn AstVariableStore>,
    )
    .with_timer(Arc::new(FailingScheduler));
    let error = eval(
        &mut host,
        HostRequest::ScheduleTimer {
            seconds: 12.0,
            body: timer_body(),
        },
        twitch_context(0.0),
    )
    .await
    .expect_err("scheduler");
    assert_eq!(error, AstRuntimeError::Host("timer store down".into()));
}

#[tokio::test(flavor = "current_thread")]
async fn unsupported_function_families_are_not_fake_values() {
    let Parts { mut host, .. } = parts();
    let context = twitch_context(0.0);

    let ban = eval(
        &mut host,
        HostRequest::Function {
            name: "ban".into(),
            args: vec![],
        },
        context.clone(),
    )
    .await
    .expect_err("ban");
    assert_eq!(
        ban,
        AstRuntimeError::Unsupported(
            "AST function family moderation has no native adapter (ban)".into()
        )
    );

    let live = eval(
        &mut host,
        HostRequest::Function {
            name: "twitch.live".into(),
            args: vec![],
        },
        context.clone(),
    )
    .await
    .expect_err("twitch.live");
    assert_eq!(
        live,
        AstRuntimeError::Unsupported(
            "AST function family twitch-data has no native adapter (twitch.live)".into()
        )
    );

    let upper = eval(
        &mut host,
        HostRequest::Function {
            name: "upper".into(),
            args: vec![JsValue::string("hi")],
        },
        context.clone(),
    )
    .await
    .expect_err("upper");
    assert_eq!(
        upper,
        AstRuntimeError::Unsupported(
            "AST pure function `upper` is owned by the evaluator and has no host adapter".into()
        )
    );

    let broken = eval(
        &mut host,
        HostRequest::Function {
            name: "break".into(),
            args: vec![],
        },
        context.clone(),
    )
    .await
    .expect("break");
    assert_eq!(as_text(&broken), "");
    assert!(matches!(context.borrow().loop_exit, Some(LoopExit::Break)));
}

#[tokio::test(flavor = "current_thread")]
async fn a_failing_cache_adapter_is_a_typed_host_error() {
    let Parts { cache, mut host, .. } = parts();
    *locked(&cache.fail_get) = Some("boom".into());
    let error = eval(
        &mut host,
        HostRequest::CacheGet {
            key: JsString::from("k"),
        },
        twitch_context(0.0),
    )
    .await
    .expect_err("boom");
    assert_eq!(error, AstRuntimeError::Host("boom".into()));
    assert_eq!(locked(&cache.ops).as_slice(), ["get:k"]);
}

#[tokio::test(flavor = "current_thread")]
async fn a_lone_surrogate_cache_key_does_not_panic() {
    let Parts { cache, mut host, .. } = parts();
    let error = eval(
        &mut host,
        HostRequest::CacheGet {
            key: JsString::from_units(vec![0xD800]),
        },
        twitch_context(0.0),
    )
    .await
    .expect_err("surrogate");
    assert_eq!(
        error,
        AstRuntimeError::Host("unpaired UTF-16 surrogate in cache key".into())
    );
    assert!(locked(&cache.ops).is_empty());
}

#[tokio::test(flavor = "current_thread")]
async fn delay_and_chat_send_follow_the_source_handlers() {
    let Parts { mut host, .. } = parts();
    let context = twitch_context(0.0);

    let missing = eval(
        &mut host,
        HostRequest::Function {
            name: "delay".into(),
            args: vec![],
        },
        context.clone(),
    )
    .await
    .expect("delay missing");
    assert_eq!(as_text(&missing), "delay: missing argument (seconds)");

    let invalid = eval(
        &mut host,
        HostRequest::Function {
            name: "delay".into(),
            args: vec![JsValue::string("nope")],
        },
        context.clone(),
    )
    .await
    .expect("delay invalid");
    assert_eq!(as_text(&invalid), "delay: \"nope\" is not a valid number");

    let range = eval(
        &mut host,
        HostRequest::Function {
            name: "delay".into(),
            args: vec![JsValue::Number(61.0)],
        },
        context.clone(),
    )
    .await
    .expect("delay range");
    assert_eq!(as_text(&range), "delay: must be between 0 and 60 seconds");

    let paused = eval(
        &mut host,
        HostRequest::Function {
            name: "delay".into(),
            args: vec![JsValue::Number(0.0)],
        },
        context.clone(),
    )
    .await
    .expect("delay zero");
    assert_eq!(as_text(&paused), "");

    let empty = eval(
        &mut host,
        HostRequest::Function {
            name: "chat.send".into(),
            args: vec![JsValue::string("   ")],
        },
        context.clone(),
    )
    .await
    .expect("empty chat");
    assert_eq!(as_text(&empty), "");

    let unwired = eval(
        &mut host,
        HostRequest::Function {
            name: "chat.send".into(),
            args: vec![JsValue::string("hello")],
        },
        context,
    )
    .await
    .expect_err("chat");
    assert_eq!(
        unwired,
        AstRuntimeError::Unsupported("chat.send has no TwitchFunctions adapter".into())
    );
}

#[test]
fn variable_plans_keep_the_source_filter_asymmetry() {
    let now = DateTime::from_millis(1_700_000_000_000);
    let owned = scope();

    let channel_read = plan_variable_read("channel-9", "global", "global", "score", "", "");
    assert_eq!(channel_read.filter.get_str("userId").expect("userId"), "");
    assert!(channel_read.filter.get("userLogin").is_none());

    let channel_write = plan_variable_upsert(
        "channel-9", "global", "global", "score", "", "", "", now,
    );
    assert_eq!(
        channel_write.filter.get_str("userLogin").expect("userLogin"),
        ""
    );
    assert!(channel_write.filter.get("userId").is_none());
    assert!(channel_write.login_fallback_filter.is_none());

    let user_read =
        plan_variable_read("channel-9", "global", "global", "score", "user-9", "@User");
    assert_eq!(user_read.filter.get_str("userLogin").expect("login"), "user");
    assert!(user_read.filter.get("userId").is_none());
    let legacy = user_read.legacy_filter.expect("global legacy filter");
    assert_eq!(
        legacy
            .get_document("scopeType")
            .expect("scopeType")
            .get_str("$ne")
            .expect("$ne"),
        "global"
    );
    assert_eq!(
        legacy
            .get_document("variables.score")
            .expect("variable")
            .get_bool("$exists")
            .expect("$exists"),
        true
    );

    let user_write = plan_variable_upsert(
        "channel-9",
        "global",
        "global",
        "score",
        "",
        "user-9",
        "@User",
        now,
    );
    assert_eq!(user_write.filter.get_str("userId").expect("userId"), "user-9");
    let fallback = user_write
        .login_fallback_filter
        .expect("11000 login fallback");
    assert_eq!(fallback.get_str("userLogin").expect("login"), "user");
    assert!(fallback.get("userId").is_none());
    let set = user_write.update.get_document("$set").expect("$set");
    assert_eq!(set.get_str("variables.score").expect("tombstone"), "");
    assert_eq!(set.get("updatedAt"), Some(&Bson::DateTime(now)));
    let on_insert = user_write
        .update
        .get_document("$setOnInsert")
        .expect("$setOnInsert");
    assert_eq!(on_insert.get_str("userLogin").expect("login"), "user");
    assert_eq!(on_insert.get_i32("__v").expect("__v"), 0);
    assert_eq!(on_insert.get("createdAt"), Some(&Bson::DateTime(now)));

    let other = resolve_user_save(&owned, Some("@Other"));
    assert!(!other.skipped);
    assert_eq!(other.user_id, "login:other");
    assert_eq!(other.user_login, "other");

    let same = resolve_user_save(&owned, Some("@User"));
    assert_eq!(same.user_id, "user-9");
    assert_eq!(same.user_login, "user");

    let deleted = resolve_user_delete(&owned, Some("@Other"));
    assert_eq!(deleted.user_id, "");
    assert_eq!(deleted.user_login, "other");
    let delete_plan = plan_variable_upsert(
        "channel-9",
        "global",
        "global",
        "score",
        "",
        &deleted.user_id,
        &deleted.user_login,
        now,
    );
    assert_eq!(
        delete_plan.filter.get_str("userLogin").expect("login"),
        "other"
    );
    assert!(delete_plan.filter.get("userId").is_none());
    assert_eq!(
        delete_plan
            .update
            .get_document("$set")
            .expect("$set")
            .get_str("variables.score")
            .expect("tombstone"),
        ""
    );

    let loaded = resolve_user_load(&owned, None);
    assert_eq!(loaded.user_id, "user-9");
    assert_eq!(loaded.user_login, "@User");
    assert!(resolve_user_save(&AstScope::new("channel-9"), None).skipped);
    assert!(resolve_user_load(&AstScope::new("channel-9"), None).skipped);
    assert!(resolve_user_delete(&AstScope::new("channel-9"), None).skipped);

    let command = plan_variable_read("channel-9", "command", "default", "score", "", "");
    assert!(command.legacy_filter.is_none());
}

#[test]
fn a_present_empty_variable_is_a_tombstone() {
    let mut variables = Document::new();
    variables.insert("score", "");
    let mut document = Document::new();
    document.insert("variables", variables);
    assert_eq!(stored_variable(&document, "score"), Some(String::new()));

    let mut variables = Document::new();
    variables.insert("score", Bson::Null);
    let mut document = Document::new();
    document.insert("variables", variables);
    assert_eq!(stored_variable(&document, "score"), Some(String::new()));

    let mut variables = Document::new();
    variables.insert("other", "x");
    let mut document = Document::new();
    document.insert("variables", variables);
    assert_eq!(stored_variable(&document, "score"), None);
}

#[test]
fn effect_fork_delegates_to_the_runtime_authority() {
    let origin = EffectOrigin {
        id: "evt-1".into(),
        kind: "chat-command".into(),
        occurred_at: "2020-01-01T00:00:00.000Z".into(),
    };
    let actor = EffectActor {
        user_id: "9".into(),
        display_name: "User".into(),
    };
    let minted = effects::create_twitch_effect_context("123", origin, actor)
        .expect("verified twitch effect");
    let scoped = effects::scope_ast_effect_context(Some(&minted), "123", "cmd")
        .expect("scoped effect");
    let mut host = parts().host;
    assert!(host.fork_effect(&minted).is_none());
    let child = host.fork_effect(&scoped).expect("fork");
    assert!(!child.same_identity(&scoped));
    let again = host.fork_effect(&scoped).expect("second fork");
    assert!(!child.same_identity(&again));
    let foreign = EffectToken::from_host(String::from("foreign"));
    assert!(host.fork_effect(&foreign).is_none());
}

#[test]
fn eval_errors_round_trip_the_runtime_variant() {
    for error in [
        AstRuntimeError::Host("boom".into()),
        AstRuntimeError::Unsupported("missing".into()),
        AstRuntimeError::Rejected("timer: seconds must be between 1 and 604800".into()),
        AstRuntimeError::Syntax("bad".into()),
        AstRuntimeError::Evaluation("bad".into()),
        AstRuntimeError::Cancelled,
    ] {
        assert_eq!(from_eval_error(&to_eval_error(error.clone())), error);
    }
}

#[test]
fn production_construction_does_not_connect() {
    let mut host = ApplicationHost::production();
    host.set_scope(scope());
    let _ = host.response_log();
}
