//! The chat message handler, the hot path: what the bot does with every `channel.chat.message`
//! of every channel. Package **P4-CHAT-MESSAGE**.
//!
//! TypeScript it ports (baseline `0c71108e`):
//!
//! - `handlers/message.handler.ts` (839 lines): `messageHandler` ([`MessageHandler`]);
//! - `handlers/keywords.handler.ts` (25 lines): `handleKeywords` (`keywords.rs`);
//! - `functions/promo/chat.promo.ts` (138 lines), `functions/promo/index.ts`: `promo`
//!   ([`crate::promo`]);
//! - and the `channel.chat.message` branch of `handlers/eventsub.handler.ts` (lines 48-61,
//!   97-103, 150-199, 233-235: the shared-chat filter, the widget feed, the streamer and the
//!   subscription's `enabled` setting), which runs before it. P4-CHAT-EVENTS ports the rest of
//!   that file and registers it beside this handler ([`crate::dispatch`]).
//!
//! # The order of effects, and where a message stops
//!
//! Each step names the reference's line (`e:` is `eventsub.handler.ts`, the rest
//! `message.handler.ts`). "Stops" means nothing after it happens for that message.
//!
//! 1. `e:49-54` A shared-chat copy from another channel (`source_broadcaster_user_id` set and
//!    not this channel): published to the widget feed, then **stops**.
//! 2. `e:59-61` Published to the widget feed ([`seams::WidgetChatFeed`]).
//! 3. `:59` The bot's own message (`chatter_user_id` is the bot account): **stops**. (Moved
//!    before steps 5 and 6 here: the reference read the streamer and the subscription first,
//!    which changes nothing but a log line; intended.)
//! 4. Admission ([`limits`]): a place among the messages in flight of the channel and in total,
//!    or the message is **dropped** and counted.
//! 5. `e:97-103` The streamer directory has no account for the channel: **stops**.
//! 6. `e:150-199` The channel's `channel.chat.message` subscription document (`eventsubs`) has
//!    `enabled` false: **stops** (no document reads as enabled, with the reference's info log).
//! 7. `:60-61` The message metric starts (`messageHandlerStarted`).
//! 8. `:64-68` The streamer, again (the reference reads it twice): none **stops**.
//! 9. `:72` The chatter's identity: badges, then editor and admin from the role cache (the
//!    broadcaster by the channel id alone); a cache failure keeps the badge roles.
//! 10. `:75-77` The chat history gets the message (`twitch:{channel}:chat:history`, awaited).
//! 11. `:79` `site:analytics` `total_messages` + 1, and `:88` the stream recorders for a message
//!     (session `messages` + 1, the activity row with its emotes) run **beside** the steps that
//!     follow (the reference does not wait for them); the message waits for them at its end.
//! 12. `:97` The text is queued for chat memory embeddings (when it is not blank).
//! 13. `:108-112` Moderation ([`seams::ChatModeration`]): an action taken **stops** (no keyword,
//!     no command, no AI reply).
//! 14. `:114-117` Keywords (`keywords.rs`): each matching keyword command runs and its reply is
//!     delivered, in match order; a failure is logged and the message goes on.
//! 15. `:130` The command is read from the text: `^!([\p{L}\p{N}]+)(?:\W@?)?(.*)?$` (the prefix is
//!     always `!`; there is no per-channel prefix in the reference).
//! 16. `:142-258` `!cct`, `!ect`, `!dct`, `!timer`, `!timers` (any case): the timer manager. Below
//!     moderator level (7): "You need moderator permissions to manage timers." and **stops**.
//!     Otherwise the timer call, the session's `commands` + 1, the command activity row, the
//!     answer posted; **stops**.
//! 17. `:260-371` No command: when the text contains `@domdimabot` or `@DomDimaBot`, the AI reply
//!     ([`seams::AiReply`]; a disabled personality, or the channels `ozbellvt` and
//!     `littlehuntervt`, **stop** silently). **Stops** either way.
//! 18. `:379-389` The command is looked up by its name as typed (case-sensitive).
//! 19. `:392` Not found, lookup failed, or not enabled: **stops** silently.
//! 20. `:396-410` An invalid stored permission expression is logged (rate-limited).
//! 21. `:412` The chatter's identity fails the command's permission: **stops** silently.
//! 22. `:417-421` The name as typed is on this process's cooldown ([`cooldowns`]): **stops**.
//! 23. `:429-766` The built-in named by `func` ([`seams::BuiltinCommands`], after the handler's
//!     own usage checks), or the custom command: the shared cooldown gate, the evaluation (one
//!     message budget, references included), the counter's `$inc`.
//! 24. `:771-775` The command activity row (`ok`, or `error` when the reply is an error or the
//!     command was refused or threw).
//! 25. A thrown built-in or a failed evaluation (a store failure, a rendering that threw) is a
//!     handler failure: logged, metric failed, **stops** (no tracking, no cooldown, no reply).
//! 26. `:779-788` The product event `command_executed`.
//! 27. `:790-800` The session's `commands` + 1 (beside the delivery).
//! 28. `:802-804` This process's cooldown for the name as typed, when the stored cooldown is not 0.
//! 29. `:818` No reply (a refused command, or a built-in that answers nothing): **stops**. Else the
//!     reply is delivered: posted trimmed, then each command reference in order.
//! 30. `:847-849` The message metric ends (failed or not).
//!
//! # Concurrency and bounds
//!
//! See [`limits`]: per channel and total places, a bounded wait, evaluations in flight, and the
//! message's deadline. One message is one task of the ingress; its side work (step 11, 27) runs
//! in the same task, beside the main steps. A command's run and its references share one message
//! budget (the delivery's `render_message` and `render_reference`); each keyword run is a message
//! of its own as in the reference, at most [`MessageConfig::keyword_runs_per_message`] of them.
//!
//! # What is logged about a message
//!
//! Failures are logged with the channel id and the message id, the function and the error text,
//! at `error` level (to telemetry and the console, as the reference's `logError`), or `warn`
//! for a cache failure the message survived. The chat text, the chatter's name and login are
//! never logged (chat is personal data; `dima-telemetry` redacts secrets, not chat), not even at
//! `debug`. Dropped and timed-out messages are counted (`chat_message.dropped`), never logged
//! one by one.
//!
//! # Differences from the reference, on purpose
//!
//! - The reference's `isMod` is one variable for the whole process, set by the first moderator
//!   or broadcaster message and never reset, so every later chatter of every channel reached the
//!   built-ins `!vanish`, `!duel`, `!amor` and `!vip` as a moderator (`!vanish` then asks Twitch
//!   to remove and later re-add the chatter as a moderator). Here it is this message's chatter
//!   (a moderator badge or the broadcaster): a security fix, asserted by the recordings.
//! - Messages are bounded ([`limits`]); keyword runs per message too.
//! - The bot's own messages stop before the streamer and subscription reads (step 3).
//! - A message without text is refused before any effect (the reference ran steps 7-14 and
//!   threw at `text.match`).
//! - `!anuncio`'s 300 limit counts characters (charter section 4, our own limit on user text),
//!   not UTF-16 units: an announcement with emoji up to 300 characters is accepted.
//! - The command found by the lookup is the one that runs (the reference looked it up twice).
//! - The counter is an `$inc` of the run's change (the delivery's, `dima_actions::runner`).
//! - The ingress's `eventsub` handler metric for a chat message covers the whole message (the
//!   reference did not wait for `messageHandler`).

