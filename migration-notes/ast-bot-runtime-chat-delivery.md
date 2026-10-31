# AST bot runtime — chat delivery lane (Lane A)

Status: **authored, not compiled.** Nothing was executed for this lane (no
`cargo`, no `rustfmt`, no `node`/`npm`, no Docker, no network, no commits). The
code below is static source only; verification is pending an integration
execution lease for feature `ast-bot-runtime`.

Team `team3-bot-ast` splits the runtime tree three ways. This lane owns the
chat/delivery half:

| Lane | Files |
|------|-------|
| A (this note) | `utils/ast_parser/runtime/{delivery,chat,wiring}.rs`, `tests/ast_chat_delivery.rs` |
| B | `runtime/{host,variables}.rs` (application host, cache/variable adapters) |
| C | `runtime/{parser,command,effects}.rs` (special parser, command executor) |
| Lead | `runtime.rs` (shared contract, unchanged by this lane) |

## TypeScript sources ported

- `dimabot/src/utils/ast_command_delivery.ts` → `runtime/delivery.rs`
  (`deliverAstMessage`).
- `dimabot/src/functions/chats/send_message.chat.ts` → `runtime/chat.rs`
  (context half: AST render, outer send, reply target, reference dispatch).
  The context-free plain half is the already-reserved
  `functions/chats/send_message_plain.rs` and is **called, not modified**.
- `dimabot/src/handlers/commands.handler.ts` was read only, for the
  `ICommandResponse` shape that `CommandExecutionResult` mirrors.
- `dimabot/src/handlers/special_parser.handler.ts` (`parseSpecialCommands`) was
  read only to keep the `ContextualMessage` ordering identical; its port is
  Lane C.

## What this lane implements

### `runtime/delivery.rs`

Native port of `deliverAstMessage`, using only the seams from `runtime.rs`
(`ChatSender`, `CommandRunner`) plus an optional `Logger`. Preserved rules:

- reference queue drained **once** with `std::mem::take` on
  `AstMessage::command_references` (the source's `splice(0)`), so a second
  delivery cannot resend them;
- `text = message.parsed_text.trim()` (JavaScript trim, via
  `utils::js_compat::trim`) and the outer send happens only when
  `chat_enabled && !text.is_empty()`;
- a failing outer send returns immediately and **no** reference runs;
- references execute in authored order; `error == true` continues with the next
  reference;
- a successful reference recurses with
  `{ parsed_text: result.message, command_references: result.command_references }`
  under the **referenced** channel and the same `chat_enabled` flag; a failing
  recursive send stops the loop and returns that failure;
- a failure while executing a reference is logged and the loop continues;
- success is `SendResult { error: false, message: "AST message delivered", status: Some(200) }`
  (`SendResult::ok(AST_MESSAGE_DELIVERED)`), exact text preserved.

Native-only decisions (documented in the module header): a
`AstRuntimeError::Cancelled` raised by a reference stops delivery instead of
being logged and skipped; every other error keeps the source's
log-and-continue; logging goes to the injected `Logger` when present and to one
`eprintln!` line otherwise.

### `runtime/chat.rs`

- `TwitchChatSender` is the concrete `ChatSender` over the real
  `TwitchFunctions`. Construction performs no I/O; the Twitch client (and an
  optional `Logger`) are injected.
- Plain (no reply target) sends **reuse**
  `TwitchFunctions::send_message_plain_with_cancellation` unchanged.
- The reply-parent path is implemented natively with the public
  `TwitchFunctions::request_detailed(TwitchAuth::App, POST, "chat/messages", …)`
  and the source body `broadcaster_id`, `sender_id` (`MODERATOR_ID` =
  `698614112`), `message`, `for_source_only: true`, plus
  `reply_parent_message_id`. Status, `Null`-body, `is_sent === false`,
  non-array `data` and transport/parse handling mirror the reserved plain port
  and the source exactly.
- `send_result_from_plain` maps the source's richer response onto `SendResult`
  (`error`, message text via `message_text_or`, `status`).
- `send_contextual_message` is the context-aware port:
  `parseSpecialCommands` (only when a context is supplied) → blank-text check →
  outer send with `replyToMessageId` → reference delivery with
  `parsedText: ''`. A parse failure is logged as a warning and the unparsed text
  is sent, as in the source. A failed outer send returns before references; after
  a successful send the reference delivery result is discarded exactly like the
  source (a typed `Err` still propagates because TypeScript cannot express it).

### `runtime/wiring.rs`

`BotRuntime` owns the real collaborators and implements all three seams:

- `AstBodyParser` → `parse_special_commands(&self.engine, &mut self.parser_host, &self.directory, text, context)`
- `CommandRunner` → `execute_command(&mut self.store, &mut SpecialParser { … command_host … }, request)`
- `ChatSender` → plain `send_chat_message(…, None, None)`

`BotRuntime` is generic over Lane C's `CommandStore` (production adapter:
`command::NativeCommandStore`, injected because its Redis connection is I/O),
holds the `Arc<TwitchStreamers>` channel directory the parser needs, and owns
**two** `ApplicationHost` instances (one per Lane C seam) because a single
`&mut` host cannot be lent to the parser and the command executor at the same
time. Both hosts are built from the same `Arc<dyn AstCache>` and
`Arc<dyn AstVariableStore>` and every call re-scopes its own host, so nothing is
duplicated. `handle_chat_message` / `handle_chat_reply` use small
`SpecialParser`/`CommandAdapter` borrows over disjoint fields to give the
contextual send its three distinct `&mut` seams.

