//! The domain-event consumers' handlers: chat announcements and account-health notices, stream
//! analytics and timeline, stream operations, follow defense, credit gifts, and the consumer table.
//! Package **P4-EVH** fills this module; it is empty until then.
//!
//! TypeScript it ports (baseline `0c71108e`), with the exports other packages call, which are the
//! public entry points the plan promises:
//!
//! - `domain_events/chat_announcement_events.ts` (288 lines)
//! - `domain_events/stream_analytics_events.ts` (171 lines)
//! - `domain_events/stream_operations_events.ts` (266 lines):
//!   `enqueueStreamOperationsReconciliation`
//! - `domain_events/follow_defense_events.ts` (67 lines)
//! - `domain_events/credit_gift_events.ts` (10 lines)
//! - `domain_events/domain_event_consumers.ts` (129 lines): `DOMAIN_EVENT_CONSUMERS`
//!
//! Each handler implements `dima_events::consumer::handler::Handler` and is registered through
//! `crate::registry::Registry` for its consumer; the handlers of the goal, widget,
//! overlay-interaction and raid-history consumers are the feature crates' (`applyGoalEvent` and the
//! others) and are registered here too. Effects are idempotent under redelivery.
