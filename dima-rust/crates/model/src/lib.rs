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

pub mod users;

pub use collection::{CollectionInfo, ReadError};
pub use decode::{DecodeError, decode, decode_document};
pub use enums::{Open, StrEnum};
pub use error::ModelError;
pub use index::{IndexFailure, IndexSpec, ensure_indexes};
pub use validation::{Rule, ValidationError, ValidatorError, ValidatorKind};

/// Every collection module, in the order of this crate's module list.
pub static REGISTRY: &[&CollectionInfo] = &[&users::INFO];
