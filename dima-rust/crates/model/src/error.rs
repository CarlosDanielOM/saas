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
    /// A save of a document loaded from another collection.
    #[error("a document loaded from {found} cannot be saved to {expected}")]
    WrongCollection {
        /// The collection of the save.
        expected: &'static str,
        /// The collection the document was loaded from.
        found: &'static str,
    },
    /// The collection's middleware refused the write (a reference hook that throws: a plan
    /// limit, a missing owner); the message is the reference's.
    #[error("{message}")]
    Refused {
        /// The collection.
        collection: &'static str,
        /// The reference's error message.
        message: String,
    },
    /// A generic write to a collection whose Mongoose middleware would be skipped: use the
    /// collection module's adapter.
    #[error("{operation} on {collection} must go through its module (Mongoose hooks)")]
    Hooked {
        /// The collection.
        collection: &'static str,
        /// The operation refused.
        operation: &'static str,
    },
}