## Public API exposed

```rust
// runtime/delivery.rs
pub const AST_MESSAGE_DELIVERED: &str = "AST message delivered";

pub struct DeliverySeams<'a, S: ChatSender + ?Sized, R: CommandRunner + ?Sized> {
    pub sender: &'a mut S,
    pub runner: &'a mut R,
    pub logger: Option<&'a std::sync::Arc<Logger>>,
}
impl<'a, S: ChatSender + ?Sized, R: CommandRunner + ?Sized> DeliverySeams<'a, S, R> {
    pub fn new(sender: &'a mut S, runner: &'a mut R) -> Self;
    pub fn with_logger(self, logger: &'a std::sync::Arc<Logger>) -> Self;
}

pub fn deliver_ast_message<'a, S, R>(
    channel_id: &'a str,
    message: &'a mut AstMessage,
    chat_enabled: bool,
    seams: DeliverySeams<'a, S, R>,
) -> BoxFuture<'a, Result<SendResult, AstRuntimeError>>
where
    S: ChatSender + ?Sized + 'a,
    R: CommandRunner + ?Sized + 'a;

// runtime/chat.rs
pub const MODERATOR_ID: &str = "698614112";

pub fn send_result_from_plain(response: &PlainMessageResponse) -> SendResult;

pub async fn send_chat_message(
    twitch: &TwitchFunctions,
    logger: Option<&Arc<Logger>>,
    channel_id: &str,
    message: &str,
    reply_to_message_id: Option<&str>,
    cancel: Option<&RequestCancellation>,
) -> Result<SendResult, AstRuntimeError>;

pub struct TwitchChatSender { /* twitch, logger */ }
impl TwitchChatSender {
    pub fn new(twitch: TwitchFunctions) -> Self;
    pub fn with_logger(twitch: TwitchFunctions, logger: Arc<Logger>) -> Self;
    pub fn with_optional_logger(twitch: TwitchFunctions, logger: Option<Arc<Logger>>) -> Self;
    pub fn twitch(&self) -> &TwitchFunctions;
    pub fn logger(&self) -> Option<&Arc<Logger>>;
    pub async fn send_message(&self, channel_id: &str, message: &str, reply_to_message_id: Option<&str>)
        -> Result<SendResult, AstRuntimeError>;
    pub async fn send_message_with_cancellation(&self, channel_id: &str, message: &str,
        reply_to_message_id: Option<&str>, cancel: Option<&RequestCancellation>)
        -> Result<SendResult, AstRuntimeError>;
}
impl ChatSender for TwitchChatSender { /* plain send */ }

pub struct ContextualMessage<'a> {
    pub channel_id: &'a str,
    pub message: &'a str,
    pub reply_to_message_id: Option<&'a str>,
    pub context: Option<SpecialParserContext>,
}
pub struct ContextualSeams<'a> {
    pub sender: &'a mut TwitchChatSender,
    pub parser: &'a mut dyn AstBodyParser,
    pub runner: &'a mut dyn CommandRunner,
    pub logger: Option<&'a Arc<Logger>>,
}
pub fn send_contextual_message<'a>(
    seams: ContextualSeams<'a>,
    request: ContextualMessage<'a>,
) -> BoxFuture<'a, Result<SendResult, AstRuntimeError>>;

// runtime/wiring.rs
pub struct BotRuntime<S: CommandStore> {
    /* engine, parser_host, command_host, directory, store, twitch, logger */
}
impl<S: CommandStore> BotRuntime<S> {
    pub fn new(
        engine: Engine,
        cache: Arc<dyn AstCache>,
        variables: Arc<dyn AstVariableStore>,
        directory: Arc<TwitchStreamers>,
        store: S,
        twitch: TwitchFunctions,
    ) -> Self; // no I/O at construction
    pub fn with_logger(self, logger: Arc<Logger>) -> Self;
    pub fn engine(&self) -> &Engine;
    pub fn twitch(&self) -> &TwitchFunctions;
    pub fn directory(&self) -> &Arc<TwitchStreamers>;
    pub fn store(&self) -> &S;
    pub fn store_mut(&mut self) -> &mut S;
    pub fn logger(&self) -> Option<&Arc<Logger>>;
    pub async fn handle_chat_message(&mut self, channel_id: &str, message: &str,
        context: SpecialParserContext) -> Result<SendResult, AstRuntimeError>;
    pub async fn handle_chat_reply(&mut self, channel_id: &str, message: &str,
        reply_to_message_id: Option<&str>, context: SpecialParserContext)
        -> Result<SendResult, AstRuntimeError>;
    pub async fn deliver(&mut self, channel_id: &str, message: &mut AstMessage, chat_enabled: bool)
        -> Result<SendResult, AstRuntimeError>;
}
impl<S: CommandStore> AstBodyParser for BotRuntime<S> { … }
impl<S: CommandStore> CommandRunner for BotRuntime<S> { … }
impl<S: CommandStore> ChatSender for BotRuntime<S> { … }
```

