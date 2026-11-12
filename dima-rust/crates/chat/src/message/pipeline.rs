//! Steps 1 to 30 of the module documentation, in order.

use super::builtins::{self, Route};
use super::event::ChatEvent;
use super::limits::Dropped;
use super::seams::{BuiltinReply, ModerationInput, ModerationVerdict};
use super::{Inner, ai, keywords, timers};
use crate::ingress::{ChatEffectInput, HandlerError, Notification};
use bson::{Bson, doc};
use dima_actions::delivery::AstMessage;
use dima_actions::host::effects::{self, ChatActor, EffectInput, EffectOrigin, OriginKind};
use dima_actions::product_events::CommandEvent;
use dima_actions::runner::{
    CommandError, CommandOutcome, CommandRequest, ExecutionAuthorization, ExecutionOrigin,
};
use dima_ai::qdrant::{QueuedChatMessage, store_chat_message_embedding_batched};
use dima_commands::cooldown::chat_cooldown_ms;
use dima_commands::permissions::{
    CompiledPermission, PermissionMode, UserIdentity, resolve_user_identity,
};
use dima_commands::runtime::channel_cache::DragonflyRoleCache;
use dima_commands::runtime::chat_history::{HistoryEntry, Platform, add_message};
use dima_engine::context::{CommandReference, Effect};
use dima_events::value::Value as EventValue;
use dima_stream::stream_activity::{ActivityKind, Capture};
use dima_stream::stream_sessions::{ChatMessage, CountEvent, MessageEvent};
use dima_telemetry::{Level, LogOptions};
use dima_twitch::TWITCH_BOT_ACCOUNT_ID;
use dima_twitch::badges::format_badges;
use dima_twitch::chat::RenderScope;
use dima_twitch::streamers::StreamerAccount;
use serde_json::{Value, json};
use std::sync::LazyLock;

/// `commandsRegex`: `^!([\p{L}\p{N}]+)(?:\W@?)?(.*)?$` with the `u` flag. JavaScript's `\W` is
/// ASCII (`[^0-9A-Za-z_]`) and its `.` excludes the four line terminators.
static COMMAND: LazyLock<Option<regex::Regex>> = LazyLock::new(|| {
    regex::Regex::new(r"^!([\p{L}\p{N}]+)(?:[^0-9A-Za-z_]@?)?([^\n\r\u{2028}\u{2029}]*)$").ok()
});

/// `MODERATOR_BADGE_IDS` of the handler (`message.handler.ts:19`).
const MODERATOR_BADGES: [&str; 2] = ["moderator", "lead_moderator"];

/// `commandsRegex` on the text: the command and the raw argument (`None` where the
/// reference's optional group is `undefined`: absent or empty).
pub(super) fn parse_command(text: &str) -> Option<(String, Option<String>)> {
    let captures = COMMAND.as_ref()?.captures(text)?;
    let command = captures.get(1)?.as_str().to_owned();
    let argument = captures
        .get(2)
        .map(|m| m.as_str())
        .filter(|argument| !argument.is_empty())
        .map(str::to_owned);
    Some((command, argument))
}

/// A failure that ends the message as the reference's outer `catch` does.
pub(super) type Failure = String;

impl Inner {
    pub(super) fn log(&self, level: Level, data: &Value, channel_id: &str, console_only: bool) {
        if let Some(telemetry) = &self.deps.delivery.host().telemetry {
            let options = if console_only {
                LogOptions::console().channel(channel_id)
            } else {
                LogOptions::new().channel(channel_id)
            };
            telemetry.log(level, data, options);
        }
    }

    pub(super) fn count(&self, name: &'static str) {
        if let Some(telemetry) = &self.deps.delivery.host().telemetry {
            telemetry.count("chat_message", name);
        }
    }

    pub(super) fn stores(&self) -> &dima_commands::runtime::Stores {
        self.deps.delivery.host().commands.stores()
    }
}

