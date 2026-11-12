//! What the message handler calls that is not ported yet, or lives in a crate it reaches only
//! through a small trait: each trait says what the handler passes, what it expects back, and
//! which package fills it. Each has a stand-in that answers what the reference answers for a
//! channel where the feature is off ("not enabled"), so the bot runs today with moderation and
//! the AI reply off, as the first vertical slice of the plan requires.
//!
//! | Trait | Reference | Filled by | Stand-in |
//! |---|---|---|---|
//! | [`ChatModeration`] | `runChatModeration` (`handlers/moderation.handler.ts:348`) | P4-MOD-RUN (`dima_moderation::handler`) | [`ModerationOff`]: no action taken |
//! | [`AiReply`] | `getChannelPersonality`, `chat` (`utils/ai/openrouter/ai.ts`), `resolveUserThreadForMessage`, `appendAssistantTurnToThread` (`utils/ai/threading/thread_router.ts`) | P4-ACT-AI-A (personality), P4-ACT-AI-B (chat, threads) | [`AiOff`]: the personality is disabled |
//! | [`BuiltinCommands`] | the built-in functions of `message.handler.ts:429-753` and the timer manager (`:177-239`) | P4-CHAT-CMDS-A/B, P4-FEAT-TIMERS, P4-ACT-MEDIA (clips) | [`BuiltinsNotPorted`]: the call fails as a thrown error |
//! | [`WidgetChatFeed`] | `publishWidgetChatEvent(channel, 'chat', event)` (`eventsub.handler.ts:51`, `:60`) | P4-FEAT-WIDGETS (`dima_features::widget_feed`) | [`NoWidgetFeed`]: nothing |
//! | [`SiteCounters`] | `incrementSiteAnalytics('total_messages', 1)` (`message.handler.ts:79`) | implemented here for `dima_stream::site_analytics::SiteAnalytics` | |
//! | [`CommandTracker`] | `trackCommand` (`message.handler.ts:779`) | implemented here for `dima_actions::product_events::ProductEvents` | |
//!
//! The moderation and AI traits are implemented in this crate over the later packages' types
//! (the orphan rule allows it: the traits are this crate's). P4-MOD-RUN implements
//! [`ChatModeration`] for its moderation pass; P4-ACT-AI-B implements [`AiReply`]; the bot
//! binary (P4-BIN-BOT) puts them into [`super::MessageDeps`].

use super::event::ChatEvent;
use dima_actions::product_events::{CommandEvent, ProductEvents};
use dima_commands::permissions::UserIdentity;
use dima_twitch::badges::Badge;
use futures_util::future::BoxFuture;

// ---------------------------------------------------------------------------------------------
// Moderation

/// What the moderation pass gets (`runChatModeration(channelID, message, identity,
/// receivedAt)`).
#[derive(Clone, Copy, Debug)]
pub struct ModerationInput<'a> {
    /// `channelID`.
    pub channel_id: &'a str,
    /// `message`: the chat message.
    pub message: &'a ChatEvent,
    /// `identity`: the chatter's resolved identity (level and tags).
    pub identity: &'a UserIdentity,
    /// `receivedAt`: when the handler received the message (epoch ms, injected clock).
    pub received_at_ms: i64,
}

/// `ChatModerationResult`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ModerationVerdict {
    /// `actionTaken: false`: the message goes on to keywords, commands and the AI reply.
    Pass,
    /// `actionTaken: true`: moderation acted (or a duplicate delivery was fenced); the handler
    /// stops here: no keyword, no command, no AI reply (`message.handler.ts:109-112`).
    ActionTaken,
}

/// The per-message moderation pass (P4-MOD-RUN).
///
/// Must: serialise one chatter's messages in a channel (the reference's `userGates`), never
/// fail (an infrastructure error is logged and answers [`ModerationVerdict::Pass`]: the
/// reference fails open), bound its own time (semantic review has its deadline), and run the
/// consequences (Helix calls) without making the message wait for them.
pub trait ChatModeration: Send + Sync {
    /// `runChatModeration`.
    fn moderate<'a>(&'a self, input: ModerationInput<'a>) -> BoxFuture<'a, ModerationVerdict>;
}

