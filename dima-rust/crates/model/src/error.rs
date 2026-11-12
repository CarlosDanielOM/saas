//! The error of a model write.

use crate::validation::ValidationError;
use dima_store::mongo::PrepareError;

/// A write a model refused to prepare.
#[derive(Debug, thiserror::Error)]
pub enum ModelError {
    /// The new document breaks a validator (Mongoose's `ValidationError`).
    #[error(transparent)]
    Validation(#[from] ValidationError),
    /// The store's helpers refused the write (a cast error, an invalid update...).
    #[error(transparent)]
    Prepare(#[from] PrepareError),
    /// An input value could not be encoded as BSON.
    #[error("encoding the document: {0}")]
    Encode(#[from] bson::error::Error),
    /// The random source failed (tokens a hook generates).
    #[error(transparent)]
    Random(#[from] dima_core::RandomError),
}
