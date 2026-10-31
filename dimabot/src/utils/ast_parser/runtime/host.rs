//! Application host for one AST evaluation.
//!
//! Lane A's [`super::wiring::BotRuntime`] constructs this type with
//! [`ApplicationHost::new`], then installs the AST function catalog with
//! [`ApplicationHost::with_functions`] and the timer scheduler with
//! [`ApplicationHost::with_timer`]. Construction performs no I/O. Dragonfly and
//! MongoDB are reached only when a cache or variable operation runs.
//!
//! `HostRequest::ScheduleTimer` keeps the source's guards here and then hands
//! the job to a [`TimerScheduler`] supplied with [`ApplicationHost::with_timer`].
//! The Dragonfly timer job store (caps, the 10-minute grace, the at-most-once
//! claim, and execution) belongs to `ast_timer_runtime` and is not called from
//! this file. `BotRuntime::new` does not install a scheduler, so a production
//! host reports [`TIMER_ADAPTER_GAP`] until integration wires one. A missing
//! adapter is a typed error, never a successful timer.

use std::sync::{Arc, Mutex};

use crate::{
    utils::ast_evaluator::{
        Context, DispatchKind, EffectToken, EvalError, FunctionRegistry, Host, HostFuture,
        HostRequest, JsString, JsValue, builtin, js_string, json_stringify,
    },
    utils::ast_syntax::AstNode,
};

use super::{
    AstCache, AstFunctionCatalog, AstRuntimeError, AstScope, AstVariableStore, BoxFuture,
    ScopedAstHost,
};

/// Inclusive upper bound from `$(timer seconds …)`: 7 days, in seconds.
pub const MAX_TIMER_SECONDS: f64 = 604_800.0;
/// Source rejects another timer once `timer_depth` is already 5.
pub const MAX_TIMER_DEPTH: f64 = 5.0;
/// Returned for [`HostRequest::ScheduleTimer`] when [`ApplicationHost::with_timer`]
/// was not called. Integration must supply a [`TimerScheduler`]; this is not a
/// successful schedule.
pub const TIMER_ADAPTER_GAP: &str = "AST timer scheduling adapter is not wired yet";

/// Divisor for the 48 random bits taken from a v4 UUID (bytes 0..6).
const UUID_48_SPACE: f64 = 281_474_976_710_656.0;

const TIMER_SECONDS_MESSAGE: &str = "timer: seconds must be between 1 and 604800";
const TIMER_DEPTH_MESSAGE: &str = "timer: maximum nested timer depth reached";
const TIMER_CHANNEL_MESSAGE: &str = "timer: requires a Twitch channel";

/// Host functions this adapter actually runs. Every other family is
/// [`AstRuntimeError::Unsupported`].
pub const SUPPORTED_HOST_FUNCTIONS: &[&str] = &["chat.send", "delay"];

/// Handoff for `HostRequest::ScheduleTimer`.
///
/// The production body is `AstTimerScheduler::schedule(&mut self, seconds, body,
/// context)` in `dimabot/src/utils/ast_timer_runtime.rs`. That method needs
/// `&mut self` and is not called here. Integration wraps it (interior
/// mutability is enough: the host future is not `Send`) in a type that
/// implements this trait, then passes `Arc<dyn TimerScheduler>` to
/// [`ApplicationHost::with_timer`] on both hosts inside
/// [`BotRuntime::with_functions`](super::wiring::BotRuntime::with_functions).
///
/// `schedule` must perform the real enqueue. `Ok(())` means the job was
/// accepted. `Err` is propagated. This trait does not apply backlog caps, the
/// grace period, or the at-most-once claim.
pub trait TimerScheduler: Send + Sync {
    fn schedule<'a>(
        &'a self,
        seconds: f64,
        body: &'a AstNode,
        context: &'a Context,
    ) -> BoxFuture<'a, Result<(), AstRuntimeError>>;
}

/// One `SaveResponses` observation.
///
/// The TypeScript hook is a no-op, and `ast_syntax::persistence` only checks
/// JSON nesting. This log is the in-process record that the host path ran. It
/// is not a Mongo collection and it does not write `commands.responses`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PersistedCommandResponses {
    pub channel_id: String,
    pub command_id: String,
    pub responses: Vec<String>,
    pub json: String,
}

