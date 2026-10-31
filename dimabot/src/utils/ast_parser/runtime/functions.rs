//! Native AST function families that have a real application adapter.
//!
//! This module is the concrete [`AstFunctionCatalog`] of the bot/AST runtime. It
//! is the first family in the native evaluator that can actually *do* something
//! outside the process — schedule a durable timer and send a chat message — so
//! before it existed every non-builtin function was an `Unsupported` gap.
//!
//! | TypeScript source                                    | Native port                        |
//! |------------------------------------------------------|------------------------------------|
//! | `src/utils/ast_parser/timer.ts` (`evaluateTimer`)     | [`BotAstFunctions::timer`]         |
//! | `src/utils/ast_parser/functions/delay.functions.ts`   | [`BotAstFunctions::delay`]         |
//! | `src/utils/ast_parser/functions/chat.functions.ts`    | [`BotAstFunctions::chat_send`]     |
//! | `src/utils/ast_parser/functions/chat.functions.ts`    | [`BotAstFunctions::announce`]      |
//! | `src/utils/ast_parser/functions/clip.functions.ts`    | [`BotAstFunctions::create_clip`]   |
//!
//! # The timer seam
//!
//! The native evaluator already owns `evaluateTimer`'s control flow. When the VM
//! reaches `AstNode::Function { name: "timer", .. }` it applies the usage, depth
//! and Twitch-channel guards, evaluates `args[0]` in a context whose
//! `effect_context` is cleared ("Timers never carry live event-effect
//! authority, including their duration expression"), applies the
//! `1..=604800` range guard and emits
//! [`HostRequest::ScheduleTimer`](crate::utils::ast_evaluator::HostRequest::ScheduleTimer)
//! with `body = AstNode::Root { children: args[1..] }`.
//!
//! So there are two entry points here, and neither is a second guard pass in
//! production:
//!
//! - [`BotAstFunctions::schedule_timer`] is the **production seam**: the host
//!   adapter for `HostRequest::ScheduleTimer`, given the already-validated
//!   `seconds`, the unevaluated body and the live [`Context`] whose snapshot
//!   crosses the cache boundary.
//! - [`BotAstFunctions::timer`] is the complete `evaluateTimer` port (same guard
//!   order and the same strings) for a host that does **not** intercept `timer`
//!   in the VM. It cannot evaluate the duration itself — it has no `Host` — so
//!   the caller passes the value `args[0]` already evaluated.
//!
//! [`AstFunctionCatalog::call`] therefore cannot serve `timer`: its arguments
//! are already evaluated [`JsValue`]s and the source keeps the timer body
//! **unevaluated** (`timer.test.ts` asserts the nested action has not run when
//! `evaluateTimer` returns). Reconstructing an AST body from evaluated values
//! would change the semantics, so `call("timer")` reports
//! [`AstRuntimeError::Unsupported`] and points at the two entry points above
//! instead of fabricating a body.
//!
//! # Unsupported families
//!
//! `announce` and `chat.announcement` are served by
//! [`BotAstFunctions::announce`] through the [`AstAnnounceSend`] seam, whose
//! production adapter is the native `sendAnnouncement` port in
//! [`crate::functions::chats::announcement`]. A catalog assembled without that
//! seam reports [`AstRuntimeError::Unsupported`] naming the missing adapter
//! and the function.
//!
//! `create.clip` is served by [`BotAstFunctions::create_clip`] through the
//! [`AstClipCreate`] seam, whose production adapter is the native `createClip`
//! port in [`crate::functions::clips`]. The handler's failures stay silent: the
//! source returns `''` when `createClip` reported an error or returned no clip
//! id, so this family never turns an operational failure into an error value.
//! Only a missing adapter and cooperative cancellation are errors.
//!
//! Every other function name behaves the same way, naming itself, so a caller
//! always learns exactly what is missing. No value is ever invented.
//!
//! The announcement family currently needs UTF-8-representable text: a lone
//! UTF-16 surrogate in an argument cannot round-trip through
//! [`JsString::to_utf8`]. That boundary is the subject of the
//! `team3-overlay-template-utf16` contract, not of this family.
//!
//! # Metadata and the permission gate
//!
//! The native VM refuses a name that is absent from the
//! [`FunctionRegistry`](crate::utils::ast_evaluator::FunctionRegistry) and
//! enforces `min_user_level` from the registered
//! [`FunctionMetadata`](crate::utils::ast_evaluator::FunctionMetadata)
//! (`permission_denied` in `evaluator/vm.rs`). The source registers
//! `announce`/`chat.announcement` at `minUserLevel: 7`; that level lives in this
//! catalog's [`BotAstFunctions::registrations`], so the host installing them with
//! [`BotAstFunctions::register_into`] is what makes the source's gate behave
//! correctly.
//!
//! # Construction and threading
//!
//! No constructor performs I/O: the Twitch client, the timer scheduler
//! (store/clock/id source), the delay clock and the optional logger are all
//! injected. Nothing here is `Send`-bound on the AST context; the catalog itself
//! is `Send + Sync` (as [`AstFunctionCatalog`] requires) and the `Rc`-based
//! [`Context`] only ever appears as a borrowed argument, never a stored field.
//! The timer scheduler is behind an **async** [`tokio::sync::Mutex`] — a
//! `std::sync::Mutex` held across the scheduler's `await` would block a
//! single-threaded `LocalSet` and could deadlock; an async mutex yields instead.