/// `isForeignSharedChatEvent` for a chat message.
fn is_foreign_shared_chat(event: &Value) -> bool {
    match event
        .get("source_broadcaster_user_id")
        .and_then(Value::as_str)
    {
        Some(source) => {
            !source.is_empty()
                && Some(source) != event.get("broadcaster_user_id").and_then(Value::as_str)
        }
        None => false,
    }
}

/// Steps 1 to 6, then the message.
pub(super) async fn entry(inner: &Inner, notification: Notification) -> Result<(), HandlerError> {
    let Notification {
        event,
        options,
        subscription,
        ..
    } = notification;
    let json = event.to_json().unwrap_or(Value::Null);
    let broadcaster = json
        .get("broadcaster_user_id")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned();
    // 1-2. The widget feed sees every chat message; a shared-chat copy stops there.
    inner.deps.feed.publish_chat(&broadcaster, &json);
    if is_foreign_shared_chat(&json) {
        return Ok(());
    }
    // 3. The bot's own message.
    if json.get("chatter_user_id").and_then(Value::as_str) == Some(TWITCH_BOT_ACCOUNT_ID) {
        return Ok(());
    }
    let to_broadcaster = json
        .get("to_broadcaster_user_id")
        .and_then(Value::as_str)
        .map(str::to_owned);
    let message = match ChatEvent::from_json(json) {
        Ok(message) => message,
        Err(error) => {
            inner.count("invalid");
            inner.log(
                Level::Warn,
                &json!({"function": "messageHandler", "channelID": broadcaster, "error": error.to_string()}),
                &broadcaster,
                true,
            );
            return Ok(());
        }
    };
    // 4. A place, or the message is dropped.
    let place = match inner.admission.admit(&broadcaster).await {
        Ok(place) => place,
        Err(reason) => {
            inner.count_dropped(reason);
            return Ok(());
        }
    };
    let work = preamble(
        inner,
        message,
        to_broadcaster,
        options.chat_effect,
        &subscription,
    );
    let outcome = match tokio::time::timeout(inner.config.message_deadline, work).await {
        Ok(outcome) => outcome,
        Err(_) => {
            inner.admission.count_dropped(Dropped::TimedOut);
            inner.count_dropped_name(Dropped::TimedOut);
            inner.log(
                Level::Warn,
                &json!({"function": "messageHandler", "channelID": broadcaster,
                    "error": "the message passed its deadline and was stopped"}),
                &broadcaster,
                true,
            );
            Ok(())
        }
    };
    drop(place);
    outcome
}

impl Inner {
    fn count_dropped(&self, reason: Dropped) {
        self.count_dropped_name(reason);
    }

    fn count_dropped_name(&self, reason: Dropped) {
        if let Some(telemetry) = &self.deps.delivery.host().telemetry {
            telemetry.count("chat_message.dropped", reason.name());
        }
    }
}

/// Steps 5 and 6, then the message handler.
async fn preamble(
    inner: &Inner,
    message: ChatEvent,
    to_broadcaster: Option<String>,
    chat_effect: Option<ChatEffectInput>,
    subscription: &dima_events::value::Object,
) -> Result<(), HandlerError> {
    let twitch = &inner.deps.delivery.host().twitch;
    let mut streamer = streamer(twitch, message.broadcaster_user_id.as_deref()).await;
    if streamer.is_none() {
        streamer = self::streamer(twitch, to_broadcaster.as_deref()).await;
    }
    let Some(streamer) = streamer else {
        return Ok(());
    };
    if !subscription_enabled(inner, streamer.id(), subscription)
        .await
        .map_err(HandlerError)?
    {
        return Ok(());
    }
    let effect = chat_effect.and_then(mint_effect);
    message_handler(inner, streamer.id(), &message, effect).await;
    Ok(())
}

async fn streamer(twitch: &dima_twitch::Twitch, id: Option<&str>) -> Option<StreamerAccount> {
    match id {
        Some(id) if !id.is_empty() => twitch.streamer(id).await,
        _ => None,
    }
}

