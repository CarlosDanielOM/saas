//! Sending chat messages: the seam that breaks the reference's renderer cycle.
//!
//! In the reference, `sendTwitchChatMessage(channelID, message, replyToMessageId, context)`
//! (`functions/chats/send_message.chat.ts`) does two different things. Without a `context` it
//! posts the text to Helix `POST /chat/messages`. With one it first renders the text as command
//! language (`parseSpecialCommands`, which runs the whole engine and its host), posts what the
//! rendering produced, then runs the command references the rendering asked for
//! (`deliverAstMessage`, which calls back into the command handler). The second half is why
//! sixty-one files import each other in a ring (`ledger/upper-layers.md` section 2.1).
//!
//! Here the two halves live in different crates:
//!
//! - the **plain send** (Helix, the app token, the 450 splitter, replies) is [`send`] in this
//!   crate and evaluates nothing (package P4-TW-CHAT);
//! - **rendering then sending** is the trait [`ChatOut`], declared here so that every crate from
//!   this layer up can name it, and implemented by `dima_actions::delivery::ChatDelivery` above
//!   the engine (package P4-ACT-CORE). A feature that posts templated chat takes an
//!   `Arc<dyn ChatOut>` and never sees the engine.
//!
//! [`RenderScope`] is what a caller says about its message (the channel, the reply target, and,
//! when the text is to be rendered, the [`Rendering`] context: the event it answers, the
//! variables, the plan and level, the scope, the effect authority). [`Sent`] and [`ChatError`]
//! are the reference's result object, typed: every field a caller of the reference reads has a
//! place in them (the callers are listed on [`ChatOut`]).
//!
//! This crate sits below `dima-engine` (layer 4 against 6), so nothing here names an engine
//! type: event data and variables are JSON, the plan is [`PlanTier`], and effect authority is a
//! description ([`EffectGrant`]) that the implementer turns into the engine's `Effect`.

pub mod send;

use dima_http::guard::BoxFuture;
use dima_model::users::PlanTier;
use serde_json::{Map, Value};

/// What a caller says about one message it sends: where it goes, which message it replies to,
/// and whether its text is command language to render first.
///
/// The reference passes `channelID` twice (the first argument and `context.channelID`); every
/// caller passes the same value, so there is one [`RenderScope::channel_id`].
#[derive(Clone, Debug, PartialEq)]
pub struct RenderScope {
    /// The broadcaster whose chat receives the message (Helix `broadcaster_id`), and the channel
    /// the text is rendered for.
    pub channel_id: String,
    /// `replyToMessageId`: Helix `reply_parent_message_id`. `None`: not a reply.
    pub reply_to: Option<String>,
    /// `Some`: the text is command language, rendered with this context before it is posted
    /// (the reference's call with a `context`). `None`: the text is posted as it is (the
    /// reference's call without one); nothing is evaluated.
    pub render: Option<Rendering>,
}

impl RenderScope {
    /// A message posted as it is (`sendTwitchChatMessage(channel, text)`).
    pub fn plain(channel_id: impl Into<String>) -> Self {
        Self {
            channel_id: channel_id.into(),
            reply_to: None,
            render: None,
        }
    }

    /// A message rendered with `rendering` first (`sendTwitchChatMessage(channel, text, null,
    /// context)`).
    pub fn rendered(channel_id: impl Into<String>, rendering: Rendering) -> Self {
        Self {
            channel_id: channel_id.into(),
            reply_to: None,
            render: Some(rendering),
        }
    }

    /// The same message as a reply to the chat message `message_id`.
    #[must_use]
    pub fn replying_to(mut self, message_id: impl Into<String>) -> Self {
        self.reply_to = Some(message_id.into());
        self
    }

    /// Whether the text is rendered before it is posted.
    pub fn renders(&self) -> bool {
        self.render.is_some()
    }
}

