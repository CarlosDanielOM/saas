//! Roulettes: the model, revisions, the overlay snapshot, and the due winner actions. Package
//! **P4-FEAT-GAMES**.
//!
//! TypeScript it ports (baseline `0c71108e`):
//!
//! - `roulette/model.ts` (236 lines) → [`input`] (`RouletteError`, `fail`, `object`, `text`,
//!   `integer`, `actionSource`) and [`model`] (`configure`, `create`, `emptyState`
//!   ([`State::default`]), `find`, `add`, `importItems`, `updateItem`, `remove`, `start`,
//!   `settle`).
//! - `roulette/service.ts` (173 lines) → [`service`]: `RouletteChannel` (the model crate's
//!   `roulette_channels`), `execute`, `snapshot`, `overlaySnapshot`, `authorizeOverlay`, and the
//!   overlay token store's `read`/`save` ([`RouletteService::token_document`],
//!   [`RouletteService::save_token`]; `manageOverlayToken` itself is P4-FEAT-OVERLAYS's).
//!   `settleDue` is not ported: the native completion worker replaced it (P2-CRON-01).
//! - `roulette/actions.ts` (50 lines) → [`actions`]: `claimAction`, `executeWinnerAction`
//!   ([`ChatWinnerActions`], posting through `ChatOut::deliver`), `runDueActions`.
//!
//! Callers: the `roulette.*` host functions (P4-ACT-MEDIA: [`RouletteService::execute`] with a
//! [`DrawActor`] from the command context, [`RouletteService::snapshot`] for `result`), the
//! routes (P4-API-OVERLAYS), the overlay socket (P4-RT-SOCKETS: [`RouletteService::version`],
//! [`Snapshot::overlay_json`], [`RouletteService::authorize_overlay`]), the site assistant
//! (P4-SA-WRITE-C: [`model`] for previews, [`RouletteService::read`], `execute` with a
//! revision), the cron (P4-CRON-FEATURES: [`RouletteService::run_due_actions`] every second).
//!
//! # Bounds on what a streamer or viewer supplies
//!
//! From the reference's validators: 20 roulettes per channel; names 1–120 characters, aliases
//! 1–40 (`^[a-z][a-z0-9_-]*$`); 1–12 colors; spin 1–120 s; hide 1–3600 s; labels 1–120;
//! multiplier 1–10,000 and copies per design (10,000 wheel, 50/75/100 cards, 60 reel, 100
//! elimination); weights safe integers with a safe total; item actions up to 8,000 characters
//! and parsed by the engine (syntax only, the engine's own limits); imports 1–10,000 rows; 100
//! open winner actions; the state's JSON at most 4 MiB; draw actors' ids 100, logins 100,
//! names 120, arguments 2,000; idempotency keys 1–128; channel ids 1–100. Text is counted in
//! characters (`MIGRATION.md` section 4).

pub mod actions;
pub mod input;
pub mod model;
pub mod service;

pub use actions::{ChannelOwner, ChannelOwners, ChatWinnerActions, WinnerActionRunner};
pub use input::RouletteError;
pub use model::State;
pub use service::{
    Action, DrawActor, Executed, Operation, RouletteConfig, RouletteService, ServiceError,
    Snapshot, TokenDocument, WinnerAction,
};