/// Step 6: `EventsubSchema.findOne({channelID, type: 'channel.chat.message'})`, a hydrated
/// document's `enabled` (default `true`; Mongoose's boolean cast for stored text and numbers).
async fn subscription_enabled(
    inner: &Inner,
    channel_id: &str,
    subscription: &dima_events::value::Object,
) -> Result<bool, String> {
    let found = tokio::time::timeout(
        inner.config.store_deadline,
        inner
            .stores()
            .mongo
            .documents(dima_model::eventsubs::COLLECTION)
            .find_one(doc! { "channelID": channel_id, "type": crate::dispatch::CHAT_MESSAGE })
            .projection(doc! { "enabled": 1 }),
    )
    .await
    .map_err(|_| "the chat message subscription did not load in time".to_owned())?
    .map_err(|error| error.to_string())?;
    let Some(document) = found else {
        let condition = subscription
            .get("condition")
            .and_then(EventValue::to_json)
            .unwrap_or(Value::Null);
        inner.log(
            Level::Info,
            &json!({"message": "No data found for eventsub", "type": crate::dispatch::CHAT_MESSAGE,
                "condition": condition}),
            channel_id,
            false,
        );
        return Ok(true);
    };
    Ok(match document.get("enabled") {
        None => true,
        Some(Bson::Boolean(flag)) => *flag,
        Some(Bson::Int32(n)) => *n != 0,
        Some(Bson::Int64(n)) => *n != 0,
        Some(Bson::Double(n)) => *n != 0.0 && !n.is_nan(),
        Some(Bson::String(text)) => matches!(text.as_str(), "true" | "1" | "yes"),
        Some(_) => false,
    })
}

/// `createTwitchEffectContext` of the verified ingress's input (`eventsub.twitch.ts:233-239`):
/// a field that is not text gives no authority (the reference's `typeof` checks).
fn mint_effect(input: ChatEffectInput) -> Option<Effect> {
    let text = |value: &EventValue| value.as_str().map(str::to_owned);
    let chat = match (&input.badges, text(&input.login), text(&input.message)) {
        (Some(badges), Some(login), Some(message)) => Some(ChatActor {
            login,
            message,
            badges: badges
                .iter()
                .map(|badge| {
                    (
                        badge.set_id.to_js_string(),
                        badge.id.to_js_string(),
                        badge.info.to_js_string(),
                    )
                })
                .collect(),
        }),
        _ => None,
    };
    effects::twitch_effect(EffectInput {
        channel_id: text(&input.channel_id)?,
        origin: EffectOrigin {
            kind: OriginKind::ChatCommand,
            id: text(&input.origin_id)?,
            occurred_at: input.occurred_at,
        },
        actor_id: text(&input.actor_id)?,
        actor_name: text(&input.display_name)?,
        chat,
    })
}

/// Steps 7 to 30 (`messageHandler`).
async fn message_handler(
    inner: &Inner,
    channel_id: &str,
    message: &ChatEvent,
    effect: Option<Effect>,
) {
    let received_at = inner.deps.delivery.host().clock.now_ms();
    let tracker = inner.deps.metrics.start_message_handler();
    match run(inner, channel_id, message, effect.as_ref(), received_at).await {
        Ok(()) => tracker.end(false),
        Err(error) => {
            inner.count("failed");
            inner.log(
                Level::Error,
                &json!({"function": "messageHandler", "channelID": channel_id,
                    "messageID": message.id(), "error": error}),
                channel_id,
                false,
            );
            tracker.end(true);
        }
    }
}

/// What a command answered (`res`).
pub(super) struct Reply {
    pub(super) error: bool,
    pub(super) message: Option<String>,
    pub(super) references: Vec<CommandReference>,
}

impl Reply {
    pub(super) fn text(error: bool, message: impl Into<String>) -> Self {
        Self {
            error,
            message: Some(message.into()),
            references: Vec::new(),
        }
    }
}

/// The chatter as the stream recorders and product events name them.
fn or_unknown(value: &str) -> String {
    if value.is_empty() {
        "unknown".to_owned()
    } else {
        value.to_owned()
    }
}

