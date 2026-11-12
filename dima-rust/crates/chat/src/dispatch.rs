//! The bot's inline EventSub handler: the [`crate::ingress::EventsubHandler`] the ingress calls,
//! routing each notification by its subscription type. Laid out by P4-CHAT-MESSAGE so that
//! P4-CHAT-EVENTS adds its events without touching the message handler's files.
//!
//! - `channel.chat.message` goes to [`crate::message::MessageHandler`] (registered with
//!   [`Dispatcher::on`] by the bot binary), which ports that type's branch of
//!   `eventsub.handler.ts` as well as `messageHandler`.
//! - Every other type, and every revocation, goes to the fallback handler: P4-CHAT-EVENTS
//!   implements [`crate::ingress::EventsubHandler`] for the rest of `eventsub.handler.ts` and
//!   `revocation.handler.ts` (its `handle` never sees a chat message), or registers one
//!   [`TypeHandler`] per type with [`Dispatcher::on`].
//!
//! The binary wires it: `Dispatcher::new(events).on(CHAT_MESSAGE, message_handler)`.

use crate::ingress::{EventsubHandler, HandlerError, Notification, Revocation, RevocationOutcome};
use futures_util::future::BoxFuture;
use std::collections::HashMap;
use std::sync::Arc;

/// `channel.chat.message`.
pub const CHAT_MESSAGE: &str = "channel.chat.message";

/// The handler of one subscription type.
pub trait TypeHandler: Send + Sync + 'static {
    /// Handles a notification of the type it is registered for (see
    /// [`EventsubHandler::handle`] for what the ingress expects).
    fn handle(&self, notification: Notification) -> BoxFuture<'static, Result<(), HandlerError>>;
}

/// Routes notifications by type (see the module documentation).
#[derive(Clone)]
pub struct Dispatcher {
    by_type: HashMap<String, Arc<dyn TypeHandler>>,
    fallback: Arc<dyn EventsubHandler>,
}

impl std::fmt::Debug for Dispatcher {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let mut types: Vec<&str> = self.by_type.keys().map(String::as_str).collect();
        types.sort_unstable();
        f.debug_struct("Dispatcher")
            .field("types", &types)
            .finish_non_exhaustive()
    }
}

impl Dispatcher {
    /// A dispatcher sending everything to `fallback` until types are registered.
    pub fn new(fallback: Arc<dyn EventsubHandler>) -> Self {
        Self {
            by_type: HashMap::new(),
            fallback,
        }
    }

    /// Sends notifications of `subscription_type` to `handler` (a later registration of the same
    /// type replaces the earlier one).
    pub fn on(mut self, subscription_type: &str, handler: Arc<dyn TypeHandler>) -> Self {
        self.by_type.insert(subscription_type.to_owned(), handler);
        self
    }

    /// The types with their own handler.
    pub fn types(&self) -> impl Iterator<Item = &str> {
        self.by_type.keys().map(String::as_str)
    }
}

impl EventsubHandler for Dispatcher {
    fn handle(&self, notification: Notification) -> BoxFuture<'static, Result<(), HandlerError>> {
        match self.by_type.get(&notification.subscription_type) {
            Some(handler) => handler.handle(notification),
            None => self.fallback.handle(notification),
        }
    }

    fn revoke(&self, revocation: Revocation) -> BoxFuture<'static, RevocationOutcome> {
        self.fallback.revoke(revocation)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ingress::{HandlerOptions, NoHandler};
    use dima_events::value::{Object, Value};
    use std::sync::Mutex;

    #[derive(Default)]
    struct Seen(Mutex<Vec<String>>);

    impl TypeHandler for Arc<Seen> {
        fn handle(
            &self,
            notification: Notification,
        ) -> BoxFuture<'static, Result<(), HandlerError>> {
            if let Ok(mut seen) = self.0.lock() {
                seen.push(notification.message_id);
            }
            Box::pin(async { Ok(()) })
        }
    }

    fn notification(kind: &str, id: &str) -> Notification {
        Notification {
            message_id: id.into(),
            message_timestamp: String::new(),
            subscription_type: kind.into(),
            subscription: Object::new(),
            event: Value::Undefined,
            options: HandlerOptions::default(),
        }
    }

    #[tokio::test]
    async fn notifications_go_to_their_type_or_the_fallback() {
        let seen = Arc::new(Seen::default());
        let dispatcher =
            Dispatcher::new(Arc::new(NoHandler)).on(CHAT_MESSAGE, Arc::new(Arc::clone(&seen)));
        assert!(
            dispatcher
                .handle(notification(CHAT_MESSAGE, "a"))
                .await
                .is_ok()
        );
        assert!(
            dispatcher
                .handle(notification("channel.follow", "b"))
                .await
                .is_ok()
        );
        assert_eq!(seen.0.lock().map(|s| s.clone()).unwrap_or_default(), ["a"]);
        assert_eq!(
            dispatcher
                .revoke(Revocation {
                    message_id: "r".into(),
                    subscription: Object::new()
                })
                .await,
            RevocationOutcome::Done
        );
        assert_eq!(dispatcher.types().collect::<Vec<_>>(), [CHAT_MESSAGE]);
    }
}
