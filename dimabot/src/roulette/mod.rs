//! Roulette domain for the widgets lane.
//!
//! Ports `dimabot/src/roulette/model.ts`, `action-model.ts`, `service.ts`,
//! and `actions.ts`. One channel document is the atomic boundary across API,
//! bot, and cron. Constructors take an injected database and perform no
//! import-time I/O. Item scripts are checked with the native AST syntax
//! engine. Due winner actions are claimed and delivered by [`actions`],
//! through the shared AST runtime. The TypeScript `roulette-actions` worker
//! still owns the one-second poll.

#![cfg(feature = "widgets-runtime")]

pub mod action_model;
pub mod actions;
pub mod model;
pub mod service;

pub use action_model::{ActionStatus, DrawActor, WinnerAction};
pub use model::{Roulette, RouletteError, State, empty_state};