/// Moderation off: what the reference answers for a channel whose moderation settings are off
/// (`moderateMessage`, `moderation.handler.ts:186-189`).
#[derive(Clone, Copy, Debug, Default)]
pub struct ModerationOff;

impl ChatModeration for ModerationOff {
    fn moderate<'a>(&'a self, _: ModerationInput<'a>) -> BoxFuture<'a, ModerationVerdict> {
        Box::pin(async { ModerationVerdict::Pass })
    }
}

// ---------------------------------------------------------------------------------------------
// The AI reply

/// What `getChannelPersonality(channelID)` answered, the two fields the handler reads.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct AiPersonality {
    /// `enabled`: only `Some(false)` stops the reply (`aiPersonality?.enabled === false`).
    pub enabled: Option<bool>,
    /// `contextWindow`: how many recent chat messages the reply reads (`?? (pro ? 15 : 7)`).
    pub context_window: Option<i64>,
}

/// One line of recent chat or of the thread, as the AI chat reads it.
#[derive(Clone, Debug, PartialEq)]
pub struct HistoryLine {
    /// `timestamp` (epoch ms).
    pub timestamp: i64,
    /// `badges`: the badge labels joined with a space, when there were any.
    pub badges: Option<String>,
    /// `username`.
    pub username: String,
    /// `message`.
    pub message: String,
}

/// `resolveUserThreadForMessage({channelID, userID, username, message, planTier,
/// sourceMessageId})`.
#[derive(Clone, Copy, Debug)]
pub struct ThreadRequest<'a> {
    /// `channelID`.
    pub channel_id: &'a str,
    /// `userID`: `String(chatter_user_id || 'unknown')`.
    pub user_id: &'a str,
    /// `username`: `chatter_user_name || chatter_user_login || 'unknown'`.
    pub username: &'a str,
    /// `message`: the text without the bot's mention, trimmed.
    pub message: &'a str,
    /// `planTier`: `pro`, `premium` or `free`.
    pub plan_tier: &'static str,
    /// `sourceMessageId`.
    pub source_message_id: &'a str,
}

/// What thread resolution answered.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct ThreadResolution {
    /// `threadID`.
    pub thread_id: Option<String>,
    /// `promptContext`.
    pub prompt_context: Vec<HistoryLine>,
}

/// `chat({channelID, message, streamer, history, threadHistory, tags})`.
#[derive(Clone, Debug)]
pub struct AiChatRequest<'a> {
    /// `channelID`.
    pub channel_id: &'a str,
    /// `message`: the text without the bot's mention, trimmed.
    pub message: &'a str,
    /// `streamer.name`.
    pub streamer_name: &'a str,
    /// `streamer.plan_tier` as stored (`None` when absent).
    pub streamer_plan: Option<&'a str>,
    /// `history`: the channel's recent chat, newest first.
    pub history: Vec<HistoryLine>,
    /// `threadHistory`.
    pub thread_history: Vec<HistoryLine>,
    /// `tags.badges`.
    pub badges: &'a [Badge],
    /// `tags.username`: `chatter_user_name`.
    pub username: Option<&'a str>,
    /// `tags.chatter_user_id`.
    pub chatter_user_id: Option<&'a str>,
    /// `tags.userLevel`.
    pub user_level: f64,
    /// `tags.identity` (`serializeUserIdentity(identity)`).
    pub identity: &'a UserIdentity,
}

/// `appendAssistantTurnToThread({channelID, threadID, message, planTier, sourceMessageId,
/// delivered})`.
#[derive(Clone, Copy, Debug)]
pub struct AssistantTurn<'a> {
    /// `channelID`.
    pub channel_id: &'a str,
    /// `threadID`.
    pub thread_id: &'a str,
    /// `message`: the reply as posted (recipient tag removed).
    pub message: &'a str,
    /// `planTier`.
    pub plan_tier: &'static str,
    /// `sourceMessageId`.
    pub source_message_id: &'a str,
    /// `delivered`: every chunk was posted.
    pub delivered: bool,
}

