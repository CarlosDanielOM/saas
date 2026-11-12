//! Everything the command language does outside the engine, and what runs it: the engine's host
//! ([`host::DimaHost`]), chat delivery ([`delivery::ChatDelivery`], the implementer of
//! [`dima_twitch::chat::ChatOut`]), command execution and the [`runner::CommandRunner`] handle,
//! AST timers, the editor's simulation, the AI chat with its tools, the AST catalog, and the bot
//! and cron side of the request surface to the API.
//!
//! Rules for everything in this workspace are in `dima-rust/MIGRATION.md`; the plan for this
//! crate is `ledger/upper-layers.md` (layer 7 of section 2.3, sections 2.1 and 2.2).
//!
//! # How the reference's cycle is broken here
//!
//! The engine (`dima-engine`) is pure and sends every effect through
//! [`dima_engine::host::Host`]; [`host::DimaHost`] implements it, forwarding each of the 99
//! [`dima_engine::host::HostFunction`]s to one of four group modules. Rendering then sending
//! chat is [`delivery`]; features below this crate reach it only through the
//! [`dima_twitch::chat::ChatOut`] trait. The AI chat lives in [`ai`], next to the host, and its
//! tools get a `&dyn ChatOut` and a [`runner::CommandRunner`], not the host module.
//!
//! # Dependencies, and why
//!
//! - `dima-engine`: the evaluator and the host trait it implements.
//! - `dima-commands`: command lookup, permissions, cooldowns, keywords.
//! - `dima-moderation`: the moderation functions' rules and actions.
//! - `dima-features`: goals, roulettes, duels, widgets, pets, Overlay Studio, follow defense,
//!   timers, which the media and moderation functions call.
//! - `dima-ai`, `dima-billing`: the AI chat and its charged usage.
//! - `dima-tts`: the TTS functions and `$(set.voice)`.
//! - `dima-twitch`: Helix, the plain send, the `ChatOut`, `BackendApi` and `ClipPublisher` seams.
//! - `dima-stream`, `dima-events`: stream facts the functions read, journaled goal
//!   contributions.
//! - `dima-core`, `dima-store`: clock and randomness, MongoDB and Dragonfly handles.
//!
//! # Modules and the packages that fill them
//!
//! - [`host`]: the dispatch is P4-SKEL's (done), the storage methods P4-ACT-CORE's (wave 2);
//!   [`host::moderation`] P4-ACT-MOD, [`host::channel`] P4-ACT-CHANNEL, [`host::media`]
//!   P4-ACT-MEDIA, [`host::ai`] P4-ACT-AI-A (all wave 3).
//! - [`delivery`], [`runner`], [`timers`], [`simulate`]: P4-ACT-CORE (wave 2).
//! - [`ai`], by P4-ACT-AI-A (wave 3); [`ai::chat`] P4-ACT-AI-B (wave 4); [`ai::catalog`]
//!   P4-ACT-AI-C (wave 3).
//! - [`backend`], by P4-ACT-MEDIA (wave 3).
//! - [`metrics`] (the bot runtime metrics), [`pubsub`] (the pub/sub manager) and
//!   [`product_events`] (PostHog product events): P4-BOT-INGRESS (wave 1). The bot, the API and
//!   the cron all load them, so they live in this crate, which the three binaries link (lead's
//!   decision at the P4-SKEL merge).
#![forbid(unsafe_code)]
#![warn(missing_docs)]

pub mod ai;
pub mod backend;
pub mod delivery;
pub mod host;
pub mod metrics;
pub mod product_events;
pub mod pubsub;
pub mod runner;
pub mod simulate;
pub mod timers;
