//! The hand-over to the bot's EventSub handlers: what the ingress gives them, and the trait the
//! handler package implements.
//!
//! Two paths leave the ingress:
//!
//! - **Journaled types** (`dima_events::contracts::TWITCH_TYPES`: follows, bits, subscriptions,
//!   raids, stream start and end, chat notifications, polls, predictions, hype trains, goals, ad
//!   breaks) are written to the journal before the answer. Their durable effects are the domain
//!   event consumers' (`dima-event-handlers`, run by the cron through `dima_events::consumer`):
//!   that registration already exists and is not this module's. The inline handler then runs
//!   too, with [`HandlerOptions::durable_chat_handled`] set, so it skips what the consumers do.
//! - **Every other type** (chat messages, redemptions, bans, chat deletions...) is handed only to
//!   the inline handler, after the answer, once per message id ([`super::dedupe`]).
//!
//! The inline handler is [`EventsubHandler`], implemented by P4-CHAT-EVENTS
//! (`handlers/eventsub.handler.ts` and `handlers/revocation.handler.ts`; the chat message
//! branch calls P4-CHAT-MESSAGE). It runs on a task the ingress tracks, after the answer was
//! written; it is at most once (a process that dies while it runs does not run it again), as in
//! the reference. What the handler package must provide is listed on each method.

use dima_events::value::{Object, Value};
use futures_util::future::BoxFuture;

/// `EventsubHandlerOptions`.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct HandlerOptions {
    /// `durableChatHandled`: the notification was journaled, so its chat announcement belongs to
    /// the durable consumer (`Boolean(durableEvent)`).
    pub durable_chat_handled: bool,
    /// `staleRetry`: accepted only as an old retry of a journaled type.
    pub stale_retry: bool,
    /// `durableDefenseHandled`: the journaled event carries `metadata.durableDefenseHandled`
    /// (an incoming raid or a follow from Twitch), so follow defense is the consumer's.
    pub durable_defense_handled: bool,
    /// `chatEffectContext`: the authority of a chat message delivered by the verified ingress,
    /// as the reference extracts it (`channel.chat.message` only).
    pub chat_effect: Option<ChatEffectInput>,
}

/// The input of `createTwitchEffectContext` for a chat message (`eventsub.twitch.ts:233`), with
/// the reference's defaults applied and nothing validated: P4-CHAT-MESSAGE mints the effect from
/// it and applies `createTwitchEffectContext`'s checks (`dima_twitch::chat::EffectGrant` notes
/// that the chat-command authority is minted above `dima-actions`). Only the verified ingress
/// builds one; the API's EventSub test route does not.
#[derive(Clone, Debug, PartialEq)]
pub struct ChatEffectInput {
    /// `channelId: event.broadcaster_user_id`.
    pub channel_id: Value,
    /// `origin.kind`: always `chat-command`.
    pub origin_kind: &'static str,
    /// `origin.id: event.message_id`.
    pub origin_id: Value,
    /// `origin.occurredAt`: the delivery's `Twitch-Eventsub-Message-Timestamp`.
    pub occurred_at: String,
    /// `actor.userId: event.chatter_user_id`.
    pub actor_id: Value,
    /// `actor.displayName: event.chatter_user_name || ''`.
    pub display_name: Value,
    /// `actor.chat.login: event.chatter_user_login || ''`.
    pub login: Value,
    /// `actor.chat.message: event.message?.text || ''`.
    pub message: Value,
    /// `actor.chat.badges`: `(event.badges || []).map(b => ({ set_id: b.set_id || '', id: b.id ||
    /// '', info: b.info || '' }))`. `None` when `badges` is truthy but not an array: the
    /// reference's `.map` throws there and the process exits (the chat effect is then simply
    /// not granted). A `null` badge reads as an empty one (the reference throws on it too).
    pub badges: Option<Vec<ChatBadge>>,
}

/// One badge of [`ChatEffectInput::badges`].
#[derive(Clone, Debug, PartialEq)]
pub struct ChatBadge {
    /// `set_id || ''`.
    pub set_id: Value,
    /// `id || ''`.
    pub id: Value,
    /// `info || ''`.
    pub info: Value,
}

/// `x || ''`.
fn or_empty(value: &Value) -> Value {
    if value.truthy() {
        value.clone()
    } else {
        Value::from("")
    }
}

impl ChatEffectInput {
    /// The reference's extraction from a chat message event.
    pub fn from_event(event: &Value, timestamp: &str) -> Self {
        let badges = match event.at("badges") {
            Value::Array(items) => Some(
                items
                    .iter()
                    .map(|badge| ChatBadge {
                        set_id: or_empty(badge.at("set_id")),
                        id: or_empty(badge.at("id")),
                        info: or_empty(badge.at("info")),
                    })
                    .collect(),
            ),
            other if other.truthy() => None,
            _ => Some(Vec::new()),
        };
        Self {
            channel_id: event.at("broadcaster_user_id").clone(),
            origin_kind: "chat-command",
            origin_id: event.at("message_id").clone(),
            occurred_at: timestamp.to_owned(),
            actor_id: event.at("chatter_user_id").clone(),
            display_name: or_empty(event.at("chatter_user_name")),
            login: or_empty(event.at("chatter_user_login")),
            message: or_empty(event.at("message").at("text")),
            badges,
        }
    }
}