use std::sync::Arc;

use crate::{
    functions::{
        TwitchFunctions,
        clips::{ClipCancelled, CreateClipOptions, CreateClipResponse},
    },
    utils::{
        ast_evaluator::{
            Context, FunctionMetadata, FunctionRegistry, JsString, JsValue, js_string, to_number,
        },
        ast_syntax::AstNode,
        ast_timer_runtime::{AstTimerClock, AstTimerIdSource, AstTimerScheduler, AstTimerStore},
        js_compat,
        logger::{Level, LogOptions, Logger},
        twitch::TWITCH_BOT_ACCOUNT_ID,
    },
};

use super::{
    AstFunctionCatalog, AstRuntimeError, AstScope, BoxFuture, SendResult, chat::send_chat_message,
};

use crate::create_clip_command::parse_clip_options;

/// `MAX_TIMER_SECONDS` in `src/utils/ast_parser/timer.ts` (`7 * 24 * 60 * 60`).
pub const MAX_TIMER_SECONDS: u64 = 7 * 24 * 60 * 60;
/// `MAX_TIMER_DEPTH` in `src/utils/ast_parser/timer.ts`.
pub const MAX_TIMER_DEPTH: f64 = 5.0;
/// `MAX_DELAY_SECONDS` in `src/utils/ast_parser/functions/delay.functions.ts`.
pub const MAX_DELAY_SECONDS: u64 = 60;
/// `message.length > 500` in `src/utils/ast_parser/functions/chat.functions.ts`.
/// The limit counts UTF-16 code units, like the source's `String.prototype.length`.
pub const MAX_ANNOUNCEMENT_LENGTH: usize = 500;

const MAX_TIMER_SECONDS_F64: f64 = MAX_TIMER_SECONDS as f64;
/// `1` in `src/utils/ast_parser/timer.ts`.
const MIN_TIMER_SECONDS: u64 = 1;

/// Sends one already-rendered chat message on behalf of `chat.send`.
///
/// Mirrors the source's `ChatFunctions.sendTwitchChatMessage(channelID,
/// message)` call: no reply target, no parser, no command references. The
/// production adapter is [`TwitchChatAdapter`]; tests inject a fake so no
/// network or Twitch token is needed.
pub trait AstChatSend: Send + Sync {
    fn send<'a>(
        &'a self,
        channel_id: &'a str,
        message: &'a str,
    ) -> BoxFuture<'a, Result<SendResult, AstRuntimeError>>;
}

/// Production [`AstChatSend`]: the native context-free chat send.
///
/// Construction performs no I/O. It reuses
/// [`send_chat_message`] unchanged, so the reply-parent path, the plain port,
/// token handling, moderation-hold handling and the source's failure projection
/// are the same ones the delivery lane uses.
pub struct TwitchChatAdapter {
    twitch: TwitchFunctions,
    logger: Option<Arc<Logger>>,
}

impl TwitchChatAdapter {
    pub fn new(twitch: TwitchFunctions) -> Self {
        Self {
            twitch,
            logger: None,
        }
    }

    pub fn with_optional_logger(twitch: TwitchFunctions, logger: Option<Arc<Logger>>) -> Self {
        Self { twitch, logger }
    }

    pub fn twitch(&self) -> &TwitchFunctions {
        &self.twitch
    }

    pub fn logger(&self) -> Option<&Arc<Logger>> {
        self.logger.as_ref()
    }
}

impl AstChatSend for TwitchChatAdapter {
    fn send<'a>(
        &'a self,
        channel_id: &'a str,
        message: &'a str,
    ) -> BoxFuture<'a, Result<SendResult, AstRuntimeError>> {
        Box::pin(async move {
            // Source: `sendTwitchChatMessage(ctx.broadcasterId, message)`.
            // No reply target and no cancellation token on this path.
            send_chat_message(
                &self.twitch,
                self.logger.as_ref(),
                channel_id,
                message,
                None,
                None,
            )
            .await
        })
    }
}

/// Sends one Twitch announcement on behalf of `announce` / `chat.announcement`.
///
/// The source calls `ChatFunctions.sendAnnouncement(ctx.broadcasterId,
/// TWITCH_BOT_ACCOUNT_ID, message, color)`. The broadcaster is the channel the
/// announcement lands in and the **bot account** is the moderator id, so the
/// seam takes the resolved colour rather than a moderator: the colour is
/// parsed by the catalog, exactly as the source's `announceHandler` parses it,
/// and the moderator id is fixed to [`TWITCH_BOT_ACCOUNT_ID`].
///
/// The production adapter is [`TwitchAnnounceAdapter`]; tests inject a fake so
/// no network or Twitch token is needed.
pub trait AstAnnounceSend: Send + Sync {
    fn announce<'a>(
        &'a self,
        channel_id: &'a str,
        message: &'a str,
        color: &'a str,
    ) -> BoxFuture<'a, Result<SendResult, AstRuntimeError>>;
}

