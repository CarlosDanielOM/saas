# Lane B — AST application host

Authoring only. Nothing in this lane was compiled, formatted, or executed. No Cargo.toml edit, no `utils/mod.rs` edit, no `wiring.rs` edit, no `ast_timer_runtime.rs` file (that worker already owns `dimabot/src/utils/ast_timer_runtime.rs`).

## Files

- `dimabot/src/utils/ast_parser/runtime/host.rs`
- `dimabot/src/utils/ast_parser/runtime/variables.rs`
- `dimabot/tests/ast_application_host.rs` (first line `#![cfg(feature = "ast-bot-runtime")]`, no `[[test]]` entry)
- This note

## Public API

```rust
impl ApplicationHost {
    pub fn new(cache: Arc<dyn AstCache>, variables: Arc<dyn AstVariableStore>) -> ApplicationHost;
    pub fn production() -> ApplicationHost;
    pub fn with_twitch(self, twitch: TwitchFunctions) -> ApplicationHost;
    pub fn with_timer(self, timer: Arc<dyn TimerScheduler>) -> ApplicationHost;
    pub fn response_log(&self) -> Arc<CommandResponseLog>;
}
impl ScopedAstHost for ApplicationHost {
    fn set_scope(&mut self, scope: AstScope);
}
impl crate::utils::ast_evaluator::Host for ApplicationHost { /* every HostRequest */ }

pub trait TimerScheduler: Send + Sync {
    fn schedule<'a>(
        &'a self,
        seconds: f64,
        body: &'a crate::utils::ast_syntax::AstNode,
        context: &'a crate::utils::ast_evaluator::Context,
    ) -> BoxFuture<'a, Result<(), AstRuntimeError>>;
}

pub const MAX_TIMER_SECONDS: f64 = 604_800.0;
pub const MAX_TIMER_DEPTH: f64 = 5.0;
pub const TIMER_ADAPTER_GAP: &str = "AST timer scheduling adapter is not wired yet";
pub const SUPPORTED_HOST_FUNCTIONS: &[&str] = &["chat.send", "delay"];

pub fn to_eval_error(error: AstRuntimeError) -> EvalError;
pub fn from_eval_error(error: &EvalError) -> AstRuntimeError;
pub fn ast_function_family(name: &str) -> &'static str;

pub struct DragonflyAstCache;
impl DragonflyAstCache { pub fn new() -> Self; }

pub struct CommandResponseLog;
pub struct PersistedCommandResponses { pub channel_id, pub command_id, pub responses, pub json }

impl MongoAstVariableStore {
    pub fn new() -> Self;
    pub fn with_database(self, name: impl Into<String>) -> Self;
}
pub struct ScopedIdentity { pub user_id, pub user_login, pub skipped }
pub struct VariableReadPlan { pub filter, pub legacy_filter }
pub struct VariableWritePlan { pub filter, pub update, pub login_fallback_filter }
pub fn plan_variable_read(...) -> VariableReadPlan;
pub fn plan_variable_upsert(..., now: DateTime) -> VariableWritePlan;
pub fn resolve_user_load(scope, target) -> ScopedIdentity;
pub fn resolve_user_save(scope, target) -> ScopedIdentity;
pub fn resolve_user_delete(scope, target) -> ScopedIdentity;
pub fn stored_variable(document, name) -> Option<String>;
```

`new`, `production`, `DragonflyAstCache::new`, and `MongoAstVariableStore::new` / `with_database` perform no I/O. Clients are obtained on the first operation (`get_redis_client`, `get_mongo_client`) and are not stored on the struct.

`Host::execute` returns `EvalError` whose `name` is the `AstRuntimeError` variant (`Unsupported`, `Host`, `Rejected`, `Cancelled`, `Syntax`, `Evaluation`). The future is the crate's non-`Send` `HostFuture`.

## What was ported

