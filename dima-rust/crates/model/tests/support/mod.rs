//! Shared harness of the live tests: the local MongoDB from `tools/test-env`, the read-only
//! `domdimabot` copy, and throwaway databases that are dropped even when a test fails.
#![allow(dead_code)]

use anyhow::{Context, Result, bail};
use bson::oid::ObjectId;
use bson::{Bson, Document};
use dima_store::mongo::{MongoConfig, MongoStore};
use futures_util::FutureExt;
use serde_json::Value;
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

/// The write entry points of each registered collection: the module's adapter for a collection
/// with hooks, the generic one otherwise. A new collection with hooks adds its adapter here.
pub mod entry {
    use bson::Document;
    use dima_core::Random;
    use dima_model::availability::Writer;
    use dima_model::{
        CollectionInfo, LoadedForSave, ModelError, admins, app_configs, commands, events,
        redemption_rewards,
    };
    use dima_store::mongo::WriteContext;
    use dima_store::mongo::save::{Change, PreparedSave};
    use dima_store::mongo::update::{
        PreparedFindAndModify, PreparedUpdate, Returned, UpdateOptions,
    };

    /// `Model.updateOne` / `updateMany`.
    pub fn update(
        info: &CollectionInfo,
        filter: &Document,
        update: Document,
        options: UpdateOptions,
        writer: Writer,
        ctx: &mut WriteContext,
        random: &dyn Random,
    ) -> Result<PreparedUpdate, ModelError> {
        match info.name {
            commands::COLLECTION => {
                commands::prepare_update(filter, update, options, writer, ctx, random)
            }
            redemption_rewards::COLLECTION => {
                redemption_rewards::prepare_update(filter, update, options, writer, ctx, random)
            }
            _ => info.prepare_update(filter, update, options, ctx),
        }
    }

    /// `Model.findOneAndUpdate`.
    #[allow(clippy::too_many_arguments)]
    pub fn find_one_and_update(
        info: &CollectionInfo,
        filter: &Document,
        update: Document,
        options: UpdateOptions,
        returned: Returned,
        writer: Writer,
        ctx: &mut WriteContext,
        random: &dyn Random,
    ) -> Result<PreparedFindAndModify, ModelError> {
        match info.name {
            commands::COLLECTION => commands::prepare_find_one_and_update(
                filter, update, options, returned, writer, ctx, random,
            ),
            redemption_rewards::COLLECTION => redemption_rewards::prepare_find_one_and_update(
                filter, update, options, returned, writer, ctx, random,
            ),
            _ => info.prepare_find_one_and_update(filter, update, options, returned, ctx),
        }
    }

    /// `doc.save()`.
    pub fn save(
        info: &CollectionInfo,
        loaded: &LoadedForSave,
        changes: &[Change],
        ctx: &mut WriteContext,
        random: &dyn Random,
    ) -> Result<PreparedSave, ModelError> {
        match info.name {
            admins::COLLECTION => admins::prepare_save(loaded, changes, ctx),
            app_configs::COLLECTION => app_configs::prepare_save(loaded, changes, ctx),
            events::COLLECTION => events::prepare_save(loaded, changes, ctx),
            commands::COLLECTION => commands::prepare_save(loaded, changes, ctx, random),
            redemption_rewards::COLLECTION => {
                redemption_rewards::prepare_save(loaded, changes, ctx, random)
            }
            _ => info.prepare_save(loaded, changes, ctx),
        }
    }

    /// Random bytes from a counter: distinct, reproducible UUIDs for the hooks' tokens.
    #[derive(Debug, Default)]
    pub struct CountingRandom(std::sync::atomic::AtomicU64);

    impl Random for CountingRandom {
        fn fill(&self, buf: &mut [u8]) -> Result<(), dima_core::RandomError> {
            for chunk in buf.chunks_mut(8) {
                let next = self.0.fetch_add(1, std::sync::atomic::Ordering::Relaxed) + 1;
                for (slot, byte) in chunk.iter_mut().zip(next.to_le_bytes()) {
                    *slot = byte;
                }
            }
            Ok(())
        }
    }
}

/// The recorded write cases (`tests/mongoose/writes.json`).
pub fn recorded_cases() -> Result<Vec<Value>> {
    let path = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/mongoose/writes.json");
    let recording: Value = serde_json::from_str(&std::fs::read_to_string(path)?)?;
    recording
        .get("cases")
        .and_then(Value::as_array)
        .cloned()
        .context("cases")
}

/// The recorded successful create cases of `collection` merged into one document (the first
/// value of a key wins): a base document with as many paths filled as the recordings have.
pub fn base_given(cases: &[Value], collection: &str) -> Result<Document> {
    let mut base = Document::new();
    for case in cases {
        let op = case.get("op").and_then(Value::as_str);
        if case.get("collection").and_then(Value::as_str) != Some(collection)
            || !matches!(op, Some("create" | "journal"))
            || case.get("error").is_some()
        {
            continue;
        }
        let doc = case.pointer("/intent/doc").context("doc")?;
        let Bson::Document(doc) = Bson::try_from(doc.clone())? else {
            bail!("{collection}: a create case without a document");
        };
        for (key, value) in doc {
            if !base.contains_key(&key) {
                base.insert(key, value);
            }
        }
    }
    if base.is_empty() {
        bail!("{collection}: no recorded create case (add one to record.mts)");
    }
    Ok(base)
}
