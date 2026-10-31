# Native AST function families (lane B3, authoring)

**Wave 1 authoring only.** Nothing in this lane was executed: no `cargo`, `cargo fmt`, `rustfmt`, `node`, `npm`, test runner, benchmark, Docker, network call, commit or deployment. Verification is pending an integration execution lease. Both files are hand-formatted; a `cargo fmt` pass may be needed.

Lane: team `team3-bot-ast`, slice B3 (timer/delay family + `chat.send`).

## What this lane adds

| TypeScript source | Native port | Status |
|---|---|---|
| `src/utils/ast_parser/timer.ts` (`evaluateTimer`, `snapshotTimerContext`) | `runtime::functions::BotAstFunctions::timer` / `schedule_timer` | ported guards + scheduling seam |
| `src/utils/ast_parser/functions/delay.functions.ts` (`delayHandler`, `MAX_DELAY_SECONDS`) | `BotAstFunctions::delay` | ported |
| `src/utils/ast_parser/functions/chat.functions.ts` (`chatSendHandler`) | `BotAstFunctions::chat_send` | ported |
| `chat.functions.ts` (`announceHandler`, `chat.announcement` alias) | `call("announce" \| "chat.announcement")` | **reserved**: explicit `Unsupported` |
| `registerFunction` metadata for both files | `BotAstFunctions::metadata` / `registrations` / `register_into` | ported verbatim |

Files created (nothing else touched):

- `dimabot/src/utils/ast_parser/runtime/functions.rs`
- `dimabot/tests/ast_functions.rs`

## The timer seam, and why there are two entry points

The native evaluator already implements `evaluateTimer`'s control flow. `evaluator/vm.rs` intercepts `AstNode::Function { name: "timer", .. }`, applies the usage / depth / Twitch-channel guards, evaluates `args[0]` in a context whose `effect_context` is cleared, applies the `1..=604800` range guard, and emits `HostRequest::ScheduleTimer { seconds, body }` with `body = AstNode::Root { children: args[1..] }`. `timer.test.ts` pins that the body has **not** run when the call returns.

So:

- `schedule_timer` is the **production seam**. It is the host adapter for `HostRequest::ScheduleTimer`: it takes the already-validated `seconds`, the unevaluated body and the live `Context` whose snapshot crosses the cache boundary, and persists the job through `ast_timer_runtime`.
- `timer` is the complete `evaluateTimer` port (same guard order, same strings) for a host that does *not* intercept `timer` in the VM. It cannot evaluate `args[0]` — it has no `Host` — so the caller passes the value `args[0]` already evaluated. That is the only deviation from the source's function shape, and it is why `timer` takes four arguments instead of two.
- `AstFunctionCatalog::call("timer", …)` returns `Unsupported`: the trait hands over evaluated `JsValue`s and the body must stay unevaluated. Rebuilding a body from evaluated values would silently change semantics, so it refuses instead of fabricating one.

The VM's `timer` path and this module therefore do not double-guard in production: the VM guards, this module stores.

## Public API