/// Production [`AstAnnounceSend`]: the native `sendAnnouncement` port.
///
/// Construction performs no I/O. The call reuses the native announcement
/// adapter in [`crate::functions::chats::announcement`], which owns the Helix
/// request shape, the `204` success rule and the failure log.
pub struct TwitchAnnounceAdapter {
    twitch: TwitchFunctions,
}

impl TwitchAnnounceAdapter {
    pub fn new(twitch: TwitchFunctions) -> Self {
        Self { twitch }
    }

    pub fn twitch(&self) -> &TwitchFunctions {
        &self.twitch
    }
}

impl AstAnnounceSend for TwitchAnnounceAdapter {
    fn announce<'a>(
        &'a self,
        channel_id: &'a str,
        message: &'a str,
        color: &'a str,
    ) -> BoxFuture<'a, Result<SendResult, AstRuntimeError>> {
        Box::pin(async move {
            let response = self
                .twitch
                .send_announcement(channel_id, TWITCH_BOT_ACCOUNT_ID, message, Some(color))
                .await;
            Ok(SendResult {
                error: response.error,
                message: response.message,
                status: response.status,
            })
        })
    }
}

/// Creates one clip on behalf of `create.clip`.
///
/// The source calls `ClipFunctions.createClip(ctx.broadcasterId, options)` after
/// `parseClipOptions`. The production adapter is [`TwitchClipCreateAdapter`];
/// tests inject a fake so no network or Twitch token is needed.
pub trait AstClipCreate: Send + Sync {
    fn create<'a>(
        &'a self,
        channel_id: &'a str,
        options: Option<&'a CreateClipOptions>,
    ) -> BoxFuture<'a, Result<CreateClipResponse, AstRuntimeError>>;
}

/// Production [`AstClipCreate`]: the native `createClip` port.
///
/// Construction performs no I/O. The call reuses
/// [`TwitchFunctions::create_clip`], which owns the bot-token header, the
/// `POST clips` request shape, the `202` success rule, the `404`
/// broadcaster-not-live value and the source's logged internal-error value.
pub struct TwitchClipCreateAdapter {
    twitch: TwitchFunctions,
}

impl TwitchClipCreateAdapter {
    pub fn new(twitch: TwitchFunctions) -> Self {
        Self { twitch }
    }

    pub fn twitch(&self) -> &TwitchFunctions {
        &self.twitch
    }
}

impl AstClipCreate for TwitchClipCreateAdapter {
    fn create<'a>(
        &'a self,
        channel_id: &'a str,
        options: Option<&'a CreateClipOptions>,
    ) -> BoxFuture<'a, Result<CreateClipResponse, AstRuntimeError>> {
        Box::pin(async move {
            match self.twitch.create_clip(channel_id, options).await {
                Ok(response) => Ok(response),
                // The source has no abort path; a cancelled request is a typed
                // failure here instead of a fabricated clip result.
                Err(ClipCancelled) => Err(AstRuntimeError::Cancelled),
            }
        })
    }
}

/// The pause `delay` performs.
///
/// The source awaits `new Promise(resolve => setTimeout(resolve, ms))`. This is
/// deliberately a separate seam from
/// [`AstTimerClock`](crate::utils::ast_timer_runtime::AstTimerClock): the timer
/// clock is owned by [`AstTimerScheduler`], which exposes `&mut` access to its
/// store and id source but not to its clock, and a delay must not hold the
/// scheduler lock while it sleeps. The production adapter is
/// [`TokioDelayClock`]; tests inject a recorder so a `delay 5` costs no wall
/// clock time.
pub trait AstDelayClock: Send + Sync {
    fn sleep_millis<'a>(&'a self, millis: u64) -> BoxFuture<'a, ()>;
}

/// Production [`AstDelayClock`]: a Tokio timer, dropped with the future.
///
/// A zero-millisecond pause returns without arming a timer; the source's
/// `setTimeout(fn, 0)` only yields a macrotask, and the authored pause has no
/// observable ordering contract beyond "after the current step".
#[derive(Clone, Copy, Debug, Default)]
pub struct TokioDelayClock;

impl AstDelayClock for TokioDelayClock {
    fn sleep_millis<'a>(&'a self, millis: u64) -> BoxFuture<'a, ()> {
        Box::pin(async move {
            if millis > 0 {
                tokio::time::sleep(std::time::Duration::from_millis(millis)).await;
            }
        })
    }
}

