//! Shared harness of the live tests: the local stores from `tools/test-env`, throwaway MongoDB
//! databases (`dima_test_events_<random>`) dropped even when a test fails, Dragonfly logical
//! databases 6 and 7 with unique key prefixes, and the recorded fixtures. Without the stores a
//! test skips with a notice, unless `DIMA_TEST_REQUIRE_STORES=1` (then it fails).
#![allow(dead_code)]

use anyhow::{Context, Result, anyhow, bail};
use bson::oid::ObjectId;
use bson::{Bson, Document};
use dima_events::value::{Object, Value};
use dima_store::mongo::{MongoConfig, MongoStore};
use futures_util::FutureExt;
use serde_json::Value as Json;
use std::future::Future;
use std::panic::AssertUnwindSafe;

/// The read-only production copy.
pub const REAL_DATABASE: &str = "domdimabot";

/// `DIMA_TEST_REQUIRE_STORES=1`.
pub fn stores_required() -> bool {
    std::env::var("DIMA_TEST_REQUIRE_STORES").is_ok_and(|v| v == "1")
}

fn missing<T>(what: &str) -> Result<Option<T>> {
    if stores_required() {
        bail!("{what} (DIMA_TEST_REQUIRE_STORES=1: a missing store fails the test)");
    }
    eprintln!("skipped: {what}");
    Ok(None)
}

fn mongo_uri() -> Result<Option<String>> {
    match std::env::var("DIMA_TEST_MONGO_URI") {
        Ok(uri) => Ok(Some(uri)),
        Err(_) => missing("DIMA_TEST_MONGO_URI is not set (eval \"$(dima-rust/tools/test-env)\")"),
    }
}

async fn connect(uri: String, database: String) -> Result<Option<MongoStore>> {
    let mut config = MongoConfig::new(uri);
    config.database = Some(database);
    config.server_selection_timeout = Some(std::time::Duration::from_secs(5));
    let store = MongoStore::connect(&config, None).await?;
    match store.ping().await {
        Ok(()) => Ok(Some(store)),
        Err(error) => missing(&format!("the local MongoDB cannot be reached: {error}")),
    }
}

/// A store on the read-only production copy.
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