async fn run(
    inner: &Inner,
    channel_id: &str,
    message: &ChatEvent,
    effect: Option<&Effect>,
    received_at: i64,
) -> Result<(), Failure> {
    let deps = &inner.deps;
    let host = deps.delivery.host();
    // 8. The streamer, again.
    let Some(streamer) = host.twitch.streamer(channel_id).await else {
        return Ok(());
    };
    // 9. The identity.
    let roles = DragonflyRoleCache::new(inner.stores().clone());
    let resolved = resolve_user_identity(channel_id, message.author(), &roles).await;
    if let Some(error) = resolved.cache_error
        && inner
            .permission_errors
            .should_log(&format!("role-cache:{channel_id}"), host.clock.now_ms())
    {
        inner.log(
            Level::Error,
            &json!({"message": "Role cache lookup failed; using Twitch badge permissions",
                "function": "resolveUserIdentity", "channelID": channel_id, "error": error.to_string()}),
            channel_id,
            true,
        );
    }
    let identity = resolved.identity;
    // 10. The chat history.
    let badges = format_badges(&message.badges);
    let entry = HistoryEntry {
        username: message.chatter_name().to_owned(),
        message: message.text.clone(),
        timestamp: received_at,
        message_id: message.message_id.clone(),
        badges: Some(badges.badge_list.clone()),
    };
    match add_message(inner.stores(), Platform::Twitch, channel_id, &entry).await {
        Ok(true) => deps.metrics.record_redis_ops_estimate(2.0),
        Ok(false) => inner.log(
            Level::Warn,
            &json!({"error": "Invalid message data", "channelID": channel_id, "messageID": message.id()}),
            channel_id,
            false,
        ),
        Err(error) => inner.log(
            Level::Error,
            &json!({"function": "ChatHistory.addMessage", "channelID": channel_id, "error": error.to_string()}),
            channel_id,
            false,
        ),
    }
    // 11. Beside the rest: the site counter and the message recorders.
    let side = async {
        let site = async {
            if let Err(error) = deps.site.increment("total_messages", 1).await {
                inner.log(
                    Level::Error,
                    &json!({"message": "Error incrementing site analytics from message handler",
                        "function": "messageHandler.incrementSiteAnalytics", "channelID": channel_id, "error": error}),
                    channel_id,
                    true,
                );
            }
        };
        let recorded = async {
            let event = MessageEvent {
                count: CountEvent {
                    channel_id: channel_id.to_owned(),
                    quantity: None,
                },
                user_id: message.chatter_user_id.clone(),
                received_at: Some(received_at),
                message_id: message.message_id.clone(),
                actor_label: message.chatter_user_name.clone(),
                message: Some(ChatMessage {
                    fragments: message.fragments(),
                }),
            };
            if let Err(error) = deps.sessions.record_stream_message_event(&event).await {
                inner.log(
                    Level::Error,
                    &json!({"message": "Error recording stream message analytics from message handler",
                        "function": "messageHandler.recordStreamMessageEvent", "channelID": channel_id,
                        "error": error.to_string()}),
                    channel_id,
                    true,
                );
            }
        };
        tokio::join!(site, recorded);
    };
    let main = after_history(
        inner,
        channel_id,
        message,
        effect,
        received_at,
        &streamer,
        &identity,
        &badges,
    );
    let ((), outcome) = tokio::join!(side, main);
    outcome
}

