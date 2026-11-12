//! How a handler is attached to its domain-event consumer and receives its dependencies
//! (P4-SKEL).
//!
//! The consumer runtime of `dima-events` takes a list of [`Consumer`]s, each a definition from
//! the reference's consumer table ([`CONSUMERS`], `DOMAIN_EVENT_CONSUMERS`) and an
//! `Arc<dyn `[`Handler`]`>`. [`Registry`] builds that list: a handler module registers its
//! handler under its consumer's name, built from the process's [`Deps`]; the cron binary hands
//! the result to `dima_events::consumer::Runtime::new`.
//!
//! The plan speaks of handlers registered "for an event type"; the code dispatches by
//! **consumer** (each consumer has its own event filter, delivery policy, leases and
//! checkpoint), so the registry is keyed by consumer name. The code wins.
//!
//! ```
//! use dima_event_handlers::registry::Registry;
//! # use dima_events::consumer::{DeliveryContext, Handler, Outcome};
//! # use dima_events::envelope::Envelope;
//! # use std::{future::Future, pin::Pin, sync::Arc};
//! # #[derive(Debug)]
//! # struct ChatAnnouncements { language: &'static str }
//! # impl Handler for ChatAnnouncements {
//! #     fn handle<'a>(&'a self, _: &'a Envelope, _: &'a DeliveryContext)
//! #         -> Pin<Box<dyn Future<Output = Outcome> + Send + 'a>> { Box::pin(async { Outcome::Done }) }
//! # }
//! // In the cron: `Registry::new(deps)` with the real `Deps`; here, any dependencies type.
//! let mut registry = Registry::new("es");
//! registry.register("chat-announcements-v1", |language| {
//!     Arc::new(ChatAnnouncements { language: *language })
//! })?;
//! assert_eq!(registry.missing().len(), 14);
//! let consumers = registry.into_consumers(); // for dima_events::consumer::Runtime::new
//! assert_eq!(consumers[0].definition.consumer, "chat-announcements-v1");
//! # Ok::<(), dima_event_handlers::registry::RegistryError>(())
//! ```

use dima_core::{Clock, Random};
use dima_events::consumer::{Consumer, Handler};
use dima_events::contracts::policy::{CONSUMERS, ConsumerDefinition, consumer_named};
use dima_store::dragonfly::Dragonfly;
use dima_store::mongo::MongoStore;
use dima_twitch::Twitch;
use dima_twitch::chat::ChatOut;
use std::fmt;
use std::sync::Arc;

/// What every handler may be built from: one per process (the cron's), shared by all handlers.
/// P4-EVH adds the feature services its handlers need (goals, widgets, overlay interactions,
/// follow defense, credit gifts) when it fills [`crate::handlers`].
pub struct Deps {
    /// MongoDB: the handlers' collections.
    pub mongo: MongoStore,
    /// Dragonfly: counters and caches the handlers keep (the follow count of chat announcements).
    pub dragonfly: Dragonfly,
    /// Twitch: the streamer directory and Helix.
    pub twitch: Twitch,
    /// Chat, rendered or plain (`chat_announcement_events.ts:133`): the cron passes
    /// `dima_actions::delivery::ChatDelivery`.
    pub chat: Arc<dyn ChatOut>,
    /// The wall clock.
    pub clock: Arc<dyn Clock>,
    /// Randomness.
    pub random: Arc<dyn Random>,
}

impl fmt::Debug for Deps {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Deps").finish_non_exhaustive()
    }
}

/// Why a handler could not be registered.
#[derive(Clone, Debug, PartialEq, Eq, thiserror::Error)]
pub enum RegistryError {
    /// No consumer of the reference's table has that name.
    #[error("no domain-event consumer is named `{0}`")]
    UnknownConsumer(String),
    /// The consumer already has a handler.
    #[error("the domain-event consumer `{0}` already has a handler")]
    Duplicate(&'static str),
}

/// The handlers registered so far, each built from the shared dependencies `D` ([`Deps`] in the
/// cron; anything in a test).
pub struct Registry<D = Deps> {
    deps: D,
    handlers: Vec<(&'static ConsumerDefinition, Arc<dyn Handler>)>,
}

impl<D> fmt::Debug for Registry<D> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Registry")
            .field(
                "registered",
                &self
                    .handlers
                    .iter()
                    .map(|(definition, _)| definition.consumer)
                    .collect::<Vec<_>>(),
            )
            .finish_non_exhaustive()
    }
}

impl<D> Registry<D> {
    /// An empty registry over the process's dependencies.
    pub fn new(deps: D) -> Self {
        Self {
            deps,
            handlers: Vec::new(),
        }
    }