pub mod config;
pub mod cooldowns;
pub mod event;
pub mod limits;
pub mod seams;

mod ai;
mod builtins;
mod keywords;
mod pipeline;
mod timers;

pub use config::MessageConfig;
pub use event::{ChatEvent, MessageError};
pub use limits::{Admission, AdmissionStats, Dropped};

use crate::dispatch::TypeHandler;
use crate::ingress::{HandlerError, Notification};
use dima_actions::delivery::ChatDelivery;
use dima_actions::metrics::BotMetrics;
use dima_ai::qdrant::{ChatEmbeddingQueue, Observer};
use dima_commands::keywords::{KeywordIndexCache, SharedKeywordLoader};
use dima_commands::permissions::PermissionErrorLimiter;
use dima_commands::runtime::keyword_store::StoreKeywordStorage;
use dima_stream::stream_activity::Activities;
use dima_stream::stream_sessions::StreamSessions;
use futures_util::future::BoxFuture;
use std::sync::Arc;

/// The keyword index cache the handler reads (over the store-backed keyword storage).
pub type KeywordCache = KeywordIndexCache<SharedKeywordLoader<StoreKeywordStorage>>;

/// Everything the handler works with; built once by the bot binary (P4-BIN-BOT).
pub struct MessageDeps {
    /// Commands, keywords and replies: the engine, its host (MongoDB, Dragonfly, Twitch with the
    /// streamer directory, the command cache, the clock, randomness, telemetry) and the chat
    /// delivery.
    pub delivery: Arc<ChatDelivery>,
    /// The stream recorders of a message and a command (session counters, timeline, activity).
    pub sessions: StreamSessions,
    /// The activity rows of commands (`captureStreamActivity`).
    pub activity: Activities,
    /// The channels' keyword indexes (the binary subscribes it to `keywords:changed`).
    pub keywords: Arc<KeywordCache>,
    /// The bot runtime metrics.
    pub metrics: BotMetrics,
    /// `trackCommand`.
    pub tracker: Arc<dyn seams::CommandTracker>,
    /// `incrementSiteAnalytics`.
    pub site: Arc<dyn seams::SiteCounters>,
    /// The chat memory embedding queue (the binary runs its batcher, `dima_ai::batcher`).
    pub embeddings: Arc<dyn ChatEmbeddingQueue + Send + Sync>,
    /// Where a refused embedding is reported.
    pub embedding_observer: Arc<dyn Observer>,
    /// Moderation (P4-MOD-RUN; [`seams::ModerationOff`] until then).
    pub moderation: Arc<dyn seams::ChatModeration>,
    /// The AI reply (P4-ACT-AI-B; [`seams::AiOff`] until then).
    pub ai: Arc<dyn seams::AiReply>,
    /// The built-in commands (P4-CHAT-CMDS-A/B, P4-FEAT-TIMERS; [`seams::BuiltinsNotPorted`]
    /// until then).
    pub builtins: Arc<dyn seams::BuiltinCommands>,
    /// The widget feed (P4-FEAT-WIDGETS; [`seams::NoWidgetFeed`] until then).
    pub feed: Arc<dyn seams::WidgetChatFeed>,
}