| Behavior | Source |
| --- | --- |
| Variable key, legacy read, tombstone, 11000 login retry, load/save filter asymmetry, user `login:` id, delete-by-login | `dimabot/src/handlers/special_parser.handler.ts` `loadScopedVariable` / `saveScopedVariable` and the channel/user closures in `createSpecialExecutionContext` (about lines 197–494) |
| `chat.send` empty message, Helix error text as a successful string | `dimabot/src/utils/ast_parser/functions/chat.functions.ts` |
| `delay` 0–60s, in-execution `Math.round(seconds * 1000)` sleep | `dimabot/src/utils/ast_parser/functions/delay.functions.ts` |
| Timer guards: depth ≥ 5, Twitch broadcaster, seconds 1..=604800 | `dimabot/src/utils/ast_parser/evaluator/vm.rs` (the `timer` function and `Task::Timer`) |
| Collection `astvariables`, journal false | `dimabot/src/schemas/ast_variables.schema.rs` (read only) |
| Effect fork | `runtime/effects.rs` `fork_ast_effect_context` — not reimplemented |

Cache uses `crate::utils::redis::get_redis_client`, not `ApplicationCacheRuntime::acquire`, so a cache op does not start observability telemetry. `SET` and `EXPIRE` stay separate. A nil `GET` is `JsValue::Null`; `EXISTS` is `JsValue::Number(1.0)` or `0.0`. Lone UTF-16 surrogates in a cache key, cache value, variable value, or user login are `AstRuntimeError::Host`, not a panic. `chat.send` uses `String::from_utf16_lossy` at the Helix boundary.

Variable writes go through `schema().native_collection` and `find_one_and_update(...).upsert(true)`. `SchemaRepository::upsert_equality` is not used: `prepare_equality_upsert` rejects dotted paths (`schema.rs`). The dotted `variables.<name>` key is unescaped, matching the source. `updatedAt`, `createdAt`, and `__v: 0` are written by this store because the driver does not run mongoose middleware. Constructors do not call `install_indexes`.

Mongo failures are logged with `eprintln` (channel, scope, identity, variable name, error — not the value) and swallowed: read `Ok("")`, write `Ok(())`. That matches the TypeScript catch. The host still propagates `AstVariableStore` errors with `?`, so a failing fake is a typed `AstRuntimeError` rather than a panic or a fake value.

## Timer seam (declared gap until wired)

Guards run in the host, in the source order (depth, Twitch channel, seconds). Messages are the source strings:

- `timer: maximum nested timer depth reached`
- `timer: requires a Twitch channel`
- `timer: seconds must be between 1 and 604800`

After the guards, the host calls `TimerScheduler::schedule`. `Ok(())` becomes `JsValue::string("")` so the VM treats it as success. `Err` is propagated. The VM still replaces any host `Err` with `timer: could not schedule timer`; direct callers see the typed error.

`ApplicationHost::new` does not install a scheduler. `BotRuntime::new` does not call `with_timer` (that file was not edited). A guarded, otherwise valid `ScheduleTimer` therefore returns `AstRuntimeError::Unsupported("AST timer scheduling adapter is not wired yet")`. No timer is faked. Caps, the 10-minute grace, the at-most-once claim, EVAL, and execution are not implemented here. They already live on `AstTimerScheduler::schedule(&mut self, seconds, body, context)` in `dimabot/src/utils/ast_timer_runtime.rs`.

The adapter integration must supply:

```rust
pub trait TimerScheduler: Send + Sync {
    fn schedule<'a>(
        &'a self,
        seconds: f64,
        body: &'a AstNode,
        context: &'a Context,
    ) -> BoxFuture<'a, Result<(), AstRuntimeError>>;
}
```

`AstTimerScheduler::schedule` takes `&mut self` and returns `Result<AstTimerJob, AstTimerError>`. Wrap it (a `Mutex` is enough: the host future is not `Send`), map `Ok(_)` to `Ok(())` and `Err` to `AstRuntimeError`, and pass `Arc<dyn TimerScheduler>` to both hosts. Do not treat `Ok(())` as success unless that scheduler accepted the job.

`$(timer …)` as `HostRequest::Function { name: "timer" }` is `Unsupported`. The VM uses `ScheduleTimer`.

## Functions

Handled here: `chat.send`, `delay`.

Re-entered only if a `HostRequest::Function` arrives for a context builtin: `count`, `scount`, `bits`, `break`, `continue` via `builtin`. The VM normally handles these before the host.

