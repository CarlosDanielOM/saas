//! Shared harness of the live tests: the local MongoDB from `tools/test-env`, the read-only
//! `domdimabot` copy, and throwaway databases that are dropped even when a test fails. Without
//! the stores a test skips with a notice, unless `DIMA_TEST_REQUIRE_STORES=1` (then it fails).
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

/// `DIMA_TEST_REQUIRE_STORES=1` (set by `tools/test-env`, `MIGRATION.md` section 8): a missing
/// store, database or expected collection fails the test instead of skipping it.
pub fn stores_required() -> bool {
    std::env::var("DIMA_TEST_REQUIRE_STORES").is_ok_and(|v| v == "1")
}

/// A store the test needs is not there: an error when stores are required, else a skip notice
/// (`Ok(None)`).
fn missing<T>(what: &str) -> Result<Option<T>> {
    if stores_required() {
        bail!("{what} (DIMA_TEST_REQUIRE_STORES=1: a missing store fails the test)");
    }
    eprintln!("skipped: {what}");
    Ok(None)
}

/// The local MongoDB URI, or `None` (with a skip notice) when it is not set and stores are not
/// required.
pub fn mongo_uri() -> Result<Option<String>> {
    match std::env::var("DIMA_TEST_MONGO_URI") {
        Ok(uri) => Ok(Some(uri)),
        Err(_) => missing("DIMA_TEST_MONGO_URI is not set (eval \"$(dima-rust/tools/test-env)\")"),
    }
}

/// A connected store on `database`, after a ping: `None` when the server cannot be reached and
/// stores are not required.
async fn connect(uri: String, database: String) -> Result<Option<MongoStore>> {
    let mut config = MongoConfig::new(uri);
    config.database = Some(database);
    let store = MongoStore::connect(&config, None).await?;
    match store.ping().await {
        Ok(()) => Ok(Some(store)),
        Err(error) => missing(&format!("the local MongoDB cannot be reached: {error}")),
    }
}

/// A store on the read-only `domdimabot` copy, or `None` when it is not available (and stores
/// are not required).
pub async fn real_store() -> Result<Option<MongoStore>> {
    let Some(uri) = mongo_uri()? else {
        return Ok(None);
    };
    let Some(store) = connect(uri, REAL_DATABASE.to_owned()).await? else {
        return Ok(None);
    };
    let names = store.client().list_database_names().await?;
    if !names.iter().any(|name| name == REAL_DATABASE) {
        return missing(&format!("the local {REAL_DATABASE} copy is not present"));
    }
    Ok(Some(store))
}

/// Runs `test` against a fresh `dima_test_model_<random>` database and drops it afterwards,
/// whatever the outcome (a failed assertion is re-raised after the drop). Skips (with a notice)
/// when MongoDB is not available and stores are not required.
pub async fn with_store<F, Fut>(test: F) -> Result<()>
where
    F: FnOnce(MongoStore) -> Fut,
    Fut: Future<Output = Result<()>>,
{
    let Some(uri) = mongo_uri()? else {
        return Ok(());
    };
    let name = format!("dima_test_model_{}", ObjectId::new().to_hex());
    let Some(store) = connect(uri, name).await? else {
        return Ok(());
    };
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
        CollectionInfo, LoadedForSave, ModelError, admins, app_configs, channel_ai_personalities,
        commands, events, redemption_rewards, referral_codes,
    };
    use dima_store::mongo::WriteContext;
    use dima_store::mongo::save::{Change, PreparedSave};
    use dima_store::mongo::update::{PreparedFindAndModify, PreparedUpdate, Returned};

    /// Create through the collection's document middleware.
    pub fn create(
        info: &CollectionInfo,
        given: &Document,
        ctx: &mut WriteContext,
    ) -> Result<dima_store::mongo::insert::PreparedInsert, ModelError> {
        if info.name == dima_model::clipdesigns::COLLECTION {
            dima_model::clipdesigns::prepare_create(given, ctx).map(|plan| plan.insert)
        } else {
            info.prepare_create(given, ctx)
        }
    }

    /// `Model.updateOne` / `updateMany`.
    pub fn update(
        info: &CollectionInfo,
        filter: &Document,
        update: Document,
        options: impl Into<dima_model::UpdateOptions>,
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
        options: impl Into<dima_model::UpdateOptions>,
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

    /// `doc.save()`. `owner` is the plan of the channel owner a save hook looks up
    /// (`channelaipersonalities`).
    pub fn save(
        info: &CollectionInfo,
        loaded: &LoadedForSave,
        changes: &[Change],
        owner: Option<&str>,
        ctx: &mut WriteContext,
        random: &dyn Random,
    ) -> Result<PreparedSave, ModelError> {
        match info.name {
            channel_ai_personalities::COLLECTION => {
                channel_ai_personalities::prepare_save(loaded, changes, owner, ctx)
            }
            dima_model::clipdesigns::COLLECTION => {
                dima_model::clipdesigns::prepare_save(loaded, changes, ctx).map(|plan| plan.save)
            }
            admins::COLLECTION => admins::prepare_save(loaded, changes, ctx),
            app_configs::COLLECTION => app_configs::prepare_save(loaded, changes, ctx),
            events::COLLECTION => events::prepare_save(loaded, changes, ctx),
            referral_codes::COLLECTION => referral_codes::prepare_save(loaded, changes, ctx),
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