/// One concrete [`AstFunctionCatalog`] backed by real application adapters.
///
/// `S`/`C`/`I` are the native timer runtime's store, clock and id source, so a
/// caller can inject the Dragonfly adapter in production and an in-memory fake in
/// a test without a second code path.
pub struct BotAstFunctions<S, C, I> {
    chat: Arc<dyn AstChatSend>,
    announce: Option<Arc<dyn AstAnnounceSend>>,
    clip: Option<Arc<dyn AstClipCreate>>,
    delay_clock: Arc<dyn AstDelayClock>,
    timers: tokio::sync::Mutex<AstTimerScheduler<S, C, I>>,
    metadata: Vec<(String, FunctionMetadata)>,
    logger: Option<Arc<Logger>>,
}

impl<S, C, I> BotAstFunctions<S, C, I>
where
    S: AstTimerStore,
    C: AstTimerClock,
    I: AstTimerIdSource,
{
    /// Assemble the catalog from injected collaborators. No I/O, no background
    /// task, no global state.
    pub fn new(
        chat: Arc<dyn AstChatSend>,
        delay_clock: Arc<dyn AstDelayClock>,
        timers: AstTimerScheduler<S, C, I>,
    ) -> Self {
        Self {
            chat,
            announce: None,
            clip: None,
            delay_clock,
            timers: tokio::sync::Mutex::new(timers),
            metadata: metadata_table(),
            logger: None,
        }
    }

    /// Production wiring: the real Twitch client behind `chat.send`, the Tokio
    /// delay clock, and the caller's timer scheduler.
    ///
    /// The same Twitch client also serves `announce` / `chat.announcement` and
    /// `create.clip`, so one client backs every Twitch-backed family here.
    pub fn with_twitch(twitch: TwitchFunctions, timers: AstTimerScheduler<S, C, I>) -> Self {
        let mut catalog = Self::new(
            Arc::new(TwitchChatAdapter::new(twitch.clone())),
            Arc::new(TokioDelayClock),
            timers,
        );
        catalog.announce = Some(Arc::new(TwitchAnnounceAdapter::new(twitch.clone())));
        catalog.clip = Some(Arc::new(TwitchClipCreateAdapter::new(twitch)));
        catalog
    }

    /// [`BotAstFunctions::with_twitch`] plus the shared logger used for the
    /// source's `console.error('AST timer scheduling failed', …)`.
    pub fn with_twitch_and_logger(
        twitch: TwitchFunctions,
        timers: AstTimerScheduler<S, C, I>,
        logger: Option<Arc<Logger>>,
    ) -> Self {
        Self {
            chat: Arc::new(TwitchChatAdapter::with_optional_logger(
                twitch.clone(),
                logger.clone(),
            )),
            announce: Some(Arc::new(TwitchAnnounceAdapter::new(twitch.clone()))),
            clip: Some(Arc::new(TwitchClipCreateAdapter::new(twitch))),
            delay_clock: Arc::new(TokioDelayClock),
            timers: tokio::sync::Mutex::new(timers),
            metadata: metadata_table(),
            logger,
        }
    }

    /// Install the announcement seam.
    ///
    /// Without it `announce` / `chat.announcement` report
    /// [`AstRuntimeError::Unsupported`], exactly as they did before the native
    /// announcement adapter existed.
    pub fn with_announce(mut self, announce: Arc<dyn AstAnnounceSend>) -> Self {
        self.announce = Some(announce);
        self
    }

    /// Install the clip seam.
    ///
    /// Without it `create.clip` reports [`AstRuntimeError::Unsupported`] naming
    /// the missing adapter instead of inventing a URL or an empty success.
    pub fn with_clip(mut self, clip: Arc<dyn AstClipCreate>) -> Self {
        self.clip = Some(clip);
        self
    }

    /// Attach a logger to an already assembled catalog.
    pub fn with_logger(mut self, logger: Arc<Logger>) -> Self {
        self.logger = Some(logger);
        self
    }

    /// Catalog metadata for one function name, exactly as the source registers
    /// it.
    pub fn metadata(&self, name: &str) -> Option<&FunctionMetadata> {
        self.metadata
            .iter()
            .find(|(key, _)| key == name)
            .map(|(_, metadata)| metadata)
    }

    /// Every `(name, metadata)` pair this catalog serves, in registration order.
    pub fn registrations(&self) -> &[(String, FunctionMetadata)] {
        &self.metadata
    }

    /// Install every registration into a native
    /// [`FunctionRegistry`].
    ///
    /// This is what makes the family reachable at all: the VM reports
    /// `[Unknown function: name]` for an unregistered name, and it enforces the
    /// registered `min_user_level` before dispatching.
    pub fn register_into(&self, registry: &mut FunctionRegistry) {
        for (name, metadata) in &self.metadata {
            registry.register(name.clone(), Some(metadata.clone()));
        }
    }

    /// Complete port of `evaluateTimer`.
    ///
    /// `args` are the **unevaluated** AST arguments of the `timer` function node,
    /// `duration` is the value `args[0]` evaluated to (the caller clears
    /// `effect_context` first, as `timer.ts` does), and `context` is the live
    /// execution context whose `timer_depth` is the nesting guard and whose
    /// snapshot crosses the cache boundary.
    ///
    /// Guard order, strings and the empty-string success value are the source's.
    pub async fn timer(
        &self,
        scope: &AstScope,
        args: &[AstNode],
        duration: &JsValue,
        context: &Context,
    ) -> Result<JsValue, AstRuntimeError> {
        // `if (node.args.length < 2)`
        if args.len() < 2 {
            return Ok(timer_message("usage: $(timer seconds message_and_actions)"));
        }
        let (depth, platform, broadcaster) = {
            let execution = context.borrow();
            (
                execution.timer_depth.unwrap_or(0.0),
                execution.platform.clone(),
                execution.broadcaster_id.clone(),
            )
        };
        // `if ((context.timerDepth ?? 0) >= MAX_TIMER_DEPTH)`
        if depth >= MAX_TIMER_DEPTH {
            return Ok(timer_message("maximum nested timer depth reached"));
        }
        // `if (!context.broadcasterId || context.platform !== 'twitch')`.
        // The scope is the broadcaster; the snapshot also stores
        // `broadcasterId` from the context, and both must name a channel.
        if broadcaster.is_empty() || scope.channel_id.is_empty() || platform != "twitch" {
            return Ok(timer_message("requires a Twitch channel"));
        }
        // `const seconds = Number(duration.value)` — JavaScript coercion, so
        // `"300"` is accepted and `"nope"`/`Infinity` are not.
        let seconds = to_number(duration);
        if !seconds.is_finite()
            || !(MIN_TIMER_SECONDS as f64..=MAX_TIMER_SECONDS_F64).contains(&seconds)
        {
            return Ok(timer_message(&format!(
                "seconds must be between {MIN_TIMER_SECONDS} and {MAX_TIMER_SECONDS}"
            )));
        }
        // `{ type: 'root', children: node.args.slice(1) }` — the body stays
        // unevaluated until the scheduler fires it in a fresh context.
        let body = AstNode::Root { children: args[1..].to_vec() };
        match self.schedule(seconds, &body, context).await {
            Ok(()) => Ok(JsValue::string("")),
            Err(error) => {
                self.log_schedule_failure(&scope.channel_id, &error).await;
                Ok(timer_message("could not schedule timer"))
            }
        }
    }

    /// Host adapter for
    /// [`HostRequest::ScheduleTimer`](crate::utils::ast_evaluator::HostRequest::ScheduleTimer).
    ///
    /// The VM has already applied the usage, depth, channel and range guards and
    /// cleared the effect authority; this persists the job through the native
    /// timer runtime. A store failure is returned as
    /// [`AstRuntimeError::Host`], which the VM turns into the source's
    /// `timer: could not schedule timer`.
    pub async fn schedule_timer(
        &self,
        scope: &AstScope,
        seconds: f64,
        body: &AstNode,
        context: &Context,
    ) -> Result<(), AstRuntimeError> {
        let result = self.schedule(seconds, body, context).await;
        if let Err(error) = &result {
            self.log_schedule_failure(&scope.channel_id, error).await;
        }
        result
    }

    /// Port of `delay.functions.ts`'s `delayHandler`.
    ///
    /// `Number(args[0])` is reused (`to_number`) so `"5"` is five seconds and
    /// `"abc"` is not a number; the failure message quotes the **raw** argument.
    pub async fn delay(&self, args: &[JsValue]) -> Result<JsValue, AstRuntimeError> {
        let Some(raw) = args.first() else {
            return Ok(JsValue::string("delay: missing argument (seconds)"));
        };
        let seconds = to_number(raw);
        if !seconds.is_finite() {
            let text = js_string(raw)
                .to_utf8()
                .map_err(|error| AstRuntimeError::Evaluation(error.to_string()))?;
            // The source interpolates the raw argument: `delay: "abc" is not…`.
            return Ok(JsValue::string(format!("delay: \"{text}\" is not a valid number")));
        }
        if !(0.0..=MAX_DELAY_SECONDS as f64).contains(&seconds) {
            return Ok(JsValue::string(format!(
                "delay: must be between 0 and {MAX_DELAY_SECONDS} seconds"
            )));
        }
        self.delay_clock.sleep_millis(delay_millis(seconds)).await;
        Ok(JsValue::string(""))
    }

    /// Port of `chat.functions.ts`'s `chatSendHandler`.
    ///
    /// `(args[0] ?? '').toString().trim()`, an empty message sends nothing, a
    /// failed send returns `chat.send: <message>` and success returns the empty
    /// string.
    pub async fn chat_send(
        &self,
        scope: &AstScope,
        args: &[JsValue],
    ) -> Result<JsValue, AstRuntimeError> {
        let raw = match args.first() {
            None => JsString::default(),
            Some(value) if value.is_nullish() => JsString::default(),
            Some(value) => js_string(value),
        };
        let message = raw.trim();
        if message.is_empty() {
            return Ok(JsValue::string(""));
        }
        let message = message
            .to_utf8()
            .map_err(|error| AstRuntimeError::Evaluation(error.to_string()))?;
        let result = self.chat.send(&scope.channel_id, &message).await?;
        if result.error {
            return Ok(JsValue::string(format!("chat.send: {}", result.message)));
        }
        Ok(JsValue::string(""))
    }

    /// `announce [color] message` — the source's `announceHandler`.
    ///
    /// The source parses the optional colour word, enforces the 500-character
    /// limit and returns `announce: <message>` on a Twitch failure. Every step
    /// here is the source's step, in the source's order.
    ///
    /// The catalogue dispatches both `announce` and `chat.announcement` here;
    /// the source registers the same handler under both names.
    pub async fn announce(
        &self,
        scope: &AstScope,
        args: &[JsValue],
    ) -> Result<JsValue, AstRuntimeError> {
        let Some(announce) = self.announce.as_ref() else {
            return Err(AstRuntimeError::Unsupported(unsupported_announcement("announce")));
        };
        // `args.map(arg => String(arg ?? '')).join(' ').trim()`
        let raw = js_arguments_joined(args);
        let raw_text = raw
            .to_utf8()
            .map_err(|error| AstRuntimeError::Evaluation(error.to_string()))?;
        let trimmed = raw_text.trim();
        // `const [first = ''] = raw.split(/\s+/);`
        let first = trimmed.split_whitespace().next().unwrap_or_default();
        let first_lower = first.to_lowercase();
        let has_color = matches!(
            first_lower.as_str(),
            "blue" | "green" | "orange" | "purple" | "primary"
        );
        let color = if has_color {
            first_lower
        } else {
            "primary".to_owned()
        };
        // `hasColor ? raw.slice(first.length).trim() : raw`
        let message = if has_color {
            trimmed[first.len()..].trim().to_owned()
        } else {
            trimmed.to_owned()
        };
        if message.is_empty() {
            return Ok(JsValue::string(
                "Usage: $(announce [blue|green|orange|purple|primary] message)",
            ));
        }
        // `message.length > 500` counts UTF-16 code units, not bytes.
        if JsString::from(message.as_str()).len() > MAX_ANNOUNCEMENT_LENGTH {
            return Ok(JsValue::string(
                "announce: message must be at most 500 characters",
            ));
        }
        let result = announce.announce(&scope.channel_id, &message, &color).await?;
        if result.error {
            return Ok(JsValue::string(format!("announce: {}", result.message)));
        }
        Ok(JsValue::string(""))
    }

    /// Port of `clip.functions.ts`'s `createClipHandler`.
    ///
    /// `parseRawArgument(args, ctx.argument)` joins the evaluated arguments with
    /// a space; with no arguments it falls back to `ctx.argument`. The argument
    /// then goes through `parseClipOptions`, and the clip URL is returned only
    /// when `createClip` reported no error **and** an id. Every other outcome —
    /// a permission refusal, a broadcaster that is not live, an unavailable
    /// endpoint, a Twitch error body — is the source's empty string.
    ///
    /// `argument` is the source's `ctx.argument`.
    /// [`AstFunctionCatalog::call`] cannot see the parser context, so it passes
    /// `None` (the source's `ctx.argument === undefined` case); a host that owns
    /// the context calls this method directly with it.
    ///
    /// The joined argument must be UTF-8 representable: a lone UTF-16 surrogate
    /// in an argument cannot round-trip through [`JsString::to_utf8`] and is
    /// reported as [`AstRuntimeError::Evaluation`] instead of a silently altered
    /// title. TypeScript strings are UTF-16 already and cannot express the case.
    pub async fn create_clip(
        &self,
        scope: &AstScope,
        args: &[JsValue],
        argument: Option<&str>,
    ) -> Result<JsValue, AstRuntimeError> {
        let Some(clip) = self.clip.as_ref() else {
            return Err(AstRuntimeError::Unsupported(unsupported_clip(
                "create.clip",
            )));
        };
        let raw_argument = parse_clip_argument(args, argument)?;
        let options = parse_clip_options(Some(&raw_argument));
        let result = clip.create(&scope.channel_id, Some(&options)).await?;
        if result.error {
            return Ok(JsValue::string(""));
        }
        let Some(clip_id) = result.clip_id_text() else {
            return Ok(JsValue::string(""));
        };
        Ok(JsValue::string(format!("https://clips.twitch.tv/{clip_id}")))
    }

    /// Persist one timer job and arm it for local delivery.
    async fn schedule(
        &self,
        seconds: f64,
        body: &AstNode,
        context: &Context,
    ) -> Result<(), AstRuntimeError> {
        let mut timers = self.timers.lock().await;
        match timers.schedule(seconds, body, context).await {
            Ok(_job) => Ok(()),
            Err(error) => Err(AstRuntimeError::Host(error.to_string())),
        }
    }

    /// Best-effort equivalent of the source's
    /// `console.error('AST timer scheduling failed', { channelID, error })`.
    async fn log_schedule_failure(&self, channel_id: &str, error: &AstRuntimeError) {
        if let Some(logger) = &self.logger {
            let _ = logger
                .log(
                    Level::Error,
                    serde_json::json!({
                        "message": "AST timer scheduling failed",
                        "channelID": channel_id,
                        "error": error.message(),
                    }),
                    LogOptions {
                        channel_id: Some(channel_id.to_owned()),
                        ..Default::default()
                    },
                )
                .await;
        }
    }
}