    /// The dependencies handlers are built from.
    pub fn deps(&self) -> &D {
        &self.deps
    }

    /// Attaches the handler `build` makes from the dependencies to the consumer named
    /// `consumer`. Refused for a name the consumer table does not have, and for a consumer that
    /// already has a handler.
    pub fn register<H>(
        &mut self,
        consumer: &str,
        build: impl FnOnce(&D) -> Arc<H>,
    ) -> Result<(), RegistryError>
    where
        H: Handler + 'static,
    {
        let definition = consumer_named(consumer)
            .ok_or_else(|| RegistryError::UnknownConsumer(consumer.to_owned()))?;
        if self
            .handlers
            .iter()
            .any(|(known, _)| known.consumer == definition.consumer)
        {
            return Err(RegistryError::Duplicate(definition.consumer));
        }
        let handler: Arc<dyn Handler> = build(&self.deps);
        self.handlers.push((definition, handler));
        Ok(())
    }

    /// The consumers of the table that have no handler yet, in the table's order. The cron
    /// reports them at start-up; their deliveries wait until a handler exists.
    pub fn missing(&self) -> Vec<&'static str> {
        CONSUMERS
            .iter()
            .filter(|definition| {
                !self
                    .handlers
                    .iter()
                    .any(|(known, _)| known.consumer == definition.consumer)
            })
            .map(|definition| definition.consumer)
            .collect()
    }

    /// The registered consumers for `dima_events::consumer::Runtime::new`, in the table's order
    /// (the order the reference's dispatcher creates deliveries in), whatever the order of
    /// registration.
    pub fn into_consumers(self) -> Vec<Consumer> {
        let mut consumers = Vec::with_capacity(self.handlers.len());
        for definition in &CONSUMERS {
            if let Some((_, handler)) = self
                .handlers
                .iter()
                .find(|(known, _)| known.consumer == definition.consumer)
            {
                consumers.push(Consumer {
                    definition,
                    handler: Arc::clone(handler),
                });
            }
        }
        consumers
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use dima_events::consumer::{DeliveryContext, Outcome};
    use dima_events::envelope::Envelope;
    use std::future::Future;
    use std::pin::Pin;
    use std::sync::atomic::{AtomicUsize, Ordering};

    #[derive(Debug)]
    struct Named;

    impl Handler for Named {
        fn handle<'a>(
            &'a self,
            _event: &'a Envelope,
            _context: &'a DeliveryContext,
        ) -> Pin<Box<dyn Future<Output = Outcome> + Send + 'a>> {
            Box::pin(async { Outcome::Done })
        }
    }

    #[test]
    fn handlers_are_built_from_the_deps_and_listed_in_table_order() {
        let built = AtomicUsize::new(0);
        let mut registry = Registry::new(&built);
        for consumer in ["polar-gifts-v1", "chat-announcements-v1", "raid-history-v1"] {
            registry
                .register(consumer, |deps| {
                    deps.fetch_add(1, Ordering::SeqCst);
                    Arc::new(Named)
                })
                .unwrap();
        }
        assert_eq!(built.load(Ordering::SeqCst), 3);
        let missing = registry.missing();
        assert_eq!(missing.len(), CONSUMERS.len() - 3);
        assert_eq!(missing.first(), Some(&"stream-timeline-v1"));
        assert!(!missing.contains(&"chat-announcements-v1"));
        let consumers = registry.into_consumers();
        assert_eq!(
            consumers
                .iter()
                .map(|consumer| consumer.definition.consumer)
                .collect::<Vec<_>>(),
            ["raid-history-v1", "chat-announcements-v1", "polar-gifts-v1"]
        );
    }

    #[test]
    fn unknown_and_duplicate_consumers_are_refused() {
        let mut registry = Registry::new(());
        assert_eq!(
            registry.register("chat-announcements", |_| Arc::new(Named)),
            Err(RegistryError::UnknownConsumer("chat-announcements".into()))
        );
        registry
            .register("stream-operations-v1", |_| Arc::new(Named))
            .unwrap();
        assert_eq!(
            registry.register("stream-operations-v1", |_| Arc::new(Named)),
            Err(RegistryError::Duplicate("stream-operations-v1"))
        );
        assert_eq!(registry.into_consumers().len(), 1);
    }

    #[test]
    fn an_empty_registry_misses_every_consumer() {
        let registry = Registry::new(());
        assert_eq!(
            registry.missing(),
            CONSUMERS
                .iter()
                .map(|definition| definition.consumer)
                .collect::<Vec<_>>()
        );
        assert!(registry.into_consumers().is_empty());
    }
}