```rust
// dimabot/src/utils/ast_parser/runtime/functions.rs

pub const MAX_TIMER_SECONDS: u64 = 7 * 24 * 60 * 60; // 604800, timer.ts
pub const MAX_TIMER_DEPTH: f64 = 5.0;               // timer.ts
pub const MAX_DELAY_SECONDS: u64 = 60;              // delay.functions.ts

pub trait AstChatSend: Send + Sync {
    fn send<'a>(&'a self, channel_id: &'a str, message: &'a str)
        -> BoxFuture<'a, Result<SendResult, AstRuntimeError>>;
}

pub struct TwitchChatAdapter { /* TwitchFunctions + Option<Arc<Logger>> */ }
impl TwitchChatAdapter {
    pub fn new(twitch: TwitchFunctions) -> Self;
    pub fn with_optional_logger(twitch: TwitchFunctions, logger: Option<Arc<Logger>>) -> Self;
    pub fn twitch(&self) -> &TwitchFunctions;
    pub fn logger(&self) -> Option<&Arc<Logger>>;
}
impl AstChatSend for TwitchChatAdapter; // chat::send_chat_message(twitch, logger, ch, msg, None, None)

pub trait AstDelayClock: Send + Sync {
    fn sleep_millis<'a>(&'a self, millis: u64) -> BoxFuture<'a, ()>;
}
#[derive(Clone, Copy, Debug, Default)]
pub struct TokioDelayClock;
impl AstDelayClock for TokioDelayClock; // tokio::time::sleep, dropped with the future

pub struct BotAstFunctions<S, C, I> { /* chat, delay_clock, Mutex<AstTimerScheduler>, metadata, logger */ }

impl<S, C, I> BotAstFunctions<S, C, I>
where S: AstTimerStore, C: AstTimerClock, I: AstTimerIdSource
{
    pub fn new(chat: Arc<dyn AstChatSend>, delay_clock: Arc<dyn AstDelayClock>,
               timers: AstTimerScheduler<S, C, I>) -> Self;         // no I/O
    pub fn with_twitch(twitch: TwitchFunctions, timers: AstTimerScheduler<S, C, I>) -> Self;
    pub fn with_twitch_and_logger(twitch: TwitchFunctions, timers: AstTimerScheduler<S, C, I>,
                                 logger: Option<Arc<Logger>>) -> Self;
    pub fn with_logger(self, logger: Arc<Logger>) -> Self;

    pub fn metadata(&self, name: &str) -> Option<&FunctionMetadata>;
    pub fn registrations(&self) -> &[(String, FunctionMetadata)];
    pub fn register_into(&self, registry: &mut FunctionRegistry);

    pub async fn timer(&self, scope: &AstScope, args: &[AstNode], duration: &JsValue,
                       context: &Context) -> Result<JsValue, AstRuntimeError>;
    pub async fn schedule_timer(&self, scope: &AstScope, seconds: f64, body: &AstNode,
                                context: &Context) -> Result<(), AstRuntimeError>;
    pub async fn delay(&self, args: &[JsValue]) -> Result<JsValue, AstRuntimeError>;
    pub async fn chat_send(&self, scope: &AstScope, args: &[JsValue])
        -> Result<JsValue, AstRuntimeError>;
}

impl<S, C, I> AstFunctionCatalog for BotAstFunctions<S, C, I>
where S: AstTimerStore + Send, C: AstTimerClock + Send, I: AstTimerIdSource + Send;
```

Notes:

