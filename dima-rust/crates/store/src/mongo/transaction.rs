//! A transaction that falls back to plain writes on a deployment without transactions, as
//! `dimabot/src/utils/follow_ledger.ts:379-388` does (ledger rule 28).
//!
//! The reference starts a session, runs the writes in `session.withTransaction`, and when that
//! fails because the server is not a replica set member, ends the session and runs the same
//! writes without one. The driver's `and_run` retries transient transaction errors and unknown
//! commit results like Node's `withTransaction`. The caller keeps its own retry loop (the
//! reference retries the whole thing up to 3 times for its own list of codes).
//!
//! On a standalone server the operation therefore runs **twice**, as in the reference: first
//! with the session, until its first write is refused (code 20, "Transaction numbers are only
//! allowed on a replica set member or mongos"), then again without a session. Anything it does
//! before its first write must be safe to repeat.
//!
//! Only the fallback path is tested here: the local server is a standalone `mongod`. The
//! transactional path runs on a replica set and is untested in this package.

use crate::mongo::error::is_transaction_unsupported;
use futures_util::future::BoxFuture;
use mongodb::{Client, ClientSession};

/// Runs `operation` inside a transaction, or without a session when the deployment does not
/// support transactions. `operation` receives `Some(session)` (pass it to every write with
/// `.session(...)`) or `None`, and the caller's `context`.
pub async fn with_transaction_or_fallback<R, C, F>(
    client: &Client,
    mut context: C,
    mut operation: F,
) -> mongodb::error::Result<R>
where
    F: for<'b> FnMut(
        Option<&'b mut ClientSession>,
        &'b mut C,
    ) -> BoxFuture<'b, mongodb::error::Result<R>>,
{
    let mut session = client.start_session().await?;
    let attempt = session
        .start_transaction()
        .and_run(&mut context, |session, context| {
            operation(Some(session), &mut **context)
        })
        .await;
    drop(session);
    match attempt {
        Err(error) if is_transaction_unsupported(&error) => operation(None, &mut context).await,
        other => other,
    }
}