/// The context command language is rendered with: the reference's `SendMessageContext` and
/// `ISpecialParserContext` (`handlers/special_parser.handler.ts:14`), less the two fields only
/// the command handler sets (`commandReferenceState`, `count`), which never cross this seam.
///
/// `Rendering::default()` is the context `{ channelID }` alone, which is what follow defense
/// passes (`utils/follow_defense_actions.ts:179`, `utils/follow_defense_summary.ts:75`).
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Rendering {
    /// `eventData`: the Twitch event the message answers (a chat message, a follow, a cheer, a
    /// raid), as the event's JSON object. The user the message answers is read from it the way
    /// the reference's `extractUserInfo` does (`chatter_user_id`, `user_id`, … and their login
    /// and name fields); a caller with no Twitch event that still answers someone writes the
    /// `chatter_user_*` fields itself, as the roulette winner action does
    /// (`roulette/actions.ts:31`). Empty: the reference's `{}`.
    pub event_data: Map<String, Value>,
    /// `eventsubData`: the stored EventSub configuration the text came from (its `name` is the
    /// scope name when none is given). Empty: the reference's `{}`.
    pub eventsub_data: Map<String, Value>,
    /// `argument`: the text after a command's name, for `$(1)`-style placeholders.
    pub argument: Option<String>,
    /// `literalArguments`: keep argument text literal, also inside functions.
    pub literal_arguments: bool,
    /// `variables`: extra `$(name)` values, in the order the reference's object lists them.
    pub variables: Vec<(String, String)>,
    /// `userPlan`. `None`: the channel's own plan, else `free`.
    pub user_plan: Option<PlanTier>,
    /// `userLevel`. `None`: resolved from the event data (`resolveAuthoredAstUserLevel`).
    pub user_level: Option<f64>,
    /// `extraContext`, merged over the fields extracted from `event_data`.
    pub extra_context: Map<String, Value>,
    /// `scopeType`. `None`: `command`.
    pub scope_type: Option<String>,
    /// `scopeName`. `None`: the EventSub configuration's `name`, else the reward title of the
    /// event data, else empty.
    pub scope_name: Option<String>,
    /// `scopeAliases`.
    pub scope_aliases: Vec<String>,
    /// `effectContext`: live effect authority for the functions the text runs (goal
    /// contributions, pet actions, widget signals). `None`: the rendering has none, which is
    /// what every caller but the durable chat announcements passes.
    pub effect: Option<EffectGrant>,
}

/// The effect authority of a verified Twitch event, as the durable chat-announcement consumer
/// mints it (`domain_events/chat_announcement_events.ts:251`):
/// `scopeAstEffectContext(createTwitchEffectContext({ channelId, origin: { kind: 'twitch-event',
/// id, occurredAt }, actor }), channelId, scope)`.
///
/// It is a description, not the authority itself: the implementer of [`ChatOut`] checks it
/// exactly as `createTwitchEffectContext` checks its input (a numeric channel id of at most 30
/// digits, an origin id of 1 to 200 characters, a parsable time, an actor id of 1 to 100
/// characters, a display name of at most 100) and renders with no authority when a check fails,
/// as the reference does. Only verified EventSub ingress and the gated durable event consumer
/// build one; the chat-command authority of a chat message is minted by the message handler
/// above `dima-actions` and never crosses this seam.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct EffectGrant {
    /// `origin.id`: the domain event's key.
    pub origin_id: String,
    /// `origin.occurredAt`: when the event happened, ISO 8601.
    pub occurred_at: String,
    /// `actor.userId`: who acted (the channel itself for anonymous and system events).
    pub actor_id: String,
    /// `actor.displayName`.
    pub actor_name: String,
    /// The stored configuration the effects run under (`eventsub:<config id>:<event type>`).
    pub scope: String,
}