/// A failure of the AI seam (logged by the handler; never the chat text).
#[derive(Clone, Debug, PartialEq, Eq, thiserror::Error)]
#[error("{0}")]
pub struct AiError(pub String);

/// The AI reply to a chat message that mentions the bot (P4-ACT-AI-A for the personality,
/// P4-ACT-AI-B for the rest). The handler owns the order (the mention check, the personality
/// gate, the two excluded channels, the history window, chunking, replies, the thread turn); the
/// implementation owns the model call, its money (credits are charged inside `chat`) and the
/// threads. Each call must bound its own time.
pub trait AiReply: Send + Sync {
    /// `getChannelPersonality(channelID)`: `Ok(None)` without a personality. An error stops the
    /// message as a thrown error does in the reference (logged as a handler failure).
    fn personality<'a>(
        &'a self,
        channel_id: &'a str,
    ) -> BoxFuture<'a, Result<Option<AiPersonality>, AiError>>;

    /// `resolveUserThreadForMessage`: an error is logged and the reply goes on without a thread.
    fn resolve_thread<'a>(
        &'a self,
        request: ThreadRequest<'a>,
    ) -> BoxFuture<'a, Result<ThreadResolution, AiError>>;

    /// `chat(...)`: the reply text, or `None` when the AI answered an error or nothing
    /// (`!aiResponse.error && aiResponse.message`).
    fn chat<'a>(&'a self, request: AiChatRequest<'a>) -> BoxFuture<'a, Option<String>>;

    /// `appendAssistantTurnToThread`: an error is logged.
    fn append_assistant_turn<'a>(
        &'a self,
        turn: AssistantTurn<'a>,
    ) -> BoxFuture<'a, Result<(), AiError>>;
}

/// The AI reply off: the personality reads as disabled, which is what the reference does for a
/// channel whose AI personality is off (`message.handler.ts:263-270`: a debug line, no reply).
#[derive(Clone, Copy, Debug, Default)]
pub struct AiOff;

impl AiReply for AiOff {
    fn personality<'a>(
        &'a self,
        _: &'a str,
    ) -> BoxFuture<'a, Result<Option<AiPersonality>, AiError>> {
        Box::pin(async {
            Ok(Some(AiPersonality {
                enabled: Some(false),
                context_window: None,
            }))
        })
    }

    fn resolve_thread<'a>(
        &'a self,
        _: ThreadRequest<'a>,
    ) -> BoxFuture<'a, Result<ThreadResolution, AiError>> {
        Box::pin(async { Ok(ThreadResolution::default()) })
    }

    fn chat<'a>(&'a self, _: AiChatRequest<'a>) -> BoxFuture<'a, Option<String>> {
        Box::pin(async { None })
    }

    fn append_assistant_turn<'a>(
        &'a self,
        _: AssistantTurn<'a>,
    ) -> BoxFuture<'a, Result<(), AiError>> {
        Box::pin(async { Ok(()) })
    }
}

// ---------------------------------------------------------------------------------------------
// Built-in commands

/// The chatter as the old built-ins read it (`tags`, `message.handler.ts:134-140`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LegacyTags {
    /// `id` and `user-id`: `chatter_user_id`.
    pub user_id: String,
    /// `username`: `chatter_user_login`.
    pub username: String,
    /// `display-name`: `chatter_user_name`.
    pub display_name: String,
    /// `mod`: a moderator badge or the broadcaster, for this message (see the module notes on
    /// the reference's process-wide flag).
    pub is_mod: bool,
}

/// `indexCommands.poll(action, …)`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PollAction {
    /// `CREATE`.
    Create,
    /// `END`.
    End,
    /// `ARCHIVE`.
    Archive,
    /// `TERMINATE`.
    Terminate,
}

/// `indexCommands.prediction(action, …)`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PredictionAction {
    /// `CREATE`.
    Create,
    /// `RESOLVED`.
    Resolved,
    /// `CANCELED`.
    Canceled,
    /// `LOCKED`.
    Locked,
}