- The inherent methods are `async fn`, not `BoxFuture`-returning, so callers never fight the trait's `&'a self`/`&[JsValue]` lifetime pairing. `call` boxes them.
- `tokio::sync::Mutex` (not `std::sync::Mutex`) guards the scheduler: a std mutex held across `enqueue`/`sleep` would block a single-threaded `LocalSet` and could deadlock.
- `AstDelayClock` is a separate seam from `AstTimerClock` because `AstTimerScheduler` exposes `store_mut`/`ids_mut` but no `clock_mut`, and a `delay` must not hold the scheduler lock while it sleeps. `TokioDelayClock` is the production adapter.
- Success values are the source's: `""` (empty string), never `undefined`.

## Exact strings preserved

| Case | Value |
|---|---|
| `timer` < 2 args | `timer: usage: $(timer seconds message_and_actions)` |
| `timerDepth >= 5` | `timer: maximum nested timer depth reached` |
| no broadcaster / `platform !== 'twitch'` | `timer: requires a Twitch channel` |
| seconds non-finite or outside `1..=604800` | `timer: seconds must be between 1 and 604800` |
| scheduling failure | `timer: could not schedule timer` |
| `timer` success | `''` |
| `delay` no args | `delay: missing argument (seconds)` |
| `delay` not a number | `delay: "<raw>" is not a valid number` |
| `delay` outside `0..=60` | `delay: must be between 0 and 60 seconds` |
| `delay` success | `''` |
| `chat.send` success (incl. blank message) | `''` |
| `chat.send` failed send | `chat.send: <message>` |

Coercion: `timer` seconds and `delay` seconds both use `ast_evaluator::to_number` (JavaScript `Number(...)`), so `"300"`/`"5"` are accepted and `"nope"` is not. `delay`'s error quotes the raw argument through `js_string`, matching the source template literal. `chat.send` reproduces `(args[0] ?? '').toString().trim()`: nullish → `''`, whitespace-only → send nothing.

## Metadata registered (verbatim from the sources)

| Name | category | syntax | minUserLevel |
|---|---|---|---|
| `timer` | `flow` | `timer seconds message_and_actions` | – |
| `delay` | `flow` | `delay seconds` | – |
| `announce` | `chat` | `announce [color] message` | **7** |
| `chat.announcement` | `chat` (aliasOf `announce`) | `announce [color] message` | **7** |
| `chat.send` | `chat` | `chat.send message` | – |

Descriptions, examples, keywords and `surfaces: ["authoring"]` are copied verbatim from `delay.functions.ts` / `chat.functions.ts`. `break` and `continue` are deliberately **not** registered here: the native VM owns them as context builtins (`FunctionRegistry::with_context_builtins`), with identical metadata.

The `min_user_level: 7` on the announcement family is the point of registering metadata: `evaluator/vm.rs` reads it from the registry and returns `permission_denied` before dispatch, which is the source's gate.

## Remaining gaps

1. **Announcement family.** `announce` and `chat.announcement` call the source's `sendAnnouncement` (`src/functions/chats`). No native adapter exists; that work is reserved to the plain-chat / temporary-role-announcement lane. Both names return `AstRuntimeError::Unsupported` naming the function and the missing adapter. Their metadata (including level 7) is registered so the permission gate still behaves like the source.
2. **Every other AST family.** `overlay`, `availability`, `roulette`, `user`, `random`, `moderation`, `twitch`, `count`, `channel`, `clip`, `followage`, `eventsub`, `tts`, `trigger`, `defense`, `pin`, `string`, `pet` — none are served here. Each returns `Unsupported` naming itself. No value is fabricated anywhere.
3. **Timer duration evaluation.** The catalog cannot evaluate `args[0]` (no `Host`, and re-entering the evaluator from inside a host call is circular). The VM does it; `timer` accepts the evaluated value. A host that bypasses the VM's `timer` interception must evaluate the duration itself with `effect_context = None` before calling `timer`.
4. **`chr(39)`-class edge cases.** `to_utf8()` can fail on lone UTF-16 surrogates in `delay`/`chat.send`; that is surfaced as `AstRuntimeError::Evaluation` (TypeScript cannot express the case because its strings are UTF-16 already).
5. **Logging** for `console.error('AST timer scheduling failed', …)` is best-effort and only when a logger is injected. Payload fields are `message`, `channelID`, `error`; the source's ISO `timestamp` and JS `stack` are not reproduced (same convention as `runtime/chat.rs`).
6. **Not verified here.** No build, test, lint or format run happened in this lane; the fakes have never been executed.

## Central patch the integration team must apply

These are the only places outside this lane's file list that must change. **Not applied by this lane.**

### 1. `dimabot/Cargo.toml` — the feature gate the test target already assumes

```toml
ast-bot-runtime = [
    "ast-evaluator", "ast-pure-functions", "redis", "mongo",
    "http-client", "logger", "twitch-functions", "twitch-streamers",
    "dep:tokio", "dep:serde_json", "dep:sha2",
]
```

(Exact membership is the integrator's call; it must enable `tokio` with `sync`+`time` — already in the dependency declaration — `serde_json`, and the `Logger`/`TwitchFunctions` graph that `runtime/chat.rs` and `ast_timer_runtime.rs` already require.)

### 2. `dimabot/src/utils/mod.rs` — mount both modules

```rust
#[cfg(feature = "ast-bot-runtime")]
#[path = "ast_parser/runtime.rs"]
pub mod ast_runtime;

#[cfg(feature = "ast-bot-runtime")]
pub mod ast_timer_runtime;
```

`runtime.rs` already declares `pub mod functions;` with `#[path = "runtime/functions.rs"]`, so no change is needed there. `crate::utils::ast_runtime` is the name `runtime.rs`'s own doc comments use.

### 3. Host dispatch — `runtime/host.rs` (`ApplicationHost`)

