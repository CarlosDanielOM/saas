//! Harness shared by the roulette, duel and bits rules tests: the local MongoDB from
//! `tools/test-env`, a throwaway `dima_test_features_<random>` database dropped even when the
//! test fails, read-only access to the production copy `domdimabot`, and typed BSON as
//! canonical extended JSON. Without the stores a test skips with a notice, unless
//! `DIMA_TEST_REQUIRE_STORES=1` (then it fails).
#![allow(dead_code, clippy::expect_used, clippy::unwrap_used, clippy::panic)]

use std::future::Future;
use std::panic::AssertUnwindSafe;

use anyhow::{Context, Result, bail};
use bson::{Bson, Document};
use dima_store::mongo::{MongoConfig, MongoStore};
use futures_util::{FutureExt, TryStreamExt};
use serde_json::Value;

pub fn stores_required() -> bool {
    std::env::var("DIMA_TEST_REQUIRE_STORES").is_ok_and(|v| v == "1")
}

pub fn missing<T>(what: &str) -> Result<Option<T>> {
    if stores_required() {
        bail!("{what} (DIMA_TEST_REQUIRE_STORES=1: a missing store fails the test)");
    }
    eprintln!("skipped: {what}");
    Ok(None)
}

pub fn random_suffix() -> String {
    let mut bytes = [0_u8; 8];
    let _ = dima_core::Random::fill(&dima_core::SystemRandom, &mut bytes);
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

pub fn mongo_uri() -> Option<String> {
    std::env::var("DIMA_TEST_MONGO_URI").ok()
}

pub async fn connect(database: &str) -> Result<Option<MongoStore>> {
    let Some(uri) = mongo_uri() else {
        return missing("DIMA_TEST_MONGO_URI is not set (eval \"$(dima-rust/tools/test-env)\")");
    };
    let mut config = MongoConfig::new(uri);
    config.database = Some(database.to_owned());
    match MongoStore::connect(&config, None).await {
        Ok(store) => Ok(Some(store)),
        Err(error) => missing(&format!("the local MongoDB cannot be reached: {error}")),
    }
}

/// The production copy, read only (no write helper is ever pointed at it).
pub async fn production() -> Result<Option<MongoStore>> {
    connect("domdimabot").await
}

/// Runs `test` against a fresh database and drops it afterwards, also when `test` fails or
/// panics.
pub async fn with_database<F, Fut>(test: F) -> Result<()>
where
    F: FnOnce(MongoStore, String) -> Fut,
    Fut: Future<Output = Result<()>>,
{
    let name = format!("dima_test_features_{}", random_suffix());
    let Some(store) = connect(&name).await? else {
        return Ok(());
    };
    let outcome = AssertUnwindSafe(test(store.clone(), name.clone()))
        .catch_unwind()
        .await;
    let dropped = store.database().drop().await;
    match outcome {
        Ok(result) => {
            dropped.context("dropping the test database")?;
            result
        }
        Err(panic) => std::panic::resume_unwind(panic),
    }
}

/// Typed BSON as Node's `EJSON.serialize(v, { relaxed: false })` writes it.
pub fn ejson(value: Bson) -> Value {
    value.into_canonical_extjson()
}

/// Every document of `collection`, sorted by `_id`, as canonical extended JSON.
pub async fn documents(store: &MongoStore, collection: &str) -> Result<Vec<Value>> {
    let rows: Vec<Document> = store
        .documents(collection)
        .find(bson::doc! {})
        .sort(bson::doc! { "_id": 1 })
        .await?
        .try_collect()
        .await?;
    Ok(rows.into_iter().map(|d| ejson(Bson::Document(d))).collect())
}

/// Reads canonical extended JSON back into BSON.
pub fn from_ejson(value: &Value) -> Result<Bson> {
    Bson::try_from(value.clone()).context("extended JSON")
}

pub fn reference(text: &str) -> Value {
    serde_json::from_str(text).expect("recorded reference")
}

/// The recorders' fixed random bytes: block `i` is SHA-256(`{label}:{i}`), consumed in order.
#[derive(Debug)]
pub struct StreamRandom {
    label: String,
    state: std::sync::Mutex<(u64, Vec<u8>)>,
}

impl StreamRandom {
    pub fn new(label: &str) -> Self {
        Self {
            label: label.to_owned(),
            state: std::sync::Mutex::new((0, Vec::new())),
        }
    }
}

impl dima_core::Random for StreamRandom {
    fn fill(&self, buf: &mut [u8]) -> Result<(), dima_core::RandomError> {
        let mut state = self.state.lock().unwrap();
        while state.1.len() < buf.len() {
            let block = state.0;
            state.0 += 1;
            let digest = dima_core::crypto::sha256(format!("{}:{block}", self.label));
            state.1.extend_from_slice(&digest.0);
        }
        let rest = state.1.split_off(buf.len());
        buf.copy_from_slice(&state.1);
        state.1 = rest;
        Ok(())
    }
}

/// JSON with every number as a double, so `1.0` and `1` compare equal (a JavaScript reading).
pub fn numbers_as_doubles(value: &Value) -> Value {
    match value {
        Value::Number(n) => n
            .as_f64()
            .and_then(serde_json::Number::from_f64)
            .map_or(Value::Null, Value::Number),
        Value::Array(items) => Value::Array(items.iter().map(numbers_as_doubles).collect()),
        Value::Object(map) => Value::Object(
            map.iter()
                .map(|(k, v)| (k.clone(), numbers_as_doubles(v)))
                .collect(),
        ),
        other => other.clone(),
    }
}