/// One call of a built-in, with exactly the arguments the reference passes (each variant names
/// its reference function and line of `message.handler.ts`).
#[derive(Clone, Debug, PartialEq)]
pub enum BuiltinCall {
    /// `indexCommands.sumimetro(channelID, chatter_user_login, text.split('!' + command)[1].trim(), command)` (`:431`).
    Sumimetro {
        /// `chatter_user_login`.
        login: String,
        /// The text after `!{command}`, trimmed.
        argument: String,
        /// The command name as typed.
        command: String,
    },
    /// `promo(channelID, streamerArgument, true)` (`:438`): `functions/promo/chat.promo.ts`.
    Promo {
        /// The streamer to promote (login).
        streamer: String,
    },
    /// `handleShoutoutCommand(channelID, streamerArgument, 'purple', '698614112', true)` (`:454`).
    Shoutout {
        /// The user to shout out.
        target: String,
    },
    /// `sendAnnouncement(channelID, chatter_user_id || modID, streamerArgument)` (`:468`).
    Announcement {
        /// The sender: the chatter, or the bot.
        sender_id: String,
        /// The text (at most 300 UTF-16 units, checked by the handler).
        text: String,
    },
    /// `indexCommands.ruletarusa(channelID, chatter_user_login, formatBadges(badges).isMod)` (`:479`).
    Ruletarusa {
        /// `chatter_user_login`.
        login: String,
        /// A broadcaster or moderator badge.
        is_mod: bool,
    },
    /// `indexCommands.amor(tags, streamerArgument)` (`:491`).
    Amor {
        /// `tags`.
        tags: LegacyTags,
        /// Who to measure the love for.
        target: String,
    },
    /// `indexCommands.disableCommand(channelID, streamerArgument)` (`:503`).
    DisableCommand {
        /// The command name.
        name: String,
    },
    /// `indexCommands.enableCommand(channelID, streamerArgument)` (`:515`).
    EnableCommand {
        /// The command name.
        name: String,
    },
    /// `createCommand(channelID, streamerArgument)` (`:527`).
    CreateCommand {
        /// `<command name> <command function>`.
        argument: String,
    },
    /// `deleteCommand(channelID, streamerArgument, userLevel)` (`:539`).
    DeleteCommand {
        /// The command name.
        argument: String,
        /// The chatter's level.
        user_level: f64,
    },
    /// `editCommand(channelID, streamerArgument, userLevel)` (`:551`).
    EditCommand {
        /// `<command name> <command function>`.
        argument: String,
        /// The chatter's level.
        user_level: f64,
    },
    /// `clearChat(channelID, chatter_user_id || modID)` (`:559`).
    ClearChat {
        /// The moderator: the chatter, or the bot.
        moderator_id: String,
    },
    /// `indexCommands.commandList(channelID, identity)` (`:567`).
    CommandList {
        /// The chatter's identity.
        identity: UserIdentity,
    },
    /// `indexCommands.followage(channelID, streamerArgument || chatter_user_login)` (`:575`).
    Followage {
        /// The user.
        login: String,
    },
    /// `indexCommands.title(channelID, streamerArgument, userLevel, parseInt(commandLevel), commandTagMode)` (`:583`).
    Title {
        /// The new title, or `''` to read it.
        argument: String,
        /// The chatter's level.
        user_level: f64,
        /// The command's stored level.
        command_level: f64,
        /// The command uses a tag expression (or an invalid one).
        tag_mode: bool,
    },
    /// `indexCommands.game(…)` (`:591`), as [`BuiltinCall::Title`].
    Game {
        /// The new game, or `''` to read it.
        argument: String,
        /// The chatter's level.
        user_level: f64,
        /// The command's stored level.
        command_level: f64,
        /// The command uses a tag expression (or an invalid one).
        tag_mode: bool,
    },
    /// `indexCommands.addModerator(channelID, streamerArgument)` (`:603`).
    AddModerator {
        /// `@username`.
        target: String,
    },
    /// `indexCommands.removeModerator(channelID, streamerArgument)` (`:615`).
    RemoveModerator {
        /// `@username`.
        target: String,
    },
    /// `indexCommands.createClip(channelID, streamerArgument)` (`:623`).
    CreateClip {
        /// The argument (may be empty).
        argument: String,
    },
    /// `indexCommands.onlyEmotes(channelID, streamerArgument)` (`:631`).
    OnlyEmotes {
        /// The argument (may be empty).
        argument: String,
    },
    /// `indexCommands.vanish(channelID, tags, modID)` (`:639`).
    Vanish {
        /// `tags`.
        tags: LegacyTags,
    },
    /// `indexCommands.duel(channelID, chatter_user_login, isMod, streamerArgument, modID)` (`:647`).
    Duel {
        /// `chatter_user_login`.
        login: String,
        /// `isMod` (see [`LegacyTags::is_mod`]).
        is_mod: bool,
        /// The opponent and options.
        argument: String,
    },
    /// `indexCommands.addVip(channelID, streamerArgument, tags)` (`:659`).
    AddVip {
        /// `@username [duration]`.
        argument: String,
        /// `tags`.
        tags: LegacyTags,
    },
    /// `indexCommands.removeVip(channelID, streamerArgument)` (`:671`).
    RemoveVip {
        /// `@username`.
        target: String,
    },
    /// `indexCommands.poll(action, channelID, argument)` (`:683-707`).
    Poll {
        /// The action.
        action: PollAction,
        /// `Title;Choice1/Choice2;duration` for `CREATE`, `''` otherwise.
        argument: String,
    },
    /// `indexCommands.prediction(action, channelID, argument)` (`:719-748`).
    Prediction {
        /// The action.
        action: PredictionAction,
        /// `Title;Outcome1/Outcome2;duration` for `CREATE`, the outcome number for
        /// `RESOLVED`, `''` otherwise.
        argument: String,
    },
    /// `createTimer(channelID, name, frequency, message)` (`:190`).
    TimerCreate {
        /// The timer's name.
        name: String,
        /// Minutes (`parseTimerFrequencyInput`).
        frequency: f64,
        /// The message.
        message: String,
    },
    /// `editTimer(channelID, name, frequency, message)` (`:209`).
    TimerEdit {
        /// The timer's name.
        name: String,
        /// New minutes, when given.
        frequency: Option<f64>,
        /// New message, when given.
        message: Option<String>,
    },
    /// `deleteTimer(channelID, name)` (`:225`).
    TimerDelete {
        /// The timer's name.
        name: String,
    },
    /// `listTimers(channelID)` (`:231`).
    TimerList,
}