pub(crate) struct Inner {
    deps: MessageDeps,
    config: MessageConfig,
    admission: Admission,
    cooldowns: cooldowns::Cooldowns,
    permission_errors: PermissionErrorLimiter,
}

/// The `channel.chat.message` handler: registered with [`crate::dispatch::Dispatcher`]. Cheap to
/// clone.
#[derive(Clone)]
pub struct MessageHandler(Arc<Inner>);

impl MessageHandler {
    /// A handler over `deps`, bounded by `config`.
    pub fn new(deps: MessageDeps, config: MessageConfig) -> Self {
        let clock = Arc::clone(&deps.delivery.host().clock);
        Self(Arc::new(Inner {
            admission: Admission::new(&config),
            cooldowns: cooldowns::Cooldowns::new(clock, &config),
            permission_errors: PermissionErrorLimiter::new(),
            deps,
            config,
        }))
    }

    /// The bounds and their counts.
    pub fn admission(&self) -> &Admission {
        &self.0.admission
    }

    /// Handles one notification of a chat message (steps 1 to 30 of the module documentation).
    /// Failures inside are logged as the reference logs them; the answer is an error only for a
    /// failure of the subscription read (step 6), which the reference let reach the ingress.
    pub async fn handle_notification(
        &self,
        notification: Notification,
    ) -> Result<(), HandlerError> {
        pipeline::entry(&self.0, notification).await
    }
}

impl TypeHandler for MessageHandler {
    fn handle(&self, notification: Notification) -> BoxFuture<'static, Result<(), HandlerError>> {
        let handler = self.clone();
        Box::pin(async move { handler.handle_notification(notification).await })
    }
}