impl<S, C, I> AstFunctionCatalog for BotAstFunctions<S, C, I>
where
    S: AstTimerStore + Send,
    C: AstTimerClock + Send,
    I: AstTimerIdSource + Send,
{
    fn call<'a>(
        &'a self,
        scope: &'a AstScope,
        name: &str,
        args: &[JsValue],
    ) -> BoxFuture<'a, Result<JsValue, AstRuntimeError>> {
        // The trait takes `name`/`args` without tying them to `'a`, so the
        // dispatch owns its copies and only borrows `self` and `scope`.
        let name = name.to_owned();
        let args = args.to_vec();
        Box::pin(async move {
            match name.as_str() {
                "delay" => self.delay(&args).await,
                "chat.send" => self.chat_send(scope, &args).await,
                "announce" | "chat.announcement" => self.announce(scope, &args).await,
                "create.clip" => self.create_clip(scope, &args, None).await,
                "timer" => Err(AstRuntimeError::Unsupported(unsupported_timer(&name))),
                other => Err(AstRuntimeError::Unsupported(unsupported_function(other))),
            }
        })
    }
}

/// Bridges the application host's single timer seam to this catalog.
///
/// [`host::TimerScheduler`](super::host::TimerScheduler) is the one timer
/// seam in this runtime: the host's `HostRequest::ScheduleTimer` arm calls
/// it, and the concrete implementation is this catalog, which owns the native
/// timer runtime. There is deliberately no second timer path.
impl<S, C, I> super::host::TimerScheduler for BotAstFunctions<S, C, I>
where
    S: AstTimerStore + Send,
    C: AstTimerClock + Send,
    I: AstTimerIdSource + Send,
{
    fn schedule<'a>(
        &'a self,
        seconds: f64,
        body: &'a AstNode,
        context: &'a Context,
    ) -> BoxFuture<'a, Result<(), AstRuntimeError>> {
        Box::pin(async move { BotAstFunctions::schedule(self, seconds, body, context).await })
    }
}

