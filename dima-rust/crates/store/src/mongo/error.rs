//! Errors, and reading the driver errors the reference branches on (ledger rules 27 and 28).

use mongodb::error::{Error, ErrorKind, WriteFailure};

/// An error from this module's connection layer.
#[derive(Debug, thiserror::Error)]
pub enum MongoError {
    /// The configuration cannot be used. The message never contains the URI.
    #[error("MongoDB configuration: {0}")]
    Config(&'static str),
    /// The driver failed; the original error is kept.
    #[error(transparent)]
    Driver(#[from] Error),
}

/// The duplicate-key server error code (E11000). The reference tests exactly this code.
pub const DUPLICATE_KEY: i32 = 11000;

/// A duplicate-key error: many idempotent paths in the reference treat it as "already done".
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DuplicateKey {
    /// The unique index that was hit (`eventKey_1`), read from the server message.
    pub index: Option<String>,
    /// The server message (`E11000 duplicate key error collection: … index: … dup key: { … }`).
    pub message: String,
}

/// The duplicate-key error inside `error`, whatever operation produced it (`insertOne`,
/// `updateOne` upsert, `insertMany`, `findOneAndUpdate`, client bulk write).
pub fn duplicate_key(error: &Error) -> Option<DuplicateKey> {
    let message = match error.kind.as_ref() {
        ErrorKind::Write(WriteFailure::WriteError(e)) if e.code == DUPLICATE_KEY => {
            e.message.clone()
        }
        ErrorKind::Command(e) if e.code == DUPLICATE_KEY => e.message.clone(),
        ErrorKind::InsertMany(e) => e
            .write_errors
            .as_ref()?
            .iter()
            .find(|w| w.code == DUPLICATE_KEY)?
            .message
            .clone(),
        ErrorKind::BulkWrite(e) => {
            let mut errors: Vec<_> = e.write_errors.iter().collect();
            errors.sort_by_key(|(index, _)| **index);
            errors
                .into_iter()
                .map(|(_, w)| w)
                .find(|w| w.code == DUPLICATE_KEY)?
                .message
                .clone()
        }
        _ => return None,
    };
    Some(DuplicateKey {
        index: index_name(&message),
        message,
    })
}

/// `true` when `error` is a duplicate-key error.
pub fn is_duplicate_key(error: &Error) -> bool {
    duplicate_key(error).is_some()
}

/// The index name in an E11000 message: the text between ` index: ` and ` dup key: `.
pub fn index_name(message: &str) -> Option<String> {
    let (_, after) = message.split_once(" index: ")?;
    let name = after
        .split_once(" dup key: ")
        .map_or(after, |(name, _)| name);
    let name = name.trim();
    (!name.is_empty()).then(|| name.to_owned())
}

/// The server error code of a command or write error, if any.
pub fn server_code(error: &Error) -> Option<i32> {
    match error.kind.as_ref() {
        ErrorKind::Command(e) => Some(e.code),
        ErrorKind::Write(WriteFailure::WriteError(e)) => Some(e.code),
        ErrorKind::Write(WriteFailure::WriteConcernError(e)) => Some(e.code),
        ErrorKind::InsertMany(e) => e
            .write_errors
            .as_ref()
            .and_then(|w| w.first())
            .map(|w| w.code),
        _ => None,
    }
}

/// `true` when the deployment cannot run transactions (a standalone server), which is when
/// `follow_ledger.ts` falls back to writing without one. The reference matches the server
/// message "Transaction numbers are only allowed on a replica set member or mongos" (what the
/// local standalone 8.2 returns to the Rust driver too). The Rust driver can also refuse
/// client-side ("Transactions are not supported by this deployment") and rewrites the server
/// message for retryable writes outside transactions; all three are recognised.
pub fn is_transaction_unsupported(error: &Error) -> bool {
    match error.kind.as_ref() {
        ErrorKind::Transaction { message, .. } => {
            message.contains("not supported by this deployment")
        }
        ErrorKind::Command(e) => {
            let message = e.message.to_lowercase();
            message
                .contains("transaction numbers are only allowed on a replica set member or mongos")
                || (e.code == 20 && message.contains("does not support retryable writes"))
        }
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn index_names_from_messages() {
        let message = r#"E11000 duplicate key error collection: db.golden_errors index: eventKey_1 dup key: { eventKey: "k" }"#;
        assert_eq!(index_name(message).as_deref(), Some("eventKey_1"));
        assert_eq!(
            index_name("E11000 duplicate key error index: a_1_b_-1").as_deref(),
            Some("a_1_b_-1")
        );
        assert_eq!(index_name("something else"), None);
        assert_eq!(index_name("E11000 index:  dup key: {}"), None);
    }
}