/// In-process snapshot of `SaveResponses`. Shared by clones of the `Arc` the
/// host stores, so a test can read what the host recorded.
#[derive(Debug, Default)]
pub struct CommandResponseLog {
    entries: Mutex<Vec<PersistedCommandResponses>>,
}

impl CommandResponseLog {
    pub fn new() -> Self {
        Self {
            entries: Mutex::new(Vec::new()),
        }
    }

    pub fn record(&self, entry: PersistedCommandResponses) {
        self.entries
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .push(entry);
    }

    pub fn entries(&self) -> Vec<PersistedCommandResponses> {
        self.entries
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .clone()
    }
}

/// Dragonfly cache used by the evaluator's `Cache*` host requests.
///
/// `new` does not connect. Each operation calls
/// [`crate::utils::redis::get_redis_client`] and drops the manager, so a
/// shutdown of the process client is not pinned by this value.
/// `ApplicationCacheRuntime::acquire` is not used: a cache read must not start
/// the observability telemetry that `acquire` installs.
///
/// `SET` and `EXPIRE` stay separate. The evaluator sends `CacheSet` and then
/// `CacheExpire` (86400 seconds). This adapter does not invent a TTL.
#[derive(Clone, Debug, Default)]
pub struct DragonflyAstCache;

impl DragonflyAstCache {
    pub fn new() -> Self {
        Self
    }

    async fn connection() -> Result<redis::aio::ConnectionManager, AstRuntimeError> {
        crate::utils::redis::get_redis_client()
            .await
            .map_err(|error| AstRuntimeError::Host(format!("dragonfly cache: {error}")))
    }
}

impl AstCache for DragonflyAstCache {
    fn get<'a>(&'a self, key: &'a str) -> BoxFuture<'a, Result<Option<String>, AstRuntimeError>> {
        Box::pin(async move {
            let mut connection = Self::connection().await?;
            redis::cmd("GET")
                .arg(key)
                .query_async(&mut connection)
                .await
                .map_err(|error| AstRuntimeError::Host(format!("dragonfly cache: {error}")))
        })
    }

    fn exists<'a>(&'a self, key: &'a str) -> BoxFuture<'a, Result<bool, AstRuntimeError>> {
        Box::pin(async move {
            let mut connection = Self::connection().await?;
            let count: i64 = redis::cmd("EXISTS")
                .arg(key)
                .query_async(&mut connection)
                .await
                .map_err(|error| AstRuntimeError::Host(format!("dragonfly cache: {error}")))?;
            Ok(count > 0)
        })
    }

    fn set<'a>(
        &'a self,
        key: &'a str,
        value: &'a str,
    ) -> BoxFuture<'a, Result<(), AstRuntimeError>> {
        Box::pin(async move {
            let mut connection = Self::connection().await?;
            let _: redis::Value = redis::cmd("SET")
                .arg(key)
                .arg(value)
                .query_async(&mut connection)
                .await
                .map_err(|error| AstRuntimeError::Host(format!("dragonfly cache: {error}")))?;
            Ok(())
        })
    }

    fn expire<'a>(
        &'a self,
        key: &'a str,
        seconds: u64,
    ) -> BoxFuture<'a, Result<(), AstRuntimeError>> {
        Box::pin(async move {
            let seconds = i64::try_from(seconds).map_err(|_| {
                AstRuntimeError::Host("cache expire seconds do not fit a Redis integer".into())
            })?;
            let mut connection = Self::connection().await?;
            let _: redis::Value = redis::cmd("EXPIRE")
                .arg(key)
                .arg(seconds)
                .query_async(&mut connection)
                .await
                .map_err(|error| AstRuntimeError::Host(format!("dragonfly cache: {error}")))?;
            Ok(())
        })
    }

    fn delete<'a>(&'a self, key: &'a str) -> BoxFuture<'a, Result<(), AstRuntimeError>> {
        Box::pin(async move {
            let mut connection = Self::connection().await?;
            let _: redis::Value = redis::cmd("DEL")
                .arg(key)
                .query_async(&mut connection)
                .await
                .map_err(|error| AstRuntimeError::Host(format!("dragonfly cache: {error}")))?;
            Ok(())
        })
    }
}

