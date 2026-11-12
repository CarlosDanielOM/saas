//! Shared harness: the local stores from `tools/test-env`, a throwaway `dima_test_billing_<id>`
//! database dropped even when a test fails, Dragonfly logical databases 9 and 10 only, channel ids
//! no other run uses, the corpus, and the tagged values it holds.
#![allow(dead_code, clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use anyhow::{Context, Result, bail};
use bson::oid::ObjectId;
use dima_core::{Random, RandomError};
use dima_store::dragonfly::{Dragonfly, DragonflyConfig, Hooks};
use dima_store::mongo::{MongoConfig, MongoStore};
use futures_util::FutureExt;
use serde_json::{Map, Value};
use std::future::Future;
use std::panic::AssertUnwindSafe;
use std::sync::atomic::{AtomicU64, Ordering};

/// `DIMA_TEST_REQUIRE_STORES=1`: a missing store fails instead of skipping.
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

/// Connects to Dragonfly logical database `db` (9 or 10).
pub async fn dragonfly(db: u8) -> Result<Option<Dragonfly>> {
    assert!(
        db == 9 || db == 10,
        "billing tests use logical databases 9 and 10 only"
    );
    let Ok(address) = std::env::var("DIMA_TEST_DRAGONFLY") else {
        return missing("DIMA_TEST_DRAGONFLY is not set (eval \"$(dima-rust/tools/test-env)\")");
    };
    let Some((host, port)) = address.rsplit_once(':') else {
        bail!("DIMA_TEST_DRAGONFLY is not host:port");
    };
    let config = DragonflyConfig::from_env_values(
        Some(host),
        Some(&format!("{port}/{db}")),
        "dima-billing-test",
    );
    match Dragonfly::connect(config, Hooks::default()).await {
        Ok(dragonfly) => Ok(Some(dragonfly)),
        Err(error) => missing(&format!("the local Dragonfly cannot be reached: {error}")),
    }
}

/// A channel id no other run uses (digits only, like a Twitch id).
pub fn channel_id() -> String {
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or_default();
    format!(
        "9{}{}{}",
        nanos % 1_000_000_000_000,
        std::process::id(),
        COUNTER.fetch_add(1, Ordering::Relaxed)
    )
}

/// Deletes every key that contains `id` (SCAN + DEL, never FLUSH), and the shared accounts
/// aggregate the invalidation script touches in this test database.
pub async fn cleanup(dragonfly: &Dragonfly, id: &str) -> Result<()> {
    let mut scan = dragonfly.scan(&format!("*{id}*"), Some(1000));
    let mut keys = Vec::new();
    while let Some(page) = scan.next_page().await? {
        keys.extend(page);
    }
    for key in keys {
        let _: i64 = dragonfly.query(redis::cmd("DEL").arg(key)).await?;
    }
    Ok(())
}

/// Every key containing `id`, with its string value, sorted.
pub async fn keys_with(dragonfly: &Dragonfly, id: &str) -> Result<Vec<(String, String)>> {
    let mut scan = dragonfly.scan(&format!("*{id}*"), Some(1000));
    let mut keys = Vec::new();
    while let Some(page) = scan.next_page().await? {
        keys.extend(
            page.into_iter()
                .map(|key| String::from_utf8_lossy(&key).into_owned()),
        );
    }
    keys.sort();
    let mut out = Vec::new();
    for key in keys {
        let value = dragonfly.get_text(&key).await?.unwrap_or_default();
        out.push((key, value));
    }
    Ok(out)
}

/// Runs `test` against a fresh `dima_test_billing_<id>` database and drops it afterwards, whatever
/// the outcome.
pub async fn with_mongo<F, Fut>(test: F) -> Result<()>
where
    F: FnOnce(MongoStore) -> Fut,
    Fut: Future<Output = Result<()>>,
{
    let Ok(uri) = std::env::var("DIMA_TEST_MONGO_URI") else {
        return missing::<()>("DIMA_TEST_MONGO_URI is not set").map(|_| ());
    };
    let mut config = MongoConfig::new(uri);
    config.database = Some(format!("dima_test_billing_{}", ObjectId::new().to_hex()));
    let store = match MongoStore::connect(&config, None).await {
        Ok(store) => store,
        Err(error) => {
            return missing::<()>(&format!("the local MongoDB cannot be reached: {error}"))
                .map(|_| ());
        }
    };
    let database = store.database().clone();
    let outcome = AssertUnwindSafe(test(store)).catch_unwind().await;
    database.drop().await.context("drop the test database")?;
    match outcome {
        Ok(outcome) => outcome,
        Err(panic) => std::panic::resume_unwind(panic),
    }
}

