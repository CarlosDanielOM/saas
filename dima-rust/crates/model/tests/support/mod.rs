//! Shared harness of the live tests: the local MongoDB from `tools/test-env`, the read-only
//! `domdimabot` copy, and throwaway databases that are dropped even when a test fails.
#![allow(dead_code)]

use anyhow::Result;
use bson::oid::ObjectId;
use dima_store::mongo::{MongoConfig, MongoStore};
use futures_util::FutureExt;
use std::future::Future;
use std::panic::AssertUnwindSafe;

/// The read-only production copy.
pub const REAL_DATABASE: &str = "domdimabot";

/// The local MongoDB URI, or `None` (with a message) when the tests must be skipped.
pub fn mongo_uri() -> Option<String> {
    match std::env::var("DIMA_TEST_MONGO_URI") {
        Ok(uri) => Some(uri),
        Err(_) => {
            eprintln!(
                "skipped: DIMA_TEST_MONGO_URI is not set (eval \"$(dima-rust/tools/test-env)\")"
            );
            None
        }
    }
}

/// A store on the read-only `domdimabot` copy, or `None` when it is not available.
pub async fn real_store() -> Result<Option<MongoStore>> {
    let Some(uri) = mongo_uri() else {
        return Ok(None);
    };
    let mut config = MongoConfig::new(uri);
    config.database = Some(REAL_DATABASE.to_owned());
    let store = MongoStore::connect(&config, None).await?;
    let names = store.client().list_database_names().await?;
    if !names.iter().any(|name| name == REAL_DATABASE) {
        eprintln!("skipped: the local {REAL_DATABASE} copy is not present");
        return Ok(None);
    }
    Ok(Some(store))
}

/// Runs `test` against a fresh `dima_test_model_<random>` database and drops it afterwards,
/// whatever the outcome (a failed assertion is re-raised after the drop).
pub async fn with_store<F, Fut>(test: F) -> Result<()>
where
    F: FnOnce(MongoStore) -> Fut,
    Fut: Future<Output = Result<()>>,
{
    let Some(uri) = mongo_uri() else {
        return Ok(());
    };
    let mut config = MongoConfig::new(uri);
    config.database = Some(format!("dima_test_model_{}", ObjectId::new().to_hex()));
    let store = MongoStore::connect(&config, None).await?;
    let database = store.database().clone();
    let outcome = AssertUnwindSafe(test(store)).catch_unwind().await;
    database.drop().await?;
    match outcome {
        Ok(outcome) => outcome,
        Err(panic) => std::panic::resume_unwind(panic),
    }
}