/// Scoped application host. One evaluation binds it with [`ScopedAstHost::set_scope`].
/// Parsing and command execution need two values because the scope is `&mut`.
pub struct ApplicationHost {
    cache: Arc<dyn AstCache>,
    variables: Arc<dyn AstVariableStore>,
    scope: AstScope,
    timer: Option<Arc<dyn TimerScheduler>>,
    functions: Option<Arc<dyn AstFunctionCatalog>>,
    responses: Arc<CommandResponseLog>,
    registry: FunctionRegistry,
}

impl ApplicationHost {
    /// No I/O. The cache and the variable store are not contacted.
    pub fn new(cache: Arc<dyn AstCache>, variables: Arc<dyn AstVariableStore>) -> ApplicationHost {
        Self {
            cache,
            variables,
            scope: AstScope::default(),
            timer: None,
            functions: None,
            responses: Arc::new(CommandResponseLog::new()),
            registry: function_registry(),
        }
    }

    /// Dragonfly cache plus the Mongo `astvariables` store. Still no I/O.
    pub fn production() -> ApplicationHost {
        Self::new(
            Arc::new(DragonflyAstCache::new()),
            Arc::new(super::variables::MongoAstVariableStore::new()),
        )
    }

    /// Install the timer handoff. Without this, `ScheduleTimer` stays
    /// [`TIMER_ADAPTER_GAP`] after the source guards pass.
    pub fn with_timer(mut self, timer: Arc<dyn TimerScheduler>) -> ApplicationHost {
        self.timer = Some(timer);
        self
    }

    /// Install the AST function catalog.
    ///
    /// The catalog is the single owner of the application-backed AST function
    /// families (`chat.send`, `delay`, and whatever it adds next). The host
    /// does not implement them itself, so a family can never be served by two
    /// different code paths.
    pub fn with_functions(mut self, functions: Arc<dyn AstFunctionCatalog>) -> ApplicationHost {
        self.functions = Some(functions);
        self
    }

    pub fn response_log(&self) -> Arc<CommandResponseLog> {
        Arc::clone(&self.responses)
    }

    async fn handle(
        &mut self,
        request: HostRequest,
        context: &Context,
    ) -> Result<JsValue, AstRuntimeError> {
        match request {
            HostRequest::Function { name, args } => self.call_function(&name, &args, context).await,
            HostRequest::CacheGet { key } => self.cache_get(&key).await,
            HostRequest::CacheExists { key } => self.cache_exists(&key).await,
            HostRequest::CacheSet { key, value } => self.cache_set(&key, &value).await,
            HostRequest::CacheExpire { key, seconds } => self.cache_expire(&key, seconds).await,
            HostRequest::CacheDelete { key } => self.cache_delete(&key).await,
            HostRequest::LoadChannelVariable { name } => {
                let value = self
                    .variables
                    .load_channel_variable(&self.scope, &name)
                    .await?;
                Ok(JsValue::string(value))
            }
            HostRequest::SaveChannelVariable { name, value } => {
                let value = utf8_text(&value, "variable value")?;
                self.variables
                    .save_channel_variable(&self.scope, &name, &value)
                    .await?;
                Ok(JsValue::string(""))
            }
            HostRequest::DeleteChannelVariable { name } => {
                self.variables
                    .delete_channel_variable(&self.scope, &name)
                    .await?;
                Ok(JsValue::string(""))
            }
            HostRequest::LoadUserVariable {
                name,
                target_user_login,
            } => {
                let target = target_login(target_user_login.as_ref())?;
                let value = self
                    .variables
                    .load_user_variable(&self.scope, &name, target.as_deref())
                    .await?;
                Ok(JsValue::string(value))
            }
            HostRequest::SaveUserVariable {
                name,
                value,
                target_user_login,
            } => {
                let value = utf8_text(&value, "variable value")?;
                let target = target_login(target_user_login.as_ref())?;
                self.variables
                    .save_user_variable(&self.scope, &name, &value, target.as_deref())
                    .await?;
                Ok(JsValue::string(""))
            }
            HostRequest::DeleteUserVariable {
                name,
                target_user_login,
            } => {
                let target = target_login(target_user_login.as_ref())?;
                self.variables
                    .delete_user_variable(&self.scope, &name, target.as_deref())
                    .await?;
                Ok(JsValue::string(""))
            }
            HostRequest::SaveResponses => self.save_responses(context),
            HostRequest::ScheduleTimer { seconds, body } => {
                self.schedule_timer(seconds, &body, context).await
            }
        }
    }

