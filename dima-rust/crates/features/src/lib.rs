//! The channel features as libraries, without sockets: goals, roulettes, duels, bits rules,
//! widgets and the widget feed, Overlay Studio's model and store, pets (admission, state,
//! readiness), custom widget bundles, the asset library, the desktop AI model, follow defense
//! with raid sessions, and custom timers.
//!
//! Rules for everything in this workspace are in `dima-rust/MIGRATION.md`; the plan for this
//! crate is `ledger/upper-layers.md` (layer 6 of section 2.3).
//!
//! # Why this crate sits below the engine's host
//!
//! The command language's host functions (`dima_actions::host`) call goals, roulettes, duels,
//! widgets, pets and Overlay Studio. A crate holding these features above the host would recreate
//! the reference's import cycle, so the features live here, below `dima-actions`, and the parts
//! that own Socket.IO namespaces or queues live above it in `dima-realtime`. This crate never
//! depends on `dima-actions` (the workspace's layer test, `api/tests/layers.rs`, enforces it).
//! Where a feature posts templated chat (goal and roulette actions, duel announcements, follow
//! defense), it takes an `Arc<dyn `[`dima_twitch::chat::ChatOut`]`>`, which `dima-actions`
//! implements.
//!
//! # Dependencies, and why
//!
//! - `dima-engine`: parsing command language (roulette action validation) and evaluating
//!   overlay text with no host.
//! - `dima-twitch`: Helix calls (duel timeouts, goal mirroring, follow-defense bans) and the
//!   [`dima_twitch::chat::ChatOut`] seam.
//! - `dima-events`: journaled events feed goals, widgets, interactions and follow defense; goal
//!   contributions are journaled.
//! - `dima-stream`: follow ledger and stream sessions (follow defense, raid sessions).
//! - `dima-tts`: pets speak through the TTS providers.
//! - `dima-billing`: plan tiers and entitlements gate features.
//! - `dima-platform`: S3 and media probes for assets, capability tokens.
//! - `dima-model`, `dima-store`: the features' collections and keys.
//!
//! # Modules and the packages that fill them (all wave 1 unless noted)
//!
//! - [`goals`], by P4-FEAT-GOALS.
//! - [`roulette`], [`duel`], [`bits_rules`]: P4-FEAT-GAMES.
//! - [`widgets`], [`widget_feed`]: P4-FEAT-WIDGETS.
//! - [`overlays`], by P4-FEAT-OVERLAYS.
//! - [`pets`], by P4-FEAT-PETS.
//! - [`defense`], by P4-FEAT-DEFENSE-A; [`defense::actions`]: P4-FEAT-DEFENSE-B (wave 2).
//! - [`timers`], by P4-FEAT-TIMERS.
//! - [`assets`], [`custom_widgets`], [`desktop`]: P4-FEAT-ASSETS.
#![forbid(unsafe_code)]
#![warn(missing_docs)]

pub mod assets;
pub mod bits_rules;
pub mod custom_widgets;
pub mod defense;
pub mod desktop;
pub mod duel;
pub mod goals;
pub mod overlays;
#[path = "pets/mod.rs"]
pub mod pets;
pub mod roulette;
pub mod timers;
pub mod widget_feed;
pub mod widgets;