/// One notification for the inline handler (`eventsubHandler(subscription, event, options)`).
#[derive(Clone, Debug, PartialEq)]
pub struct Notification {
    /// `Twitch-Eventsub-Message-Id`.
    pub message_id: String,
    /// `Twitch-Eventsub-Message-Timestamp`.
    pub message_timestamp: String,
    /// `subscription.type` (`String(notification?.subscription?.type || 'unknown')`).
    pub subscription_type: String,
    /// `notification.subscription`, as Twitch sent it.
    pub subscription: Object,
    /// `notification.event`, as Twitch sent it.
    pub event: Value,
    /// The options.
    pub options: HandlerOptions,
}

/// A revocation for `revocationHandler(subscription)`.
#[derive(Clone, Debug, PartialEq)]
pub struct Revocation {
    /// `Twitch-Eventsub-Message-Id`.
    pub message_id: String,
    /// `notification.subscription`, as Twitch sent it (its `status` says why).
    pub subscription: Object,
}

/// What the revocation handler did.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum RevocationOutcome {
    /// Done, or nothing to do (`error: false`): 204.
    Done,
    /// It failed in a way a redelivery may fix (a store error; `error: true` from the `catch`):
    /// 503, Twitch delivers it again.
    Retry(String),
    /// It can never succeed (the reference's `Invalid subscription data`: no `id`, `type` or
    /// `version`): 204 and a dead-letter record, instead of the reference's 503 that Twitch
    /// redelivers for ever (lead's decision).
    Invalid(String),
}

/// A failure of the inline handler (logged and counted, as the reference's `.catch`).
#[derive(Clone, Debug, PartialEq, Eq, thiserror::Error)]
#[error("{0}")]
pub struct HandlerError(pub String);

/// The bot's EventSub handlers, as the ingress calls them.
pub trait EventsubHandler: Send + Sync + 'static {
    /// `eventsubHandler(subscription, event, options)`: runs after the answer was written, on a
    /// task the ingress tracks (drained at shutdown). Must not assume it runs before the next
    /// delivery of the same channel; must bound its own work (P4-CHAT-MESSAGE limits messages
    /// per channel and evaluations in flight).
    fn handle(&self, notification: Notification) -> BoxFuture<'static, Result<(), HandlerError>>;

    /// `revocationHandler(subscription)`: runs before the answer, which depends on it. Must
    /// answer within the ingress's deadline (a timeout is answered 503 and Twitch redelivers),
    /// and be idempotent (Twitch may deliver a revocation twice).
    fn revoke(&self, revocation: Revocation) -> BoxFuture<'static, RevocationOutcome>;
}

/// A handler that does nothing (the binary's stand-in until P4-CHAT-EVENTS lands, and tests).
#[derive(Clone, Copy, Debug, Default)]
pub struct NoHandler;

impl EventsubHandler for NoHandler {
    fn handle(&self, _: Notification) -> BoxFuture<'static, Result<(), HandlerError>> {
        Box::pin(async { Ok(()) })
    }

    fn revoke(&self, _: Revocation) -> BoxFuture<'static, RevocationOutcome> {
        Box::pin(async { RevocationOutcome::Done })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn json(text: &str) -> Value {
        Value::from_json(&serde_json::from_str(text).unwrap_or_default())
    }

    #[test]
    fn the_chat_effect_input_is_extracted_like_the_reference() {
        let event = json(
            r#"{"broadcaster_user_id":"1001","message_id":"m1","chatter_user_id":"5001",
                "chatter_user_name":"","chatter_user_login":"viewer","message":{"text":"hi 👋🏽"},
                "badges":[{"set_id":"sub","id":"12","info":null},null,{"set_id":0}]}"#,
        );
        let input = ChatEffectInput::from_event(&event, "2026-11-12T09:29:58.123456789Z");
        assert_eq!(input.channel_id, Value::from("1001"));
        assert_eq!(input.display_name, Value::from(""));
        assert_eq!(input.message, Value::from("hi 👋🏽"));
        let badges = input.badges.unwrap_or_default();
        assert_eq!(badges.len(), 3);
        assert_eq!(badges[0].info, Value::from(""));
        assert_eq!(badges[1].set_id, Value::from(""));
        assert_eq!(badges[2].set_id, Value::from(""));
    }

    #[test]
    fn badges_that_are_not_a_list_grant_no_chat() {
        let event = json(r#"{"badges":"admin","message":null}"#);
        let input = ChatEffectInput::from_event(&event, "");
        assert_eq!(input.badges, None);
        assert_eq!(input.message, Value::from(""));
        assert_eq!(input.channel_id, Value::Undefined);
        let event = json(r#"{"badges":null}"#);
        assert_eq!(
            ChatEffectInput::from_event(&event, "").badges,
            Some(Vec::new())
        );
    }
}