/// `timer: <message>` — the source's `fail()` value.
fn timer_message(message: &str) -> JsValue {
    JsValue::string(format!("timer: {message}"))
}

/// `Math.round(seconds * 1000)` for the `setTimeout` delay.
fn delay_millis(seconds: f64) -> u64 {
    let millis = (seconds * 1000.0 + 0.5).floor();
    if millis <= 0.0 { 0 } else { millis as u64 }
}

/// `String(arg ?? '')` — the source's argument coercion for `announce`.
///
/// `??` replaces only `null` and `undefined` with the empty string, so this is
/// **not** [`js_string`], which renders `null` as `"null"` and `undefined` as
/// `"undefined"`. An array is joined with `,` and its `null`/`undefined`
/// elements become empty, matching `Array.prototype.join`.
fn js_to_string_or_empty(value: &JsValue) -> JsString {
    match value {
        JsValue::Undefined | JsValue::Null => JsString::default(),
        JsValue::Boolean(flag) => JsString::from(if *flag { "true" } else { "false" }),
        JsValue::Number(number) => {
            JsString::from(crate::utils::json_number::number_string(*number))
        }
        JsValue::String(text) => text.clone(),
        JsValue::Object(_) => JsString::from("[object Object]"),
        JsValue::Array(items) => {
            let mut out = JsString::default();
            for (index, item) in items.borrow().iter().enumerate() {
                if index > 0 {
                    out.push(&JsString::from(","));
                }
                out.push(&js_to_string_or_empty(item));
            }
            out
        }
    }
}