impl BuiltinCall {
    /// The reference's function, for logs and the stand-in's error.
    pub fn function(&self) -> &'static str {
        match self {
            Self::Sumimetro { .. } => "sumimetro",
            Self::Promo { .. } => "promo",
            Self::Shoutout { .. } => "handleShoutoutCommand",
            Self::Announcement { .. } => "sendAnnouncement",
            Self::Ruletarusa { .. } => "ruletarusa",
            Self::Amor { .. } => "amor",
            Self::DisableCommand { .. } => "disableCommand",
            Self::EnableCommand { .. } => "enableCommand",
            Self::CreateCommand { .. } => "createCommand",
            Self::DeleteCommand { .. } => "deleteCommand",
            Self::EditCommand { .. } => "editCommand",
            Self::ClearChat { .. } => "clearChat",
            Self::CommandList { .. } => "commandList",
            Self::Followage { .. } => "followage",
            Self::Title { .. } => "title",
            Self::Game { .. } => "game",
            Self::AddModerator { .. } => "addModerator",
            Self::RemoveModerator { .. } => "removeModerator",
            Self::CreateClip { .. } => "createClip",
            Self::OnlyEmotes { .. } => "onlyEmotes",
            Self::Vanish { .. } => "vanish",
            Self::Duel { .. } => "duel",
            Self::AddVip { .. } => "addVip",
            Self::RemoveVip { .. } => "removeVip",
            Self::Poll { .. } => "poll",
            Self::Prediction { .. } => "prediction",
            Self::TimerCreate { .. } => "createTimer",
            Self::TimerEdit { .. } => "editTimer",
            Self::TimerDelete { .. } => "deleteTimer",
            Self::TimerList => "listTimers",
        }
    }
}