    async fn cache_get(&self, key: &JsString) -> Result<JsValue, AstRuntimeError> {
        let key = utf8_text(key, "cache key")?;
        match self.cache.get(&key).await? {
            Some(value) => Ok(JsValue::string(value)),
            None => Ok(JsValue::Null),
        }
    }

    async fn cache_exists(&self, key: &JsString) -> Result<JsValue, AstRuntimeError> {
        let key = utf8_text(key, "cache key")?;
        let found = self.cache.exists(&key).await?;
        Ok(JsValue::Number(if found { 1.0 } else { 0.0 }))
    }

    async fn cache_set(&self, key: &JsString, value: &JsString) -> Result<JsValue, AstRuntimeError> {
        let key = utf8_text(key, "cache key")?;
        let value = utf8_text(value, "cache value")?;
        self.cache.set(&key, &value).await?;
        Ok(JsValue::string(""))
    }

    async fn cache_expire(&self, key: &JsString, seconds: u64) -> Result<JsValue, AstRuntimeError> {
        let key = utf8_text(key, "cache key")?;
        self.cache.expire(&key, seconds).await?;
        Ok(JsValue::string(""))
    }

    async fn cache_delete(&self, key: &JsString) -> Result<JsValue, AstRuntimeError> {
        let key = utf8_text(key, "cache key")?;
        self.cache.delete(&key).await?;
        Ok(JsValue::string(""))
    }

    fn save_responses(&self, context: &Context) -> Result<JsValue, AstRuntimeError> {
        let (command_id, values) = {
            let execution = context.borrow();
            (
                execution.command_id.clone(),
                execution.command_responses.borrow().clone(),
            )
        };
        let responses = values
            .iter()
            .map(|value| String::from_utf16_lossy(js_string(value).units()))
            .collect();
        let json = match json_stringify(&JsValue::array(values)) {
            Ok(Some(text)) => String::from_utf16_lossy(text.units()),
            Ok(None) => String::new(),
            Err(error) => return Err(AstRuntimeError::Evaluation(error.message)),
        };
        self.responses.record(PersistedCommandResponses {
            channel_id: self.scope.channel_id.clone(),
            command_id,
            responses,
            json,
        });
        Ok(JsValue::string(""))
    }

    async fn schedule_timer(
        &self,
        seconds: f64,
        body: &AstNode,
        context: &Context,
    ) -> Result<JsValue, AstRuntimeError> {
        // Same order as the evaluator: depth, Twitch channel, then seconds.
        // The VM collapses every host `Err` into "timer: could not schedule
        // timer"; direct callers still see the typed guard.
        let depth = context.borrow().timer_depth.unwrap_or(0.0);
        if depth >= MAX_TIMER_DEPTH {
            return Err(AstRuntimeError::Rejected(TIMER_DEPTH_MESSAGE.into()));
        }
        let broadcaster_id_empty = context.borrow().broadcaster_id.is_empty();
        let twitch = context.borrow().platform == "twitch";
        if broadcaster_id_empty || !twitch {
            return Err(AstRuntimeError::Rejected(TIMER_CHANNEL_MESSAGE.into()));
        }
        if !seconds.is_finite() || !(1.0..=MAX_TIMER_SECONDS).contains(&seconds) {
            return Err(AstRuntimeError::Rejected(TIMER_SECONDS_MESSAGE.into()));
        }
        let Some(scheduler) = &self.timer else {
            return Err(AstRuntimeError::Unsupported(TIMER_ADAPTER_GAP.into()));
        };
        scheduler.schedule(seconds, body, context).await?;
        Ok(JsValue::string(""))
    }