/// `args.map(arg => String(arg ?? '')).join(' ')`
fn js_arguments_joined(args: &[JsValue]) -> JsString {
    let mut out = JsString::default();
    for (index, argument) in args.iter().enumerate() {
        if index > 0 {
            out.push(&JsString::from(" "));
        }
        out.push(&js_to_string_or_empty(argument));
    }
    out
}

fn unsupported_announcement(name: &str) -> String {
    format!(
        "{name}: no announcement adapter is installed on this catalog. \
         The native sendAnnouncement port lives in \
         src/functions/chats/announcement.chat.rs; install it with \
         BotAstFunctions::with_announce (the Twitch constructors install it \
         automatically)"
    )
}

fn unsupported_clip(name: &str) -> String {
    format!(
        "{name}: no clip adapter is installed on this catalog. \
         The native createClip port lives in src/functions/clips/create.clip.rs; \
         install it with BotAstFunctions::with_clip (the Twitch constructors \
         install it automatically)"
    )
}

/// `parseRawArgument(args, ctx.argument)` from `clip.functions.ts`.
///
/// `args.map(arg => String(arg)).join(' ').trim()` when the function has
/// arguments; otherwise `String(fallback || '').trim()`. `String(...)` keeps
/// `null`/`undefined` spells, so [`js_string`] is the right coercion here — not
/// the `?? ''` variant the announcement family uses.
fn parse_clip_argument(
    args: &[JsValue],
    fallback: Option<&str>,
) -> Result<String, AstRuntimeError> {
    if args.is_empty() {
        return Ok(js_compat::trim(fallback.unwrap_or_default()).to_owned());
    }
    let mut joined = JsString::default();
    for (index, argument) in args.iter().enumerate() {
        if index > 0 {
            joined.push(&JsString::from(" "));
        }
        joined.push(&js_string(argument));
    }
    joined
        .trim()
        .to_utf8()
        .map_err(|error| AstRuntimeError::Evaluation(error.to_string()))
}