#[allow(clippy::too_many_arguments)]
async fn after_history(
    inner: &Inner,
    channel_id: &str,
    message: &ChatEvent,
    effect: Option<&Effect>,
    received_at: i64,
    streamer: &StreamerAccount,
    identity: &UserIdentity,
    badges: &dima_twitch::badges::FormattedBadges,
) -> Result<(), Failure> {
    let deps = &inner.deps;
    let host = deps.delivery.host();
    // 12. Chat memory.
    store_chat_message_embedding_batched(
        &*deps.embeddings,
        &*deps.embedding_observer,
        QueuedChatMessage {
            text: message.text.clone(),
            channel_id: channel_id.to_owned(),
            channel_name: Some(streamer.name().to_owned()),
            username: message.chatter_name().to_owned(),
            user_id: or_unknown(message.chatter_id()),
            timestamp: (host.clock.now_ms() as f64 / 1000.0).floor(),
            language: None,
        },
    );
    // 13. Moderation.
    let verdict = deps
        .moderation
        .moderate(ModerationInput {
            channel_id,
            message,
            identity,
            received_at_ms: received_at,
        })
        .await;
    if verdict == ModerationVerdict::ActionTaken {
        inner.count("moderated");
        return Ok(());
    }
    // 14. Keywords.
    if let Err(error) = keywords::handle(inner, channel_id, message, identity, effect).await {
        inner.log(
            Level::Error,
            &json!({"function": "messageHandler.keywords", "channelID": channel_id,
                "messageID": message.id(), "error": error}),
            channel_id,
            false,
        );
    }
    // 15. The command.
    let is_mod = message
        .badges
        .iter()
        .any(|badge| MODERATOR_BADGES.contains(&badge.set_id.as_str()))
        || message.chatter_id() == channel_id;
    let parsed = parse_command(&message.text);
    let (command, argument) = match &parsed {
        Some((command, argument)) => (command.as_str(), argument.as_deref()),
        None => ("", None),
    };
    let streamer_argument = argument.map(dima_text::trim).unwrap_or_default();
    let command_lower = dima_text::to_lower(command);
    let context = Context {
        inner,
        channel_id,
        message,
        effect,
        received_at,
        streamer,
        identity,
        is_mod,
        command,
        argument,
        streamer_argument,
        command_lower: &command_lower,
    };
    // 16. Timers.
    if let Some(route) = timers::route(&command_lower, streamer_argument) {
        return timers::run(&context, route).await;
    }
    // 17. No command: the AI reply.
    if parsed.is_none() {
        return ai::reply(&context).await;
    }
    command_path(&context, badges).await
}

/// What the command steps read.
pub(super) struct Context<'a> {
    pub(super) inner: &'a Inner,
    pub(super) channel_id: &'a str,
    pub(super) message: &'a ChatEvent,
    pub(super) effect: Option<&'a Effect>,
    pub(super) received_at: i64,
    pub(super) streamer: &'a StreamerAccount,
    pub(super) identity: &'a UserIdentity,
    /// This message's chatter is a moderator or the broadcaster.
    pub(super) is_mod: bool,
    /// The command as typed.
    pub(super) command: &'a str,
    /// The raw argument.
    pub(super) argument: Option<&'a str>,
    /// `argument.trim()`.
    pub(super) streamer_argument: &'a str,
    pub(super) command_lower: &'a str,
}