/// What a built-in answered (`{error, message}`); the handler maps it to the reply as each
/// branch of the reference does.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct BuiltinReply {
    /// `error`.
    pub error: bool,
    /// `message` (`None` when absent or empty, which the handler's `||` fallbacks treat alike).
    pub message: Option<String>,
}

/// A built-in that threw: the handler's `catch` (`:768`) marks the command failed, records its
/// activity as an error, and the message ends as a handler failure (no tracking, no cooldown,
/// no reply).
#[derive(Clone, Debug, PartialEq, Eq, thiserror::Error)]
#[error("{0}")]
pub struct BuiltinError(pub String);

/// The built-in chat commands and the timer manager (P4-CHAT-CMDS-A/B, P4-FEAT-TIMERS). Each
/// call must bound its own time; its chat output is the reply the handler delivers (a built-in
/// that posts on its own, as `!so` does, answers an empty success).
pub trait BuiltinCommands: Send + Sync {
    /// Runs `call` in `channel_id`.
    fn run<'a>(
        &'a self,
        channel_id: &'a str,
        call: BuiltinCall,
    ) -> BoxFuture<'a, Result<BuiltinReply, BuiltinError>>;
}

/// No built-in is ported yet: every call fails as a thrown error would (logged, no reply).
#[derive(Clone, Copy, Debug, Default)]
pub struct BuiltinsNotPorted;

impl BuiltinCommands for BuiltinsNotPorted {
    fn run<'a>(
        &'a self,
        _: &'a str,
        call: BuiltinCall,
    ) -> BoxFuture<'a, Result<BuiltinReply, BuiltinError>> {
        Box::pin(async move {
            Err(BuiltinError(format!(
                "the built-in {} is not ported yet",
                call.function()
            )))
        })
    }
}

// ---------------------------------------------------------------------------------------------
// The widget feed, the site counter, product events

/// `publishWidgetChatEvent(channel, 'chat', event)`: fire and forget (P4-FEAT-WIDGETS). Must not
/// block: queue or drop with a count.
pub trait WidgetChatFeed: Send + Sync {
    /// Publishes a chat message (`broadcaster_user_id ?? ''`) to the channel's widgets.
    fn publish_chat(&self, channel_id: &str, event: &serde_json::Value);
}

/// No widget feed (until P4-FEAT-WIDGETS).
#[derive(Clone, Copy, Debug, Default)]
pub struct NoWidgetFeed;

impl WidgetChatFeed for NoWidgetFeed {
    fn publish_chat(&self, _: &str, _: &serde_json::Value) {}
}

/// `incrementSiteAnalytics(filter, value)`.
pub trait SiteCounters: Send + Sync {
    /// Adds `value` to the site counter `filter`.
    fn increment<'a>(
        &'a self,
        filter: &'static str,
        value: i64,
    ) -> BoxFuture<'a, Result<(), String>>;
}

impl SiteCounters for dima_stream::site_analytics::SiteAnalytics {
    fn increment<'a>(
        &'a self,
        filter: &'static str,
        value: i64,
    ) -> BoxFuture<'a, Result<(), String>> {
        Box::pin(async move {
            self.increment_site_analytics(filter, value)
                .await
                .map_err(|error| error.to_string())
        })
    }
}

/// `trackCommand(params)`.
pub trait CommandTracker: Send + Sync {
    /// Queues a `command_executed` product event.
    fn track_command(&self, event: &CommandEvent);
}

impl CommandTracker for ProductEvents {
    fn track_command(&self, event: &CommandEvent) {
        ProductEvents::track_command(self, event);
    }
}
