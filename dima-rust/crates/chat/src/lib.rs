//! The bot's own logic: the EventSub webhook ingress on port 3333, the chat message handler (the
//! hot path), the handlers of the other EventSub notifications, the built-in chat commands, the
//! bot's runtime metrics and product events.
//!
//! Rules for everything in this workspace are in `dima-rust/MIGRATION.md`; the plan for this
//! crate is `ledger/upper-layers.md` (layer 8 of section 2.3).
//!
//! # Dependencies, and why
//!
//! `dima-actions` and what lies below it: commands run through its runner, chat goes out through
//! its `ChatDelivery`, moderation through `dima-moderation`, the features through
//! `dima-features`. The bot binary links this crate and nothing of the API's
//! (`dima-realtime`, `dima-services`, `dima-routes`, `dima-site-agent`, `dima-recap`,
//! `dima-event-handlers`); `api/tests/layers.rs` enforces it. The API links this crate for one
//! route: its EventSub test route runs the bot's handler in the API process (lead's decision on
//! plan question 3).
//!
//! # Modules and the packages that fill them
//!
//! - [`ingress`], [`metrics`]: P4-BOT-INGRESS (wave 1).
//! - [`message`] and [`dispatch`] (the inline handler routing by subscription type), by
//!   P4-CHAT-MESSAGE (wave 3).
//! - [`events`], by P4-CHAT-EVENTS (wave 3).
//! - [`commands`], by P4-CHAT-CMDS-A (wave 3) and P4-CHAT-CMDS-B (wave 4).
#![forbid(unsafe_code)]
#![warn(missing_docs)]

pub mod commands;
pub mod dispatch;
pub mod events;
pub mod ingress;
pub mod message;
pub mod metrics;
