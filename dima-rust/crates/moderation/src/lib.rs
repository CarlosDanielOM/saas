//! Chat moderation: the rules a chat message is checked against (blacklists, caps, emote spam,
//! links, spam categories), permits and offense steps, decisions, the model-driven semantic
//! review and its variation jobs, the per-message moderation pass and the executor of its
//! actions on Twitch.
//!
//! Rules for everything in this workspace are in `dima-rust/MIGRATION.md`; the plan for this
//! crate is `ledger/upper-layers.md` (layer 6 of section 2.3).
//!
//! # Dependencies, and why
//!
//! - `dima-commands`: the bounded pattern engine for user patterns, and the roles and
//!   permissions a rule exempts.
//! - `dima-ai`: the model calls of the semantic review and of variation generation.
//! - `dima-twitch`: deleting, timing out, banning and warning on Twitch, and the public notice
//!   through [`dima_twitch::chat::ChatOut`].
//! - `dima-billing`: semantic review is charged usage.
//! - `dima-model`, `dima-store`: settings, offenses, permits and decisions in MongoDB and
//!   Dragonfly.
//!
//! Nothing here depends on `dima-actions` or the engine's host: the command language's
//! moderation functions (`dima_actions::host::moderation`) call into this crate, never the
//! other way.
//!
//! # Modules and the packages that fill them
//!
//! - [`rules`]: P4-MOD-RULES (the rules, their state, variations, spam protection).
//! - [`handler`], [`actions`], [`semantic`]: P4-MOD-RUN (wave 2).
#![forbid(unsafe_code)]
#![warn(missing_docs)]

pub mod actions;
pub mod handler;
pub mod rules;
pub mod semantic;