fn unsupported_timer(name: &str) -> String {
    format!(
        "{name}: an evaluated-argument catalog cannot schedule a timer, because the body must stay unevaluated; the native VM emits HostRequest::ScheduleTimer, so call BotAstFunctions::schedule_timer (or BotAstFunctions::timer for the full guard port)"
    )
}

fn unsupported_function(name: &str) -> String {
    format!("{name}: no native adapter for this AST function")
}

/// The `registerFunction(...)` metadata of the families implemented here,
/// copied from `delay.functions.ts`, `chat.functions.ts` and
/// `clip.functions.ts`.
fn metadata_table() -> Vec<(String, FunctionMetadata)> {
    let announce = FunctionMetadata {
        description: "Sends a Twitch announcement. Optional first word selects blue, green, orange, purple or primary; default primary. Message must be 1-500 characters.".into(),
        syntax: "announce [color] message".into(),
        category: "chat".into(),
        examples: vec![
            "announce Welcome everyone!".into(),
            "announce purple Five minutes left!".into(),
        ],
        min_user_level: Some(7.0),
        keywords: Some(vec![
            "announcement".into(),
            "announce".into(),
            "anuncio".into(),
        ]),
        ..Default::default()
    };
    vec![
        (
            "timer".into(),
            FunctionMetadata {
                description: "Schedules an unevaluated message and its nested actions after 1-604800 seconds. Returns immediately. Survives bot restarts in cache; overdue jobs run within a 10-minute grace period, then expire. Each invocation creates a separate timer; execution is at most once.".into(),
                syntax: "timer seconds message_and_actions".into(),
                category: "flow".into(),
                examples: vec!["timer 300 5 minutes over! $(trigger.send hurray)".into()],
                keywords: Some(vec![
                    "timer".into(),
                    "schedule".into(),
                    "countdown".into(),
                    "temporizador".into(),
                    "deferred".into(),
                ]),
                surfaces: Some(vec!["authoring".into()]),
                ..Default::default()
            },
        ),
        (
            "delay".into(),
            FunctionMetadata {
                description: "Pauses execution for the given number of seconds (0-60). Used to sequence multi-step command flows.".into(),
                syntax: "delay seconds".into(),
                category: "flow".into(),
                examples: vec!["delay 3".into()],
                keywords: Some(vec![
                    "delay".into(),
                    "wait".into(),
                    "pause".into(),
                    "esperar".into(),
                    "pausa".into(),
                    "segundos".into(),
                ]),
                surfaces: Some(vec!["authoring".into()]),
                ..Default::default()
            },
        ),
        ("announce".into(), announce.clone()),
        (
            "chat.announcement".into(),
            FunctionMetadata {
                alias_of: Some("announce".into()),
                ..announce
            },
        ),
        (
            "chat.send".into(),
            FunctionMetadata {
                description: "Sends a message to chat as the bot.".into(),
                syntax: "chat.send message".into(),
                category: "chat".into(),
                examples: vec!["chat.send Hello everyone!".into()],
                keywords: Some(vec![
                    "send message".into(),
                    "say".into(),
                    "enviar mensaje".into(),
                    "decir en chat".into(),
                    "hablar".into(),
                ]),
                ..Default::default()
            },
        ),
        (
            "create.clip".into(),
            FunctionMetadata {
                description: "Creates a clip of the current stream moment and returns the clip URL. Optional clip title.".into(),
                syntax: "create.clip [title]".into(),
                category: "clip".into(),
                examples: vec!["create.clip".into(), "create.clip Epic win".into()],
                min_user_level: Some(7.0),
                keywords: Some(vec![
                    "clip".into(),
                    "create clip".into(),
                    "crear clip".into(),
                    "clip this".into(),
                    "momento".into(),
                ]),
                ..Default::default()
            },
        ),
    ]
}