Pure names (`upper`, `lower`, `title`, `capitalize`, `trim`, `length`, `slice`, `replace`, `user`, `touser`, `random`, and the EventSub pures) return `Unsupported` naming the evaluator. `pure::dispatch` is `pub(super)` and is not called. `Host::random` is the evaluator's RNG hook: 48 bits from `Uuid::new_v4` bytes 0..6, divided by 2^48. `Uuid::new_v4` panics inside the uuid crate if entropy fails; this lane does not add an unwrap and does not add `dep:getrandom`.

Every other family is `AstRuntimeError::Unsupported` and names the family (`moderation`, `twitch-data`, `overlay`, `availability`, `roulette`, `randomuser`, `clip`, `followage`, `trigger`, `tts`, `pet`, `defense`, `pin`, `channel`, `chat` for `announce` / `chat.announcement`, or `unregistered`). `announce` is not wired. No Helix moderation, poll, or prediction method is half-ported.

A handler string such as `delay: must be between 0 and 60 seconds` or `chat.send: …` is a successful `JsValue`. A missing `TwitchFunctions` for a non-empty `chat.send` is `Unsupported`, not `""`.

## SaveResponses

In-process `CommandResponseLog` only: channel id from the host scope, command id and `command_responses` from the context, each response via `js_string` + `String::from_utf16_lossy`, plus `json_stringify` of the array. Not a second Mongo collection. Not `commands.responses` (those are authored templates). `ast_parser/persistence.rs` only validates nesting and is not a writer. The TypeScript `saveResponses` default is a no-op (`evaluator.ts`).

## Effect fork

`Host::fork_effect` calls `super::effects::fork_ast_effect_context(Some(effect))`. The default trait method returns `None`, which strips authority. The `State` inside the token is private to `effects.rs`. An empty path returns `None`. An unknown token returns `None`.

## Central patch (not applied)

`dimabot/Cargo.toml`, add `dep:sha2` beside the lead's list. `mongo` already enables `dep:sha2`; `runtime/effects.rs` (and the other worker's timer file) import `sha2` directly, so name it on this feature too. Do not add `dep:getrandom`. Do not add an `ast_timer_runtime` module line here.

```toml
ast-bot-runtime = ["ast-evaluator", "ast-pure-functions", "ast-blocks", "ast-syntax", "commands-service", "twitch-functions", "twitch-client", "twitch-streamers", "twitch-tokens", "permissions", "redis-application-runtime", "logger-redis", "application-schemas", "timer-policy", "mongo", "redis", "http-client", "dep:tokio", "dep:serde", "dep:serde_json", "dep:uuid", "dep:sha2"]
```

`dimabot/src/utils/mod.rs`:

```rust
#[cfg(feature = "ast-bot-runtime")]
#[path = "ast_parser/runtime.rs"]
pub mod ast_runtime;
```

`dimabot/src/utils/ast_parser/runtime/wiring.rs` — not edited. Both hosts need the timer adapter or `ScheduleTimer` stays the declared gap:

```rust
let parser_host = ApplicationHost::new(Arc::clone(&cache), Arc::clone(&variables))
    .with_twitch(twitch.clone())
    .with_timer(Arc::clone(&timer));
let command_host = ApplicationHost::new(cache, variables)
    .with_twitch(twitch.clone())
    .with_timer(timer);
```

Inside this tree, sibling modules use `super::`. After the patch the path is `crate::utils::ast_runtime`.

## Tests

`dimabot/tests/ast_application_host.rs` uses in-memory `AstCache`, `AstVariableStore`, and `TimerScheduler` fakes. `#[tokio::test(flavor = "current_thread")]` because the host future and `Context` are `!Send`. Plan, tombstone, effect-fork, and error round-trip tests are synchronous. They do not open Mongo, Redis, Docker, or the network.

The test crate cannot see the module until the patch above is applied.

## Still open

- Timer runtime (caps, grace, claim, execution, parser, delivery) is the other worker's file and is not called. `BotRuntime::new` does not install `TimerScheduler`.
- `SaveResponses` is an in-process log.
- `Uuid::new_v4` can panic inside uuid when entropy is unavailable.
- Effect authority stays in `runtime/effects.rs`.
- Cache does not start Redis observability telemetry.
- `runtime/effects.rs` needs `sha2` on the feature (see the patch).
- No `cargo` build, test, or `rustfmt` has been run. Verification waits on an integration execution lease.