The host needs one catalog field and two `execute` arms. Shape (field names are the host lane's):

```rust
// field
functions: Option<Arc<dyn AstFunctionCatalog>>,   // default None

// Host::execute, `context: Context` is the argument the trait already gives you
HostRequest::Function { name, args } => match self.functions.clone() {
    Some(catalog) => match catalog.call(&self.scope, &name, &args).await {
        Ok(value) => Ok(value),
        Err(error) => Err(EvalError::new(error.message().to_owned())),
    },
    None => Err(EvalError::new(format!(
        "{name}: no native adapter for this AST function"
    ))),
},
HostRequest::ScheduleTimer { seconds, body } => match self.functions.clone() {
    Some(catalog) => catalog
        .schedule_timer(&self.scope, seconds, &body, &context)
        .await
        .map(|()| JsValue::Undefined)
        .map_err(|error| EvalError::new(error.message().to_owned())),
    None => Err(EvalError::new("timer: could not schedule timer")),
},
```

`schedule_timer` returning `Err` is what makes the VM produce the source's `timer: could not schedule timer`; do not pre-map it to a string in the host.

### 4. Registry + construction

```rust
let mut registry = FunctionRegistry::default();
registry.register_pure_builtins();          // and with_context_builtins(), per current wiring
functions.register_into(&mut registry);     // timer, delay, announce, chat.announcement, chat.send
let engine = Engine::new(registry);         // unregistered names stay "[Unknown function: …]"

let functions = Arc::new(BotAstFunctions::with_twitch_and_logger(
    twitch.clone(),
    AstTimerScheduler::new(
        DragonflyTimerStore::connect().await?,   // explicit I/O, caller-owned
        SystemClock,
        DigestTimerIdSource::new(),
    ),
    Some(logger.clone()),
));
// then hand `functions` to ApplicationHost (both parser-side and command-side hosts).
```

`ApplicationHost::with_twitch(...)` in `runtime/wiring.rs` currently builds hosts with no catalog; `wiring.rs` will need a `with_functions(Arc<dyn AstFunctionCatalog>)` (or an extra `BotRuntime::new` argument) so both hosts receive the same catalog. That file is lead-owned in this wave.

### 5. Test target

`dimabot/tests/ast_functions.rs` is auto-discovered; no `[[test]]` entry is needed. Its first line is `#![cfg(feature = "ast-bot-runtime")]`, so it compiles to nothing until the feature exists.

## Test coverage (`dimabot/tests/ast_functions.rs`)

In-memory fakes only (fake store, fixed clock, counting id source, fake chat send, recording delay clock). No Dragonfly, MongoDB, Twitch, network, Docker or wall-clock sleep.

1. `timer` < 2 arguments → usage string, nothing enqueued.
2. depth 5 and 6 → depth message, nothing enqueued.
3. `platform: "youtube"`, empty scope channel, empty `context.broadcaster_id` → requires-a-Twitch-channel, nothing enqueued.
4. seconds `0`, `-1`, `604801`, `±Infinity`, `NaN`, `"nope"` → range message, nothing enqueued.
5. valid `timer` → `""`, one enqueue, and the decoded payload has `body.type == "root"`, `children == [literal "5 minutes over! ", function "timer.testaction"]`, `context.timerDepth == 1`, `context.broadcasterId == "test"`, `dueAt == now + 300000`, `expiresAt == dueAt + 600000`.
6. `timer` with `"300"` → coerced, `dueAt == now + 300000`, duration excluded from the body.
7. store refusal → `timer: could not schedule timer`.
8. `delay` missing / `"abc"` / `61` / `-1` → the three messages, and no pause recorded.
9. `delay "5"` → waits 5000 ms; `delay 0` → waits 0 ms; both return `""`.
10. `chat.send` success → `""` and the send was recorded; failure → `chat.send: held for moderation`; the message is trimmed before sending; blank/nullish/no-arg → `""` and nothing sent.
11. `call("announce")`, `call("chat.announcement")`, `call("timer")`, `call("totally.unknown")` → `AstRuntimeError::Unsupported` naming the function.
12. metadata: categories, syntaxes, examples, keywords count, `min_user_level == Some(7.0)` for the announcement family, `alias_of == "announce"`, five registrations, and `register_into` making the names visible in a `FunctionRegistry` with the level gate intact.

## Proof paths

- Sources: `dimabot/src/utils/ast_parser/timer.ts`, `dimabot/src/utils/ast_parser/timer.test.ts`, `dimabot/src/utils/ast_parser/functions/delay.functions.ts`, `dimabot/src/utils/ast_parser/functions/chat.functions.ts`, `dimabot/src/utils/ast_parser/functions/index.ts`.
- Shared contract: `dimabot/src/utils/ast_parser/runtime.rs` (unchanged).
- Reused adapters: `dimabot/src/utils/ast_timer_runtime.rs` (store/scheduler/`enqueue_ast_timer`), `dimabot/src/utils/ast_parser/runtime/chat.rs` (`send_chat_message`), `dimabot/src/utils/ast_parser/evaluator/vm.rs` (timer interception, `permission_denied`).
- This lane: `dimabot/src/utils/ast_parser/runtime/functions.rs`, `dimabot/tests/ast_functions.rs`.
- Neighbouring lane evidence style: `dimabot/tests/ast_timer_runtime.rs`, `dimabot/tests/ast_chat_delivery.rs`.
