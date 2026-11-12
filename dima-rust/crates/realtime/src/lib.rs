//! The API's live side: every Socket.IO namespace and the desktop app's raw WebSocket, the TTS,
//! clip and DimaFX queues that emit to them, the Overlay Studio live loop, the pet and desktop
//! AI runtimes, and the in-process implementations of the request surface the bot reaches over
//! HTTP.
//!
//! Rules for everything in this workspace are in `dima-rust/MIGRATION.md`; the plan for this
//! crate is `ledger/upper-layers.md` (layer 8 of section 2.3, cycle C02 in section 2.1).
//!
//! # How cycle C02 is broken here
//!
//! In the reference the queues import the Socket.IO server and the server imports the queues to
//! wire their events. Here the API binary builds the `dima_socketio` server once; each realtime
//! module implements [`registry::RealtimeModule`], declares its own namespaces through the
//! [`registry::Registry`] the binary drives, and keeps the typed handles it gets back. No queue
//! names the server; the server names no queue.
//!
//! # Dependencies, and why
//!
//! - `dima-features`: the features whose live side lives here (roulettes, widgets, duels,
//!   Overlay Studio, pets, assets, the desktop AI model).
//! - `dima-actions`: evaluations that run in the API (simulation, the site agent, the EventSub
//!   test route) and the AI chat of the pets and the desktop app.
//! - `dima-socketio`, `dima-web`: the namespaces, and the WebSocket upgrade of the desktop app.
//! - `dima-tts`: synthesis for the TTS queue.
//! - `dima-platform`: tokens, S3, TTS usage, the media tools.
//!
//! Only the API links this crate; the bot does not (`api/tests/layers.rs` enforces it).
//!
//! # Modules and the packages that fill them
//!
//! - [`registry`], by P4-SKEL (done).
//! - [`server`], [`overlays`], [`preview`], [`desktop_ws`]: P4-RT-SOCKETS (wave 2).
//! - [`backend`], by P4-RT-SOCKETS, with the clip publisher of P4-RT-CLIP-FX.
//! - [`tts`], by P4-RT-TTS-A (wave 3); [`tts::playback`]: P4-RT-TTS-B (wave 4).
//! - [`clips`], [`dimafx`]: P4-RT-CLIP-FX (wave 3).
//! - [`overlay_live`], by P4-RT-OVERLAY-LIVE (wave 3).
//! - [`pets`], by P4-RT-PETS (wave 5).
//! - [`desktop_ai`], by P4-RT-DESKTOP (wave 5).
#![forbid(unsafe_code)]
#![warn(missing_docs)]

pub mod backend;
pub mod clips;
pub mod desktop_ai;
pub mod desktop_ws;
pub mod dimafx;
pub mod overlay_live;
pub mod overlays;
pub mod pets;
pub mod preview;
pub mod registry;
pub mod server;
pub mod tts;