/// The read-only production copy, or `None` when absent (and stores are not required).
pub async fn real_store() -> Result<Option<MongoStore>> {
    let Ok(uri) = std::env::var("DIMA_TEST_MONGO_URI") else {
        return missing("DIMA_TEST_MONGO_URI is not set");
    };
    let mut config = MongoConfig::new(uri);
    config.database = Some("domdimabot".into());
    let store = match MongoStore::connect(&config, None).await {
        Ok(store) => store,
        Err(error) => return missing(&format!("the local MongoDB cannot be reached: {error}")),
    };
    let names = store.client().list_database_names().await?;
    if !names.iter().any(|name| name == "domdimabot") {
        return missing("the local domdimabot copy is not present");
    }
    Ok(Some(store))
}

/// Randomness whose UUIDs are `00000000-0000-4000-8000-000000000000`, the corpus's `randomUUID`.
#[derive(Debug)]
pub struct ZeroRandom;

impl Random for ZeroRandom {
    fn fill(&self, buf: &mut [u8]) -> Result<(), RandomError> {
        buf.fill(0);
        Ok(())
    }
}

/// The corpus file.
pub fn corpus() -> Value {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/corpus/billing.json");
    serde_json::from_slice(&std::fs::read(path).expect("corpus")).expect("corpus json")
}

/// A tagged number of the corpus as an `f64` (`None` for anything else).
pub fn number(value: &Value) -> Option<f64> {
    match value {
        Value::Number(n) => n.as_f64(),
        Value::Object(o) => match o.get("$number").and_then(Value::as_str)? {
            "NaN" => Some(f64::NAN),
            "+Infinity" => Some(f64::INFINITY),
            "-Infinity" => Some(f64::NEG_INFINITY),
            "-0" => Some(-0.0),
            _ => None,
        },
        _ => None,
    }
}

/// `true` for `{$undefined: true}`.
pub fn is_undefined(value: &Value) -> bool {
    value.get("$undefined").is_some()
}

/// A corpus value as the JSON Polar or a store could hold: `undefined` members dropped (`null` in
/// arrays), `-0` kept; `None` when it holds `NaN` or an infinity (JSON cannot carry them).
pub fn plain(value: &Value) -> Option<Value> {
    Some(match value {
        Value::Object(o) if o.contains_key("$number") => {
            let n = number(value)?;
            if !n.is_finite() {
                return None;
            }
            Value::Number(serde_json::Number::from_f64(n)?)
        }
        Value::Object(o) if o.contains_key("$undefined") => Value::Null,
        Value::Object(o) => {
            let mut out = Map::new();
            for (k, v) in o {
                if is_undefined(v) {
                    continue;
                }
                out.insert(k.clone(), plain(v)?);
            }
            Value::Object(out)
        }
        Value::Array(items) => Value::Array(items.iter().map(plain).collect::<Option<_>>()?),
        other => other.clone(),
    })
}

/// A field of a corpus object: `None` when absent or `undefined`.
pub fn field<'a>(value: &'a Value, key: &str) -> Option<&'a Value> {
    value.get(key).filter(|v| !is_undefined(v))
}

/// A text field (`None` when absent, `undefined` or `null`).
pub fn text<'a>(value: &'a Value, key: &str) -> Option<&'a str> {
    field(value, key).and_then(Value::as_str)
}

/// Compares an expected corpus value with an actual JSON value: numbers by value with the sign
/// of zero, `undefined` members as absent, object key order ignored.
pub fn same(expected: &Value, actual: &Value) -> bool {
    if let Some(n) = number(expected).filter(|_| !expected.is_number()) {
        return number(actual).is_some_and(|a| {
            (a.is_nan() && n.is_nan()) || (a == n && a.is_sign_negative() == n.is_sign_negative())
        });
    }
    match (expected, actual) {
        (Value::Number(e), Value::Number(a)) => {
            let (e, a) = (
                e.as_f64().unwrap_or(f64::NAN),
                a.as_f64().unwrap_or(f64::NAN),
            );
            e == a && (e != 0.0 || e.is_sign_negative() == a.is_sign_negative())
        }
        (Value::Object(e), Value::Object(a)) if !e.contains_key("$undefined") => {
            let defined: Vec<_> = e.iter().filter(|(_, v)| !is_undefined(v)).collect();
            defined.len() == a.len()
                && defined
                    .iter()
                    .all(|(k, v)| a.get(*k).is_some_and(|actual| same(v, actual)))
        }
        (Value::Array(e), Value::Array(a)) => {
            e.len() == a.len() && e.iter().zip(a).all(|(e, a)| same(e, a))
        }
        (e, a) => e == a,
    }
}

/// A balance Rust writes always has its revision hash beside it (item 1 of P2-BILLING-01c); a
/// balance found without one belongs to a lost generation and is read again from Polar. A test
/// that plants a balance by hand plants its revision too, with this.
pub async fn plant_revision(dragonfly: &Dragonfly, id: &str) -> Result<()> {
    let _: i64 = dragonfly
        .query(
            redis::cmd("HSET")
                .arg(dima_billing::plans::balance::revision_key(id))
                .arg("gen")
                .arg(format!("planted-{id}"))
                .arg("pub")
                .arg(0),
        )
        .await?;
    Ok(())
}