    async fn call_function(
        &self,
        name: &str,
        args: &[JsValue],
        context: &Context,
    ) -> Result<JsValue, AstRuntimeError> {
        // The VM dispatches context and pure functions before the host. A
        // direct `HostRequest::Function` still has to refuse a fake value.
        let kind = self.registry.get(name).map(|entry| entry.dispatch);
        match kind {
            Some(DispatchKind::Context) => {
                return match name {
                    "count" | "scount" | "bits" | "break" | "continue" => {
                        Ok(builtin(name, args, context))
                    }
                    _ => Err(unsupported_function(name)),
                };
            }
            #[cfg(feature = "ast-pure-functions")]
            Some(DispatchKind::Pure(_)) => {
                return Err(AstRuntimeError::Unsupported(format!(
                    "AST pure function `{name}` is owned by the evaluator and has no host adapter"
                )));
            }
            Some(DispatchKind::Host) | None => {}
        }
        // The catalog owns the application-backed families. Without one
        // installed, the host refuses rather than serving a family itself.
        match &self.functions {
            Some(catalog) => catalog.call(&self.scope, name, args).await,
            None => Err(unsupported_function(name)),
        }
    }
}

impl ScopedAstHost for ApplicationHost {
    fn set_scope(&mut self, scope: AstScope) {
        self.scope = scope;
    }
}

impl Host for ApplicationHost {
    fn execute<'a>(&'a mut self, request: HostRequest, context: Context) -> HostFuture<'a> {
        Box::pin(async move { self.handle(request, &context).await.map_err(to_eval_error) })
    }

    fn random(&mut self) -> Result<f64, EvalError> {
        // `Uuid::new_v4` panics inside the uuid crate when the process has no
        // entropy. This function does not add its own unwrap. Bytes 0..6 are
        // the 48 bits that are not the version or variant nibbles.
        let bytes = uuid::Uuid::new_v4().as_bytes();
        let mut bits = 0u64;
        for byte in bytes[0..6].iter().copied() {
            bits = (bits << 8) | u64::from(byte);
        }
        Ok((bits as f64) / UUID_48_SPACE)
    }

    fn fork_effect(&mut self, effect: &EffectToken) -> Option<EffectToken> {
        // `runtime/effects.rs` owns the private authority state. Cloning the
        // `Rc` would be the same token, and the default `Host` method returns
        // `None`, which strips authority on a command reference.
        super::effects::fork_ast_effect_context(Some(effect))
    }
}

/// Encode a runtime error so [`Host::execute`]'s `EvalError` still names the variant.
pub fn to_eval_error(error: AstRuntimeError) -> EvalError {
    let name = match &error {
        AstRuntimeError::Unsupported(_) => "Unsupported",
        AstRuntimeError::Host(_) => "Host",
        AstRuntimeError::Rejected(_) => "Rejected",
        AstRuntimeError::Cancelled => "Cancelled",
        AstRuntimeError::Syntax(_) => "Syntax",
        AstRuntimeError::Evaluation(_) => "Evaluation",
    };
    EvalError {
        name: name.into(),
        message: error.message().to_owned(),
    }
}

/// Inverse of [`to_eval_error`]. An unknown `name` stays an [`AstRuntimeError::Evaluation`].
pub fn from_eval_error(error: &EvalError) -> AstRuntimeError {
    match error.name.as_str() {
        "Unsupported" => AstRuntimeError::Unsupported(error.message.clone()),
        "Host" => AstRuntimeError::Host(error.message.clone()),
        "Rejected" => AstRuntimeError::Rejected(error.message.clone()),
        "Cancelled" => AstRuntimeError::Cancelled,
        "Syntax" => AstRuntimeError::Syntax(error.message.clone()),
        _ => AstRuntimeError::Evaluation(error.message.clone()),
    }
}

