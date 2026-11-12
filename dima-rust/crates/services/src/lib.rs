//! The API's services: the logic behind the routes that is not a route itself. Command and
//! reward writes, the reserved defaults of a new channel, the settings services (EventSub
//! configuration, AI personality, follow defense, moderation), the dashboard's read services,
//! and account deletion.
//!
//! Rules for everything in this workspace are in `dima-rust/MIGRATION.md`; the plan for this
//! crate is `ledger/upper-layers.md` (layer 8 of section 2.3).
//!
//! # Dependencies, and why
//!
//! `dima-actions` and what lies below it: command writes validate command language with the
//! engine and simulate it with the host; settings writes reach moderation and the features;
//! reads use the billing ledger and the stream analytics. Only the API links this crate (the
//! site agent's write tools reuse it); the bot and the cron do not.
//!
//! # Modules and the packages that fill them
//!
//! - [`reads`], by P4-SVC-READS (wave 1).
//! - [`commands`], by P4-SVC-COMMANDS (wave 1).
//! - [`settings`], by P4-SVC-SETTINGS (wave 2).
//! - [`account`], by P4-SVC-ACCOUNT (wave 2).
#![forbid(unsafe_code)]
#![warn(missing_docs)]

pub mod account;
pub mod commands;
pub mod reads;
pub mod settings;
