//! EventSub subscription management: everything the backend learns from Twitch arrives through
//! these subscriptions, and this module creates, lists, deletes and reconciles them.
//!
//! Reference: `utils/eventsub.ts`, `utils/eventsub_condition.ts`, `utils/eventsub_access.ts`,
//! `utils/eventsub_bits_config.ts`, `utils/chat_event_catalog.ts`,
//! `utils/eventsub_reconciliation.ts` and `utils/eventsub_reconciliation_policy.ts`.
//!
//! - The subscription table ([`SUBSCRIPTION_TYPES`]), the bits type helpers and [`Settings`] are
//!   in [`types`].
//! - Conditions, `buildExpectedEventsubCondition` and the raid direction helpers are in
//!   [`condition`].
//! - `buildBitsEventsubConfig` is in [`bits`], `getEventsubAccess` in [`access`], the built-in
//!   chat events in [`catalog`], the circuit breaker in [`policy`].
//! - The configuration (callback, secret, deadlines) is [`EventsubSettings`].
//! - Create, list, delete and the bits migration are [`EventsubManager`]'s ([`manage`]); so is
//!   the reconciliation ([`reconcile`]).
#![allow(clippy::module_name_repetitions)]

pub mod access;
pub mod bits;
pub mod catalog;
pub mod condition;
mod js;
pub mod manage;
pub mod policy;
pub mod reconcile;
mod settings;
mod store;
pub mod types;

pub use access::{EventsubAccess, EventsubPermission, GlobalOwnerAccess, eventsub_access};
pub use bits::build_bits_eventsub_config;
pub use catalog::{builtin_chat_event, builtin_chat_events, with_builtin_chat_events};
pub use condition::{
    Condition, OUTGOING_RAID_EVENT, RaidDirection, build_expected_condition, raid_condition,
    raid_config_type, raid_direction, subscription_key,
};
pub use manage::{
    BitsMigration, EventsubList, EventsubManager, EventsubRecord, Failure, ListError,
    RemoteEventsub, SubscribeError, SubscribeRequest, UnsubscribeError, Unsubscribed,
};
pub use policy::should_trip_circuit_breaker;
pub use reconcile::{
    Action, AlwaysContinue, RaidPreferences, ReconcileError, ReconcileReport, ReconcileSettings,
    RunControl,
};
pub use settings::{EventsubSettings, REFERENCE_CALLBACK, SettingsError};
pub use types::{
    CANONICAL_BITS_EVENT_TYPE, LEGACY_BITS_EVENT_TYPES, SUBSCRIPTION_TYPES, Setting, Settings,
    SubscriptionType, canonicalize_eventsub_type, equivalent_eventsub_types, is_bits_event_type,
    is_legacy_bits_event_type,
};