/// A send that did not fail: the reference's `{ error: false, … }`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Sent {
    /// Twitch took the message (`message: 'Message sent'`, `type: 'success'`): the id Twitch
    /// gave it (`data[0].message_id`), which the credit-gift announcement stores and
    /// `$(pin.create)` pins.
    Posted {
        /// `data[0].message_id`.
        message_id: Option<String>,
    },
    /// Nothing was left to post: the text (rendered, when it was) was empty or blank. The
    /// command references the rendering produced still ran. The reference answers `{ error:
    /// false, message: 'AST message delivered', status: 200, type: 'success' }`.
    Nothing,
}

/// Why a send failed: the reference's `{ error: true, … }` answers, plus the two errors it
/// throws instead of answering.
///
/// [`ChatError::message`] and [`ChatError::kind`] are the reference's `message` and `type`
/// fields, which callers log, report or compare (`type === 'held_for_moderation'`).
#[derive(Clone, Debug, PartialEq, Eq, thiserror::Error)]
pub enum ChatError {
    /// Twitch answered outside 2xx: `{ message: data.message, status, type: data.error }`.
    #[error("Twitch refused the chat message ({status})")]
    Rejected {
        /// The HTTP status.
        status: u16,
        /// `data.error`, when Twitch sent one.
        kind: Option<String>,
        /// `data.message`, when Twitch sent one.
        message: Option<String>,
    },
    /// Twitch held the message for moderator review (`is_sent: false`): `type:
    /// 'held_for_moderation'`. The credit-gift announcement stops retrying on it.
    #[error("Message held for moderation review by Twitch")]
    HeldForModeration {
        /// The HTTP status (a 2xx).
        status: u16,
        /// `data[0].message_id`.
        message_id: Option<String>,
    },
    /// No app token could be had: `500 'Failed to get Twitch app token'`.
    #[error("Failed to get Twitch app token")]
    NoAppToken,
    /// Anything else failed on the way (the request, an unreadable answer): `500 'Error
    /// sending Twitch chat message'`, with the cause as `reason` (logged, never shown in chat).
    /// In the empty-text branch the reference passes on the result of a command reference's own
    /// failed send with `type: 'error'`; the implementer maps that to this variant or to
    /// [`ChatError::Rejected`] with `kind` `error`, as the recording shows.
    #[error("Error sending Twitch chat message")]
    Failed {
        /// The cause (`err.message`).
        reason: String,
    },
    /// Rendering stopped on a required goal contribution of a durable EventSub action that could
    /// not be journaled (`RequiredGoalContributionError`,
    /// `utils/ast_parser/functions/goals.functions.ts:52`). The reference rethrows it out of the
    /// send instead of answering, so that the domain event is retried; a caller passes it on (a
    /// domain-event handler fails its delivery with it). Nothing was posted.
    #[error("Required goal contribution could not be journaled")]
    RequiredGoalContribution,
    /// [`ChatOut::deliver`] only: rendering failed (the reference's `parseSpecialCommands`
    /// threw, and the goal and roulette actions let it through). Nothing was posted. The send
    /// path never answers this: it logs the failure and posts the text unrendered.
    #[error("rendering failed: {reason}")]
    Render {
        /// What failed (no secrets).
        reason: String,
    },
}

impl ChatError {
    /// The reference's `message` field: what a caller logs or reports (`chat.send:
    /// ${result.message}`, `report(…, response.message)`). For the two thrown errors, the
    /// error's own message.
    pub fn message(&self) -> Option<&str> {
        match self {
            Self::Rejected { message, .. } => message.as_deref(),
            Self::HeldForModeration { .. } => Some("Message held for moderation review by Twitch"),
            Self::NoAppToken => Some("Failed to get Twitch app token"),
            Self::Failed { .. } => Some("Error sending Twitch chat message"),
            Self::RequiredGoalContribution => {
                Some("Required goal contribution could not be journaled")
            }
            Self::Render { reason } => Some(reason),
        }
    }