impl Context<'_> {
    /// The plain post (`sendTwitchChatMessage(channelID, text)`): its failure is the send's own
    /// log.
    pub(super) async fn post(&self, text: &str, reply_to: Option<&str>) -> bool {
        let mut scope = RenderScope::plain(self.channel_id);
        if let Some(id) = reply_to {
            scope = scope.replying_to(id);
        }
        self.inner.deps.delivery.post(&scope, text).await.is_ok()
    }

    /// `void recordStreamCommandEvent({channelID})`.
    pub(super) async fn record_command_event(&self) {
        let event = CountEvent {
            channel_id: self.channel_id.to_owned(),
            quantity: None,
        };
        if let Err(error) = self
            .inner
            .deps
            .sessions
            .record_stream_command_event(&event)
            .await
        {
            self.inner.log(
                Level::Error,
                &json!({"message": "Error recording stream command analytics from message handler",
                    "function": "messageHandler.recordStreamCommandEvent", "channelID": self.channel_id,
                    "command": self.command_lower, "error": error.to_string()}),
                self.channel_id,
                true,
            );
        }
    }

    /// `captureStreamActivity({kind: 'command', …})`.
    pub(super) async fn capture_command(&self, key: &str, label: &str, error: bool) {
        let capture = Capture {
            channel_id: self.channel_id.to_owned(),
            event_id: self.message.id().to_owned(),
            kind: ActivityKind::Command,
            occurred_at: Some(bson::DateTime::from_millis(self.received_at)),
            session: None,
            actor: self.message.chatter_id().to_owned(),
            actor_label: self.message.chatter_name().to_owned(),
            key: key.to_owned(),
            label: label.to_owned(),
            value: None,
            outcome: Some(if error { "error" } else { "ok" }.to_owned()),
            emotes: Vec::new(),
        };
        if let Err(error) = self
            .inner
            .deps
            .activity
            .capture_stream_activity(&capture)
            .await
        {
            self.inner.log(
                Level::Error,
                &json!({"message": "Command tracking failed", "channelID": self.channel_id,
                    "error": error.to_string()}),
                self.channel_id,
                true,
            );
        }
    }

    /// The chat-origin authorization of the chatter.
    pub(super) fn authorization(&self) -> ExecutionAuthorization {
        ExecutionAuthorization {
            origin: ExecutionOrigin::Chat,
            identity: self.identity.clone(),
        }
    }

    /// Runs a stored command as the chat message names it (`executeCustomCommand` with a chat
    /// authorization), waiting for a turn among the evaluations in flight.
    pub(super) async fn execute(
        &self,
        command: &dima_model::commands::Command,
        name: &str,
        argument: Option<String>,
    ) -> Result<CommandOutcome, CommandError> {
        let _turn = self.inner.admission.evaluation().await;
        self.inner
            .deps
            .delivery
            .execute_custom_command(
                command,
                CommandRequest {
                    channel_id: self.channel_id.to_owned(),
                    event_data: self.message.engine_value(),
                    name: name.to_owned(),
                    argument,
                    authorization: Some(self.authorization()),
                    reference: None,
                    effect: self.effect.cloned(),
                },
            )
            .await
    }

    /// `deliverAstMessage(channelID, {parsedText, commandReferences})`: a failed post is the
    /// send's own log.
    pub(super) async fn deliver(&self, text: String, references: Vec<CommandReference>) {
        let _ = self
            .inner
            .deps
            .delivery
            .deliver_message(self.channel_id, AstMessage { text, references }, true)
            .await;
    }
}

