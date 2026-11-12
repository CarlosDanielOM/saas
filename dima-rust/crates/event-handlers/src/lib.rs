//! The handlers of the domain-event consumers (chat announcements, account-health notices,
//! stream analytics and timeline, stream operations, follow defense, credit gifts, and the
//! features' own handlers), and the [`registry::Registry`] through which each is attached to its
//! consumer with its dependencies.
//!
//! Rules for everything in this workspace are in `dima-rust/MIGRATION.md`; the plan for this
//! crate is `ledger/upper-layers.md` (layer 8 of section 2.3).
//!
//! # Dependencies, and why
//!
//! - `dima-events`: the consumer runtime, the consumer table and the [`dima_events::consumer::Handler`]
//!   trait every handler implements.
//! - `dima-features`: goals, widgets, overlay interactions, follow defense, bits rules.
//! - `dima-stream`: stream analytics, the timeline, stream operations, raid history.
//! - `dima-billing`: credit gifts.
//! - `dima-twitch`: the streamer directory, EventSub configuration, and chat through
//!   [`dima_twitch::chat::ChatOut`].
//!
//! **Not `dima-actions`.** Handlers that post chat take an `Arc<dyn ChatOut>`
//! ([`registry::Deps::chat`]); the cron hands them `dima_actions::delivery::ChatDelivery`. A
//! test may use the real `ChatDelivery` as a dev-dependency. `api/tests/layers.rs` enforces the
//! exclusion. Only the cron links this crate.
//!
//! # Modules and the packages that fill them
//!
//! - [`registry`], by P4-SKEL (done).
//! - [`handlers`], by P4-EVH (wave 3).
#![forbid(unsafe_code)]
#![warn(missing_docs)]

pub mod handlers;
pub mod registry;