No `Send` bound appears anywhere in these files. The module path is
`crate::utils::ast_runtime::{delivery, chat, wiring}` (per the lead's correction).

## Tests

`dimabot/tests/ast_chat_delivery.rs` starts with
`#![cfg(feature = "ast-bot-runtime")]` (no `[[test]]` entry needed) and uses
in-memory fakes only — no MongoDB, Redis, Twitch client, network or Docker:

1. `outer_text_precedes_reference_execution` — outer send before any reference.
2. `empty_outer_text_still_dispatches_references` — blank text, references run.
3. `failing_outer_send_skips_references` — failing outer send stops everything
   (the queued reference step is still unconsumed).
4. `failing_reference_continues_with_the_rest` — `error == true` **and** a
   thrown-equivalent `Err` both continue to the remaining references.
5. `reference_queue_is_drained_once` — the queue empties and a second delivery
   dispatches nothing.
6. `nested_references_keep_order_and_channels` — nested references in authored
   order, each under its own referenced channel.

## Lane B / Lane C surface actually used

Lane B (still landing):

```rust
super::host::ApplicationHost::new(cache: Arc<dyn AstCache>, variables: Arc<dyn AstVariableStore>) -> ApplicationHost
super::host::ApplicationHost::with_twitch(twitch: TwitchFunctions) -> ApplicationHost
impl ScopedAstHost for ApplicationHost { fn set_scope(&mut self, scope: AstScope); }
```

Lane C landed with these signatures, which `wiring.rs` now calls directly:

```rust
// runtime/parser.rs
pub fn parse_special_commands<'a, H: ScopedAstHost + 'a>(
    engine: &'a Engine,
    host: &'a mut H,
    directory: &'a TwitchStreamers,
    source: &'a str,
    context: SpecialParserContext,
) -> BoxFuture<'a, Result<SpecialParserResult, AstRuntimeError>>;

// runtime/command.rs
pub fn execute_command<'a, S: CommandStore + 'a, P: AstBodyParser + 'a>(
    store: &'a mut S,
    parser: &'a mut P,
    request: &'a CommandReference,
) -> BoxFuture<'a, Result<CommandExecutionResult, AstRuntimeError>>;
```

Consequences for this lane, already applied:

- The facade holds the channel directory (`Arc<TwitchStreamers>`) the parser
  needs, and the command store is a generic `S: CommandStore` because Lane C's
  `NativeCommandStore` owns a live Redis `ConnectionManager` — building it would
  be I/O, so the application caller injects it. `NativeCommandStore` is the
  production adapter; a worker or test can inject a fake
  `CommandStore`.
- Lane C's executor needs an `AstBodyParser` for the referenced command body, so
  `CommandAdapter` builds its own Lane C `SpecialParser` over the command-side
  host, and `handle_chat_reply` passes Lane C's `SpecialParser` itself as the
  parser seam — this lane adds no parser adapter of its own.
  `BotRuntime`'s own `AstBodyParser`/`CommandRunner`/`ChatSender` impls remain
  available for direct seam use.
- `parse_special_commands` and `execute_command` both return `BoxFuture`
  (`Pin<Box<dyn Future>>`); the adapters call them inside
  `Box::pin(async move { … .await })`, which also accepts an `async fn` if Lane C
  switches style later. Any further signature change only touches
  `CommandAdapter`, `SpecialParser` construction and the three `impl` blocks.

`CommandExecutor<S, P>` from Lane C is compatible but not used directly: it
wants an owned parser, while the facade needs the parser and runner as two
simultaneously borrowed seams. `CommandAdapter` performs the same call shape.

## Central patch the integration team must apply

`dimabot/Cargo.toml` (features):

```toml
ast-bot-runtime = ["ast-evaluator", "ast-pure-functions", "ast-blocks", "ast-syntax", "commands-service", "twitch-functions", "twitch-client", "twitch-streamers", "twitch-tokens", "permissions", "redis-application-runtime", "logger-redis", "application-schemas", "timer-policy", "mongo", "redis", "http-client", "dep:tokio", "dep:serde", "dep:serde_json", "dep:uuid"]
```

`dimabot/src/utils/mod.rs` (after the `ast-blocks` block):

```rust
#[cfg(feature = "ast-bot-runtime")]
#[path = "ast_parser/runtime.rs"]
pub mod ast_runtime;
```

This lane needs **no** `dep:sha2` and uses no `uuid` APIs itself; both entries
stay in the lead's feature list for the other lanes. No new dependency is
required by `delivery.rs`, `chat.rs`, `wiring.rs` or the test: `reqwest`,
`serde`, `serde_json`, `tokio` and the existing logger/Twitch modules cover it.

## Remaining gaps

- Not compiled or tested. `cargo check`/`test`, `rustfmt` and `clippy` are
  pending an execution lease; this lane was authoring-only.
- `runtime/host.rs` and `runtime/variables.rs` (Lane B) do not exist yet, so
  `wiring.rs` cannot compile until they land. Lane C's `parser.rs`,
  `command.rs` and `effects.rs` landed after this lane started and their real
  signatures are now wired (see above). `delivery.rs` only needs `runtime.rs`;
  `chat.rs` needs `twitch-functions` + `delivery.rs`.
- `SendResult` carries only `error`/`message`/`status`; the source's
  `type`/`reason`/`data` fields stay on `PlainMessageResponse` and are not
  projected through the seam. Callers that need the moderation-hold `data`
  payload must use the plain sender directly.
- Cancellation asymmetry: the reply-parent path returns
  `AstRuntimeError::Cancelled`, while the reserved plain port maps cancellation
  to a caught-failure `SendResult`. This lane never passes a cancellation token,
  so the asymmetry is unreachable from `TwitchChatSender`.
- The reserved plain port owns the "blank message" shortcut; the AST context
  path never sends a blank body because `send_contextual_message` branches to
  reference delivery first.
- The AST function families available to the rendered body are Lane B/C's
  registry, not this lane's. Untranslated AST functions remain a Lane B/C
  concern; this lane only calls `parse_special_commands`/`execute_command`.
- Lane C's `execute_command` returns `Unsupported` for keyword-activated
  commands. Delivery treats that as the source's caught reference error: it is
  logged and the remaining references continue, so a keyword reference silently
  produces no message until Lane C adds the keyword count adapter. This is a
  Lane C gap surfaced, not introduced, by this lane.
- Log payloads omit the source's ISO `timestamp` and JavaScript `stack` (the
  native logger stamps its own timestamp and has no JS stack). Absent optional
  log fields are encoded as `null`.
- Deployment and caller adoption are out of scope: production still runs the
  TypeScript chat path until the integration team wires `BotRuntime` into the
  bot entrypoint and verifies it under the ops workflow.
