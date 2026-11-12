//! MongoDB document types, collections, indexes and write helpers: the Rust counterpart of the
//! Mongoose schemas in `dimabot/src/schemas/`.
//!
//! Rules for everything in this workspace are in `dima-rust/MIGRATION.md` (sections 3 and 7 for
//! data). Writes go through `dima_store::mongo` (read its crate docs first); this crate says,
//! per collection, what those helpers need and what Mongoose would have validated or hooked.
#![forbid(unsafe_code)]
#![warn(missing_docs)]

pub mod collection;
pub mod decode;
mod defaults;
pub mod enums;
pub mod error;
pub mod index;
pub mod validation;
pub mod values;

pub mod ast_variables;
pub mod command_user_variables;
pub mod countdown_timers;
pub mod custom_timers;
pub mod domain_event_checkpoints;
pub mod domain_event_deliveries;
pub mod eventsubs;
pub mod stream_sessions;
pub mod timer_commands;
pub mod users;

pub use collection::{CollectionInfo, ReadError};
pub use decode::{DecodeError, decode, decode_document};
pub use enums::{Open, StrEnum};
pub use error::ModelError;
pub use index::{IndexFailure, IndexSpec, ensure_indexes};
pub use validation::{Rule, ValidationError, ValidatorError, ValidatorKind};

/// Every collection, one entry per collection (a module may hold two, like the countdown and its
/// configuration).
pub static REGISTRY: &[&CollectionInfo] = &[
    &users::INFO,
    &eventsubs::INFO,
    &ast_variables::INFO,
    &command_user_variables::INFO,
    &timer_commands::INFO,
    &custom_timers::INFO,
    &countdown_timers::INFO,
    &countdown_timers::CONFIG_INFO,
    &stream_sessions::INFO,
    &domain_event_deliveries::INFO,
    &domain_event_checkpoints::INFO,
];