/// Family label for an AST function that has no native host adapter.
///
/// EventSub names, string names, `user` / `touser`, and `random` are evaluator
/// pure or context functions. They are listed so an unexpected host request
/// still names the family instead of returning a stand-in value.
pub fn ast_function_family(name: &str) -> &'static str {
    match name {
        "chat.send" | "announce" | "chat.announcement" => "chat",
        "delay" | "timer" | "break" | "continue" => "flow",
        "count" | "scount" | "bits" => "counters",
        "upper" | "lower" | "title" | "capitalize" | "trim" | "length" | "slice" | "replace" => {
            "string"
        }
        "user" | "touser" => "user",
        "random" => "random",
        "randomuser" => "randomuser",
        "followage" => "followage",
        "create.clip" => "clip",
        "trigger.send" => "trigger",
        "bot.mode" => "defense",
        "warn" | "vip" | "add.vip" | "channel.add.vip" | "twitch.add.vip" | "unvip" | "ban"
        | "ban.self" | "ban.mod" | "mod" | "add.mod" | "channel.add.mod" | "twitch.add.mod"
        | "unmod" | "permit" | "clear.chat" | "emoteonly" => "moderation",
        "twitch.live" | "twitch.subs" | "twitch.title" | "twitch.game" | "twitch.viewers"
        | "twitch.follows" | "twitch.channel" | "twitch.login" => "twitch-data",
        "twitch.modiversary" | "twitch.streak" | "raid.channel" | "raid.login" | "raid.viewers"
        | "cheer.amount" | "cheer.message" | "sub.tier" | "sub.months" | "gifted.user"
        | "hypetrain.progress" | "hypetrain.level" | "hypetrain.end" | "shoutout.channel"
        | "reward.input" | "redemption.input" => "eventsub",
        "raid" | "unraid" | "set.title" | "set.game" | "set.voice" | "start.prediction"
        | "get.prediction" | "lock.prediction" | "end.prediction" | "cancel.prediction"
        | "start.poll" | "get.poll" | "end.poll" | "cancel.poll" | "ad" | "ad.time" | "ai" => {
            "channel"
        }
        "tts" | "tts.speak" | "tts.piper" | "tts.ai" | "tts.kokoro" | "tts.clone" | "tts.fish" => {
            "tts"
        }
        "pet.talk" | "pet.ask" => "pet",
        "pin" | "pin.create" | "pin.update" | "pin.del" | "pin.delete" => "pin",
        _ if name.starts_with("overlay.") => "overlay",
        _ if name.starts_with("roulette.") => "roulette",
        _ if name.starts_with("enable.") || name.starts_with("disable.") => "availability",
        _ => "unregistered",
    }
}

fn unsupported_function(name: &str) -> AstRuntimeError {
    if name == "timer" {
        return AstRuntimeError::Unsupported(
            "AST function `timer` is scheduled through HostRequest::ScheduleTimer, not as a host function value".into(),
        );
    }
    let family = ast_function_family(name);
    AstRuntimeError::Unsupported(format!(
        "AST function family {family} has no native adapter ({name})"
    ))
}

fn utf8_text(value: &JsString, what: &str) -> Result<String, AstRuntimeError> {
    value.to_utf8().map_err(|_| {
        AstRuntimeError::Host(format!("unpaired UTF-16 surrogate in {what}"))
    })
}

fn target_login(target: Option<&JsString>) -> Result<Option<String>, AstRuntimeError> {
    let Some(target) = target else {
        return Ok(None);
    };
    if target.is_empty() {
        return Ok(None);
    }
    let login = target.to_utf8().map_err(|_| {
        AstRuntimeError::Host("unpaired UTF-16 surrogate in user login".into())
    })?;
    if login.is_empty() {
        Ok(None)
    } else {
        Ok(Some(login))
    }
}

#[cfg(feature = "ast-pure-functions")]
fn function_registry() -> FunctionRegistry {
    let mut registry = FunctionRegistry::with_context_builtins();
    registry.register_pure_builtins();
    registry
}

#[cfg(not(feature = "ast-pure-functions"))]
fn function_registry() -> FunctionRegistry {
    FunctionRegistry::with_context_builtins()
}