    /// The reference's `type` field. `None` where Twitch sent no `error`, and for the two errors
    /// the reference throws rather than answers.
    pub fn kind(&self) -> Option<&str> {
        match self {
            Self::Rejected { kind, .. } => kind.as_deref(),
            Self::HeldForModeration { .. } => Some("held_for_moderation"),
            Self::NoAppToken | Self::Failed { .. } => Some("error"),
            Self::RequiredGoalContribution | Self::Render { .. } => None,
        }
    }

    /// The reference's `status` field. `None` for the two errors it throws.
    pub fn status(&self) -> Option<u16> {
        match self {
            Self::Rejected { status, .. } | Self::HeldForModeration { status, .. } => Some(*status),
            Self::NoAppToken | Self::Failed { .. } => Some(500),
            Self::RequiredGoalContribution | Self::Render { .. } => None,
        }
    }

    /// Whether the reference throws this error out of the send instead of answering with it:
    /// a caller must pass it on, not treat it as a failed post.
    pub fn is_thrown(&self) -> bool {
        matches!(self, Self::RequiredGoalContribution | Self::Render { .. })
    }
}

/// Posting chat that may contain command language: rendered, posted, and the command references
/// the rendering produced run, in the reference's order (the outer text first, then each
/// reference in authored order, each reference's own text posted before the next one runs).
///
/// Implemented by `dima_actions::delivery::ChatDelivery` (package P4-ACT-CORE), which owns the
/// engine, the host and the command runner; called by every feature that posts chat. A test of a
/// feature uses a fake that records what it was asked to send.
///
/// # The reference's callers, and which method each one uses
///
/// `send` is `sendTwitchChatMessage`; *render* marks a call with a `context`
/// ([`RenderScope::rendered`]), *plain* one without ([`RenderScope::plain`]). The package that
/// ports the caller is in brackets. Line numbers are at the baseline commit `0c71108e`.
///
/// Through [`ChatOut::send`], rendered:
///
/// - `handlers/ad_break.handler.ts:32` and `:43`, `ban.handler.ts:46`, `follow.handler.ts:70`
///   (variables `user`, `userLogin`, `count`), `stream_offline.handler.ts:37`,
///   `stream_online.handler.ts:66`, `redemption.handler.ts:113` and `:181`,
///   `eventsub.handler.ts:84` (an outgoing raid: the event data is rewritten first), `:213` and
///   `:228` [P4-CHAT-EVENTS]; `cheer.handler.ts:86` reads `error` and `message` [P4-CHAT-EVENTS].
/// - `domain_events/chat_announcement_events.ts:259` through its `sendMessage` dependency
///   (`:133`): event data, the EventSub configuration, an argument with literal arguments,
///   variables and an [`EffectGrant`]; reads `error`, `message` and `type`, and lets
///   [`ChatError::RequiredGoalContribution`] through [P4-EVH].
/// - `utils/follow_defense_actions.ts:179` and `utils/follow_defense_summary.ts:75`: the context
///   `{ channelID }` alone, so `Rendering::default()` [P4-FEAT-DEFENSE-B, P4-FEAT-DEFENSE-A].
///
/// Through [`ChatOut::send`], plain:
///
/// - `duel/completion.ts:80` and `:88`: reads `error` and `message` [P4-FEAT-GAMES].
/// - `utils/temporary_roles_announcements.ts:67` and `:78`: reads `error` and `message`
///   [P4-CRON-FEATURES].
/// - `utils/credit_gifts.ts:260`: reads `error`, `type === 'held_for_moderation'` and
///   `data.message_id` [P2-BILLING-02b].
/// - `functions/moderation/execute_action.moderation.ts:48`: the `@user reason` notice, result
///   ignored [P4-MOD-RUN].
/// - `domain_events/chat_announcement_events.ts:307`: the account-health notice; reads `error`,
///   `message`, `type` [P4-EVH].
/// - `handlers/message.handler.ts:168` and `:256` (timer management answers), `:335` (each chunk
///   of an AI reply, as a reply to the chat message: [`RenderScope::replying_to`])
///   [P4-CHAT-MESSAGE]; `handlers/stream_online.handler.ts:107` [P4-CHAT-EVENTS];
///   `commands/shoutout.command.ts:113` [P4-CHAT-CMDS-B]; `server/routes/admin_site.route.ts:969`
///   [P4-API-ADMIN-SITE].
/// - Host functions: `utils/ast_parser/functions/channel.functions.ts:52`, `:65`, `:89`, `:115`,
///   `chat.functions.ts:12` (reads `message`), `pin.functions.ts:73` (reads `message` and
///   `data.message_id`) [P4-ACT-CHANNEL]. These run inside `dima-actions` and may call the plain
///   send of [`send`] directly instead.
/// - `utils/ast_command_delivery.ts:13`: the delivery's own post [P4-ACT-CORE].
///
/// Through [`ChatOut::deliver`] (`parseSpecialCommands` then `deliverAstMessage`):
///
/// - `goals/completion.ts:11-14`: plain for a message action, rendered for a command-language
///   action (scope `goal`, the goal's id, the channel's plan, level 10, literal arguments); a
///   failure fails the action [P4-FEAT-GOALS].
/// - `roulette/actions.ts:28-34`: rendered (scope `roulette`, the actor as event data, the
///   draw's variables); a failure fails the action [P4-FEAT-GAMES].
/// - `workers/timer.worker.ts:141-152` with `renderTimerMessage` (`utils/timer_runtime.ts`)
///   [P4-CRON-FEATURES, P4-FEAT-TIMERS].
///
/// Callers above `dima-actions` that deliver a command's own result (`handlers/keywords.handler.ts:22`,
/// `raid.handler.ts:105`, `redemption.handler.ts:128`, `:136`, `:196`, `:204`, `:274`,
/// `message.handler.ts:819`) and the engine's own users (`utils/ast_timer_runtime.ts:169`,
/// `utils/ai/tools/ast_parser.tool.ts:158`) use `ChatDelivery` directly: they hand over command
/// references that are already evaluated, which this trait does not carry.
///
/// Not ported: `handlers/cheers.handler.ts:16` (unreachable) and
/// `utils/ai/tools/code_execution.tool.ts:24` (the tool is dropped).
pub trait ChatOut: Send + Sync {
    /// `sendTwitchChatMessage(scope.channel_id, text, scope.reply_to, context)`: renders `text`
    /// when [`RenderScope::render`] is set, posts the result (unless it is blank: then
    /// [`Sent::Nothing`]), then runs the command references the rendering produced.
    ///
    /// As in the reference, a rendering failure other than
    /// [`ChatError::RequiredGoalContribution`] is logged and the text is posted unrendered; a
    /// blank text is never posted; the text is posted as rendered, not trimmed.
    fn send<'a>(
        &'a self,
        scope: &'a RenderScope,
        text: &'a str,
    ) -> BoxFuture<'a, Result<Sent, ChatError>>;

    /// `deliverAstMessage(channel_id, render ? parseSpecialCommands(text, render) : { parsedText:
    /// text })`: renders `text` when `render` is given, posts the result trimmed unless it is
    /// empty, then runs the command references. A rendering failure is
    /// [`ChatError::Render`] and nothing is posted; a failed post stops the delivery. Never a
    /// reply.
    fn deliver<'a>(
        &'a self,
        channel_id: &'a str,
        render: Option<&'a Rendering>,
        text: &'a str,
    ) -> BoxFuture<'a, Result<(), ChatError>>;
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Mutex};

    #[test]
    fn errors_carry_the_reference_fields() {
        let rejected = ChatError::Rejected {
            status: 403,
            kind: Some("Forbidden".into()),
            message: Some("The sender must be a moderator".into()),
        };
        assert_eq!(rejected.status(), Some(403));
        assert_eq!(rejected.kind(), Some("Forbidden"));
        assert_eq!(rejected.message(), Some("The sender must be a moderator"));
        let bare = ChatError::Rejected {
            status: 500,
            kind: None,
            message: None,
        };
        assert_eq!((bare.kind(), bare.message()), (None, None));

        let held = ChatError::HeldForModeration {
            status: 200,
            message_id: Some("m-1".into()),
        };
        assert_eq!(held.kind(), Some("held_for_moderation"));
        assert_eq!(
            held.message(),
            Some("Message held for moderation review by Twitch")
        );
        assert_eq!(held.status(), Some(200));

        assert_eq!(
            (
                ChatError::NoAppToken.status(),
                ChatError::NoAppToken.kind(),
                ChatError::NoAppToken.message()
            ),
            (
                Some(500),
                Some("error"),
                Some("Failed to get Twitch app token")
            )
        );
        let failed = ChatError::Failed {
            reason: "connection reset".into(),
        };
        assert_eq!(
            (failed.status(), failed.kind(), failed.message()),
            (
                Some(500),
                Some("error"),
                Some("Error sending Twitch chat message")
            )
        );

        for thrown in [
            ChatError::RequiredGoalContribution,
            ChatError::Render { reason: "x".into() },
        ] {
            assert!(thrown.is_thrown());
            assert_eq!((thrown.status(), thrown.kind()), (None, None));
        }
        assert!(!failed.is_thrown());
        assert_eq!(
            ChatError::RequiredGoalContribution.message(),
            Some("Required goal contribution could not be journaled")
        );
    }

    #[test]
    fn scopes() {
        let plain = RenderScope::plain("1001");
        assert!(!plain.renders());
        assert_eq!(plain.reply_to, None);
        let reply = RenderScope::plain("1001").replying_to("msg-9");
        assert_eq!(reply.reply_to.as_deref(), Some("msg-9"));
        let rendered = RenderScope::rendered("1001", Rendering::default());
        assert!(rendered.renders());
        assert_eq!(rendered.render, Some(Rendering::default()));
    }

    /// The trait is object-safe and usable behind `Arc<dyn ChatOut>`, as features hold it.
    #[tokio::test]
    async fn a_feature_can_hold_and_call_it() {
        #[derive(Default)]
        struct Recorder(Mutex<Vec<(String, bool, String)>>);
        impl ChatOut for Recorder {
            fn send<'a>(
                &'a self,
                scope: &'a RenderScope,
                text: &'a str,
            ) -> BoxFuture<'a, Result<Sent, ChatError>> {
                Box::pin(async move {
                    if let Ok(mut log) = self.0.lock() {
                        log.push((scope.channel_id.clone(), scope.renders(), text.to_owned()));
                    }
                    Ok(Sent::Posted { message_id: None })
                })
            }
            fn deliver<'a>(
                &'a self,
                channel_id: &'a str,
                render: Option<&'a Rendering>,
                text: &'a str,
            ) -> BoxFuture<'a, Result<(), ChatError>> {
                Box::pin(async move {
                    if let Ok(mut log) = self.0.lock() {
                        log.push((channel_id.to_owned(), render.is_some(), text.to_owned()));
                    }
                    Ok(())
                })
            }
        }
        let recorder = Arc::new(Recorder::default());
        let chat: Arc<dyn ChatOut> = recorder.clone();
        let sent = chat
            .send(&RenderScope::plain("1001"), "¡Hola 👋 مرحبا!")
            .await;
        assert_eq!(sent, Ok(Sent::Posted { message_id: None }));
        chat.deliver("1001", Some(&Rendering::default()), "$(user)")
            .await
            .unwrap();
        let log = recorder.0.lock().unwrap().clone();
        assert_eq!(
            log,
            [
                ("1001".to_owned(), false, "¡Hola 👋 مرحبا!".to_owned()),
                ("1001".to_owned(), true, "$(user)".to_owned())
            ]
        );
    }
}