/// Steps 18 to 29.
async fn command_path(
    context: &Context<'_>,
    badges: &dima_twitch::badges::FormattedBadges,
) -> Result<(), Failure> {
    let inner = context.inner;
    let deps = &inner.deps;
    let channel_id = context.channel_id;
    // 18. The lookup, by the name as typed.
    let lookup = deps
        .delivery
        .host()
        .commands
        .find(channel_id, context.command)
        .await;
    deps.metrics.record_redis_ops_estimate(1.0);
    let lookup = match lookup {
        Ok(lookup) => lookup,
        Err(error) => {
            inner.log(
                Level::Error,
                &json!({"function": "Commands.getCommandFromDB", "channelID": channel_id,
                    "error": error.to_string()}),
                channel_id,
                false,
            );
            return Ok(());
        }
    };
    if let Some(error) = &lookup.cache_error {
        inner.log(
            Level::Warn,
            &json!({"function": "Commands.getCommandFromDB", "channelID": channel_id,
                "cache": error.to_string()}),
            channel_id,
            false,
        );
    }
    // 19. Not found, or not enabled.
    let Some(command) = lookup.command else {
        return Ok(());
    };
    if command.enabled != Some(true) {
        return Ok(());
    }
    // 20-21. The permission.
    let expression = command.permission_expression.as_ref().map(|e| &e.0);
    let level = command.user_level.map(|level| level.to_bson());
    let permission = CompiledPermission::compile(expression, level.as_ref());
    if permission.mode() == PermissionMode::Invalid {
        let error = permission
            .validation_error()
            .map(ToString::to_string)
            .unwrap_or_default();
        let key = format!("command:{channel_id}:{}:{error}", context.command_lower);
        if inner
            .permission_errors
            .should_log(&key, deps.delivery.host().clock.now_ms())
        {
            inner.log(
                Level::Error,
                &json!({"function": "messageHandler.commandPermission",
                    "message": "Stored permission expression is invalid; command denied until repaired",
                    "channelID": channel_id, "command": context.command, "error": error}),
                channel_id,
                false,
            );
        }
    }
    if !permission.decide(context.identity).allowed {
        return Ok(());
    }
    // 22. This process's cooldown, by the name as typed.
    if inner.cooldowns.has(channel_id, context.command) {
        inner.count("cooldown");
        return Ok(());
    }
    // 23. The built-in or the custom command.
    let tag_mode = permission.mode() != PermissionMode::Level;
    let command_level = command.user_level.map_or(0.0, |level| level.0);
    let outcome = builtins::route(context, &command, command_level, tag_mode, badges);
    let ran: Result<(Option<Reply>, bool), Failure> = match outcome {
        Route::Usage(reply) => Ok((Some(reply), false)),
        Route::Builtin(call, mapping) => match deps.builtins.run(channel_id, call).await {
            Ok(reply) => Ok((mapping.map(reply, context), false)),
            Err(error) => Err(error.0),
        },
        Route::Custom => custom(context, &command).await,
    };
    // 24. The command's activity row, whatever happened.
    let name = command
        .cmd
        .clone()
        .filter(|cmd| !cmd.is_empty())
        .unwrap_or_else(|| context.command_lower.to_owned());
    let failed_or_error = match &ran {
        Ok((reply, failed)) => *failed || reply.as_ref().is_some_and(|reply| reply.error),
        Err(_) => true,
    };
    context
        .capture_command(
            &dima_text::to_lower(&name),
            &format!("!{name}"),
            failed_or_error,
        )
        .await;
    // 25. A thrown built-in or a failed run ends the message here.
    let (reply, _) = ran?;
    // 26. The product event.
    let error = reply.as_ref().is_some_and(|reply| reply.error);
    deps.tracker.track_command(&CommandEvent {
        channel_id: channel_id.to_owned(),
        channel_name: context.streamer.name().to_owned(),
        command: context.command_lower.to_owned(),
        status: if error { "error" } else { "success" },
        user_id: or_unknown(context.message.chatter_id()),
        username: or_unknown(context.message.chatter_name()),
        arguments: (!context.streamer_argument.is_empty())
            .then(|| context.streamer_argument.to_owned()),
        error_message: if error {
            reply.as_ref().and_then(|reply| reply.message.clone())
        } else {
            None
        },
    });
    // 28. This process's cooldown.
    let cooldown = command
        .cooldown
        .map_or(Value::Null, |seconds| json!(seconds.0));
    if let Some(delay) = chat_cooldown_ms(Some(&cooldown)) {
        inner.cooldowns.set(channel_id, context.command, delay);
    }
    // 27 and 29. The session's command count beside the delivery.
    let deliver = async {
        if let Some(reply) = reply {
            context
                .deliver(reply.message.unwrap_or_default(), reply.references)
                .await;
        }
    };
    tokio::join!(context.record_command_event(), deliver);
    Ok(())
}

/// The custom command (`commandHandler` with a chat authorization, `:757-764`; `!so` of a
/// command that is not reserved, `:445-448`): `(reply, refused)`.
pub(super) async fn custom(
    context: &Context<'_>,
    command: &dima_model::commands::Command,
) -> Result<(Option<Reply>, bool), Failure> {
    match context
        .execute(
            command,
            context.command,
            context.argument.map(str::to_owned),
        )
        .await
    {
        Ok(CommandOutcome::Ran(ran)) => Ok((
            Some(Reply {
                error: false,
                message: Some(ran.message),
                references: ran.references,
            }),
            false,
        )),
        Ok(CommandOutcome::Refused(_)) => Ok((None, true)),
        Err(error) => Err(error.to_string()),
    }
}

impl super::builtins::Mapping {
    fn map(&self, reply: BuiltinReply, context: &Context<'_>) -> Option<Reply> {
        builtins::map_reply(self, reply, context.message.chatter_name())
    }
}