/// Runs `test` against a fresh `dima_test_events_<random>` database and drops it afterwards,
/// whatever the outcome.
pub async fn with_store<F, Fut>(test: F) -> Result<()>
where
    F: FnOnce(MongoStore) -> Fut,
    Fut: Future<Output = Result<()>>,
{
    let Some(uri) = mongo_uri()? else {
        return Ok(());
    };
    let name = format!("dima_test_events_{}", ObjectId::new().to_hex());
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

/// Ensures the indexes of `info` (as the binaries do at startup) and returns the report.
pub async fn indexes(
    store: &MongoStore,
    info: &dima_model::CollectionInfo,
) -> Result<dima_model::IndexReport> {
    let report = dima_model::ensure_indexes(
        store,
        info,
        dima_model::startup_policy(info),
        std::time::Duration::from_secs(30),
    )
    .await;
    if report.failures().next().is_some() {
        bail!("index creation failed: {report}");
    }
    Ok(report)
}

/// The recorded fixture.
pub fn recorded() -> Result<Json> {
    let path = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/recorded.json");
    let text = std::fs::read_to_string(path).with_context(|| format!("reading {path}"))?;
    Ok(serde_json::from_str(&text)?)
}

/// A recorded value (tagged JSON, see `tests/reference/record.mts`) as a [`Value`].
pub fn decode(json: &Json) -> Value {
    if let Json::Object(map) = json
        && map.len() == 1
    {
        if let Some(date) = map.get("$date") {
            return Value::Date(date.as_f64().unwrap_or(f64::NAN));
        }
        if map.contains_key("$undefined") {
            return Value::Undefined;
        }
        if let Some(Json::String(number)) = map.get("$number") {
            return Value::Number(match number.as_str() {
                "Infinity" => f64::INFINITY,
                "-Infinity" => f64::NEG_INFINITY,
                "-0" => -0.0,
                _ => f64::NAN,
            });
        }
        if let Some(Json::String(id)) = map.get("$oid")
            && let Ok(id) = ObjectId::parse_str(id)
        {
            return Value::ObjectId(id);
        }
    }
    match json {
        Json::Object(map) => Value::Object(
            map.iter()
                .map(|(k, v)| (k.clone(), decode(v)))
                .collect::<Object>(),
        ),
        Json::Array(items) => Value::Array(items.iter().map(decode).collect()),
        other => Value::from_json(other),
    }
}

/// The object of a recorded value.
pub fn decode_object(json: &Json) -> Result<Object> {
    match decode(json) {
        Value::Object(object) => Ok(object),
        other => Err(anyhow!("expected an object, got {other:?}")),
    }
}

/// A recorded canonical Extended JSON document.
pub fn document(json: &Json) -> Result<Document> {
    match Bson::try_from(json.clone()).map_err(|e| anyhow!("extended JSON: {e}"))? {
        Bson::Document(document) => Ok(document),
        other => Err(anyhow!("expected a document, got {other:?}")),
    }
}

/// Exact BSON equality: same types (a double is not an int32), same key order, `-0` is not `0`.
/// `ignore` names top-level keys whose values are generated (compared for type only).
pub fn assert_same(expected: &Bson, actual: &Bson, path: &str) -> Result<()> {
    match (expected, actual) {
        (Bson::Document(a), Bson::Document(b)) => {
            let keys_a: Vec<&String> = a.keys().collect();
            let keys_b: Vec<&String> = b.keys().collect();
            if keys_a != keys_b {
                bail!("{path}: keys differ\n  expected {keys_a:?}\n  actual   {keys_b:?}");
            }
            for (key, value) in a {
                let other = b.get(key).ok_or_else(|| anyhow!("{path}.{key} missing"))?;
                assert_same(value, other, &format!("{path}.{key}"))?;
            }
            Ok(())
        }
        (Bson::Array(a), Bson::Array(b)) => {
            if a.len() != b.len() {
                bail!("{path}: {} items expected, {} found", a.len(), b.len());
            }
            for (index, (x, y)) in a.iter().zip(b).enumerate() {
                assert_same(x, y, &format!("{path}[{index}]"))?;
            }
            Ok(())
        }
        (Bson::Double(a), Bson::Double(b)) if a.to_bits() == b.to_bits() => Ok(()),
        (a, b) if std::mem::discriminant(a) == std::mem::discriminant(b) && a == b => Ok(()),
        (a, b) => bail!("{path}: expected {a:?}, found {b:?}"),
    }
}

/// A unique prefix for Dragonfly keys of one test.
pub fn key_prefix(test: &str) -> String {
    format!("dima:test:events:{test}:{}:", ObjectId::new().to_hex())
}

/// A Dragonfly handle on logical database `db` (6 or 7 only).
pub async fn dragonfly(db: u8) -> Result<Option<dima_store::dragonfly::Dragonfly>> {
    if db != 6 && db != 7 {
        bail!("tests use Dragonfly databases 6 and 7 only");
    }
    let Ok(address) = std::env::var("DIMA_TEST_DRAGONFLY") else {
        return missing("DIMA_TEST_DRAGONFLY is not set (eval \"$(dima-rust/tools/test-env)\")");
    };
    let (host, port) = address
        .rsplit_once(':')
        .ok_or_else(|| anyhow!("DIMA_TEST_DRAGONFLY is host:port"))?;
    let mut config = dima_store::dragonfly::DragonflyConfig::from_env_values(
        Some(host),
        Some(&format!("{port}/{db}")),
        "dima-events-tests",
    );
    config.response_timeout = std::time::Duration::from_secs(2);
    match dima_store::dragonfly::Dragonfly::connect(config, Default::default()).await {
        Ok(client) => Ok(Some(client)),
        Err(error) => missing(&format!("the local Dragonfly cannot be reached: {error}")),
    }
}

/// Deletes every key under `prefix` (bounded scan).
pub async fn clean_keys(client: &dima_store::dragonfly::Dragonfly, prefix: &str) -> Result<()> {
    let mut scan = client.scan(&format!("{prefix}*"), Some(1000));
    let mut keys = Vec::new();
    for _ in 0..10_000 {
        match scan.next_page().await? {
            Some(page) => keys.extend(page),
            None => break,
        }
    }
    for key in keys {
        if let Ok(key) = String::from_utf8(key) {
            client.del(&[key.as_str()]).await?;
        }
    }
    Ok(())
}
