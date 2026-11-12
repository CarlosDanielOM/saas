//! MongoDB access that stays compatible with the TypeScript (Mongoose 8 on the Node driver)
//! writing the same collections.
//!
//! The specification is `dima-rust/ledger/mongo.md`, section "Rules a Rust data layer must
//! follow to stay compatible"; every rule this module implements was checked against what
//! Mongoose 8.24.3 really sends and stores: `tests/mongo_golden/record.mjs` records it and
//! `tests/mongo_golden.rs` replays every recorded case through these helpers.
//!
//! - [`connection`]: [`MongoStore`] (client + database handle) from a [`MongoConfig`], with a
//!   [`CommandHook`] for telemetry.
//! - [`number`], [`date`], [`id`]: BSON numbers, dates and ids as the Node driver writes and
//!   Mongoose reads them; ObjectId casting.
//! - [`schema`]: the per-collection description the write helpers work from.
//! - [`filter`]: filters cast to the schema types as Mongoose casts them (string ids to
//!   ObjectIds, date text to dates…), for reads ([`filter::prepare_filter`]) and inside every
//!   write helper.
//! - [`update`], [`insert`], [`save`]: the update or document Mongoose would really send for
//!   the caller's intent (timestamps, `__v`, defaults on insert and upsert, `minimize`, `trim`,
//!   immutable paths, sub-document ids, the save delta). They take the time and id source as a
//!   [`WriteContext`], so callers stay deterministic.
//! - [`write`](mod@write): the one checked way to run a prepared write ([`write::Writes`]): unknown
//!   paths fail in debug builds and are reported in release builds; a save that matched
//!   nothing is a conflict.
//! - [`json`]: documents rendered as Express renders a `.lean()` read.
//! - [`error`]: duplicate-key detection; [`transaction`]: transaction with the standalone
//!   fallback.
#![warn(missing_docs)]

mod cast;
pub mod connection;
pub mod date;
pub mod error;
pub mod filter;
pub mod id;
pub mod insert;
pub mod json;
pub mod number;
pub mod save;
pub mod schema;
pub mod transaction;
pub mod update;
pub mod write;

pub use cast::{MAX_DEPTH, PrepareError, WriteContext};
pub use connection::{CommandHook, MongoConfig, MongoStore};
pub use error::MongoError;
